'use strict';

/**
 * LocalProvider —— 本地免密钥推理（B 轨）
 *
 * 职责：spawn Python sidecar 子进程跑推理，按行解析其 JSON 事件协议，
 *       映射到统一的 Provider 任务状态；支持取消（kill 子进程）与超时。
 *
 * 协议（与 src/local/infer_ltx.py 约定）：
 *   stdout 逐行 JSON：
 *     {"event":"progress","step","total","percent","message"}
 *     {"event":"log","level","message"}
 *     {"event":"done","path","seconds","width","height","dryRun"}
 *     {"event":"error","code","message"}
 *   退出码：0 成功 / 2 OOM / 3 依赖或缺模型 / 4 参数错误 / 1 其他
 *
 * 诚实边界：真实 GPU 推理需 CUDA + 已下载权重，无法在无 GPU/无权重环境验证；
 *   --dry-run 走完整协议产出占位视频（明确标注 dryRun），用于验证编排与协议解析。
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const { BaseProvider, TASK_STATUS, ERROR_CODE, ProviderError } = require('./base.js');

/** Python 退出码 → 内部错误码 */
const EXIT_CODE_MAP = {
  0: null,
  1: ERROR_CODE.TASK_FAILED,
  2: ERROR_CODE.OUT_OF_MEMORY,
  3: ERROR_CODE.NOT_INSTALLED,
  4: ERROR_CODE.TASK_FAILED
};

class LocalProvider extends BaseProvider {
  /**
   * @param {object} opts
   * @param {object} opts.paths paths.js 结果
   * @param {Function} [opts.resolvePython] 返回 python 可执行路径；默认自动探测
   * @param {Function} [opts.spawnImpl] 注入以便测试
   * @param {string} [opts.scriptPath] 推理脚本路径；默认按打包/开发态推导
   */
  constructor(opts = {}) {
    super({ name: 'local', track: 'local', ...opts });
    this.paths = opts.paths;
    this._spawn = opts.spawnImpl || spawn;
    this._resolvePython = opts.resolvePython || (() => this.defaultResolvePython());
    this.scriptPath = opts.scriptPath || this.defaultScriptPath();
    this.modelIds = [];
    /** @type {Map<string, import('child_process').ChildProcess>} taskId → 子进程句柄，供取消 */
    this._children = new Map();
  }

  defaultScriptPath() {
    // 打包后 extraResources 解包到 resources/local；开发态在 src/local
    if (this.paths && this.paths.localScriptsDir && fs.existsSync(path.join(this.paths.localScriptsDir, 'infer_ltx.py'))) {
      return path.join(this.paths.localScriptsDir, 'infer_ltx.py');
    }
    return path.join(__dirname, '..', '..', 'local', 'infer_ltx.py');
  }

  /**
   * 探测可用的 Python：应用下载的 embeddable → 已知开发态 python → 系统 PATH
   * @returns {string|null}
   */
  defaultResolvePython() {
    const candidates = [];
    if (this.paths) {
      candidates.push(path.join(this.paths.pythonDir, 'python.exe'));
    }
    // 开发态：uv 管理的 python（本机实测存在）
    const uvPy = path.join(os.homedir(), 'AppData', 'Roaming', 'uv', 'python');
    if (fs.existsSync(uvPy)) {
      try {
        for (const d of fs.readdirSync(uvPy)) {
          const p = path.join(uvPy, d, 'python.exe');
          if (fs.existsSync(p)) candidates.push(p);
        }
      } catch { /* 忽略枚举失败 */ }
    }
    candidates.push('python'); // 系统 PATH 兜底
    for (const c of candidates) {
      if (c === 'python') return c; // PATH 兜底，交给 spawn 解析
      if (fs.existsSync(c)) return c;
    }
    return null;
  }

