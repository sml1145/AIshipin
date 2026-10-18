import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const rendererDir = join(here, '..', 'src', 'renderer');

/**
 * GUI 端到端验证：用本机 Edge（Playwright 驱动）真实渲染界面代码。
 *
 * 为什么这么做（本机实测结论）：
 *   本机是含 ToDesk/MuMu/GameViewer 虚拟显示适配器（IDD）的远程会话，
 *   Electron 的 Chromium 在此环境 GPU 进程断言崩溃（electron#54552），窗口页面无法提交渲染，
 *   Electron 33/44 同症状、Edge 正常。这是环境问题，非软件缺陷。
 *   因此用同机正常的 Edge 作为"渲染代理"，对同一套 renderer 代码做真实 E2E，
 *   证明界面代码正确；Electron 侧的主进程/IPC/业务逻辑另由 236 项无头测试覆盖。
 *
 * 手段：本地 http 服务托管 src/renderer，Playwright 注入 mock 的 window.hxsk 桥接，
 *       在真实 DOM 上验证消息流、路由预览、取消、设置、本地模型页、更新浮层、Markdown 转义防 XSS。
 */

let chromium;
try { ({ chromium } = require('playwright-core')); }
catch { /* 未安装则整组跳过 */ }

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.ico': 'image/x-icon' };

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let urlPath = decodeURIComponent(req.url.split('?')[0]);
      if (urlPath === '/') urlPath = '/index.html';
      const filePath = join(rendererDir, normalize(urlPath).replace(/^(\.\.[/\\])+/, ''));
      if (!filePath.startsWith(rendererDir) || !existsSync(filePath)) { res.writeHead(404); res.end('not found'); return; }
      const ext = extname(filePath);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      res.end(readFileSync(filePath));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/**
 * 注入到页面的 mock 桥接。所有方法读取 window.__cfg（测试可实时改），
 * 并把调用记录进 window.__calls；window.__fire(ch, payload) 模拟主进程推事件。
 */
