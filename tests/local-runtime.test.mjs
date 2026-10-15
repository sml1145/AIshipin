import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const runtime = require('../src/main/local-runtime.js');
const catalogMod = require('../src/main/catalog.js');
const pathsMod = require('../src/main/paths.js');
const hardware = require('../src/main/hardware.js');

const here = dirname(fileURLToPath(import.meta.url));
const bundled = join(here, '..', 'models.json');
const catalog = catalogMod.load({ catalogBundled: bundled, catalogCached: null }).catalog;
const localModels = catalog.models.filter(m => m.track === 'local');
const ltx = localModels.find(m => m.id === 'local-ltx-2b-fp8');
const cog = localModels.find(m => m.id === 'local-cogvideox-2b');

function tmp(prefix) { return mkdtempSync(join(tmpdir(), `hxsk-rt-${prefix}-`)); }
function makePaths() {
  const dir = tmp('paths');
  const p = pathsMod.resolvePaths({ appPath: dir, userDataPath: join(dir, 'ud'), resourcesPath: dir, isPackaged: false, homeDir: dir });
  pathsMod.ensureDirs(p);
  return p;
}
/** 假下载 fetch：任何 URL 都返回一段字节 */
function fakeDlFetch(content = 'WEIGHTBYTES') {
  return async (url) => {
    const buf = Buffer.from(content);
    return { ok: true, status: 200, headers: { get: (k) => (k.toLowerCase() === 'content-length' ? String(buf.length) : null) }, body: (async function* () { yield buf; })() };
  };
}

/* ============ 源构造 ============ */

test('Python 源：三镜像且均为实测可达域名', () => {
  const src = runtime.pythonEmbedSources('3.11.9');
  assert.equal(src.length, 3);
  assert.ok(src.some(s => s.url.includes('python.org')));
  assert.ok(src.some(s => s.url.includes('npmmirror')));
  assert.ok(src.some(s => s.url.includes('huaweicloud')));
  assert.ok(src.every(s => s.url.includes('python-3.11.9-embed-amd64.zip')));
});

test('权重源：ModelScope resolve URL 正确，保留子目录相对路径', () => {
  const src = runtime.weightSources(cog);
  // CogVideoX 有 4 个权重文件，其中含子目录
  assert.equal(src.length, 4);
  const rel = src.map(s => s.relPath);
  assert.ok(rel.includes('transformer/diffusion_pytorch_model.safetensors'));
  assert.ok(rel.some(r => r.startsWith('text_encoder/')));
  assert.ok(rel.some(r => r.startsWith('vae/')));
  for (const s of src) {
    assert.ok(s.url.startsWith('https://www.modelscope.cn/models/ZhipuAI/CogVideoX-2b/resolve/master/'), `URL 应指向 ModelScope resolve: ${s.url}`);
    assert.ok(s.url.includes(s.relPath), 'URL 应包含相对路径');
  }
});

test('权重源：LTX 单文件也正确', () => {
  const src = runtime.weightSources(ltx);
  assert.equal(src.length, 1);
  assert.ok(src[0].url.includes('ltx-video-2b-v0.9.1.safetensors'));
});

/* ============ 安装计划 ============ */

test('安装计划：含 Python + pip + 全部权重项，并带体积与预检', () => {
  const paths = makePaths();
  const hw = { vramGB: 8, totalRamGB: 15.2, diskFreeGB: 100, vramSource: 'nvidia-smi' };
  const plan = runtime.buildInstallPlan({ model: ltx, paths, hardware: hw });
  assert.equal(plan.modelId, 'local-ltx-2b-fp8');
  assert.ok(plan.items.some(i => i.kind === 'python'));
  assert.ok(plan.items.some(i => i.kind === 'pip'));
  assert.ok(plan.items.some(i => i.kind === 'weight'));
  assert.equal(plan.totalDownloadGB, ltx.downloadGB);
  assert.equal(plan.requiredDiskGB, 20);
  assert.ok(plan.readiness, '应带硬件就绪评估');
  assert.equal(plan.readiness.canInstall, true);
});

