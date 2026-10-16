const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const STEP = process.env.STEP_OUT || 'steps.log';
function log(s){ try{ fs.appendFileSync(STEP, s+'\n'); }catch(e){} }
app.whenReady().then(() => {
  log('ready');
  const w = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, offscreen: process.env.PROBE_OSR === '1' } });
  const wc = w.webContents;
  wc.on('did-finish-load', () => { log('FINISH_LOAD'); try{ fs.writeFileSync(process.env.RESULT_OUT,'OK'); }catch(e){} setTimeout(()=>app.exit(0),200); });
  wc.on('did-fail-load', (e,c,d) => log('FAIL_LOAD '+c+' '+d));
  wc.loadURL('about:blank');
  setTimeout(() => { log('timeout'); app.exit(9); }, 20000);
});
