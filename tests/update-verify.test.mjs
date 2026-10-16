import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';

const require = createRequire(import.meta.url);
const uv = require('../src/main/update-verify.js');
const { UPDATE_MANIFEST_PUBLIC_KEY, MANIFEST_SIGNATURE_FILENAME } = require('../src/main/update-pubkey.js');

const here = dirname(fileURLToPath(import.meta.url));

/* ============ 密钥生成 ============ */

test('generateKeyPair: 产出 Ed25519 三种表示且公钥可互推', () => {
  const kp = uv.generateKeyPair();
  assert.ok(kp.publicKeyPem.includes('BEGIN PUBLIC KEY'));
  assert.ok(kp.privateKeyPem.includes('BEGIN PRIVATE KEY'));
  assert.ok(typeof kp.publicKeyBase64 === 'string' && kp.publicKeyBase64.length > 20);
  // PEM 与 base64 DER 应是同一把公钥的两种编码
  const crypto = require('node:crypto');
  const fromPem = crypto.createPublicKey(kp.publicKeyPem).export({ type: 'spki', format: 'der' }).toString('base64');
  assert.equal(fromPem, kp.publicKeyBase64);
});

test('generateKeyPair: 每次生成的密钥对不同（不是硬编码常量）', () => {
  const a = uv.generateKeyPair();
  const b = uv.generateKeyPair();
  assert.notEqual(a.publicKeyBase64, b.publicKeyBase64);
  assert.notEqual(a.privateKeyPem, b.privateKeyPem);
});

/* ============ 签名与验签 ============ */

const SAMPLE = [
  'version: 1.2.0',
  'files:',
  '  - url: HuanXiangShiKe-Setup-1.2.0.exe',
  '    sha512: abc123==',
  '    size: 128577108',
  'path: HuanXiangShiKe-Setup-1.2.0.exe',
  'sha512: abc123=='
].join('\n');

test('签名验签：合法签名验证通过', () => {
  const kp = uv.generateKeyPair();
  const sig = uv.signManifest(SAMPLE, kp.privateKeyPem);
  assert.equal(uv.verifyManifest(SAMPLE, sig, kp.publicKeyPem), true);
  assert.equal(uv.verifyManifest(SAMPLE, sig, kp.publicKeyBase64), true, 'base64 DER 公钥也应可验签');
});

test('签名验签关键：清单被篡改后验签必须失败', () => {
  const kp = uv.generateKeyPair();
  const sig = uv.signManifest(SAMPLE, kp.privateKeyPem);
  // 攻击者把版本号改高，诱导用户"更新"到恶意包
  const tampered = SAMPLE.replace('version: 1.2.0', 'version: 9.9.0');
  assert.equal(uv.verifyManifest(tampered, sig, kp.publicKeyPem), false);
  // 攻击者替换 sha512 使其匹配恶意安装包
  const tampered2 = SAMPLE.replace('abc123==', 'EVIL_HASH==');
  assert.equal(uv.verifyManifest(tampered2, sig, kp.publicKeyPem), false);
});

test('签名验签关键：用别人的私钥签名无法通过（伪造者无私钥）', () => {
  const legit = uv.generateKeyPair();
  const attacker = uv.generateKeyPair();
  const forgedSig = uv.signManifest(SAMPLE, attacker.privateKeyPem);
  assert.equal(uv.verifyManifest(SAMPLE, forgedSig, legit.publicKeyPem), false, '攻击者签名不得通过官方公钥验签');
});

test('签名验签：签名被改动即失败', () => {
  const kp = uv.generateKeyPair();
  const sig = uv.signManifest(SAMPLE, kp.privateKeyPem);
  const buf = Buffer.from(sig, 'base64');
  buf[0] = buf[0] ^ 0xff; // 翻转一个字节
  assert.equal(uv.verifyManifest(SAMPLE, buf.toString('base64'), kp.publicKeyPem), false);
});

