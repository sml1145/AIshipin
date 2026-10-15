'use strict';

/**
 * Provider 抽象层
 *
 * 所有生成通道（云端 A 轨、本地 B 轨、Mock 自检）都实现同一套接口，
 * 上层路由与任务管理完全不感知具体是哪家，便于扩展与降级。
 *
 * 统一接口：
 *   probeAvailability()  → {available:boolean, reason?:string, models?:string[]}
 *   createTask(req)      → {taskId}
 *   pollTask(taskId)     → {status:'pending'|'running'|'succeeded'|'failed', progress?:number, message?:string, videoUrl?:string}
 *   fetchResult(taskId)  → {localPath, durationSec, resolution, ...}
 *   cancelTask(taskId)   → {cancelled:boolean}
 *
 * 设计要点：
 *   - 一律异步任务模型（云端本身就是异步轮询，本地推理也是长任务）
 *   - progress 用 0-100，UI 直接画进度条
 *   - 每个 Provider 自报 supports(modelId)，路由据此过滤
 */

const TASK_STATUS = Object.freeze({
  PENDING: 'pending',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELLED: 'cancelled'
});

/** 输入类型常量，与 models.json 的 inputs 字段对齐 */
const INPUT = Object.freeze({
  T2V: 't2v',
  I2V: 'i2v',
  AUDIO: 'audio',
  FIRST_LAST_FRAME: 'first_last_frame'
});

class ProviderError extends Error {
  /**
   * @param {string} message
   * @param {object} [opts]
   * @param {string} [opts.code] 机器可读错误码，UI 据此给出针对性建议
   * @param {boolean} [opts.retryable] 是否值得重试/降级
   * @param {string} [opts.provider]
   */
  constructor(message, opts = {}) {
    super(message);
    this.name = 'ProviderError';
    this.code = opts.code || 'PROVIDER_ERROR';
    this.retryable = opts.retryable !== false;
    this.provider = opts.provider || null;
    this.detail = opts.detail || null;
  }
}

/** 错误码枚举：UI 据此给出人话建议，而不是把原始报错甩给用户 */
const ERROR_CODE = Object.freeze({
  NO_KEY: 'NO_KEY',
  NO_QUOTA: 'NO_QUOTA',
  UNREACHABLE: 'UNREACHABLE',
  AUTH_FAILED: 'AUTH_FAILED',
  MODEL_NOT_FOUND: 'MODEL_NOT_FOUND',
  RATE_LIMITED: 'RATE_LIMITED',
  CONTENT_REJECTED: 'CONTENT_REJECTED',
  OUT_OF_MEMORY: 'OUT_OF_MEMORY',
  DISK_FULL: 'DISK_FULL',
  TIMEOUT: 'TIMEOUT',
  TASK_FAILED: 'TASK_FAILED',
  NOT_INSTALLED: 'NOT_INSTALLED',
  CANCELLED: 'CANCELLED',
  // 通用兜底码：Provider 未注册等编排层异常。必须显式定义，
  // 否则 humanizeError 与 RETRYABLE_CODES 引用 ERROR_CODE.PROVIDER_ERROR 会得到 undefined，
  // 使这类可降级错误被误判为终止类而不再尝试下一个候选。
  PROVIDER_ERROR: 'PROVIDER_ERROR'
});

/**
 * Provider 基类
 */
class BaseProvider {
  /**
   * @param {object} opts
   * @param {string} opts.name       通道标识，与 models.json 的 provider 字段对应
   * @param {string} opts.track      'cloud' | 'local' | 'mock'
   * @param {Function} [opts.emit]   进度回调 (taskId, {status, progress, message})
   * @param {Function} [opts.log]
   */
  constructor({ name, track, emit = null, log = null }) {
    this.name = name;
    this.track = track;
    this._emit = emit;
    this._log = log || (() => {});
    /** @type {Map<string, object>} taskId -> 任务状态 */
    this.tasks = new Map();
  }

  /** 是否支持某个模型 id */
  supports(modelId) {
    return (this.modelIds || []).includes(modelId);
  }

  /** 探测可用性：网络可达性 + 密钥 + 依赖是否就绪 */
  async probeAvailability() {
    throw new Error(`${this.constructor.name} 未实现 probeAvailability()`);
  }

  /** 从通道拉取真实可用模型清单（用户要求："模型从接口上拉取"） */
  async listModels() {
    return { ok: true, models: this.modelIds || [], fromRemote: false };
  }

  async createTask() {
    throw new Error(`${this.constructor.name} 未实现 createTask()`);
  }

  async pollTask(taskId) {
    const t = this.tasks.get(taskId);
    if (!t) {
      throw new ProviderError(`任务不存在: ${taskId}`, { code: ERROR_CODE.TASK_FAILED, retryable: false });
    }
    return { ...t };
  }

  async fetchResult(taskId) {
    const t = this.tasks.get(taskId);
    if (!t) {
      throw new ProviderError(`任务不存在: ${taskId}`, { code: ERROR_CODE.TASK_FAILED, retryable: false });
    }
    if (t.status !== TASK_STATUS.SUCCEEDED) {
      throw new ProviderError(`任务尚未成功（当前 ${t.status}），无法取结果`, { code: ERROR_CODE.TASK_FAILED, retryable: true });
    }
    return t.result || null;
  }

  async cancelTask(taskId) {
    const t = this.tasks.get(taskId);
    if (!t) return { cancelled: false, reason: '任务不存在' };
    t.status = TASK_STATUS.CANCELLED;
    return { cancelled: true };
  }

