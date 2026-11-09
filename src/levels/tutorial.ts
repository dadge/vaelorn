/**
 * Niveau-tutoriel « La cour d'entraînement » (thème `crypt`, ~5 min, sans boss).
 *
 * Données pures (`LevelDef`), joué par `GameScene` avec 2 joueurs simulés (le joueur + un PARTENAIRE SCRIPTÉ, voir
 * `src/tutorial/`). Ce niveau n'est JAMAIS dans `LEVELS` (src/levels/index.ts) : il n'apparaît ni dans la campagne, ni dans
 * le menu « niveau de départ », ni dans les sauvegardes. Il est quand même validé par `validateLevel` (tests).
 *
 * Une salle = un chapitre (7 salles). Contraintes de conception :
 *  - `playerSpawns[0]` = le joueur, `playerSpawns[1]` = le partenaire scripté (les deux autres servent de bourrage : la
 *    validation exige 4 spawns reliés) ;
 *  - toutes les cibles du partenaire sont sur la RANGÉE 6 (centre des passages de 5 tuiles, rangées 4..8) : il avance en
 *    ligne droite, sans pathfinding ;
 *  - chaque salle porte un vrai mécanisme (règle « mécanisme coopératif » du validateur) ou un brasero allumé DE DÉCOR
 *    (`lit: true`, jamais exigé : sans torche à recharger, il n'affiche aucune invite) ;
 *  - slots d'objectifs : avec 2 joueurs, `slot % 2` → slots 0 et 2 pour le joueur, 1 et 3 pour le partenaire ;
 *  - la dernière salle est la salle finale : sa sortie exige les 4 objectifs personnels.
 *
 * Aucune chaîne affichée ici : uniquement des clés i18n (src/i18n/parts/tutorial-level.*.json).
 * Convention de tuiles : `[colonne, ligne]`. Glyphes : '#' mur, 'o' pilier, '.' sol.
 */
import type { DecorDef, LevelDef, MechanismDef, RoomDef, TileXY } from '../core/types';

/** Identifiant du niveau-tutoriel (hors campagne). */
export const TUTORIAL_LEVEL_ID = 'tutorial';

/** Graine fixe de la simulation du tutoriel (jamais `Date.now`) : le tutoriel est rejouable à l'identique. */
export const TUTORIAL_SEED = 0x7e11a;

/** Rangée (tuile) sur laquelle le partenaire se déplace : centre des passages dans les murs. */
export const TUTORIAL_LANE_ROW = 6;

// ───────────────────────────── Aides de géométrie ─────────────────────────────

interface WallColumn {
  /** Colonne du mur. */
  x: number;
  /** Rangées [première, dernière] du passage (incluses). */
  gap: [number, number];
}

/** Salle rectangulaire entourée de murs, avec colonnes de mur percées d'un passage et piliers. */
function hall(w: number, h: number, walls: readonly WallColumn[] = [], pillars: readonly TileXY[] = []): string[] {
  const rows: string[][] = [];
  for (let y = 0; y < h; y++) {
    const row: string[] = [];
    for (let x = 0; x < w; x++) row.push(x === 0 || y === 0 || x === w - 1 || y === h - 1 ? '#' : '.');
    rows.push(row);
  }
  for (const col of walls) {
    for (let y = 1; y < h - 1; y++) if (y < col.gap[0] || y > col.gap[1]) rows[y][col.x] = '#';
  }
  for (const [px, py] of pillars) rows[py][px] = 'o';
  return rows.map((r) => r.join(''));
}

/** Tuiles verticales d'une porte dans une colonne de mur (rangées incluses). */
function doorColumn(x: number, y0: number, y1: number): TileXY[] {
  const out: TileXY[] = [];
  for (let y = y0; y <= y1; y++) out.push([x, y]);
  return out;
}

/** Brasero allumé de DÉCOR (non exigé) : satisfait la règle « mécanisme coopératif » sans rien demander au joueur. */
function decorBrazier(tile: TileXY): MechanismDef {
  return { id: 'br_decor', type: 'brazier', tile, lit: true, labelKey: 'mech.tutorial.br_decor' };
}

const wallTorches = (xs: readonly number[]): DecorDef[] => xs.map((x) => ({ type: 'torch' as const, tile: [x, 0] as TileXY }));

/** Taille standard d'une salle du tutoriel : 36 × 12 tuiles (la vue à 1 joueur montre ≈ 26,7 × 15 tuiles). */
const W = 36;
const H = 12;
/** Rectangle de sortie standard (à l'extrémité est, centré sur la rangée 6). */
const EXIT = { x: 33, y: 4, w: 2, h: 5 };
/** Les 4 spawns : [0] joueur, [1] partenaire, [2][3] bourrage. */
const STD_SPAWNS: TileXY[] = [[3, 5], [4, 6], [3, 7], [5, 7]];

// ───────────────────────────── Salle 1 : la cour (déplacement, panneau, objectifs, combat, spécial) ─────────────────────────────

