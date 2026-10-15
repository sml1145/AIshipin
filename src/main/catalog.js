'use strict';

/**
 * 模型能力库加载与远程热更新
 *
 * 加载优先级：
 *   1. userData 里的缓存副本（远程热更新来的，最新）
 *   2. 随包分发的 models.json（离线兜底，永远可用）
 *
 * 远程热更新：从 sml1145/AIshipin 拉最新 models.json，多源竞速 + schemaVersion 校验。
 * 失败时静默降级到本地副本，绝不让软件因为拉不到远程而不可用。
 */

const fs = require('node:fs');

const DEFAULT_TIMEOUT_MS = 8000;

/** 读取随包的 models.json */
function loadBundled(catalogPath) {
  const raw = fs.readFileSync(catalogPath, 'utf8');
  const parsed = JSON.parse(raw);
  validateCatalog(parsed, catalogPath);
  return parsed;
}

/** 结构校验：缺关键字段就抛错，避免半残的能力库把路由带崩 */
function validateCatalog(catalog, source) {
  const where = source ? `（来源 ${source}）` : '';
  if (!catalog || typeof catalog !== 'object') {
    throw new Error(`模型库不是合法对象${where}`);
  }
  if (typeof catalog.schemaVersion !== 'number') {
    throw new Error(`模型库缺 schemaVersion${where}`);
  }
  if (!Array.isArray(catalog.models) || catalog.models.length === 0) {
    throw new Error(`模型库 models 为空${where}`);
  }
  if (!catalog.intents || typeof catalog.intents !== 'object') {
    throw new Error(`模型库缺 intents${where}`);
  }
  for (const m of catalog.models) {
    if (!m.id || !m.track || !Array.isArray(m.inputs)) {
      throw new Error(`模型库存在字段缺失的模型${where}: ${JSON.stringify(m && m.id)}`);
    }
  }
  return true;
}

/** 读取远程热更新的缓存副本；损坏则返回 null（不抛错，降级到随包版本） */
function loadCached(cachedPath) {
  try {
    if (!fs.existsSync(cachedPath)) return null;
    const parsed = JSON.parse(fs.readFileSync(cachedPath, 'utf8'));
    validateCatalog(parsed, cachedPath);
    return parsed;
  } catch {
    return null;
  }
}

/**
 * 加载能力库：缓存优先，随包兜底
 * @returns {{catalog:object, source:'cached'|'bundled', warning:string|null}}
 */
function load({ catalogBundled, catalogCached }) {
  const cached = catalogCached ? loadCached(catalogCached) : null;
  if (cached) {
    return { catalog: cached, source: 'cached', warning: null };
  }
  try {
    return { catalog: loadBundled(catalogBundled), source: 'bundled', warning: null };
  } catch (e) {
    throw new Error(`无法加载模型能力库：${e.message}`);
  }
}

/**
 * 从远程拉取最新能力库（多源竞速）
 * @param {object} opts
 * @param {string[]} opts.urls 候选源
 * @param {number} [opts.localSchemaVersion] 本地版本号，远端必须 >= 才接受
 * @param {typeof fetch} [opts.fetchImpl] 注入以便测试
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{ok:boolean, catalog?:object, url?:string, error?:string}>}
 */
async function fetchRemote({ urls, localSchemaVersion = 0, fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const doFetch = fetchImpl || globalThis.fetch;
  if (!doFetch) {
    return { ok: false, error: '当前运行时不支持 fetch' };
  }
  if (!Array.isArray(urls) || urls.length === 0) {
    return { ok: false, error: '未配置远程源' };
  }

  const attempt = async (url) => {
    const res = await doFetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'cache-control': 'no-cache' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const parsed = JSON.parse(text);
    validateCatalog(parsed, url);
    if (parsed.schemaVersion < localSchemaVersion) {
      throw new Error(`远程 schemaVersion(${parsed.schemaVersion}) 低于本地(${localSchemaVersion})，可能是旧缓存`);
    }
    return { url, catalog: parsed };
  };

  // 并行竞速，取最先成功且校验通过者
  const results = await Promise.allSettled(urls.map(attempt));
  for (const r of results) {
    if (r.status === 'fulfilled') return { ok: true, ...r.value };
  }
  const errs = results
    .filter(r => r.status === 'rejected')
    .map(r => String(r.reason && r.reason.message ? r.reason.message : r.reason));
  return { ok: false, error: errs.join(' | ') || '全部远程源失败' };
}

/**
 * 尝试热更新：拉远程 → 校验 → 写缓存
 * @returns {Promise<{updated:boolean, catalog:object, source:string, message:string}>}
 */
async function refresh({ paths, fetchImpl, timeoutMs }) {
  const current = load({ catalogBundled: paths.catalogBundled, catalogCached: paths.catalogCached });
  const remoteUrls = (current.catalog.remoteSource && current.catalog.remoteSource.urls) || [];

  const res = await fetchRemote({
    urls: remoteUrls,
    localSchemaVersion: current.catalog.schemaVersion || 0,
    fetchImpl,
    timeoutMs
  });

  if (!res.ok) {
    return {
      updated: false,
      catalog: current.catalog,
      source: current.source,
      message: `远程更新不可用，使用本地能力库（${current.source}）。原因：${res.error}`
    };
  }

  // 内容有变化才写盘，避免无意义 IO
  const changed = JSON.stringify(res.catalog) !== JSON.stringify(current.catalog);
  if (changed) {
    fs.mkdirSync(require('node:path').dirname(paths.catalogCached), { recursive: true });
    fs.writeFileSync(paths.catalogCached, JSON.stringify(res.catalog, null, 2), 'utf8');
  }
  return {
    updated: changed,
    catalog: res.catalog,
    source: 'remote',
    message: changed
      ? `模型能力库已热更新（schemaVersion ${res.catalog.schemaVersion}），新增/调整了模型擅长领域`
      : '模型能力库已是最新'
  };
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  load,
  loadBundled,
  loadCached,
  validateCatalog,
  fetchRemote,
  refresh
};
