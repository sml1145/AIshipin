'use strict';

/**
 * 任务编排器 —— 软件真正干活的地方
 *
 * 职责：把用户的「图片 + 描述」变成一段视频，全程可解释、可降级、不假装成功。
 *
 * 主流程 submit()：
 *   1. 归一化请求（图片路径、时长、比例、是否离线）
 *   2. 调路由引擎选出首选模型 + 完整降级链（reasons 全程可见）
 *   3. 若用户要「多模型搭配/分镜」→ 走 compose()，否则走单模型 runSingle()
 *   4. 按降级链逐个尝试：每个模型经其 Provider 提交→轮询→取结果
 *      某个模型失败（额度耗尽/不可达/超时/OOM）→ 记录原因 → 自动切下一个
 *   5. 全部失败 → 明确报告每个模型为什么失败，并给可行动建议；绝不静默返回假成功
 *
 * 关键原则：
 *   - 降级只在"可重试类"错误时发生（网络/额度/限流/超时/OOM）；
 *     内容审核拒绝、参数非法这类换模型也没用的错误，直接终止并如实告知
 *   - 每步都发 progress 事件，UI 能实时看到"正在用哪个模型、第几次尝试、为什么换"
 */

const path = require('node:path');
const { TASK_STATUS, ERROR_CODE, ProviderError, humanizeError } = require('./providers/base.js');
const routerCore = require('./router-core.js');
const { concatVideos } = require('./ffmpeg.js');

/** 换模型重试是否有意义：这些错误码值得降级，其余直接终止 */
const RETRYABLE_CODES = new Set([
  ERROR_CODE.NO_KEY, ERROR_CODE.NO_QUOTA, ERROR_CODE.UNREACHABLE,
  ERROR_CODE.RATE_LIMITED, ERROR_CODE.OUT_OF_MEMORY, ERROR_CODE.TIMEOUT,
  ERROR_CODE.MODEL_NOT_FOUND, ERROR_CODE.PROVIDER_ERROR, ERROR_CODE.TASK_FAILED,
  ERROR_CODE.NOT_INSTALLED
]);
/** 这些错误换模型也没用，直接终止（如实告知用户，不浪费额度） */
const TERMINAL_CODES = new Set([
  ERROR_CODE.CONTENT_REJECTED, ERROR_CODE.AUTH_FAILED, ERROR_CODE.DISK_FULL, ERROR_CODE.CANCELLED
]);

class Orchestrator {
  /**
   * @param {object} opts
   * @param {object} opts.catalog models.json 内容
   * @param {Map<string, object>} opts.providers provider 名 → Provider 实例
   * @param {object} opts.paths paths.js 结果
   * @param {Function} opts.getHardware 返回最新硬件探测结果
   * @param {Function} opts.getProviderStatus 返回 {name: {reachable, hasKey}}
   * @param {Function} [opts.getLocalModelsInstalled] 返回已安装本地模型 id 列表
   * @param {Function} [opts.emit] (taskId, state) => void 进度回调
   * @param {number} [opts.pollIntervalMs] 轮询间隔
   * @param {number} [opts.pollTimeoutMs] 单任务轮询超时
   * @param {Function} [opts.sleepImpl] 注入以便测试
   */
  constructor(opts = {}) {
    this.catalog = opts.catalog;
    this.providers = opts.providers;
    this.paths = opts.paths;
    this.getHardware = opts.getHardware || (() => ({ vramGB: 0, ramGB: 0, diskFreeGB: 0 }));
    this.getProviderStatus = opts.getProviderStatus || (() => ({}));
    this.getLocalModelsInstalled = opts.getLocalModelsInstalled || (() => []);
    this.emit = opts.emit || (() => {});
    this.pollIntervalMs = opts.pollIntervalMs || 3000;
    this.pollTimeoutMs = opts.pollTimeoutMs || 30 * 60 * 1000;
    this.sleep = opts.sleepImpl || ((ms) => new Promise(r => setTimeout(r, ms)));
    /** @type {Map<string, object>} taskId → 任务状态 */
    this.tasks = new Map();
    /** 已取消的任务集合 */
    this.cancelled = new Set();
  }

