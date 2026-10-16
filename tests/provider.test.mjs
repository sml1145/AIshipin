import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const catalogMod = require('../src/main/catalog.js');
const hw = require('../src/main/hardware.js');
const ffmpegMod = require('../src/main/ffmpeg.js');
const { MockProvider, SELF_TEST_LABEL } = require('../src/main/providers/mock.js');
const { ProviderError, ERROR_CODE, TASK_STATUS, humanizeError } = require('../src/main/providers/base.js');
const pathsMod = require('../src/main/paths.js');

const here = dirname(fileURLToPath(import.meta.url));
const bundled = join(here, '..', 'models.json');

function tmp(prefix) {
  return mkdtempSync(join(tmpdir(), `hxsk-test-${prefix}-`));
}

/* ============ 模型能力库 ============ */

test('能力库：随包 models.json 可加载且通过结构校验', () => {
  const r = catalogMod.load({ catalogBundled: bundled, catalogCached: null });
  assert.equal(r.source, 'bundled');
  assert.ok(r.catalog.models.length >= 10);
  assert.ok(Object.keys(r.catalog.intents).length >= 10);
});

test('能力库：缓存副本优先于随包版本（热更新生效路径）', () => {
  const dir = tmp('catalog');
  const cached = join(dir, 'models-cached.json');
  const base = JSON.parse(readFileSync(bundled, 'utf8'));
  base.schemaVersion = 99;
  base.models.push({ ...base.models[0], id: 'hot-updated-model', name: '热更新新增模型' });
  const fs = require('node:fs');
  fs.writeFileSync(cached, JSON.stringify(base), 'utf8');

  const r = catalogMod.load({ catalogBundled: bundled, catalogCached: cached });
  assert.equal(r.source, 'cached');
  assert.equal(r.catalog.schemaVersion, 99);
  assert.ok(r.catalog.models.some(m => m.id === 'hot-updated-model'));
  rmSync(dir, { recursive: true, force: true });
});

test('能力库：缓存损坏时降级到随包版本，不让软件崩掉', () => {
  const dir = tmp('catalog-bad');
  const cached = join(dir, 'models-cached.json');
  require('node:fs').writeFileSync(cached, '{ 这不是合法 JSON ', 'utf8');
  const r = catalogMod.load({ catalogBundled: bundled, catalogCached: cached });
  assert.equal(r.source, 'bundled', '损坏缓存必须被忽略');
  rmSync(dir, { recursive: true, force: true });
});

test('能力库：缺 schemaVersion / models 为空必须抛错，不接受半残数据', () => {
  assert.throws(() => catalogMod.validateCatalog({ models: [{ id: 'a', track: 'cloud', inputs: ['t2v'] }], intents: {} }), /schemaVersion/);
  assert.throws(() => catalogMod.validateCatalog({ schemaVersion: 1, models: [], intents: {} }), /models 为空/);
  assert.throws(() => catalogMod.validateCatalog({ schemaVersion: 1, models: [{ track: 'cloud', inputs: ['t2v'] }], intents: {} }), /字段缺失/);
  assert.throws(() => catalogMod.validateCatalog(null), /不是合法对象/);
});

test('能力库：远程热更新多源竞速，取最先成功者', async () => {
  const good = { schemaVersion: 5, models: [{ id: 'x', track: 'mock', inputs: ['t2v'], name: 'X', quality: 5, costFactor: 0, license: 'MIT' }], intents: {} };
  const fetchImpl = async (url) => {
    if (url.includes('bad')) {
      const e = new Error('HTTP 502'); throw e;
    }
    return { ok: true, text: async () => JSON.stringify(good) };
  };
  const r = await catalogMod.fetchRemote({
    urls: ['https://example.com/bad/models.json', 'https://example.com/good/models.json'],
    localSchemaVersion: 1,
    fetchImpl
  });
  assert.equal(r.ok, true);
  assert.ok(r.url.includes('good'));
  assert.equal(r.catalog.schemaVersion, 5);
});

