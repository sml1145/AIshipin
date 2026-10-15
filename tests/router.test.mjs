import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const router = require('../src/main/router-core.js');

const here = dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(readFileSync(join(here, '..', 'models.json'), 'utf8'));

/**
 * 贴近本机实测的上下文：
 * 国内通道（百炼 / SiliconFlow）可达且已配 Key；海外通道（HF / Replicate）实测不可达。
 */
function cloudReady(extra = {}) {
  return {
    ...extra,
    providers: {
      dashscope: { reachable: true, hasKey: true },
      siliconflow: { reachable: true, hasKey: true },
      modelscope: { reachable: true, hasKey: false },
      huggingface: { reachable: false, hasKey: false },
      replicate: { reachable: false, hasKey: false },
      fal: { reachable: false, hasKey: false },
      local: { reachable: true, hasKey: false },
      mock: { reachable: true, hasKey: false }
    }
  };
}

/** 海外通道也可达（验证质量更优的海外模型能被正确选中） */
function allChannelsReady(extra = {}) {
  return {
    ...extra,
    providers: {
      dashscope: { reachable: true, hasKey: true },
      siliconflow: { reachable: true, hasKey: true },
      modelscope: { reachable: true, hasKey: true },
      huggingface: { reachable: true, hasKey: true },
      replicate: { reachable: true, hasKey: true },
      fal: { reachable: true, hasKey: true },
      local: { reachable: true, hasKey: false },
      mock: { reachable: true, hasKey: false }
    }
  };
}

/** 本地模型已安装 + 本机真实硬件（8GB 显存 / 15.2GB 内存） */
function localReady(ids = ['local-ltx-2b-fp8', 'local-wan2.1-1.3b-fp8'], extra = {}) {
  return {
    ...extra,
    localModelsInstalled: ids,
    hardware: { vramGB: 8, ramGB: 15.2, diskFreeGB: 100 }
  };
}

/* ============ 意图识别 ============ */

test('意图识别：关键词命中并给出分数', () => {
  const intents = router.detectIntents('让这张照片里的人像动起来，微笑眨眼', catalog.intents);
  assert.ok(intents.has('portrait_motion'), '应命中人像动态意图');
  const det = intents.get('portrait_motion');
  assert.ok(det.hits.includes('动起来'));
  assert.ok(det.hits.includes('微笑'));
  assert.ok(det.score >= 6);
});

test('意图识别：多关键词命中分数更高', () => {
  const one = router.detectIntents('动漫风格', catalog.intents);
  const many = router.detectIntents('动漫风格，二次元，卡通，动画番剧', catalog.intents);
  assert.ok(many.get('anime').score > one.get('anime').score);
});

test('意图识别：空文本不命中任何意图', () => {
  assert.equal(router.detectIntents('', catalog.intents).size, 0);
  assert.equal(router.detectIntents(null, catalog.intents).size, 0);
});

test('意图识别：新增能力意图均可命中', () => {
  const cases = [
    ['motion_transfer', '把参考视频的动作迁移到图片人物上'],
    ['video_edit', '编辑视频，将整个画面转换为黏土风格'],
    ['doc_to_video', '根据这个PPT文档生成一段视频'],
    ['long_duration', '要一个30秒的多镜头叙事长视频'],
    ['audio_video', '有声视频，需要台词和BGM音效'],
    ['offline_private', '离线本地生成，不联网，注意隐私']
  ];
  for (const [key, text] of cases) {
    const r = router.detectIntents(text, catalog.intents);
    assert.ok(r.has(key), `「${text}」应命中 ${key} 意图`);
  }
});

/* ============ 路由：国内通道可达（本机实测场景）============ */

test('路由：有图 + 人像 → HappyHorse 1.1 图生视频', () => {
  const r = router.route({
    prompt: '让这张照片里的人物动起来，自然地微笑',
    catalog,
    context: cloudReady({ hasImage: true })
  });
  assert.ok(r.selected, '必须有选定模型');
  assert.equal(r.selected.id, 'happyhorse-1.1-i2v');
  assert.ok(r.selected.matchedIntents.some(m => m.intent.includes('人像')));
});

