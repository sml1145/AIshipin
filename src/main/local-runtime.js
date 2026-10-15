'use strict';

/**
 * 本地运行时与权重下载管理器（B 轨安装侧）
 *
 * 职责：把「本地免密钥推理」所需的三样东西下载并校验到位：
 *   1. Python embeddable 运行时（python.org 主源 / npmmirror / 华为镜像，实测三路可达）
 *   2. torch cu124 + 纯 Python 依赖（download.pytorch.org / pypi，实测可达）
 *   3. 模型权重（ModelScope resolve，实测可达；体积见 models.json）
 *
 * 全部复用 downloader.js 的断点续传 + SHA256 + 多源竞速，以及 hardware.js 的磁盘/显存预检。
 *
 * 诚实边界：真实下载约 9GB、需 ≥20GB 磁盘与 CUDA，无法在本 CI 环境完整验证；
 *   本模块的计划构造、预检、进度聚合、错误归因均可无头测试（注入假 downloader）。
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const { downloadFile, raceDownload, sha256File } = require('./downloader.js');
const { assessLocalReadiness } = require('./hardware.js');

/** Python embeddable 多源（实测均可达） */
function pythonEmbedSources(version = '3.11.9') {
  const file = `python-${version}-embed-amd64.zip`;
  return [
    { label: 'python.org', url: `https://www.python.org/ftp/python/${version}/${file}` },
    { label: 'npmmirror', url: `https://registry.npmmirror.com/-/binary/python/${version}/${file}` },
    { label: '华为镜像', url: `https://mirrors.huaweicloud.com/python/${version}/${file}` }
  ];
}

/**
 * 构造模型权重下载源（ModelScope resolve）
 * @param {object} model models.json 里的本地模型条目
 * @returns {{url:string,label:string}[]}
 */
function weightSources(model, extra = {}) {
  const w = model.weights || {};
  const repo = w.repo;
  const base = extra.modelscopeBase || 'https://www.modelscope.cn';
  const files = [w.file, ...((w.extraFiles || []).map(f => f.file))].filter(Boolean);
  // 每个文件都从 resolve 下载；返回首个文件的源用于竞速示例，完整清单由 plan 给出
  return files.map(f => ({
    label: `ModelScope ${path.basename(f)}`,
    url: `${base}/models/${repo}/resolve/master/${f}`,
    relPath: f
  }));
}

/**
 * 生成完整安装计划（不执行），供 UI 展示体积/来源，也供测试断言
 * @param {object} opts
 * @param {object} opts.model models.json 本地模型条目
 * @param {object} opts.paths paths.js 结果
 * @param {object} [opts.hardware] 硬件探测结果
 */
function buildInstallPlan({ model, paths, hardware }) {
  const items = [];
  const pyDir = paths.pythonDir;
  const modelDir = path.join(paths.modelsDir, model.id);

  items.push({
    kind: 'python',
    label: 'Python 3.11.9 embeddable',
    destPath: path.join(paths.runtimeDir, 'python-embed.zip'),
    extractTo: pyDir,
    sources: pythonEmbedSources('3.11.9'),
    approxMB: 11
  });

  items.push({
    kind: 'pip',
    label: 'torch cu124 + 推理依赖',
    note: '由安装后的 python -m pip 执行，非直接文件下载',
    approxMB: 2600
  });

  for (const f of weightSources(model)) {
    items.push({
      kind: 'weight',
      label: f.label,
      relPath: f.relPath,
      destPath: path.join(modelDir, f.relPath),
      sources: [{ label: f.label, url: f.url }],
      approxMB: null // 体积以 models.json 的 sizeGB 为准
    });
  }

  const totalGB = model.downloadGB || null;
  const readiness = hardware ? assessLocalReadiness(hardware, model, 20) : null;

  return {
    modelId: model.id,
    modelName: model.name,
    items,
    totalDownloadGB: totalGB,
    requiredDiskGB: 20,
    readiness,
    warning: model.warning || null
  };
}

/**
 * 执行安装计划：逐项下载 + 校验 + 解压 + pip 安装
 * @param {object} opts
 * @param {object} opts.plan buildInstallPlan 的结果
 * @param {object} opts.paths
 * @param {Function} [opts.onProgress] ({phase,item,percent,message}) => void
 * @param {Function} [opts.fetchImpl] 注入假下载，便于测试
 * @param {Function} [opts.pipImpl] 注入假 pip 执行，便于测试
 * @param {Function} [opts.unzipImpl] 注入假解压，便于测试
 * @param {boolean} [opts.skipNetwork] 测试用：跳过真实下载/解压/pip
 * @returns {Promise<{ok:boolean, installed:object, steps:object[], error?:string}>}
 */