const yard: RoomDef = {
  id: 't_yard',
  nameKey: 'room.tutorial.t_yard.name',
  theme: 'crypt',
  layout: hall(W, H, [], [[14, 2], [14, 9], [22, 2], [22, 9]]),
  playerSpawns: STD_SPAWNS,
  // 4 limaces lentes, loin du partenaire (≥ 18 tuiles) : 2 au départ, 2 quand les premières sont vaincues.
  enemies: [
    { kind: 'slime', tile: [24, 4] },
    { kind: 'slime', tile: [24, 8] },
    { kind: 'slime', tile: [28, 5], wave: 1 },
    { kind: 'slime', tile: [28, 8], wave: 1 },
  ],
  mechanisms: [decorBrazier([18, 2])],
  signs: [{ id: 's_yard', tile: [9, 5], textKey: 'sign.tutorial.s_yard' }],
  decor: wallTorches([6, 18, 30]),
  exit: { rect: EXIT, requires: ['clear'] },
};

// ───────────────────────────── Salle 2 : l'atelier (levier, plaques, porte, objectif d'équipe) ─────────────────────────────

const workshop: RoomDef = {
  id: 't_workshop',
  nameKey: 'room.tutorial.t_workshop.name',
  theme: 'crypt',
  layout: hall(W, H, [{ x: 16, gap: [4, 8] }, { x: 26, gap: [4, 8] }]),
  playerSpawns: STD_SPAWNS,
  enemies: [],
  mechanisms: [
    { id: 'lv', type: 'lever', tile: [13, 2], labelKey: 'mech.tutorial.lv' },
    { id: 'd_lever', type: 'door', tiles: doorColumn(16, 4, 8), requires: ['lv'], labelKey: 'mech.tutorial.d_lever' },
    // plaque A derrière la herse (le joueur), plaque B devant (le partenaire : 2 joueurs requis)
    { id: 'pA', type: 'plate', tile: [20, 6], colorSlot: 0, labelKey: 'mech.tutorial.pA' },
    { id: 'pB', type: 'plate', tile: [11, 6], colorSlot: 1, minPlayers: 2, labelKey: 'mech.tutorial.pB' },
    { id: 'd_plates', type: 'door', tiles: doorColumn(26, 4, 8), requires: ['pA', 'pB'], labelKey: 'mech.tutorial.d_plates' },
    // levier rouge : réservé au 2e joueur (le partenaire) → objectif personnel `o_lever`
    { id: 'lv1', type: 'lever', tile: [8, 6], ownerSlot: 1, minPlayers: 2, labelKey: 'mech.tutorial.lv1' },
  ],
  signs: [{ id: 's_workshop', tile: [6, 3], textKey: 'sign.tutorial.s_workshop' }],
  decor: wallTorches([8, 24]),
  // `obj:` fait apparaître la ligne « Objectifs personnels accomplis x/y (en attente : …) » du bloc d'objectifs de salle
  exit: { rect: EXIT, requires: ['d_plates', 'obj:o_kills', 'obj:o_lever'] },
};

// ───────────────────────────── Salle 3 : la voûte (bloc poussable, clé et porte de couleur) ─────────────────────────────

const vault: RoomDef = {
  id: 't_vault',
  nameKey: 'room.tutorial.t_vault.name',
  theme: 'crypt',
  layout: hall(W, H, [{ x: 16, gap: [4, 8] }, { x: 26, gap: [4, 8] }]),
  playerSpawns: STD_SPAWNS,
  enemies: [],
  mechanisms: [
    // un seul héros suffit dans le tutoriel (dans un vrai donjon, deux héros poussent ensemble)
    { id: 'b', type: 'block', tile: [8, 3], playersRequired: 1, labelKey: 'mech.tutorial.block' },
    { id: 'so', type: 'socket', tile: [14, 3], blockId: 'b', labelKey: 'mech.tutorial.so' },
    { id: 'd_block', type: 'door', tiles: doorColumn(16, 4, 8), requires: ['so'], labelKey: 'mech.tutorial.d_block' },
    { id: 'k0', type: 'key', tile: [21, 3], ownerSlot: 0, doorId: 'kd', labelKey: 'mech.tutorial.k0' },
    { id: 'kd', type: 'door', tiles: doorColumn(26, 4, 8), requires: [], keyId: 'k0', labelKey: 'mech.tutorial.kd' },
  ],
  signs: [{ id: 's_vault', tile: [5, 3], textKey: 'sign.tutorial.s_vault' }],
  decor: wallTorches([8, 24]),
  exit: { rect: EXIT, requires: ['d_block', 'obj:o_key'] },
};

// ───────────────────────────── Salle 4 : la salle sombre (torche, braseros) ─────────────────────────────

