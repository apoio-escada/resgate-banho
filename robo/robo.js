/**
 * RESGATE DE BANHO – ROBÔ DO DP002
 * Postos Pichilau · TI 08.3.2
 *
 * Busca pedidos no servidor (Apps Script), faz o resgate no ClubPetro,
 * gera a senha no EVO, imprime o ticket do cliente e salva o PDF
 * (via ClubPetro + via caixa EVO) na pasta do OneDrive.
 *
 * Cada pedido tem um "jornal" em dados/jornal/<id>.json com a etapa em que está.
 * Se o navegador ou o computador cair, o robô continua da etapa que faltava
 * e nunca repete o resgate no ClubPetro.
 *
 * Uso:
 *   node robo.js            -> funcionamento normal
 *   node robo.js --login    -> abre o navegador do robô para fazer login no ClubPetro e no EVO
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const { PDFDocument } = require('pdf-lib');

const VERSAO = '2.13.2';
// v2.11.0: só um computador roda o robô. O que for instalado por último "assume" (arquivo dados\assumir.flag);
// o anterior recebe do servidor o aviso de que foi substituído, fecha os navegadores e fica em espera.
const MAQUINA = require('os').hostname();
let substituidoPor = null;
// v2.10.0: clientes deixados abertos no ClubPetro depois da consulta de pontos (o resgate continua dali)
const clientesAbertos = new Map();   // consultaId -> { cpf, em, pontos, timer }
const ESPERA_ESCOLHA_MS = 2 * 60 * 1000;
const senhasEmEspera = {};   // v2.7.0: senhas prontas esperando o cliente pedir a impressão
const BASE = __dirname;
const CFG = carregarConfig();
const DADOS = path.resolve(BASE, CFG.pastaDados || 'dados');
const JORNAL = path.join(DADOS, 'jornal');
const DIAG = path.join(DADOS, 'diagnostico');
const TICKETS = path.join(DADOS, 'tickets');
[DADOS, JORNAL, DIAG, TICKETS].forEach(p => fs.mkdirSync(p, { recursive: true }));

// ------------------------------------------------------------------ configuração e log

function carregarConfig() {
  const arq = path.join(BASE, 'config.json');
  if (!fs.existsSync(arq)) {
    console.error('Falta o config.json. Copie config.exemplo.json para config.json e preencha.');
    process.exit(1);
  }
  const c = JSON.parse(fs.readFileSync(arq, 'utf8'));
  c.clubpetro = Object.assign({ urlResgate: 'https://app.clubpetro.com/redeem', produto: 'Banho', categoria: 'Serviço' }, c.clubpetro || {});
  c.evo = Object.assign({ url: 'http://192.168.194.230/', botao: 'B.PICHILAUMAIS' }, c.evo || {});
  c.tempos = Object.assign({ passo: 30000, ticketEvo: 45000, captura: 20000 }, c.tempos || {});
  c.tempos.passo = Math.max(30000, Number(c.tempos.passo) || 0); c.tempos.captura = Math.max(20000, Number(c.tempos.captura) || 0);   // v2.13.1: ClubPetro lento
  // v2.12.0: logins e senhas vêm do servidor (Configurações do painel); o config.json só precisa de servidorUrl + roboToken
  c.navegador = c.navegador || 'chrome'; c.perfilNavegador = c.perfilNavegador || 'perfil-navegador';
  c.larguraPapelMm = c.larguraPapelMm || 80; c.pastaDados = c.pastaDados || 'dados';
  if (c.diagnostico === undefined) c.diagnostico = true;
  return c;
}

const LOG = path.join(DADOS, 'robo.log');
function log(...a) {
  const linha = `[${new Date().toLocaleString('pt-BR')}] ` + a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  console.log(linha);
  try { fs.appendFileSync(LOG, linha + '\n'); } catch (_) {}
}

const dormir = ms => new Promise(r => setTimeout(r, ms));
// v2.12.0: os PDFs ficam SEMPRE no próprio computador (C:\RoboBanho\Comprovantes\AAAA-MM); OneDrive (pastaNuvem) e
// pastaBackup são opcionais e só valem se a pasta existir neste computador
const PASTA_LOCAL = path.join(BASE, 'Comprovantes');
function pastasDestino() {
  const extras = [CFG.pastaNuvem, CFG.pastaBackup].filter(p => p && fs.existsSync(p));
  return [PASTA_LOCAL, ...extras.filter(p => path.resolve(p) !== path.resolve(PASTA_LOCAL))];
}

class ErroCliente extends Error {         // problema do cliente: nenhum resgate foi feito
  constructor(tipo, msgCliente, interno) { super(interno || tipo); this.tipo = tipo; this.msgCliente = msgCliente; }
}
class ErroVerificar extends Error {       // não sabemos se o resgate foi feito: o caixa confere
  constructor(msg) { super(msg); this.tipo = 'VERIFICAR'; }
}

// ------------------------------------------------------------------ servidor

async function api(acao, dados = {}, tentativas = 3) {
  for (let t = 1; t <= tentativas; t++) {
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 25000);
      const r = await fetch(CFG.servidorUrl, {
        method: 'POST', redirect: 'follow', signal: ctrl.signal,
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({ acao, token: CFG.roboToken, versao: VERSAO }, dados))
      });
      clearTimeout(to);
      const j = await r.json();
      if (!j.ok && /Token/.test(j.erro || '')) { log('ERRO: token do robô recusado. Confira o roboToken no config.json.'); }
      return j;
    } catch (e) {
      if (t === tentativas) throw e;
      await dormir(2000 * t);
    }
  }
}

// ------------------------------------------------------------------ jornal (retomada)

function jornalLer(id) { const f = path.join(JORNAL, id + '.json'); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; }
function jornalGravar(j) {
  j.atualizado = new Date().toISOString();
  fs.writeFileSync(path.join(JORNAL, j.id + '.json'), JSON.stringify(j, null, 1));
  if (process.env.ROBO_PARAR_EM && process.env.ROBO_PARAR_EM === j.etapa) { log('TESTE: parando de propósito em', j.etapa); process.exit(9); }
}
function jornalApagar(id) { try { fs.unlinkSync(path.join(JORNAL, id + '.json')); } catch (_) {} }
function jornaisPendentes() { return fs.readdirSync(JORNAL).filter(f => f.endsWith('.json')).map(f => jornalLer(f.slice(0, -5))).filter(Boolean); }

// ------------------------------------------------------------------ navegador

let ctx = null, render = null;
const capturas = [];   // tudo que os sites mandam imprimir chega aqui

// Troca window.print por uma captura do conteúdo. Nada abre a janela de impressão.
const GANCHO_IMPRESSAO = `(() => {
  if (window.__roboGancho) return; window.__roboGancho = true;
  window.print = function () {
    try {
      const orig = document.querySelectorAll('canvas');
      const clone = document.documentElement.cloneNode(true);
      clone.querySelectorAll('canvas').forEach((c, i) => {
        try { const img = document.createElement('img'); img.src = orig[i].toDataURL();
              img.width = orig[i].width; img.height = orig[i].height;
              img.style.cssText = orig[i].style.cssText; img.className = orig[i].className; c.replaceWith(img); } catch (e) {}
      });
      const vals = document.querySelectorAll('input, textarea');
      clone.querySelectorAll('input, textarea').forEach((el, i) => { if (vals[i]) el.setAttribute('value', vals[i].value); });
      clone.querySelectorAll('script').forEach(s => s.remove());
      window.__roboImprimir({ html: '<!DOCTYPE html>' + clone.outerHTML, url: location.href, titulo: document.title,
                              texto: (document.body && document.body.innerText) || '' });
    } catch (e) { try { window.__roboImprimir({ erro: String(e), url: location.href }); } catch (_) {} }
  };
})();`;

function origemNavegador() {
  return CFG.caminhoNavegador ? { executablePath: CFG.caminhoNavegador } : { channel: CFG.navegador || 'chrome' };
}

async function abrirNavegador() {
  if (ctx) return ctx;
  log('Abrindo navegador do robô (' + (CFG.navegador || 'chrome') + ')...');
  const perfil = path.resolve(BASE, CFG.perfilNavegador || 'perfil-navegador');
  // trava deixada por um navegador que caiu (se ainda houver um aberto, o Windows não deixa apagar)
  for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'lockfile']) {
    try { fs.rmSync(path.join(perfil, f), { force: true }); } catch (_) {}
  }
  const abrir = () => chromium.launchPersistentContext(perfil, {
    ...origemNavegador(), headless: !!CFG.semJanela, viewport: null,
    // o robô trabalha mesmo atrás de outras janelas (ex.: o totem no mesmo computador)
    args: ['--start-maximized', '--disable-session-crashed-bubble', '--hide-crash-restore-bubble',
           '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling']
  });
  try { ctx = await abrir(); }
  catch (e) {
    // v2.12.2: Chrome sai com código 21 quando o perfil do robô já está aberto (navegador antigo que ficou preso).
    // Fecha só os Chrome que usam o perfil do robô e tenta de novo.
    if (process.platform !== 'win32' || !/exitCode=21|has been closed|ProcessSingleton|in use/i.test(e.message)) throw e;
    log('O perfil do navegador do robô estava preso por outro Chrome. Fechando e tentando de novo...');
    require('child_process').spawnSync('powershell', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'chrome.exe' -and $_.CommandLine -like '*${perfil.replace(/'/g, "''")}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`], { stdio: 'ignore' });
    await dormir(3000);
    for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'lockfile']) { try { fs.rmSync(path.join(perfil, f), { force: true }); } catch (_) {} }
    ctx = await abrir();
  }
  ctx.on('close', () => { log('Navegador fechado. Vou reabrir.'); ctx = null; abasClub.clear(); });
  // v2.13.2: as janelas do robô abrem minimizadas, para não roubar o teclado do totem (mesmo computador).
  // Desligar: "minimizarJanelas": false no config.json.
  if (CFG.minimizarJanelas !== false && !CFG.semJanela) {
    ctx.on('page', p => minimizarJanela(p));
    for (const p of ctx.pages()) minimizarJanela(p);
  }
  await prepararContexto(ctx);
  return ctx;
}

async function minimizarJanela(p) {
  try {
    await dormir(800);
    const s = await p.context().newCDPSession(p);
    const { windowId } = await s.send('Browser.getWindowForTarget');
    await s.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
    await s.detach().catch(() => {});
  } catch (_) {}
}
const ARGS_NAVEGADOR = ['--start-maximized', '--disable-session-crashed-bubble', '--hide-crash-restore-bubble',
  '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'];

async function prepararContexto(c) {
  await c.exposeBinding('__roboImprimir', async (fonte, dados) => {
    capturas.push(Object.assign({ quando: Date.now(), pagina: fonte.page ? fonte.page.url() : '' }, dados));
    log('Impressão capturada de', dados.url || '?');
  });
  await c.addInitScript(GANCHO_IMPRESSAO);
  c.on('dialog', d => d.accept().catch(() => {}));
  c.on('page', p => p.on('dialog', d => d.accept().catch(() => {})));
}

// ---------- EVO: uma janela separada para cada caixa (cada uma com o seu login)
// Cookies de janelas diferentes não se misturam, então dois caixas ficam logados ao mesmo tempo.
let navEvo = null;
const janelasEvo = new Map();          // login do EVO -> { c, p }
async function janelaEvoDoCaixa(cred) {
  if (!navEvo || !navEvo.isConnected()) {
    navEvo = await chromium.launch({ ...origemNavegador(), headless: !!CFG.semJanela, args: ARGS_NAVEGADOR });
    navEvo.on('disconnected', () => { navEvo = null; janelasEvo.clear(); });
    janelasEvo.clear();
  }
  const chave = cred.usuario.toLowerCase();
  let j = janelasEvo.get(chave);
  if (j && !j.p.isClosed()) return j.p;
  if (j) await j.c.close().catch(() => {});
  const c = await navEvo.newContext({ viewport: null });
  await prepararContexto(c);
  const p = await c.newPage();
  p.setDefaultTimeout(CFG.tempos.passo);
  await p.goto(CFG.evo.url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  janelasEvo.set(chave, { c, p });
  log('Janela do EVO aberta para o caixa', cred.usuario);
  return p;
}
async function fecharJanelaEvo(cred) {
  if (!cred) return;
  const j = janelasEvo.get(cred.usuario.toLowerCase());
  if (j) { janelasEvo.delete(cred.usuario.toLowerCase()); await j.c.close().catch(() => {}); log('Janela do EVO fechada para o caixa', cred.usuario); }
}

async function navegadorRender() {
  if (render && render.isConnected()) return render;
  render = await chromium.launch({ ...origemNavegador(), headless: true });
  return render;
}

async function aba(nome, urlInicial, teste) {
  await abrirNavegador();
  let p = ctx.pages().find(pg => teste(pg.url()));
  if (!p) {
    p = ctx.pages().find(pg => pg.url() === 'about:blank') || await ctx.newPage();
    await p.goto(urlInicial, { waitUntil: 'domcontentloaded', timeout: 45000 });
  }
  p.setDefaultTimeout(CFG.tempos.passo);
  // não puxa a janela do robô para a frente: assim ela não cobre o totem nem a tela do caixa
  if (CFG.trazerParaFrente) await p.bringToFront();
  return p;
}
// v2.8.0: uma aba do ClubPetro para cada caixa (no navegador principal; o login do ClubPetro é o do posto).
// A aba fica aberta e já carregada na tela de resgate: o próximo resgate começa sem esperar a página.
const abasClub = new Map();            // caixa -> { p, pronta: Promise|null, ok: boolean, em: ms }
const CLUB_PRONTA_MS = 10 * 60 * 1000; // depois de 10 min parada, recarrega antes de usar (sessão pode ter caído)
function chaveCaixa() { return credEvoTurno && credEvoTurno.usuario ? credEvoTurno.usuario.toLowerCase() : '_posto'; }
async function abaClubDoCaixa(chave) {
  await abrirNavegador();
  const a = abasClub.get(chave);
  if (a && !a.p.isClosed()) return a.p;
  const livre = ctx.pages().find(pg => pg.url() === 'about:blank' && ![...abasClub.values()].some(x => x.p === pg));
  const p = livre || await ctx.newPage();
  p.setDefaultTimeout(CFG.tempos.passo);
  abasClub.set(chave, { p, pronta: null, ok: false, em: 0 });
  log('Aba do ClubPetro aberta para o caixa', chave);
  return p;
}
async function deixarClubPronto(chave) {
  const p = await abaClubDoCaixa(chave), a = abasClub.get(chave);
  await p.setViewportSize({ width: 1366, height: 768 }).catch(() => {});
  await p.goto(CFG.clubpetro.urlResgate, { waitUntil: 'domcontentloaded', timeout: 45000 });
  if (await precisaLoginClub(p)) {
    await loginClubPetro(p);
    await p.goto(CFG.clubpetro.urlResgate, { waitUntil: 'domcontentloaded', timeout: 45000 });
    if (await precisaLoginClub(p)) throw new Error('LOGIN_CLUBPETRO: o ClubPetro continuou pedindo login');
  }
  a.ok = true; a.em = Date.now();
}
function prepararClub(chave) {           // recarrega em segundo plano, sem segurar o robô
  const a = abasClub.get(chave);
  if (!a || a.p.isClosed()) return;
  a.ok = false;
  a.pronta = deixarClubPronto(chave).catch(e => { log('Aba do ClubPetro (' + chave + ') não ficou pronta:', e.message); });
}
async function fecharAbaClub(chave) {
  const a = abasClub.get(chave);
  if (!a) return;
  abasClub.delete(chave);
  await a.p.close().catch(() => {});
  log('Aba do ClubPetro fechada para o caixa', chave);
}
const abaClub = () => abaClubDoCaixa(chaveCaixa());

// v2.8.0: tipos de resgate (hoje só o banho). Preparado para o vale refeição: cada tipo tem a categoria e o
// produto do ClubPetro e o botão do EVO. O servidor/totem mandam tarefa.tipoResgate; sem isso, é banho.
function tiposResgate() {
  // v2.9.0: modalidades configuradas no painel (servidor) têm prioridade
  if (Array.isArray(CFG.modalidades) && CFG.modalidades.length) {
    const m = {}; CFG.modalidades.forEach(x => { if (x && x.id) m[x.id] = Object.assign({ ativo: true }, x); });
    if (m.banho) { m.banho.usaEvo = true; m.banho.categoria = m.banho.categoria || CFG.clubpetro.categoria; m.banho.botaoEvo = m.banho.botaoEvo || CFG.evo.botao; }
    return m;
  }
  const extra = CFG.tiposResgate || {};
  return Object.assign({
    banho: { nome: 'Banho', categoria: CFG.clubpetro.categoria, produto: CFG.clubpetro.produto, botaoEvo: CFG.evo.botao, usaEvo: true, ativo: true },
    refeicao: { nome: 'Refeição', categoria: 'Serviço', produto: 'Vale Refeição - Restaurante Gaúcha', botaoEvo: '', usaEvo: false, ativo: true }
  }, ...Object.entries(extra).map(([k, v]) => ({ [k]: Object.assign({ nome: k, ativo: true }, v) })));
}
function tipoDoResgate(j) {
  const id = (j && j.tipoResgate) || 'banho';
  const t = (j && j.mod && j.mod.id === id) ? Object.assign({ ativo: true }, j.mod) : tiposResgate()[id];
  if (!t) throw new Error('Tipo de resgate desconhecido: ' + id);
  if (id === 'banho') t.usaEvo = true;
  if (!t.ativo || !t.produto || (t.usaEvo && !t.botaoEvo)) throw new Error('O tipo de resgate "' + (t.nome || id) + '" ainda não está configurado.');
  return t;
}
const escRe = s => String(s || '').replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');

// v2.9.0: lê os prêmios da tela (nome, categoria, pontos) — cartões com "Categoria: X" e "NNN PONTOS"
async function lerPremios(p) {
  return p.evaluate(() => {
    const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const folhas = [...document.querySelectorAll('body *')].filter(e => e.children.length === 0 && vis(e) && /^categoria\s*:/i.test(e.textContent.trim()));
    const out = [];
    for (const f of folhas) {
      let card = f.parentElement;
      for (let k = 0; k < 6 && card && !/\d+\s*pontos/i.test(card.innerText || ''); k++) card = card.parentElement;
      if (!card) continue;
      const linhas = (card.innerText || '').split('\n').map(x => x.trim()).filter(Boolean);
      const iCat = linhas.findIndex(x => /^categoria\s*:/i.test(x));
      const nome = iCat > 0 ? linhas[iCat - 1] : '';
      const pts = /(\d[\d.]*)\s*pontos/i.exec(card.innerText || '') || /^(\d[\d.]*)$/.exec(linhas.find(x => /^\d[\d.]*$/.test(x)) || '');
      if (nome) out.push({ nome, categoria: linhas[iCat].replace(/^categoria\s*:\s*/i, ''), pontos: pts ? Number(String(pts[1]).replace(/\./g, '')) : 0 });
    }
    const vistos = new Set();
    return out.filter(x => !vistos.has(x.nome.toLowerCase()) && vistos.add(x.nome.toLowerCase()));
  }).catch(() => []);
}
let ultimoEnvioPremios = 0;
async function enviarPremios(lista) {
  if (!lista || !lista.length || Date.now() - ultimoEnvioPremios < 6 * 3600 * 1000) return;
  ultimoEnvioPremios = Date.now();
  await api('robo_premios', { lista }).catch(() => {});
  log('Lista de prêmios do ClubPetro enviada ao painel (' + lista.length + ').');
}