test('路由：纯文生 + 写实 → Wan 3.0（原生有声、1080P）', () => {
  const r = router.route({
    prompt: '电影感的写实画面，超清质感，一个人在雨中行走',
    catalog,
    context: cloudReady()
  });
  assert.equal(r.selected.id, 'wan3-video');
});

test('路由：动漫/二次元 → Wan 3.0（国内可达时不选低质量通道）', () => {
  const r = router.route({
    prompt: '动漫二次元风格的少女在樱花树下跳舞，卡通动画',
    catalog,
    context: cloudReady()
  });
  assert.equal(r.selected.id, 'wan3-video');
});

test('路由：风景空镜（海外不可达）→ 降级到 Wan 3.0', () => {
  const r = router.route({
    prompt: '航拍雪山与森林的空镜，镜头稳定，延时摄影',
    catalog,
    context: cloudReady()
  });
  assert.equal(r.selected.id, 'wan3-video');
  const rej = r.rejected.find(x => x.id === 'hunyuanvideo-1.5');
  assert.ok(rej, 'HunyuanVideo 应因通道不可达被拒');
  assert.ok(rej.reasons.join().includes('不可达'));
});

test('路由：风景空镜（海外可达）→ 升级到更擅长的 HunyuanVideo', () => {
  const r = router.route({
    prompt: '航拍雪山与森林的空镜，镜头稳定，延时摄影',
    catalog,
    context: allChannelsReady()
  });
  assert.equal(r.selected.id, 'hunyuanvideo-1.5');
});

test('路由：高质感产品广告（有图）→ Wan 3.0 优速版', () => {
  const r = router.route({
    prompt: '电商产品广告，瓶身缓慢旋转展示，商业宣传片质感',
    catalog,
    context: cloudReady({ hasImage: true })
  });
  assert.equal(r.selected.id, 'wan3-video-prime');
});

test('路由：无缝循环微动效（海外不可达）→ Wan2.2 图生视频 Flash', () => {
  const r = router.route({
    prompt: '做一个无缝循环的微动效，静物轻微摆动，当动态壁纸用，gif 风格',
    catalog,
    context: cloudReady({ hasImage: true })
  });
  assert.equal(r.selected.id, 'wan2.2-i2v-flash');
});

test('路由：无缝循环微动效（海外可达）→ LTX-2.5 Fast', () => {
  const r = router.route({
    prompt: '做一个无缝循环的微动效，静物轻微摆动，当动态壁纸用，gif 风格',
    catalog,
    context: allChannelsReady({ hasImage: true })
  });
  assert.equal(r.selected.id, 'ltx-2.5-fast');
});

test('路由：图 + 音频口型驱动 → Wan 3.0（音频驱动能力）', () => {
  const r = router.route({
    prompt: '用这段音频让人物对口型说话，做成数字人视频',
    catalog,
    context: cloudReady({ hasImage: true, hasAudio: true })
  });
  assert.equal(r.selected.id, 'wan3-video');
  assert.ok(r.selected.matchedIntents.some(m => m.intent.includes('有声')));
});

test('路由：想要生成声音（无音频输入）→ Wan 3.0 系列原生有声', () => {
  const r = router.route({
    prompt: '有声视频，需要音乐和音效，音画同步',
    catalog,
    context: cloudReady({ hasAudio: false })
  });
  assert.ok(
    ['wan3-video', 'wan3-video-prime', 'happyhorse-1.1-t2v'].includes(r.selected.id),
    `应选原生有声模型，实际 ${r.selected.id}`
  );
});