function mockInitScript() {
  const listeners = {};
  window.__calls = [];
  window.__cfg = window.__cfg || {};
  const rec = (name, args) => window.__calls.push({ name, args });
  const C = () => window.__cfg;

  window.__fire = (channel, payload) => { (listeners[channel] || []).forEach(fn => fn(payload)); };

  const defaultCatalog = {
    schemaVersion: 2,
    models: [
      { id: 'mock-selftest', name: '自检模式（Mock）', track: 'mock', inputs: ['t2v'] },
      { id: 'wan3-video', name: '通义万相 Wan 3.0', track: 'cloud', provider: 'dashscope', inputs: ['t2v'] }
    ],
    intents: {}, facts: {}
  };

  window.hxsk = {
    getAppInfo: async () => { rec('getAppInfo'); return C().appInfo || { name: '幻想时刻', version: '1.2.0', displayVersion: '1.2', ffmpeg: 'C:\\ffmpeg.exe', userData: 'C:\\ud', outputDir: 'C:\\out' }; },
    getCatalog: async () => { rec('getCatalog'); return C().catalog || defaultCatalog; },
    refreshCatalog: async () => { rec('refreshCatalog'); return { updated: false, source: 'bundled', message: 'ok' }; },
    detectHardware: async () => { rec('detectHardware'); return C().hardware || { gpu: 'NVIDIA GeForce RTX 4060 Laptop GPU', vramGB: 8, totalRamGB: 15.2, diskFreeGB: 120, vramSource: 'nvidia-smi', vramWarning: null }; },
    previewRoute: async (req) => { rec('previewRoute', req); return C().preview || { selected: { id: 'mock-selftest', name: '自检模式（Mock）', track: 'mock' }, chain: [{ id: 'mock-selftest', name: '自检模式', track: 'mock', score: 1 }], rejected: [], intents: [], explanation: '未配置 Key，落到自检模式' }; },
    submitGenerate: async (req) => {
      rec('submitGenerate', req);
      const taskId = 'job_test_1';
      // 模拟真实编排：先发 created 事件（触发取消按钮），再发 running 进度，最后返回结果
      setTimeout(() => window.__fire('task:progress', { id: taskId, event: 'created' }), 0);
      setTimeout(() => window.__fire('task:progress', { id: taskId, status: 'running', progress: 40, message: '正在生成…' }), 10);
      if (C().cancelCalled) { window.__fire('task:progress', { id: taskId, status: 'cancelled' }); return { ok: false, status: 'cancelled', message: '任务已取消' }; }
      const gen = C().generateResult;
      if (gen) return gen;
      return { ok: true, status: 'succeeded', message: '已用「自检模式（Mock）」生成成功', attempts: [], routing: (C().preview) || null, result: { localPath: 'C:\\out\\selftest.mp4', videoUrl: 'file:///C:/out/selftest.mp4', isSelfTest: true, modelId: 'mock-selftest' } };
    },
    cancelGenerate: async (taskId) => { rec('cancelGenerate', taskId); window.__cfg.cancelCalled = true; return { cancelled: true, taskId }; },
    getTask: async (taskId) => { rec('getTask', taskId); return { id: taskId }; },
    pickImage: async () => { rec('pickImage'); return C().pickedImage || null; },
    listSecrets: async () => { rec('listSecrets'); return { configured: C().secrets || {}, decryptError: null }; },
    listProviders: async () => { rec('listProviders'); return C().providers || [
      { kind: 'dashscope', label: '阿里云百炼', keyName: 'DASHSCOPE_API_KEY', applyUrl: 'https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key', linkVerified: true, reachableRegion: 'cn', freeQuota: '新用户有免费额度', note: '通义万相全系列', configured: !!(C().secrets||{}).dashscope },
      { kind: 'siliconflow', label: 'SiliconFlow 硅基流动', keyName: 'SILICONFLOW_API_KEY', applyUrl: 'https://cloud.siliconflow.cn/account/ak', linkVerified: true, reachableRegion: 'cn', freeQuota: '注册赠代金券', note: '本地图片 base64 直传', configured: !!(C().secrets||{}).siliconflow },
      { kind: 'modelscope', label: 'ModelScope 魔搭', keyName: 'MODELSCOPE_ACCESS_TOKEN', applyUrl: 'https://www.modelscope.cn', linkVerified: false, reachableRegion: 'cn', freeQuota: '有每日免费额度', note: '本版未作为视频通道', configured: false },
      { kind: 'huggingface', label: 'Hugging Face', keyName: 'HF_TOKEN', applyUrl: 'https://huggingface.co', linkVerified: false, reachableRegion: 'overseas', freeQuota: '需 Pro 套餐', note: '本机实测不可达', configured: false },
      { kind: 'replicate', label: 'Replicate', keyName: 'REPLICATE_API_TOKEN', applyUrl: 'https://replicate.com', linkVerified: false, reachableRegion: 'overseas', freeQuota: '无免费额度', note: '海外通道', configured: false },
      { kind: 'fal', label: 'fal.ai', keyName: 'FAL_KEY', applyUrl: 'https://fal.ai', linkVerified: false, reachableRegion: 'overseas', freeQuota: '无免费额度', note: '海外通道', configured: false }
    ]; },
    openKeyPage: async (kind) => { rec('openKeyPage', kind); return { ok: true, url: 'https://example/' + kind }; },
    setSecret: async (k, v) => { rec('setSecret', [k, v]); (window.__cfg.secrets = window.__cfg.secrets || {})[k] = true; return { saved: true, kind: k }; },
    clearSecret: async (k) => { rec('clearSecret', k); if (window.__cfg.secrets) delete window.__cfg.secrets[k]; return { cleared: true, kind: k }; },
    getConfig: async () => { rec('getConfig'); return C().config || { workspaceId: '', extraMirrors: [], autoCheckUpdate: false, localModelId: 'local-ltx-2b-fp8' }; },
    setConfig: async (patch) => { rec('setConfig', patch); return { ...(C().config || {}), ...patch }; },
    listLocalModels: async () => { rec('listLocalModels'); return C().localModels || []; },
    planLocalInstall: async (id) => { rec('planLocalInstall', id); return { ok: true, modelId: id }; },
    installLocalModel: async (id) => { rec('installLocalModel', id); if (C().installResult) return C().installResult; return { ok: true, installed: { modelId: id }, steps: [] }; },
    runLocalSelfCheck: async (id) => { rec('runLocalSelfCheck', id); return C().selfCheckResult || { ok: true, pythonPath: 'python', gpuReady: false, dryRunReady: true, dryRunOk: true, summary: 'Python：3.12.14 · torch：未安装 · CUDA：不可用 · dry-run 链路：通过 · GPU 真实出片就绪：否', problems: ['未安装 torch，无法检查 CUDA'], warnings: [], env: { python: '3.12.14', cuda: false }, dryRun: { ok: true, result: { localPath: 'C:\\out\\selfcheck.mp4', isSelfTest: true } } }; },
    checkUpdate: async (opts) => { rec('checkUpdate', opts); return C().updateResult || { ok: true, needUpdate: false, current: '1.2', latest: '1.2', message: '当前已是最新版本 1.2。', channelSummary: '3 条通道可用' }; },
    downloadUpdate: async () => { rec('downloadUpdate'); return C().downloadResult || { ok: true, message: '新版本已下载并通过校验', sha512Verified: true, winnerChannel: 'GitHub Releases 直连', bytes: 128577108, latest: '1.2', installerPath: 'C:\\tmp\\x.exe' }; },
    installUpdate: async () => { rec('installUpdate'); return { ok: true }; },
    openManualUpdate: async () => { rec('openManualUpdate'); return true; },
    getRollbackStatus: async () => { rec('getRollbackStatus'); return { needed: false }; },
    showOutputDir: async () => { rec('showOutputDir'); return true; },
    showItemInFolder: async (p) => { rec('showItemInFolder', p); return true; },
    on: (channel, listener) => { (listeners[channel] = listeners[channel] || []).push(listener); return () => { listeners[channel] = listeners[channel].filter(l => l !== listener); }; }
  };
}

