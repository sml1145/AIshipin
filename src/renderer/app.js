'use strict';

/**
 * 渲染进程逻辑
 *
 * 安全要点：
 *   - 所有文本一律先转义再插入 DOM，绝不用 innerHTML 直接塞用户/模型内容（防 XSS）
 *   - 只通过 window.hxsk（preload 白名单）访问能力，不碰 require/fs
 *   - 图片只显示主进程回传的本地路径（file://），不读取文件内容到渲染层
 *
 * 健壮性要点（v1.3 修复"点击无反馈"）：
 *   - 任何失败都必须让用户看得见，绝不静默：桥接缺失、IPC 被拒、异常抛出都要显式提示
 *   - 顶层不得有裸 hxsk 调用，否则桥接未注入时脚本会中断，导致后续按钮全部绑不上监听
 */

/* ============ 全局错误可见化（必须最先执行）============
 *
 * 教训：此前 app.js 在顶层直接 hxsk.on(...)，一旦 preload 未注入 window.hxsk，
 * 该行抛 TypeError 中断整个脚本 → 其后所有按钮监听器都没绑定 → 表现为
 * "所有按钮点了没反应"，且因为中断发生在 init() 之前，连错误提示都不显示。
 * 现在把任何未捕获异常都变成界面上可见的红色横幅。
 */

/** 在页面顶部显示一条可关闭的错误横幅（用于致命问题）。
 *  必须可关闭：桥接缺失时若横幅盖住整个界面，用户连「诊断」页都点不进去。 */
function showFatalBanner(title, detail) {
  try {
    let bar = document.getElementById('fatalBanner');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'fatalBanner';
      bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;' +
        'background:#7a1f2b;color:#fff;padding:12px 44px 12px 16px;font-size:13px;line-height:1.6;' +
        'border-bottom:2px solid #ff6b7a;white-space:pre-wrap;font-family:inherit;' +
        'max-height:45vh;overflow:auto';
      const closeBtn = document.createElement('button');
      closeBtn.id = 'fatalBannerClose';
      closeBtn.setAttribute('aria-label', '关闭');
      closeBtn.textContent = '×';
      closeBtn.style.cssText = 'position:absolute;top:6px;right:10px;background:transparent;' +
        'border:none;color:#fff;font-size:22px;line-height:1;cursor:pointer;padding:2px 8px';
      closeBtn.addEventListener('click', () => { bar.style.display = 'none'; });
      bar.appendChild(closeBtn);
      const text = document.createElement('span');
      text.id = 'fatalBannerText';
      bar.appendChild(text);
      if (document.body) document.body.appendChild(bar);
      else document.addEventListener('DOMContentLoaded', () => document.body.appendChild(bar));
    }
    bar.style.display = '';
    const textEl = bar.querySelector('#fatalBannerText');
    if (textEl) textEl.textContent = title + (detail ? '\n' + detail : '');
  } catch (e) { /* 连 DOM 都不可用时无能为力 */ }
}

window.addEventListener('error', (e) => {
  showFatalBanner('⚠ 界面脚本出错（请把这段截图反馈）',
    `${e.message || e.error}\n位置: ${(e.filename || '').split('/').pop()}:${e.lineno}`);
});

// 未处理的 Promise 拒绝 —— 这正是"点击按钮毫无反应"的元凶：
// 此前 14 个点击处理器缺 try/catch，IPC 被拒时异常被静默丢弃
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  const msg = (r && (r.message || r.error)) || String(r);
  showFatalBanner('⚠ 操作失败（请把这段截图反馈）', msg);
});

/* ============ 桥接守卫 ============
 * preload 可能因 sandbox / 打包路径 / 加载顺序而未注入 window.hxsk。
 * 这种情况下绝不能静默死亡：用一个"安全代理"兜底，使任何方法调用都
 *   ① 不再抛 TypeError（否则顶层 hxsk.on(...) 会中断整个脚本，后续按钮全绑不上）
 *   ② 显示明确的错误横幅，告诉用户到底怎么了、能怎么办
 */
const REAL_HXSK = window.hxsk;
let hxsk;
if (REAL_HXSK) {
  hxsk = REAL_HXSK;
} else {
  const bridgeMissingMsg =
    '界面桥接未加载（window.hxsk 不存在），所有功能不可用。\n' +
    '可能原因：安装文件损坏、被安全软件拦截、或直接从压缩包内运行。\n' +
    '建议：卸载后重新安装最新版；若仍如此，请把本提示截图反馈。';
  showFatalBanner('⚠ 界面桥接未加载', bridgeMissingMsg);
  hxsk = new Proxy({}, {
    get(_t, prop) {
      // 事件订阅返回空操作，避免顶层调用中断脚本
      if (prop === 'on') return () => () => {};
      // 其余方法调用一律返回被拒绝的 Promise，由 unhandledrejection 或调用方 catch 呈现
      return () => Promise.reject(new Error(bridgeMissingMsg));
    }
  });
}

/**
 * 初始化期间各步骤的失败记录。
 * 必须声明在所有顶层 safeOn() 调用之前 —— 否则顶层调用一旦触发 push 就会撞上
 * const 的暂时性死区（TDZ）ReferenceError，把"可见的错误"变成"脚本中断"。
 */
const initErrors = [];

