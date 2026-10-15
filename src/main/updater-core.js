'use strict';

/**
 * 多通道并行更新 —— 核心逻辑层（纯函数，可注入假网络完整测试）
 *
 * 用户强调："更新功能很重要，要多通道并行更新，确保更新功能可以使用"
 *
 * 设计：
 *   阶段1 探测竞速：同时向 N 个通道问"最新版本是什么"，取最先成功者（Promise.allSettled）
 *   阶段2 版本比对：按十进制语义比较（2.0 > 1.9），不是 semver
 *   阶段3 下载竞速：同时向 M 个通道拉安装包，取最先成功且校验通过者
 *   阶段4 完整性校验：SHA512 对照 latest.yml，不符即丢弃
 *   阶段5 安装与回滚：静默安装，失败恢复备份
 *
 * 任何阶段全部失败 → 明确告知用户并给出手动下载直链，绝不静默失败。
 */

const { isNewer, extractVersionFromTag, compareVersions, formatDisplay } = require('./version-core.js');

const PROBE_TIMEOUT_MS = 8000;
const DOWNLOAD_TIMEOUT_MS = 0; // 下载不限时，靠 Range 续传兜底

/** 仓库常量 */
const REPO_OWNER = 'sml1145';
const REPO_NAME = 'AIshipin';

/**
 * 生成探测通道清单（多通道并行的"多通道"来源）
 *
 * 本机实测：api.github.com 200、github.com/.../releases/download 200、codeload 200；
 * ghfast.top 等公共加速代理实测超时 —— 仍保留在清单里，探测阶段会自动淘汰，
 * 这样换网络环境的用户也能受益。
 *
 * @param {object} [opts]
 * @param {string} [opts.owner]
 * @param {string} [opts.repo]
 * @param {string[]} [opts.extraMirrors] 用户可在设置里自行追加镜像
 */
function buildProbeChannels(opts = {}) {
  const owner = opts.owner || REPO_OWNER;
  const repo = opts.repo || REPO_NAME;
  const extra = Array.isArray(opts.extraMirrors) ? opts.extraMirrors : [];

  const channels = [
    {
      label: 'GitHub API（主通道）',
      kind: 'api',
      url: `https://api.github.com/repos/${owner}/${repo}/releases/latest`,
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'HuanXiangShiKe-Updater' },
      parser: 'githubApi',
      priority: 1
    },
    {
      label: 'GitHub Releases 页面（HTML 兜底）',
      kind: 'html',
      url: `https://github.com/${owner}/${repo}/releases/latest`,
      headers: { 'User-Agent': 'HuanXiangShiKe-Updater' },
      parser: 'githubHtml',
      priority: 2
    },
    {
      label: 'GitHub Tags 列表（无 Release 时兜底）',
      kind: 'api',
      url: `https://api.github.com/repos/${owner}/${repo}/tags?per_page=10`,
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'HuanXiangShiKe-Updater' },
      parser: 'githubTags',
      priority: 3
    }
  ];

  // 公共加速镜像：本机实测超时会被自动淘汰，但保留以适配其他网络环境
  for (const mirror of extra) {
    channels.push({
      label: `镜像（${new URL(mirror).host}）`,
      kind: 'api',
      url: mirror.replace(/\/$/, '') + `/${owner}/${repo}/releases/latest`,
      headers: { Accept: 'application/vnd.github+json' },
      parser: 'githubApi',
      priority: 4
    });
  }

  return channels;
}

/**
 * 生成安装包下载通道清单（多通道并行下载）
 * @param {object} params
 * @param {string} params.tag Release tag，如 "v1.1"
 * @param {string} params.assetName 安装包文件名
 * @param {string[]} [params.extraMirrors]
 */
function buildDownloadChannels({ tag, assetName, owner = REPO_OWNER, repo = REPO_NAME, extraMirrors = [] }) {
  const direct = `https://github.com/${owner}/${repo}/releases/download/${encodeURIComponent(tag)}/${assetName}`;
  const channels = [
    { label: 'GitHub Releases 直连', url: direct, priority: 1, kind: 'direct' },
    {
      label: 'GitHub API 资产地址',
      url: `https://api.github.com/repos/${owner}/${repo}/releases/assets/by-name/${assetName}`,
      headers: { Accept: 'application/octet-stream', 'User-Agent': 'HuanXiangShiKe-Updater' },
      priority: 2, kind: 'apiAsset'
    }
  ];
  for (const m of extraMirrors) {
    channels.push({
      label: `镜像下载（${new URL(m).host}）`,
      url: m.replace(/\/$/, '') + `/${owner}/${repo}/releases/download/${encodeURIComponent(tag)}/${assetName}`,
      priority: 3, kind: 'mirror'
    });
  }
  return channels;
}

