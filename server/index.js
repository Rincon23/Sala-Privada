// Servidor da Sala Privada: entrega o site, faz a sinalização por WebSocket
// (quem está na sala, o que está no ar, chat, música e arquivos) e repassa as
// chamadas para o Cloudflare Realtime. O segredo do app do Realtime nunca sai daqui.
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, statfs, truncate, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 8380;
const APP_ID = (process.env.REALTIME_APP_ID || '').trim();
const APP_SECRET = (process.env.REALTIME_APP_SECRET || '').trim();
const ROOM_PASSWORD = process.env.ROOM_PASSWORD || '';
const LIMIT_GB = Number(process.env.MONTHLY_LIMIT_GB) || 900;
const FILE_TTL_HOURS = Number(process.env.FILE_TTL_HOURS) || 24;
const FILE_MAX_GB = Number(process.env.FILE_MAX_GB) || 10;
const FILES_TOTAL_GB = Number(process.env.FILES_TOTAL_GB) || 50;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const USAGE_FILE = path.join(DATA_DIR, 'usage.json');
const FILES_DIR = path.join(DATA_DIR, 'files');
const FILES_INDEX = path.join(DATA_DIR, 'files.json');
const SOUNDS_DIR = path.join(DATA_DIR, 'sounds');
const SOUNDS_INDEX = path.join(DATA_DIR, 'sounds.json');
const SOUND_MAX_BYTES = 2 * 1024 * 1024;
const SOUNDS_MAX = 200;
// Sons que já vêm na mesa (gerados por scripts/make-sounds.mjs).
const DEFAULT_SOUNDS = [
  ['corneta', 'Corneta', '📯'],
  ['trombone-triste', 'Trombone triste', '🎺'],
  ['ba-dum-tss', 'Ba dum tss', '🥁'],
  ['boing', 'Boing', '🌀'],
  ['errou', 'Errou', '❌'],
  ['acertou', 'Acertou', '✅'],
  ['grilos', 'Grilos', '🦗'],
  ['suspense', 'Suspense', '😱'],
  ['aplausos', 'Aplausos', '👏'],
  ['explosao', 'Explosão', '💥'],
  ['pum', 'Pum', '💨'],
].map(([id, name, emoji]) => ({ id, name, emoji, url: `/sounds/${id}.wav`, builtin: true }));
// O Cloudflare não deixa passar pedidos de mais de 100 MB, então o envio vai em pedaços.
const CHUNK_BYTES = 32 * 1024 * 1024;
const GB = 1e9;
const RTC_BASE = `https://rtc.live.cloudflare.com/v1/apps/${encodeURIComponent(APP_ID)}`;
const ICE_SERVERS = [{ urls: 'stun:stun.cloudflare.com:3478' }];
const RECONNECT_GRACE_MS = 15_000;
const STREAM_KINDS = new Set(['mic', 'camera', 'screen']);
const COLORS = ['#7c6cff', '#ff6b9a', '#34d399', '#f5a524', '#38bdf8', '#fb7185', '#c084fc', '#2dd4bf', '#f97316'];

const newId = (bytes = 6) => randomBytes(bytes).toString('base64url');

// Muda sempre que os arquivos do site mudam; quem está com a versão antiga aberta é avisado.
async function siteVersion(dir = path.join(ROOT, 'public')) {
  const hash = createHash('sha1');
  const walk = async (current) => {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else hash.update(entry.name).update(await readFile(full));
    }
  };
  await walk(dir);
  return hash.digest('hex').slice(0, 10);
}

const APP_VERSION = await siteVersion();

// ---------- log que explica o que aconteceu e o que fazer ----------

const logSeen = new Map();

// Repetições do mesmo aviso em menos de 1 minuto viram um contador, para o log não lotar.
function log(level, who, text, action, key) {
  const dedupe = key || `${level}|${who}|${text}`;
  const now = Date.now();
  const seen = logSeen.get(dedupe);
  if (seen && now - seen.at < 60_000) {
    seen.skipped++;
    return;
  }
  const repeats = seen?.skipped ? ` (aconteceu mais ${seen.skipped}x antes deste)` : '';
  logSeen.set(dedupe, { at: now, skipped: 0 });
  const time = new Date().toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'medium' });
  const line = `${time} [${level}] ${who ? `${who}: ` : ''}${text}${repeats}${action ? `\n    → O que fazer: ${action}` : ''}`;
  if (level === 'ERRO') console.error(line);
  else console.log(line);
}

