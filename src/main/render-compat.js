'use strict';

/**
 * 渲染兼容诊断（纯逻辑，可无头测试）
 *
 * 用途：把"页面迟迟未提交渲染"这一现象，转成可读的根因诊断与处置建议。
 * 根因依据：electron#54552 —— IDD 虚拟显示适配器（ToDesk/MuMu/GameViewer 等）
 *   在设备总线上枚举于真实 GPU 之前，Chromium CollectDriverInfoD3D() 选错适配器，
 *   导致 GPU 进程 STATUS_BREAKPOINT(0x80000003) 崩溃，页面永不提交。
 */

/** 默认看门狗超时（ms）：正常渲染远快于此，超时基本可判定为环境问题 */
const DEFAULT_WATCHDOG_MS = 20000;

/** 默认注入的图形兼容开关（尽力而为，不保证修复；UseAngle 是 Windows 渲染必需，绝不禁用） */
const COMPAT_GPU_SWITCHES = [
  ['disable-features', 'Vulkan'],
  ['enable-unsafe-swiftshader', null]
];

/** 已知的 IDD 虚拟显示适配器名称特征（用于诊断提示，不作强制判定） */
const IDD_ADAPTER_HINTS = ['todesk', 'mumu', 'gameviewer', 'sunlogin', '向日葵', 'virtual display', 'indirect display', 'idd'];

/**
 * 解析用户通过 HXSK_GPU_FLAGS 环境变量传入的自定义开关
 * 支持格式："a=b;c=" 或 "a=b,c="（值为空表示纯 flag）
 * @returns {Array<[string, string|undefined]>}
 */
function parseGpuFlagsEnv(envValue) {
  if (!envValue || typeof envValue !== 'string') return [];
  const out = [];
  for (const pair of envValue.split(/[;,]/)) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) out.push([trimmed, undefined]);
    else out.push([trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1).trim()]);
  }
  return out.filter(([k]) => k.length > 0);
}

/**
 * 汇总所有应注入的命令行开关（默认兼容开关 + 环境变量自定义）
 * @returns {Array<{name:string, value:string|undefined, source:'default'|'env'}>}
 */
function collectGpuSwitches(envValue) {
  const list = COMPAT_GPU_SWITCHES.map(([name, value]) => ({ name, value: value === null ? undefined : value, source: 'default' }));
  for (const [name, value] of parseGpuFlagsEnv(envValue)) {
    list.push({ name, value, source: 'env' });
  }
  return list;
}

/**
 * 检测已枚举的显示适配器里是否疑似存在 IDD 虚拟适配器
 * @param {string[]} adapterNames 例如 WMI Win32_VideoController.Name 列表
 * @returns {{suspicious:boolean, matched:string[]}}
 */
function detectIddAdapters(adapterNames) {
  const names = Array.isArray(adapterNames) ? adapterNames : [];
  const matched = [];
  for (const n of names) {
    const lower = String(n || '').toLowerCase();
    if (IDD_ADAPTER_HINTS.some(h => lower.includes(h))) matched.push(String(n));
  }
  return { suspicious: matched.length > 0, matched };
}

/**
 * 构造渲染失败诊断对象（写日志 + 展示给用户）
 * @param {object} params
 * @param {number} params.elapsedMs 从开始加载到判定失败的耗时
 * @param {number} [params.watchdogMs]
 * @param {object} [params.versions] { electron, chrome, node }
 * @param {string} [params.gpuFlagsEnv] HXSK_GPU_FLAGS 原值
 * @param {string[]} [params.adapters] 显示适配器名列表
 * @param {string} [params.logsDir]
 */
function buildRenderFailureDiagnosis(params = {}) {
  const {
    elapsedMs = 0,
    watchdogMs = DEFAULT_WATCHDOG_MS,
    versions = {},
    gpuFlagsEnv = '',
    adapters = [],
    logsDir = ''
  } = params;

  const idd = detectIddAdapters(adapters);
  const suggestions = [
    '在物理显示器的本地会话中运行本软件（而非远程桌面 / 模拟器会话）',
    '或在「设备管理器 → 显示适配器」中临时禁用 ToDesk / MuMu / GameViewer 等虚拟显示适配器后重试',
    '或设置环境变量 HXSK_GPU_FLAGS 追加图形开关后再试（不保证生效）'
  ];

  return {
    problem: `窗口页面未能在 ${watchdogMs}ms 内完成渲染（did-finish-load 未触发）`,
    elapsedMs,
    likelyCause: idd.suspicious
      ? `检测到疑似虚拟显示适配器（${idd.matched.join('、')}）：IDD 驱动会让 Chromium 选错显示适配器，GPU 进程断言崩溃（electron#54552）`
      : '最可能是虚拟显示适配器（IDD，如 ToDesk/MuMu/GameViewer）或远程会话导致 Chromium GPU 进程断言崩溃（electron#54552）；也可能是显卡驱动异常',
    iddDetected: idd.suspicious,
    iddAdapters: idd.matched,
    suggestions,
    reference: 'https://github.com/electron/electron/issues/54552',
    env: {
      platform: process.platform,
      arch: process.arch,
      electron: versions.electron || null,
      chrome: versions.chrome || null,
      node: versions.node || process.versions.node,
      gpuFlags: gpuFlagsEnv || '(默认)'
    },
    logsDir: logsDir || null,
    at: new Date().toISOString()
  };
}

/**
 * 把诊断对象渲染成给用户看的对话框文本
 */
function formatDialogText(diag, logPath) {
  return (
    '窗口页面未能在预期时间内完成渲染。\n\n' +
    '最可能原因：当前是远程桌面 / 模拟器会话，其虚拟显示适配器（ToDesk / MuMu / GameViewer 等）与 Chromium 冲突。\n\n' +
    '建议：\n' +
    '1) 在物理显示器的本地会话中运行本软件；\n' +
    '2) 或在设备管理器中临时禁用上述虚拟显示适配器后重试；\n' +
    '3) 或设置环境变量 HXSK_GPU_FLAGS 追加图形开关后再试（不保证生效）。\n\n' +
    (logPath ? '详细诊断已写入：' + logPath : '')
  );
}

module.exports = {
  DEFAULT_WATCHDOG_MS,
  COMPAT_GPU_SWITCHES,
  IDD_ADAPTER_HINTS,
  parseGpuFlagsEnv,
  collectGpuSwitches,
  detectIddAdapters,
  buildRenderFailureDiagnosis,
  formatDialogText
};