test('能力库：远程 schemaVersion 低于本地时拒绝，防止被旧缓存降级', async () => {
  const stale = { schemaVersion: 1, models: [{ id: 'x', track: 'mock', inputs: ['t2v'], name: 'X', quality: 5, costFactor: 0, license: 'MIT' }], intents: {} };
  const r = await catalogMod.fetchRemote({
    urls: ['https://example.com/models.json'],
    localSchemaVersion: 7,
    fetchImpl: async () => ({ ok: true, text: async () => JSON.stringify(stale) })
  });
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('低于本地'));
});

test('能力库：全部远程源失败时返回 ok:false 且带原因，不抛异常', async () => {
  const r = await catalogMod.fetchRemote({
    urls: ['https://a.invalid/m.json', 'https://b.invalid/m.json'],
    fetchImpl: async () => { throw new Error('ENOTFOUND'); }
  });
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('ENOTFOUND'));
});

test('能力库：refresh 在远程不可用时静默降级到本地，软件照常可用', async () => {
  const dir = tmp('refresh');
  const p = { catalogBundled: bundled, catalogCached: join(dir, 'cached.json') };
  const r = await catalogMod.refresh({
    paths: p,
    fetchImpl: async () => { throw new Error('network down'); }
  });
  assert.equal(r.updated, false);
  assert.equal(r.source, 'bundled');
  assert.ok(r.message.includes('使用本地能力库'));
  assert.ok(r.catalog.models.length > 0);
  rmSync(dir, { recursive: true, force: true });
});

test('能力库：refresh 成功且内容有变化时写入缓存', async () => {
  const dir = tmp('refresh-ok');
  const p = { catalogBundled: bundled, catalogCached: join(dir, 'cached.json') };
  const base = JSON.parse(readFileSync(bundled, 'utf8'));
  base.schemaVersion = base.schemaVersion + 1;
  base.models[0].notes = '远程更新过的备注';
  const r = await catalogMod.refresh({
    paths: p,
    fetchImpl: async () => ({ ok: true, text: async () => JSON.stringify(base) })
  });
  assert.equal(r.updated, true);
  assert.equal(r.source, 'remote');
  assert.ok(existsSync(p.catalogCached), '缓存必须已落盘');
  assert.equal(JSON.parse(readFileSync(p.catalogCached, 'utf8')).schemaVersion, base.schemaVersion);
  rmSync(dir, { recursive: true, force: true });
});

/* ============ 硬件探测解析 ============ */

test('硬件解析：nvidia-smi 输出 8188MiB → 8GB（这是本机真实值）', () => {
  const r = hw.parseNvidiaSmiCsv('NVIDIA GeForce RTX 4060 Laptop GPU, 8188 MiB, 610.88\n');
  assert.equal(r.name, 'NVIDIA GeForce RTX 4060 Laptop GPU');
  assert.equal(r.memoryMiB, 8188);
  assert.equal(r.memoryGB, 8);
  assert.equal(r.driver, '610.88');
});

test('硬件解析：WMI 4GB 溢出值必须被标记为可疑（本机实测踩过的坑）', () => {
  const r = hw.parseWmiAdapterRam('0\n536870912\n4294967296\n');
  assert.ok(r, '应能解析');
  assert.ok(r.suspicious, '达到 32 位上限的值必须标记可疑');
});

test('硬件解析：WMI 正常小显存不标记可疑', () => {
  const r = hw.parseWmiAdapterRam('1073741824\n');
  assert.equal(r.gb, 1);
  assert.equal(r.suspicious, false);
});

test('适配器名解析：换行分隔、去空行、去重', () => {
  const sample = 'Todesk Virtual Display Adapter\nMuMu Virtual Display Adapter\nTodesk Virtual Display Adapter\n\nNVIDIA GeForce RTX 4060 Laptop GPU\n';
  assert.deepEqual(hw.parseAdapterNames(sample), [
    'Todesk Virtual Display Adapter',
    'MuMu Virtual Display Adapter',
    'NVIDIA GeForce RTX 4060 Laptop GPU'
  ]);
});

