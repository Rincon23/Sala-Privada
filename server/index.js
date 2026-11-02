// Servidor da Sala Privada: entrega o site, faz a sinalização por WebSocket
// (quem está na sala, o que está no ar, chat e música) e repassa as chamadas
// para o Cloudflare Realtime. O segredo do app do Realtime nunca sai daqui.
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 8380;
const APP_ID = (process.env.REALTIME_APP_ID || '').trim();
const APP_SECRET = (process.env.REALTIME_APP_SECRET || '').trim();
const ROOM_PASSWORD = process.env.ROOM_PASSWORD || '';
const LIMIT_GB = Number(process.env.MONTHLY_LIMIT_GB) || 900;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const USAGE_FILE = path.join(DATA_DIR, 'usage.json');
const RTC_BASE = `https://rtc.live.cloudflare.com/v1/apps/${encodeURIComponent(APP_ID)}`;
const ICE_SERVERS = [{ urls: 'stun:stun.cloudflare.com:3478' }];
const RECONNECT_GRACE_MS = 15_000;
const STREAM_KINDS = new Set(['mic', 'camera', 'screen']);
const COLORS = ['#7c6cff', '#ff6b9a', '#34d399', '#f5a524', '#38bdf8', '#fb7185', '#c084fc', '#2dd4bf', '#f97316'];

const newId = (bytes = 6) => randomBytes(bytes).toString('base64url');

// ---------- estado da sala (só em memória, exceto o uso do mês) ----------

const participants = new Map();
const streams = new Map();
const sessions = new Map(); // sessionId do Realtime -> id do participante dono
const chat = [];
const music = { queue: [], current: null, playing: false, position: 0, since: Date.now() };
let usage = { month: monthKey(), bytes: 0 };
let usageDirty = false;

function publicParticipant(p) {
  return { id: p.id, name: p.name, color: p.color, micOn: p.micOn, deafened: p.deafened, online: p.online, joinedAt: p.joinedAt };
}

function snapshot() {
  return {
    participants: [...participants.values()].map(publicParticipant),
    streams: [...streams.values()],
    chat: chat.slice(-80),
    music: musicState(),
    usage: usageInfo(),
  };
}

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function broadcast(msg, exceptId) {
  const data = JSON.stringify(msg);
  for (const p of participants.values()) {
    if (p.id !== exceptId && p.ws?.readyState === 1) p.ws.send(data);
  }
}

function cleanName(name) {
  return String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 32);
}

function colorFor(name) {
  let hash = 0;
  for (const ch of name.toLowerCase()) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return COLORS[hash % COLORS.length];
}

function pushChat(entry) {
  chat.push(entry);
  if (chat.length > 150) chat.shift();
  broadcast({ type: 'chat', message: entry });
}

function systemChat(text) {
  pushChat({ id: newId(), system: true, text, ts: Date.now() });
}

// ---------- entrada e saída ----------

function handleJoin(ws, msg) {
  if (ROOM_PASSWORD && msg.password !== ROOM_PASSWORD) {
    return send(ws, { type: 'error', code: 'password', message: 'Senha incorreta.' });
  }
  const name = cleanName(msg.name);
  if (!name) return send(ws, { type: 'error', code: 'name', message: 'Escolha um nome.' });

  let p = msg.resume ? participants.get(msg.resume.id) : null;
  const resumed = !!p && p.token === msg.resume.token;
  if (resumed) {
    clearTimeout(p.leaveTimer);
    p.leaveTimer = null;
    if (p.ws && p.ws !== ws) p.ws.close();
  } else {
    p = { id: newId(), token: newId(18), name, color: colorFor(name), joinedAt: Date.now() };
    participants.set(p.id, p);
  }
  p.ws = ws;
  p.online = true;
  p.name = name;
  p.micOn = !!msg.micOn;
  p.deafened = !!msg.deafened;
  ws.pid = p.id;

  send(ws, { type: 'welcome', resumed, you: { id: p.id, token: p.token }, state: snapshot() });
  if (resumed) {
    broadcast({ type: 'participant:updated', participant: publicParticipant(p) }, p.id);
  } else {
    broadcast({ type: 'participant:joined', participant: publicParticipant(p) }, p.id);
    systemChat(`${p.name} entrou`);
  }
}

