// Gera os efeitos sonoros que já vêm na mesa de sons, sintetizados do zero
// (sem usar gravação de ninguém). Rode com: npm run sounds
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'sounds');
const SR = 22050;

// ---------- blocos básicos ----------

let seed = 7;
const noise = () => {
  seed = (seed * 16807) % 2147483647;
  return seed / 1073741823.5 - 1;
};
const random = () => (noise() + 1) / 2;
const saw = (phase) => 2 * (phase - Math.floor(phase + 0.5));
const square = (phase) => (phase - Math.floor(phase) < 0.5 ? 1 : -1);
const sine = (phase) => Math.sin(2 * Math.PI * phase);

const buffer = (seconds) => new Float32Array(Math.ceil(seconds * SR));

// Soma fn(t) no trecho [start, start + length) do buffer.
function add(buf, start, length, fn) {
  const s = Math.floor(start * SR);
  const n = Math.floor(length * SR);
  for (let i = 0; i < n && s + i < buf.length; i++) buf[s + i] += fn(i / SR);
}

// Oscilador com frequência variável (a fase acumula amostra a amostra).
function tone(buf, start, length, freqAt, wave, ampAt) {
  let phase = 0;
  add(buf, start, length, (t) => {
    phase += freqAt(t) / SR;
    return wave(phase) * ampAt(t);
  });
}

function envelope(t, length, attack = 0.01, release = 0.05) {
  if (t < attack) return t / attack;
  if (t > length - release) return Math.max(0, (length - t) / release);
  return 1;
}

function lowpass(buf, cutoffAt) {
  let y = 0;
  for (let i = 0; i < buf.length; i++) {
    const fc = typeof cutoffAt === 'function' ? cutoffAt(i / SR) : cutoffAt;
    y += (1 - Math.exp((-2 * Math.PI * fc) / SR)) * (buf[i] - y);
    buf[i] = y;
  }
  return buf;
}

function highpass(buf, cutoff) {
  const low = lowpass(Float32Array.from(buf), cutoff);
  for (let i = 0; i < buf.length; i++) buf[i] -= low[i];
  return buf;
}

function drive(buf, amount) {
  for (let i = 0; i < buf.length; i++) buf[i] = Math.tanh(buf[i] * amount);
  return buf;
}

function mix(target, source, at = 0, gain = 1) {
  const s = Math.floor(at * SR);
  for (let i = 0; i < source.length && s + i < target.length; i++) target[s + i] += source[i] * gain;
  return target;
}

function normalize(buf, peak) {
  let max = 0;
  for (const v of buf) max = Math.max(max, Math.abs(v));
  if (max > 0) for (let i = 0; i < buf.length; i++) buf[i] *= peak / max;
  // pequeno fade no fim para não estalar
  const fade = Math.min(buf.length, Math.floor(0.01 * SR));
  for (let i = 0; i < fade; i++) buf[buf.length - 1 - i] *= i / fade;
  return buf;
}

