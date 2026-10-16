import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);
const { UpdateManager, PHASE, summarizeChannels } = require('../src/main/updater.js');
const up = require('../src/main/updater-core.js');
const pathsMod = require('../src/main/paths.js');
const { generateKeyPair, signManifest, normalizeManifest } = require('../src/main/update-verify.js');

const here = dirname(fileURLToPath(import.meta.url));

// 测试专用密钥对：私钥只在测试进程内存中，绝不落盘、绝不入仓、绝不与生产公钥混用。
// 每个 UpdateManager 实例注入 testKeys.publicKeyBase64，验签才可能通过。
const testKeys = generateKeyPair();

/** 对 latest.yml 文本用测试私钥签名（验签模块要求对规范化文本签名） */
function signYml(ymlText) {
  return signManifest(normalizeManifest(ymlText), testKeys.privateKeyPem);
}

function tmp(prefix) {
  return mkdtempSync(join(tmpdir(), `hxsk-upd-${prefix}-`));
}

function makePaths() {
  const dir = tmp('paths');
  return pathsMod.resolvePaths({
    appPath: dir, userDataPath: join(dir, 'ud'), resourcesPath: dir,
    isPackaged: false, homeDir: dir
  });
}

const INSTALLER_BYTES = Buffer.from('MZ-fake-installer-binary-content-for-sha-test');
const INSTALLER_SHA512 = crypto.createHash('sha512').update(INSTALLER_BYTES).digest('base64');
const INSTALLER_SHA256 = crypto.createHash('sha256').update(INSTALLER_BYTES).digest('hex');

function latestYml(version = '1.1.0') {
  return [
    `version: ${version}`,
    'files:',
    `  - url: HuanXiangShiKe-Setup-${version}.exe`,
    `    sha512: ${INSTALLER_SHA512}`,
    `    size: ${INSTALLER_BYTES.length}`,
    `path: HuanXiangShiKe-Setup-${version}.exe`,
    `sha512: ${INSTALLER_SHA512}`,
    'releaseDate: "2026-10-15T08:00:00.000Z"'
  ].join('\n');
}

/**
 * 假 fetch：能应答 API 探测、latest.yml、latest.yml.sig、以及安装包二进制下载
 * @param {object} o
 * @param {'valid'|'tampered'|'missing'} [o.sigMode] 签名模式：valid=合法签名，tampered=签名与清单不符，missing=不提供签名
 */
function fullFakeFetch({ version = '1.1', yml = null, installerBytes = INSTALLER_BYTES, failDownload = false, apiFail = false, sigMode = 'valid' } = {}) {
  const recorder = [];
  const ymlText = yml !== null ? yml : latestYml(`${version}.0`);
  const impl = async (url, opts = {}) => {
    recorder.push({ url, opts });
    if (url.includes('api.github.com/repos/sml1145/AIshipin/releases/latest')) {
      if (apiFail) throw new Error('ENOTFOUND api.github.com');
      return {
        ok: true, status: 200, headers: { get: () => null },
        text: async () => JSON.stringify({
          tag_name: `v${version}`, name: `幻想时刻 v${version}`,
          published_at: '2026-10-15T08:00:00Z', body: '修复更新问题',
          html_url: `https://github.com/sml1145/AIshipin/releases/tag/v${version}`,
          assets: [
            { name: `HuanXiangShiKe-Setup-${version}.0.exe`, size: installerBytes.length, browser_download_url: `https://github.com/dl/setup.exe` },
            { name: 'latest.yml', size: 400, browser_download_url: 'https://github.com/dl/latest.yml' }
          ]
        })
      };
    }
    if (url.includes('releases/latest') && !url.includes('api.github.com')) {
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => `<a href="/releases/tag/v${version}">x</a>` };
    }
    if (url.includes('/tags')) {
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify([{ name: `v${version}` }]) };
    }
    // 注意：.sig 必须在 latest.yml 之前判断，否则会被 includes('latest.yml') 误匹配
    if (url.includes('latest.yml.sig')) {
      if (sigMode === 'missing') return { ok: false, status: 404, headers: { get: () => null }, text: async () => '' };
      const sig = sigMode === 'tampered'
        ? signYml(ymlText + '\n# 被篡改的内容')   // 签名对应的是另一份清单 → 验签必失败
        : signYml(ymlText);
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => sig };
    }
    if (url.includes('latest.yml')) {
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => ymlText };
    }
    // 安装包下载
    if (failDownload) throw new Error('network down during download');
    return {
      ok: true, status: 200,
      headers: { get: (k) => (k.toLowerCase() === 'content-length' ? String(installerBytes.length) : null) },
      body: (async function* () { yield installerBytes; })()
    };
  };
  return { impl, recorder };
}