function onSocketClose(ws) {
  const p = participants.get(ws.pid);
  if (!p || p.ws !== ws) return;
  p.ws = null;
  if (ws.leaving) return removeParticipant(p);
  // Dá um tempo para reconectar (troca de rede, celular dormindo) sem derrubar o que está no ar.
  p.online = false;
  broadcast({ type: 'participant:updated', participant: publicParticipant(p) });
  p.leaveTimer = setTimeout(() => removeParticipant(p), RECONNECT_GRACE_MS);
}

function removeParticipant(p) {
  if (participants.get(p.id) !== p) return;
  clearTimeout(p.leaveTimer);
  participants.delete(p.id);
  for (const s of [...streams.values()]) {
    if (s.ownerId !== p.id) continue;
    streams.delete(s.id);
    broadcast({ type: 'stream:removed', id: s.id });
  }
  for (const [sid, owner] of sessions) if (owner === p.id) sessions.delete(sid);
  broadcast({ type: 'participant:left', id: p.id });
  systemChat(`${p.name} saiu`);
  // Sala vazia: pausa a música para ela não "andar sozinha".
  if (!participants.size && music.playing) setPlaying(false);
}

// ---------- música ----------

function musicPosition() {
  return music.playing ? music.position + (Date.now() - music.since) / 1000 : music.position;
}

function musicState() {
  return { queue: music.queue, current: music.current, playing: music.playing, position: musicPosition(), serverTime: Date.now() };
}

function broadcastMusic() {
  broadcast({ type: 'music', music: musicState() });
}

function playItem(item) {
  music.current = item || null;
  music.position = 0;
  music.since = Date.now();
  music.playing = !!item;
  broadcastMusic();
}

function setPlaying(playing) {
  if (!music.current) return;
  music.position = musicPosition();
  music.since = Date.now();
  music.playing = playing;
  broadcastMusic();
}

function parseYouTubeId(input) {
  const text = input.trim();
  if (/^[\w-]{11}$/.test(text)) return text;
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www|m|music)\./, '');
  let id = null;
  if (host === 'youtu.be') id = url.pathname.split('/')[1];
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (url.pathname === '/watch') id = url.searchParams.get('v');
    else id = url.pathname.match(/^\/(?:shorts|embed|live|v)\/([^/?#]+)/)?.[1];
  }
  return id && /^[\w-]{11}$/.test(id) ? id : null;
}

async function videoInfo(videoId) {
  const url = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (res.status === 401 || res.status === 403) return { error: 'Esse vídeo não pode ser tocado aqui (é privado ou o dono bloqueou).' };
    if (res.status === 400 || res.status === 404) return { error: 'Vídeo não encontrado. Confere o link?' };
    if (!res.ok) return {};
    const data = await res.json();
    return { title: data.title, author: data.author_name };
  } catch {
    return {};
  }
}

function ytErrorText(code) {
  if (code === 100) return 'o vídeo foi removido ou é privado';
  if (code === 101 || code === 150) return 'o dono não deixa tocar fora do YouTube';
  return 'o YouTube recusou';
}

// ---------- uso do plano grátis ----------

function monthKey() {
  return new Date().toISOString().slice(0, 7);
}

function rollMonth() {
  const month = monthKey();
  if (usage.month !== month) {
    usage = { month, bytes: 0 };
    usageDirty = true;
  }
}

function addUsage(bytes) {
  rollMonth();
  usage.bytes += bytes;
  usageDirty = true;
}

function usageInfo() {
  rollMonth();
  const usedGB = usage.bytes / 1e9;
  return { usedGB: Math.round(usedGB * 100) / 100, limitGB: LIMIT_GB, blocked: usedGB >= LIMIT_GB };
}

