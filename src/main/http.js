'use strict';

/**
 * 共享 HTTP 层：超时、重试、JSON 解析、错误规范化
 *
 * 所有云端通道都走这里，避免每个 Provider 各写一套 fetch 逻辑。
 * 关键点：
 *   - 一律带超时，绝不让请求无限挂着（长任务靠轮询，不靠长连接）
 *   - 只重试可重试的错误（网络抖动、5xx、429），4xx 鉴权类错误不重试
 *   - 把非 2xx 的响应体尽量解析出来，因为平台把真实原因放在 body 里
 */

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_RETRIES = 2;
const RETRY_DELAY_MS = 1500;

/**
 * 默认 fetch 实现：
 *   在 Electron 主进程中优先使用 net.fetch —— 它走 Chromium 网络栈，
 *   使用操作系统证书存储与系统代理。
 *
 *   为什么必须这样（本机实测教训）：某些企业/远程网络存在 TLS 拦截，
 *   其根证书只存在于 Windows 证书存储，而 Node 原生 fetch(undici) 使用自带
 *   CA 束，会报 UNABLE_TO_VERIFY_LEAF / fetch failed；gh 与 PowerShell 却正常。
 *   若沿用原生 fetch，软件在这类网络上所有云端调用与更新都会失败。
 *   非 Electron 环境（单元测试）回退到 globalThis.fetch。
 */
function getDefaultFetch() {
  try {
    // eslint-disable-next-line global-require
    const { net } = require('electron');
    if (net && typeof net.fetch === 'function' && process.type === 'browser') {
      return (url, init) => net.fetch(url, init);
    }
  } catch { /* 非 Electron 环境 */ }
  return globalThis.fetch;
}

/** 判断 HTTP 状态码是否值得重试 */
function isRetryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

/** 判断异常是否值得重试（网络层错误） */
function isRetryableError(err) {
  const msg = String((err && err.message) || err || '');
  return /ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|EPIPE|socket hang up|fetch failed|network|TimeoutError|aborted/i.test(msg);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/** 从任意响应体里尽力提取人类可读的错误信息 */
function extractErrorText(body) {
  if (body == null) return '';
  if (typeof body === 'string') return body.slice(0, 600);
  if (typeof body === 'object') {
    const candidates = [body.message, body.msg, body.error && body.error.message, body.error, body.code, body.reason, body.detail];
    for (const c of candidates) {
      if (typeof c === 'string' && c.trim()) return c.slice(0, 600);
      if (typeof c === 'number') return String(c);
      if (c && typeof c === 'object' && c.message) return String(c.message).slice(0, 600);
    }
    try {
      return JSON.stringify(body).slice(0, 600);
    } catch {
      return '';
    }
  }
  return String(body).slice(0, 600);
}

/**
 * 带超时与重试的 HTTP 请求
 * @param {object} opts
 * @param {string} opts.url
 * @param {string} [opts.method]
 * @param {object} [opts.headers]
 * @param {object|string} [opts.body] 对象会自动 JSON 序列化
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.retries]
 * @param {Function} [opts.fetchImpl] 注入以便测试
 * @param {Function} [opts.onRetry] (attempt, err) => void
 * @returns {Promise<{status:number, ok:boolean, json:any|null, text:string, headers:object}>}
 */
async function httpRequest(opts) {
  const {
    url,
    method = 'GET',
    headers = {},
    body,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = DEFAULT_RETRIES,
    fetchImpl,
    onRetry = null
  } = opts;

  const doFetch = fetchImpl || getDefaultFetch();
  if (!doFetch) throw new Error('当前运行时不支持 fetch（需要 Node 18+ 或 Electron 主进程）');

  const finalHeaders = { ...headers };
  let payload;
  if (body !== undefined && body !== null) {
    if (typeof body === 'string') {
      payload = body;
    } else {
      payload = JSON.stringify(body);
      if (!Object.keys(finalHeaders).some(k => k.toLowerCase() === 'content-type')) {
        finalHeaders['Content-Type'] = 'application/json';
      }
    }
  }

  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await doFetch(url, {
        method,
        headers: finalHeaders,
        body: payload,
        signal: AbortSignal.timeout(timeoutMs)
      });

      const text = await res.text();
      let json = null;
      if (text) {
        try { json = JSON.parse(text); } catch { json = null; }
      }

      if (res.ok) {
        return { status: res.status, ok: true, json, text, headers: headersToObject(res.headers) };
      }

      // 非 2xx：可重试状态码则重试，否则立刻抛出带响应体信息的错误
      const errText = extractErrorText(json) || extractErrorText(text) || `HTTP ${res.status}`;
      if (isRetryableStatus(res.status) && attempt < retries) {
        lastErr = new Error(`${errText} (HTTP ${res.status})`);
        lastErr.status = res.status;
        lastErr.body = json;
        if (onRetry) onRetry(attempt + 1, lastErr);
        await sleep(RETRY_DELAY_MS * (attempt + 1));
        continue;
      }
      const e = new Error(`${errText} (HTTP ${res.status})`);
      e.status = res.status;
      e.body = json;
      e.retryable = isRetryableStatus(res.status);
      throw e;
    } catch (err) {
      // 已经带 status 的是上面主动抛出的 HTTP 错误，不再当网络错误重试
      if (err && err.status && !isRetryableStatus(err.status)) throw err;
      lastErr = err;
      if (!isRetryableError(err) && !(err && err.status)) throw err;
      if (attempt < retries) {
        if (onRetry) onRetry(attempt + 1, err);
        await sleep(RETRY_DELAY_MS * (attempt + 1));
        continue;
      }
    }
  }
  throw lastErr || new Error('请求失败：未知原因');
}

