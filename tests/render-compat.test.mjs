import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const rc = require('../src/main/render-compat.js');

/* ============ GPU 开关环境变量解析 ============ */

test('parseGpuFlagsEnv: 解析 key=value 与纯 flag，支持分号/逗号分隔', () => {
  assert.deepEqual(rc.parseGpuFlagsEnv('disable-gpu=;use-angle=swiftshader'), [
    ['disable-gpu', ''],
    ['use-angle', 'swiftshader']
  ]);
  assert.deepEqual(rc.parseGpuFlagsEnv('a=b,c=d'), [['a', 'b'], ['c', 'd']]);
  assert.deepEqual(rc.parseGpuFlagsEnv('solo-flag'), [['solo-flag', undefined]]);
});

test('parseGpuFlagsEnv: 空值/空白/非法输入返回空数组，不抛错', () => {
  assert.deepEqual(rc.parseGpuFlagsEnv(''), []);
  assert.deepEqual(rc.parseGpuFlagsEnv(null), []);
  assert.deepEqual(rc.parseGpuFlagsEnv(undefined), []);
  assert.deepEqual(rc.parseGpuFlagsEnv('   '), []);
  assert.deepEqual(rc.parseGpuFlagsEnv(';;,'), []);
  assert.deepEqual(rc.parseGpuFlagsEnv(123), []);
});

test('parseGpuFlagsEnv: 值含等号只按第一个等号分割', () => {
  assert.deepEqual(rc.parseGpuFlagsEnv('foo=a=b'), [['foo', 'a=b']]);
});

/* ============ 开关汇总 ============ */

test('collectGpuSwitches: 默认含 Vulkan 禁用与 swiftshader，且不含 UseAngle（Windows 渲染必需）', () => {
  const list = rc.collectGpuSwitches('');
  const names = list.map(s => s.name + (s.value !== undefined ? '=' + s.value : ''));
  assert.ok(names.some(n => n.includes('disable-features') && n.includes('Vulkan')), '应禁用 Vulkan');
  assert.ok(names.some(n => n.includes('enable-unsafe-swiftshader')), '应启用 swiftshader 回退');
  // 关键：绝不能禁用 UseAngle，否则 Windows 上渲染直接崩
  assert.ok(!names.some(n => /UseAngle/.test(n) && /disable/.test(n)), '绝不能禁用 UseAngle');
  const df = list.find(s => s.name === 'disable-features');
  assert.ok(!String(df.value).includes('UseAngle'), 'disable-features 里不得含 UseAngle');
});

test('collectGpuSwitches: 环境变量自定义开关被追加并标记 source=env', () => {
  const list = rc.collectGpuSwitches('my-flag=1');
  const envOnes = list.filter(s => s.source === 'env');
  assert.equal(envOnes.length, 1);
  assert.equal(envOnes[0].name, 'my-flag');
  assert.equal(envOnes[0].value, '1');
  const defOnes = list.filter(s => s.source === 'default');
  assert.ok(defOnes.length >= 2, '默认开关应保留');
});

test('collectGpuSwitches: 默认开关的 value=null 归一化为 undefined', () => {
  const list = rc.collectGpuSwitches('');
  const swift = list.find(s => s.name === 'enable-unsafe-swiftshader');
  assert.equal(swift.value, undefined, 'null 应归一化为 undefined（纯 flag）');
});

/* ============ IDD 虚拟显示适配器检测 ============ */

test('detectIddAdapters: 识别本机真实的 ToDesk/MuMu/GameViewer 适配器', () => {
  const real = [
    'Todesk Virtual Display Adapter',
    'MuMu Virtual Display Adapter',
    'GameViewer Virtual Display Adapter',
    'AMD Radeon 780M Graphics',
    'NVIDIA GeForce RTX 4060 Laptop GPU'
  ];
  const r = rc.detectIddAdapters(real);
  assert.equal(r.suspicious, true);
  assert.equal(r.matched.length, 3, '应匹配到三个虚拟适配器');
  assert.ok(r.matched.some(m => m.includes('Todesk')));
  assert.ok(!r.matched.some(m => m.includes('NVIDIA')), '真实 GPU 不应被误判为虚拟适配器');
});

test('detectIddAdapters: 只有物理显卡时不误报', () => {
  const r = rc.detectIddAdapters(['NVIDIA GeForce RTX 4060 Laptop GPU', 'AMD Radeon 780M Graphics']);
  assert.equal(r.suspicious, false);
  assert.deepEqual(r.matched, []);
});

