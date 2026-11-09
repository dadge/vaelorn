#!/usr/bin/env node
/**
 * Génère les icônes de l'application (PWA) dans public/icons/ — sans dépendance (encodeur PNG maison, zlib de Node).
 *
 *   node scripts/make-icons.mjs
 *
 * Dessin : un soleil levant (« l'aube ») sur l'horizon, entouré de cinq fragments en losange, sur un ciel violet nuit.
 * Tout le dessin tient dans le cercle central de 80 % de l'icône (zone de sécurité des icônes « maskable »),
 * donc la même image sert aux icônes normales et masquables. Rendu suréchantillonné 3×3 (bords lissés).
 * Les PNG générés sont versionnés : ce script n'est à relancer que pour changer le dessin.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

const HORIZON = 0.64;
const SUN = { x: 0.5, y: HORIZON, r: 0.2 };
const FRAGMENTS = [
  { x: 0.5, y: 0.19, s: 0.065 },
  { x: 0.31, y: 0.28, s: 0.045 },
  { x: 0.69, y: 0.28, s: 0.045 },
  { x: 0.2, y: 0.45, s: 0.03 },
  { x: 0.8, y: 0.45, s: 0.03 },
];

const hex = (h) => [(h >> 16) & 255, (h >> 8) & 255, h & 255];
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const clamp01 = (x) => Math.max(0, Math.min(1, x));

/** Couleur [r,g,b] au point (u, v) ∈ [0,1]². */
export function sample(u, v) {
  // ciel : dégradé vertical violet nuit → presque noir ; sol sous l'horizon : sombre
  let c = mix(hex(0x1e1346), hex(0x0b0a14), clamp01(v / 0.9));
  // lueur chaude autour du soleil
  const d = Math.hypot(u - SUN.x, v - SUN.y);
  const glow = Math.pow(clamp01(1 - d / 0.5), 2) * (v <= HORIZON ? 0.65 : 0.22);
  c = mix(c, hex(0xff8a3c), glow);
  // disque solaire (au-dessus de l'horizon seulement)
  if (v <= HORIZON && d <= SUN.r) c = mix(hex(0xffeeb0), hex(0xff9a3c), clamp01((v - (SUN.y - SUN.r)) / SUN.r));
  // ligne d'horizon
  if (Math.abs(v - (HORIZON + 0.004)) <= 0.004 && Math.abs(u - 0.5) <= 0.33) c = hex(0xffc070);
  // fragments (losanges)
  for (const f of FRAGMENTS) {
    if (Math.abs(u - f.x) + Math.abs(v - f.y) <= f.s) c = mix(hex(0xfff3c4), hex(0xbfe8ff), clamp01((v - (f.y - f.s)) / (2 * f.s)));
  }
  return c;
}

/** Rendu RGBA `size`×`size`, suréchantillonné `ss`×`ss`. */
export function render(size, ss = 3) {
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const c = sample((x + (sx + 0.5) / ss) / size, (y + (sy + 0.5) / ss) / size);
          r += c[0];
          g += c[1];
          b += c[2];
        }
      }
      const n = ss * ss;
      const i = (y * size + x) * 4;
      px[i] = Math.round(r / n);
      px[i + 1] = Math.round(g / n);
      px[i + 2] = Math.round(b / n);
      px[i + 3] = 255;
    }
  }
  return px;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 255] ^ (c >>> 8);
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

/** Encode des pixels RGBA 8 bits en PNG. */
export function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // profondeur
  ihdr[9] = 6; // RGBA
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filtre « aucun »
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Icônes produites : nom de fichier → taille. */
export const ICONS = {
  'icon-192.png': 192,
  'icon-512.png': 512,
  'icon-maskable-512.png': 512,
  'apple-touch-icon.png': 180,
  'favicon-32.png': 32,
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const [name, size] of Object.entries(ICONS)) {
    const file = path.join(OUT_DIR, name);
    fs.writeFileSync(file, encodePng(size, render(size)));
    console.log(`${name} (${size}×${size})`);
  }
}
