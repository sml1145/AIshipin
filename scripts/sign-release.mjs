#!/usr/bin/env node
/**
 * 发布前对 latest.yml 做 Ed25519 签名，产出 latest.yml.sig
 *
 * 安全设计：
 *   - 私钥路径从环境变量 HXSK_SIGNING_KEY 读取，绝不硬编码在仓库里
 *   - 私钥必须存放在仓库之外（本项目约定：<项目同级>/HuanXiangShiKe-signing/update-private.pem）
 *   - 私钥缺失或签名失败一律报错退出（非零码），绝不静默跳过——
 *     否则会出现"发布了未签名的 Release"，客户端因 fail-closed 拒绝更新
 *   - 公钥可公开（已内置于 src/main/update-pubkey.js），只有私钥需要保密
 *
 * 用法：
 *   npm run sign        # 使用默认私钥路径约定
 *   HXSK_SIGNING_KEY=D:\keys\update-private.pem npm run sign
 *   node scripts/sign-release.mjs --check   # 只校验现有签名是否有效，不重新签名
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { signManifest, verifyManifest, normalizeManifest } = require('../src/main/update-verify.js');
const { UPDATE_MANIFEST_PUBLIC_KEY, MANIFEST_SIGNATURE_FILENAME } = require('../src/main/update-pubkey.js');

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const releaseDir = join(root, 'release');
const manifestPath = join(releaseDir, 'latest.yml');
const sigPath = join(releaseDir, MANIFEST_SIGNATURE_FILENAME);

/** 约定的私钥位置：项目同级目录，在 .git 管辖范围之外 */
const DEFAULT_KEY_PATH = join(root, '..', 'HuanXiangShiKe-signing', 'update-private.pem');

function resolveKeyPath() {
  const fromEnv = process.env.HXSK_SIGNING_KEY;
  const candidate = fromEnv ? resolve(fromEnv) : DEFAULT_KEY_PATH;
  return { path: candidate, fromEnv: Boolean(fromEnv) };
}

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

const checkOnly = process.argv.includes('--check');

if (!existsSync(manifestPath)) {
  fail(`未找到 ${manifestPath}，请先运行 npm run dist 生成 latest.yml`);
}

const rawYml = readFileSync(manifestPath, 'utf8');
const normalized = normalizeManifest(rawYml);

if (checkOnly) {
  if (!existsSync(sigPath)) fail(`缺少签名文件 ${MANIFEST_SIGNATURE_FILENAME}，客户端将因 fail-closed 拒绝更新`);
  const sig = readFileSync(sigPath, 'utf8').trim();
  const ok = verifyManifest(normalized, sig, UPDATE_MANIFEST_PUBLIC_KEY);
  if (!ok) fail('现有签名与 latest.yml 不匹配（清单可能已变更，需重新签名）');
  console.log('✓ latest.yml 签名有效，与内置公钥匹配');
  process.exit(0);
}

const { path: keyPath, fromEnv } = resolveKeyPath();
if (!existsSync(keyPath)) {
  fail(
    `未找到签名私钥：${keyPath}\n` +
    `  ${fromEnv ? '（来自环境变量 HXSK_SIGNING_KEY）' : '（约定路径：项目同级的 HuanXiangShiKe-signing/update-private.pem）'}\n` +
    `  私钥不得存放在仓库内。请设置环境变量 HXSK_SIGNING_KEY 指向私钥文件，例如：\n` +
    `    $env:HXSK_SIGNING_KEY='D:\\keys\\update-private.pem'; npm run sign`
  );
}

let privateKeyPem;
try {
  privateKeyPem = readFileSync(keyPath, 'utf8');
} catch (e) {
  fail(`读取私钥失败：${e.message}`);
}

const signature = signManifest(normalized, privateKeyPem);

// 自校验：签完立刻用内置公钥验一次，防止写出无效签名
if (!verifyManifest(normalized, signature, UPDATE_MANIFEST_PUBLIC_KEY)) {
  fail('签名自校验失败：私钥与应用内置公钥不匹配，请勿发布（否则客户端会拒绝更新）');
}

writeFileSync(sigPath, signature + '\n', 'utf8');
console.log(`✓ 已签名：${sigPath}`);
console.log(`  清单：latest.yml（规范化后 ${normalized.length} 字节）`);
console.log(`  签名：${signature.slice(0, 24)}…（Ed25519, base64）`);
console.log(`  自校验：与内置公钥匹配 ✓`);
console.log(`下一步：gh release 时把 ${MANIFEST_SIGNATURE_FILENAME} 与 latest.yml 一起上传`);
