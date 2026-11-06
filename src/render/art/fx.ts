/**
 * Effets : arcs d'épée (24×24), projectiles (8×8, orientés vers la DROITE → le rendu applique la rotation),
 * impacts, relevage, marqueur de joueur (blanc, à teinter) et ombre au sol.
 * Les FX n'ont pas de contour : ils se détachent par leurs couleurs claires.
 */
import { FX_COLORS as F, OUTLINE, WHITE } from '../palettes';
import { Bitmap, CLEAR } from './bitmap';

/** Arc d'épée orienté vers la droite (croissant ouvert à gauche, queue effilée aux extrémités). */
function slashRight(): Bitmap {
  const b = new Bitmap(24, 24);
  // croissant extérieur
  b.ellipse(7, 12, 15.5, 11, F.slashLow);
  b.ellipse(3.2, 12, 14.2, 10.2, CLEAR);
  // croissant médian plus fin
  const mid = new Bitmap(24, 24);
  mid.ellipse(7, 12, 15, 10.4, F.slashMid);
  mid.ellipse(3.8, 12, 14.2, 10.3, CLEAR);
  b.blit(mid, 0, 0);
  // cœur lumineux
  const core = new Bitmap(24, 24);
  core.ellipse(7, 12, 14.4, 9.8, F.slashHi);
  core.ellipse(4.6, 12, 14.2, 10, CLEAR);
  b.blit(core, 0, 0);
  // extrémités : on retire les pointes trop épaisses pour affiner la queue
  for (const y of [1, 2, 21, 22]) for (let x = 0; x < 24; x++) if (x < 14) b.set(x, y, CLEAR);
  return b;
}

function slash(dir: 'up' | 'down' | 'left' | 'right'): Bitmap {
  const r = slashRight();
  switch (dir) {
    case 'right': return r;
    case 'left': return r.flipH();
    case 'down': return r.rotate(1);
    default: return r.rotate(3);
  }
}

function arrow(): Bitmap {
  const b = new Bitmap(8, 8);
  b.hline(1, 6, 4, F.arrowShaft);
  b.hline(1, 6, 3, F.arrowShaft);
  b.polygon([[5, 2], [8, 4], [5, 6]], F.arrowHead);
  b.set(0, 2, F.arrowFeather);
  b.set(1, 2, F.arrowFeather);
  b.set(0, 5, F.arrowFeather);
  b.set(1, 5, F.arrowFeather);
  b.set(2, 2, F.arrowFeather);
  b.set(2, 5, F.arrowFeather);
  return b;
}

function bolt(): Bitmap {
  const b = new Bitmap(8, 8);
  b.ellipse(4, 4, 3.9, 2.1, F.boltShade);
  b.ellipse(4.4, 4, 3.2, 1.5, F.bolt);
  b.hline(2, 7, 4, F.boltHi);
  b.set(0, 3, F.boltShade);
  b.set(0, 5, F.boltShade);
  return b;
}

function orb(): Bitmap {
  const b = new Bitmap(8, 8);
  b.shadedEllipse(4, 4, 3.6, 3.6, { hi: F.orbHi, base: F.orb, shade: F.orbShade });
  b.set(2, 2, F.orbHi);
  return b;
}

function shard(): Bitmap {
  const b = new Bitmap(8, 8);
  b.polygon([[0.2, 4], [3, 1.2], [7.8, 4], [3, 6.8]], F.shard);
  b.polygon([[0.2, 4], [3, 1.2], [7.8, 4]], F.shardHi);
  b.polygon([[0.2, 4], [7.8, 4], [3, 6.8]], F.shardShade);
  return b;
}

function heal(): Bitmap {
  const b = new Bitmap(8, 8);
  b.box(3, 0, 4, 7, F.heal);
  b.box(0, 3, 7, 4, F.heal);
  b.box(2, 2, 5, 5, F.heal);
  b.box(3, 3, 4, 4, F.healHi);
  b.set(3, 1, F.healHi);
  b.set(1, 3, F.healHi);
  b.set(3, 6, F.healShade);
  b.set(6, 4, F.healShade);
  return b;
}

