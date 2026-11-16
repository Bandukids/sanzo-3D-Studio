// SANZO 3D Studio — 零框架后端：静态站点 + TokenHub（混元 3D / Tripo 3D）代理。
// API Key 只存在于服务端进程，永远不会下发到浏览器。
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const THREE_DIR = path.join(ROOT, 'node_modules', 'three');
const DATA_DIR = process.env.SANZO_DATA_DIR ? path.resolve(process.env.SANZO_DATA_DIR) : path.join(ROOT, 'data');
const ASSET_DIR = path.join(DATA_DIR, 'assets');
const TASK_FILE = path.join(DATA_DIR, 'tasks.json');

// ---------- 配置 ----------
function loadDotEnv() {
  try {
    for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
      if (!m || line.trim().startsWith('#')) continue;
      const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
      if (value && process.env[m[1]] === undefined) process.env[m[1]] = value;
    }
  } catch { /* 没有 .env 也没关系 */ }
}
loadDotEnv();

const PORT = process.env.PORT === undefined ? 5173 : Number(process.env.PORT);
const API_KEY = process.env.TOKENHUB_API_KEY || process.env.HUNYUAN_3D_API_KEY || process.env.TENCENT_HUNYUAN_API_KEY || '';
const ALLOWED_ORIGINS = [
  'https://tokenhub.tencentmaas.com', 'https://tokenhub.tencentmaas.cn',
  'https://tokenhub-intl.tencentmaas.com', 'https://tokenhub-intl.tencentmaas.cn',
];
const BASE_URL = (process.env.TOKENHUB_BASE_URL || ALLOWED_ORIGINS[0]).replace(/\/+$/, '');
if (!ALLOWED_ORIGINS.includes(BASE_URL)) {
  console.error(`TOKENHUB_BASE_URL 必须是以下之一：\n  ${ALLOWED_ORIGINS.join('\n  ')}`);
  process.exit(1);
}

const MODELS = {
  'hy-3d-3.1': { family: 'hunyuan', kind: 'pro', label: '混元 3D 3.1', tag: '专业版 · 高精度' },
  'hy-3d-express': { family: 'hunyuan', kind: 'express', label: '混元 3D Express', tag: '极速版 · 快' },
  'hy-3d-3.0': { family: 'hunyuan', kind: 'pro', label: '混元 3D 3.0', tag: '专业版' },
  'tripo-3d-3.1': { family: 'tripo', kind: 'tripo', label: 'Tripo 3D 3.1', tag: '通用 · 高质量' },
  'tripo-3d-p1': { family: 'tripo', kind: 'tripo', label: 'Tripo 3D P1', tag: '通用' },
};

// 混元绑骨的人形动作模板，编号 1..48（motion_type）
const HY_MOTIONS = [
  '回旋踢', '左勾拳', '蓄力攻击', '蓄力出拳', '二连击打', '二连击打-2', '后撤', '受击',
  '受击-2', '受击-3', '受击倒地-1', '受击倒地-2', '落地', '沮丧', '割喉', '刺拳',
  '连续击打', '踢腿', '侧踢', '打太极', '后空翻', '蹲姿转体', '走路-1', '走路-2',
  '走路-3', '待机-1', '待机-2', '街舞', '扭扭舞', '左转弯', '右转弯', '慢跑',
  '慢跑-2', '奔跑', '冲刺跑-1', '冲刺跑-2', '冲刺跑-3', '原地跳-1', '滑铲', '向前大跳',
  '向前大跳-2', '跨越', '恐吓', '向前跌倒', '右转', '原地跳-2', '转身', '发送冲击波',
];
// Tripo 预设动画：TokenHub 控制台只给出了 walk，其余来自 Tripo 官方预设名，尚未在 TokenHub 上确认。
const TRIPO_PRESETS = [
  { id: 'walk', label: '行走', confirmed: true }, { id: 'idle', label: '待机' }, { id: 'run', label: '奔跑' },
  { id: 'jump', label: '跳跃' }, { id: 'climb', label: '攀爬' }, { id: 'slash', label: '挥砍' },
  { id: 'shoot', label: '射击' }, { id: 'hurt', label: '受击' }, { id: 'fall', label: '倒地' }, { id: 'turn', label: '转身' },
];
const SOURCE_TTL = 23 * 3600 * 1000;       // 上游任务 ID 只保留 24 小时