test('验签健壮性：非法/缺失输入一律返回 false，绝不抛异常', () => {
  const kp = uv.generateKeyPair();
  const sig = uv.signManifest(SAMPLE, kp.privateKeyPem);
  assert.equal(uv.verifyManifest('', sig, kp.publicKeyPem), false);
  assert.equal(uv.verifyManifest(null, sig, kp.publicKeyPem), false);
  assert.equal(uv.verifyManifest(SAMPLE, '', kp.publicKeyPem), false);
  assert.equal(uv.verifyManifest(SAMPLE, null, kp.publicKeyPem), false);
  assert.equal(uv.verifyManifest(SAMPLE, sig, ''), false);
  assert.equal(uv.verifyManifest(SAMPLE, sig, null), false);
  assert.equal(uv.verifyManifest(SAMPLE, 'not-base64-!!!', kp.publicKeyPem), false);
  assert.equal(uv.verifyManifest(SAMPLE, sig, 'not-a-key'), false);
});

/* ============ 规范化 ============ */

test('normalizeManifest: CRLF 归一化为 LF，消除跨平台验签失败', () => {
  assert.equal(uv.normalizeManifest('a\r\nb\r\n'), 'a\nb\n');
  assert.equal(uv.normalizeManifest('a\nb\n'), 'a\nb\n');
  assert.equal(uv.normalizeManifest(''), '');
  assert.equal(uv.normalizeManifest(null), '');
});

test('normalizeManifest 关键：对 CRLF 原文签名后，LF 版本仍能验签通过', () => {
  const kp = uv.generateKeyPair();
  const crlf = SAMPLE.replace(/\n/g, '\r\n');
  const sig = uv.signManifest(uv.normalizeManifest(crlf), kp.privateKeyPem);
  assert.equal(uv.verifyManifest(uv.normalizeManifest(SAMPLE), sig, kp.publicKeyPem), true);
});

/* ============ 应用内置公钥 ============ */

test('内置公钥：是合法的 base64 DER 且能被 crypto 解析为 Ed25519', () => {
  const crypto = require('node:crypto');
  const der = Buffer.from(UPDATE_MANIFEST_PUBLIC_KEY, 'base64');
  assert.ok(der.length > 0);
  const key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
  assert.equal(key.asymmetricKeyType, 'ed25519');
});

test('内置公钥：签名文件名约定为 latest.yml.sig', () => {
  assert.equal(MANIFEST_SIGNATURE_FILENAME, 'latest.yml.sig');
});

test('内置公钥：仓库内绝不含私钥（防泄露）', () => {
  const root = join(here, '..');
  for (const p of ['update-private.pem', 'private.pem', 'src/main/update-private.pem', 'build/update-private.pem']) {
    assert.ok(!existsSync(join(root, p)), `仓库内不得存在私钥文件: ${p}`);
  }
  // 全仓库源码扫描：不应出现 PRIVATE KEY 字样
  const srcFiles = [
    'src/main/update-pubkey.js', 'src/main/update-verify.js', 'scripts/sign-release.mjs'
  ];
  for (const f of srcFiles) {
    const full = join(root, f);
    if (!existsSync(full)) continue;
    const txt = readFileSync(full, 'utf8');
    assert.ok(!txt.includes('BEGIN PRIVATE KEY'), `${f} 不得内嵌私钥内容`);
  }
});

/* ============ 已发布 Release 的签名有效性（条件测试）============ */

test('发布产物：release/latest.yml.sig 若存在则必须与内置公钥匹配', (t) => {
  const root = join(here, '..');
  const yml = join(root, 'release', 'latest.yml');
  const sig = join(root, 'release', MANIFEST_SIGNATURE_FILENAME);
  if (!existsSync(yml) || !existsSync(sig)) {
    t.skip('release 产物或签名文件不存在（尚未打包/签名），跳过');
    return;
  }
  const normalized = uv.normalizeManifest(readFileSync(yml, 'utf8'));
  const signature = readFileSync(sig, 'utf8').trim();
  assert.equal(
    uv.verifyManifest(normalized, signature, UPDATE_MANIFEST_PUBLIC_KEY), true,
    '已发布的签名必须能用应用内置公钥验证通过，否则客户端会拒绝更新'
  );
});
