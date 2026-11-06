import { makeDraggable } from './drag.js';
import { explain } from './explain.js';
import { icon } from './icons.js';
import { MusicPlayer, playlistVideos } from './music.js';
import { RtcApi, SfuConnection } from './rtc.js';
import { compactWav } from './wav.js';

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
const REBUILD_DELAYS = [0, 2000, 5000, 10000, 20000, 30000];
const SOUND_MAX_SECONDS = 180;
const SOUND_MAX_BYTES = 10 * 1024 * 1024; // o mesmo limite do servidor
const canShareScreen = !!navigator.mediaDevices?.getDisplayMedia;

const settings = {
  micId: store.get('micId', ''),
  camId: store.get('camId', ''),
  outId: store.get('outId', ''),
  noise: store.get('noise', true),
  quality: store.get('quality', '1080p30'),
  // Live de alguém da sala abre sozinha (dá para desligar em Configurações para gastar menos dados).
  autoWatch: store.get('autoWatch', true),
};

const state = {
  config: null,
  me: null,
  inRoom: false,
  leaving: false,
  participants: new Map(),
  streams: new Map(),
  account: null, // a conta logada: { id, email, name, admin }
  servers: new Map(),
  server: store.get('server', null), // servidor aberto na lista de canais
  channels: new Map(),
  musics: new Map(), // id da sala de voz -> os vídeos dela
  sounds: [],
  music: null, // os vídeos da sala de voz em que estou
  usage: null,
  voice: null, // sala de voz em que estou
  view: store.get('view', null), // canal de texto aberto no meio da tela
  micOn: store.get('joinMic', true),
  deafened: false,
  micBeforeDeafen: true,
  watching: new Set(),
  previewing: new Set(),
  pinned: [], // quadros fixados (p:<pessoa> e s:<tela>), na ordem em que aparecem
  tileOrder: null, // a ordem que a pessoa arrastou no palco (null = a de sempre: telas e depois quem chegou antes)
  dm: false, // vendo as conversas privadas (em vez de um servidor)
  videoOnStage: false, // o vídeo do YouTube virou um quadro do palco
  dmView: null, // a conversa privada aberta
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
const recentErrors = new Map();
const rebuildAttempts = { sender: 0, receiver: 0 };

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
let textChat = null;
let voiceChat = null;
let authReady = Promise.resolve();

const serverNow = () => Date.now() + state.clockOffset;
const randomId = () => Math.random().toString(36).slice(2, 10);

// ---------- entrada ----------

async function init() {
  for (const el of $$('[data-icon]')) el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon));
  setupInstall();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

  $('#join-email').value = store.get('email', '');
  $('#join-mic').checked = state.micOn;
  $('#join-cam').checked = store.get('joinCam', false);
  $('#join-form').addEventListener('submit', onJoinSubmit);
  bindAuthUi();
  bindRoomUi();

  try {
    state.config = await fetch('/api/config').then((r) => r.json());
  } catch {
    state.config = { realtimeReady: false, iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }] };
  }
  $('#join-warning').hidden = state.config.realtimeReady;
  setAuthMode(store.get('email', '') ? 'login' : 'register');
  refreshPresence();
  presenceTimer = setInterval(refreshPresence, 10000);
  // Link de convite (#convite=CODIGO): guarda o código para entrar no servidor depois do login.
  const invite = /^#convite=([\w-]+)$/.exec(location.hash);
  if (invite) {
    history.replaceState(null, '', location.pathname + location.search);
    store.set('invite', invite[1]);
  }
  showInvite();
  // Links dos e-mails: #confirmar=TOKEN (ativa a conta e já entra) e #senha=TOKEN (escolher senha nova).
  const link = /^#(confirmar|senha)=([\w-]+)$/.exec(location.hash);
  if (link) {
    history.replaceState(null, '', location.pathname + location.search);
    return openEmailLink(link[1], link[2]);
  }
  // Já entrou neste aparelho antes: vai direto para a sala.
  state.account = await fetch('/api/auth/me').then((r) => r.json()).catch(() => null);
  if (state.account) return enterWithAccount();
  (store.get('email', '') ? $('#join-pass') : $('#join-name')).focus();
}

// ---------- conta ----------

const AUTH_MODES = {
  login: { title: 'Entrar', sub: 'Que bom te ver de novo.', button: 'Entrar', busy: 'Entrando…', ask: 'Ainda não tem conta?', to: 'register', link: 'Criar conta' },
  register: { title: 'Criar conta', sub: 'Leva um minuto. Depois é só confirmar o e-mail.', button: 'Criar conta', busy: 'Criando a conta…', ask: 'Já tem conta?', to: 'login', link: 'Entrar' },
  forgot: { title: 'Esqueci minha senha', sub: 'Mandamos um link para você escolher uma senha nova.', button: 'Mandar o link', busy: 'Mandando…', ask: 'Lembrou?', to: 'login', link: 'Voltar para entrar' },
  reset: { title: 'Senha nova', sub: 'Escolha a senha nova da sua conta.', button: 'Salvar e entrar', busy: 'Salvando…', ask: '', to: 'login', link: 'Voltar para entrar' },
  sent: { title: 'Veja seu e-mail', sub: '', button: '', busy: '', ask: '', to: 'login', link: 'Voltar para entrar' },
};

let authMode = 'login';
let resetToken = null; // do link de "Esqueci minha senha"
let pendingEmail = null; // cadastro esperando a confirmação, para "Mandar o e-mail de novo"

function setAuthMode(mode, sentText) {
  authMode = mode;
  const m = AUTH_MODES[mode];
  $('#join-title').textContent = m.title;
  $('#join-sub').textContent = m.sub;
  $('#join-sub').hidden = !m.sub;
  $('#field-name').hidden = mode !== 'register';
  $('#field-email').hidden = !['login', 'register', 'forgot'].includes(mode);
  $('#field-pass').hidden = !['login', 'register', 'reset'].includes(mode);
  $('#forgot-link').hidden = mode !== 'login';
  $('#join-prefs').hidden = mode !== 'login' && mode !== 'register';
  $('#join-sent').hidden = mode !== 'sent';
  $('#join-btn').hidden = mode === 'sent';
  $('#join-name').required = mode === 'register';
  $('#join-email').required = !$('#field-email').hidden;
  $('#join-pass').required = !$('#field-pass').hidden;
  $('#join-pass-label').textContent = mode === 'reset' ? 'Senha nova' : 'Senha';
  $('#join-pass').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  $('#join-pass').minLength = mode === 'login' ? 0 : 6;
  if (sentText) $('#join-sent-text').textContent = sentText;
  $('#resend-btn').hidden = !pendingEmail;
  $('#join-switch-text').textContent = m.ask;
  $('#switch-btn').textContent = m.link;
  $('#switch-btn').dataset.mode = m.to;
  showJoinError('');
  setJoinBusy(false);
}

async function authApi(action, body) {
  let res;
  try {
    res = await fetch(`/api/auth/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    throw new Error('Sem conexão com o servidor.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.errorDescription || `Erro ${res.status}`);
  return data;
}

function bindAuthUi() {
  $('#switch-btn').addEventListener('click', (e) => setAuthMode(e.currentTarget.dataset.mode));
  $('#forgot-link').addEventListener('click', () => setAuthMode('forgot'));
  $('#pass-toggle').addEventListener('click', () => {
    const show = $('#join-pass').type === 'password';
    $('#join-pass').type = show ? 'text' : 'password';
    $('#pass-toggle').classList.toggle('on', show);
    $('#pass-toggle').setAttribute('aria-label', show ? 'Esconder a senha' : 'Mostrar a senha');
  });
  $('#resend-btn').addEventListener('click', async () => {
    if (!pendingEmail) return;
    $('#resend-btn').disabled = true;
    await authApi('resend', { email: pendingEmail }).catch(() => {});
    $('#join-sent-text').textContent = `Mandamos de novo para ${pendingEmail}. Veja também a caixa de spam.`;
    setTimeout(() => ($('#resend-btn').disabled = false), 30_000);
  });
}

async function onJoinSubmit(event) {
  event.preventDefault();
  if (authMode === 'sent') return;
  state.micOn = $('#join-mic').checked;
  store.set('joinMic', state.micOn);
  store.set('joinCam', $('#join-cam').checked);
  const email = $('#join-email').value.trim();
  const password = $('#join-pass').value;
  const body = {
    login: { email, password },
    register: { email, password, name: $('#join-name').value.trim(), invite: store.get('invite', null) },
    forgot: { email },
    reset: { token: resetToken, password },
  }[authMode];
  setJoinBusy(true);
  showJoinError('');
  let data;
  try {
    data = await authApi(authMode, body);
  } catch (err) {
    setJoinBusy(false);
    return showJoinError(err.message);
  }
  if (email) store.set('email', email);
  if (authMode === 'register') {
    pendingEmail = email;
    return setAuthMode('sent', `Falta um passo: abra o link que mandamos para ${email} para criar a conta (veja também o spam; ele vale por 24 horas). Digitou o e-mail errado? É só se cadastrar de novo com o certo.`);
  }
  if (authMode === 'forgot') {
    pendingEmail = null;
    return setAuthMode('sent', `Se existir uma conta com ${email}, chegou um link para trocar a senha. Ele vale por 1 hora (veja também o spam).`);
  }
  // Entrou (com a senha ou com a senha nova): segue para a sala.
  state.account = data;
  resetToken = null;
  $('#join-pass').value = '';
  unlockAudio();
  enterWithAccount();
}

async function openEmailLink(kind, token) {
  if (kind === 'senha') {
    resetToken = token;
    setAuthMode('reset');
    return $('#join-pass').focus();
  }
  setAuthMode('login');
  setJoinBusy(true);
  try {
    state.account = await authApi('verify', { token });
  } catch (err) {
    setJoinBusy(false);
    return showJoinError(err.message);
  }
  store.set('email', state.account.email);
  toast(state.account.host ? 'E-mail confirmado. Você é o host da sala!' : 'E-mail confirmado. Bem-vindo à sala!');
  enterWithAccount();
}

function enterWithAccount() {
  joinInfo = { startCam: store.get('joinCam', false) };
  setJoinBusy(true);
  connect();
}

async function logout() {
  await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
  leave();
}

// Quem chegou por um link de convite vê para qual servidor foi chamado.
async function showInvite() {
  const code = store.get('invite', null);
  $('#join-invite').hidden = true;
  if (!code) return;
  try {
    const res = await fetch(`/api/invite/${encodeURIComponent(code)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.errorDescription);
    $('#join-invite-text').textContent = `Você foi convidado para ${data.name}. Entre ou crie sua conta para participar.`;
  } catch (err) {
    $('#join-invite-text').textContent = err.message || 'Não deu para abrir o convite agora.';
  }
  $('#join-invite').hidden = false;
}

async function refreshPresence() {
  if (state.inRoom) return;
  try {
    const p = await fetch('/api/presence').then((r) => r.json());
    let text = 'Ninguém na sala agora';
    if (p.count) text = `${p.count} ${p.count === 1 ? 'pessoa' : 'pessoas'} online agora`;
    $('#presence').textContent = text;
    $('.presence').classList.toggle('empty', !p.count);
  } catch {
    $('#presence').textContent = 'Servidor fora do ar';
  }
}


function setJoinBusy(busy) {
  $('#join-btn').disabled = busy;
  const m = AUTH_MODES[authMode];
  $('#join-btn').textContent = busy ? m.busy || 'Entrando…' : m.button;
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
    send({
      type: 'join',
      micOn: state.micOn,
      deafened: state.deafened,
      resume: state.me,
      version: state.config?.version,
    });
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
      // Login expirado ou trocado: volta para a tela de entrar.
      if (msg.code === 'auth' && state.inRoom) {
        state.leaving = true;
        return location.reload();
      }
      if (msg.code === 'auth') {
        state.account = null;
        setAuthMode('login');
      }
      if (!state.inRoom) {
        setJoinBusy(false);
        showJoinError(msg.message);
      } else toast(msg.message);
      return;
    case 'logout':
      state.leaving = true;
      toast(msg.text, { timeout: 15000 });
      return setTimeout(() => location.reload(), 3000);
    case 'directory':
      return onDirectory(msg);
    case 'account':
      return onAccount(msg.account, msg.by);
    case 'server:joined':
      return onServerJoined(msg);
    case 'dm:opened':
      return onDmOpened(msg.id);
    case 'invite:error':
      store.set('invite', null);
      $('#no-servers-error').textContent = msg.text;
      if (state.servers.size) toast(msg.text);
      return;
    case 'pong':
      return onPong(msg);
    case 'notice':
      return toast(msg.text);
    case 'participant:joined':
      state.participants.set(msg.participant.id, msg.participant);
      return renderAll();
    case 'participant:updated': {
      const p = msg.participant;
      const prev = state.participants.get(p.id);
      // A minha sala de voz quem decide é este app (o aviso do servidor pode chegar atrasado).
      if (p.id === state.me?.id) Object.assign(p, { voice: state.voice, connecting: voiceConn.sent });
      else if (state.voice && prev?.voice !== p.voice) {
        if (p.voice === state.voice) sound('join');
        else if (prev?.voice === state.voice) sound('leave');
      }
      state.participants.set(p.id, p);
      if (prev && prev.name !== p.name) applyVolumes();
      reconcile();
      return renderAll();
    }
    case 'participant:left': {
      const gone = state.participants.get(msg.id);
      if (state.voice && gone?.voice === state.voice) sound('leave');
      state.participants.delete(msg.id);
      for (const s of [...state.streams.values()]) if (s.ownerId === msg.id) state.streams.delete(s.id);
      reconcile();
      return renderAll();
    }
    case 'voice:ended':
      leaveVoice({ notify: false });
      return toast(msg.text);
    case 'channel:added':
      state.channels.set(msg.channel.id, msg.channel);
      if (msg.by === state.me?.id && msg.channel.kind === 'text') return openChannel(msg.channel.id);
      return renderChannels();
    case 'channel:updated':
      state.channels.set(msg.channel.id, msg.channel);
      return renderAll();
    case 'channel:removed':
      return onChannelRemoved(msg.id);
    case 'channel:order':
      msg.ids.forEach((id, i) => {
        const ch = state.channels.get(id);
        if (ch) ch.position = i;
      });
      return renderChannels();
    case 'voice:moved': {
      const ch = state.channels.get(msg.channelId);
      if (!ch || !state.voice || state.voice === ch.id) return;
      // Quem estava olhando a sala de voz passa a ver a nova; quem estava num chat de texto continua nele.
      joinVoice(ch.id, { show: state.view === state.voice });
      return toast(`${msg.by} te moveu para ${ch.name}.`);
    }
    case 'chat:history':
      return onHistory(msg);
    case 'chat:deleted':
      return onChatDeleted(msg);
    case 'chat:cleared':
      return onChatCleared(msg);
    case 'stream:added':
      return onStreamAdded(msg.stream);
    case 'stream:removed':
      state.streams.delete(msg.id);
      state.watching.delete(msg.id);
      reconcile();
      return renderAll();
    case 'chat':
      return onChatMessage(msg.message);
    case 'music':
      return onMusic(msg.channelId, msg.music);
    case 'usage':
      return onUsage(msg.usage);
    case 'republish':
      return onRepublishRequest();
    case 'sound:play': {
      const sound = state.sounds.find((s) => s.id === msg.id);
      return sound && playSound(sound, msg.by);
    }
    case 'sound:stop':
      if (!soundsPlaying.size) return;
      stopSounds();
      return toast(`${msg.by} parou os sons.`, { timeout: 3000 });
    case 'sound:added':
      state.sounds.push(msg.sound);
      return renderSoundpad();
    case 'sound:removed':
      state.sounds = state.sounds.filter((s) => s.id !== msg.id);
      return renderSoundpad();
  }
}

function onWelcome(msg) {
  const previousId = state.me?.id;
  state.me = msg.you;
  $('#banner').hidden = true;
  if (msg.version && state.config?.version && msg.version !== state.config.version && !state.updateOffered) {
    state.updateOffered = true;
    toast('Saiu uma versão nova do app.', { action: 'Atualizar', onAction: () => location.reload(), timeout: 10 * 60_000 });
  }
  state.participants = new Map(msg.state.participants.map((p) => [p.id, p]));
  state.streams = new Map(msg.state.streams.map((s) => [s.id, s]));
  state.account = accountOf({ ...msg.you, id: msg.you.userId });
  state.servers = new Map(msg.state.servers.map((s) => [s.id, s]));
  if (state.account.muted) state.micOn = false;
  // Chegou por um link de convite: entra no servidor agora que já está logado.
  const invite = store.get('invite', null);
  if (invite) send({ type: 'server:join', code: invite });
  state.channels = new Map(msg.state.channels.map((c) => [c.id, c]));
  state.musics = new Map(Object.entries(msg.state.musics));
  state.sounds = msg.state.sounds;
  // As imagens do chat precisam desse cookie; o histórico só é pedido depois dele.
  authReady = refreshAuthCookie();
  chats.clear();
  for (const view of chatViews) view.channelId = null;
  for (const id of state.watching) if (!state.streams.has(id)) state.watching.delete(id);

  if (!state.inRoom) enterRoom();
  else if (state.voice && !state.channels.has(state.voice)) leaveVoice({ notify: false });
  else if (!msg.resumed) {
    // O servidor esqueceu a gente (reiniciou ou demoramos demais): volta para a sala de voz e anuncia de novo o que está no ar.
    if (state.voice) send({ type: 'voice:join', channelId: state.voice });
    if (previousId && local.mic) {
      detachMeter(previousId);
      attachMeter(state.me.id, local.mic.stream);
    }
    for (const entry of localEntries()) if (entry.mids.length && !entry.parked) announce(entry);
  }
  const me = state.participants.get(state.me.id);
  if (me) me.voice = state.voice;
  onUsage(msg.state.usage);
  syncMusic();
  renderSoundpad();
  renderAll();
  reconcile();
}

