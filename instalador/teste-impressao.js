/**
 * Teste de impressão do robô.
 *  - Lista as impressoras do DP002.
 *  - Se encontrar uma impressora térmica (MP-4200, Bematech, Elgin, Epson TM...), imprime o aviso nela.
 *  - Também imprime na impressora do config.json se rodar com --config.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const ptp = require('pdf-to-printer');

const TERMICA = /mp-?4200|bematech|elgin|epson\s*tm|tm-t\d|daruma|termica|térmica|pos-?80|thermal|sweda|tanca|control\s*id/i;
const AVISO = 'Avisar a Magno que saiu essa impressão na sua impressora.';

async function pdfAviso(destino) {
  const cfgArq = path.join(__dirname, 'config.json');
  const cfg = fs.existsSync(cfgArq) ? JSON.parse(fs.readFileSync(cfgArq, 'utf8')) : {};
  const b = await chromium.launch({ channel: cfg.navegador || 'chrome', headless: true });
  const p = await b.newPage();
  await p.setContent(`<html><body style="font-family:Arial;width:72mm;margin:4mm;text-align:center">
    <h2 style="margin:0 0 3mm">TESTE DE IMPRESSÃO</h2>
    <p style="font-size:13pt"><b>${AVISO}</b></p>
    <p style="font-size:9pt">Robô do resgate de banho · ${new Date().toLocaleString('pt-BR')}<br>Impressora: ${destino}</p>
    </body></html>`);
  const arq = path.join(__dirname, 'teste-impressao.pdf');
  fs.writeFileSync(arq, await p.pdf({ width: '80mm', height: '100mm', printBackground: true }));
  await b.close();
  return arq;
}

(async () => {
  const lista = await ptp.getPrinters();
  const padrao = await ptp.getDefaultPrinter().catch(() => null);
  console.log('\nImpressoras encontradas neste computador:');
  lista.forEach(i => console.log(' -', i.name, padrao && padrao.name === i.name ? '(padrão)' : ''));

  const alvos = lista.filter(i => TERMICA.test(i.name)).map(i => i.name);
  if (process.argv.includes('--config')) {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
    alvos.push(cfg.impressora || (padrao && padrao.name));
  }
  if (!alvos.length) {
    console.log('\nNenhuma impressora térmica encontrada. Nada foi impresso.');
    console.log('Para testar a impressora configurada no robô, rode: node teste-impressao.js --config');
    return;
  }
  for (const nome of [...new Set(alvos.filter(Boolean))]) {
    const arq = await pdfAviso(nome);
    await ptp.print(arq, { printer: nome, scale: 'noscale', orientation: 'portrait' });
    console.log('\nTeste enviado para:', nome);
  }
})().catch(e => { console.error('Falha no teste:', e.message); process.exit(1); });
