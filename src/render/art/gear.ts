/**
 * Art de l'ÉQUIPEMENT (PROVISOIRE, généré par code) : 15 objets (5 emplacements simples × 3 niveaux) + 10 accessoires (lanterne, aimant, cor de guerre × 3 niveaux, anneau du
 * vampire niveau III) + 3 bonus temporaires (potion de vitesse, éclair de rage, étoile), chacun en deux tailles tirées du MÊME dessin 6×6 :
 *  - `gear_icon_<emplacement>_<niveau>` (8×8) : icône du HUD (rangée d'équipement sous les cœurs) ;
 *  - `gear_<emplacement>_<niveau>` (16×16) : objet au sol, dessin agrandi ×2, SANS cadre ni boîte (le halo doux est un effet de rendu, comme pour les cœurs).
 * Emplacements : boots (Sandales / Bottes de cuir / Bottes ailées), protection (Casque / Bouclier / Armure), artifact (Amulette / Sablier / Orbe),
 * magic (Potion / Baguette / Chapeau de sorcier), weapon (Épée / Hache / Arc).
 * Accessoires : `gear_accessory_<sorte>_<niveau>` / `gear_icon_accessory_<sorte>_<niveau>` (la teinte de l'objet suit le niveau : cuir, métal, or ; l'anneau est doré).
 * Bonus temporaires : `gear_buff_<sorte>` (16×16) / `gear_icon_buff_<sorte>` (8×8), sorte = speed | rage | star.
 * Style identique au reste de l'atlas : contour sombre 1 px, aplats, aucun pixel semi-transparent ; couleurs de `GEAR_COLORS` (liste blanche).
 */
import { GEAR_COLORS as C, OUTLINE } from '../palettes';
import { Bitmap, type ColorMap } from './bitmap';

/** Une lettre par couleur dans les dessins ci-dessous. */
const GEAR_MAP: ColorMap = {
  a: C.leatherDark,
  b: C.leather,
  c: C.leatherLight,
  n: C.metalDark,
  m: C.metal,
  M: C.metalLight,
  d: C.goldDark,
  g: C.gold,
  G: C.goldLight,
  u: C.blue,
  U: C.blueLight,
  p: C.purple,
  P: C.purpleLight,
  e: C.green,
  E: C.greenLight,
  r: C.red,
  W: C.wing,
  w: C.white,
};

/** Emplacements dessinés (les 5 emplacements simples). */
export const GEAR_ART_SLOTS = ['boots', 'protection', 'artifact', 'magic', 'weapon'] as const;

/** Dessins 6×6 par emplacement et niveau (indice 0 = niveau I). */
const DRAWINGS: Readonly<Record<(typeof GEAR_ART_SLOTS)[number], readonly (readonly string[])[]>> = {
  // Sandales / Bottes de cuir / Bottes ailées
  boots: [
    ['..bb..', '..bb..', '..bb..', '.bbbc.', 'bbbbb.', '.a.a..'],
    ['.bbb..', '.bcb..', '.bbb..', '.bbb..', 'bbbbb.', 'aaaaa.'],
    ['W.bbb.', 'WWbcb.', '.Wbbb.', '..bbb.', '.bbbbb', '.ggggg'],
  ],
  // Casque / Bouclier / Armure
  protection: [
    ['.mmmm.', 'mMMmmm', 'mmmmmm', 'mnnnnm', 'mn..nm', '......'],
    ['gggggg', 'guuUug', 'guuUug', '.guug.', '..gug.', '...g..'],
    ['m.mm.m', 'mMmmMm', '.mMMm.', '.mmmm.', '.mnnm.', '.mmmm.'],
  ],
  // Amulette / Sablier / Orbe
  artifact: [
    ['.n..n.', '..nn..', '..nn..', '.dggd.', '.gGGg.', '..gg..'],
    ['gggggg', '.uUUu.', '..uu..', '..UU..', '.uuuu.', 'gggggg'],
    ['.pPPp.', 'pPwPpp', 'pPPppp', 'pppppp', '.pppp.', '.gggg.'],
  ],
  // Potion / Baguette / Chapeau de sorcier
  magic: [
    ['..nn..', '..mm..', '.eEEe.', 'eEeeee', 'eeeeee', '.eeee.'],
    ['....Gg', '...Gg.', '..bg..', '.bb...', 'bb....', 'b.....'],
    ['...pp.', '..pPp.', '..ppp.', '.pppp.', '.dddd.', 'pppppp'],
  ],
  // Épée / Hache / Arc
  weapon: [
    ['.....M', '....MM', '...MM.', '.gMM..', '.bg...', 'b.....'],
    ['.mmm..', 'mMMmb.', 'mMmmb.', '.mm.b.', '...b..', '...b..'],
    ['.bb...', 'b..b..', 'bwwwww', 'b..b..', '.bb...', '......'],
  ],
};