const MAX_IMAGE_BYTES = 6 * 1024 * 1024;   // 混元本地图片上限 6 MiB
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const MIN_QUERY_GAP = 5000;                // 上游查询最小间隔
const MODEL_EXT = ['glb', 'gltf', 'fbx', 'obj', 'stl', 'usdz', 'zip', 'mp4', 'gif'];
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp'];

// ---------- 任务存储 ----------
/** @type {Map<string, any>} */
const tasks = new Map();
const busy = new Set();

function loadTasks() {
  try {
    for (const t of JSON.parse(fs.readFileSync(TASK_FILE, 'utf8'))) tasks.set(t.id, t);
  } catch { /* 首次运行 */ }
}
let saveTimer = null;
function saveTasks() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await fsp.mkdir(DATA_DIR, { recursive: true });
      const tmp = TASK_FILE + '.tmp';
      await fsp.writeFile(tmp, JSON.stringify([...tasks.values()], null, 2));
      await fsp.rename(tmp, TASK_FILE);
    } catch (e) { console.error('保存任务失败', e.message); }
  }, 150);
}
loadTasks();

function publicTask(t) {
  const { lastQuery, ...rest } = t;
  return { kind: 'model', parentId: null, title: t.prompt || '图片生成的模型', ...rest };
}

// ---------- 上游调用 ----------
class ApiError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

function errorDetail(body, fallback) {
  const inner = body?.Response && typeof body.Response === 'object' ? body.Response : body;
  const err = inner?.error ?? inner?.Error;
  if (err && typeof err === 'object') {
    return `${err.code || err.Code || 'APIError'}: ${err.message || err.Message || fallback}`;
  }
  if (err) return String(err);
  const code = inner?.error_code || inner?.ErrorCode;
  const msg = inner?.error_message || inner?.ErrorMessage || inner?.message;
  return code || msg ? `${code || 'APIError'}: ${msg || fallback}` : fallback;
}

const HTTP_HINTS = {
  401: '请检查 API Key 与地域是否匹配。',
  403: '账号可能没有开通该模型，或子账号缺少 QcloudTokenhubFullAccess 权限。',
  429: '触发了额度 / 并发 / 频率限制（多数 3D 模型默认并发为 1）。',
};

async function upstream(endpoint, payload) {
  if (!API_KEY) throw new ApiError('服务端未配置 TOKENHUB_API_KEY', 503);
  let res;
  try {
    res = await fetch(BASE_URL + endpoint, {
      method: payload ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: payload ? JSON.stringify(payload) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    throw new ApiError(`无法连接 TokenHub：${e.cause?.code || e.name}`, 502);
  }
  const raw = await res.text();
  let body = null;
  try { body = JSON.parse(raw); } catch { /* 非 JSON */ }
  if (!res.ok) {
    const detail = body ? errorDetail(body, '请求被拒绝') : '上游返回了非 JSON 错误';
    throw new ApiError(`TokenHub HTTP ${res.status}：${detail} ${HTTP_HINTS[res.status] || ''}`.trim(), 502);
  }
  if (!body || typeof body !== 'object') throw new ApiError('TokenHub 返回了无法解析的响应', 502);
  const inner = body.Response && typeof body.Response === 'object' ? body.Response : body;
  if (inner.error || inner.Error) throw new ApiError(errorDetail(body, 'API 请求失败'), 502);
  return inner;
}

function normalizeStatus(body) {
  const s = String(body.status ?? body.Status ?? '').toLowerCase();
  if (['queued', 'wait', 'waiting', 'pending', 'submitted'].includes(s)) return 'queued';
  if (['in_progress', 'run', 'running', 'processing'].includes(s)) return 'running';
  if (['completed', 'done', 'success', 'succeeded', 'finished'].includes(s)) return 'done';
  if (['failed', 'fail', 'error', 'cancelled', 'canceled', 'banned', 'expired'].includes(s)) return 'failed';
  return 'running';
}

function extOf(url) {
  try { return path.extname(new URL(url).pathname).slice(1).toLowerCase(); } catch { return ''; }
}

/** 从查询结果里收集可下载的文件；兼容混元的 data[] 以及 Tripo 尚未公开的返回结构。 */
function collectResults(body) {
  const files = [];
  const seen = new Set();
  let preview = null;
  const add = (url, type) => {
    if (typeof url !== 'string' || !url.startsWith('https://') || seen.has(url)) return;
    seen.add(url);
    files.push({ url, type: (type || extOf(url) || 'file').toLowerCase() });
  };
  const data = Array.isArray(body.data) ? body.data : Array.isArray(body.ResultFile3Ds) ? body.ResultFile3Ds : null;
  if (data) {
    for (const item of data) {
      if (!item || typeof item !== 'object') continue;
      add(item.url ?? item.Url, item.type ?? item.Type);
      preview ||= item.preview_image_url ?? item.PreviewImageUrl ?? null;
    }
  }
  // 通用兜底：遍历整个响应，找指向模型 / 预览图的 https 链接
  const walk = (node, key = '') => {
    if (typeof node === 'string') {
      if (!node.startsWith('https://')) return;
      const ext = extOf(node);
      const k = key.toLowerCase();
      if (IMAGE_EXT.includes(ext) || k.includes('preview') || k.includes('render') || k.includes('thumbnail')) {
        if (IMAGE_EXT.includes(ext) || k.includes('image') || k.includes('thumbnail')) preview ||= node;
      } else if (MODEL_EXT.includes(ext) || ['url', 'download_url', 'model', 'pbr_model', 'base_model'].includes(k)) {
        add(node);
      }
    } else if (Array.isArray(node)) {
      node.forEach((n) => walk(n, key));
    } else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) walk(v, k);
    }
  };
  walk(body);
  return { files, preview: typeof preview === 'string' && preview.startsWith('https://') ? preview : null };
}

