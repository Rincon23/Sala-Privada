// Conexão com o SFU do Cloudflare Realtime. Cada SfuConnection é um
// RTCPeerConnection com a sua sessão no Realtime. O segredo do app fica no
// servidor: daqui só falamos com /api/rtc, que repassa as chamadas.
//
// Cada conexão tem um papel fixo: "send" (só nós oferecemos) ou "receive"
// (só o Cloudflare oferece). Misturar os dois na mesma conexão foi o que fez
// sessões se perderem no meio da negociação.

const GATHER_TIMEOUT_MS = 1000;
const CONNECT_TIMEOUT_MS = 15000;
const TRACK_TIMEOUT_MS = 10000;
// Erros depois dos quais a sessão não serve mais: o Cloudflare manda criar outra.
const SESSION_BREAKING = new Set(['session_error', 'invalid_session_description']);

function codedError(message, code, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

export class RtcApi {
  constructor(getAuth) {
    this.getAuth = getAuth;
  }

  async call(method, path, body) {
    let res;
    try {
      res = await fetch(`/api/rtc${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.getAuth()}` },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw codedError('Sem conexão com o servidor da sala', 'network');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.errorCode) {
      throw codedError(data.errorDescription || `Erro ${res.status} no servidor de mídia`, data.errorCode || `http_${res.status}`, {
        status: res.status,
      });
    }
    return data;
  }

  newSession() {
    return this.call('POST', '/sessions');
  }

  addTracks(sessionId, body) {
    return this.call('POST', `/sessions/${sessionId}/tracks`, body);
  }

  renegotiate(sessionId, body) {
    return this.call('PUT', `/sessions/${sessionId}/renegotiate`, body);
  }

  closeTracks(sessionId, body) {
    return this.call('PUT', `/sessions/${sessionId}/close`, body);
  }
}

function waitIceGathering(pc) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', check);
      resolve();
    };
    const check = () => pc.iceGatheringState === 'complete' && done();
    const timer = setTimeout(done, GATHER_TIMEOUT_MS);
    pc.addEventListener('icegatheringstatechange', check);
  });
}

function waitConnected(pc) {
  if (pc.connectionState === 'connected') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      pc.removeEventListener('connectionstatechange', check);
    };
    const check = () => {
      if (pc.connectionState === 'connected') {
        cleanup();
        resolve();
      } else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        cleanup();
        reject(codedError('Falha na conexão de mídia', 'connect_failed'));
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(codedError('Demorou demais para conectar ao servidor de mídia', 'connect_timeout'));
    }, CONNECT_TIMEOUT_MS);
    pc.addEventListener('connectionstatechange', check);
  });
}

// Dispara "failed" (com o erro em event.detail) quando a conexão não serve
// mais; quem usa cria outra e refaz o que estava no ar.
export class SfuConnection extends EventTarget {
  constructor(api, iceServers, role) {
    super();
    this.api = api;
    this.iceServers = iceServers;
    this.role = role;
    this.pc = null;
    this.sessionId = null;
    this.closed = false;
    this.queue = Promise.resolve();
    this.trackWaiters = new Map();
  }

  // O Realtime exige uma negociação por vez em cada sessão.
  enqueue(fn) {
    const run = this.queue.then(async () => {
      if (this.closed) throw codedError('Conexão de mídia encerrada', 'closed');
      try {
        return await fn();
      } catch (err) {
        if (SESSION_BREAKING.has(err.code) || err.broken) this.fail(err);
        throw err;
      }
    });
    this.queue = run.catch(() => {});
    return run;
  }

  async ensure() {
    if (this.pc) return;
    const pc = new RTCPeerConnection({ iceServers: this.iceServers, bundlePolicy: 'max-bundle' });
    pc.addEventListener('track', (event) => {
      const waiter = this.trackWaiters.get(event.transceiver.mid);
      if (!waiter) return;
      this.trackWaiters.delete(event.transceiver.mid);
      waiter(event.track);
    });
    let disconnectTimer = null;
    pc.addEventListener('connectionstatechange', () => {
      clearTimeout(disconnectTimer);
      if (pc.connectionState === 'failed') this.fail(codedError('A conexão de mídia caiu', 'connect_failed'));
      else if (pc.connectionState === 'disconnected') {
        disconnectTimer = setTimeout(() => {
          if (pc.connectionState === 'disconnected') this.fail(codedError('A conexão de mídia caiu', 'connect_failed'));
        }, 8000);
      }
    });
    this.pc = pc;
    const { sessionId } = await this.api.newSession();
    this.sessionId = sessionId;
  }

  fail(err) {
    if (this.closed) return;
    this.close();
    this.dispatchEvent(new CustomEvent('failed', { detail: err }));
  }

  close() {
    this.closed = true;
    this.trackWaiters.clear();
    this.pc?.close();
  }