/** Dessin 6×6 (sans contour) d'un objet. */
function art(slot: (typeof GEAR_ART_SLOTS)[number], level: number): Bitmap {
  const b = new Bitmap(6, 6);
  b.stamp(DRAWINGS[slot][level - 1], GEAR_MAP, 0, 0);
  return b;
}

/** Icône 8×8 du HUD : le dessin 6×6 au centre, contour sombre. */
function icon(slot: (typeof GEAR_ART_SLOTS)[number], level: number): Bitmap {
  const b = new Bitmap(8, 8);
  b.blit(art(slot, level), 1, 1);
  return b.outline(OUTLINE);
}

/** Objet au sol 16×16 : le même dessin agrandi ×2 (pixels carrés 2×2), centré, contour sombre, aucun cadre ni fond. */
function world(slot: (typeof GEAR_ART_SLOTS)[number], level: number): Bitmap {
  const src = art(slot, level);
  const b = new Bitmap(16, 16);
  for (let y = 0; y < src.h; y++) {
    for (let x = 0; x < src.w; x++) {
      const c = src.get(x, y);
      if (c < 0) continue;
      b.rect(2 + x * 2, 2 + y * 2, 2, 2, c);
    }
  }
  return b.outline(OUTLINE);
}

/** Accessoires dessinés (l'anneau du vampire n'existe qu'au niveau III). */
export const GEAR_ART_ACCESSORIES = ['lantern', 'magnet', 'warhorn', 'vampire'] as const;
/** Bonus temporaires dessinés. */
export const GEAR_ART_BUFFS = ['speed', 'rage', 'star'] as const;

/** Dessins 6×6 des accessoires (x / X = teinte du NIVEAU : cuir, métal, or). */
const ACCESSORY_DRAWINGS: Readonly<Record<(typeof GEAR_ART_ACCESSORIES)[number], readonly string[]>> = {
  // Lanterne : cadre teinté, flamme dorée
  lantern: ['..nn..', '.nxxn.', 'nxGGxn', 'nxGgxn', '.nxxn.', '.nnnn.'],
  // Aimant à cœurs : fer à cheval rouge, pôles teintés
  magnet: ['xx..xx', 'xx..xx', 'rr..rr', 'rr..rr', '.rrrr.', '..rr..'],
  // Cor de guerre : pavillon teinté, embouchure sombre
  warhorn: ['.....X', '...xxX', '..xxxx', '.xxxx.', 'xxx...', 'nn....'],
  // Anneau du vampire : anneau d'or, gemme rouge
  vampire: ['..rr..', '..rr..', '.gggg.', 'g....g', 'g....g', '.gggg.'],
};

/** Dessins 6×6 des bonus temporaires. */
const BUFF_DRAWINGS: Readonly<Record<(typeof GEAR_ART_BUFFS)[number], readonly string[]>> = {
  // Potion de vitesse : fiole bleue, reflet blanc
  speed: ['..nn..', '..uu..', '.uUUu.', 'uUwUuu', 'uuuuuu', '.uuuu.'],
  // Éclair de rage : éclair rouge liseré d'or
  rage: ['...rr.', '..rGr.', '.rrGr.', '..rrrr', '..rr..', '.r....'],
  // Étoile : étoile dorée
  star: ['..GG..', 'GGGGGG', '.GggG.', '.gGGg.', 'gg..gg', 'g....g'],
};