test('detectIddAdapters: 大小写不敏感 + 支持中文名 + 空输入安全', () => {
  assert.equal(rc.detectIddAdapters(['TODESK VIRTUAL DISPLAY']).suspicious, true);
  assert.equal(rc.detectIddAdapters(['向日葵虚拟显示器']).suspicious, true);
  assert.equal(rc.detectIddAdapters(['Sunlogin Virtual Display']).suspicious, true);
  assert.equal(rc.detectIddAdapters([]).suspicious, false);
  assert.equal(rc.detectIddAdapters(null).suspicious, false);
  assert.equal(rc.detectIddAdapters(undefined).suspicious, false);
});

/* ============ 诊断构造 ============ */

test('buildRenderFailureDiagnosis: 检测到 IDD 时给出具体适配器名与 issue 引用', () => {
  const d = rc.buildRenderFailureDiagnosis({
    elapsedMs: 20001,
    adapters: ['Todesk Virtual Display Adapter', 'NVIDIA GeForce RTX 4060 Laptop GPU'],
    versions: { electron: '44.7.2', chrome: '140.0.0.0' },
    gpuFlagsEnv: '',
    logsDir: 'C:\\ud\\logs'
  });
  assert.equal(d.iddDetected, true);
  assert.ok(d.likelyCause.includes('Todesk'), '应点名检测到的适配器');
  assert.ok(d.likelyCause.includes('54552'));
  assert.equal(d.reference, 'https://github.com/electron/electron/issues/54552');
  assert.ok(d.suggestions.length >= 3);
  assert.equal(d.env.electron, '44.7.2');
  assert.equal(d.problem.includes('20000ms'), true);
});

test('buildRenderFailureDiagnosis: 未检测到 IDD 时给通用诊断而非编造适配器', () => {
  const d = rc.buildRenderFailureDiagnosis({ elapsedMs: 20001, adapters: ['NVIDIA GeForce RTX 4060'] });
  assert.equal(d.iddDetected, false);
  assert.ok(d.likelyCause.includes('最可能'), '应表述为推测而非确定');
  assert.ok(d.likelyCause.includes('54552'));
  assert.deepEqual(d.iddAdapters, []);
});

test('buildRenderFailureDiagnosis: 建议里必须含物理会话与禁用适配器两条核心解法', () => {
  const d = rc.buildRenderFailureDiagnosis({ elapsedMs: 1 });
  const joined = d.suggestions.join(' ');
  assert.ok(joined.includes('物理显示器') || joined.includes('本地会话'));
  assert.ok(joined.includes('设备管理器') || joined.includes('禁用'));
  assert.ok(joined.includes('HXSK_GPU_FLAGS'));
});

test('buildRenderFailureDiagnosis: 默认参数也能构造完整诊断（不崩）', () => {
  const d = rc.buildRenderFailureDiagnosis();
  assert.equal(d.iddDetected, false);
  assert.equal(d.env.gpuFlags, '(默认)');
  assert.ok(d.problem.includes('20000'));
  assert.ok(d.at);
});

test('buildRenderFailureDiagnosis: 自定义 gpuFlags 被如实记录，便于远程诊断', () => {
  const d = rc.buildRenderFailureDiagnosis({ gpuFlagsEnv: 'disable-gpu=' });
  assert.equal(d.env.gpuFlags, 'disable-gpu=');
});

/* ============ 对话框文案 ============ */

test('formatDialogText: 含三条建议、根因说明与日志路径', () => {
  const d = rc.buildRenderFailureDiagnosis({ elapsedMs: 1, adapters: ['Todesk Virtual Display Adapter'] });
  const txt = rc.formatDialogText(d, 'C:\\ud\\logs\\render-failure.json');
  assert.ok(txt.includes('未能') && txt.includes('渲染'));
  assert.ok(txt.includes('虚拟显示适配器') || txt.includes('ToDesk'));
  assert.ok(txt.includes('1)'), '应有编号建议');
  assert.ok(txt.includes('render-failure.json'), '应告知日志位置');
});

test('formatDialogText: 无日志路径时不输出 undefined', () => {
  const d = rc.buildRenderFailureDiagnosis();
  const txt = rc.formatDialogText(d, '');
  assert.ok(!txt.includes('undefined'));
  assert.ok(!txt.includes('null'));
});

/* ============ 常量一致性 ============ */

test('常量: DEFAULT_WATCHDOG_MS 合理（>=10s，避免误报正常慢启动）', () => {
  assert.ok(rc.DEFAULT_WATCHDOG_MS >= 10000);
  assert.ok(rc.DEFAULT_WATCHDOG_MS <= 60000);
});

test('常量: 默认开关不含会破坏 Windows 渲染的项', () => {
  for (const [name, value] of rc.COMPAT_GPU_SWITCHES) {
    assert.notEqual(name, 'disable-gpu', '默认不应硬关 GPU（会误伤正常环境）');
    assert.ok(!String(value || '').includes('UseAngle'), '不得禁用 UseAngle');
  }
});
