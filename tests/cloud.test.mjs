import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DashScopeProvider, STATUS_MAP: DS_STATUS_MAP } = require('../src/main/providers/dashscope.js');
const { SiliconFlowProvider, STATUS_MAP: SF_STATUS_MAP, VALID_SIZES, pickImageSize } = require('../src/main/providers/siliconflow.js');
const { TASK_STATUS, ERROR_CODE, ProviderError } = require('../src/main/providers/base.js');
const http = require('../src/main/http.js');
const downloader = require('../src/main/downloader.js');

const here = dirname(fileURLToPath(import.meta.url));

function tmp(prefix) {
  return mkdtempSync(join(tmpdir(), `hxsk-cloud-${prefix}-`));
}

/** 造一个可编程的假 fetch，记录所有请求并按脚本响应 */
function fakeFetch(script) {
  const calls = [];
  const impl = async (url, opts = {}) => {
    calls.push({ url, opts });
    const match = typeof script === 'function' ? script(url, opts, calls.length - 1) : script[url] || script.default;
    if (!match) throw new Error(`假 fetch 未定义该 URL 的响应: ${url}`);
    if (match instanceof Error) throw match;
    return {
      ok: match.ok !== false,
      status: match.status || 200,
      headers: { get: (k) => (match.headers || {})[k] ?? null, forEach: () => {} },
      text: async () => (typeof match.body === 'string' ? match.body : JSON.stringify(match.body ?? '')),
      body: null
    };
  };
  return { impl, calls };
}

/** 假下载：直接把文件写出来，避免真实联网 */
function fakeDownloadFetch(content = 'MP4FAKE') {
  const impl = async (url) => {
    const buf = Buffer.from(content);
    return {
      ok: true, status: 200,
      headers: { get: (k) => (k.toLowerCase() === 'content-length' ? String(buf.length) : null) },
      body: (async function* () { yield buf; })()
    };
  };
  return impl;
}

/* ============ HTTP 共享层 ============ */

test('HTTP：可重试状态码判定正确', () => {
  for (const s of [408, 425, 429, 500, 502, 503, 504]) {
    assert.equal(http.isRetryableStatus(s), true, `${s} 应可重试`);
  }
  for (const s of [200, 400, 401, 403, 404, 422]) {
    assert.equal(http.isRetryableStatus(s), false, `${s} 不应重试`);
  }
});

test('HTTP：网络层错误判定可重试，业务错误不可', () => {
  assert.equal(http.isRetryableError(new Error('fetch failed ENOTFOUND')), true);
  assert.equal(http.isRetryableError(new Error('socket hang up')), true);
  assert.equal(http.isRetryableError(new Error('The operation was aborted due to timeout')), true);
  assert.equal(http.isRetryableError(new Error('Invalid API Key provided')), false);
});