function onStreamAdded(stream) {
  const isNew = !state.streams.has(stream.id);
  state.streams.set(stream.id, stream);
  if (isNew && stream.kind === 'screen' && stream.ownerId !== state.me.id && inMyVoice(stream.ownerId)) {
    const owner = state.participants.get(stream.ownerId)?.name || 'Alguém';
    if (settings.autoWatch) {
      state.watching.add(stream.id);
      toast(`${owner} começou uma live (${stream.label}).`);
    } else {
      toast(`${owner} começou a compartilhar (${stream.label})`, { action: 'Assistir', onAction: () => watch(stream.id) });
    }
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
  textChat = makeChatView($('#text-chat'));
  voiceChat = makeChatView($('#voice-chat'));
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
  setInterval(checkHealth, 3000);
  setInterval(updateSpeaking, 100);
  setInterval(tickConnect, 250);
  requestAnimationFrame(syncVideoBox);
  const stageObserver = new ResizeObserver(layoutGrid);
  stageObserver.observe($('#grid'));
  stageObserver.observe($('#focus'));
  bindStageDrag();

  // Entra na sala sem estar em nenhuma sala de voz; o microfone liga ao clicar numa.
  if (!state.config.realtimeReady) {
    state.micOn = false;
    sendState();
    toast('Voz e vídeo ainda não foram configurados no servidor.', { timeout: 8000 });
  }
}

// ---------- salas de voz ----------

// ---------- conectando a voz ----------
// Ao entrar numa sala de voz (ou quando a conexão é refeita), um checklist mostra o que já
// funciona. Ele é calculado do estado real: assinaturas que chegaram, microfone no ar e a
// conexão de envio pronta. Os outros veem três pontinhos até eu poder ouvir e falar.

const CONNECT_SHOW_MS = 300; // pronto antes disso: o painel nem aparece
const CONNECT_GIVEUP_MS = 30_000; // depois disso os outros param de ver "conectando" (os erros já viram aviso)
const voiceConn = { since: 0, label: '', shown: false, dismissed: false, doneTimer: null, sent: false, micError: '' };

function voiceLog(step) {
  if (voiceConn.since) console.info(`[voz] ${step} em ${Math.round(performance.now() - voiceConn.since)} ms`);
}

function startConnect(label) {
  if (!state.config?.realtimeReady || !state.voice) return;
  clearTimeout(voiceConn.doneTimer);
  Object.assign(voiceConn, { since: performance.now(), label, dismissed: false, doneTimer: null });
  if (label !== 'Reconectando…') voiceConn.micError = '';
  tickConnect();
}

// Cada etapa: 'ok', 'wait' (pulsando), 'off' (não se aplica agora) ou 'error'.
function voiceSteps() {
  if (!state.voice || !state.config?.realtimeReady) return null;
  const wanted = wantedStreams();
  const arrived = (list) => (list.every((s) => subs.get(s.id)?.status === 'ok') ? 'ok' : 'wait');
  const hearing = wanted.filter((s) => s.kind === 'mic');
  const seeing = wanted.filter((s) => s.kind !== 'mic');
  const retrying = (list) => (list.some((s) => subs.get(s.id)?.status === 'error') ? 'tentando de novo' : '');
  let talk = 'wait';
  let talkNote = '';
  if (state.account?.muted) [talk, talkNote] = ['off', 'mutado por um admin'];
  else if (voiceConn.micError) [talk, talkNote] = ['error', voiceConn.micError];
  else if (!state.micOn) [talk, talkNote] = ['off', 'microfone desligado'];
  else if (local.mic?.live) talk = 'ok';
  const sending = local.mic || local.camera || local.screens.size || micStarting || camStarting;
  const cam = sender?.ready ? 'ok' : sending ? 'wait' : 'off';
  return [
    { id: 'listen', label: 'Ouvir', state: arrived(hearing), note: retrying(hearing) },
    { id: 'watch', label: 'Ver câmeras e telas', state: arrived(seeing), note: retrying(seeing) },
    { id: 'cam', label: 'Ligar a câmera', state: cam, note: cam === 'off' ? 'conecta quando você ligar' : '' },
    { id: 'talk', label: 'Falar', state: talk, note: talkNote },
  ];
}

const DOTS = '<span class="dots" title="Conectando a voz…"><i></i><i></i><i></i></span>';

const STEP_MARK = {
  ok: () => icon('check'),
  wait: () => '<span class="dots"><i></i><i></i><i></i></span>',
  off: () => icon('minus'),
  error: () => icon('x'),
};

function tickConnect() {
  const steps = voiceConn.since ? voiceSteps() : null;
  const elapsed = performance.now() - voiceConn.since;
  const waiting = !!steps?.some((st) => st.state === 'wait');
  const failed = !!steps?.some((st) => st.state === 'error');
  // Para os outros: ainda não consigo falar (o microfone está ligado, mas não chegou ao ar).
  const connecting = !!steps && elapsed < CONNECT_GIVEUP_MS && steps.some((st) => st.id === 'talk' && st.state === 'wait');
  setConnecting(connecting);

  const panel = $('#connect-panel');
  if (!steps) {
    voiceConn.since = 0;
    voiceConn.shown = false;
    panel.hidden = true;
    return;
  }
  if (!waiting && !failed) {
    // Tudo pronto: quem viu o painel vê o "pronto" por um instante.
    voiceConn.since = 0;
    if (voiceConn.shown && !panel.hidden) {
      renderConnectPanel('Tudo pronto', steps, false);
      clearTimeout(voiceConn.doneTimer);
      voiceConn.doneTimer = setTimeout(() => {
        if (!voiceConn.since) panel.hidden = true;
      }, 1000);
    } else {
      panel.hidden = true;
    }
    voiceConn.shown = false;
    return;
  }
  if (voiceConn.dismissed || (elapsed < CONNECT_SHOW_MS && !failed)) return;
  voiceConn.shown = true;
  renderConnectPanel(waiting ? voiceConn.label : 'Nem tudo conectou', steps, failed);
}

function renderConnectPanel(title, steps, failed) {
  $('#connect-title').textContent = title;
  $('#connect-steps').replaceChildren(
    ...steps.map((st) => {
      const li = document.createElement('li');
      li.className = st.state;
      li.innerHTML = `<span class="mark">${STEP_MARK[st.state]()}</span><span><span class="label"></span> <span class="note"></span></span>`;
      $('.label', li).textContent = st.label;
      $('.note', li).textContent = st.note ? `(${st.note})` : '';
      return li;
    }),
  );
  $('#connect-retry').hidden = !failed;
  $('#connect-panel').hidden = false;
}

function setConnecting(connecting) {
  if (connecting === voiceConn.sent) return;
  voiceConn.sent = connecting;
  const me = state.participants.get(state.me?.id);
  if (me) me.connecting = connecting;
  if (state.voice) send({ type: 'voice:status', connecting });
  renderPeople();
  renderStage();
  renderChannels();
}

function retryConnect() {
  voiceConn.micError = '';
  if (!state.account?.muted) {
    state.micOn = true;
    sendState();
    applyMic();
  }
  startConnect('Conectando a voz…');
}

function inMyVoice(pid) {
  return !!state.voice && state.participants.get(pid)?.voice === state.voice;
}

function setMyVoice(id) {
  const me = state.participants.get(state.me.id);
  if (me) me.voice = id;
}

function joinVoice(id, { show = true } = {}) {
  if (state.channels.get(id)?.kind !== 'voice') return;
  if (state.voice === id) return showView(id);
  if (state.voice) {
    stopLocalMedia({ keepMic: true });
    stopSounds();
  }
  state.voice = id;
  setMyVoice(id);
  // Saiu (ou trocou de sala) há menos de VOICE_HOLD_MS: o mesmo microfone volta ao ar na hora.
  const reuse = !!local.mic?.parked && !state.account?.muted;
  const connecting = !!state.config.realtimeReady && state.micOn && !state.account?.muted && !reuse;
  send({ type: 'voice:join', channelId: id, connecting });
  voiceConn.sent = connecting;
  unlockAudio();
  sound('join');
  if (state.config.realtimeReady) {
    startConnect('Conectando a voz…');
    if (reuse) unparkMic();
    else releaseParkedMic();
    receiver?.prewarm();
    if (!local.mic && state.micOn && !state.account?.muted) sender?.prewarm();
    if (state.micOn) startMic();
    if (joinInfo.startCam) {
      joinInfo.startCam = false;
      startCamera();
    }
  }
  if (settings.autoWatch) {
    for (const st of state.streams.values()) if (st.kind === 'screen' && st.ownerId !== state.me.id && inMyVoice(st.ownerId)) state.watching.add(st.id);
  }
  syncMusic();
  bindChat(voiceChat, id);
  reconcile();
  if (show) showView(id);
  else renderAll();
}

function leaveVoice({ notify = true } = {}) {
  if (!state.voice) return;
  stopLocalMedia({ keepMic: true });
  state.voice = null;
  setMyVoice(null);
  if (notify) send({ type: 'voice:join', channelId: null });
  sound('leave');
  state.watching.clear();
  state.previewing.clear();
  state.pinned = [];
  state.tileOrder = null;
  state.videoOnStage = false;
  voiceConn.since = 0;
  voiceConn.sent = false;
  $('#connect-panel').hidden = true;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  toggleSoundpad(false);
  stopSounds(); // os sons eram daquela sala
  syncMusic();
  reconcile();
  renderAll();
}

// keepMic: ao sair ou trocar de sala, o microfone fica "estacionado" por VOICE_HOLD_MS em vez de parar.
function stopLocalMedia({ keepMic = false } = {}) {
  const mic = local.mic;
  if (mic && !(keepMic && parkMic())) {
    local.mic = null;
    unpublishLocal(mic);
    detachMeter(state.me.id);
  }
  stopCamera();
  for (const id of [...local.screens.keys()]) stopScreen(id);
}

// ---------- microfone estacionado ----------
// Sair de uma sala e voltar logo (ou só trocar de sala) não pode custar uma conexão nova:
// refazer a sessão no Cloudflare e esperar quem ouve assinar de novo levava mais de 10 s.
// Por VOICE_HOLD_MS a faixa fica capturada, mas desligada (ninguém ouve) e sem anúncio no
// servidor, e a conexão de envio continua aberta com ela (uma conexão vazia é o que dá o
// erro do BUNDLE). Voltando a tempo, é só religar e anunciar de novo.

const VOICE_HOLD_MS = 10_000;
let micHoldTimer = null;

function parkMic() {
  const mic = local.mic;
  if (!mic?.live || !mic.mids.length) return false;
  mic.parked = true;
  mic.items[0].track.enabled = false;
  clearTimeout(micHoldTimer);
  micHoldTimer = setTimeout(releaseParkedMic, VOICE_HOLD_MS);
  return true;
}

// Ninguém voltou a tempo: desmonta como antes (o navegador apaga o aviso de microfone em uso).
function releaseParkedMic() {
  clearTimeout(micHoldTimer);
  micHoldTimer = null;
  const mic = local.mic;
  if (!mic?.parked) return;
  local.mic = null;
  unpublishLocal(mic);
  detachMeter(state.me.id);
  renderControls();
}

function unparkMic() {
  const mic = local.mic;
  if (!mic?.parked) return false;
  clearTimeout(micHoldTimer);
  micHoldTimer = null;
  mic.parked = false;
  mic.items[0].track.enabled = state.micOn;
  announce(mic);
  voiceLog('o microfone voltou ao ar sem reconectar');
  return true;
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
  const conn = new SfuConnection(api, state.config.iceServers, role === 'sender' ? 'send' : 'receive');
  conn.addEventListener('failed', (event) => {
    if (state.leaving) return;
    if (role === 'sender' && sender !== conn) return;
    if (role === 'receiver' && receiver !== conn) return;
    // Sessão morta no Cloudflare (ex.: 410): não adianta insistir nela, cria outra.
    const attempt = ++rebuildAttempts[role];
    const delay = REBUILD_DELAYS[Math.min(attempt - 1, REBUILD_DELAYS.length - 1)];
    reportError(event.detail, 'connect', role === 'sender' ? 'o que você transmite' : 'o que você recebe', { quiet: attempt < 2 });
    setTimeout(() => (role === 'sender' ? rebuildSender() : rebuildReceiver()), delay);
  });
  return conn;
}

async function rebuildSender() {
  if (state.leaving) return;
  sender = makeConnection('sender');
  if (state.voice && !voiceConn.since) startConnect('Reconectando…');
  for (const entry of localEntries()) {
    try {
      await pushEntry(entry);
      if (!entry.parked) announce(entry);
    } catch (err) {
      if (!sender.closed) reportError(err, 'send', entry.label.toLowerCase());
    }
  }
}

function rebuildReceiver() {
  if (state.leaving) return;
  for (const sub of subs.values()) detachAudio(sub);
  subs.clear();
  receiver = makeConnection('receiver');
  if (state.voice && !voiceConn.since) startConnect('Reconectando…');
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
  rebuildAttempts.sender = 0;
}

function announce(entry) {
  entry.live = true;
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
  if (local.mic || micStarting || !state.config.realtimeReady || !state.voice || state.account?.muted) return;
  micStarting = true;
  const voice = state.voice;
  let entry = null;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints() });
    voiceLog('o navegador liberou o microfone');
    // Saiu da sala de voz enquanto o navegador pedia o microfone.
    if (state.voice !== voice) return stream.getTracks().forEach((t) => t.stop());
    const track = stream.getAudioTracks()[0];
    track.enabled = state.micOn;
    const id = `mic-${randomId()}`;
    entry = { id, kind: 'mic', label: 'Microfone', stream, items: [{ track, trackName: `${id}:audio` }], mids: [], senders: [] };
    local.mic = entry;
    attachMeter(state.me.id, stream);
    await publishLocal(entry, () => local.mic === entry && state.voice === voice);
    voiceLog('o microfone está no ar (já dá para falar)');
  } catch (err) {
    if (entry && local.mic === entry) {
      entry.stream.getTracks().forEach((t) => t.stop());
      local.mic = null;
      detachMeter(state.me.id);
    }
    state.micOn = false;
    sendState();
    voiceConn.micError = explain(err, 'mic').text;
    reportError(err, 'mic');
  } finally {
    micStarting = false;
    renderControls();
    renderPeople();
  }
}

function toggleMic() {
  if (state.account?.muted) return toast('Um admin te mutou. Só um admin pode desmutar.');
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
    state.micOn = state.micBeforeDeafen && !state.account?.muted;
  }
  applyDeafen();
  applyMic();
  if (!state.deafened) sound('on');
  sendState();
}

function applyMic() {
  if (state.micOn && !local.mic && state.voice) startMic();
  if (local.mic) local.mic.items[0].track.enabled = state.micOn && !local.mic.parked;
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
  renderChannels();
}

function toggleCamera() {
  if (local.camera) stopCamera();
  else startCamera();
}

async function startCamera() {
  if (local.camera || camStarting || !state.voice) return;
  if (!state.config.realtimeReady) return toast('Voz e vídeo ainda não foram configurados no servidor.');
  if (state.usage?.blocked) return toast(QUOTA_MSG);
  camStarting = true;
  renderControls();
  const voice = state.voice;
  let entry = null;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: cameraConstraints() });
    if (state.voice !== voice) return stream.getTracks().forEach((t) => t.stop());
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
    await publishLocal(entry, () => local.camera === entry && state.voice === voice);
  } catch (err) {
    if (entry && local.camera === entry) {
      entry.stream.getTracks().forEach((t) => t.stop());
      local.camera = null;
    }
    reportError(err, 'cam');
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
    reportError(err, 'cam');
  }
  renderStage();
}

async function startScreen() {
  if (!state.voice) return;
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
    // NotAllowedError/AbortError aqui é a pessoa cancelando a escolha da tela
    if (err.name !== 'NotAllowedError' && err.name !== 'AbortError') reportError(err, 'screen', 'o compartilhamento de tela');
    return;
  }
  if (!state.voice) return stream.getTracks().forEach((t) => t.stop());
  const voice = state.voice;
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
    await publishLocal(entry, () => local.screens.get(id) === entry && state.voice === voice);
  } catch (err) {
    if (local.screens.get(id) === entry) {
      local.screens.delete(id);
      stream.getTracks().forEach((t) => t.stop());
    }
    reportError(err, 'send', `a ${label}`);
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
  reconcile();
  renderAll();
}

