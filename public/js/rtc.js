// Conexão com o SFU do Cloudflare Realtime. Cada SfuConnection é um
// RTCPeerConnection com a sua sessão no Realtime. O segredo do app fica no
// servidor: daqui só falamos com /api/rtc, que repassa as chamadas.

const GATHER_TIMEOUT_MS = 1000;
const CONNECT_TIMEOUT_MS = 15000;
const TRACK_TIMEOUT_MS = 10000;

export class RtcApi {
  constructor(getAuth) {
    this.getAuth = getAuth;
  }

  async call(method, path, body) {
    const res = await fetch(`/api/rtc${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.getAuth()}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.errorCode) {
      const err = new Error(data.errorDescription || `Erro ${res.status} no servidor de mídia`);
      err.code = data.errorCode || res.status;
      throw err;
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
        reject(new Error('Falha na conexão de mídia'));
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Demorou demais para conectar ao servidor de mídia'));
    }, CONNECT_TIMEOUT_MS);
    pc.addEventListener('connectionstatechange', check);
  });
}

// Dispara o evento "failed" quando a conexão cai de vez; quem usa decide recriar.
export class SfuConnection extends EventTarget {
  constructor(api, iceServers) {
    super();
    this.api = api;
    this.iceServers = iceServers;
    this.pc = null;
    this.sessionId = null;
    this.closed = false;
    this.queue = Promise.resolve();
    this.trackWaiters = new Map();
  }

  // O Realtime exige uma negociação por vez em cada sessão.
  enqueue(fn) {
    const run = this.queue.then(() => {
      if (this.closed) throw new Error('Conexão de mídia encerrada');
      return fn();
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
      if (pc.connectionState === 'failed') this.fail();
      else if (pc.connectionState === 'disconnected') {
        disconnectTimer = setTimeout(() => pc.connectionState === 'disconnected' && this.fail(), 8000);
      }
    });
    this.pc = pc;
    const { sessionId } = await this.api.newSession();
    this.sessionId = sessionId;
  }

  fail() {
    if (this.closed) return;
    this.close();
    this.dispatchEvent(new Event('failed'));
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
        await pc.setRemoteDescription(res.sessionDescription);
      } catch (err) {
        if (pc.signalingState === 'have-local-offer') await pc.setLocalDescription({ type: 'rollback' }).catch(() => {});
        for (const t of transceivers) t.stop();
        throw err;
      }
      const failed = (res.tracks || []).find((t) => t.errorCode);
      if (failed) {
        await this.closeNow(transceivers.map((t) => t.mid)).catch(() => {});
        throw new Error(failed.errorDescription || failed.errorCode);
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
        await pc.setRemoteDescription(res.sessionDescription);
        await pc.setLocalDescription(await pc.createAnswer());
        await waitIceGathering(pc);
        await this.api.renegotiate(this.sessionId, { sessionDescription: { type: 'answer', sdp: pc.localDescription.sdp } });
      }
      const got = await Promise.all(arrivals);
      const failed = results.find((t) => t.errorCode);
      if (failed) {
        if (got.length) await this.closeNow(got.map((g) => g.mid)).catch(() => {});
        const err = new Error(failed.errorDescription || failed.errorCode);
        err.code = failed.errorCode;
        throw err;
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
        reject(new Error('A mídia não chegou'));
      }, TRACK_TIMEOUT_MS);
      this.trackWaiters.set(mid, (track) => {
        clearTimeout(timer);
        resolve(track);
      });
    });
  }

  async closeNow(mids) {
    const pc = this.pc;
    if (!pc || !mids.length || pc.signalingState === 'closed') return;
    for (const t of pc.getTransceivers()) {
      if (mids.includes(t.mid)) t.stop();
    }
    const tracks = mids.map((mid) => ({ mid }));
    try {
      await pc.setLocalDescription(await pc.createOffer());
      await waitIceGathering(pc);
      const res = await this.api.closeTracks(this.sessionId, {
        tracks,
        sessionDescription: { type: 'offer', sdp: pc.localDescription.sdp },
        force: false,
      });
      await pc.setRemoteDescription(res.sessionDescription);
    } catch {
      if (pc.signalingState === 'have-local-offer') await pc.setLocalDescription({ type: 'rollback' }).catch(() => {});
      await this.api.closeTracks(this.sessionId, { tracks, force: true }).catch(() => {});
    }
  }
}