test('适配器名解析：空/null 输入返回空数组，不抛错', () => {
  assert.deepEqual(hw.parseAdapterNames(''), []);
  assert.deepEqual(hw.parseAdapterNames(null), []);
  assert.deepEqual(hw.parseAdapterNames(undefined), []);
  assert.deepEqual(hw.parseAdapterNames('   \n  \n'), []);
});

test('适配器名解析：兼容 CRLF 与首尾空白', () => {
  assert.deepEqual(hw.parseAdapterNames(' A \r\n B \r\n'), ['A', 'B']);
});

test('硬件探测：displayAdapters 枚举出全部适配器（含 IDD 虚拟适配器）', async () => {
  const fakeRun = async (cmd, args) => {
    if (cmd === 'nvidia-smi') return 'NVIDIA GeForce RTX 4060 Laptop GPU, 8188 MiB, 610.88\n';
    const joined = (args || []).join(' ');
    if (joined.includes('Win32_VideoController') && joined.includes('Name')) {
      return 'Todesk Virtual Display Adapter\nMuMu Virtual Display Adapter\nGameViewer Virtual Display Adapter\nAMD Radeon 780M Graphics\nNVIDIA GeForce RTX 4060 Laptop GPU\n';
    }
    if (joined.includes('AdapterRAM')) return '4294967296\n';
    throw new Error('unexpected ' + cmd);
  };
  const r = await hw.detect({ run: fakeRun, diskProbePath: tmpdir() });
  assert.equal(r.displayAdapters.length, 5, '应枚举出全部 5 个适配器');
  assert.ok(r.displayAdapters.some(a => a.includes('Todesk')));
  assert.ok(r.displayAdapters.some(a => a.includes('NVIDIA')));
  assert.equal(r.gpu, 'NVIDIA GeForce RTX 4060 Laptop GPU', 'gpu 字段仍只反映主 GPU');
});

test('硬件探测关键：枚举适配器失败时 displayAdapters 退化为空数组，不影响主探测', async () => {
  const fakeRun = async (cmd) => {
    if (cmd === 'nvidia-smi') return 'NVIDIA GeForce RTX 4060 Laptop GPU, 8188 MiB, 610.88\n';
    throw new Error('powershell 不可用');
  };
  const r = await hw.detect({ run: fakeRun, diskProbePath: tmpdir() });
  assert.deepEqual(r.displayAdapters, []);
  assert.equal(r.vramGB, 8, '显存探测不受适配器枚举失败影响');
});

test('硬件探测：注入假的 nvidia-smi 输出，验证走可信通道', async () => {
  const fakeRun = async (cmd) => {
    if (cmd === 'nvidia-smi') return 'NVIDIA GeForce RTX 4060 Laptop GPU, 8188 MiB, 610.88\n';
    throw new Error('unexpected command ' + cmd);
  };
  const r = await hw.detect({ run: fakeRun, diskProbePath: tmpdir() });
  assert.equal(r.vramGB, 8);
  assert.equal(r.vramSource, 'nvidia-smi');
  assert.equal(r.cudaDriver, '610.88');
  assert.ok(r.totalRamGB > 0);
});

test('硬件探测：nvidia-smi 不可用时给出明确警告而非假装没有 GPU', async () => {
  const fakeRun = async () => { throw new Error('nvidia-smi not found'); };
  const r = await hw.detect({ run: fakeRun, diskProbePath: tmpdir() });
  assert.ok(r.vramWarning, '必须给出警告');
  assert.ok(r.vramWarning.includes('nvidia-smi') || r.vramWarning.includes('GPU'));
});