function wantedStreams() {
  const list = [];
  for (const s of state.streams.values()) {
    if (s.ownerId === state.me?.id || !inMyVoice(s.ownerId)) continue;
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
  const conn = receiver;
  const sub = { stream, mediaStream: new MediaStream(), mids: [], status: 'loading', audioEls: [], muted: false, since: 0 };
  subs.set(stream.id, sub);
  renderStage();
  try {
    const got = await conn.pull(stream.tracks.map((t) => ({ sessionId: stream.sessionId, trackName: t.trackName })));
    if (subs.get(stream.id) !== sub) {
      conn.closeTracks(got.map((g) => g.mid)).catch(() => {});
      return;
    }
    sub.mids = got.map((g) => g.mid);
    for (const g of got) sub.mediaStream.addTrack(g.track);
    sub.status = 'ok';
    sub.since = Date.now();
    if (voiceConn.since) voiceLog(`${streamLabel(stream)} começou a chegar`);
    retries.delete(stream.id);
    rebuildAttempts.receiver = 0;
    attachAudio(sub);
  } catch (err) {
    // Se a conexão inteira caiu, a recriação já vai pedir tudo de novo.
    if (subs.get(stream.id) !== sub || conn.closed) return;
    sub.status = 'error';
    if (err.code === 'quota') {
      reportError(err, 'watch');
      if (stream.kind === 'screen') state.watching.delete(stream.id);
    } else {
      const attempt = scheduleRetry(stream.id, sub);
      // As primeiras falhas costumam ser a transmissão ainda começando; só avisa se insistir.
      if (attempt >= 4) reportError(err, 'watch', streamLabel(stream));
    }
  }
  renderStage();
  renderPeople();
}

// A primeira falha costuma ser a transmissão ainda começando no Cloudflare: tenta de novo logo
// (antes eram 2 s, 4 s, 6 s… e quem voltava para a sala levava mais de 10 s para ser ouvido).
const RETRY_DELAYS = [300, 700, 1500, 3000];

function scheduleRetry(id, sub) {
  const attempt = (retries.get(id) || 0) + 1;
  retries.set(id, attempt);
  const delay = RETRY_DELAYS[attempt - 1] ?? Math.min(2000 * attempt, 30000);
  setTimeout(() => {
    if (subs.get(id) !== sub) return;
    subs.delete(id);
    reconcile();
  }, delay);
  return attempt;
}

function resubscribe(id) {
  unsubscribe(id);
  reconcile();
}

function streamLabel(stream) {
  const owner = state.participants.get(stream.ownerId)?.name || 'alguém';
  if (stream.kind === 'mic') return `o áudio de ${owner}`;
  if (stream.kind === 'camera') return `a câmera de ${owner}`;
  return `a ${stream.label} de ${owner}`;
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
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (settings.outId) audioCtx.setSinkId?.(settings.outId).catch(() => {});
    }
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

// ---------- monitor: o áudio e o vídeo estão chegando? ----------

// Microfone (mesmo mutado) e câmera mandam pacotes o tempo todo; se pararam,
// a conexão travou. Telas ficam de fora: tela parada pode não mandar nada.
const STALL_MS = 7000;
const received = new Map(); // id da faixa -> { packets, changedAt }
const stalls = new Map(); // id da transmissão -> { count, at }
let receivedPc = null;
let sentAudio = { pc: null, packets: 0, changedAt: 0 };
let lastRepublish = 0;

async function checkHealth() {
  if (!state.inRoom || state.leaving) return;
  await checkReceiving();
  await checkSending();
}

async function checkReceiving() {
  const conn = receiver;
  const pc = conn?.pc;
  if (!pc || conn.closed) return;
  if (receivedPc !== pc) {
    received.clear();
    receivedPc = pc;
  }
  let stats;
  try {
    stats = await pc.getStats();
  } catch {
    return;
  }
  const packetsByTrack = new Map();
  stats.forEach((r) => {
    if (r.type === 'inbound-rtp') packetsByTrack.set(r.trackIdentifier, r.packetsReceived || 0);
  });
  const now = Date.now();
  const stalled = [];
  for (const sub of subs.values()) {
    if (sub.status !== 'ok' || sub.stream.kind === 'screen' || now - sub.since < STALL_MS) continue;
    if (!state.participants.get(sub.stream.ownerId)?.online) continue;
    for (const track of sub.mediaStream.getTracks()) {
      const packets = packetsByTrack.get(track.id);
      if (packets === undefined) continue;
      const seen = received.get(track.id);
      if (!seen || packets > seen.packets) received.set(track.id, { packets, changedAt: now });
      else if (now - seen.changedAt > STALL_MS) {
        stalled.push(sub);
        break;
      }
    }
  }
  if (!stalled.length || conn.closed) return;
  if (stalled.length >= 2) {
    // Nada de ninguém chegando: o problema é a minha conexão de recepção.
    conn.fail(Object.assign(new Error('Nada está chegando'), { code: 'receive_stalled' }));
    return;
  }
  const [sub] = stalled;
  const previous = stalls.get(sub.stream.id);
  const count = previous && now - previous.at < 120000 ? previous.count + 1 : 1;
  stalls.set(sub.stream.id, { count, at: now });
  // Repetiu logo depois de refazer: provavelmente é o lado de quem transmite; o servidor avisa a pessoa.
  send({ type: 'health', streamId: sub.stream.id, repeated: count > 1 });
  reportError(Object.assign(new Error('Parou de chegar'), { code: 'stream_stalled' }), 'watch', streamLabel(sub.stream), { quiet: count < 2 });
  resubscribe(sub.stream.id);
}

async function checkSending() {
  const conn = sender;
  const pc = conn?.pc;
  if (!pc || conn.closed || !local.mic?.mids.length) return;
  let stats;
  try {
    stats = await pc.getStats();
  } catch {
    return;
  }
  let packets = 0;
  stats.forEach((r) => {
    if (r.type === 'outbound-rtp' && r.kind === 'audio') packets += r.packetsSent || 0;
  });
  const now = Date.now();
  if (sentAudio.pc !== pc || packets > sentAudio.packets) {
    sentAudio = { pc, packets, changedAt: now };
  } else if (now - sentAudio.changedAt > STALL_MS) {
    sentAudio.changedAt = now;
    conn.fail(Object.assign(new Error('Seu áudio parou de sair'), { code: 'send_stalled' }));
  }
}

// O servidor pede quando outras pessoas não estão recebendo o que eu transmito.
function onRepublishRequest() {
  const now = Date.now();
  if (!sender || now - lastRepublish < 30000) return;
  lastRepublish = now;
  sender.fail(Object.assign(new Error('Outras pessoas não estavam recebendo'), { code: 'republish' }));
}

function reportError(err, what, label = '', { quiet = false } = {}) {
  const info = explain(err, what, label);
  const key = `${what}|${info.code}|${label}`;
  const now = Date.now();
  const last = recentErrors.get(key) || 0;
  recentErrors.set(key, now);
  if (now - last < 20000) return;
  send({
    type: 'client-error',
    what,
    code: info.code,
    text: info.text,
    action: info.action,
    detail: String(err?.message || '').slice(0, 300),
  });
  if (!quiet) toast(`${info.text} ${info.action}`, { timeout: 9000 });
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
    if (s.kind === 'screen' && s.ownerId !== state.me?.id && inMyVoice(s.ownerId)) {
      list.push({ id: s.id, ownerId: s.ownerId, label: s.label, mine: false });
    }
  }
  return list;
}

function initials(name = '?') {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] || '?') + (parts.length > 1 ? parts.at(-1)[0] : '')).toUpperCase();
}

// A foto da pessoa, ou as iniciais na cor dela.
function paintAvatar(el, { name, color, avatar }) {
  if (color) el.style.setProperty('--c', color);
  el.classList.toggle('photo', !!avatar);
  el.style.backgroundImage = avatar ? `url("${avatar}")` : '';
  el.textContent = initials(name);
}

// ---------- render ----------

function renderAll() {
  if (!state.inRoom) return;
  renderNoServers();
  renderControls();
  renderPeople();
  renderView();
  renderStage();
  renderChannels();
}

function renderControls() {
  // Fora de uma sala de voz só ficam microfone e fone (valem para quando entrar numa).
  const inVoice = !!state.voice;
  for (const id of ['#btn-cam', '#btn-sounds', '#btn-leave']) $(id).hidden = !inVoice;

  const mic = $('#btn-mic');
  mic.innerHTML = icon(state.micOn ? 'mic' : 'mic-off');
  mic.classList.toggle('off', !state.micOn);
  mic.disabled = micStarting;
  mic.classList.toggle('locked', !!state.account?.muted);
  mic.title = mic.ariaLabel = state.account?.muted ? 'Um admin te mutou' : state.micOn ? 'Desligar o microfone' : 'Ligar o microfone';

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
  screen.hidden = !canShareScreen || !inVoice;
  screen.innerHTML = icon('screen-share') + (local.screens.size ? `<span class="ctl-count">${local.screens.size}</span>` : '');
  screen.classList.toggle('on', local.screens.size > 0);
  screen.disabled = blocked;
  screen.title = screen.ariaLabel = local.screens.size ? 'Compartilhar mais uma tela ou janela' : 'Compartilhar tela ou janela';
}

// Quem aparece em Pessoas: os membros do servidor aberto (o host está em todos).
function serverPeople(server = currentServer()) {
  if (!server) return [];
  return sortedParticipants().filter((p) => p.id === state.me?.id || p.host || server.members.includes(p.userId));
}

// Admin mexe em quem não é admin; o host, em todos (menos nele mesmo). O servidor confere de novo.
function canManage(p) {
  const me = state.account;
  if (!me?.admin || !p || p.userId === me.id || p.host) return false;
  return !p.admin || !!me.host;
}

function personActions(p) {
  if (!canManage(p)) return '';
  const server = currentServer();
  const inThisServer = p.voice && state.channels.get(p.voice)?.serverId === server?.id;
  const btn = (act, iconName, text, cls = '') => `<button class="person-act ${cls}" type="button" data-act="${act}">${icon(iconName)}<span>${text}</span></button>`;
  return [
    btn('mute', p.muted ? 'mic' : 'mic-off', p.muted ? 'Desmutar' : 'Mutar'),
    inThisServer && btn('voice-kick', 'leave', 'Tirar da sala de voz'),
    state.account.host && btn('role', 'shield', p.admin ? 'Tirar o cargo de admin' : 'Tornar admin'),
    server?.members.includes(p.userId) && btn('kick', 'user-x', `Expulsar de ${server.name}`, 'danger'),
    btn('ban', 'ban', `Banir de ${server?.name || 'servidor'}`, 'danger'),
  ]
    .filter(Boolean)
    .join('');
}

function renderPeople() {
  if (!state.inRoom) return;
  const people = serverPeople();
  $('#people-count').textContent = people.length;
  const items = people.map((p) => {
    const mine = p.id === state.me.id;
    const hasCam = mine ? !!local.camera : !!cameraOf(p.id);
    const screens = screenCountOf(p.id);
    const li = document.createElement('li');
    li.className = 'person';
    li.dataset.speaker = p.id;
    li.dataset.id = p.id;
    li.classList.toggle('offline', !p.online);
    li.classList.toggle('connecting', !!p.connecting && !!p.voice);
    li.classList.toggle('expanded', state.expanded === p.id && !mine);

    const where = p.voice && state.channels.get(p.voice);
    let status = 'Reconectando…';
    if (p.online && !where) status = 'Fora das salas de voz';
    else if (p.online) {
      const doing = [hasCam && 'câmera ligada', screens && `${screens} ${screens > 1 ? 'telas' : 'tela'} ao vivo`].filter(Boolean).join(' · ');
      status = `Em ${where.name} · ${p.connecting ? 'conectando a voz…' : doing || (p.deafened ? 'sem ouvir' : p.micOn ? 'na call' : 'mutado')}`;
    }
    if (p.muted) status += ' · mutado por um admin';
    const icons = where
      ? [p.connecting && DOTS, !p.micOn && icon('mic-off', 'bad'), p.deafened && icon('headphones-off', 'bad'), hasCam && icon('video'), screens && icon('monitor')]
          .filter(Boolean)
          .join('')
      : '';
    const tag = p.host ? '<span class="admin-tag">host</span>' : p.admin ? '<span class="admin-tag">admin</span>' : '';

    li.innerHTML = `
      <div class="person-row">
        <div class="avatar sm"></div>
        <div class="person-main"><div class="person-name"></div><div class="person-status"></div></div>
        ${tag}
        <div class="person-icons">${icons}</div>
      </div>`;
    paintAvatar($('.avatar', li), p);
    $('.person-name', li).textContent = mine ? `${p.name} (você)` : p.name;
    $('.person-status', li).textContent = status;
    if (!mine) {
      li.title = canManage(p) ? 'Clique para ver as opções' : 'Clique para ajustar o volume';
      if (state.expanded === p.id) {
        const vol = document.createElement('label');
        vol.className = 'person-vol';
        vol.innerHTML = `${icon('volume')}<input type="range" min="0" max="100" aria-label="Volume (só para você)">`;
        $('input', vol).value = Math.round(volumeFor(p.id) * 100);
        li.append(vol);
        const actions = personActions(p);
        if (actions) {
          const box = document.createElement('div');
          box.className = 'person-actions';
          box.innerHTML = actions;
          li.append(box);
        }
      }
    }
    return li;
  });
  $('#people').replaceChildren(...items);
}

// ---------- menu do botão direito numa pessoa ----------
// Na lista de Pessoas, numa sala de voz da lista de canais ou no quadro dela no palco.

let menuPerson = null;

