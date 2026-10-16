import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sc = require('../src/main/local-selfcheck.js');
const pathsMod = require('../src/main/paths.js');
const catalogMod = require('../src/main/catalog.js');
const { LocalProvider } = require('../src/main/providers/local.js');
const { TASK_STATUS } = require('../src/main/providers/base.js');

const here = dirname(fileURLToPath(import.meta.url));
const bundled = join(here, '..', 'models.json');
const catalog = catalogMod.load({ catalogBundled: bundled, catalogCached: null }).catalog;
const ltx = catalog.models.find(m => m.id === 'local-ltx-2b-fp8');

function tmp(prefix) { return mkdtempSync(join(tmpdir(), `hxsk-sc-${prefix}-`)); }
function makePaths() {
  const dir = tmp('paths');
  const p = pathsMod.resolvePaths({ appPath: dir, userDataPath: join(dir, 'ud'), resourcesPath: dir, isPackaged: false, homeDir: dir });
  pathsMod.ensureDirs(p);
  return p;
}

// 真实 Python（有则跑集成，无则跳过——不假装通过）
const REAL_PY = process.env.HXSK_TEST_PYTHON || null;
const hasRealPy = REAL_PY && existsSync(REAL_PY);

/* ============ resolveScriptDir ============ */

test('resolveScriptDir: 能找到含 env_probe.py 的脚本目录', () => {
  const paths = makePaths();
  const dir = sc.resolveScriptDir(paths);
  assert.ok(dir, '应能定位脚本目录');
  assert.ok(existsSync(join(dir, 'env_probe.py')), '目录下应有 env_probe.py');
  assert.ok(existsSync(join(dir, 'infer_ltx.py')), '目录下应有 infer_ltx.py');
});

/* ============ runPython ============ */

test('runPython: 脚本不存在时返回 ok:false 且不抛异常', async () => {
  const paths = makePaths();
  const r = await sc.runPython(paths.localScriptsDir, 'python', 'no_such_script.py', []);
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('不存在'));
  assert.deepEqual(r.events, []);
});

/* ============ probeEnv（真实 Python 集成）============ */

test('probeEnv: 真实运行探针，缺 torch 时如实报告（不假装就绪）', async (t) => {
  if (!hasRealPy) { t.skip('未提供 HXSK_TEST_PYTHON'); return; }
  const paths = makePaths();
  const r = await sc.probeEnv({ paths, pythonPath: REAL_PY });
  assert.equal(r.ok, true, '探针应成功执行');
  assert.equal(r.report.event, 'probe', 'probe 事件应保留 event 标识');
  assert.ok(typeof r.report.python === 'string', '应报告 Python 版本');
  assert.ok(typeof r.report.cuda === 'boolean');
  assert.ok(Array.isArray(r.report.problems));
  // 当前环境无 torch → gpuReady 必为 false，且 problems 必须点名 torch
  assert.equal(r.report.gpuReady, false);
  assert.ok(r.report.problems.some(p => p.includes('torch')), '应如实指出缺 torch');
});

test('probeEnv: 指定权重清单时逐个检查缺失文件', async (t) => {
  if (!hasRealPy) { t.skip(); return; }
  const paths = makePaths();
  const modelRoot = join(paths.modelsDir, 'local-ltx-2b-fp8');
  const r = await sc.probeEnv({
    paths, pythonPath: REAL_PY, modelRoot,
    weightFiles: [ltx.weights.file]
  });
  assert.equal(r.ok, true);
  const w = r.report.weights;
  assert.equal(w.modelRoot, modelRoot);
  assert.deepEqual(w.present, []);
  assert.deepEqual(w.missing, [ltx.weights.file], '未下载时应报告权重缺失');
  assert.ok(r.report.problems.some(p => p.includes('权重缺失')));
});

test('probeEnv: 权重真实存在时计入 present（用假文件模拟）', async (t) => {
  if (!hasRealPy) { t.skip(); return; }
  const paths = makePaths();
  const modelRoot = join(paths.modelsDir, 'local-ltx-2b-fp8');
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(modelRoot, { recursive: true });
  writeFileSync(join(modelRoot, ltx.weights.file), 'fake-weight-bytes');
  const r = await sc.probeEnv({ paths, pythonPath: REAL_PY, modelRoot, weightFiles: [ltx.weights.file] });
  assert.deepEqual(r.report.weights.present, [ltx.weights.file]);
  assert.deepEqual(r.report.weights.missing, []);
  rmSync(paths.userData, { recursive: true, force: true });
});

/* ============ dryRunPipeline（真实 Python + numpy/imageio 时端到端）============ */

test('dryRunPipeline: python 缺失依赖时如实失败，不伪造产物', async (t) => {
  if (!hasRealPy) { t.skip(); return; }
  const paths = makePaths();
  const r = await sc.dryRunPipeline({ paths, pythonPath: REAL_PY, LocalProvider });
  // 当前 uv python 无 numpy/imageio → dry-run 应失败并报 DEPS_MISSING 相关原因
  if (!r.ok) {
    assert.ok(r.error, '失败必须带原因');
    assert.ok(/numpy|imageio|依赖|DEPS/i.test(r.error), '应指向依赖缺失: ' + r.error);
  } else {
    // 若环境恰好有依赖，则必须产出真实文件且标注自检
    assert.equal(r.result.isSelfTest, true);
    assert.equal(r.result.fileExists, true);
  }
});

/* ============ runLocalSelfCheck 汇总 ============ */

test('runLocalSelfCheck: 汇总结论含 summary 且不伪造 gpuReady', async (t) => {
  if (!hasRealPy) { t.skip(); return; }
  const paths = makePaths();
  const r = await sc.runLocalSelfCheck({ paths, pythonPath: REAL_PY, LocalProvider, model: ltx });
  assert.equal(typeof r.summary, 'string');
  assert.ok(r.summary.includes('Python'), 'summary 应含 Python 状态');
  assert.ok(r.summary.includes('CUDA'));
  assert.ok(r.summary.includes('权重'));
  assert.ok(r.summary.includes('dry-run'));
  assert.equal(r.gpuReady, false, '无 torch/CUDA 环境不得谎报就绪');
  assert.ok(Array.isArray(r.problems) && r.problems.length > 0, '应如实列出问题');
});

test('runLocalSelfCheck: skipDryRun 时只跑探针', async (t) => {
  if (!hasRealPy) { t.skip(); return; }
  const paths = makePaths();
  const r = await sc.runLocalSelfCheck({ paths, pythonPath: REAL_PY, LocalProvider, model: ltx, skipDryRun: true });
  assert.equal(r.dryRun.skipped, true);
  assert.ok(r.summary.includes('已跳过'));
  assert.ok(r.env, '应有探针报告');
});

/* ============ pythonPath 缺失路径 ============ */

test('runLocalSelfCheck: pythonPath 为 null 时由调用方兜底（模块层不崩）', async () => {
  const paths = makePaths();
  // 传一个必然失败的 pythonPath，验证不会抛未捕获异常而是结构化返回
  const r = await sc.probeEnv({ paths, pythonPath: join(tmpdir(), 'no-such-python.exe') });
  assert.equal(r.ok, false);
  assert.equal(r.report.ready, false);
  assert.ok(r.report.problems.length > 0, '探针无输出时应给出结构化问题而非崩溃');
});
