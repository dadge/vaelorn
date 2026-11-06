/**
 * Mécanismes : plaques, leviers, portes, clés, bloc poussable, réceptacle, sortie, piédestal, runes.
 *
 * Conventions :
 *  - plate_* / lever_* : centre clair → le rendu peut teinter (couleur du slot « qui doit faire quoi »).
 *  - door_closed : tuile OPAQUE raccordable (une porte = N tuiles) ; door_open : presque vide (sol visible) ;
 *    door_sealed : dalle scellée violette pour la sortie verrouillée (opaque).
 *  - key_<n> : clé dont l'anneau a la couleur PLAYER_COLORS[n] (slot n % 4).
 *  - rune_<symbole> : glyphe seul sur fond transparent (le rendu pose rune_frame dessous si besoin).
 */
import { MECH_COLORS as M, OUTLINE, RUNE_COLORS as R, SLOT_COLORS, SLOT_LIGHTS, SLOT_SHADES, WHITE } from '../palettes';
import { Bitmap, CLEAR } from './bitmap';

export const RUNE_SYMBOLS = ['sun', 'moon', 'star', 'eye', 'flame', 'wave'] as const;

function plateUp(): Bitmap {
  const b = new Bitmap(16, 16);
  b.box(2, 3, 13, 13, M.stoneShade);
  b.box(3, 3, 12, 11, M.plateLight);
  b.hline(3, 12, 12, M.plateMid);
  b.hline(3, 12, 13, M.stoneShade);
  b.box(5, 5, 10, 9, M.plateMid);
  b.box(6, 6, 9, 8, M.plateLight);
  b.set(4, 4, WHITE);
  return b.outline(OUTLINE);
}

function plateDown(): Bitmap {
  const b = new Bitmap(16, 16);
  b.box(2, 4, 13, 13, M.stoneDark);
  b.box(3, 6, 12, 12, M.plateMid);
  b.hline(3, 12, 5, M.stoneShade);
  b.box(5, 7, 10, 11, M.plateLight);
  b.box(6, 8, 9, 10, M.plateMid);
  b.hline(3, 12, 13, M.stoneShade);
  return b.outline(OUTLINE);
}

function lever(on: boolean): Bitmap {
  const b = new Bitmap(16, 16);
  // socle de pierre
  b.box(3, 10, 12, 14, M.stone);
  b.hline(3, 12, 10, M.stoneHi);
  b.hline(3, 12, 14, M.stoneShade);
  b.vline(12, 11, 14, M.stoneShade);
  b.box(6, 10, 9, 11, M.stoneDark);
  // manche + pommeau
  const tipX = on ? 12 : 4;
  const col = on ? { hi: M.goldHi, base: M.green, shade: M.greenDeep } : { hi: WHITE, base: M.red, shade: M.redDeep };
  b.line(8, 10, tipX, 4, M.ironHi);
  b.line(7, 10, tipX - 1, 4, M.iron);
  b.shadedEllipse(tipX + (on ? 0.5 : 0), 3.6, 2.4, 2.4, col);
  return b.outline(OUTLINE);
}

function doorClosed(): Bitmap {
  const b = new Bitmap(16, 16);
  b.rect(0, 0, 16, 16, M.wood);
  // planches
  for (const x of [3, 7, 11, 15]) b.vline(x, 0, 15, M.woodShade);
  for (const x of [1, 5, 9, 13]) b.vline(x, 1, 14, M.woodHi);
  // renforts de fer et rivets
  for (const y of [2, 11]) {
    b.box(0, y, 15, y + 2, M.iron);
    b.hline(0, 15, y, M.ironHi);
    b.hline(0, 15, y + 2, M.ironDark);
    for (const x of [2, 6, 10, 14]) b.set(x, y + 1, M.goldHi);
  }
  b.hline(0, 15, 0, M.woodShade);
  b.hline(0, 15, 15, M.woodShade);
  b.hline(0, 15, 14, M.woodShade);
  return b;
}

function doorOpen(): Bitmap {
  const b = new Bitmap(16, 16);
  // simples gonds / rails au sol : la porte est relevée
  for (const [x, y] of [[0, 0], [14, 0], [0, 14], [14, 14]] as const) {
    b.box(x, y, x + 1, y + 1, M.iron);
    b.set(x, y, M.ironHi);
  }
  b.hline(2, 13, 0, M.ironDark);
  b.hline(2, 13, 15, M.ironDark);
  return b;
}