  _emit(taskId, patch) {
    const t = this.tasks.get(taskId) || { id: taskId, attempts: [] };
    Object.assign(t, patch);
    this.tasks.set(taskId, t);
    try { this.emit(taskId, { id: taskId, ...patch }); } catch { /* UI 回调异常不阻断生成 */ }
    return t;
  }

  /**
   * 构造路由上下文
   */
  _buildRouteContext(req) {
    const hardware = this.getHardware();
    const providers = this.getProviderStatus();
    const localModelsInstalled = this.getLocalModelsInstalled();
    return {
      hasImage: Boolean(req.imagePath || req.firstFramePath),
      hasAudio: Boolean(req.audioPath),
      hasReference: Boolean((req.referenceImages && req.referenceImages.length) || req.hasReference),
      hasVideoInput: Boolean(req.videoPath || req.hasVideoInput),
      wantFirstLastFrame: Boolean(req.lastFramePath || req.wantFirstLastFrame),
      wantVertical: Boolean(req.wantVertical),
      wantLongDuration: Boolean(req.wantLongDuration),
      offlineOnly: Boolean(req.offlineOnly),
      hardware: {
        vramGB: hardware.vramGB || 0,
        ramGB: hardware.totalRamGB || hardware.ramGB || 0,
        diskFreeGB: hardware.diskFreeGB || 0
      },
      localModelsInstalled,
      providers
    };
  }

  /**
   * 提交生成请求（对外主入口）
   * @param {object} req
   * @param {string} req.prompt 用户描述
   * @param {string} [req.imagePath] 本地图片路径（图生视频）
   * @param {string} [req.lastFramePath] 尾帧（首尾帧）
   * @param {string} [req.audioPath] 音频（音频驱动）
   * @param {string} [req.videoPath] 待编辑/参考视频
   * @param {number} [req.durationSec]
   * @param {string} [req.ratio] 宽高比，如 '9:16'
   * @param {boolean} [req.offlineOnly] 强制离线
   * @param {string} [req.forceModelId] 用户手动指定模型，跳过自动路由的首选（仍保留降级）
   * @param {string[]} [req.segments] 分镜提示词数组，提供则走多模型搭配
   * @returns {Promise<object>} 最终结果
   */
  async submit(req = {}) {
    const taskId = this._newTaskId();
    this.cancelled.delete(taskId);
    this._emit(taskId, {
      id: taskId, status: TASK_STATUS.PENDING, progress: 0,
      prompt: req.prompt || '', createdAt: Date.now(), attempts: []
    });
    // 立即通知界面 taskId，使"取消"在长任务开始后即可用（submit 要 await 到结束才返回）
    this._emit(taskId, { event: 'created', id: taskId });

    const context = this._buildRouteContext(req);
    const routeResult = routerCore.route({ prompt: req.prompt || '', catalog: this.catalog, context });

    // 把选型理由立即回传，UI 展示"选了哪个模型、为什么"
    this._emit(taskId, {
      status: TASK_STATUS.PENDING, progress: 3,
      routing: {
        selected: routeResult.selected ? routeResult.selected.id : null,
        selectedName: routeResult.selected ? routeResult.selected.name : null,
        chain: routeResult.chain.map(m => ({ id: m.id, name: m.name, track: m.track, provider: m.provider, score: m.finalScore })),
        rejected: routeResult.rejected,
        intents: routeResult.intents,
        explanation: routeResult.explanation
      },
      message: routeResult.selected ? `已选定模型：${routeResult.selected.name}` : '没有可用模型'
    });

    if (!routeResult.selected) {
      const result = {
        ok: false, taskId, status: TASK_STATUS.FAILED,
        message: '没有可用的生成模型：云端通道缺 Key 或不可达，本地模型包也未安装。',
        routing: this.tasks.get(taskId).routing,
        suggestion: '请在「设置」里配置任一云端 API Key，或在「本地模型」页下载本地模型包（约 9GB，之后可离线免费生成）。'
      };
      this._emit(taskId, result);
      return result;
    }

    try {
      // 多模型搭配（分镜）
      if (Array.isArray(req.segments) && req.segments.length > 1) {
        return await this._compose(taskId, req, routeResult, context);
      }
      // 单模型 + 降级链
      return await this._runWithFallback(taskId, req, routeResult);
    } catch (err) {
      const result = {
        ok: false, taskId, status: TASK_STATUS.FAILED,
        message: `生成过程异常：${String(err.message || err)}`,
        routing: this.tasks.get(taskId).routing
      };
      this._emit(taskId, result);
      return result;
    }
  }

