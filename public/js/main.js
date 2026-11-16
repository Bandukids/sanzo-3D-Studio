import { initShell } from './shell.js';
import { createLibrary } from './library.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const state = {
  mode: 'text', model: 'hy-3d-3.1', models: [], motions: [], tripoPresets: [],
  hasKey: false, imageBase64: '', current: null, tasks: [],
};
let viewer = null;
let pollTimer = 0;
let tickTimer = 0;
let viewerPromise, heroPromise, shell, library;
let loadedTaskId = null, presentationVersion = 0, cachedInfo = null;
let toastTimer;
function toast(text) {
  clearTimeout(toastTimer);
  $('#toast').textContent = text; $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4200);
}
function ensureViewer() {
  if (!viewerPromise) viewerPromise = import('./viewer.js').then(({Viewer}) => {
    viewer = new Viewer($('#viewer'));
    const rotate = viewer.controls.autoRotate;
    $('#tRotate').classList.toggle('is-on', rotate);
    $('#tRotate').setAttribute('aria-pressed', String(rotate));
    return viewer;
  }).catch(e => { viewerPromise = null; toast(`预览器未能加载：${e.message}`); });
  return viewerPromise;
}

// ---------- 基础 ----------
async function api(path, options) {
  const res = await fetch(path, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `请求失败（${res.status}）`);
  return body;
}
const post = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const fmtTime = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const fmtSize = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const isActive = (t) => Boolean(t && !['done', 'failed'].includes(t.status));
const byId = (id) => state.tasks.find((t) => t.id === id) || null;
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
function setMsg(text, err = false) {
  const m = $('#formMsg');
  m.textContent = text;
  m.classList.toggle('err', err);
}
const KIND = { model: '模型', rig: '绑骨', animate: '动画', motion: '动作' };

// ---------- 3D ----------
function ensureHero() {
  if (!heroPromise) heroPromise = import('./hero.js').then(({initHero}) => initHero($('#heroCanvas'), $('#hero'))).catch(e => console.warn('Hero 3D 初始化失败', e));
}

// ---------- 导航 / 入场动效 ----------
addEventListener('scroll', () => $('#nav').classList.toggle('is-stuck', scrollY > 30), { passive: true });
const revealer = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); revealer.unobserve(e.target); }
}, { threshold: 0.08 });
const reveal = (nodes) => nodes.forEach((n, i) => {
  n.classList.add('reveal');
  n.style.transitionDelay = `${(i % 4) * 90}ms`;
  revealer.observe(n);
});
reveal($$('#homePage .section-head, #homePage .step, #homePage .cta > *'));

// ---------- 绑骨控件（左侧「模型绑骨」与右侧管线共用） ----------
function rigControls() {
  const box = el('div', 'rig-controls');
  let engine = 'hunyuan';
  const seg = el('div', 'seg');
  const motionRow = el('label', 'select-row');
  const select = el('select');
  select.append(new Option('仅绑骨，不加动作', ''));
  for (const m of state.motions) select.append(new Option(`${String(m.id).padStart(2, '0')} · ${m.label}`, m.id));
  motionRow.append(el('span', null, '动作模板'), select);
  const note = el('p', 'pipe-note');
  const paint = () => {
    for (const b of seg.children) b.classList.toggle('is-active', b.dataset.engine === engine);
    motionRow.hidden = engine !== 'hunyuan';
    note.textContent = engine === 'hunyuan'
      ? '混元：绑骨时可同时套用一个人形动作模板（需 A / T Pose 的人形角色，模型 ≤ 60 MB）。输出 FBX。'
      : 'Tripo：先绑骨，完成后再从预设里选动画。支持更多输入格式（≤ 150 MB）。';
  };
  for (const [id, label] of [['hunyuan', '混元绑骨'], ['tripo', 'Tripo 绑骨']]) {
    const b = el('button', null, label);
    b.type = 'button';
    b.dataset.engine = id;
    b.addEventListener('click', () => { engine = id; paint(); });
    seg.append(b);
  }
  const row = el('div', 'pipe-row');
  row.append(seg, motionRow);
  box.append(row, note);
  paint();
  return { node: box, row, value: () => ({ engine, motionType: engine === 'hunyuan' ? select.value : '' }) };
}
let rigUrlCtl = null;

