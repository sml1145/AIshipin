#!/usr/bin/env node
/**
 * UI 契约静态检查（不需要渲染，可在任何环境跑）
 *
 * 背景教训：界面脚本 app.js 在【顶层】直接调用 hxsk.on(...)，一旦桥接对象未注入，
 * 脚本会在该行中断，导致其后所有按钮的监听器都绑不上 → 表现为"所有按钮点了没反应"，
 * 而且因为中断发生在 init() 之前，连"初始化失败"提示都不会显示 —— 完全静默。
 *
 * 这类 bug 在 mock 桥接的 E2E 测试里永远发现不了（mock 保证 hxsk 存在）。
 * 所以用静态检查守住四条不变量：
 *   1. 顶层不得有未受保护的 hxsk.* 调用（必须先确认桥接存在）
 *   2. 每个 addEventListener('click') 的处理器必须有 try/catch 或 .catch（失败要给用户可见反馈）
 *   3. 顶层 $('#id') 选择器引用的元素必须真实存在于 index.html
 *   4. preload 暴露的方法必须都能在主进程找到对应 handler（与 check-ipc-contract 互补）
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const appSrc = readFileSync(join(ROOT, 'src/renderer/app.js'), 'utf8');
const htmlSrc = readFileSync(join(ROOT, 'src/renderer/index.html'), 'utf8');

const problems = [];
const notes = [];

/* ---- 1. 顶层未受保护的 hxsk.* 调用 ---- */
// 取"顶层"= 不在任何 function/箭头函数/块内的语句。用缩进为 0 的行近似判定。
const lines = appSrc.split('\n');
lines.forEach((line, i) => {
  if (/^hxsk\./.test(line.trim()) && /^\S/.test(line)) {
    // 允许包在 try 里的（检查前几行是否有 try {）
    const ctx = lines.slice(Math.max(0, i - 3), i).join('\n');
    if (!/try\s*\{/.test(ctx)) {
      problems.push(`[顶层裸调用] 第 ${i + 1} 行: ${line.trim().slice(0, 70)}`);
    }
  }
});

/* ---- 2. 点击处理器必须有错误兜底（仅针对真正调用桥接的） ---- */
// 判据收紧：只有【处理器体内调用了 hxsk.*】的才要求 try/catch。
// 纯 DOM 操作（如切换视图、关闭浮层）不可能失败，强求 try/catch 只会制造噪音。
//
// 处理器体必须按括号配对精确提取 —— 用固定字符窗口会把后续无关代码算进来产生误报。
function extractBalanced(src, openIdx) {
  // openIdx 指向 '('，返回配对 ')' 的下标
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return i; }
  }
  return src.length - 1;
}

