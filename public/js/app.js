import { icon } from './icons.js';
import { MusicPlayer } from './music.js';
import { RtcApi, SfuConnection } from './rtc.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(`sala:${key}`);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`sala:${key}`, JSON.stringify(value));
    } catch {
      // navegador sem armazenamento: só não lembra a preferência
    }
  },
};

const QUALITY = {
  '720p30': { width: 1280, height: 720, frameRate: 30, maxBitrate: 1_500_000, hint: 'detail' },
  '1080p30': { width: 1920, height: 1080, frameRate: 30, maxBitrate: 3_000_000, hint: 'detail' },
  '1080p60': { width: 1920, height: 1080, frameRate: 60, maxBitrate: 5_000_000, hint: 'motion' },
};
const SURFACE_NAMES = { monitor: 'Tela', window: 'Janela', browser: 'Aba' };
const QUOTA_MSG = 'O limite gratuito de vídeo deste mês acabou. A voz continua funcionando.';
const canShareScreen = !!navigator.mediaDevices?.getDisplayMedia;

const settings = {
  micId: store.get('micId', ''),
  camId: store.get('camId', ''),
  outId: store.get('outId', ''),
  noise: store.get('noise', true),
  quality: store.get('quality', '1080p30'),
  autoWatch: store.get('autoWatch', false),
};

const state = {
  config: null,
  me: null,
  inRoom: false,
  leaving: false,
  participants: new Map(),
  streams: new Map(),
  chat: [],
  music: null,
  usage: null,
  micOn: store.get('joinMic', true),
  deafened: false,
  micBeforeDeafen: true,
  watching: new Set(),
  previewing: new Set(),
  focusKey: null,
  tab: 'people',
  unread: 0,
  expanded: null,
  clockOffset: 0,
};

// O que eu estou transmitindo. Cada entrada: { id, kind, label, stream, items: [{ track, trackName, encodings }], mids, senders }
const local = { mic: null, camera: null, screens: new Map(), facing: 'user', multipleCams: false };
// O que eu estou recebendo, por id da transmissão.
const subs = new Map();
const retries = new Map();
const tiles = new Map();
const meters = new Map();
const clockSamples = [];
const usageSeen = new Map();

let ws = null;
let api = null;
let sender = null;
let receiver = null;
let music = null;
let joinInfo = null;
let reconnectDelay = 1000;
let screenCount = 0;
let presenceTimer = null;
let audioCtx = null;
let micStarting = false;
let camStarting = false;
let audioUnlockShown = false;
let quotaWarned = false;
let usagePc = null;

const serverNow = () => Date.now() + state.clockOffset;
const randomId = () => Math.random().toString(36).slice(2, 10);

init();

// ---------- entrada ----------

async function init() {
  for (const el of $$('[data-icon]')) el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon));
  setupInstall();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

  $('#join-name').value = store.get('name', '');
  $('#join-mic').checked = state.micOn;
  $('#join-cam').checked = store.get('joinCam', false);
  $('#join-form').addEventListener('submit', onJoinSubmit);
  bindRoomUi();

  try {
    state.config = await fetch('/api/config').then((r) => r.json());
  } catch {
    state.config = { needsPassword: false, realtimeReady: false, iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }] };
  }
  $('#join-pass-field').hidden = !state.config.needsPassword;
  $('#join-warning').hidden = state.config.realtimeReady;
  refreshPresence();
  presenceTimer = setInterval(refreshPresence, 10000);
  if (!$('#join-name').value) $('#join-name').focus();
}

async function refreshPresence() {
  if (state.inRoom) return;
  try {
    const p = await fetch('/api/presence').then((r) => r.json());
    let text = 'Ninguém na sala agora';
    if (p.count && p.names?.length) text = `${listNames(p.names)} ${p.count === 1 ? 'está' : 'estão'} na sala`;
    else if (p.count) text = `${p.count} ${p.count === 1 ? 'pessoa' : 'pessoas'} na sala`;
    $('#presence').textContent = text;
    $('.presence').classList.toggle('empty', !p.count);
  } catch {
    $('#presence').textContent = 'Servidor fora do ar';
  }
}

function listNames(names) {
  if (names.length <= 3) return names.join(', ').replace(/, ([^,]*)$/, ' e $1');
  return `${names.slice(0, 3).join(', ')} e mais ${names.length - 3}`;
}

function onJoinSubmit(event) {
  event.preventDefault();
  const name = $('#join-name').value.trim().slice(0, 32);
  if (!name) return showJoinError('Digite seu nome.');
  store.set('name', name);
  state.micOn = $('#join-mic').checked;
  store.set('joinMic', state.micOn);
  const startCam = $('#join-cam').checked;
  store.set('joinCam', startCam);
  joinInfo = { name, password: $('#join-pass').value, startCam };
  unlockAudio();
  setJoinBusy(true);
  showJoinError('');
  connect();
}

function setJoinBusy(busy) {
  $('#join-btn').disabled = busy;
  $('#join-btn').textContent = busy ? 'Entrando…' : 'Entrar na sala';
}

function showJoinError(text) {
  $('#join-error').textContent = text;
}

// ---------- WebSocket ----------

function connect() {
  if (ws) {
    const old = ws;
    ws = null;
    old.close();
  }
  const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws = socket;
  socket.addEventListener('open', () => {
    reconnectDelay = 1000;
    send({ type: 'join', name: joinInfo.name, password: joinInfo.password, micOn: state.micOn, deafened: state.deafened, resume: state.me });
    for (let i = 0; i < 3; i++) setTimeout(ping, i * 400);
  });
  socket.addEventListener('message', (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    onMessage(msg);
  });
  socket.addEventListener('close', () => {
    if (ws !== socket || state.leaving) return;
    if (!state.inRoom) {
      setJoinBusy(false);
      if (!$('#join-error').textContent) showJoinError('Não foi possível conectar ao servidor.');
      return;
    }
    $('#banner').hidden = false;
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 10000);
  });
}