/* ============ 极简安全 Markdown ============ */

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** 只支持极少标记，且全程基于已转义文本，杜绝注入 */
function renderMarkdown(src) {
  const esc = escapeHtml(src);
  const lines = esc.split('\n');
  const out = [];
  let inCode = false;
  for (let raw of lines) {
    if (/^```/.test(raw.trim())) {
      out.push(inCode ? '</code></pre>' : '<pre><code>');
      inCode = !inCode;
      continue;
    }
    if (inCode) { out.push(raw); continue; }
    let line = raw;
    // 行内 code
    line = line.replace(/`([^`]+)`/g, '<code>$1</code>');
    // 粗体
    line = line.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    // 链接：只允许 http(s)，且 href 已转义
    line = line.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    if (/^#{1,4}\s/.test(line)) {
      const lvl = line.match(/^#+/)[0].length;
      out.push(`<h${lvl}>${line.replace(/^#+\s/, '')}</h${lvl}>`);
    } else if (/^\s*[-*]\s/.test(line)) {
      out.push(`<div class="li">• ${line.replace(/^\s*[-*]\s/, '')}</div>`);
    } else if (line.trim() === '') {
      out.push('<br/>');
    } else {
      out.push(`<div>${line}</div>`);
    }
  }
  if (inCode) out.push('</code></pre>');
  return out.join('');
}

/* ============ 工具 ============ */

function $(sel) { return document.querySelector(sel); }
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function toast(msg, type = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast ${type}`;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.className = 'toast hidden'; }, 3200);
}
function fileUrl(p) {
  if (!p) return '';
  if (p.startsWith('file://')) return p;
  return 'file:///' + p.replace(/\\/g, '/');
}

/**
 * 统一的点击兜底包装。
 * 教训：此前多个点击处理器直接调用 hxsk.*，IPC 被拒时变成未处理的 Promise 拒绝，
 * 异常被静默丢弃 —— 用户点了按钮【毫无反应也没有报错】，无从判断是卡住还是坏了。
 * 用它包装后，任何失败都会变成一条可见的 toast + 致命横幅。
 *
 * @param {string} label 操作名（用于提示文案，如"打开文件夹"）
 * @param {Function} fn 实际处理逻辑，可以是 async
 */
function guardClick(label, fn) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      const msg = (err && (err.message || err.error)) || String(err);
      toast(`${label}失败：${msg}`, 'err');
      showFatalBanner(`⚠ ${label}失败`, msg + '\n请把这段截图反馈以便修复。');
    }
  };
}

/* ============ 全局状态 ============ */

const state = {
  appInfo: null,
  catalog: null,
  hardware: null,
  secrets: {},
  config: {},
  attachedImages: [],   // 本地图片绝对路径
  currentTaskId: null,  // 当前进行中的任务 id，用于取消
  taskNodes: new Map(), // taskId → {bubble, progressFill, progressText, attemptsEl, videoSlot}
  history: []
};

/* ============ 视图切换 ============ */

document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    btn.classList.add('active');
    $(`#view-${btn.dataset.view}`).classList.add('active');
    if (btn.dataset.view === 'local') renderLocalModels();
    if (btn.dataset.view === 'settings') renderSettings();
    if (btn.dataset.view === 'tasks') renderTasks();
    if (btn.dataset.view === 'diag') renderDiag();
  });
});

/* ============ 对话 ============ */

function addMessage(role, content, opts = {}) {
  const msg = el('div', `msg ${role}`);
  const avatar = el('div', 'avatar', role === 'user' ? '我' : '幻');
  const bubble = el('div', 'bubble');
  if (opts.html) bubble.innerHTML = content;
  else if (opts.markdown) bubble.innerHTML = renderMarkdown(content);
  else bubble.textContent = content;
  msg.appendChild(avatar);
  msg.appendChild(bubble);
  $('#chatLog').appendChild(msg);
  $('#chatLog').scrollTop = $('#chatLog').scrollHeight;
  return bubble;
}

/** 追加一条助手消息，带路由卡片 + 进度条 + 视频槽 */
function addAssistantTaskMessage(routing) {
  const msg = el('div', 'msg assistant');
  const avatar = el('div', 'avatar', '幻');
  const bubble = el('div', 'bubble');

  if (routing && routing.explanation) {
    const card = el('div', 'routing-card');
    card.innerHTML = renderMarkdown(routing.explanation);
    bubble.appendChild(card);
  }

  const progressWrap = el('div', 'progress-wrap');
  const bar = el('div', 'progress-bar');
  const fill = el('div', 'progress-fill');
  bar.appendChild(fill);
  const ptext = el('div', 'progress-text', '准备中…');
  progressWrap.appendChild(bar);
  progressWrap.appendChild(ptext);
  bubble.appendChild(progressWrap);

  const attemptsEl = el('div', 'attempts');
  bubble.appendChild(attemptsEl);

  const videoSlot = el('div');
  bubble.appendChild(videoSlot);

  msg.appendChild(avatar);
  msg.appendChild(bubble);
  $('#chatLog').appendChild(msg);
  $('#chatLog').scrollTop = $('#chatLog').scrollHeight;
  const nodes = { bubble, progressFill: fill, progressText: ptext, attemptsEl, videoSlot };
  _lastNodes = nodes;
  return nodes;
}

function renderAttempts(attemptsEl, attempts) {
  if (!attemptsEl || !Array.isArray(attempts)) return;
  attemptsEl.innerHTML = '';
  const fails = attempts.filter(a => !a.ok);
  if (fails.length === 0) return;
  const head = el('div', '', `已尝试 ${fails.length} 个候选并自动降级：`);
  attemptsEl.appendChild(head);
  for (const f of fails) {
    const line = el('div', 'fail', `✗ ${f.modelName}（${f.errorCode}）：${(f.hint || f.error || '').split('\n')[0]}`);
    attemptsEl.appendChild(line);
  }
}

/* ============ 生成 ============ */

async function handleSend() {
  const prompt = $('#promptInput').value.trim();
  const offlineOnly = $('#chkOffline').checked;
  if (!prompt && state.attachedImages.length === 0) {
    toast('请输入描述或上传图片', 'err');
    return;
  }

  // 用户消息
  const userBubble = addMessage('user', prompt || '(仅图片)');
  for (const img of state.attachedImages) {
    const im = document.createElement('img');
    im.className = 'thumb';
    im.src = fileUrl(img);
    userBubble.appendChild(im);
  }

  const req = {
    prompt,
    offlineOnly,
    imagePath: state.attachedImages[0] || undefined
  };

  $('#btnSend').disabled = true;
  $('#promptInput').value = '';

  // 预演路由，先把选型理由显示出来
  let preview = null;
  try { preview = await hxsk.previewRoute(req); } catch (e) { /* 预演失败不阻断 */ }
  const nodes = addAssistantTaskMessage(preview);

  // 清空已附图
  state.attachedImages = [];
  renderImagePreviews();

  try {
    const result = await hxsk.submitGenerate(req);
    finishTask(nodes, result);
  } catch (err) {
    nodes.progressText.textContent = '生成异常';
    nodes.progressFill.style.width = '0%';
    nodes.bubble.appendChild(el('div', 'selftest-tag', `错误：${err.message || err}`));
  } finally {
    $('#btnSend').disabled = false;
  }
}

