// Servidor da Sala Privada: entrega o site, faz a sinalização por WebSocket
// (quem está na sala, o que está no ar, chat, música e arquivos) e repassa as
// chamadas para o Cloudflare Realtime. O segredo do app do Realtime nunca sai daqui.
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { appendFile, mkdir, readdir, readFile, statfs, truncate, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import express from 'express';
import nodemailer from 'nodemailer';
import { WebSocketServer } from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 8380;
const APP_ID = (process.env.REALTIME_APP_ID || '').trim();
const APP_SECRET = (process.env.REALTIME_APP_SECRET || '').trim();
// Quem criar a conta com este e-mail (e confirmar) é o host.
const ADMIN_EMAIL = cleanEmail(process.env.ADMIN_EMAIL);
// Endereço do site nos links dos e-mails. Vazio = o endereço por onde o pedido chegou.
const PUBLIC_URL = (process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
const SMTP_HOST = (process.env.SMTP_HOST || '').trim();
const SMTP_PORT = Number(process.env.SMTP_PORT) || 465;
const SMTP_USER = (process.env.SMTP_USER || '').trim();
const SMTP_PASS = process.env.SMTP_PASS || '';
const MAIL_FROM = (process.env.MAIL_FROM || '').trim();
const VERIFY_MS = 24 * 3_600_000; // o link de confirmar o e-mail vale 24 h
const RESET_MS = 3_600_000; // o de trocar a senha, 1 h
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
const SOUND_MAX_BYTES = 10 * 1024 * 1024;
const SOUND_MAX_SECONDS = 180;
const SOUNDS_MAX = 200;
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const LOGINS_FILE = path.join(DATA_DIR, 'sessions.json');
const SERVERS_FILE = path.join(DATA_DIR, 'servers.json');
const SESSION_DAYS = 180;
const MAIN_SERVER = 'principal'; // o primeiro servidor, criado sozinho na primeira vez
const CHANNELS_FILE = path.join(DATA_DIR, 'channels.json');
const MESSAGES_DIR = path.join(DATA_DIR, 'messages');
const ATTACH_DIR = path.join(DATA_DIR, 'attachments');
const CHAT_FILE_MAX_MB = Number(process.env.CHAT_FILE_MAX_MB) || 25;
const CHANNELS_MAX = 50;
const HISTORY_PAGE = 50;
// Anexos que o navegador mostra direto no chat; o resto só baixa (um HTML ou SVG aberto aqui rodaria código no site).
const INLINE_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif',
  'video/mp4', 'video/webm', 'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/webm', 'audio/mp4',
]);
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
  for (const [ip, f] of failures) if (f.until < Date.now()) failures.delete(ip);
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
const users = new Map(); // id -> { id, email, name, passHash, createdAt }
const logins = new Map(); // token do cookie de login -> { userId, createdAt }
const servers = new Map(); // id -> { id, name, createdAt, invite, members: [ids das contas], banned: [ids das contas] }
const channels = new Map(); // id -> { id, serverId, kind: 'text' | 'voice', name, createdAt, createdBy }
const messages = new Map(); // id do canal -> mensagens em ordem (ficam salvas em data/messages)
const attachments = new Map(); // id do anexo -> dados, só dos que já estão numa mensagem
const pendingUploads = new Map(); // anexos enviados que ainda não foram para nenhuma mensagem
const musics = new Map(); // id da sala de voz -> música tocando nela
let usage = { month: monthKey(), bytes: 0 };
let usageDirty = false;

function publicParticipant(p) {
  return {
    id: p.id,
    name: p.name,
    color: p.color,
    voice: p.voice,
    micOn: p.micOn,
    deafened: p.deafened,
    online: p.online,
    joinedAt: p.joinedAt,
    userId: p.userId,
    admin: !!p.admin,
    host: !!p.host,
    muted: !!users.get(p.userId)?.muted,
  };
}

