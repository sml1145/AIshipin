'use strict';

/**
 * 硬件探测：显存 / 内存 / 磁盘
 *
 * 关键教训（本机实测）：WMI 的 Win32_VideoController.AdapterRAM 是 32 位字段，
 * 8GB 显存会被溢出误报成 4GB。所以显存必须走 nvidia-smi，WMI 只作兜底且需标注不可信。
 *
 * 解析逻辑与命令执行分离，便于用固定输出做单元测试。
 */

const os = require('node:os');
const { execFile } = require('node:child_process');

/**
 * 解析 nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 的输出
 * @param {string} stdout 例如 "8188\n" 或多卡 "8188\n4096\n"
 * @returns {number[]} 每张卡的显存 MB 数组
 */
function parseNvidiaSmiMemory(stdout) {
  if (!stdout) return [];
  return String(stdout)
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => /^\d+$/.test(l))
    .map(Number);
}

/**
 * 解析 nvidia-smi 的 CSV 多字段输出
 * @param {string} stdout 例如 "NVIDIA GeForce RTX 4060 Laptop GPU, 8188 MiB, 610.88"
 */
function parseNvidiaSmiCsv(stdout) {
  const line = String(stdout || '').split(/\r?\n/).find(l => l.trim().length > 0);
  if (!line) return null;
  const parts = line.split(',').map(s => s.trim());
  const memMiB = Number((parts[1] || '').replace(/[^\d.]/g, ''));
  return {
    name: parts[0] || null,
    memoryMiB: Number.isFinite(memMiB) ? memMiB : null,
    memoryGB: Number.isFinite(memMiB) ? Number((memMiB / 1024).toFixed(2)) : null,
    driver: parts[2] || null
  };
}

/** 从 WMI 输出解析显存（不可信，32 位溢出） */
function parseWmiAdapterRam(stdout) {
  const nums = String(stdout || '')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => /^\d+$/.test(l))
    .map(Number);
  if (nums.length === 0) return null;
  const maxBytes = Math.max(...nums);
  return {
    bytes: maxBytes,
    gb: Number((maxBytes / 1024 / 1024 / 1024).toFixed(2)),
    // 32 位字段上限约 4GB，达到上限即说明可能溢出
    suspicious: maxBytes >= 4294967295 || maxBytes === 4294967296 || maxBytes >= 4 * 1024 * 1024 * 1024 - 1
  };
}

/** 剩余磁盘空间（字节）；跨平台，优先用 fs.statfs（Node 18.15+） */
async function getDiskFreeBytes(targetPath) {
  const fs = require('node:fs').promises;
  if (typeof fs.statfs === 'function') {
    try {
      const st = await fs.statfs(targetPath);
      return st.bavail * st.bsize;
    } catch {
      /* 落到平台命令 */
    }
  }
  if (process.platform === 'win32') {
    const drive = String(targetPath).replace(/^([A-Za-z]):.*$/, '$1:');
    const out = await runCommand('powershell.exe', [
      '-NoProfile', '-Command',
      `(Get-PSDrive -Name '${drive.replace(':', '')}' | Select-Object -ExpandProperty Free)`
    ]);
    const n = Number(String(out).trim());
    return Number.isFinite(n) ? n : 0;
  }
  const out = await runCommand('df', ['-k', targetPath]);
  const line = String(out).split(/\r?\n/)[1] || '';
  const cols = line.split(/\s+/).filter(Boolean);
  return Number(cols[3] || 0) * 1024;
}

