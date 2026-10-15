#!/usr/bin/env node
/**
 * GUI 自检：真实启动窗口，验证界面、安全沙箱与核心链路，结果打印并写入 smoke-result.json
 *
 * 用法：npm run smoke
 * 适用场景：在正常的交互式桌面会话下运行（远程/无桌面会话的环境可能无法呈现窗口，
 * 属环境限制而非软件缺陷；无头逻辑链路已由 node --test 全量覆盖）。
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const out = join(root, 'smoke-result.json');
if (existsSync(out)) rmSync(out, { force: true });

const electron = process.platform === 'win32'
  ? join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
  : join(root, 'node_modules', 'electron', 'dist', 'electron');

const r = spawnSync(electron, ['.'], {
  cwd: root,
  env: { ...process.env, HXSK_SMOKE_TEST: '1', HXSK_SMOKE_OUT: out },
  stdio: 'inherit',
  timeout: 120000
});

if (existsSync(out)) {
  const res = JSON.parse(readFileSync(out, 'utf8'));
  console.log('\n=== GUI SMOKE RESULT ===');
  for (const c of res.checks) {
    console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? '  (' + c.detail + ')' : ''}`);
  }
  console.log(res.ok ? '\n全部通过。' : '\n存在失败项，见上。');
  process.exit(res.ok ? 0 : 2);
} else {
  console.error('未生成 smoke-result.json：窗口可能未能在当前会话呈现（远程/无桌面会话环境的已知限制）。');
  console.error('逻辑链路请用 npm test 验证（无头、全量、真实断言）。');
  process.exit(r.status == null ? 3 : r.status);
}