function finishTask(nodes, result) {
  // 任务收口：复位取消按钮与当前任务 id
  const cancelBtn = $('#btnCancel');
  if (cancelBtn) { cancelBtn.style.display = 'none'; cancelBtn.disabled = false; cancelBtn.textContent = '取消'; }
  state.currentTaskId = null;
  renderAttempts(nodes.attemptsEl, result.attempts);
  if (result.ok && result.result) {
    nodes.progressFill.style.width = '100%';
    nodes.progressText.textContent = result.message || '生成完成';
    const r = result.result;
    if (r.localPath) {
      const video = document.createElement('video');
      video.src = fileUrl(r.localPath);
      video.controls = true;
      nodes.videoSlot.appendChild(video);
      const bar = el('div');
      const openBtn = el('button', 'ghost-btn', '在文件夹中显示');
      openBtn.style.marginTop = '8px';
      openBtn.addEventListener('click', guardClick('打开所在文件夹', () => hxsk.showItemInFolder(r.localPath)));
      bar.appendChild(openBtn);
      nodes.videoSlot.appendChild(bar);
    }
    if (r.isSelfTest) {
      nodes.bubble.appendChild(el('div', 'selftest-tag', '⚠️ 自检模式：这是 ffmpeg 合成的样例视频，不是真实 AI 生成结果。配置 API Key 或安装本地模型后可得到真实结果。'));
    }
    if (r.composed) {
      nodes.bubble.appendChild(el('div', 'selftest-tag', `多模型搭配：共 ${r.segments.length} 段，已拼接`));
    }
    if (r.concatFailed) {
      nodes.bubble.appendChild(el('div', 'selftest-tag', `各段已生成但自动拼接失败：${r.concatError}。已保留分段视频。`));
    }
    recordHistory(result);
  } else {
    nodes.progressFill.style.width = '0%';
    nodes.progressText.textContent = result.message || '生成失败';
    nodes.bubble.appendChild(el('div', 'selftest-tag', result.suggestion || result.message || '生成失败'));
  }
  updateTrackBadge();
}

function recordHistory(result) {
  state.history.unshift({
    at: new Date().toLocaleString(),
    prompt: (result.routing && result.routing.selected) || '',
    model: result.result && result.result.modelName,
    path: result.result && result.result.localPath,
    selfTest: !!(result.result && result.result.isSelfTest)
  });
  if (state.history.length > 100) state.history.pop();
}

/* ============ 图片附件 ============ */

function renderImagePreviews() {
  const row = $('#imagePreviewRow');
  row.innerHTML = '';
  state.attachedImages.forEach((p, i) => {
    const pv = el('div', 'pv');
    const im = document.createElement('img');
    im.src = fileUrl(p);
    const rm = el('button', 'rm', '×');
    rm.addEventListener('click', () => { state.attachedImages.splice(i, 1); renderImagePreviews(); });
    pv.appendChild(im); pv.appendChild(rm);
    row.appendChild(pv);
  });
}

/**
 * 选择图片（症状"＋图片拉不起文件夹"的修复点）
 *
 * 此前这里没有任何 try/catch：一旦 IPC 被拒（主进程 handler 未注册、或返回结构不符），
 * 就变成未处理的 Promise 拒绝 —— 用户点击后【完全没有任何反应，也没有报错】。
 * 现在：点击立即给视觉反馈，失败明确提示原因，成功兼容多种返回形状。
 */
$('#btnAddImage').addEventListener('click', async () => {
  const btn = $('#btnAddImage');
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = '打开中…';
  try {
    const r = await hxsk.pickImage();
    // 兼容三种可能的返回：字符串路径 / {paths:[...]} / null（用户取消）
    let picked = null;
    if (typeof r === 'string' && r) picked = [r];
    else if (r && Array.isArray(r.paths) && r.paths.length) picked = r.paths;
    else if (r && typeof r.path === 'string' && r.path) picked = [r.path];

    if (picked) {
      for (const p of picked) {
        if (!state.attachedImages.includes(p)) state.attachedImages.push(p);
      }
      renderImagePreviews();
      previewCurrentRoute();
      toast(`已添加 ${picked.length} 张图片`, 'ok');
    } else {
      toast('未选择图片（已取消）', '');
    }
  } catch (err) {
    const msg = (err && (err.message || err.error)) || String(err);
    toast('打开图片选择器失败：' + msg, 'err');
    showFatalBanner('⚠ 无法打开图片选择器', msg + '\n请把这段截图反馈以便修复。');
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
});

// 生成按钮：handleSend 内部已有 try/catch，这里再兜一层，确保任何意外都可见
$('#btnSend').addEventListener('click', async () => {
  try { await handleSend(); }
  catch (err) {
    toast('生成失败：' + ((err && (err.message || err.error)) || err), 'err');
    const b = $('#btnSend'); if (b) b.disabled = false;
  }
});
$('#promptInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    handleSend().catch(err => toast('生成失败：' + ((err && (err.message || err.error)) || err), 'err'));
  }
});

let previewTimer = null;
$('#promptInput').addEventListener('input', () => {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(previewCurrentRoute, 500);
});

