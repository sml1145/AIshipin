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
      btn.addEventListener('click', () => hxsk.showItemInFolder(h.path));
      card.appendChild(btn);
    }
    body.appendChild(card);
  }
}

/* ============ 设置 ============ */

async function renderSettings() {
  state.config = await hxsk.getConfig();
  state.secrets = (await hxsk.listSecrets()).configured || {};
  $('#cfgWorkspace').value = state.config.workspaceId || '';
  $('#cfgMirrors').value = (state.config.extraMirrors || []).join('\n');
  $('#cfgAutoUpdate').checked = state.config.autoCheckUpdate !== false;

  let providers = [];
  try { providers = await hxsk.listProviders(); }
  catch (e) { providers = []; }

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
      clearBtn.addEventListener('click', async () => {
        await hxsk.clearSecret(p.kind); toast('已清除', 'ok'); renderSettings(); updateTrackBadge();
      });
      row.appendChild(clearBtn);
    }
    wrap.appendChild(row);

    // 第二行：申请引导（去哪弄 Key + 免费额度 + 说明）
    const guide = el('div', 'key-guide');
    if (p.applyUrl) {
      const link = el('a', 'key-link', p.linkVerified ? '→ 去哪申请 Key' : '→ 打开官网申请');
      link.href = '#';
      link.title = p.linkVerified ? p.applyUrl : (p.applyUrl + '（链接未逐一核实，登录后自行找 API Key / Tokens 入口）');
      link.addEventListener('click', (e) => { e.preventDefault(); hxsk.openKeyPage(p.kind); });
      guide.appendChild(link);
    }
    if (p.freeQuota) guide.appendChild(el('span', 'guide-note', '额度：' + p.freeQuota));
    if (p.note) guide.appendChild(el('span', 'guide-note muted', p.note));
    wrap.appendChild(guide);

    body.appendChild(wrap);
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