async function loadUsage() {
  try {
    const saved = JSON.parse(await readFile(USAGE_FILE, 'utf8'));
    if (saved.month === monthKey() && Number.isFinite(saved.bytes)) usage = saved;
  } catch {
    // primeira vez rodando: começa do zero
  }
}

async function saveUsage() {
  if (!usageDirty) return;
  usageDirty = false;
  try {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(USAGE_FILE, JSON.stringify(usage));
  } catch (err) {
    console.error('Não consegui salvar o uso do mês:', err.message);
  }
}

// ---------- mensagens do WebSocket ----------

function validStream(s) {
  const ok = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;
  if (!s || typeof s !== 'object' || !ok(s.id, 64) || !STREAM_KINDS.has(s.kind) || !ok(s.sessionId, 128)) return null;
  if (!Array.isArray(s.tracks) || !s.tracks.length || s.tracks.length > 4) return null;
  const tracks = s.tracks.map((t) => ({ trackName: t?.trackName, kind: t?.kind }));
  if (!tracks.every((t) => ok(t.trackName, 128) && (t.kind === 'audio' || t.kind === 'video'))) return null;
  return { id: s.id, kind: s.kind, label: String(s.label ?? '').slice(0, 60), sessionId: s.sessionId, tracks };
}

const handlers = {
  update(p, msg) {
    if (typeof msg.micOn === 'boolean') p.micOn = msg.micOn;
    if (typeof msg.deafened === 'boolean') p.deafened = msg.deafened;
    if (msg.name !== undefined) {
      const name = cleanName(msg.name);
      if (name && name !== p.name) {
        systemChat(`${p.name} agora se chama ${name}`);
        p.name = name;
      }
    }
    broadcast({ type: 'participant:updated', participant: publicParticipant(p) });
  },

  'stream:publish'(p, msg) {
    const s = validStream(msg.stream);
    if (!s) return;
    const owner = sessions.get(s.sessionId);
    if (owner && owner !== p.id) return;
    const existing = streams.get(s.id);
    if (existing && existing.ownerId !== p.id) return;
    sessions.set(s.sessionId, p.id);
    const stream = { ...s, ownerId: p.id };
    streams.set(s.id, stream);
    broadcast({ type: 'stream:added', stream });
  },

  'stream:unpublish'(p, msg) {
    const s = streams.get(msg.id);
    if (!s || s.ownerId !== p.id) return;
    streams.delete(s.id);
    broadcast({ type: 'stream:removed', id: s.id });
  },

  chat(p, msg) {
    const text = String(msg.text ?? '').trim().slice(0, 1000);
    if (text) pushChat({ id: newId(), pid: p.id, name: p.name, color: p.color, text, ts: Date.now() });
  },

  async 'music:add'(p, msg) {
    const videoId = parseYouTubeId(String(msg.url ?? ''));
    if (!videoId) return send(p.ws, { type: 'notice', text: 'Esse link não parece ser do YouTube.' });
    if (music.queue.length >= 100) return send(p.ws, { type: 'notice', text: 'A fila está cheia.' });
    const info = await videoInfo(videoId);
    if (info.error) return send(p.ws, { type: 'notice', text: info.error });
    const item = { id: newId(), videoId, title: info.title || 'Vídeo do YouTube', author: info.author || '', by: p.name };
    if (music.current) {
      music.queue.push(item);
      broadcastMusic();
    } else {
      playItem(item);
    }
    systemChat(`${p.name} colocou ${item.title}`);
  },

  'music:play'() {
    setPlaying(true);
  },

  'music:pause'() {
    setPlaying(false);
  },

  'music:skip'(p, msg) {
    // itemId evita pular duas músicas quando duas pessoas clicam juntas
    if (music.current && msg.itemId === music.current.id) playItem(music.queue.shift());
  },

  'music:seek'(p, msg) {
    const t = Number(msg.t);
    if (!music.current || !Number.isFinite(t)) return;
    music.position = Math.max(0, Math.min(t, 86_400));
    music.since = Date.now();
    broadcastMusic();
  },

  'music:ended'(p, msg) {
    if (music.current && msg.itemId === music.current.id) playItem(music.queue.shift());
  },

  'music:error'(p, msg) {
    if (!music.current || msg.itemId !== music.current.id) return;
    systemChat(`Não deu para tocar ${music.current.title}: ${ytErrorText(msg.code)}`);
    playItem(music.queue.shift());
  },

  'music:duration'(p, msg) {
    const duration = Number(msg.duration);
    if (music.current && msg.itemId === music.current.id && duration > 0) music.current.duration = duration;
  },

  'music:remove'(p, msg) {
    const i = music.queue.findIndex((item) => item.id === msg.itemId);
    if (i < 0) return;
    music.queue.splice(i, 1);
    broadcastMusic();
  },

  usage(p, msg) {
    const bytes = Number(msg.bytes);
    if (Number.isFinite(bytes) && bytes > 0 && bytes < 2e9) addUsage(bytes);
  },

  leave(p, msg, ws) {
    ws.leaving = true;
    removeParticipant(p);
    ws.close();
  },
};