function runCommand(cmd, args, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${cmd} 执行失败: ${err.message}${stderr ? ' | ' + String(stderr).slice(0, 200) : ''}`));
      resolve(stdout);
    });
  });
}

/**
 * 完整探测
 * @param {object} [opts]
 * @param {string} [opts.diskProbePath] 用于测剩余空间的目录
 * @param {Function} [opts.run] 注入命令执行器，便于测试
 */
async function detect(opts = {}) {
  const run = opts.run || runCommand;
  const diskProbePath = opts.diskProbePath || os.homedir();

  const result = {
    platform: process.platform,
    arch: process.arch,
    totalRamGB: Number((os.totalmem() / 1024 / 1024 / 1024).toFixed(1)),
    freeRamGB: Number((os.freemem() / 1024 / 1024 / 1024).toFixed(1)),
    cpuModel: null,
    cpuCores: os.cpus().length,
    gpu: null,
    vramGB: 0,
    vramSource: 'none',
    vramWarning: null,
    diskFreeGB: 0,
    cudaDriver: null,
    detectedAt: new Date().toISOString()
  };

  try {
    result.cpuModel = (os.cpus()[0] || {}).model || null;
  } catch { /* 忽略 */ }

  // 显存：nvidia-smi 优先（可信）
  try {
    const out = await run('nvidia-smi', [
      '--query-gpu=name,memory.total,driver_version', '--format=csv,noheader'
    ]);
    const parsed = parseNvidiaSmiCsv(out);
    if (parsed && parsed.memoryGB) {
      result.gpu = parsed.name;
      result.vramGB = parsed.memoryGB;
      result.vramSource = 'nvidia-smi';
      result.cudaDriver = parsed.driver;
    }
  } catch {
    result.vramWarning = '未检测到 NVIDIA 驱动或 nvidia-smi 不可用，本地推理（B 轨）可能无法使用 GPU';
  }

  // 兜底：WMI（需标注可能溢出）
  if (!result.vramGB && process.platform === 'win32') {
    try {
      const out = await run('powershell.exe', [
        '-NoProfile', '-Command',
        '(Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty AdapterRAM) -join "`n"'
      ]);
      const wmi = parseWmiAdapterRam(out);
      if (wmi) {
        result.vramGB = wmi.gb;
        result.vramSource = 'wmi';
        if (wmi.suspicious) {
          result.vramWarning = 'WMI 显存字段是 32 位，大于 4GB 的显卡会被溢出误报，此数值可能偏低，仅供参考';
        }
      }
    } catch { /* 无 GPU 或命令失败 */ }
  }

  // 磁盘
  try {
    const free = await getDiskFreeBytes(diskProbePath);
    result.diskFreeGB = Number((free / 1024 / 1024 / 1024).toFixed(1));
  } catch {
    result.diskFreeGB = 0;
  }

  return result;
}

/**
 * 判断本地模型包能否安装/运行
 * @param {object} hw detect() 的结果
 * @param {object} model models.json 里的本地模型条目
 * @param {number} [requiredDiskGB] 安装所需磁盘空间，默认 20
 */
function assessLocalReadiness(hw, model, requiredDiskGB = 20) {
  const problems = [];
  const warnings = [];

  if (!hw || hw.vramGB <= 0) {
    problems.push('未探测到可用 GPU 显存，本地推理无法进行');
  } else if (model.vramGB && hw.vramGB < model.vramGB) {
    problems.push(`该模型需显存 ${model.vramGB}GB，本机探测为 ${hw.vramGB}GB，会 OOM`);
  }

  if (model.ramGB && hw.totalRamGB < model.ramGB) {
    warnings.push(`该模型建议内存 ${model.ramGB}GB，本机 ${hw.totalRamGB}GB，可能因换页而极慢或失败`);
  }
  if (hw.vramSource === 'wmi' && hw.vramWarning) {
    warnings.push(hw.vramWarning);
  }
  if (hw.diskFreeGB < requiredDiskGB) {
    problems.push(`需至少 ${requiredDiskGB}GB 磁盘空闲用于下载运行时与权重，当前仅 ${hw.diskFreeGB}GB`);
  }
  if (model.downloadGB && hw.diskFreeGB < model.downloadGB + 5) {
    warnings.push(`该模型权重约 ${model.downloadGB}GB，建议保留额外 5GB 余量`);
  }
  if (model.warning) {
    warnings.push(model.warning);
  }

  return {
    canInstall: problems.length === 0,
    canRun: problems.length === 0,
    problems,
    warnings,
    estimatedDownloadGB: model.downloadGB || null
  };
}

module.exports = {
  detect,
  parseNvidiaSmiMemory,
  parseNvidiaSmiCsv,
  parseWmiAdapterRam,
  getDiskFreeBytes,
  assessLocalReadiness,
  runCommand
};