async function previewCurrentRoute() {
  const prompt = $('#promptInput').value.trim();
  const hint = $('#routeHint');
  if (!prompt) { hint.textContent = '输入描述后可预览将使用哪个模型'; return; }
  try {
    const p = await hxsk.previewRoute({ prompt, offlineOnly: $('#chkOffline').checked, imagePath: state.attachedImages[0] });
    hint.textContent = p.selected ? `将使用：${p.selected.name}${p.selected.warning ? '（⚠️ ' + p.selected.warning.slice(0, 30) + '…）' : ''}` : '暂无可用模型，请先配置 Key 或安装本地模型';
  } catch { /* 忽略 */ }
}
$('#chkOffline').addEventListener('change', previewCurrentRoute);

/* ============ 任务进度事件 ============ */

/**
 * 受保护的事件订阅。
 * 教训：此前顶层直接写 hxsk.on(...)，一旦桥接未注入就抛 TypeError 中断整个脚本，
 * 导致其后所有按钮的监听器都绑不上 —— 表现为"所有按钮点了都没反应"。
 */
function safeOn(channel, handler) {
  try { hxsk.on(channel, handler); }
  catch (err) { initErrors.push(`订阅事件 ${channel}：${(err && (err.message || err.error)) || err}`); }
}

safeOn('task:progress', (payload) => {
  if (!payload) return;
  // 捕获新建任务的 id，使取消按钮在长任务期间可用
  if (payload.event === 'created' && payload.id) {
    state.currentTaskId = payload.id;
    $('#btnCancel').style.display = '';
    $('#btnCancel').disabled = false;
    return;
  }
  if (payload.status === 'running' && payload.message) {
    const nodes = lastTaskNodes();
    if (nodes) {
      if (typeof payload.progress === 'number') nodes.progressFill.style.width = payload.progress + '%';
      nodes.progressText.textContent = payload.message;
    }
  }
});
let _lastNodes = null;
function lastTaskNodes() { return _lastNodes; }

// 取消当前生成任务
$('#btnCancel').addEventListener('click', async () => {
  if (!state.currentTaskId) return;
  $('#btnCancel').disabled = true;
  $('#btnCancel').textContent = '取消中…';
  try { await hxsk.cancelGenerate(state.currentTaskId); toast('已请求取消', 'ok'); }
  catch (e) { toast('取消失败：' + (e.message || e), 'err'); }
});

/* ============ 本地模型 ============ */

async function renderLocalModels() {
  const body = $('#localBody');
  body.innerHTML = '';
  const hw = state.hardware || await hxsk.detectHardware();

  const intro = el('p', 'muted', '本地模型免密钥、完全离线、数据不出本机。首次使用需下载运行时与权重（约 9GB，需 ≥20GB 磁盘空闲）。受 8GB 显存限制，出片约 480p / 5 秒，单条数分钟，质量低于云端。');
  body.appendChild(intro);

  const hwLine = el('p', 'muted', `本机：${hw.gpu || '未探测到 GPU'} · 显存 ${hw.vramGB}GB · 内存 ${hw.totalRamGB}GB · 磁盘空闲 ${hw.diskFreeGB}GB`);
  body.appendChild(hwLine);

  // 本地轨道自检：不下载权重即可验证 Provider↔Python 链路，并如实报告 GPU 出片就绪状态
  const scCard = el('div', 'model-card selfcheck-card');
  const scTitle = el('h3', null, '本地推理自检');
  scCard.appendChild(scTitle);
  scCard.appendChild(el('div', 'meta', '无需下载权重即可验证本地推理链路是否通畅（用占位视频跑完整协议）。GPU 真实出片是否就绪会单独如实报告，不会伪造结果。'));
  const scActions = el('div', 'actions');
  const scBtn = el('button', 'primary-btn', '运行自检');
  const scOut = el('div', 'meta sc-out');
  scOut.style.marginTop = '10px';
  scBtn.addEventListener('click', async () => {
    scBtn.disabled = true;
    scBtn.textContent = '自检中…';
    scOut.textContent = '正在检查 Python 运行时、依赖、CUDA 与推理链路…';
    try {
      const r = await hxsk.runLocalSelfCheck();
      scOut.innerHTML = '';
      if (!r || r.ok === false) {
        scOut.appendChild(el('div', 'warn', '✗ ' + ((r && (r.summary || r.error)) || '自检失败')));
        for (const p of (r && r.problems) || []) scOut.appendChild(el('div', 'muted', '· ' + p));
      } else {
        const badge = el('div');
        badge.appendChild(el('span', r.dryRunOk ? 'kstate on' : 'kstate off', r.dryRunOk ? '✓ dry-run 链路通过' : '✗ dry-run 链路失败'));
        badge.appendChild(el('span', r.gpuReady ? 'kstate on' : 'kstate off', r.gpuReady ? '✓ GPU 出片就绪' : '· GPU 出片未就绪'));
        badge.style.display = 'flex';
        badge.style.gap = '14px';
        scOut.appendChild(badge);
        scOut.appendChild(el('div', 'muted', r.summary || ''));
        if (r.dryRun && r.dryRun.result && r.dryRun.result.localPath) {
          const vrow = el('div');
          vrow.style.marginTop = '8px';
          const v = document.createElement('video');
          v.src = fileUrl(r.dryRun.result.localPath);
          v.controls = true;
          v.style.maxWidth = '260px';
          vrow.appendChild(v);
          scOut.appendChild(vrow);
          scOut.appendChild(el('div', 'selftest-tag', '⚠️ 上方为自检占位视频（ffmpeg 合成），用于证明本地推理链路通畅，非真实 AI 生成结果。'));
        }
        for (const p of r.problems || []) scOut.appendChild(el('div', 'warn', '· ' + p));
        for (const w of r.warnings || []) scOut.appendChild(el('div', 'muted', '· 提示：' + w));
      }
    } catch (e) {
      scOut.innerHTML = '';
      scOut.appendChild(el('div', 'warn', '自检异常：' + (e.message || e)));
    } finally {
      scBtn.disabled = false;
      scBtn.textContent = '运行自检';
    }
  });
  scActions.appendChild(scBtn);
  scCard.appendChild(scActions);
  scCard.appendChild(scOut);
  body.appendChild(scCard);

  let models = [];
  try { models = await hxsk.listLocalModels(); }
  catch (e) { body.appendChild(el('p', 'warn', '加载本地模型清单失败：' + (e.message || e))); return; }

  for (const m of models) {
    const card = el('div', 'model-card');
    const h = el('h3');
    h.textContent = m.name;
    if (m.installed) h.appendChild(el('span', 'badge installed', '已安装'));
    card.appendChild(h);

    const meta = el('div', 'meta');
    meta.innerHTML = renderMarkdown(
      `显存需求 ${m.vramGB}GB · 内存需求 ${m.ramGB}GB · 下载约 ${m.downloadGB}GB\n许可 ${m.license}\n分辨率 ${m.resolution || '—'} · 最长 ${m.maxDurationSec || '—'} 秒\n${m.notes || ''}`
    );
    card.appendChild(meta);
    if (m.warning) card.appendChild(el('div', 'warn', '⚠️ ' + m.warning));

    // 硬件就绪评估：跑不动就直接说明原因，不给"下载"按钮误导用户
    if (m.readiness && !m.readiness.canInstall) {
      const rd = el('div', 'warn', '本机不满足：' + m.readiness.problems.join('；'));
      card.appendChild(rd);
    } else if (m.readiness && m.readiness.warnings && m.readiness.warnings.length) {
      card.appendChild(el('div', 'muted', '提示：' + m.readiness.warnings.join('；')));
    }

    const actions = el('div', 'actions');
    const progressText = el('span', 'muted', '');
    actions.appendChild(progressText);

    if (m.installed) {
      const useBtn = el('button', 'ghost-btn', '用它生成（离线）');
      useBtn.addEventListener('click', () => {
        switchView('chat');
        $('#chkOffline').checked = true;
        $('#promptInput').focus();
        previewCurrentRoute();
        toast('已切到离线模式，输入描述后生成将用本地模型', 'ok');
      });
      actions.appendChild(useBtn);
    } else {
      const btn = el('button', 'primary-btn', '下载并安装');
      const canInstall = !m.readiness || m.readiness.canInstall;
      if (!canInstall) { btn.disabled = true; btn.title = '本机硬件不满足，无法安装'; }
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = '安装中…';
        progressText.textContent = '正在准备安装…';
        // 订阅该模型的安装进度
        const off = hxsk.on('local:progress', (p) => {
          if (p.modelId !== m.id) return;
          progressText.textContent = `${p.phase === 'python' ? '运行时' : p.phase === 'pip' ? '依赖' : '权重'}：${p.message || ''}${p.percent != null ? ' ' + p.percent + '%' : ''}`;
        });
        try {
          const r = await hxsk.installLocalModel(m.id);
          if (r.ok) { toast(`${m.name} 安装完成`, 'ok'); renderLocalModels(); updateTrackBadge(); }
          else { toast('安装失败：' + (r.error || '未知原因'), 'err'); progressText.textContent = r.error || '安装失败'; }
        } catch (e) {
          toast('安装异常：' + (e.message || e), 'err');
          progressText.textContent = String(e.message || e);
        } finally {
          off();
          btn.disabled = false;
          btn.textContent = '下载并安装';
        }
      });
      actions.appendChild(btn);
    }
    card.appendChild(actions);
    body.appendChild(card);
  }
}