let srv, browser;
const results = { pass: 0, fail: 0, skipped: 0 };

test.before(async () => {
  if (!chromium) return;
  try {
    srv = await startServer();
    browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-sandbox', '--disable-gpu'] });
  } catch (e) {
    browser = null;
    console.log('无法启动 Edge 渲染代理，GUI E2E 将跳过：' + (e.message || e).split('\n')[0]);
  }
});

test.after(async () => {
  if (browser) await browser.close().catch(() => {});
  if (srv) srv.server.close();
});

/** 打开一个新页面，注入 mock，加载界面并等待初始化完成 */
async function openPage(cfg = {}) {
  if (!browser) return null;
  const context = await browser.newContext({ viewport: { width: 1200, height: 820 } });
  // cfg 必须在页面脚本（app.js 的 init）运行前注入，否则 init 阶段读到的仍是默认值。
  // addInitScript 按注册顺序执行：先设 __cfg，再定义 mock 桥接。
  await context.addInitScript((c) => { window.__cfg = c || {}; }, cfg || {});
  await context.addInitScript(mockInitScript);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.message || e)));
  await page.goto(`http://127.0.0.1:${srv.port}/index.html`, { waitUntil: 'domcontentloaded' });
  return { page, context, errors };
}

test('GUI: 应用启动渲染品牌、导航与欢迎消息', async (t) => {
  const r = await openPage();
  if (!r) { t.skip('无 Edge 渲染代理'); return; }
  const { page, errors } = r;
  await page.waitForFunction(() => document.querySelectorAll('.msg').length > 0, null, { timeout: 5000 });
  assert.equal(await page.textContent('.brand span'), '幻想时刻');
  assert.equal((await page.$$('.nav-btn')).length, 6, '应有 6 个导航项（含新增的诊断页）');
  const welcome = await page.textContent('.msg.assistant .bubble');
  assert.ok(welcome.includes('幻想时刻'), '欢迎消息应渲染');
  assert.equal(errors.length, 0, '页面不应有 JS 错误: ' + errors.join('; '));
});