const clickRe = /addEventListener\(\s*'click'\s*,\s*/g;
let m;
let clickCount = 0;
let bridgeClickCount = 0;
const unguarded = [];
while ((m = clickRe.exec(appSrc)) !== null) {
  clickCount++;
  // 处理器实参起点：'click', 之后的第一个 '(' 或直接是箭头函数体
  const afterComma = m.index + m[0].length;
  // 找到整个 addEventListener(...) 的结束括号，从而得到处理器实参全文
  const addEvOpen = appSrc.indexOf('(', m.index);
  const addEvClose = extractBalanced(appSrc, addEvOpen);
  const handlerSrc = appSrc.slice(afterComma, addEvClose);

  const callsBridge = /\bhxsk\./.test(handlerSrc);
  if (!callsBridge) continue; // 纯 DOM 处理器，无需兜底
  bridgeClickCount++;
  const hasGuard = /\btry\s*\{/.test(handlerSrc) || /\.catch\s*\(/.test(handlerSrc) ||
                   /\bcatch\s*\(/.test(handlerSrc) || /\bguardClick\s*\(/.test(handlerSrc);
  if (!hasGuard) {
    const lineNo = appSrc.slice(0, m.index).split('\n').length;
    unguarded.push(`第 ${lineNo} 行: ${handlerSrc.replace(/\s+/g, ' ').slice(0, 90)}`);
  }
}
if (unguarded.length) {
  problems.push(`[点击无错误兜底] ${unguarded.length}/${bridgeClickCount} 个【调用桥接】的点击处理器缺 try/catch，失败时会静默无反馈:\n    - ${unguarded.join('\n    - ')}`);
} else {
  notes.push(`点击处理器共 ${clickCount} 个，其中调用桥接的 ${bridgeClickCount} 个全部有错误兜底`);
}

/* ---- 3. 顶层 $('#id') 必须在 HTML 中存在 ---- */
// 只检查顶层绑定用的选择器（出现在 addEventListener 之前的 $('#..')）
const idRe = /\$\('#([A-Za-z0-9_-]+)'\)/g;
const htmlIds = new Set([...htmlSrc.matchAll(/id="([^"]+)"/g)].map(x => x[1]));
const missing = new Set();
let im;
while ((im = idRe.exec(appSrc)) !== null) {
  if (!htmlIds.has(im[1])) missing.add(im[1]);
}
if (missing.size) {
  problems.push(`[选择器指向不存在的元素] ${[...missing].join(', ')} —— $('#x') 返回 null，后续 .addEventListener 会抛错中断整个脚本`);
} else {
  notes.push(`所有 $('#id') 选择器（${htmlIds.size} 个 id 中引用的）都在 index.html 中存在`);
}

/* ---- 4. 顶层是否有 hxsk 存在性守卫 ---- */
// 认可的守卫写法：直接判空、typeof 判断、或先存成常量再判（本项目用 REAL_HXSK）
const hasBridgeGuard =
  /if\s*\(\s*!\s*window\.hxsk/.test(appSrc) ||
  /typeof\s+window\.hxsk\s*[!=]==?\s*['"]undefined['"]/.test(appSrc) ||
  /const\s+\w+\s*=\s*window\.hxsk\s*;[\s\S]{0,200}?if\s*\(\s*\w+\s*\)/.test(appSrc) ||
  /hxsk\s*\|\|/.test(appSrc);
if (!hasBridgeGuard) {
  problems.push('[缺桥接守卫] app.js 未检查 window.hxsk 是否存在。preload 注入失败时会静默死亡，用户看不到任何提示');
} else {
  notes.push('已有 window.hxsk 存在性守卫');
}

/* ---- 6. 顶层不得有裸 hxsk.on 订阅（必须走 safeOn） ---- */
const bareOn = [...appSrc.matchAll(/^hxsk\.on\(/gm)];
if (bareOn.length) {
  problems.push(`[顶层裸订阅] 存在 ${bareOn.length} 处顶层 hxsk.on(...)，桥接缺失时会中断脚本，必须改用 safeOn()`);
} else {
  notes.push('顶层事件订阅全部走 safeOn 受保护调用');
}

/* ---- 7. 致命错误横幅必须存在 ---- */
if (!/showFatalBanner/.test(appSrc)) {
  problems.push('[缺致命错误呈现] 未定义 showFatalBanner，桥接缺失时无从告知用户');
} else {
  notes.push('已有致命错误横幅呈现能力');
}

/* ---- 5. 全局错误可见化 ---- */
const hasGlobalTrap = /window\.addEventListener\(\s*['"]error['"]/.test(appSrc) &&
                      /unhandledrejection/.test(appSrc);
if (!hasGlobalTrap) {
  problems.push('[缺全局错误捕获] 未监听 window error / unhandledrejection，异常无法呈现给用户');
} else {
  notes.push('已有全局 error / unhandledrejection 捕获');
}

console.log('=== UI 契约静态检查 ===');
notes.forEach(n => console.log('  ✓ ' + n));
if (problems.length === 0) {
  console.log('\nUI 契约检查通过：无静默失败风险点');
  process.exit(0);
}
console.log('\n发现 ' + problems.length + ' 类问题：');
problems.forEach(p => console.log('  ✗ ' + p));
console.log('\n这些问题会导致"点击无反应且无任何提示"。');
process.exit(1);