// v2.9.0: consulta de pontos pedida no totem (não resgata nada)
async function consultarPontos(t) {
  // v2.10.0: 2 ou 3 totens ao mesmo tempo: cada consulta usa a sua aba. A aba "_consulta" fica pré-carregada;
  // quem chega primeiro a pega e outra já começa a ser preparada.
  const chave = 'c:' + t.id;
  const pre = abasClub.get('_consulta');
  if (pre && !pre.p.isClosed() && !pre.emUso) { abasClub.delete('_consulta'); abasClub.set(chave, pre); abaClubDoCaixa('_consulta').then(() => prepararClub('_consulta')).catch(() => {}); }
  try {
    const p = await abaClubDoCaixa(chave);
    const a = abasClub.get(chave);
    if (a.pronta) { await a.pronta; a.pronta = null; }
    const pronta = a.ok && Date.now() - a.em < CLUB_PRONTA_MS && p.url().startsWith(CFG.clubpetro.urlResgate);
    a.ok = false;
    if (!pronta) await deixarClubPronto(chave);
    a.ok = false;
    const modal = p.locator('[role="dialog"], .modal, .MuiDialog-root').filter({ hasText: /Resgate de pr[êe]mios/i }).last();
    if (!(await modal.isVisible().catch(() => false))) await clicarTexto(p, /novo resgate/i);
    await modal.waitFor({ state: 'visible' });
    await modal.getByText(/^CPF$/).first().click();
    const busca = modal.locator('input:visible:not([type="radio"]):not([type="checkbox"])').first();
    await busca.click();
    await busca.type(t.cpf, { delay: 50 });
    const opcao = await escolherClienteNaLista(p, busca, { id: t.id, cpf: t.cpf });
    if (!opcao) { await api('robo_consulta', { id: t.id, erro: 'Não encontramos esse CPF no Pichilau+. Confira os números ou procure o caixa.' }); return; }
    await opcao.click();
    await clicarTexto(p, /continuar resgate/i, modal);
    await p.getByText(/hist[óo]rico deste cliente/i).first().waitFor({ state: 'visible' });
    const pontos = await lerPontosCliente(p);
    await p.getByText(/^por categoria$/i).first().click().catch(() => {});
    await p.getByText(/^todas$/i).first().click().catch(() => {});
    await dormir(800);
    const premios = await lerPremios(p);
    enviarPremios(premios);
    const custos = {};
    for (const m of (t.modalidades || [])) {
      const pr = premios.find(x => x.nome.toLowerCase() === String(m.produto || '').toLowerCase());
      if (pr) custos[m.id] = pr.pontos;
    }
    // v2.10.0: o cliente fica aberto nesta aba esperando a escolha no totem; outra aba de consulta já vai sendo preparada
    const entrada = abasClub.get(chave);
    abasClub.delete(chave); abasClub.set('q:' + t.id, entrada);
    const timer = setTimeout(() => { if (clientesAbertos.delete(t.id)) fecharAbaClub('q:' + t.id); }, ESPERA_ESCOLHA_MS);
    clientesAbertos.set(t.id, { cpf: t.cpf, em: Date.now(), pontos, timer });
    if (!abasClub.has('_consulta')) abaClubDoCaixa('_consulta').then(() => prepararClub('_consulta')).catch(() => {});
    await api('robo_consulta', { id: t.id, pontos: pontos === null ? undefined : pontos, custos });
    log(`[${t.id}] Consulta de pontos: ${pontos} pontos (cliente aberto esperando a escolha)`);
    return;
  } catch (e) {
    log(`[${t.id}] Falha na consulta de pontos: ${e.message}`);
    await api('robo_consulta', { id: t.id, erro: 'Não foi possível consultar agora. Tente de novo ou procure o caixa.' }).catch(() => {});
  }
  fecharAbaClub(chave);
}
// com login do caixa: janela própria desse caixa; sem login cadastrado: aba do navegador principal (como antes)
const abaEvo = () => credEvoTurno ? janelaEvoDoCaixa(credEvoTurno)
  : aba('evo', CFG.evo.url, u => u.startsWith(CFG.evo.url.replace(/\/$/, '')));

async function esperarCaptura(desde, ms) {
  const fim = Date.now() + (ms || CFG.tempos.captura);
  while (Date.now() < fim) {
    const c = capturas.find(x => x.quando >= desde && !x.usada && x.html);
    if (c) { c.usada = true; return c; }
    await dormir(250);
  }
  return null;
}

// LGPD: mascara CPF, celular, cartão e nome do cliente (texto e campos) antes de salvar a foto/HTML do diagnóstico.
function mascararTexto(t) {
  return String(t || '')
    .replace(/\b\d{3}\.?\d{3}\.?\d{3}-?(\d{2})\b/g, '***.***.***-$1')
    .replace(/\(?\b\d{2}\)?\s?9?\d{4}-?(\d{4})\b/g, '(**) *****-$1');
}
async function mascararPagina(p) {
  await p.evaluate(() => {
    const cpf = /\b\d{3}\.?\d{3}\.?\d{3}-?(\d{2})\b/g, cel = /\(?\b\d{2}\)?\s?9?\d{4}-?(\d{4})\b/g;
    const m = t => t.replace(cpf, '***.***.***-$1').replace(cel, '(**) *****-$1');
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n; (n = w.nextNode());) { const v = m(n.nodeValue); if (v !== n.nodeValue) n.nodeValue = v; }
    // campos com 6+ dígitos, com ou sem pontuação (ex.: CPF 000.000.000-00): mantém só os 2 últimos dígitos
    document.querySelectorAll('input, textarea').forEach(i => {
      const n = (i.value.match(/\d/g) || []).length;
      if (n >= 6) { let k = n; i.value = i.value.replace(/\d/g, d => (--k < 2 ? d : '*')); i.setAttribute('value', i.value); }
    });
    // cabeçalho do cliente: o valor logo depois dos rótulos CLIENTE e CARTÃO
    const folhas = [...document.querySelectorAll('body *')].filter(e => e.children.length === 0 && e.textContent.trim());
    folhas.forEach((e, k) => {
      const r = e.textContent.trim();
      const v = folhas[k + 1];
      if (!v) return;
      if (/^cliente$/i.test(r)) v.textContent = v.textContent.trim().split(/\s+/)[0] + ' ***';
      if (/^cart[ãa]o$/i.test(r)) v.textContent = v.textContent.replace(/\d(?=\d{3})/g, '*');
    });
  }).catch(() => {});
}

async function diagnostico(p, nome) {
  try {
    const base = path.join(DIAG, `${new Date().toISOString().replace(/[:.]/g, '-')}-${nome}`);
    if (p) {
      await mascararPagina(p);
      await p.screenshot({ path: base + '.png', fullPage: true }).catch(() => {});
      fs.writeFileSync(base + '.html', mascararTexto(await p.content().catch(() => '')));
    }
    log('Diagnóstico salvo:', base);
  } catch (_) {}
}

// ------------------------------------------------------------------ PDF e impressão

function comBase(html, url) {
  const base = `<base href="${url}">`;
  return /<head[^>]*>/i.test(html) ? html.replace(/<head([^>]*)>/i, `<head$1>${base}`) : base + html;
}

// Conteúdo mais largo que a bobina (ex.: fechamento do EVO feito para A4) é reduzido para caber, sem cortar as bordas.
async function ajustarLargura(pg) {
  await pg.evaluate(() => {
    document.documentElement.style.margin = '0'; document.body.style.margin = '0';
    const larg = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
    const vis = window.innerWidth;
    if (larg > vis + 2) document.body.style.zoom = String(Math.max(0.3, (vis - 4) / larg));
  }).catch(() => {});
}

async function abrirConteudo(pg, html) {
  // 'load' basta para o comprovante; a espera pela rede parada fica curta (antes: até 20 s)
  await pg.setContent(html, { waitUntil: 'load', timeout: 8000 }).catch(() => {});
  await pg.waitForLoadState('networkidle', { timeout: 600 }).catch(() => {});
}
// PDF e PNG do mesmo comprovante numa só abertura (com cache por arquivo)
const cacheRender = new Map();
// Começa a preparar o PDF/imagem assim que o comprovante é capturado, enquanto o robô segue trabalhando.
function adiantarRender(doc) { if (doc && doc.tipo === 'html') renderizarDoc(doc).catch(() => {}); }
function renderizarDoc(doc) {
  if (cacheRender.has(doc.arq)) return cacheRender.get(doc.arq);
  const prom = renderizarDocAgora(doc);
  cacheRender.set(doc.arq, prom);
  prom.catch(() => cacheRender.delete(doc.arq));
  if (cacheRender.size > 40) cacheRender.delete(cacheRender.keys().next().value);
  return prom;
}
async function renderizarDocAgora(doc) {
  const larguraMm = CFG.larguraPapelMm || 80;
  // fechamento do EVO: área útil menor que o papel (a térmica não imprime nas bordas), centralizada
  const margem = doc.margemMm !== undefined ? doc.margemMm : 0;
  const util = larguraMm - 2 * margem;
  const b = await navegadorRender();
  const pg = await b.newPage({ viewport: { width: Math.round(util * 3.78), height: 60 }, deviceScaleFactor: 2 });
  try {
    await abrirConteudo(pg, fs.readFileSync(doc.arq, 'utf8'));
    await pg.emulateMedia({ media: 'print' });
    await ajustarLargura(pg);
    const altura = await pg.evaluate(() => Math.max(document.body.scrollHeight, document.documentElement.scrollHeight));
    const minimo = Math.round(larguraMm * 3.78 * 1.25);
    const pdf = await pg.pdf({ width: larguraMm + 'mm', height: Math.max(altura + 40, minimo) + 'px', printBackground: true,
                               margin: { top: '0', bottom: '0', left: margem + 'mm', right: margem + 'mm' } });
    const png = await pg.screenshot({ fullPage: true, type: 'png' });
    return { pdf, png };
  } finally { await pg.close(); }
}