/** 切换到指定视图（供本地模型页跳转对话用） */
function switchView(name) {
  document.querySelectorAll('.nav-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.view === name);
  });
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  const target = $(`#view-${name}`);
  if (target) target.classList.add('active');
}

/* ============ 任务记录 ============ */

function renderTasks() {
  const body = $('#tasksBody');
  body.innerHTML = '';
  if (state.history.length === 0) { body.appendChild(el('p', 'muted', '暂无任务。')); return; }
  for (const h of state.history) {
    const card = el('div', 'model-card');
    card.innerHTML = `<h3>${escapeHtml(h.model || '未知模型')}${h.selfTest ? ' <span class="badge">自检</span>' : ''}</h3>`;
    const meta = el('div', 'meta', `${h.at}\n${h.path || ''}`);
    card.appendChild(meta);
    if (h.path) {
      const btn = el('button', 'ghost-btn', '在文件夹中显示');
      btn.style.marginTop = '8px';
      btn.addEventListener('click', guardClick('打开所在文件夹', () => hxsk.showItemInFolder(h.path)));
      card.appendChild(btn);
    }
    body.appendChild(card);
  }
}

/* ============ 设置 ============ */

async function renderSettings() {
  // 形状归一化：主进程 config:get 返回配置对象、secret:list 返回 {configured}、
  // secret:providers 返回数组。这里对每个都做容错，避免任一形状漂移就让整个设置页抛
  // "not iterable / cannot read property" 而白屏（此前 providers 直接 for...of 就崩过）。
  state.config = (await hxsk.getConfig().catch(() => null)) || {};
  const sec = (await hxsk.listSecrets().catch(() => null)) || {};
  state.secrets = sec.configured || {};
  $('#cfgWorkspace').value = state.config.workspaceId || '';
  $('#cfgMirrors').value = (Array.isArray(state.config.extraMirrors) ? state.config.extraMirrors : []).join('\n');
  $('#cfgAutoUpdate').checked = state.config.autoCheckUpdate !== false;

  let providersRaw = null;
  try { providersRaw = await hxsk.listProviders(); }
  catch (e) { providersRaw = null; }
  // 兼容 数组 / {providers:[]} / {ok,providers} 三种形状，最终一定得到数组
  const providers = Array.isArray(providersRaw)
    ? providersRaw
    : (providersRaw && Array.isArray(providersRaw.providers) ? providersRaw.providers : []);

  const body = $('#keysBody');
  body.innerHTML = '';

  const REGION_HINT = {
    cn: { text: '国内可达', cls: 'on' },
    overseas: { text: '海外·本机实测不可达', cls: 'off' },
    unknown: { text: '可达性未知', cls: 'off' }
  };

  for (const p of providers) {
    const wrap = el('div', 'key-block');

    // 第一行：名称 + 状态 + 可达性徽标
    const row = el('div', 'key-row');
    const nameBox = el('div', 'kname');
    nameBox.textContent = p.label;
    row.appendChild(nameBox);
    row.appendChild(el('span', 'kstate ' + (p.configured ? 'on' : 'off'), p.configured ? '已配置' : '未配置'));
    const region = REGION_HINT[p.reachableRegion] || REGION_HINT.unknown;
    row.appendChild(el('span', 'kstate ' + region.cls, region.text));

    const input = document.createElement('input');
    input.type = 'password';
    input.placeholder = p.configured ? '已保存（留空则不修改）' : `粘贴 ${p.keyName || 'API Key'}`;
    row.appendChild(input);

    const saveBtn = el('button', 'ghost-btn', '保存');
    saveBtn.addEventListener('click', async () => {
      const v = input.value.trim();
      if (!v) { toast('未输入密钥', 'err'); return; }
      try { await hxsk.setSecret(p.kind, v); input.value = ''; toast(`${p.label} 密钥已加密保存`, 'ok'); renderSettings(); updateTrackBadge(); }
      catch (e) { toast('保存失败：' + (e.message || e), 'err'); }
    });
    row.appendChild(saveBtn);

    if (p.configured) {
      const clearBtn = el('button', 'ghost-btn', '清除');
      clearBtn.addEventListener('click', guardClick('清除密钥', async () => {
        await hxsk.clearSecret(p.kind); toast('已清除', 'ok'); renderSettings(); updateTrackBadge();
      }));
      row.appendChild(clearBtn);
    }
    wrap.appendChild(row);

    // 第二行：申请引导（去哪弄 Key + 免费额度 + 说明）
    const guide = el('div', 'key-guide');
    if (p.applyUrl) {
      const link = el('a', 'key-link', p.linkVerified ? '→ 去哪申请 Key' : '→ 打开官网申请');
      link.href = '#';
      link.title = p.linkVerified ? p.applyUrl : (p.applyUrl + '（链接未逐一核实，登录后自行找 API Key / Tokens 入口）');
      link.addEventListener('click', (e) => {
        e.preventDefault();
        guardClick('打开申请页', () => hxsk.openKeyPage(p.kind))(e);
      });
      guide.appendChild(link);
    }
    if (p.freeQuota) guide.appendChild(el('span', 'guide-note', '额度：' + p.freeQuota));
    if (p.note) guide.appendChild(el('span', 'guide-note muted', p.note));
    wrap.appendChild(guide);

    body.appendChild(wrap);
  }
}