  /**
   * 按降级链逐个尝试，直到成功或全部失败
   */
  async _runWithFallback(taskId, req, routeResult) {
    // 用户手动指定模型时，把它提到链首（仍保留其余作为降级）
    let chain = routeResult.chain;
    if (req.forceModelId) {
      const forced = chain.find(m => m.id === req.forceModelId);
      if (forced) {
        chain = [forced, ...chain.filter(m => m.id !== req.forceModelId)];
      }
    }

    const attempts = [];
    for (let i = 0; i < chain.length; i++) {
      const model = chain[i];
      if (this.cancelled.has(taskId)) {
        return this._cancelled(taskId, attempts);
      }

      this._emit(taskId, {
        status: TASK_STATUS.RUNNING, progress: 5 + Math.floor((i / chain.length) * 10),
        currentModel: model.id, currentModelName: model.name, currentTrack: model.track,
        attemptIndex: i + 1, attemptTotal: chain.length,
        message: `正在用「${model.name}」生成（第 ${i + 1}/${chain.length} 个候选）…`
      });

      const attempt = { index: i + 1, modelId: model.id, modelName: model.name, track: model.track, provider: model.provider, startedAt: Date.now() };
      try {
        const result = await this._runSingleModel(taskId, req, model, attempt);
        attempts.push({ ...attempt, ok: true });
        this._emit(taskId, { attempts });
        // 成功
        return {
          ok: true, taskId, status: TASK_STATUS.SUCCEEDED, progress: 100,
          result: { ...result, modelId: model.id, modelName: model.name, track: model.track, isSelfTest: result.isSelfTest === true },
          routing: this.tasks.get(taskId).routing,
          attempts,
          usedFallback: i > 0,
          message: i > 0
            ? `已用「${model.name}」生成成功（前面 ${i} 个候选失败后自动降级）`
            : `已用「${model.name}」生成成功`
        };
      } catch (err) {
        const code = err.code || ERROR_CODE.TASK_FAILED;
        const retryable = RETRYABLE_CODES.has(code) && !TERMINAL_CODES.has(code);
        attempts.push({ ...attempt, ok: false, error: String(err.message || err), errorCode: code, retryable, hint: humanizeError(err) });
        this._emit(taskId, { attempts, message: `「${model.name}」失败（${code}），${retryable && i < chain.length - 1 ? '自动尝试下一个候选…' : '无法继续降级'}` });

        // 终止类错误：换模型也没用，立即停止并如实告知
        if (!retryable) {
          return {
            ok: false, taskId, status: TASK_STATUS.FAILED,
            message: `生成失败且无法通过换模型解决：${humanizeError(err)}`,
            errorCode: code, routing: this.tasks.get(taskId).routing, attempts,
            stoppedAt: model.id
          };
        }
        // 还有候选就继续降级
        if (i < chain.length - 1) continue;
      }
    }

    // 全部候选都失败
    return {
      ok: false, taskId, status: TASK_STATUS.FAILED,
      message: '所有候选模型均生成失败。',
      routing: this.tasks.get(taskId).routing, attempts,
      suggestion: this._summarizeFailureSuggestion(attempts)
    };
  }

