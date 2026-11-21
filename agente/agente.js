// Agente de impressão do Resgate Pichilau+ (oculto). Informa as impressoras deste computador ao servidor do posto
// e imprime o que o painel mandar para cá: senhas do cliente e fechamentos (EVO e relatório do app).
'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
const VERSAO = '1.0.0';
const BASE = __dirname, DADOS = path.join(BASE, 'dados');
fs.mkdirSync(DADOS, { recursive: true });
const CFG = JSON.parse(fs.readFileSync(path.join(BASE, 'config.json'), 'utf8'));
const NOME = CFG.nome || os.hostname();
const dormir = ms => new Promise(r => setTimeout(r, ms));
const LOG = path.join(DADOS, 'agente.log');
function log(...a) {
  const l = `[${new Date().toLocaleString('pt-BR')}] ${a.join(' ')}`;
  console.log(l);
  try { if (fs.existsSync(LOG) && fs.statSync(LOG).size > 2e6) fs.renameSync(LOG, LOG + '.antigo'); fs.appendFileSync(LOG, l + '\n'); } catch (_) {}
}
// só um agente por computador
const TRAVA = path.join(DADOS, 'agente.lock');
try { const pid = Number(fs.readFileSync(TRAVA, 'utf8')); if (pid && pid !== process.pid) { process.kill(pid, 0); log('Outro agente já está rodando. Saindo.'); process.exit(0); } } catch (_) {}
fs.writeFileSync(TRAVA, String(process.pid));
process.on('exit', () => { try { fs.unlinkSync(TRAVA); } catch (_) {} });

async function api(acao, dados) {
  const r = await fetch(CFG.servidorUrl, { method: 'POST', redirect: 'follow', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(Object.assign({ acao, token: CFG.token, nome: NOME }, dados || {})) });
  return r.json();
}
const ptp = require('pdf-to-printer');
let config = {};   // impressoras escolhidas no painel: { senha, fechamento }
async function registrar() {
  try {
    const lista = (await ptp.getPrinters()).map(p => p.name || p.deviceId).filter(Boolean);
    const padrao = ((await ptp.getDefaultPrinter().catch(() => null)) || {}).name || '';
    const r = await api('agente_registrar', { lista, padrao, versao: VERSAO });
    if (r && r.ok) config = r.cfg || {};
    else log('Servidor recusou o registro:', (r && r.erro) || '?');
  } catch (e) { log('Falha ao registrar:', e.message); }
}
const ARQ_DESDE = path.join(DADOS, 'desde.txt');
let desde = (() => { try { return fs.readFileSync(ARQ_DESDE, 'utf8').trim(); } catch (_) { return ''; } })();
async function imprimir(item) {
  if (!item.pdf) { log('Sem PDF para', item.tipo, item.ref, '(ignorado)'); return; }
  const r = await api('agente_imagem', { arquivo: item.pdf });
  if (!r || !r.ok || !r.png) throw new Error((r && r.erro) || 'arquivo não veio');
  const arq = path.join(DADOS, `${item.tipo}-${item.ref}-${item.id}.pdf`);
  fs.writeFileSync(arq, Buffer.from(r.png, 'base64'));
  const destino = item.tipo === 'senha' ? (config.senha || '') : (config.fechamento || config.senha || '');
  await ptp.print(arq, Object.assign({ scale: 'noscale', orientation: 'portrait' }, destino ? { printer: destino } : {}));
  log(`Impresso ${item.tipo} ${item.ref} em ${destino || 'impressora padrão'}`);
  setTimeout(() => { try { fs.unlinkSync(arq); } catch (_) {} }, 60000);
}
async function principal() {
  log(`Agente de impressão v${VERSAO} iniciado (${NOME})`);
  await registrar(); setInterval(registrar, 60 * 1000);
  if (!desde) {   // primeira vez: começa do agora (não imprime o que já passou)
    const r = await api('agente_pendentes', { desde: '0', operadores: ['__nenhum__'] }).catch(() => null);
    desde = (r && r.ultimo) || String(Date.now()); fs.writeFileSync(ARQ_DESDE, desde);
  }
  for (;;) {
    try {
      const r = await api('agente_pendentes', { desde, operadores: ['__nenhum__'], esperar: true });
      if (!r || !r.ok) { log('Servidor:', (r && r.erro) || 'sem resposta'); await dormir(15000); continue; }
      for (const it of r.itens || []) {
        try { await imprimir(it); } catch (e) { log('Falha ao imprimir', it.tipo, it.ref, ':', e.message); }
        if (Number(it.id) > Number(desde)) { desde = String(it.id); fs.writeFileSync(ARQ_DESDE, desde); }
      }
      if (r.ultimo && Number(r.ultimo) > Number(desde)) { desde = String(r.ultimo); fs.writeFileSync(ARQ_DESDE, desde); }
      await dormir(1500);
    } catch (e) { log('Erro no laço:', e.message); await dormir(10000); }
  }
}
principal();