function send(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function onMessage(msg) {
  switch (msg.type) {
    case 'welcome':
      return onWelcome(msg);
    case 'error':
      if (!state.inRoom) {
        setJoinBusy(false);
        showJoinError(msg.message);
      } else toast(msg.message);
      return;
    case 'pong':
      return onPong(msg);
    case 'notice':
      return toast(msg.text);
    case 'participant:joined':
      state.participants.set(msg.participant.id, msg.participant);
      sound('join');
      return renderAll();
    case 'participant:updated': {
      const prev = state.participants.get(msg.participant.id);
      state.participants.set(msg.participant.id, msg.participant);
      if (prev && prev.name !== msg.participant.name) applyVolumes();
      renderPeople();
      return renderStage();
    }
    case 'participant:left':
      state.participants.delete(msg.id);
      for (const s of [...state.streams.values()]) if (s.ownerId === msg.id) state.streams.delete(s.id);
      sound('leave');
      reconcile();
      return renderAll();
    case 'stream:added':
      return onStreamAdded(msg.stream);
    case 'stream:removed':
      state.streams.delete(msg.id);
      state.watching.delete(msg.id);
      reconcile();
      return renderAll();
    case 'chat':
      return onChat(msg.message);
    case 'music':
      return onMusic(msg.music);
    case 'usage':
      return onUsage(msg.usage);
  }
}

function onWelcome(msg) {
  const previousId = state.me?.id;
  state.me = msg.you;
  $('#banner').hidden = true;
  state.participants = new Map(msg.state.participants.map((p) => [p.id, p]));
  state.streams = new Map(msg.state.streams.map((s) => [s.id, s]));
  state.chat = msg.state.chat;
  for (const id of state.watching) if (!state.streams.has(id)) state.watching.delete(id);

  if (!state.inRoom) enterRoom();
  else if (!msg.resumed) {
    // O servidor esqueceu a gente (reiniciou ou demoramos demais): anuncia de novo o que está no ar.
    if (previousId && local.mic) {
      detachMeter(previousId);
      attachMeter(state.me.id, local.mic.stream);
    }
    for (const entry of localEntries()) if (entry.mids.length) announce(entry);
  }
  onUsage(msg.state.usage);
  onMusic(msg.state.music);
  renderChat();
  renderAll();
  reconcile();
}

function onStreamAdded(stream) {
  const isNew = !state.streams.has(stream.id);
  state.streams.set(stream.id, stream);
  if (isNew && stream.kind === 'screen' && stream.ownerId !== state.me.id) {
    const owner = state.participants.get(stream.ownerId)?.name || 'Alguém';
    if (settings.autoWatch) state.watching.add(stream.id);
    else toast(`${owner} começou a compartilhar (${stream.label})`, { action: 'Assistir', onAction: () => watch(stream.id) });
  }
  reconcile();
  renderAll();
}

function ping() {
  send({ type: 'ping', t0: Date.now() });
}

function onPong({ t0, ts }) {
  const rtt = Date.now() - t0;
  clockSamples.push({ rtt, offset: ts - (t0 + rtt / 2) });
  if (clockSamples.length > 8) clockSamples.shift();
  state.clockOffset = clockSamples.reduce((best, s) => (s.rtt < best.rtt ? s : best)).offset;
}

// ---------- sala ----------

function enterRoom() {
  state.inRoom = true;
  clearInterval(presenceTimer);
  $('#join').hidden = true;
  $('#room').hidden = false;
  setTab(state.tab);

  api = new RtcApi(() => `${state.me.id}:${state.me.token}`);
  sender = makeConnection('sender');
  receiver = makeConnection('receiver');

  music = new MusicPlayer($('#yt-player'), { send, now: serverNow, onTick: renderMusicProgress });
  music.setSilenced(state.deafened);
  $('#music-volume').value = music.volume;
  music.init().catch(() => toast('Não foi possível carregar o player do YouTube.'));

  setInterval(ping, 15000);
  setInterval(reportUsage, 15000);
  setInterval(updateSpeaking, 100);
  new ResizeObserver(layoutGrid).observe($('#grid'));

  if (!state.config.realtimeReady) {
    state.micOn = false;
    sendState();
    toast('Voz e vídeo ainda não foram configurados no servidor.', { timeout: 8000 });
  } else {
    if (state.micOn) startMic();
    if (joinInfo.startCam) startCamera();
  }
}

function leave() {
  state.leaving = true;
  send({ type: 'leave' });
  for (const entry of localEntries()) entry.stream.getTracks().forEach((t) => t.stop());
  sender?.close();
  receiver?.close();
  setTimeout(() => location.reload(), 150);
}

// ---------- transmitir ----------

function makeConnection(role) {
  const conn = new SfuConnection(api, state.config.iceServers);
  conn.addEventListener('failed', () => {
    if (state.leaving) return;
    if (role === 'sender' && sender === conn) rebuildSender();
    if (role === 'receiver' && receiver === conn) rebuildReceiver();
  });
  return conn;
}

async function rebuildSender() {
  sender = makeConnection('sender');
  for (const entry of localEntries()) {
    try {
      await pushEntry(entry);
      announce(entry);
    } catch (err) {
      console.warn('Não consegui retransmitir', entry.label, err);
    }
  }
}

function rebuildReceiver() {
  for (const sub of subs.values()) detachAudio(sub);
  subs.clear();
  receiver = makeConnection('receiver');
  reconcile();
  renderAll();
}

function localEntries() {
  return [local.mic, local.camera, ...local.screens.values()].filter(Boolean);
}

async function pushEntry(entry) {
  const res = await sender.push(entry.items.map(({ track, trackName, encodings }) => ({ track, trackName, encodings })));
  entry.mids = res.map((r) => r.mid);
  entry.senders = res.map((r) => r.sender);
}

function announce(entry) {
  send({
    type: 'stream:publish',
    stream: {
      id: entry.id,
      kind: entry.kind,
      label: entry.label,
      sessionId: sender.sessionId,
      tracks: entry.items.map((item) => ({ trackName: item.trackName, kind: item.track.kind })),
    },
  });
}

// stillWanted evita anunciar algo que a pessoa desligou enquanto ainda conectava.
async function publishLocal(entry, stillWanted) {
  await pushEntry(entry);
  if (!stillWanted()) {
    sender.closeTracks(entry.mids).catch(() => {});
    return;
  }
  announce(entry);
}

function unpublishLocal(entry) {
  send({ type: 'stream:unpublish', id: entry.id });
  entry.stream.getTracks().forEach((t) => t.stop());
  if (entry.mids.length) sender.closeTracks(entry.mids).catch(() => {});
}

async function replaceLocalTrack(entry, track) {
  const item = entry.items[0];
  const old = item.track;
  track.enabled = old.enabled;
  await entry.senders[0]?.replaceTrack(track);
  item.track = track;
  entry.stream = new MediaStream([track]);
  old.stop();
}

function micConstraints() {
  return {
    deviceId: settings.micId ? { ideal: settings.micId } : undefined,
    echoCancellation: true,
    noiseSuppression: settings.noise,
    autoGainControl: true,
  };
}

function cameraConstraints() {
  return {
    deviceId: settings.camId ? { ideal: settings.camId } : undefined,
    facingMode: settings.camId ? undefined : local.facing,
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 30, max: 30 },
  };
}

