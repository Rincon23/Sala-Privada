// Gera os PNGs do app (PWA e iPhone) a partir das mesmas formas do icon.svg,
// sem depender de nenhuma biblioteca de imagem. Rode com: npm run icons
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
const TOP = [0x97, 0x87, 0xff];
const BOTTOM = [0x5a, 0x3f, 0xe0];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const dot = (ax, ay, bx, by) => ax * bx + ay * by;

function sdRoundRect(px, py, cx, cy, hx, hy, r) {
  const qx = Math.abs(px - cx) - hx + r;
  const qy = Math.abs(py - cy) - hy + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function sdSegment(px, py, ax, ay, bx, by) {
  const pax = px - ax;
  const pay = py - ay;
  const bax = bx - ax;
  const bay = by - ay;
  const h = clamp(dot(pax, pay, bax, bay) / dot(bax, bay, bax, bay), 0, 1);
  return Math.hypot(pax - bax * h, pay - bay * h);
}

function sdTriangle(px, py, [x0, y0], [x1, y1], [x2, y2]) {
  const e = [[x1 - x0, y1 - y0], [x2 - x1, y2 - y1], [x0 - x2, y0 - y2]];
  const v = [[px - x0, py - y0], [px - x1, py - y1], [px - x2, py - y2]];
  const s = Math.sign(e[0][0] * e[2][1] - e[0][1] * e[2][0]);
  let dist = Infinity;
  let sign = Infinity;
  for (let i = 0; i < 3; i++) {
    const [ex, ey] = e[i];
    const [vx, vy] = v[i];
    const h = clamp(dot(vx, vy, ex, ey) / dot(ex, ey, ex, ey), 0, 1);
    dist = Math.min(dist, (vx - ex * h) ** 2 + (vy - ey * h) ** 2);
    sign = Math.min(sign, s * (vx * ey - vy * ex));
  }
  return -Math.sqrt(dist) * Math.sign(sign);
}

// Desenho em coordenadas de 512x512 (igual ao SVG).
function foreground(x, y) {
  const screen = Math.abs(sdRoundRect(x, y, 256, 236, 144, 100, 32)) - 16;
  const play = sdTriangle(x, y, [232, 196], [296, 236], [232, 276]) - 8;
  const stand = sdSegment(x, y, 256, 352, 256, 392) - 16;
  const base = sdSegment(x, y, 196, 392, 316, 392) - 16;
  return Math.min(screen, play, stand, base);
}

function render(size, { rounded, scale }) {
  const px = new Uint8Array(size * size * 4);
  const unit = 512 / size;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const x = (i + 0.5) * unit;
      const y = (j + 0.5) * unit;
      const bgDist = rounded ? sdRoundRect(x, y, 256, 256, 256, 256, 116) : -1;
      const bg = clamp(0.5 - bgDist / unit, 0, 1);
      // o desenho é encolhido em volta do centro para caber na área segura dos ícones "maskable"
      const fx = 256 + (x - 256) / scale;
      const fy = 256 + (y - 256) / scale;
      const fg = clamp(0.5 - foreground(fx, fy) / (unit / scale), 0, 1);
      const t = (x + y) / 1024;
      const k = (j * size + i) * 4;
      for (let c = 0; c < 3; c++) {
        const grad = TOP[c] + (BOTTOM[c] - TOP[c]) * t;
        px[k + c] = Math.round(grad + (255 - grad) * fg);
      }
      px[k + 3] = Math.round(bg * 255);
    }
  }
  return encodePng(size, size, px);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bits por canal
  header[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const icons = [
  ['icon-192.png', 192, { rounded: true, scale: 1 }],
  ['icon-512.png', 512, { rounded: true, scale: 1 }],
  ['icon-maskable-512.png', 512, { rounded: false, scale: 0.78 }],
  ['apple-touch-icon.png', 180, { rounded: false, scale: 0.9 }],
];

for (const [name, size, options] of icons) {
  writeFileSync(path.join(OUT, name), render(size, options));
  console.log(`gerado ${name}`);
}