async function htmlParaPdf(html, url, larguraMm) {
  const b = await navegadorRender();
  const pg = await b.newPage({ viewport: { width: Math.round((larguraMm || 80) * 3.78), height: 60 } });
  try {
    await abrirConteudo(pg, url ? comBase(html, url) : html);
    await pg.emulateMedia({ media: 'print' });
    if (larguraMm) await ajustarLargura(pg);
    if (larguraMm) {
      const altura = await pg.evaluate(() => Math.max(document.body.scrollHeight, document.documentElement.scrollHeight));
      // página sempre "em pé": a altura nunca fica menor que a largura (senão o Windows gira o papel)
      const minimo = Math.round(larguraMm * 3.78 * 1.25);
      return await pg.pdf({ width: larguraMm + 'mm', height: Math.max(altura + 40, minimo) + 'px', printBackground: true,
                            margin: { top: '0', bottom: '0', left: '0', right: '0' } });
    }
    return await pg.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true });
  } finally { await pg.close(); }
}

function ticketReserva(job) {
  const agora = new Date().toLocaleString('pt-BR');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    body{font-family:Arial,sans-serif;width:72mm;margin:4mm;text-align:center}
    h1{font-size:15pt;margin:0 0 2mm} .s{font-size:44pt;font-weight:bold;margin:2mm 0}
    p{margin:1mm 0;font-size:10pt}</style></head><body>
    <h1>${CFG.posto || 'Postos Pichilau'}</h1><p>BANHO PICHILAU+</p>
    <p>SENHA</p><div class="s">${job.ticket}</div>
    <p>${agora}</p><p>Resgate ${job.codigo || ''}</p></body></html>`;
}

// Impressora: a escolhida no painel do caixa (engrenagem) vale primeiro;
// vazio no painel = config.json; vazio nos dois = impressora padrão do Windows.
// Duas escolhas no painel: impressora da senha (cliente) e impressora do fechamento (EVO + relatório do turno).
let impressoraPainel = '', impressoraFechamento = '';
function impressoraAtual(tipo) {
  if (tipo === 'fechamento') return impressoraFechamento || impressoraPainel || CFG.impressora || '';
  return impressoraPainel || CFG.impressora || '';
}
function notarImpressora(r) {
  if (r && typeof r.impressora === 'string' && r.impressora !== impressoraPainel) {
    impressoraPainel = r.impressora;
    log('Impressora da senha:', impressoraPainel || '(padrão do Windows)');
  }
  if (r && typeof r.impressoraFechamento === 'string' && r.impressoraFechamento !== impressoraFechamento) {
    impressoraFechamento = r.impressoraFechamento;
    log('Impressora do fechamento:', impressoraFechamento || '(a mesma da senha)');
  }
}

async function enviarImpressoras() {
  try {
    const ptp = require('pdf-to-printer');
    const lista = (await ptp.getPrinters()).map(i => i.name);
    const padrao = await ptp.getDefaultPrinter().then(p => (p && p.name) || '').catch(() => '');
    notarImpressora(await api('robo_impressoras', { lista, padrao }, 1));
    log('Lista de impressoras enviada ao painel:', lista.length, 'impressora(s); padrão:', padrao || '?');
  } catch (e) { log('Não consegui listar as impressoras:', e.message); }
}

// Imagem (PNG) de cada impressão, enviada ao servidor para o navegador do caixa imprimir.
async function htmlParaPng(html, larguraMm) {
  const b = await navegadorRender();
  const pg = await b.newPage({ viewport: { width: Math.round((larguraMm || 80) * 3.78), height: 60 }, deviceScaleFactor: 3 });
  try {
    await abrirConteudo(pg, html);
    await pg.emulateMedia({ media: 'print' });
    await ajustarLargura(pg);
    return await pg.screenshot({ fullPage: true, type: 'png' });
  } finally { await pg.close(); }
}
async function docParaPng(doc) {
  if (!doc || !fs.existsSync(doc.arq)) return null;
  if (doc.tipo === 'html') return (await renderizarDoc(doc)).png;
  return fs.readFileSync(doc.arq);
}
async function enviarImagem(tipo, ref, png, pdf) {
  if (!png) return;
  try {
    const r = await api('robo_imagem', { tipo, ref, png: Buffer.from(png).toString('base64'), pdf: pdf ? Buffer.from(pdf).toString('base64') : '' }, 2);
    if (r && r.ok) log('Imagem da impressão enviada ao painel:', tipo); else log('Painel recusou a imagem:', r && r.erro);
  } catch (e) { log('Não consegui enviar a imagem da impressão:', e.message); }
}

async function imprimir(pdfBuffer, nome, tipo, impressoraEscolhida) {
  const arq = path.join(TICKETS, nome);
  fs.writeFileSync(arq, pdfBuffer);
  if (CFG.naoImprimir) { log('Impressão desligada (naoImprimir). Arquivo:', arq); return arq; }
  if (CFG.imprimirNoRobo === false) { log('Impressão no robô desligada no painel (imprime no navegador do caixa).'); return arq; }
  const ptp = require('pdf-to-printer');
  const destino = impressoraEscolhida || impressoraAtual(tipo);   // v2.12.3: o totem pode escolher a impressora
  await ptp.print(arq, Object.assign({ scale: 'noscale', orientation: 'portrait' }, destino ? { printer: destino } : {}));
  log('Ticket enviado para', destino || 'impressora padrão do Windows');
  return arq;
}

function pastaDoMes(raiz, d) {
  const p = path.join(raiz, `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function nomeArquivo(job) {
  const d = new Date(job.horaResgate || Date.now());
  const z = n => String(n).padStart(2, '0');
  if (job.semEvo) return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}.${z(d.getMinutes())} - ${job.tipoResgate || 'refeicao'} - resgate.${job.codigo}.pdf`;
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}.${z(d.getMinutes())} - id ${job.ticket} - resgate.${job.codigo}.pdf`;
}

// v2.10.0: fila de PDFs para a nuvem. Tenta o OneDrive (pastaNuvem/pastaBackup); se falhar, manda para o
// Google Drive pelo servidor. Até 5 tentativas, 1 min entre elas; o jornal só some depois de salvo.
const filaSalvar = [];
let salvandoNuvem = false;
function salvarEmSegundoPlano(j) {
  if (!filaSalvar.some(x => x.id === j.id)) filaSalvar.push(j);
  if (!salvandoNuvem) rodarFilaSalvar().catch(e => { salvandoNuvem = false; log('Fila de PDFs parou:', e.message); });
}
async function rodarFilaSalvar() {
  salvandoNuvem = true;
  while (filaSalvar.length) {
    const j = filaSalvar[0];
    try {
      j.arquivo = await salvarPdfUnificado(j);
      j.etapa = 'SALVO'; jornalGravar(j);
      await api('robo_atualizar', { id: j.id, arquivo: j.arquivo }).catch(() => {});
      jornalApagar(j.id);
      filaSalvar.shift();
      log(`[${j.id}] PDF na nuvem: ${j.arquivo}`);
    } catch (e) {
      j.tentSalvar = (j.tentSalvar || 0) + 1; jornalGravar(j);
      log(`[${j.id}] Não salvei o PDF na nuvem (tentativa ${j.tentSalvar}/5): ${e.message}`);
      filaSalvar.shift();
      if (j.tentSalvar < 5) { filaSalvar.push(j); await dormir(60000); }
      else log(`[${j.id}] PDF fica no jornal; o robô tenta de novo ao reiniciar.`);
    }
  }
  salvandoNuvem = false;
}

async function salvarPdfUnificado(job) {
  const doc = await PDFDocument.create();
  for (const d of [job.docClub].concat(job.docsViaCaixa && job.docsViaCaixa.length ? job.docsViaCaixa : [job.docViaCaixa])) {
    const buf = await docParaPdf(d);
    if (!buf) continue;
    const src = await PDFDocument.load(buf);
    (await doc.copyPages(src, src.getPageIndices())).forEach(pg => doc.addPage(pg));
  }
  const bytes = Buffer.from(await doc.save());
  const nome = nomeArquivo(job);
  const destinos = pastasDestino();
  let salvo = '';
  for (const raiz of destinos) {
    try {
      const arq = path.join(pastaDoMes(raiz, new Date(job.horaResgate || Date.now())), nome);
      fs.writeFileSync(arq, bytes);
      salvo = salvo || arq;
      log('PDF salvo:', arq);
    } catch (e) { log('Não consegui salvar em', raiz, '-', e.message); }
  }
  if (!salvo) {
    // OneDrive indisponível: guarda no Google Drive pelo servidor (pasta do app)
    const r = await api('robo_arquivo', { ref: job.id, nome, pdf: bytes.toString('base64') }, 2).catch(e => ({ ok: false, erro: e.message }));
    if (r && r.ok) { log('PDF salvo no Google Drive:', nome); return 'Drive: ' + nome; }
    throw new Error('Nenhuma pasta de destino disponível para o PDF' + (r && r.erro ? ' (Drive: ' + r.erro + ')' : ''));
  }
  return nome;
}

// Guarda o que foi capturado (HTML ou foto da tela) para virar PDF depois.
// Assim, se algo cair depois do resgate, nada se perde e nada se repete.
async function guardarCaptura(nome, cap, paginaReserva) {
  if (cap && cap.html) {
    const arq = path.join(TICKETS, nome + '.html');
    fs.writeFileSync(arq, comBase(cap.html, cap.url || 'about:blank'));
    return { tipo: 'html', arq };
  }
  if (paginaReserva) {
    const arq = path.join(TICKETS, nome + '.png');
    await paginaReserva.screenshot({ path: arq }).catch(() => {});
    if (fs.existsSync(arq)) return { tipo: 'png', arq };
  }
  return null;
}

async function docParaPdf(doc) {
  if (!doc || !fs.existsSync(doc.arq)) return null;
  if (doc.tipo === 'html') return (await renderizarDoc(doc)).pdf;
  const pdf = await PDFDocument.create();
  const img = await pdf.embedPng(fs.readFileSync(doc.arq));
  // foto da tela (reserva) também no tamanho da bobina, igual à senha
  const largura = (CFG.larguraPapelMm || 80) * 72 / 25.4, k = largura / img.width;
  const altura = Math.max(img.height * k, largura * 1.25);
  const pg = pdf.addPage([largura, altura]);
  pg.drawImage(img, { x: 0, y: altura - img.height * k, width: largura, height: img.height * k });
  return Buffer.from(await pdf.save());
}

// ------------------------------------------------------------------ leitura do código do resgate