async function startMic() {
  if (local.mic || micStarting || !state.config.realtimeReady) return;
  micStarting = true;
  let entry = null;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints() });
    const track = stream.getAudioTracks()[0];
    track.enabled = state.micOn;
    const id = `mic-${randomId()}`;
    entry = { id, kind: 'mic', label: 'Microfone', stream, items: [{ track, trackName: `${id}:audio` }], mids: [], senders: [] };
    local.mic = entry;
    attachMeter(state.me.id, stream);
    await publishLocal(entry, () => local.mic === entry);
  } catch (err) {
    if (entry && local.mic === entry) {
      entry.stream.getTracks().forEach((t) => t.stop());
      local.mic = null;
      detachMeter(state.me.id);
    }
    state.micOn = false;
    sendState();
    toast(mediaError(err, 'mic'));
  } finally {
    micStarting = false;
    renderControls();
    renderPeople();
  }
}

function toggleMic() {
  if (state.deafened) {
    state.deafened = false;
    state.micOn = true;
    applyDeafen();
  } else {
    state.micOn = !state.micOn;
  }
  applyMic();
  sound(state.micOn ? 'on' : 'off');
  sendState();
}

function toggleDeafen() {
  state.deafened = !state.deafened;
  if (state.deafened) {
    state.micBeforeDeafen = state.micOn;
    state.micOn = false;
  } else {
    state.micOn = state.micBeforeDeafen;
  }
  applyDeafen();
  applyMic();
  if (!state.deafened) sound('on');
  sendState();
}

function applyMic() {
  if (state.micOn && !local.mic) startMic();
  if (local.mic) local.mic.items[0].track.enabled = state.micOn;
  renderControls();
}

function applyDeafen() {
  for (const el of $$('#audio-sink audio')) el.muted = shouldMute(el);
  music?.setSilenced(state.deafened);
  renderControls();
}

function sendState() {
  const me = state.participants.get(state.me?.id);
  if (me) Object.assign(me, { micOn: state.micOn, deafened: state.deafened });
  send({ type: 'update', micOn: state.micOn, deafened: state.deafened });
  renderPeople();
  renderStage();
}

function toggleCamera() {
  if (local.camera) stopCamera();
  else startCamera();
}

async function startCamera() {
  if (local.camera || camStarting) return;
  if (!state.config.realtimeReady) return toast('Voz e vídeo ainda não foram configurados no servidor.');
  if (state.usage?.blocked) return toast(QUOTA_MSG);
  camStarting = true;
  renderControls();
  let entry = null;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: cameraConstraints() });
    const track = stream.getVideoTracks()[0];
    const id = `cam-${randomId()}`;
    entry = {
      id,
      kind: 'camera',
      label: 'Câmera',
      stream,
      items: [{ track, trackName: `${id}:video`, encodings: [{ maxBitrate: 900_000, maxFramerate: 30 }] }],
      mids: [],
      senders: [],
    };
    local.camera = entry;
    navigator.mediaDevices
      .enumerateDevices()
      .then((list) => {
        local.multipleCams = list.filter((d) => d.kind === 'videoinput').length > 1;
        renderStage();
      })
      .catch(() => {});
    renderStage();
    await publishLocal(entry, () => local.camera === entry);
  } catch (err) {
    if (entry && local.camera === entry) {
      entry.stream.getTracks().forEach((t) => t.stop());
      local.camera = null;
    }
    toast(err.code === 'quota' ? QUOTA_MSG : mediaError(err, 'cam'));
  } finally {
    camStarting = false;
    renderAll();
  }
}

function stopCamera() {
  const entry = local.camera;
  if (!entry) return;
  local.camera = null;
  unpublishLocal(entry);
  renderAll();
}

async function flipCamera() {
  const entry = local.camera;
  if (!entry) return;
  local.facing = local.facing === 'user' ? 'environment' : 'user';
  settings.camId = '';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: cameraConstraints() });
    await replaceLocalTrack(entry, stream.getVideoTracks()[0]);
  } catch (err) {
    toast(mediaError(err, 'cam'));
  }
  renderStage();
}

async function startScreen() {
  if (!canShareScreen) return toast('Este navegador não deixa compartilhar a tela. Use o app no computador.');
  if (!state.config.realtimeReady) return toast('Voz e vídeo ainda não foram configurados no servidor.');
  if (state.usage?.blocked) return toast(QUOTA_MSG);
  const q = QUALITY[settings.quality] || QUALITY['1080p30'];
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { ideal: q.width }, height: { ideal: q.height }, frameRate: { ideal: q.frameRate, max: q.frameRate } },
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: false, restrictOwnAudio: true },
      systemAudio: 'include',
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
    });
  } catch (err) {
    if (err.name !== 'NotAllowedError' && err.name !== 'AbortError') toast(`Não foi possível compartilhar: ${err.message}`);
    return;
  }
  const video = stream.getVideoTracks()[0];
  if ('contentHint' in video) video.contentHint = q.hint;
  const audio = stream.getAudioTracks()[0];
  const id = `screen-${randomId()}`;
  const label = `${SURFACE_NAMES[video.getSettings().displaySurface] || 'Tela'} ${++screenCount}`;
  const items = [{ track: video, trackName: `${id}:video`, encodings: [{ maxBitrate: q.maxBitrate, maxFramerate: q.frameRate }] }];
  if (audio) items.push({ track: audio, trackName: `${id}:audio` });
  const entry = { id, kind: 'screen', label, stream, items, mids: [], senders: [], starting: true };
  local.screens.set(id, entry);
  video.addEventListener('ended', () => stopScreen(id));
  renderAll();
  try {
    await publishLocal(entry, () => local.screens.get(id) === entry);
  } catch (err) {
    if (local.screens.get(id) === entry) {
      local.screens.delete(id);
      stream.getTracks().forEach((t) => t.stop());
    }
    toast(err.code === 'quota' ? QUOTA_MSG : `Não foi possível transmitir: ${err.message}`);
  }
  entry.starting = false;
  renderAll();
}

function stopScreen(id) {
  const entry = local.screens.get(id);
  if (!entry) return;
  local.screens.delete(id);
  state.previewing.delete(id);
  unpublishLocal(entry);
  renderAll();
}

// ---------- receber ----------

function watch(id) {
  if (!state.streams.has(id)) return;
  state.watching.add(id);
  reconcile();
  renderAll();
}

function unwatch(id) {
  state.watching.delete(id);
  if (state.focusKey === `s:${id}`) state.focusKey = null;
  reconcile();
  renderAll();
}

function wantedStreams() {
  const list = [];
  for (const s of state.streams.values()) {
    if (s.ownerId === state.me?.id || !state.participants.has(s.ownerId)) continue;
    if (s.kind === 'screen' && !state.watching.has(s.id)) continue;
    list.push(s);
  }
  return list;
}

function reconcile() {
  if (!receiver || !state.config?.realtimeReady) return;
  const wanted = new Map(wantedStreams().map((s) => [s.id, s]));
  for (const [id, sub] of subs) {
    const s = wanted.get(id);
    if (!s || s.sessionId !== sub.stream.sessionId) unsubscribe(id);
  }
  for (const s of wanted.values()) if (!subs.has(s.id)) subscribe(s);
}