/** 构造注入了测试公钥的 UpdateManager（否则验签必失败） */
function makeManager(opts = {}) {
  const merged = { manifestPublicKey: testKeys.publicKeyBase64, ...opts };
  return new UpdateManager(merged);
}

/* ============ 检查更新 ============ */

test('检查更新：发现新版本时返回 needUpdate 并附通道汇总', async () => {
  const f = fullFakeFetch({ version: '1.1' });
  const m = makeManager({ paths: makePaths(), currentVersion: '1.0.0', fetchImpl: f.impl });
  const r = await m.check();
  assert.equal(r.ok, true);
  assert.equal(r.needUpdate, true);
  assert.equal(r.phase, PHASE.FOUND);
  assert.equal(r.latest, '1.1');
  assert.ok(r.channelSummary.includes('通道可用'));
  assert.equal(r.downloaded, false, '默认不自动下载，先让用户确认');
});

test('检查更新：已是最新时明确告知且不下载', async () => {
  const f = fullFakeFetch({ version: '1.0' });
  const m = makeManager({ paths: makePaths(), currentVersion: '1.0.0', fetchImpl: f.impl });
  const r = await m.check();
  assert.equal(r.needUpdate, false);
  assert.equal(r.phase, PHASE.NO_UPDATE);
  assert.ok(r.message.includes('已是最新'));
});

test('检查更新关键：1.9→2.0 判定为需要更新（十进制进位）', async () => {
  const f = fullFakeFetch({ version: '2.0' });
  const m = makeManager({ paths: makePaths(), currentVersion: '1.9.0', fetchImpl: f.impl });
  const r = await m.check();
  assert.equal(r.needUpdate, true);
  assert.equal(r.current, '1.9');
  assert.equal(r.latest, '2.0');
});

test('检查更新：全部通道失败时给出手动下载地址，不假装成功', async () => {
  const f = { impl: async () => { throw new Error('ENOTFOUND'); } };
  const m = makeManager({ paths: makePaths(), currentVersion: '1.0.0', fetchImpl: f.impl });
  const r = await m.check();
  assert.equal(r.ok, false);
  assert.equal(r.phase, PHASE.FAILED);
  assert.ok(r.manualUrl.includes('github.com/sml1145/AIshipin'), '必须给出手动下载入口');
  assert.ok(r.suggestion.includes('手动下载'));
});

test('检查更新：并发触发被拦截，不会重复探测', async () => {
  const f = fullFakeFetch({ version: '1.1' });
  const m = makeManager({ paths: makePaths(), currentVersion: '1.0.0', fetchImpl: f.impl });
  const p1 = m.check();
  const p2 = m.check(); // 立即第二次
  const r2 = await p2;
  await p1;
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, 'busy');
});

test('检查更新：onState 逐阶段回调，UI 能展示探测进度', async () => {
  const f = fullFakeFetch({ version: '1.1' });
  const phases = [];
  const m = makeManager({
    paths: makePaths(), currentVersion: '1.0.0', fetchImpl: f.impl,
    onState: (s) => phases.push(s.phase)
  });
  await m.check();
  assert.ok(phases.includes(PHASE.PROBING), '应有探测中阶段');
  assert.ok(phases.includes(PHASE.FOUND), '应有发现新版本阶段');
});

/* ============ 下载 + 校验 ============ */