// ---------- 表单 ----------
function setMode(mode) {
  state.mode = mode;
  for (const t of $$('.tab')) {
    const on = t.dataset.mode === mode;
    t.classList.toggle('is-active', on);
    t.setAttribute('aria-selected', on);
    t.tabIndex = on ? 0 : -1;
  }
  for (const p of $$('.mode-pane')) p.hidden = p.dataset.pane !== mode;
  $('#composerTitle').replaceChildren(document.createTextNode(['rig','motion'].includes(mode) ? '让形体动起来' : '创作新形体'), el('span', null, '。'));
  $('#composerSubtitle').textContent = mode === 'rig' ? '给已有角色，加上新的可能。' : mode === 'motion' ? '用一句话，编排一个动作。' : '从一个念头，到触手可及。';
  $('#inspirationNote').hidden = !['text','image'].includes(mode);
  $('#formMsg').classList.remove('err');
  updateOptions();
}
$$('.tab').forEach((t) => t.addEventListener('click', () => setMode(t.dataset.mode)));

function renderModels() {
  $('#models').replaceChildren(...state.models.map(m => new Option(m.label,m.id)));
  $('#models').value = state.model;
}
$('#models').addEventListener('change', e => { state.model = e.target.value; updateOptions(); saveDraft(); });

function updateOptions() {
  const m = state.models.find((x) => x.id === state.model);
  if (!m) return;
  const generating = state.mode === 'text' || state.mode === 'image';
  const tripo = m.kind === 'tripo';
  $('#engineField').hidden = $('#modelsLabel').hidden = !generating;
  $('#advanced').hidden = !generating || tripo;
  $('#modelHint').textContent = `${m.tag} · ${m.family === 'tripo' ? 'TRIPO' : 'HUNYUAN'}`;
  $('#faceRow').hidden = m.kind !== 'pro';
  $('#optPbr').disabled = $('#optGeometry').checked;
  $('#tripoTip').hidden = !(tripo && state.mode === 'image');
  $('#drop').style.opacity = tripo ? 0.45 : 1;
  $('#drop').setAttribute('aria-disabled', String(tripo));
  $('#drop').tabIndex = tripo ? -1 : 0;
  $('#imageFile').disabled = tripo;
  $('#genBtn').firstChild.textContent = { text: '开始生成 ', image: '开始生成 ', rig: '开始绑骨 ', motion: '生成动作 ' }[state.mode];
  updateCostNote();
}
$('#optGeometry').addEventListener('change', updateOptions);
$('#optDemo').addEventListener('change', updateCostNote);
function updateCostNote() {
  if ($('#formMsg').classList.contains('err')) return;
  setMsg($('#optDemo').checked ? '演示模式：走完整流程，但结果是内置的示例。' : '将调用 TokenHub 真实生成，按账户额度计费。');
}

const prompt = $('#prompt');
prompt.addEventListener('input', () => { $('#promptCount').textContent = `${[...prompt.value].length} / 1024`; });
$('#motionPrompt').addEventListener('input', (e) => { $('#motionCount').textContent = `${[...e.target.value].length} / 128`; });
$('#motionDuration').addEventListener('input', (e) => { $('#motionDurationText').textContent = `${e.target.value} 秒`; });

