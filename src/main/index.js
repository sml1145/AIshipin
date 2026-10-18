'use strict';

/**
 * Electron 主进程
 *
 * 安全基线（对话式应用的底线）：
 *   - contextIsolation: true、nodeIntegration: false、sandbox: true
 *   - 渲染进程只能通过 preload 的 contextBridge 调用白名单方法，触达不到 require/fs/child_process
 *   - 所有真实能力（网络、文件、子进程、密钥）都留在主进程
 */

const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const pathsMod = require('./paths.js');
const catalogMod = require('./catalog.js');
const hardware = require('./hardware.js');
const { SecretStore, SECRET_KINDS, getProviderMeta, getKeyApplyUrl } = require('./secrets.js');
const { Orchestrator } = require('./orchestrator.js');
const { UpdateManager } = require('./updater.js');
const { MockProvider } = require('./providers/mock.js');
const { DashScopeProvider } = require('./providers/dashscope.js');
const { SiliconFlowProvider } = require('./providers/siliconflow.js');
const { LocalProvider } = require('./providers/local.js');
const ffmpegMod = require('./ffmpeg.js');
const runtimeMod = require('./local-runtime.js');
const renderCompat = require('./render-compat.js');
const selfCheckMod = require('./local-selfcheck.js');

const pkg = require('../../package.json');

/* ============ 启动开关（必须在 app.whenReady 之前 appendSwitch 才生效）============
 *
 * 背景（本机实测 + electron#54552）：
 *   在含 IDD 虚拟显示适配器（ToDesk / MuMu / GameViewer 等远程桌面/模拟器）的会话里，
 *   Chromium 的 CollectDriverInfoD3D() 可能选中虚拟适配器，导致 GPU 进程断言崩溃
 *   （STATUS_BREAKPOINT 0x80000003），页面永远无法提交渲染（did-finish-load 不触发）。
 *
 * 诚实说明：实测 --disable-gpu / swiftshader / no-zygote / offscreen 等 8 组开关在真实
 *   IDD 环境下均无效；根本解法是在物理显示会话运行、或在设备管理器禁用这些虚拟显示适配器。
 *   这里注入一组"尽力而为"的兼容性开关（对部分环境可能有效），并提供环境变量
 *   HXSK_GPU_FLAGS 让受影响用户自行追加尝试，但**不承诺一定能修复**。
 *   渲染是否真的成功由下方 createWindow 里的看门狗检测并给出可读诊断。
 */
for (const sw of renderCompat.collectGpuSwitches(process.env.HXSK_GPU_FLAGS)) {
  try { app.commandLine.appendSwitch(sw.name, sw.value); } catch { /* 忽略 */ }
}

/** 单实例锁：避免多开导致更新与端口冲突 */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

let mainWindow = null;
let PATHS = null;
let secretStore = null;
let orchestrator = null;
let updateManager = null;
let providers = new Map();
let hwCache = null;

/* ============ 初始化 ============ */