async function subscribe(stream) {
  const sub = { stream, mediaStream: new MediaStream(), mids: [], status: 'loading', audioEls: [], muted: false };
  subs.set(stream.id, sub);
  renderStage();
  try {
    const got = await receiver.pull(stream.tracks.map((t) => ({ sessionId: stream.sessionId, trackName: t.trackName })));
    if (subs.get(stream.id) !== sub) {
      receiver.closeTracks(got.map((g) => g.mid)).catch(() => {});
      return;
    }
    sub.mids = got.map((g) => g.mid);
    for (const g of got) sub.mediaStream.addTrack(g.track);
    sub.status = 'ok';
    retries.delete(stream.id);
    attachAudio(sub);
  } catch (err) {
    if (subs.get(stream.id) !== sub) return;
    sub.status = 'error';
    if (err.code === 'quota') {
      warnQuota();
      if (stream.kind === 'screen') state.watching.delete(stream.id);
    } else {
      scheduleRetry(stream.id, sub);
    }
  }
  renderStage();
  renderPeople();
}

function scheduleRetry(id, sub) {
  const attempt = (retries.get(id) || 0) + 1;
  retries.set(id, attempt);
  setTimeout(() => {
    if (subs.get(id) !== sub) return;
    subs.delete(id);
    reconcile();
  }, Math.min(2000 * attempt, 30000));
}

function unsubscribe(id) {
  const sub = subs.get(id);
  if (!sub) return;
  subs.delete(id);
  detachAudio(sub);
  if (sub.mids.length) receiver?.closeTracks(sub.mids).catch(() => {});
  renderStage();
}

function attachAudio(sub) {
  for (const track of sub.mediaStream.getAudioTracks()) {
    const el = document.createElement('audio');
    el.autoplay = true;
    el.dataset.owner = sub.stream.ownerId;
    el.dataset.kind = sub.stream.kind;
    el.dataset.stream = sub.stream.id;
    el.srcObject = new MediaStream([track]);
    el.volume = sub.stream.kind === 'mic' ? volumeFor(sub.stream.ownerId) : 1;
    el.muted = shouldMute(el);
    if (settings.outId && el.setSinkId) el.setSinkId(settings.outId).catch(() => {});
    $('#audio-sink').append(el);
    el.play().catch(needAudioUnlock);
    sub.audioEls.push(el);
  }
  if (sub.stream.kind === 'mic') attachMeter(sub.stream.ownerId, sub.mediaStream);
}

function detachAudio(sub) {
  for (const el of sub.audioEls) {
    el.srcObject = null;
    el.remove();
  }
  sub.audioEls = [];
  if (sub.stream.kind === 'mic') detachMeter(sub.stream.ownerId);
}

function shouldMute(el) {
  if (state.deafened) return true;
  return el.dataset.kind === 'screen' && !!subs.get(el.dataset.stream)?.muted;
}

function volumeFor(pid) {
  const name = state.participants.get(pid)?.name;
  return store.get(`vol:${name}`, 100) / 100;
}

function applyVolumes() {
  for (const el of $$('#audio-sink audio[data-kind="mic"]')) el.volume = volumeFor(el.dataset.owner);
}

function needAudioUnlock() {
  if (audioUnlockShown) return;
  audioUnlockShown = true;
  toast('O navegador bloqueou o som da sala.', {
    action: 'Ativar som',
    timeout: 60000,
    onAction: () => {
      audioUnlockShown = false;
      unlockAudio();
      for (const el of $$('#audio-sink audio')) el.play().catch(() => {});
    },
  });
}

// ---------- quem está falando ----------

function unlockAudio() {
  try {
    audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
    audioCtx.resume();
  } catch {
    // sem Web Audio: só perde o indicador de fala e os sons
  }
}

function attachMeter(pid, stream) {
  detachMeter(pid);
  if (!audioCtx || !stream.getAudioTracks().length) return;
  const source = audioCtx.createMediaStreamSource(stream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  meters.set(pid, { source, analyser, data: new Uint8Array(analyser.fftSize), until: 0 });
}

function detachMeter(pid) {
  const meter = meters.get(pid);
  if (!meter) return;
  meter.source.disconnect();
  meters.delete(pid);
}

function updateSpeaking() {
  const now = performance.now();
  const speaking = new Set();
  for (const [pid, meter] of meters) {
    meter.analyser.getByteTimeDomainData(meter.data);
    let sum = 0;
    for (const v of meter.data) sum += ((v - 128) / 128) ** 2;
    const rms = Math.sqrt(sum / meter.data.length);
    const micOn = pid === state.me?.id ? state.micOn : state.participants.get(pid)?.micOn;
    if (micOn && rms > 0.03) meter.until = now + 350;
    if (meter.until > now) speaking.add(pid);
  }
  for (const el of $$('[data-speaker]')) el.classList.toggle('speaking', speaking.has(el.dataset.speaker));
}

// ---------- uso do plano grátis ----------

// Soma o que chegou do Cloudflare (é isso que conta no plano grátis) e manda para o servidor.
async function reportUsage() {
  const pc = receiver?.pc;
  if (!pc) return;
  if (usagePc !== pc) {
    usageSeen.clear();
    usagePc = pc;
  }
  let delta = 0;
  try {
    const stats = await pc.getStats();
    stats.forEach((report) => {
      if (report.type !== 'inbound-rtp') return;
      const total = (report.bytesReceived || 0) + (report.headerBytesReceived || 0);
      const previous = usageSeen.get(report.id) || 0;
      if (total > previous) delta += total - previous;
      usageSeen.set(report.id, total);
    });
  } catch {
    return;
  }
  if (delta > 0) send({ type: 'usage', bytes: delta });
}

function onUsage(usage) {
  state.usage = usage;
  if (usage?.blocked) {
    warnQuota();
    if (local.camera) stopCamera();
    for (const id of [...local.screens.keys()]) stopScreen(id);
  } else {
    quotaWarned = false;
  }
  renderUsage();
  renderControls();
}

function warnQuota() {
  if (quotaWarned) return;
  quotaWarned = true;
  toast(QUOTA_MSG, { timeout: 10000 });
}

// ---------- telas e participantes ----------

function sortedParticipants() {
  return [...state.participants.values()].sort((a, b) => {
    if (a.id === state.me?.id) return -1;
    if (b.id === state.me?.id) return 1;
    return a.joinedAt - b.joinedAt;
  });
}

function cameraOf(pid) {
  for (const s of state.streams.values()) if (s.ownerId === pid && s.kind === 'camera') return s;
  return null;
}

function screenCountOf(pid) {
  if (pid === state.me?.id) return local.screens.size;
  let count = 0;
  for (const s of state.streams.values()) if (s.ownerId === pid && s.kind === 'screen') count++;
  return count;
}

function screenList() {
  const list = [];
  for (const e of local.screens.values()) list.push({ id: e.id, ownerId: state.me.id, label: e.label, mine: true, starting: e.starting });
  for (const s of state.streams.values()) {
    if (s.kind === 'screen' && s.ownerId !== state.me?.id && state.participants.has(s.ownerId)) {
      list.push({ id: s.id, ownerId: s.ownerId, label: s.label, mine: false });
    }
  }
  return list;
}

function initials(name = '?') {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] || '?') + (parts.length > 1 ? parts.at(-1)[0] : '')).toUpperCase();
}