// 图片
function setImage(file) {
  if (!file) return;
  if (state.models.find(m => m.id === state.model)?.kind === 'tripo') return setMsg('Tripo 图生模型需要填写公开图片链接。', true);
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return setMsg('参考图仅支持 JPEG / PNG / WebP', true);
  if (file.size > 6 * 1024 * 1024) return setMsg('参考图不能超过 6 MB', true);
  const reader = new FileReader();
  reader.onload = () => {
    state.imageBase64 = String(reader.result).split(',')[1] || '';
    $('#imagePreview').src = reader.result;
    $('#imagePreview').hidden = false;
    $('#dropText').hidden = true;
    $('#imageClear').hidden = false;
    $('#formMsg').classList.remove('err');
    updateCostNote();
  };
  reader.readAsDataURL(file);
}
function clearImage() {
  state.imageBase64 = '';
  $('#imageFile').value = '';
  $('#imagePreview').hidden = true;
  $('#dropText').hidden = false;
  $('#imageClear').hidden = true;
}
$('#imageFile').addEventListener('change', (e) => setImage(e.target.files[0]));
$('#imageClear').addEventListener('click', (e) => { e.preventDefault(); clearImage(); });
const drop = $('#drop');
drop.addEventListener('keydown', e => {
  if (!['Enter', ' '].includes(e.key) || e.target !== drop || $('#imageFile').disabled) return;
  e.preventDefault(); $('#imageFile').click();
});
for (const ev of ['dragenter', 'dragover']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('is-over'); });
for (const ev of ['dragleave', 'drop']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('is-over'); });
drop.addEventListener('drop', (e) => setImage(e.dataTransfer.files[0]));

// 首页输入框 → 创作台
$('#chips').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (chip) { $('#heroPrompt').value = chip.dataset.p; $('#heroPrompt').focus(); }
});
$('#heroForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('#heroPrompt').value.trim();
  shell.navigate('/create/');
  shell.mobileTab('form');
  if (!text) return prompt.focus({ preventScroll: true });
  setMode('text');
  prompt.value = text;
  prompt.dispatchEvent(new Event('input'));
  saveDraft();
  prompt.focus();
});
$('#genForm').addEventListener('submit', (e) => { e.preventDefault(); submit(); });
$('#genBtn').disabled = true;

async function submit() {
  const btn = $('#genBtn');
  if (btn.disabled) return;
  const demo = $('#optDemo').checked;
  let path, body;
  if (state.mode === 'rig') {
    if (!rigUrlCtl) return;
    path = '/api/rig';
    body = { fileUrl: $('#rigUrl').value, demo, ...rigUrlCtl.value() };
  } else if (state.mode === 'motion') {
    path = '/api/motion';
    body = { prompt: $('#motionPrompt').value, duration: Number($('#motionDuration').value), demo };
  } else {
    path = '/api/generate';
    body = {
      mode: state.mode, model: state.model, demo,
      prompt: prompt.value, imageUrl: $('#imageUrl').value, imageBase64: state.mode === 'image' ? state.imageBase64 : '',
      pbr: $('#optPbr').checked, geometry: $('#optGeometry').checked, faceCount: $('#optFaces').value,
    };
  }
  btn.disabled = true;
  $('#formMsg').classList.remove('err');
  setMsg('正在提交…');
  try {
    const task = await post(path, body);
    setMsg(task.demo ? '演示任务已开始，不调用生成服务。' : '已提交，云端开始处理。');
    upsertTask(task);
    openTask(task);
    shell.mobileTab('preview');
  } catch (e) {
    setMsg(e.message, true);
  } finally {
    btn.disabled = false;
  }
}

// ---------- 舞台 ----------
const STATUS = {
  queued: ['排队中', '任务已提交，正在等待云端算力。'],
  running: ['处理中', '云端正在计算，通常需要 1 – 5 分钟。可以离开页面，稍后在作品库查看。'],
  saving: ['保存中', '已完成，正在把文件保存到本机。'],
};
const taskTitle = (t) => t.title || t.prompt || '未命名';

function setBadge(text, cls) {
  const b = $('#stageBadge');
  b.textContent = text;
  b.className = 'badge' + (cls ? ' ' + cls : '');
}

function resetAnimUi() {
  $('#animBar').hidden = true;
  $('#tBones').hidden = true;
}

async function openTask(task) {
  clearTimeout(pollTimer);
  clearInterval(tickTimer);
  state.current = task.id;
  try { localStorage.setItem('sanzo-3d-current', task.id); } catch {}
  $('#stageName').textContent = library.rootTitle(task);
  $('#stageName').title = `${taskTitle(task)} · ${task.modelLabel}`;
  $('#stageGuide').hidden = true;
  $('#versionsBtn').disabled = false;
  $('#downloads').hidden = true;
  resetAnimUi();
  renderGallery();
  renderPipeline();
  await ensureViewer();
  if (state.current !== task.id) return;
  if (isActive(task)) {
    loadedTaskId = null;
    viewer?.showGenerating();
    tickTimer = setInterval(() => { $('#statusTime').textContent = fmtTime(Date.now() - task.createdAt); }, 500);
    renderProgress(task);
    poll(task.id);
  } else {
    finishTask(task);
  }
}