test('下载更新：SHA512 校验通过并给出安装包路径', async () => {
  const f = fullFakeFetch({ version: '1.1' });
  const m = makeManager({ paths: makePaths(), currentVersion: '1.0.0', fetchImpl: f.impl });
  const r = await m.check({ downloadIfNew: true });
  assert.equal(r.ok, true);
  assert.equal(r.phase, PHASE.READY_TO_INSTALL);
  assert.equal(r.sha512Verified, true, '必须做了 SHA512 校验');
  assert.equal(r.sha256, INSTALLER_SHA256);
  assert.ok(existsSync(r.installerPath), '安装包必须真实下载落盘');
  assert.equal(readFileSync(r.installerPath).equals(INSTALLER_BYTES), true);
  rmSync(m.downloadDir, { recursive: true, force: true });
});

test('下载更新关键：SHA512 不符必须删除文件并拒绝安装', async () => {
  // 下载到的内容被篡改，与 latest.yml 里的 sha512 不符
  const tampered = Buffer.from('TAMPERED-MALICIOUS-INSTALLER');
  const f = fullFakeFetch({ version: '1.1', installerBytes: tampered });
  const m = makeManager({ paths: makePaths(), currentVersion: '1.0.0', fetchImpl: f.impl });
  const r = await m.check({ downloadIfNew: true });
  assert.equal(r.ok, false);
  assert.equal(r.phase, PHASE.FAILED);
  assert.ok(r.message.includes('SHA512 校验失败'), `应明确告知校验失败，实际：${r.message}`);
  assert.ok(r.suggestion.includes('篡改') || r.suggestion.includes('手动'));
  // 被篡改的安装包必须已从磁盘删除
  const leftover = join(m.downloadDir, 'HuanXiangShiKe-Setup-1.1.0.exe');
  assert.ok(!existsSync(leftover), '校验失败的安装包必须被删除，不能留在磁盘');
  rmSync(m.downloadDir, { recursive: true, force: true });
});

test('下载更新：下载全部失败时给出手动下载直链', async () => {
  const f = fullFakeFetch({ version: '1.1', failDownload: true });
  const m = makeManager({ paths: makePaths(), currentVersion: '1.0.0', fetchImpl: f.impl });
  const r = await m.check({ downloadIfNew: true });
  assert.equal(r.ok, false);
  assert.equal(r.phase, PHASE.FAILED);
  assert.ok(r.manualUrl || r.directUrl, '必须给出手动下载途径');
  assert.ok(r.message.includes('下载通道均失败'));
});

test('下载更新关键：缺少 Ed25519 签名清单时拒绝自动更新（fail-closed）', async () => {
  const f = fullFakeFetch({ version: '1.1', sigMode: 'missing' });
  const m = makeManager({ paths: makePaths(), currentVersion: '1.0.0', fetchImpl: f.impl });
  const r = await m.check({ downloadIfNew: true });
  assert.equal(r.ok, false, '缺签名必须拒绝，不得放行');
  assert.equal(r.phase, PHASE.FAILED);
  assert.ok(r.message.includes('签名') || r.message.includes('Ed25519'), '应说明因缺签名而拒绝: ' + r.message);
  assert.ok(r.manualUrl, '应给出手动下载出口');
  // 绝不能下载落盘任何安装包
  assert.ok(!existsSync(join(m.downloadDir, 'HuanXiangShiKe-Setup-1.1.0.exe')), '拒绝时不应留下安装包');
  rmSync(m.downloadDir, { recursive: true, force: true });
});

test('下载更新关键：Ed25519 签名与清单不符（被篡改）时拒绝自动更新', async () => {
  // sigMode:'tampered' 让签名对应的是另一份清单内容，与真实 latest.yml 不匹配
  const f = fullFakeFetch({ version: '1.1', sigMode: 'tampered' });
  const m = makeManager({ paths: makePaths(), currentVersion: '1.0.0', fetchImpl: f.impl });
  const r = await m.check({ downloadIfNew: true });
  assert.equal(r.ok, false, '验签失败必须拒绝');
  assert.equal(r.phase, PHASE.FAILED);
  assert.ok(r.message.includes('验签失败') || r.message.includes('篡改'), '应说明验签失败: ' + r.message);
  assert.ok(!existsSync(join(m.downloadDir, 'HuanXiangShiKe-Setup-1.1.0.exe')), '验签失败不应留下安装包');
  rmSync(m.downloadDir, { recursive: true, force: true });
});