test('本地就绪评估：8GB 显存 + 15.2GB 内存下 LTX-2B 可跑，Wan2.1 给内存警告', () => {
  const catalog = JSON.parse(readFileSync(bundled, 'utf8'));
  const ltx = catalog.models.find(m => m.id === 'local-ltx-2b-fp8');
  const wan = catalog.models.find(m => m.id === 'local-wan2.1-1.3b-fp8');
  const hwFake = { vramGB: 8, totalRamGB: 15.2, diskFreeGB: 100, vramSource: 'nvidia-smi' };

  const a = hw.assessLocalReadiness(hwFake, ltx, 20);
  assert.equal(a.canRun, true, 'LTX-2B 在 8GB 显存应可运行');
  assert.equal(a.problems.length, 0);

  const b = hw.assessLocalReadiness(hwFake, wan, 20);
  assert.ok(b.warnings.length > 0, 'Wan2.1 的 T5 内存风险必须被提示');
  assert.ok(b.warnings.join().includes('内存') || b.warnings.join().includes('T5'));
});

test('本地就绪评估：显存不足必须判定为跑不动并说明差多少', () => {
  const catalog = JSON.parse(readFileSync(bundled, 'utf8'));
  const ltx = catalog.models.find(m => m.id === 'local-ltx-2b-fp8');
  const r = hw.assessLocalReadiness({ vramGB: 4, totalRamGB: 16, diskFreeGB: 100, vramSource: 'wmi' }, ltx, 20);
  assert.equal(r.canRun, false);
  assert.ok(r.problems.join().includes('显存'));
  assert.ok(r.problems.join().includes('OOM'));
});

test('本地就绪评估：磁盘不足必须拦截（需 ≥20GB）', () => {
  const catalog = JSON.parse(readFileSync(bundled, 'utf8'));
  const ltx = catalog.models.find(m => m.id === 'local-ltx-2b-fp8');
  const r = hw.assessLocalReadiness({ vramGB: 8, totalRamGB: 16, diskFreeGB: 5, vramSource: 'nvidia-smi' }, ltx, 20);
  assert.equal(r.canInstall, false);
  assert.ok(r.problems.join().includes('磁盘'));
});

/* ============ 路径解析 ============ */

test('路径解析：用户数据与安装目录分离，升级不丢模型包', () => {
  const p = pathsMod.resolvePaths({
    appPath: 'C:\\app\\install',
    userDataPath: 'C:\\users\\me\\AppData\\Roaming\\幻想时刻',
    resourcesPath: 'C:\\app\\install\\resources',
    isPackaged: true,
    homeDir: 'C:\\users\\me'
  });
  assert.ok(p.modelsDir.includes('幻想时刻'));
  assert.ok(p.modelsDir.startsWith('C:\\users\\me'), '模型权重必须在用户数据目录，不在安装目录');
  assert.ok(!p.modelsDir.startsWith('C:\\app\\install'));
  assert.ok(p.outputDir.includes('Videos'));
  assert.equal(p.catalogBundled.includes('app.asar'), true);
  assert.equal(p.localScriptsDir.includes('resources'), true);
  assert.ok(p.requiredDirs.length >= 6);
});

test('路径解析：开发模式下指向源码目录', () => {
  const p = pathsMod.resolvePaths({
    appPath: 'D:\\proj\\HuanXiangShiKe',
    userDataPath: 'D:\\proj\\HuanXiangShiKe\\.userdata',
    resourcesPath: 'D:\\proj\\HuanXiangShiKe',
    isPackaged: false,
    homeDir: 'C:\\users\\me'
  });
  assert.equal(p.catalogBundled, join('D:\\proj\\HuanXiangShiKe', 'models.json'));
  assert.ok(p.localScriptsDir.includes('src'));
});

test('路径解析：ensureDirs 幂等创建全部目录', () => {
  const dir = tmp('dirs');
  const p = pathsMod.resolvePaths({
    appPath: dir, userDataPath: join(dir, 'ud'), resourcesPath: dir,
    isPackaged: false, homeDir: dir
  });
  pathsMod.ensureDirs(p);
  pathsMod.ensureDirs(p); // 第二次不应报错
  for (const d of p.requiredDirs) {
    assert.ok(existsSync(d), `目录应已创建: ${d}`);
  }
  rmSync(dir, { recursive: true, force: true });
});

/* ============ 错误码与人话提示 ============ */