function openPersonMenu(p, x, y, anchor) {
  closePersonMenu();
  const mine = p.id === state.me?.id;
  const menu = $('#ctx-menu');
  const where = p.voice && state.channels.get(p.voice);
  const tileKey = `p:${p.id}`;
  const parts = [`<div class="ctx-head"><div class="avatar"></div><div><strong></strong><span></span></div></div>`];
  if (!mine) parts.push(`<button class="ctx-item" type="button" data-ctx="dm">${icon('chat')}<span>Mensagem privada</span></button>`);
  if (tiles.has(tileKey)) {
    const pinned = state.pinned.includes(tileKey);
    parts.push(`<button class="ctx-item" type="button" data-ctx="${pinned ? 'unpin' : 'pin'}">${icon(pinned ? 'pin-off' : 'pin')}<span>${pinned ? 'Desafixar do palco' : 'Fixar no palco'}</span></button>`);
  }
  if (!mine) parts.push(`<label class="ctx-vol" title="Volume (só para você)">${icon('volume')}<input type="range" min="0" max="100" aria-label="Volume (só para você)"></label>`);
  const actions = mine ? '' : personActions(p);
  if (actions) parts.push(`<div class="ctx-sep"></div>${actions}`);
  if (mine) parts.push(`<button class="ctx-item" type="button" data-ctx="settings">${icon('settings')}<span>Configurações</span></button>`);
  menu.innerHTML = parts.join('');
  paintAvatar($('.ctx-head .avatar', menu), p);
  $('.ctx-head strong', menu).textContent = mine ? `${p.name} (você)` : p.name;
  $('.ctx-head span', menu).textContent = where ? `Em ${where.name}` : p.online ? 'Fora das salas de voz' : 'Reconectando…';
  const vol = $('input', menu);
  if (vol) vol.value = Math.round(volumeFor(p.id) * 100);
  menu.hidden = false;
  // Fica inteiro dentro da tela.
  const box = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, innerWidth - box.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, innerHeight - box.height - 8))}px`;
  menuPerson = { id: p.id, anchor };
  anchor?.classList.add('menu-open');
}

function closePersonMenu() {
  if (!menuPerson) return;
  menuPerson.anchor?.classList.remove('menu-open');
  menuPerson = null;
  $('#ctx-menu').hidden = true;
}

const PERSON_TARGETS = '#people .person[data-id], #channel-list .ch-member[data-member], #stage .tile[data-key^="p:"]';

function personAt(el) {
  return state.participants.get(el.dataset.id || el.dataset.member || el.dataset.key.slice(2));
}

// No mouse, o menu abre no botão direito. No toque, abre num toque rápido: segurar o dedo é para
// arrastar (e o navegador transforma o "segurar" num botão direito, que aqui é ignorado).
function bindPersonMenu() {
  let lastPointer = 'mouse';
  let pressedAt = 0;
  let lastTap = { el: null, at: 0 };
  document.addEventListener(
    'pointerdown',
    (e) => {
      lastPointer = e.pointerType || 'mouse';
      pressedAt = Date.now();
    },
    true,
  );
  const byTouch = (e) => (e.pointerType || lastPointer) !== 'mouse';
  const HOLD_MS = 450; // dedo parado mais que isso foi "segurar", não toque
  document.addEventListener('contextmenu', (e) => {
    if (!state.inRoom) return;
    const el = e.target.closest(PERSON_TARGETS);
    if (!el) return closePersonMenu();
    const p = personAt(el);
    if (!p) return;
    e.preventDefault();
    if (byTouch(e)) return;
    openPersonMenu(p, e.clientX, e.clientY, el);
  });
  // Toque rápido numa pessoa (na lista, numa sala de voz ou no palco) abre o menu. Vem antes dos
  // outros cliques, para não abrir também as opções na lista de Pessoas.
  document.addEventListener(
    'click',
    (e) => {
      if (!state.inRoom || !byTouch(e) || e.target.closest('button, input, label, a, .person-vol, .person-actions')) return;
      const el = e.target.closest(PERSON_TARGETS);
      const p = el && personAt(el);
      if (!p) return;
      e.preventDefault();
      e.stopPropagation();
      if (Date.now() - pressedAt > HOLD_MS) return;
      // Dois toques seguidos num quadro do palco são tela cheia, não menu.
      const now = Date.now();
      const double = lastTap.el === el && now - lastTap.at < 350;
      lastTap = { el, at: now };
      if (double) return closePersonMenu();
      openPersonMenu(p, e.clientX, e.clientY, el);
    },
    true,
  );
  $('#ctx-menu').addEventListener('click', (e) => {
    const p = state.participants.get(menuPerson?.id);
    const ctx = e.target.closest('[data-ctx]')?.dataset.ctx;
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!p || (!ctx && !act)) return;
    closePersonMenu();
    if (ctx === 'dm') openDmWith(p);
    else if (ctx === 'pin' || ctx === 'unpin') tileAction(`p:${p.id}`, ctx, tiles.get(`p:${p.id}`));
    else if (ctx === 'settings') $('#btn-settings').click();
    else if (act) onPersonAction(act, p);
  });
  $('#ctx-menu').addEventListener('input', (e) => {
    const p = state.participants.get(menuPerson?.id);
    if (!p) return;
    store.set(`vol:${p.name}`, Number(e.target.value));
    applyVolumes();
  });
  document.addEventListener('pointerdown', (e) => {
    if (menuPerson && !e.target.closest('#ctx-menu')) closePersonMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePersonMenu();
  });
  window.addEventListener('resize', closePersonMenu);
  window.addEventListener('blur', closePersonMenu);
}

function onPersonAction(act, p) {
  const server = currentServer();
  if (act === 'mute') return send({ type: 'member:mute', userId: p.userId, muted: !p.muted });
  if (act === 'voice-kick') return send({ type: 'voice:kick', pid: p.id });
  if (act === 'role') {
    const ask = p.admin
      ? `Tirar o cargo de admin de ${p.name}?`
      : `Tornar ${p.name} admin? A pessoa vai poder mutar, expulsar e banir quem não é admin, apagar contas, tirar sons da mesa e arrastar canais e pessoas.`;
    if (!confirm(ask)) return;
    return adminApi('PUT', `/users/${p.userId}/admin`, { admin: !p.admin }).catch((err) => toast(err.message));
  }
  if (!server) return;
  if (act === 'kick' && confirm(`Expulsar ${p.name} de ${server.name}? A pessoa pode voltar se tiver o link de convite.`)) {
    send({ type: 'member:kick', userId: p.userId, serverId: server.id });
  }
  if (act === 'ban' && confirm(`Banir ${p.name} de ${server.name}? A pessoa sai e não consegue voltar nem com o convite (só o host desfaz).`)) {
    send({ type: 'member:kick', userId: p.userId, serverId: server.id, ban: true });
  }
}

function onPeopleClick(event) {
  if (event.target.closest('.person-vol')) return;
  const act = event.target.closest('[data-act]');
  if (act) {
    const p = state.participants.get(act.closest('.person')?.dataset.id);
    if (p) onPersonAction(act.dataset.act, p);
    return;
  }
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

const VIDEO_KEY = 'v:yt'; // o quadro do vídeo do YouTube no palco

function tileKeys() {
  const keys = [];
  for (const s of screenList()) {
    if (s.mine ? state.previewing.has(s.id) : subs.has(s.id)) keys.push(`s:${s.id}`);
  }
  if (state.voice) for (const p of sortedParticipants()) if (p.voice === state.voice) keys.push(`p:${p.id}`);
  if (state.voice && state.videoOnStage) keys.unshift(VIDEO_KEY);
  return keys;
}

// Põe os quadros no lugar: os fixados em cima (grandes) e o resto na grade, ou numa faixa
// de quadros menores quando há algo fixado.
// Depois que a pessoa arrasta algum quadro, a ordem dela vale; quadros novos entram no fim.
function orderedKeys(keys) {
  if (!state.tileOrder) return keys;
  const known = state.tileOrder.filter((k) => keys.includes(k));
  state.tileOrder = [...known, ...keys.filter((k) => !known.includes(k))];
  return state.tileOrder;
}

function renderStage() {
  if (!state.inRoom) return;
  const keys = orderedKeys(tileKeys());
  // Quadro que sumiu (a pessoa saiu, a tela parou) sai dos fixados sozinho.
  state.pinned = state.pinned.filter((k) => keys.includes(k));
  for (const [key, tile] of tiles) {
    if (keys.includes(key)) continue;
    tile.el.remove();
    tiles.delete(key);
  }
  for (const key of keys) updateTile(key, tiles.get(key) || createTile(key));

  const pinned = state.pinned;
  if (stageDragging) {
    // Quadro novo no meio do arrasto vai para o fim da grade; o resto fica onde a pessoa arrumou.
    for (const key of keys) if (!tiles.get(key).el.parentElement) $('#grid').append(tiles.get(key).el);
    return layoutGrid();
  }
  const rest = keys.filter((k) => !pinned.includes(k));
  const place = () => {
    placeTiles($('#focus'), pinned);
    placeTiles($('#grid'), rest);
    $('#stage').classList.toggle('has-focus', pinned.length > 0);
    $('#focus').hidden = !pinned.length;
    $('#focus').classList.toggle('single', pinned.length === 1);
    layoutGrid();
  };
  // Só anima quando a arrumação muda (fixar, desafixar, alguém entrar ou sair), e com o palco à vista.
  const arrangement = `${pinned.join()}|${rest.join()}`;
  if (arrangement !== stageArrangement && stageArrangement && !$('#stage').hidden) animateTiles(place);
  else place();
  stageArrangement = arrangement;
  for (const tile of tiles.values()) if (tile.stream && tile.video.paused) tile.video.play().catch(() => {});
  renderLivebar();
}

let stageArrangement = '';

// Coloca os quadros de keys dentro de box, nessa ordem, mexendo só no que mudou de lugar
// (tirar e pôr de volta um vídeo faz ele piscar).
function placeTiles(box, keys) {
  keys.forEach((key, i) => {
    const el = tiles.get(key).el;
    if (box.children[i] !== el) box.insertBefore(el, box.children[i] || null);
  });
}

function createTile(key) {
  const el = document.createElement('div');
  el.className = key === VIDEO_KEY ? 'tile video-tile' : 'tile';
  el.dataset.key = key;
  el.innerHTML = `
    <video autoplay playsinline muted></video>
    <div class="avatar"></div>
    <span class="tile-dots dots" title="Conectando a voz…"><i></i><i></i><i></i></span>
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
  el.addEventListener('dblclick', () => (key === VIDEO_KEY ? toggleVideoFull() : toggleFullscreen(tile)));
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
  pin: ['pin', 'Fixar'],
  unpin: ['pin-off', 'Desafixar'],
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
  let actions = [state.pinned.includes(key) ? 'unpin' : 'pin', 'fullscreen'];

  if (type === 'v') {
    const current = state.music?.current;
    name = current ? `Vídeo · ${current.title}` : 'Vídeo · nada tocando';
    actions = [...actions, 'close'];
  } else if (type === 'p') {
    const p = state.participants.get(id);
    const mine = id === state.me.id;
    name = mine ? `${p.name} (você)` : p.name;
    speaker = id;
    paintAvatar(tile.avatar, p);
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
    tile.el.classList.toggle('connecting', !!p.connecting && p.online);
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
  tile.el.classList.toggle('pinned', state.pinned.includes(key));
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
  if (act === 'pin') {
    if (!state.pinned.includes(key)) state.pinned.push(key);
    renderStage();
  } else if (act === 'unpin') {
    state.pinned = state.pinned.filter((k) => k !== key);
    renderStage();
  } else if (act === 'fullscreen') {
    if (key === VIDEO_KEY) toggleVideoFull();
    else toggleFullscreen(tile);
  } else if (act === 'flip') {
    flipCamera();
  } else if (act === 'mute' || act === 'unmute') {
    const sub = subs.get(id);
    if (!sub) return;
    sub.muted = act === 'mute';
    for (const el of sub.audioEls) el.muted = shouldMute(el);
    renderStage();
  } else if (act === 'close' && key === VIDEO_KEY) {
    // O vídeo volta para a aba Vídeo.
    state.videoOnStage = false;
    state.pinned = state.pinned.filter((k) => k !== VIDEO_KEY);
    renderStage();
    renderMusic();
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

// ---------- arrastar os quadros do palco ----------
// Como os widgets do celular: enquanto o quadro é arrastado, ele já ocupa o lugar onde vai cair e os
// outros abrem espaço (com animação). Soltar na área dos fixados fixa o quadro; tirar de lá desafixa.
// A ordem vale só para quem arrastou.

let stageDragging = false;

function bindStageDrag() {
  makeDraggable($('#stage'), {
    selector: '.tile',
    canDrag: (el, e) => !e.target.closest('button') && !document.fullscreenElement && tiles.size > 1,
    onMove(el, x, y, ghost) {
      if (!stageDragging) {
        stageDragging = true;
        document.body.classList.add('stage-dragging');
      }
      liveMoveTile(el, x, y, ghost);
    },
    onDrop() {
      commitStageOrder();
    },
    onEnd() {
      stageDragging = false;
      document.body.classList.remove('stage-dragging');
      renderStage();
    },
    settle: true,
  });
}

function inside(box, x, y) {
  const r = box.getBoundingClientRect();
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

// Onde o quadro fica de verdade, sem a animação que está movendo ele agora (as animações do FLIP
// usam origem no canto de cima, então dá para descontar o deslocamento e a escala).
function layoutRect(t) {
  const r = t.getBoundingClientRect();
  const tr = getComputedStyle(t).transform;
  if (!tr || tr === 'none') return r;
  const m = new DOMMatrixReadOnly(tr);
  const width = r.width / (m.a || 1);
  const height = r.height / (m.d || 1);
  const left = r.left - m.e;
  const top = r.top - m.f;
  return { left, top, width, height, right: left + width, bottom: top + height };
}

// Quem decide é o centro do quadro arrastado: passou do meio de um vizinho, já troca de lugar com
// ele (como os widgets do celular). Fica antes de todo quadro que está numa linha de baixo, ou na
// mesma linha mais à direita (numa coluna só, mais abaixo).
function liveMoveTile(el, x, y, ghost) {
  const g = ghost?.getBoundingClientRect();
  const cx = g ? g.left + g.width / 2 : x;
  const cy = g ? g.top + g.height / 2 : y;
  const focus = $('#focus');
  const grid = $('#grid');
  const area = !focus.hidden && inside(focus, cx, cy) ? focus : inside(grid, cx, cy) ? grid : !focus.hidden && inside(focus, x, y) ? focus : inside(grid, x, y) ? grid : null;
  if (!area) return;
  edgeScroll(area, cx);
  const others = [...area.children].filter((t) => t.classList.contains('tile') && t !== el);
  const rects = others.map(layoutRect);
  // Lado a lado (linhas) ou um embaixo do outro (coluna)?
  const sideBySide = rects.some((a, i) => rects.some((b, j) => i !== j && Math.abs(a.top - b.top) < 4));
  // Basta o quadro arrastado cobrir mais da metade do vizinho para trocar com ele: a borda da frente
  // dele passou do meio do vizinho. Vindo de outra área, vale o centro.
  const inArea = el.parentElement === area;
  const half = (sideBySide ? g?.width || 0 : g?.height || 0) / 2;
  const pos = sideBySide ? cx : cy;
  let index = 0;
  rects.forEach((r, i) => {
    let before;
    if (cy > r.bottom) before = true;
    else if (cy < r.top) before = false;
    else {
      const middle = sideBySide ? r.left + r.width / 2 : r.top + r.height / 2;
      const wasBefore = inArea && !!(others[i].compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
      if (!inArea) before = pos > middle;
      else if (wasBefore) before = pos - half >= middle; // continua antes até a borda de trás do arrastado passar o meio dele
      else before = pos + half > middle; // passa a ficar antes quando a borda da frente passa o meio
    }
    if (before) index++;
  });
  const next = others[index] || null;
  if (el.parentElement === area && el.nextElementSibling === next) return;
  animateTiles(() => {
    area.insertBefore(el, next);
    $('#focus').classList.toggle('single', $('#focus').children.length === 1);
    layoutGrid();
  });
}

// A faixa de quadros menores rola sozinha quando o quadro chega perto da borda dela.
function edgeScroll(area, cx) {
  if (area.id !== 'grid' || area.scrollWidth <= area.clientWidth) return;
  const r = area.getBoundingClientRect();
  if (cx < r.left + 48) area.scrollLeft -= 14;
  else if (cx > r.right - 48) area.scrollLeft += 14;
}

// FLIP: guarda onde cada quadro estava (e o tamanho), aplica a mudança e anima cada um do lugar
// antigo para o novo. Quadro que acabou de aparecer entra crescendo.
function animateTiles(change) {
  const before = new Map([...$$('#stage .tile')].map((t) => [t, t.getBoundingClientRect()]));
  change();
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  for (const t of $$('#stage .tile')) {
    const a = before.get(t);
    if (!a) {
      t.animate([{ opacity: 0, transform: 'scale(0.92)' }, { opacity: 1, transform: 'none' }], { duration: 220, easing: 'ease-out' });
      continue;
    }
    const b = t.getBoundingClientRect();
    if (!b.width || !a.width) continue;
    const dx = a.left - b.left;
    const dy = a.top - b.top;
    const sx = a.width / b.width;
    const sy = a.height / b.height;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(sx - 1) < 0.01 && Math.abs(sy - 1) < 0.01) continue;
    t.animate(
      [
        { transformOrigin: '0 0', transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` },
        { transformOrigin: '0 0', transform: 'none' },
      ],
      { duration: 260, easing: 'cubic-bezier(0.2, 0.9, 0.3, 1)' },
    );
  }
}

function commitStageOrder() {
  const keysIn = (box) => [...box.children].map((t) => t.dataset.key).filter((k) => k && tiles.has(k));
  const pinned = keysIn($('#focus'));
  const rest = keysIn($('#grid'));
  state.pinned = pinned;
  state.tileOrder = [...rest, ...pinned];
}

// Escolhe o número de colunas que deixa os quadros (16:9) maiores no espaço disponível:
// na grade (sem nada fixado) ou na área dos fixados (com mais de um).
function layoutGrid() {
  const grid = $('#grid');
  const focus = $('#focus');
  // Conta o que está na tela (no meio de um arrasto, isso muda antes do estado).
  const pinned = focus.hidden ? 0 : focus.children.length;
  if (pinned) grid.style.removeProperty('--tile-w');
  else fitTiles(grid, grid.children.length);
  if (pinned > 1) fitTiles(focus, pinned);
  else focus.style.removeProperty('--tile-w');
}

function fitTiles(box, n) {
  if (!n) return;
  const gap = 8;
  const width = box.clientWidth;
  const height = box.clientHeight;
  if (!width || !height) return;
  let best = 0;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    let w = (width - gap * (cols - 1)) / cols;
    const h = (w * 9) / 16;
    if (h * rows + gap * (rows - 1) > height) w = (((height - gap * (rows - 1)) / rows) * 16) / 9;
    best = Math.max(best, Math.floor(w));
  }
  box.style.setProperty('--tile-w', `${Math.max(best, 120)}px`);
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
  if (tab === 'chat') {
    state.unread = 0;
    if (state.voice) markRead(state.voice);
  }
  for (const b of $$('.tab')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  for (const panel of $$('[data-panel]')) panel.classList.toggle('inactive', panel.dataset.panel !== tab);
  renderBadge();
  if (tab === 'chat' && voiceChat) voiceChat.box.scrollTop = voiceChat.box.scrollHeight;
}

function renderBadge() {
  const badge = $('#chat-badge');
  badge.hidden = !state.unread;
  badge.textContent = state.unread > 9 ? '9+' : state.unread;
}

// ---------- canais ----------

const chats = new Map(); // id do canal -> { list, loaded, loading, more }
const chatViews = []; // o canal de texto no meio da tela e o chat da sala de voz, ao lado
const readUpTo = new Map();
const INLINE_IMAGE = /^image\/(png|jpeg|gif|webp|avif)$/;

// ---------- servidores ----------

function sortedServers() {
  return [...state.servers.values()].sort((a, b) => a.createdAt - b.createdAt);
}

const inviteLink = (s) => `${location.origin}/convite/${s.invite}`;

// Aceita o código sozinho ou o link inteiro.
const parseInvite = (text) => /convite[=/]([\w-]{4,32})/.exec(text)?.[1] || text.trim();

function joinByInvite(text) {
  const code = parseInvite(String(text || ''));
  if (!code) return;
  $('#no-servers-error').textContent = '';
  send({ type: 'server:join', code });
}

function onServerJoined({ id, name, already }) {
  store.set('invite', null);
  $('#no-servers-code').value = '';
  toast(already ? `Você já está em ${name}.` : `Você entrou em ${name}!`);
  // A lista nova de servidores pode chegar logo depois deste aviso.
  const open = () => {
    if (!state.servers.has(id)) return false;
    state.view = null;
    selectServer(id);
    return true;
  };
  if (!open()) setTimeout(open, 300);
}

async function copyInvite(s) {
  if (!s?.invite) return;
  const link = inviteLink(s);
  try {
    await navigator.clipboard.writeText(link);
  } catch {
    // Navegador sem acesso à área de transferência: copia pelo jeito antigo.
    const area = Object.assign(document.createElement('textarea'), { value: link });
    document.body.append(area);
    area.select();
    const copied = document.execCommand('copy');
    area.remove();
    if (!copied) {
      try {
        prompt(`Link de convite de ${s.name}:`, link);
      } catch {
        toast(`Convite de ${s.name}: ${link}`, { timeout: 20000 });
      }
      return;
    }
  }
  toast(`Link de convite de ${s.name} copiado.`);
}

// Sem servidor nenhum: a tela de "que pena" cobre a sala até chegar um convite.
function renderNoServers() {
  const none = state.inRoom && !state.servers.size;
  $('#no-servers').hidden = !none;
}

function currentServer() {
  return state.servers.get(state.server) || sortedServers()[0];
}

function selectServer(id) {
  if (!state.servers.has(id)) return;
  state.dm = false;
  state.server = id;
  store.set('server', id);
  toggleServerMenu(false);
  renderAll();
}

function toggleServerMenu(open = $('#server-menu').hidden) {
  $('#server-menu').hidden = !open;
  $('#server-head').setAttribute('aria-expanded', String(open));
  if (open) renderServerMenu();
}

// Os servidores ficam na barra da esquerda; o menu do nome tem só o que se faz com o servidor aberto.
function renderServerMenu() {
  const current = currentServer();
  const items = [];
  const extra = (act, iconName, text) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'server-item muted';
    b.dataset.menu = act;
    b.innerHTML = `${icon(iconName)}<span class="server-item-name"></span>`;
    $('.server-item-name', b).textContent = text;
    items.push(b);
  };
  if (current?.invite) extra('invite', 'link', `Copiar convite de ${current.name}`);
  extra('join', 'plus', 'Entrar com um convite');
  if (state.account?.host) extra('servers', 'settings', 'Gerenciar servidores');
  $('#server-menu').replaceChildren(...items);
}

// ---------- barra de servidores ----------
// Como no Discord: as conversas privadas em cima, depois um ícone por servidor, e embaixo
// entrar com um convite (e, para o host, gerenciar os servidores).

const SERVER_ICONS = [
  ['gamepad', 'Jogos'],
  ['meeting', 'Reunião'],
  ['chat', 'Conversa'],
  ['tvplay', 'Vídeos'],
  ['music', 'Música'],
  ['star', 'Estrela'],
  ['heart', 'Coração'],
  ['book', 'Estudos'],
  ['code', 'Código'],
  ['trophy', 'Troféu'],
  ['rocket', 'Foguete'],
  ['coffee', 'Café'],
];

function serverBadge(s) {
  return s.icon ? icon(s.icon) : escapeText(initials(s.name));
}

function escapeText(text) {
  return String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

function serverUnread(s) {
  return [...state.channels.values()].some((c) => c.serverId === s.id && c.kind === 'text' && isUnread(c));
}

function unreadDms() {
  return [...state.channels.values()].filter((c) => c.kind === 'dm' && isUnread(c)).length;
}

function renderRail() {
  if (!state.inRoom) return;
  const current = !state.dm && currentServer();
  const item = (inner, { active = false, unread = false, title = '' } = {}) => {
    const div = document.createElement('div');
    div.className = 'rail-item';
    div.classList.toggle('active', active);
    div.classList.toggle('unread', unread && !active);
    div.innerHTML = inner;
    if (title) $('button', div).title = title;
    return div;
  };
  const dmCount = unreadDms();
  const items = [
    item(`<button class="rail-btn" type="button" data-rail="dm" aria-label="Mensagens privadas">${icon('chat')}</button>${dmCount ? `<span class="rail-badge">${dmCount > 9 ? '9+' : dmCount}</span>` : ''}`, {
      active: state.dm,
      unread: dmCount > 0,
      title: 'Mensagens privadas',
    }),
  ];
  const sep = document.createElement('div');
  sep.className = 'rail-sep';
  items.push(sep);
  for (const s of sortedServers()) {
    const el = item(`<button class="rail-btn${s.icon ? ' has-icon' : ''}" type="button" data-server="${s.id}"></button>`, {
      active: s.id === current?.id,
      unread: serverUnread(s),
      title: s.name,
    });
    $('button', el).innerHTML = serverBadge(s);
    $('button', el).setAttribute('aria-label', s.name);
    items.push(el);
  }
  items.push(item(`<button class="rail-btn ghost" type="button" data-rail="join" aria-label="Entrar com um convite">${icon('plus')}</button>`, { title: 'Entrar com um convite' }));
  if (state.account?.host) {
    items.push(item(`<button class="rail-btn ghost muted" type="button" data-rail="servers" aria-label="Gerenciar servidores">${icon('settings')}</button>`, { title: 'Gerenciar servidores' }));
  }
  $('#rail').replaceChildren(...items);
}

function bindRail() {
  $('#rail').addEventListener('click', (e) => {
    const server = e.target.closest('[data-server]');
    if (server) {
      selectServer(server.dataset.server);
      return;
    }
    const act = e.target.closest('[data-rail]')?.dataset.rail;
    if (act === 'dm') openDms();
    else if (act === 'servers') openServersPanel();
    else if (act === 'join') {
      const code = prompt('Cole o link ou o código de convite:');
      if (code) joinByInvite(code);
    }
  });
}

// ---------- conversas privadas ----------
// Cada conversa é um canal "dm" que só as duas contas enxergam; as mensagens somem depois de
// alguns dias (o servidor apaga). Abrir uma conversa com alguém: botão direito na pessoa.

function dmOther(ch) {
  const id = ch.members?.find((m) => m !== state.account?.id) || ch.members?.[0];
  const online = sortedParticipants().find((p) => p.userId === id);
  return { userId: id, name: online?.name || ch.names?.[id] || 'Conta apagada', color: online?.color || '', avatar: online?.avatar || ch.avatars?.[id] || null, online: !!online };
}

function sortedDms() {
  return [...state.channels.values()].filter((c) => c.kind === 'dm').sort((a, b) => (b.lastTs || b.createdAt) - (a.lastTs || a.createdAt));
}

let dmPicking = false;

function openDms() {
  state.dm = true;
  if (!state.channels.get(state.dmView)) state.dmView = sortedDms()[0]?.id || null;
  toggleServerMenu(false);
  renderAll();
}

function openDmWith(p) {
  if (!p?.userId || p.userId === state.account?.id) return;
  closePersonMenu();
  send({ type: 'dm:open', userId: p.userId });
}

function onDmOpened(id) {
  const open = () => {
    if (!state.channels.has(id)) return false;
    dmPicking = false;
    $('#room').classList.remove('channels-open');
    showView(id);
    return true;
  };
  if (!open()) setTimeout(open, 300);
}

// Quem dá para chamar no privado: quem está conectado e divide um servidor comigo.
function dmCandidates() {
  const seen = new Set();
  const list = [];
  for (const s of sortedServers()) {
    for (const p of serverPeople(s)) {
      if (p.userId === state.account?.id || seen.has(p.userId)) continue;
      seen.add(p.userId);
      list.push(p);
    }
  }
  return list;
}

function renderDmList() {
  const box = document.createElement('div');
  box.className = 'ch-group';
  box.innerHTML = `<button class="btn secondary small dm-new" type="button" data-dm-new>${icon('plus')}Nova conversa</button>`;
  if (dmPicking) {
    const ul = document.createElement('ul');
    ul.className = 'dm-pick';
    const people = dmCandidates();
    if (!people.length) ul.innerHTML = '<p class="hint">Ninguém conectado agora. Dá para abrir uma conversa pelo botão direito em alguém.</p>';
    for (const p of people) {
      const li = document.createElement('li');
      li.innerHTML = `<button type="button" data-dm-user="${p.userId}"><span class="avatar"></span><span></span></button>`;
      paintAvatar($('.avatar', li), p);
      $('span:last-child', li).textContent = p.name;
      ul.append(li);
    }
    box.append(ul);
  }
  const head = document.createElement('div');
  head.className = 'ch-head';
  head.innerHTML = '<span>Mensagens privadas</span>';
  box.append(head);
  for (const ch of sortedDms()) {
    const other = dmOther(ch);
    const row = document.createElement('div');
    row.className = 'ch-row dm-row';
    row.dataset.id = ch.id;
    row.classList.toggle('active', ch.id === state.dmView);
    row.classList.toggle('unread', isUnread(ch));
    row.innerHTML = `<button class="ch" type="button" data-channel="${ch.id}"><span class="avatar"></span><span class="ch-name"></span></button>`;
    paintAvatar($('.avatar', row), other);
    $('.ch-name', row).textContent = other.name;
    box.append(row);
  }
  if (!sortedDms().length) {
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = 'Nenhuma conversa ainda.';
    box.append(hint);
  }
  $('#channel-list').replaceChildren(box);
  $('#server-name').textContent = 'Mensagens privadas';
  $('#server-head').disabled = true;
}

// Mexeram em servidores ou membros: chega a lista nova do que esta conta enxerga.
function onDirectory(d) {
  state.servers = new Map(d.servers.map((s) => [s.id, s]));
  state.channels = new Map(d.channels.map((c) => [c.id, c]));
  state.musics = new Map(Object.entries(d.musics));
  for (const id of [...chats.keys()]) if (!state.channels.has(id)) chats.delete(id);
  for (const view of chatViews) if (view.channelId && !state.channels.has(view.channelId)) view.channelId = null;
  if (state.voice && !state.channels.has(state.voice)) leaveVoice({ notify: false });
  syncMusic();
  renderAll();
  renderServersPanel();
}

const accountOf = (a) => ({ id: a.id, email: a.email, name: a.name, admin: a.admin, host: a.host, muted: !!a.muted, avatar: a.avatar || null });

// O host deu ou tirou o cargo de admin desta conta, ou um admin mutou ou desmutou.
function onAccount(account, by) {
  const was = state.account;
  state.account = accountOf(account);
  if (was?.admin !== account.admin) toast(account.admin ? 'Você agora é admin da sala.' : 'Você não é mais admin da sala.');
  if (!account.admin && $('#admin-dialog').open) $('#admin-dialog').close();
  if (!!was?.muted !== !!account.muted) {
    if (account.muted) {
      // O servidor já parou de mandar o microfone para os outros; aqui ele desliga de vez.
      state.micOn = false;
      const mic = local.mic;
      clearTimeout(micHoldTimer);
      if (mic) {
        local.mic = null;
        unpublishLocal(mic);
        detachMeter(state.me.id);
      }
      sendState();
      toast(`${by || 'Um admin'} te mutou. Só um admin pode desmutar.`, { timeout: 8000 });
    } else {
      toast(`${by || 'Um admin'} te desmutou. Pode ligar o microfone.`);
    }
  }
  renderAll();
  renderSoundpad();
  if ($('#settings').open) renderSettingsAvatar();
}

// ---------- canais ----------

function sortedChannels(kind, serverId = currentServer()?.id) {
  return [...state.channels.values()]
    .filter((c) => c.kind === kind && c.serverId === serverId)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || a.createdAt - b.createdAt);
}

function channelLabel(ch) {
  if (ch.kind === 'dm') return `@${dmOther(ch).name}`;
  return ch.kind === 'text' ? `#${ch.name}` : ch.name;
}

// O canal de texto aberto (ou a sala de voz em que estou, se foi ela que a pessoa abriu), no servidor aberto.
function currentView() {
  if (state.dm) return state.channels.get(state.dmView) || null;
  const ch = state.channels.get(state.view);
  if (ch && ch.serverId === currentServer()?.id && (ch.kind === 'text' || ch.id === state.voice)) return ch;
  return sortedChannels('text')[0];
}

function showView(id) {
  const ch = state.channels.get(id);
  if (!ch) return;
  if (ch.kind === 'dm') {
    state.dm = true;
    state.dmView = id;
    return renderAll();
  }
  state.dm = false;
  state.view = id;
  if (ch.serverId !== state.server) {
    state.server = ch.serverId;
    store.set('server', ch.serverId);
  }
  if (ch.kind === 'text') store.set('view', id);
  renderAll();
}

function openChannel(id) {
  $('#room').classList.remove('channels-open');
  if (state.channels.get(id)?.kind === 'voice') joinVoice(id);
  else showView(id);
}

function renderView() {
  const ch = currentView();
  // Conversas privadas sem nenhuma aberta: a tela de "comece uma conversa".
  const emptyDm = state.dm && !ch;
  $('#dm-empty').hidden = !emptyDm;
  $('#text-chat').hidden = emptyDm;
  if (emptyDm) {
    $('#stage').hidden = true;
    $('#text-view').hidden = false;
    $('#text-title').textContent = 'Mensagens privadas';
    $('#text-icon').innerHTML = icon('chat');
    $('#dm-empty-text').textContent = `Clique com o botão direito em alguém (na lista de Pessoas, numa sala de voz ou no palco) e escolha "Mensagem privada". As mensagens somem depois de ${state.config?.dmTtlDays || 7} dias.`;
  }
  if (!ch || !textChat) return;
  if (ch.kind !== 'dm') state.view = ch.id;
  const voiceView = ch.kind === 'voice';
  const wasHidden = $('#stage').hidden;
  $('#stage').hidden = !voiceView;
  $('#text-view').hidden = voiceView;
  if (voiceView && wasHidden) requestAnimationFrame(layoutGrid);
  if (!voiceView) {
    $('#text-title').textContent = ch.kind === 'dm' ? dmOther(ch).name : ch.name;
    $('#text-icon').innerHTML = icon(ch.kind === 'dm' ? 'at' : 'hash');
    if (textChat.channelId !== ch.id) bindChat(textChat, ch.id);
    if (document.visibilityState === 'visible') markRead(ch.id);
  }
  if (state.voice && voiceChat.channelId !== state.voice) bindChat(voiceChat, state.voice);
  for (const view of chatViews) {
    const bound = state.channels.get(view.channelId);
    view.input.placeholder = bound ? `Conversar em ${channelLabel(bound)}` : '';
  }
  // O chat ao lado é o da sala de voz: só existe dentro de uma.
  $('#tab-chat').hidden = !state.voice;
  if (!state.voice && state.tab === 'chat') setTab('people');
}

function renderChannels() {
  // Durante um arrasto a lista fica parada; ela é desenhada de novo ao soltar.
  if (!state.inRoom || channelDrag?.active) return;
  renderRail();
  if (state.dm) {
    renderDmList();
    renderVoiceStatus();
    return;
  }
  $('#server-head').disabled = false;
  $('#channel-list').classList.toggle('can-drag', !!state.account?.admin);
  // Criar, renomear e apagar canais: só admin (o servidor também barra).
  $('#channel-list').classList.toggle('can-edit', !!state.account?.admin);
  const view = currentView();
  const groups = [
    ['text', 'Canais de texto'],
    ['voice', 'Canais de voz'],
  ].map(([kind, title]) => {
    const group = document.createElement('div');
    group.className = 'ch-group';
    const what = kind === 'voice' ? 'de voz' : 'de texto';
    group.innerHTML = `<div class="ch-head"><span></span><button class="icon-btn sm" type="button" data-add="${kind}" aria-label="Criar canal ${what}" title="Criar canal ${what}">${icon('plus')}</button></div>`;
    $('.ch-head span', group).textContent = title;
    for (const ch of sortedChannels(kind)) {
      const row = document.createElement('div');
      row.className = 'ch-row';
      row.dataset.id = ch.id;
      row.dataset.kind = kind;
      row.classList.toggle('active', ch.id === view?.id);
      row.classList.toggle('connected', ch.id === state.voice);
      row.classList.toggle('unread', kind === 'text' && isUnread(ch));
      const playing = state.musics.get(ch.id)?.playing ? icon('tvplay', 'ch-music') : '';
      row.innerHTML = `<button class="ch" type="button" data-channel="${ch.id}">${icon(kind === 'voice' ? 'volume' : 'hash')}<span class="ch-name"></span>${playing}</button><button class="icon-btn sm ch-edit" type="button" data-edit="${ch.id}" aria-label="Editar canal" title="Editar canal">${icon('settings')}</button>`;
      $('.ch-name', row).textContent = ch.name;
      group.append(row);
      if (kind !== 'voice') continue;
      const members = sortedParticipants().filter((p) => p.voice === ch.id);
      if (!members.length) continue;
      const ul = document.createElement('ul');
      ul.className = 'ch-members';
      ul.dataset.voice = ch.id;
      for (const p of members) {
        const mine = p.id === state.me.id;
        const li = document.createElement('li');
        li.className = 'ch-member';
        li.dataset.speaker = p.id;
        li.dataset.member = p.id;
        li.classList.toggle('offline', !p.online);
        li.classList.toggle('connecting', !!p.connecting);
        if (p.connecting) li.title = 'Conectando a voz…';
        const icons = [
          p.connecting && DOTS,
          (mine ? local.camera : cameraOf(p.id)) && icon('video'),
          screenCountOf(p.id) && icon('monitor'),
          !p.micOn && icon('mic-off', 'bad'),
          p.deafened && icon('headphones-off', 'bad'),
        ]
          .filter(Boolean)
          .join('');
        li.innerHTML = `<div class="avatar"></div><span class="ch-member-name"></span><span class="ch-member-icons">${icons}</span>`;
        paintAvatar($('.avatar', li), p);
        $('.ch-member-name', li).textContent = p.name;
        ul.append(li);
      }
      group.append(ul);
    }
    return group;
  });
  $('#channel-list').replaceChildren(...groups);
  $('#server-name').textContent = currentServer()?.name || '';
  renderVoiceStatus();
}

function renderVoiceStatus() {
  const voice = state.channels.get(state.voice);
  $('#voice-status').hidden = !voice;
  if (voice) {
    const where = state.dm || voice.serverId !== currentServer()?.id ? ` · ${state.servers.get(voice.serverId)?.name || ''}` : '';
    $('#voice-status-name').textContent = `${voice.name}${where}`;
  }
}

// ---------- arrastar canais e pessoas (só admin) ----------

let channelDrag = null;
let dropTarget = null; // { before } ao arrastar um canal; { pid, channelId } ao arrastar uma pessoa

function clearDropMarks() {
  for (const el of $$('#channel-list .drop-before, #channel-list .drop-after, #channel-list .drop-into')) {
    el.classList.remove('drop-before', 'drop-after', 'drop-into');
  }
}

function bindChannelDrag() {
  channelDrag = makeDraggable($('#channel-list'), {
    selector: '.ch-row, .ch-member',
    canDrag: () => !!state.account?.admin && !state.dm,
    onMove(el, x, y) {
      clearDropMarks();
      dropTarget = el.classList.contains('ch-row') ? channelDropAt(el, y) : memberDropAt(el, x, y);
    },
    onDrop(el) {
      if (dropTarget?.pid) moveMember(dropTarget.pid, dropTarget.channelId);
      else if (dropTarget) moveChannel(el.dataset.id, dropTarget.before);
    },
    onEnd() {
      dropTarget = null;
      renderChannels();
    },
  });
}

// Um canal cai entre os do mesmo tipo: antes do primeiro cuja metade está abaixo do ponteiro.
function channelDropAt(el, y) {
  const rows = $$('.ch-row', el.closest('.ch-group')).filter((r) => r !== el);
  const next = rows.find((r) => {
    const box = r.getBoundingClientRect();
    return y < box.top + box.height / 2;
  });
  if (next) next.classList.add('drop-before');
  else rows.at(-1)?.classList.add('drop-after');
  return { before: next?.dataset.id || null };
}

// Uma pessoa cai na sala de voz embaixo do ponteiro (na linha da sala ou na lista de quem está nela).
function memberDropAt(el, x, y) {
  const spot = document.elementFromPoint(x, y)?.closest('#channel-list .ch-row[data-kind="voice"], #channel-list .ch-members');
  const channelId = spot?.dataset.id || spot?.dataset.voice;
  const pid = el.dataset.member;
  if (!channelId || channelId === state.participants.get(pid)?.voice) return null;
  $(`#channel-list .ch-row[data-id="${channelId}"]`)?.classList.add('drop-into');
  return { pid, channelId };
}

function moveChannel(id, before) {
  const ch = state.channels.get(id);
  if (!ch) return;
  const old = sortedChannels(ch.kind, ch.serverId);
  const list = old.filter((c) => c !== ch);
  const at = before ? list.findIndex((c) => c.id === before) : -1;
  list.splice(at < 0 ? list.length : at, 0, ch);
  if (list.every((c, i) => c === old[i])) return;
  // Já mostra na ordem nova; o servidor confirma para todo mundo.
  list.forEach((c, i) => (c.position = i));
  send({ type: 'channel:move', id, before });
}

function moveMember(pid, channelId) {
  if (pid === state.me.id) return joinVoice(channelId);
  send({ type: 'voice:move', pid, channelId });
}

function onChannelRemoved(id) {
  const ch = state.channels.get(id);
  state.channels.delete(id);
  if (state.dmView === id) state.dmView = null;
  state.musics.delete(id);
  chats.delete(id);
  for (const view of chatViews) if (view.channelId === id) view.channelId = null;
  if (state.voice === id) {
    leaveVoice({ notify: false });
    toast(`A sala de voz ${ch?.name || ''} foi apagada.`);
  }
  renderAll();
}

// ---------- lidas e não lidas ----------

function readTs(id) {
  if (!readUpTo.has(id)) readUpTo.set(id, store.get(`read:${id}`, 0));
  return readUpTo.get(id);
}

function isUnread(ch) {
  return ch.lastTs > readTs(ch.id);
}

function markRead(id) {
  const ch = state.channels.get(id);
  if (!ch || readTs(id) >= ch.lastTs) return;
  readUpTo.set(id, ch.lastTs);
  store.set(`read:${id}`, ch.lastTs);
  renderChannels();
}

function isChatVisible(id) {
  if (document.visibilityState !== 'visible') return false;
  if (!$('#text-view').hidden && textChat?.channelId === id) return true;
  return id === state.voice && state.tab === 'chat' && !$('#room').classList.contains('side-hidden');
}

// ---------- mensagens ----------

function chatOf(id) {
  let c = chats.get(id);
  if (!c) {
    c = { list: [], loaded: false, loading: false, more: false };
    chats.set(id, c);
  }
  return c;
}

async function loadHistory(id, before = null) {
  const c = chatOf(id);
  if (c.loading) return;
  c.loading = true;
  await authReady;
  send({ type: 'chat:history', channelId: id, before });
}

function onHistory({ channelId, before, messages, more }) {
  const c = chats.get(channelId);
  if (!c) return;
  c.loading = false;
  const known = new Set(c.list.map((m) => m.id));
  c.list = before ? [...messages.filter((m) => !known.has(m.id)), ...c.list] : messages;
  c.more = more;
  c.loaded = true;
  for (const view of chatViews) if (view.channelId === channelId) renderChatView(view, { keepScroll: !!before });
}

function onChatMessage(m) {
  const ch = state.channels.get(m.channelId);
  if (ch) ch.lastTs = m.ts;
  const c = chats.get(m.channelId);
  if (c?.loaded) {
    c.list.push(m);
    for (const view of chatViews) if (view.channelId === m.channelId) appendChat(view, m);
  }
  if (m.pid === state.me?.id || isChatVisible(m.channelId)) markRead(m.channelId);
  else if (ch?.kind === 'dm') {
    sound('on');
    toast(`Mensagem privada de ${m.name}${m.text ? `: ${m.text.slice(0, 80)}` : ''}`, { action: 'Abrir', onAction: () => showView(m.channelId) });
  } else if (m.channelId === state.voice) {
    state.unread++;
    renderBadge();
  }
  renderChannels();
}

function onChatDeleted({ channelId, id }) {
  const c = chats.get(channelId);
  if (!c) return;
  c.list = c.list.filter((m) => m.id !== id);
  for (const view of chatViews) if (view.channelId === channelId) renderChatView(view, { keepScroll: true });
}

// A sala de voz esvaziou e o chat dela foi apagado.
function onChatCleared({ channelId }) {
  const ch = state.channels.get(channelId);
  if (ch) ch.lastTs = 0;
  const c = chats.get(channelId);
  if (c) Object.assign(c, { list: [], loaded: true, loading: false, more: false });
  if (channelId === state.voice) {
    state.unread = 0;
    renderBadge();
  }
  for (const view of chatViews) if (view.channelId === channelId) renderChatView(view);
  renderChannels();
}

function myAuthor() {
  return state.me?.author;
}

function fmtWhen(ts) {
  const d = new Date(ts);
  const time = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(ts).setHours(0, 0, 0, 0)) / 86_400_000);
  if (days === 0) return time;
  if (days === 1) return `ontem às ${time}`;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return `${d.toLocaleDateString('pt-BR', sameYear ? { day: '2-digit', month: '2-digit' } : undefined)} ${time}`;
}

function messageEl(m, prev) {
  const el = document.createElement('div');
  el.className = 'msg';
  el.dataset.id = m.id;
  // Mensagens seguidas da mesma pessoa ficam juntas, sem repetir foto e nome.
  el.classList.toggle('cont', !!prev && prev.author === m.author && m.ts - prev.ts < 5 * 60_000);
  el.innerHTML = `<div class="avatar xs"></div><div class="msg-body"><div class="msg-head"><span class="msg-name"></span><span class="msg-time"></span></div><div class="msg-text"></div><div class="atts"></div></div>`;
  paintAvatar($('.avatar', el), m);
  $('.msg-name', el).textContent = m.name;
  $('.msg-time', el).textContent = fmtWhen(m.ts);
  el.title = new Date(m.ts).toLocaleString('pt-BR', { dateStyle: 'full', timeStyle: 'short' });
  if (m.text) linkify($('.msg-text', el), m.text);
  else $('.msg-text', el).remove();
  const atts = $('.atts', el);
  for (const a of m.attachments || []) atts.append(attachmentEl(a));
  if (!atts.children.length) atts.remove();
  if (m.author === myAuthor()) {
    el.insertAdjacentHTML('beforeend', `<button class="icon-btn sm msg-del" type="button" data-delete-msg="${m.id}" aria-label="Apagar mensagem" title="Apagar mensagem">${icon('trash')}</button>`);
  }
  return el;
}

function attachmentEl(a) {
  const url = `/api/attachments/${encodeURIComponent(a.id)}`;
  if (INLINE_IMAGE.test(a.type)) {
    const img = document.createElement('img');
    img.className = 'att-img';
    img.alt = a.name;
    img.loading = 'lazy';
    img.dataset.name = a.name;
    // Com o tamanho conhecido, o espaço já fica reservado e o chat não pula quando a imagem chega.
    if (a.width && a.height) {
      const scale = Math.min(1, 400 / a.width, 320 / a.height);
      img.style.width = `${Math.round(a.width * scale)}px`;
      img.style.aspectRatio = `${a.width} / ${a.height}`;
    }
    img.src = url;
    return img;
  }
  if (/^video\/(mp4|webm)$/.test(a.type)) {
    const video = document.createElement('video');
    video.className = 'att-video';
    video.controls = true;
    video.preload = 'metadata';
    video.src = url;
    return video;
  }
  if (/^audio\/(mpeg|ogg|wav|webm|mp4)$/.test(a.type)) {
    const audio = document.createElement('audio');
    audio.className = 'att-audio';
    audio.controls = true;
    audio.preload = 'metadata';
    audio.src = url;
    return audio;
  }
  const link = document.createElement('a');
  link.className = 'att-file';
  link.href = url;
  link.download = a.name;
  link.innerHTML = `${icon('file')}<span class="att-file-main"><span class="att-file-name"></span><span class="att-file-size"></span></span>${icon('download')}`;
  $('.att-file-name', link).textContent = a.name;
  $('.att-file-size', link).textContent = fmtBytes(a.size);
  return link;
}

// ---------- caixa de mensagens (a mesma para o canal de texto e para o chat da sala de voz) ----------

function makeChatView(root) {
  root.innerHTML = `
    <div class="messages"></div>
    <div class="pending" hidden></div>
    <div class="chat-status" hidden></div>
    <form class="inline-form chat-form">
      <button class="icon-btn attach" type="button" aria-label="Anexar arquivo" title="Anexar arquivo (ou cole uma imagem com Ctrl+V)">${icon('paperclip')}</button>
      <input type="file" multiple hidden>
      <input class="input" maxlength="2000" autocomplete="off" aria-label="Mensagem">
      <button class="btn square" type="submit" aria-label="Enviar">${icon('send')}</button>
    </form>`;
  const view = {
    root,
    channelId: null,
    pending: [],
    sending: false,
    stick: true,
    box: $('.messages', root),
    tray: $('.pending', root),
    status: $('.chat-status', root),
    form: $('form', root),
    input: $('input.input', root),
    picker: $('input[type="file"]', root),
  };
  view.form.addEventListener('submit', (e) => {
    e.preventDefault();
    sendChat(view);
  });
  view.input.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (!files.length) return;
    e.preventDefault();
    addAttachments(view, files);
  });
  $('.attach', root).addEventListener('click', () => view.picker.click());
  view.picker.addEventListener('change', () => {
    addAttachments(view, [...view.picker.files]);
    view.picker.value = '';
  });
  view.tray.addEventListener('click', (e) => {
    const b = e.target.closest('[data-remove-pending]');
    if (!b) return;
    const item = view.pending.find((p) => p.key === b.dataset.removePending);
    if (item?.preview) URL.revokeObjectURL(item.preview);
    view.pending = view.pending.filter((p) => p !== item);
    renderPending(view);
  });
  view.box.addEventListener('scroll', () => {
    const box = view.box;
    view.stick = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    const c = chats.get(view.channelId);
    if (box.scrollTop < 80 && c?.more && !c.loading) loadHistory(view.channelId, c.list[0]?.id);
  });
  // Imagem sem tamanho conhecido terminou de carregar: continua colado no fim.
  view.box.addEventListener('load', () => view.stick && (view.box.scrollTop = view.box.scrollHeight), true);
  view.box.addEventListener('click', (e) => {
    const older = e.target.closest('.load-older');
    const c = chats.get(view.channelId);
    if (older && c?.more) loadHistory(view.channelId, c.list[0]?.id);
    const img = e.target.closest('.att-img');
    if (img) openLightbox(img);
    const del = e.target.closest('[data-delete-msg]');
    if (del && confirm('Apagar esta mensagem? Não dá para desfazer.')) {
      send({ type: 'chat:delete', channelId: view.channelId, id: del.dataset.deleteMsg });
    }
  });
  chatViews.push(view);
  return view;
}

function bindChat(view, id) {
  view.channelId = id;
  view.stick = true;
  const c = chatOf(id);
  if (!c.loaded) loadHistory(id);
  renderChatView(view);
}

function renderChatView(view, { keepScroll = false } = {}) {
  const box = view.box;
  const c = chats.get(view.channelId);
  const ch = state.channels.get(view.channelId);
  const items = [];
  if (!c?.loaded) {
    const note = document.createElement('p');
    note.className = 'chat-start';
    note.textContent = 'Carregando…';
    items.push(note);
  } else if (c.more) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn secondary small load-older';
    b.textContent = 'Carregar mensagens antigas';
    items.push(b);
  } else {
    const note = document.createElement('p');
    note.className = 'chat-start';
    if (ch?.kind === 'voice') note.textContent = `Começo do chat de ${channelLabel(ch)}. As mensagens daqui somem quando todo mundo sai da sala.`;
    else if (ch?.kind === 'dm') note.textContent = `Começo da sua conversa privada com ${dmOther(ch).name}. Só vocês dois veem, e as mensagens somem depois de ${state.config?.dmTtlDays || 7} dias.`;
    else note.textContent = ch ? `Começo de ${channelLabel(ch)}. Mande mensagens, imagens (dá para colar com Ctrl+V) e arquivos: tudo fica guardado aqui.` : '';
    items.push(note);
  }
  let prev = null;
  for (const m of c?.list || []) {
    items.push(messageEl(m, prev));
    prev = m;
  }
  const fromBottom = box.scrollHeight - box.scrollTop;
  box.replaceChildren(...items);
  box.scrollTop = keepScroll ? box.scrollHeight - fromBottom : box.scrollHeight;
}

function appendChat(view, m) {
  const list = chats.get(view.channelId).list;
  const box = view.box;
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  box.append(messageEl(m, list.at(-2)));
  if (nearBottom || m.pid === state.me?.id) box.scrollTop = box.scrollHeight;
}

// O chat que recebe um Ctrl+V ou um arquivo solto quando nenhuma caixa de texto está selecionada.
function activeChatView() {
  if (!$('#text-view').hidden) return textChat;
  if (state.voice && state.tab === 'chat' && !$('#room').classList.contains('side-hidden')) return voiceChat;
  return null;
}

async function addAttachments(view, files) {
  if (!view.channelId) return;
  const max = state.config.chatFileMaxMB;
  for (const file of files) {
    if (view.pending.length >= 10) {
      toast('Dá para mandar até 10 anexos por mensagem.');
      break;
    }
    if (file.size > max * 1e6) {
      toast(`"${file.name}" passa de ${max} MB, o limite do chat. Mande pela aba Arquivos.`, { timeout: 8000 });
      continue;
    }
    const item = { key: randomId(), file, preview: null, width: 0, height: 0 };
    if (INLINE_IMAGE.test(file.type)) {
      item.preview = URL.createObjectURL(file);
      try {
        const bitmap = await createImageBitmap(file);
        item.width = bitmap.width;
        item.height = bitmap.height;
        bitmap.close();
      } catch {
        // sem o tamanho: a imagem aparece do mesmo jeito, só sem o espaço reservado
      }
    }
    view.pending.push(item);
  }
  renderPending(view);
  view.input.focus();
}

function renderPending(view) {
  view.tray.hidden = !view.pending.length;
  view.tray.replaceChildren(
    ...view.pending.map((item) => {
      const el = document.createElement('div');
      el.className = 'pending-item';
      el.title = item.file.name;
      if (item.preview) {
        const img = document.createElement('img');
        img.alt = '';
        img.src = item.preview;
        el.append(img);
      } else {
        el.innerHTML = `${icon('file')}<span></span>`;
        $('span', el).textContent = item.file.name;
      }
      if (!view.sending) el.insertAdjacentHTML('beforeend', `<button type="button" data-remove-pending="${item.key}" aria-label="Tirar anexo">${icon('x')}</button>`);
      return el;
    }),
  );
}

function setChatStatus(view, text) {
  view.status.hidden = !text;
  view.status.textContent = text;
}

async function sendChat(view) {
  const text = view.input.value.trim();
  if (view.sending || !view.channelId || (!text && !view.pending.length)) return;
  if (ws?.readyState !== WebSocket.OPEN) return toast('Sem conexão com o servidor agora. Tente de novo em instantes.');
  const channelId = view.channelId;
  view.sending = true;
  view.form.querySelectorAll('button, input').forEach((el) => (el.disabled = true));
  renderPending(view);
  const ids = [];
  try {
    for (const [i, item] of view.pending.entries()) {
      setChatStatus(view, view.pending.length > 1 ? `Enviando ${i + 1} de ${view.pending.length}…` : 'Enviando…');
      ids.push((await uploadAttachment(item)).id);
    }
    send({ type: 'chat', channelId, text, attachments: ids });
    for (const item of view.pending) if (item.preview) URL.revokeObjectURL(item.preview);
    view.pending = [];
    view.input.value = '';
  } catch (err) {
    reportError(err, 'file', 'o anexo');
  } finally {
    view.sending = false;
    view.form.querySelectorAll('button, input').forEach((el) => (el.disabled = false));
    setChatStatus(view, '');
    renderPending(view);
    view.input.focus();
  }
}

async function uploadAttachment(item) {
  const headers = {
    Authorization: authHeader(),
    'Content-Type': 'application/octet-stream',
    'X-File-Name': encodeURIComponent(item.file.name || 'imagem.png'),
    'X-File-Type': encodeURIComponent(item.file.type || ''),
  };
  if (item.width) Object.assign(headers, { 'X-Width': String(item.width), 'X-Height': String(item.height) });
  let res;
  try {
    res = await fetch('/api/attachments', { method: 'POST', headers, body: item.file });
  } catch {
    throw Object.assign(new Error('Sem conexão com o servidor da sala'), { code: 'network' });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.errorDescription || `Erro ${res.status}`), { code: data.errorCode || `http_${res.status}` });
  return data;
}

function openLightbox(img) {
  const box = $('#lightbox');
  $('img', box).src = img.src;
  $('img', box).alt = img.alt;
  const link = $('.lightbox-link', box);
  link.href = img.src;
  link.download = img.dataset.name || '';
  box.showModal();
}

// ---------- criar, renomear e apagar canais ----------

let channelEditing = null;

function openChannelDialog({ kind, channel }) {
  channelEditing = channel ? { id: channel.id } : { kind };
  const what = (channel?.kind || kind) === 'voice' ? 'de voz' : 'de texto';
  $('#channel-title').textContent = channel ? `Editar canal ${what}` : `Criar canal ${what}`;
  $('#channel-name').value = channel?.name || '';
  $('#channel-name').placeholder = (channel?.kind || kind) === 'voice' ? 'Ex.: Duo, Flex, Resenha' : 'Ex.: comps, prints, memes';
  $('#channel-save').textContent = channel ? 'Salvar' : 'Criar canal';
  $('#channel-delete').hidden = !channel;
  $('#channel-dialog').showModal();
  $('#channel-name').focus();
}

function bindChannels() {
  $('#channel-list').addEventListener('click', (e) => {
    const open = e.target.closest('[data-channel]');
    if (open) return openChannel(open.dataset.channel);
    if (e.target.closest('[data-dm-new]')) {
      dmPicking = !dmPicking;
      return renderChannels();
    }
    const dmUser = e.target.closest('[data-dm-user]');
    if (dmUser) return send({ type: 'dm:open', userId: dmUser.dataset.dmUser });
    const add = e.target.closest('[data-add]');
    if (add) return openChannelDialog({ kind: add.dataset.add });
    const edit = e.target.closest('[data-edit]');
    if (edit) return openChannelDialog({ channel: state.channels.get(edit.dataset.edit) });
    // Clicar em quem está numa sala de voz abre as opções da pessoa em Pessoas.
    const member = e.target.closest('[data-member]');
    if (member && member.dataset.member !== state.me?.id) {
      $('#room').classList.remove('side-hidden', 'channels-open');
      setTab('people');
      state.expanded = member.dataset.member;
      renderPeople();
      $(`#people .person[data-id="${member.dataset.member}"]`)?.scrollIntoView({ block: 'nearest' });
    }
  });
  bindChannelDrag();
  $('#channel-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('#channel-name').value.trim();
    if (!name) return;
    if (channelEditing.id) send({ type: 'channel:update', id: channelEditing.id, name });
    else send({ type: 'channel:create', kind: channelEditing.kind, name, serverId: currentServer()?.id });
    $('#channel-dialog').close();
  });
  $('#channel-cancel').addEventListener('click', () => $('#channel-dialog').close());
  $('#channel-delete').addEventListener('click', () => {
    const ch = state.channels.get(channelEditing.id);
    if (!ch) return $('#channel-dialog').close();
    const extra = ch.kind === 'text' ? ' e todas as mensagens e imagens dele' : ' e o chat dela';
    if (!confirm(`Apagar ${channelLabel(ch)}${extra}? Não dá para desfazer.`)) return;
    send({ type: 'channel:delete', id: ch.id });
    $('#channel-dialog').close();
  });
  $('#server-head').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleServerMenu();
  });
  $('#server-menu').addEventListener('click', (e) => {
    const item = e.target.closest('[data-server]');
    if (item) return selectServer(item.dataset.server);
    const act = e.target.closest('[data-menu]')?.dataset.menu;
    if (!act) return;
    toggleServerMenu(false);
    if (act === 'invite') copyInvite(currentServer());
    else if (act === 'servers') openServersPanel();
    else if (act === 'join') {
      const code = prompt('Cole o link ou o código de convite:');
      if (code) joinByInvite(code);
    }
  });
  $('#no-servers-form').addEventListener('submit', (e) => {
    e.preventDefault();
    joinByInvite($('#no-servers-code').value);
  });
  $('#no-servers-logout').addEventListener('click', logout);
  document.addEventListener('click', (e) => {
    if (!$('#server-menu').hidden && !e.target.closest('#server-menu, #server-head')) toggleServerMenu(false);
  });
  $('#voice-status-leave').addEventListener('click', () => leaveVoice());
  $('#btn-channels').addEventListener('click', () => $('#room').classList.toggle('channels-open'));
  $('#channels-backdrop').addEventListener('click', () => $('#room').classList.remove('channels-open'));
  $('#lightbox').addEventListener('click', (e) => {
    if (!e.target.closest('.lightbox-link')) $('#lightbox').close();
  });
  // Ctrl+V com uma imagem copiada, sem precisar clicar na caixa de mensagem antes.
  document.addEventListener('paste', (e) => {
    if (!state.inRoom || e.target.closest?.('input, textarea, [contenteditable]')) return;
    const view = activeChatView();
    const files = [...(e.clipboardData?.files || [])];
    if (!view || !files.length) return;
    e.preventDefault();
    addAttachments(view, files);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !state.inRoom) return;
    for (const view of chatViews) if (view.channelId && isChatVisible(view.channelId)) markRead(view.channelId);
  });
}

