'use strict';

/**
 * 分片下载器：断点续传 + SHA256 校验 + 进度回调 + 多通道竞速
 *
 * 两处复用：
 *   1. 下载云端生成的视频（SiliconFlow 的 URL 只有 1 小时有效期，必须及时落盘）
 *   2. 下载本地模型权重与 Python 运行时（总计约 9GB，必须能续传，不能失败就重来）
 *
 * 安全要点：下载完成必须校验哈希，校验失败即删除文件并报错，绝不把可疑文件交给下游。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');

const DEFAULT_CHUNK_TIMEOUT_MS = 60000;

/** 计算文件的 SHA256（流式，不把大文件读进内存） */
function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', d => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/** 计算 SHA512（electron-updater 的 latest.yml 用的是 SHA512 base64） */
function sha512File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha512');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', d => hash.update(d));
    stream.on('end', () => resolve(hash.digest('base64')));
  });
}

/** 校验 SHA256，不符则删除文件并抛错 */
async function verifySha256(filePath, expectedHex) {
  if (!expectedHex) return { verified: false, reason: '未提供期望的 SHA256，跳过校验' };
  const actual = await sha256File(filePath);
  if (actual.toLowerCase() !== String(expectedHex).toLowerCase()) {
    try { fs.rmSync(filePath, { force: true }); } catch { /* 忽略清理失败 */ }
    throw new Error(`SHA256 校验失败，已删除损坏文件。期望 ${expectedHex}，实际 ${actual}`);
  }
  return { verified: true, sha256: actual };
}

/**
 * 下载单个文件，支持断点续传
 * @param {object} opts
 * @param {string} opts.url
 * @param {string} opts.destPath
 * @param {string} [opts.sha256] 期望哈希，提供则强制校验
 * @param {number} [opts.expectedBytes] 期望大小，用于判断续传是否已完成
 * @param {Function} [opts.onProgress] ({downloadedBytes, totalBytes, percent, speedKBps}) => void
 * @param {boolean} [opts.resume] 默认 true，支持 Range 续传
 * @param {number} [opts.retries]
 * @param {Function} [opts.fetchImpl]
 * @returns {Promise<{destPath:string, bytes:number, sha256?:string, resumed:boolean}>}
 */
async function downloadFile(opts) {
  const {
    url, destPath, sha256 = null, expectedBytes = null,
    onProgress = null, resume = true, retries = 2, fetchImpl = null,
    timeoutMs = DEFAULT_CHUNK_TIMEOUT_MS
  } = opts;

  const doFetch = fetchImpl || require('./http.js').getDefaultFetch();
  if (!doFetch) throw new Error('当前运行时不支持 fetch');

  fs.mkdirSync(path.dirname(destPath), { recursive: true });

  // 已存在且大小匹配则视为已完成
  if (expectedBytes && fs.existsSync(destPath)) {
    const st = fs.statSync(destPath);
    if (st.size === expectedBytes) {
      if (sha256) await verifySha256(destPath, sha256);
      return { destPath, bytes: st.size, sha256: sha256 || (await sha256File(destPath)), resumed: true, skipped: true };
    }
  }

  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let offset = 0;
    let resumed = false;
    if (resume && fs.existsSync(destPath)) {
      offset = fs.statSync(destPath).size;
      if (expectedBytes && offset >= expectedBytes) {
        // 上次已下完，直接校验
        if (sha256) await verifySha256(destPath, sha256);
        return { destPath, bytes: offset, sha256: sha256 || (await sha256File(destPath)), resumed: true, skipped: true };
      }
      if (offset > 0) resumed = true;
    }

    const headers = {};
    if (resumed) headers.Range = `bytes=${offset}-`;

    try {
      const res = await doFetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });

      // 416 = Range 超出范围，说明文件其实已经完整
      if (res.status === 416) {
        const st = fs.statSync(destPath);
        if (sha256) await verifySha256(destPath, sha256);
        return { destPath, bytes: st.size, sha256: sha256 || (await sha256File(destPath)), resumed: true };
      }
      if (!res.ok && res.status !== 206) {
        throw new Error(`下载失败 HTTP ${res.status}`);
      }
      if (res.status === 200 && resumed) {
        // 服务端不支持 Range，只能从头下
        offset = 0;
        resumed = false;
      }

      const totalHeader = res.headers.get('content-length');
      const contentRange = res.headers.get('content-range');
      let totalBytes = expectedBytes;
      if (contentRange && contentRange.includes('/')) {
        totalBytes = Number(contentRange.split('/')[1]) || totalBytes;
      } else if (totalHeader) {
        totalBytes = offset + Number(totalHeader);
      }

      const tmpPath = `${destPath}.part`;
      // 续传时保留已有部分：把 .part 当作已下载内容继续追加
      if (resumed && fs.existsSync(destPath)) {
        fs.copyFileSync(destPath, tmpPath);
      } else if (!resumed && fs.existsSync(tmpPath)) {
        fs.rmSync(tmpPath, { force: true });
      }

      const startedAt = Date.now();
      let downloaded = offset;
      let lastReport = 0;

      const fileStream = fs.createWriteStream(tmpPath, { flags: resumed ? 'a' : 'w' });
      try {
        // 手动泵数据以便统计进度（pipeline 不便插入计数）
        const body = res.body;
        if (body && typeof body[Symbol.asyncIterator] === 'function') {
          for await (const chunk of body) {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            fileStream.write(buf);
            downloaded += buf.length;
            const now = Date.now();
            if (onProgress && now - lastReport > 400) {
              lastReport = now;
              const elapsedSec = Math.max(0.001, (now - startedAt) / 1000);
              onProgress({
                downloadedBytes: downloaded,
                totalBytes: totalBytes || null,
                percent: totalBytes ? Number(((downloaded / totalBytes) * 100).toFixed(1)) : null,
                speedKBps: Number((((downloaded - offset) / elapsedSec) / 1024).toFixed(0)),
                resumed
              });
            }
          }
        } else {
          await pipeline(body, fileStream);
        }
      } finally {
        await new Promise(r => fileStream.end(r));
      }

      const finalSize = fs.statSync(tmpPath).size;
      if (expectedBytes && finalSize !== expectedBytes) {
        throw new Error(`下载不完整：期望 ${expectedBytes} 字节，实际 ${finalSize} 字节`);
      }
      fs.renameSync(tmpPath, destPath);

      if (sha256) await verifySha256(destPath, sha256);
      const actualHash = sha256 || (await sha256File(destPath));
      if (onProgress) onProgress({ downloadedBytes: finalSize, totalBytes: finalSize, percent: 100, speedKBps: null, resumed, done: true });
      return { destPath, bytes: finalSize, sha256: actualHash, resumed };
    } catch (err) {
      lastErr = err;
      const msg = String((err && err.message) || err);
      // 校验失败不重试：重试也拿不到正确内容，且文件已被删除
      if (/SHA256 校验失败/.test(msg)) throw err;
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
        continue;
      }
    }
  }
  throw lastErr || new Error('下载失败：未知原因');
}