// Limite simples de mensagens por conexão (balde de fichas).
function allowMessage(ws) {
  const now = Date.now();
  ws.tokens = Math.min(60, ws.tokens + ((now - ws.lastRefill) / 1000) * 15);
  ws.lastRefill = now;
  if (ws.tokens < 1) return false;
  ws.tokens -= 1;
  return true;
}

// ---------- HTTP ----------

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '512kb' }));

app.get('/api/config', (req, res) => {
  res.json({ needsPassword: !!ROOM_PASSWORD, realtimeReady: !!(APP_ID && APP_SECRET), iceServers: ICE_SERVERS });
});

app.get('/api/presence', (req, res) => {
  const list = [...participants.values()];
  res.json({ count: list.length, names: ROOM_PASSWORD ? [] : list.map((p) => p.name) });
});

function requireParticipant(req, res, next) {
  const [pid, token] = (req.get('authorization') || '').replace(/^Bearer\s+/i, '').split(':');
  const p = participants.get(pid);
  if (!p || p.token !== token) {
    return res.status(401).json({ errorCode: 'unauthorized', errorDescription: 'Sua sessão expirou. Entre na sala de novo.' });
  }
  req.participant = p;
  next();
}

function requireRealtime(req, res, next) {
  if (APP_ID && APP_SECRET) return next();
  res.status(503).json({ errorCode: 'not_configured', errorDescription: 'O servidor ainda não tem as chaves do Cloudflare Realtime.' });
}

function ownSession(req, res, next) {
  const sid = req.params.sid;
  if (!/^[\w-]{1,128}$/.test(sid)) return badRequest(res);
  const owner = sessions.get(sid);
  if (owner && owner !== req.participant.id) {
    return res.status(403).json({ errorCode: 'forbidden', errorDescription: 'Essa sessão de mídia é de outra pessoa.' });
  }
  sessions.set(sid, req.participant.id);
  next();
}

function badRequest(res) {
  res.status(400).json({ errorCode: 'bad_request', errorDescription: 'Pedido inválido.' });
}

function cleanTracks(list) {
  if (!Array.isArray(list) || !list.length || list.length > 16) return null;
  const out = [];
  for (const t of list) {
    if (!t || typeof t !== 'object') return null;
    const entry = {};
    if (t.location === 'local' || t.location === 'remote') entry.location = t.location;
    for (const key of ['mid', 'trackName', 'sessionId']) {
      if (typeof t[key] === 'string' && t[key].length <= 128) entry[key] = t[key];
    }
    out.push(entry);
  }
  return out;
}

// undefined = não veio; null = veio inválido
function cleanSdp(sd) {
  if (sd === undefined || sd === null) return undefined;
  if ((sd.type !== 'offer' && sd.type !== 'answer') || typeof sd.sdp !== 'string' || sd.sdp.length > 300_000) return null;
  return { type: sd.type, sdp: sd.sdp };
}

