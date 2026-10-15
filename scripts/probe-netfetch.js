// 在 Electron 主进程内验证更新探测（net.fetch 走系统证书存储）
const { app } = require('electron');
const fs = require('node:fs');
const up = require('../src/main/updater-core.js');

app.whenReady().then(async () => {
  const out = process.env.PROBE_OUT || 'netfetch-probe.json';
  try {
    const chans = up.buildProbeChannels();
    const probe = await up.probeLatest({ channels: chans, timeoutMs: 15000 });
    const res = { ok: probe.ok, attempts: probe.attempts, version: probe.release && probe.release.version, winner: probe.winner && probe.winner.label };
    fs.writeFileSync(out, JSON.stringify(res, null, 2));
  } catch (e) {
    fs.writeFileSync(out, JSON.stringify({ ok: false, error: String(e.message || e) }, null, 2));
  }
  setTimeout(() => app.exit(0), 300);
});