test('路由：极速竖版（海外不可达）→ Wan 3.0 优速版', () => {
  const r = router.route({
    prompt: '赶时间，要极速秒出的竖版短视频，发抖音用',
    catalog,
    context: cloudReady()
  });
  assert.equal(r.selected.id, 'wan3-video-prime');
});

test('路由：极速竖版（海外可达）→ LTX-2.5 Fast', () => {
  const r = router.route({
    prompt: '赶时间，要极速秒出的竖版短视频，发抖音用',
    catalog,
    context: allChannelsReady()
  });
  assert.equal(r.selected.id, 'ltx-2.5-fast');
});

test('路由：首尾帧/转场 → Wan2.2 首尾帧专用模型', () => {
  const r = router.route({
    prompt: '用这两张图做首尾帧，中间加自然转场过渡',
    catalog,
    context: cloudReady({ hasImage: true, wantFirstLastFrame: true })
  });
  assert.equal(r.selected.id, 'wan2.2-kf2v-flash');
});

test('路由：30秒长时长多镜头 → Wan 3.0 系列（支持 2-30 秒）', () => {
  const r = router.route({
    prompt: '要一个30秒的多镜头叙事长视频，一镜到底',
    catalog,
    context: cloudReady()
  });
  assert.ok(['wan3-video', 'wan3-video-prime'].includes(r.selected.id), `实际 ${r.selected.id}`);
  assert.ok(r.selected.maxDurationSec >= 30, '选中模型必须真的支持 30 秒');
});

test('路由：动作迁移（有图 + 有参考视频）→ Wan2.2 animate-move（官方对口模型）', () => {
  const r = router.route({
    prompt: '把参考视频里的跳舞动作迁移到这张图片的人物上',
    catalog,
    context: cloudReady({ hasImage: true, hasVideoInput: true, hasReference: true })
  });
  assert.equal(r.selected.id, 'wan2.2-animate-move');
});

test('路由关键：动作迁移模型在缺参考视频时被拒绝，不给出会失败的调用', () => {
  const r = router.route({
    prompt: '把跳舞动作迁移到图片人物上',
    catalog,
    context: cloudReady({ hasImage: true, hasVideoInput: false })
  });
  const ids = r.chain.map(m => m.id);
  assert.ok(!ids.includes('wan2.2-animate-move'), '缺动作参考视频时不应入选');
  assert.ok(!ids.includes('wan2.2-animate-mix'), '缺动作参考视频时不应入选');
  assert.ok(r.rejected.some(x => x.reasons.join().includes('动作参考')));
});

test('路由：视频编辑/风格转换（提供待编辑视频）→ Wan2.7 videoedit', () => {
  const r = router.route({
    prompt: '编辑视频，将整个画面转换为黏土风格',
    catalog,
    context: cloudReady({ hasVideoInput: true })
  });
  assert.equal(r.selected.id, 'wan2.7-videoedit');
});

test('路由关键：视频编辑专用模型在缺视频输入时被拒绝', () => {
  const r = router.route({
    prompt: '编辑视频，将整个画面转换为黏土风格',
    catalog,
    context: cloudReady({ hasVideoInput: false })
  });
  const ids = r.chain.map(m => m.id);
  assert.ok(!ids.includes('wan2.7-videoedit'), '缺待编辑视频时专用编辑模型不应入选');
  assert.ok(!ids.includes('happyhorse-1.0-video-edit'), '缺待编辑视频时专用编辑模型不应入选');
  assert.ok(r.rejected.some(x => x.reasons.join().includes('待编辑的视频')));
});

test('路由：文档生视频 → Wan 3.0（支持 file/link 素材）', () => {
  const r = router.route({
    prompt: '根据这个PPT文档生成一段产品介绍视频',
    catalog,
    context: cloudReady()
  });
  assert.equal(r.selected.id, 'wan3-video');
  assert.ok((r.selected.modelId || '').startsWith('wan3.0'), '必须落到官方支持 file 素材的模型');
});

/* ============ 路由：输入约束（关键防呆）============ */

