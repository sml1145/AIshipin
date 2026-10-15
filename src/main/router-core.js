'use strict';

/**
 * 智能模型路由引擎（纯函数，可独立测试）
 *
 * 决策公式：
 *   score = 意图命中分(0-10) × 通道可用(0/1) × 硬件可行(0/1) × (quality×0.5 + speed×0.3 - cost×0.2)
 * 失败时按降级链依次尝试，A 轨（云端）与 B 轨（本地）互为兜底，最终兜底到 Mock 自检通道。
 *
 * 设计原则：每次决策都产出人类可读的 reasons，界面直接展示，不做黑盒。
 */

/** 硬件与状态的默认假设（真实值由主进程探测后注入） */
const DEFAULT_CONTEXT = {
  hasImage: false,
  hasAudio: false,
  hasReference: false,
  hasVideoInput: false,
  wantFirstLastFrame: false,
  wantVertical: false,
  wantLongDuration: false,
  offlineOnly: false,
  hardware: { vramGB: 8, ramGB: 16, diskFreeGB: 100 },
  localModelInstalled: false,
  localModelsInstalled: [],
  keys: {},
  providers: {
    dashscope: { reachable: true, hasKey: false },
    siliconflow: { reachable: true, hasKey: false },
    modelscope: { reachable: true, hasKey: false },
    huggingface: { reachable: false, hasKey: false },
    replicate: { reachable: false, hasKey: false },
    fal: { reachable: false, hasKey: false },
    local: { reachable: true, hasKey: false },
    mock: { reachable: true, hasKey: false }
  }
};

/**
 * 识别用户描述命中的意图
 * @param {string} text 用户描述
 * @param {object} intents models.json 的 intents 段
 * @returns {Map<string, {label:string, hits:string[], score:number}>}
 */
function detectIntents(text, intents) {
  const result = new Map();
  const lower = String(text || '').toLowerCase();
  if (!lower.trim()) return result;

  for (const [key, def] of Object.entries(intents || {})) {
    const hits = [];
    for (const kw of def.keywords || []) {
      if (lower.includes(String(kw).toLowerCase())) hits.push(kw);
    }
    if (hits.length > 0) {
      // 命中越多分越高，但封顶 10；首个命中给 6 分基础
      const score = Math.min(10, 6 + (hits.length - 1) * 2);
      result.set(key, { label: def.label, hits, score });
    }
  }
  return result;
}

/**
 * 解析模型"必须具备"的输入条件。
 * 优先用显式声明的 requiredInputs；未声明时按 inputs 推断：
 * 只支持 i2v 而不支持 t2v 的模型，必然需要图片。
 */
function resolveRequiredInputs(model) {
  if (Array.isArray(model.requiredInputs)) return model.requiredInputs;
  const inputs = model.inputs || [];
  const required = [];
  if (inputs.includes('i2v') && !inputs.includes('t2v')) required.push('i2v');
  return required;
}

/**
 * 判断某个模型在当前上下文下是否"可用"，返回 {ok, reasons}
 */
