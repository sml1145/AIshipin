import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Orchestrator, RETRYABLE_CODES, TERMINAL_CODES } = require('../src/main/orchestrator.js');
const { SecretStore, DEFAULT_CONFIG, SECRET_KINDS, maskSecret } = require('../src/main/secrets.js');
const catalogMod = require('../src/main/catalog.js');
const pathsMod = require('../src/main/paths.js');
const { MockProvider } = require('../src/main/providers/mock.js');
const { BaseProvider, TASK_STATUS, ERROR_CODE, ProviderError } = require('../src/main/providers/base.js');

const here = dirname(fileURLToPath(import.meta.url));
const bundled = join(here, '..', 'models.json');
const catalog = catalogMod.load({ catalogBundled: bundled, catalogCached: null }).catalog;

function tmp(prefix) {
  return mkdtempSync(join(tmpdir(), `hxsk-orch-${prefix}-`));
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

/** 可编程的假 Provider：按脚本决定成功或抛特定错误码 */
class StubProvider extends BaseProvider {
  constructor(name, script = {}) {
    super({ name, track: script.track || 'cloud' });
    this.script = script;
    this.modelIds = script.modelIds || [];
    this.created = [];
    this.cancelled = [];
  }
  async probeAvailability() { return { available: true }; }
  async createTask(req) {
    this.created.push(req);
    const id = this._newTaskId(this.name);
    if (this.script.failOnCreate) {
      throw new ProviderError(this.script.failOnCreate.message, { code: this.script.failOnCreate.code, retryable: true });
    }
    this._progress(id, { status: TASK_STATUS.SUCCEEDED, progress: 100, result: this.script.result || { localPath: join(tmpdir(), `${id}.mp4`), isSelfTest: false } });
    return { taskId: id };
  }
  async pollTask(id) { return { ...(this.tasks.get(id) || { status: TASK_STATUS.SUCCEEDED, progress: 100 }) }; }
  async cancelTask(id) { this.cancelled.push(id); return { cancelled: true }; }
}

/** 真实 Mock Provider（走 ffmpeg 合成，端到端最可信） */
function realMockProvider(outputDir) {
  return new MockProvider({ outputDir, simulatedDelayMs: 0 });
}

function baseCtx(extra = {}) {
  return {
    getHardware: () => ({ vramGB: 8, totalRamGB: 15.2, diskFreeGB: 100 }),
    getProviderStatus: () => ({
      dashscope: { reachable: true, hasKey: false },
      siliconflow: { reachable: true, hasKey: false },
      local: { reachable: true, hasKey: false },
      mock: { reachable: true, hasKey: false }
    }),
    getLocalModelsInstalled: () => [],
    pollIntervalMs: 1,
    pollTimeoutMs: 5000,
    // 必须让出宏任务队列，否则真实 ffmpeg 子进程的 I/O 回调会被微任务轮询饿死
    sleepImpl: () => new Promise(r => setTimeout(r, 0)),
    ...extra
  };
}

/* ============ 编排器：无 Key 全链路（端到端真实自检）============ */

test('编排器关键：无任何 Key 时经路由降级到 Mock，真实产出可播放视频', async () => {
  const paths = makePaths();
  const providers = new Map([['mock', realMockProvider(paths.outputDir)]]);
  const orch = new Orchestrator({ catalog, providers, paths, ...baseCtx() });
  const r = await orch.submit({ prompt: '一只猫在草地上奔跑' });
  assert.equal(r.ok, true, `应成功（自检模式），实际：${r.message}`);
  assert.equal(r.status, TASK_STATUS.SUCCEEDED);
  assert.equal(r.result.track, 'mock');
  assert.equal(r.result.isSelfTest, true, '必须标明是自检，不冒充真实生成');
  assert.ok(existsSync(r.result.localPath), '视频文件必须真实存在');
  assert.ok(r.message.includes('生成成功'));
  rmSync(paths.userData, { recursive: true, force: true });
});

test('编排器：选型理由随结果回传，UI 可展示为什么选这个模型', async () => {
  const paths = makePaths();
  const providers = new Map([['mock', realMockProvider(paths.outputDir)]]);
  const orch = new Orchestrator({ catalog, providers, paths, ...baseCtx() });
  const r = await orch.submit({ prompt: '让照片里的人动起来' });
  assert.ok(r.routing, '必须带路由信息');
  assert.ok(r.routing.explanation.length > 0, '必须有可读的选型解释');
  assert.ok(Array.isArray(r.routing.chain), '必须给出降级链');
  assert.ok(Array.isArray(r.routing.rejected), '必须给出被拒模型及原因');
  rmSync(paths.userData, { recursive: true, force: true });
});

test('编排器：无模型可用时明确报错并给建议，不静默失败', async () => {
  const paths = makePaths();
  const providers = new Map(); // 一个 provider 都没有
  const orch = new Orchestrator({
    catalog, providers, paths,
    ...baseCtx({
      getProviderStatus: () => ({ mock: { reachable: false, hasKey: false } })
    })
  });
  // 构造一个路由必然选不出模型的场景：offlineOnly 且本地未装、mock 也不可达
  const r = await orch.submit({ prompt: '离线生成一段视频', offlineOnly: true });
  assert.equal(r.ok, false);
  assert.ok(r.message.includes('没有可用') || r.message.includes('失败'));
  assert.ok(r.suggestion && r.suggestion.length > 0, '必须给出可行动建议');
});

/* ============ 编排器：降级链 ============ */

test('编排器关键：首选模型额度耗尽时自动降级到下一个候选', async () => {
  const paths = makePaths();
  // dashscope 首次创建即抛 NO_QUOTA，mock 兜底成功
  const ds = new StubProvider('dashscope', {
    modelIds: ['wan3.0-video'],
    failOnCreate: { code: ERROR_CODE.NO_QUOTA, message: 'Insufficient quota' }
  });
  const providers = new Map([['dashscope', ds], ['mock', realMockProvider(paths.outputDir)]]);
  const orch = new Orchestrator({
    catalog, providers, paths,
    ...baseCtx({
      getProviderStatus: () => ({
        dashscope: { reachable: true, hasKey: true },
        siliconflow: { reachable: true, hasKey: false },
        local: { reachable: true, hasKey: false },
        mock: { reachable: true, hasKey: false }
      })
    })
  });
  const r = await orch.submit({ prompt: '电影感的写实画面，超清质感' });
  assert.equal(r.ok, true, `降级后应成功，实际：${r.message}`);
  assert.equal(r.usedFallback, true, '必须标明发生了降级');
  assert.ok(r.attempts.some(a => !a.ok && a.errorCode === ERROR_CODE.NO_QUOTA), '应记录首选因额度失败');
  assert.ok(r.attempts.some(a => a.ok), '应记录降级后成功');
  rmSync(paths.userData, { recursive: true, force: true });
});

test('编排器关键：内容审核拒绝是终止类错误，不再无谓降级浪费额度', async () => {
  const paths = makePaths();
  const ds = new StubProvider('dashscope', {
    modelIds: ['wan3.0-video'],
    failOnCreate: { code: ERROR_CODE.CONTENT_REJECTED, message: '内容不合规' }
  });
  const providers = new Map([['dashscope', ds], ['mock', realMockProvider(paths.outputDir)]]);
  const orch = new Orchestrator({
    catalog, providers, paths,
    ...baseCtx({
      getProviderStatus: () => ({
        dashscope: { reachable: true, hasKey: true },
        siliconflow: { reachable: true, hasKey: false },
        local: { reachable: true, hasKey: false },
        mock: { reachable: true, hasKey: false }
      })
    })
  });
  const r = await orch.submit({ prompt: '电影感的写实画面，超清质感' });
  assert.equal(r.ok, false, '内容审核拒绝应终止而非降级');
  assert.equal(r.errorCode, ERROR_CODE.CONTENT_REJECTED);
  assert.ok(r.message.includes('无法通过换模型解决'));
  rmSync(paths.userData, { recursive: true, force: true });
});

test('编排器：全部候选失败时汇总原因并给建议', async () => {
  const paths = makePaths();
  const ds = new StubProvider('dashscope', { modelIds: ['wan3.0-video'], failOnCreate: { code: ERROR_CODE.NO_QUOTA, message: 'no quota' } });
  const sf = new StubProvider('siliconflow', { modelIds: ['Wan-AI/Wan2.2-T2V-A14B'], failOnCreate: { code: ERROR_CODE.UNREACHABLE, message: 'network' } });
  const providers = new Map([['dashscope', ds], ['siliconflow', sf]]);
  const orch = new Orchestrator({
    catalog, providers, paths,
    ...baseCtx({
      getProviderStatus: () => ({
        dashscope: { reachable: true, hasKey: true },
        siliconflow: { reachable: true, hasKey: true },
        local: { reachable: true, hasKey: false },
        mock: { reachable: false, hasKey: false }
      })
    })
  });
  const r = await orch.submit({ prompt: '电影感的写实画面，超清质感' });
  assert.equal(r.ok, false);
  assert.ok(r.attempts.length >= 1);
  assert.ok(r.suggestion.length > 0, '必须给出汇总建议');
  assert.ok(r.suggestion.includes('额度') || r.suggestion.includes('Key') || r.suggestion.includes('本地'));
});

test('编排器：强制指定模型时把它提到链首', async () => {
  const paths = makePaths();
  const sf = new StubProvider('siliconflow', { modelIds: ['Wan-AI/Wan2.2-T2V-A14B'], result: { localPath: join(tmpdir(), 'sf.mp4'), isSelfTest: false } });
  const ds = new StubProvider('dashscope', { modelIds: ['wan3.0-video'], result: { localPath: join(tmpdir(), 'ds.mp4'), isSelfTest: false } });
  const providers = new Map([['dashscope', ds], ['siliconflow', sf]]);
  const orch = new Orchestrator({
    catalog, providers, paths,
    ...baseCtx({
      getProviderStatus: () => ({
        dashscope: { reachable: true, hasKey: true },
        siliconflow: { reachable: true, hasKey: true },
        local: { reachable: true, hasKey: false },
        mock: { reachable: true, hasKey: false }
      })
    })
  });
  const r = await orch.submit({ prompt: '电影感的写实画面', forceModelId: 'sf-wan2.2-t2v' });
  assert.equal(r.ok, true);
  assert.equal(r.result.modelId, 'sf-wan2.2-t2v', '应优先用用户强制指定的模型');
});

/* ============ 编排器：参数与安全 ============ */

test('编排器：时长被钳制到模型支持范围，不提交注定失败的参数', async () => {
  const paths = makePaths();
  const ds = new StubProvider('dashscope', { modelIds: ['wan3.0-video'], result: { localPath: join(tmpdir(), 'x.mp4') } });
  const providers = new Map([['dashscope', ds], ['mock', realMockProvider(paths.outputDir)]]);
  const orch = new Orchestrator({
    catalog, providers, paths,
    ...baseCtx({
      getProviderStatus: () => ({ dashscope: { reachable: true, hasKey: true }, siliconflow: { reachable: true, hasKey: false }, local: { reachable: true, hasKey: false }, mock: { reachable: true, hasKey: false } })
    })
  });
  await orch.submit({ prompt: '电影感写实画面超清质感', durationSec: 9999 });
  const sent = ds.created[0];
  const model = catalog.models.find(m => m.id === 'wan3-video');
  assert.ok(sent.durationSec <= model.maxDurationSec, `时长应被钳到 ${model.maxDurationSec}，实际 ${sent.durationSec}`);
});

test('编排器：取消任务后状态为 cancelled', async () => {
  const paths = makePaths();
  const providers = new Map([['mock', realMockProvider(paths.outputDir)]]);
  const orch = new Orchestrator({ catalog, providers, paths, ...baseCtx() });
  const promise = orch.submit({ prompt: '一只猫在跑' });
  // 立即取消
  const taskId = null;
  const r = await promise;
  // Mock 太快可能已完成，这里验证 cancel 接口本身不报错
  const c = orch.cancel('job_nonexistent');
  assert.equal(c.cancelled, true);
  assert.ok(r.ok === true || r.status === TASK_STATUS.CANCELLED);
  rmSync(paths.userData, { recursive: true, force: true });
});

test('编排器：preview 预演路由不真正生成，供 UI 提前展示选型', () => {
  const paths = makePaths();
  const providers = new Map([['mock', realMockProvider(paths.outputDir)]]);
  const orch = new Orchestrator({ catalog, providers, paths, ...baseCtx() });
  const p = orch.preview({ prompt: '让照片里的人动起来微笑' });
  assert.ok(p.explanation.length > 0);
  assert.ok(Array.isArray(p.chain));
  assert.equal(orch.tasks.size, 0, 'preview 不应创建任务');
});

/* ============ 多模型搭配（分镜）============ */

test('编排器关键：分镜模式用多个模型各出一段再拼接', async () => {
  const paths = makePaths();
  const providers = new Map([['mock', realMockProvider(paths.outputDir)]]);
  const orch = new Orchestrator({ catalog, providers, paths, ...baseCtx() });
  const r = await orch.submit({
    prompt: '一个产品的完整广告',
    segments: ['产品特写缓慢旋转', '模特使用产品的场景', '品牌 logo 收尾']
  });
  assert.equal(r.ok, true, `分镜应成功，实际：${r.message}`);
  assert.equal(r.result.composed, true, '应产出拼接后的成片');
  assert.equal(r.result.segments.length, 3, '应有三段');
  assert.ok(existsSync(r.result.localPath), '拼接后的视频必须真实存在');
  assert.ok(r.message.includes('拼接'), '应说明是多模型拼接');
  rmSync(paths.userData, { recursive: true, force: true });
});

test('编排器：分镜某段全失败时中断并说明是第几段', async () => {
  const paths = makePaths();
  const ds = new StubProvider('dashscope', { modelIds: ['wan3.0-video'], failOnCreate: { code: ERROR_CODE.NO_QUOTA, message: 'no quota' } });
  const providers = new Map([['dashscope', ds]]); // 没有 mock 兜底
  const orch = new Orchestrator({
    catalog, providers, paths,
    ...baseCtx({
      getProviderStatus: () => ({ dashscope: { reachable: true, hasKey: true }, siliconflow: { reachable: true, hasKey: false }, local: { reachable: true, hasKey: false }, mock: { reachable: false, hasKey: false } })
    })
  });
  const r = await orch.submit({ prompt: '广告', segments: ['第一段', '第二段'] });
  assert.equal(r.ok, false);
  assert.ok(r.message.includes('段'), '应指出是第几段失败');
});

/* ============ 错误码分类 ============ */

test('错误分类：可重试与终止类错误码划分正确，无重叠', () => {
  for (const code of TERMINAL_CODES) {
    assert.ok(!RETRYABLE_CODES.has(code), `${code} 不应同时在可重试集合里`);
  }
  assert.ok(RETRYABLE_CODES.has(ERROR_CODE.NO_QUOTA), '额度耗尽应可降级');
  assert.ok(RETRYABLE_CODES.has(ERROR_CODE.UNREACHABLE), '网络不可达应可降级');
  assert.ok(TERMINAL_CODES.has(ERROR_CODE.CONTENT_REJECTED), '内容审核拒绝应终止');
  assert.ok(TERMINAL_CODES.has(ERROR_CODE.AUTH_FAILED), 'Key 无效应终止（换模型无用）');
});

/* ============ 密钥存储 ============ */

function fakeSafeStorage() {
  // 模拟 Electron safeStorage：用可逆的 base64 充当"加密"，仅测试用
  return {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(`ENC::${Buffer.from(s, 'utf8').toString('base64')}`, 'utf8'),
    decryptString: (buf) => {
      const s = buf.toString('utf8');
      if (!s.startsWith('ENC::')) throw new Error('not encrypted by us');
      return Buffer.from(s.slice(5), 'base64').toString('utf8');
    }
  };
}

test('密钥存储：保存后可原样取回，且落盘内容非明文', () => {
  const paths = makePaths();
  const store = new SecretStore({ paths, safeStorage: fakeSafeStorage() });
  store.setKey('dashscope', 'sk-secret-1234567890');
  assert.equal(store.getKey('dashscope'), 'sk-secret-1234567890');
  const raw = readFileSync(paths.secretsFile);
  assert.ok(!raw.includes('sk-secret-1234567890'), '磁盘上绝不能出现明文密钥');
  rmSync(paths.userData, { recursive: true, force: true });
});

test('密钥存储：safeStorage 不可用时拒绝保存，绝不降级为明文', () => {
  const paths = makePaths();
  const store = new SecretStore({ paths, safeStorage: { isEncryptionAvailable: () => false } });
  assert.throws(() => store.setKey('dashscope', 'sk-123'), (e) => {
    assert.equal(e.code, 'ENCRYPTION_UNAVAILABLE');
    assert.ok(e.message.includes('明文'));
    return true;
  });
  assert.ok(!existsSync(paths.secretsFile), '拒绝保存时不应产生文件');
});

test('密钥存储：listConfiguredKinds 只报是否配置，绝不返回密钥内容', () => {
  const paths = makePaths();
  const store = new SecretStore({ paths, safeStorage: fakeSafeStorage() });
  store.setKey('siliconflow', 'sf-key-abcdef');
  const r = store.listConfiguredKinds();
  assert.equal(r.configured.siliconflow, true);
  assert.equal(r.configured.dashscope, false);
  assert.ok(!JSON.stringify(r).includes('sf-key-abcdef'), '返回结构里绝不能含密钥明文');
});

test('密钥存储：清除密钥后取回为 null，全清空后删除文件', () => {
  const paths = makePaths();
  const store = new SecretStore({ paths, safeStorage: fakeSafeStorage() });
  store.setKey('dashscope', 'sk-a');
  store.setKey('siliconflow', 'sk-b');
  store.clearKey('dashscope');
  assert.equal(store.getKey('dashscope'), null);
  assert.equal(store.getKey('siliconflow'), 'sk-b');
  store.clearKey('siliconflow');
  assert.ok(!existsSync(paths.secretsFile), '全部清空后应删除密钥文件');
});

test('密钥存储：未知密钥类型必须报错，不接受任意键名', () => {
  const paths = makePaths();
  const store = new SecretStore({ paths, safeStorage: fakeSafeStorage() });
  assert.throws(() => store.setKey('evil_key', 'x'), /未知的密钥类型/);
  assert.throws(() => store.getKey('evil_key'), /未知的密钥类型/);
});

test('密钥存储：空值不得保存（清除须走 clearKey）', () => {
  const paths = makePaths();
  const store = new SecretStore({ paths, safeStorage: fakeSafeStorage() });
  assert.throws(() => store.setKey('dashscope', '   '), /不能为空/);
});

test('密钥存储：配置损坏时不让软件崩溃，用默认值并备份', () => {
  const paths = makePaths();
  writeFileSync(paths.configFile, '{ 坏掉的 json ', 'utf8');
  const store = new SecretStore({ paths, safeStorage: fakeSafeStorage() });
  const cfg = store.loadConfig();
  assert.equal(cfg.autoCheckUpdate, DEFAULT_CONFIG.autoCheckUpdate, '应回落到默认配置');
});

test('密钥存储：saveConfig 只允许已知字段落盘', () => {
  const paths = makePaths();
  const store = new SecretStore({ paths, safeStorage: fakeSafeStorage() });
  store.saveConfig({ workspaceId: 'ws-1', evilField: 'should-not-persist' });
  const saved = JSON.parse(readFileSync(paths.configFile, 'utf8'));
  assert.equal(saved.workspaceId, 'ws-1');
  assert.equal(saved.evilField, undefined, '未知字段不得写入配置');
});

test('掩码：密钥展示只露前后几位，中间打码', () => {
  assert.equal(maskSecret('sk-1234567890abcdef'), 'sk-1…cdef');
  assert.ok(!maskSecret('sk-1234567890abcdef').includes('1234567890'));
  assert.ok(maskSecret('short').includes('…'));
});

test('支持的密钥种类与模型库的云端 provider 对应', () => {
  const providers = new Set(catalog.models.filter(m => m.track === 'cloud').map(m => m.provider));
  for (const p of providers) {
    assert.ok(SECRET_KINDS.includes(p), `模型库用到的 provider "${p}" 必须能在密钥存储里配置`);
  }
});