function renderProgress(task) {
  const [label, sub] = STATUS[task.status] || STATUS.running;
  const box = $('#stageStatus');
  box.hidden = false;
  box.classList.remove('fail');
  setBadge(`${KIND[task.kind]}${label}`, 'run');
  $('#statusText').textContent = `${KIND[task.kind]} · ${label}` + (task.progress != null && task.status === 'running' ? ` ${Math.round(task.progress)}%` : '');
  $('#statusTime').textContent = fmtTime(Date.now() - task.createdAt);
  $('#statusSub').textContent = task.note ? `查询暂时失败，将自动重试：${task.note}` : task.demo ? '正在演示生成流程，完成后显示内置示例，不消耗额度。' : sub;
  const bar = $('#statusBar');
  const known = task.progress != null;
  bar.parentElement.classList.toggle('indeterminate', !known);
  bar.style.width = known ? `${Math.max(4, task.progress)}%` : '';
}

async function poll(id) {
  if (state.current !== id) return;
  if (document.hidden) { pollTimer = setTimeout(() => poll(id), 5000); return; }
  try {
    const task = await api(`/api/tasks/${id}`);
    upsertTask(task);
    if (state.current !== id) return;
    if (isActive(task)) {
      renderProgress(task);
      pollTimer = setTimeout(() => poll(id), task.demo ? 900 : 3000);
    } else {
      finishTask(task);
    }
  } catch (e) {
    $('#statusSub').textContent = `连接本地服务失败，正在重试：${e.message}`;
    pollTimer = setTimeout(() => poll(id), 5000);
  }
}

function setupAnimUi(info, task) {
  if (!info) return;
  // 上游导出的片段名是内部哈希，只有一段时直接用动作名
  if (info.clips.length === 1 && task?.options?.motionName && !task.demo) info.clips[0].name = task.options.motionName;
  const bones = $('#tBones');
  bones.hidden = !info.hasSkeleton;
  if (info.hasSkeleton) {
    // 绑骨结果默认把骨架亮出来
    bones.classList.add('is-on');
    bones.setAttribute('aria-pressed', true);
    viewer.setSkeleton(true);
  }
  const bar = $('#animBar');
  bar.hidden = !info.clips.length;
  if (!info.clips.length) return;
  const play = $('#aPlay');
  play.textContent = '暂停';
  play.classList.add('is-on');
  play.setAttribute('aria-pressed', 'true');
  viewer?.setPaused(false);
  $('#aClips').replaceChildren(...info.clips.map((c, i) => {
    const b = el('button', 'tool' + (i === 0 ? ' is-on' : ''), `${c.name} · ${c.duration.toFixed(1)}s`);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(i === 0));
    b.addEventListener('click', () => {
      for (const x of $('#aClips').children) { x.classList.toggle('is-on', x === b); x.setAttribute('aria-pressed', String(x === b)); }
      viewer.playClip(i);
      play.textContent = '暂停';
      play.classList.add('is-on');
      play.setAttribute('aria-pressed', 'true');
    });
    return b;
  }));
}
$('#aPlay').addEventListener('click', (e) => {
  const playing = !e.target.classList.contains('is-on');
  e.target.classList.toggle('is-on', playing);
  e.target.setAttribute('aria-pressed', String(playing));
  e.target.textContent = playing ? '暂停' : '播放';
  viewer?.setPaused(!playing);
});