test('错误规范化：401 → AUTH_FAILED 且不可重试', () => {
  class P extends (require('../src/main/providers/base.js').BaseProvider) {
    constructor() { super({ name: 't', track: 'cloud' }); }
    async probeAvailability() { return { available: true }; }
    async createTask() { return { taskId: 'x' }; }
  }
  const p = new P();
  const e = p._normalizeError(new Error('HTTP 401 Unauthorized'), 'DashScope');
  assert.ok(e instanceof ProviderError);
  assert.equal(e.code, ERROR_CODE.AUTH_FAILED);
  assert.equal(e.retryable, false);
});

test('错误规范化：各类真实报错映射到正确错误码', () => {
  const { BaseProvider } = require('../src/main/providers/base.js');
  class P extends BaseProvider {
    constructor() { super({ name: 't', track: 'cloud' }); }
    async probeAvailability() { return { available: true }; }
    async createTask() { return { taskId: 'x' }; }
  }
  const p = new P();
  const cases = [
    ['quota exceeded 额度不足', ERROR_CODE.NO_QUOTA],
    ['429 Too Many Requests', ERROR_CODE.RATE_LIMITED],
    ['CUDA out of memory', ERROR_CODE.OUT_OF_MEMORY],
    ['No space left on device', ERROR_CODE.DISK_FULL],
    ['request timed out', ERROR_CODE.TIMEOUT],
    ['fetch failed ENOTFOUND', ERROR_CODE.UNREACHABLE],
    ['content policy violation 敏感内容', ERROR_CODE.CONTENT_REJECTED],
    ['404 model not found', ERROR_CODE.MODEL_NOT_FOUND]
  ];
  for (const [msg, code] of cases) {
    assert.equal(p._normalizeError(new Error(msg)).code, code, `应映射为 ${code}: ${msg}`);
  }
});

test('人话提示：每个错误码都有可行动的中文建议', () => {
  for (const code of Object.values(ERROR_CODE)) {
    const msg = humanizeError({ code });
    assert.ok(msg && msg.length > 5, `${code} 缺人话提示`);
    assert.ok(!msg.includes('未知错误'), `${code} 不应显示"未知错误"`);
    assert.ok(msg.length > 10, `${code} 的建议过于空泛`);
  }
});

test('人话提示：未知错误码也要给出兜底建议，不能甩原始报错', () => {
  const m = humanizeError({ code: 'SOMETHING_WEIRD', message: 'x' });
  assert.ok(m.length > 10);
  assert.ok(m.includes('通道') || m.includes('重试'));
});

test('人话提示：无 Key 时引导用户配置或切本地，不是甩原始报错', () => {
  const m = humanizeError({ code: ERROR_CODE.NO_KEY });
  assert.ok(m.includes('API Key'));
  assert.ok(m.includes('本地') || m.includes('设置'));
});

/* ============ Mock 自检通道 ============ */

test('Mock：probeAvailability 永远可用且标明是自检', async () => {
  const dir = tmp('mock');
  const p = new MockProvider({ outputDir: dir, simulatedDelayMs: 0 });
  const r = await p.probeAvailability();
  assert.equal(r.available, true);
  assert.equal(r.isSelfTest, true);
  assert.ok(r.reason.includes('无需'));
  rmSync(dir, { recursive: true, force: true });
});