test('GUI: 导航切换视图正确', async (t) => {
  const r = await openPage();
  if (!r) { t.skip(); return; }
  const { page } = r;
  await page.waitForFunction(() => document.querySelectorAll('.msg').length > 0);
  for (const view of ['settings', 'local', 'tasks', 'diag', 'about', 'chat']) {
    await page.click(`.nav-btn[data-view="${view}"]`);
    const active = await page.$eval(`#view-${view}`, el => el.classList.contains('active'));
    assert.equal(active, true, `点击后 #view-${view} 应 active`);
  }
});

test('GUI: 输入描述后路由预览提示更新', async (t) => {
  const r = await openPage({ preview: { selected: { id: 'wan3-video', name: '通义万相 Wan 3.0' }, chain: [], rejected: [], intents: [], explanation: 'x' } });
  if (!r) { t.skip(); return; }
  const { page } = r;
  await page.waitForFunction(() => document.querySelectorAll('.msg').length > 0);
  await page.fill('#promptInput', '电影感写实画面');
  await page.waitForFunction(() => document.querySelector('#routeHint').textContent.includes('Wan 3.0'), null, { timeout: 3000 });
  assert.ok((await page.textContent('#routeHint')).includes('将使用'));
});

test('GUI: 发送消息生成用户气泡 + 助手任务气泡（含路由卡片/进度/视频）', async (t) => {
  const r = await openPage({ preview: { selected: { id: 'mock-selftest', name: '自检模式' }, chain: [], rejected: [], intents: [], explanation: '未配置 Key，落到自检模式' } });
  if (!r) { t.skip(); return; }
  const { page, errors } = r;
  await page.waitForFunction(() => document.querySelectorAll('.msg').length > 0);
  await page.fill('#promptInput', '一只猫在草地上奔跑');
  await page.click('#btnSend');
  // 等视频出现
  await page.waitForSelector('.msg.assistant .bubble video', { timeout: 5000 });
  const userText = await page.textContent('.msg.user .bubble');
  assert.ok(userText.includes('一只猫'), '用户消息应显示');
  const routingCard = await page.$('.msg.assistant .routing-card');
  assert.ok(routingCard, '应有路由选型理由卡片');
  const videoSrc = await page.$eval('.msg.assistant video', v => v.getAttribute('src'));
  assert.ok(videoSrc.includes('selftest.mp4'), '应内嵌结果视频: ' + videoSrc);
  assert.equal(errors.length, 0, '不应有 JS 错误: ' + errors.join('; '));
});

test('GUI: 自检结果必须显示"非真实 AI 生成"标注', async (t) => {
  const r = await openPage();
  if (!r) { t.skip(); return; }
  const { page } = r;
  await page.waitForFunction(() => document.querySelectorAll('.msg').length > 0);
  await page.fill('#promptInput', '测试');
  await page.click('#btnSend');
  await page.waitForSelector('.msg.assistant .selftest-tag', { timeout: 5000 });
  const tag = await page.textContent('.msg.assistant .selftest-tag');
  assert.ok(tag.includes('自检模式') && tag.includes('不是真实'), '必须明确标注非真实生成: ' + tag);
});

test('GUI: 生成期间出现取消按钮，点击后调用 cancelGenerate', async (t) => {
  const r = await openPage({
    generateResult: new Promise(() => {}) // 永不 resolve，模拟长任务
  });
  if (!r) { t.skip(); return; }
  const { page } = r;
  await page.waitForFunction(() => document.querySelectorAll('.msg').length > 0);
  await page.fill('#promptInput', '长任务');
  await page.click('#btnSend');
  await page.waitForFunction(() => document.querySelector('#btnCancel').style.display !== 'none', null, { timeout: 3000 });
  await page.click('#btnCancel');
  await page.waitForFunction(() => window.__calls.some(c => c.name === 'cancelGenerate'), null, { timeout: 3000 });
  assert.ok(true, '取消按钮应可用并触发 cancelGenerate');
});

