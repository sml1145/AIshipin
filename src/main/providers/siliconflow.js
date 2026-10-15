'use strict';

/**
 * SiliconFlow（硅基流动）Provider
 *
 * 依据官方文档（2026-10-15 核实，api-docs.siliconflow.cn）：
 *   提交：POST /v1/video/submit
 *     Header: Authorization: Bearer <key>, Content-Type: application/json
 *     Body: { model, prompt, image_size, image?, negative_prompt?, seed? }
 *       - image_size 必填，仅接受 "1280x720" | "720x1280" | "960x960"
 *       - image 支持 "data:image/png;base64,XXX" 或图片 URL（本地图生视频首选此通道）
 *     Response: { requestId }   ← requestId 有效期 10 分钟
 *   查询：POST /v1/video/status   Body: { requestId }
 *     Response: { status: 'Succeed'|'InQueue'|'InProgress'|'Failed', reason?, results?: { videos: [{url}], timings, seed } }
 *     视频 URL 有效期 1 小时，必须立即下载落盘
 *
 * 实测教训：/v1/videos/generations 返回 404，正确路径是 /v1/video/submit。
 */

const fs = require('node:fs');
const path = require('node:path');
const { BaseProvider, TASK_STATUS, ERROR_CODE, ProviderError } = require('./base.js');
const { httpRequest, fileToDataUrl } = require('../http.js');
const { downloadFile } = require('../downloader.js');

const BASE_URL = 'https://api.siliconflow.cn';
const SUBMIT_PATH = '/v1/video/submit';
const STATUS_PATH = '/v1/video/status';

/** 官方状态 → 内部状态 */
const STATUS_MAP = {
  Succeed: TASK_STATUS.SUCCEEDED,
  InQueue: TASK_STATUS.PENDING,
  InProgress: TASK_STATUS.RUNNING,
  Failed: TASK_STATUS.FAILED
};

/** 官方仅接受这三种分辨率 */
const VALID_SIZES = ['1280x720', '720x1280', '960x960'];

/** 按用户请求的宽高比选官方支持的 image_size */
function pickImageSize(want) {
  if (VALID_SIZES.includes(want)) return want;
  const w = String(want || '1280x720');
  if (w === '9:16' || w === 'vertical' || w === 'portrait') return '720x1280';
  if (w === '1:1' || w === 'square') return '960x960';
  return '1280x720';
}

class SiliconFlowProvider extends BaseProvider {
  constructor(opts = {}) {
    super({ name: 'siliconflow', track: 'cloud', ...opts });
    this.getApiKey = opts.getApiKey || (() => null);
    this.outputDir = opts.outputDir;
    this.fetchImpl = opts.fetchImpl || null;
    this.modelIds = [];
  }

  async probeAvailability() {
    const key = this.getApiKey();
    if (!key) return { available: false, reason: '未配置 SiliconFlow API Key', code: ERROR_CODE.NO_KEY };
    try {
      const res = await httpRequest({
        url: `${BASE_URL}${STATUS_PATH}`,
        method: 'POST',
        headers: { Authorization: `Bearer ${key}` },
        body: { requestId: 'connectivity-probe' },
        timeoutMs: 8000, retries: 0, fetchImpl: this.fetchImpl
      });
      return { available: true, reason: '端点可达', status: res.status };
    } catch (err) {
      if (err && err.status) {
        const authBad = err.status === 401 || err.status === 403;
        return {
          available: !authBad,
          reason: authBad ? `API Key 无效（HTTP ${err.status}）` : '端点可达',
          code: authBad ? ERROR_CODE.AUTH_FAILED : undefined
        };
      }
      return { available: false, reason: `端点不可达：${String(err.message || err).slice(0, 120)}`, code: ERROR_CODE.UNREACHABLE };
    }
  }

  async createTask(req = {}) {
    const key = this.getApiKey();
    if (!key) throw new ProviderError('未配置 SiliconFlow API Key', { code: ERROR_CODE.NO_KEY, retryable: false, provider: this.name });
    const model = req.modelId || req.model;
    if (!model) throw new ProviderError('缺少 model 参数', { code: ERROR_CODE.MODEL_NOT_FOUND, retryable: false, provider: this.name });

    const body = {
      model,
      prompt: req.prompt || '',
      image_size: pickImageSize(req.imageSize || req.ratio)
    };
    if (req.negativePrompt) body.negative_prompt = req.negativePrompt;
    if (req.seed != null) body.seed = req.seed;

    // 图生视频：本地图片转 base64 data URL（官方明确支持）
    if (req.imagePath) {
      if (/^https?:\/\//i.test(req.imagePath)) {
        body.image = req.imagePath;
      } else if (fs.existsSync(req.imagePath)) {
        body.image = fileToDataUrl(req.imagePath).dataUrl;
      } else {
        throw new ProviderError(`图片文件不存在: ${req.imagePath}`, { code: ERROR_CODE.TASK_FAILED, retryable: false, provider: this.name });
      }
    }

    const taskId = this._newTaskId('sf');
    this._progress(taskId, { id: taskId, status: TASK_STATUS.PENDING, progress: 0, provider: this.name, track: this.track, modelId: model, message: '正在向 SiliconFlow 提交任务…' });

    try {
      const res = await httpRequest({
        url: `${BASE_URL}${SUBMIT_PATH}`,
        method: 'POST',
        headers: { Authorization: `Bearer ${key}` },
        body, timeoutMs: 30000, fetchImpl: this.fetchImpl
      });
      const requestId = res.json && res.json.requestId;
      if (!requestId) {
        throw new ProviderError(`SiliconFlow 未返回 requestId，响应：${JSON.stringify(res.json || res.text).slice(0, 300)}`, { code: ERROR_CODE.TASK_FAILED, provider: this.name });
      }
      this._progress(taskId, { status: TASK_STATUS.PENDING, progress: 5, remoteTaskId: requestId, message: '任务已提交（requestId 有效期 10 分钟），排队中…' });
      return { taskId, remoteTaskId: requestId, isSelfTest: false };
    } catch (err) {
      const norm = this._normalizeError(err, 'SiliconFlow 提交失败');
      this._progress(taskId, { status: TASK_STATUS.FAILED, error: norm.message, errorCode: norm.code });
      throw norm;
    }
  }