$('#btnSaveConfig').addEventListener('click', guardClick('保存设置', async () => {
  const patch = {
    workspaceId: $('#cfgWorkspace').value.trim(),
    extraMirrors: $('#cfgMirrors').value.split('\n').map(s => s.trim()).filter(Boolean),
    autoCheckUpdate: $('#cfgAutoUpdate').checked
  };
  await hxsk.setConfig(patch);
  toast('设置已保存', 'ok');
}));

/* ============ 更新 ============ */

$('#btnCheckUpdate').addEventListener('click', async () => {
  const overlay = $('#updateOverlay');
  const body = $('#updateBody');
  const btn = $('#btnCheckUpdate');
  $('#updateTitle').textContent = '检测更新';
  body.innerHTML = '';
  overlay.classList.remove('hidden');
  body.appendChild(el('div', '', '正在并行探测多个更新通道…'));
  btn.disabled = true;

  try {
    const r = await hxsk.checkUpdate({ downloadIfNew: false });
    body.innerHTML = '';
    if (r && r.channelSummary) body.appendChild(el('div', 'muted', r.channelSummary));
    if (r && r.ok && !r.needUpdate) {
      body.appendChild(el('div', 'ch-ok', `✓ ${r.message}`));
    } else if (r && r.ok && r.needUpdate) {
      body.appendChild(el('div', '', `发现新版本 ${r.latest}（当前 ${r.current}）`));
      const dlBtn = el('button', 'primary-btn', '下载并安装');
      dlBtn.style.marginTop = '12px';
      dlBtn.addEventListener('click', guardClick('下载更新', () => doDownloadInstall(body)));
      body.appendChild(dlBtn);
    } else {
      body.appendChild(el('div', 'ch-bad', `✗ ${(r && r.message) || '检测更新失败'}`));
      if (r && r.detail) body.appendChild(el('div', 'muted', r.detail));
      const manualBtn = el('button', 'ghost-btn', '打开下载页面');
      manualBtn.style.marginTop = '12px';
      manualBtn.addEventListener('click', guardClick('打开下载页面', () => hxsk.openManualUpdate()));
      body.appendChild(manualBtn);
    }
  } catch (err) {
    // 关键：检测更新失败也必须在浮层里说清原因，不能只留一句 toast 或什么都不显示
    const msg = (err && (err.message || err.error)) || String(err);
    body.innerHTML = '';
    body.appendChild(el('div', 'ch-bad', '✗ 检测更新失败'));
    body.appendChild(el('div', 'muted', msg));
    const manualBtn = el('button', 'ghost-btn', '打开下载页面');
    manualBtn.style.marginTop = '12px';
    manualBtn.addEventListener('click', guardClick('打开下载页面', () => hxsk.openManualUpdate()));
    body.appendChild(manualBtn);
    toast('检测更新失败：' + msg, 'err');
  } finally {
    btn.disabled = false;
  }
});