function initRuntime() {
  PATHS = pathsMod.resolvePaths({
    appPath: app.getAppPath(),
    userDataPath: app.getPath('userData'),
    resourcesPath: process.resourcesPath,
    isPackaged: app.isPackaged,
    homeDir: app.getPath('home')
  });
  pathsMod.ensureDirs(PATHS);

  secretStore = new SecretStore({ paths: PATHS, safeStorage });

  // 注册 Provider（云端通道用函数惰性取 Key，避免密钥常驻内存）
  providers = new Map();
  providers.set('mock', new MockProvider({ outputDir: PATHS.outputDir, emit: forwardTaskProgress }));
  providers.set('dashscope', new DashScopeProvider({
    outputDir: PATHS.outputDir,
    emit: forwardTaskProgress,
    getApiKey: () => secretStore.getKey('dashscope')
  }));
  // workspaceId 可能随配置变化，每次请求前同步最新值（Provider 的 baseUrl getter 读 this.workspaceId）
  syncWorkspace();
  providers.set('siliconflow', new SiliconFlowProvider({
    outputDir: PATHS.outputDir,
    emit: forwardTaskProgress,
    getApiKey: () => secretStore.getKey('siliconflow')
  }));
  providers.set('local', new LocalProvider({
    paths: PATHS,
    emit: forwardTaskProgress
  }));

  orchestrator = new Orchestrator({
    catalog: currentCatalog(),
    providers,
    paths: PATHS,
    getHardware: () => hwCache || { vramGB: 0, ramGB: 0, diskFreeGB: 0 },
    getProviderStatus: buildProviderStatus,
    getLocalModelsInstalled: listInstalledLocalModels,
    emit: forwardTaskProgress
  });

  updateManager = new UpdateManager({
    paths: PATHS,
    currentVersion: pkg.version,
    extraMirrors: secretStore.loadConfig().extraMirrors || [],
    electronApp: app,
    onState: (state) => sendToRenderer('update:state', state)
  });
}

let cachedCatalog = null;
function currentCatalog() {
  if (!cachedCatalog) {
    const loaded = catalogMod.load({ catalogBundled: PATHS.catalogBundled, catalogCached: PATHS.catalogCached });
    cachedCatalog = loaded.catalog;
  }
  return cachedCatalog;
}

/** 同步百炼地域端点配置到 Provider（workspaceId 可在设置里改，需即时生效） */
function syncWorkspace() {
  const ds = providers.get('dashscope');
  if (ds && secretStore) ds.workspaceId = secretStore.loadConfig().workspaceId || null;
}

/** 汇总各通道状态，供路由判断可达性与是否有 Key */
function buildProviderStatus() {
  const cfg = secretStore.listConfiguredKinds().configured;
  const status = {};
  for (const [name] of providers) {
    status[name] = { reachable: true, hasKey: Boolean(cfg[name]) };
  }
  // mock 与 local 不需要 Key
  status.mock = { reachable: providers.has('mock'), hasKey: false };
  status.local = { reachable: true, hasKey: false };
  return status;
}

/** 已安装的本地模型：用运行时管理器的统一判定，检查全部权重文件（含子目录）是否真的都在 */
function listInstalledLocalModels() {
  const installed = [];
  const cat = currentCatalog();
  for (const m of cat.models) {
    if (m.track !== 'local' || !m.weights) continue;
    if (runtimeMod.isModelInstalled(m, PATHS)) installed.push(m.id);
  }
  return installed;
}