test('GUI: 设置页渲染各通道密钥行并可保存', async (t) => {
  const r = await openPage();
  if (!r) { t.skip(); return; }
  const { page } = r;
  await page.waitForFunction(() => document.querySelectorAll('.msg').length > 0);
  await page.click('.nav-btn[data-view="settings"]');
  await page.waitForSelector('.key-block', { timeout: 3000 });
  const blocks = await page.$$('.key-block');
  assert.ok(blocks.length >= 6, '应有各云端通道的密钥块');
  const names = await page.$$eval('.key-row .kname', els => els.map(e => e.textContent));
  assert.ok(names.some(n => n.includes('阿里云百炼')), '应含百炼');
  assert.ok(names.some(n => n.includes('SiliconFlow')), '应含 SiliconFlow');
  // 填第一个 key 并保存
  await page.fill('.key-block:nth-child(1) input', 'sk-test-123');
  await page.click('.key-block:nth-child(1) .key-row button.ghost-btn');
  await page.waitForFunction(() => window.__calls.some(c => c.name === 'setSecret'), null, { timeout: 3000 });
});

test('GUI: 设置页每个通道显示申请引导（去哪弄 Key + 额度 + 可达性）', async (t) => {
  const r = await openPage();
  if (!r) { t.skip(); return; }
  const { page } = r;
  await page.waitForFunction(() => document.querySelectorAll('.msg').length > 0);
  await page.click('.nav-btn[data-view="settings"]');
  await page.waitForSelector('.key-guide', { timeout: 3000 });
  // 申请链接存在
  const links = await page.$$('.key-guide .key-link');
  assert.ok(links.length >= 6, '每个通道都应有申请链接');
  // 免费额度说明存在
  const guideText = await page.$$eval('.key-guide', els => els.map(e => e.textContent).join(' '));
  assert.ok(guideText.includes('额度'), '应说明免费额度');
  // 可达性提示：国内可达 / 海外不可达
  const states = await page.$$eval('.key-row .kstate', els => els.map(e => e.textContent).join(' '));
  assert.ok(states.includes('国内可达'), '应标注国内通道可达');
  assert.ok(states.includes('海外') || states.includes('不可达'), '应标注海外通道本机不可达');
});

test('GUI 安全: 点击申请链接只传 kind 给主进程，URL 由主进程决定（不接受任意 URL）', async (t) => {
  const r = await openPage();
  if (!r) { t.skip(); return; }
  const { page } = r;
  await page.waitForFunction(() => document.querySelectorAll('.msg').length > 0);
  await page.click('.nav-btn[data-view="settings"]');
  await page.waitForSelector('.key-guide .key-link', { timeout: 3000 });
  await page.click('.key-block:nth-child(1) .key-guide .key-link');
  await page.waitForFunction(() => window.__calls.some(c => c.name === 'openKeyPage'), null, { timeout: 3000 });
  const call = await page.evaluate(() => window.__calls.find(c => c.name === 'openKeyPage'));
  assert.equal(call.args, 'dashscope', '只应传通道标识 kind，不传 URL');
  // 链接是 href="#" 由 JS 拦截，不是直接导航到外链（防钓鱼）
  const href = await page.$eval('.key-block:nth-child(1) .key-guide .key-link', a => a.getAttribute('href'));
  assert.equal(href, '#', '链接应为占位 href，点击交给主进程处理');
});

test('GUI: 海外通道申请链接标注"未核实"，不误导用户', async (t) => {
  const r = await openPage();
  if (!r) { t.skip(); return; }
  const { page } = r;
  await page.waitForFunction(() => document.querySelectorAll('.msg').length > 0);
  await page.click('.nav-btn[data-view="settings"]');
  await page.waitForSelector('.key-guide .key-link', { timeout: 3000 });
  // Hugging Face（linkVerified=false）的链接文案应为"打开官网申请"而非"去哪申请 Key"
  const links = await page.$$eval('.key-block', blocks => blocks.map(b => {
    const name = (b.querySelector('.kname') || {}).textContent || '';
    const link = (b.querySelector('.key-link') || {}).textContent || '';
    const title = (b.querySelector('.key-link') || {}).title || '';
    return { name, link, title };
  }));
  const hf = links.find(l => l.name.includes('Hugging Face'));
  assert.ok(hf, '应有 Hugging Face 行');
  assert.ok(hf.link.includes('官网'), '未核实链接应表述为打开官网');
  assert.ok(hf.title.includes('未') || hf.title.includes('核实'), '应提示链接未逐一核实');
});

