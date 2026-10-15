'use strict';

/**
 * 渲染进程逻辑
 *
 * 安全要点：
 *   - 所有文本一律先转义再插入 DOM，绝不用 innerHTML 直接塞用户/模型内容（防 XSS）
 *   - 只通过 window.hxsk（preload 白名单）访问能力，不碰 require/fs
 *   - 图片只显示主进程回传的本地路径（file://），不读取文件内容到渲染层
 */

const hxsk = window.hxsk;

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

/* ============ 全局状态 ============ */

const state = {
  appInfo: null,
  catalog: null,
  hardware: null,
  secrets: {},
  config: {},
  attachedImages: [],   // 本地图片绝对路径
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
      openBtn.addEventListener('click', () => hxsk.showItemInFolder(r.localPath));
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

$('#btnAddImage').addEventListener('click', async () => {
  const p = await hxsk.pickImage();
  if (p) { state.attachedImages.push(p); renderImagePreviews(); previewCurrentRoute(); }
});

$('#btnSend').addEventListener('click', handleSend);
$('#promptInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
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

hxsk.on('task:progress', (payload) => {
  // 简化：进度事件用于未来多任务并发；当前单任务已在 finishTask 收口
  if (payload && payload.status === 'running' && payload.message) {
    // 找到最后一条助手消息的进度文本更新
    const nodes = lastTaskNodes();
    if (nodes) {
      if (typeof payload.progress === 'number') nodes.progressFill.style.width = payload.progress + '%';
      nodes.progressText.textContent = payload.message;
    }
  }
});
let _lastNodes = null;
function lastTaskNodes() { return _lastNodes; }

/* ============ 本地模型 ============ */

async function renderLocalModels() {
  const body = $('#localBody');
  body.innerHTML = '';
  const cat = state.catalog || await hxsk.getCatalog();
  const hw = state.hardware || await hxsk.detectHardware();
  const localModels = cat.models.filter(m => m.track === 'local');

  const intro = el('p', 'muted', '本地模型免密钥、完全离线、数据不出本机。首次使用需下载运行时与权重（约 9GB，需 ≥20GB 磁盘空闲）。受 8GB 显存限制，出片约 480p / 5 秒，单条数分钟，质量低于云端。');
  body.appendChild(intro);

  const hwLine = el('p', 'muted', `本机：${hw.gpu || '未探测到 GPU'} · 显存 ${hw.vramGB}GB · 内存 ${hw.totalRamGB}GB · 磁盘空闲 ${hw.diskFreeGB}GB`);
  body.appendChild(hwLine);

  for (const m of localModels) {
    const card = el('div', 'model-card');
    const h = el('h3');
    h.textContent = m.name;
    const installed = false; // 由主进程 listInstalledLocalModels 判断，这里展示元信息
    card.appendChild(h);
    const meta = el('div', 'meta');
    meta.innerHTML = renderMarkdown(
      `显存需求 ${m.vramGB}GB · 内存需求 ${m.ramGB}GB · 下载约 ${m.downloadGB}GB\n许可 ${m.license}\n${m.notes || ''}`
    );
    card.appendChild(meta);
    if (m.warning) card.appendChild(el('div', 'warn', '⚠️ ' + m.warning));
    const actions = el('div', 'actions');
    const btn = el('button', 'primary-btn', '下载并安装');
    btn.addEventListener('click', () => toast('本地模型下载将在 v1.0 后续构建接入（当前版本可先用云端或自检模式）', 'err'));
    actions.appendChild(btn);
    card.appendChild(actions);
    body.appendChild(card);
  }
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
      btn.addEventListener('click', () => hxsk.showItemInFolder(h.path));
      card.appendChild(btn);
    }
    body.appendChild(card);
  }
}

/* ============ 设置 ============ */

const SECRET_LABELS = {
  dashscope: '阿里云百炼', siliconflow: 'SiliconFlow', modelscope: 'ModelScope',
  huggingface: 'Hugging Face', replicate: 'Replicate', fal: 'fal.ai'
};