async function downloadTo(url, dest) {
  // 签名下载链接：不带 Authorization
  const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!res.ok || !res.body) throw new Error(`下载失败 HTTP ${res.status}`);
  const tmp = dest + '.part';
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
  await fsp.rename(tmp, dest);
  return (await fsp.stat(dest)).size;
}

async function saveResults(task, body) {
  const { files, preview } = collectResults(body);
  if (!files.length) throw new Error('任务已完成，但响应里没有找到模型下载链接');
  const dir = path.join(ASSET_DIR, task.id);
  await fsp.mkdir(dir, { recursive: true });
  const saved = [];
  const used = new Set();
  for (const f of files) {
    let ext = extOf(f.url) || f.type;
    if (!/^[a-z0-9]{1,5}$/.test(ext)) ext = 'bin';
    let name = `model.${ext}`;
    for (let i = 2; used.has(name); i++) name = `model-${i}.${ext}`;
    used.add(name);
    try {
      const size = await downloadTo(f.url, path.join(dir, name));
      saved.push({ type: f.type === 'file' ? ext : f.type, name, size, url: `/assets/${task.id}/${name}` });
    } catch (e) {
      console.error(`[${task.id}] ${name}: ${e.message}`);
    }
  }
  if (!saved.length) throw new Error('模型文件下载失败（签名链接可能已过期）');
  task.files = saved;
  if (preview) {
    try {
      const ext = IMAGE_EXT.includes(extOf(preview)) ? extOf(preview) : 'png';
      await downloadTo(preview, path.join(dir, `preview.${ext}`));
      task.preview = `/assets/${task.id}/preview.${ext}`;
    } catch { /* 预览图失败不影响结果 */ }
  }
}