  /** 汇总所有失败原因，给出可行动建议 */
  _summarizeFailureSuggestion(attempts) {
    const codes = new Set(attempts.filter(a => !a.ok).map(a => a.errorCode));
    const parts = [];
    if (codes.has(ERROR_CODE.NO_KEY)) parts.push('多数通道未配置 API Key');
    if (codes.has(ERROR_CODE.NO_QUOTA)) parts.push('部分通道额度已用尽');
    if (codes.has(ERROR_CODE.UNREACHABLE)) parts.push('部分通道网络不可达');
    if (codes.has(ERROR_CODE.OUT_OF_MEMORY)) parts.push('本地模型显存/内存不足');
    if (codes.has(ERROR_CODE.NOT_INSTALLED)) parts.push('本地模型包尚未安装');
    const detail = parts.length ? `原因汇总：${parts.join('；')}。` : '';
    return `${detail}可在「设置」补充 API Key，或在「本地模型」页安装本地模型包后重试；若只是想验证软件是否正常，可用自检模式（Mock）跑通流程。`;
  }

  /**
   * 单个模型：提交 → 轮询 → 取结果
   */
  async _runSingleModel(taskId, req, model, attempt) {
    const provider = this.providers.get(model.provider);
    if (!provider) {
      const e = new ProviderError(`未注册 Provider: ${model.provider}`, { code: ERROR_CODE.PROVIDER_ERROR, provider: model.provider });
      throw e;
    }

    // 提交任务，带上该模型的 API 规格（分辨率/比例/时长等）
    const createReq = {
      modelId: model.modelId || model.id,
      prompt: req.prompt || '',
      imagePath: req.imagePath || req.firstFramePath || null,
      lastFramePath: req.lastFramePath || null,
      audioPath: req.audioPath || null,
      videoPath: req.videoPath || null,
      referenceImages: req.referenceImages || null,
      durationSec: this._clampDuration(req.durationSec, model),
      ratio: req.ratio || (model.api && model.api.defaultRatio) || null,
      resolution: req.resolution || (model.api && model.api.defaultResolution) || null,
      imageSize: req.imageSize || req.ratio || (model.api && model.api.defaultImageSize) || null,
      negativePrompt: req.negativePrompt || null,
      parentTaskId: taskId,
      attempt
    };

    const created = await provider.createTask(createReq);
    const remoteTaskId = created.taskId;
    attempt.remoteTaskId = remoteTaskId;

    // 轮询直到终态或超时
    const startedAt = Date.now();
    let state = await provider.pollTask(remoteTaskId);
    while (state.status === TASK_STATUS.PENDING || state.status === TASK_STATUS.RUNNING) {
      if (this.cancelled.has(taskId)) {
        await provider.cancelTask(remoteTaskId).catch(() => {});
        const e = new ProviderError('任务已被用户取消', { code: ERROR_CODE.CANCELLED, retryable: false });
        throw e;
      }
      if (Date.now() - startedAt > this.pollTimeoutMs) {
        const e = new ProviderError(`生成超时（超过 ${Math.round(this.pollTimeoutMs / 60000)} 分钟）`, { code: ERROR_CODE.TIMEOUT });
        throw e;
      }
      // 把子任务进度映射到总进度（单模型占 10%~95%）
      const subProgress = state.progress || 0;
      this._emit(taskId, {
        status: TASK_STATUS.RUNNING,
        progress: Math.min(95, 10 + Math.floor(subProgress * 0.85)),
        message: state.message || `「${model.name}」生成中… ${subProgress}%`,
        currentModel: model.id, currentModelName: model.name
      });
      await this.sleep(this.pollIntervalMs);
      state = await provider.pollTask(remoteTaskId);
    }

    if (state.status === TASK_STATUS.CANCELLED) {
      throw new ProviderError('任务被取消', { code: ERROR_CODE.CANCELLED, retryable: false });
    }
    if (state.status === TASK_STATUS.FAILED) {
      const e = new ProviderError(state.error || `${model.name} 生成失败`, {
        code: state.errorCode || ERROR_CODE.TASK_FAILED, retryable: true
      });
      throw e;
    }
    if (state.status !== TASK_STATUS.SUCCEEDED) {
      throw new ProviderError(`未知任务状态: ${state.status}`, { code: ERROR_CODE.TASK_FAILED });
    }

    const result = await provider.fetchResult(remoteTaskId);
    if (!result || !result.localPath) {
      throw new ProviderError('任务成功但未返回本地视频路径', { code: ERROR_CODE.TASK_FAILED });
    }
    this._emit(taskId, { progress: 96, message: `「${model.name}」生成完成，视频已保存到本地` });
    return result;
  }