test('GUI: 设置页保存配置调用 setConfig', async (t) => {
  const r = await openPage();
  if (!r) { t.skip(); return; }
  const { page } = r;
  await page.waitForFunction(() => document.querySelectorAll('.msg').length > 0);
  await page.click('.nav-btn[data-view="settings"]');
  await page.fill('#cfgWorkspace', 'ws-abc');
  await page.click('#btnSaveConfig');
  await page.waitForFunction(() => window.__calls.some(c => c.name === 'setConfig' && c.args.workspaceId === 'ws-abc'), null, { timeout: 3000 });
  assert.ok(true);
});

test('GUI: 本地模型页渲染卡片，硬件不足时禁用安装按钮', async (t) => {
  const r = await openPage({
    localModels: [
      { id: 'local-ltx-2b-fp8', name: '本地 LTX-Video 2B', license: 'Apache-2.0', vramGB: 6.5, ramGB: 10, downloadGB: 5.32, resolution: '480p', maxDurationSec: 5, installed: false, readiness: { canInstall: true, problems: [], warnings: [] }, notes: '8GB 显存最优' },
      { id: 'local-big', name: '本地大模型', license: 'Apache-2.0', vramGB: 40, ramGB: 64, downloadGB: 80, installed: false, readiness: { canInstall: false, problems: ['需显存 40GB，本机仅 8GB'], warnings: [] }, notes: '' }
    ]
  });
  if (!r) { t.skip(); return; }
  const { page } = r;
  await page.waitForFunction(() => document.querySelectorAll('.msg').length > 0);
  await page.click('.nav-btn[data-view="local"]');
  await page.waitForSelector('.model-card', { timeout: 3000 });
  // 排除自检卡（它也用 model-card 类），只数真实模型卡
  const cards = await page.$$('.model-card:not(.selfcheck-card)');
  assert.equal(cards.length, 2);
  // 第二个硬件不足，安装按钮应 disabled（自检卡的按钮不参与此断言）
  const disabled = await page.$$eval('.model-card:not(.selfcheck-card) button.primary-btn', btns => btns.map(b => b.disabled));
  assert.equal(disabled[0], false, '硬件够的应可安装');
  assert.equal(disabled[1], true, '硬件不够的必须禁用安装');
  const bodyText = await page.textContent('#localBody');
  assert.ok(bodyText.includes('本机不满足'), '应说明硬件不满足原因');
});

test('GUI: 本地模型已安装时显示"用它生成"按钮', async (t) => {
  const r = await openPage({
    localModels: [{ id: 'local-ltx-2b-fp8', name: '本地 LTX-Video 2B', license: 'Apache-2.0', vramGB: 6.5, ramGB: 10, downloadGB: 5.32, installed: true, readiness: { canInstall: true, problems: [], warnings: [] } }]
  });
  if (!r) { t.skip(); return; }
  const { page } = r;
  await page.waitForFunction(() => document.querySelectorAll('.msg').length > 0);
  await page.click('.nav-btn[data-view="local"]');
  await page.waitForSelector('.model-card .badge.installed', { timeout: 3000 });
  const useBtn = await page.$('.model-card button.ghost-btn');
  assert.ok(useBtn, '已安装应有"用它生成"按钮');
  await useBtn.click();
  // 应切回对话视图并勾选离线
  const offlineChecked = await page.$eval('#chkOffline', c => c.checked);
  assert.equal(offlineChecked, true, '点击后应勾选离线生成');
});

test('GUI: 本地模型页有自检面板且点击后展示结果', async (t) => {
  const r = await openPage();
  if (!r) { t.skip(); return; }
  const { page, errors } = r;
  await page.waitForFunction(() => document.querySelectorAll('.msg').length > 0);
  await page.click('.nav-btn[data-view="local"]');
  await page.waitForSelector('.selfcheck-card', { timeout: 3000 });
  const title = await page.textContent('.selfcheck-card h3');
  assert.ok(title.includes('本地推理自检'), '应有自检面板标题');
  const btn = await page.$('.selfcheck-card button.primary-btn');
  assert.ok(btn, '应有运行自检按钮');
  await btn.click();
  await page.waitForFunction(() => window.__calls.some(c => c.name === 'runLocalSelfCheck'), null, { timeout: 5000 });
  await page.waitForSelector('.selfcheck-card .kstate', { timeout: 5000 });
  const states = await page.$$eval('.selfcheck-card .kstate', els => els.map(e => e.textContent));
  assert.ok(states.some(s => s.includes('dry-run') || s.includes('链路')), '应显示 dry-run 链路状态');
  assert.ok(states.some(s => s.includes('GPU')), '应显示 GPU 出片就绪状态');
  const summary = await page.textContent('.selfcheck-card .sc-out');
  assert.ok(summary.includes('Python'), 'summary 应含 Python 版本');
  assert.equal(errors.length, 0, '不应有 JS 错误: ' + errors.join('; '));
});