test('路由关键：图生视频模型在无图时必须被拒绝', () => {
  const r = router.route({
    prompt: '电影感写实画面，一个人在雨中行走',
    catalog,
    context: cloudReady({ hasImage: false })
  });
  const ids = r.chain.map(m => m.id);
  for (const m of catalog.models) {
    const req = m.requiredInputs || ((m.inputs || []).includes('i2v') && !(m.inputs || []).includes('t2v') ? ['i2v'] : []);
    if (req.includes('i2v')) {
      assert.ok(!ids.includes(m.id), `需图片的模型 ${m.id} 不应在无图场景入选`);
    }
  }
  assert.ok(r.rejected.some(x => x.reasons.join().includes('未上传图片')));
});

test('路由关键：带图时不支持图生视频的模型必须被拒绝', () => {
  const r = router.route({
    prompt: '让照片动起来',
    catalog,
    context: cloudReady({ hasImage: true })
  });
  const ids = r.chain.map(m => m.id);
  assert.ok(!ids.includes('happyhorse-1.1-t2v'), '纯文生视频模型不应在带图场景入选');
  assert.ok(!ids.includes('wan2.2-t2v-plus'), '纯文生视频模型不应在带图场景入选');
  assert.ok(r.rejected.some(x => x.reasons.join().includes('不支持图生视频')));
});

test('路由关键：需音频的模型在缺音频时被拒绝，不给出会失败的调用', () => {
  const r = router.route({
    prompt: '用音频驱动数字人口型说话',
    catalog,
    context: cloudReady({ hasImage: true, hasAudio: false })
  });
  const ids = r.chain.map(m => m.id);
  for (const m of catalog.models) {
    if ((m.requiredInputs || []).includes('audio')) {
      assert.ok(!ids.includes(m.id), `${m.id} 需音频，缺音频时不应入选`);
    }
  }
});

test('路由关键：需首尾帧的模型在只要单图时被拒绝', () => {
  const r = router.route({
    prompt: '让这张照片动起来',
    catalog,
    context: cloudReady({ hasImage: true, wantFirstLastFrame: false })
  });
  const ids = r.chain.map(m => m.id);
  assert.ok(!ids.includes('wan2.2-kf2v-flash'), '首尾帧专用模型不应在无尾帧需求时入选');
});

/* ============ 路由：本地轨道与硬件边界 ============ */

test('路由关键：无任何 Key 且本地未装 → 兜底到 Mock 且明确标注自检模式', () => {
  const r = router.route({ prompt: '一只猫在草地上奔跑', catalog, context: {} });
  assert.ok(r.selected, '必须有兜底，不能让流程断掉');
  assert.equal(r.selected.track, 'mock');
  assert.ok(r.explanation.includes('自检模式'), '解释中必须明确告知是自检模式');
});

test('路由：离线要求 → 跳过全部云端，走本地 LTX-2B', () => {
  const r = router.route({
    prompt: '我要离线本地生成，不联网，注意隐私，画面是一个人在跑步',
    catalog,
    context: localReady(['local-ltx-2b-fp8', 'local-wan2.1-1.3b-fp8'], { offlineOnly: true })
  });
  assert.equal(r.selected.track, 'local');
  assert.equal(r.selected.id, 'local-ltx-2b-fp8', '8GB 显存应选 LTX-2B 而非内存吃紧的 Wan2.1');
  assert.ok(r.explanation.includes('离线'));
  // 核心不变量：可执行链里不得出现任何云端模型
  assert.ok(!r.chain.some(m => m.track === 'cloud'), '离线模式下可执行链不得包含云端模型');
  // 全部云端模型都被拒（部分因离线，部分因缺图片/缺音频等更前置的输入约束，理由都成立）
  const cloudTotal = catalog.models.filter(m => m.track === 'cloud').length;
  const cloudRejected = r.rejected.filter(x => x.track === 'cloud').length;
  assert.equal(cloudRejected, cloudTotal, '所有云端模型都必须被拒');
  assert.ok(
    r.rejected.some(x => x.track === 'cloud' && x.reasons.join().includes('离线')),
    '至少应有云端模型明确因离线要求被拒'
  );
});

