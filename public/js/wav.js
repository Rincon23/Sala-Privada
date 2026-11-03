// Um som longo em WAV passa do limite de envio: vira um WAV menor (mono, 22 kHz),
// que ainda soa bem para efeitos e falas. 3 minutos ficam com uns 8 MB.

export async function compactWav(buffer, rate = 22050) {
  const ctx = new OfflineAudioContext(1, Math.ceil(buffer.duration * rate), rate);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  source.start();
  const samples = (await ctx.startRendering()).getChannelData(0);

  const view = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const text = (at, s) => [...s].forEach((ch, i) => view.setUint8(at + i, ch.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true); // tamanho do bloco fmt
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); // bytes por segundo
  view.setUint16(32, 2, true); // bytes por amostra
  view.setUint16(34, 16, true); // bits por amostra
  text(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([view], { type: 'audio/wav' });
}