const dark: RoomDef = {
  id: 't_dark',
  nameKey: 'room.tutorial.t_dark.name',
  theme: 'crypt',
  layout: hall(W, H),
  playerSpawns: STD_SPAWNS,
  enemies: [],
  dark: true,
  mechanisms: [
    { id: 'br_a', type: 'brazier', tile: [14, 4], lit: true, labelKey: 'mech.tutorial.br_a' },
    { id: 'br_b', type: 'brazier', tile: [22, 4], labelKey: 'mech.tutorial.br_b' },
  ],
  signs: [{ id: 's_dark', tile: [7, 5], textKey: 'sign.tutorial.s_dark' }],
  // torches de décor : zone de départ éclairée (exigence du validateur : ≤ 6 tuiles d'une source de lumière)
  decor: [
    { type: 'torch', tile: [2, 3] },
    { type: 'torch', tile: [2, 9] },
    { type: 'torch', tile: [31, 3] },
    { type: 'torch', tile: [31, 9] },
  ],
  exit: { rect: EXIT, requires: ['br_b'] },
};

// ───────────────────────────── Salle 5 : le relevage (le partenaire tombe) ─────────────────────────────

const revive: RoomDef = {
  id: 't_revive',
  nameKey: 'room.tutorial.t_revive.name',
  theme: 'crypt',
  layout: hall(W, H, [{ x: 31, gap: [4, 8] }]),
  // le partenaire démarre loin (x = 22) : il tombe 1,2 s après l'arrivée
  playerSpawns: [[3, 5], [22, 5], [3, 7], [4, 7]],
  enemies: [],
  mechanisms: [
    decorBrazier([10, 2]),
    // levier RÉSERVÉ au partenaire (comme `lv1`) qui ouvre la herse de la sortie : tant que le partenaire est à terre il ne peut
    // pas le tirer. Le relevage devient donc incontournable (sans lui la sortie reste fermée), au lieu d'un simple conseil.
    { id: 'lv_r', type: 'lever', tile: [27, 6], ownerSlot: 1, minPlayers: 2, labelKey: 'mech.tutorial.lv_r' },
    { id: 'd_revive', type: 'door', tiles: doorColumn(31, 4, 8), requires: ['lv_r'], labelKey: 'mech.tutorial.d_revive' },
  ],
  decor: wallTorches([6, 18, 30]),
  exit: { rect: EXIT, requires: ['d_revive'] },
};

// ───────────────────────────── Salle 6 : l'appel (grande salle : le partenaire est hors de la vue) ─────────────────────────────

const callPillars: TileXY[] = [];
for (let x = 8; x <= 56; x += 8) callPillars.push([x, 2], [x, 10]);

const call: RoomDef = {
  id: 't_call',
  nameKey: 'room.tutorial.t_call.name',
  theme: 'crypt',
  layout: hall(64, 13, [], callPillars),
  // le partenaire est à 47 tuiles du joueur : hors champ (la vue montre ≈ 26,7 tuiles de large)
  playerSpawns: [[3, 6], [50, 6], [3, 8], [4, 9]],
  enemies: [],
  mechanisms: [decorBrazier([30, 3])],
  decor: wallTorches([10, 30, 50]),
  exit: { rect: { x: 61, y: 5, w: 2, h: 4 }, requires: [] },
};

// ───────────────────────────── Salle 7 : le sceau (mort d'équipe, objectifs, sortie finale) ─────────────────────────────

const seal: RoomDef = {
  id: 't_seal',
  nameKey: 'room.tutorial.t_seal.name',
  theme: 'crypt',
  layout: hall(W, H),
  playerSpawns: [[3, 5], [5, 6], [3, 7], [5, 8]],
  enemies: [],
  mechanisms: [decorBrazier([10, 2])],
  zones: [{ id: 'z_seal', rect: { x: 15, y: 4, w: 4, h: 5 } }],
  signs: [{ id: 's_seal', tile: [8, 4], textKey: 'sign.tutorial.s_seal' }],
  decor: wallTorches([6, 18, 30]),
  exit: { rect: EXIT, requires: ['obj:o_kills', 'obj:o_lever', 'obj:o_key', 'obj:o_zone'], final: true, sealed: true },
};

// ───────────────────────────── Niveau ─────────────────────────────

/** Le niveau-tutoriel (hors campagne). */
export const tutorialLevel: LevelDef = {
  id: TUTORIAL_LEVEL_ID,
  nameKey: 'level.tutorial.name',
  theme: 'crypt',
  estimatedMinutes: 5,
  // texte jamais joué (le tutoriel n'a pas de dialogue) mais exigé par la validation
  intro: [{ speaker: 'aldric', textKey: 'level.tutorial.intro.1' }],
  outro: [{ speaker: 'aldric', textKey: 'level.tutorial.outro.1' }],
  rooms: [yard, workshop, vault, dark, revive, call, seal],
  objectives: [
    { id: 'o_kills', slot: 0, roomId: 't_yard', kind: 'kills', count: 2, labelKey: 'objective.tutorial.o_kills' },
    { id: 'o_lever', slot: 1, roomId: 't_workshop', kind: 'mechanism', mechanismId: 'lv1', labelKey: 'objective.tutorial.o_lever' },
    { id: 'o_key', slot: 2, roomId: 't_vault', kind: 'mechanism', mechanismId: 'kd', labelKey: 'objective.tutorial.o_key' },
    { id: 'o_zone', slot: 3, roomId: 't_seal', kind: 'zone', zoneId: 'z_seal', seconds: 4, labelKey: 'objective.tutorial.o_zone' },
  ],
};