  /**
   * 多模型搭配（分镜）：每段独立走降级链，最后拼接
   */
  async _compose(taskId, req, routeResult, context) {
    const segments = req.segments;
    const segmentResults = [];
    const allAttempts = [];

    for (let s = 0; s < segments.length; s++) {
      if (this.cancelled.has(taskId)) return this._cancelled(taskId, allAttempts);
      const segPrompt = segments[s];
      this._emit(taskId, {
        status: TASK_STATUS.RUNNING,
        progress: Math.floor((s / segments.length) * 80),
        message: `正在生成第 ${s + 1}/${segments.length} 段分镜…`,
        composePhase: 'generating', composeIndex: s + 1, composeTotal: segments.length
      });

      // 每段按自己的提示词独立路由（可能选中不同模型，实现"多模型搭配"）
      const segRoute = routerCore.route({ prompt: segPrompt, catalog: this.catalog, context });
      const segReq = { ...req, prompt: segPrompt, segments: undefined };
      const segChain = segRoute.chain;
      if (segChain.length === 0) {
        return {
          ok: false, taskId, status: TASK_STATUS.FAILED,
          message: `第 ${s + 1} 段分镜没有可用模型，无法完成多模型搭配。`,
          routing: this.tasks.get(taskId).routing, attempts: allAttempts
        };
      }

      let segOk = false;
      for (let i = 0; i < segChain.length; i++) {
        const model = segChain[i];
        const attempt = { segment: s + 1, index: i + 1, modelId: model.id, modelName: model.name, track: model.track, provider: model.provider, startedAt: Date.now() };
        try {
          const result = await this._runSingleModel(taskId, segReq, model, attempt);
          allAttempts.push({ ...attempt, ok: true });
          segmentResults.push({ index: s, prompt: segPrompt, modelId: model.id, modelName: model.name, track: model.track, localPath: result.localPath, isSelfTest: result.isSelfTest === true });
          segOk = true;
          break;
        } catch (err) {
          const code = err.code || ERROR_CODE.TASK_FAILED;
          const retryable = RETRYABLE_CODES.has(code) && !TERMINAL_CODES.has(code);
          allAttempts.push({ ...attempt, ok: false, error: String(err.message || err), errorCode: code, retryable });
          if (!retryable || i === segChain.length - 1) break;
        }
      }
      if (!segOk) {
        return {
          ok: false, taskId, status: TASK_STATUS.FAILED,
          message: `第 ${s + 1} 段分镜的所有候选模型均失败，多模型搭配中断。`,
          routing: this.tasks.get(taskId).routing, attempts: allAttempts,
          suggestion: this._summarizeFailureSuggestion(allAttempts)
        };
      }
    }

    // 拼接各段
    this._emit(taskId, { progress: 85, message: '正在拼接各段分镜…', composePhase: 'concatenating' });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outPath = path.join(this.paths.outputDir, `composed_${stamp}_${taskId.slice(-6)}.mp4`);
    try {
      const inputs = segmentResults.map(s => s.localPath);
      await concatVideos({ inputs, outputPath: outPath });
      this._emit(taskId, { progress: 100, message: '多模型搭配视频已拼接完成' });
      return {
        ok: true, taskId, status: TASK_STATUS.SUCCEEDED, progress: 100,
        result: {
          localPath: outPath, videoUrl: `file:///${outPath.replace(/\\/g, '/')}`,
          composed: true, segments: segmentResults, provider: 'multi', track: 'mixed',
          isSelfTest: segmentResults.every(s => s.isSelfTest), createdAt: Date.now()
        },
        routing: this.tasks.get(taskId).routing, attempts: allAttempts,
        message: `已用 ${new Set(segmentResults.map(s => s.modelId)).size} 个模型分段生成并拼接为一条视频（共 ${segmentResults.length} 段）`
      };
    } catch (err) {
      // 拼接失败：降级为返回各段，如实告知未自动拼接（方案里的降级路径）
      this._emit(taskId, { progress: 100, message: '拼接失败，已保留各段视频', composePhase: 'concat-failed' });
      return {
        ok: true, taskId, status: TASK_STATUS.SUCCEEDED, progress: 100,
        result: {
          composed: false, concatFailed: true, concatError: String(err.message || err),
          segments: segmentResults, isSelfTest: segmentResults.every(s => s.isSelfTest), createdAt: Date.now()
        },
        routing: this.tasks.get(taskId).routing, attempts: allAttempts,
        message: `各段已生成，但自动拼接失败（${String(err.message || err).slice(0, 100)}）。已保留 ${segmentResults.length} 段独立视频，可手动合并。`
      };
    }
  }