// ---------- render ----------

function renderAll() {
  if (!state.inRoom) return;
  renderControls();
  renderPeople();
  renderStage();
}

function renderControls() {
  const mic = $('#btn-mic');
  mic.innerHTML = icon(state.micOn ? 'mic' : 'mic-off');
  mic.classList.toggle('off', !state.micOn);
  mic.disabled = micStarting;
  mic.title = mic.ariaLabel = state.micOn ? 'Desligar o microfone' : 'Ligar o microfone';

  const deafen = $('#btn-deafen');
  deafen.innerHTML = icon(state.deafened ? 'headphones-off' : 'headphones');
  deafen.classList.toggle('off', state.deafened);
  deafen.title = deafen.ariaLabel = state.deafened ? 'Voltar a ouvir' : 'Parar de ouvir a sala';

  const blocked = !!state.usage?.blocked;
  const cam = $('#btn-cam');
  cam.innerHTML = icon(local.camera ? 'video' : 'video-off');
  cam.classList.toggle('on', !!local.camera);
  cam.disabled = camStarting || (blocked && !local.camera);
  cam.title = cam.ariaLabel = local.camera ? 'Desligar a câmera' : 'Ligar a câmera';

  const screen = $('#btn-screen');
  screen.hidden = !canShareScreen;
  screen.innerHTML = icon('screen-share') + (local.screens.size ? `<span class="ctl-count">${local.screens.size}</span>` : '');
  screen.classList.toggle('on', local.screens.size > 0);
  screen.disabled = blocked;
  screen.title = screen.ariaLabel = local.screens.size ? 'Compartilhar mais uma tela ou janela' : 'Compartilhar tela ou janela';
}

function renderPeople() {
  if (!state.inRoom) return;
  $('#people-count').textContent = state.participants.size;
  const items = sortedParticipants().map((p) => {
    const mine = p.id === state.me.id;
    const hasCam = mine ? !!local.camera : !!cameraOf(p.id);
    const screens = screenCountOf(p.id);
    const li = document.createElement('li');
    li.className = 'person';
    li.dataset.speaker = p.id;
    li.dataset.id = p.id;
    li.classList.toggle('offline', !p.online);
    li.classList.toggle('expanded', state.expanded === p.id && !mine);

    const status = !p.online
      ? 'Reconectando…'
      : [hasCam && 'câmera ligada', screens && `${screens} ${screens > 1 ? 'telas' : 'tela'} ao vivo`].filter(Boolean).join(' · ') ||
        (p.deafened ? 'Sem ouvir' : p.micOn ? 'Na call' : 'Mutado');
    const icons = [
      !p.micOn && icon('mic-off', 'bad'),
      p.deafened && icon('headphones-off', 'bad'),
      hasCam && icon('video'),
      screens && icon('monitor'),
    ]
      .filter(Boolean)
      .join('');

    li.innerHTML = `
      <div class="person-row">
        <div class="avatar sm"></div>
        <div class="person-main"><div class="person-name"></div><div class="person-status"></div></div>
        <div class="person-icons">${icons}</div>
      </div>`;
    const avatar = $('.avatar', li);
    avatar.textContent = initials(p.name);
    avatar.style.setProperty('--c', p.color);
    $('.person-name', li).textContent = mine ? `${p.name} (você)` : p.name;
    $('.person-status', li).textContent = status;
    if (!mine) {
      li.title = 'Clique para ajustar o volume';
      if (state.expanded === p.id) {
        const vol = document.createElement('label');
        vol.className = 'person-vol';
        vol.innerHTML = `${icon('volume')}<input type="range" min="0" max="100" aria-label="Volume">`;
        $('input', vol).value = Math.round(volumeFor(p.id) * 100);
        li.append(vol);
      }
    }
    return li;
  });
  $('#people').replaceChildren(...items);
}

function onPeopleClick(event) {
  if (event.target.closest('.person-vol')) return;
  const li = event.target.closest('.person');
  if (!li || li.dataset.id === state.me.id) return;
  state.expanded = state.expanded === li.dataset.id ? null : li.dataset.id;
  renderPeople();
}

function onPeopleInput(event) {
  const li = event.target.closest('.person');
  if (!li) return;
  const name = state.participants.get(li.dataset.id)?.name;
  store.set(`vol:${name}`, Number(event.target.value));
  applyVolumes();
}

function tileKeys() {
  const keys = [];
  for (const s of screenList()) {
    if (s.mine ? state.previewing.has(s.id) : subs.has(s.id)) keys.push(`s:${s.id}`);
  }
  for (const p of sortedParticipants()) keys.push(`p:${p.id}`);
  return keys;
}

function renderStage() {
  if (!state.inRoom) return;
  const keys = tileKeys();
  if (state.focusKey && !keys.includes(state.focusKey)) state.focusKey = null;
  for (const [key, tile] of tiles) {
    if (keys.includes(key)) continue;
    tile.el.remove();
    tiles.delete(key);
  }
  const grid = $('#grid');
  const focus = $('#focus');
  for (const key of keys) updateTile(key, tiles.get(key) || createTile(key));

  if (state.focusKey) {
    const el = tiles.get(state.focusKey).el;
    if (el.parentElement !== focus) focus.append(el);
  }
  keys
    .filter((k) => k !== state.focusKey)
    .forEach((key, i) => {
      const el = tiles.get(key).el;
      if (grid.children[i] !== el) grid.insertBefore(el, grid.children[i] || null);
    });
  for (const tile of tiles.values()) if (tile.stream && tile.video.paused) tile.video.play().catch(() => {});

  $('#stage').classList.toggle('has-focus', !!state.focusKey);
  $('#focus').hidden = !state.focusKey;
  renderLivebar();
  layoutGrid();
}

function createTile(key) {
  const el = document.createElement('div');
  el.className = 'tile';
  el.innerHTML = `
    <video autoplay playsinline muted></video>
    <div class="avatar"></div>
    <div class="tile-status"></div>
    <div class="tile-label"><span class="tile-icons"></span><span class="name"></span></div>
    <div class="tile-actions"></div>`;
  const tile = {
    el,
    video: $('video', el),
    avatar: $('.avatar', el),
    status: $('.tile-status', el),
    name: $('.name', el),
    icons: $('.tile-icons', el),
    actions: $('.tile-actions', el),
    stream: null,
    actionsKey: '',
    iconsKey: '',
  };
  el.addEventListener('dblclick', () => toggleFullscreen(tile));
  tile.actions.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (button) tileAction(key, button.dataset.act, tile);
  });
  tiles.set(key, tile);
  return tile;
}