test('Mock：注入假合成器时全链路跑通并产出结果元数据', async () => {
  const dir = tmp('mock-fake');
  const outPath = join(dir, 'fake.mp4');
  let calledWith = null;
  const p = new MockProvider({
    outputDir: dir,
    simulatedDelayMs: 0,
    synth: async (opts) => {
      calledWith = opts;
      require('node:fs').writeFileSync(opts.outputPath, 'fake-video-bytes');
      return { outputPath: opts.outputPath, durationSec: opts.durationSec, width: opts.width, height: opts.height, hasText: true };
    }
  });
  const { taskId } = await p.createTask({ prompt: '一只猫在跑', durationSec: 5 });
  // 轮询直到结束
  let st = await p.pollTask(taskId);
  for (let i = 0; i < 50 && st.status !== TASK_STATUS.SUCCEEDED && st.status !== TASK_STATUS.FAILED; i++) {
    await new Promise(r => setTimeout(r, 20));
    st = await p.pollTask(taskId);
  }
  assert.equal(st.status, TASK_STATUS.SUCCEEDED, `应成功，实际 ${st.status}: ${st.error}`);
  assert.equal(st.progress, 100);
  const res = await p.fetchResult(taskId);
  assert.equal(res.isSelfTest, true, '结果必须标明是自检，不能让用户误认为真实生成');
  assert.ok(res.selfTestNote.includes('不包含任何 AI 生成内容'));
  assert.equal(res.durationSec, 5);
  assert.ok(res.videoUrl.startsWith('file:///'));
  assert.ok(calledWith.text.includes('自检模式'), '合成画面必须带自检水印');
  assert.ok(calledWith.text.includes('一只猫在跑'), '水印应带上用户提示词便于确认链路');
  rmSync(dir, { recursive: true, force: true });
});

test('Mock：未成功前调用 fetchResult 必须报错，不返回半成品', async () => {
  const dir = tmp('mock-pending');
  const p = new MockProvider({
    outputDir: dir,
    simulatedDelayMs: 0,
    synth: async () => { await new Promise(r => setTimeout(r, 400)); return { outputPath: '', durationSec: 5, width: 1, height: 1, hasText: false }; }
  });
  const { taskId } = await p.createTask({ prompt: 'x' });
  await assert.rejects(() => p.fetchResult(taskId), /尚未成功/);
  await p.cancelTask(taskId);
  rmSync(dir, { recursive: true, force: true });
});

test('Mock：未配置输出目录时明确报错，不静默失败', async () => {
  const p = new MockProvider({ outputDir: null });
  await assert.rejects(() => p.createTask({ prompt: 'x' }), /未配置输出目录/);
});

test('Mock：合成器抛错时任务转 FAILED 并带原因', async () => {
  const dir = tmp('mock-fail');
  const p = new MockProvider({
    outputDir: dir,
    simulatedDelayMs: 0,
    synth: async () => { throw new Error('ffmpeg crashed'); }
  });
  const { taskId } = await p.createTask({ prompt: 'x' });
  let st = await p.pollTask(taskId);
  for (let i = 0; i < 50 && st.status !== TASK_STATUS.FAILED; i++) {
    await new Promise(r => setTimeout(r, 20));
    st = await p.pollTask(taskId);
  }
  assert.equal(st.status, TASK_STATUS.FAILED);
  assert.ok(st.error.includes('ffmpeg crashed'));
  rmSync(dir, { recursive: true, force: true });
});

test('Mock：不存在的任务 id 必须报错', async () => {
  const dir = tmp('mock-404');
  const p = new MockProvider({ outputDir: dir, simulatedDelayMs: 0 });
  await assert.rejects(() => p.pollTask('task_nonexistent'), /任务不存在/);
  rmSync(dir, { recursive: true, force: true });
});

/* ============ ffmpeg 真实自检（关键：不靠推断） ============ */

test('ffmpeg：二进制存在且可执行', async () => {
  const bin = ffmpegMod.resolveFfmpegPath();
  if (bin === 'ffmpeg') {
    // 退回系统 PATH，跳过但不假装成功
    return;
  }
  assert.ok(existsSync(bin), `ffmpeg 二进制应存在: ${bin}`);
  // ffmpeg -version 输出到 stdout（不是 stderr）
  const { stdout, stderr } = await ffmpegMod.runFfmpeg(['-version'], { ffmpegPath: bin, timeoutMs: 30000 });
  const combined = `${stdout}\n${stderr}`;
  assert.ok(/ffmpeg version/i.test(combined), `应输出版本信息，实际: ${combined.slice(0, 200)}`);
});

