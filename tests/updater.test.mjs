import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const up = require('../src/main/updater-core.js');

/** 可编程假 fetch：按 URL 匹配响应，支持模拟超时与错误 */
function fakeFetch(routes, recorder = []) {
  const impl = async (url, opts = {}) => {
    recorder.push({ url, opts, at: Date.now() });
    const key = Object.keys(routes).find(k => url.includes(k));
    const r = key ? routes[key] : routes.default;
    if (!r) throw new Error(`未定义响应: ${url}`);
    if (typeof r === 'function') return r(url, opts);
    if (r.delay) await new Promise(res => setTimeout(res, r.delay));
    if (r.throw) throw new Error(r.throw);
    return {
      ok: r.ok !== false,
      status: r.status || 200,
      headers: { get: () => null },
      text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? ''))
    };
  };
  return { impl, recorder };
}

const apiRelease = (tag, assets = []) => ({
  tag_name: tag,
  name: `幻想时刻 ${tag}`,
  published_at: '2026-10-15T08:00:00Z',
  body: '修复若干问题',
  html_url: `https://github.com/sml1145/AIshipin/releases/tag/${tag}`,
  assets
});

/* ============ 通道清单 ============ */

test('通道清单：默认包含 API 主通道、HTML 兜底、Tags 兜底三条', () => {
  const ch = up.buildProbeChannels();
  assert.ok(ch.length >= 3, `至少三条通道，实际 ${ch.length}`);
  assert.ok(ch.some(c => c.parser === 'githubApi' && c.url.includes('api.github.com')));
  assert.ok(ch.some(c => c.parser === 'githubHtml'));
  assert.ok(ch.some(c => c.parser === 'githubTags'));
  assert.ok(ch.every(c => c.url.includes('sml1145/AIshipin')), '所有通道必须指向目标仓库');
});

test('通道清单：用户自定义镜像会被追加且 URL 拼接正确', () => {
  const ch = up.buildProbeChannels({ extraMirrors: ['https://gh.example.com/'] });
  const mirror = ch.find(c => c.label.includes('gh.example.com'));
  assert.ok(mirror, '镜像通道应被追加');
  assert.equal(mirror.url, 'https://gh.example.com/sml1145/AIshipin/releases/latest');
});

test('通道清单：可覆盖 owner/repo（便于将来迁移仓库）', () => {
  const ch = up.buildProbeChannels({ owner: 'other', repo: 'Repo2' });
  assert.ok(ch[0].url.includes('other/Repo2'));
});

test('下载通道清单：直连 + API 资产 + 镜像，且文件名被正确编码', () => {
  const ch = up.buildDownloadChannels({
    tag: 'v1.1', assetName: 'HuanXiangShiKe-Setup-1.1.0.exe', extraMirrors: ['https://gh.example.com']
  });
  assert.ok(ch.length >= 3);
  assert.equal(ch[0].url, 'https://github.com/sml1145/AIshipin/releases/download/v1.1/HuanXiangShiKe-Setup-1.1.0.exe');
  assert.ok(ch[1].url.includes('/releases/assets/by-name/'));
  assert.ok(ch[2].url.startsWith('https://gh.example.com/'));
});

test('下载通道清单：tag 含特殊字符时必须 URL 编码', () => {
  const ch = up.buildDownloadChannels({ tag: 'v1.1 beta', assetName: 'a.exe' });
  assert.ok(ch[0].url.includes('v1.1%20beta'), `应编码空格: ${ch[0].url}`);
});

/* ============ 响应解析 ============ */

test('解析 GitHub API：提取 tag、版本、资产并标记安装包与 manifest', () => {
  const r = up.parseGithubApi(apiRelease('v1.1', [
    { name: 'HuanXiangShiKe-Setup-1.1.0.exe', size: 123456, browser_download_url: 'https://x/a.exe' },
    { name: 'latest.yml', size: 400, browser_download_url: 'https://x/latest.yml' },
    { name: 'HuanXiangShiKe-Setup-1.1.0.exe.blockmap', size: 900, browser_download_url: 'https://x/a.blockmap' }
  ]));
  assert.equal(r.tag, 'v1.1');
  assert.equal(r.version, '1.1');
  assert.equal(r.publishedAt, '2026-10-15T08:00:00Z');
  assert.equal(r.assets.length, 3);
  assert.ok(r.assets.find(a => a.name === 'latest.yml').isManifest);
  assert.ok(r.assets.find(a => a.name.endsWith('.exe')).isInstaller);
  assert.equal(r.assets.find(a => a.name.endsWith('.exe')).size, 123456);
});