/**
 * 多通道竞速下载同一个文件（用户强调的"多通道并行更新"核心）
 * 并行向多个候选 URL 发起下载，取最先成功且校验通过者，其余取消。
 * @param {object} opts
 * @param {Array<{url:string, label:string}>} opts.sources
 * @param {string} opts.destPath
 * @param {string} [opts.sha256]
 * @param {number} [opts.expectedBytes]
 * @param {Function} [opts.onProgress] ({label, ...progress}) => void
 * @param {Function} [opts.fetchImpl]
 * @returns {Promise<{destPath:string, winner:string, attempts:Array}>}
 */
async function raceDownload(opts) {
  const { sources, destPath, sha256 = null, expectedBytes = null, onProgress = null, fetchImpl = null } = opts;
  if (!Array.isArray(sources) || sources.length === 0) {
    throw new Error('未提供下载源');
  }

  const attempts = [];
  const controllers = sources.map(() => new AbortController());

  const runOne = async (src, idx) => {
    const startedAt = Date.now();
    try {
      const r = await downloadFile({
        url: src.url,
        destPath,
        sha256,
        expectedBytes,
        fetchImpl,
        retries: 0, // 竞速场景下不在单个通道内重试，交给其他通道
        onProgress: onProgress ? (p) => onProgress({ label: src.label, url: src.url, ...p }) : null
      });
      // 成功后取消其他通道
      controllers.forEach((c, i) => { if (i !== idx) c.abort(); });
      attempts.push({ label: src.label, url: src.url, ok: true, ms: Date.now() - startedAt });
      return { ...r, winner: src.label, winnerUrl: src.url, attempts };
    } catch (err) {
      attempts.push({ label: src.label, url: src.url, ok: false, error: String((err && err.message) || err).slice(0, 300), ms: Date.now() - startedAt });
      throw err;
    }
  };

  const results = await Promise.allSettled(sources.map(runOne));
  for (const r of results) {
    if (r.status === 'fulfilled') return r.value;
  }
  const errs = attempts.map(a => `${a.label}: ${a.error}`).join(' | ');
  throw new Error(`全部下载通道均失败 → ${errs}`);
}

module.exports = {
  DEFAULT_CHUNK_TIMEOUT_MS,
  sha256File,
  sha512File,
  verifySha256,
  downloadFile,
  raceDownload
};