setInterval(() => {
  const cutoff = Date.now() - 10 * 60_000;
  for (const [key, seen] of logSeen) if (seen.at < cutoff) logSeen.delete(key);
}, 10 * 60_000);

const who = (p) => (p ? `${p.name} (${p.device})` : '');

function shortDevice(ua = '') {
  let browser = 'navegador desconhecido';
  if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/OPR\//.test(ua)) browser = 'Opera';
  else if (/Firefox\//.test(ua)) browser = 'Firefox';
  else if (/Chrome\//.test(ua)) browser = 'Chrome/Brave';
  else if (/Safari\//.test(ua)) browser = 'Safari';
  let os = '';
  if (/Android/.test(ua)) os = 'Android';
  else if (/iPhone|iPad/.test(ua)) os = 'iPhone/iPad';
  else if (/Windows/.test(ua)) os = 'Windows';
  else if (/Mac OS X/.test(ua)) os = 'Mac';
  else if (/Linux/.test(ua)) os = 'Linux';
  return os ? `${browser} no ${os}` : browser;
}

function fmtBytes(bytes) {
  if (bytes >= GB) return `${(bytes / GB).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

// Erros do Cloudflare Realtime: [o que aconteceu, o que fazer]. null = não vale logar.
const CF_EXPLAIN = {
  unauthorized: [
    'o Cloudflare recusou as chaves do Realtime',
    'confira REALTIME_APP_ID e REALTIME_APP_SECRET no .env e rode "docker compose up -d --force-recreate"',
  ],
  not_found: ['o app do Realtime não foi encontrado', 'confira o REALTIME_APP_ID no .env'],
  session_error: [
    'a conexão de mídia dessa pessoa expirou no Cloudflare',
    'nada: o app dela abre uma conexão nova sozinho. Se repetir muito com a mesma pessoa, a rede dela pode estar bloqueando chamadas (VPN ou Wi-Fi de empresa)',
  ],
  invalid_session_description: [
    'o Cloudflare recusou a negociação de mídia do navegador',
    'nada: o app recria a conexão sozinho. Se repetir, a pessoa deve recarregar a página ou usar Chrome, Edge ou Brave atualizado',
  ],
  invalid_params: [
    'o Cloudflare recusou o pedido (normalmente a transmissão tinha acabado de ser encerrada)',
    'nada se for raro. Se repetir, guarde este trecho do log para análise',
  ],
  not_found_track_error: [
    'a transmissão pedida não existe mais ou ainda não começou a enviar',
    'nada: o app tenta de novo. Se não resolver, quem transmite deve parar e compartilhar de novo',
  ],
  empty_track_error: ['a transmissão existe, mas não está chegando nada dela', 'quem transmite deve conferir a internet ou compartilhar de novo'],
  close_track_error: null,
  retryable_transient_error: ['instabilidade passageira no Cloudflare', 'nada: o app tenta de novo'],
  temporarily_unavailable_error: ['o Cloudflare está temporariamente indisponível', 'nada: o app tenta de novo. Se durar, veja cloudflarestatus.com'],
  transport_unavailable_error: [
    'o Cloudflare não conseguiu montar o caminho da mídia',
    'nada: o app tenta de novo. Se repetir, a rede da pessoa pode estar bloqueando chamadas',
  ],
  backend_error: ['erro interno do Cloudflare', 'se durar, veja cloudflarestatus.com'],
  internal_error: ['erro interno do Cloudflare', 'se durar, veja cloudflarestatus.com'],
};

function logRealtimeError(ctx, code, description, status) {
  if (CF_EXPLAIN[code] === null) return;
  const [what, todo] = CF_EXPLAIN[code] || ['o Cloudflare respondeu com um erro inesperado', 'se repetir, guarde este trecho do log para análise'];
  const detail = `${status ? `${status} ` : ''}${code}${description ? `: ${description}` : ''}`;
  log('ERRO', who(ctx.p), `ao ${ctx.action}, ${what} [${detail}]`, todo, `${ctx.p?.id}|cf|${code}`);
}

// ---------- estado da sala (só em memória, exceto uso do mês e arquivos) ----------

const participants = new Map();
const streams = new Map();
const sessions = new Map(); // sessionId do Realtime -> id do participante dono
const stallReports = new Map(); // id da transmissão -> Map(id de quem reclamou -> quando)
const files = new Map();
const sounds = new Map();
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
    files: [...files.values()].filter((f) => f.complete).map(publicFile),
    sounds: allSounds(),
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

const clip = (value, max) => String(value ?? '').slice(0, max);

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

function describeStream(s) {
  const owner = participants.get(s.ownerId)?.name || 'alguém';
  if (s.kind === 'mic') return `o áudio de ${owner}`;
  if (s.kind === 'camera') return `a câmera de ${owner}`;
  return `"${s.label}" de ${owner}`;
}

const SEND_NAMES = { mic: 'o microfone', cam: 'a câmera', screen: 'uma tela' };

function describeTracks(tracks) {
  const parts = tracks.map((t) => {
    const streamId = String(t.trackName || '').split(':')[0];
    if (t.location === 'remote') {
      const s = streams.get(streamId);
      return s ? `receber ${describeStream(s)}` : 'receber uma transmissão que já acabou';
    }
    return `enviar ${SEND_NAMES[streamId.split('-')[0]] || 'mídia'}`;
  });
  return [...new Set(parts)].join(' e ');
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
  p.device = ws.device;
  p.micOn = !!msg.micOn;
  p.deafened = !!msg.deafened;
  ws.pid = p.id;

  send(ws, { type: 'welcome', resumed, version: APP_VERSION, you: { id: p.id, token: p.token }, state: snapshot() });
  if (msg.version !== APP_VERSION) {
    log(
      'AVISO',
      who(p),
      msg.version ? 'está com uma versão antiga do app aberta' : 'está com uma versão bem antiga do app aberta (de antes do aviso de atualização)',
      `${p.name} deve apertar F5 na página da sala (ou clicar em "Atualizar" no aviso). Versões antigas têm erros já corrigidos`,
      `${p.id}|version`,
    );
    // Versões antigas não sabem comparar a versão sozinhas; o aviso simples elas entendem.
    if (!msg.version) send(ws, { type: 'notice', text: 'Saiu uma versão nova da Sala Privada com correções. Aperte F5 para atualizar.' });
  }
  if (resumed) {
    broadcast({ type: 'participant:updated', participant: publicParticipant(p) }, p.id);
    log('INFO', who(p), 'reconectou ao servidor');
  } else {
    broadcast({ type: 'participant:joined', participant: publicParticipant(p) }, p.id);
    systemChat(`${p.name} entrou`);
    log('INFO', who(p), `entrou na sala (${participants.size} ${participants.size === 1 ? 'pessoa' : 'pessoas'} agora)`);
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
  log('INFO', who(p), `perdeu a conexão com o servidor; esperando ${RECONNECT_GRACE_MS / 1000}s para voltar`);
  p.leaveTimer = setTimeout(() => {
    log('AVISO', who(p), 'não voltou a tempo e foi tirado da sala', 'nada: quando a internet dela voltar, o app entra de novo sozinho');
    removeParticipant(p);
  }, RECONNECT_GRACE_MS);
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
  log('INFO', who(p), 'saiu da sala');
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
  const before = usageInfo().blocked;
  rollMonth();
  usage.bytes += bytes;
  usageDirty = true;
  if (!before && usageInfo().blocked) {
    log(
      'AVISO',
      null,
      `o uso do mês chegou em ${LIMIT_GB} GB: câmera e telas foram pausadas até o mês virar (a voz continua)`,
      'nada, para não haver cobrança. Para liberar mais, aumente MONTHLY_LIMIT_GB no .env (acima de 1.000 GB o Cloudflare cobra US$ 0,05 por GB)',
    );
    broadcast({ type: 'usage', usage: usageInfo() });
  }
}

function usageInfo() {
  rollMonth();
  const usedGB = usage.bytes / GB;
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
    log('ERRO', null, `não consegui salvar o uso do mês (${err.message})`, 'confira se o volume /data do container existe e tem espaço');
  }
}

// ---------- arquivos que somem sozinhos ----------

function publicFile(f) {
  return { id: f.id, name: f.name, size: f.size, ownerId: f.ownerId, ownerName: f.ownerName, createdAt: f.createdAt, expiresAt: f.expiresAt };
}

const filePath = (id) => path.join(FILES_DIR, id);

function cleanFileName(name) {
  return String(name ?? '')
    .replace(/[\\/\0\r\n]/g, '_')
    .trim()
    .slice(0, 200);
}

async function saveFiles() {
  try {
    await writeFile(FILES_INDEX, JSON.stringify([...files.values()].filter((f) => f.complete)));
  } catch (err) {
    log('ERRO', null, `não consegui salvar a lista de arquivos (${err.message})`, 'confira o espaço em disco do servidor');
  }
}

async function loadFiles() {
  await mkdir(FILES_DIR, { recursive: true });
  try {
    for (const f of JSON.parse(await readFile(FILES_INDEX, 'utf8'))) if (f.complete) files.set(f.id, f);
  } catch {
    // ainda não há arquivos
  }
  // Envios interrompidos por um reinício ficam no disco sem estar na lista: apaga.
  for (const name of await readdir(FILES_DIR)) {
    if (!files.has(name)) await unlink(filePath(name)).catch(() => {});
  }
  await sweepFiles();
}

async function removeFile(f) {
  files.delete(f.id);
  await unlink(filePath(f.id)).catch(() => {});
  if (!f.complete) return;
  broadcast({ type: 'file:removed', id: f.id });
  await saveFiles();
}

async function sweepFiles() {
  const now = Date.now();
  for (const f of [...files.values()]) {
    if (f.complete && f.expiresAt <= now) {
      await removeFile(f);
      log('INFO', null, `o arquivo "${f.name}" (${fmtBytes(f.size)}) expirou e foi apagado`);
    } else if (!f.complete && !f.writing && now - f.updatedAt > 30 * 60_000) {
      await removeFile(f);
      log('INFO', null, `o envio de "${f.name}" ficou parado por 30 min e foi descartado`);
    }
  }
}

// ---------- mesa de sons ----------

function publicSound(s) {
  return { id: s.id, name: s.name, emoji: s.emoji, ownerId: s.ownerId, ownerName: s.ownerName, url: `/api/sounds/${s.id}`, builtin: false };
}

function allSounds() {
  return [...DEFAULT_SOUNDS, ...[...sounds.values()].sort((a, b) => a.createdAt - b.createdAt).map(publicSound)];
}

async function saveSounds() {
  try {
    await writeFile(SOUNDS_INDEX, JSON.stringify([...sounds.values()]));
  } catch (err) {
    log('ERRO', null, `não consegui salvar a lista de sons (${err.message})`, 'confira o espaço em disco do servidor');
  }
}

async function loadSounds() {
  await mkdir(SOUNDS_DIR, { recursive: true });
  try {
    for (const s of JSON.parse(await readFile(SOUNDS_INDEX, 'utf8'))) sounds.set(s.id, s);
  } catch {
    // ainda não há sons adicionados
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
    if (existing) log('INFO', who(p), `refez a transmissão de ${describeStream(stream)} numa conexão nova`);
    else if (s.kind !== 'mic') log('INFO', who(p), `começou a transmitir ${describeStream(stream)}`);
  },

  'stream:unpublish'(p, msg) {
    const s = streams.get(msg.id);
    if (!s || s.ownerId !== p.id) return;
    streams.delete(s.id);
    broadcast({ type: 'stream:removed', id: s.id });
    if (s.kind !== 'mic') log('INFO', who(p), `parou de transmitir ${describeStream(s)}`);
  },

  // O navegador avisa que parou de chegar algo de alguém.
  health(p, msg) {
    const s = streams.get(msg.streamId);
    if (!s) return;
    const owner = participants.get(s.ownerId);
    const now = Date.now();
    const reports = stallReports.get(s.id) || new Map();
    reports.set(p.id, now);
    for (const [pid, at] of reports) if (now - at > 30_000) reports.delete(pid);
    stallReports.set(s.id, reports);
    log('AVISO', who(p), `parou de receber ${describeStream(s)}; o app refez essa recepção sozinho`, null, `${p.id}|stall|${s.id}`);
    // Repetiu depois de refazer, ou mais de uma pessoa reclamou: o problema é de quem transmite.
    if ((msg.repeated || reports.size >= 2) && owner?.ws && now - (s.lastRepublish || 0) > 45_000) {
      s.lastRepublish = now;
      send(owner.ws, { type: 'republish', streamId: s.id });
      log(
        'AVISO',
        who(owner),
        `${reports.size >= 2 ? `${reports.size} pessoas` : p.name} continuavam sem receber ${describeStream(s)}; pedi para o app de ${owner.name} refazer a transmissão`,
        `nada, é automático. Se repetir, ${owner.name} deve recarregar a página ou trocar de rede (desligar VPN, usar outro Wi-Fi ou 4G)`,
      );
    }
  },

  // Erros que o navegador percebeu, já com a explicação para quem está na sala.
  'client-error'(p, msg) {
    const code = clip(msg.code, 60);
    const detail = clip(msg.detail, 300);
    const text = clip(msg.text, 300);
    const extra = detail && !text.includes(detail) ? ` [${code}: ${detail}]` : ` [${code}]`;
    log('ERRO', who(p), `${text}${extra}`, clip(msg.action, 300), `${p.id}|client|${code}|${clip(msg.what, 20)}`);
  },

  // Quem clicou já tocou na hora; os outros recebem o aviso para tocar também.
  'sound:play'(p, msg) {
    const id = String(msg.id ?? '');
    if (!DEFAULT_SOUNDS.some((s) => s.id === id) && !sounds.has(id)) return;
    const now = Date.now();
    if (now - (p.lastSound || 0) < 400) return;
    p.lastSound = now;
    broadcast({ type: 'sound:play', id, by: p.name }, p.id);
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
    log('AVISO', who(p), `o YouTube não tocou "${music.current.title}" (${ytErrorText(msg.code)}); pulei para a próxima`, 'escolher outro vídeo da mesma música');
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
  res.json({
    needsPassword: !!ROOM_PASSWORD,
    realtimeReady: !!(APP_ID && APP_SECRET),
    iceServers: ICE_SERVERS,
    version: APP_VERSION,
    fileMaxGB: FILE_MAX_GB,
    fileTtlHours: FILE_TTL_HOURS,
  });
});

app.get('/api/presence', (req, res) => {
  const list = [...participants.values()];
  res.json({ count: list.length, names: ROOM_PASSWORD ? [] : list.map((p) => p.name) });
});

function participantFrom(value) {
  const [pid, token] = String(value || '').split(':');
  const p = participants.get(pid);
  return p && p.token === token ? p : null;
}

function requireParticipant(req, res, next) {
  const p = participantFrom((req.get('authorization') || '').replace(/^Bearer\s+/i, ''));
  if (!p) return res.status(401).json({ errorCode: 'unauthorized', errorDescription: 'Sua sessão expirou. Entre na sala de novo.' });
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

async function realtime(method, pathname, body, ctx) {
  let res;
  try {
    res = await fetch(RTC_BASE + pathname, {
      method,
      headers: { Authorization: `Bearer ${APP_SECRET}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    log(
      'ERRO',
      who(ctx.p),
      `ao ${ctx.action}, o servidor não conseguiu falar com o Cloudflare (${err.message})`,
      'confira a internet do servidor (ex.: "ping 1.1.1.1"). Se estiver ok, veja cloudflarestatus.com',
      'cf-network',
    );
    return { status: 502, data: { errorCode: 'upstream', errorDescription: 'O servidor não conseguiu falar com o Cloudflare.' } };
  }
  const data = await res
    .json()
    .catch(() => ({ errorCode: 'bad_response', errorDescription: `Resposta inesperada do Cloudflare (${res.status}).` }));
  if (!res.ok || data.errorCode) logRealtimeError(ctx, data.errorCode || `http_${res.status}`, data.errorDescription, res.status);
  for (const t of data.tracks || []) if (t.errorCode) logRealtimeError(ctx, t.errorCode, t.errorDescription);
  return { status: res.status, data };
}

const rtc = express.Router();
rtc.use(requireParticipant, requireRealtime);

rtc.post('/sessions', async (req, res) => {
  const r = await realtime('POST', '/sessions/new', undefined, { p: req.participant, action: 'abrir uma conexão de mídia' });
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
  const ctx = { p: req.participant, action: describeTracks(tracks) };
  const r = await realtime('POST', `/sessions/${req.params.sid}/tracks/new`, { sessionDescription, tracks }, ctx);
  res.status(r.status).json(r.data);
});

rtc.put('/sessions/:sid/renegotiate', ownSession, async (req, res) => {
  const sessionDescription = cleanSdp(req.body?.sessionDescription);
  if (!sessionDescription) return badRequest(res);
  const ctx = { p: req.participant, action: 'confirmar a negociação de mídia' };
  const r = await realtime('PUT', `/sessions/${req.params.sid}/renegotiate`, { sessionDescription }, ctx);
  res.status(r.status).json(r.data);
});

rtc.put('/sessions/:sid/close', ownSession, async (req, res) => {
  const list = Array.isArray(req.body?.tracks) ? req.body.tracks : [];
  const tracks = list.filter((t) => typeof t?.mid === 'string').slice(0, 16).map((t) => ({ mid: t.mid }));
  const sessionDescription = cleanSdp(req.body?.sessionDescription);
  if (!tracks.length || sessionDescription === null) return badRequest(res);
  const ctx = { p: req.participant, action: 'encerrar uma transmissão' };
  const body = { tracks, sessionDescription, force: !!req.body.force };
  const r = await realtime('PUT', `/sessions/${req.params.sid}/tracks/close`, body, ctx);
  res.status(r.status).json(r.data);
});

app.use('/api/rtc', rtc);

// Downloads usam um cookie, porque um link comum não manda cabeçalho de autorização.
app.post('/api/auth-cookie', requireParticipant, (req, res) => {
  const p = req.participant;
  res.cookie('sala_auth', `${p.id}:${p.token}`, {
    httpOnly: true,
    sameSite: 'strict',
    secure: req.get('x-forwarded-proto') === 'https',
    path: '/api',
    maxAge: 7 * 24 * 3600_000,
  });
  res.json({ ok: true });
});

const fileRoutes = express.Router();

fileRoutes.post('/', requireParticipant, async (req, res) => {
  const p = req.participant;
  const name = cleanFileName(req.body?.name);
  const size = Number(req.body?.size);
  if (!name || !Number.isSafeInteger(size) || size <= 0) return badRequest(res);
  if (size > FILE_MAX_GB * GB) {
    return res.status(413).json({ errorCode: 'file_too_large', errorDescription: `"${name}" passa do limite de ${FILE_MAX_GB} GB por arquivo.` });
  }
  const reserved = [...files.values()].reduce((sum, f) => sum + f.size, 0);
  let free = Infinity;
  try {
    const fs = await statfs(FILES_DIR);
    free = fs.bavail * fs.bsize;
  } catch {
    // sem informação de disco: confia só no limite do .env
  }
  if (reserved + size > FILES_TOTAL_GB * GB || size > free - 2 * GB) {
    log(
      'AVISO',
      who(p),
      `não deu para enviar "${name}" (${fmtBytes(size)}): ${fmtBytes(reserved)} de ${FILES_TOTAL_GB} GB de arquivos em uso e ${fmtBytes(free)} livres no disco`,
      'esperar arquivos expirarem, apagar algum na aba Arquivos, ou aumentar FILES_TOTAL_GB no .env',
    );
    return res.status(507).json({ errorCode: 'storage_full', errorDescription: 'Sem espaço para arquivos no servidor.' });
  }
  const now = Date.now();
  const f = { id: newId(9), name, size, ownerId: p.id, ownerName: p.name, createdAt: now, updatedAt: now, expiresAt: 0, received: 0, complete: false, writing: false };
  files.set(f.id, f);
  await writeFile(filePath(f.id), '');
  res.json({ id: f.id, chunkSize: CHUNK_BYTES });
});

fileRoutes.put('/:id/chunk', requireParticipant, async (req, res) => {
  const f = files.get(req.params.id);
  if (!f || f.complete) return res.status(404).json({ errorCode: 'not_found', errorDescription: 'Esse envio não existe mais.' });
  if (f.ownerId !== req.participant.id) return res.status(403).json({ errorCode: 'forbidden', errorDescription: 'Esse envio é de outra pessoa.' });
  const offset = Number(req.query.offset);
  if (f.writing || offset !== f.received) {
    return res.status(409).json({ errorCode: 'offset', errorDescription: 'Pedaço fora de ordem.', received: f.received });
  }
  f.writing = true;
  const limit = Math.min(CHUNK_BYTES, f.size - f.received);
  let written = 0;
  const counter = new Transform({
    transform(chunk, encoding, done) {
      written += chunk.length;
      done(written > limit ? new Error('pedaço maior que o combinado') : null, chunk);
    },
  });
  try {
    await truncate(filePath(f.id), f.received);
    await pipeline(req, counter, createWriteStream(filePath(f.id), { flags: 'a' }));
    f.received += written;
    f.updatedAt = Date.now();
  } catch {
    await truncate(filePath(f.id), f.received).catch(() => {});
    return res.status(400).json({ errorCode: 'chunk_failed', errorDescription: 'Um pedaço do arquivo chegou incompleto.', received: f.received });
  } finally {
    f.writing = false;
  }
  if (f.received === f.size) {
    f.complete = true;
    f.expiresAt = Date.now() + FILE_TTL_HOURS * 3600_000;
    await saveFiles();
    broadcast({ type: 'file:added', file: publicFile(f) });
    systemChat(`${f.ownerName} enviou ${f.name} (${fmtBytes(f.size)}). Fica disponível por ${FILE_TTL_HOURS} h na aba Arquivos.`);
    log('INFO', who(req.participant), `enviou o arquivo "${f.name}" (${fmtBytes(f.size)}); some em ${FILE_TTL_HOURS} h`);
  }
  res.json({ received: f.received, complete: f.complete });
});

fileRoutes.delete('/:id', requireParticipant, async (req, res) => {
  const p = req.participant;
  const f = files.get(req.params.id);
  if (!f) return res.json({ ok: true });
  if (f.ownerId !== p.id && f.ownerName !== p.name) {
    return res.status(403).json({ errorCode: 'forbidden', errorDescription: 'Só quem enviou pode apagar.' });
  }
  await removeFile(f);
  if (f.complete) log('INFO', who(p), `apagou o arquivo "${f.name}"`);
  res.json({ ok: true });
});

function cookieParticipant(req) {
  const cookie = /(?:^|;\s*)sala_auth=([^;]+)/.exec(req.headers.cookie || '')?.[1];
  return participantFrom(decodeURIComponent(cookie || ''));
}

fileRoutes.get('/:id', (req, res) => {
  if (!cookieParticipant(req)) {
    return res.status(401).type('text/plain; charset=utf-8').send('Entre na sala para baixar este arquivo.');
  }
  const f = files.get(req.params.id);
  if (!f?.complete) return res.status(404).type('text/plain; charset=utf-8').send('Esse arquivo já expirou ou foi apagado.');
  res.download(filePath(f.id), f.name, { headers: { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' } });
});

app.use('/api/files', fileRoutes);

const soundRoutes = express.Router();

// O áudio vem cru no corpo; nome e emoji vão nos cabeçalhos.
soundRoutes.post('/', requireParticipant, express.raw({ type: () => true, limit: SOUND_MAX_BYTES }), async (req, res) => {
  const p = req.participant;
  const type = String(req.get('content-type') || '').split(';')[0].trim();
  const header = (key) => {
    try {
      return decodeURIComponent(req.get(key) || '');
    } catch {
      return '';
    }
  };
  const name = cleanName(header('x-sound-name')).slice(0, 24);
  const emoji = [...header('x-sound-emoji').trim()].slice(0, 2).join('') || '🔊';
  if (!name || !/^(audio|video)\//.test(type) || !Buffer.isBuffer(req.body) || !req.body.length) {
    return res.status(400).json({ errorCode: 'bad_sound', errorDescription: 'Mande um arquivo de áudio e um nome para o som.' });
  }
  if (sounds.size >= SOUNDS_MAX) {
    return res.status(507).json({ errorCode: 'sounds_full', errorDescription: `A mesa já tem ${SOUNDS_MAX} sons. Apague algum antes.` });
  }
  const s = { id: newId(9), name, emoji, type, ownerId: p.id, ownerName: p.name, createdAt: Date.now() };
  await writeFile(path.join(SOUNDS_DIR, s.id), req.body);
  sounds.set(s.id, s);
  await saveSounds();
  broadcast({ type: 'sound:added', sound: publicSound(s) });
  systemChat(`${p.name} colocou o som ${emoji} ${name} na mesa`);
  log('INFO', who(p), `adicionou o som "${name}" (${fmtBytes(req.body.length)})`);
  res.json(publicSound(s));
});

soundRoutes.get('/:id', (req, res) => {
  if (!cookieParticipant(req)) return res.status(401).end();
  const s = sounds.get(req.params.id);
  if (!s) return res.status(404).end();
  res.sendFile(path.join(SOUNDS_DIR, s.id), {
    headers: { 'Content-Type': s.type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=86400' },
  });
});

soundRoutes.delete('/:id', requireParticipant, async (req, res) => {
  const p = req.participant;
  const s = sounds.get(req.params.id);
  if (!s) return res.json({ ok: true });
  if (s.ownerId !== p.id && s.ownerName !== p.name) {
    return res.status(403).json({ errorCode: 'forbidden', errorDescription: 'Só quem adicionou pode tirar o som.' });
  }
  sounds.delete(s.id);
  await unlink(path.join(SOUNDS_DIR, s.id)).catch(() => {});
  await saveSounds();
  broadcast({ type: 'sound:removed', id: s.id });
  log('INFO', who(p), `tirou o som "${s.name}" da mesa`);
  res.json({ ok: true });
});

app.use('/api/sounds', soundRoutes);

app.use(
  express.static(path.join(ROOT, 'public'), {
    setHeaders(res) {
      res.setHeader('Cache-Control', 'no-cache');
    },
  }),
);

app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ errorCode: 'file_too_large', errorDescription: 'O arquivo passa do tamanho máximo.' });
  }
  log('ERRO', null, `erro inesperado em ${req.method} ${req.path}: ${err.message}`, 'se repetir, guarde este trecho do log para análise');
  if (res.headersSent) return next(err);
  res.status(500).json({ errorCode: 'server_error', errorDescription: 'Erro inesperado no servidor.' });
});

// ---------- inicialização ----------

const server = createServer(app);
// Uploads grandes por conexões lentas não podem cair no tempo limite padrão.
server.requestTimeout = 0;
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.tokens = 60;
  ws.lastRefill = Date.now();
  ws.device = shortDevice(req.headers['user-agent']);
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
    Promise.resolve(handler(p, msg, ws)).catch((err) => {
      log('ERRO', who(p), `falhou ao tratar "${msg.type}": ${err.message}`, 'se repetir, guarde este trecho do log para análise');
    });
  });
  ws.on('close', () => onSocketClose(ws));
});

await loadUsage();
await loadFiles();
await loadSounds();

setInterval(saveUsage, 30_000);
setInterval(sweepFiles, 5 * 60_000);
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
  log('INFO', null, `Sala Privada rodando na porta ${PORT}; arquivos somem em ${FILE_TTL_HOURS} h (até ${FILE_MAX_GB} GB cada)`);
  if (!APP_ID || !APP_SECRET) {
    log('AVISO', null, 'sem as chaves do Cloudflare Realtime: voz, câmera e telas estão desligados', 'preencha REALTIME_APP_ID e REALTIME_APP_SECRET no .env e rode "docker compose up -d --force-recreate"');
  }
  if (!ROOM_PASSWORD) log('AVISO', null, 'a sala está sem senha: qualquer pessoa com o link entra', 'se quiser, preencha ROOM_PASSWORD no .env');
});