/** Impact : 0 étincelle, 1 gerbe, 2 éclats qui se dispersent. */
function hit(step: number): Bitmap {
  const b = new Bitmap(16, 16);
  if (step === 0) {
    b.hline(5, 10, 8, F.hit);
    b.vline(8, 5, 10, F.hit);
    b.box(7, 7, 8, 8, F.hitHi);
    b.line(5, 5, 6, 6, F.hitLow);
    b.line(10, 5, 9, 6, F.hitLow);
    b.line(5, 10, 6, 9, F.hitLow);
    b.line(10, 10, 9, 9, F.hitLow);
  } else if (step === 1) {
    const ang = [0, 45, 90, 135, 180, 225, 270, 315];
    for (const a of ang) {
      const r = (a * Math.PI) / 180;
      const long = a % 90 === 0;
      b.line(8 + Math.cos(r) * 3, 8 + Math.sin(r) * 3, 8 + Math.cos(r) * (long ? 7 : 5.6), 8 + Math.sin(r) * (long ? 7 : 5.6), long ? F.hit : F.hitLow);
    }
    b.ellipse(8, 8, 2.8, 2.8, F.hitHi);
    b.ellipse(8, 8, 1.4, 1.4, F.hit);
  } else {
    for (const [x, y] of [[8, 2], [8, 13], [2, 8], [13, 8], [4, 4], [12, 4], [4, 12], [12, 12]] as const) {
      b.set(x, y, F.hit);
    }
    for (const [x, y] of [[3, 3], [13, 3], [3, 13], [13, 13], [8, 1], [8, 14], [1, 8], [14, 8]] as const) b.set(x, y, F.hitLow);
    b.set(7, 7, F.hitHi);
    b.set(8, 8, F.hitHi);
  }
  return b;
}

/** Relevage : anneau + étincelles qui montent (0 → 3). */
function revive(step: number): Bitmap {
  const b = new Bitmap(16, 16);
  const sparkle = (x: number, y: number, c: number) => {
    b.set(x, y, c);
    b.set(x - 1, y, F.reviveDeep);
    b.set(x + 1, y, F.reviveDeep);
    b.set(x, y - 1, F.reviveDeep);
    b.set(x, y + 1, F.reviveDeep);
  };
  const ring = (rx: number, ry: number, y: number, c: number) => {
    for (let a = 0; a < 360; a += 12) {
      const r = (a * Math.PI) / 180;
      b.set(8 + Math.cos(r) * rx, y + Math.sin(r) * ry, c);
    }
  };
  if (step === 0) {
    ring(4.5, 2, 12, F.reviveGreen);
    ring(2.5, 1, 12, F.revive);
    b.set(8, 10, F.reviveHi);
    b.set(5, 9, F.revive);
    b.set(11, 9, F.revive);
  } else if (step === 1) {
    ring(5.5, 2.4, 11, F.revive);
    ring(3.5, 1.5, 11, F.reviveGreen);
    sparkle(5, 7, F.reviveHi);
    sparkle(11, 6, F.revive);
  } else if (step === 2) {
    ring(6.5, 2.8, 9, F.reviveGreen);
    sparkle(4, 4, F.reviveHi);
    sparkle(12, 5, F.revive);
    sparkle(8, 2, F.reviveHi);
    b.set(8, 8, F.revive);
  } else {
    for (const [x, y, c] of [[3, 3, F.revive], [12, 2, F.reviveHi], [8, 1, F.revive], [14, 6, F.reviveGreen], [1, 7, F.reviveGreen], [5, 8, F.reviveHi], [11, 9, F.revive]] as const) b.set(x, y, c);
    b.set(8, 5, F.reviveHi);
  }
  return b;
}

function marker(): Bitmap {
  const b = new Bitmap(8, 8);
  const rows: Array<[number, number]> = [[0, 7], [1, 6], [1, 6], [2, 5], [2, 5], [3, 4], [3, 4], [3, 4]];
  rows.forEach(([x0, x1], y) => b.hline(x0, x1, y, WHITE));
  return b;
}

function shadow(): Bitmap {
  const b = new Bitmap(16, 8);
  b.ellipse(8, 4, 7.4, 3.4, F.shadow);
  return b;
}

/** Étoile à quatre branches 8×8 (éclats de lancement des spéciaux, soin) : blanche au cœur, dorée aux pointes ; à teinter. */
function star(): Bitmap {
  return Bitmap.fromRows(
    ['...gg...', '...ww...', '...ww...', 'gwwwwwwg', 'gwwwwwwg', '...ww...', '...ww...', '...gg...'],
    { w: WHITE, g: F.hit },
  );
}

/** Braise 4×4 (particule de feu), orange vif avec un cœur jaune. */
function ember(): Bitmap {
  return Bitmap.fromRows(['.gg.', 'gwwg', 'gwwg', '.gg.'], { w: F.hit, g: F.hitLow });
}

/** Frames d'effets. */
export function buildFxFrames(): Record<string, Bitmap> {
  const out: Record<string, Bitmap> = {
    fx_slash_up: slash('up'),
    fx_slash_down: slash('down'),
    fx_slash_left: slash('left'),
    fx_slash_right: slash('right'),
    fx_arrow: arrow(),
    fx_bolt: bolt(),
    fx_orb: orb(),
    fx_shard: shard(),
    fx_heal: heal(),
    fx_marker: marker(),
    fx_shadow: shadow(),
    fx_star: star(),
    fx_ember: ember(),
  };
  for (let i = 0; i < 3; i++) out[`fx_hit_${i}`] = hit(i);
  for (let i = 0; i < 4; i++) out[`fx_revive_${i}`] = revive(i);
  void OUTLINE;
  return out;
}