  async probeAvailability() {
    const py = this._resolvePython();
    if (!py) {
      return { available: false, reason: '未找到可用的 Python 运行时，请在「本地模型」页下载运行时', code: ERROR_CODE.NOT_INSTALLED };
    }
    if (!fs.existsSync(this.scriptPath) && !this._spawn.__stub) {
      return { available: false, reason: `推理脚本缺失: ${this.scriptPath}`, code: ERROR_CODE.NOT_INSTALLED };
    }
    return { available: true, reason: 'Python 运行时就绪', python: py };
  }

  /**
   * 创建本地推理任务：spawn python 子进程，流式解析事件
   * @param {object} req modelId, prompt, imagePath, outputPath, modelRoot, frames, width, height, dryRun 等
   */
  async createTask(req = {}) {
    const py = this._resolvePython();
    if (!py) {
      throw new ProviderError('未找到可用的 Python 运行时', { code: ERROR_CODE.NOT_INSTALLED, retryable: false, provider: this.name });
    }
    if (!req.prompt) {
      throw new ProviderError('缺少提示词', { code: ERROR_CODE.TASK_FAILED, retryable: false, provider: this.name });
    }

    const taskId = this._newTaskId('local');
    const outputPath = req.outputPath || path.join(
      this.paths ? this.paths.outputDir : os.tmpdir(),
      `local_${Date.now().toString(36)}_${taskId.slice(-6)}.mp4`
    );

    // 请求经 @文件 传给 Python，避免超长命令行与转义问题
    const reqFile = path.join(os.tmpdir(), `hxsk_req_${taskId}.json`);
    const requestObj = {
      prompt: req.prompt,
      outputPath,
      modelKind: req.modelKind || 'ltx',
      weights: { root: req.modelRoot || (this.paths ? path.join(this.paths.modelsDir, req.modelId || 'local-ltx-2b-fp8') : null) },
      negativePrompt: req.negativePrompt,
      width: req.width, height: req.height, frames: req.frames,
      steps: req.steps, guidance: req.guidance, seed: req.seed,
      imagePath: req.imagePath || undefined,
      quantization: req.quantization || 'fp8'
    };
    fs.writeFileSync(reqFile, JSON.stringify(requestObj), 'utf8');

    this._progress(taskId, {
      id: taskId, status: TASK_STATUS.RUNNING, progress: 0, provider: this.name,
      track: this.track, modelId: req.modelId || null, message: '正在启动本地推理…',
      isSelfTest: Boolean(req.dryRun)
    });

    const args = [this.scriptPath, '--request', `@${reqFile}`];
    if (req.dryRun) args.push('--dry-run');

    // 后台执行：spawn 后立即返回 taskId，子进程事件异步更新 this.tasks，
    // 与云端 Provider 的异步任务模型一致，pollTask 读状态、cancelTask 可 kill 子进程。
    let child;
    try {
      child = this._spawn(py, args, { windowsHide: true });
    } catch (err) {
      this._cleanup(reqFile);
      const e = this._normalizeError(err, '无法启动本地推理进程');
      this._progress(taskId, { status: TASK_STATUS.FAILED, error: e.message, errorCode: e.code });
      throw e;
    }
    this._children.set(taskId, child);

    let stdoutBuf = '';
    let stderrBuf = '';

    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        stdoutBuf += chunk.toString();
        let idx;
        while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
          const line = stdoutBuf.slice(0, idx).trim();
          stdoutBuf = stdoutBuf.slice(idx + 1);
          if (line) this._handleEvent(taskId, line);
        }
      });
    }
    if (child.stderr) {
      child.stderr.on('data', (chunk) => { stderrBuf += chunk.toString(); });
    }

    child.on('error', (err) => {
      const e = this._normalizeError(err, '本地推理进程错误');
      this._progress(taskId, { status: TASK_STATUS.FAILED, error: e.message, errorCode: e.code });
      this._children.delete(taskId);
      this._cleanup(reqFile);
    });

    child.on('close', (code) => {
      if (stdoutBuf.trim()) this._handleEvent(taskId, stdoutBuf.trim());
      const t = this.tasks.get(taskId) || {};
      this._children.delete(taskId);
      this._cleanup(reqFile);
      if (t.status === TASK_STATUS.SUCCEEDED || t.status === TASK_STATUS.CANCELLED) return;
      const mapped = EXIT_CODE_MAP[code] || ERROR_CODE.TASK_FAILED;
      const detail = (stderrBuf || '').trim().slice(-400) || `python 退出码 ${code}`;
      this._progress(taskId, {
        status: TASK_STATUS.FAILED,
        error: t.error || `本地推理失败：${detail}`,
        errorCode: t.errorCode || mapped
      });
    });

    return { taskId, isSelfTest: Boolean(req.dryRun) };
  }

  /** 解析一行 JSON 事件并更新任务状态 */
  _handleEvent(taskId, line) {
    let ev;
    try { ev = JSON.parse(line); } catch {
      // 非 JSON 行（如 Python traceback）作为日志保留，不当成功
      this._progress(taskId, { lastRaw: line.slice(0, 300) });
      return;
    }
    switch (ev.event) {
      case 'progress':
        this._progress(taskId, {
          status: TASK_STATUS.RUNNING,
          progress: Math.max(1, Math.min(99, Math.round(ev.percent || 0))),
          message: ev.message || `本地推理 ${ev.step}/${ev.total}`
        });
        break;
      case 'log':
        this._progress(taskId, { logLevel: ev.level, logMessage: ev.message });
        if (ev.level === 'warn' && /DRY-RUN/.test(ev.message || '')) {
          this._progress(taskId, { isSelfTest: true });
        }
        break;
      case 'done':
        this._progress(taskId, {
          status: TASK_STATUS.SUCCEEDED, progress: 100,
          message: ev.dryRun ? '本地自检完成（占位视频，非真实生成）' : '本地推理完成',
          result: {
            localPath: ev.path,
            videoUrl: `file:///${String(ev.path || '').replace(/\\/g, '/')}`,
            durationSec: ev.seconds, width: ev.width, height: ev.height,
            modelId: this.tasks.get(taskId) ? this.tasks.get(taskId).modelId : null,
            provider: this.name, track: this.track,
            isSelfTest: Boolean(ev.dryRun), createdAt: Date.now()
          }
        });
        break;
      case 'error':
        this._progress(taskId, {
          status: TASK_STATUS.FAILED,
          error: ev.message,
          errorCode: this._mapPyErrorCode(ev.code)
        });
        break;
      default:
        break;
    }
  }

  /** Python 错误码 → 内部错误码 */
  _mapPyErrorCode(code) {
    const map = {
      OUT_OF_MEMORY: ERROR_CODE.OUT_OF_MEMORY,
      NO_CUDA: ERROR_CODE.OUT_OF_MEMORY,
      DEPS_MISSING: ERROR_CODE.NOT_INSTALLED,
      NOT_INSTALLED: ERROR_CODE.NOT_INSTALLED,
      NOT_IMPLEMENTED: ERROR_CODE.NOT_INSTALLED,
      BAD_REQUEST: ERROR_CODE.TASK_FAILED,
      RUNTIME: ERROR_CODE.TASK_FAILED
    };
    return map[code] || ERROR_CODE.TASK_FAILED;
  }

  _cleanup(reqFile) {
    try { if (reqFile && fs.existsSync(reqFile)) fs.rmSync(reqFile, { force: true }); } catch { /* 忽略 */ }
  }

  async cancelTask(taskId) {
    const child = this._children.get(taskId);
    this._progress(taskId, { status: TASK_STATUS.CANCELLED, message: '正在取消本地推理…' });
    if (child && typeof child.kill === 'function') {
      try { child.kill('SIGTERM'); } catch { /* 忽略 */ }
    }
    this._children.delete(taskId);
    return { cancelled: true };
  }
}

module.exports = { LocalProvider, EXIT_CODE_MAP };