test('HTTP：2xx 返回解析出的 JSON', async () => {
  const f = fakeFetch({ default: { status: 200, body: { a: 1 } } });
  const r = await http.httpRequest({ url: 'https://x.test/api', fetchImpl: f.impl, retries: 0 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.json, { a: 1 });
});

test('HTTP：4xx 抛错并带上响应体里的真实原因', async () => {
  const f = fakeFetch({ default: { ok: false, status: 400, body: { message: 'image_size is required' } } });
  await assert.rejects(
    () => http.httpRequest({ url: 'https://x.test/api', fetchImpl: f.impl, retries: 0 }),
    (e) => {
      assert.equal(e.status, 400);
      assert.ok(e.message.includes('image_size is required'), '必须暴露平台给的真实原因');
      return true;
    }
  );
});

test('HTTP：401 不重试（重试也没用），500 会重试', async () => {
  const f401 = fakeFetch({ default: { ok: false, status: 401, body: { message: 'Invalid token' } } });
  await assert.rejects(() => http.httpRequest({ url: 'https://x.test', fetchImpl: f401.impl, retries: 2 }));
  assert.equal(f401.calls.length, 1, '401 不应重试');

  const f500 = fakeFetch({ default: { ok: false, status: 500, body: { message: 'boom' } } });
  await assert.rejects(() => http.httpRequest({ url: 'https://x.test', fetchImpl: f500.impl, retries: 1 }));
  assert.equal(f500.calls.length, 2, '500 应重试一次');
});

test('HTTP：对象 body 自动 JSON 序列化并补 Content-Type', async () => {
  const f = fakeFetch({ default: { status: 200, body: {} } });
  await http.httpRequest({ url: 'https://x.test', method: 'POST', body: { a: 1 }, fetchImpl: f.impl, retries: 0 });
  assert.equal(f.calls[0].opts.body, '{"a":1}');
  assert.equal(f.calls[0].opts.headers['Content-Type'], 'application/json');
});

test('HTTP：图片转 base64 data URL 且 MIME 正确', () => {
  const dir = tmp('img');
  const p = join(dir, 'a.png');
  writeFileSync(p, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const r = http.fileToDataUrl(p);
  assert.ok(r.dataUrl.startsWith('data:image/png;base64,'));
  assert.equal(r.mime, 'image/png');
  assert.equal(r.bytes, 8);
  const jpg = join(dir, 'b.jpg');
  writeFileSync(jpg, Buffer.from([0xff, 0xd8, 0xff]));
  assert.equal(http.fileToDataUrl(jpg).mime, 'image/jpeg');
  rmSync(dir, { recursive: true, force: true });
});

/* ============ DashScope（百炼）============ */

test('DashScope关键：提交请求必须符合官方文档（异步头 + input/parameters 结构）', async () => {
  const f = fakeFetch({ default: { status: 200, body: { output: { task_id: 'abc123', task_status: 'PENDING' } } } });
  const p = new DashScopeProvider({ getApiKey: () => 'sk-test', outputDir: tmp('ds'), fetchImpl: f.impl });
  const { taskId, remoteTaskId } = await p.createTask({ modelId: 'wan3.0-video', prompt: '一只猫在跑', resolution: '720P', ratio: 'adaptive', durationSec: 5 });

  assert.equal(remoteTaskId, 'abc123');
  const call = f.calls[0];
  assert.ok(call.url.endsWith('/api/v1/services/aigc/video-generation/video-synthesis'), `端点错误: ${call.url}`);
  assert.equal(call.opts.method, 'POST');
  assert.equal(call.opts.headers['X-DashScope-Async'], 'enable', '必须带异步头，否则接口行为不同');
  assert.equal(call.opts.headers.Authorization, 'Bearer sk-test');

  const body = JSON.parse(call.opts.body);
  assert.equal(body.model, 'wan3.0-video');
  assert.equal(body.input.prompt, '一只猫在跑');
  assert.equal(body.parameters.resolution, '720P');
  assert.equal(body.parameters.ratio, 'adaptive');
  assert.equal(body.parameters.duration, 5);
  assert.equal(body.input.media, undefined, '纯文生视频不应带 media 字段');
  assert.ok(taskId.startsWith('ds_'));
});

test('DashScope：填了 WorkspaceId 必须走地域端点（官方要求同地域）', async () => {
  const f = fakeFetch({ default: { status: 200, body: { output: { task_id: 'x' } } } });
  const p = new DashScopeProvider({ getApiKey: () => 'sk', workspaceId: 'ws-abc', outputDir: tmp('ds'), fetchImpl: f.impl });
  await p.createTask({ modelId: 'wan3.0-video', prompt: 'x' });
  assert.ok(f.calls[0].url.startsWith('https://ws-abc.cn-beijing.maas.aliyuncs.com/api/v1'), `应使用地域端点: ${f.calls[0].url}`);
});

test('DashScope：图生视频必须把本地图片转成 data URL 放进 input.media 的 first_frame', async () => {
  const dir = tmp('ds-img');
  const img = join(dir, 'photo.png');
  writeFileSync(img, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  const f = fakeFetch({ default: { status: 200, body: { output: { task_id: 't1' } } } });
  const p = new DashScopeProvider({ getApiKey: () => 'sk', outputDir: dir, fetchImpl: f.impl });
  await p.createTask({ modelId: 'happyhorse-1.1-i2v', prompt: '让她微笑', imagePath: img });
  const body = JSON.parse(f.calls[0].opts.body);
  assert.ok(Array.isArray(body.input.media));
  assert.equal(body.input.media[0].type, 'first_frame');
  assert.ok(body.input.media[0].url.startsWith('data:image/png;base64,'), '本地图片应转 base64');
});

test('DashScope：首尾帧同时传 first_frame 与 last_frame', async () => {
  const dir = tmp('ds-flf');
  const a = join(dir, 'a.png'); const b = join(dir, 'b.png');
  writeFileSync(a, Buffer.from([1])); writeFileSync(b, Buffer.from([2]));
  const f = fakeFetch({ default: { status: 200, body: { output: { task_id: 't2' } } } });
  const p = new DashScopeProvider({ getApiKey: () => 'sk', outputDir: dir, fetchImpl: f.impl });
  await p.createTask({ modelId: 'wan2.2-kf2v-flash', prompt: '自然过渡', imagePath: a, lastFramePath: b });
  const media = JSON.parse(f.calls[0].opts.body).input.media;
  const types = media.map(m => m.type);
  assert.ok(types.includes('first_frame') && types.includes('last_frame'), `应同时含首尾帧: ${types}`);
});

test('DashScope：未返回 task_id 必须报错，不能静默成功', async () => {
  const f = fakeFetch({ default: { status: 200, body: { output: {} } } });
  const p = new DashScopeProvider({ getApiKey: () => 'sk', outputDir: tmp('ds'), fetchImpl: f.impl });
  await assert.rejects(() => p.createTask({ modelId: 'wan3.0-video', prompt: 'x' }), /未返回 task_id/);
});

test('DashScope：无 Key 时明确报 NO_KEY 且不可重试', async () => {
  const p = new DashScopeProvider({ getApiKey: () => null, outputDir: tmp('ds'), fetchImpl: fakeFetch({}).impl });
  await assert.rejects(
    () => p.createTask({ modelId: 'wan3.0-video', prompt: 'x' }),
    (e) => { assert.equal(e.code, ERROR_CODE.NO_KEY); assert.equal(e.retryable, false); return true; }
  );
  const probe = await p.probeAvailability();
  assert.equal(probe.available, false);
  assert.equal(probe.code, ERROR_CODE.NO_KEY);
});

test('DashScope：轮询状态映射符合官方取值', () => {
  assert.equal(DS_STATUS_MAP.PENDING, TASK_STATUS.PENDING);
  assert.equal(DS_STATUS_MAP.RUNNING, TASK_STATUS.RUNNING);
  assert.equal(DS_STATUS_MAP.SUCCEEDED, TASK_STATUS.SUCCEEDED);
  assert.equal(DS_STATUS_MAP.FAILED, TASK_STATUS.FAILED);
  for (const k of ['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'UNKNOWN']) {
    assert.ok(k in DS_STATUS_MAP, `官方状态 ${k} 必须已映射`);
  }
});

test('DashScope：RUNNING 中轮询返回 running 且进度递增，不提前判成功', async () => {
  const f = fakeFetch({ default: { status: 200, body: { output: { task_id: 't', task_status: 'RUNNING' } } } });
  const p = new DashScopeProvider({ getApiKey: () => 'sk', outputDir: tmp('ds'), fetchImpl: f.impl });
  const { taskId } = await p.createTask({ modelId: 'wan3.0-video', prompt: 'x' });
  const s1 = await p.pollTask(taskId);
  assert.equal(s1.status, TASK_STATUS.RUNNING);
  assert.ok(s1.progress > 0 && s1.progress < 100);
  const s2 = await p.pollTask(taskId);
  assert.ok(s2.progress >= s1.progress, '进度不应倒退');
});

test('DashScope：FAILED 时带出平台给的失败原因', async () => {
  const f = fakeFetch({
    default: { status: 200, body: { output: { task_id: 't', task_status: 'FAILED', message: 'DataInspectionFailed: 内容不合规' } } }
  });
  const p = new DashScopeProvider({ getApiKey: () => 'sk', outputDir: tmp('ds'), fetchImpl: f.impl });
  const { taskId } = await p.createTask({ modelId: 'wan3.0-video', prompt: 'x' });
  const s = await p.pollTask(taskId);
  assert.equal(s.status, TASK_STATUS.FAILED);
  assert.ok(s.error.includes('内容不合规'), '必须把平台原因透传给用户');
});

test('DashScope：SUCCEEDED 后必须把视频下载到本地（URL 仅 24 小时有效）', async () => {
  const dir = tmp('ds-ok');
  let callIdx = 0;
  const f = {
    impl: async (url, opts) => {
      callIdx++;
      if (url.includes('/services/aigc/')) {
        return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ output: { task_id: 'rt1', task_status: 'PENDING' } }), body: null };
      }
      if (url.includes('/tasks/rt1')) {
        return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ output: { task_status: 'SUCCEEDED', video_url: 'https://cdn.test/v.mp4' } }), body: null };
      }
      // 视频下载
      const buf = Buffer.from('VIDEO_BYTES_' + callIdx);
      return { ok: true, status: 200, headers: { get: (k) => (k.toLowerCase() === 'content-length' ? String(buf.length) : null) }, body: (async function* () { yield buf; })() };
    }
  };
  const p = new DashScopeProvider({ getApiKey: () => 'sk', outputDir: dir, fetchImpl: f.impl });
  const { taskId } = await p.createTask({ modelId: 'wan3.0-video', prompt: 'x' });
  const s = await p.pollTask(taskId);
  assert.equal(s.status, TASK_STATUS.SUCCEEDED);
  assert.equal(s.progress, 100);
  assert.ok(s.result.localPath, '必须落盘到本地');
  assert.ok(existsSync(s.result.localPath), '本地文件必须真实存在');
  assert.ok(s.result.videoUrl.startsWith('file:///'), 'UI 播放需要 file:// URL');
  assert.equal(s.result.isSelfTest, false, '真实生成不得标记为自检');
  rmSync(dir, { recursive: true, force: true });
});

