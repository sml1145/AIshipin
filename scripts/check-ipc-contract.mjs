#!/usr/bin/env node
/**
 * IPC 契约检查：渲染层调用的每个 window.hxsk.* 方法，
 * 必须都在 preload 的白名单里声明；反之 preload 暴露的方法也应在界面被用到（提示未用项）。
 *
 * 为什么需要：preload 用 contextBridge 白名单暴露方法，若界面调用了未暴露的名字，
 * 运行时会静默 undefined 再抛错，排查成本高。本脚本在构建前静态拦住这类错配。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const preloadSrc = readFileSync(join(root, 'src', 'preload', 'index.js'), 'utf8');
const appSrc = readFileSync(join(root, 'src', 'renderer', 'app.js'), 'utf8');

// preload 中 api 对象的顶层键（形如 "  getAppInfo: () => ..."）
const exposed = new Set();
for (const m of preloadSrc.matchAll(/^\s{2}([A-Za-z]\w*)\s*:\s*\(?/gm)) exposed.add(m[1]);

// 渲染层实际调用的方法（含 window.hxsk.x 与解构后的 hxsk.x）
const used = new Set();
for (const m of appSrc.matchAll(/\bhxsk\.([A-Za-z]\w*)/g)) used.add(m[1]);

const missing = [...used].filter(u => !exposed.has(u));
const unused = [...exposed].filter(e => !used.has(e));

console.log(`preload 暴露方法 ${exposed.size} 个：${[...exposed].join(', ')}`);
console.log(`渲染层调用方法 ${used.size} 个：${[...used].join(', ')}`);

let failed = false;
if (missing.length) {
  console.error(`\n✗ 渲染层调用了 preload 未暴露的方法（运行时会 undefined）：${missing.join(', ')}`);
  failed = true;
} else {
  console.log('\n✓ 渲染层调用的方法全部在 preload 白名单内');
}
if (unused.length) {
  console.log(`⚠ preload 暴露但界面未使用（可能是预留接口）：${unused.join(', ')}`);
}

// 额外校验：preload 里 invoke 的 channel 必须都在主进程注册过
const mainSrc = readFileSync(join(root, 'src', 'main', 'index.js'), 'utf8');
const invoked = new Set();
for (const m of preloadSrc.matchAll(/ipcRenderer\.invoke\('([\w:]+)'/g)) invoked.add(m[1]);
const handled = new Set();
for (const m of mainSrc.matchAll(/ipcMain\.handle\('([\w:]+)'/g)) handled.add(m[1]);
const noHandler = [...invoked].filter(c => !handled.has(c));
if (noHandler.length) {
  console.error(`✗ preload 调用了主进程未注册的 channel：${noHandler.join(', ')}`);
  failed = true;
} else {
  console.log(`✓ preload 调用的 ${invoked.size} 个 channel 全部已在主进程注册`);
}
const deadHandlers = [...handled].filter(c => !invoked.has(c));
if (deadHandlers.length) console.log(`⚠ 主进程注册但 preload 未调用的 channel：${deadHandlers.join(', ')}`);

// 事件通道：preload 白名单 vs 主进程 send
const allowEvents = [...preloadSrc.matchAll(/ALLOWED_EVENTS\s*=\s*\[([^\]]+)\]/gs)];
const eventsInPreload = allowEvents.length
  ? [...allowEvents[0][1].matchAll(/'([\w:]+)'/g)].map(m => m[1])
  : [];
const sentEvents = new Set();
for (const m of mainSrc.matchAll(/sendToRenderer\('([\w:]+)'/g)) sentEvents.add(m[1]);
const unsubscribable = [...sentEvents].filter(e => !eventsInPreload.includes(e));
if (unsubscribable.length) {
  console.error(`✗ 主进程推送了渲染层无法订阅的事件（不在 ALLOWED_EVENTS）：${unsubscribable.join(', ')}`);
  failed = true;
} else {
  console.log(`✓ 主进程推送的 ${sentEvents.size} 个事件均可被渲染层订阅`);
}

process.exit(failed ? 1 : 0);