/** 把编排器/Provider 的进度转发给渲染进程 */
function forwardTaskProgress(taskId, state) {
  sendToRenderer('task:progress', { taskId, ...state });
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

/* ============ 窗口 ============ */

function createWindow() {
  // 打包后图标已由 electron-builder 写入 exe；开发态才从 build 目录读取
  const devIcon = app.isPackaged ? undefined : path.join(__dirname, '..', '..', 'build', 'icon.ico');
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: '幻想时刻',
    backgroundColor: '#0f1115',
    icon: devIcon,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false
    }
  });

  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // 渲染看门狗：IDD 虚拟显示环境下页面可能永不提交渲染（did-finish-load 不触发）。
  // 检测到这种情况就写详细诊断日志并弹可读提示，明确指向根因，而不是让用户对着白屏干等。
  let rendered = false;
  const renderStart = Date.now();
  mainWindow.webContents.once('did-finish-load', () => { rendered = true; });
  const watchdogMs = Number(process.env.HXSK_RENDER_WATCHDOG_MS) || renderCompat.DEFAULT_WATCHDOG_MS;
  setTimeout(async () => {
    if (rendered || !mainWindow || mainWindow.isDestroyed()) return;
    // 适配器名从后台预热的硬件探测结果取（含 IDD 虚拟适配器）。
    // 竞态兜底：若后台探测尚未完成（displayAdapters 为空），这里同步补探测一次，
    // 否则诊断会漏判 IDD（实测：看门狗先于后台 detect 触发时 iddDetected 会假阴性）。
    let adapters = (hwCache && Array.isArray(hwCache.displayAdapters) && hwCache.displayAdapters.length)
      ? hwCache.displayAdapters
      : [];
    if (adapters.length === 0) {
      try {
        const fresh = await hardware.detect({ diskProbePath: PATHS.outputDir });
        if (fresh) {
          hwCache = hwCache || fresh;
          adapters = Array.isArray(fresh.displayAdapters) ? fresh.displayAdapters : [];
        }
      } catch { /* 探测失败不阻断诊断，退化为通用文案 */ }
    }
    if (adapters.length === 0 && hwCache && hwCache.gpu) adapters = [hwCache.gpu];
    const diag = renderCompat.buildRenderFailureDiagnosis({
      elapsedMs: Date.now() - renderStart,
      watchdogMs,
      versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
      gpuFlagsEnv: process.env.HXSK_GPU_FLAGS || '',
      adapters,
      logsDir: PATHS.logsDir
    });
    const logPath = path.join(PATHS.logsDir, 'render-failure.json');
    try {
      fs.mkdirSync(PATHS.logsDir, { recursive: true });
      fs.writeFileSync(logPath, JSON.stringify(diag, null, 2), 'utf8');
    } catch { /* 写日志失败不阻断提示 */ }
    // 冒烟测试模式：不弹阻塞式对话框（否则无头自动化会卡住），仅靠日志与退出码
    if (process.env.HXSK_SMOKE_TEST === '1') return;
    dialog.showErrorBox('幻想时刻 · 界面未能渲染', renderCompat.formatDialogText(diag, logPath));
  }, watchdogMs);

  // 外链一律交给系统浏览器，不在应用内打开，避免钓鱼与任意导航
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    const allowed = url.startsWith('file://') || url.startsWith('http://localhost');
    if (!allowed) e.preventDefault();
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

/* ============ IPC 白名单 ============ */