  async pollTask(taskId) {
    const t = this.tasks.get(taskId);
    if (!t) throw new ProviderError(`任务不存在: ${taskId}`, { code: ERROR_CODE.TASK_FAILED, retryable: false });
    if ([TASK_STATUS.SUCCEEDED, TASK_STATUS.FAILED, TASK_STATUS.CANCELLED].includes(t.status)) return { ...t };
    const key = this.getApiKey();
    if (!key) throw new ProviderError('未配置 SiliconFlow API Key', { code: ERROR_CODE.NO_KEY, retryable: false });
    if (!t.remoteTaskId) return { ...t };

    try {
      const res = await httpRequest({
        url: `${BASE_URL}${STATUS_PATH}`,
        method: 'POST',
        headers: { Authorization: `Bearer ${key}` },
        body: { requestId: t.remoteTaskId },
        timeoutMs: 20000, retries: 1, fetchImpl: this.fetchImpl
      });
      const data = res.json || {};
      const status = STATUS_MAP[data.status] || TASK_STATUS.PENDING;

      if (status === TASK_STATUS.SUCCEEDED) {
        const videoUrl = data.results && data.results.videos && data.results.videos[0] && data.results.videos[0].url;
        if (!videoUrl) {
          this._progress(taskId, { status: TASK_STATUS.FAILED, error: '成功但未返回视频 URL', errorCode: ERROR_CODE.TASK_FAILED });
          return { ...this.tasks.get(taskId) };
        }
        this._progress(taskId, { status: TASK_STATUS.RUNNING, progress: 90, message: '生成完成，正在下载视频（URL 1 小时内有效）…', videoUrl });
        await this._downloadResult(taskId, videoUrl);
        return { ...this.tasks.get(taskId) };
      }
      if (status === TASK_STATUS.FAILED) {
        const reason = data.reason || 'SiliconFlow 任务失败';
        this._progress(taskId, { status: TASK_STATUS.FAILED, error: reason, errorCode: this._mapFailReason(reason), message: `生成失败：${reason}` });
        return { ...this.tasks.get(taskId) };
      }
      this._progress(taskId, {
        status,
        progress: t.progress && t.progress >= 50 ? t.progress : Math.min(80, (t.progress || 5) + 5),
        message: data.status === 'InQueue' ? '排队中…' : '正在生成…'
      });
      return { ...this.tasks.get(taskId) };
    } catch (err) {
      throw this._normalizeError(err, 'SiliconFlow 轮询失败');
    }
  }

  _mapFailReason(reason) {
    const r = String(reason || '').toLowerCase();
    if (/insufficient|balance|quota|欠费/.test(r)) return ERROR_CODE.NO_QUOTA;
    if (/content|policy|sensitive|违规|敏感/.test(r)) return ERROR_CODE.CONTENT_REJECTED;
    if (/overload|50505/.test(r)) return ERROR_CODE.RATE_LIMITED;
    return ERROR_CODE.TASK_FAILED;
  }

  async _downloadResult(taskId, videoUrl) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const destPath = path.join(this.outputDir, `siliconflow_${stamp}_${taskId.slice(-6)}.mp4`);
    try {
      const r = await downloadFile({ url: videoUrl, destPath, fetchImpl: this.fetchImpl, retries: 2 });
      this._progress(taskId, {
        status: TASK_STATUS.SUCCEEDED, progress: 100, message: '视频已下载到本地',
        result: {
          localPath: destPath, videoUrl: `file:///${destPath.replace(/\\/g, '/')}`,
          remoteUrl: videoUrl, modelId: this.tasks.get(taskId).modelId, provider: this.name,
          track: this.track, isSelfTest: false, bytes: r.bytes, createdAt: Date.now()
        }
      });
    } catch (err) {
      this._progress(taskId, { status: TASK_STATUS.FAILED, error: `视频下载失败：${err.message}`, errorCode: ERROR_CODE.TASK_FAILED, remoteVideoUrl: videoUrl });
    }
  }
}

module.exports = { SiliconFlowProvider, BASE_URL, STATUS_MAP, VALID_SIZES, pickImageSize };