  /** 时长钳制到模型支持范围，避免提交注定失败的参数 */
  _clampDuration(want, model) {
    const max = model.maxDurationSec || 5;
    if (want == null) return Math.min(5, max);
    return Math.max(1, Math.min(Number(want) || 5, max));
  }

  _cancelled(taskId, attempts) {
    const result = {
      ok: false, taskId, status: TASK_STATUS.CANCELLED,
      message: '任务已取消。', errorCode: ERROR_CODE.CANCELLED,
      routing: this.tasks.get(taskId) ? this.tasks.get(taskId).routing : null,
      attempts
    };
    this._emit(taskId, result);
    return result;
  }

  /** 取消任务 */
  cancel(taskId) {
    this.cancelled.add(taskId);
    const t = this.tasks.get(taskId);
    if (t && (t.status === TASK_STATUS.PENDING || t.status === TASK_STATUS.RUNNING)) {
      this._emit(taskId, { status: TASK_STATUS.CANCELLED, message: '正在取消…' });
    }
    return { cancelled: true, taskId };
  }

  getTask(taskId) {
    return this.tasks.get(taskId) || null;
  }

  /** 预演路由（不真正生成），供 UI 在用户点"生成"前展示将用哪个模型 */
  preview(req = {}) {
    const context = this._buildRouteContext(req);
    const routeResult = routerCore.route({ prompt: req.prompt || '', catalog: this.catalog, context });
    return {
      selected: routeResult.selected ? {
        id: routeResult.selected.id, name: routeResult.selected.name,
        track: routeResult.selected.track, provider: routeResult.selected.provider,
        warning: routeResult.selected.warning, license: routeResult.selected.license
      } : null,
      chain: routeResult.chain.map(m => ({ id: m.id, name: m.name, track: m.track, score: m.finalScore })),
      rejected: routeResult.rejected,
      intents: routeResult.intents,
      explanation: routeResult.explanation
    };
  }

  _newTaskId() {
    return `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }
}

module.exports = { Orchestrator, RETRYABLE_CODES, TERMINAL_CODES };