  // items: [{ track, trackName, encodings? }] -> [{ mid, sender }]
  push(items) {
    return this.enqueue(async () => {
      await this.ensure();
      const pc = this.pc;
      const transceivers = items.map((item) =>
        pc.addTransceiver(item.track, item.encodings ? { direction: 'sendonly', sendEncodings: item.encodings } : { direction: 'sendonly' }),
      );
      let res;
      try {
        await pc.setLocalDescription(await pc.createOffer());
        await waitIceGathering(pc);
        res = await this.api.addTracks(this.sessionId, {
          sessionDescription: { type: 'offer', sdp: pc.localDescription.sdp },
          tracks: transceivers.map((t, i) => ({ location: 'local', mid: t.mid, trackName: items[i].trackName })),
        });
      } catch (err) {
        if (pc.signalingState === 'have-local-offer') await pc.setLocalDescription({ type: 'rollback' }).catch(() => {});
        for (const t of transceivers) t.stop();
        // Sem saber se o Cloudflare recebeu a oferta, a sessão pode ter ficado diferente da nossa: recria.
        if (err.code === 'network' || err.code === 'upstream') err.broken = true;
        throw err;
      }
      try {
        await pc.setRemoteDescription(res.sessionDescription);
      } catch (err) {
        // O Cloudflare já aceitou a oferta; se o navegador não aceita a resposta, a sessão ficou torta.
        throw Object.assign(err, { code: 'invalid_session_description', broken: true });
      }
      const failed = (res.tracks || []).find((t) => t.errorCode);
      if (failed) {
        await this.closeNow(transceivers.map((t) => t.mid)).catch(() => {});
        throw codedError(failed.errorDescription || failed.errorCode, failed.errorCode);
      }
      await waitConnected(pc);
      return transceivers.map((t) => ({ mid: t.mid, sender: t.sender }));
    });
  }

  // items: [{ sessionId, trackName }] -> [{ mid, trackName, track }]
  pull(items) {
    return this.enqueue(async () => {
      await this.ensure();
      const pc = this.pc;
      const res = await this.api.addTracks(this.sessionId, {
        tracks: items.map((item) => ({ location: 'remote', sessionId: item.sessionId, trackName: item.trackName })),
      });
      const results = res.tracks || [];
      // Os ouvintes precisam existir antes do setRemoteDescription, que é quando o evento "track" chega.
      const arrivals = results
        .filter((t) => !t.errorCode)
        .map((t) => this.waitTrack(t.mid).then((track) => ({ mid: t.mid, trackName: t.trackName, track })));
      for (const a of arrivals) a.catch(() => {});
      if (res.requiresImmediateRenegotiation) {
        try {
          await pc.setRemoteDescription(res.sessionDescription);
          await pc.setLocalDescription(await pc.createAnswer());
          await waitIceGathering(pc);
        } catch (err) {
          // Sem a nossa resposta o Cloudflare fica esperando e a sessão trava: melhor recriar.
          throw Object.assign(err, { code: 'invalid_session_description', broken: true });
        }
        try {
          await this.api.renegotiate(this.sessionId, { sessionDescription: { type: 'answer', sdp: pc.localDescription.sdp } });
        } catch (err) {
          // Se a resposta não chegou ao Cloudflare, ele recusa tudo depois ("esperando uma resposta").
          throw Object.assign(err, { broken: true });
        }
      }
      const got = await Promise.all(arrivals);
      const failed = results.find((t) => t.errorCode);
      if (failed) {
        if (got.length) await this.closeNow(got.map((g) => g.mid)).catch(() => {});
        throw codedError(failed.errorDescription || failed.errorCode, failed.errorCode);
      }
      return got;
    });
  }

  closeTracks(mids) {
    return this.enqueue(() => this.closeNow(mids));
  }

  waitTrack(mid) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.trackWaiters.delete(mid);
        reject(codedError('A mídia não chegou', 'track_timeout'));
      }, TRACK_TIMEOUT_MS);
      this.trackWaiters.set(mid, (track) => {
        clearTimeout(timer);
        resolve(track);
      });
    });
  }

  async closeNow(mids) {
    const pc = this.pc;
    if (!pc || !mids.length || this.closed) return;
    const tracks = mids.map((mid) => ({ mid }));
    if (this.role === 'receive') {
      // Quem recebe só pede para parar o encaminhamento; o Cloudflare continua
      // sendo o único que oferece nesta conexão.
      await this.api.closeTracks(this.sessionId, { tracks, force: true }).catch(() => {});
      return;
    }
    for (const t of pc.getTransceivers()) {
      if (mids.includes(t.mid)) t.stop();
    }
    try {
      await pc.setLocalDescription(await pc.createOffer());
      await waitIceGathering(pc);
      const res = await this.api.closeTracks(this.sessionId, {
        tracks,
        sessionDescription: { type: 'offer', sdp: pc.localDescription.sdp },
        force: false,
      });
      await pc.setRemoteDescription(res.sessionDescription);
    } catch (err) {
      if (pc.signalingState === 'have-local-offer') await pc.setLocalDescription({ type: 'rollback' }).catch(() => {});
      await this.api.closeTracks(this.sessionId, { tracks, force: true }).catch(() => {});
      if (SESSION_BREAKING.has(err.code)) throw err;
    }
  }
}