function snapshot(p) {
  return {
    participants: [...participants.values()].map(publicParticipant),
    streams: [...streams.values()],
    ...directoryFor(p),
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

// Só para quem enxerga o canal (só os membros do servidor dele).
function broadcastChannel(channelId, msg) {
  const data = JSON.stringify(msg);
  for (const p of participants.values()) {
    if (canSeeChannel(p, channelId) && p.ws?.readyState === 1) p.ws.send(data);
  }
}

// Só para quem está naquela sala de voz.
function broadcastVoice(channelId, msg, exceptId) {
  const data = JSON.stringify(msg);
  for (const p of participants.values()) {
    if (p.voice === channelId && p.id !== exceptId && p.ws?.readyState === 1) p.ws.send(data);
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

// Quem escreveu, de um jeito que sobrevive a reconexões: a conta.
function authorKey(p) {
  return `u:${p.userId}`;
}

// Mensagens de antes das contas guardam o nome de quem escreveu.
function isAuthor(p, m) {
  return m.author === authorKey(p) || m.author === `n:${p.name.toLowerCase()}`;
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
  // A conta vem do cookie de login, conferido quando a conexão abriu.
  const user = users.get(ws.userId);
  if (!user) {
    return send(ws, { type: 'error', code: 'auth', message: 'Entre com o seu e-mail e senha. Se a página for antiga, aperte F5.' });
  }
  const name = user.name;

  let p = msg.resume ? participants.get(msg.resume.id) : null;
  const resumed = !!p && p.token === msg.resume.token && p.userId === user.id;
  if (resumed) {
    clearTimeout(p.leaveTimer);
    p.leaveTimer = null;
    if (p.ws && p.ws !== ws) p.ws.close();
  } else {
    p = { id: newId(), token: newId(18), name, color: colorFor(name), voice: null, joinedAt: Date.now() };
    participants.set(p.id, p);
  }
  p.ws = ws;
  p.online = true;
  p.name = name;
  p.userId = user.id;
  p.admin = isAdmin(user);
  p.host = isHost(user);
  p.device = ws.device;
  p.micOn = !!msg.micOn && !user.muted;
  p.deafened = !!msg.deafened;
  ws.pid = p.id;

  const you = { ...publicUser(user), userId: user.id, id: p.id, token: p.token, author: authorKey(p) };
  send(ws, { type: 'welcome', resumed, version: APP_VERSION, you, state: snapshot(p) });
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
  dropStreams(p);
  for (const [sid, owner] of sessions) if (owner === p.id) sessions.delete(sid);
  broadcast({ type: 'participant:left', id: p.id });
  log('INFO', who(p), 'saiu da sala');
  if (p.voice) pauseIfEmpty(p.voice);
}

function dropStreams(p) {
  for (const s of [...streams.values()]) {
    if (s.ownerId !== p.id) continue;
    streams.delete(s.id);
    broadcast({ type: 'stream:removed', id: s.id });
  }
}

function voiceMembers(channelId) {
  return [...participants.values()].filter((p) => p.voice === channelId);
}

// Entra numa sala de voz (ou sai, com null). O que a pessoa transmitia na sala anterior acaba.
function moveVoice(p, channelId) {
  const from = p.voice;
  if (from === channelId) return;
  p.voice = channelId;
  dropStreams(p);
  broadcast({ type: 'participant:updated', participant: publicParticipant(p) });
  if (channelId) log('INFO', who(p), `entrou na sala de voz "${channels.get(channelId).name}"`);
  if (from) pauseIfEmpty(from);
}

// Sala de voz vazia: pausa a música para ela não "andar sozinha".
function pauseIfEmpty(channelId) {
  const m = musics.get(channelId);
  if (m?.playing && !voiceMembers(channelId).length) setPlaying(channelId, false);
}

// ---------- música (cada sala de voz tem a sua) ----------

function musicOf(channelId) {
  let m = musics.get(channelId);
  if (!m) {
    m = { queue: [], current: null, playing: false, position: 0, since: Date.now() };
    musics.set(channelId, m);
  }
  return m;
}

function musicPosition(m) {
  return m.playing ? m.position + (Date.now() - m.since) / 1000 : m.position;
}

function musicState(m) {
  return { queue: m.queue, current: m.current, playing: m.playing, position: musicPosition(m), serverTime: Date.now() };
}

// Vai para todo mundo que enxerga a sala: a lista de canais mostra onde tem música tocando.
function broadcastMusic(channelId) {
  broadcastChannel(channelId, { type: 'music', channelId, music: musicState(musicOf(channelId)) });
}

function playItem(channelId, item) {
  const m = musicOf(channelId);
  m.current = item || null;
  m.position = 0;
  m.since = Date.now();
  m.playing = !!item;
  broadcastMusic(channelId);
}

function setPlaying(channelId, playing) {
  const m = musicOf(channelId);
  if (!m.current) return;
  m.position = musicPosition(m);
  m.since = Date.now();
  m.playing = playing;
  broadcastMusic(channelId);
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
  return { id: s.id, name: s.name, emoji: s.emoji, duration: s.duration || 0, ownerId: s.ownerId, ownerName: s.ownerName, url: `/api/sounds/${s.id}`, builtin: false };
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

// ---------- contas ----------
// Cada pessoa cria a conta com e-mail e senha e confirma o e-mail pelo link que chega. A senha só fica
// guardada como hash (scrypt) em data/users.json; quem entra ganha um cookie com um token guardado em
// data/sessions.json. Quem confirmar o ADMIN_EMAIL do .env é o host.

const scryptAsync = promisify(scrypt);

function cleanEmail(email) {
  return String(email ?? '').trim().toLowerCase().slice(0, 120);
}

const validEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
// O host dá e tira o cargo de admin; quem recebe pode todo o resto.
const isHost = (user) => !!user?.verified && !!ADMIN_EMAIL && user.email === ADMIN_EMAIL;
const isAdmin = (user) => isHost(user) || !!user?.admin;
const userByEmail = (email) => [...users.values()].find((u) => u.email === email);

function publicUser(u) {
  return { id: u.id, email: u.email, name: u.name, admin: isAdmin(u), host: isHost(u), verified: !!u.verified, muted: !!u.muted, createdAt: u.createdAt };
}

// Links de uso único (confirmar o e-mail, trocar a senha). Só o hash do token fica guardado na conta.
const tokenHash = (token) => createHash('sha256').update(String(token ?? '')).digest('hex');

function issueToken(user, kind, ms) {
  const token = newId(24);
  user[kind] = { hash: tokenHash(token), exp: Date.now() + ms };
  saveUsers();
  return token;
}

function userByToken(kind, token) {
  const hash = tokenHash(token);
  return [...users.values()].find((u) => u[kind]?.hash === hash && u[kind].exp > Date.now()) || null;
}

const siteUrl = (req) => PUBLIC_URL || `${isHttps(req) ? 'https' : 'http'}://${req.get('host')}`;

function sendConfirm(req, user) {
  const url = `${siteUrl(req)}/#confirmar=${issueToken(user, 'verify', VERIFY_MS)}`;
  return sendMail(
    user.email,
    'Confirme seu e-mail na Sala Privada',
    `Oi, ${user.name}!\n\nPara ativar sua conta na Sala Privada, abra o link abaixo:\n\n${url}\n\n` +
      'O link vale por 24 horas. Se não foi você que criou a conta, é só ignorar este e-mail.',
  );
}

function sendReset(req, user) {
  const url = `${siteUrl(req)}/#senha=${issueToken(user, 'reset', RESET_MS)}`;
  return sendMail(
    user.email,
    'Trocar a senha da Sala Privada',
    `Oi, ${user.name}!\n\nPediram para trocar a senha da sua conta na Sala Privada. Para escolher uma senha nova, abra o link abaixo:\n\n${url}\n\n` +
      'O link vale por 1 hora. Se não foi você, ignore este e-mail: sua senha continua a mesma.',
  );
}

// ---------- e-mails ----------
// Saem pelo SMTP do .env (Gmail: smtp.gmail.com, porta 465 e uma "senha de app"). Sem SMTP_HOST,
// o e-mail só aparece no log, para dar para seguir os links testando no PC.

let mailer = null;
const mailSent = new Map(); // chave -> horários dos últimos envios

// A mesma caixa recebe no máximo 3 por hora, e o servidor manda no máximo 30 por hora e 200 por dia:
// ninguém consegue gastar a cota do Gmail (nem sujar o nome dele) criando contas com o e-mail dos outros.
function allowMail(key, max, ms) {
  const now = Date.now();
  const recent = (mailSent.get(key) || []).filter((at) => at > now - ms);
  const ok = recent.length < max;
  if (ok) recent.push(now);
  mailSent.set(key, recent);
  return ok;
}

async function sendMail(to, subject, text) {
  if (!allowMail(`to:${to}`, 3, 3_600_000)) {
    log('AVISO', null, `${to} já recebeu 3 e-mails nesta hora; este não foi enviado`);
    return false;
  }
  if (!allowMail('hour', 30, 3_600_000) || !allowMail('day', 200, 86_400_000)) {
    log('AVISO', null, `passou do limite de e-mails (30 por hora ou 200 por dia); o e-mail para ${to} não foi enviado`, 'nada se foi um pico de cadastros. Se não, alguém pode estar criando contas com o e-mail dos outros: veja as contas no painel de admin');
    return false;
  }
  if (!SMTP_HOST) {
    log('INFO', null, `e-mail que sairia para ${to} (sem SMTP no .env): ${subject}\n${text}`);
    return true;
  }
  mailer ??= nodemailer.createTransport({ host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_PORT === 465, auth: { user: SMTP_USER, pass: SMTP_PASS } });
  try {
    await mailer.sendMail({ from: MAIL_FROM || `Sala Privada <${SMTP_USER}>`, to, subject, text });
    return true;
  } catch (err) {
    log(
      'ERRO',
      null,
      `não consegui mandar o e-mail para ${to} (${err.message})`,
      'confira SMTP_HOST, SMTP_USER e SMTP_PASS no .env (no Gmail, SMTP_PASS é uma "senha de app") e rode "docker compose up -d --force-recreate"',
    );
    return false;
  }
}

async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scryptAsync(String(password), salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

async function checkPassword(password, stored) {
  const [, salt, hash] = String(stored || '').split('$');
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const got = await scryptAsync(String(password ?? ''), Buffer.from(salt, 'base64'), expected.length);
  return timingSafeEqual(got, expected);
}

function saveUsers() {
  return onDisk('as contas', () => writeFile(USERS_FILE, JSON.stringify([...users.values()])));
}

function saveLogins() {
  return onDisk('os logins', () => writeFile(LOGINS_FILE, JSON.stringify([...logins])));
}

async function loadUsers() {
  try {
    for (const u of JSON.parse(await readFile(USERS_FILE, 'utf8'))) users.set(u.id, u);
  } catch {
    // ainda não há contas
  }
  const stale = Date.now() - 7 * 86_400_000;
  for (const u of [...users.values()]) {
    // Contas de antes da confirmação por e-mail já valem.
    u.verified ??= true;
    // Cadastro nunca confirmado (e-mail errado, ou de outra pessoa) some depois de 7 dias.
    if (!u.verified && u.createdAt < stale) users.delete(u.id);
  }
  await saveUsers();
  const cutoff = Date.now() - SESSION_DAYS * 86_400_000;
  try {
    for (const [token, s] of JSON.parse(await readFile(LOGINS_FILE, 'utf8'))) {
      if (users.has(s.userId) && s.createdAt > cutoff) logins.set(token, s);
    }
  } catch {
    // ninguém entrou ainda
  }
}

const isHttps = (req) => req.get('x-forwarded-proto') === 'https';

function userFrom(req) {
  const s = logins.get(readCookie(req, 'sala_login'));
  if (!s || s.createdAt < Date.now() - SESSION_DAYS * 86_400_000) return null;
  return users.get(s.userId) || null;
}

function startLogin(req, res, user) {
  const token = newId(24);
  logins.set(token, { userId: user.id, createdAt: Date.now() });
  saveLogins();
  res.cookie('sala_login', token, { httpOnly: true, sameSite: 'lax', secure: isHttps(req), path: '/', maxAge: SESSION_DAYS * 86_400_000 });
}

// Desconecta a conta em todos os aparelhos (menos o que pediu, se for o caso).
function endLogins(userId, keepToken) {
  for (const [token, s] of logins) if (s.userId === userId && token !== keepToken) logins.delete(token);
  saveLogins();
}

function kickUser(userId, text) {
  for (const p of [...participants.values()]) {
    if (p.userId !== userId) continue;
    send(p.ws, { type: 'logout', text });
    removeParticipant(p);
    p.ws?.close();
  }
}

// Erros de senha por IP: depois de 10 em 10 minutos, espera.
const failures = new Map();
const clientIp = (req) => req.get('cf-connecting-ip') || req.socket.remoteAddress || '';

function blocked(req) {
  const f = failures.get(clientIp(req));
  return !!f && f.until > Date.now() && f.count >= 10;
}

function failed(req) {
  const ip = clientIp(req);
  const now = Date.now();
  const f = failures.get(ip);
  if (!f || f.until < now) failures.set(ip, { count: 1, until: now + 10 * 60_000 });
  else if (++f.count === 10) log('AVISO', null, `10 senhas erradas seguidas vindas de ${ip}; esse endereço espera 10 minutos`, 'nada se foi alguém da sala esquecendo a senha (o admin pode trocar a senha da pessoa no painel)');
}

// ---------- servidores ----------
// Cada servidor tem os seus membros. Quem não é membro entra pelo link (ou código) de convite do servidor;
// o host enxerga e cuida de todos. Admins expulsam, banem e mutam pessoas nos servidores em que estão.

const newInvite = () => randomBytes(6).toString('base64url').replace(/[-_]/g, 'x');

function publicServer(s, p) {
  const out = { id: s.id, name: s.name, createdAt: s.createdAt, members: s.members };
  // O convite fica com quem cuida da sala; a lista de banidos, só com o host.
  if (p?.admin || p?.host) out.invite = s.invite;
  if (p?.host) out.banned = s.banned;
  return out;
}

function canSee(p, serverId) {
  const s = servers.get(serverId);
  return !!s && (!!p.host || s.members.includes(p.userId));
}

const serverByInvite = (code) => (code ? [...servers.values()].find((s) => s.invite === code) : null) || null;

// Aceita o código sozinho ou o link inteiro (…/convite/CODIGO ou …#convite=CODIGO).
function cleanInvite(value) {
  const text = String(value ?? '').trim();
  const m = /convite[=/]([\w-]{4,32})/.exec(text);
  return (m ? m[1] : text).slice(0, 32);
}

// Admin mexe em quem não é admin; o host, em todos (menos nele mesmo).
function canManage(actor, user) {
  if (!actor?.admin || !user || user.id === actor.userId || isHost(user)) return false;
  return !isAdmin(user) || !!actor.host;
}

function canSeeChannel(p, channelId) {
  const c = channels.get(channelId);
  return !!c && canSee(p, c.serverId);
}

// Os servidores, canais e músicas que essa pessoa enxerga.
function directoryFor(p) {
  const visible = [...servers.values()].filter((s) => canSee(p, s.id));
  const ids = new Set(visible.map((s) => s.id));
  return {
    servers: visible.map((s) => publicServer(s, p)),
    channels: [...channels.values()].filter((c) => ids.has(c.serverId)).map(publicChannel),
    musics: Object.fromEntries([...musics].filter(([id]) => ids.has(channels.get(id)?.serverId)).map(([id, m]) => [id, musicState(m)])),
  };
}

// Depois de mexer em servidores ou membros: quem perdeu acesso sai da sala de voz, e todos recebem a lista nova.
function refreshDirectories() {
  for (const p of participants.values()) {
    if (p.voice && !canSeeChannel(p, p.voice)) moveVoice(p, null);
    send(p.ws, { type: 'directory', ...directoryFor(p) });
  }
}

function saveServers() {
  return onDisk('a lista de servidores', () => writeFile(SERVERS_FILE, JSON.stringify([...servers.values()])));
}

async function loadServers() {
  try {
    for (const s of JSON.parse(await readFile(SERVERS_FILE, 'utf8'))) servers.set(s.id, s);
  } catch {
    // primeira vez: só o principal, logo abaixo
  }
  if (!servers.size) servers.set(MAIN_SERVER, { id: MAIN_SERVER, name: 'Sala Privada', createdAt: Date.now(), members: [] });
  for (const s of servers.values()) {
    // Antes dos convites o principal era aberto a todos: quem já tinha conta continua dentro.
    if (!Array.isArray(s.members)) s.members = [...users.keys()];
    s.members = s.members.filter((id) => users.has(id));
    s.banned = (s.banned || []).filter((id) => users.has(id));
    s.invite ||= newInvite();
  }
  await saveServers();
}

// Os canais de um servidor e de um tipo, na ordem da lista (o admin muda arrastando).
function channelsOf(serverId, kind) {
  return [...channels.values()]
    .filter((c) => c.serverId === serverId && c.kind === kind)
    .sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity) || a.createdAt - b.createdAt);
}

function addChannel(serverId, kind, name, createdBy) {
  const position = (channelsOf(serverId, kind).at(-1)?.position ?? -1) + 1;
  const c = { id: newId(), serverId, kind, name, position, createdAt: Date.now(), createdBy };
  channels.set(c.id, c);
  messages.set(c.id, []);
  return c;
}

// ---------- canais de texto e de voz ----------
// Os canais e as mensagens ficam no disco (data/channels.json e data/messages/<canal>.jsonl,
// uma mensagem por linha). Os anexos ficam em data/attachments e só somem se a mensagem for apagada.

function publicChannel(c) {
  return { id: c.id, serverId: c.serverId, kind: c.kind, name: c.name, position: c.position, createdAt: c.createdAt, lastTs: messages.get(c.id)?.at(-1)?.ts || 0 };
}

const messagesFile = (channelId) => path.join(MESSAGES_DIR, `${channelId}.jsonl`);
const attachPath = (id) => path.join(ATTACH_DIR, id);

// Gravações no disco uma de cada vez, para uma não atropelar a outra.
let diskQueue = Promise.resolve();

function onDisk(what, task) {
  diskQueue = diskQueue
    .then(task)
    .catch((err) => log('ERRO', null, `não consegui salvar ${what} (${err.message})`, 'confira o espaço em disco do servidor e se o volume /data existe'));
  return diskQueue;
}

function saveChannels() {
  return onDisk('a lista de canais', () => writeFile(CHANNELS_FILE, JSON.stringify([...channels.values()])));
}

function rewriteMessages(channelId) {
  const lines = (messages.get(channelId) || []).map((m) => `${JSON.stringify(m)}\n`).join('');
  return onDisk('as mensagens', () => writeFile(messagesFile(channelId), lines));
}

async function loadChannels() {
  await mkdir(MESSAGES_DIR, { recursive: true });
  await mkdir(ATTACH_DIR, { recursive: true });
  try {
    for (const c of JSON.parse(await readFile(CHANNELS_FILE, 'utf8'))) {
      if (!/^[\w-]{1,32}$/.test(c.id) || (c.kind !== 'text' && c.kind !== 'voice')) continue;
      // Canais de antes dos servidores ficam no principal; os de um servidor que sumiu, somem.
      if (!c.serverId && servers.has(MAIN_SERVER)) c.serverId = MAIN_SERVER;
      if (!servers.has(c.serverId)) continue;
      channels.set(c.id, c);
    }
  } catch {
    // primeira vez: cria os canais padrão logo abaixo
  }
  // Todo servidor tem pelo menos um canal de texto e uma sala de voz.
  for (const serverId of servers.keys()) {
    for (const [kind, name] of [['text', 'geral'], ['voice', 'Geral']]) {
      if (![...channels.values()].some((c) => c.serverId === serverId && c.kind === kind)) addChannel(serverId, kind, name, null);
    }
  }
  // Canais de antes da ordem por arrasto ficam na ordem em que foram criados.
  for (const serverId of servers.keys()) {
    for (const kind of ['text', 'voice']) channelsOf(serverId, kind).forEach((c, i) => (c.position = i));
  }
  await saveChannels();
  for (const c of channels.values()) {
    const list = [];
    try {
      for (const line of (await readFile(messagesFile(c.id), 'utf8')).split('\n')) {
        if (!line) continue;
        try {
          list.push(JSON.parse(line));
        } catch {
          // linha cortada por um desligamento no meio da gravação
        }
      }
    } catch {
      // canal ainda sem mensagens
    }
    messages.set(c.id, list);
    for (const m of list) for (const a of m.attachments || []) attachments.set(a.id, { ...a, channelId: c.id });
  }
  // Sobras de canais apagados e de envios que não viraram mensagem.
  for (const name of await readdir(MESSAGES_DIR)) {
    if (!channels.has(name.replace(/\.jsonl$/, ''))) await unlink(path.join(MESSAGES_DIR, name)).catch(() => {});
  }
  for (const name of await readdir(ATTACH_DIR)) {
    if (!attachments.has(name)) await unlink(attachPath(name)).catch(() => {});
  }
}

function addMessage(m) {
  messages.get(m.channelId).push(m);
  for (const a of m.attachments) attachments.set(a.id, { ...a, channelId: m.channelId });
  broadcastChannel(m.channelId, { type: 'chat', message: m });
  onDisk('uma mensagem', () => appendFile(messagesFile(m.channelId), `${JSON.stringify(m)}\n`));
}

function deleteMessage(channelId, index) {
  const [m] = messages.get(channelId).splice(index, 1);
  for (const a of m.attachments) attachments.delete(a.id);
  broadcastChannel(channelId, { type: 'chat:deleted', channelId, id: m.id });
  rewriteMessages(channelId);
  onDisk('a remoção dos anexos', async () => {
    for (const a of m.attachments) await unlink(attachPath(a.id)).catch(() => {});
  });
}

function deleteChannel(c) {
  for (const member of voiceMembers(c.id)) moveVoice(member, null);
  const list = messages.get(c.id) || [];
  musics.delete(c.id);
  messages.delete(c.id);
  channels.delete(c.id);
  for (const m of list) for (const a of m.attachments || []) attachments.delete(a.id);
  broadcast({ type: 'channel:removed', id: c.id });
  saveChannels();
  onDisk('a remoção do canal', async () => {
    await unlink(messagesFile(c.id)).catch(() => {});
    for (const m of list) for (const a of m.attachments || []) await unlink(attachPath(a.id)).catch(() => {});
  });
  return list.length;
}

// Anexo enviado mas nunca mandado numa mensagem (a pessoa desistiu): some depois de 1 h.
function sweepUploads() {
  const cutoff = Date.now() - 60 * 60_000;
  for (const [id, up] of pendingUploads) {
    if (up.createdAt > cutoff) continue;
    pendingUploads.delete(id);
    onDisk('a limpeza de anexos', () => unlink(attachPath(id)).catch(() => {}));
  }
}

// Só dá para receber o que é transmitido na mesma sala de voz.
function sameVoice(p, trackName) {
  const s = streams.get(String(trackName || '').split(':')[0]);
  if (!s) return true; // já acabou: o Cloudflare responde que não existe
  return !!p.voice && participants.get(s.ownerId)?.voice === p.voice;
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
    if (typeof msg.micOn === 'boolean') p.micOn = msg.micOn && !users.get(p.userId)?.muted;
    if (typeof msg.deafened === 'boolean') p.deafened = msg.deafened;
    // O nome é o da conta: trocar aqui troca para sempre.
    const name = msg.name !== undefined && cleanName(msg.name);
    const user = users.get(p.userId);
    if (name && user && name !== user.name) {
      user.name = name;
      saveUsers();
      for (const other of participants.values()) {
        if (other.userId !== user.id) continue;
        other.name = name;
        if (other !== p) broadcast({ type: 'participant:updated', participant: publicParticipant(other) });
      }
    }
    broadcast({ type: 'participant:updated', participant: publicParticipant(p) });
  },

  'voice:join'(p, msg) {
    const id = msg.channelId ? String(msg.channelId) : null;
    if (id && (channels.get(id)?.kind !== 'voice' || !canSeeChannel(p, id))) {
      return send(p.ws, { type: 'voice:ended', text: 'Essa sala de voz não existe mais.' });
    }
    moveVoice(p, id);
  },

  'channel:create'(p, msg) {
    const kind = msg.kind === 'voice' ? 'voice' : 'text';
    const name = cleanName(msg.name);
    const serverId = String(msg.serverId ?? '');
    if (!name || !canSee(p, serverId)) return;
    if (!p.admin) return send(p.ws, { type: 'notice', text: 'Só um admin cria canais.' });
    if (channels.size >= CHANNELS_MAX * servers.size) return send(p.ws, { type: 'notice', text: 'Canais demais. Apague algum antes.' });
    const c = addChannel(serverId, kind, name, p.name);
    saveChannels();
    broadcastChannel(c.id, { type: 'channel:added', channel: publicChannel(c), by: p.id });
    log('INFO', who(p), `criou o canal de ${kind === 'voice' ? 'voz' : 'texto'} "${name}" em ${servers.get(serverId).name}`);
  },

  'channel:update'(p, msg) {
    const c = channels.get(String(msg.id ?? ''));
    const name = cleanName(msg.name);
    if (!c || !name || name === c.name || !canSee(p, c.serverId)) return;
    if (!p.admin) return send(p.ws, { type: 'notice', text: 'Só um admin renomeia canais.' });
    log('INFO', who(p), `renomeou o canal "${c.name}" para "${name}"`);
    c.name = name;
    saveChannels();
    broadcastChannel(c.id, { type: 'channel:updated', channel: publicChannel(c) });
  },

  'channel:delete'(p, msg) {
    const c = channels.get(String(msg.id ?? ''));
    if (!c || !canSee(p, c.serverId)) return;
    if (!p.admin) return send(p.ws, { type: 'notice', text: 'Só um admin apaga canais.' });
    if ([...channels.values()].filter((x) => x.serverId === c.serverId && x.kind === c.kind).length <= 1) {
      return send(p.ws, { type: 'notice', text: `Precisa sobrar pelo menos um canal de ${c.kind === 'voice' ? 'voz' : 'texto'}.` });
    }
    const count = deleteChannel(c);
    log('AVISO', who(p), `apagou o canal "${c.name}"${count ? ` e as ${count} mensagens dele` : ''}`);
  },

  // O admin arrastou um canal: ele fica antes do canal `before` (ou no fim da lista).
  'channel:move'(p, msg) {
    const c = channels.get(String(msg.id ?? ''));
    if (!c || !canSee(p, c.serverId)) return;
    if (!p.admin) return send(p.ws, { type: 'notice', text: 'Só um admin muda a ordem dos canais.' });
    const list = channelsOf(c.serverId, c.kind).filter((x) => x !== c);
    const at = list.findIndex((x) => x.id === msg.before);
    list.splice(at < 0 ? list.length : at, 0, c);
    list.forEach((x, i) => (x.position = i));
    saveChannels();
    broadcastChannel(c.id, { type: 'channel:order', ids: list.map((x) => x.id) });
  },

  // O admin arrastou alguém para outra sala de voz: o app da pessoa troca de sala sozinho.
  'voice:move'(p, msg) {
    if (!p.admin) return send(p.ws, { type: 'notice', text: 'Só um admin move pessoas entre as salas de voz.' });
    const target = participants.get(String(msg.pid ?? ''));
    const id = String(msg.channelId ?? '');
    if (!target?.voice || target.voice === id || channels.get(id)?.kind !== 'voice' || !canSeeChannel(p, id)) return;
    if (!canSeeChannel(target, id)) return send(p.ws, { type: 'notice', text: `${target.name} não é membro desse servidor.` });
    if (!target.online) return send(p.ws, { type: 'notice', text: `${target.name} está sem conexão agora.` });
    send(target.ws, { type: 'voice:moved', channelId: id, by: p.name });
    log('INFO', who(p), `moveu ${target.name} para a sala de voz "${channels.get(id).name}"`);
  },

  // Entrar num servidor com o código (ou link) de convite.
  'server:join'(p, msg) {
    const now = Date.now();
    p.inviteTries = (p.inviteTries || []).filter((at) => at > now - 10 * 60_000);
    if (p.inviteTries.length >= 10) return send(p.ws, { type: 'invite:error', text: 'Muitos códigos errados. Espere uns 10 minutos.' });
    const s = serverByInvite(cleanInvite(msg.code));
    if (!s) {
      p.inviteTries.push(now);
      return send(p.ws, { type: 'invite:error', text: 'Esse convite não existe (ou foi trocado). Peça um link novo para o dono do site.' });
    }
    if (s.banned.includes(p.userId)) return send(p.ws, { type: 'invite:error', text: `Você foi banido de ${s.name}.` });
    const already = s.members.includes(p.userId) || !!p.host;
    if (!s.members.includes(p.userId)) {
      s.members.push(p.userId);
      saveServers();
      log('INFO', who(p), `entrou no servidor "${s.name}" pelo convite`);
      // Os outros aparelhos da pessoa e os membros (que veem a lista de membros) recebem a lista nova.
      for (const other of participants.values()) if (canSee(other, s.id)) send(other.ws, { type: 'directory', ...directoryFor(other) });
    }
    send(p.ws, { type: 'server:joined', id: s.id, name: s.name, already });
  },

  // Expulsar (ou banir) alguém do servidor: a pessoa sai dele na hora. Expulsa, pode voltar pelo convite; banida, não.
  'member:kick'(p, msg) {
    const s = servers.get(String(msg.serverId ?? ''));
    const user = users.get(String(msg.userId ?? ''));
    if (!s || !user || !canSee(p, s.id)) return;
    if (!canManage(p, user)) return send(p.ws, { type: 'notice', text: 'Você não pode fazer isso com essa pessoa.' });
    const ban = !!msg.ban;
    if (!s.members.includes(user.id) && !ban) return send(p.ws, { type: 'notice', text: `${user.name} não é membro de ${s.name}.` });
    s.members = s.members.filter((id) => id !== user.id);
    if (ban && !s.banned.includes(user.id)) s.banned.push(user.id);
    saveServers();
    refreshDirectories();
    for (const other of participants.values()) {
      if (other.userId === user.id) send(other.ws, { type: 'notice', text: `${p.name} ${ban ? 'te baniu' : 'te expulsou'} de ${s.name}.` });
    }
    send(p.ws, { type: 'notice', text: `${user.name} ${ban ? 'foi banido' : 'foi expulso'} de ${s.name}.` });
    log('AVISO', who(p), `${ban ? 'baniu' : 'expulsou'} ${user.name} (${user.email}) do servidor "${s.name}"`);
  },

  // Mutar alguém: o microfone dessa conta para de chegar nos outros até um admin desmutar.
  'member:mute'(p, msg) {
    const user = users.get(String(msg.userId ?? ''));
    if (!user) return;
    if (!canManage(p, user)) return send(p.ws, { type: 'notice', text: 'Você não pode fazer isso com essa pessoa.' });
    user.muted = !!msg.muted;
    saveUsers();
    for (const other of [...participants.values()]) {
      if (other.userId !== user.id) continue;
      if (user.muted) {
        other.micOn = false;
        for (const st of [...streams.values()]) {
          if (st.ownerId !== other.id || st.kind !== 'mic') continue;
          streams.delete(st.id);
          broadcast({ type: 'stream:removed', id: st.id });
        }
      }
      send(other.ws, { type: 'account', account: publicUser(user), by: p.name });
      broadcast({ type: 'participant:updated', participant: publicParticipant(other) });
    }
    log('INFO', who(p), `${user.muted ? 'mutou' : 'desmutou'} ${user.name} (${user.email})`);
  },

  // Tirar alguém da sala de voz (sem tirar do servidor).
  'voice:kick'(p, msg) {
    const target = participants.get(String(msg.pid ?? ''));
    if (!target?.voice || !canSeeChannel(p, target.voice)) return;
    if (!canManage(p, users.get(target.userId))) return send(p.ws, { type: 'notice', text: 'Você não pode fazer isso com essa pessoa.' });
    const room = channels.get(target.voice)?.name || 'a sala de voz';
    moveVoice(target, null);
    send(target.ws, { type: 'voice:ended', text: `${p.name} te tirou de ${room}.` });
    log('INFO', who(p), `tirou ${target.name} da sala de voz "${room}"`);
  },

  'stream:publish'(p, msg) {
    const s = validStream(msg.stream);
    if (!s || !p.voice) return;
    if (s.kind === 'mic' && users.get(p.userId)?.muted) return;
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

  // Quem clicou já tocou na hora; os outros da mesma sala de voz recebem o aviso para tocar também.
  'sound:play'(p, msg) {
    const id = String(msg.id ?? '');
    if (!p.voice || (!DEFAULT_SOUNDS.some((s) => s.id === id) && !sounds.has(id))) return;
    const now = Date.now();
    if (now - (p.lastSound || 0) < 400) return;
    p.lastSound = now;
    broadcastVoice(p.voice, { type: 'sound:play', id, by: p.name }, p.id);
  },

  // Som comprido demais: qualquer um da sala de voz para para todos.
  'sound:stop'(p) {
    if (p.voice) broadcastVoice(p.voice, { type: 'sound:stop', by: p.name }, p.id);
  },

  chat(p, msg) {
    const channel = channels.get(String(msg.channelId ?? ''));
    if (!channel || !canSee(p, channel.serverId)) return;
    const text = String(msg.text ?? '').trim().slice(0, 2000);
    const author = authorKey(p);
    const list = [];
    for (const id of Array.isArray(msg.attachments) ? msg.attachments.slice(0, 10) : []) {
      const up = pendingUploads.get(String(id));
      if (!up || up.author !== author) continue;
      pendingUploads.delete(up.meta.id);
      list.push(up.meta);
    }
    if (!text && !list.length) return;
    addMessage({ id: newId(), channelId: channel.id, pid: p.id, author, name: p.name, color: p.color, text, attachments: list, ts: Date.now() });
  },

  'chat:delete'(p, msg) {
    const channelId = String(msg.channelId ?? '');
    const list = canSeeChannel(p, channelId) && messages.get(channelId);
    const i = list ? list.findIndex((m) => m.id === msg.id) : -1;
    if (i < 0) return;
    if (!isAuthor(p, list[i])) return send(p.ws, { type: 'notice', text: 'Só quem mandou pode apagar a mensagem.' });
    deleteMessage(channelId, i);
  },

  // O histórico vem em páginas, das mais novas para as mais antigas.
  'chat:history'(p, msg) {
    const channelId = String(msg.channelId ?? '');
    const list = canSeeChannel(p, channelId) && messages.get(channelId);
    if (!list) return;
    let end = list.length;
    if (msg.before) {
      const i = list.findIndex((m) => m.id === msg.before);
      if (i >= 0) end = i;
    }
    const start = Math.max(0, end - HISTORY_PAGE);
    send(p.ws, { type: 'chat:history', channelId, before: msg.before || null, messages: list.slice(start, end), more: start > 0 });
  },

  async 'music:add'(p, msg) {
    const channelId = p.voice;
    if (!channelId) return send(p.ws, { type: 'notice', text: 'Entre numa sala de voz para colocar música.' });
    const videoId = parseYouTubeId(String(msg.url ?? ''));
    if (!videoId) return send(p.ws, { type: 'notice', text: 'Esse link não parece ser do YouTube.' });
    if (musicOf(channelId).queue.length >= 100) return send(p.ws, { type: 'notice', text: 'A fila está cheia.' });
    const info = await videoInfo(videoId);
    if (info.error) return send(p.ws, { type: 'notice', text: info.error });
    if (!channels.has(channelId)) return; // a sala foi apagada enquanto o YouTube respondia
    const item = { id: newId(), videoId, title: info.title || 'Vídeo do YouTube', author: info.author || '', by: p.name };
    const m = musicOf(channelId);
    if (m.current) {
      m.queue.push(item);
      broadcastMusic(channelId);
    } else {
      playItem(channelId, item);
    }
  },

  'music:play'(p) {
    if (p.voice) setPlaying(p.voice, true);
  },

  'music:pause'(p) {
    if (p.voice) setPlaying(p.voice, false);
  },

  'music:skip'(p, msg) {
    // itemId evita pular duas músicas quando duas pessoas clicam juntas
    const m = p.voice && musics.get(p.voice);
    if (m?.current && msg.itemId === m.current.id) playItem(p.voice, m.queue.shift());
  },

  'music:seek'(p, msg) {
    const m = p.voice && musics.get(p.voice);
    const t = Number(msg.t);
    if (!m?.current || !Number.isFinite(t)) return;
    m.position = Math.max(0, Math.min(t, 86_400));
    m.since = Date.now();
    broadcastMusic(p.voice);
  },

  'music:ended'(p, msg) {
    const m = p.voice && musics.get(p.voice);
    if (m?.current && msg.itemId === m.current.id) playItem(p.voice, m.queue.shift());
  },

  'music:error'(p, msg) {
    const m = p.voice && musics.get(p.voice);
    if (!m?.current || msg.itemId !== m.current.id) return;
    broadcastVoice(p.voice, { type: 'notice', text: `Não deu para tocar ${m.current.title}: ${ytErrorText(msg.code)}` });
    log('AVISO', who(p), `o YouTube não tocou "${m.current.title}" (${ytErrorText(msg.code)}); pulei para a próxima`, 'escolher outro vídeo da mesma música');
    playItem(p.voice, m.queue.shift());
  },

  'music:duration'(p, msg) {
    const m = p.voice && musics.get(p.voice);
    const duration = Number(msg.duration);
    if (m?.current && msg.itemId === m.current.id && duration > 0) m.current.duration = duration;
  },

  'music:remove'(p, msg) {
    const m = p.voice && musics.get(p.voice);
    const i = m ? m.queue.findIndex((item) => item.id === msg.itemId) : -1;
    if (i < 0) return;
    m.queue.splice(i, 1);
    broadcastMusic(p.voice);
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
    realtimeReady: !!(APP_ID && APP_SECRET),
    iceServers: ICE_SERVERS,
    version: APP_VERSION,
    fileMaxGB: FILE_MAX_GB,
    fileTtlHours: FILE_TTL_HOURS,
    chatFileMaxMB: CHAT_FILE_MAX_MB,
  });
});

app.get('/api/presence', (req, res) => {
  const list = [...participants.values()];
  // Sem nomes: o site é aberto, e quem está na sala só aparece para quem é dos mesmos servidores.
  res.json({ count: list.length });
});

// O nome do servidor do convite, para a tela de entrar mostrar para onde a pessoa foi chamada.
app.get('/api/invite/:code', (req, res) => {
  const s = serverByInvite(cleanInvite(req.params.code));
  if (!s) return res.status(404).json({ errorCode: 'not_found', errorDescription: 'Esse convite não existe (ou foi trocado).' });
  res.json({ name: s.name });
});

// O link de convite abre o site, que guarda o código e entra no servidor depois do login.
app.get('/convite/:code', (req, res) => {
  res.redirect(302, `/#convite=${encodeURIComponent(cleanInvite(req.params.code))}`);
});

// ---------- entrar, criar conta e painel de admin ----------

const fail = (res, status, errorCode, errorDescription) => res.status(status).json({ errorCode, errorDescription });
const TOO_MANY = 'Muitas tentativas erradas. Espere uns 10 minutos.';

const authRoutes = express.Router();

authRoutes.get('/me', (req, res) => {
  const user = userFrom(req);
  res.json(user && publicUser(user));
});

authRoutes.post('/register', async (req, res) => {
  if (blocked(req)) return fail(res, 429, 'too_many', TOO_MANY);
  const name = cleanName(req.body?.name);
  const email = cleanEmail(req.body?.email);
  const password = String(req.body?.password ?? '');
  if (!name) return fail(res, 400, 'name', 'Escolha um nome ou apelido.');
  if (!validEmail(email)) return fail(res, 400, 'email', 'Esse e-mail não parece certo.');
  if (password.length < 6) return fail(res, 400, 'password', 'A senha precisa ter pelo menos 6 caracteres.');
  let user = userByEmail(email);
  if (user?.verified) return fail(res, 409, 'exists', 'Já existe uma conta com esse e-mail. Entre com ela ou use "Esqueci minha senha".');
  const passHash = await hashPassword(password);
  // Cadastro que nunca foi confirmado (e-mail digitado errado, ou alguém usando o e-mail dos outros): recomeça.
  if (!user) {
    user = { id: newId(), email, createdAt: Date.now() };
    users.set(user.id, user);
  }
  Object.assign(user, { name, passHash, verified: false });
  saveUsers();
  if (!(await sendConfirm(req, user))) return fail(res, 503, 'mail', 'Não deu para mandar o e-mail de confirmação agora. Tente de novo daqui a pouco.');
  log('INFO', null, `${name} criou uma conta (${email}); falta confirmar o e-mail`);
  res.json({ pending: true, email });
});

// O link do e-mail abre o site com o token; o app manda para cá e já entra.
authRoutes.post('/verify', (req, res) => {
  const user = userByToken('verify', req.body?.token);
  if (!user) return fail(res, 400, 'link', 'Esse link de confirmação expirou ou já foi usado. Entre com o seu e-mail e senha para receber outro.');
  user.verified = true;
  delete user.verify;
  saveUsers();
  startLogin(req, res, user);
  log('INFO', null, `${user.name} confirmou o e-mail (${user.email})${isHost(user) ? ' e é o host da sala' : ''}`);
  res.json(publicUser(user));
});

authRoutes.post('/login', async (req, res) => {
  if (blocked(req)) return fail(res, 429, 'too_many', TOO_MANY);
  const user = userByEmail(cleanEmail(req.body?.email));
  if (!user || !(await checkPassword(req.body?.password, user.passHash))) {
    failed(req);
    return fail(res, 401, 'login', 'E-mail ou senha incorretos.');
  }
  if (!user.verified) {
    const sent = await sendConfirm(req, user);
    const where = sent ? `Mandamos um link novo para ${user.email}` : `Procure o link que mandamos para ${user.email}`;
    return fail(res, 403, 'unverified', `Falta confirmar o e-mail. ${where} (veja também o spam).`);
  }
  startLogin(req, res, user);
  res.json(publicUser(user));
});

// Responde sempre igual (e sem esperar o e-mail sair), para ninguém descobrir quais e-mails têm conta.
authRoutes.post('/forgot', (req, res) => {
  if (blocked(req)) return fail(res, 429, 'too_many', TOO_MANY);
  const email = cleanEmail(req.body?.email);
  if (!validEmail(email)) return fail(res, 400, 'email', 'Esse e-mail não parece certo.');
  const user = userByEmail(email);
  if (user) sendReset(req, user);
  res.json({ ok: true });
});

authRoutes.post('/resend', (req, res) => {
  const user = userByEmail(cleanEmail(req.body?.email));
  if (user && !user.verified) sendConfirm(req, user);
  res.json({ ok: true });
});

// Quem abriu o link do e-mail é dono dele: a conta fica confirmada e os outros aparelhos saem.
authRoutes.post('/reset', async (req, res) => {
  const user = userByToken('reset', req.body?.token);
  if (!user) return fail(res, 400, 'link', 'Esse link expirou ou já foi usado. Peça outro em "Esqueci minha senha".');
  const password = String(req.body?.password ?? '');
  if (password.length < 6) return fail(res, 400, 'password', 'A senha precisa ter pelo menos 6 caracteres.');
  user.passHash = await hashPassword(password);
  user.verified = true;
  delete user.reset;
  delete user.verify;
  saveUsers();
  endLogins(user.id);
  kickUser(user.id, 'A senha da sua conta foi trocada. Entre de novo com a senha nova.');
  startLogin(req, res, user);
  log('INFO', null, `${user.name} (${user.email}) trocou a senha pelo link do e-mail`);
  res.json(publicUser(user));
});

authRoutes.post('/logout', (req, res) => {
  logins.delete(readCookie(req, 'sala_login'));
  saveLogins();
  res.clearCookie('sala_login', { path: '/' });
  res.json({ ok: true });
});

authRoutes.post('/password', async (req, res) => {
  const user = userFrom(req);
  if (!user) return fail(res, 401, 'unauthorized', 'Entre na sua conta de novo.');
  if (blocked(req)) return fail(res, 429, 'too_many', TOO_MANY);
  if (!(await checkPassword(req.body?.current, user.passHash))) {
    failed(req);
    return fail(res, 403, 'current', 'A senha atual não confere.');
  }
  const password = String(req.body?.password ?? '');
  if (password.length < 6) return fail(res, 400, 'password', 'A senha nova precisa ter pelo menos 6 caracteres.');
  user.passHash = await hashPassword(password);
  saveUsers();
  // Os outros aparelhos precisam entrar de novo com a senha nova.
  endLogins(user.id, readCookie(req, 'sala_login'));
  res.json({ ok: true });
});

app.use('/api/auth', authRoutes);

const adminRoutes = express.Router();

adminRoutes.use((req, res, next) => {
  const user = userFrom(req);
  if (!isAdmin(user)) return fail(res, 403, 'forbidden', 'Só o admin pode fazer isso.');
  req.user = user;
  next();
});

adminRoutes.get('/users', (req, res) => {
  res.json([...users.values()].sort((a, b) => a.createdAt - b.createdAt).map(publicUser));
});

// Os admins que o host escolheu não mexem nas contas uns dos outros (nem na do host).
function protectedAccount(req, user) {
  if (isHost(user)) return 'Só o próprio host mexe na conta dele (em Configurações ou em "Esqueci minha senha").';
  if (isAdmin(user) && !isHost(req.user)) return 'Só o host mexe na conta de outro admin.';
  return null;
}

adminRoutes.post('/users/:id/password', async (req, res) => {
  const user = users.get(req.params.id);
  if (!user) return fail(res, 404, 'not_found', 'Essa conta não existe mais.');
  const locked = protectedAccount(req, user);
  if (locked) return fail(res, 403, 'admin', locked);
  const password = String(req.body?.password ?? '');
  if (password.length < 6) return fail(res, 400, 'password', 'A senha precisa ter pelo menos 6 caracteres.');
  user.passHash = await hashPassword(password);
  saveUsers();
  endLogins(user.id);
  kickUser(user.id, 'O admin trocou a sua senha. Entre de novo com a senha nova.');
  log('INFO', null, `o admin trocou a senha de ${user.name} (${user.email})`);
  res.json({ ok: true });
});

adminRoutes.delete('/users/:id', (req, res) => {
  const user = users.get(req.params.id);
  if (!user) return res.json({ ok: true });
  const locked = protectedAccount(req, user);
  if (locked) return fail(res, 403, 'admin', locked);
  users.delete(user.id);
  saveUsers();
  endLogins(user.id);
  kickUser(user.id, 'Sua conta foi apagada pelo admin.');
  for (const s of servers.values()) {
    s.members = s.members.filter((id) => id !== user.id);
    s.banned = s.banned.filter((id) => id !== user.id);
  }
  saveServers();
  refreshDirectories();
  log('AVISO', null, `o admin apagou a conta de ${user.name} (${user.email})`);
  res.json({ ok: true });
});

// Dar ou tirar o cargo de admin: só o host.
adminRoutes.put('/users/:id/admin', (req, res) => {
  if (!isHost(req.user)) return fail(res, 403, 'forbidden', 'Só o host dá e tira o cargo de admin.');
  const user = users.get(req.params.id);
  if (!user) return fail(res, 404, 'not_found', 'Essa conta não existe mais.');
  if (isHost(user)) return fail(res, 400, 'admin', 'O host é sempre admin.');
  user.admin = !!req.body?.admin;
  saveUsers();
  for (const p of participants.values()) {
    if (p.userId !== user.id) continue;
    p.admin = user.admin;
    send(p.ws, { type: 'account', account: publicUser(user) });
    broadcast({ type: 'participant:updated', participant: publicParticipant(p) });
  }
  // Admin vê o link de convite dos servidores em que está; quem perdeu o cargo deixa de ver.
  refreshDirectories();
  log('INFO', null, `o host ${user.admin ? 'deu' : 'tirou'} o cargo de admin ${user.admin ? 'para' : 'de'} ${user.name} (${user.email})`);
  res.json(publicUser(user));
});

app.use('/api/admin', adminRoutes);

// ---------- painel de servidores (só o host) ----------

const hostRoutes = express.Router();

hostRoutes.use((req, res, next) => {
  const user = userFrom(req);
  if (!isHost(user)) return fail(res, 403, 'forbidden', 'Só o host cuida dos servidores.');
  req.user = user;
  next();
});

const hostView = { host: true, admin: true };

// Servidor novo já vem com um canal de texto, uma sala de voz e um link de convite.
hostRoutes.post('/', (req, res) => {
  const name = cleanName(req.body?.name);
  if (!name) return fail(res, 400, 'name', 'Escolha um nome para o servidor.');
  if (servers.size >= 20) return fail(res, 400, 'too_many', 'Já são 20 servidores. Apague algum antes.');
  const s = { id: newId(), name, createdAt: Date.now(), members: [], banned: [], invite: newInvite() };
  servers.set(s.id, s);
  addChannel(s.id, 'text', 'geral', req.user.name);
  addChannel(s.id, 'voice', 'Geral', req.user.name);
  saveServers();
  saveChannels();
  refreshDirectories();
  log('INFO', null, `o host criou o servidor "${name}"`);
  res.json(publicServer(s, hostView));
});

hostRoutes.put('/:id', (req, res) => {
  const s = servers.get(req.params.id);
  if (!s) return fail(res, 404, 'not_found', 'Esse servidor não existe mais.');
  const name = req.body?.name !== undefined ? cleanName(req.body.name) : s.name;
  if (!name) return fail(res, 400, 'name', 'Escolha um nome para o servidor.');
  s.name = name;
  if (Array.isArray(req.body?.members)) {
    s.members = [...new Set(req.body.members.map(String))].filter((id) => users.has(id) && !isHost(users.get(id)));
    // Quem o host coloca de volta deixa de estar banido.
    s.banned = s.banned.filter((id) => !s.members.includes(id));
  }
  saveServers();
  refreshDirectories();
  res.json(publicServer(s, hostView));
});

// Link novo: o antigo para de funcionar (quem já entrou continua dentro).
hostRoutes.post('/:id/invite', (req, res) => {
  const s = servers.get(req.params.id);
  if (!s) return fail(res, 404, 'not_found', 'Esse servidor não existe mais.');
  s.invite = newInvite();
  saveServers();
  refreshDirectories();
  log('INFO', null, `o host trocou o link de convite de "${s.name}"`);
  res.json(publicServer(s, hostView));
});

hostRoutes.delete('/:id/banned/:userId', (req, res) => {
  const s = servers.get(req.params.id);
  if (!s) return fail(res, 404, 'not_found', 'Esse servidor não existe mais.');
  s.banned = s.banned.filter((id) => id !== req.params.userId);
  saveServers();
  refreshDirectories();
  res.json(publicServer(s, hostView));
});

hostRoutes.delete('/:id', (req, res) => {
  const s = servers.get(req.params.id);
  if (!s) return res.json({ ok: true });
  if (servers.size <= 1) return fail(res, 400, 'last', 'Precisa sobrar pelo menos um servidor.');
  let count = 0;
  for (const c of [...channels.values()]) if (c.serverId === s.id) count += deleteChannel(c);
  servers.delete(s.id);
  saveServers();
  refreshDirectories();
  log('AVISO', null, `o host apagou o servidor "${s.name}"${count ? ` e as ${count} mensagens dele` : ''}`);
  res.json({ ok: true });
});

app.use('/api/servers', hostRoutes);

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
  if (tracks.some((t) => t.location === 'remote' && !sameVoice(req.participant, t.trackName))) {
    return res.status(403).json({ errorCode: 'other_voice', errorDescription: 'Essa transmissão é de outra sala de voz.' });
  }
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
    broadcast({ type: 'notice', text: `${f.ownerName} enviou ${f.name} (${fmtBytes(f.size)}). Fica ${FILE_TTL_HOURS} h na aba Arquivos.` }, req.participant.id);
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

function readCookie(req, name) {
  const raw = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(req.headers.cookie || '')?.[1];
  try {
    return raw ? decodeURIComponent(raw) : '';
  } catch {
    return '';
  }
}

function cookieParticipant(req) {
  return participantFrom(readCookie(req, 'sala_auth'));
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

// O áudio vem cru no corpo; nome, emoji e duração (medida pelo navegador) vão nos cabeçalhos.
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
  const duration = Math.round(Number(req.get('x-sound-duration')) * 10) / 10;
  if (!name || !/^(audio|video)\//.test(type) || !Buffer.isBuffer(req.body) || !req.body.length) {
    return res.status(400).json({ errorCode: 'bad_sound', errorDescription: 'Mande um arquivo de áudio e um nome para o som.' });
  }
  if (!(duration > 0) || duration > SOUND_MAX_SECONDS + 0.5) {
    return res.status(400).json({ errorCode: 'too_long', errorDescription: 'O som pode ter no máximo 3 minutos.' });
  }
  if (sounds.size >= SOUNDS_MAX) {
    return res.status(507).json({ errorCode: 'sounds_full', errorDescription: `A mesa já tem ${SOUNDS_MAX} sons. Peça para um admin tirar algum.` });
  }
  const s = { id: newId(9), name, emoji, type, duration, ownerId: p.id, ownerName: p.name, createdAt: Date.now() };
  await writeFile(path.join(SOUNDS_DIR, s.id), req.body);
  sounds.set(s.id, s);
  await saveSounds();
  broadcast({ type: 'sound:added', sound: publicSound(s) });
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
  if (!p.admin) {
    return res.status(403).json({ errorCode: 'forbidden', errorDescription: 'Só um admin pode tirar sons da mesa.' });
  }
  sounds.delete(s.id);
  await unlink(path.join(SOUNDS_DIR, s.id)).catch(() => {});
  await saveSounds();
  broadcast({ type: 'sound:removed', id: s.id });
  log('INFO', who(p), `tirou o som "${s.name}" da mesa`);
  res.json({ ok: true });
});

app.use('/api/sounds', soundRoutes);

// ---------- anexos do chat ----------

const attachmentRoutes = express.Router();

// O arquivo vem cru no corpo (como octet-stream, para nenhum outro leitor mexer); nome, tipo e tamanho da imagem nos cabeçalhos.
attachmentRoutes.post('/', requireParticipant, express.raw({ type: () => true, limit: CHAT_FILE_MAX_MB * 1e6 }), async (req, res) => {
  const p = req.participant;
  const header = (key) => {
    try {
      return decodeURIComponent(req.get(key) || '');
    } catch {
      return '';
    }
  };
  if (!Buffer.isBuffer(req.body) || !req.body.length) return badRequest(res);
  let free = Infinity;
  try {
    const fs = await statfs(ATTACH_DIR);
    free = fs.bavail * fs.bsize;
  } catch {
    // sem informação de disco: segue
  }
  const name = cleanFileName(header('x-file-name')) || 'arquivo';
  if (free - req.body.length < 2 * GB) {
    log('AVISO', who(p), `não deu para guardar o anexo "${name}": só ${fmtBytes(free)} livres no disco`, 'liberar espaço no servidor (apagar canais antigos ou arquivos)');
    return res.status(507).json({ errorCode: 'storage_full', errorDescription: 'Sem espaço no servidor.' });
  }
  const size = (key) => {
    const n = Number(req.get(key));
    return Number.isInteger(n) && n > 0 && n <= 100_000 ? n : undefined;
  };
  const meta = {
    id: newId(12),
    name,
    type: header('x-file-type').toLowerCase().slice(0, 100) || 'application/octet-stream',
    size: req.body.length,
    width: size('x-width'),
    height: size('x-height'),
  };
  await writeFile(attachPath(meta.id), req.body);
  pendingUploads.set(meta.id, { meta, author: authorKey(p), createdAt: Date.now() });
  res.json(meta);
});

attachmentRoutes.get('/:id', (req, res) => {
  const p = cookieParticipant(req);
  if (!p) return res.status(401).type('text/plain; charset=utf-8').send('Entre na sala para ver este anexo.');
  const a = attachments.get(req.params.id);
  if (!a || !canSeeChannel(p, a.channelId)) return res.status(404).type('text/plain; charset=utf-8').send('Esse anexo foi apagado.');
  const inline = INLINE_TYPES.has(a.type);
  res.sendFile(attachPath(a.id), {
    headers: {
      'Content-Type': inline ? a.type : 'application/octet-stream',
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(a.name)}`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox",
      'Cache-Control': 'private, max-age=31536000, immutable',
    },
  });
});

app.use('/api/attachments', attachmentRoutes);

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
  ws.userId = userFrom(req)?.id;
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
await loadUsers();
await loadServers();
await loadChannels();

setInterval(saveUsage, 30_000);
setInterval(sweepFiles, 5 * 60_000);
setInterval(sweepUploads, 10 * 60_000);
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
    await diskQueue;
    process.exit(0);
  });
}

server.listen(PORT, () => {
  log('INFO', null, `Sala Privada rodando na porta ${PORT}; arquivos somem em ${FILE_TTL_HOURS} h (até ${FILE_MAX_GB} GB cada)`);
  if (!APP_ID || !APP_SECRET) {
    log('AVISO', null, 'sem as chaves do Cloudflare Realtime: voz, câmera e telas estão desligados', 'preencha REALTIME_APP_ID e REALTIME_APP_SECRET no .env e rode "docker compose up -d --force-recreate"');
  }
  if (!ADMIN_EMAIL) {
    log('AVISO', null, 'não há host: ninguém consegue criar servidores, dar o cargo de admin nem trocar senhas', 'preencha ADMIN_EMAIL no .env, rode "docker compose up -d --force-recreate" e crie a conta com esse e-mail');
  } else if (![...users.values()].some(isHost)) {
    log('INFO', null, `o host (${ADMIN_EMAIL}) ainda não tem conta: é só criar a conta com esse e-mail e confirmar pelo link que chega`);
  }
  if (!SMTP_HOST) {
    log(
      'AVISO',
      null,
      'sem SMTP: os e-mails de confirmar conta e de trocar senha só aparecem neste log',
      'preencha SMTP_HOST, SMTP_USER e SMTP_PASS no .env (Gmail: smtp.gmail.com e uma senha de app de myaccount.google.com/apppasswords) e rode "docker compose up -d --force-recreate"',
    );
  }
});