function doorSealed(): Bitmap {
  const b = new Bitmap(16, 16);
  b.rect(0, 0, 16, 16, M.stoneShade);
  b.frame(0, 0, 15, 15, M.stoneDark);
  b.frame(1, 1, 14, 14, M.stone);
  b.box(2, 2, 13, 13, M.stoneShade);
  // sceau violet : anneau + étoile à 4 branches
  b.ellipse(8, 8, 5.4, 5.4, M.purpleDark);
  b.ellipse(8, 8, 4.4, 4.4, M.purple);
  b.ellipse(8, 8, 3.4, 3.4, M.purpleDark);
  b.vline(8, 4, 12, M.purple);
  b.hline(4, 12, 8, M.purple);
  b.set(8, 8, M.cyanHi);
  b.set(8, 4, M.cyanHi);
  b.set(8, 12, M.cyanHi);
  b.set(4, 8, M.cyanHi);
  b.set(12, 8, M.cyanHi);
  for (const [x, y] of [[2, 2], [13, 2], [2, 13], [13, 13]] as const) b.set(x, y, M.gold);
  return b;
}

function exitOpen(): Bitmap {
  const b = new Bitmap(16, 16);
  b.ellipse(8, 8, 7.2, 7.2, M.goldShade);
  b.ellipse(8, 8, 6.2, 6.2, M.gold);
  b.ellipse(8, 8, 5, 5, M.goldHi);
  b.ellipse(8, 8, 3.8, 3.8, M.floorGlow);
  // flèche vers le haut (sortie)
  b.polygon([[8, 4.2], [11.4, 8.4], [4.6, 8.4]], M.goldShade);
  b.box(7, 8, 8, 11, M.goldShade);
  for (const [x, y] of [[8, 1], [14, 8], [1, 8], [8, 15]] as const) b.set(x, y, WHITE);
  return b.outline(OUTLINE);
}

function exitClosed(): Bitmap {
  const b = new Bitmap(16, 16);
  b.ellipse(8, 8, 7.2, 7.2, M.stoneDark);
  b.ellipse(8, 8, 6.2, 6.2, M.stoneShade);
  b.ellipse(8, 8, 5, 5, M.stoneDark);
  // cadenas
  b.box(5, 8, 10, 12, M.goldShade);
  b.box(6, 9, 9, 11, M.gold);
  b.set(7, 10, M.stoneDark);
  b.set(8, 10, M.stoneDark);
  b.frame(6, 4, 9, 8, M.ironHi);
  b.box(7, 5, 8, 8, CLEAR);
  b.box(5, 8, 10, 8, M.goldShade);
  return b.outline(OUTLINE);
}

function pedestal(): Bitmap {
  const b = new Bitmap(16, 16);
  // fût et socle
  b.box(4, 8, 11, 13, M.stone);
  b.vline(10, 8, 13, M.stoneShade);
  b.vline(11, 8, 13, M.stoneShade);
  b.vline(5, 9, 12, M.stoneHi);
  b.box(2, 12, 13, 14, M.stone);
  b.hline(2, 13, 14, M.stoneShade);
  b.hline(2, 4, 12, M.stoneHi);
  // plateau elliptique
  b.ellipse(8, 7, 6.2, 3.8, M.stoneHi);
  b.ellipse(8, 7.2, 4.8, 2.6, M.stone);
  b.ellipse(8, 7, 2.6, 1.4, M.plateMid);
  b.set(7, 6, WHITE);
  return b.outline(OUTLINE);
}

function runeFrame(): Bitmap {
  const b = new Bitmap(16, 16);
  b.box(0, 0, 15, 15, M.goldShade);
  b.frame(1, 1, 14, 14, M.gold);
  b.box(2, 2, 13, 13, R.dark);
  b.frame(3, 3, 12, 12, R.mid);
  for (const [x, y] of [[0, 0], [15, 0], [0, 15], [15, 15]] as const) b.set(x, y, CLEAR);
  for (const [x, y] of [[1, 1], [14, 1], [1, 14], [14, 14]] as const) b.set(x, y, M.goldHi);
  return b.outline(OUTLINE);
}