// v2.13.1: abre "Histórico deste cliente" e procura um resgate do prêmio feito agora (a partir de 'desde')
async function codigoNoHistorico(p, tp, desde) {
  try {
    await p.keyboard.press('Escape').catch(() => {});
    await clicarTexto(p, /hist[óo]rico deste cliente/i, null, 10000);
    await dormir(2500);
    const txt = (await p.locator('body').innerText().catch(() => '')).replace(/\r/g, '');
    const prod = String(tp.produto || '').toLowerCase();
    const blocos = txt.split(/(?=\b\d{2}\/\d{2}\/\d{4})/);
    for (const b of blocos) {
      const d = /^(\d{2})\/(\d{2})\/(\d{4})\D{0,6}(\d{2}):(\d{2})/.exec(b);
      if (!d || (prod && b.toLowerCase().indexOf(prod.slice(0, 18)) < 0)) continue;
      const quando = new Date(+d[3], +d[2] - 1, +d[1], +d[4], +d[5]).getTime();
      if (quando < desde - 3 * 60 * 1000 || quando > Date.now() + 60 * 1000) continue;
      const c = /\b((?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8})\b/i.exec(b);
      if (c) return c[1];
    }
  } catch (_) {}
  return '';
}
function extrairCodigo(texto) {
  if (!texto) return '';
  const t = texto.replace(/\s+/g, ' ');
  const regras = [];
  if (CFG.clubpetro.regexCodigo) regras.push(new RegExp(CFG.clubpetro.regexCodigo, 'i'));
  regras.push(/(?:c[óo]d(?:igo)?|voucher|resgate|autoriza[çc][ãa]o)\s*(?:do resgate)?\s*[:#nº°.\-]*\s*([a-z0-9]{6,12})\b/i);
  regras.push(/\b((?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8})\b/i);
  for (const r of regras) {
    const m = r.exec(t);
    if (m && /[a-z]/i.test(m[1]) && /\d/.test(m[1])) return m[1].toLowerCase();
  }
  return '';
}

// ------------------------------------------------------------------ ClubPetro

// v2.13.1: espera o botão aparecer (o ClubPetro às vezes demora para mostrar a próxima tela)
async function clicarTexto(p, re, escopo, ms) {
  const base = escopo || p, fim = Date.now() + (ms || 45000);
  while (Date.now() < fim) {
    const b = base.getByRole('button', { name: re }).first();
    if (await b.isVisible().catch(() => false) && await b.isEnabled().catch(() => true)) { await b.click({ timeout: 15000 }); return; }
    const t = base.getByText(re).first();
    if (await t.isVisible().catch(() => false)) { await t.click({ timeout: 15000 }); return; }
    await dormir(300);
  }
  throw new Error('O botão "' + String(re.source || re).replace(/[\\^$]/g, '') + '" não apareceu no ClubPetro (lentidão)');
}

async function digitarData(campo, nasc, completa) {
  const valor = completa ? nasc : nasc.slice(0, 5);
  await campo.click(); await campo.fill('');
  await campo.type(valor, { delay: 60 });
  const v = await campo.inputValue();
  if (v.replace(/\D/g, '') !== valor.replace(/\D/g, '')) {
    await campo.fill(''); await campo.type(valor.replace(/\D/g, ''), { delay: 60 });
  }
}

// Procura o cliente na lista que abre embaixo do campo de busca do ClubPetro.
// A lista pode mostrar o nome, o CPF ou os dois; aceitamos a opção que tiver os dígitos do CPF
// ou, se houver uma única opção de cliente, essa. Registra no log o que apareceu (sem o CPF inteiro).
async function escolherClienteNaLista(p, busca, j) {
  const ignorar = /pesquise|digite|nenhum|n[ãa]o encontrad|carregando|sem resultado|no options/i;
  const candidatos = () => p.locator([
    '[role="option"]', '[role="listbox"] li', '.MuiAutocomplete-option', '[class*="-option"]',
    '[class*="menu"] li', '[class*="dropdown"] li', '[class*="popper"] li', '[class*="Popper"] li', '[class*="suggest"] li'
  ].join(', '));
  const tentarAte = async (ms) => {
    const fim = Date.now() + ms;
    while (Date.now() < fim) {
      const lista = candidatos();
      const n = await lista.count();
      const validas = [];
      for (let i = 0; i < Math.min(n, 30); i++) {
        const el = lista.nth(i);
        if (!(await el.isVisible().catch(() => false))) continue;
        const txt = ((await el.innerText().catch(() => '')) || '').trim();
        if (!txt || ignorar.test(txt) || txt.length > 200) continue;
        validas.push({ el, txt });
      }
      const comCpf = validas.find(v => v.txt.replace(/\D/g, '').includes(j.cpf));
      if (comCpf) return comCpf.el;
      if (validas.length === 1 && Date.now() > fim - ms + 2500) {
        log('[' + j.id + '] Opção única na lista do ClubPetro (sem CPF no texto), usando ela. (nome do cliente não vai para o log - LGPD)');
        return validas[0].el;
      }
      if (validas.length > 1) log('[' + j.id + '] Lista do ClubPetro com', validas.length, 'opções; nenhuma com o CPF no texto.');
      await dormir(400);
    }
    return null;
  };
  let el = await tentarAte(9000);
  if (el) return el;
  // segunda tentativa: digitar o CPF formatado
  const cpfFmt = j.cpf.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  await busca.fill('');
  await busca.type(cpfFmt, { delay: 60 });
  el = await tentarAte(9000);
  if (el) return el;
  // terceira: tecla para baixo + Enter (alguns campos só abrem a lista assim)
  await busca.press('ArrowDown').catch(() => {});
  el = await tentarAte(3000);
  if (el) return el;
  log('[' + j.id + '] Nenhum cliente apareceu na busca (a foto da tela fica na pasta diagnostico).');
  return null;
}

// Marca (com data-robo-alvo) o botão "Adicionar prêmio" (seta para cima) do cartão do Banho.
// 1º pelo rótulo "Adicionar prêmio"; 2º pela seta de cima mais próxima do nome do produto.
async function marcarBotaoAdicionar(p, produto) {
  return p.evaluate((nome) => {
    document.querySelectorAll('[data-robo-alvo]').forEach(e => e.removeAttribute('data-robo-alvo'));
    const visivel = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const titulo = [...document.querySelectorAll('body *')].find(e => visivel(e) && e.children.length === 0 && e.textContent.trim().toLowerCase() === nome.toLowerCase());
    if (!titulo) return { achou: false, motivo: 'nome do produto não está na tela' };
    // cartão = menor ancestral que contém "pontos" e algum elemento clicável
    let cartao = titulo.parentElement;
    while (cartao && !(/pontos/i.test(cartao.innerText) && cartao.querySelector('svg, button, [role="button"]'))) cartao = cartao.parentElement;
    if (!cartao) return { achou: false, motivo: 'cartão do produto não encontrado' };
    const custo = Number(((/(\d+)\s*pontos/i.exec(cartao.innerText) || [])[1]) || 0);
    const rotulo = /adicionar\s*pr[êe]mio|add|incrementar|aumentar/i;
    let alvo = [...cartao.querySelectorAll('[aria-label], [title], [data-tooltip], [data-tip]')].find(e => visivel(e) &&
      rotulo.test(e.getAttribute('aria-label') || e.getAttribute('title') || e.getAttribute('data-tooltip') || e.getAttribute('data-tip') || ''));
    let como = 'rótulo';
    if (!alvo) {
      // seta de cima: entre os clicáveis pequenos do cartão, o mais alto na coluna mais à direita
      const cands = [...cartao.querySelectorAll('button, [role="button"], svg')]
        .filter(e => visivel(e) && !(e.tagName.toLowerCase() === 'svg' && (e.parentElement.closest('svg') || e.closest('button, [role="button"]'))))
        .map(e => ({ e, r: e.getBoundingClientRect() })).filter(o => o.r.width < 60 && o.r.height < 60);
      if (!cands.length) return { achou: false, motivo: 'sem setas no cartão', custo };
      const maxX = Math.max(...cands.map(o => o.r.left));
      const coluna = cands.filter(o => o.r.left > maxX - 30).sort((a, b) => a.r.top - b.r.top);
      alvo = coluna[0].e; como = 'posição (seta de cima)';
    }
    const clicavel = alvo.closest('button, [role="button"]') || alvo;
    clicavel.setAttribute('data-robo-alvo', 'adicionar');
    return { achou: true, como, custo };
  }, produto);
}

// ---------- login do portal ClubPetro (login e senha cadastrados pelo auditor no painel)
let credClub = null;
async function precisaLoginClub(p) {
  await p.waitForLoadState('domcontentloaded').catch(() => {});
  await dormir(800);
  if (/login|signin|sign-in|entrar|auth/i.test(p.url())) return true;
  return (await p.locator('input[type="password"]:visible').count()) > 0;
}
async function loginClubPetro(p) {
  if (!credClub) throw new Error('LOGIN_CLUBPETRO: o ClubPetro pediu login e não há login cadastrado (engrenagem › Configurações do posto)');
  const senha = p.locator('input[type="password"]:visible').first();
  await senha.waitFor({ state: 'visible', timeout: 15000 });
  const usuario = p.locator('input:visible:not([type="password"]):not([type="hidden"]):not([type="checkbox"]):not([type="radio"])').first();
  await usuario.fill(credClub.usuario);
  await senha.fill(credClub.senha);
  const botao = p.getByRole('button', { name: /entrar|acessar|login|logar|continuar/i }).first();
  if (await botao.count()) await botao.click(); else await senha.press('Enter');
  try { await p.waitForURL(u => !/login|signin|sign-in|auth/i.test(String(u)), { timeout: 25000 }); }
  catch (_) { await diagnostico(p, 'login-clubpetro'); throw new Error('LOGIN_CLUBPETRO: o ClubPetro não aceitou o login cadastrado'); }
  log('Login no ClubPetro feito como', credClub.usuario);
}

// ---------- configuração do posto vinda do painel (auditor)
let versaoConfig = null;
async function carregarConfigRemota(forcar) {
  try {
    const r = await api('robo_config', {}, 2);
    if (!r || !r.ok) return;
    if (r.evoUrl) CFG.evo.url = r.evoUrl;
    if (r.evoBotao) CFG.evo.botao = r.evoBotao;
    if (r.produto) CFG.clubpetro.produto = r.produto;
    if (Array.isArray(r.modalidades)) CFG.modalidades = r.modalidades;
    if (r.atualizarHora !== undefined) CFG.atualizarHora = r.atualizarHora;   // v2.13.0: horário da atualização automática     // v2.9.0: banho, refeição...
    credClub = r.clubpetro || null;
    CFG.imprimirNoRobo = r.imprimirNoRobo !== false;
    if (r.posto) CFG.posto = 'Postos Pichilau - ' + r.posto;
    versaoConfig = r.versaoConfig || '';
    log('Configuração do posto carregada:', r.posto || '?', '· EVO', CFG.evo.url, '· botão', CFG.evo.botao,
        '· ClubPetro', credClub ? 'com login cadastrado' : 'sem login cadastrado');
  } catch (e) { log('Não consegui carregar a configuração do posto:', e.message); }
}
function notarConfig(r) { if (r && typeof r.versaoConfig === 'string' && versaoConfig !== null && r.versaoConfig !== versaoConfig) carregarConfigRemota(); }

// Saldo do cliente: o número que aparece logo abaixo do rótulo PONTOS (ex.: "0", "1.250" ou "1.250,00").
// v2.12.4: nome do cliente no cabeçalho do ClubPetro ("CLIENTE  Madalena Da Silva Gomes") → "Madalena Gomes"
async function lerNomeCliente(p) {
  const nome = await p.evaluate(() => {
    const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const rot = [...document.querySelectorAll('body *')].find(e => e.children.length === 0 && vis(e) && /^cliente$/i.test(e.textContent.trim()));
    if (!rot) return '';
    let el = rot.nextElementSibling;
    if (!el && rot.parentElement) el = rot.parentElement.nextElementSibling;
    if (el && el.textContent.trim()) return el.textContent.trim();
    const linhas = (rot.parentElement ? rot.parentElement.innerText : '').split('\n').map(x => x.trim()).filter(Boolean);
    return linhas[1] || '';
  }).catch(() => '');
  const partes = String(nome || '').replace(/\s+/g, ' ').trim().split(' ').filter(w => !/^(da|de|do|das|dos|e)$/i.test(w));
  if (!partes.length) return '';
  const cap = w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  return (partes.length > 1 ? cap(partes[0]) + ' ' + cap(partes[partes.length - 1]) : cap(partes[0])).slice(0, 40);
}
async function lerPontosCliente(p) {
  // Cabeçalho do cliente: CLIENTE · CPF · CARTÃO · PONTOS · CELULAR (rótulo e o valor logo depois).
  // Procuramos o PONTOS que vem depois do CPF, para não confundir com os "1080 PONTOS" dos prêmios.
  const txt = await p.evaluate(() => {
    const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const folhas = [...document.querySelectorAll('body *')].filter(e => e.children.length === 0 && vis(e) && e.textContent.trim());
    const t = e => e.textContent.trim();
    const iCpf = folhas.findIndex(e => /^cpf$/i.test(t(e)));
    if (iCpf < 0) return '';
    for (let k = iCpf + 1; k < Math.min(folhas.length, iCpf + 12); k++) {
      if (/^pontos$/i.test(t(folhas[k]))) {
        for (let m = k + 1; m < Math.min(folhas.length, k + 4); m++) if (/^[\d.]+(,\d+)?$/.test(t(folhas[m]))) return t(folhas[m]);
        return '';
      }
    }
    return '';
  }).catch(() => '');
  if (!txt) return null;
  const n = Number(txt.replace(/\./g, '').replace(',', '.'));
  return isNaN(n) ? null : n;
}

async function etapaClubPetro(j) {
  const tp = tipoDoResgate(j);
  // v2.10.0: cliente já aberto pela consulta de pontos? continua dali (sem novo resgate/CPF/continuar)
  let reuso = null;
  if (j.consultaId) {
    const c = clientesAbertos.get(j.consultaId), ab = abasClub.get('q:' + j.consultaId);
    if (c && ab && !ab.p.isClosed() && c.cpf === j.cpf) { reuso = ab.p; clearTimeout(c.timer); clientesAbertos.delete(j.consultaId); log(`[${j.id}] ClubPetro: cliente já aberto pela consulta.`); }
  }
  const chave = reuso ? 'q:' + j.consultaId : chaveCaixa();
  const p = reuso || await abaClub();
  const a = abasClub.get(chave);
  if (!reuso) {
  if (a.pronta) { await a.pronta; a.pronta = null; }
  // Layout de computador sempre: com janela estreita o ClubPetro troca para o layout de celular
  // (sem o texto "Prêmios resgatados") e o robô recusava clientes com pontos (v2.5.0).
  await p.setViewportSize({ width: 1366, height: 768 }).catch(() => {});
  const pronta = a.ok && Date.now() - a.em < CLUB_PRONTA_MS && p.url().startsWith(CFG.clubpetro.urlResgate);
  a.ok = false;
  if (!pronta) await deixarClubPronto(chave);
  else log(`[${j.id}] ClubPetro: aba do caixa já estava pronta.`);
  a.ok = false;

  // 1. Janela "Resgate de prêmios": escolher CPF e buscar o cliente
  const modal = p.locator('[role="dialog"], .modal, .MuiDialog-root').filter({ hasText: /Resgate de pr[êe]mios/i }).last();
  if (!(await modal.isVisible().catch(() => false))) await clicarTexto(p, /novo resgate/i);
  await modal.waitFor({ state: 'visible' });
  await modal.getByText(/^CPF$/).first().click();
  const busca = modal.locator('input:visible:not([type="radio"]):not([type="checkbox"])').first();
  await busca.click();
  await busca.type(j.cpf, { delay: 50 });
  const cpfFmt = j.cpf.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  const opcao = await escolherClienteNaLista(p, busca, j);
  if (!opcao) {
    await diagnostico(p, j.id + '-cpf');
    throw new ErroCliente('CPF_NAO_ENCONTRADO', 'Não encontramos esse CPF no Pichilau+. Confira os números ou procure o caixa para se cadastrar.');
  }
  await opcao.click();
  await clicarTexto(p, /continuar resgate/i, modal);
  }   // fim do "if (!reuso)"

  // 2. Cliente carregado: conferir pontos
  await p.getByText(/hist[óo]rico deste cliente/i).first().waitFor({ state: 'visible' });
  j.pontos = await lerPontosCliente(p);
  j.cliente = await lerNomeCliente(p);       // v2.12.4: só nome e último sobrenome, para o caixa conferir
  if (j.pontos !== null || j.cliente) {
    if (j.pontos !== null) log(`[${j.id}] Saldo do cliente: ${j.pontos} pontos`);
    await api('robo_atualizar', { id: j.id, etapa: 'CLUBPETRO', pontos: j.pontos === null ? undefined : j.pontos, cliente: j.cliente || undefined }).catch(() => {});
  }

  // 3. Por categoria › Serviço › Banho (+1)
  await p.getByText(/^por categoria$/i).first().click();
  if (Date.now() - ultimoEnvioPremios > 6 * 3600 * 1000) {      // atualiza a lista de prêmios do painel (no máx. a cada 6 h)
    await p.getByText(/^todas$/i).first().click().catch(() => {});
    await dormir(600);
    enviarPremios(await lerPremios(p));
  }
  await p.getByText(new RegExp(`^${escRe(tp.categoria)}$`, 'i')).first().click();
  await p.getByText(new RegExp(`^${escRe(tp.produto)}$`, 'i')).first().waitFor({ state: 'visible' });
  await dormir(600);
  const info = await marcarBotaoAdicionar(p, tp.produto);
  if (info.custo) await api('robo_atualizar', { id: j.id, etapa: 'CLUBPETRO', custo: info.custo * Math.max(1, Number(j.qtd || 1)) }).catch(() => {});
  const qtd = Math.max(1, Number(j.qtd || 1));
  if (info.custo && j.pontos !== undefined && j.pontos < info.custo * qtd) {
    throw new ErroCliente('PONTOS_INSUFICIENTES', qtd > 1
      ? `Pontos insuficientes para ${qtd} banhos (precisa de ${info.custo * qtd}, tem ${j.pontos}). Tente com menos fichas.`
      : `Você ainda não tem pontos suficientes para ${String(tp.nome || 'o resgate').toLowerCase()} (precisa de ${info.custo}, tem ${j.pontos}).`);
  }
  if (!info.achou) {
    await diagnostico(p, j.id + '-mais');
    throw new Error('Não achei o botão Adicionar prêmio do ' + tp.produto + ' (' + info.motivo + ')');
  }
  log('[' + j.id + '] Botão Adicionar prêmio encontrado por', info.como);
  const mais = p.locator('[data-robo-alvo="adicionar"]').first();
  await mais.scrollIntoViewIfNeeded().catch(() => {});
  await mais.hover().catch(() => {});
  for (let i = 0; i < qtd; i++) { await mais.click(); await dormir(500); }     // uma ficha por clique
  // Confere a quantidade: 1º o contador do cartão do Banho (entre as setas; existe nos layouts de computador e de celular),
  // 2º o texto "Prêmios resgatados: N" (só no layout de computador).
  const lerQtdCartao = () => p.evaluate(() => {
    const b = document.querySelector('[data-robo-alvo="adicionar"]');
    const caixa = b && b.parentElement;
    if (!caixa) return null;
    const num = [...caixa.children].map(e => e.textContent.trim()).find(t => /^\d+$/.test(t));
    return num === undefined ? null : Number(num);
  }).catch(() => null);
  const textoQtd = p.getByText(new RegExp('pr[êe]mios resgatados:\\s*' + qtd + '\\b', 'i')).first();
  let qtdOk = false;
  for (const limite = Date.now() + 6000; Date.now() < limite;) {
    if ((await lerQtdCartao()) === qtd || await textoQtd.isVisible().catch(() => false)) { qtdOk = true; break; }
    await dormir(300);
  }
  if (qtdOk) log('[' + j.id + '] Banho adicionado (quantidade ' + qtd + ' conferida)');
  else {
    await diagnostico(p, j.id + '-mais');
    throw new ErroCliente('PONTOS_INSUFICIENTES', 'Não foi possível adicionar ' + String(tp.nome || 'o prêmio').toLowerCase() + '. Seus pontos podem não ser suficientes. Procure o caixa.', 'Botão + do ' + tp.produto + ' não respondeu');
  }

  // 4. Finalizar › Confirmar
  await clicarTexto(p, /finalizar resgate/i);
  const conf = p.locator('[role="dialog"], .modal, .MuiDialog-root').filter({ hasText: /confirmar resgate/i }).last();
  await conf.waitFor({ state: 'visible', timeout: 60000 });
  await clicarTexto(p, /confirmar resgate/i, conf);

  // 5. Data de nascimento (alguns pedem DD/MM, outros DD/MM/AAAA)
  const val = p.locator('[role="dialog"], .modal, .MuiDialog-root').filter({ hasText: /nascimento/i }).last();
  await val.waitFor({ state: 'visible', timeout: 60000 });
  const pedeAno = /AAAA|YYYY|ano/i.test(await val.innerText());
  await digitarData(val.locator('input:visible').first(), j.nasc, pedeAno);

  j.etapa = 'CLUBPETRO_FINALIZANDO'; jornalGravar(j);
  await api('robo_atualizar', { id: j.id, etapa: 'CLUBPETRO_FINALIZANDO' }).catch(() => {});
  const marco = Date.now();
  await clicarTexto(p, /^finalizar$/i, val);

  // 6. Sucesso ou data errada
  const sucesso = p.getByText(/resgatado com sucesso|resgate realizado com sucesso/i).first();
  const fim = Date.now() + 75000;          // v2.13.1: o ClubPetro às vezes demora para confirmar
  let ok = false;
  while (Date.now() < fim) {
    if (await sucesso.isVisible().catch(() => false)) { ok = true; break; }
    if (capturas.some(x => x.quando >= marco && x.html)) { ok = true; log(`[${j.id}] ClubPetro: confirmado pelo comprovante.`); break; }
    if (await val.isVisible().catch(() => false)) {
      const txt = await val.innerText().catch(() => '');
      if (/inv[áa]lid|incorret|n[ãa]o confere|divergente/i.test(txt) ||
          await p.getByText(/data.*(inv[áa]lid|incorret|n[ãa]o confere)/i).first().isVisible().catch(() => false)) {
        j.etapa = 'CLUBPETRO'; jornalGravar(j);
        throw new ErroCliente('DATA_INVALIDA', 'A data de nascimento não confere com o cadastro do Pichilau+. Confira e tente de novo.');
      }
    }
    await dormir(300);
  }
  let codigoHist = '';
  if (!ok && !(await sucesso.isVisible().catch(() => false))) {
    codigoHist = await codigoNoHistorico(p, tp, marco);       // v2.13.1: confere no histórico se o resgate entrou
    if (!codigoHist) {
      await diagnostico(p, j.id + '-finalizar');
      throw new ErroVerificar('Não apareceu a confirmação do ClubPetro depois de Finalizar');
    }
    log(`[${j.id}] ClubPetro não mostrou a confirmação, mas o resgate está no histórico (código ${codigoHist}).`);
  }
  j.horaResgate = Date.now();

  // 7. Comprovante: o ClubPetro manda imprimir sozinho; se não mandar, clicamos
  let cap = await esperarCaptura(marco, 8000);
  if (!cap) { await clicarTexto(p, /imprimir comprovante/i, null, 8000).catch(() => {}); cap = await esperarCaptura(marco, CFG.tempos.captura); }
  const codigoDe = c => extrairCodigo(c && c.texto) || extrairCodigo(c && c.html && c.html.replace(/<[^>]+>/g, ' '));
  j.codigo = codigoDe(cap) || codigoHist;
  for (const limite = Date.now() + 20000; !j.codigo && Date.now() < limite;) {   // v2.13.1: tela do comprovante pode demorar
    j.codigo = extrairCodigo(await p.locator('body').innerText().catch(() => '')) || (!cap && (cap = await esperarCaptura(marco, 1000)) ? codigoDe(cap) : '');
    if (!j.codigo) await dormir(700);
  }
  if (!j.codigo) j.codigo = await codigoNoHistorico(p, tp, marco);

  j.docClub = await guardarCaptura(j.id + '-clubpetro', cap, p);
  adiantarRender(j.docClub);

  if (!j.codigo) {
    if (cap) fs.writeFileSync(path.join(DIAG, j.id + '-recibo-clubpetro.html'), mascararTexto(cap.html));
    await diagnostico(p, j.id + '-codigo');
    throw new ErroVerificar('Resgate feito no ClubPetro, mas não consegui ler o código no comprovante');
  }
  delete j.cpf; delete j.nasc;              // LGPD: não precisa mais
  j.etapa = 'CLUBPETRO_OK'; jornalGravar(j);
  await api('robo_atualizar', { id: j.id, status: 'PROCESSANDO', etapa: 'CLUBPETRO_OK', codigo: j.codigo }).catch(() => {});
  await clicarTexto(p, /novo resgate/i, null, 5000).catch(() => p.keyboard.press('Escape').catch(() => {}));
  log(`[${j.id}] ClubPetro OK. Código ${j.codigo}`);
}

// ------------------------------------------------------------------ EVO

function modalEvo(p, re) { return p.locator('[role="dialog"], .modal, .swal2-popup, .MuiDialog-root, .v-dialog, div').filter({ hasText: re }).last(); }

// Entra no EVO quando ele mostra a tela de login (depois do Sair do fechamento de caixa).
// Usa evo.usuario e evo.senha do config.json, que ficam só neste computador.
// Login do EVO do caixa que abriu o turno (vem do servidor, cadastrado pelo auditor).
// Se não houver, usa o do config.json; se também não houver, o login salvo no navegador.
let credEvoTurno = null;
function notarCredEvo(t) { credEvoTurno = t && t.evo && t.evo.usuario ? t.evo : null; }

async function usuarioLogadoEvo(p) {
  const txt = await p.locator('body').innerText().catch(() => '');
  const m = /USU[ÁA]RIO\s*:\s*([^\s]+)/i.exec(txt);
  return m ? m[1].trim() : '';
}

async function sairEvo(p) {
  for (const alvo of [p.getByRole('button', { name: /^sair$/i }), p.getByRole('link', { name: /^sair$/i }), p.getByText(/^sair$/i)]) {
    const el = alvo.first();
    if (await el.isVisible().catch(() => false)) { await el.click().catch(() => {}); await p.waitForTimeout(1500); return true; }
  }
  return false;
}

async function garantirLoginEvo(p) {
  const senha = p.locator('input[type="password"]:visible').first();
  if (!(await senha.count())) return false;
  const usuario = p.locator('input:visible:not([type="password"]):not([type="hidden"]):not([type="checkbox"])').first();
  let como = '';
  const cred = credEvoTurno || (CFG.evo.usuario && CFG.evo.senha ? { usuario: CFG.evo.usuario, senha: CFG.evo.senha } : null);
  if (cred) {
    await usuario.fill(cred.usuario);
    await senha.fill(cred.senha);
    como = credEvoTurno ? 'login do caixa ' + cred.usuario : 'config.json';
  } else {
    // Sem usuário/senha no config.json: usa o login salvo no navegador do robô.
    // O Chrome só libera o preenchimento automático depois de um clique; então clica no campo,
    // escolhe a primeira sugestão salva e confere se usuário e senha foram preenchidos.
    await usuario.click();
    await dormir(700);
    let preenchido = (await usuario.inputValue().catch(() => '')) && (await senha.inputValue().catch(() => ''));
    if (!preenchido) {
      await usuario.press('ArrowDown').catch(() => {});
      await dormir(400);
      await usuario.press('Enter').catch(() => {});
      await dormir(800);
      await senha.click().catch(() => {});
      await dormir(400);
      preenchido = (await usuario.inputValue().catch(() => '')) && (await senha.inputValue().catch(() => ''));
    }
    if (!preenchido) {
      await diagnostico(p, 'login-evo');
      throw new Error('LOGIN_EVO: o EVO pediu login e o navegador do robô não preencheu sozinho. Rode o LOGIN.bat e salve a senha, ou coloque evo.usuario e evo.senha no config.json');
    }
    como = 'login salvo no navegador';
  }
  const botao = p.getByRole('button', { name: /entrar|login|acessar|logar/i }).first();
  if (await botao.count()) await botao.click(); else await senha.press('Enter');
  try { await p.getByRole('button', { name: /emitir/i }).first().waitFor({ state: 'visible', timeout: 20000 }); }
  catch (_) { await diagnostico(p, 'login-evo'); throw new Error('LOGIN_EVO: o EVO não aceitou o login (' + como + ')'); }
  log('Login no EVO feito (' + como + ')');
  return true;
}

async function etapaEvo(j) {
  const qtd = Math.max(1, Number(j.qtd || 1));
  j.tickets = j.tickets || []; j.docsCliente = j.docsCliente || []; j.docsViaCaixa = j.docsViaCaixa || [];
  while (j.tickets.length < qtd) await emitirUmaSenha(j, j.tickets.length + 1, qtd);
  j.ticket = j.tickets.join(', ');
  j.docCliente = j.docsCliente[0] || null; j.docViaCaixa = j.docsViaCaixa[0] || null;
  j.etapa = 'EVO_OK'; jornalGravar(j);
  await api('robo_atualizar', { id: j.id, status: 'SENHA_GERADA', etapa: 'EVO_OK', ticket: j.ticket,
                                msgCliente: qtd > 1 ? 'Senhas geradas. Imprimindo...' : 'Senha gerada. Imprimindo...' }).catch(() => {});
  log(`[${j.id}] EVO OK. Senha(s) ${j.ticket}`);
}

async function emitirUmaSenha(j, n, qtd) {
  const p = await abaEvo();
  const pronta = p.url().startsWith(CFG.evo.url.replace(/\/$/, '')) &&
    !(await p.locator('input[type="password"]:visible').count()) &&
    await p.getByRole('button', { name: /emitir/i }).first().isVisible().catch(() => false);
  if (!pronta) await p.goto(CFG.evo.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await garantirLoginEvo(p);

  const cartao = p.locator('div').filter({ hasText: tipoDoResgate(j).botaoEvo }).filter({ has: p.getByRole('button', { name: /emitir/i }) }).last();
  await cartao.getByRole('button', { name: /emitir/i }).first().click();

  const conf = modalEvo(p, /confirmar emiss[ãa]o/i);
  await conf.waitFor({ state: 'visible' });
  const campo = conf.locator('input:visible, textarea:visible').first();
  await campo.fill(j.codigo);

  j.etapa = 'EVO_EMITINDO'; jornalGravar(j);
  await api('robo_atualizar', { id: j.id, etapa: 'EVO_EMITINDO' }).catch(() => {});
  const marco = Date.now();
  await conf.getByRole('button', { name: /^emitir$/i }).first().click();

  // O EVO tem textos escondidos com "TICKET" (modelo de impressão); só vale o que está visível na tela.
  let numero = '';
  const fimTk = Date.now() + CFG.tempos.ticketEvo;
  while (Date.now() < fimTk && !numero) {
    numero = await p.evaluate(() => {
      const vis = e => { const r = e.getBoundingClientRect(); const st = getComputedStyle(e); return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none'; };
      const els = [...document.querySelectorAll('body *')].filter(e => vis(e) && /TICKET/i.test(e.textContent || '') && e.textContent.length < 400);
      for (const e of els.reverse()) {
        const m = /TICKET\s*:?\s*(\d{1,8})/i.exec((e.innerText || '').replace(/\s+/g, ' '));
        if (m) return m[1];
      }
      return '';
    }).catch(() => '');
    if (!numero) await dormir(500);
  }
  if (!numero) {
    await diagnostico(p, j.id + '-evo');
    const tela = (await p.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);
    log(`[${j.id}] EVO sem número de ticket visível. Tela: ${tela}`);
    throw new ErroVerificar(qtd > 1 ? `EVO não mostrou o número do ticket da ficha ${n} de ${qtd} (já emitidas: ${j.tickets.join(', ') || 'nenhuma'})` : 'EVO não mostrou o número do ticket');
  }
  const caixaTicket = p.locator('[role="dialog"], .modal, .swal2-popup, .MuiDialog-root, .v-dialog, div')
    .filter({ hasText: /TICKET/ }).filter({ has: p.getByRole('button', { name: /via caixa/i }) }).filter({ visible: true }).last();
  j.tickets.push(numero);
  j.etapa = 'CLUBPETRO_OK'; jornalGravar(j);          // a próxima ficha (se houver) pode ser emitida
  log(`[${j.id}] EVO: senha ${numero}${qtd > 1 ? ` (ficha ${n} de ${qtd})` : ''}`);

  // Ticket do cliente: o EVO manda imprimir ao emitir; se não, clicamos em IMPRIMIR
  let capCli = await esperarCaptura(marco, 5000);
  if (!capCli) { const m2 = Date.now(); await clicarTexto(p, /^imprimir$/i, caixaTicket, 8000).catch(() => {}); capCli = await esperarCaptura(m2); }
  const docCli = capCli ? await guardarCaptura(j.id + '-cliente-' + n, capCli) : null;
  if (docCli) { j.docsCliente.push(docCli); adiantarRender(docCli); }

  // Via caixa: só vai para o PDF
  const m3 = Date.now();
  await clicarTexto(p, /via caixa/i, caixaTicket, 10000).catch(() => {});
  const via = await guardarCaptura(j.id + '-viacaixa-' + n, await esperarCaptura(m3), p);
  if (via) { j.docsViaCaixa.push(via); adiantarRender(via); }
  await clicarTexto(p, /^fechar$/i, caixaTicket, 5000).catch(() => {});
  jornalGravar(j);
}

// várias senhas: junta os PDFs e empilha as imagens
async function pdfDasSenhas(j) {
  const docs = (j.docsCliente && j.docsCliente.length) ? j.docsCliente : [j.docCliente].filter(Boolean);
  if (!docs.length) return null;
  const out = await PDFDocument.create();
  for (const d of docs) {
    const buf = await docParaPdf(d); if (!buf) continue;
    const src = await PDFDocument.load(buf);
    (await out.copyPages(src, src.getPageIndices())).forEach(pg => out.addPage(pg));
  }
  return out.getPageCount() ? Buffer.from(await out.save()) : null;
}
async function pngDasSenhas(j) {
  const docs = (j.docsCliente && j.docsCliente.length) ? j.docsCliente : [j.docCliente].filter(Boolean);
  const pngs = [];
  for (const d of docs) { const b = await docParaPng(d); if (b) pngs.push(Buffer.from(b).toString('base64')); }
  if (!pngs.length) return null;
  if (pngs.length === 1) return Buffer.from(pngs[0], 'base64');
  return htmlParaPng('<html><body style="margin:0">' + pngs.map(b => `<img src="data:image/png;base64,${b}" style="width:100%;display:block;margin-bottom:6mm">`).join('') + '</body></html>', CFG.larguraPapelMm || 80);
}

// ------------------------------------------------------------------ pedido completo

async function processar(j) {
  log(`[${j.id}] Iniciando na etapa ${j.etapa}`);
  try {
    if (['RECEBIDO', 'CLUBPETRO'].includes(j.etapa)) { j.etapa = 'CLUBPETRO'; jornalGravar(j); await etapaClubPetro(j); }
    if (j.etapa === 'CLUBPETRO_FINALIZANDO') throw new ErroVerificar('O robô parou no meio da finalização do ClubPetro. Confira no histórico do cliente se o banho foi resgatado.');
    if (j.etapa === 'CLUBPETRO_OK') {
      if (tipoDoResgate(j).usaEvo) await etapaEvo(j);
      else {                                   // v2.9.0: refeição e outras sem EVO: o comprovante do ClubPetro é o que sai
        j.semEvo = true; j.ticket = j.codigo; j.imprimir = true;
        j.etapa = 'EVO_OK'; jornalGravar(j);
      }
    }
    if (j.etapa === 'EVO_EMITINDO') throw new ErroVerificar(`O robô parou no meio da emissão no EVO (código ${j.codigo}). Confira no EVO se o ticket saiu.`);
    if (j.etapa === 'EVO_OK') {
      const t0 = Date.now();
      try {
        const pdfCli = j.semEvo ? ((await docParaPdf(j.docClub)) || await htmlParaPdf(ticketReserva(j), null, CFG.larguraPapelMm || 80))
          : (await pdfDasSenhas(j)) || await htmlParaPdf(ticketReserva(j), null, CFG.larguraPapelMm || 80);
        const pngCli = async () => (j.semEvo ? await docParaPng(j.docClub) : await pngDasSenhas(j)) || await htmlParaPng(ticketReserva(j), CFG.larguraPapelMm || 80);
        // impressão local e envio da imagem (agentes/navegador) em paralelo
        if (j.impTotem) {
          // v2.12.1: o próprio totem imprime a senha (impressora dele); o robô só manda a imagem
          fs.writeFileSync(path.join(TICKETS, j.id + '-cliente.pdf'), pdfCli);
          await enviarImagem('senha', j.id, await pngCli(), pdfCli);
          j.impresso = true; j.aguardaCliente = j.imprimir === false;
          log(`[${j.id}] Senha enviada para o totem imprimir.`);
        } else if (j.imprimir === false) {
          // v2.7.0: o cliente escolhe no totem. A senha fica pronta e só imprime se ele teclar Enter (comando REIMPRIMIR).
          fs.writeFileSync(path.join(TICKETS, j.id + '-cliente.pdf'), pdfCli);
          const png = await pngCli();
          senhasEmEspera[j.id] = { pdf: pdfCli, png, em: Date.now(), local: j.imprimirLocal !== false, impressora: j.impressora };
          j.impresso = true; j.aguardaCliente = true;
          log(`[${j.id}] Senha pronta; impressão só se o cliente pedir no totem.`);
        } else {
          const envio = (async () => enviarImagem('senha', j.id, await pngCli(), pdfCli))();
          // v2.12.1: se um PDV marcou "imprimir senha" para este caixa, quem imprime é o PDV (o robô só manda a imagem)
          if (j.imprimirLocal !== false) await imprimir(pdfCli, j.id + '-cliente.pdf', undefined, j.impressora);
          else log(`[${j.id}] Senha vai para o PDV do caixa imprimir.`);
          j.impresso = true;
          j.envio = envio;                     // o envio para agentes/navegador termina depois do aviso de concluído
        }
      }
      catch (e) { log(`[${j.id}] Falha ao imprimir: ${e.message}`); j.impresso = false; }
      j.etapa = 'IMPRESSO'; jornalGravar(j);
      log(`[${j.id}] Tempo impressão/envio: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    }
    if (j.envio) { await Promise.race([j.envio, dormir(100)]).catch(() => {}); }
    // o cliente e o caixa já veem a senha como concluída; o PDF do OneDrive é montado logo depois
    await api('robo_atualizar', {
      id: j.id, status: 'CONCLUIDO', etapa: j.impresso === false ? 'SEM_IMPRESSAO' : 'CONCLUIDO',
      codigo: j.codigo, ticket: j.ticket,
      mensagem: [j.impresso === false ? 'Senha gerada, mas a impressora falhou. Use Reimprimir.' : '',
                 (j.docViaCaixa || j.semEvo) ? '' : 'PDF sem a via caixa do EVO (robô caiu antes de capturar).'].filter(Boolean).join(' '),
      msgCliente: j.impresso === false ? 'Sua senha está na tela. A impressora falhou: peça ao caixa para reimprimir.'
        : j.semEvo ? 'Pegue o comprovante com o caixa.' : j.aguardaCliente ? 'Anote sua senha ou tecle Enter para imprimir.' : 'Retire seu comprovante.'
    });
    if (j.envio) { await j.envio.catch(() => {}); delete j.envio; }
    // v2.10.0: impresso e avisado; o PDF vai para a nuvem em segundo plano e o robô já pega o próximo cliente
    log(`[${j.id}] Concluído em ${((Date.now() - new Date(j.criado).getTime()) / 1000).toFixed(0)}s (PDF indo para a nuvem em segundo plano)`);
    if (j.etapa === 'IMPRESSO') salvarEmSegundoPlano(j);
    else jornalApagar(j.id);
  } catch (e) {
    const p = ctx && ctx.pages()[0];
    if (e instanceof ErroCliente) {
      log(`[${j.id}] Recusado (${e.tipo}): ${e.message}`);
      await api('robo_atualizar', { id: j.id, status: 'ERRO', etapa: e.tipo, mensagem: e.msgCliente || e.message, msgCliente: e.msgCliente }).catch(() => {});
      jornalApagar(j.id);
      if (p) await p.goto(CFG.clubpetro.urlResgate).catch(() => {});
    } else if (e instanceof ErroVerificar) {
      log(`[${j.id}] VERIFICAR: ${e.message}`);
      await api('robo_atualizar', { id: j.id, status: 'VERIFICAR', etapa: j.etapa, mensagem: e.message, codigo: j.codigo || '', ticket: j.ticket || '',
        msgCliente: 'Seu resgate precisa de uma conferência. Procure o caixa.' }).catch(() => {});
      jornalApagar(j.id);
    } else if (j.etapa === 'CLUBPETRO' || j.etapa === 'RECEBIDO') {
      // falha técnica antes de finalizar: nenhum ponto foi gasto, pode tentar de novo
      j.tentativas = (j.tentativas || 0) + 1; jornalGravar(j);
      log(`[${j.id}] Falha técnica (tentativa ${j.tentativas}): ${e.message}`);
      if (p) await diagnostico(p, j.id + '-falha');
      if (j.tentativas >= 2 || /LOGIN/.test(e.message)) {
        await api('robo_atualizar', { id: j.id, status: 'ERRO', etapa: 'FALHA', mensagem: e.message,
          msgCliente: 'Não foi possível fazer o resgate agora. Procure o caixa.' }).catch(() => {});
        jornalApagar(j.id);
      } else throw e;     // o laço principal tenta de novo
    } else {
      j.tentativasPos = (j.tentativasPos || 0) + 1; jornalGravar(j);
      log(`[${j.id}] Falha técnica na etapa ${j.etapa} (tentativa ${j.tentativasPos}): ${e.message}`);
      if (j.tentativasPos >= 3) {
        const senhaOk = !!j.ticket;
        await api('robo_atualizar', { id: j.id, status: senhaOk ? 'CONCLUIDO' : 'VERIFICAR', etapa: j.etapa,
          codigo: j.codigo || '', ticket: j.ticket || '', mensagem: 'Pendência técnica: ' + e.message,
          msgCliente: senhaOk ? 'Sua senha está na tela. Se o comprovante não saiu, peça ao caixa para reimprimir.'
                              : 'Seu resgate precisa de uma conferência. Procure o caixa.' }).catch(() => {});
        jornalApagar(j.id);
      } else throw e;     // etapas seguras (CLUBPETRO_OK, EVO_OK, IMPRESSO): o laço retoma
    }
  }
}

// ------------------------------------------------------------------ comandos do caixa

// Se o EVO está aberto com outro caixa, clica em Sair e volta para a tela de login.
async function trocarUsuarioEvoSePreciso(p) {
  if (!credEvoTurno || (await p.locator('input[type="password"]:visible').count())) return;
  const atual = await usuarioLogadoEvo(p);
  if (atual && atual.toLowerCase() !== credEvoTurno.usuario.toLowerCase()) {
    log('EVO estava com', atual, '- saindo para entrar com', credEvoTurno.usuario);
    await sairEvo(p);
    await p.goto(CFG.evo.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  }
}

async function comandoEntrarEvo() {
  const p = await abaEvo();
  await p.goto(CFG.evo.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await trocarUsuarioEvoSePreciso(p);
  const entrou = await garantirLoginEvo(p);
  await p.getByRole('button', { name: /emitir/i }).first().waitFor({ state: 'visible', timeout: 15000 });
  // v2.8.0: junto com o EVO do caixa, já deixa a aba do ClubPetro desse caixa aberta e na tela de resgate
  const chave = chaveCaixa();
  await abaClubDoCaixa(chave); prepararClub(chave);
  return (entrou ? 'Login feito no EVO.' : 'EVO já estava aberto e pronto.') + ' ClubPetro do caixa preparado.';
}

// Lê no fechamento do EVO a quantidade do cartão do resgate (ex.: "B.PICHILAUMAIS ... 3").
let qtdEvoFechamento = null;
function lerQtdEvo(texto) {
  // v2.10.1: a quantidade é o número inteiro logo depois do nome do cartão, ignorando valores em reais
  // (R$ 0,00). No HTML do EVO o valor às vezes vem antes da quantidade e o robô lia o "0" de "R$ 0,00".
  const nome = String(CFG.evo.botao || 'B.PICHILAUMAIS').replace(/[.\s]/g, '').split('').map(c => c.replace(/[-\/\\^$*+?()|[\]{}]/g, '\\$&')).join('[.\\s]*');
  const t = String(texto || '').replace(/\s+/g, ' ');
  const m = new RegExp(nome, 'i').exec(t);
  if (!m) return null;     // fechamento sem esse cartão na lista: "não lido" (o painel pede ao caixa)
  let resto = t.slice(m.index + m[0].length, m.index + m[0].length + 80);
  const prox = resto.search(/[A-Z]{2,}[A-Z.\s$]*\d/);            // próximo item da lista (ex.: "B. PAGO $5")
  if (prox > 0) resto = resto.slice(0, prox);
  resto = resto.replace(/R\$\s*-?[\d.]*,\d{2}/gi, ' ').replace(/\d+,\d{2}/g, ' ');
  const q = /(?:^|[^\d,.])(\d{1,4})(?![\d,])/.exec(resto);
  return q ? Number(q[1]) : null;
}

async function comandoFecharCaixaEvo(cmd) {
  qtdEvoFechamento = null;
  const p = await abaEvo();
  await p.goto(CFG.evo.url, { waitUntil: 'domcontentloaded' });
  // fecha o caixa de quem está fechando o turno: se o EVO estiver com outro login, sai e entra com o certo
  await trocarUsuarioEvoSePreciso(p);
  await garantirLoginEvo(p);
  const quem = await usuarioLogadoEvo(p);
  if (credEvoTurno && quem && quem.toLowerCase() !== credEvoTurno.usuario.toLowerCase()) {
    throw new Error('O EVO continuou com o login ' + quem + ' e não com ' + credEvoTurno.usuario + '. Feche o caixa pelo EVO.');
  }
  const marco = Date.now();
  await clicarTexto(p, /fechar caixa/i);
  await dormir(800);
  // confirmações do EVO (se houver). Não clica de novo em FECHAR CAIXA, para não fechar duas vezes.
  for (const re of [/^confirmar$/i, /^sim$/i, /^ok$/i]) {
    const b = p.getByRole('button', { name: re }).last();
    if (await b.isVisible().catch(() => false)) { await b.click().catch(() => {}); break; }
  }
  // O EVO mostra o fechamento com o botão IMPRIMIR: o robô clica nele e captura a impressão de verdade
  // (não a foto da tela). Se o EVO já mandar imprimir sozinho, usa essa.
  let cap = await esperarCaptura(marco, 3000);
  if (!cap) {
    const botao = p.getByRole('button', { name: /imprimir/i }).filter({ visible: true }).last();
    try { await botao.waitFor({ state: 'visible', timeout: 15000 }); }
    catch (_) { await diagnostico(p, 'fechamento-evo-sem-imprimir'); }
    if (await botao.isVisible().catch(() => false)) {
      const m2 = Date.now();
      await botao.click();
      cap = await esperarCaptura(m2, 15000);
    }
  }
  if (!cap) {
    await diagnostico(p, 'fechamento-evo-sem-captura');
    log('Fechamento do EVO: não veio a impressão do EVO; vou salvar uma foto da tela no lugar.');
  }
  const docFech = await guardarCaptura('fechamento-' + Date.now(), cap, p);
  if (docFech) docFech.margemMm = CFG.margemFechamentoMm !== undefined ? CFG.margemFechamentoMm : 5;
  // v2.10.0: o HTML da impressão vem com &nbsp; entre o item e a quantidade: decodifica antes de ler o total
  const textoDeHtml = h => String(h || '').replace(/<(br|\/p|\/div|\/tr|\/td)[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;|&#xa0;/gi, ' ').replace(/&amp;/gi, '&').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16))).replace(/[\u00a0\u2007\u202f]/g, ' ');
  const textoTela = await p.locator('body').innerText().catch(() => '');
  const textoFech = cap && cap.html ? textoDeHtml(cap.html) : textoTela;
  qtdEvoFechamento = lerQtdEvo(textoFech);
  if (qtdEvoFechamento === null && textoTela) qtdEvoFechamento = lerQtdEvo(textoTela);   // 2ª fonte: a tela do EVO
  // caixa do EVO aberto há poucos minutos (o robô entrou de novo no fim do dia) não representa o turno: não usa a leitura
  const ab = /ABERTURA\s*:?\s*(\d{2})\/(\d{2})\/(\d{4}),?\s*(\d{2}):(\d{2})/i.exec(textoFech.replace(/\s+/g, ' '));
  if (ab) {
    const abertura = new Date(+ab[3], +ab[2] - 1, +ab[1], +ab[4], +ab[5]).getTime();
    if (Date.now() - abertura < 10 * 60 * 1000) {
      log('Fechamento do EVO: caixa aberto há menos de 10 min (sessão nova do robô). Total não considerado; informe o total do papel do EVO no app.');
      qtdEvoFechamento = null;
    }
  }
  log('Fechamento do EVO:', CFG.evo.botao, '=', qtdEvoFechamento === null ? 'não encontrado' : qtdEvoFechamento);
  ultimoFechamentoEvo = Date.now();
  const pdf = await docParaPdf(docFech);
  const d = new Date(); const z = n => String(n).padStart(2, '0');
  const nome = `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}.${z(d.getMinutes())} - fechamento caixa EVO.pdf`;
  if (cmd && cmd.ref) fs.writeFileSync(path.join(TICKETS, 'fechamento-' + cmd.ref + '.pdf'), pdf);   // para reimpressão
  // v2.10.0: 1º imprime (o total já foi lido), depois manda a imagem e salva na nuvem em segundo plano
  let impresso = false;
  try { if (cmd && cmd.imprimirLocal === false) log('Fechamento do EVO vai para o PDV imprimir.'); else await imprimir(pdf, 'fechamento-evo-' + Date.now() + '.pdf', 'fechamento'); impresso = true; }
  catch (e) { log('Falha ao imprimir o fechamento do EVO:', e.message); }
  (async () => {
    if (cmd && cmd.ref) await enviarImagem('fechamento', cmd.ref, await docParaPng(docFech), pdf).catch(() => {});
    for (const raiz of pastasDestino()) {
      try { fs.writeFileSync(path.join(pastaDoMes(raiz, d), nome), pdf); log('Fechamento do EVO salvo:', nome); } catch (e) { log('Não salvei o fechamento em', raiz, '-', e.message); }
    }
  })();
  await clicarTexto(p, /^fechar$/i, null, 5000).catch(() => {});
  // depois de fechar o caixa, sair do EVO (o próximo turno entra de novo sozinho)
  const saiu = await sairEvo(p);
  await fecharJanelaEvo(credEvoTurno);          // turno fechado: a janela desse caixa sai de cena
  await fecharAbaClub(chaveCaixa());
  return 'Caixa do EVO fechado, ' + (impresso ? 'impresso' : 'NÃO impresso (veja a impressora)') + ' e salvo' +
    (saiu ? ', saída feita. ' : ' (botão Sair não encontrado). ') + nome;
}

async function comandoReimprimirFechamento(cmd) {
  const arq = path.join(TICKETS, 'fechamento-' + cmd.ref + '.pdf');
  if (!fs.existsSync(arq)) throw new Error('O PDF desse fechamento não está neste computador. Ele fica salvo também no OneDrive, na pasta do mês.');
  await imprimir(fs.readFileSync(arq), 'reimpressao-fechamento-' + Date.now() + '.pdf', 'fechamento');
  return 'Fechamento do EVO reimpresso';
}

// Relatório do turno no formato de bobina (80 mm), igual ao papel da senha do EVO.
// v2.6.0: fechamento por status (erros sem/com senha, cancelados, concluídos), TOTAL ROBÔ,
// registro externo (Total EVO − Total robô) e resumo por OPNF com campo de conferência.
// Usa os números do servidor quando vierem; se não, calcula pela lista de resgates.
function resumoRelatorio(R) {
  const res = R.resgates || [];
  const fichas = x => Number(x.qtd) || 1;
  const soma = f => res.filter(f).reduce((t, x) => t + fichas(x), 0);
  const temSenha = x => !!String(x.ticket || '').trim();
  const num = (v, alt) => (v === undefined || v === null || v === '' || isNaN(Number(v))) ? alt : Number(v);
  const conc = num(R.qtdConcluidos, soma(x => x.status === 'CONCLUIDO'));
  const canc = num(R.qtdCancelados, soma(x => x.status === 'CANCELADO'));
  const errCom = num(R.qtdErroComSenha, soma(x => x.status === 'VERIFICAR' && temSenha(x)));
  const errSem = num(R.qtdErroSemSenha, null);   // erros só vêm do servidor
  const total = num(R.qtdTotalRobo, conc + canc + errCom);
  const evo = num(R.qtdEvo, null);
  const externo = evo === null ? null : evo - total;
  // lotes (OPNF): do servidor; se não vierem, agrupa pela OPNF dos resgates concluídos
  // v2.7.1: quantidade da OPNF em fichas (senhas). A aba Lotes conta códigos: um código com 2 senhas contava 1.
  const fichasDoLote = l => {
    const doLote = res.filter(x => x.status === 'CONCLUIDO' && ((l.lote && String(x.lote) === String(l.lote)) || (l.opnf && String(x.opnf) === String(l.opnf))));
    return doLote.length ? doLote.reduce((t, x) => t + fichas(x), 0) : num(l.qtd, 0);
  };
  let lotes = (R.lotes || []).map(l => ({ hora: (String(l.criado || '').match(/\d{2}:\d{2}/) || ['-'])[0], opnf: l.opnf || '-', qtd: fichasDoLote(l) }));
  if (!R.lotes) {
    const m = {};
    res.filter(x => x.status === 'CONCLUIDO' && x.opnf).forEach(x => {
      const k = String(x.opnf);
      if (!m[k]) m[k] = { hora: String(x.hora || '').slice(11, 16) || '-', opnf: k, qtd: 0 };
      m[k].qtd += fichas(x);
    });
    lotes = Object.values(m);
  }
  const fichasLotes = lotes.reduce((t, l) => t + l.qtd, 0);
  const semOpnf = soma(x => x.status === 'CONCLUIDO' && !x.opnf && !x.lote);
  return { conc, canc, errCom, errSem, total, evo, externo, lotes, fichasLotes, semOpnf };
}

function htmlRelatorio(R) {
  const e = x => String(x == null ? '' : x).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const S = resumoRelatorio(R);
  const lin = (rot, val, cls) => `<div class="l ${cls || ''}"><span>${e(rot)}</span><b>${e(val)}</b></div>`;
  const sep = c => `<div class="sep">${c}</div>`;
  const lotes = S.lotes.map((l, i) => `<tr><td>${i + 1}</td><td>${e(l.hora)}</td><td>${e(l.opnf)}</td><td class="n">${e(l.qtd)}</td><td class="ok">(&nbsp;&nbsp;&nbsp;)</td></tr>`).join('')
    || '<tr><td colspan="5">Nenhuma OPNF no turno.</td></tr>';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    @page { size: 80mm auto; margin: 0 }
    body { font-family: Arial, sans-serif; width: 72mm; margin: 3mm 4mm; color: #000; font-size: 9.5pt }
    h1 { font-size: 12pt; margin: 0 0 1mm; text-align: center } .c { text-align: center }
    .linha { border-top: 1px dashed #000; margin: 2mm 0 }
    dl { display: grid; grid-template-columns: auto 1fr; gap: .4mm 3mm; margin: 0 } dt { color: #333 } dd { margin: 0; font-weight: bold }
    .l { display: flex; justify-content: space-between; padding: .3mm 0 } .l.forte { font-size: 11pt } .l.forte span { font-weight: bold }
    .sep { margin: .5mm 0; font-weight: bold }
    .aviso { border: 1px solid #000; padding: 1mm; margin-top: 1.5mm; font-size: 8.5pt; font-weight: bold; text-align: center }
    table { width: 100%; border-collapse: collapse; font-size: 9pt } th { text-align: left; border-bottom: 1px solid #000 }
    td { padding: .8mm .4mm } td.n, th.n { text-align: center } td.ok { text-align: center; white-space: nowrap }
    .ass { margin-top: 12mm; border-top: 1px solid #000; text-align: center; padding-top: 1mm; font-size: 8.5pt }
  </style></head><body>
    <h1>RESGATE DE BANHO PICHILAU+</h1><div class="c">Fechamento robô</div><div class="c">Postos Pichilau · ${e(R.posto)}</div>
    <div class="linha"></div>
    <dl><dt>Data</dt><dd>${e(String(R.abertura).slice(0, 10))}</dd><dt>Caixa</dt><dd>${e(R.caixa)}</dd>
      <dt>Início</dt><dd>${e(String(R.abertura).slice(11, 16))}</dd><dt>Fim</dt><dd>${e(R.fechamento ? String(R.fechamento).slice(11, 16) : 'em aberto')}</dd></dl>
    <div class="linha"></div>
    ${lin('Erros sem senha', S.errSem === null ? '-' : S.errSem)}
    ${sep('-')}
    ${lin('Cancelados robô', S.canc)}
    ${lin('Erro com senha', S.errCom)}
    ${lin('Concluídos robô', S.conc)}
    ${sep('-')}
    ${lin('TOTAL ROBÔ', S.total, 'forte')}
    ${lin('Registro externo', S.externo === null ? '-' : S.externo)}
    ${sep('=')}
    ${lin('Total EVO', S.evo === null ? 'não lido' : S.evo, 'forte')}
    ${S.evo === null ? '<div class="aviso">Total EVO não lido: informe no painel o total B.PICHILAUMAIS do papel do EVO.</div>' : ''}
    ${S.externo !== null && S.externo < 0 ? '<div class="aviso">Robô maior que o EVO: conferir cancelados e erros com senha.</div>' : ''}
    ${sep('-')}
    ${lin('OPNF ' + S.lotes.length, '(' + S.fichasLotes + ' resgates)')}
    ${S.semOpnf ? `<div class="aviso">${S.semOpnf} resgate(s) concluído(s) sem OPNF</div>` : ''}
    <div class="linha"></div>
    <table><thead><tr><th>#</th><th>Hora</th><th>OPNF</th><th class="n">Quant.</th><th class="n">OK</th></tr></thead><tbody>${lotes}</tbody></table>
    <div class="linha"></div>
    <div class="ass">${e(R.caixa)} · Caixa</div><div class="ass">Conferente</div>
    <div class="c" style="font-size:7.5pt;margin-top:3mm">Impresso em ${e(new Date().toLocaleString('pt-BR'))} · robô v${VERSAO}</div>
  </body></html>`;
}

// v2.6.0: se o total do EVO não foi lido no fechamento, o relatório espera alguns minutos para o caixa
// informar a quantidade no painel (opcional). Um segundo pedido do mesmo turno (com ou sem total) imprime na hora.
let ultimoFechamentoEvo = 0;
const relatoriosEmEspera = {};
async function comandoImprimirRelatorio(cmd) {
  if (!cmd.relatorio) throw new Error('O servidor não mandou os dados do relatório.');
  const ref = cmd.ref || cmd.relatorio.id || 'turno';
  if (relatoriosEmEspera[ref]) { clearTimeout(relatoriosEmEspera[ref]); delete relatoriosEmEspera[ref]; }
  else {
    const esperaMin = CFG.esperaTotalEvoMin !== undefined ? Number(CFG.esperaTotalEvoMin) : 5;
    if (cmd.relatorio.qtdEvo == null && esperaMin > 0 && Date.now() - ultimoFechamentoEvo < 10 * 60 * 1000) {
      relatoriosEmEspera[ref] = setTimeout(async () => {
        if (!relatoriosEmEspera[ref]) return;
        delete relatoriosEmEspera[ref];
        try { log('Relatório do turno: ninguém informou o total do EVO; imprimindo com "não lido".'); log(await imprimirRelatorioAgora(cmd)); }
        catch (e) { log('Falha ao imprimir o relatório em espera:', e.message); }
      }, esperaMin * 60 * 1000);
      log(`Relatório do turno em espera (até ${esperaMin} min) para o caixa informar o total do EVO no painel.`);
      return `Total EVO não lido: relatório aguardando até ${esperaMin} min o caixa informar no painel (ou imprimir sem).`;
    }
  }
  return imprimirRelatorioAgora(cmd);
}

async function imprimirRelatorioAgora(cmd) {
  const pdf = await htmlParaPdf(htmlRelatorio(cmd.relatorio), null, CFG.larguraPapelMm || 80);
  await enviarImagem('relatorio', cmd.ref, await htmlParaPng(htmlRelatorio(cmd.relatorio), CFG.larguraPapelMm || 80), pdf);
  const d = new Date(); const z = n => String(n).padStart(2, '0');
  const nome = `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}.${z(d.getMinutes())} - relatorio do turno - ${String(cmd.relatorio.caixa || '').replace(/[\\/:*?"<>|]/g, '')}.pdf`;
  for (const raiz of pastasDestino()) {
    try { fs.writeFileSync(path.join(pastaDoMes(raiz, d), nome), pdf); } catch (_) {}
  }
  if (cmd.imprimirLocal !== false) await imprimir(pdf, 'relatorio-' + Date.now() + '.pdf', 'fechamento');
  return 'Relatório do turno impresso e salvo. ' + nome;
}

// senhas que esperam o cliente pedir a impressão no totem (somem em 30 min; depois disso o REIMPRIMIR usa o PDF salvo)
setInterval(() => { for (const [k, v] of Object.entries(senhasEmEspera)) if (Date.now() - v.em > 30 * 60 * 1000) delete senhasEmEspera[k]; }, 5 * 60 * 1000);
async function comandoReimprimir(cmd) {
  const espera = senhasEmEspera[cmd.ref];
  if (espera) {
    // primeira impressão pedida pelo cliente: igual à impressão normal (impressora do robô + agentes de impressão)
    delete senhasEmEspera[cmd.ref];
    const envio = enviarImagem('senha', cmd.ref, espera.png, espera.pdf).catch(e => log('Falha ao enviar a senha aos agentes:', e.message));
    if (espera.local !== false) await imprimir(espera.pdf, cmd.ref + '-cliente.pdf', undefined, espera.impressora);
    await envio;
    return 'Senha impressa a pedido do cliente';
  }
  const arq = path.join(TICKETS, cmd.ref + '-cliente.pdf');
  const pdf = fs.existsSync(arq) ? fs.readFileSync(arq)
    : await htmlParaPdf(ticketReserva({ ticket: cmd.ticket, codigo: cmd.codigo }), 'about:blank', CFG.larguraPapelMm || 80);
  await imprimir(pdf, cmd.ref + '-cliente.pdf');
  return 'Reimpresso';
}

async function executarComando(t) {
  log('Comando', t.comando, t.ref);
  notarCredEvo(t);
  try {
    const msg = t.comando === 'FECHAR_CAIXA_EVO' ? await comandoFecharCaixaEvo(t)
              : t.comando === 'ENTRAR_EVO' ? await comandoEntrarEvo(t)
              : t.comando === 'REIMPRIMIR_FECHAMENTO' ? await comandoReimprimirFechamento(t)
              : t.comando === 'IMPRIMIR_RELATORIO' ? await comandoImprimirRelatorio(t)
              : t.comando === 'REIMPRIMIR' ? await comandoReimprimir(t)
              : t.comando === 'ATUALIZAR_ROBO' ? (await verificarAtualizacao(true)) || 'Verificado.'
              : t.comando === 'LISTAR_IMPRESSORAS' ? (await enviarImpressoras(), 'Lista de impressoras deste computador enviada ao painel.')
              : 'Comando desconhecido';
    await api('robo_comando', Object.assign({ id: t.id, status: 'OK', mensagem: msg },
      t.comando === 'FECHAR_CAIXA_EVO' && qtdEvoFechamento !== null ? { qtdEvo: qtdEvoFechamento } : {}));
  } catch (e) {
    log('Falha no comando:', e.message);
    await api('robo_comando', { id: t.id, status: 'ERRO', mensagem: e.message }).catch(() => {});
  }
}

// ------------------------------------------------------------------ laço principal

let ocupado = false;
function sinalDeVida() {
  setInterval(() => { if (ocupado && !substituidoPor) api('robo_sinal', { maquina: MAQUINA }, 1).then(notarImpressora).catch(() => {}); }, 15000);
  enviarImpressoras();
  setInterval(enviarImpressoras, 10 * 60 * 1000);
}

async function principal() {
  log(`Robô do resgate de banho v${VERSAO} iniciado`);
  await carregarConfigRemota();
  navegadorRender().catch(() => {});          // deixa o gerador de PDF pronto antes do primeiro resgate
  sinalDeVida();
  setInterval(() => carregarConfigRemota(), 10 * 60 * 1000);
  setInterval(() => verificarAtualizacao(false), 10 * 60 * 1000);   // v2.13.0: aplica só no horário agendado
  setTimeout(reabrirTotemSePreciso, 20000);
  let falhas = 0;
  for (;;) {
    try {
      if (!substituidoPor) await abrirNavegador();
      if (!trabalhando && !substituidoPor) {
        const pendente = jornaisPendentes().find(x => !filaSalvar.some(f => f.id === x.id));
        if (pendente) { ocupado = true; await processar(pendente); ocupado = false; continue; }
        if (filaLocal.length) { rodarTrabalho(filaLocal.shift()); continue; }
      }
      // v2.10.0: com um resgate em andamento, pede ao servidor só consultas de pontos (de outros totens)
      const flagAssumir = path.join(DADOS, 'assumir.flag');
      const assumir = fs.existsSync(flagAssumir);
      const r = await api('robo_proximo', { esperar: !substituidoPor, soConsulta: trabalhando, maquina: MAQUINA, versao: VERSAO, assumir });
      if (r && r.ok && assumir && !r.substituido) { try { fs.unlinkSync(flagAssumir); } catch (_) {} log(`Este computador (${MAQUINA}) assumiu o robô.`); }
      if (r && r.substituido) {
        if (!substituidoPor) {
          substituidoPor = r.substituido.maquina || 'outro computador';
          const aviso = `ROBÔ AGORA RODA NO COMPUTADOR "${substituidoPor}"${r.substituido.desde ? ' (desde ' + r.substituido.desde + ')' : ''}. ESTE COMPUTADOR (${MAQUINA}) FICA EM ESPERA. Para voltar a usar este: rode ASSUMIR.bat.`;
          log(aviso);
          try { process.stdout.write('\x1b]0;Robo Resgate Banho - EM ESPERA (rodando em ' + substituidoPor + ')\x07'); } catch (_) {}
          console.log('\n' + '='.repeat(70) + '\n' + aviso + '\n' + '='.repeat(70) + '\n');
          for (const k of [...abasClub.keys()]) await fecharAbaClub(k).catch(() => {});
          if (ctx) await ctx.close().catch(() => {});
          ctx = null;
        }
        await dormir(60000);
        continue;
      }
      if (substituidoPor) { log(`Este computador voltou a rodar o robô (${MAQUINA}).`); substituidoPor = null; }
      notarImpressora(r);
      if (r && typeof r.versaoConfig === 'string' && versaoConfig !== null && r.versaoConfig !== versaoConfig) await carregarConfigRemota();
      falhas = 0;
      if (r && r.ok && r.tarefa) {
        if (r.tarefa.tipo === 'CONSULTA') {
          consultasAtivas++;
          consultarPontos(r.tarefa).catch(e => log('Consulta:', e.message)).finally(() => { consultasAtivas--; });
          continue;
        }
        if (trabalhando) { filaLocal.push(r.tarefa); continue; }   // servidor antigo: guarda para depois
        rodarTrabalho(r.tarefa);
        continue;
      }
      await dormir((r && r.intervalo !== undefined ? r.intervalo : 5) * 1000);
    } catch (e) {
      ocupado = false;
      falhas++;
      log('Erro no laço:', e.message);
      if (/Target.*closed|browser has been closed|Browser closed/i.test(e.message)) ctx = null;
      await dormir(Math.min(30000, 3000 * falhas));
    }
  }
}

// v2.10.0: resgates e comandos (EVO) continuam um por vez; o laço segue atendendo consultas enquanto isso
let trabalhando = false, consultasAtivas = 0;
const filaLocal = [];
function rodarTrabalho(t) {
  trabalhando = true; ocupado = true;
  (async () => {
    const r = { tarefa: t };
    try {
      {
        if (r.tarefa.tipo === 'RESGATE') {
          notarCredEvo(r.tarefa);
          const j = { id: r.tarefa.id, cpf: r.tarefa.cpf, nasc: r.tarefa.nasc, qtd: r.tarefa.qtd || 1, imprimir: r.tarefa.imprimir !== false, etapa: 'RECEBIDO', criado: new Date().toISOString() };
          if (r.tarefa.produto) CFG.clubpetro.produto = r.tarefa.produto;
          if (r.tarefa.tipoResgate) j.tipoResgate = r.tarefa.tipoResgate;
          if (r.tarefa.modalidade) j.mod = r.tarefa.modalidade;
          if (r.tarefa.consultaId) j.consultaId = r.tarefa.consultaId;
          if (r.tarefa.impTotem) j.impTotem = true;
          if (r.tarefa.impressora) j.impressora = r.tarefa.impressora;
          if (r.tarefa.imprimirLocal === false) j.imprimirLocal = false;
          jornalGravar(j);
          try { await processar(j); } finally { prepararClub(chaveCaixa()); if (j.consultaId) fecharAbaClub('q:' + j.consultaId); }
        } else await executarComando(r.tarefa);
      }
    } catch (e) { log('Erro no resgate/comando:', e.message); }
    finally { trabalhando = false; ocupado = false; }
  })();
}

async function modoLogin() {
  await abrirNavegador();
  const a = await ctx.newPage(); await a.goto(CFG.clubpetro.urlResgate).catch(() => {});
  const b = await ctx.newPage(); await b.goto(CFG.evo.url).catch(() => {});
  log('Faça login no ClubPetro e no EVO nessas abas, marque "lembrar senha" se houver, e depois feche o navegador.');
  await new Promise(r => ctx.on('close', r));
  process.exit(0);
}

process.on('unhandledRejection', e => log('Erro não tratado:', e && e.message));
// v2.13.0: atualização automática. A cada 15 min confere robo/versao.json no GitHub (repositório do site).
// Versão nova: baixa robo.js, confere o SHA-256 e a sintaxe, guarda o atual como robo.js.bak-<versão>, troca e
// reinicia (o INICIAR abre de novo sozinho). Nunca no meio de um resgate nem entre 17:50 e 18:10.
// Desligar: "autoAtualizar": false no config.json.
const URL_ATUALIZACAO = 'https://raw.githubusercontent.com/apoio-escada/resgate-banho/main/robo/';
const versaoMaior = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((x[i] || 0) > (y[i] || 0)) return true; if ((x[i] || 0) < (y[i] || 0)) return false; } return false; };
// Só aplica no horário agendado no painel (padrão 03:00; vazio = só manual) ou pelo botão "Atualizar o robô agora".
async function verificarAtualizacao(forcar) {
  if ((CFG.autoAtualizar === false && !forcar) || substituidoPor) return 'Este computador está em espera.';
  const h = new Date(); const mins = h.getHours() * 60 + h.getMinutes();
  if (!forcar) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(CFG.atualizarHora === undefined ? '03:00' : CFG.atualizarHora || ''));
    if (!m) return;                                                  // só manual
    const ini = Number(m[1]) * 60 + Number(m[2]);
    if (mins < ini || mins > ini + 30) return;                      // fora da janela agendada
  }
  if (mins >= 17 * 60 + 50 && mins <= 18 * 60 + 10) return 'Agora não (fechamento do caixa). Tente depois das 18:10.';
  if (trabalhando || ocupado || consultasAtivas > 0 || filaSalvar.length || clientesAbertos.size) return forcar ? 'O robô está atendendo agora; tente de novo em 1 minuto.' : undefined;
  try {
    const base = CFG.urlAtualizacao || URL_ATUALIZACAO;
    const info = await fetch(base + 'versao.json?t=' + Date.now(), { cache: 'no-store' }).then(r => r.ok ? r.json() : null);
    if (!info || !info.versao || !versaoMaior(info.versao, VERSAO)) return `O robô já está na versão mais nova (${VERSAO}).`;
    log(`Versão nova do robô disponível: ${info.versao} (esta é ${VERSAO}). Baixando...`);
    const cod = Buffer.from(await (await fetch(base + 'robo.js?t=' + Date.now(), { cache: 'no-store' })).arrayBuffer());
    const sha = require('crypto').createHash('sha256').update(cod).digest('hex');
    if (info.sha256 && sha !== String(info.sha256).toLowerCase()) { log('Atualização recusada: o arquivo baixado não confere (SHA-256).'); return; }
    if (!/const VERSAO = '/.test(cod.toString('utf8')) || cod.toString('utf8').indexOf(`'${info.versao}'`) < 0) { log('Atualização recusada: versão do arquivo não bate.'); return; }
    const novo = path.join(BASE, 'robo.novo.js');
    fs.writeFileSync(novo, cod);
    const chk = require('child_process').spawnSync(process.execPath, ['--check', novo], { encoding: 'utf8' });
    if (chk.status !== 0) { log('Atualização recusada: erro de sintaxe no arquivo novo.', (chk.stderr || '').slice(0, 300)); fs.unlinkSync(novo); return; }
    if (trabalhando || ocupado || consultasAtivas > 0 || clientesAbertos.size) { fs.unlinkSync(novo); return; }   // chegou cliente: fica para a próxima
    const atual = path.join(BASE, 'robo.js');
    fs.copyFileSync(atual, path.join(BASE, 'robo.js.bak-' + VERSAO));
    fs.renameSync(novo, atual);
    log(`Robô atualizado para ${info.versao}. Reiniciando...`);
    try { fs.writeFileSync(path.join(DADOS, 'reabrir-totem.flag'), '1'); } catch (_) {}
    try { if (ctx) await ctx.close(); } catch (_) {}
    setTimeout(() => process.exit(0), 3000);
    return `Atualizando para ${info.versao}. O robô reinicia em instantes.`;
  } catch (e) { log('Não consegui verificar atualização:', e.message); return 'Não consegui verificar a atualização: ' + e.message; }
}
// depois de uma atualização: reabre o totem em tela cheia (modo quiosque) se ele roda neste computador pelo atalho
// "Totem Resgate Banho" (REINICIO-AUTOMATICO.bat, opção 3)
function reabrirTotemSePreciso() {
  const flag = path.join(DADOS, 'reabrir-totem.flag');
  if (!fs.existsSync(flag)) return;
  try { fs.unlinkSync(flag); } catch (_) {}
  if (process.platform !== 'win32') return;
  const lnk = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Totem Resgate Banho.lnk');
  if (!fs.existsSync(lnk)) { log('Totem não reaberto: crie o atalho de quiosque (REINICIO-AUTOMATICO.bat, opção 3).'); return; }
  const cp = require('child_process');
  cp.spawnSync('powershell', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'chrome.exe' -and $_.CommandLine -like '*--kiosk*' -and $_.CommandLine -like '*resgate-banho*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"], { stdio: 'ignore' });
  setTimeout(() => { cp.spawn('cmd', ['/c', 'start', '', lnk], { detached: true, stdio: 'ignore' }).unref(); log('Totem reaberto em tela cheia.'); }, 8000);
}

// v2.12.2: só um robô por computador (dois robôs disputavam o mesmo perfil do Chrome)
function travaUnica() {
  const trava = path.join(DADOS, 'robo.lock');
  try {
    const pid = Number(fs.readFileSync(trava, 'utf8'));
    if (pid && pid !== process.pid) { try { process.kill(pid, 0); log(`Outro robô já está rodando neste computador (PID ${pid}). Esta cópia vai esperar.`); return false; } catch (_) {} }
  } catch (_) {}
  fs.mkdirSync(DADOS, { recursive: true });
  fs.writeFileSync(trava, String(process.pid));
  process.on('exit', () => { try { if (Number(fs.readFileSync(trava, 'utf8')) === process.pid) fs.unlinkSync(trava); } catch (_) {} });
  return true;
}
async function esperarVez() { while (!travaUnica()) await dormir(30000); }
if (require.main === module) {
  if (process.argv.includes('--login')) modoLogin(); else esperarVez().then(principal);
}
module.exports = { extrairCodigo, nomeArquivo, htmlParaPdf, GANCHO_IMPRESSAO };
