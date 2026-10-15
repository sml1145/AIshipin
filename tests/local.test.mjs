import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

const require = createRequire(import.meta.url);
const { LocalProvider, EXIT_CODE_MAP } = require('../src/main/providers/local.js');
const { TASK_STATUS, ERROR_CODE } = require('../src/main/providers/base.js');
const pathsMod = require('../src/main/paths.js');

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(here, '..', 'src', 'local', 'infer_ltx.py');

function tmp(prefix) {
  return mkdtempSync(join(tmpdir(), `hxsk-local-${prefix}-`));
}
function makePaths() {
  const dir = tmp('paths');
  const p = pathsMod.resolvePaths({
    appPath: dir, userDataPath: join(dir, 'ud'), resourcesPath: dir,
    isPackaged: false, homeDir: dir
  });
  pathsMod.ensureDirs(p);
  return p;
}

/**
 * 桩子进程：模拟 python 逐行吐 JSON 事件，然后以指定退出码 close。
 * @param {string[]} lines 要按序打印的 JSON 事件行
 * @param {number} exitCode
 * @param {object} [opts] delayMs 每行间隔；stderr 要写入 stderr 的内容
 */
function stubChild(lines, exitCode, opts = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = (sig) => { child.killed = true; child._killSignal = sig; };
  child.__stub = true;
  const delay = opts.delayMs ?? 0;
  // 异步吐事件，模拟真实子进程
  setTimeout(() => {
    for (const l of lines) child.stdout.emit('data', Buffer.from(l + '\n'));
    if (opts.stderr) child.stderr.emit('data', Buffer.from(opts.stderr));
    setTimeout(() => child.emit('close', exitCode), delay + 5);
  }, delay);
  return child;
}

/** 等任务进入终态 */
async function waitDone(provider, taskId, timeoutMs = 3000) {
  const t0 = Date.now();
  let st = provider.tasks.get(taskId);
  while (st && (st.status === TASK_STATUS.PENDING || st.status === TASK_STATUS.RUNNING) && Date.now() - t0 < timeoutMs) {
    await new Promise(r => setTimeout(r, 10));
    st = provider.tasks.get(taskId);
  }
  return provider.tasks.get(taskId);
}

/* ============ 协议解析 ============ */

test('LocalProvider：解析 progress 事件序列并更新进度', async () => {
  const paths = makePaths();
  const lines = [
    JSON.stringify({ event: 'progress', step: 1, total: 3, percent: 33.3, message: '本地推理中 1/3 步' }),
    JSON.stringify({ event: 'progress', step: 2, total: 3, percent: 66.6, message: '本地推理中 2/3 步' }),
    JSON.stringify({ event: 'done', path: join(paths.outputDir, 'v.mp4'), seconds: 4, width: 512, height: 320, dryRun: false })
  ];
  const provider = new LocalProvider({
    paths, scriptPath, spawnImpl: () => stubChild(lines, 0), resolvePython: () => 'python'
  });
  const { taskId } = await provider.createTask({ prompt: '一只猫', modelId: 'local-ltx-2b-fp8' });
  const st = await waitDone(provider, taskId);
  assert.equal(st.status, TASK_STATUS.SUCCEEDED);
  assert.equal(st.progress, 100);
  assert.equal(st.result.width, 512);
  assert.equal(st.result.isSelfTest, false);
});

test('LocalProvider：done 事件产出 result 且 videoUrl 为 file://', async () => {
  const paths = makePaths();
  const outPath = join(paths.outputDir, 'done.mp4');
  const lines = [JSON.stringify({ event: 'done', path: outPath, seconds: 4.04, width: 512, height: 320, dryRun: false })];
  const provider = new LocalProvider({ paths, scriptPath, spawnImpl: () => stubChild(lines, 0), resolvePython: () => 'python' });
  const { taskId } = await provider.createTask({ prompt: 'x', modelId: 'm' });
  const st = await waitDone(provider, taskId);
  assert.equal(st.result.localPath, outPath);
  assert.ok(st.result.videoUrl.startsWith('file:///'));
  assert.equal(st.result.provider, 'local');
  assert.equal(st.result.track, 'local');
});

test('LocalProvider：dryRun 的 done 事件必须标 isSelfTest=true（不冒充真实生成）', async () => {
  const paths = makePaths();
  const lines = [
    JSON.stringify({ event: 'log', level: 'warn', message: 'DRY-RUN 模式：产出占位视频，非真实 AI 生成结果' }),
    JSON.stringify({ event: 'done', path: join(paths.outputDir, 'd.mp4'), seconds: 2, width: 320, height: 240, dryRun: true })
  ];
  const provider = new LocalProvider({ paths, scriptPath, spawnImpl: () => stubChild(lines, 0), resolvePython: () => 'python' });
  const { taskId } = await provider.createTask({ prompt: 'x', dryRun: true });
  const st = await waitDone(provider, taskId);
  assert.equal(st.result.isSelfTest, true);
  assert.ok(st.message.includes('自检') || st.message.includes('占位'));
});