// ---------- painel de admin ----------

let adminUsers = [];

async function adminApi(method, path, body) {
  let res;
  try {
    res = await fetch(`/api/admin${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error('Sem conexão com o servidor.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.errorDescription || `Erro ${res.status}`);
  return data;
}

async function adminAction(task) {
  $('#admin-error').textContent = '';
  try {
    await task();
  } catch (err) {
    $('#admin-error').textContent = err.message;
  }
}

async function openAdmin() {
  if (!state.account?.admin) return;
  $('#admin-dialog').showModal();
  await adminAction(async () => {
    adminUsers = await adminApi('GET', '/users');
  });
  renderAdmin();
}

// ---------- painel de servidores (só o host) ----------

async function serversApi(method, path, body) {
  let res;
  try {
    res = await fetch(`/api/servers${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error('Sem conexão com o servidor.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.errorDescription || `Erro ${res.status}`);
  return data;
}

async function serversAction(task) {
  $('#servers-error').textContent = '';
  try {
    await task();
  } catch (err) {
    $('#servers-error').textContent = err.message;
  }
}

async function openServersPanel() {
  if (!state.account?.host) return;
  $('#servers-dialog').showModal();
  renderServersPanel();
  await serversAction(async () => {
    adminUsers = await adminApi('GET', '/users');
  });
  renderServersPanel();
}

function renderServersPanel() {
  if (!$('#servers-dialog').open) return;
  const nameOf = (id) => adminUsers.find((u) => u.id === id);
  $('#servers-list').replaceChildren(
    ...sortedServers().map((s) => {
      const li = document.createElement('li');
      li.className = 'admin-item';
      li.dataset.server = s.id;
      const banned = s.banned || [];
      li.innerHTML = `
        <div class="admin-row">
          <div class="admin-main"><div class="admin-name"></div><div class="admin-sub"></div></div>
          <button class="btn secondary small" type="button" data-act="members">Membros</button>
          <button class="icon-btn sm" type="button" data-act="rename" aria-label="Renomear" title="Renomear">${icon('settings')}</button>
          <button class="icon-btn sm" type="button" data-act="delete" aria-label="Apagar servidor" title="Apagar servidor">${icon('trash')}</button>
        </div>
        <div class="invite-row">
          <input class="input invite-input" readonly aria-label="Link de convite">
          <button class="btn small" type="button" data-act="copy">${icon('link')}Copiar</button>
          <button class="btn secondary small" type="button" data-act="new-invite" title="O link antigo para de funcionar">Novo link</button>
        </div>`;
      $('.admin-name', li).textContent = s.name;
      const pick = document.createElement('div');
      pick.className = 'icon-pick';
      pick.innerHTML = [
        `<button type="button" data-icon-pick="" class="${s.icon ? '' : 'on'}" title="Iniciais do nome">${escapeText(initials(s.name))}</button>`,
        ...SERVER_ICONS.map(([id, label]) => `<button type="button" data-icon-pick="${id}" class="${s.icon === id ? 'on' : ''}" title="${label}">${icon(id)}</button>`),
      ].join('');
      $('.admin-row', li).after(pick);
      const count = s.members.length;
      $('.admin-sub', li).textContent = `${count} ${count === 1 ? 'membro' : 'membros'}${banned.length ? ` · ${banned.length} ${banned.length === 1 ? 'banido' : 'banidos'}` : ''}`;
      $('.invite-input', li).value = inviteLink(s);
      if (serversExpanded === s.id) {
        const box = document.createElement('div');
        box.className = 'admin-members';
        const others = adminUsers.filter((u) => !u.host && !banned.includes(u.id));
        if (others.length) {
          const head = document.createElement('p');
          head.className = 'hint';
          head.textContent = 'Ligue para colocar a pessoa no servidor; desligue para tirar.';
          box.append(head);
        }
        for (const u of others) {
          const label = document.createElement('label');
          label.className = 'toggle-row';
          label.innerHTML = '<span class="toggle-text"></span><input type="checkbox" class="switch">';
          $('.toggle-text', label).textContent = `${u.name} · ${u.email}`;
          $('input', label).checked = s.members.includes(u.id);
          $('input', label).dataset.user = u.id;
          box.append(label);
        }
        if (!others.length && !banned.length) box.append('Ninguém além de você tem conta ainda.');
        for (const id of banned) {
          const row = document.createElement('div');
          row.className = 'admin-row banned-row';
          row.innerHTML = `<div class="admin-main"><div class="admin-name"></div><div class="admin-sub">Banido</div></div><button class="btn secondary small" type="button" data-act="unban">Desbanir</button>`;
          row.dataset.user = id;
          const u = nameOf(id);
          $('.admin-name', row).textContent = u ? `${u.name} · ${u.email}` : 'Conta';
          box.append(row);
        }
        li.append(box);
      }
      return li;
    }),
  );
}

let serversExpanded = null; // servidor com a lista de membros aberta no painel do host

function bindServersPanel() {
  $('#servers-close').addEventListener('click', () => $('#servers-dialog').close());
  $('#btn-servers').addEventListener('click', () => {
    $('#settings').close();
    openServersPanel();
  });
  $('#server-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('#server-new').value.trim();
    if (!name) return;
    serversAction(async () => {
      const s = await serversApi('POST', '/', { name });
      $('#server-new').value = '';
      serversExpanded = s.id;
      renderServersPanel();
    });
  });
  $('#servers-list').addEventListener('click', (e) => {
    const s = state.servers.get(e.target.closest('[data-server]')?.dataset.server);
    const pick = e.target.closest('[data-icon-pick]');
    if (pick && s) return serversAction(() => serversApi('PUT', `/${s.id}`, { icon: pick.dataset.iconPick || null }));
    const b = e.target.closest('[data-act]');
    if (!b || !s) return;
    const act = b.dataset.act;
    if (act === 'copy') copyInvite(s);
    else if (act === 'new-invite' && confirm(`Criar um link novo para ${s.name}? O link antigo para de funcionar (quem já entrou continua).`)) {
      serversAction(() => serversApi('POST', `/${s.id}/invite`));
    } else if (act === 'rename') {
      const name = prompt('Nome novo do servidor:', s.name)?.trim();
      if (name && name !== s.name) serversAction(() => serversApi('PUT', `/${s.id}`, { name }));
    } else if (act === 'members') {
      serversExpanded = serversExpanded === s.id ? null : s.id;
      renderServersPanel();
    } else if (act === 'unban') {
      serversAction(() => serversApi('DELETE', `/${s.id}/banned/${b.closest('[data-user]').dataset.user}`));
    } else if (act === 'delete' && confirm(`Apagar o servidor ${s.name}, com todos os canais, mensagens e imagens dele? Não dá para desfazer.`)) {
      serversAction(() => serversApi('DELETE', `/${s.id}`));
    }
  });
  $('#servers-list').addEventListener('change', (e) => {
    const box = e.target.closest('input[data-user]');
    const s = state.servers.get(e.target.closest('[data-server]')?.dataset.server);
    if (!box || !s) return;
    const members = new Set(s.members);
    if (box.checked) members.add(box.dataset.user);
    else members.delete(box.dataset.user);
    serversAction(() => serversApi('PUT', `/${s.id}`, { members: [...members] }));
  });
}

function renderAdmin() {
  if (!$('#admin-dialog').open) return;
  $('#admin-users').replaceChildren(
    ...adminUsers.map((u) => {
      const li = document.createElement('li');
      li.className = 'admin-item';
      li.dataset.user = u.id;
      const host = state.account?.host;
      const tag = u.host ? '<span class="admin-tag">host</span>' : u.admin ? '<span class="admin-tag">admin</span>' : '';
      // Só o host dá e tira o cargo; a conta de outro admin, só ele mexe.
      const roleLabel = u.admin ? 'Tirar o cargo de admin' : 'Tornar admin';
      const role = host && !u.host ? `<button class="icon-btn sm role-btn${u.admin ? ' on' : ''}" type="button" data-act="role" aria-label="${roleLabel}" title="${roleLabel}">${icon('shield')}</button>` : '';
      // Trocar a senha de alguém, só o host.
      const pass = host ? '<button class="btn secondary small" type="button" data-act="password">Nova senha</button>' : '';
      const manage =
        !u.host && (!u.admin || host)
          ? `${pass}<button class="icon-btn sm" type="button" data-act="delete-user" aria-label="Apagar conta" title="Apagar conta">${icon('trash')}</button>`
          : '';
      li.innerHTML = `<div class="admin-row"><div class="admin-main"><div class="admin-name"></div><div class="admin-sub"></div></div>${tag}${role}${manage}</div>`;
      $('.admin-name', li).textContent = u.name;
      $('.admin-sub', li).textContent = u.email;
      return li;
    }),
  );
}

function bindAdmin() {
  $('#admin-close').addEventListener('click', () => $('#admin-dialog').close());
  $('#btn-admin').addEventListener('click', () => {
    $('#settings').close();
    openAdmin();
  });
  $('#admin-users').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    const u = adminUsers.find((x) => x.id === e.target.closest('[data-user]')?.dataset.user);
    if (!b || !u) return;
    if (b.dataset.act === 'role') {
      const ask = u.admin
        ? `Tirar o cargo de admin de ${u.name}?`
        : `Tornar ${u.name} admin? A pessoa vai poder mutar, expulsar e banir quem não é admin, apagar contas, tirar sons da mesa e arrastar canais e pessoas.`;
      if (!confirm(ask)) return;
      adminAction(async () => {
        await adminApi('PUT', `/users/${u.id}/admin`, { admin: !u.admin });
        adminUsers = await adminApi('GET', '/users');
        renderAdmin();
      });
    } else if (b.dataset.act === 'password') {
      const password = prompt(`Senha nova para ${u.name} (pelo menos 6 caracteres). Depois passe para a pessoa; ela pode trocar em Configurações.`);
      if (password) {
        adminAction(async () => {
          await adminApi('POST', `/users/${u.id}/password`, { password });
          toast(`Senha de ${u.name} trocada.`);
        });
      }
    } else if (b.dataset.act === 'delete-user' && confirm(`Apagar a conta de ${u.name} (${u.email})? As mensagens dela continuam nos canais.`)) {
      adminAction(async () => {
        await adminApi('DELETE', `/users/${u.id}`);
        adminUsers = await adminApi('GET', '/users');
        renderAdmin();
      });
    }
  });
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

// ---------- vídeos do YouTube ----------

function onMusic(channelId, m) {
  state.musics.set(channelId, m);
  if (channelId === state.voice) syncMusic();
  renderChannels();
}

// Cada sala de voz tem os seus vídeos; o player toca os da sala em que estou (nenhum, fora delas).
function syncMusic() {
  state.music = (state.voice && state.musics.get(state.voice)) || null;
  music?.setState(state.music);
  renderMusic();
}

function renderMusic() {
  const m = state.music;
  const current = m?.current;
  const inVoice = !!state.voice;
  $('#np-title').textContent = current ? current.title : inVoice ? 'Nada tocando' : 'Fora das salas de voz';
  $('#np-by').textContent = current
    ? `colocado por ${current.by}`
    : inVoice
      ? 'Cole um link do YouTube aqui embaixo para começar.'
      : 'Entre numa sala de voz para ver e colocar vídeos. Cada sala tem os seus.';
  $('#yt-empty').hidden = !!current;
  $('#yt-full').hidden = !current;
  $('#yt-pin').hidden = !current || !inVoice || state.videoOnStage;
  $('#yt-slot').classList.toggle('away', state.videoOnStage && inVoice);
  if (!current && isVideoFull()) toggleVideoFull(false);
  if (state.videoOnStage) renderStage();
  $('#music-url').disabled = !inVoice;
  $('#music-form button').disabled = !inVoice;
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
      $('.queue-by', li).textContent = `colocado por ${item.by}`;
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

// ---------- o player flutuante ----------
// O iframe do YouTube recarregaria se mudasse de lugar na página, então ele fica sempre no mesmo
// elemento e, a cada quadro, se posiciona por cima do lugar onde deve aparecer: o quadro dele no
// palco ou a aba Vídeo. Fora dos dois, fica escondido (e tocando). O recorte segue a área que rola.

// Onde o player deve aparecer agora. Arrastando o quadro do vídeo, ele segue o fantasma (a cópia
// que acompanha o cursor). O recorte só existe quando a área rola (a aba Vídeo e a faixa de baixo):
// sem isso, um quadro animando entre a área dos fixados e a faixa sumia no meio do caminho.
function videoSlot() {
  const ghost = $('.drag-ghost.video-tile');
  if (ghost) return { el: ghost, clip: null, stage: true, floating: true };
  if (state.videoOnStage && !$('#stage').hidden) {
    const tile = tiles.get(VIDEO_KEY);
    if (tile?.el.isConnected) {
      const box = tile.el.parentElement;
      const scrolls = box.scrollWidth > box.clientWidth + 1 || box.scrollHeight > box.clientHeight + 1;
      return { el: tile.el, clip: scrolls ? box : null, stage: true };
    }
  }
  const slot = $('#yt-slot');
  const panel = slot.closest('.panel');
  if (panel.classList.contains('inactive') || slot.classList.contains('away')) return null;
  return { el: slot, clip: panel, stage: false };
}

// A caixa do elemento sem a transformação (posição e tamanho do layout), mais a transformação dele.
// O player copia as duas: anima junto (translate e escala na GPU) sem redimensionar o iframe a cada
// quadro da animação, que era o que fazia o vídeo engasgar e piscar durante o arrasto.
function layoutBox(el) {
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  const width = parseFloat(cs.width) || r.width;
  const height = parseFloat(cs.height) || r.height;
  if (!cs.transform || cs.transform === 'none') return { left: r.left, top: r.top, width, height, transform: 'none', origin: cs.transformOrigin, visual: r };
  const m = new DOMMatrixReadOnly(cs.transform);
  const [ox, oy] = cs.transformOrigin.split(' ').map(parseFloat);
  const left = r.left - m.e - ox * (1 - m.a);
  const top = r.top - m.f - oy * (1 - m.d);
  return { left, top, width, height, transform: cs.transform, origin: cs.transformOrigin, visual: r, sx: m.a, sy: m.d };
}

let videoBox = '';

function syncVideoBox() {
  requestAnimationFrame(syncVideoBox);
  const wrap = $('#yt-wrap');
  if (!wrap) return;
  if (isVideoFull()) {
    if (videoBox) {
      videoBox = '';
      wrap.removeAttribute('style');
      wrap.classList.remove('off', 'floating');
    }
    return;
  }
  const slot = state.inRoom ? videoSlot() : null;
  const b = slot && layoutBox(slot.el);
  const r = b?.visual;
  const c = slot?.clip ? slot.clip.getBoundingClientRect() : { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
  const visible = r && r.width > 0 && r.height > 0 && r.right > c.left && r.left < c.right && r.bottom > c.top && r.top < c.bottom;
  if (!visible) {
    if (videoBox !== 'off') {
      videoBox = 'off';
      wrap.classList.add('off');
      wrap.classList.remove('floating');
      wrap.removeAttribute('style');
    }
    return;
  }
  // O recorte é medido na tela e convertido para a escala do próprio player.
  const clip = slot.clip
    ? [(c.top - r.top) / (b.sy || 1), (r.right - c.right) / (b.sx || 1), (r.bottom - c.bottom) / (b.sy || 1), (c.left - r.left) / (b.sx || 1)]
        .map((v) => `${Math.max(0, v)}px`)
        .join(' ')
    : '';
  const box = `${b.left}|${b.top}|${b.width}|${b.height}|${b.transform}|${b.origin}|${clip}|${slot.stage}|${!!slot.floating}`;
  if (box === videoBox) return;
  videoBox = box;
  wrap.classList.remove('off');
  wrap.classList.toggle('on-stage', slot.stage);
  wrap.classList.toggle('floating', !!slot.floating);
  Object.assign(wrap.style, {
    left: `${b.left}px`,
    top: `${b.top}px`,
    width: `${b.width}px`,
    height: `${b.height}px`,
    transform: b.transform === 'none' ? '' : b.transform,
    transformOrigin: b.origin,
    clipPath: clip ? `inset(${clip})` : '',
  });
}

// Leva o vídeo para o palco, junto das telas e das pessoas. Lá ele é um quadro como os outros:
// dá para fixar, arrastar, pôr em tela cheia ou mandar de volta para a aba Vídeo.
function bringVideoToStage() {
  if (!state.voice) return toast('Entre numa sala de voz para levar o vídeo ao palco.');
  state.videoOnStage = true;
  showView(state.voice);
  renderMusic();
}

// Tela cheia do vídeo. No iPhone (sem tela cheia para divs) ocupa a tela por CSS.
function isVideoFull() {
  return document.fullscreenElement === $('#yt-wrap') || $('#yt-wrap').classList.contains('pseudo-full');
}

function toggleVideoFull(on = !isVideoFull()) {
  const wrap = $('#yt-wrap');
  if (on && !state.music?.current) return;
  if (!on) {
    if (document.fullscreenElement === wrap) document.exitFullscreen().catch(() => {});
    wrap.classList.remove('pseudo-full');
  } else if (document.fullscreenEnabled && wrap.requestFullscreen) {
    // Alguns navegadores embutidos nem aceitam nem recusam: depois de 1 s sem tela cheia, vai a de CSS.
    const fallback = () => {
      clearTimeout(timer);
      if (document.fullscreenElement !== wrap) wrap.classList.add('pseudo-full');
      renderVideoFull();
    };
    const timer = setTimeout(fallback, 1000);
    wrap.requestFullscreen().then(() => clearTimeout(timer), fallback);
  } else {
    wrap.classList.add('pseudo-full');
  }
  // O estado final só se sabe depois do fullscreenchange; o botão se ajusta lá também.
  renderVideoFull();
}

function renderVideoFull() {
  if (document.fullscreenElement === $('#yt-wrap')) $('#yt-wrap').classList.remove('pseudo-full');
  const full = isVideoFull();
  const button = $('#yt-full');
  $('#yt-wrap').classList.toggle('full', full);
  button.innerHTML = icon(full ? 'minimize' : 'maximize');
  button.title = full ? 'Sair da tela cheia (Esc)' : 'Tela cheia (ou dois cliques no vídeo)';
  button.setAttribute('aria-label', full ? 'Sair da tela cheia' : 'Tela cheia');
}

// Link com list=: é uma playlist (com ou sem um vídeo dela junto).
function youtubeList(text) {
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www|m|music)\./, '');
  if (!['youtube.com', 'youtu.be', 'youtube-nocookie.com'].includes(host)) return null;
  const list = url.searchParams.get('list');
  if (!list || !/^[\w-]{2,64}$/.test(list)) return null;
  const v = host === 'youtu.be' ? url.pathname.split('/')[1] : url.searchParams.get('v');
  return { list, start: /^[\w-]{11}$/.test(v || '') ? v : null };
}

let addingPlaylist = false;

async function addPlaylist({ list, start }) {
  if (addingPlaylist) return toast('Ainda estou abrindo a outra playlist.');
  addingPlaylist = true;
  const input = $('#music-url');
  const placeholder = input.placeholder;
  input.placeholder = 'Abrindo a playlist…';
  try {
    const ids = await playlistVideos(list).catch(() => []);
    send({ type: 'music:addList', list, start, ids });
  } finally {
    addingPlaylist = false;
    input.placeholder = placeholder;
  }
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

// ---------- pedidos ao servidor ----------

function authHeader() {
  return `Bearer ${state.me.id}:${state.me.token}`;
}

// Anexos e sons são links comuns, então a autorização vai num cookie.
function refreshAuthCookie() {
  return fetch('/api/auth-cookie', { method: 'POST', headers: { Authorization: authHeader() } }).catch(() => {});
}

async function filesApi(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: authHeader() },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw Object.assign(new Error('Sem conexão com o servidor da sala'), { code: 'network' });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.errorDescription || `Erro ${res.status}`), { code: data.errorCode || `http_${res.status}` });
  return data;
}