  /** 统一的进度上报，保证 UI 拿到一致的数据结构 */
  _progress(taskId, patch) {
    const t = this.tasks.get(taskId) || { id: taskId };
    Object.assign(t, patch);
    this.tasks.set(taskId, t);
    if (this._emit) {
      try {
        this._emit(taskId, { id: taskId, ...patch });
      } catch (e) {
        this._log('progress emit failed', e);
      }
    }
    return t;
  }

  /** 生成稳定的任务 id */
  _newTaskId(prefix = 'task') {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  /** 把原始错误规范化成 ProviderError，避免上层拿到一堆异构异常 */
  _normalizeError(err, context) {
    if (err instanceof ProviderError) return err;
    const msg = String((err && err.message) || err || '未知错误');
    let code = ERROR_CODE.TASK_FAILED;
    let retryable = true;

    if (/401|403|unauthoriz|invalid api key|auth/i.test(msg)) {
      code = ERROR_CODE.AUTH_FAILED; retryable = false;
    } else if (/429|rate.?limit|too many|throttl/i.test(msg)) {
      code = ERROR_CODE.RATE_LIMITED;
    } else if (/quota|余额|insufficient|欠费|arrears/i.test(msg)) {
      code = ERROR_CODE.NO_QUOTA; retryable = false;
    } else if (/out of memory|oom|cuda.*memory|显存/i.test(msg)) {
      code = ERROR_CODE.OUT_OF_MEMORY;
    } else if (/no space|disk full|磁盘/i.test(msg)) {
      code = ERROR_CODE.DISK_FULL; retryable = false;
    } else if (/timeout|timed out|超时/i.test(msg)) {
      code = ERROR_CODE.TIMEOUT;
    } else if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|network|fetch failed|证书|certificate/i.test(msg)) {
      code = ERROR_CODE.UNREACHABLE;
    } else if (/green|sensitive|违规|敏感|content.*polic/i.test(msg)) {
      code = ERROR_CODE.CONTENT_REJECTED; retryable = false;
    } else if (/404|not found|模型不存在/i.test(msg)) {
      code = ERROR_CODE.MODEL_NOT_FOUND;
    }

    return new ProviderError(context ? `${context}: ${msg}` : msg, {
      code, retryable, provider: this.name, detail: msg
    });
  }
}

/** 给 UI 的人话建议：把错误码翻译成用户能行动的提示 */
function humanizeError(err) {
  const map = {
    [ERROR_CODE.NO_KEY]: '该通道还没配置 API Key。请到「设置」里填入对应平台的密钥，或切换到本地免密钥生成。',
    [ERROR_CODE.NO_QUOTA]: '该通道额度已用完或账户欠费。可换其他云端通道，或切换到本地免密钥生成（不花钱）。',
    [ERROR_CODE.UNREACHABLE]: '该通道当前网络不可达。已自动尝试其他通道；若都不可用，可切换到本地免密钥生成。',
    [ERROR_CODE.AUTH_FAILED]: 'API Key 无效或已过期，请核对后重新填写。',
    [ERROR_CODE.MODEL_NOT_FOUND]: '通道里没有这个模型，或模型名需要按你的控制台实际可用清单调整。请到「设置 → 模型」核对模型 ID。',
    [ERROR_CODE.RATE_LIMITED]: '请求过于频繁被限流，稍等片刻会自动重试。',
    [ERROR_CODE.CONTENT_REJECTED]: '内容被平台安全策略拒绝，请调整描述后重试。',
    [ERROR_CODE.OUT_OF_MEMORY]: '显存不足（OOM）。已尝试降低分辨率/步数；若仍失败，建议改用云端通道或选择更小的本地模型。',
    [ERROR_CODE.DISK_FULL]: '磁盘空间不足，请清理后重试。',
    [ERROR_CODE.TIMEOUT]: '生成超时。任务可能仍在服务端进行，可稍后重试或换更快的通道。',
    [ERROR_CODE.NOT_INSTALLED]: '本地模型包尚未安装。请到「本地模型」页一键下载（约 9GB，需 ≥20GB 磁盘空闲）。',
    [ERROR_CODE.CANCELLED]: '任务已按你的操作取消，未产生费用。可修改描述后重新提交，或切换到其他通道再生成。',
    // 通用兜底码也要给可行动的建议，不能让用户看到"未知错误"
    [ERROR_CODE.PROVIDER_ERROR]: '生成过程中出现异常。已自动尝试降级到其他通道；若仍失败，请检查网络与设置，或切换到本地免密钥生成。',
    [ERROR_CODE.TASK_FAILED]: '该生成任务未成功完成。已自动尝试降级到其他通道；若仍失败，请查看「任务记录」里的详细原因，或换一条描述重试。'
  };
  const code = (err && err.code) || ERROR_CODE.TASK_FAILED;
  const base = map[code];
  const raw = err && err.message ? String(err.message) : '';
  if (!base) {
    return `生成失败：${raw || '未知错误'}。可尝试切换其他通道或本地免密钥生成。`;
  }
  // 附上原始报错的关键部分，方便用户反馈时能定位，但不把长堆栈甩到界面上
  return raw && raw.length < 160 ? `${base}\n（详细：${raw}）` : base;
}

module.exports = {
  BaseProvider,
  ProviderError,
  TASK_STATUS,
  INPUT,
  ERROR_CODE,
  humanizeError
};