function headersToObject(h) {
  const out = {};
  if (!h) return out;
  try {
    if (typeof h.forEach === 'function') {
      h.forEach((v, k) => { out[k] = v; });
      return out;
    }
    return { ...h };
  } catch {
    return out;
  }
}

/** 便捷 JSON POST */
function postJson(url, body, opts = {}) {
  return httpRequest({ url, method: 'POST', body, ...opts });
}

/** 便捷 JSON GET */
function getJson(url, opts = {}) {
  return httpRequest({ url, method: 'GET', ...opts });
}

/**
 * 探测端点可达性：只关心能不能连通，不关心业务结果。
 * 401/403/404 都说明网络可达（是鉴权或路径问题），只有连接层失败才算不可达。
 */
async function probeEndpoint(url, { timeoutMs = 8000, fetchImpl } = {}) {
  try {
    const res = await httpRequest({
      url, method: 'GET', timeoutMs, retries: 0, fetchImpl,
      // 探测允许任何状态码，不抛错
      ...(fetchImpl ? {} : {})
    });
    return { reachable: true, status: res.status };
  } catch (err) {
    if (err && err.status) return { reachable: true, status: err.status };
    return { reachable: false, error: String((err && err.message) || err).slice(0, 200) };
  }
}

/**
 * 把本地图片文件读成 data URL（base64）
 * SiliconFlow 官方文档明确支持 data:image/png;base64,XXX 形式
 */
function fileToDataUrl(filePath, fs = require('node:fs')) {
  const ext = String(filePath).toLowerCase().split('.').pop();
  const mimeMap = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp' };
  const mime = mimeMap[ext] || 'image/png';
  const buf = fs.readFileSync(filePath);
  return { dataUrl: `data:${mime};base64,${buf.toString('base64')}`, mime, bytes: buf.length };
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_RETRIES,
  isRetryableStatus,
  isRetryableError,
  extractErrorText,
  httpRequest,
  postJson,
  getJson,
  probeEndpoint,
  fileToDataUrl,
  headersToObject,
  getDefaultFetch
};