test('DashScope：probeAvailability 在 401 时判定为 Key 失效而非通道不可达', async () => {
  const f = fakeFetch({ default: { ok: false, status: 401, body: { message: 'InvalidApiKey' } } });
  const p = new DashScopeProvider({ getApiKey: () => 'sk-bad', outputDir: tmp('ds'), fetchImpl: f.impl });
  const r = await p.probeAvailability();
  assert.equal(r.available, false);
  assert.equal(r.code, ERROR_CODE.AUTH_FAILED);
  assert.ok(r.reason.includes('无效'));
});

test('DashScope：probeAvailability 在 404 时仍判定网络可达', async () => {
  const f = fakeFetch({ default: { ok: false, status: 404, body: { message: 'not found' } } });
  const p = new DashScopeProvider({ getApiKey: () => 'sk', outputDir: tmp('ds'), fetchImpl: f.impl });
  const r = await p.probeAvailability();
  assert.equal(r.available, true, '404 说明网络通，只是路径/任务不存在');
});

/* ============ SiliconFlow ============ */

test('SiliconFlow关键：端点必须是 /v1/video/submit（实测 /v1/videos/generations 是 404）', async () => {
  const f = fakeFetch({ default: { status: 200, body: { requestId: 'req-1' } } });
  const p = new SiliconFlowProvider({ getApiKey: () => 'sk', outputDir: tmp('sf'), fetchImpl: f.impl });
  await p.createTask({ modelId: 'Wan-AI/Wan2.2-T2V-A14B', prompt: '一只猫' });
  assert.equal(f.calls[0].url, 'https://api.siliconflow.cn/v1/video/submit');
  assert.equal(f.calls[0].opts.method, 'POST');
  assert.equal(f.calls[0].opts.headers.Authorization, 'Bearer sk');
  const body = JSON.parse(f.calls[0].opts.body);
  assert.equal(body.model, 'Wan-AI/Wan2.2-T2V-A14B');
  assert.equal(body.prompt, '一只猫');
  assert.ok(VALID_SIZES.includes(body.image_size), `image_size 必填且只能是官方三值，实际 ${body.image_size}`);
});

