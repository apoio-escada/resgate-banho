// Instalador do robô do resgate (v2.12): pede o código de instalação gerado no painel e configura tudo sozinho.
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), readline = require('readline');
const { spawnSync } = require('child_process');
const BASE = __dirname;
// v2.14: o assistente de instalação (página Instalar) coloca o posto.json com o servidor do posto; sem ele, Escada BR
let POSTO = {}; try { POSTO = JSON.parse(fs.readFileSync(path.join(BASE, 'posto.json'), 'utf8')); } catch (_) {}
const SERVIDOR = POSTO.servidorUrl || 'https://script.google.com/macros/s/AKfycbzt0MUjJtbjAaL8Y5USF38P8M3wax9aV-LCPi0d3sHKOaefTPz3yR7xji7rJplznkSY/exec';
const SITE = 'https://apoio-escada.github.io/resgate-banho/' + (POSTO.servidorUrl ? '?servidor=' + encodeURIComponent(POSTO.servidorUrl) : '');
const pergunta = q => new Promise(ok => { const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); rl.question(q, r => { rl.close(); ok(r.trim()); }); });
const ps = cmd => spawnSync('powershell', ['-NoProfile', '-Command', cmd], { stdio: 'ignore' });
function atalho(destino, alvo, args, minimizado) {
  ps(`$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${destino}');$s.TargetPath='${alvo}';$s.Arguments='${args || ''}';$s.WorkingDirectory='${BASE}';${minimizado ? '$s.WindowStyle=7;' : ''}$s.Save()`);
}
(async () => {
  console.log('\n================ ROBÔ DO RESGATE - INSTALAÇÃO ================');
  console.log('Computador: ' + os.hostname() + (POSTO.postoNome ? '  ·  Posto: ' + POSTO.postoNome : ''));
  const arq = path.join(BASE, 'config.json');
  let cfg = fs.existsSync(arq) ? JSON.parse(fs.readFileSync(arq, 'utf8')) : {};
  if (!cfg.roboToken || /COLE_AQUI/i.test(cfg.roboToken)) {
    console.log('\nNo painel do caixa (auditor): Configurações > "Instalar robô em outro computador".');
    console.log('Ele mostra um CÓDIGO de 6 números (vale 15 minutos).\n');
    for (let t = 1; t <= 5; t++) {
      const codigo = (await pergunta('Digite o código de instalação: ')).replace(/\D/g, '');
      if (codigo.length !== 6) { console.log('O código tem 6 números.'); continue; }
      try {
        const r = await fetch(SERVIDOR, { method: 'POST', redirect: 'follow', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({ acao: 'acesso_pareamentoRobo', codigo, maquina: os.hostname() }) }).then(x => x.json());
        if (r && r.ok && r.token) { cfg = Object.assign(cfg, { servidorUrl: SERVIDOR, roboToken: r.token, posto: r.posto || cfg.posto || '' }); console.log('OK: computador autorizado.'); break; }
        console.log('Não deu: ' + ((r && r.erro) || 'código inválido ou vencido') + '. Gere outro código no painel se precisar.');
      } catch (e) { console.log('Sem resposta do servidor (' + e.message + '). Confira a internet.'); }
      if (t === 5) { console.log('\nInstalação interrompida.'); process.exit(1); }
    }
  } else console.log('Este computador já estava autorizado (config.json com token).');
  cfg.servidorUrl = cfg.servidorUrl || SERVIDOR;
  delete cfg.evo; delete cfg.pastaNuvem;            // logins vêm do painel; PDFs ficam em C:\RoboBanho\Comprovantes
  fs.writeFileSync(arq, JSON.stringify(cfg, null, 2));
  fs.mkdirSync(path.join(BASE, 'dados'), { recursive: true });
  fs.mkdirSync(path.join(BASE, 'Comprovantes'), { recursive: true });
  fs.writeFileSync(path.join(BASE, 'dados', 'assumir.flag'), 'assumir');
  // atalhos: área de trabalho, menu Iniciar e iniciar com o Windows
  const desk = path.join(os.homedir(), 'Desktop');
  const menu = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  const startup = path.join(menu, 'Startup');
  // v2.12: o robô roda em segundo plano (sem a janela preta). Atalhos: abrir, ver status, parar e comprovantes.
  const wscript = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'wscript.exe');
  const oculto = '"' + path.join(BASE, 'iniciar-oculto.vbs') + '"';
  try { fs.unlinkSync(path.join(startup, 'Robo Resgate Banho.lnk')); } catch (_) {}
  for (const d of [desk, menu]) {
    try {
      atalho(path.join(d, 'Robô Banho.lnk'), wscript, oculto);
      atalho(path.join(d, 'Robô Banho - Status.lnk'), path.join(BASE, 'STATUS.bat'));
      atalho(path.join(d, 'Robô Banho - Parar.lnk'), path.join(BASE, 'PARAR.bat'));
      atalho(path.join(d, 'Robô Banho - Comprovantes.lnk'), path.join(BASE, 'Comprovantes'));
    } catch (_) {}
  }
  atalho(path.join(startup, 'Robo Resgate Banho.lnk'), wscript, oculto);
  console.log('OK: o robô roda em segundo plano (sem janela) e abre junto com o Windows.');
  console.log('OK: atalhos na área de trabalho: "Robô Banho" (abrir), "Robô Banho - Status" (ver mensagens),');
  console.log('    "Robô Banho - Parar" e "Robô Banho - Comprovantes".');
  console.log('OK: comprovantes em ' + path.join(BASE, 'Comprovantes'));
  if (/^s/i.test(await pergunta('\nImprimir uma página de teste na impressora térmica? (S/N) '))) spawnSync(process.execPath, [path.join(BASE, 'teste-impressao.js')], { stdio: 'inherit', cwd: BASE });
  // v2.14: totem neste mesmo computador, em tela cheia (quiosque) e abrindo junto com o Windows
  if (/^s/i.test(await pergunta('\nEste computador também será o TOTEM do cliente? (S/N) '))) {
    const chrome = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe', path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe')].find(f => fs.existsSync(f));
    if (!chrome) console.log('Google Chrome não encontrado. Instale o Chrome e rode o INSTALAR.bat de novo para criar o totem.');
    else {
      const args = '--kiosk --kiosk-printing --no-first-run --disable-session-crashed-bubble --user-data-dir=\"' + path.join(BASE, 'perfil-totem') + '\" \"' + SITE + '\"';
      ps(`$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${path.join(startup, 'Totem Resgate Banho.lnk')}');$s.TargetPath='${chrome}';$s.Arguments='${args.replace(/'/g, "''")}';$s.Save()`);
      ps(`$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${path.join(desk, 'Totem Resgate Banho.lnk')}');$s.TargetPath='${chrome}';$s.Arguments='${args.replace(/'/g, "''")}';$s.Save()`);
      console.log('OK: atalho "Totem Resgate Banho" (tela cheia, abre com o Windows). Para sair da tela cheia: Alt+F4.');
      setTimeout(() => spawnSync('cmd', ['/c', 'start', '', path.join(desk, 'Totem Resgate Banho.lnk')], { stdio: 'ignore' }), 15000);
    }
  }
  console.log('\nAbrindo o robô em segundo plano. A janela de STATUS mostra as mensagens (deve aparecer "Este computador (' + os.hostname() + ') assumiu o robô"). Pode fechar o STATUS: o robô continua.');
  spawnSync(wscript, [path.join(BASE, 'iniciar-oculto.vbs')], { stdio: 'ignore' });
  spawnSync('cmd', ['/c', 'start', '', path.join(BASE, 'STATUS.bat')], { stdio: 'ignore' });
  console.log('\n================ INSTALAÇÃO CONCLUÍDA ================\n');
})().catch(e => { console.log('Erro na instalação: ' + e.message); process.exit(1); });