async function finishTask(task) {
  const version = ++presentationVersion;
  await ensureViewer();
  if (state.current !== task.id || version !== presentationVersion) return;
  clearInterval(tickTimer);
  renderPipeline();
  const box = $('#stageStatus');
  if (task.status === 'failed') {
    loadedTaskId = null;
    viewer?.showIdle();
    setBadge('失败', 'fail');
    box.hidden = false;
    box.classList.add('fail');
    $('#statusBar').parentElement.classList.remove('indeterminate');
    $('#statusText').textContent = `${KIND[task.kind]}失败`;
    $('#statusTime').textContent = fmtTime((task.finishedAt || Date.now()) - task.createdAt);
    $('#statusSub').textContent = task.error || '未知错误';
    return;
  }
  box.hidden = true;
  setBadge('完成', 'done');
  if (loadedTaskId === task.id) { setupAnimUi(cachedInfo, task); $('#downloads').hidden = false; return; }
  // Any new load invalidates the cached result until it has finished presenting.
  loadedTaskId = null;
  const dl = document.createDocumentFragment();
  let info = null;
  try {
    if (task.demo) {
      if (task.kind === 'model') info = viewer?.showDemoModel();
      else info = viewer?.showDemoRig(task.kind !== 'rig' || Boolean(task.options?.motionType));
      dl.append(el('span', 'label', '演示结果为内置示例，没有可下载的文件。'));
    } else {
      const files = task.files || [];
      const view = files.find((f) => /\.(glb|gltf)$/i.test(f.name)) || files.find((f) => /\.fbx$/i.test(f.name));
      if (view && viewer) info = await viewer.loadModel(view.url);
      else viewer?.showIdle();
      dl.append(el('span', 'label', view ? '下载' : '该结果没有 GLB / FBX，无法在线预览，请下载后查看：'));
      for (const f of files) {
        const a = el('a', 'dl');
        a.href = `${f.url}?dl`;
        a.append(el('b', null, f.name.split('.').pop()), el('small', null, fmtSize(f.size)));
        dl.append(a);
      }
    }
  } catch (e) {
    if (state.current !== task.id || version !== presentationVersion) return;
    viewer?.showIdle();
    dl.append(el('span', 'label', `模型预览失败：${e.message}`));
  }
  if (state.current !== task.id || version !== presentationVersion) return;
  setupAnimUi(info, task);
  if (info?.triangles) dl.append(el('span', 'label', ` · ${info.triangles.toLocaleString()} 三角面`));
  if (info && task.kind !== 'model') {
    dl.append(el('span', 'label', ` · ${info.hasSkeleton ? '含骨骼' : '未检测到骨骼'} · ${info.clips.length} 段动画`));
  }
  $('#downloads').replaceChildren(dl);
  $('#downloads').hidden = false;
  loadedTaskId = task.id;
  cachedInfo = info;
}

// 工具栏
const toggle = (btn, fn) => btn.addEventListener('click', () => {
  const on = !btn.classList.contains('is-on');
  btn.classList.toggle('is-on', on);
  btn.setAttribute('aria-pressed', on);
  fn(on);
});
toggle($('#tRotate'), (on) => viewer?.setAutoRotate(on));
toggle($('#tWire'), (on) => viewer?.setWireframe(on));
toggle($('#tBones'), (on) => viewer?.setSkeleton(on));
$('#tReset').addEventListener('click', () => viewer?.resetView());

// ---------- 管线：建模 → 绑骨 → 动作 ----------
function chainOf(task) {
  const chain = [];
  for (let t = task; t && chain.length < 8; t = t.parentId ? byId(t.parentId) : null) chain.push(t);
  return chain;
}

function setStep(step, cls, detail) {
  const li = $(`#track [data-step="${step}"]`);
  li.className = cls || '';
  li.querySelector('small')?.remove();
  if (detail) li.append(el('small', null, detail));
}
const stepClass = (t) => (t.status === 'done' ? 'done' : t.status === 'failed' ? 'fail' : 'run');

async function runStep(btn, msg, path, body) {
  if (btn.disabled) return;
  btn.disabled = true;
  msg.textContent = '';
  try {
    const task = await post(path, body);
    upsertTask(task);
    openTask(task);
    shell.mobileTab('preview');
  } catch (e) {
    msg.textContent = e.message;
    btn.disabled = false;
  }
}