const ACTIONS = {
  flip: ['flip', 'Virar a câmera'],
  mute: ['volume', 'Silenciar o som da tela'],
  unmute: ['volume-off', 'Ativar o som da tela'],
  focus: ['focus', 'Destacar'],
  fullscreen: ['maximize', 'Tela cheia'],
  close: ['x', 'Fechar'],
};

function updateTile(key, tile) {
  const type = key[0];
  const id = key.slice(2);
  let stream = null;
  let name = '';
  let status = '';
  let speaker = '';
  let mirror = false;
  let icons = '';
  let actions = ['focus', 'fullscreen'];

  if (type === 'p') {
    const p = state.participants.get(id);
    const mine = id === state.me.id;
    name = mine ? `${p.name} (você)` : p.name;
    speaker = id;
    tile.avatar.textContent = initials(p.name);
    tile.el.style.setProperty('--c', p.color);
    if (mine) {
      stream = local.camera?.stream || null;
      mirror = !!local.camera && local.facing === 'user' && !settings.camId;
      if (local.camera && local.multipleCams) actions = ['flip', ...actions];
    } else {
      const cam = cameraOf(id);
      const sub = cam && subs.get(cam.id);
      stream = sub?.status === 'ok' ? sub.mediaStream : null;
    }
    icons = [!p.micOn && icon('mic-off', 'bad'), p.deafened && icon('headphones-off', 'bad')].filter(Boolean).join('');
    tile.el.classList.toggle('offline', !p.online);
    if (!p.online) status = 'Reconectando…';
  } else {
    const info = screenList().find((s) => s.id === id);
    const owner = state.participants.get(info.ownerId);
    name = `${info.mine ? 'Você' : owner?.name || '?'} · ${info.label}`;
    tile.el.style.setProperty('--c', owner?.color || '');
    actions = [...actions, 'close'];
    if (info.mine) {
      stream = local.screens.get(id)?.stream || null;
    } else {
      const sub = subs.get(id);
      stream = sub?.status === 'ok' ? sub.mediaStream : null;
      if (sub?.status === 'loading') status = 'Abrindo a tela…';
      if (sub?.status === 'error') status = 'Não deu para abrir. Tentando de novo…';
      if (sub?.mediaStream.getAudioTracks().length) actions = [sub.muted ? 'unmute' : 'mute', ...actions];
    }
  }

  tile.el.classList.toggle('screen', type === 's');
  tile.el.classList.toggle('mirror', mirror);
  tile.el.classList.toggle('has-video', !!stream?.getVideoTracks().length);
  tile.el.dataset.speaker = speaker;
  if (tile.stream !== stream) {
    tile.stream = stream;
    tile.video.srcObject = stream;
  }
  tile.name.textContent = name;
  tile.status.textContent = status;
  tile.status.hidden = !status;
  if (tile.iconsKey !== icons) {
    tile.iconsKey = icons;
    tile.icons.innerHTML = icons;
  }
  const actionsKey = actions.join();
  if (tile.actionsKey !== actionsKey) {
    tile.actionsKey = actionsKey;
    tile.actions.innerHTML = actions
      .map((act) => `<button class="tile-btn" type="button" data-act="${act}" title="${ACTIONS[act][1]}" aria-label="${ACTIONS[act][1]}">${icon(ACTIONS[act][0])}</button>`)
      .join('');
  }
}

function tileAction(key, act, tile) {
  const id = key.slice(2);
  if (act === 'focus') {
    state.focusKey = state.focusKey === key ? null : key;
    renderStage();
  } else if (act === 'fullscreen') {
    toggleFullscreen(tile);
  } else if (act === 'flip') {
    flipCamera();
  } else if (act === 'mute' || act === 'unmute') {
    const sub = subs.get(id);
    if (!sub) return;
    sub.muted = act === 'mute';
    for (const el of sub.audioEls) el.muted = shouldMute(el);
    renderStage();
  } else if (act === 'close') {
    if (local.screens.has(id)) {
      state.previewing.delete(id);
      renderStage();
    } else {
      unwatch(id);
    }
  }
}

function toggleFullscreen(tile) {
  if (document.fullscreenElement) return document.exitFullscreen().catch(() => {});
  if (tile.el.requestFullscreen) tile.el.requestFullscreen().catch(() => {});
  else tile.video.webkitEnterFullscreen?.();
}

// Escolhe o número de colunas que deixa os quadros (16:9) maiores no espaço disponível.
function layoutGrid() {
  const grid = $('#grid');
  if (state.focusKey) return grid.style.removeProperty('--tile-w');
  const n = grid.children.length;
  if (!n) return;
  const gap = 8;
  const width = grid.clientWidth;
  const height = grid.clientHeight;
  let best = 0;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    let w = (width - gap * (cols - 1)) / cols;
    const h = (w * 9) / 16;
    if (h * rows + gap * (rows - 1) > height) w = (((height - gap * (rows - 1)) / rows) * 16) / 9;
    best = Math.max(best, Math.floor(w));
  }
  grid.style.setProperty('--tile-w', `${Math.max(best, 120)}px`);
}

function renderLivebar() {
  const bar = $('#livebar');
  const list = screenList();
  bar.hidden = !list.length;
  bar.replaceChildren(
    ...list.map((s) => {
      const owner = state.participants.get(s.ownerId);
      const chip = document.createElement('div');
      chip.className = 'chip';
      chip.style.setProperty('--c', owner?.color || '');
      chip.innerHTML = `<span class="live-dot"></span><span class="chip-text"></span>`;
      $('.chip-text', chip).textContent = `${s.mine ? 'Você' : owner?.name || '?'} · ${s.label}`;
      const buttons = [];
      if (s.mine) {
        if (s.starting) buttons.push(['', 'Iniciando…', 'ghost', true]);
        else buttons.push([state.previewing.has(s.id) ? 'hide' : 'preview', state.previewing.has(s.id) ? 'Esconder' : 'Ver', 'ghost']);
        buttons.push(['stop', 'Parar', 'danger']);
      } else {
        buttons.push(state.watching.has(s.id) ? ['unwatch', 'Fechar', 'ghost'] : ['watch', 'Assistir', '']);
      }
      for (const [act, text, variant, disabled] of buttons) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `chip-btn ${variant}`;
        b.textContent = text;
        b.dataset.act = act;
        b.dataset.id = s.id;
        b.disabled = !!disabled;
        chip.append(b);
      }
      return chip;
    }),
  );
}