async function realtime(method, pathname, body) {
  const res = await fetch(RTC_BASE + pathname, {
    method,
    headers: { Authorization: `Bearer ${APP_SECRET}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const data = await res
    .json()
    .catch(() => ({ errorCode: 'bad_response', errorDescription: `Resposta inesperada do Cloudflare (${res.status}).` }));
  if (!res.ok) console.warn(`Realtime ${method} ${pathname} -> ${res.status} ${data?.errorCode || ''}`);
  return { status: res.status, data };
}

const rtc = express.Router();
rtc.use(requireParticipant, requireRealtime);

rtc.post('/sessions', async (req, res) => {
  const r = await realtime('POST', '/sessions/new');
  if (r.data?.sessionId) sessions.set(r.data.sessionId, req.participant.id);
  res.status(r.status).json(r.data);
});

rtc.post('/sessions/:sid/tracks', ownSession, async (req, res) => {
  const tracks = cleanTracks(req.body?.tracks);
  const sessionDescription = cleanSdp(req.body?.sessionDescription);
  if (!tracks || sessionDescription === null) return badRequest(res);
  if (usageInfo().blocked && tracks.some((t) => t.trackName?.endsWith(':video'))) {
    return res.status(429).json({ errorCode: 'quota', errorDescription: 'O limite gratuito de vídeo deste mês acabou.' });
  }
  const r = await realtime('POST', `/sessions/${req.params.sid}/tracks/new`, { sessionDescription, tracks });
  res.status(r.status).json(r.data);
});

rtc.put('/sessions/:sid/renegotiate', ownSession, async (req, res) => {
  const sessionDescription = cleanSdp(req.body?.sessionDescription);
  if (!sessionDescription) return badRequest(res);
  const r = await realtime('PUT', `/sessions/${req.params.sid}/renegotiate`, { sessionDescription });
  res.status(r.status).json(r.data);
});

rtc.put('/sessions/:sid/close', ownSession, async (req, res) => {
  const list = Array.isArray(req.body?.tracks) ? req.body.tracks : [];
  const tracks = list.filter((t) => typeof t?.mid === 'string').slice(0, 16).map((t) => ({ mid: t.mid }));
  const sessionDescription = cleanSdp(req.body?.sessionDescription);
  if (!tracks.length || sessionDescription === null) return badRequest(res);
  const r = await realtime('PUT', `/sessions/${req.params.sid}/tracks/close`, { tracks, sessionDescription, force: !!req.body.force });
  res.status(r.status).json(r.data);
});

app.use('/api/rtc', rtc);
app.use(
  express.static(path.join(ROOT, 'public'), {
    setHeaders(res) {
      res.setHeader('Cache-Control', 'no-cache');
    },
  }),
);

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(502).json({ errorCode: 'upstream', errorDescription: 'Falha ao falar com o Cloudflare Realtime.' });
});

// ---------- inicialização ----------

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.tokens = 60;
  ws.lastRefill = Date.now();
  ws.on('pong', () => {
    ws.isAlive = true;
  });
  ws.on('message', (raw) => {
    if (!allowMessage(ws)) return;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'ping') return send(ws, { type: 'pong', t0: msg.t0, ts: Date.now() });
    if (msg.type === 'join') return handleJoin(ws, msg);
    const p = participants.get(ws.pid);
    const handler = Object.hasOwn(handlers, msg.type) ? handlers[msg.type] : null;
    if (!p || p.ws !== ws || !handler) return;
    Promise.resolve(handler(p, msg, ws)).catch((err) => console.error(`Erro em ${msg.type}:`, err));
  });
  ws.on('close', () => onSocketClose(ws));
});

await loadUsage();

setInterval(saveUsage, 30_000);
setInterval(() => {
  if (participants.size) broadcast({ type: 'usage', usage: usageInfo() });
}, 30_000);
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await saveUsage();
    process.exit(0);
  });
}

server.listen(PORT, () => {
  const realtimeNote = APP_ID && APP_SECRET ? '' : ' (sem chaves do Cloudflare Realtime: voz e vídeo desligados)';
  console.log(`Sala Privada rodando na porta ${PORT}${realtimeNote}`);
});