test('GUI: 自检 dry-run 结果必须标注"非真实 AI 生成"', async (t) => {
  const r = await openPage();
  if (!r) { t.skip(); return; }
  const { page } = r;
  await page.waitForFunction(() => document.querySelectorAll('.msg').length > 0);
  await page.click('.nav-btn[data-view="local"]');
  await page.waitForSelector('.selfcheck-card', { timeout: 3000 });
  await page.click('.selfcheck-card button.primary-btn');
  await page.waitForSelector('.selfcheck-card .selftest-tag', { timeout: 5000 });
  const tag = await page.textContent('.selfcheck-card .selftest-tag');
  assert.ok(tag.includes('自检占位视频') || tag.includes('非真实 AI 生成'), '必须明确标注非真实生成: ' + tag);
});

test('GUI: 自检失败时如实展示问题，不伪造就绪', async (t) => {
  const r = await openPage({
    selfCheckResult: {
      ok: true, pythonPath: 'python', gpuReady: false, dryRunReady: false, dryRunOk: false,
      summary: 'Python：3.12 · torch：未安装 · CUDA：不可用 · dry-run 链路：失败 · GPU 真实出片就绪：否',
      problems: ['未安装 torch', 'dry-run 链路自检失败：缺 numpy'], warnings: [],
      env: { python: '3.12', cuda: false }, dryRun: { ok: false, error: '缺 numpy' }
    }
  });
  if (!r) { t.skip(); return; }
  const { page } = r;
  await page.waitForFunction(() => document.querySelectorAll('.msg').length > 0);
  await page.click('.nav-btn[data-view="local"]');
  await page.waitForSelector('.selfcheck-card', { timeout: 3000 });
  await page.click('.selfcheck-card button.primary-btn');
  await page.waitForFunction(() => document.querySelector('.selfcheck-card .kstate.off'), null, { timeout: 5000 });
  const states = await page.$$eval('.selfcheck-card .kstate', els => els.map(e => ({ text: e.textContent, cls: e.className })));
  assert.ok(states.some(s => s.text.includes('✗') || s.cls.includes('off')), '失败项必须用 off 样式标注');
  const warnText = await page.$$eval('.selfcheck-card .warn', els => els.map(e => e.textContent).join(' '));
  assert.ok(warnText.includes('torch') || warnText.includes('numpy'), '应如实列出缺失依赖');
  assert.ok(!states.some(s => s.text.includes('✓ GPU 出片就绪')), 'GPU 未就绪不得显示为就绪');
});

test('GUI: 检测更新浮层——已最新时提示无需更新', async (t) => {
  const r = await openPage({ updateResult: { ok: true, needUpdate: false, current: '1.2', latest: '1.2', message: '当前已是最新版本 1.2。', channelSummary: '3 条通道可用（GitHub API、HTML、Tags）' } });
  if (!r) { t.skip(); return; }
  const { page } = r;
  await page.waitForFunction(() => document.querySelectorAll('.msg').length > 0);
  await page.click('#btnCheckUpdate');
  await page.waitForFunction(() => document.querySelector('#updateBody').textContent.includes('已是最新'), null, { timeout: 3000 });
  assert.ok((await page.textContent('#updateBody')).includes('已是最新'));
});

