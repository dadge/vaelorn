/**
 * Aperçus visuels de l'atlas de sprites (hors production).
 *
 *   node scripts/preview-atlas.mjs [dossierDeSortie] [échelle]
 *
 * Bundle src/render/art/index.ts avec esbuild (déjà présent via Vite), construit l'atlas en Node
 * (aucun DOM), puis écrit des PNG agrandis : atlas complet, planche des héros, des ennemis/boss,
 * des tuiles des 3 thèmes, des mécanismes/décors/FX/UI. Encodeur PNG minimal (zlib de Node).
 */
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(process.argv[2] ?? join(tmpdir(), 'vaelorn-preview'));
const SCALE = Number(process.argv[3] ?? 6);
mkdirSync(outDir, { recursive: true });

// ── PNG minimal ──
const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** Encode des pixels RGBA (Uint8Array) en PNG. */
export function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// ── Bundle + import du module d'art ──
const result = await build({
  entryPoints: [join(root, 'src/render/art/index.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  external: ['phaser'],
  logLevel: 'silent',
});
const bundleFile = join(outDir, '.art-bundle.mjs');
writeFileSync(bundleFile, result.outputFiles[0].text);
const art = await import(pathToFileURL(bundleFile).href);
const atlas = art.buildAtlasData();

// ── Aides de composition ──
function sheet(w, h, bg) {
  const px = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    px[i * 4] = bg[0];
    px[i * 4 + 1] = bg[1];
    px[i * 4 + 2] = bg[2];
    px[i * 4 + 3] = 255;
  }
  return { w, h, px };
}
/** Colle une frame de l'atlas à (dx, dy), agrandie ×s. */
function blit(sh, name, dx, dy, s = SCALE) {
  const f = atlas.frames[name];
  if (!f) return;
  for (let j = 0; j < f.h; j++) {
    for (let i = 0; i < f.w; i++) {
      const o = ((f.y + j) * atlas.width + (f.x + i)) * 4;
      if (atlas.pixels[o + 3] === 0) continue;
      for (let v = 0; v < s; v++) {
        for (let u = 0; u < s; u++) {
          const X = dx + i * s + u;
          const Y = dy + j * s + v;
          if (X < 0 || Y < 0 || X >= sh.w || Y >= sh.h) continue;
          const p = (Y * sh.w + X) * 4;
          sh.px[p] = atlas.pixels[o];
          sh.px[p + 1] = atlas.pixels[o + 1];
          sh.px[p + 2] = atlas.pixels[o + 2];
          sh.px[p + 3] = 255;
        }
      }
    }
  }
}
function save(name, sh) {
  const file = join(outDir, name);
  writeFileSync(file, encodePng(sh.w, sh.h, sh.px));
  console.log(file);
}
/** Planche en grille : lignes = tableaux de noms de frames. */
function grid(name, rows, { bg = [78, 86, 98], cell = 16, gap = 4, scale = SCALE } = {}) {
  const cols = Math.max(...rows.map((r) => r.length));
  const cw = cell * scale + gap * 2;
  const sh = sheet(cols * cw, rows.length * cw, bg);
  rows.forEach((r, j) => r.forEach((n, i) => n && blit(sh, n, i * cw + gap, j * cw + gap, scale)));
  save(name, sh);
}

// ── Atlas complet ──
{
  const s = Math.max(1, Math.floor(1024 / atlas.width));
  const sh = sheet(atlas.width * s, atlas.height * s, [78, 86, 98]);
  for (const n of Object.keys(atlas.frames)) blit(sh, n, atlas.frames[n].x * s, atlas.frames[n].y * s, s);
  save('atlas-full.png', sh);
  console.log(`atlas ${atlas.width}x${atlas.height}, ${Object.keys(atlas.frames).length} frames`);
}

// ── Héros ──
const heroes = ['david', 'sandrine', 'romain', 'valentine', 'aelith', 'brokk', 'grok', 'mira'];
const dirs = ['down', 'up', 'left', 'right'];
grid(
  'heroes-walk.png',
  heroes.map((h) => dirs.flatMap((d) => [`hero_${h}_${d}_0`, `hero_${h}_${d}_1`])),
);
grid(
  'heroes-attack.png',
  heroes.map((h) => [...dirs.map((d) => `hero_${h}_${d}_attack`), `hero_${h}_downed`]),
);
// zoom ×2 en taille réelle (lisibilité) : héros côte à côte
grid('heroes-zoom2.png', [heroes.map((h) => `hero_${h}_down_0`)], { scale: 2, gap: 6, bg: [58, 90, 52] });

// ── Ennemis et boss ──
const enemies = ['slime', 'bat', 'skeleton', 'archer', 'spider', 'wisp', 'knight'];
grid('enemies.png', [enemies.map((e) => `enemy_${e}_0`), enemies.map((e) => `enemy_${e}_1`)]);
{
  const bosses = ['boss_golem_0', 'boss_golem_1', 'boss_golem_hurt', 'boss_morvane_0', 'boss_morvane_1', 'boss_morvane_hurt'];
  const s = 4;
  const sh = sheet(bosses.length * (48 * s + 8), 48 * s + 8, [78, 86, 98]);
  bosses.forEach((n, i) => blit(sh, n, i * (48 * s + 8) + 4, 4, s));
  save('bosses.png', sh);
}

// ── Tuiles : une planche par thème, plus une salle d'exemple ──
const kinds = ['floor', 'floor_alt', 'wall', 'wall_top', 'pillar', 'pit', 'void'];
grid(
  'tiles.png',
  ['crypt', 'grove', 'citadel'].map((t) => kinds.map((k) => `tile_${t}_${k}`)),
  { gap: 2 },
);
{
  const room = [
    '#########',
    '#o.,..,o#',
    '#.......#',
    '#..~~...#',
    '#..~~.,.#',
    '#.......#',
    '#o..,..o#',
    '#########',
  ];
  const s = 4;
  const T = 16 * s;
  const sh = sheet(room[0].length * T * 3 + 40, room.length * T, [10, 10, 14]);
  ['crypt', 'grove', 'citadel'].forEach((theme, ti) => {
    room.forEach((row, y) =>
      [...row].forEach((g, x) => {
        const below = room[y + 1]?.[x];
        let name;
        if (g === '#') name = below === '#' || below === undefined ? `tile_${theme}_wall_top` : `tile_${theme}_wall`;
        else if (g === 'o') name = `tile_${theme}_pillar`;
        else if (g === '~') name = `tile_${theme}_pit`;
        else name = `tile_${theme}_floor${(x * 7 + y * 13) % 5 === 0 || g === ',' ? '_alt' : ''}`;
        blit(sh, name, ti * (room[0].length * T + 20) + x * T, y * T, s);
      }),
    );
  });
  save('room-sample.png', sh);
}

// ── Mécanismes, décors, FX, UI ──
const mech = ['plate_up', 'plate_down', 'lever_off', 'lever_on', 'door_closed', 'door_open', 'door_sealed', 'exit_open', 'exit_closed', 'pedestal', 'rune_frame', 'key_0', 'key_1', 'key_2', 'key_3'];
const runes = ['sun', 'moon', 'star', 'eye', 'flame', 'wave'].map((r) => `rune_${r}`);
const decor = ['decor_torch_0', 'decor_torch_1', 'decor_statue', 'decor_banner', 'decor_crate', 'decor_bones', 'decor_plant', 'decor_crystal', 'sign'];
grid('mechanisms.png', [mech, runes, decor], { bg: [60, 66, 80] });
{
  const s = 4;
  const names = ['block', 'socket', 'socket_filled'];
  const sh = sheet(names.length * (32 * s + 8), 32 * s + 8, [60, 66, 80]);
  names.forEach((n, i) => blit(sh, n, i * (32 * s + 8) + 4, 4, s));
  save('big-mechanisms.png', sh);
}
grid(
  'fx-ui.png',
  [
    ['fx_slash_up', 'fx_slash_down', 'fx_slash_left', 'fx_slash_right'],
    ['fx_arrow', 'fx_bolt', 'fx_orb', 'fx_shard', 'fx_heal', 'fx_marker', 'fx_shadow'],
    ['fx_hit_0', 'fx_hit_1', 'fx_hit_2', 'fx_revive_0', 'fx_revive_1', 'fx_revive_2', 'fx_revive_3'],
    ['ui_heart_full', 'ui_heart_half', 'ui_heart_empty', 'ui_medcross', 'ui_check', 'ui_cross', 'ui_down', 'ui_key_0', 'ui_key_1', 'ui_key_2', 'ui_key_3'],
  ],
  { cell: 24, bg: [60, 66, 80] },
);

// ── Lumière : braseros, icônes de torche, braises (fond sombre : lisibilité en salle noire) ──
grid(
  'light.png',
  [
    ['brazier_unlit', 'brazier_lit_0', 'brazier_lit_1', 'decor_torch_0'],
    ['ui_torch_full', 'ui_torch_half', 'ui_torch_empty', 'fx_ember_0', 'fx_ember_1', 'fx_ember_2'],
  ],
  { cell: 16, bg: [26, 24, 40], scale: 12, gap: 6 },
);

// ── Zoom personnalisé : node scripts/preview-atlas.mjs <dossier> <échelle> <frame> [<frame> ...] ──
{
  const custom = process.argv.slice(4);
  if (custom.length > 0) {
    const cell = Math.max(...custom.map((n) => Math.max(atlas.frames[n]?.w ?? 16, atlas.frames[n]?.h ?? 16)));
    grid('custom.png', [custom], { cell, scale: Math.max(1, Math.floor(1400 / (custom.length * cell))), gap: 4 });
  }
}