async function runInstallPlan(opts) {
  const { plan, paths, onProgress = () => {}, fetchImpl = null, pipImpl = null, unzipImpl = null, skipNetwork = false } = opts;
  const steps = [];
  const report = (phase, item, percent, message) => onProgress({ phase, item, percent, message });

  // 磁盘预检
  if (plan.readiness && !plan.readiness.canInstall) {
    return {
      ok: false, installed: null, steps,
      error: `无法安装：${plan.readiness.problems.join('；')}`,
      code: 'PRECHECK_FAILED'
    };
  }

  fs.mkdirSync(paths.runtimeDir, { recursive: true });
  fs.mkdirSync(paths.modelsDir, { recursive: true });

  for (const item of plan.items) {
    if (item.kind === 'python') {
      report('python', item.label, 0, '正在下载 Python 运行时…');
      if (skipNetwork) { steps.push({ item: item.label, ok: true, skipped: true }); continue; }
      try {
        await raceDownload({ sources: item.sources, destPath: item.destPath, fetchImpl });
        report('python', item.label, 70, '正在解压 Python 运行时…');
        if (unzipImpl) await unzipImpl(item.destPath, item.extractTo);
        else await defaultUnzip(item.destPath, item.extractTo);
        steps.push({ item: item.label, ok: true });
        report('python', item.label, 100, 'Python 运行时就绪');
      } catch (err) {
        steps.push({ item: item.label, ok: false, error: String(err.message || err) });
        return { ok: false, installed: null, steps, error: `Python 运行时安装失败：${err.message}`, code: 'PYTHON_FAILED' };
      }
    } else if (item.kind === 'pip') {
      report('pip', item.label, 0, '正在安装 torch 与推理依赖（约 2.6GB，耗时较长）…');
      if (skipNetwork) { steps.push({ item: item.label, ok: true, skipped: true }); continue; }
      try {
        const pyExe = path.join(paths.pythonDir, 'python.exe');
        const reqFile = path.join(paths.localScriptsDir, 'requirements.txt');
        if (pipImpl) await pipImpl(pyExe, reqFile);
        else await defaultPipInstall(pyExe, reqFile, report);
        steps.push({ item: item.label, ok: true });
        report('pip', item.label, 100, 'torch 与依赖安装完成');
      } catch (err) {
        steps.push({ item: item.label, ok: false, error: String(err.message || err) });
        return { ok: false, installed: null, steps, error: `依赖安装失败：${err.message}`, code: 'PIP_FAILED' };
      }
    } else if (item.kind === 'weight') {
      report('weight', item.label, 0, `正在下载权重 ${item.relPath}…`);
      if (skipNetwork) { steps.push({ item: item.label, ok: true, skipped: true }); continue; }
      try {
        fs.mkdirSync(path.dirname(item.destPath), { recursive: true });
        const r = await raceDownload({ sources: item.sources, destPath: item.destPath, fetchImpl });
        steps.push({ item: item.label, ok: true, sha256: r.sha256 });
        report('weight', item.label, 100, `${item.relPath} 下载并校验完成`);
      } catch (err) {
        steps.push({ item: item.label, ok: false, error: String(err.message || err) });
        return { ok: false, installed: null, steps, error: `权重下载失败（${item.relPath}）：${err.message}`, code: 'WEIGHT_FAILED' };
      }
    }
  }

  // 标记已安装：写一个 marker，供 listInstalledLocalModels 识别
  const markerDir = path.join(paths.modelsDir, plan.modelId);
  fs.mkdirSync(markerDir, { recursive: true });
  const marker = { modelId: plan.modelId, installedAt: new Date().toISOString(), steps };
  if (!skipNetwork) {
    try { fs.writeFileSync(path.join(markerDir, 'installed.json'), JSON.stringify(marker, null, 2), 'utf8'); } catch { /* 忽略 */ }
  }
  return { ok: true, installed: marker, steps };
}

/** 默认解压：用 Windows 自带的 tar（Win10 1803+ 内置 bsdtar，可解 zip） */
function defaultUnzip(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  return new Promise((resolve, reject) => {
    execFile('tar', ['-xf', zipPath, '-C', destDir], { windowsHide: true, timeout: 120000 }, (err) => {
      if (err) return reject(new Error(`解压失败：${err.message}`));
      resolve();
    });
  });
}

/** 默认 pip 安装：先装 torch(cu124)，再装 requirements.txt */
function defaultPipInstall(pyExe, reqFile, report = () => {}) {
  const run = (args, label) => new Promise((resolve, reject) => {
    report('pip', label, 30, `pip ${label}…`);
    execFile(pyExe, args, { windowsHide: true, timeout: 30 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${label} 失败：${(stderr || stdout || err.message || '').toString().slice(-400)}`));
      resolve();
    });
  });
  return (async () => {
    await run(['-m', 'pip', 'install', '--no-input', '--disable-pip-version-check', 'pip', '--upgrade'], '升级 pip');
    await run(['-m', 'pip', 'install', '--no-input', '--disable-pip-version-check',
      'torch', 'torchvision', '--index-url', 'https://download.pytorch.org/whl/cu124'], '安装 torch cu124');
    await run(['-m', 'pip', 'install', '--no-input', '--disable-pip-version-check', '-r', reqFile], '安装推理依赖');
  })();
}

/**
 * 检查某本地模型是否已安装（权重文件真实存在）
 */
function isModelInstalled(model, paths) {
  const modelDir = path.join(paths.modelsDir, model.id);
  const w = model.weights || {};
  const files = [w.file, ...((w.extraFiles || []).map(f => f.file))].filter(Boolean);
  if (files.length === 0) return false;
  return files.every(f => fs.existsSync(path.join(modelDir, f)));
}

module.exports = {
  pythonEmbedSources,
  weightSources,
  buildInstallPlan,
  runInstallPlan,
  defaultUnzip,
  defaultPipInstall,
  isModelInstalled
};
