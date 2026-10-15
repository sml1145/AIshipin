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

const here = dirname(fileURLToPath(import.meta.url));

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
 * 假 fetch：能应答 API 探测、latest.yml、以及安装包二进制下载
 */
function fullFakeFetch({ version = '1.1', yml = null, installerBytes = INSTALLER_BYTES, failDownload = false, apiFail = false } = {}) {
  const recorder = [];
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
    if (url.includes('latest.yml')) {
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => (yml !== null ? yml : latestYml(`${version}.0`)) };
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

/* ============ 检查更新 ============ */

test('检查更新：发现新版本时返回 needUpdate 并附通道汇总', async () => {
  const f = fullFakeFetch({ version: '1.1' });
  const m = new UpdateManager({ paths: makePaths(), currentVersion: '1.0.0', fetchImpl: f.impl });
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
  const m = new UpdateManager({ paths: makePaths(), currentVersion: '1.0.0', fetchImpl: f.impl });
  const r = await m.check();
  assert.equal(r.needUpdate, false);
  assert.equal(r.phase, PHASE.NO_UPDATE);
  assert.ok(r.message.includes('已是最新'));
});

test('检查更新关键：1.9→2.0 判定为需要更新（十进制进位）', async () => {
  const f = fullFakeFetch({ version: '2.0' });
  const m = new UpdateManager({ paths: makePaths(), currentVersion: '1.9.0', fetchImpl: f.impl });
  const r = await m.check();
  assert.equal(r.needUpdate, true);
  assert.equal(r.current, '1.9');
  assert.equal(r.latest, '2.0');
});

test('检查更新：全部通道失败时给出手动下载地址，不假装成功', async () => {
  const f = { impl: async () => { throw new Error('ENOTFOUND'); } };
  const m = new UpdateManager({ paths: makePaths(), currentVersion: '1.0.0', fetchImpl: f.impl });
  const r = await m.check();
  assert.equal(r.ok, false);
  assert.equal(r.phase, PHASE.FAILED);
  assert.ok(r.manualUrl.includes('github.com/sml1145/AIshipin'), '必须给出手动下载入口');
  assert.ok(r.suggestion.includes('手动下载'));
});

test('检查更新：并发触发被拦截，不会重复探测', async () => {
  const f = fullFakeFetch({ version: '1.1' });
  const m = new UpdateManager({ paths: makePaths(), currentVersion: '1.0.0', fetchImpl: f.impl });
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
  const m = new UpdateManager({
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
  const m = new UpdateManager({ paths: makePaths(), currentVersion: '1.0.0', fetchImpl: f.impl });
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
  const m = new UpdateManager({ paths: makePaths(), currentVersion: '1.0.0', fetchImpl: f.impl });
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
  const m = new UpdateManager({ paths: makePaths(), currentVersion: '1.0.0', fetchImpl: f.impl });
  const r = await m.check({ downloadIfNew: true });
  assert.equal(r.ok, false);
  assert.equal(r.phase, PHASE.FAILED);
  assert.ok(r.manualUrl || r.directUrl, '必须给出手动下载途径');
  assert.ok(r.message.includes('下载通道均失败'));
});

test('下载更新：latest.yml 缺失时仍能下载，但标注未做 SHA512 校验', async () => {
  // manifest 取不到（返回空 yml 触发解析失败）→ 降级为只校验大小
  const f = fullFakeFetch({ version: '1.1', yml: 'garbage-not-yaml' });
  const m = new UpdateManager({ paths: makePaths(), currentVersion: '1.0.0', fetchImpl: f.impl });
  const r = await m.check({ downloadIfNew: true });
  assert.equal(r.ok, true);
  assert.equal(r.sha512Verified, false, '没有 manifest 就必须如实标注未校验');
  assert.ok(existsSync(r.installerPath));
  rmSync(m.downloadDir, { recursive: true, force: true });
});

test('下载更新：多通道竞速，记录胜出通道', async () => {
  const f = fullFakeFetch({ version: '1.1' });
  const m = new UpdateManager({ paths: makePaths(), currentVersion: '1.0.0', fetchImpl: f.impl });
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
  const m = new UpdateManager({
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
  const m = new UpdateManager({ paths: makePaths(), currentVersion: '1.0.0', fetchImpl: async () => { throw new Error('x'); } });
  const r = await m.install({ installerPath: join(tmp('nope'), 'missing.exe') });
  assert.equal(r.ok, false);
  assert.ok(r.message.includes('安装包不存在'));
});

test('安装：spawn 抛错时给出可手动运行的安装包路径', async () => {
  const f = fullFakeFetch({ version: '1.1' });
  const fakeSpawn = () => { throw new Error('EACCES permission denied'); };
  const m = new UpdateManager({
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
  const m = new UpdateManager({
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
  const m = new UpdateManager({ paths, currentVersion: '1.1.0', fetchImpl: async () => { throw new Error('x'); } });
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
  const m = new UpdateManager({ paths, currentVersion: '1.0.0', fetchImpl: async () => { throw new Error('x'); } });
  const r = m.checkRollbackOnStartup();
  assert.equal(r.needed, true);
  assert.equal(r.toVersion, '1.1');
  assert.equal(r.installerExists, false);
  assert.ok(r.message.includes('未完成'));
});

test('回滚判定：无记录时静默通过', () => {
  const m = new UpdateManager({ paths: makePaths(), currentVersion: '1.0.0', fetchImpl: async () => { throw new Error('x'); } });
  assert.equal(m.checkRollbackOnStartup().needed, false);
});

test('回滚判定：记录损坏时不崩，给出警告', () => {
  const paths = makePaths();
  pathsMod.ensureDirs(paths);
  writeFileSync(join(paths.userData, 'last-update-attempt.json'), '{ broken json');
  const m = new UpdateManager({ paths, currentVersion: '1.0.0', fetchImpl: async () => { throw new Error('x'); } });
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
  const m = new UpdateManager({ paths: makePaths(), currentVersion: '1.0.0', fetchImpl: async () => { throw new Error('x'); } });
  assert.equal(m.getManualDownloadUrl(), 'https://github.com/sml1145/AIshipin/releases/latest');
});
