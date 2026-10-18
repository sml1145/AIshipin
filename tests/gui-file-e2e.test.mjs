/**
 * file:// 加载方式的界面 E2E（补上此前只用 http:// 测试留下的盲区）
 *
 * 教训：真实应用用 loadFile() 以 file:// 加载页面，而此前的界面 E2E 全部用
 * 本地 http 服务托管。两者在 CSP 'self' 的匹配行为上可能不同 —— 若 CSP 拦截了
 * app.js，http 方式的测试会全绿，而真实应用里所有按钮都失效。
 *
 * 本测试直接用 file:// 加载真实 index.html + 真实 app.js（不经过任何构建），
 * 断言：脚本确实执行、导航可切换、＋图片可触发文件选择、桥接缺失时错误可见。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RENDERER = join(ROOT, 'src', 'renderer');
const INDEX_FILE = join(RENDERER, 'index.html');

test('file:// 加载真实界面：脚本执行且按钮可用', async (t) => {
  assert.ok(existsSync(INDEX_FILE), 'index.html 必须存在');

  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(() => browser.close());

  const ctx = await browser.newContext();

  // 真实 preload 无法在纯浏览器里运行（依赖 electron），因此注入等价 mock。
  // 注意：这里刻意让 mock 的返回形状与主进程【完全一致】，避免形状不符掩盖真 bug。
  await ctx.addInitScript(() => {
    const calls = [];
    window.__calls = calls;
    window.hxsk = {
      getAppInfo: async () => ({ name: '幻想时刻', version: '1.3.0', displayVersion: '1.3', electron: '44.7.2', chrome: '130', platform: 'win32', arch: 'x64', isPackaged: false, ffmpeg: 'C:/ffmpeg.exe', userData: 'C:/ud', outputDir: 'C:/out' }),
      detectHardware: async () => ({ gpu: 'RTX 4060', vramGB: 8, totalRamGB: 15.2, freeRamGB: 8, diskFreeGB: 100, vramWarning: null, displayAdapters: [] }),
      getCatalog: async () => ({ models: [{ id: 'm1', name: 'M1' }], intents: [], schemaVersion: 2, facts: [] }),
      refreshCatalog: async () => ({ updated: false, source: 'bundled', message: '' }),
      previewRoute: async () => ({ ok: true, selected: { modelId: 'mock', displayName: 'Mock 自检', track: 'mock', reasons: ['无 Key'] }, chain: [], rejected: [], explanation: '**选型理由**：测试' }),
      submitGenerate: async () => { calls.push('submitGenerate'); return { ok: false, message: '测试：未真正生成', suggestion: '测试建议' }; },
      cancelGenerate: async () => ({ ok: true }),
      getTask: async () => ({ ok: true, task: null }),
      listLocalModels: async () => ({ ok: true, models: [], readiness: null, pythonPath: null }),
      planLocalInstall: async () => ({ ok: false, error: '测试' }),
      installLocalModel: async () => ({ ok: false, error: '测试' }),
      runLocalSelfCheck: async () => ({ ok: false, summary: '测试：未安装运行时', problems: ['缺 Python'], warnings: [] }),
      // 关键：记录被调用，用于断言"＋图片"确实触发了文件选择
      pickImage: async () => { calls.push('pickImage'); return 'C:/tmp/picked.png'; },
      listSecrets: async () => ({ configured: {} }),
      setSecret: async () => ({ ok: true }),
      clearSecret: async () => ({ ok: true }),
      // 必须与主进程真实返回形状一致：secret:providers 返回【数组】，不是 {ok,providers}
      // （此前 mock 写成对象，导致测试通过但真实界面 for...of 抛 not iterable）
      listProviders: async () => ([{ kind: 'dashscope', label: '阿里云百炼', keyName: 'DASHSCOPE_API_KEY', applyUrl: 'https://bailian.console.aliyun.com', linkVerified: true, reachableRegion: 'cn', freeQuota: '有', note: null, configured: false }]),
      openKeyPage: async () => ({ ok: true }),
      // config:get 返回纯配置对象，无 ok 包装
      getConfig: async () => ({ workspaceId: '', extraMirrors: [], autoCheckUpdate: false }),
      setConfig: async () => { calls.push('setConfig'); return { ok: true }; },
      checkUpdate: async () => { calls.push('checkUpdate'); return { ok: true, needUpdate: false, message: '当前已是最新版本 1.3。', channelSummary: '3 通道' }; },
      downloadUpdate: async () => ({ ok: true }),
      installUpdate: async () => ({ ok: true }),
      openManualUpdate: async () => ({ ok: true }),
      getRollbackStatus: async () => ({ ok: true, pending: false }),
      showOutputDir: async () => ({ ok: true }),
      showItemInFolder: async () => ({ ok: true }),
      on: () => () => {}
    };
  });

  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  // 核心：用 file:// 加载真实文件（与 Electron loadFile 等价）
  const fileUrl = pathToFileURL(INDEX_FILE).href;
  await page.goto(fileUrl, { waitUntil: 'load', timeout: 20000 });
  await page.waitForTimeout(900);

  t.assert.ok(errors.length === 0, '不应有脚本错误，实际：\n' + errors.join('\n'));

  // 1) app.js 确实执行了（CSP 未拦截脚本）—— 这是本次修复的关键断言
  const scriptRan = await page.evaluate(() => document.querySelectorAll('#chatLog > *').length);
  t.assert.ok(scriptRan >= 1, `app.js 必须已执行并插入欢迎消息，实际子元素数=${scriptRan}（若为 0 说明脚本被 CSP 拦截或未加载）`);

  // 2) 版本号已渲染（证明 init 的 getAppInfo 步骤成功）
  const ver = await page.textContent('#aboutVersion');
  t.assert.match(ver, /1\.3/, '关于页版本应已渲染');

  // 3) 导航按钮可用（纯 DOM，不依赖桥接）
  await page.click('.nav-btn[data-view="settings"]');
  await page.waitForTimeout(300);
  t.assert.ok(await page.evaluate(() => document.getElementById('view-settings').classList.contains('active')), '设置视图应被激活');
  t.assert.ok(await page.evaluate(() => document.getElementById('view-chat').classList.contains('active') === false), '对话视图应被隐藏');

  // 4) 症状2 修复验证：＋图片按钮必须真的触发 pickImage，并把图片加入预览
  await page.click('.nav-btn[data-view="chat"]');
  await page.waitForTimeout(200);
  await page.click('#btnAddImage');
  await page.waitForTimeout(400);
  const callsAfterPick = await page.evaluate(() => window.__calls.slice());
  t.assert.ok(callsAfterPick.includes('pickImage'), '点击＋图片必须调用 pickImage（拉不起对话框的症状）');
  const previewCount = await page.evaluate(() => document.querySelectorAll('#imagePreviewRow .pv').length);
  t.assert.equal(previewCount, 1, '选中的图片应出现在预览区');

  // 5) 检测更新按钮必须有可见反馈
  await page.click('#btnCheckUpdate');
  await page.waitForTimeout(400);
  const overlayVisible = await page.evaluate(() => !document.getElementById('updateOverlay').classList.contains('hidden'));
  t.assert.ok(overlayVisible, '点击检测更新后浮层应显示');
  const overlayText = await page.textContent('#updateBody');
  t.assert.match(overlayText, /最新版本/, '浮层应显示检测结果文案');
  await page.click('#updateClose');
  await page.waitForTimeout(200);
  t.assert.ok(await page.evaluate(() => document.getElementById('updateOverlay').classList.contains('hidden')), '关闭按钮应隐藏浮层');

  // 6) 生成按钮必须有反馈（mock 返回失败，界面应显示失败文案而非静默）
  await page.fill('#promptInput', '测试描述');
  await page.click('#btnSend');
  await page.waitForTimeout(500);
  const chatText = await page.evaluate(() => document.getElementById('chatLog').textContent);
  t.assert.match(chatText, /测试：未真正生成|测试建议/, '生成失败时必须在界面上给出可见反馈');

  await ctx.close();
});

test('file:// 桥接缺失时：错误可见而非静默死亡', async (t) => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(() => browser.close());

  // 刻意【不注入】window.hxsk，模拟 preload 未成功注入的真实故障
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));

  await page.goto(pathToFileURL(INDEX_FILE).href, { waitUntil: 'load', timeout: 20000 });
  await page.waitForTimeout(700);

  // 关键：即使桥接缺失，脚本也不得中断 —— 导航（纯 DOM）仍必须可用
  await page.click('.nav-btn[data-view="about"]');
  await page.waitForTimeout(300);
  const aboutActive = await page.evaluate(() => document.getElementById('view-about').classList.contains('active'));
  t.assert.ok(aboutActive, '桥接缺失时导航按钮仍必须工作（否则脚本已被中断，这正是"所有按钮无反馈"的成因）');

  // 必须显示明确的错误横幅，而不是让用户对着死界面猜
  const banner = await page.evaluate(() => {
    const b = document.getElementById('fatalBanner');
    return b ? b.textContent : null;
  });
  t.assert.ok(banner && /桥接未加载/.test(banner), '桥接缺失时必须显示可读的错误横幅，实际：' + banner);

  // 横幅必须可关闭，否则会盖住整个界面导致用户连导航都点不了
  await page.click('#fatalBannerClose');
  await page.waitForTimeout(200);
  const bannerHidden = await page.evaluate(() => document.getElementById('fatalBanner').style.display === 'none');
  t.assert.ok(bannerHidden, '错误横幅必须可关闭，否则会遮挡界面所有操作');

  // 切回对话视图再点（＋图片在 #view-chat 内，非激活视图是 display:none 点不到）
  await page.click('.nav-btn[data-view="chat"]');
  await page.waitForTimeout(200);

  // 点击依赖桥接的按钮不得抛未捕获异常（应被安全代理兜住）
  let threw = null;
  try {
    await page.click('#btnAddImage', { timeout: 5000 });
    await page.waitForTimeout(400);
  } catch (e) { threw = e.message.split('\n')[0]; }
  t.assert.equal(threw, null, '点击＋图片不应抛未捕获异常');

  await ctx.close();
});

test('诊断面板：逐个接口自检并呈现连通结果', async (t) => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(() => browser.close());
  const ctx = await browser.newContext();

  // 注入完整 mock，但故意让【某一个接口失败】，验证诊断能如实标出失败项
  await ctx.addInitScript(() => {
    window.hxsk = {
      getAppInfo: async () => ({ version: '1.3.0', displayVersion: '1.3', electron: '44.7.2', chrome: '130', platform: 'win32', arch: 'x64', ffmpeg: null, userData: 'C:/ud', outputDir: 'C:/out' }),
      getCatalog: async () => ({ models: [], intents: [], schemaVersion: 2 }),
      detectHardware: async () => ({ gpu: 'RTX 4060', vramGB: 8, totalRamGB: 15.2 }),
      getConfig: async () => ({ workspaceId: '', extraMirrors: [], autoCheckUpdate: false }),
      listSecrets: async () => ({ configured: {} }),
      listProviders: async () => ([]),
      listLocalModels: async () => ({ ok: true, models: [] }),
      previewRoute: async () => ({ ok: true, selected: null, chain: [], rejected: [], explanation: '' }),
      // 故意失败：验证诊断能捕获并显示 ✗
      checkUpdate: async () => { throw new Error('模拟通道全挂'); },
      showOutputDir: async () => ({ ok: true }),
      on: () => () => {}
    };
  });

  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(pathToFileURL(INDEX_FILE).href, { waitUntil: 'load', timeout: 20000 });
  await page.waitForTimeout(800);
  t.assert.ok(errors.length === 0, '诊断页加载不应有脚本错误：' + errors.join('; '));

  // 切到诊断页并运行自检
  await page.click('.nav-btn[data-view="diag"]');
  await page.waitForTimeout(200);
  await page.click('#btnRunDiag');
  await page.waitForTimeout(600);

  // 诊断结果应包含通过项与失败项
  const diagText = await page.evaluate(() => document.getElementById('diagBody').textContent);
  t.assert.match(diagText, /应用信息/, '诊断应列出应用信息接口');
  t.assert.match(diagText, /模拟通道全挂/, '诊断必须如实显示失败接口的错误原因，而非静默');

  const okCount = await page.evaluate(() => document.querySelectorAll('#diagBody .diag-ok').length);
  const badCount = await page.evaluate(() => document.querySelectorAll('#diagBody .diag-bad').length);
  t.assert.ok(okCount >= 5, `应有多个通过项，实际 ${okCount}`);
  t.assert.ok(badCount >= 1, `失败接口应被标红，实际 badCount=${badCount}`);
  t.assert.match(diagText, /小结：/, '诊断应给出通过/失败小结');

  await ctx.close();
});