function fmtBytes(bytes) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

// Arrastar arquivos para qualquer lugar da sala: viram anexo do chat que está embaixo
// (ou do chat aberto na tela, se soltar fora dele).
function bindDrop() {
  let dragDepth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  const chatUnder = (e) => chatViews.find((view) => view.channelId && view.root.contains(e.target)) || activeChatView();
  document.addEventListener('dragenter', (e) => {
    if (!state.inRoom || !hasFiles(e)) return;
    dragDepth++;
    $('#drop-overlay').hidden = false;
  });
  document.addEventListener('dragleave', () => {
    if (dragDepth && --dragDepth === 0) $('#drop-overlay').hidden = true;
  });
  document.addEventListener('dragover', (e) => {
    if (!state.inRoom || !hasFiles(e)) return;
    e.preventDefault();
    $('#drop-overlay > div').textContent = chatUnder(e)?.channelId ? 'Solte para anexar na mensagem' : 'Abra um chat para anexar arquivos';
  });
  document.addEventListener('drop', (e) => {
    if (!state.inRoom || !hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    $('#drop-overlay').hidden = true;
    const view = chatUnder(e);
    if (view?.channelId) addAttachments(view, [...e.dataTransfer.files]);
    else toast('Abra um chat (de texto ou da sala de voz) para anexar arquivos.');
  });
}

// ---------- mesa de sons ----------

const soundBuffers = new Map(); // url -> Promise<AudioBuffer>
const soundsPlaying = new Set();
let soundVolume = store.get('soundVolume', 70);
let lastSoundAt = 0;
let flashTimer = null;

function loadSound(url) {
  if (!soundBuffers.has(url)) {
    const loading = fetch(url)
      .then((res) => {
        if (!res.ok) throw Object.assign(new Error(`O som não carregou (erro ${res.status})`), { code: `http_${res.status}` });
        return res.arrayBuffer();
      })
      .then((data) => audioCtx.decodeAudioData(data));
    loading.catch(() => soundBuffers.delete(url));
    soundBuffers.set(url, loading);
  }
  return soundBuffers.get(url);
}

// Som comprido toca direto do arquivo, aos poucos: decodificar 3 minutos de uma vez pesa na memória.
const isLongSound = (s) => s.duration > 20;

async function playSound(sound, by) {
  unlockAudio();
  if (!audioCtx) return;
  flashSound(sound, by);
  if (state.deafened || soundVolume === 0) return;
  try {
    if (isLongSound(sound)) return playLongSound(sound);
    const source = audioCtx.createBufferSource();
    source.buffer = await loadSound(sound.url);
    const gain = audioCtx.createGain();
    gain.gain.value = (soundVolume / 100) ** 2;
    source.connect(gain).connect(audioCtx.destination);
    source.onended = trackSound(() => source.stop());
    source.start();
  } catch (err) {
    reportError(err, 'sound', `o som ${sound.name}`);
  }
}

function playLongSound(sound) {
  const audio = new Audio(sound.url);
  audio.volume = (soundVolume / 100) ** 2;
  if (settings.outId && audio.setSinkId) audio.setSinkId(settings.outId).catch(() => {});
  const stop = trackSound(() => {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  });
  audio.onended = stop;
  audio.onerror = () => {
    stop();
    reportError(Object.assign(new Error('O som não carregou'), { code: 'sound_load' }), 'sound', `o som ${sound.name}`);
  };
  audio.play().catch(stop);
}

// Guarda o que está tocando para dar para parar. No máximo 4 sons juntos: o mais antigo para.
// Devolve a função que para este som (pode ser chamada mais de uma vez).
function trackSound(stopNow) {
  if (soundsPlaying.size >= 4) soundsPlaying.values().next().value();
  const stop = () => {
    if (!soundsPlaying.delete(stop)) return;
    stopNow();
    renderSoundStop();
  };
  soundsPlaying.add(stop);
  renderSoundStop();
  return stop;
}

function stopSounds() {
  for (const stop of [...soundsPlaying]) stop();
}

function renderSoundStop() {
  $('#sound-stop').hidden = !soundsPlaying.size;
}

// Para os sons para todo mundo da sala de voz.
function clickStopSounds() {
  stopSounds();
  send({ type: 'sound:stop' });
}

function clickSound(id) {
  const sound = state.sounds.find((s) => s.id === id);
  const now = Date.now();
  if (!sound || !state.voice || now - lastSoundAt < 400) return;
  lastSoundAt = now;
  playSound(sound, null);
  send({ type: 'sound:play', id });
}

function flashSound(sound, by) {
  const flash = $('#sound-flash');
  flash.textContent = `${by || 'Você'} tocou ${sound.emoji} ${sound.name}`;
  flash.hidden = false;
  flash.classList.remove('show');
  void flash.offsetWidth;
  flash.classList.add('show');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => (flash.hidden = true), 2200);
}

