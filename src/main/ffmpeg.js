'use strict';

/**
 * ffmpeg 工具层
 *
 * 用途：①Mock 自检通道真实合成一段可播放视频（让"无密钥跑通全链路"是真验证）
 *      ②多模型分段生成后的拼接
 *
 * 二进制来自 @ffmpeg-installer/ffmpeg（随包分发，无 postinstall 下载，规避了
 * ffmpeg-static 撞 GitHub TLS 证书链失败的问题）。
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

/** 定位 ffmpeg 可执行文件 */
function resolveFfmpegPath() {
  // 1. @ffmpeg-installer/ffmpeg（打包后经 asarUnpack 解包）
  try {
    const p = require('@ffmpeg-installer/ffmpeg').path;
    if (p && fs.existsSync(p)) return p;
  } catch { /* 继续找 */ }

  // 2. asar.unpacked 兜底路径
  const candidates = [
    path.join(process.resourcesPath || '', 'app.asar.unpacked', 'node_modules', '@ffmpeg-installer', 'win32-x64', 'ffmpeg.exe'),
    path.join(process.resourcesPath || '', 'app.asar.unpacked', 'node_modules', '@ffmpeg-installer', 'ffmpeg', 'ffmpeg.exe')
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }

  // 3. 系统 PATH
  return 'ffmpeg';
}

/** 执行 ffmpeg；返回 stdout+stderr，失败时带上完整参数便于诊断 */
function runFfmpeg(args, { ffmpegPath, timeoutMs = 180000, onProgress } = {}) {
  const bin = ffmpegPath || resolveFfmpegPath();
  return new Promise((resolve, reject) => {
    const child = execFile(bin, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const detail = String(stderr || stdout || '').slice(-1200);
        return reject(new Error(`ffmpeg 执行失败: ${err.message}\n参数: ${args.join(' ')}\n输出: ${detail}`));
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
    if (onProgress && child.stderr) {
      let buf = '';
      child.stderr.on('data', (d) => {
        buf += String(d);
        const m = buf.match(/time=(\d+):(\d+):(\d+)\.(\d+)/g);
        if (m && m.length) {
          const last = m[m.length - 1];
          const parts = last.replace('time=', '').split(':');
          const sec = Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2]);
          onProgress(sec);
          buf = '';
        }
      });
    }
  });
}

/** 读取视频时长（秒），用于验证拼接结果 */
async function probeDuration(filePath, ffprobePath) {
  // @ffmpeg-installer 只带 ffmpeg，不带 ffprobe；用 ffmpeg -i 解析 Duration
  const bin = ffprobePath || resolveFfmpegPath();
  return new Promise((resolve) => {
    execFile(bin, ['-i', filePath], { timeout: 20000, windowsHide: true }, (_err, stdout, stderr) => {
      const text = String(stderr || '') + String(stdout || '');
      const m = text.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
      if (!m) return resolve(null);
      resolve(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 100);
    });
  });
}

/**
 * 合成一段纯色/渐变测试视频（Mock 自检用）
 * 用 lavfi 生成，不依赖任何外部素材，也不需要 GPU。
 * @param {object} opts
 * @param {string} opts.outputPath
 * @param {number} [opts.durationSec]
 * @param {string} [opts.text] 叠加到画面上的文字，标明这是自检样例
 * @param {number} [opts.width]
 * @param {number} [opts.height]
 */
async function synthesizeTestVideo({
  outputPath,
  durationSec = 5,
  text = '幻想时刻 · 自检模式样例（非真实 AI 生成）',
  width = 854,
  height = 480,
  ffmpegPath
}) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  // testsrc2 生成动态测试图案；drawtext 需字体，Windows 用 msyh.ttc，缺失则退化为纯图案
  const safeText = String(text).replace(/'/g, "\\'").replace(/:/g, '\\:');
  const fontCandidates = [
    'C\\:/Windows/Fonts/msyh.ttc',
    'C\\:/Windows/Fonts/msyhbd.ttc',
    'C\\:/Windows/Fonts/simhei.ttf',
    'C\\:/Windows/Fonts/arial.ttf'
  ];
  const font = fontCandidates.find(f => fs.existsSync(f.replace(/\\\:/g, ':').replace(/\//g, path.sep)));

  const filters = [`testsrc2=size=${width}x${height}:rate=24:duration=${durationSec}`];
  if (font) {
    filters.push(`drawtext=fontfile='${font}':text='${safeText}':fontcolor=white:fontsize=28:box=1:boxcolor=black@0.6:boxborderw=12:x=(w-text_w)/2:y=h-80`);
  }

  const args = [
    '-y',
    '-f', 'lavfi',
    '-i', filters.join(','),
    '-f', 'lavfi',
    '-i', `sine=frequency=440:duration=${durationSec}`,
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-shortest',
    outputPath
  ];

  await runFfmpeg(args, { ffmpegPath });
  return { outputPath, durationSec, width, height, hasText: Boolean(font) };
}

/**
 * 拼接多段视频（多模型搭配用）
 * 统一先转码到相同分辨率/帧率再 concat，避免不同模型输出的参数不一致导致拼接失败。
 * @param {object} opts
 * @param {string[]} opts.inputs 各分段视频路径（有序）
 * @param {string} opts.outputPath 输出路径
 * @param {number} [opts.width]
 * @param {number} [opts.height]
 * @param {number} [opts.fps]
 */
async function concatVideos({ inputs, outputPath, width = 854, height = 480, fps = 24, ffmpegPath }) {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new Error('拼接需要至少一个输入视频');
  }
  for (const f of inputs) {
    if (!fs.existsSync(f)) throw new Error(`分段视频不存在: ${f}`);
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  // 单段直接复制，不做无意义转码
  if (inputs.length === 1) {
    fs.copyFileSync(inputs[0], outputPath);
    return { outputPath, segments: 1, method: 'copy' };
  }

  // concat demuxer 要求同参数，故先统一规格到临时文件再拼接（最稳）
  const bin = ffmpegPath || resolveFfmpegPath();
  const tmpDir = path.join(path.dirname(outputPath), `_concat_tmp_${Date.now().toString(36)}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const normalized = [];

  try {
    for (let i = 0; i < inputs.length; i++) {
      const n = path.join(tmpDir, `seg_${String(i).padStart(3, '0')}.mp4`);
      await runFfmpeg([
        '-y', '-i', inputs[i],
        '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,fps=${fps}`,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-ar', '44100', '-ac', '2',
        // 补齐静音音轨，防止某段无音轨导致 concat 失败
        '-af', 'apad',
        '-shortest',
        n
      ], { ffmpegPath: bin });
      normalized.push(n);
    }

    const listFile = path.join(tmpDir, 'list.txt');
    fs.writeFileSync(listFile, normalized.map(f => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'), 'utf8');

    await runFfmpeg([
      '-y', '-f', 'concat', '-safe', '0', '-i', listFile,
      '-c', 'copy', outputPath
    ], { ffmpegPath: bin });

    return { outputPath, segments: inputs.length, method: 'normalize-then-concat' };
  } finally {
    // 清理临时目录（只删本次自己创建的、路径已明确的临时物）
    try {
      for (const f of fs.readdirSync(tmpDir)) fs.rmSync(path.join(tmpDir, f), { force: true });
      fs.rmdirSync(tmpDir);
    } catch { /* 清理失败不影响结果 */ }
  }
}

module.exports = {
  resolveFfmpegPath,
  runFfmpeg,
  probeDuration,
  synthesizeTestVideo,
  concatVideos
};