test('SiliconFlow：image_size 只接受官方三个值，非法值必须被纠正', () => {
  for (const v of VALID_SIZES) assert.equal(pickImageSize(v), v);
  assert.equal(pickImageSize('9:16'), '720x1280');
  assert.equal(pickImageSize('1:1'), '960x960');
  assert.equal(pickImageSize('16:9'), '1280x720');
  assert.equal(pickImageSize('随便乱填'), '1280x720', '非法值必须回落到合法默认值');
  assert.equal(pickImageSize(undefined), '1280x720');
  assert.deepEqual(VALID_SIZES, ['1280x720', '720x1280', '960x960']);
});

test('SiliconFlow：图生视频用 base64 直传（官方明确支持，这是本地图片的关键通道）', async () => {
  const dir = tmp('sf-img');
  const img = join(dir, 'p.png');
  writeFileSync(img, Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9]));
  const f = fakeFetch({ default: { status: 200, body: { requestId: 'req-2' } } });
  const p = new SiliconFlowProvider({ getApiKey: () => 'sk', outputDir: dir, fetchImpl: f.impl });
  await p.createTask({ modelId: 'Wan-AI/Wan2.2-I2V-A14B', prompt: '动起来', imagePath: img, imageSize: '9:16' });
  const body = JSON.parse(f.calls[0].opts.body);
  assert.ok(body.image.startsWith('data:image/png;base64,'), '必须转 base64 data URL');
  assert.equal(body.image_size, '720x1280');
});

