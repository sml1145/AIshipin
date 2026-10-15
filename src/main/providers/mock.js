'use strict';

/**
 * MockProvider —— 自检通道
 *
 * 作用：在"没有配置任何 API Key、也没有安装本地模型包"的情况下，
 * 让「输入描述 → 路由选模型 → 提交任务 → 轮询进度 → 拿到视频 → 播放」全链路真实跑通。
 *
 * 关键原则（用户的硬性要求：不假装实现）：
 *   - 它确实生成一个真实可播放的 mp4（用 ffmpeg 的 testsrc2 合成），不是返回假数据
 *   - 但画面明确叠加「自检模式样例（非真实 AI 生成）」水印，且任务结果里
 *     isSelfTest=true、UI 全程标注，绝不让用户误以为是真实 AI 生成结果
 */

const path = require('node:path');
const fs = require('node:fs');
const { BaseProvider, TASK_STATUS, ERROR_CODE, ProviderError } = require('./base.js');
const { synthesizeTestVideo, resolveFfmpegPath } = require('../ffmpeg.js');

const SELF_TEST_LABEL = '自检模式样例（非真实 AI 生成）';

class MockProvider extends BaseProvider {
  constructor(opts = {}) {
    super({ name: 'mock', track: 'mock', ...opts });
    this.outputDir = opts.outputDir;
    this.modelIds = ['mock-selftest'];
    /** 可注入的合成实现，便于测试 */
    this._synth = opts.synth || synthesizeTestVideo;
    /** 人为设定的失败率/延迟，用于测试降级链 */
    this.simulatedDelayMs = opts.simulatedDelayMs ?? 120;
  }

  async probeAvailability() {
    const ffmpeg = resolveFfmpegPath();
    const ffmpegOk = ffmpeg === 'ffmpeg' ? null : fs.existsSync(ffmpeg);
    return {
      available: true, // Mock 永远可用，是全链路最后的兜底
      reason: ffmpegOk === false
        ? 'ffmpeg 二进制缺失，自检通道无法合成视频'
        : '自检通道可用：无需 API Key、无需本地模型、无需联网',
      ffmpegPath: ffmpeg,
      ffmpegOk: ffmpegOk === null ? 'unknown(system PATH)' : ffmpegOk,
      isSelfTest: true
    };
  }

  /**
   * 创建自检任务
   * @param {object} req
   * @param {string} req.modelId
   * @param {string} req.prompt
   * @param {string|null} req.imagePath
   * @param {number} [req.durationSec]
   * @param {string} [req.requestId] 便于与真实请求关联排查
   */
  async createTask(req = {}) {
    if (!this.outputDir) {
      throw new ProviderError('未配置输出目录，无法生成自检视频', {
        code: ERROR_CODE.TASK_FAILED, retryable: false, provider: this.name
      });
    }
    const taskId = this._newTaskId('mock');
    this._progress(taskId, {
      id: taskId,
      status: TASK_STATUS.PENDING,
      progress: 0,
      modelId: req.modelId || 'mock-selftest',
      prompt: req.prompt || '',
      hasImage: Boolean(req.imagePath),
      isSelfTest: true,
      provider: this.name,
      track: this.track,
      createdAt: Date.now(),
      message: '已排队（自检模式）'
    });
    // 异步执行，不阻塞调用方
    this._run(taskId, req).catch((e) => {
      this._progress(taskId, {
        status: TASK_STATUS.FAILED,
        error: e.message,
        errorCode: (e && e.code) || ERROR_CODE.TASK_FAILED,
        message: `自检生成失败：${e.message}`
      });
    });
    return { taskId, isSelfTest: true };
  }

  async _run(taskId, req) {
    this._progress(taskId, { status: TASK_STATUS.RUNNING, progress: 5, message: '正在准备自检样例…' });
    if (this.simulatedDelayMs > 0) {
      await new Promise(r => setTimeout(r, this.simulatedDelayMs));
    }

    const durationSec = Math.max(2, Math.min(10, Number(req.durationSec) || 5));
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outputPath = path.join(this.outputDir, `selftest_${stamp}_${taskId.slice(-6)}.mp4`);

    this._progress(taskId, { progress: 30, message: `正在合成 ${durationSec}s 样例视频（ffmpeg testsrc2）…` });

    const promptLine = String(req.prompt || '').slice(0, 40).replace(/[':\r\n]/g, ' ');
    const text = `${SELF_TEST_LABEL}  |  提示词: ${promptLine || '(空)'}`;

    const info = await this._synth({
      outputPath,
      durationSec,
      text,
      width: 854,
      height: 480
    });

    this._progress(taskId, { progress: 90, message: '正在写入结果…' });

    if (!fs.existsSync(outputPath)) {
      throw new ProviderError('合成后未找到输出文件，自检失败', {
        code: ERROR_CODE.TASK_FAILED, retryable: true, provider: this.name
      });
    }

    this._progress(taskId, {
      status: TASK_STATUS.SUCCEEDED,
      progress: 100,
      message: '自检样例已生成（注意：这不是真实 AI 生成结果）',
      videoUrl: `file:///${outputPath.replace(/\\/g, '/')}`,
      result: {
        localPath: outputPath,
        videoUrl: `file:///${outputPath.replace(/\\/g, '/')}`,
        durationSec: info.durationSec,
        width: info.width,
        height: info.height,
        resolution: `${info.width}x${info.height}`,
        modelId: req.modelId || 'mock-selftest',
        provider: this.name,
        track: this.track,
        isSelfTest: true,
        selfTestNote: '本视频由 ffmpeg 合成的测试图案构成，用于验证全链路是否通畅，不包含任何 AI 生成内容。配置 API Key 或安装本地模型后即可得到真实结果。',
        hasWatermarkText: info.hasText,
        createdAt: Date.now()
      }
    });
  }
}

module.exports = { MockProvider, SELF_TEST_LABEL };
