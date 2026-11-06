// Player do YouTube que segue o estado dos vídeos da sala, vindo do servidor.
// Todo mundo toca o mesmo vídeo no mesmo segundo; o volume é de cada um.

let apiReady = null;

function loadYouTubeApi() {
  apiReady ??= new Promise((resolve, reject) => {
    if (window.YT?.Player) return resolve(window.YT);
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      resolve(window.YT);
    };
    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.onerror = () => reject(new Error('Não foi possível carregar o YouTube'));
    document.head.append(script);
  });
  return apiReady;
}

function readVolume() {
  try {
    const saved = Number(localStorage.getItem('sala:musicVolume'));
    return Number.isFinite(saved) && localStorage.getItem('sala:musicVolume') !== null ? saved : 60;
  } catch {
    return 60;
  }
}

export class MusicPlayer {
  constructor(mount, { send, now, onTick }) {
    this.mount = mount;
    this.send = send;
    this.now = now;
    this.onTick = onTick;
    this.player = null;
    this.YT = null;
    this.state = null;
    this.loadedId = null;
    this.reportedDuration = null;
    this.lastEndedSent = 0;
    this.volume = readVolume();
    this.silenced = false;
  }

  async init() {
    const YT = await loadYouTubeApi();
    this.YT = YT;
    await new Promise((resolve) => {
      this.player = new YT.Player(this.mount, {
        width: '100%',
        height: '100%',
        playerVars: { autoplay: 0, controls: 0, disablekb: 1, fs: 0, iv_load_policy: 3, playsinline: 1, rel: 0, origin: location.origin },
        events: {
          onReady: resolve,
          onStateChange: (e) => this.onStateChange(e),
          onError: (e) => this.send({ type: 'music:error', itemId: this.loadedId, code: e.data }),
        },
      });
    });
    this.applyVolume();
    this.apply();
    setInterval(() => {
      this.apply();
      this.onTick?.();
    }, 1000);
  }

  setState(state) {
    this.state = state;
    this.apply();
  }

  setVolume(volume) {
    this.volume = volume;
    try {
      localStorage.setItem('sala:musicVolume', String(volume));
    } catch {
      // sem armazenamento: o volume vale só até fechar
    }
    this.applyVolume();
  }

  // Ensurdecer na call também cala o vídeo.
  setSilenced(silenced) {
    this.silenced = silenced;
    this.applyVolume();
  }

  applyVolume() {
    if (!this.player?.setVolume) return;
    this.player.setVolume(this.volume);
    if (this.silenced || this.volume === 0) this.player.mute();
    else this.player.unMute();
  }

  expected() {
    const s = this.state;
    if (!s?.current) return 0;
    return s.playing ? s.position + Math.max(0, this.now() - s.serverTime) / 1000 : s.position;
  }

  currentTime() {
    return this.player?.getCurrentTime?.() || 0;
  }

  duration() {
    return this.player?.getDuration?.() || 0;
  }

  apply() {
    if (!this.player?.getPlayerState) return;
    const { PlayerState } = this.YT;
    const s = this.state;
    const current = s?.current;
    if (!current) {
      if (this.loadedId) {
        this.player.stopVideo();
        this.loadedId = null;
      }
      return;
    }
    const target = this.expected();
    if (this.loadedId !== current.id) {
      this.loadedId = current.id;
      this.reportedDuration = null;
      const options = { videoId: current.videoId, startSeconds: target };
      if (s.playing) this.player.loadVideoById(options);
      else this.player.cueVideoById(options);
      return;
    }
    const ps = this.player.getPlayerState();
    if (ps === PlayerState.ENDED) {
      const duration = this.duration();
      if (s.playing && duration && target < duration - 1) {
        this.player.seekTo(target, true);
        this.player.playVideo();
      } else if (s.playing && Date.now() - this.lastEndedSent > 5000) {
        this.lastEndedSent = Date.now();
        this.send({ type: 'music:ended', itemId: current.id });
      }
      return;
    }
    if (s.playing && ps !== PlayerState.PLAYING && ps !== PlayerState.BUFFERING) this.player.playVideo();
    if (!s.playing && (ps === PlayerState.PLAYING || ps === PlayerState.BUFFERING)) this.player.pauseVideo();
    // seekTo num vídeo só "carregado" faz ele tocar, então só corrige quem já está tocando ou pausado
    if (ps === PlayerState.PLAYING || ps === PlayerState.PAUSED) {
      const drift = Math.abs(this.currentTime() - target);
      if (drift > (s.playing ? 2 : 0.5)) this.player.seekTo(target, true);
    }
  }

  onStateChange(event) {
    const { PlayerState } = this.YT;
    if (event.data === PlayerState.ENDED && this.loadedId) {
      this.lastEndedSent = Date.now();
      this.send({ type: 'music:ended', itemId: this.loadedId });
    }
    if (event.data === PlayerState.PLAYING && this.reportedDuration !== this.loadedId) {
      const duration = this.duration();
      if (duration > 0) {
        this.reportedDuration = this.loadedId;
        this.send({ type: 'music:duration', itemId: this.loadedId, duration });
      }
    }
    this.onTick?.();
  }
}