function registerIpc() {
  // 应用信息
  ipcMain.handle('app:info', () => ({
    name: pkg.productName,
    version: pkg.version,
    displayVersion: pkg.displayVersion,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    platform: process.platform,
    arch: process.arch,
    isPackaged: app.isPackaged,
    ffmpeg: ffmpegMod.resolveFfmpegPath(),
    userData: PATHS.userData,
    outputDir: PATHS.outputDir
  }));

  // 硬件探测（带缓存，避免每次都跑 nvidia-smi）
  // 注意：ipcMain.handle 的第一个入参是 event，force 是第二个 —— 此前误写成 (force)
  // 会让 force 实际拿到 event 对象，force===true 永远不成立，导致强制刷新失效。
  ipcMain.handle('hardware:detect', async (_e, force) => {
    if (!hwCache || force === true) hwCache = await hardware.detect({ diskProbePath: PATHS.outputDir });
    return hwCache;
  });

  // 模型能力库
  ipcMain.handle('catalog:get', () => {
    const cat = currentCatalog();
    return { models: cat.models, intents: cat.intents, schemaVersion: cat.schemaVersion, facts: cat.facts };
  });
  ipcMain.handle('catalog:refresh', async () => {
    const r = await catalogMod.refresh({ paths: PATHS });
    if (r.updated) { cachedCatalog = r.catalog; orchestrator.catalog = r.catalog; }
    return { updated: r.updated, source: r.source, message: r.message };
  });

  // 本地模型（B 轨）：列出 + 安装状态 + 硬件就绪评估
  ipcMain.handle('local:list', () => {
    const cat = currentCatalog();
    const hw = hwCache || null;
    return cat.models.filter(m => m.track === 'local').map(m => ({
      id: m.id,
      name: m.name,
      license: m.license,
      notes: m.notes,
      warning: m.warning || null,
      vramGB: m.vramGB,
      ramGB: m.ramGB,
      downloadGB: m.downloadGB,
      resolution: m.resolution,
      maxDurationSec: m.maxDurationSec,
      installed: runtimeMod.isModelInstalled(m, PATHS),
      readiness: hw ? hardware.assessLocalReadiness(hw, m, 20) : null
    }));
  });

  // 安装计划预检（不下载）：返回体积、来源、磁盘/显存是否够
  ipcMain.handle('local:plan', (_e, modelId) => {
    const model = currentCatalog().models.find(m => m.id === modelId);
    if (!model) return { ok: false, error: `未知本地模型: ${modelId}` };
    const plan = runtimeMod.buildInstallPlan({ model, paths: PATHS, hardware: hwCache });
    return {
      ok: true,
      modelId: plan.modelId,
      modelName: plan.modelName,
      totalDownloadGB: plan.totalDownloadGB,
      requiredDiskGB: plan.requiredDiskGB,
      readiness: plan.readiness,
      warning: plan.warning,
      itemCount: plan.items.length
    };
  });

  // 执行安装：下载 Python 运行时 + torch + 权重（约 9GB，耗时较长），进度经事件推送
  ipcMain.handle('local:install', async (_e, modelId) => {
    const model = currentCatalog().models.find(m => m.id === modelId);
    if (!model) return { ok: false, error: `未知本地模型: ${modelId}` };
    if (!hwCache) hwCache = await hardware.detect({ diskProbePath: PATHS.outputDir }).catch(() => null);
    const plan = runtimeMod.buildInstallPlan({ model, paths: PATHS, hardware: hwCache });
    return await runtimeMod.runInstallPlan({
      plan,
      paths: PATHS,
      onProgress: (p) => sendToRenderer('local:progress', { modelId, ...p })
    });
  });

  // 本地轨道自检：环境探针 + dry-run 链路，如实报告"哪些就绪、还差什么"
  // 不需 GPU/权重即可验证 Provider↔Python 协议链路；真实 GPU 出片就绪与否单独判定
  ipcMain.handle('local:selfcheck', async (_e, modelId) => {
    const localProvider = providers.get('local');
    if (!localProvider) return { ok: false, error: '本地 Provider 未初始化' };
    const pythonPath = localProvider._resolvePython();
    if (!pythonPath) {
      return {
        ok: false,
        summary: '未找到可用的 Python 运行时',
        problems: ['未找到 Python 运行时：请先在「本地模型」页下载并安装运行时'],
        warnings: [], gpuReady: false, dryRunReady: false, dryRunOk: false,
        env: null, dryRun: null
      };
    }
    const model = modelId ? currentCatalog().models.find(m => m.id === modelId) : null;
    const result = await selfCheckMod.runLocalSelfCheck({
      paths: PATHS,
      pythonPath,
      LocalProvider: localProvider.constructor,
      model: model || null
    });
    return { ok: true, pythonPath, ...result };
  });

  // 路由预演（不真正生成）
  ipcMain.handle('route:preview', (_e, req) => orchestrator.preview(normalizeReq(req)));

  // 生成
  ipcMain.handle('generate:submit', (_e, req) => {
    syncWorkspace(); // 每次生成前同步最新的地域端点配置
    orchestrator.catalog = currentCatalog();
    return orchestrator.submit(normalizeReq(req));
  });
  ipcMain.handle('generate:cancel', (_e, taskId) => orchestrator.cancel(taskId));
  ipcMain.handle('generate:task', (_e, taskId) => orchestrator.getTask(taskId));

  // 图片选择：只允许图片类型，返回主进程内的绝对路径（不把文件内容传给渲染层）
  ipcMain.handle('dialog:pickImage', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '选择图片',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] }]
    });
    if (r.canceled || r.filePaths.length === 0) return null;
    return r.filePaths[0];
  });

  // 密钥管理（渲染层永远拿不到明文，只能设置/清除/查是否已配置）
  ipcMain.handle('secret:list', () => secretStore.listConfiguredKinds());
  ipcMain.handle('secret:set', (_e, kind, value) => secretStore.setKey(kind, value));
  ipcMain.handle('secret:clear', (_e, kind) => secretStore.clearKey(kind));

  // 各云端通道的申请引导（去哪弄 Key、免费额度、是否本机可达）——只读展示信息，不含密钥
  ipcMain.handle('secret:providers', () => {
    const configured = secretStore.listConfiguredKinds().configured || {};
    return SECRET_KINDS.map(kind => {
      const meta = getProviderMeta(kind) || {};
      return {
        kind,
        label: meta.label || kind,
        keyName: meta.keyName || null,
        applyUrl: meta.applyUrl || null,
        linkVerified: meta.verified === true,
        reachableRegion: meta.reachableRegion || 'unknown',
        freeQuota: meta.freeQuota || null,
        note: meta.note || null,
        configured: Boolean(configured[kind])
      };
    });
  });

  // 打开某通道的 Key 申请页：只打开代码内固定的官方 URL，绝不接受渲染层传入的任意地址（防钓鱼）
  ipcMain.handle('secret:openKeyPage', (_e, kind) => {
    const url = getKeyApplyUrl(kind);
    if (!url) return { ok: false, error: `未知通道或缺少官方链接: ${kind}` };
    shell.openExternal(url);
    return { ok: true, url };
  });

  // 配置
  ipcMain.handle('config:get', () => secretStore.loadConfig());
  ipcMain.handle('config:set', (_e, patch) => secretStore.saveConfig(patch));

  // 更新
  ipcMain.handle('update:check', (_e, opts) => updateManager.check(opts || {}));
  ipcMain.handle('update:download', async () => {
    // 用上次 check 缓存的 release 继续下载
    const rel = updateManager.lastResult && updateManager.lastResult.release;
    if (!rel) return { ok: false, message: '请先检查更新' };
    return updateManager.download(rel);
  });
  ipcMain.handle('update:install', () => updateManager.install());
  ipcMain.handle('update:openManual', () => { shell.openExternal(updateManager.getManualDownloadUrl()); return true; });
  ipcMain.handle('update:rollbackStatus', () => updateManager.checkRollbackOnStartup());

  // 打开输出目录 / 在文件管理器中显示视频
  ipcMain.handle('shell:showOutputDir', () => { shell.openPath(PATHS.outputDir); return true; });
  ipcMain.handle('shell:showItem', (_e, p) => { if (p && fs.existsSync(p)) shell.showItemInFolder(p); return true; });
}