function checkAvailability(model, ctx, intents) {
  const reasons = [];
  const inputs = model.inputs || [];

  // 1a. 模型自身要求的输入必须被满足（否则真实调用必然失败）
  for (const need of resolveRequiredInputs(model)) {
    if (need === 'i2v' && !ctx.hasImage) {
      return { ok: false, reasons: ['该模型必须上传图片才能工作，但本次未上传图片'] };
    }
    if (need === 'audio' && !ctx.hasAudio) {
      return { ok: false, reasons: ['该模型必须提供音频才能工作，但本次未提供音频'] };
    }
    if (need === 'first_last_frame' && !ctx.wantFirstLastFrame) {
      return { ok: false, reasons: ['该模型是首尾帧专用模型，需要同时提供首帧与尾帧'] };
    }
    if (need === 'reference' && !ctx.hasReference) {
      return { ok: false, reasons: ['该模型需要参考素材（图片/视频）才能工作，但本次未提供'] };
    }
    if (need === 'video_edit' && !ctx.hasVideoInput) {
      return { ok: false, reasons: ['该模型是视频编辑模型，需要提供待编辑的视频'] };
    }
    if (need === 'motion_transfer' && !(ctx.hasVideoInput || ctx.hasReference)) {
      return { ok: false, reasons: ['该模型需要动作参考视频才能工作，但本次未提供'] };
    }
  }

  // 1b. 反向校验：用户给了输入，模型必须支持
  if (ctx.hasImage && !inputs.includes('i2v')) {
    return { ok: false, reasons: [`不支持图生视频，而本次上传了图片`] };
  }
  if (ctx.hasAudio && !inputs.includes('audio')) {
    return { ok: false, reasons: [`不支持音频输入，而本次需要音频驱动`] };
  }
  if (ctx.wantFirstLastFrame && !inputs.includes('first_last_frame')) {
    reasons.push('不支持首尾帧控制');
    return { ok: false, reasons };
  }

  // 2. 离线要求：只允许 local / mock 轨
  if (ctx.offlineOnly && model.track === 'cloud') {
    return { ok: false, reasons: ['用户要求离线生成，跳过云端通道'] };
  }

  // 3. 云端通道：必须可达 + 有 Key
  if (model.track === 'cloud') {
    const p = ctx.providers[model.provider] || { reachable: false, hasKey: false };
    if (!p.reachable) {
      return { ok: false, reasons: [`通道 ${model.provider} 本机网络不可达`] };
    }
    if (model.requiresKey && !p.hasKey) {
      return { ok: false, reasons: [`通道 ${model.provider} 未配置 API Key`] };
    }
  }

  // 4. 本地轨道：必须已安装 + 硬件够
  if (model.track === 'local') {
    const installed = (ctx.localModelsInstalled || []).includes(model.id) || ctx.localModelInstalled;
    if (!installed) {
      return { ok: false, reasons: ['本地模型包尚未下载安装'] };
    }
    const needVram = model.vramGB || 0;
    const needRam = model.ramGB || 0;
    if (needVram > ctx.hardware.vramGB) {
      return { ok: false, reasons: [`需显存 ${needVram}GB，本机仅 ${ctx.hardware.vramGB}GB，跑不动`] };
    }
    if (needRam > ctx.hardware.ramGB) {
      return { ok: false, reasons: [`需内存 ${needRam}GB，本机仅 ${ctx.hardware.ramGB}GB，跑不动`] };
    }
  }

  // 5. Mock 自检轨：默认永远可用，但若显式声明其 provider 不可达则也应跳过，
  //    否则编排器会选中一个没有对应 Provider 实例的 mock 而崩溃。
  if (model.track === 'mock') {
    const p = ctx.providers[model.provider];
    if (p && p.reachable === false) {
      return { ok: false, reasons: ['自检通道不可用'] };
    }
    return { ok: true, reasons };
  }

  // 6. 其余情况：可用
  return { ok: true, reasons };
}

/**
 * 计算模型对当前意图的匹配分
 *
 * 加权策略：主意图（最高分）为主导，其余命中意图只做小幅加成（25%）。
 * 这样避免"偶然命中一个次要关键词"的模型压过真正对口的模型。
 */
function scoreModel(model, intents) {
  const strengths = model.strengths || {};
  const matchedIntents = [];
  const matches = [];

  for (const [key, det] of intents.entries()) {
    const w = strengths[key];
    if (w && w > 0) {
      const m = det.score * (w / 10);
      matches.push(m);
      matchedIntents.push({ intent: det.label, weight: w, match: Number(m.toFixed(3)) });
    }
  }

  let intentScore = 0;
  if (intents.size === 0) {
    // 没有任何意图命中时，用通用质量分兜底（避免全 0 排不出序）
    intentScore = (model.quality || 5) * 0.6;
  } else if (matches.length > 0) {
    matches.sort((a, b) => b - a);
    const primary = matches[0];
    const secondarySum = matches.slice(1).reduce((s, v) => s + v, 0);
    intentScore = primary + 0.25 * secondarySum;
  }
  // 命中了意图但该模型一个都不擅长 → intentScore 保持 0，自然排到后面

  const quality = model.quality || 5;
  const speed = model.speed || 5;
  const cost = model.costFactor || 0;
  const base = quality * 0.5 + speed * 0.3 - cost * 0.2;

  matchedIntents.sort((a, b) => b.match - a.match);

  return {
    intentScore: Number(intentScore.toFixed(3)),
    baseScore: Number(base.toFixed(3)),
    total: Number((intentScore * base).toFixed(3)),
    matchedIntents
  };
}

/**
 * 主路由入口
 * @param {object} params
 * @param {string} params.prompt 用户描述
 * @param {object} params.catalog models.json 内容
 * @param {object} [params.context] 上下文（与 DEFAULT_CONTEXT 合并）
 * @returns {{selected:object|null, chain:object[], rejected:object[], intents:Array, explanation:string}}
 */