async function doDownloadInstall(body) {
  body.innerHTML = '';
  body.appendChild(el('div', '', '正在多通道并行下载并校验…'));
  let dl;
  try {
    dl = await hxsk.downloadUpdate();
  } catch (err) {
    const msg = (err && (err.message || err.error)) || String(err);
    body.innerHTML = '';
    body.appendChild(el('div', 'ch-bad', '✗ 下载失败'));
    body.appendChild(el('div', 'muted', msg));
    return;
  }
  body.innerHTML = '';
  if (dl && dl.ok) {
    body.appendChild(el('div', 'ch-ok', `✓ ${dl.message}`));
    body.appendChild(el('div', 'muted', `SHA512 校验：${dl.sha512Verified ? '已通过' : '未提供校验值（仅校验大小）'}\n清单 Ed25519 验签：${dl.manifestSigned ? '已通过' : '未提供签名'}\n下载通道：${dl.winnerChannel || '—'}\n大小：${(dl.bytes / 1024 / 1024).toFixed(1)} MB`));
    const insBtn = el('button', 'primary-btn', '立即安装（应用将退出）');
    insBtn.style.marginTop = '12px';
    insBtn.addEventListener('click', guardClick('安装更新', async () => { await hxsk.installUpdate(); }));
    body.appendChild(insBtn);
  } else {
    body.appendChild(el('div', 'ch-bad', `✗ ${(dl && dl.message) || '下载失败'}`));
    if (dl && dl.detail) body.appendChild(el('div', 'muted', dl.detail));
    if (dl && dl.manualUrl) {
      const b = el('button', 'ghost-btn', '打开下载页面');
      b.style.marginTop = '12px';
      b.addEventListener('click', guardClick('打开下载页面', () => hxsk.openManualUpdate()));
      body.appendChild(b);
    }
  }
}

$('#updateClose').addEventListener('click', () => $('#updateOverlay').classList.add('hidden'));

safeOn('update:state', (s) => {
  if (s && s.phase === 'downloading' && typeof s.percent === 'number') {
    const body = $('#updateBody');
    if (body && $('#updateOverlay') && !$('#updateOverlay').classList.contains('hidden')) {
      body.innerHTML = '';
      body.appendChild(el('div', '', s.message || `下载中 ${s.percent}%`));
      const bar = el('div', 'progress-bar');
      const fill = el('div', 'progress-fill');
      fill.style.width = s.percent + '%';
      bar.appendChild(fill);
      body.appendChild(bar);
    }
  }
});

safeOn('update:rollback', (rb) => {
  if (rb && rb.needed) toast(rb.message, 'err');
});

/* ============ 轨道徽标 ============ */

function updateTrackBadge() {
  const badge = $('#trackBadge');
  const anyKey = Object.values(state.secrets || {}).some(Boolean);
  if (anyKey) { badge.textContent = '云端就绪'; badge.className = 'track-badge cloud'; }
  else { badge.textContent = '自检模式'; badge.className = 'track-badge'; }
}

/* ============ 诊断（本机自曝故障，不靠外部工具）============
 *
 * 为什么需要：界面按钮"点了没反应"往往源于某个 IPC 被拒或桥接未注入，
 * 但用户看不到底层错误。这里逐个调用每个桥接方法，把结果/错误直接呈现出来，
 * 用户点一下「运行自检」就能拿到确切原因并反馈，无需开发者远程猜测。
 */

const DIAG_CASES = [
  { name: '应用信息 app:info', fn: () => hxsk.getAppInfo() },
  { name: '模型能力库 catalog:get', fn: () => hxsk.getCatalog() },
  { name: '硬件探测 hardware:detect', fn: () => hxsk.detectHardware(true) },
  { name: '配置读取 config:get', fn: () => hxsk.getConfig() },
  { name: '密钥状态 secret:list', fn: () => hxsk.listSecrets() },
  { name: '通道引导 secret:providers', fn: () => hxsk.listProviders() },
  { name: '本地模型 local:list', fn: () => hxsk.listLocalModels() },
  { name: '路由预演 route:preview', fn: () => hxsk.previewRoute({ prompt: '自检：一只猫在草地上奔跑' }) },
  { name: '更新检测 update:check', fn: () => hxsk.checkUpdate({ downloadIfNew: false }) },
  { name: '输出目录 shell:showOutputDir', fn: () => hxsk.showOutputDir() }
];

let lastDiagText = '';

async function runDiag() {
  const body = $('#diagBody');
  body.innerHTML = '';
  const lines = [];
  const bridgeOk = Boolean(window.hxsk && window.hxsk !== hxsk ? false : hxsk && hxsk.getAppInfo);
  lines.push(`桥接对象 window.hxsk：${window.hxsk ? '已注入' : '缺失（preload 未加载）'}`);
  lines.push('');

  let pass = 0, fail = 0;
  for (const c of DIAG_CASES) {
    const row = el('div', 'diag-row');
    const t0 = Date.now();
    let ok = false, detail = '';
    try {
      const r = await Promise.race([
        c.fn(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('超时(10s) 未返回')), 10000))
      ]);
      ok = true;
      detail = typeof r === 'object' ? JSON.stringify(r).slice(0, 120) : String(r).slice(0, 120);
      pass++;
    } catch (err) {
      ok = false;
      detail = String((err && (err.message || err.error)) || err).slice(0, 200);
      fail++;
    }
    const ms = Date.now() - t0;
    row.appendChild(el('span', ok ? 'diag-ok' : 'diag-bad', ok ? '✓' : '✗'));
    row.appendChild(el('span', 'diag-name', c.name));
    row.appendChild(el('span', 'diag-ms', ms + 'ms'));
    row.appendChild(el('span', 'diag-detail ' + (ok ? 'muted' : 'diag-err'), detail));
    body.appendChild(row);
    lines.push(`${ok ? '✓' : '✗'} ${c.name} (${ms}ms) ${detail}`);
  }

  const summary = el('div', 'diag-summary ' + (fail === 0 ? 'ch-ok' : 'ch-bad'),
    `\n小结：${pass} 项通过，${fail} 项失败。${bridgeOk ? '' : '【桥接缺失，所有功能不可用】'}`);
  body.appendChild(summary);
  lines.push('');
  lines.push(`小结：${pass} 通过 / ${fail} 失败`);

  // 附环境信息，便于定位
  let env = '';
  try {
    const info = await hxsk.getAppInfo();
    env = `版本 ${info.version} | Electron ${info.electron} | ${info.platform}`;
  } catch (e) { env = '版本信息读取失败'; }
  lines.unshift('=== 幻想时刻 界面自检 ===');
  lines.splice(1, 0, env);
  lastDiagText = lines.join('\n');
}

