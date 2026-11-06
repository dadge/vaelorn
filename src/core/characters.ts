/**
 * Définitions des 8 personnages jouables (lecture seule — ne jamais muter `CHARACTERS`).
 *
 * Stats : force/résistance 1..10 (voir balance.ts pour les formules : PV = 50 + 10 × résistance,
 * dégâts = (6 + 2.5 × force) × attack.damageMult). Aucun couple (force, résistance) n'est dupliqué.
 * Clés i18n : character.<id>.name | .class | .desc. Sprites : hero_<id>_<dir>_<0|1>, hero_<id>_<dir>_attack, hero_<id>_downed.
 *
 * Pour ranged : `attack.range` ≈ projectile.speed × lifeMs / 1000.
 */
import type { CharacterDef, CharacterId, PlayerState, SpecialDef } from './types';

/** Ordre canonique (écran de sélection) : famille d'abord, puis personnages libres. */
export const CHARACTER_IDS: readonly CharacterId[] = [
  'david',
  'sandrine',
  'romain',
  'valentine',
  'aelith',
  'brokk',
  'grok',
  'mira',
];

function key(id: CharacterId, part: 'name' | 'class' | 'desc'): string {
  return `character.${id}.${part}`;
}

/** Clé i18n d'une attaque spéciale : character.<id>.special.name | .desc. */
function sKey(id: CharacterId, part: 'name' | 'desc'): string {
  return `character.${id}.special.${part}`;
}

/** Définitions par id. */
export const CHARACTERS: Readonly<Record<CharacterId, CharacterDef>> = {
  // Guerrier : fort et très résistant, épée à large arc.
  david: {
    id: 'david',
    nameKey: key('david', 'name'),
    classKey: key('david', 'class'),
    descKey: key('david', 'desc'),
    family: true,
    color: 0x4a7fd4,
    strength: 8,
    resistance: 9,
    speed: 68,
    reviveTimeMult: 1,
    attack: { kind: 'melee', cooldownMs: 450, range: 24, arcDeg: 100, animMs: 180, damageMult: 0.8 },
    special: { kind: 'whirlwind', nameKey: sKey('david', 'name'), descKey: sKey('david', 'desc'), cooldownMs: 14000, damageMult: 3.5, radius: 46, range: 46, animMs: 280 },
  },
  // Magicienne : le plus fort, très fragile, orbe perforant à distance.
  sandrine: {
    id: 'sandrine',
    nameKey: key('sandrine', 'name'),
    classKey: key('sandrine', 'class'),
    descKey: key('sandrine', 'desc'),
    family: true,
    color: 0xb04ad4,
    strength: 10,
    resistance: 2,
    speed: 72,
    reviveTimeMult: 1,
    attack: {
      kind: 'ranged',
      cooldownMs: 650,
      range: 200,
      animMs: 200,
      damageMult: 0.75,
      projectile: { kind: 'orb', speed: 200, lifeMs: 1000, radius: 4, pierce: true },
    },
    special: { kind: 'fireNova', nameKey: sKey('sandrine', 'name'), descKey: sKey('sandrine', 'desc'), cooldownMs: 18000, damageMult: 6, radius: 58, range: 64, animMs: 400 },
  },
  // Éclaireur : le plus rapide, lame courte et vive.
  romain: {
    id: 'romain',
    nameKey: key('romain', 'name'),
    classKey: key('romain', 'class'),
    descKey: key('romain', 'desc'),
    family: true,
    color: 0x3fae5a,
    strength: 5,
    resistance: 5,
    speed: 106,
    reviveTimeMult: 1,
    attack: { kind: 'melee', cooldownMs: 320, range: 18, arcDeg: 90, animMs: 140, damageMult: 0.8 },
    special: { kind: 'dash', nameKey: sKey('romain', 'name'), descKey: sKey('romain', 'desc'), cooldownMs: 9000, damageMult: 3, radius: 10, range: 90, animMs: 250, invulnMs: 350 },
  },
  // Guérisseuse-archère : projectile « heal » qui blesse peu, relève plus vite.
  valentine: {
    id: 'valentine',
    nameKey: key('valentine', 'name'),
    classKey: key('valentine', 'class'),
    descKey: key('valentine', 'desc'),
    family: true,
    color: 0xf2a0c8,
    strength: 4,
    resistance: 4,
    speed: 80,
    reviveTimeMult: 0.65,
    attack: {
      kind: 'ranged',
      cooldownMs: 500,
      range: 190,
      animMs: 180,
      damageMult: 0.6,
      projectile: { kind: 'heal', speed: 190, lifeMs: 1000, radius: 4, pierce: false },
    },
    special: { kind: 'healNova', nameKey: sKey('valentine', 'name'), descKey: sKey('valentine', 'desc'), cooldownMs: 20000, damageMult: 2.5, radius: 72, range: 72, animMs: 500, healFraction: 0.4 },
  },
  // Elfe archère : flèches rapides à distance.
  aelith: {
    id: 'aelith',
    nameKey: key('aelith', 'name'),
    classKey: key('aelith', 'class'),
    descKey: key('aelith', 'desc'),
    family: false,
    color: 0x58d8a0,
    strength: 7,
    resistance: 3,
    speed: 86,
    reviveTimeMult: 1,
    attack: {
      kind: 'ranged',
      cooldownMs: 400,
      range: 234,
      animMs: 160,
      damageMult: 0.75,
      projectile: { kind: 'arrow', speed: 260, lifeMs: 900, radius: 3, pierce: false },
    },
    special: { kind: 'arrowFan', nameKey: sKey('aelith', 'name'), descKey: sKey('aelith', 'desc'), cooldownMs: 13000, damageMult: 0.6, radius: 3, range: 170, animMs: 300, count: 9, spreadDeg: 40 },
  },
  // Nain tank : lent, hache à très large arc mais courte portée.
  brokk: {
    id: 'brokk',
    nameKey: key('brokk', 'name'),
    classKey: key('brokk', 'class'),
    descKey: key('brokk', 'desc'),
    family: false,
    color: 0xc87838,
    strength: 6,
    resistance: 10,
    speed: 58,
    reviveTimeMult: 1,
    attack: { kind: 'melee', cooldownMs: 550, range: 20, arcDeg: 140, animMs: 220, damageMult: 0.9 },
    special: { kind: 'quake', nameKey: sKey('brokk', 'name'), descKey: sKey('brokk', 'desc'), cooldownMs: 16000, damageMult: 3, radius: 62, range: 62, animMs: 450, stunMs: 1300 },
  },
  // Troll : massue lente, énormes dégâts.
  grok: {
    id: 'grok',
    nameKey: key('grok', 'name'),
    classKey: key('grok', 'class'),
    descKey: key('grok', 'desc'),
    family: false,
    color: 0x6a9a3a,
    strength: 9,
    resistance: 7,
    speed: 54,
    reviveTimeMult: 1,
    attack: { kind: 'melee', cooldownMs: 800, range: 26, arcDeg: 120, animMs: 300, damageMult: 1.2 },
    special: { kind: 'smash', nameKey: sKey('grok', 'name'), descKey: sKey('grok', 'desc'), cooldownMs: 17000, damageMult: 6, radius: 46, range: 46, animMs: 350, arcDeg: 150 },
  },
  // Maraudeuse : très rapide, dagues frénétiques de courte portée.
  mira: {
    id: 'mira',
    nameKey: key('mira', 'name'),
    classKey: key('mira', 'class'),
    descKey: key('mira', 'desc'),
    family: false,
    color: 0x9a2a4a,
    strength: 6,
    resistance: 3,
    speed: 102,
    reviveTimeMult: 1,
    attack: { kind: 'melee', cooldownMs: 240, range: 16, arcDeg: 110, animMs: 120, damageMult: 0.5 },
    special: { kind: 'bladeDance', nameKey: sKey('mira', 'name'), descKey: sKey('mira', 'desc'), cooldownMs: 12000, damageMult: 1.3, radius: 38, range: 38, animMs: 600, count: 5, invulnMs: 600 },
  },
};