function renderSoundpad() {
  if (!state.inRoom) return;
  const myName = state.participants.get(state.me.id)?.name;
  const buttons = state.sounds.map((s) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sound-btn';
    b.dataset.sound = s.id;
    const mine = !s.builtin && (s.ownerId === state.me.id || s.ownerName === myName);
    b.classList.toggle('mine', mine);
    b.classList.toggle('removable', !s.builtin && !!state.account?.admin);
    const length = s.duration > 15 ? ` · ${fmtDuration(s.duration)}` : '';
    b.title = s.builtin ? s.name : `${s.name} (de ${s.ownerName}${length})`;
    b.innerHTML = '<span class="sound-emoji"></span><span class="sound-name"></span>';
    $('.sound-emoji', b).textContent = s.emoji;
    $('.sound-name', b).textContent = s.name;
    return b;
  });
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'sound-btn add';
  add.id = 'sound-add';
  add.innerHTML = `${icon('plus')}<span class="sound-name">Adicionar</span>`;
  $('#soundpad-grid').replaceChildren(...buttons, add);
}

function toggleSoundpad(open = $('#soundpad').hidden) {
  $('#soundpad').hidden = !open;
  $('#btn-sounds').classList.toggle('on', open);
  $('#btn-sounds').setAttribute('aria-expanded', String(open));
  if (!open) return;
  renderSoundpad();
  unlockAudio();
  // Carrega os curtos de antemão para o clique tocar na hora (os longos vão chegando enquanto tocam).
  if (audioCtx) for (const s of state.sounds) if (!isLongSound(s)) loadSound(s.url).catch(() => {});
}