function rigCard(source, redo) {
  const card = el('div', 'pipe-card');
  const h = el('h4', null, redo ? '换一个动作 / 重新绑骨' : '下一步：绑骨');
  h.append(el('small', null, source.demo ? '演示' : '消耗额度'));
  const ctl = rigControls();
  const btn = el('button', 'btn-primary', redo ? '重新绑骨' : '开始绑骨');
  btn.type = 'button';
  const msg = el('p', 'pipe-msg');
  if (!source.demo && Date.now() - source.createdAt > 23 * 3600 * 1000) {
    btn.disabled = true;
    msg.textContent = '来源链接已过再加工时效，原模型仍可预览和下载。';
  }
  btn.addEventListener('click', () => runStep(btn, msg, '/api/rig', { sourceId: source.id, ...ctl.value() }));
  ctl.row.append(btn);
  card.append(h, ctl.node, msg);
  return card;
}

function animateCard(rig) {
  const card = el('div', 'pipe-card');
  const h = el('h4', null, '下一步：加动画');
  h.append(el('small', null, rig.demo ? '演示' : '消耗额度'));
  let preset = 'walk';
  const row = el('div', 'pipe-row');
  for (const p of state.tripoPresets) {
    const b = el('button', 'preset' + (p.id === preset ? ' is-active' : ''), p.label);
    b.type = 'button';
    if (!p.confirmed) b.append(el('sup', null, '?'));
    b.addEventListener('click', () => {
      preset = p.id;
      for (const x of row.querySelectorAll('.preset')) x.classList.toggle('is-active', x === b);
    });
    row.append(b);
  }
  const btn = el('button', 'btn-primary', '生成动画');
  btn.type = 'button';
  const msg = el('p', 'pipe-msg');
  if (!rig.demo && Date.now() - rig.createdAt > 23 * 3600 * 1000) {
    btn.disabled = true;
    msg.textContent = '绑骨结果已过云端再加工时效，可以继续预览或下载。';
  }
  btn.addEventListener('click', () => runStep(btn, msg, '/api/animate', { sourceId: rig.id, preset }));
  row.append(btn);
  card.append(h, row, el('p', 'pipe-note', '带 ? 的预设来自 Tripo 官方预设名，TokenHub 文档只确认了「行走」，其余可能被拒绝（被拒绝不扣费）。'), msg);
  return card;
}

function renderPipeline() {
  const body = $('#pipeBody');
  const cur = state.current ? byId(state.current) : null;
  body.replaceChildren();
  if (!cur) {
    setStep('model', 'next'); setStep('rig', ''); setStep('anim', '');
    body.append(el('p', 'pipe-hint', '先生成一个角色模型，或在作品库打开一个，然后在这里继续绑骨、加动作。'));
    return;
  }
  const chain = chainOf(cur);
  const model = chain.find((t) => t.kind === 'model');
  const rig = chain.find((t) => t.kind === 'rig');
  const anim = chain.find((t) => t.kind === 'animate' || t.kind === 'motion');
  const rigMotion = rig?.options?.motionName;

  if (cur.kind === 'motion') {
    setStep('model', '', '不适用'); setStep('rig', '', '不适用');
  } else {
    setStep('model', model ? stepClass(model) : 'done', model ? model.modelLabel : '外部模型');
    setStep('rig', rig ? stepClass(rig) : model?.status === 'done' ? 'next' : '', rig ? rig.modelLabel.split(' · ')[0] : '');
  }
  if (anim) setStep('anim', stepClass(anim), anim.kind === 'motion' ? '文生动作' : anim.options?.motionName);
  else if (rigMotion) setStep('anim', stepClass(rig), rigMotion);
  else setStep('anim', rig?.status === 'done' && rig.family === 'tripo' ? 'next' : '');

  if (isActive(cur)) {
    body.append(el('p', 'pipe-hint', `${KIND[cur.kind]}任务进行中，完成后可以在这里继续下一步。`));
    return;
  }
  if (cur.status === 'failed') {
    body.append(el('p', 'pipe-hint', '这一步失败了。可以回到上一步的结果重新尝试。'));
  }
  if (cur.kind === 'motion') {
    body.append(el('p', 'pipe-hint', '文生动作的结果是自带标准人形的独立动画，接口暂不支持重定向到自己的角色。'));
    return;
  }
  const tripoRig = chain.find((t) => t.kind === 'rig' && t.family === 'tripo' && t.status === 'done');
  if (tripoRig) body.append(animateCard(tripoRig));
  if (model?.status === 'done') body.append(rigCard(model, Boolean(rig)));
  else if (rig?.options?.external) body.append(el('p', 'pipe-hint', '这是站外模型的绑骨结果。要换动作，请在左侧「模型绑骨」里重新提交链接。'));
}