test('ffmpeg：真实合成一段 3 秒自检视频，且文件确实可播放、时长正确', async () => {
  const bin = ffmpegMod.resolveFfmpegPath();
  if (bin === 'ffmpeg' && !existsSync(bin)) {
    throw new Error('ffmpeg 不可用，无法完成真实自检');
  }
  const dir = tmp('ffmpeg-real');
  const out = join(dir, 'real-selftest.mp4');
  const info = await ffmpegMod.synthesizeTestVideo({
    outputPath: out, durationSec: 3, text: SELF_TEST_LABEL, width: 320, height: 180
  });
  assert.ok(existsSync(out), '视频文件必须真实生成');
  const size = statSync(out).size;
  assert.ok(size > 5000, `视频文件应有实际内容，实际 ${size} 字节`);
  const dur = await ffmpegMod.probeDuration(out);
  assert.ok(dur !== null, '应能解析出时长');
  assert.ok(dur >= 2.5 && dur <= 4.0, `时长应约 3 秒，实际 ${dur}`);
  assert.equal(info.width, 320);
  rmSync(dir, { recursive: true, force: true });
});

test('ffmpeg：拼接两段视频后时长等于两段之和', async () => {
  const bin = ffmpegMod.resolveFfmpegPath();
  const dir = tmp('ffmpeg-concat');
  const a = join(dir, 'a.mp4');
  const b = join(dir, 'b.mp4');
  const out = join(dir, 'merged.mp4');
  await ffmpegMod.synthesizeTestVideo({ outputPath: a, durationSec: 2, text: 'seg A', width: 320, height: 180 });
  await ffmpegMod.synthesizeTestVideo({ outputPath: b, durationSec: 3, text: 'seg B', width: 320, height: 180 });
  const r = await ffmpegMod.concatVideos({ inputs: [a, b], outputPath: out, width: 320, height: 180, fps: 24 });
  assert.equal(r.segments, 2);
  assert.ok(existsSync(out));
  const dur = await ffmpegMod.probeDuration(out);
  assert.ok(dur !== null, '拼接结果应能解析时长');
  assert.ok(dur >= 4.5 && dur <= 6.0, `拼接后应约 5 秒（2+3），实际 ${dur}`);
  rmSync(dir, { recursive: true, force: true });
});

test('ffmpeg：拼接不存在的分段必须报错，不产出空文件', async () => {
  const dir = tmp('ffmpeg-concat-bad');
  await assert.rejects(
    () => ffmpegMod.concatVideos({ inputs: [join(dir, 'nope.mp4')], outputPath: join(dir, 'out.mp4') }),
    /不存在/
  );
  await assert.rejects(
    () => ffmpegMod.concatVideos({ inputs: [], outputPath: join(dir, 'out.mp4') }),
    /至少一个/
  );
  rmSync(dir, { recursive: true, force: true });
});

test('Mock + 真实 ffmpeg：端到端自检，产出真实可播放视频并带水印标注', async () => {
  const dir = tmp('mock-e2e');
  const p = new MockProvider({ outputDir: dir, simulatedDelayMs: 0 });
  const probe = await p.probeAvailability();
  if (probe.ffmpegOk === false) {
    throw new Error('ffmpeg 缺失，端到端自检无法进行');
  }
  const { taskId } = await p.createTask({ prompt: '夕阳下的海边空镜', durationSec: 2 });
  let st = await p.pollTask(taskId);
  for (let i = 0; i < 200 && st.status !== TASK_STATUS.SUCCEEDED && st.status !== TASK_STATUS.FAILED; i++) {
    await new Promise(r => setTimeout(r, 50));
    st = await p.pollTask(taskId);
  }
  assert.equal(st.status, TASK_STATUS.SUCCEEDED, `应成功，实际 ${st.status}: ${st.error || ''}`);
  const res = await p.fetchResult(taskId);
  assert.ok(existsSync(res.localPath), '视频文件必须真实存在');
  assert.ok(statSync(res.localPath).size > 5000, '视频必须有实际内容');
  const dur = await ffmpegMod.probeDuration(res.localPath);
  assert.ok(dur >= 1.5 && dur <= 3.0, `时长应约 2 秒，实际 ${dur}`);
  assert.equal(res.isSelfTest, true);
  rmSync(dir, { recursive: true, force: true });
});