test('路由：带警告的本地模型（Wan2.1 内存吃紧）不应压过 LTX-2B', () => {
  const r = router.route({
    prompt: '离线本地生成，写实风格',
    catalog,
    context: localReady(['local-ltx-2b-fp8', 'local-wan2.1-1.3b-fp8'], { offlineOnly: true })
  });
  assert.equal(r.selected.id, 'local-ltx-2b-fp8');
  const wan = r.chain.find(m => m.id === 'local-wan2.1-1.3b-fp8');
  assert.ok(wan, 'Wan2.1 仍应在降级链中，只是排后面');
  assert.ok(wan.finalScore < r.selected.finalScore);
});

test('路由：硬件不足时跳过跑不动的本地模型', () => {
  const r = router.route({
    prompt: '离线本地生成一段写实视频',
    catalog,
    context: {
      offlineOnly: true,
      localModelsInstalled: ['local-ltx-2b-fp8', 'local-wan2.1-1.3b-fp8', 'local-cogvideox-2b'],
      hardware: { vramGB: 6, ramGB: 12, diskFreeGB: 100 }
    }
  });
  const localOnes = r.chain.filter(m => m.track === 'local');
  assert.equal(localOnes.length, 0, '6GB 显存下不应有任何本地模型入选');
  const rejected = r.rejected.filter(x => x.track === 'local');
  assert.ok(rejected.length >= 3);
  assert.ok(rejected.some(x => x.reasons.join().includes('显存')));
});

test('路由：本地模型未安装时明确给出安装引导，不静默失败', () => {
  const r = router.route({
    prompt: '离线本地生成一段视频',
    catalog,
    context: { offlineOnly: true, localModelsInstalled: [], hardware: { vramGB: 8, ramGB: 15.2, diskFreeGB: 100 } }
  });
  const rej = r.rejected.filter(x => x.track === 'local');
  assert.ok(rej.length >= 3);
  assert.ok(rej.every(x => x.reasons.join().includes('尚未下载')));
});

/* ============ 路由：可解释性 ============ */

test('路由：无意图关键词时仍能按质量排序出结果', () => {
  const r = router.route({ prompt: '随便来点什么', catalog, context: cloudReady() });
  assert.ok(r.selected);
  assert.ok(r.explanation.includes('未命中特定意图'));
});

test('路由：解释必须包含选定理由与降级链，不做黑盒', () => {
  const r = router.route({
    prompt: '电影感写实画面，超清质感',
    catalog,
    context: cloudReady()
  });
  assert.ok(r.explanation.includes('选定'));
  assert.ok(r.explanation.includes('降级'), '必须告知失败时的降级路径');
  assert.ok(r.explanation.includes('识别到意图'));
});

test('执行链：顺序与排序结果一致，Mock 永远在末尾', () => {
  const r = router.route({ prompt: '无意义文本', catalog, context: {} });
  const ids = router.toExecutionChain(r);
  assert.ok(ids.length > 0);
  assert.equal(ids[ids.length - 1], 'mock-selftest', 'Mock 必须是最后兜底');
});

test('执行链：完整通道就绪时链条包含多个真实候选，具备降级能力', () => {
  const r = router.route({ prompt: '电影感写实画面', catalog, context: allChannelsReady() });
  const real = r.chain.filter(m => m.track !== 'mock');
  assert.ok(real.length >= 5, `应有足够降级候选，实际 ${real.length}`);
  // 分数必须单调不增
  for (let i = 1; i < real.length; i++) {
    assert.ok(real[i - 1].finalScore >= real[i].finalScore, '降级链必须按分数降序');
  }
});

/* ============ 模型库完整性（防止编造模型混入）============ */

