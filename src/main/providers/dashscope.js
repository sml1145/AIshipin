'use strict';

/**
 * DashScope（阿里云百炼 · 通义万相）Provider
 *
 * 依据官方文档（2026-10-15 核实，help.aliyun.com/zh/model-studio）：
 *   创建任务：POST /api/v1/services/aigc/video-generation/video-synthesis
 *     Header: X-DashScope-Async: enable, Authorization: Bearer <key>, Content-Type: application/json
 *     Body: { model, input: { prompt, media?: [{type, url}] }, parameters: { resolution, ratio, duration, prompt_extend, audio } }
 *   查询任务：GET /api/v1/tasks/{task_id}   Header: Authorization: Bearer <key>
 *     task_status: PENDING / RUNNING / SUCCEEDED / FAILED / UNKNOWN
 *     成功：output.video_url（有效期 24 小时）
 *
 * 关键约束（文档明确）：模型、Endpoint、API Key 必须同一地域，跨地域调用失败。
 *   默认用通用端点 dashscope.aliyuncs.com；用户可在设置里填 WorkspaceId 切到地域端点。
 *
 * 本地图片说明：官方 media[].url 示例均为 http(s)。本实现先尝试 data:base64，
 *   若通道拒绝会抛 CONTENT/参数错误，由上层提示改用 SiliconFlow（其官方支持 base64）。不假装一定成功。
 */

const fs = require('node:fs');
const { BaseProvider, TASK_STATUS, ERROR_CODE, ProviderError } = require('./base.js');
const { httpRequest, fileToDataUrl } = require('../http.js');
const { downloadFile } = require('../downloader.js');

const GENERIC_BASE = 'https://dashscope.aliyuncs.com/api/v1';
const SUBMIT_PATH = '/services/aigc/video-generation/video-synthesis';
const TASK_PATH = '/tasks/';

/** 文档核实的任务状态 → 内部状态 */
const STATUS_MAP = {
  PENDING: TASK_STATUS.PENDING,
  RUNNING: TASK_STATUS.RUNNING,
  SUCCEEDED: TASK_STATUS.SUCCEEDED,
  FAILED: TASK_STATUS.FAILED,
  UNKNOWN: TASK_STATUS.PENDING,
  CANCELED: TASK_STATUS.CANCELLED,
  SUCCEED: TASK_STATUS.SUCCEEDED
};

class DashScopeProvider extends BaseProvider {
  /**
   * @param {object} opts
   * @param {Function} opts.getApiKey 返回当前 API Key（从 safeStorage 解密）
   * @param {string} [opts.workspaceId] 填了则用地域端点
   * @param {string} opts.outputDir 视频落盘目录
   * @param {Function} [opts.fetchImpl]
   */
  constructor(opts = {}) {
    super({ name: 'dashscope', track: 'cloud', ...opts });
    this.getApiKey = opts.getApiKey || (() => null);
    this.workspaceId = opts.workspaceId || null;
    this.outputDir = opts.outputDir;
    this.fetchImpl = opts.fetchImpl || null;
    this.modelIds = [];
  }

  get baseUrl() {
    if (this.workspaceId) {
      return `https://${this.workspaceId}.cn-beijing.maas.aliyuncs.com/api/v1`;
    }
    return GENERIC_BASE;
  }

  async probeAvailability() {
    const key = this.getApiKey();
    if (!key) {
      return { available: false, reason: '未配置百炼 API Key', code: ERROR_CODE.NO_KEY };
    }
    // 轻量探测：请求任务查询端点，401/404 都说明网络可达
    try {
      const res = await httpRequest({
        url: `${this.baseUrl}${TASK_PATH}probe-connectivity-check`,
        method: 'GET',
        headers: { Authorization: `Bearer ${key}` },
        timeoutMs: 8000,
        retries: 0,
        fetchImpl: this.fetchImpl
      });
      return { available: true, reason: '端点可达', status: res.status };
    } catch (err) {
      if (err && err.status) {
        // 有 HTTP 状态码 = 网络可达（鉴权/路径问题不影响可达性判断）
        const authBad = err.status === 401 || err.status === 403;
        return {
          available: !authBad,
          reason: authBad ? `API Key 无效或已过期（HTTP ${err.status}）` : '端点可达',
          code: authBad ? ERROR_CODE.AUTH_FAILED : undefined
        };
      }
      return { available: false, reason: `端点不可达：${String(err.message || err).slice(0, 120)}`, code: ERROR_CODE.UNREACHABLE };
    }
  }