// ---------- 资产库与任务 ----------
function upsertTask(task) {
  const i=state.tasks.findIndex(t=>t.id===task.id);
  if(i>=0) state.tasks[i]=task; else state.tasks.unshift(task);
  renderGallery();
}
function renderGallery() {
  library?.render();
  const current=byId(state.current);
  if(current && library?.groupFor(current.id)?.trashed) {
    state.current=null; loadedTaskId=null; presentationVersion++;
    clearTimeout(pollTimer); clearInterval(tickTimer);
    viewer?.showIdle(); resetAnimUi(); setBadge('待命');
    $('#stageName').textContent='等待你的下一个灵感';
    $('#stageGuide').hidden=false; $('#versionsBtn').disabled=true;
    $('#downloads').hidden=$('#stageStatus').hidden=true;
    renderPipeline();
  } else if(current) $('#stageName').textContent=library.rootTitle(current);
}

// 后台刷新其他未完成的任务
let refreshing = false;
setInterval(async () => {
  if (refreshing || document.hidden) return;
  refreshing = true;
  try {
  for (const t of state.tasks.filter((x) => isActive(x) && x.id !== state.current)) {
    try { upsertTask(await api(`/api/tasks/${t.id}`)); } catch { /* 下次再试 */ }
  }
  } finally { refreshing = false; }
}, 6000);

// ---------- 启动 ----------
const pill = $('#keyPill');
function setPill(cls, text) {
  pill.className = 'pill ' + cls; $('#keyText').textContent = text;
  $('#connectionDot').className = 'connection-dot ' + (cls === 'ok' ? 'ok' : cls === 'bad' ? 'bad' : '');
  $('#connectionLabel').textContent = cls === 'ok' ? '生成服务已验证' : cls === 'configured' ? '服务凭证已配置' : cls === 'warn' ? '演示模式可用' : cls === 'bad' ? '连接需要检查' : '正在检查服务';
}
pill.addEventListener('click', async () => {
  if (!state.hasKey) return setPill('warn', '未配置 Key · 演示模式');
  setPill('', '检查中…');
  try {
    const r = await api('/api/check-auth');
    setPill('ok', `Key 有效 · ${r.models3d.length} 个 3D 模型`);
  } catch (e) {
    setPill('bad', 'Key 校验失败');
    pill.title = e.message;
  }
});