function onLivebarClick(event) {
  const b = event.target.closest('button[data-act]');
  if (!b) return;
  const { act, id } = b.dataset;
  if (act === 'watch') watch(id);
  if (act === 'unwatch') unwatch(id);
  if (act === 'stop') stopScreen(id);
  if (act === 'preview') state.previewing.add(id);
  if (act === 'hide') state.previewing.delete(id);
  renderStage();
}

// ---------- abas e chat ----------

function setTab(tab) {
  state.tab = tab;
  if (tab === 'chat') state.unread = 0;
  for (const b of $$('.tab')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  for (const panel of $$('[data-panel]')) panel.classList.toggle('inactive', panel.dataset.panel !== tab);
  renderBadge();
  if (tab === 'chat') scrollChat();
}

function renderBadge() {
  const badge = $('#chat-badge');
  badge.hidden = !state.unread;
  badge.textContent = state.unread > 9 ? '9+' : state.unread;
}

function onChat(message) {
  state.chat.push(message);
  if (state.chat.length > 200) state.chat.shift();
  const box = $('#messages');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  box.append(chatEl(message));
  if (nearBottom || message.pid === state.me?.id) scrollChat();
  if (!message.system && message.pid !== state.me?.id && (state.tab !== 'chat' || $('#room').classList.contains('side-hidden'))) {
    state.unread++;
    renderBadge();
  }
}

function renderChat() {
  $('#messages').replaceChildren(...state.chat.map(chatEl));
  scrollChat();
}

function scrollChat() {
  const box = $('#messages');
  box.scrollTop = box.scrollHeight;
}

function chatEl(m) {
  const el = document.createElement('div');
  if (m.system) {
    el.className = 'msg system';
    el.textContent = m.text;
    return el;
  }
  el.className = 'msg';
  el.innerHTML = `<div class="avatar xs"></div><div class="msg-body"><div class="msg-head"><span class="msg-name"></span><span class="msg-time"></span></div><div class="msg-text"></div></div>`;
  const avatar = $('.avatar', el);
  avatar.textContent = initials(m.name);
  avatar.style.setProperty('--c', m.color);
  $('.msg-name', el).textContent = m.name;
  $('.msg-time', el).textContent = new Date(m.ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  linkify($('.msg-text', el), m.text);
  return el;
}

function linkify(el, text) {
  let last = 0;
  for (const match of text.matchAll(/https?:\/\/[^\s<]+/g)) {
    el.append(text.slice(last, match.index));
    const a = document.createElement('a');
    a.href = match[0];
    a.textContent = match[0];
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    el.append(a);
    last = match.index + match[0].length;
  }
  el.append(text.slice(last));
}

// ---------- música ----------

function onMusic(m) {
  state.music = m;
  music?.setState(m);
  renderMusic();
}

function renderMusic() {
  const m = state.music;
  const current = m?.current;
  $('#np-title').textContent = current ? current.title : 'Nada tocando';
  $('#np-by').textContent = current ? `colocada por ${current.by}` : 'Cole um link do YouTube aqui embaixo para começar.';
  $('#yt-empty').hidden = !!current;
  for (const button of [$('#music-toggle'), $('#mini-toggle')]) {
    button.innerHTML = icon(m?.playing ? 'pause' : 'play');
    button.disabled = !current;
  }
  $('#music-skip').disabled = !current;
  $('#mini').hidden = !current;
  $('#mini-title').textContent = current?.title || '';
  $('#queue-count').textContent = m?.queue.length ? `(${m.queue.length})` : '';
  $('#queue-empty').hidden = !!m?.queue.length;
  $('#queue').replaceChildren(
    ...(m?.queue || []).map((item) => {
      const li = document.createElement('li');
      li.innerHTML = `<img alt="" loading="lazy"><div class="queue-main"><div class="queue-title"></div><div class="queue-by"></div></div><button class="icon-btn sm" type="button" aria-label="Tirar da fila">${icon('x')}</button>`;
      $('img', li).src = `https://i.ytimg.com/vi/${item.videoId}/mqdefault.jpg`;
      $('.queue-title', li).textContent = item.title;
      $('.queue-by', li).textContent = `colocada por ${item.by}`;
      $('button', li).dataset.remove = item.id;
      return li;
    }),
  );
  renderMusicProgress();
}

function renderMusicProgress() {
  const current = state.music?.current;
  const time = current && music ? music.currentTime() : 0;
  const duration = current ? (music?.duration() || current.duration || 0) : 0;
  $('#progress-fill').style.width = duration ? `${Math.min(100, (time / duration) * 100)}%` : '0%';
  $('#time-cur').textContent = fmtTime(time);
  $('#time-dur').textContent = fmtTime(duration);
}

function fmtTime(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${rest}` : `${m}:${rest}`;
}

function toggleMusic() {
  if (!state.music?.current) return;
  send({ type: state.music.playing ? 'music:pause' : 'music:play' });
}

function skipMusic() {
  if (state.music?.current) send({ type: 'music:skip', itemId: state.music.current.id });
}

function seekMusic(event) {
  const duration = music?.duration() || state.music?.current?.duration;
  if (!duration) return;
  const rect = event.currentTarget.getBoundingClientRect();
  send({ type: 'music:seek', t: ((event.clientX - rect.left) / rect.width) * duration });
}

// ---------- configurações ----------

async function openSettings() {
  $('#set-name').value = state.participants.get(state.me.id)?.name || '';
  $('#set-noise').checked = settings.noise;
  $('#set-quality').value = settings.quality;
  $('#set-autowatch').checked = settings.autoWatch;
  $('#set-out-field').hidden = !('setSinkId' in HTMLMediaElement.prototype);
  renderUsage();
  $('#settings').showModal();
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    fillDevices($('#set-mic'), devices, 'audioinput', settings.micId, 'Microfone');
    fillDevices($('#set-out'), devices, 'audiooutput', settings.outId, 'Saída');
    fillDevices($('#set-cam'), devices, 'videoinput', settings.camId, 'Câmera');
  } catch {
    // sem lista de dispositivos: fica no padrão do sistema
  }
}

function fillDevices(select, devices, kind, selected, fallback) {
  const list = devices.filter((d) => d.kind === kind && d.deviceId !== 'default' && d.deviceId !== 'communications');
  const options = [new Option('Padrão do sistema', '')];
  list.forEach((d, i) => options.push(new Option(d.label || `${fallback} ${i + 1}`, d.deviceId)));
  select.replaceChildren(...options);
  select.value = list.some((d) => d.deviceId === selected) ? selected : '';
}

function bindSettings() {
  $('#set-name').addEventListener('change', (e) => {
    const name = e.target.value.trim().slice(0, 32);
    if (!name) return;
    store.set('name', name);
    if (joinInfo) joinInfo.name = name;
    send({ type: 'update', name });
  });
  $('#set-mic').addEventListener('change', async (e) => {
    settings.micId = e.target.value;
    store.set('micId', settings.micId);
    if (!local.mic) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints() });
      await replaceLocalTrack(local.mic, stream.getAudioTracks()[0]);
      attachMeter(state.me.id, local.mic.stream);
    } catch (err) {
      toast(mediaError(err, 'mic'));
    }
  });
  $('#set-out').addEventListener('change', (e) => {
    settings.outId = e.target.value;
    store.set('outId', settings.outId);
    for (const el of $$('#audio-sink audio')) el.setSinkId?.(settings.outId).catch(() => {});
  });
  $('#set-cam').addEventListener('change', async (e) => {
    settings.camId = e.target.value;
    store.set('camId', settings.camId);
    if (!local.camera) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: cameraConstraints() });
      await replaceLocalTrack(local.camera, stream.getVideoTracks()[0]);
    } catch (err) {
      toast(mediaError(err, 'cam'));
    }
    renderStage();
  });
  $('#set-noise').addEventListener('change', (e) => {
    settings.noise = e.target.checked;
    store.set('noise', settings.noise);
    local.mic?.items[0].track.applyConstraints({ noiseSuppression: settings.noise }).catch(() => {});
  });
  $('#set-quality').addEventListener('change', (e) => {
    settings.quality = e.target.value;
    store.set('quality', settings.quality);
  });
  $('#set-autowatch').addEventListener('change', (e) => {
    settings.autoWatch = e.target.checked;
    store.set('autoWatch', settings.autoWatch);
    if (settings.autoWatch) for (const s of screenList()) if (!s.mine) watch(s.id);
  });
}

function renderUsage() {
  const u = state.usage;
  if (!u) return;
  $('#usage-text').textContent = `${u.usedGB.toLocaleString('pt-BR')} de ${u.limitGB.toLocaleString('pt-BR')} GB`;
  const fill = $('#usage-fill');
  const ratio = Math.min(1, u.usedGB / u.limitGB);
  fill.style.width = `${ratio * 100}%`;
  fill.classList.toggle('warn', ratio > 0.8);
}

// ---------- ligações da interface ----------

function bindRoomUi() {
  $('#btn-mic').addEventListener('click', toggleMic);
  $('#btn-deafen').addEventListener('click', toggleDeafen);
  $('#btn-cam').addEventListener('click', toggleCamera);
  $('#btn-screen').addEventListener('click', startScreen);
  $('#btn-leave').addEventListener('click', leave);
  $('#btn-settings').addEventListener('click', openSettings);
  $('#btn-side').addEventListener('click', () => {
    const hidden = $('#room').classList.toggle('side-hidden');
    store.set('sideHidden', hidden);
    if (!hidden && state.tab === 'chat') {
      state.unread = 0;
      renderBadge();
    }
    requestAnimationFrame(layoutGrid);
  });
  $('#room').classList.toggle('side-hidden', store.get('sideHidden', false));
  for (const tab of $$('.tab')) tab.addEventListener('click', () => setTab(tab.dataset.tab));
  $('#livebar').addEventListener('click', onLivebarClick);
  $('#people').addEventListener('click', onPeopleClick);
  $('#people').addEventListener('input', onPeopleInput);

  $('#chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#chat-input');
    const text = input.value.trim();
    if (!text) return;
    send({ type: 'chat', text });
    input.value = '';
  });
  $('#music-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#music-url');
    const url = input.value.trim();
    if (!url) return;
    send({ type: 'music:add', url });
    input.value = '';
  });
  $('#music-toggle').addEventListener('click', toggleMusic);
  $('#mini-toggle').addEventListener('click', toggleMusic);
  $('#music-skip').addEventListener('click', skipMusic);
  $('#mini-skip').addEventListener('click', skipMusic);
  $('#mini-title').addEventListener('click', () => {
    $('#room').classList.remove('side-hidden');
    setTab('music');
  });
  $('#music-volume').addEventListener('input', (e) => music?.setVolume(Number(e.target.value)));
  $('#progress').addEventListener('click', seekMusic);
  $('#queue').addEventListener('click', (e) => {
    const b = e.target.closest('[data-remove]');
    if (b) send({ type: 'music:remove', itemId: b.dataset.remove });
  });
  bindSettings();

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.focusKey && !document.fullscreenElement) {
      state.focusKey = null;
      renderStage();
    }
  });
  window.addEventListener('pagehide', () => {
    if (state.inRoom && !state.leaving) send({ type: 'leave' });
  });
}

// ---------- instalar como app ----------

let installPrompt = null;

function setupInstall() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installPrompt = e;
    updateInstallButtons();
  });
  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    updateInstallButtons();
    toast('App instalado!');
  });
  for (const b of $$('[data-install]')) b.addEventListener('click', install);
  updateInstallButtons();
}

function isStandalone() {
  return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

function updateInstallButtons() {
  for (const b of $$('[data-install]')) b.hidden = isStandalone();
}

async function install() {
  if (installPrompt) {
    installPrompt.prompt();
    await installPrompt.userChoice.catch(() => {});
    installPrompt = null;
    return updateInstallButtons();
  }
  $('#install-help').showModal();
}

// ---------- utilidades ----------

function sound(kind) {
  if (!audioCtx || state.deafened) return;
  const notes = { join: [523, 784], leave: [784, 523], on: [660], off: [440] }[kind];
  const t0 = audioCtx.currentTime;
  notes.forEach((freq, i) => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    const start = t0 + i * 0.09;
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(0.05, start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.16);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(start);
    osc.stop(start + 0.18);
  });
}

function toast(text, { action, onAction, timeout = 5000 } = {}) {
  const el = document.createElement('div');
  el.className = 'toast';
  const span = document.createElement('span');
  span.textContent = text;
  el.append(span);
  if (action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn small';
    b.textContent = action;
    b.addEventListener('click', () => {
      onAction();
      el.remove();
    });
    el.append(b);
  }
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'icon-btn sm';
  close.ariaLabel = 'Fechar aviso';
  close.innerHTML = icon('x');
  close.addEventListener('click', () => el.remove());
  el.append(close);
  $('#toasts').append(el);
  setTimeout(() => el.remove(), timeout);
}

function mediaError(err, what) {
  const name = what === 'mic' ? 'o microfone' : 'a câmera';
  if (err?.name === 'NotAllowedError') return `Sem permissão para usar ${name}. Libere nas permissões do site.`;
  if (err?.name === 'NotFoundError' || err?.name === 'OverconstrainedError') return `Não encontrei ${name} neste aparelho.`;
  if (err?.name === 'NotReadableError') return `${what === 'mic' ? 'O microfone' : 'A câmera'} está sendo usado por outro programa.`;
  return `Problema com ${name}: ${err?.message || err}`;
}
