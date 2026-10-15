#!/usr/bin/env node
/**
 * 版本号递进脚本 —— 实现用户指定的十进制进位规则
 *
 *   node scripts/bump-version.mjs          # 1.0 -> 1.1，1.9 -> 2.0
 *   node scripts/bump-version.mjs --dry    # 只打印，不写文件
 *   node scripts/bump-version.mjs --set 2.0 # 直接指定版本
 *
 * 同步更新 package.json 的 version(三段 semver) 与 displayVersion(两段)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const core = require('../src/main/version-core.js');

const here = dirname(fileURLToPath(import.meta.url));
const pkgPath = join(here, '..', 'package.json');

function main() {
  const argv = process.argv.slice(2);
  const dry = argv.includes('--dry');
  const setIdx = argv.indexOf('--set');

  const raw = readFileSync(pkgPath, 'utf8');
  const pkg = JSON.parse(raw);
  const current = pkg.displayVersion || core.formatDisplay(core.parseVersion(pkg.version));

  let next;
  if (setIdx !== -1 && argv[setIdx + 1]) {
    next = core.parseVersion(argv[setIdx + 1]);
    next.patch = 0;
  } else {
    next = core.bumpDecimal(current);
  }

  const nextDisplay = core.formatDisplay(next);
  const nextSemver = core.formatSemver(next);

  console.log(`当前版本: ${current}`);
  console.log(`新版本  : ${nextDisplay}  (package.json version = ${nextSemver})`);

  if (nextDisplay === current) {
    console.log('版本未变化，跳过写入。');
    return;
  }
  if (dry) {
    console.log('[--dry] 未写入文件。');
    return;
  }

  pkg.version = nextSemver;
  pkg.displayVersion = nextDisplay;
  // 保留原文件的缩进风格与末尾换行
  const indent = raw.match(/\n(\s+)"/) ? raw.match(/\n(\s+)"/)[1].length : 2;
  const hadTrailingNewline = raw.endsWith('\n');
  const out = JSON.stringify(pkg, null, indent) + (hadTrailingNewline ? '\n' : '');
  writeFileSync(pkgPath, out, 'utf8');
  console.log(`已写入 ${pkgPath}`);
  console.log(`下一步：npm run dist 打包，然后 gh release create v${nextDisplay} 上传安装包`);
}

main();
