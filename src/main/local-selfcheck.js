'use strict';

/**
 * 本地推理自检（B 轨）
 *
 * 目的：让用户装机后一键确认"本地免密钥轨道"是否可用，以及在不可用时**如实**说清差什么。
 * 两级自检，都不假装成功：
 *   1) 环境探针（env_probe.py）：报告 Python/torch/CUDA/依赖/权重就绪状态
 *   2) dry-run 链路（infer_ltx.py --dry-run）：不需 GPU/权重，用占位视频走完整
 *      Provider↔Python 协议，证明编排/进度/产物链路通畅（产物明确标注非真实生成）
 *
 * 诚实边界：真实 GPU 出片需 CUDA + 已下载权重，本自检**不会**伪造真实生成结果；
 *   它只回答"链路是否就绪/差什么"，dry-run 产物一定带 isSelfTest 标记。
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');

const { TASK_STATUS } = require('./providers/base.js');

/** 定位推理与探针脚本目录（打包后 extraResources，开发态 src/local） */
function resolveScriptDir(paths) {
  const candidates = [
    paths && paths.localScriptsDir,
    path.join(__dirname, '..', 'local'),
    path.join(__dirname, '..', '..', 'src', 'local')
  ].filter(Boolean);
  for (const d of candidates) {
    if (fs.existsSync(path.join(d, 'env_probe.py'))) return d;
  }
  return candidates[0] || null;
}

/**
 * 运行 Python 脚本并收集其 stdout 的 JSON 事件行
 * @returns {Promise<{ok:boolean, events:object[], exitCode:number, stdout:string, stderr:string, error?:string}>}
 */
function runPython(scriptDir, pythonPath, scriptName, args, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve) => {
    const scriptPath = path.join(scriptDir, scriptName);
    if (!fs.existsSync(scriptPath)) {
      return resolve({ ok: false, events: [], exitCode: -1, stdout: '', stderr: '', error: `脚本不存在: ${scriptPath}` });
    }
    const child = execFile(pythonPath, [scriptPath, ...args], {
      timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024
    }, (err, stdout, stderr) => {
      const events = [];
      for (const line of String(stdout || '').split(/\r?\n/)) {
        const t = line.trim();
        if (!t) continue;
        try { events.push(JSON.parse(t)); } catch { /* 非 JSON 行忽略（如 traceback） */ }
      }
      resolve({
        ok: !err,
        events,
        exitCode: err && typeof err.code === 'number' ? err.code : (err ? 1 : 0),
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        error: err ? String((err && err.message) || err) : null
      });
    });
    // execFile 已处理，这里保留引用避免被 GC（无实际额外动作）
    void child;
  });
}

/**
 * 第一级：环境探针
 * @returns {Promise<{ok:boolean, report:object}>} report 为 env_probe 的结构化输出
 */
async function probeEnv({ paths, pythonPath, modelRoot, weightFiles }) {
  const scriptDir = resolveScriptDir(paths);
  const args = [];
  if (modelRoot) args.push('--model-root', modelRoot);
  if (Array.isArray(weightFiles) && weightFiles.length) args.push('--weights', weightFiles.join(','));

  const r = await runPython(scriptDir, pythonPath, 'env_probe.py', args);
  const probeEvent = r.events.find(e => e.event === 'probe');
  if (!probeEvent) {
    return {
      ok: false,
      report: {
        ready: false, gpuReady: false, dryRunReady: false,
        problems: [`环境探针无输出（退出码 ${r.exitCode}）：${(r.stderr || r.error || '').slice(0, 200)}`],
        warnings: [], deps: {}, python: null, torch: null, cuda: false
      }
    };
  }
  return { ok: true, report: probeEvent };
}

/**
 * 第二级：dry-run 链路自检（不需 GPU/权重）
 * @returns {Promise<{ok:boolean, result:object}>} result 含产物路径与是否自检标记
 */