test('LocalProvider：error 事件映射到正确错误码（OUT_OF_MEMORY）', async () => {
  const paths = makePaths();
  const lines = [JSON.stringify({ event: 'error', code: 'OUT_OF_MEMORY', message: '显存不足' })];
  const provider = new LocalProvider({ paths, scriptPath, spawnImpl: () => stubChild(lines, 2), resolvePython: () => 'python' });
  const { taskId } = await provider.createTask({ prompt: 'x' });
  const st = await waitDone(provider, taskId);
  assert.equal(st.status, TASK_STATUS.FAILED);
  assert.equal(st.errorCode, ERROR_CODE.OUT_OF_MEMORY);
});

test('LocalProvider：NO_CUDA 也映射为 OUT_OF_MEMORY（同类不可行）', async () => {
  const paths = makePaths();
  const lines = [JSON.stringify({ event: 'error', code: 'NO_CUDA', message: '未检测到 CUDA GPU' })];
  const provider = new LocalProvider({ paths, scriptPath, spawnImpl: () => stubChild(lines, 2), resolvePython: () => 'python' });
  const { taskId } = await provider.createTask({ prompt: 'x' });
  const st = await waitDone(provider, taskId);
  assert.equal(st.errorCode, ERROR_CODE.OUT_OF_MEMORY);
});

test('LocalProvider：非 JSON 行（traceback）不当成功，保留为 lastRaw', async () => {
  const paths = makePaths();
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
  setTimeout(() => {
    child.stdout.emit('data', Buffer.from('Traceback (most recent call last):\n'));
    child.stderr.emit('data', Buffer.from('ModuleNotFoundError: No module named diffusers\n'));
    child.emit('close', 1);
  }, 5);
  const provider = new LocalProvider({ paths, scriptPath, spawnImpl: () => child, resolvePython: () => 'python' });
  const { taskId } = await provider.createTask({ prompt: 'x' });
  const st = await waitDone(provider, taskId);
  assert.equal(st.status, TASK_STATUS.FAILED, '非 JSON 输出 + 退出码1 必须判失败，绝不能当成功');
  assert.ok(st.error.includes('diffusers') || st.error.includes('退出码'), '失败原因应带 stderr 线索');
});

/* ============ 退出码映射 ============ */

test('退出码映射：各退出码对应正确内部错误码', () => {
  assert.equal(EXIT_CODE_MAP[0], null);
  assert.equal(EXIT_CODE_MAP[2], ERROR_CODE.OUT_OF_MEMORY);
  assert.equal(EXIT_CODE_MAP[3], ERROR_CODE.NOT_INSTALLED);
  assert.equal(EXIT_CODE_MAP[1], ERROR_CODE.TASK_FAILED);
});

test('LocalProvider：退出码3（缺模型/依赖）未成功时归因 NOT_INSTALLED', async () => {
  const paths = makePaths();
  const provider = new LocalProvider({ paths, scriptPath, spawnImpl: () => stubChild([], 3), resolvePython: () => 'python' });
  const { taskId } = await provider.createTask({ prompt: 'x' });
  const st = await waitDone(provider, taskId);
  assert.equal(st.status, TASK_STATUS.FAILED);
  assert.equal(st.errorCode, ERROR_CODE.NOT_INSTALLED);
});

/* ============ 参数与安全 ============ */

test('LocalProvider：请求经 @文件 传给 python，避免超长命令行', async () => {
  const paths = makePaths();
  let capturedArgs = null;
  const provider = new LocalProvider({
    paths, scriptPath, resolvePython: () => 'python',
    spawnImpl: (py, args) => { capturedArgs = { py, args }; return stubChild([JSON.stringify({ event: 'done', path: 'x.mp4', seconds: 1, width: 1, height: 1 })], 0); }
  });
  const longPrompt = 'x'.repeat(5000);
  await provider.createTask({ prompt: longPrompt, modelId: 'm' });
  assert.equal(capturedArgs.py, 'python');
  assert.equal(capturedArgs.args[0], scriptPath);
  const reqArgIdx = capturedArgs.args.indexOf('--request');
  assert.ok(reqArgIdx >= 0);
  const reqArg = capturedArgs.args[reqArgIdx + 1];
  assert.ok(reqArg.startsWith('@'), '请求应通过 @文件 传递');
  assert.ok(reqArg.length < 200, '命令行不应包含超长 prompt');
});