test('解析 GitHub API：缺 tag_name 或版本不可识别时必须抛错', () => {
  assert.throws(() => up.parseGithubApi({ name: 'x' }), /缺少 tag_name/);
  assert.throws(() => up.parseGithubApi({ tag_name: 'no-version' }), /无法从 tag 提取版本号/);
  assert.throws(() => up.parseGithubApi(null), /不是合法 JSON/);
});

test('解析 GitHub API：兼容 2.0 这类进位后的版本', () => {
  assert.equal(up.parseGithubApi(apiRelease('v2.0')).version, '2.0');
  assert.equal(up.parseGithubApi(apiRelease('v1.9')).version, '1.9');
});

test('解析 HTML 兜底：从 /releases/tag/ 链接提取版本', () => {
  const html = '<html><a href="/sml1145/AIshipin/releases/tag/v1.2">v1.2</a></html>';
  const r = up.parseGithubHtml(html, 'https://github.com/sml1145/AIshipin/releases/latest');
  assert.equal(r.version, '1.2');
  assert.equal(r.tag, 'v1.2');
  assert.equal(r.fromHtml, true);
});

test('解析 HTML 兜底：URL 编码的 tag 要解码，找不到 tag 必须抛错', () => {
  assert.equal(up.parseGithubHtml('<a href="/releases/tag/v1.3%20rc">x</a>').tag, 'v1.3 rc');
  assert.throws(() => up.parseGithubHtml('<html>nothing here</html>'), /未找到 release tag/);
});

test('解析 Tags 兜底：从多个 tag 中按十进制语义取最大（2.0 > 1.9）', () => {
  const r = up.parseGithubTags([
    { name: 'v1.0' }, { name: 'v1.9' }, { name: 'v2.0' }, { name: 'v1.5' }
  ]);
  assert.equal(r.version, '2.0');
  assert.equal(r.tag, 'v2.0');
  assert.equal(r.fromTags, true);
});

test('解析 Tags 兜底：空列表或无版本号必须抛错', () => {
  assert.throws(() => up.parseGithubTags([]), /为空/);
  assert.throws(() => up.parseGithubTags([{ name: 'init' }]), /没有可识别的版本号/);
});

test('解析 latest.yml：提取 version 与 sha512（不依赖 yaml 库）', () => {
  const yml = [
    'version: 1.1.0',
    'files:',
    '  - url: HuanXiangShiKe-Setup-1.1.0.exe',
    '    sha512: abcDEF123==',
    '    size: 251658240',
    'path: HuanXiangShiKe-Setup-1.1.0.exe',
    'sha512: abcDEF123==',
    'releaseDate: "2026-10-15T08:00:00.000Z"'
  ].join('\n');
  const r = up.parseLatestYml(yml);
  assert.equal(r.version, '1.1.0');
  assert.equal(r.sha512, 'abcDEF123==');
  assert.equal(r.path, 'HuanXiangShiKe-Setup-1.1.0.exe');
  assert.ok(r.releaseDate.includes('2026-10-15'));
});

test('解析 latest.yml：缺 version 必须抛错，不接受残缺 manifest', () => {
  assert.throws(() => up.parseLatestYml('sha512: xx\n'), /缺少 version/);
  assert.throws(() => up.parseLatestYml(''), /缺少 version/);
});

test('安装包名挑选：优先用真实资产里的 exe，排除 blockmap', () => {
  const rel = up.parseGithubApi(apiRelease('v1.1', [
    { name: 'HuanXiangShiKe-Setup-1.1.0.exe.blockmap', browser_download_url: 'x' },
    { name: 'HuanXiangShiKe-Setup-1.1.0.exe', browser_download_url: 'y' }
  ]));
  assert.equal(up.pickInstallerName(rel, '1.1'), 'HuanXiangShiKe-Setup-1.1.0.exe');
});

test('安装包名挑选：无资产时按命名规则推导，保证 HTML 兜底通道也能下载', () => {
  const rel = { version: '1.2', assets: [] };
  assert.equal(up.pickInstallerName(rel, '1.2'), 'HuanXiangShiKe-Setup-1.2.0.exe');
});

/* ============ 阶段1：探测竞速（多通道并行的核心）============ */