test('安装计划：CogVideoX 的权重项数=4（含子目录文件，验证 basename bug 已修）', () => {
  const paths = makePaths();
  const plan = runtime.buildInstallPlan({ model: cog, paths, hardware: { vramGB: 8, totalRamGB: 15.2, diskFreeGB: 100 } });
  const weightItems = plan.items.filter(i => i.kind === 'weight');
  assert.equal(weightItems.length, 4, 'CogVideoX 有 4 个权重文件，计划必须全部列出');
  // 目标路径必须保留子目录，不能用 basename 拍平
  assert.ok(weightItems.some(i => i.destPath.includes('transformer')));
  assert.ok(weightItems.some(i => i.destPath.includes('text_encoder')));
});

test('安装计划：磁盘不足时 readiness.canInstall=false 并说明', () => {
  const paths = makePaths();
  const plan = runtime.buildInstallPlan({ model: ltx, paths, hardware: { vramGB: 8, totalRamGB: 15.2, diskFreeGB: 5 } });
  assert.equal(plan.readiness.canInstall, false);
  assert.ok(plan.readiness.problems.join().includes('磁盘'));
});

/* ============ 执行安装 ============ */

test('安装执行关键：预检不过时不下载任何文件，直接 PRECHECK_FAILED', async () => {
  const paths = makePaths();
  const plan = runtime.buildInstallPlan({ model: ltx, paths, hardware: { vramGB: 8, totalRamGB: 15.2, diskFreeGB: 3 } });
  let downloaded = false;
  const r = await runtime.runInstallPlan({
    plan, paths,
    fetchImpl: async () => { downloaded = true; throw new Error('不应被调用'); },
    unzipImpl: async () => { downloaded = true; },
    pipImpl: async () => { downloaded = true; }
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'PRECHECK_FAILED');
  assert.equal(downloaded, false, '预检失败绝不能触发下载');
});

test('安装执行：skipNetwork 模式下各步标记 skipped，不联网', async () => {
  const paths = makePaths();
  const plan = runtime.buildInstallPlan({ model: ltx, paths, hardware: { vramGB: 8, totalRamGB: 15.2, diskFreeGB: 100 } });
  const r = await runtime.runInstallPlan({ plan, paths, skipNetwork: true });
  assert.equal(r.ok, true);
  assert.ok(r.steps.every(s => s.skipped === true), 'skipNetwork 下所有步骤应标记 skipped');
});

test('安装执行：注入假下载/解压/pip，验证完整流程与进度回调顺序', async () => {
  const paths = makePaths();
  const plan = runtime.buildInstallPlan({ model: ltx, paths, hardware: { vramGB: 8, totalRamGB: 15.2, diskFreeGB: 100 } });
  const phases = [];
  let unzipCalled = false, pipCalled = false;
  const r = await runtime.runInstallPlan({
    plan, paths,
    fetchImpl: fakeDlFetch(),
    unzipImpl: async () => { unzipCalled = true; },
    pipImpl: async () => { pipCalled = true; },
    onProgress: (p) => phases.push(p.phase)
  });
  assert.equal(r.ok, true, `应成功，实际 ${r.error}`);
  assert.ok(unzipCalled, 'Python 包应被解压');
  assert.ok(pipCalled, 'pip 依赖应被安装');
  // 阶段顺序：python → pip → weight
  const firstIdx = (ph) => phases.indexOf(ph);
  assert.ok(firstIdx('python') < firstIdx('pip'), 'python 应先于 pip');
  assert.ok(firstIdx('pip') < firstIdx('weight'), 'pip 应先于权重');
  // 安装了 marker
  assert.ok(existsSync(join(paths.modelsDir, 'local-ltx-2b-fp8', 'installed.json')));
  rmSync(paths.userData, { recursive: true, force: true });
});

test('安装执行：权重下载失败时归因 WEIGHT_FAILED 并带文件名', async () => {
  const paths = makePaths();
  const plan = runtime.buildInstallPlan({ model: ltx, paths, hardware: { vramGB: 8, totalRamGB: 15.2, diskFreeGB: 100 } });
  let callCount = 0;
  const r = await runtime.runInstallPlan({
    plan, paths,
    // python 下载成功，权重下载失败
    fetchImpl: async (url) => {
      callCount++;
      if (url.includes('modelscope')) throw new Error('ModelScope 503');
      const buf = Buffer.from('PYZIP');
      return { ok: true, status: 200, headers: { get: () => null }, body: (async function* () { yield buf; })() };
    },
    unzipImpl: async () => {},
    pipImpl: async () => {}
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'WEIGHT_FAILED');
  assert.ok(r.error.includes('权重下载失败'));
  rmSync(paths.userData, { recursive: true, force: true });
});

test('安装执行：pip 失败时归因 PIP_FAILED', async () => {
  const paths = makePaths();
  const plan = runtime.buildInstallPlan({ model: ltx, paths, hardware: { vramGB: 8, totalRamGB: 15.2, diskFreeGB: 100 } });
  const r = await runtime.runInstallPlan({
    plan, paths,
    fetchImpl: fakeDlFetch(),
    unzipImpl: async () => {},
    pipImpl: async () => { throw new Error('torch cu124 下载超时'); }
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'PIP_FAILED');
  assert.ok(r.error.includes('torch'));
  rmSync(paths.userData, { recursive: true, force: true });
});

test('安装执行：Python 下载失败时归因 PYTHON_FAILED', async () => {
  const paths = makePaths();
  const plan = runtime.buildInstallPlan({ model: ltx, paths, hardware: { vramGB: 8, totalRamGB: 15.2, diskFreeGB: 100 } });
  const r = await runtime.runInstallPlan({
    plan, paths,
    fetchImpl: async () => { throw new Error('python.org 不可达'); },
    unzipImpl: async () => {},
    pipImpl: async () => {}
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'PYTHON_FAILED');
});

/* ============ 已安装判定 ============ */

test('isModelInstalled：LTX 单文件存在才算已安装', () => {
  const paths = makePaths();
  assert.equal(runtime.isModelInstalled(ltx, paths), false, '未下载时应为 false');
  const dest = join(paths.modelsDir, 'local-ltx-2b-fp8', 'ltx-video-2b-v0.9.1.safetensors');
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, 'x');
  assert.equal(runtime.isModelInstalled(ltx, paths), true);
  rmSync(paths.userData, { recursive: true, force: true });
});

test('isModelInstalled 关键：CogVideoX 必须全部子目录文件都在才算已安装（防 basename 误判）', () => {
  const paths = makePaths();
  const base = join(paths.modelsDir, 'local-cogvideox-2b');
  // 只放主文件（transformer/...），不放 text_encoder 与 vae
  mkdirSync(join(base, 'transformer'), { recursive: true });
  writeFileSync(join(base, 'transformer', 'diffusion_pytorch_model.safetensors'), 'x');
  assert.equal(runtime.isModelInstalled(cog, paths), false, '缺子目录文件时必须判未安装');
  // 补齐其余文件
  for (const f of cog.weights.extraFiles) {
    mkdirSync(join(base, dirname(f.file)), { recursive: true });
    writeFileSync(join(base, f.file), 'x');
  }
  assert.equal(runtime.isModelInstalled(cog, paths), true, '全部文件就位才算已安装');
  rmSync(paths.userData, { recursive: true, force: true });
});

test('isModelInstalled：无 weights 定义的模型返回 false', () => {
  const paths = makePaths();
  assert.equal(runtime.isModelInstalled({ id: 'x', track: 'local' }, paths), false);
});