/** Teintes (x, X) d'un accessoire selon son niveau : I cuir, II métal, III or. */
function levelTint(level: number): ColorMap {
  if (level >= 3) return { x: C.gold, X: C.goldLight };
  if (level === 2) return { x: C.metal, X: C.metalLight };
  return { x: C.leather, X: C.leatherLight };
}

/** Dessin 6×6 d'un accessoire. */
function accessoryArt(kind: (typeof GEAR_ART_ACCESSORIES)[number], level: number): Bitmap {
  const b = new Bitmap(6, 6);
  b.stamp(ACCESSORY_DRAWINGS[kind], { ...GEAR_MAP, ...levelTint(level) }, 0, 0);
  return b;
}

/** Dessin 6×6 d'un bonus temporaire. */
function buffArt(kind: (typeof GEAR_ART_BUFFS)[number]): Bitmap {
  const b = new Bitmap(6, 6);
  b.stamp(BUFF_DRAWINGS[kind], GEAR_MAP, 0, 0);
  return b;
}

/** Icône 8×8 d'un dessin 6×6 : au centre, contour sombre. */
function iconOf(src: Bitmap): Bitmap {
  const b = new Bitmap(8, 8);
  b.blit(src, 1, 1);
  return b.outline(OUTLINE);
}

/** Objet au sol 16×16 d'un dessin 6×6 : agrandi ×2, centré, contour sombre, aucun cadre ni fond. */
function worldOf(src: Bitmap): Bitmap {
  const b = new Bitmap(16, 16);
  for (let y = 0; y < src.h; y++) {
    for (let x = 0; x < src.w; x++) {
      const c = src.get(x, y);
      if (c < 0) continue;
      b.rect(2 + x * 2, 2 + y * 2, 2, 2, c);
    }
  }
  return b.outline(OUTLINE);
}

/** Nom de la frame 16×16 d'un accessoire au sol. */
export function accessoryWorldFrame(kind: string, level: number): string {
  return `gear_accessory_${kind}_${level}`;
}

/** Nom de la frame 8×8 de l'icône de HUD d'un accessoire. */
export function accessoryIconFrame(kind: string, level: number): string {
  return `gear_icon_accessory_${kind}_${level}`;
}

/** Nom de la frame 16×16 d'un bonus temporaire au sol. */
export function buffWorldFrame(kind: string): string {
  return `gear_buff_${kind}`;
}

/** Nom de la frame 8×8 de l'icône de HUD d'un bonus temporaire. */
export function buffIconFrame(kind: string): string {
  return `gear_icon_buff_${kind}`;
}

/** Nom de la frame 16×16 d'un objet au sol. */
export function gearWorldFrame(slot: string, level: number): string {
  return `gear_${slot}_${level}`;
}

/** Nom de la frame 8×8 d'une icône de HUD. */
export function gearIconFrame(slot: string, level: number): string {
  return `gear_icon_${slot}_${level}`;
}

/** Frames de l'équipement. */
export function buildGearFrames(): Record<string, Bitmap> {
  const out: Record<string, Bitmap> = {};
  for (const slot of GEAR_ART_SLOTS) {
    for (const level of [1, 2, 3]) {
      out[gearWorldFrame(slot, level)] = world(slot, level);
      out[gearIconFrame(slot, level)] = icon(slot, level);
    }
  }
  for (const kind of GEAR_ART_ACCESSORIES) {
    for (const level of kind === 'vampire' ? [3] : [1, 2, 3]) {
      const art6 = accessoryArt(kind, level);
      out[accessoryWorldFrame(kind, level)] = worldOf(art6);
      out[accessoryIconFrame(kind, level)] = iconOf(art6);
    }
  }
  for (const kind of GEAR_ART_BUFFS) {
    const art6 = buffArt(kind);
    out[buffWorldFrame(kind)] = worldOf(art6);
    out[buffIconFrame(kind)] = iconOf(art6);
  }
  return out;
}