/* ============ 响应解析 ============ */

/** 解析 GitHub API 的 releases/latest 响应 */
function parseGithubApi(json) {
  if (!json || typeof json !== 'object') throw new Error('响应不是合法 JSON 对象');
  // 严格只认 tag_name：name 是 Release 标题（显示名），从中提取版本可能得到错误值
  const tag = json.tag_name;
  if (!tag) throw new Error('响应缺少 tag_name');
  const version = extractVersionFromTag(tag);
  if (!version) throw new Error(`无法从 tag 提取版本号: ${tag}`);
  const assets = Array.isArray(json.assets) ? json.assets : [];
  return {
    tag,
    version,
    releaseName: json.name || tag,
    publishedAt: json.published_at || null,
    notes: json.body || '',
    htmlUrl: json.html_url || null,
    assets: assets.map(a => ({
      name: a.name,
      size: a.size,
      downloadUrl: a.browser_download_url,
      // 用于校验：latest.yml 里带 sha512
      isInstaller: /\.(exe|msi)$/i.test(a.name || ''),
      isManifest: /^latest\.yml$/i.test(a.name || '')
    }))
  };
}

/** 解析 GitHub Releases 页面 HTML（API 被限流时的兜底） */
function parseGithubHtml(html, url) {
  const text = String(html || '');
  // releases/latest 会 302 到 /releases/tag/<tag>
  let tag = null;
  const m = text.match(/\/releases\/tag\/([^"'\s?]+)/);
  if (m) tag = decodeURIComponent(m[1]);
  if (!tag) throw new Error('HTML 中未找到 release tag');
  const version = extractVersionFromTag(tag);
  if (!version) throw new Error(`无法从 tag 提取版本号: ${tag}`);
  return {
    tag, version,
    releaseName: tag,
    publishedAt: null, notes: '',
    htmlUrl: url || null,
    assets: [], // HTML 解析不逐个抓资产，下载阶段用固定命名规则拼
    fromHtml: true
  };
}

/** 解析 tags 列表（仓库有 tag 但没建 Release 时的兜底） */
function parseGithubTags(json) {
  if (!Array.isArray(json) || json.length === 0) throw new Error('tags 列表为空');
  // 按十进制版本语义取最大
  let best = null;
  for (const t of json) {
    const v = extractVersionFromTag(t.name);
    if (!v) continue;
    if (!best || compareVersions(v, best.version) > 0) best = { tag: t.name, version: v };
  }
  if (!best) throw new Error('tags 中没有可识别的版本号');
  return { tag: best.tag, version: best.version, releaseName: best.tag, publishedAt: null, notes: '', htmlUrl: null, assets: [], fromTags: true };
}

/**
 * 解析 latest.yml（electron-builder 产出，含 SHA512 与文件名）
 * 不引入 yaml 依赖，用最小解析器读取所需字段。
 */
function parseLatestYml(text) {
  const out = { version: null, sha512: null, path: null, releaseDate: null, files: [] };
  const lines = String(text || '').split(/\r?\n/);
  let inFile = null;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line || line.trimStart().startsWith('#')) continue;
    const m = line.match(/^(\s*)([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!m) continue;
    const [, indent, key, val] = m;
    const clean = val.replace(/^["']|["']$/g, '');
    if (indent.length === 0) {
      if (key === 'version') out.version = clean;
      else if (key === 'sha512') out.sha512 = clean;
      else if (key === 'path') out.path = clean;
      else if (key === 'releaseDate') out.releaseDate = clean;
      inFile = null;
    } else if (key === 'url' && inFile !== null && out.files[inFile]) {
      out.files[inFile].url = clean;
    } else if (key === 'sha512' && inFile !== null && out.files[inFile]) {
      out.files[inFile].sha512 = clean;
    } else if (key === 'size' && inFile !== null && out.files[inFile]) {
      out.files[inFile].size = Number(clean) || null;
    } else if (indent.length <= 2 && /\.(exe|msi|zip|blockmap)$/i.test(clean)) {
      // files 列表项：以 "- path: xxx" 或 "- url: xxx" 开头
      out.files.push({ path: clean, url: null, sha512: null, size: null });
      inFile = out.files.length - 1;
    }
  }
  if (!out.version) throw new Error('latest.yml 缺少 version 字段');
  return out;
}

/**
 * 从 Release 信息中挑出安装包资产名
 * 规则：优先 latest.yml 里的 path；否则找 .exe（排除 blockmap）；否则用固定命名规则
 */
function pickInstallerName(release, fallbackVersion) {
  if (release && release.installerName) return release.installerName;
  const assets = (release && release.assets) || [];
  const manifest = assets.find(a => a.isManifest);
  const exe = assets.filter(a => a.isInstaller && !/blockmap$/i.test(a.name));
  if (exe.length > 0) return exe[0].name;
  if (manifest) return null; // 有 manifest 但没 exe，交给下载 manifest 后再定
  const v = (release && release.version) || fallbackVersion;
  return v ? `HuanXiangShiKe-Setup-${v.split('.').slice(0, 2).join('.')}.0.exe` : null;
}

/* ============ 阶段1：探测竞速 ============ */

/**
 * 并行向所有通道探测最新版本，取最先成功者
 * @param {object} opts
 * @param {object[]} opts.channels
 * @param {Function} opts.fetchImpl
 * @param {number} [opts.timeoutMs]
 * @param {Function} [opts.onChannel] (label, result) => void  每个通道的结果回调（UI 展示用）
 * @returns {Promise<{ok:boolean, release?:object, winner?:object, attempts:object[], error?:string}>}
 */
async function probeLatest(opts) {
  const { channels, fetchImpl, timeoutMs = PROBE_TIMEOUT_MS, onChannel = null } = opts;
  if (!Array.isArray(channels) || channels.length === 0) {
    return { ok: false, attempts: [], error: '未配置任何更新通道' };
  }
  const doFetch = fetchImpl || globalThis.fetch;
  if (!doFetch) return { ok: false, attempts: [], error: '当前运行时不支持 fetch' };

  const attempts = [];

  const probeOne = async (ch) => {
    const startedAt = Date.now();
    try {
      const res = await doFetch(ch.url, {
        headers: ch.headers || {},
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      let release;
      if (ch.parser === 'githubApi') release = parseGithubApi(JSON.parse(text));
      else if (ch.parser === 'githubHtml') release = parseGithubHtml(text, ch.url);
      else if (ch.parser === 'githubTags') release = parseGithubTags(JSON.parse(text));
      else throw new Error(`未知解析器: ${ch.parser}`);

      const rec = { label: ch.label, url: ch.url, ok: true, version: release.version, ms: Date.now() - startedAt };
      attempts.push(rec);
      if (onChannel) onChannel(ch.label, rec);
      return { release, channel: ch, attempt: rec };
    } catch (err) {
      const rec = {
        label: ch.label, url: ch.url, ok: false,
        error: String((err && err.message) || err).slice(0, 200), ms: Date.now() - startedAt
      };
      attempts.push(rec);
      if (onChannel) onChannel(ch.label, rec);
      throw err;
    }
  };

  // 真并行：allSettled 后按 priority 与耗时挑最优
  const results = await Promise.allSettled(channels.map(probeOne));
  const fulfilled = [];
  for (let i = 0; i < results.length; i++) {
    if (results[i].status === 'fulfilled') fulfilled.push(results[i].value);
  }
  if (fulfilled.length === 0) {
    return { ok: false, attempts, error: attempts.map(a => `${a.label}: ${a.error}`).join(' | ') };
  }
  // 版本必须一致，若不一致取最大版本（防止镜像滞后）
  fulfilled.sort((a, b) => {
    const c = compareVersions(b.release.version, a.release.version);
    if (c !== 0) return c;
    return (a.channel.priority || 9) - (b.channel.priority || 9);
  });
  const winner = fulfilled[0];
  return { ok: true, release: winner.release, winner: winner.channel, attempts };
}

/* ============ 阶段2：版本比对 ============ */

/**
 * 判断是否需要更新
 * @returns {{needUpdate:boolean, current:string, latest:string, release:object, message:string}}
 */
function decideUpdate({ currentVersion, release }) {
  const latest = release.version;
  const cur = formatDisplay(require('./version-core.js').parseVersion(currentVersion));
  const lat = formatDisplay(require('./version-core.js').parseVersion(latest));
  if (isNewer(latest, currentVersion)) {
    return {
      needUpdate: true, current: cur, latest: lat, release,
      message: `发现新版本 ${lat}（当前 ${cur}），可以更新。${release.publishedAt ? '发布于 ' + release.publishedAt.slice(0, 10) + '。' : ''}`
    };
  }
  return {
    needUpdate: false, current: cur, latest: lat, release,
    message: `当前已是最新版本 ${cur}。`
  };
}

module.exports = {
  REPO_OWNER, REPO_NAME, PROBE_TIMEOUT_MS, DOWNLOAD_TIMEOUT_MS,
  buildProbeChannels, buildDownloadChannels,
  parseGithubApi, parseGithubHtml, parseGithubTags, parseLatestYml,
  pickInstallerName, probeLatest, decideUpdate
};