// ---------- 空间外壳与草稿 ----------
library=createLibrary({ getTasks:()=>state.tasks, api, toast, onUpdate:upsertTask,
  onOpen:task=>{ shell.navigate(task.kind === 'model' || !task.kind ? '/create/' : '/studio/'); openTask(task); shell.mobileTab('preview'); }
});
function selectInitialTask() {
  if(state.current) return;
  let saved=null;
  try { saved=localStorage.getItem('sanzo-3d-current'); } catch {}
  const available=state.tasks.filter(t=>!library.groupFor(t.id)?.trashed);
  const task=available.find(t=>t.id===saved) || available.find(isActive) || available.find(t=>t.status==='done');
  if(task) openTask(task);
}
shell=initShell({ onView:view=>{
  if(view==='home') ensureHero();
  if(['create','studio'].includes(view)) {
    if(view==='studio' && !['rig','motion'].includes(state.mode)) setMode('rig');
    if(view==='create' && !['text','image'].includes(state.mode)) setMode('text');
    ensureViewer().then(()=>{
      if(state.current && loadedTaskId!==state.current && !isActive(byId(state.current))) finishTask(byId(state.current));
      else if(!state.current) selectInitialTask();
    });
  }
  if(view==='assets' || view==='tasks') renderGallery();
}});
$('#versionsBtn').addEventListener('click',()=>{ if(state.current) library.details(state.current); });
$('#randomPrompt').addEventListener('click',()=>{
  const chips=$$('#chips .chip');
  const chosen=chips[Math.floor(Math.random()*chips.length)];
  setMode('text'); prompt.value=chosen.dataset.p; prompt.dispatchEvent(new Event('input')); prompt.focus(); saveDraft();
});
$('#refreshTasks').addEventListener('click', async e=>{
  const btn=e.currentTarget; btn.disabled=true;
  try {
    const pending = state.tasks.filter(isActive);
    for (const task of pending) upsertTask(await api(`/api/tasks/${task.id}`));
    state.tasks=await api('/api/tasks'); renderGallery(); toast('任务列表已刷新');
  }
  catch(err){toast(err.message);}finally{btn.disabled=false;}
});
const draftFields=['prompt','motionPrompt','motionDuration','models','imageUrl','rigUrl','optPbr','optGeometry','optFaces','optDemo'];
let draftTimer;
function saveDraft() {
  clearTimeout(draftTimer);
  draftTimer=setTimeout(()=>{
    try {
      const values=Object.fromEntries(draftFields.map(id=>[id,$('#'+id).type==='checkbox'?$('#'+id).checked:$('#'+id).value]));
      localStorage.setItem('sanzo-3d-draft',JSON.stringify(values));
    } catch {}
  },250);
}
try {
  const saved=JSON.parse(localStorage.getItem('sanzo-3d-draft') || '{}');
  for(const id of draftFields) if(Object.hasOwn(saved,id) && id!=='models') {
    const n=$('#'+id);
    if(n.type==='checkbox' && typeof saved[id]==='boolean') n.checked=saved[id];
    else if(typeof saved[id]==='string') n.value=saved[id];
  }
  if(typeof saved.models==='string') state.model=saved.models;
  $('#promptCount').textContent=[...prompt.value].length+' / 1024';
  $('#motionCount').textContent=[...$('#motionPrompt').value].length+' / 128';
  $('#motionDurationText').textContent=$('#motionDuration').value+' 秒';
} catch {}
for(const id of draftFields) $('#'+id).addEventListener('input',saveDraft);
for(const tab of $$('.tab')) {
  tab.id='tab-'+tab.dataset.mode;
  tab.setAttribute('aria-controls','pane-'+tab.dataset.mode);
  const pane=$('[data-pane="'+tab.dataset.mode+'"]'); pane.id='pane-'+tab.dataset.mode;
  pane.setAttribute('role','tabpanel'); pane.setAttribute('aria-labelledby',tab.id);
  tab.addEventListener('keydown',e=>{
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;
    e.preventDefault();
    const visible=$$('.tab').filter(b=>getComputedStyle(b).display!=='none');
    const i=visible.indexOf(tab);
    const next=e.key==='Home'?visible[0]:e.key==='End'?visible.at(-1):visible[(i+(e.key==='ArrowRight'?1:-1)+visible.length)%visible.length];
    setMode(next.dataset.mode); next.focus();
  });
}

(async function boot() {
  try {
    const cfg = await api('/api/config');
    Object.assign(state, { models: cfg.models, motions: cfg.motions, tripoPresets: cfg.tripoPresets, hasKey: cfg.hasKey });
    if (!state.models.some(m => m.id === state.model)) state.model = state.models[0]?.id || '';
    if (cfg.hasKey) setPill('configured', `凭证已配置 · ${cfg.region} · 点击验证`);
    else {
      setPill('warn', '未配置 Key · 演示模式');
      $('#optDemo').checked = true;
      $('#optDemo').disabled = true;
    }
    rigUrlCtl = rigControls();
    $('#rigUrlControls').append(rigUrlCtl.node);
    renderModels();
    updateOptions();
    $('#genBtn').disabled = false;
    state.tasks = await api('/api/tasks');
    renderGallery();
    renderPipeline();
    if (['create','studio'].includes(shell.view)) selectInitialTask();
  } catch (e) {
    setPill('bad', '本地服务未响应');
    setMsg(e.message, true);
  }
})();