test('SiliconFlow：图片是 http URL 时原样传，不做多余 base64', async () => {
  const f = fakeFetch({ default: { status: 200, body: { requestId: 'req-3' } } });
  const p = new SiliconFlowProvider({ getApiKey: () => 'sk', outputDir: tmp('sf'), fetchImpl: f.impl });
  await p.createTask({ modelId: 'Wan-AI/Wan2.2-I2V-A14B', prompt: 'x', imagePath: 'https://cdn.test/a.png' });
  assert.equal(JSON.parse(f.calls[0].opts.body).image, 'https://cdn.test/a.png');
});

test('SiliconFlow：图片文件不存在必须明确报错，不提交注定失败的请求', async () => {
  const p = new SiliconFlowProvider({ getApiKey: () => 'sk', outputDir: tmp('sf'), fetchImpl: fakeFetch({}).impl });
  await assert.rejects(
    () => p.createTask({ modelId: 'Wan-AI/Wan2.2-I2V-A14B', prompt: 'x', imagePath: join(tmp('nope'), 'missing.png') }),
    /图片文件不存在/
  );
});

test('SiliconFlow：未返回 requestId 必须报错', async () => {
  const f = fakeFetch({ default: { status: 200, body: {} } });
  const p = new SiliconFlowProvider({ getApiKey: () => 'sk', outputDir: tmp('sf'), fetchImpl: f.impl });
  await assert.rejects(() => p.createTask({ modelId: 'Wan-AI/Wan2.2-T2V-A14B', prompt: 'x' }), /未返回 requestId/);
});

test('SiliconFlow：状态查询用 POST + requestId（不是 GET）', async () => {
  const f = fakeFetch({
    'https://api.siliconflow.cn/v1/video/submit': { status: 200, body: { requestId: 'req-1' } },
    default: { status: 200, body: { status: 'InProgress' } }
  });
  const p = new SiliconFlowProvider({ getApiKey: () => 'sk', outputDir: tmp('sf'), fetchImpl: f.impl });
  const { taskId } = await p.createTask({ modelId: 'Wan-AI/Wan2.2-T2V-A14B', prompt: 'x' });
  await p.pollTask(taskId);
  const poll = f.calls[1];
  assert.equal(poll.url, 'https://api.siliconflow.cn/v1/video/status');
  assert.equal(poll.opts.method, 'POST');
  assert.deepEqual(JSON.parse(poll.opts.body), { requestId: 'req-1' }, 'body 必须只含 requestId');
});

test('SiliconFlow：官方四种状态映射正确', () => {
  assert.equal(SF_STATUS_MAP.Succeed, TASK_STATUS.SUCCEEDED);
  assert.equal(SF_STATUS_MAP.InQueue, TASK_STATUS.PENDING);
  assert.equal(SF_STATUS_MAP.InProgress, TASK_STATUS.RUNNING);
  assert.equal(SF_STATUS_MAP.Failed, TASK_STATUS.FAILED);
  for (const k of ['Succeed', 'InQueue', 'InProgress', 'Failed']) assert.ok(k in SF_STATUS_MAP);
});