function route({ prompt, catalog, context = {} }) {
  const ctx = {
    ...DEFAULT_CONTEXT,
    ...context,
    hardware: { ...DEFAULT_CONTEXT.hardware, ...(context.hardware || {}) },
    providers: { ...DEFAULT_CONTEXT.providers, ...(context.providers || {}) }
  };

  const intents = detectIntents(prompt, catalog.intents);
  const models = catalog.models || [];

  const chain = [];
  const rejected = [];

  for (const model of models) {
    const avail = checkAvailability(model, ctx, intents);
    if (!avail.ok) {
      rejected.push({
        id: model.id,
        name: model.name,
        track: model.track,
        reasons: avail.reasons
      });
      continue;
    }
    const sc = scoreModel(model, intents);
    chain.push({
      id: model.id,
      name: model.name,
      track: model.track,
      provider: model.provider,
      // 真实调用所需的模型标识与核对状态，执行层与 UI 都要用
      modelId: model.modelId || null,
      modelIdVerified: model.modelIdVerified === true,
      matchPattern: (model.match && model.match.pattern) || null,
      api: model.api || null,
      license: model.license,
      warning: model.warning || null,
      resolution: model.resolution,
      maxDurationSec: model.maxDurationSec,
      score: sc.total,
      intentScore: sc.intentScore,
      baseScore: sc.baseScore,
      matchedIntents: sc.matchedIntents,
      // 有警告的模型（如内存吃紧）在同等分数下降权，避免默认把用户推向高风险路径
      penalty: model.warning ? 0.75 : 1.0,
      finalScore: Number((sc.total * (model.warning ? 0.75 : 1.0)).toFixed(3)),
      notes: model.notes || ''
    });
  }

  chain.sort((a, b) => b.finalScore - a.finalScore);

  // Mock 始终排到末尾作为最后兜底，不参与正常竞争
  const mockIdx = chain.findIndex(m => m.track === 'mock');
  let mockEntry = null;
  if (mockIdx !== -1) {
    mockEntry = chain.splice(mockIdx, 1)[0];
  }
  const ordered = mockEntry ? [...chain, mockEntry] : chain;

  const selected = ordered.length > 0 ? ordered[0] : null;

  // 生成人类可读的决策说明
  const explanation = buildExplanation({ selected, intents, ctx, ordered, mockEntry });

  return {
    selected,
    chain: ordered,
    rejected,
    intents: Array.from(intents.entries()).map(([key, v]) => ({ key, ...v })),
    explanation,
    context: {
      offlineOnly: ctx.offlineOnly,
      hasImage: ctx.hasImage,
      hasAudio: ctx.hasAudio,
      vramGB: ctx.hardware.vramGB,
      ramGB: ctx.hardware.ramGB
    }
  };
}

function buildExplanation({ selected, intents, ctx, ordered, mockEntry }) {
  const lines = [];
  const intentList = Array.from(intents.values());

  if (intentList.length > 0) {
    lines.push(`识别到意图：${intentList.map(i => `${i.label}（命中 ${i.hits.join('、')}）`).join('；')}`);
  } else {
    lines.push('未命中特定意图关键词，按通用质量与速度排序');
  }

  if (ctx.offlineOnly) {
    lines.push('已按你的要求限定为离线本地生成，跳过全部云端通道');
  }
  if (ctx.hasImage) {
    lines.push('本次带图片输入，已过滤掉不支持图生视频的模型');
  }

  if (!selected) {
    lines.push('没有可用模型：云端通道缺 Key 或不可达，且本地模型包未安装。请先在设置中配置 API Key，或在「本地模型」页下载安装。');
    return lines.join('\n');
  }

  if (selected.track === 'mock') {
    lines.push(`⚠️ 当前为「自检模式」：${selected.name}。未配置任何 API Key 且本地模型未安装，返回的是预置样例视频，用于验证全链路是否通畅，不是真实 AI 生成结果。`);
    return lines.join('\n');
  }

  lines.push(
    `选定：${selected.name}（${selected.track === 'local' ? '本地免密钥' : '云端 ' + selected.provider}）` +
    ` · 综合分 ${selected.finalScore}` +
    (selected.matchedIntents.length ? ` · 擅长 ${selected.matchedIntents.map(m => m.intent).join('/')}` : '')
  );
  if (selected.warning) lines.push(`⚠️ 注意：${selected.warning}`);
  if (selected.notes) lines.push(`说明：${selected.notes}`);

  const fallbacks = ordered.slice(1).filter(m => m.track !== 'mock').slice(0, 3);
  if (fallbacks.length > 0) {
    lines.push(`若失败将依次降级：${fallbacks.map(f => f.name).join(' → ')}`);
  } else if (mockEntry) {
    lines.push('若失败将降级到自检模式（Mock），保证流程不中断');
  }
  return lines.join('\n');
}

/**
 * 生成降级链（供实际执行时逐个尝试）
 * @param {object} routeResult route() 的返回值
 * @returns {string[]} 模型 id 顺序数组
 */
function toExecutionChain(routeResult) {
  return (routeResult.chain || []).map(m => m.id);
}

module.exports = {
  DEFAULT_CONTEXT,
  detectIntents,
  checkAvailability,
  scoreModel,
  route,
  toExecutionChain,
  buildExplanation
};