function renderDiag() {
  const body = $('#diagBody');
  if (!body) return;
  if (body.children.length === 0) {
    body.appendChild(el('p', 'muted', '尚未运行。点右上角「运行自检」。'));
  }
}

$('#btnRunDiag').addEventListener('click', guardClick('运行自检', async () => {
  $('#btnRunDiag').disabled = true;
  $('#btnRunDiag').textContent = '检测中…';
  try { await runDiag(); }
  finally { $('#btnRunDiag').disabled = false; $('#btnRunDiag').textContent = '运行自检'; }
}));

$('#btnCopyDiag').addEventListener('click', guardClick('复制结果', async () => {
  if (!lastDiagText) { toast('请先运行自检', 'err'); return; }
  try {
    await navigator.clipboard.writeText(lastDiagText);
    toast('已复制，请粘贴反馈', 'ok');
  } catch (e) {
    // 剪贴板不可用时，把结果直接显示出来供手动复制
    const body = $('#diagBody');
    const pre = document.createElement('pre');
    pre.className = 'diag-raw';
    pre.textContent = lastDiagText;
    body.appendChild(pre);
    toast('剪贴板不可用，已在下方显示结果', 'err');
  }
}));

/* ============ 初始化 ============ */

/**
 * 逐步隔离错误：此前 4 个 await 串成一条链，任一 IPC 失败就会让整个 init 中断，
 * 导致硬件信息、轨道徽标、欢迎消息全部不显示 —— 用户看到的是一个"死"界面。
 * 现在每步独立容错，单项失败只影响该项，并把失败如实显示出来。
 */
async function safeStep(name, fn, fallback) {
  try {
    return await fn();
  } catch (err) {
    initErrors.push(`${name}：${(err && (err.message || err.error)) || err}`);
    return fallback;
  }
}

async function init() {
  state.appInfo = await safeStep('读取应用信息', () => hxsk.getAppInfo(), {});
  const ver = $('#aboutVersion');
  if (ver) {
    ver.textContent = state.appInfo.displayVersion
      ? `${state.appInfo.displayVersion}（${state.appInfo.version}）`
      : '未知（应用信息读取失败）';
  }

  state.catalog = await safeStep('加载模型能力库', () => hxsk.getCatalog(), { models: [], intents: [], schemaVersion: '?' });
  state.config = await safeStep('读取配置', () => hxsk.getConfig(), {});
  const secrets = await safeStep('读取密钥状态', () => hxsk.listSecrets(), { configured: {} });
  state.secrets = (secrets && secrets.configured) || {};

  // 硬件（后台探测，不阻塞）
  hxsk.detectHardware().then(hw => {
    state.hardware = hw || {};
    const s = $('#hwSummary');
    if (s) {
      s.textContent = `${hw.gpu || '无 GPU'}\n显存 ${hw.vramGB}GB · 内存 ${hw.totalRamGB}GB`;
      if (hw.vramWarning) s.title = hw.vramWarning;
    }
  }).catch(() => { const s = $('#hwSummary'); if (s) s.textContent = '硬件探测失败'; });
  try {
    hxsk.on('hardware:ready', (hw) => {
      state.hardware = hw || {};
      const s = $('#hwSummary');
      if (s) s.textContent = `${hw.gpu || '无 GPU'}\n显存 ${hw.vramGB}GB · 内存 ${hw.totalRamGB}GB`;
    });
  } catch (err) { initErrors.push('订阅硬件事件：' + ((err && err.message) || err)); }

  updateTrackBadge();

  // 关于页详情
  const detail = $('#aboutDetail');
  if (detail) {
    detail.innerHTML = '';
    const mk = (k, v) => { const d = el('div'); d.textContent = `${k}：${v}`; detail.appendChild(d); };
    mk('FFmpeg', state.appInfo.ffmpeg || '未找到');
    mk('数据目录', state.appInfo.userData || '未知');
    mk('输出目录', state.appInfo.outputDir || '未知');
    mk('模型库版本', 'schemaVersion ' + state.catalog.schemaVersion);
    mk('可用模型', (state.catalog.models || []).length + ' 个');
  }

  // 欢迎消息
  addMessage('assistant', '你好，我是**幻想时刻**。上传一张图片、写一段描述，我就能帮你生成视频。\n\n没有 API Key 也没关系——我会用「自检模式」先跑通全流程（产出的是带水印的样例视频，非真实 AI 结果）。想要真实生成，请到「设置」配置云端 API Key，或在「本地模型」页下载离线模型包。', { markdown: true });

  // 初始化过程中有步骤失败时，如实告知用户（而不是假装一切正常）
  if (initErrors.length) {
    addMessage('assistant',
      `⚠ 部分功能初始化失败，以下能力可能不可用：\n\n${initErrors.map(e => '- ' + e).join('\n')}\n\n` +
      `其余功能仍可正常使用。请把这段信息截图反馈以便修复。`, { markdown: true });
  }

  // 启动自动检查更新
  if (state.config.autoCheckUpdate) {
    setTimeout(async () => {
      try {
        const r = await hxsk.checkUpdate({ downloadIfNew: false });
        if (r.ok && r.needUpdate) toast(`发现新版本 ${r.latest}，点击右上角「检测更新」升级`, 'ok');
      } catch { /* 自动检查失败不打扰用户，手动检测时再报错 */ }
    }, 2500);
  }
}

init().catch(err => {
  // init 自身整体失败也必须可见（此前只有这里能提示，但顶层裸调用会让它根本执行不到）
  addMessage('assistant', '⚠ 初始化失败：' + ((err && (err.message || err.error)) || err) + '\n\n界面可能无法正常工作，请把这段信息截图反馈。', {});
  showFatalBanner('⚠ 初始化失败', String((err && (err.message || err.error)) || err));
});