  /** 构造 media 数组：区分首帧/首尾帧/参考图/音频/视频等 */
  _buildMedia(req) {
    const media = [];
    const pushImage = (type, src) => {
      if (!src) return;
      if (/^https?:\/\//i.test(src)) {
        media.push({ type, url: src });
      } else if (fs.existsSync(src)) {
        const { dataUrl } = fileToDataUrl(src);
        media.push({ type, url: dataUrl });
      }
    };
    if (req.imagePath) pushImage('first_frame', req.imagePath);
    if (req.lastFramePath) pushImage('last_frame', req.lastFramePath);
    for (const ref of req.referenceImages || []) pushImage('reference_image', ref);
    if (req.audioPath) {
      if (/^https?:\/\//i.test(req.audioPath)) media.push({ type: 'reference_audio', url: req.audioPath });
      else if (fs.existsSync(req.audioPath)) media.push({ type: 'reference_audio', url: fileToDataUrl(req.audioPath).dataUrl });
    }
    if (req.videoPath) {
      if (/^https?:\/\//i.test(req.videoPath)) media.push({ type: 'reference_video', url: req.videoPath });
    }
    return media;
  }

  async createTask(req = {}) {
    const key = this.getApiKey();
    if (!key) {
      throw new ProviderError('未配置百炼 API Key', { code: ERROR_CODE.NO_KEY, retryable: false, provider: this.name });
    }
    const model = req.modelId || req.model;
    if (!model) {
      throw new ProviderError('缺少 model 参数', { code: ERROR_CODE.MODEL_NOT_FOUND, retryable: false, provider: this.name });
    }

    const input = { prompt: req.prompt || '' };
    const media = this._buildMedia(req);
    if (media.length > 0) input.media = media;

    const parameters = {};
    if (req.resolution) parameters.resolution = req.resolution;
    if (req.ratio) parameters.ratio = req.ratio;
    if (req.durationSec != null) parameters.duration = req.durationSec;
    if (req.promptExtend != null) parameters.prompt_extend = req.promptExtend;
    if (req.audio != null) parameters.audio = req.audio;

    const body = { model, input };
    if (Object.keys(parameters).length > 0) body.parameters = parameters;

    const taskId = this._newTaskId('ds');
    this._progress(taskId, {
      id: taskId, status: TASK_STATUS.PENDING, progress: 0, provider: this.name,
      track: this.track, modelId: model, message: '正在向百炼提交任务…'
    });

    try {
      const res = await httpRequest({
        url: `${this.baseUrl}${SUBMIT_PATH}`,
        method: 'POST',
        headers: { 'X-DashScope-Async': 'enable', Authorization: `Bearer ${key}` },
        body,
        timeoutMs: 30000,
        fetchImpl: this.fetchImpl
      });
      const remoteTaskId = res.json && (res.json.output && (res.json.output.task_id || res.json.output.taskId));
      if (!remoteTaskId) {
        throw new ProviderError(`百炼未返回 task_id，响应：${JSON.stringify(res.json || res.text).slice(0, 300)}`, {
          code: ERROR_CODE.TASK_FAILED, provider: this.name
        });
      }
      this._progress(taskId, {
        status: TASK_STATUS.PENDING, progress: 5, remoteTaskId,
        message: '任务已提交，排队中…'
      });
      return { taskId, remoteTaskId, isSelfTest: false };
    } catch (err) {
      const norm = this._normalizeError(err, 'DashScope 提交失败');
      this._progress(taskId, { status: TASK_STATUS.FAILED, error: norm.message, errorCode: norm.code });
      throw norm;
    }
  }

  async pollTask(taskId) {
    const t = this.tasks.get(taskId);
    if (!t) throw new ProviderError(`任务不存在: ${taskId}`, { code: ERROR_CODE.TASK_FAILED, retryable: false });
    if (t.status === TASK_STATUS.SUCCEEDED || t.status === TASK_STATUS.FAILED || t.status === TASK_STATUS.CANCELLED) {
      return { ...t };
    }
    const key = this.getApiKey();
    if (!key) throw new ProviderError('未配置百炼 API Key', { code: ERROR_CODE.NO_KEY, retryable: false });
    if (!t.remoteTaskId) return { ...t };

    try {
      const res = await httpRequest({
        url: `${this.baseUrl}${TASK_PATH}${t.remoteTaskId}`,
        method: 'GET',
        headers: { Authorization: `Bearer ${key}` },
        timeoutMs: 20000,
        retries: 1,
        fetchImpl: this.fetchImpl
      });
      const out = (res.json && res.json.output) || {};
      const status = STATUS_MAP[out.task_status] || TASK_STATUS.PENDING;
      const patch = { status, remoteStatus: out.task_status };

      if (status === TASK_STATUS.SUCCEEDED) {
        const videoUrl = out.video_url || out.results || (out.video && out.video.url);
        patch.progress = 90;
        patch.message = '生成完成，正在下载视频（URL 24 小时内有效）…';
        patch.videoUrl = videoUrl;
        this._progress(taskId, patch);
        await this._downloadResult(taskId, videoUrl);
        return { ...this.tasks.get(taskId) };
      }
      if (status === TASK_STATUS.FAILED) {
        const reason = out.message || out.code || '百炼任务失败';
        patch.error = reason;
        patch.errorCode = out.code && /quota|balance/i.test(String(out.code)) ? ERROR_CODE.NO_QUOTA : ERROR_CODE.TASK_FAILED;
        patch.message = `生成失败：${reason}`;
        this._progress(taskId, patch);
        return { ...this.tasks.get(taskId) };
      }
      // 进行中：给一个粗略进度
      patch.progress = t.progress && t.progress >= 50 ? t.progress : Math.min(80, (t.progress || 5) + 5);
      patch.message = out.task_status === 'RUNNING' ? '正在生成…' : '排队中…';
      this._progress(taskId, patch);
      return { ...this.tasks.get(taskId) };
    } catch (err) {
      const norm = this._normalizeError(err, 'DashScope 轮询失败');
      throw norm;
    }
  }

  async _downloadResult(taskId, videoUrl) {
    if (!videoUrl) {
      this._progress(taskId, { status: TASK_STATUS.FAILED, error: '任务成功但未返回 video_url', errorCode: ERROR_CODE.TASK_FAILED });
      return;
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const destPath = `${this.outputDir}\\dashscope_${stamp}_${taskId.slice(-6)}.mp4`;
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
      this._progress(taskId, {
        status: TASK_STATUS.FAILED, error: `视频下载失败：${err.message}`,
        errorCode: ERROR_CODE.TASK_FAILED, remoteVideoUrl: videoUrl
      });
    }
  }
}

module.exports = { DashScopeProvider, GENERIC_BASE, STATUS_MAP };