function onSoundRightClick(id) {
  const sound = state.sounds.find((s) => s.id === id);
  if (!sound || sound.builtin) return;
  toast(`Tirar o som ${sound.emoji} ${sound.name} da mesa?`, {
    action: 'Tirar',
    onAction: () => filesApi('DELETE', `/api/sounds/${id}`).catch((err) => reportError(err, 'sound', 'tirar o som')),
  });
}

function openSoundDialog() {
  $('#sound-form').reset();
  $('#sound-error').textContent = '';
  $('#sound-save').disabled = false;
  $('#sound-dialog').showModal();
}

// Confere se o arquivo é um áudio que o navegador entende e se tem até 3 minutos.
async function checkSoundFile(file) {
  if (!file) throw new Error('Escolha um arquivo de áudio.');
  if (file.size > 100 * 1024 * 1024) throw new Error('O arquivo é grande demais. Use um MP3 de até 3 minutos.');
  unlockAudio();
  let buffer;
  try {
    buffer = await audioCtx.decodeAudioData(await file.arrayBuffer());
  } catch {
    throw new Error('Esse arquivo não parece ser um áudio que o navegador entende. Tente MP3 ou WAV.');
  }
  if (buffer.duration > SOUND_MAX_SECONDS + 0.5) throw new Error(`O som tem ${fmtDuration(buffer.duration)}; o máximo é 3 minutos.`);
  return buffer;
}

function fmtDuration(seconds) {
  const s = Math.round(seconds);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} min`;
}

function bindSoundpad() {
  $('#btn-sounds').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleSoundpad();
  });
  $('#soundpad-close').addEventListener('click', () => toggleSoundpad(false));
  $('#sound-stop').addEventListener('click', clickStopSounds);
  $('#sound-volume').value = soundVolume;
  $('#sound-volume').addEventListener('input', (e) => {
    soundVolume = Number(e.target.value);
    store.set('soundVolume', soundVolume);
  });
  $('#soundpad-grid').addEventListener('click', (e) => {
    const b = e.target.closest('.sound-btn');
    if (!b) return;
    if (b.id === 'sound-add') return openSoundDialog();
    clickSound(b.dataset.sound);
    b.classList.remove('pulse');
    void b.offsetWidth;
    b.classList.add('pulse');
  });
  $('#soundpad-grid').addEventListener('contextmenu', (e) => {
    const b = e.target.closest('.sound-btn.removable');
    if (!b) return;
    e.preventDefault();
    onSoundRightClick(b.dataset.sound);
  });
  document.addEventListener('click', (e) => {
    if ($('#soundpad').hidden || e.target.closest('#soundpad, #btn-sounds, dialog, .toast')) return;
    toggleSoundpad(false);
  });

  $('#sound-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file && !$('#sound-name').value) $('#sound-name').value = file.name.replace(/\.[^.]+$/, '').slice(0, 24);
  });
  $('#sound-cancel').addEventListener('click', () => $('#sound-dialog').close());
  $('#sound-preview').addEventListener('click', async () => {
    $('#sound-error').textContent = '';
    try {
      const buffer = await checkSoundFile($('#sound-file').files[0]);
      const source = audioCtx.createBufferSource();
      source.buffer = buffer;
      source.connect(audioCtx.destination);
      source.start();
    } catch (err) {
      $('#sound-error').textContent = err.message;
    }
  });
  $('#sound-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const file = $('#sound-file').files[0];
    const name = $('#sound-name').value.trim();
    $('#sound-error').textContent = '';
    if (!name) return ($('#sound-error').textContent = 'Dê um nome para o botão.');
    $('#sound-save').disabled = true;
    try {
      const buffer = await checkSoundFile(file);
      const ext = file.name.split('.').pop().toLowerCase();
      // Arquivo grande (WAV longo, por exemplo) vira um WAV menor antes de subir.
      const body = file.size > SOUND_MAX_BYTES ? await compactWav(buffer) : file;
      const res = await fetch('/api/sounds', {
        method: 'POST',
        headers: {
          Authorization: authHeader(),
          'Content-Type': body.type || `audio/${ext === 'mp3' ? 'mpeg' : ext}`,
          'X-Sound-Name': encodeURIComponent(name),
          'X-Sound-Emoji': encodeURIComponent($('#sound-emoji').value.trim()),
          'X-Sound-Duration': buffer.duration.toFixed(1),
        },
        body,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.errorDescription || `Erro ${res.status} ao enviar o som.`);
      $('#sound-dialog').close();
    } catch (err) {
      $('#sound-error').textContent = err.message;
    } finally {
      $('#sound-save').disabled = false;
    }
  });
}

// ---------- configurações ----------

// ---------- foto de perfil ----------
// O app recorta a imagem no meio, deixa quadrada com 256 px e manda pequena (WebP, ou JPEG no Safari antigo).

function renderSettingsAvatar() {
  const me = state.participants.get(state.me?.id);
  paintAvatar($('#set-avatar'), { name: me?.name || state.account?.name || '?', color: me?.color, avatar: state.account?.avatar });
  $('#set-avatar-remove').hidden = !state.account?.avatar;
}

async function squareImage(file, size = 256) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    canvas.getContext('2d').drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size);
    const blob = (await new Promise((r) => canvas.toBlob(r, 'image/webp', 0.85))) || (await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.88)));
    // Navegador que "faz" WebP devolvendo PNG: manda JPEG, que é menor.
    if (blob && blob.type === 'image/png') return await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.88));
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function uploadAvatar(file) {
  if (!file) return;
  const hint = $('#set-avatar-hint');
  hint.textContent = 'Enviando…';
  try {
    const blob = await squareImage(file).catch(() => null);
    if (!blob) throw new Error('Essa imagem não deu para abrir. Tente uma PNG, JPG ou WebP.');
    const res = await fetch('/api/auth/avatar', { method: 'POST', headers: { 'Content-Type': blob.type }, body: blob });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.errorDescription || 'Não deu para trocar a foto agora.');
    state.account = accountOf(data);
    hint.textContent = 'Foto trocada.';
  } catch (err) {
    hint.textContent = err.message;
  }
  renderSettingsAvatar();
}

async function removeAvatar() {
  const res = await fetch('/api/auth/avatar', { method: 'DELETE' }).catch(() => null);
  const data = await res?.json().catch(() => null);
  if (res?.ok && data) state.account = accountOf(data);
  $('#set-avatar-hint').textContent = res?.ok ? 'Foto tirada: voltam as iniciais.' : 'Não deu para tirar a foto agora.';
  renderSettingsAvatar();
}

async function openSettings() {
  $('#set-name').value = state.participants.get(state.me.id)?.name || '';
  $('#set-avatar-hint').textContent = 'Sua foto aparece para todo mundo no lugar das iniciais.';
  renderSettingsAvatar();
  const role = state.account?.host ? ' (host)' : state.account?.admin ? ' (admin)' : '';
  $('#set-email').textContent = `Conta: ${state.account?.email || ''}${role}`;
  $('#pw-change').hidden = false;
  $('#pw-change').open = false;
  $('#pw-error').textContent = '';
  $('#btn-admin').hidden = !state.account?.admin;
  $('#btn-servers').hidden = !state.account?.host;
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
  $('#set-avatar-file').addEventListener('change', (e) => {
    uploadAvatar(e.target.files[0]);
    e.target.value = '';
  });
  $('#set-avatar-remove').addEventListener('click', removeAvatar);
  $('#set-name').addEventListener('change', (e) => {
    const name = e.target.value.trim().slice(0, 32);
    if (!name) return;
    if (state.account) state.account.name = name;
    send({ type: 'update', name });
  });
  $('#pw-save').addEventListener('click', async () => {
    const error = $('#pw-error');
    error.textContent = '';
    try {
      const res = await fetch('/api/auth/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current: $('#pw-current').value, password: $('#pw-new').value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.errorDescription || `Erro ${res.status}`);
    } catch (err) {
      error.textContent = err instanceof TypeError ? 'Sem conexão com o servidor.' : err.message;
      return;
    }
    $('#pw-current').value = '';
    $('#pw-new').value = '';
    $('#pw-change').open = false;
    toast('Senha trocada. Nos outros aparelhos, entre de novo com a senha nova.');
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
      reportError(err, 'mic');
    }
  });
  $('#set-out').addEventListener('change', (e) => {
    settings.outId = e.target.value;
    store.set('outId', settings.outId);
    for (const el of $$('#audio-sink audio')) el.setSinkId?.(settings.outId).catch(() => {});
    audioCtx?.setSinkId?.(settings.outId).catch(() => {});
  });
  $('#set-cam').addEventListener('change', async (e) => {
    settings.camId = e.target.value;
    store.set('camId', settings.camId);
    if (!local.camera) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: cameraConstraints() });
      await replaceLocalTrack(local.camera, stream.getVideoTracks()[0]);
    } catch (err) {
      reportError(err, 'cam');
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
  $('#btn-leave').addEventListener('click', () => leaveVoice());
  $('#btn-exit').addEventListener('click', logout);
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
  bindChannels();
  bindAdmin();
  bindServersPanel();

  $('#music-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#music-url');
    const url = input.value.trim();
    if (!url) return;
    input.value = '';
    const list = youtubeList(url);
    if (list) addPlaylist(list);
    else send({ type: 'music:add', url });
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
  $('#connect-close').addEventListener('click', () => {
    voiceConn.dismissed = true;
    $('#connect-panel').hidden = true;
  });
  $('#connect-retry').addEventListener('click', retryConnect);
  $('#yt-full').addEventListener('click', () => toggleVideoFull());
  $('#yt-pin').addEventListener('click', bringVideoToStage);
  $('#yt-back').addEventListener('click', () => tileAction(VIDEO_KEY, 'close'));
  // A roda do mouse em cima do vídeo rola a aba (o player não está dentro dela na página).
  $('#yt-wrap').addEventListener('wheel', (e) => {
    if (!$('#yt-wrap').classList.contains('on-stage')) $('#yt-slot').closest('.panel').scrollBy(0, e.deltaY);
  }, { passive: true });
  $('#yt-wrap').addEventListener('dblclick', () => toggleVideoFull());
  document.addEventListener('fullscreenchange', renderVideoFull);
  $('#progress').addEventListener('click', seekMusic);
  $('#queue').addEventListener('click', (e) => {
    const b = e.target.closest('[data-remove]');
    if (b) send({ type: 'music:remove', itemId: b.dataset.remove });
  });
  bindSettings();
  bindDrop();
  bindRail();
  bindPersonMenu();
  bindSoundpad();

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('#yt-wrap').classList.contains('pseudo-full')) return toggleVideoFull(false);
    if (e.key === 'Escape' && !$('#soundpad').hidden) return toggleSoundpad(false);
    if (e.key === 'Escape' && state.pinned.length && !document.fullscreenElement) {
      state.pinned = [];
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

// Por último, depois que todas as variáveis do módulo já existem.
init();