// ---------- 请求体构造 ----------
function sniffImage(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return 'jpeg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

function httpsUrl(value) {
  let u;
  try { u = new URL(value); } catch { throw new ApiError('图片链接格式不正确'); }
  if (u.protocol !== 'https:') throw new ApiError('图片链接必须是公开可访问的 HTTPS 地址');
  return u.toString();
}

function buildPayload(input) {
  const model = MODELS[input.model];
  if (!model) throw new ApiError('未知模型');
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
  const imageUrl = typeof input.imageUrl === 'string' ? input.imageUrl.trim() : '';
  let imageBase64 = typeof input.imageBase64 === 'string' ? input.imageBase64.replace(/^data:[^,]*,/, '') : '';
  const mode = input.mode === 'image' ? 'image' : 'text';
  const payload = { model: input.model };

  if (mode === 'text') {
    if (!prompt) throw new ApiError('请先写下你想生成的物体');
    if ([...prompt].length > 1024) throw new ApiError('描述不能超过 1024 个字符');
    // 请求体不是 UTF-8 时中文会变成替换符，直接拒绝，避免拿乱码去扣费生成
    if (prompt.includes('�')) throw new ApiError('描述的文字编码不正确（请求体必须是 UTF-8）');
    payload.prompt = prompt;
  } else if (model.kind === 'tripo') {
    if (imageBase64 && !imageUrl) throw new ApiError('Tripo 图生 3D 目前只支持公开的图片 URL，请填写链接或改用混元模型');
    if (!imageUrl) throw new ApiError('请填写参考图的 HTTPS 链接');
    payload.input = httpsUrl(imageUrl);
  } else if (imageBase64) {
    const buf = Buffer.from(imageBase64, 'base64');
    if (!buf.length) throw new ApiError('图片内容为空');
    if (buf.length > MAX_IMAGE_BYTES) throw new ApiError('参考图不能超过 6 MB');
    const fmt = sniffImage(buf);
    if (!fmt) throw new ApiError('参考图仅支持 JPEG / PNG / WebP');
    payload.image_base64 = buf.toString('base64');
  } else if (imageUrl) {
    payload.image_url = httpsUrl(imageUrl);
  } else {
    throw new ApiError('请上传参考图或填写图片链接');
  }

  const geometry = Boolean(input.geometry);
  const pbr = Boolean(input.pbr) && !geometry;
  if (model.kind === 'pro') {
    if (pbr) payload.enable_pbr = true;
    // 实测：Normal 模式必须省略 generate_type；白模按服务端报错信息使用首字母大写。
    if (geometry) payload.generate_type = 'Geometry';
    const fc = Number(input.faceCount);
    if (Number.isFinite(fc) && fc > 0) {
      if (fc < 3000 || fc > 1_500_000) throw new ApiError('面数需在 3000 – 1500000 之间');
      payload.face_count = Math.round(fc);
    }
  } else if (model.kind === 'express') {
    if (pbr) payload.enable_pbr = true;
    if (geometry) payload.enable_geometry = true;
    payload.result_format = 'GLB'; // 实测：小写会被拒绝（InvalidResultFormat）
  }
  return { payload, mode, prompt, geometry, pbr };
}

// ---------- 任务生命周期 ----------
function createTask(input) {
  const { payload, mode, prompt, geometry, pbr } = buildPayload(input);
  return submitTask({
    kind: 'model', model: payload.model, modelLabel: MODELS[payload.model].label, family: MODELS[payload.model].family,
    mode, prompt: mode === 'text' ? prompt : '', title: mode === 'text' ? prompt : '图片生成的模型',
    options: { pbr, geometry, faceCount: payload.face_count || null },
  }, payload, Boolean(input.demo) || !API_KEY);
}

/** 重新向上游查询来源任务，拿一条新鲜的签名链接作为绑骨输入（本地文件上游访问不到）。 */
async function freshSourceUrl(source, exts) {
  if (!source.upstreamId) throw new ApiError('来源任务没有云端记录，无法作为绑骨输入');
  if (Date.now() - source.createdAt > SOURCE_TTL) {
    throw new ApiError('来源模型的云端链接已过期（上游只保留 24 小时）。请把本地模型上传到可公开访问的地址，再用「模型绑骨」提交链接。');
  }
  const body = await upstream('/v1/api/3d/query', { model: source.model, id: source.upstreamId });
  const { files } = collectResults(body);
  for (const ext of exts) {
    const hit = files.find((f) => extOf(f.url) === ext || f.type === ext);
    if (hit) return { url: hit.url, ext };
  }
  throw new ApiError(`来源任务里没有可用于绑骨的 ${exts.join(' / ').toUpperCase()} 文件`);
}

async function createRig(input) {
  const engine = input.engine === 'tripo' ? 'tripo' : 'hunyuan';
  const source = input.sourceId ? tasks.get(String(input.sourceId)) : null;
  if (input.sourceId && !source) throw new ApiError('来源模型不存在');
  if (source && source.status !== 'done') throw new ApiError('来源模型还没有生成完成');
  const demo = Boolean(input.demo) || !API_KEY || Boolean(source?.demo);

  let motionType = null;
  if (engine === 'hunyuan' && input.motionType !== undefined && input.motionType !== null && input.motionType !== '') {
    motionType = Number(input.motionType);
    if (!Number.isInteger(motionType) || motionType < 1 || motionType > HY_MOTIONS.length) throw new ApiError('动作模板编号需在 1 – 48 之间');
  }

  const accepted = engine === 'hunyuan' ? ['glb', 'fbx'] : ['glb', 'fbx', 'gltf', 'obj', 'stl'];
  let file = null;
  if (source) {
    if (!demo) file = await freshSourceUrl(source, accepted);
  } else {
    const url = httpsUrl(typeof input.fileUrl === 'string' ? input.fileUrl.trim() : '');
    const ext = extOf(url);
    if (ext && !accepted.includes(ext)) throw new ApiError(`${engine === 'hunyuan' ? '混元' : 'Tripo'}绑骨只接受 ${accepted.join(' / ').toUpperCase()} 模型`);
    file = { url, ext };
  }

  let payload;
  if (engine === 'hunyuan') {
    const file3d = { url: file?.url };
    if (file?.ext === 'glb' || file?.ext === 'fbx') file3d.type = file.ext;
    payload = { model: 'hy-3d-rigging', file_3d: file3d };
    if (motionType) payload.motion_type = motionType;
  } else {
    payload = { model: 'tripo-3d-rigging', input: file?.url };
  }
  const motionName = motionType ? HY_MOTIONS[motionType - 1] : null;
  return submitTask({
    kind: 'rig', model: payload.model, family: engine,
    modelLabel: (engine === 'hunyuan' ? '混元绑骨' : 'Tripo 绑骨') + (motionName ? ` · ${motionName}` : ''),
    parentId: source?.id || null, mode: 'rig', prompt: '',
    title: source ? publicTask(source).title : '外部模型',
    options: { motionType, motionName, external: !source },
  }, payload, demo);
}

async function createAnimation(input) {
  const source = tasks.get(String(input.sourceId || ''));
  if (!source || source.kind !== 'rig' || source.family !== 'tripo') throw new ApiError('Tripo 动画需要一个已完成的 Tripo 绑骨任务');
  if (source.status !== 'done') throw new ApiError('绑骨任务还没有完成');
  const preset = TRIPO_PRESETS.find((p) => p.id === input.preset);
  if (!preset) throw new ApiError('未知的动画预设');
  const demo = Boolean(input.demo) || !API_KEY || Boolean(source.demo);
  if (!demo && !source.upstreamId) throw new ApiError('绑骨任务没有云端记录');
  if (!demo && Date.now() - source.createdAt > SOURCE_TTL) throw new ApiError('绑骨任务已超过 24 小时，云端记录过期，需要重新绑骨');
  return submitTask({
    kind: 'animate', model: 'tripo-3d-animation', family: 'tripo', modelLabel: `Tripo 动画 · ${preset.label}`,
    parentId: source.id, mode: 'animate', prompt: '', title: publicTask(source).title,
    options: { preset: preset.id, motionName: preset.label },
  }, { model: 'tripo-3d-animation', input: source.upstreamId, animation: `preset:${preset.id}` }, demo);
}

function createMotion(input) {
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
  if (!prompt) throw new ApiError('请描述想要的动作');
  if ([...prompt].length > 128) throw new ApiError('动作描述不能超过 128 个字符');
  if (prompt.includes('�')) throw new ApiError('描述的文字编码不正确（请求体必须是 UTF-8）');
  const payload = { model: 'hy-3d-motion', prompt };
  const duration = Number(input.duration);
  if (input.duration !== undefined && input.duration !== '' && input.duration !== null) {
    if (!Number.isInteger(duration) || duration < 1 || duration > 12) throw new ApiError('时长需为 1 – 12 秒的整数');
    payload.duration = duration;
  }
  return submitTask({
    kind: 'motion', model: 'hy-3d-motion', family: 'hunyuan', modelLabel: '混元文生动作',
    mode: 'motion', prompt, title: prompt, options: { duration: payload.duration || 5 },
  }, payload, Boolean(input.demo) || !API_KEY);
}

async function submitTask(meta, payload, demo) {
  const now = Date.now();
  const task = {
    id: crypto.randomBytes(8).toString('hex'),
    upstreamId: null, parentId: null,
    ...meta,
    status: 'queued', demo, progress: null,
    createdAt: now, updatedAt: now, finishedAt: null,
    error: null, files: [], preview: null, lastQuery: 0,
  };
  if (!demo) {
    // 提交只发一次；结果不确定时不自动重试，避免重复扣费。
    const body = await upstream('/v1/api/3d/submit', payload);
    const id = body.id ?? body.task_id ?? body.job_id ?? body.JobId ?? body.data?.task_id ?? body.data?.id;
    if (!id) throw new ApiError('提交已发出，但响应里没有任务 ID。请先到 TokenHub 控制台确认任务记录，再决定是否重新提交。', 502);
    task.upstreamId = String(id);
    task.status = normalizeStatus(body) === 'failed' ? 'failed' : 'queued';
  }
  tasks.set(task.id, task);
  saveTasks();
  return task;
}

async function refreshTask(task) {
  if (task.status === 'done' || task.status === 'failed' || busy.has(task.id)) return task;
  const now = Date.now();
  if (task.demo) {
    const t = now - task.createdAt;
    task.status = t < 1800 ? 'queued' : t < 9000 ? 'running' : 'done';
    task.progress = Math.min(100, Math.round((t / 9000) * 100));
    if (task.status === 'done') { task.finishedAt = now; saveTasks(); }
    task.updatedAt = now;
    return task;
  }
  if (now - task.lastQuery < MIN_QUERY_GAP) return task;
  busy.add(task.id);
  task.lastQuery = now;
  try {
    const body = await upstream('/v1/api/3d/query', { model: task.model, id: task.upstreamId });
    const status = normalizeStatus(body);
    const progress = Number(body.progress ?? body.Progress ?? body.data?.progress);
    if (Number.isFinite(progress)) task.progress = Math.max(0, Math.min(100, progress));
    task.note = null;
    if (status === 'done') {
      task.status = 'saving';
      await saveResults(task, body);
      task.status = 'done';
      task.progress = 100;
      task.finishedAt = Date.now();
    } else if (status === 'failed') {
      task.status = 'failed';
      task.error = errorDetail(body, '生成任务失败');
      task.finishedAt = Date.now();
    } else {
      task.status = status;
    }
  } catch (e) {
    if (task.status === 'saving') {
      task.status = 'failed';
      task.error = e.message;
      task.finishedAt = Date.now();
    } else {
      task.note = e.message; // 查询出错不改变任务状态，下次继续查
    }
  } finally {
    busy.delete(task.id);
    task.updatedAt = Date.now();
    saveTasks();
  }
  return task;
}

// ---------- HTTP ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.mp4': 'video/mp4', '.ico': 'image/x-icon',
  '.wasm': 'application/wasm', '.zip': 'application/zip',
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
  res.end(body);
}