/** 规范化来自渲染层的生成请求，只接受白名单字段，防止任意字段注入 */
function normalizeReq(req = {}) {
  const allowStr = ['prompt', 'imagePath', 'lastFramePath', 'audioPath', 'videoPath', 'ratio', 'resolution', 'imageSize', 'negativePrompt', 'forceModelId'];
  const out = {};
  for (const k of allowStr) {
    if (typeof req[k] === 'string') out[k] = req[k];
  }
  if (typeof req.durationSec === 'number' && req.durationSec > 0) out.durationSec = req.durationSec;
  if (typeof req.offlineOnly === 'boolean') out.offlineOnly = req.offlineOnly;
  if (Array.isArray(req.referenceImages)) out.referenceImages = req.referenceImages.filter(x => typeof x === 'string');
  if (Array.isArray(req.segments)) out.segments = req.segments.filter(x => typeof x === 'string');
  return out;
}

/* ============ 生命周期 ============ */

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(async () => {
  initRuntime();
  registerIpc();
  createWindow();

  // 冒烟测试钩子：无界面环境真实启动窗口并验证安全基线与 IPC，结果写文件后退出
  if (process.env.HXSK_SMOKE_TEST === '1') {
    await runSmokeTest().catch(err => {
      const out = { ok: false, error: String(err.message || err) };
      try { fs.writeFileSync(process.env.HXSK_SMOKE_OUT || 'smoke-result.json', JSON.stringify(out, null, 2)); } catch { /* ignore */ }
      app.exit(1);
    });
    return;
  }

  // 后台预热硬件探测，不阻塞窗口显示
  hardware.detect({ diskProbePath: PATHS.outputDir }).then(hw => { hwCache = hw; sendToRenderer('hardware:ready', hw); }).catch(() => {});

  // 启动时若上次升级未完成，提示用户
  const rb = updateManager.checkRollbackOnStartup();
  if (rb.needed) sendToRenderer('update:rollback', rb);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

/**
 * 冒烟测试：真实加载窗口，验证安全基线与核心 IPC 可用
 * 结果写入 HXSK_SMOKE_OUT 指定的 JSON 文件，供 CI/自检读取
 */
async function runSmokeTest() {
  const results = { ok: true, checks: [] };
  const record = (name, pass, detail) => { results.checks.push({ name, pass, detail: detail || null }); if (!pass) results.ok = false; };

  await new Promise(resolve => {
    if (mainWindow.webContents.isLoading()) mainWindow.webContents.once('did-finish-load', resolve);
    else resolve();
  });

  // 1. 窗口已创建且标题正确
  record('window-created', mainWindow !== null && !mainWindow.isDestroyed());
  record('window-title', String(mainWindow.getTitle()).includes('幻想时刻'), mainWindow.getTitle());

  // 2. 安全基线：渲染层触达不到 node 全局
  const sandbox = await mainWindow.webContents.executeJavaScript(`
    (function () {
      return {
        hasRequire: typeof window.require !== 'undefined',
        hasProcess: typeof window.process !== 'undefined',
        hasBridge: typeof window.hxsk !== 'undefined' && typeof window.hxsk.getAppInfo === 'function',
        csp: (document.querySelector('meta[http-equiv="Content-Security-Policy"]') || {}).content || null
      };
    })()
  `);
  record('no-require-in-renderer', sandbox.hasRequire === false);
  record('no-process-in-renderer', sandbox.hasProcess === false);
  record('preload-bridge-exposed', sandbox.hasBridge === true);

  // 3. 核心 IPC：app:info 返回版本与路径
  const info = await mainWindow.webContents.executeJavaScript('window.hxsk.getAppInfo()');
  record('ipc-app-info', Boolean(info && info.version && info.outputDir), info && info.version);

  // 4. 路由预演：无 Key 时应落到自检模式（mock）
  const preview = await mainWindow.webContents.executeJavaScript(
    'window.hxsk.previewRoute({ prompt: "一只猫在草地上奔跑" })'
  );
  record('route-preview-works', Boolean(preview && preview.selected), preview && preview.selected && preview.selected.id);
  record('route-falls-back-to-mock', Boolean(preview && preview.selected && preview.selected.track === 'mock'), preview && preview.selected && preview.selected.track);

  // 5. 密钥接口：列表只回布尔，不回明文
  const secrets = await mainWindow.webContents.executeJavaScript('window.hxsk.listSecrets()');
  record('secret-list-no-plaintext', Boolean(secrets && secrets.configured), secrets && typeof secrets.configured.dashscope);

  // 6. 硬件探测（真实跑 nvidia-smi）
  const hw = await mainWindow.webContents.executeJavaScript('window.hxsk.detectHardware(true)');
  record('hardware-detect', Boolean(hw && typeof hw.vramGB === 'number'), hw && `${hw.gpu || 'n/a'} vram=${hw.vramGB}`);

  const outPath = process.env.HXSK_SMOKE_OUT || 'smoke-result.json';
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2), 'utf8');
  // 给主进程一点时间落盘，再退出
  setTimeout(() => app.exit(results.ok ? 0 : 2), 300);
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