function sun(): Bitmap {
  const b = new Bitmap(16, 16);
  const rays = [[8, 1.5, 8, 3.8], [8, 14.5, 8, 12.2], [1.5, 8, 3.8, 8], [14.5, 8, 12.2, 8], [3.4, 3.4, 5, 5], [12.6, 3.4, 11, 5], [3.4, 12.6, 5, 11], [12.6, 12.6, 11, 11]];
  for (const [x0, y0, x1, y1] of rays) b.line(x0, y0, x1, y1, R.sun);
  b.ellipse(8, 8, 3.8, 3.8, R.sun);
  b.set(6, 6, WHITE);
  b.set(7, 6, WHITE);
  b.set(6, 7, WHITE);
  return b.outline(OUTLINE);
}

function moon(): Bitmap {
  const b = new Bitmap(16, 16);
  b.ellipse(8, 8, 6.2, 6.2, R.moon);
  b.ellipse(11.4, 6.6, 5, 5, CLEAR);
  b.set(4, 6, WHITE);
  b.set(4, 7, WHITE);
  b.set(5, 5, WHITE);
  return b.outline(OUTLINE);
}

function star(): Bitmap {
  const b = new Bitmap(16, 16);
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const r = i % 2 === 0 ? 7 : 2.9;
    pts.push([8 + Math.cos(a) * r, 8.5 + Math.sin(a) * r]);
  }
  b.polygon(pts, R.star);
  b.set(8, 5, WHITE);
  b.set(8, 6, WHITE);
  b.set(8, 7, WHITE);
  return b.outline(OUTLINE);
}

function eye(): Bitmap {
  const b = new Bitmap(16, 16);
  b.ellipse(8, 8, 7, 4.2, WHITE);
  b.ellipse(8, 8, 2.9, 2.9, R.eye);
  b.ellipse(8, 8, 1.4, 1.4, OUTLINE);
  b.set(7, 7, WHITE);
  b.line(1, 8, 3, 6, R.eye);
  b.line(14, 8, 12, 6, R.eye);
  b.hline(4, 11, 3, R.eye);
  return b.outline(OUTLINE);
}

function flame(): Bitmap {
  const b = new Bitmap(16, 16);
  b.polygon([[8, 1.2], [10.6, 5], [12.4, 8.6], [11.4, 12.2], [8, 14.4], [4.6, 12.2], [3.6, 8.6], [5.6, 6.2], [6.6, 3.6]], R.flame);
  b.polygon([[8, 6], [10, 9.4], [9.2, 12.4], [8, 13.2], [6.8, 12.4], [6.2, 9.4]], R.sun);
  b.polygon([[8, 9], [9, 11.4], [8, 12.4], [7, 11.4]], WHITE);
  return b.outline(OUTLINE);
}

function wave(): Bitmap {
  const b = new Bitmap(16, 16);
  for (const y0 of [4, 8, 12]) {
    for (let x = 1; x <= 14; x++) {
      const y = y0 + Math.round(1.4 * Math.sin((x - 1) * 0.85));
      b.set(x, y, R.wave);
      b.set(x, y + 1, R.wave);
    }
  }
  for (const [x, y] of [[3, 4], [3, 8], [3, 12]] as const) b.set(x, y, WHITE);
  return b.outline(OUTLINE);
}

function key(slot: number, size: 16 | 8): Bitmap {
  const col = { hi: SLOT_LIGHTS[slot], base: SLOT_COLORS[slot], shade: SLOT_SHADES[slot] };
  if (size === 8) {
    const b = new Bitmap(8, 8);
    b.shadedEllipse(2.6, 2.6, 1.9, 1.9, col);
    b.line(3, 3, 6, 6, M.gold);
    b.set(5, 6, M.goldShade);
    b.set(6, 5, M.goldShade);
    b.set(2, 2, OUTLINE);
    return b.outline(OUTLINE);
  }
  const b = new Bitmap(16, 16);
  // tige dorée en diagonale, dents, anneau coloré
  b.line(7, 7, 13, 13, M.gold);
  b.line(8, 7, 13, 12, M.goldShade);
  b.line(7, 8, 12, 13, M.goldHi);
  b.set(13, 10, M.gold);
  b.set(12, 10, M.goldShade);
  b.set(10, 13, M.gold);
  b.set(10, 12, M.goldShade);
  b.shadedEllipse(5.4, 5.4, 3.8, 3.8, col);
  b.set(5, 5, CLEAR);
  b.set(5, 6, CLEAR);
  b.set(6, 5, CLEAR);
  b.set(6, 6, CLEAR);
  b.set(3, 3, WHITE);
  return b.outline(OUTLINE);
}