test('模型库完整性：每个模型都有必备字段', () => {
  for (const m of catalog.models) {
    assert.ok(m.id, '缺 id');
    assert.ok(m.name, `${m.id} 缺 name`);
    assert.ok(['cloud', 'local', 'mock'].includes(m.track), `${m.id} track 非法`);
    assert.ok(Array.isArray(m.inputs) && m.inputs.length > 0, `${m.id} 缺 inputs`);
    assert.ok(typeof m.quality === 'number', `${m.id} 缺 quality`);
    assert.ok(typeof m.costFactor === 'number', `${m.id} 缺 costFactor`);
    assert.ok(m.license, `${m.id} 缺 license`);
    if (m.track === 'local') {
      assert.ok(typeof m.vramGB === 'number', `${m.id} 本地模型必须声明 vramGB`);
      assert.ok(typeof m.ramGB === 'number', `${m.id} 本地模型必须声明 ramGB`);
      assert.ok(m.weights && m.weights.file, `${m.id} 本地模型必须有 weights.file`);
    }
    if (m.track === 'cloud') {
      assert.ok(m.provider, `${m.id} 云端模型必须声明 provider`);
      assert.ok(m.region, `${m.id} 云端模型必须声明 region`);
    }
  }
});

test('模型库：意图关键词不得为空', () => {
  for (const [k, v] of Object.entries(catalog.intents)) {
    assert.ok(Array.isArray(v.keywords) && v.keywords.length > 0, `意图 ${k} 缺关键词`);
    assert.ok(v.label, `意图 ${k} 缺 label`);
  }
});

test('模型库：远程热更新源必须指向 sml1145/AIshipin', () => {
  assert.ok(catalog.remoteSource.urls.length >= 2, '至少两个远程源做兜底');
  for (const u of catalog.remoteSource.urls) {
    assert.ok(u.includes('sml1145/AIshipin'), `远程源应指向目标仓库: ${u}`);
  }
});

test('模型库关键：不得混入官方清单里不存在的模型（曾误加 wan2.2-s2v）', () => {
  const ids = catalog.models.map(m => m.id);
  const modelIds = catalog.models.map(m => m.modelId).filter(Boolean);
  // 这些是早先基于二手调研臆测、经官方文档核实并不存在的条目
  for (const ghost of ['wan2.2-s2v', 'minimax-h3']) {
    assert.ok(!modelIds.includes(ghost), `模型库不得包含未经官方文档核实的 ${ghost}`);
  }
  // 音频驱动能力必须由官方确认支持的模型承担
  const audioCapable = catalog.models.filter(m => (m.inputs || []).includes('audio'));
  assert.ok(audioCapable.length > 0, '必须有支持音频输入的模型');
  assert.ok(audioCapable.every(m => m.modelIdVerified === true || m.track !== 'cloud'),
    '承担音频能力的云端模型必须是已核对官方文档的');
  assert.ok(ids.includes('wan2.7-i2v'), '音频驱动应由官方文档确认的 wan2.7-i2v 承担');
});

test('模型库：云端模型必须声明 modelIdVerified，已核对的必须给出真实 modelId', () => {
  const cloudModels = catalog.models.filter(m => m.track === 'cloud');
  assert.ok(cloudModels.length > 0);
  for (const m of cloudModels) {
    assert.equal(typeof m.modelIdVerified, 'boolean', `${m.id} 必须显式声明是否已核对官方文档`);
    assert.ok(m.match && m.match.pattern, `${m.id} 必须有 match.pattern 以便从通道清单自动发现真实 id`);
    if (m.modelIdVerified) {
      assert.ok(typeof m.modelId === 'string' && m.modelId.length > 0, `${m.id} 已核对就必须给出真实 modelId`);
    }
  }
});