test('探测竞速关键：主通道超时时自动由兜底通道胜出，更新功能不中断', async () => {
  const f = fakeFetch({
    'api.github.com/repos': { delay: 3000, throw: 'timeout' },
    'github.com/sml1145/AIshipin/releases/latest': { body: '<a href="/releases/tag/v1.4">x</a>' },
    'api.github.com/repos/sml1145/AIshipin/tags': { body: [{ name: 'v1.4' }] }
  });
  const r = await up.probeLatest({
    channels: up.buildProbeChannels(),
    fetchImpl: f.impl,
    timeoutMs: 500
  });
  assert.equal(r.ok, true, '主通道挂掉也应探测成功');
  assert.equal(r.release.version, '1.4');
  assert.notEqual(r.winner.label, 'GitHub API（主通道）', '胜出者不应是已超时的主通道');
});

test('探测竞速：全部通道成功时按 priority 选主通道，且版本取最大（防镜像滞后）', async () => {
  const f = fakeFetch({
    'api.github.com/repos/sml1145/AIshipin/releases/latest': { body: apiRelease('v1.2') },
    'github.com/sml1145/AIshipin/releases/latest': { body: '<a href="/releases/tag/v1.5">x</a>' },
    'api.github.com/repos/sml1145/AIshipin/tags': { body: [{ name: 'v1.3' }] }
  });
  const r = await up.probeLatest({ channels: up.buildProbeChannels(), fetchImpl: f.impl });
  assert.equal(r.ok, true);
  assert.equal(r.release.version, '1.5', '镜像/兜底报告更高版本时应取更高版本，避免用户漏更新');
});

test('探测竞速：真的是并行发起而非串行等待', async () => {
  const started = [];
  const f = {
    impl: async (url) => {
      started.push(Date.now());
      await new Promise(r => setTimeout(r, 200));
      if (url.includes('api.github.com/repos/sml1145/AIshipin/releases/latest')) {
        return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(apiRelease('v1.1')) };
      }
      throw new Error('HTTP 404');
    }
  };
  const t0 = Date.now();
  await up.probeLatest({ channels: up.buildProbeChannels(), fetchImpl: f.impl, timeoutMs: 5000 });
  const elapsed = Date.now() - t0;
  // 串行至少 3×200=600ms，并行应约 200ms 多一点
  assert.ok(elapsed < 550, `应并行执行，实际耗时 ${elapsed}ms（串行会超过 600ms）`);
  assert.ok(Math.max(...started) - Math.min(...started) < 100, '各通道应几乎同时发起');
});

test('探测竞速：全部通道失败时返回明确原因，不抛异常也不假装成功', async () => {
  const f = fakeFetch({ default: { throw: 'ENOTFOUND api.github.com' } });
  const r = await up.probeLatest({ channels: up.buildProbeChannels(), fetchImpl: f.impl, timeoutMs: 300 });
  assert.equal(r.ok, false);
  assert.ok(r.error.length > 0);
  assert.ok(r.attempts.every(a => a.ok === false));
  assert.ok(r.attempts.length >= 3, '应记录每个通道的失败情况供诊断');
});

test('探测竞速：HTTP 404（仓库还没建 Release）被当作通道失败并记录', async () => {
  const f = fakeFetch({ default: { ok: false, status: 404, body: { message: 'Not Found' } } });
  const r = await up.probeLatest({ channels: up.buildProbeChannels(), fetchImpl: f.impl });
  assert.equal(r.ok, false);
  assert.ok(r.attempts.some(a => a.error.includes('404')));
});

test('探测竞速：onChannel 回调逐通道上报结果，供 UI 展示每条通道状态', async () => {
  const seen = [];
  const f = fakeFetch({
    'api.github.com/repos/sml1145/AIshipin/releases/latest': { body: apiRelease('v1.1') },
    default: { ok: false, status: 404 }
  });
  await up.probeLatest({
    channels: up.buildProbeChannels(), fetchImpl: f.impl,
    onChannel: (label, rec) => seen.push({ label, ok: rec.ok })
  });
  assert.equal(seen.length, 3, '三条通道都应上报');
  assert.ok(seen.some(s => s.ok === true));
  assert.ok(seen.some(s => s.ok === false));
});

test('探测竞速：无通道配置或无 fetch 时给出明确错误', async () => {
  const r1 = await up.probeLatest({ channels: [], fetchImpl: async () => ({}) });
  assert.equal(r1.ok, false);
  assert.ok(r1.error.includes('未配置'));
  const r2 = await up.probeLatest({ channels: up.buildProbeChannels(), fetchImpl: null });
  assert.equal(r2.ok, false);
});

/* ============ 阶段2：版本比对 ============ */