test('GUI: 检测更新浮层——有新版本时显示下载安装按钮', async (t) => {
  const r = await openPage({ updateResult: { ok: true, needUpdate: true, current: '1.2', latest: '1.3', message: '发现新版本', channelSummary: '3 条通道可用' } });
  if (!r) { t.skip(); return; }
  const { page } = r;
  await page.waitForFunction(() => document.querySelectorAll('.msg').length > 0);
  await page.click('#btnCheckUpdate');
  await page.waitForSelector('#updateBody button.primary-btn', { timeout: 3000 });
  const btnText = await page.textContent('#updateBody button.primary-btn');
  assert.ok(btnText.includes('下载并安装'));
});

test('GUI: 更新全失败时给出手动下载入口', async (t) => {
  const r = await openPage({ updateResult: { ok: false, message: '所有更新通道均无法连通', detail: 'timeout', manualUrl: 'https://github.com/sml1145/AIshipin/releases/latest' } });
  if (!r) { t.skip(); return; }
  const { page } = r;
  await page.waitForFunction(() => document.querySelectorAll('.msg').length > 0);
  await page.click('#btnCheckUpdate');
  await page.waitForFunction(() => document.querySelector('#updateBody').textContent.includes('无法连通'), null, { timeout: 3000 });
  const manual = await page.$('#updateBody button.ghost-btn');
  assert.ok(manual, '应提供打开下载页面按钮');
});

test('GUI: 关于页显示版本与模型库信息', async (t) => {
  const r = await openPage();
  if (!r) { t.skip(); return; }
  const { page } = r;
  await page.waitForFunction(() => document.querySelectorAll('.msg').length > 0);
  await page.click('.nav-btn[data-view="about"]');
  const ver = await page.textContent('#aboutVersion');
  assert.ok(ver.includes('1.2'), '应显示版本: ' + ver);
  const detail = await page.textContent('#aboutDetail');
  assert.ok(detail.includes('模型库版本') && detail.includes('可用模型'));
});

test('GUI 安全关键: Markdown 渲染转义 <script>/<img onerror>，杜绝 XSS', async (t) => {
  const r = await openPage({
    // 模拟模型返回含恶意脚本的说明文本，验证渲染层转义
    preview: { selected: { id: 'x', name: 'X' }, chain: [], rejected: [], intents: [], explanation: '<script>window.__xss1=true</script><img src=x onerror="window.__xss2=true">正常文本' }
  });
  if (!r) { t.skip(); return; }
  const { page } = r;
  await page.waitForFunction(() => document.querySelectorAll('.msg').length > 0);
  await page.fill('#promptInput', 'test');
  await page.click('#btnSend');
  await page.waitForSelector('.msg.assistant .routing-card', { timeout: 5000 });
  await page.waitForTimeout(300); // 给潜在 onerror 触发时间
  const xss1 = await page.evaluate(() => window.__xss1 === true);
  const xss2 = await page.evaluate(() => window.__xss2 === true);
  assert.equal(xss1, false, '<script> 不得执行');
  assert.equal(xss2, false, '<img onerror> 不得执行');
  const cardHtml = await page.$eval('.routing-card', el => el.innerHTML);
  assert.ok(cardHtml.includes('&lt;script&gt;') || !cardHtml.includes('<script'), '脚本应被转义为文本');
});

test('GUI: 硬件摘要显示 GPU 与显存', async (t) => {
  const r = await openPage();
  if (!r) { t.skip(); return; }
  const { page } = r;
  await page.waitForFunction(() => document.querySelector('#hwSummary').textContent.includes('RTX 4060'), null, { timeout: 5000 });
  const hw = await page.textContent('#hwSummary');
  assert.ok(hw.includes('8') && hw.includes('15.2'));
});

test('GUI: 轨道徽标——无 Key 显示自检模式，有 Key 显示云端就绪', async (t) => {
  const r1 = await openPage({ secrets: {} });
  if (!r1) { t.skip(); return; }
  await r1.page.waitForFunction(() => document.querySelectorAll('.msg').length > 0);
  assert.equal(await r1.page.textContent('#trackBadge'), '自检模式');
  await r1.context.close();

  const r2 = await openPage({ secrets: { dashscope: true } });
  await r2.page.waitForFunction(() => document.querySelectorAll('.msg').length > 0);
  assert.equal(await r2.page.textContent('#trackBadge'), '云端就绪');
  await r2.context.close();
});