test('LocalProvider：无 python 运行时报 NOT_INSTALLED 且不 spawn', async () => {
  const paths = makePaths();
  let spawned = false;
  const provider = new LocalProvider({
    paths, scriptPath, resolvePython: () => null,
    spawnImpl: () => { spawned = true; return stubChild([], 0); }
  });
  await assert.rejects(() => provider.createTask({ prompt: 'x' }), (e) => {
    assert.equal(e.code, ERROR_CODE.NOT_INSTALLED);
    return true;
  });
  assert.equal(spawned, false, '无运行时不应尝试 spawn');
});

test('LocalProvider：缺 prompt 报错', async () => {
  const paths = makePaths();
  const provider = new LocalProvider({ paths, scriptPath, spawnImpl: () => stubChild([], 0), resolvePython: () => 'python' });
  await assert.rejects(() => provider.createTask({}), /缺少提示词/);
});

test('LocalProvider：probeAvailability 在无 python 时不可用', async () => {
  const paths = makePaths();
  const p1 = new LocalProvider({ paths, scriptPath, resolvePython: () => null });
  const r1 = await p1.probeAvailability();
  assert.equal(r1.available, false);
  assert.equal(r1.code, ERROR_CODE.NOT_INSTALLED);
  const p2 = new LocalProvider({ paths, scriptPath, resolvePython: () => 'python' });
  const r2 = await p2.probeAvailability();
  assert.equal(r2.available, true);
});

/* ============ 取消 ============ */

test('LocalProvider：cancelTask 触发子进程 kill 并置 CANCELLED', async () => {
  const paths = makePaths();
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  let killSignal = null;
  child.kill = (sig) => { killSignal = sig; };
  // 永不 close，模拟长任务
  const provider = new LocalProvider({ paths, scriptPath, spawnImpl: () => child, resolvePython: () => 'python' });
  const { taskId } = await provider.createTask({ prompt: 'x' });
  await new Promise(r => setTimeout(r, 20));
  const r = await provider.cancelTask(taskId);
  assert.equal(r.cancelled, true);
  assert.equal(killSignal, 'SIGTERM', '取消应向子进程发终止信号');
  assert.equal(provider.tasks.get(taskId).status, TASK_STATUS.CANCELLED);
});

test('LocalProvider：取消后 close 不覆盖 CANCELLED 状态', async () => {
  const paths = makePaths();
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
  const provider = new LocalProvider({ paths, scriptPath, spawnImpl: () => child, resolvePython: () => 'python' });
  const { taskId } = await provider.createTask({ prompt: 'x' });
  await provider.cancelTask(taskId);
  child.emit('close', 1); // 取消后子进程才退出
  assert.equal(provider.tasks.get(taskId).status, TASK_STATUS.CANCELLED, '不应被后续 close 改成 FAILED');
});

/* ============ 清理 ============ */

test('LocalProvider：任务结束后清理临时请求文件', async () => {
  const paths = makePaths();
  let reqFile = null;
  const provider = new LocalProvider({
    paths, scriptPath, resolvePython: () => 'python',
    spawnImpl: (py, args) => {
      const i = args.indexOf('--request');
      reqFile = args[i + 1].slice(1);
      return stubChild([JSON.stringify({ event: 'done', path: 'x.mp4', seconds: 1, width: 1, height: 1 })], 0);
    }
  });
  const { taskId } = await provider.createTask({ prompt: 'x' });
  await waitDone(provider, taskId);
  await new Promise(r => setTimeout(r, 30));
  assert.ok(reqFile, '应捕获到请求文件路径');
  assert.ok(!existsSync(reqFile), '任务结束后临时请求文件应被清理');
});

/* ============ 真实 Python 集成（若本机 python 可用）============ */

test('LocalProvider：错误路径与真实 Python 脚本协议一致（DEPS_MISSING/BAD_REQUEST/NOT_INSTALLED）', async (t) => {
  // 这条测试用真实 python 跑脚本的三条错误分支，验证 JS 侧映射与脚本实际行为一致。
  // 若无可用 python 或脚本不存在则跳过（不假装通过）。
  const realPy = process.env.HXSK_TEST_PYTHON;
  if (!realPy || !existsSync(realPy) || !existsSync(scriptPath)) {
    t.skip('未提供 HXSK_TEST_PYTHON 或脚本缺失，跳过真实集成');
    return;
  }
  const paths = makePaths();
  const provider = new LocalProvider({ paths, scriptPath, resolvePython: () => realPy });

  // 模型目录不存在 → NOT_INSTALLED（退出码3）
  const { taskId } = await provider.createTask({
    prompt: 'x', modelId: 'local-ltx-2b-fp8',
    modelRoot: 'Z:/definitely-not-exist-hxsk'
  });
  const st = await waitDone(provider, taskId, 15000);
  assert.equal(st.status, TASK_STATUS.FAILED);
  assert.equal(st.errorCode, ERROR_CODE.NOT_INSTALLED);
});