/** Bloc poussable 2×2 tuiles : pierre biseautée, gravure en losange. */
function block(): Bitmap {
  const b = new Bitmap(32, 32);
  b.box(0, 0, 31, 31, M.stoneDark);
  b.box(1, 1, 30, 30, M.stone);
  b.box(1, 1, 30, 2, M.stoneHi);
  b.box(1, 1, 2, 30, M.stoneHi);
  b.box(29, 3, 30, 30, M.stoneShade);
  b.box(3, 29, 30, 30, M.stoneShade);
  // panneau en creux
  b.frame(6, 6, 25, 25, M.stoneShade);
  b.frame(7, 7, 24, 24, M.stoneHi);
  b.box(8, 8, 23, 23, M.stone);
  // losange gravé
  b.polygon([[16, 9], [22.5, 16], [16, 23], [9.5, 16]], M.stoneShade);
  b.polygon([[16, 11.2], [20.4, 16], [16, 20.8], [11.6, 16]], M.stone);
  b.set(16, 16, M.stoneDark);
  b.set(15, 16, M.stoneDark);
  b.set(16, 15, M.stoneDark);
  b.set(15, 15, M.stoneDark);
  // rivets d'angle
  for (const [x, y] of [[4, 4], [27, 4], [4, 27], [27, 27]] as const) {
    b.box(x, y, x + 1, y + 1, M.stoneHi);
    b.set(x + 1, y + 1, M.stoneShade);
  }
  for (const [x, y] of [[0, 0], [31, 0], [0, 31], [31, 31]] as const) b.set(x, y, CLEAR);
  return b.outline(OUTLINE);
}

/** Réceptacle 2×2 : creux dans le sol, filet violet (inactif) ou vert lumineux (rempli). */
function socket(filled: boolean): Bitmap {
  const b = new Bitmap(32, 32);
  b.box(0, 0, 31, 31, M.stoneDark);
  b.box(1, 1, 30, 30, M.stoneShade);
  b.box(1, 1, 30, 2, M.stone);
  b.box(1, 1, 2, 30, M.stone);
  b.box(4, 4, 27, 27, M.ironDark);
  b.box(5, 5, 26, 26, filled ? M.greenDeep : M.purpleDark);
  b.frame(7, 7, 24, 24, filled ? M.green : M.purpleDeep);
  b.frame(8, 8, 23, 23, filled ? M.greenDeep : M.purpleDark);
  b.box(9, 9, 22, 22, filled ? M.purpleDark : M.ironDark);
  // repères d'angle
  const mark = filled ? M.green : M.purple;
  for (const [x, y, dx, dy] of [[5, 5, 1, 1], [26, 5, -1, 1], [5, 26, 1, -1], [26, 26, -1, -1]] as const) {
    b.hline(Math.min(x, x + dx * 3), Math.max(x, x + dx * 3), y, mark);
    b.vline(x, Math.min(y, y + dy * 3), Math.max(y, y + dy * 3), mark);
  }
  if (filled) {
    b.box(14, 14, 17, 17, M.green);
    b.box(15, 15, 16, 16, WHITE);
  } else {
    b.hline(13, 18, 15, M.purpleDeep);
    b.hline(13, 18, 16, M.purpleDeep);
  }
  for (const [x, y] of [[0, 0], [31, 0], [0, 31], [31, 31]] as const) b.set(x, y, CLEAR);
  return b.outline(OUTLINE);
}

/** Frames des mécanismes (hors décors). */
export function buildMechanismFrames(): Record<string, Bitmap> {
  const out: Record<string, Bitmap> = {
    plate_up: plateUp(),
    plate_down: plateDown(),
    lever_off: lever(false),
    lever_on: lever(true),
    door_closed: doorClosed(),
    door_open: doorOpen(),
    door_sealed: doorSealed(),
    exit_open: exitOpen(),
    exit_closed: exitClosed(),
    pedestal: pedestal(),
    rune_frame: runeFrame(),
    rune_sun: sun(),
    rune_moon: moon(),
    rune_star: star(),
    rune_eye: eye(),
    rune_flame: flame(),
    rune_wave: wave(),
    block: block(),
    socket: socket(false),
    socket_filled: socket(true),
  };
  for (let s = 0; s < 4; s++) out[`key_${s}`] = key(s, 16);
  return out;
}

/** Icônes de clé 8×8 pour l'UI (`ui_key_<n>`). */
export function buildKeyIcons(): Record<string, Bitmap> {
  const out: Record<string, Bitmap> = {};
  for (let s = 0; s < 4; s++) out[`ui_key_${s}`] = key(s, 8);
  return out;
}