async function renderSettings() {
  state.config = await hxsk.getConfig();
  state.secrets = (await hxsk.listSecrets()).configured || {};
  $('#cfgWorkspace').value = state.config.workspaceId || '';
  $('#cfgMirrors').value = (state.config.extraMirrors || []).join('\n');
  $('#cfgAutoUpdate').checked = state.config.autoCheckUpdate !== false;

  const body = $('#keysBody');
  body.innerHTML = '';
  for (const kind of Object.keys(SECRET_LABELS)) {
    const row = el('div', 'key-row');
    row.appendChild(el('div', 'kname', SECRET_LABELS[kind]));
    const stateEl = el('span', 'kstate ' + (state.secrets[kind] ? 'on' : 'off'), state.secrets[kind] ? '已配置' : '未配置');
    row.appendChild(stateEl);
    const input = document.createElement('input');
    input.type = 'password';
    input.placeholder = state.secrets[kind] ? '已保存（留空则不修改）' : '粘贴 API Key';
    row.appendChild(input);
    const saveBtn = el('button', 'ghost-btn', '保存');
    saveBtn.addEventListener('click', async () => {
      const v = input.value.trim();
      if (!v) { toast('未输入密钥', 'err'); return; }
      try { await hxsk.setSecret(kind, v); input.value = ''; toast(`${SECRET_LABELS[kind]} 密钥已加密保存`, 'ok'); renderSettings(); updateTrackBadge(); }
      catch (e) { toast('保存失败：' + (e.message || e), 'err'); }
    });
    row.appendChild(saveBtn);
    if (state.secrets[kind]) {
      const clearBtn = el('button', 'ghost-btn', '清除');
      clearBtn.addEventListener('click', async () => {
        await hxsk.clearSecret(kind); toast('已清除', 'ok'); renderSettings(); updateTrackBadge();
      });
      row.appendChild(clearBtn);
    }
    body.appendChild(row);
  }
}

$('#btnSaveConfig').addEventListener('click', async () => {
  const patch = {
    workspaceId: $('#cfgWorkspace').value.trim(),
    extraMirrors: $('#cfgMirrors').value.split('\n').map(s => s.trim()).filter(Boolean),
    autoCheckUpdate: $('#cfgAutoUpdate').checked
  };
  await hxsk.setConfig(patch);
  toast('设置已保存', 'ok');
});

/* ============ 更新 ============ */

$('#btnCheckUpdate').addEventListener('click', async () => {
  const overlay = $('#updateOverlay');
  const body = $('#updateBody');
  $('#updateTitle').textContent = '检测更新';
  body.innerHTML = '';
  overlay.classList.remove('hidden');
  body.appendChild(el('div', '', '正在并行探测多个更新通道…'));

  const r = await hxsk.checkUpdate({ downloadIfNew: false });
  body.innerHTML = '';
  if (r.channelSummary) body.appendChild(el('div', 'muted', r.channelSummary));
  if (r.ok && !r.needUpdate) {
    body.appendChild(el('div', 'ch-ok', `✓ ${r.message}`));
  } else if (r.ok && r.needUpdate) {
    body.appendChild(el('div', '', `发现新版本 ${r.latest}（当前 ${r.current}）`));
    const dlBtn = el('button', 'primary-btn', '下载并安装');
    dlBtn.style.marginTop = '12px';
    dlBtn.addEventListener('click', () => doDownloadInstall(body));
    body.appendChild(dlBtn);
  } else {
    body.appendChild(el('div', 'ch-bad', `✗ ${r.message}`));
    if (r.detail) body.appendChild(el('div', 'muted', r.detail));
    const manualBtn = el('button', 'ghost-btn', '打开下载页面');
    manualBtn.style.marginTop = '12px';
    manualBtn.addEventListener('click', () => hxsk.openManualUpdate());
    body.appendChild(manualBtn);
  }
});

