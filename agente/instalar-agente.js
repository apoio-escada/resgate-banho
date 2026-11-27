// Instalador do agente de impressão: pede o código gerado no painel (admin/auditor) e liga o agente oculto.
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), readline = require('readline');
const { spawnSync } = require('child_process');
const BASE = __dirname;
let POSTO = {}; try { POSTO = JSON.parse(fs.readFileSync(path.join(BASE, 'posto.json'), 'utf8')); } catch (_) {}
let SERVIDOR = POSTO.servidorUrl || 'https://script.google.com/macros/s/AKfycbzt0MUjJtbjAaL8Y5USF38P8M3wax9aV-LCPi0d3sHKOaefTPz3yR7xji7rJplznkSY/exec';
const pergunta = q => new Promise(ok => { const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); rl.question(q, r => { rl.close(); ok(r.trim()); }); });
const ps = cmd => spawnSync('powershell', ['-NoProfile', '-Command', cmd], { stdio: 'ignore' });
(async () => {
  console.log('\n========== AGENTE DE IMPRESSÃO - INSTALAÇÃO ==========');
  console.log('Computador: ' + os.hostname());
  const arq = path.join(BASE, 'config.json');
  let cfg = fs.existsSync(arq) ? JSON.parse(fs.readFileSync(arq, 'utf8')) : {};
  if (!cfg.token) {
    if (!POSTO.servidorUrl) {   // instalador padrão (download direto): pergunta o posto
      const l = await pergunta('Link do painel do posto (Enter = Posto Escada BR): ');
      const m = /servidor=([^&#\s]+)/.exec(l); const u = m ? decodeURIComponent(m[1]) : (/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(l) ? l : '');
      if (u) SERVIDOR = u;
    }
    console.log('\nNo painel do caixa (admin ou auditor): engrenagem > Impressoras > "Instalar agente neste computador".\n');
    for (let t = 1; t <= 5; t++) {
      const codigo = (await pergunta('Digite o código de 6 números: ')).replace(/\D/g, '');
      if (codigo.length !== 6) { console.log('O código tem 6 números.'); continue; }
      try {
        const r = await fetch(SERVIDOR, { method: 'POST', redirect: 'follow', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ acao: 'acesso_pareamentoAgente', codigo }) }).then(x => x.json());
        if (r && r.ok && r.token) { cfg = { servidorUrl: SERVIDOR, token: r.token, nome: os.hostname() }; console.log('OK: computador autorizado (' + (r.posto || 'posto') + ').'); break; }
        console.log('Não deu: ' + ((r && r.erro) || 'código inválido') + '.');
      } catch (e) { console.log('Sem resposta do servidor (' + e.message + ').'); }
      if (t === 5) { console.log('Instalação interrompida.'); process.exit(1); }
    }
    fs.writeFileSync(arq, JSON.stringify(cfg, null, 2));
  }
  // v2.15: sem .vbs (bloqueado pelo Controle Inteligente de Aplicativos); abre escondido pelo PowerShell do Windows
  const psExe = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const node = path.join(BASE, 'node', 'node.exe');
  const cmd = `Start-Process -FilePath '${node}' -ArgumentList 'agente.js' -WorkingDirectory '${BASE}' -WindowStyle Hidden`;
  const startup = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Agente Impressao Banho.lnk');
  ps(`$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${startup}');$s.TargetPath='${psExe}';$s.Arguments='-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "${cmd.replace(/'/g, "''")}"';$s.WorkingDirectory='${BASE}';$s.Save()`);
  spawnSync(psExe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command', cmd], { stdio: 'ignore' });
  console.log('OK: o agente roda escondido e abre junto com o Windows.');
  console.log('\nAgora, no painel: engrenagem > Impressoras. Este computador aparece como "' + os.hostname() + '" com as impressoras dele.');
  console.log('Escolha a impressora da senha e do fechamento e onde a senha do cliente deve sair.\n');
})().catch(e => { console.log('Erro: ' + e.message); process.exit(1); });