async function dryRunPipeline({ paths, pythonPath, LocalProvider }) {
  const scriptDir = resolveScriptDir(paths);
  const inferScript = path.join(scriptDir, 'infer_ltx.py');
  if (!fs.existsSync(inferScript)) {
    return { ok: false, error: `推理脚本不存在: ${inferScript}` };
  }

  const outDir = paths ? paths.outputDir : os.tmpdir();
  fs.mkdirSync(outDir, { recursive: true });
  const outputPath = path.join(outDir, `local_selfcheck_${Date.now().toString(36)}.mp4`);

  const provider = new LocalProvider({
    paths,
    scriptPath: inferScript,
    resolvePython: () => pythonPath
  });

  try {
    const { taskId } = await provider.createTask({
      prompt: '本地链路自检', dryRun: true, modelId: 'selfcheck', outputPath
    });
    // 轮询到终态
    const t0 = Date.now();
    let st = provider.tasks.get(taskId);
    while (st && (st.status === TASK_STATUS.PENDING || st.status === TASK_STATUS.RUNNING) && Date.now() - t0 < 60000) {
      await new Promise(r => setTimeout(r, 200));
      st = provider.tasks.get(taskId);
    }
    if (st && st.status === TASK_STATUS.SUCCEEDED && st.result) {
      const exists = st.result.localPath ? fs.existsSync(st.result.localPath) : false;
      return {
        ok: Boolean(exists),
        result: {
          ...st.result,
          fileExists: exists,
          // 强制标注：dry-run 一定是自检，绝不冒充真实生成
          isSelfTest: true
        }
      };
    }
    return { ok: false, error: (st && (st.error || st.message)) || 'dry-run 未成功', errorCode: st && st.errorCode };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

/**
 * 完整本地自检：环境探针 + dry-run 链路，汇总成一份诚实结论
 * @param {object} opts
 * @param {object} opts.paths
 * @param {string} opts.pythonPath
 * @param {Function} opts.LocalProvider LocalProvider 构造器
 * @param {object} [opts.model] 目标本地模型条目（用于查权重清单）
 * @param {boolean} [opts.skipDryRun] 仅探针
 * @returns {Promise<{gpuReady:boolean, dryRunReady:boolean, dryRunOk:boolean, env:object, dryRun:object, summary:string, problems:string[], warnings:string[]}>}
 */
async function runLocalSelfCheck(opts) {
  const { paths, pythonPath, LocalProvider, model = null, skipDryRun = false } = opts;

  // 权重清单（若指定模型）
  let modelRoot = null;
  let weightFiles = [];
  if (model && model.weights) {
    modelRoot = path.join(paths.modelsDir, model.id);
    weightFiles = [model.weights.file, ...((model.weights.extraFiles || []).map(f => f.file))].filter(Boolean);
  }

  const envRes = await probeEnv({ paths, pythonPath, modelRoot, weightFiles });
  const env = envRes.report;

  let dryRun = { ok: false, skipped: true };
  if (!skipDryRun) {
    dryRun = await dryRunPipeline({ paths, pythonPath, LocalProvider });
  }

  const problems = [...(env.problems || [])];
  const warnings = [...(env.warnings || [])];
  if (!skipDryRun && !dryRun.ok) {
    problems.push(`dry-run 链路自检失败：${dryRun.error || '未知原因'}`);
  }

  // 汇总成人话
  const parts = [];
  parts.push(`Python：${env.python || '未检测到'}`);
  parts.push(`torch：${env.torch || '未安装'}`);
  parts.push(`CUDA：${env.cuda ? '可用' : '不可用'}` + (env.vramGB ? `（显存 ${env.vramGB}GB）` : ''));
  if (model) {
    const w = env.weights || {};
    parts.push(`权重：${(w.present || []).length}/${weightFiles.length} 就绪`);
  }
  parts.push(`dry-run 链路：${skipDryRun ? '已跳过' : (dryRun.ok ? '通过' : '失败')}`);
  parts.push(`GPU 真实出片就绪：${env.gpuReady ? '是' : '否'}`);
  const summary = parts.join(' · ');

  return {
    gpuReady: Boolean(env.gpuReady),
    dryRunReady: Boolean(env.dryRunReady),
    dryRunOk: Boolean(dryRun.ok),
    env,
    dryRun,
    summary,
    problems,
    warnings
  };
}

module.exports = {
  resolveScriptDir,
  runPython,
  probeEnv,
  dryRunPipeline,
  runLocalSelfCheck
};