async function doDownloadInstall(body) {
  body.innerHTML = '';
  body.appendChild(el('div', '', '正在多通道并行下载并校验…'));
  const dl = await hxsk.downloadUpdate();
  body.innerHTML = '';
  if (dl.ok) {
    body.appendChild(el('div', 'ch-ok', `✓ ${dl.message}`));
    body.appendChild(el('div', 'muted', `SHA512 校验：${dl.sha512Verified ? '已通过' : '未提供校验值（仅校验大小）'}\n下载通道：${dl.winnerChannel || '—'}\n大小：${(dl.bytes / 1024 / 1024).toFixed(1)} MB`));
    const insBtn = el('button', 'primary-btn', '立即安装（应用将退出）');
    insBtn.style.marginTop = '12px';
    insBtn.addEventListener('click', async () => { await hxsk.installUpdate(); });
    body.appendChild(insBtn);
  } else {
    body.appendChild(el('div', 'ch-bad', `✗ ${dl.message}`));
    if (dl.detail) body.appendChild(el('div', 'muted', dl.detail));
    if (dl.manualUrl) {
      const b = el('button', 'ghost-btn', '打开下载页面');
      b.style.marginTop = '12px';
      b.addEventListener('click', () => hxsk.openManualUpdate());
      body.appendChild(b);
    }
  }
}

$('#updateClose').addEventListener('click', () => $('#updateOverlay').classList.add('hidden'));

hxsk.on('update:state', (s) => {
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

hxsk.on('update:rollback', (rb) => {
  if (rb && rb.needed) toast(rb.message, 'err');
});

/* ============ 轨道徽标 ============ */

function updateTrackBadge() {
  const badge = $('#trackBadge');
  const anyKey = Object.values(state.secrets || {}).some(Boolean);
  if (anyKey) { badge.textContent = '云端就绪'; badge.className = 'track-badge cloud'; }
  else { badge.textContent = '自检模式'; badge.className = 'track-badge'; }
}

/* ============ 初始化 ============ */

async function init() {
  state.appInfo = await hxsk.getAppInfo();
  $('#aboutVersion').textContent = `${state.appInfo.displayVersion}（${state.appInfo.version}）`;
  state.catalog = await hxsk.getCatalog();
  state.config = await hxsk.getConfig();
  state.secrets = (await hxsk.listSecrets()).configured || {};

  // 硬件
  hxsk.detectHardware().then(hw => {
    state.hardware = hw;
    $('#hwSummary').textContent = `${hw.gpu || '无 GPU'}\n显存 ${hw.vramGB}GB · 内存 ${hw.totalRamGB}GB`;
    if (hw.vramWarning) $('#hwSummary').title = hw.vramWarning;
  }).catch(() => { $('#hwSummary').textContent = '硬件探测失败'; });
  hxsk.on('hardware:ready', (hw) => {
    state.hardware = hw;
    $('#hwSummary').textContent = `${hw.gpu || '无 GPU'}\n显存 ${hw.vramGB}GB · 内存 ${hw.totalRamGB}GB`;
  });

  updateTrackBadge();

  // 关于页详情
  const detail = $('#aboutDetail');
  detail.innerHTML = '';
  const mk = (k, v) => { const d = el('div'); d.textContent = `${k}：${v}`; detail.appendChild(d); };
  mk('FFmpeg', state.appInfo.ffmpeg || '未找到');
  mk('数据目录', state.appInfo.userData);
  mk('输出目录', state.appInfo.outputDir);
  mk('模型库版本', 'schemaVersion ' + state.catalog.schemaVersion);
  mk('可用模型', state.catalog.models.length + ' 个');

  // 欢迎消息
  addMessage('assistant', '你好，我是**幻想时刻**。上传一张图片、写一段描述，我就能帮你生成视频。\n\n没有 API Key 也没关系——我会用「自检模式」先跑通全流程（产出的是带水印的样例视频，非真实 AI 结果）。想要真实生成，请到「设置」配置云端 API Key，或在「本地模型」页下载离线模型包。', { markdown: true });

  // 启动自动检查更新
  if (state.config.autoCheckUpdate) {
    setTimeout(async () => {
      try {
        const r = await hxsk.checkUpdate({ downloadIfNew: false });
        if (r.ok && r.needUpdate) toast(`发现新版本 ${r.latest}，点击右上角「检测更新」升级`, 'ok');
      } catch { /* 静默 */ }
    }, 2500);
  }
}

init().catch(err => {
  addMessage('assistant', '初始化失败：' + (err.message || err), {});
});