/** Liste ordonnée (david, sandrine, romain, valentine, aelith, brokk, grok, mira). */
export const CHARACTER_LIST: readonly CharacterDef[] = CHARACTER_IDS.map((id) => CHARACTERS[id]);

/**
 * Définition d'un personnage. Lance une erreur si l'id est inconnu (donnée corrompue).
 * @param id identifiant de personnage
 */
export function getCharacter(id: CharacterId): CharacterDef {
  const def = CHARACTERS[id];
  if (!def) throw new Error(`Personnage inconnu : ${String(id)}`);
  return def;
}

/**
 * Attaque spéciale d'un personnage (`undefined` si le personnage n'en a pas — ne devrait pas arriver pour les 8 personnages).
 * @param characterId identifiant de personnage
 */
export function getSpecialDef(characterId: CharacterId): SpecialDef | undefined {
  return CHARACTERS[characterId]?.special;
}

/**
 * Niveau de recharge de l'attaque spéciale pour le HUD : 0 = vide (vient d'être utilisée) … 1 = prête.
 * Pur ; 0 si le personnage n'a pas de spécial ; toujours borné à [0, 1].
 * @param p état du joueur (`specialCooldownMs` est lu)
 * @param character définition du personnage du joueur
 */
export function specialFraction(p: Pick<PlayerState, 'specialCooldownMs'>, character: CharacterDef): number {
  const def = character.special;
  if (!def || !(def.cooldownMs > 0)) return 0;
  const cd = Number.isFinite(p.specialCooldownMs) ? p.specialCooldownMs : 0;
  return Math.min(1, Math.max(0, 1 - cd / def.cooldownMs));
}