test('下载更新：验签通过后正常下载并做 SHA512 校验', async () => {
  const f = fullFakeFetch({ version: '1.1', sigMode: 'valid' });
  const m = makeManager({ paths: makePaths(), currentVersion: '1.0.0', fetchImpl: f.impl });
  const r = await m.check({ downloadIfNew: true });
  assert.equal(r.ok, true, '合法签名应放行');
  assert.equal(r.manifestSigned, true, '应标注清单已验签');
  assert.equal(r.sha512Verified, true);
  rmSync(m.downloadDir, { recursive: true, force: true });
});

test('下载更新：多通道竞速，记录胜出通道', async () => {
  const f = fullFakeFetch({ version: '1.1' });
  const m = makeManager({ paths: makePaths(), currentVersion: '1.0.0', fetchImpl: f.impl });
  const r = await m.check({ downloadIfNew: true });
  assert.equal(r.ok, true);
  assert.ok(r.winnerChannel, '应记录哪个通道下载成功');
  rmSync(m.downloadDir, { recursive: true, force: true });
});

/* ============ 静默安装 ============ */

test('安装关键：用参数数组 spawn 安装器，绝不拼接 shell 命令（防中文/空格路径注入）', async () => {
  const f = fullFakeFetch({ version: '1.1' });
  const spawnCalls = [];
  const fakeSpawn = (cmd, args, opts) => {
    spawnCalls.push({ cmd, args, opts });
    return { unref: () => {} };
  };
  const fakeApp = { getPath: () => 'C:\\Users\\me\\AppData\\Local\\Programs\\幻想时刻\\幻想时刻.exe', quit: () => {} };
  const m = makeManager({
    paths: makePaths(), currentVersion: '1.0.0', fetchImpl: f.impl,
    spawnImpl: fakeSpawn, electronApp: fakeApp
  });
  await m.check({ downloadIfNew: true });
  const r = await m.install();
  assert.equal(r.ok, true);
  assert.equal(spawnCalls.length, 1);
  const { cmd, args, opts } = spawnCalls[0];
  assert.ok(cmd.endsWith('.exe'), '第一个参数应是安装器路径本身');
  assert.ok(args.includes('/S'), '必须带 NSIS 静默参数');
  assert.ok(args.some(a => a.startsWith('/D=')), '必须指定安装目录');
  // 关键安全断言：cmd 是纯路径，args 是数组，没有 shell 元字符拼接
  assert.ok(!/[;&|`$]/.test(cmd), '命令不得含 shell 元字符');
  assert.ok(opts.detached === true, '必须 detached，应用退出后安装器继续');
  assert.equal(opts.shell, undefined, '绝不能走 shell（否则路径含空格/中文会注入）');
  rmSync(m.downloadDir, { recursive: true, force: true });
});

test('安装：安装包不存在时明确报错，不静默失败', async () => {
  const m = makeManager({ paths: makePaths(), currentVersion: '1.0.0', fetchImpl: async () => { throw new Error('x'); } });
  const r = await m.install({ installerPath: join(tmp('nope'), 'missing.exe') });
  assert.equal(r.ok, false);
  assert.ok(r.message.includes('安装包不存在'));
});

test('安装：spawn 抛错时给出可手动运行的安装包路径', async () => {
  const f = fullFakeFetch({ version: '1.1' });
  const fakeSpawn = () => { throw new Error('EACCES permission denied'); };
  const m = makeManager({
    paths: makePaths(), currentVersion: '1.0.0', fetchImpl: f.impl,
    spawnImpl: fakeSpawn, electronApp: { getPath: () => 'C:\\x\\app.exe', quit: () => {} }
  });
  await m.check({ downloadIfNew: true });
  const r = await m.install();
  assert.equal(r.ok, false);
  assert.ok(r.suggestion.includes('手动双击'), '应引导用户手动安装');
  assert.ok(r.installerPath && existsSync(r.installerPath));
  rmSync(m.downloadDir, { recursive: true, force: true });
});

test('安装：记录升级尝试，供下次启动做回滚判定', async () => {
  const f = fullFakeFetch({ version: '1.1' });
  const paths = makePaths();
  pathsMod.ensureDirs(paths);
  const m = makeManager({
    paths, currentVersion: '1.0.0', fetchImpl: f.impl,
    spawnImpl: () => ({ unref: () => {} }), electronApp: { getPath: () => 'C:\\x\\app.exe', quit: () => {} }
  });
  await m.check({ downloadIfNew: true });
  await m.install();
  const rec = JSON.parse(readFileSync(join(paths.userData, 'last-update-attempt.json'), 'utf8'));
  assert.equal(rec.fromVersion, '1.0.0');
  assert.equal(rec.toVersion, '1.1');
  rmSync(m.downloadDir, { recursive: true, force: true });
});

/* ============ 回滚判定 ============ */

test('回滚判定：升级成功（版本已变）后清理记录并报告升级成功', () => {
  const paths = makePaths();
  pathsMod.ensureDirs(paths);
  writeFileSync(join(paths.userData, 'last-update-attempt.json'), JSON.stringify({
    fromVersion: '1.0.0', toVersion: '1.1', installerPath: 'C:\\x.exe', at: new Date().toISOString()
  }));
  const m = makeManager({ paths, currentVersion: '1.1.0', fetchImpl: async () => { throw new Error('x'); } });
  const r = m.checkRollbackOnStartup();
  assert.equal(r.needed, false);
  assert.equal(r.upgradedFrom, '1.0.0');
  assert.equal(r.upgradedTo, '1.1');
  assert.ok(!existsSync(join(paths.userData, 'last-update-attempt.json')), '成功后应清理记录');
});

test('回滚判定：升级未完成（版本没变）时提示用户', () => {
  const paths = makePaths();
  pathsMod.ensureDirs(paths);
  writeFileSync(join(paths.userData, 'last-update-attempt.json'), JSON.stringify({
    fromVersion: '1.0.0', toVersion: '1.1', installerPath: 'C:\\gone.exe', at: new Date().toISOString()
  }));
  const m = makeManager({ paths, currentVersion: '1.0.0', fetchImpl: async () => { throw new Error('x'); } });
  const r = m.checkRollbackOnStartup();
  assert.equal(r.needed, true);
  assert.equal(r.toVersion, '1.1');
  assert.equal(r.installerExists, false);
  assert.ok(r.message.includes('未完成'));
});

test('回滚判定：无记录时静默通过', () => {
  const m = makeManager({ paths: makePaths(), currentVersion: '1.0.0', fetchImpl: async () => { throw new Error('x'); } });
  assert.equal(m.checkRollbackOnStartup().needed, false);
});

test('回滚判定：记录损坏时不崩，给出警告', () => {
  const paths = makePaths();
  pathsMod.ensureDirs(paths);
  writeFileSync(join(paths.userData, 'last-update-attempt.json'), '{ broken json');
  const m = makeManager({ paths, currentVersion: '1.0.0', fetchImpl: async () => { throw new Error('x'); } });
  const r = m.checkRollbackOnStartup();
  assert.equal(r.needed, false);
  assert.ok(r.warning.includes('损坏'));
});

/* ============ 通道汇总 ============ */

test('通道汇总：把探测结果整理成人话', () => {
  const s = summarizeChannels([
    { label: 'A', ok: true, version: '1.1' },
    { label: 'B', ok: false, error: 'timeout' }
  ]);
  assert.ok(s.includes('1 条通道可用'));
  assert.ok(s.includes('1 条不可用'));
  assert.ok(s.includes('timeout'));
});

test('手动下载地址指向目标仓库 Releases', () => {
  const m = makeManager({ paths: makePaths(), currentVersion: '1.0.0', fetchImpl: async () => { throw new Error('x'); } });
  assert.equal(m.getManualDownloadUrl(), 'https://github.com/sml1145/AIshipin/releases/latest');
});