function wav(buf) {
  const data = Buffer.alloc(buf.length * 2);
  for (let i = 0; i < buf.length; i++) data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, buf[i])) * 32767), i * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SR, 24);
  header.writeUInt32LE(SR * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

// ---------- os sons ----------

function corneta() {
  const b = buffer(1.3);
  for (const [start, length] of [[0, 0.16], [0.21, 0.16], [0.42, 0.8]]) {
    for (const f of [415, 523, 622, 830]) {
      tone(b, start, length, (t) => f * (1 + 0.004 * Math.sin(2 * Math.PI * 6 * t)), saw, (t) => envelope(t, length, 0.015, 0.06) * 0.25);
    }
  }
  return lowpass(drive(b, 2.5), 3500);
}

function tromboneTriste() {
  const notes = [[293.66, 0, 0.42], [277.18, 0.45, 0.42], [261.63, 0.9, 0.42], [246.94, 1.35, 1.5]];
  const b = buffer(3);
  notes.forEach(([f, start, length], i) => {
    const last = i === notes.length - 1;
    const depth = last ? 0.035 : 0.01;
    tone(b, start, length, (t) => f * (1 + depth * Math.sin(2 * Math.PI * 5 * t) * Math.min(1, t / 0.3)), saw, (t) => envelope(t, length, 0.06, 0.12));
    tone(b, start, length, (t) => (f / 2) * (1 + depth * Math.sin(2 * Math.PI * 5 * t)), sine, (t) => envelope(t, length, 0.06, 0.12) * 0.6);
  });
  return lowpass(b, 1100);
}

function baDumTss() {
  const b = buffer(1.9);
  const drum = (start, high, low) => {
    tone(b, start, 0.3, (t) => low + (high - low) * Math.exp(-t * 20), sine, (t) => Math.exp(-t * 11));
    add(b, start, 0.2, (t) => noise() * 0.45 * Math.exp(-t * 28));
  };
  drum(0, 210, 120);
  drum(0.17, 160, 85);
  const cymbal = buffer(1.5);
  add(cymbal, 0, 1.5, (t) => noise() * Math.exp(-t * 3.2));
  for (const f of [3150, 4250, 5410, 6310, 7280]) tone(cymbal, 0, 1.5, () => f, square, (t) => 0.08 * Math.exp(-t * 3.2));
  mix(b, highpass(cymbal, 4500), 0.38, 0.9);
  return b;
}

function boing() {
  const b = buffer(0.95);
  const freq = (t) => 180 * (1 + 0.6 * Math.exp(-4 * t) * Math.sin(2 * Math.PI * 14 * t)) + 140 * t;
  tone(b, 0, 0.95, freq, sine, (t) => Math.exp(-3.5 * t) * Math.min(1, t / 0.005));
  tone(b, 0, 0.95, (t) => 2 * freq(t), sine, (t) => 0.3 * Math.exp(-5 * t));
  return b;
}

function errou() {
  const b = buffer(0.8);
  const amp = (t) => envelope(t, 0.75, 0.01, 0.06) * (0.8 + 0.2 * Math.sin(2 * Math.PI * 10 * t));
  tone(b, 0, 0.75, () => 98, square, amp);
  tone(b, 0, 0.75, () => 104, square, amp);
  return lowpass(b, 1800);
}

function acertou() {
  const b = buffer(1.6);
  const bell = (start, f) => {
    for (const [ratio, gain, decay] of [[1, 1, 3], [2, 0.4, 5], [2.76, 0.3, 6], [5.4, 0.12, 9]]) {
      tone(b, start, 1.4, () => f * ratio, sine, (t) => gain * Math.exp(-t * decay) * Math.min(1, t / 0.002));
    }
  };
  bell(0, 1046.5);
  bell(0.18, 1568);
  return b;
}

function grilos() {
  const b = buffer(2.6);
  const cricket = (offset, f) => {
    for (const group of [0.1, 0.75, 1.4, 2.05]) {
      for (let k = 0; k < 3; k++) {
        tone(b, group + offset + k * 0.06, 0.035, () => f, sine, (t) => Math.sin((Math.PI * t) / 0.035) * 0.5);
      }
    }
  };
  cricket(0, 4700);
  cricket(0.3, 5100);
  return b;
}

function suspense() {
  const notes = [[146.83, 0, 0.28], [174.61, 0.33, 0.28], [138.59, 0.68, 1.7]];
  const b = buffer(2.5);
  notes.forEach(([f, start, length], i) => {
    const tremolo = i === 2 ? (t) => 0.85 + 0.15 * Math.sin(2 * Math.PI * 6 * t) : () => 1;
    tone(b, start, length, () => f, saw, (t) => envelope(t, length, 0.02, 0.25) * tremolo(t));
    tone(b, start, length, () => f / 2, sine, (t) => envelope(t, length, 0.02, 0.25) * 0.8);
    add(b, start, 0.25, (t) => noise() * 0.5 * Math.exp(-t * 18));
  });
  return lowpass(b, 900);
}

function aplausos() {
  const length = 2.8;
  const b = buffer(length);
  let t = 0;
  while (t < length - 0.05) {
    const density = 55 * Math.min(1, t / 0.25) * Math.min(1, (length - t) / 0.9);
    t += -Math.log(1 - random() * 0.999) / Math.max(density, 4);
    const gain = 0.3 + 0.7 * random();
    add(b, t, 0.03, (x) => noise() * gain * Math.exp(-x * 260));
  }
  return highpass(lowpass(b, 4200), 600);
}

function explosao() {
  const b = buffer(2.3);
  add(b, 0, 2.3, (t) => noise() * Math.exp(-t * 2.2));
  lowpass(b, (t) => 180 + 3000 * Math.exp(-t * 4));
  tone(b, 0, 1, (t) => 40 + 30 * Math.exp(-t * 10), sine, (t) => Math.exp(-t * 5));
  return drive(b, 3);
}

function pum() {
  const b = buffer(1);
  let flutter = 0;
  tone(
    b,
    0,
    0.95,
    (t) => 85 + 25 * Math.sin(2 * Math.PI * 7 * t) + 40 * t + 8 * noise(),
    saw,
    (t) => {
      flutter += 22 / SR;
      return envelope(t, 0.95, 0.02, 0.2) * (0.6 + 0.4 * square(flutter));
    },
  );
  add(b, 0, 0.95, (t) => noise() * 0.25 * envelope(t, 0.95, 0.02, 0.3));
  return lowpass(b, 650);
}

const SOUNDS = [
  ['corneta', corneta, 0.9],
  ['trombone-triste', tromboneTriste, 0.9],
  ['ba-dum-tss', baDumTss, 0.9],
  ['boing', boing, 0.9],
  ['errou', errou, 0.7],
  ['acertou', acertou, 0.8],
  ['grilos', grilos, 0.35],
  ['suspense', suspense, 0.9],
  ['aplausos', aplausos, 0.8],
  ['explosao', explosao, 0.9],
  ['pum', pum, 0.9],
];

mkdirSync(OUT, { recursive: true });
for (const [name, make, peak] of SOUNDS) {
  seed = 7;
  const samples = normalize(make(), peak);
  if (samples.some((v) => !Number.isFinite(v))) throw new Error(`${name} gerou valores inválidos`);
  writeFileSync(path.join(OUT, `${name}.wav`), wav(samples));
  console.log(`gerado ${name}.wav (${(samples.length / SR).toFixed(1)} s)`);
}