async function serveFile(req, res, baseDir, relPath, { cache = 'no-cache', download = false } = {}) {
  const file = path.resolve(baseDir, '.' + path.posix.normalize('/' + relPath));
  if (file !== baseDir && !file.startsWith(baseDir + path.sep)) return sendJson(res, 403, { error: 'forbidden' });
  let stat;
  try { stat = await fsp.stat(file); } catch { return sendJson(res, 404, { error: 'not found' }); }
  if (!stat.isFile()) return sendJson(res, 404, { error: 'not found' });
  const headers = {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Content-Length': stat.size, 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff',
  };
  if (download) headers['Content-Disposition'] = `attachment; filename="${path.basename(file)}"`;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { reject(new ApiError('请求体过大', 413)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new ApiError('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

async function handleApi(req, res, url) {
  const p = url.pathname;
  if (p === '/api/config' && req.method === 'GET') {
    return sendJson(res, 200, {
      hasKey: Boolean(API_KEY),
      region: BASE_URL.includes('intl') ? '新加坡' : '中国内地',
      models: Object.entries(MODELS).map(([id, m]) => ({ id, ...m })),
      motions: HY_MOTIONS.map((label, i) => ({ id: i + 1, label })),
      tripoPresets: TRIPO_PRESETS,
    });
  }
  if (p === '/api/check-auth' && req.method === 'GET') {
    // 只读取模型目录，不提交任务、不消耗额度
    const body = await upstream('/v1/models');
    const list = Array.isArray(body.data) ? body.data.map((m) => m.id).filter(Boolean) : [];
    return sendJson(res, 200, { ok: true, models3d: list.filter((id) => /3d/i.test(id)) });
  }
  if (req.method !== 'GET') {
    // 仅接受本页面发起的请求，避免其他网站借用本地服务消耗额度
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) throw new ApiError('forbidden', 403);
  }
  const creators = { '/api/generate': createTask, '/api/rig': createRig, '/api/animate': createAnimation, '/api/motion': createMotion };
  if (creators[p] && req.method === 'POST') {
    const task = await creators[p](await readBody(req));
    return sendJson(res, 200, publicTask(task));
  }
  if (p === '/api/tasks' && req.method === 'GET') {
    const list = [...tasks.values()].sort((a, b) => b.createdAt - a.createdAt);
    return sendJson(res, 200, list.map(publicTask));
  }
  const m = p.match(/^\/api\/tasks\/([a-f0-9]{16})$/);
  if (m) {
    const task = tasks.get(m[1]);
    if (!task) return sendJson(res, 404, { error: '任务不存在' });
    if (req.method === 'GET') return sendJson(res, 200, publicTask(await refreshTask(task)));
    if (req.method === 'PATCH') {
      const input = await readBody(req);
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ApiError('资产信息必须为 JSON 对象');
      const changes = {};
      if (Object.hasOwn(input, 'title')) {
        if (typeof input.title !== 'string' || !input.title.trim() || [...input.title.trim()].length > 120) throw new ApiError('资产名称需为 1–120 个字符');
        changes.title = input.title.trim();
      }
      if (Object.hasOwn(input, 'collection')) {
        if (typeof input.collection !== 'string' || [...input.collection.trim()].length > 60) throw new ApiError('项目名称不能超过 60 个字符');
        changes.collection = input.collection.trim();
      }
      if (Object.hasOwn(input, 'trashed')) {
        if (typeof input.trashed !== 'boolean') throw new ApiError('回收状态必须为布尔值');
        changes.trashedAt = input.trashed ? Date.now() : null;
      }
      if (!Object.keys(changes).length) throw new ApiError('没有可更新的资产信息');
      Object.assign(task, changes, { updatedAt: Date.now() });
      saveTasks();
      return sendJson(res, 200, publicTask(task));
    }
    if (req.method === 'DELETE') {
      tasks.delete(task.id);
      saveTasks();
      await fsp.rm(path.join(ASSET_DIR, task.id), { recursive: true, force: true });
      return sendJson(res, 200, { ok: true });
    }
  }
  return sendJson(res, 404, { error: 'not found' });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = decodeURIComponent(url.pathname);
    if (p.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' });
    if (p.startsWith('/vendor/three/')) {
      return await serveFile(req, res, THREE_DIR, p.slice('/vendor/three/'.length), { cache: 'public, max-age=86400' });
    }
    if (p.startsWith('/assets/') && p !== '/assets/') {
      return await serveFile(req, res, ASSET_DIR, p.slice('/assets/'.length), {
        cache: 'public, max-age=3600', download: url.searchParams.has('dl'),
      });
    }
    const appRoute = /^\/(?:create|assets|studio|tasks|settings)\/?$/.test(p);
    return await serveFile(req, res, PUBLIC_DIR, p === '/' || appRoute ? 'index.html' : p);
  } catch (e) {
    if (!(e instanceof ApiError)) console.error(e);
    if (!res.headersSent) sendJson(res, e instanceof ApiError ? e.status : 500, { error: e instanceof ApiError ? e.message : '服务器内部错误' });
    else res.end();
  }
});

// 只监听本机，Key 不会暴露给局域网
server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  SANZO 3D Studio  →  http://localhost:${server.address().port}`);
  console.log(`  TokenHub Key: ${API_KEY ? '已配置' : '未配置（仅演示模式可用）'}  ·  ${BASE_URL}\n`);
});