test('SiliconFlow：Succeed 后从 results.videos[0].url 取地址并立即下载（URL 仅 1 小时有效）', async () => {
  const dir = tmp('sf-ok');
  const f = {
    impl: async (url) => {
      if (url.endsWith('/v1/video/submit')) {
        return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ requestId: 'rq-9' }) };
      }
      if (url.endsWith('/v1/video/status')) {
        return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ status: 'Succeed', results: { videos: [{ url: 'https://cdn.sf/v.mp4' }], timings: { inference: 42.1 }, seed: 7 } }) };
      }
      const buf = Buffer.from('SF_VIDEO_BYTES');
      return { ok: true, status: 200, headers: { get: (k) => (k.toLowerCase() === 'content-length' ? String(buf.length) : null) }, body: (async function* () { yield buf; })() };
    }
  };
  const p = new SiliconFlowProvider({ getApiKey: () => 'sk', outputDir: dir, fetchImpl: f.impl });
  const { taskId } = await p.createTask({ modelId: 'Wan-AI/Wan2.2-T2V-A14B', prompt: 'x' });
  const s = await p.pollTask(taskId);
  assert.equal(s.status, TASK_STATUS.SUCCEEDED);
  assert.ok(existsSync(s.result.localPath));
  assert.equal(s.result.isSelfTest, false);
  assert.equal(s.result.provider, 'siliconflow');
  rmSync(dir, { recursive: true, force: true });
});

test('SiliconFlow：Failed 时把 reason 透传并映射错误码（余额不足→NO_QUOTA）', async () => {
  const f = fakeFetch({
    'https://api.siliconflow.cn/v1/video/submit': { status: 200, body: { requestId: 'rq-f1' } },
    default: { status: 200, body: { status: 'Failed', reason: 'Insufficient balance, please recharge' } }
  });
  const p = new SiliconFlowProvider({ getApiKey: () => 'sk', outputDir: tmp('sf'), fetchImpl: f.impl });
  const { taskId } = await p.createTask({ modelId: 'Wan-AI/Wan2.2-T2V-A14B', prompt: 'x' });
  const s = await p.pollTask(taskId);
  assert.equal(s.status, TASK_STATUS.FAILED);
  assert.equal(s.errorCode, ERROR_CODE.NO_QUOTA);
  assert.ok(s.error.includes('Insufficient balance'));
});

test('SiliconFlow：内容审核失败映射为 CONTENT_REJECTED（不可重试）', async () => {
  const f = fakeFetch({
    'https://api.siliconflow.cn/v1/video/submit': { status: 200, body: { requestId: 'rq-f2' } },
    default: { status: 200, body: { status: 'Failed', reason: 'content policy violation' } }
  });
  const p = new SiliconFlowProvider({ getApiKey: () => 'sk', outputDir: tmp('sf'), fetchImpl: f.impl });
  const { taskId } = await p.createTask({ modelId: 'Wan-AI/Wan2.2-T2V-A14B', prompt: 'x' });
  const s = await p.pollTask(taskId);
  assert.equal(s.errorCode, ERROR_CODE.CONTENT_REJECTED);
});

test('SiliconFlow：无 Key 时报 NO_KEY 且不发起请求', async () => {
  const f = fakeFetch({});
  const p = new SiliconFlowProvider({ getApiKey: () => null, outputDir: tmp('sf'), fetchImpl: f.impl });
  await assert.rejects(
    () => p.createTask({ modelId: 'Wan-AI/Wan2.2-T2V-A14B', prompt: 'x' }),
    (e) => { assert.equal(e.code, ERROR_CODE.NO_KEY); return true; }
  );
  assert.equal(f.calls.length, 0, '无 Key 不应发起任何网络请求');
});

test('SiliconFlow：缺 model 参数时报 MODEL_NOT_FOUND', async () => {
  const p = new SiliconFlowProvider({ getApiKey: () => 'sk', outputDir: tmp('sf'), fetchImpl: fakeFetch({}).impl });
  await assert.rejects(() => p.createTask({ prompt: 'x' }), (e) => {
    assert.equal(e.code, ERROR_CODE.MODEL_NOT_FOUND);
    return true;
  });
});

/* ============ 下载器 ============ */

test('下载器：SHA256 校验通过', async () => {
  const dir = tmp('dl-ok');
  const dest = join(dir, 'f.bin');
  const content = Buffer.from('hello-modelscope-weights');
  const crypto = await import('node:crypto');
  const expected = crypto.createHash('sha256').update(content).digest('hex');
  const r = await downloader.downloadFile({
    url: 'https://x.test/f.bin', destPath: dest, sha256: expected, expectedBytes: content.length,
    fetchImpl: fakeDownloadFetch(content.toString())
  });
  assert.equal(r.bytes, content.length);
  assert.equal(r.sha256, expected);
  assert.ok(existsSync(dest));
  rmSync(dir, { recursive: true, force: true });
});

