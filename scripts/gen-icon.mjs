#!/usr/bin/env node
/**
 * 把 build/ico-stages 下的多尺寸 PNG 打包成 build/icon.ico
 * 使用纯 JS 的 png-to-ico（不依赖 sharp 等原生二进制，规避当前网络的下载风险）
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pngToIco from 'png-to-ico';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const stagesDir = join(root, 'build', 'ico-stages');
const out = join(root, 'build', 'icon.ico');

const sizes = [256, 128, 64, 48, 32, 24, 16];
const inputs = [];
for (const s of sizes) {
  const p = join(stagesDir, `icon-${s}.png`);
  if (!existsSync(p)) {
    console.error(`缺少 ${p}，请先运行 scripts/prepare-icon.ps1`);
    process.exit(1);
  }
  inputs.push(p);
}

const buf = await pngToIco(inputs);
writeFileSync(out, buf);
console.log(`已生成 ${out}（${(buf.length / 1024).toFixed(1)} KB，含 ${sizes.join('/')} 尺寸）`);