test('模型库：已核对的百炼模型 modelId 必须与官方文档一致', () => {
  const official = [
    'wan3.0-video', 'wan3.0-video-prime',
    'happyhorse-1.1-t2v', 'happyhorse-1.1-i2v', 'happyhorse-1.1-r2v',
    'wan2.7-i2v', 'wan2.7-t2v', 'wan2.7-videoedit',
    'wan2.2-kf2v-flash', 'wan2.2-animate-move', 'wan2.2-animate-mix',
    'happyhorse-1.0-video-edit', 'wan2.2-t2v-plus', 'wan2.2-i2v-flash'
  ];
  const ds = catalog.models.filter(m => m.provider === 'dashscope' && m.modelIdVerified);
  assert.ok(ds.length >= 10, '百炼已核对模型数量应足够覆盖主要场景');
  for (const m of ds) {
    assert.ok(official.includes(m.modelId), `${m.id} 的 modelId "${m.modelId}" 不在官方清单内`);
  }
});

test('模型库：SiliconFlow 端点必须是核实过的 /v1/video/submit（实测 /v1/videos/generations 为 404）', () => {
  const sf = catalog.models.filter(m => m.provider === 'siliconflow');
  assert.ok(sf.length >= 2);
  for (const m of sf) {
    assert.equal(m.api.submitPath, '/v1/video/submit');
    assert.equal(m.api.statusPath, '/v1/video/status');
    assert.ok(m.api.imageAcceptsBase64 === true || !m.inputs.includes('i2v'),
      'SiliconFlow 图生视频必须标注支持 base64，这是本地图片上传的关键');
  }
  const i2v = sf.find(m => m.id === 'sf-wan2.2-i2v');
  assert.ok(i2v.api.imageSizes.includes('1280x720'));
  assert.deepEqual(i2v.api.autoRatioMapping, { '16:9': '1280x720', '9:16': '720x1280', '1:1': '960x960' });
});

test('模型库关键：ModelScope 视频端点未获取，不得当作视频通道使用', () => {
  const ms = catalog.models.filter(m => m.provider === 'modelscope');
  assert.equal(ms.length, 0, 'ModelScope 视频端点官方文档未获取，本版不得编造端点当通道用');
  assert.ok(catalog.facts.modelscopePolicy.includes('未获取'), '必须在 facts 中如实说明');
});

test('模型库：本地模型权重体积必须与实测 ModelScope 清单一致', () => {
  const ltx = catalog.models.find(m => m.id === 'local-ltx-2b-fp8');
  assert.equal(ltx.weights.file, 'ltx-video-2b-v0.9.1.safetensors');
  assert.equal(ltx.weights.sizeGB, 5.32);
  const wan = catalog.models.find(m => m.id === 'local-wan2.1-1.3b-fp8');
  const t5 = wan.weights.extraFiles.find(f => f.file.includes('t5'));
  assert.equal(t5.sizeGB, 10.58, 'T5 编码器体积必须是实测的 10.58GB，这是内存风险的关键依据');
  assert.ok(wan.warning.includes('10.58GB'), '必须把内存风险写进 warning 供界面提示');
});

test('模型库：海外不可达模型必须标注 region 以便自动过滤', () => {
  const overseas = catalog.models.filter(m => m.region === 'overseas-unreachable');
  assert.ok(overseas.length >= 2, '应有海外通道模型（本机不可达但保留代码位）');
  for (const m of overseas) {
    assert.ok(m.notes.includes('不可达'), `${m.id} 必须在 notes 说明本机实测不可达`);
    assert.equal(m.modelIdVerified, false, '未核对的海外模型不得标记为已验证');
  }
});

test('模型库：schemaVersion 必须为 2（官方文档核实后的修订版）', () => {
  assert.equal(catalog.schemaVersion, 2);
  assert.ok(catalog.facts.dashscopeEndpoint.includes('video-synthesis'));
  assert.ok(catalog.facts.dashscopeImagePolicy.includes('不假装'), '必须如实说明本地图片传 DashScope 的不确定性');
});