test('下载器关键：SHA256 不符必须删除文件并报错，绝不把可疑文件交给下游', async () => {
  const dir = tmp('dl-bad');
  const dest = join(dir, 'f.bin');
  await assert.rejects(
    () => downloader.downloadFile({
      url: 'https://x.test/f.bin', destPath: dest, sha256: 'deadbeef'.repeat(8),
      fetchImpl: fakeDownloadFetch('tampered-content')
    }),
    /SHA256 校验失败/
  );
  assert.ok(!existsSync(dest), '校验失败的文件必须被删除');
  rmSync(dir, { recursive: true, force: true });
});

test('下载器：大小不符视为不完整并报错（防止半截权重被当成完整）', async () => {
  const dir = tmp('dl-short');
  const dest = join(dir, 'f.bin');
  await assert.rejects(
    () => downloader.downloadFile({
      url: 'https://x.test/f.bin', destPath: dest, expectedBytes: 999999,
      fetchImpl: fakeDownloadFetch('short')
    }),
    /下载不完整/
  );
  rmSync(dir, { recursive: true, force: true });
});

test('下载器：多通道竞速取最先成功者', async () => {
  const dir = tmp('dl-race');
  const dest = join(dir, 'r.bin');
  let slowCalled = false;
  const impl = async (url) => {
    if (url.includes('slow')) {
      slowCalled = true;
      await new Promise(r => setTimeout(r, 600));
      throw new Error('slow channel timeout');
    }
    const buf = Buffer.from('from-fast-channel');
    return { ok: true, status: 200, headers: { get: () => null }, body: (async function* () { yield buf; })() };
  };
  const r = await downloader.raceDownload({
    sources: [{ url: 'https://x.test/fast', label: 'fast' }, { url: 'https://x.test/slow', label: 'slow' }],
    destPath: dest, fetchImpl: impl
  });
  assert.equal(r.winner, 'fast');
  assert.ok(existsSync(dest));
  rmSync(dir, { recursive: true, force: true });
});

test('下载器：全部通道失败时报出每个通道的原因', async () => {
  const dir = tmp('dl-allfail');
  const impl = async (url) => { throw new Error(`boom-${url.includes('a') ? 'A' : 'B'}`); };
  await assert.rejects(
    () => downloader.raceDownload({
      sources: [{ url: 'https://x.test/a', label: 'chanA' }, { url: 'https://x.test/b', label: 'chanB' }],
      destPath: join(dir, 'x.bin'), fetchImpl: impl
    }),
    (e) => {
      assert.ok(e.message.includes('chanA'), '应包含各通道失败原因');
      assert.ok(e.message.includes('chanB'));
      return true;
    }
  );
  rmSync(dir, { recursive: true, force: true });
});

test('下载器：无下载源时必须报错', async () => {
  await assert.rejects(() => downloader.raceDownload({ sources: [], destPath: 'x' }), /未提供下载源/);
});

/* ============ Provider 基类契约 ============ */

test('Provider 契约：三个通道都实现了统一接口', () => {
  for (const P of [DashScopeProvider, SiliconFlowProvider]) {
    const p = new P({ getApiKey: () => null, outputDir: tmp('x'), fetchImpl: fakeFetch({}).impl });
    for (const m of ['probeAvailability', 'createTask', 'pollTask', 'fetchResult', 'cancelTask', 'listModels']) {
      assert.equal(typeof p[m], 'function', `${P.name} 缺 ${m}`);
    }
  }
});

test('Provider 契约：取消任务后状态为 cancelled', async () => {
  const f = fakeFetch({ default: { status: 200, body: { output: { task_id: 't' } } } });
  const p = new DashScopeProvider({ getApiKey: () => 'sk', outputDir: tmp('ds'), fetchImpl: f.impl });
  const { taskId } = await p.createTask({ modelId: 'wan3.0-video', prompt: 'x' });
  const r = await p.cancelTask(taskId);
  assert.equal(r.cancelled, true);
  const s = await p.pollTask(taskId);
  assert.equal(s.status, TASK_STATUS.CANCELLED);
});