test('版本比对：远端更新时判定需要更新', () => {
  const rel = up.parseGithubApi(apiRelease('v1.1'));
  const d = up.decideUpdate({ currentVersion: '1.0.0', release: rel });
  assert.equal(d.needUpdate, true);
  assert.equal(d.current, '1.0');
  assert.equal(d.latest, '1.1');
  assert.ok(d.message.includes('1.1'));
  assert.ok(d.message.includes('2026-10-15'), '应告知发布时间');
});

test('版本比对关键：1.9 → 2.0 必须判定为需要更新（十进制进位语义）', () => {
  const rel = up.parseGithubApi(apiRelease('v2.0'));
  const d = up.decideUpdate({ currentVersion: '1.9.0', release: rel });
  assert.equal(d.needUpdate, true, '1.9 到 2.0 是真升级');
  assert.equal(d.current, '1.9');
  assert.equal(d.latest, '2.0');
});

test('版本比对：已是最新时明确告知，不触发下载', () => {
  const rel = up.parseGithubApi(apiRelease('v1.0'));
  const d = up.decideUpdate({ currentVersion: '1.0.0', release: rel });
  assert.equal(d.needUpdate, false);
  assert.ok(d.message.includes('已是最新'));
});

test('版本比对：本地版本高于远端（开发中）时不降级', () => {
  const rel = up.parseGithubApi(apiRelease('v1.0'));
  const d = up.decideUpdate({ currentVersion: '1.3.0', release: rel });
  assert.equal(d.needUpdate, false, '绝不能提示"更新"到更旧版本');
});

test('版本比对：显示名一律两段，绝不出现 1.10', () => {
  for (const [cur, tag] of [['1.0.0', 'v1.1'], ['1.9.0', 'v2.0'], ['2.0.0', 'v2.1']]) {
    const d = up.decideUpdate({ currentVersion: cur, release: up.parseGithubApi(apiRelease(tag)) });
    assert.ok(/^\d+\.\d+$/.test(d.latest), `显示名应为两段: ${d.latest}`);
    assert.ok(/^\d+\.\d+$/.test(d.current));
    assert.ok(!d.latest.includes('.10'));
  }
});

/* ============ 端到端：探测→比对→挑安装包 ============ */

test('端到端：从探测到确定要下载的安装包名与地址', async () => {
  const f = fakeFetch({
    'api.github.com/repos/sml1145/AIshipin/releases/latest': {
      body: apiRelease('v1.1', [
        { name: 'HuanXiangShiKe-Setup-1.1.0.exe', size: 251658240, browser_download_url: 'https://github.com/sml1145/AIshipin/releases/download/v1.1/HuanXiangShiKe-Setup-1.1.0.exe' },
        { name: 'latest.yml', size: 400, browser_download_url: 'https://github.com/sml1145/AIshipin/releases/download/v1.1/latest.yml' }
      ])
    },
    default: { ok: false, status: 404 }
  });
  const probe = await up.probeLatest({ channels: up.buildProbeChannels(), fetchImpl: f.impl });
  assert.equal(probe.ok, true);
  const decision = up.decideUpdate({ currentVersion: '1.0.0', release: probe.release });
  assert.equal(decision.needUpdate, true);
  const assetName = up.pickInstallerName(probe.release, decision.latest);
  assert.equal(assetName, 'HuanXiangShiKe-Setup-1.1.0.exe');
  const dl = up.buildDownloadChannels({ tag: probe.release.tag, assetName });
  assert.equal(dl[0].url, probe.release.assets[0].downloadUrl);
});

test('端到端关键：主通道全挂时仍能经 HTML 兜底完成探测并推导下载地址', async () => {
  const f = fakeFetch({
    'api.github.com': { throw: 'ENOTFOUND' },
    'github.com/sml1145/AIshipin/releases/latest': { body: '<a href="/releases/tag/v1.6">x</a>' }
  });
  const probe = await up.probeLatest({ channels: up.buildProbeChannels(), fetchImpl: f.impl, timeoutMs: 500 });
  assert.equal(probe.ok, true);
  assert.equal(probe.release.version, '1.6');
  assert.equal(probe.release.fromHtml, true);
  const d = up.decideUpdate({ currentVersion: '1.0.0', release: probe.release });
  assert.equal(d.needUpdate, true);
  // HTML 兜底没有资产列表，必须能按命名规则推导出文件名
  const assetName = up.pickInstallerName(probe.release, d.latest);
  assert.equal(assetName, 'HuanXiangShiKe-Setup-1.6.0.exe');
  const dl = up.buildDownloadChannels({ tag: probe.release.tag, assetName });
  assert.ok(dl[0].url.includes('/releases/download/v1.6/HuanXiangShiKe-Setup-1.6.0.exe'));
});
