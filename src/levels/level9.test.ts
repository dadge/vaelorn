import { describe, expect, it } from 'vitest';

import { getCharacter } from '../core/characters';
import { TILE } from '../core/constants';
import { RoomGrid } from '../core/grid';
import { isBossKind, isMiniBossKind } from '../core/enemies';
import { collectRequiredI18nKeys, validateBossStructure, validateLevel } from '../core/levelValidation';
import { effectiveLeverWindowMs } from '../core/mechanisms';
import { resolveSlot } from '../core/slots';
import type { BlockDef, DoorDef, EnemyKind, EnemySpawnDef, LeverDef, LevelDef, MechanismDef, PlateDef, RoomDef, RunePuzzleDef, TileXY } from '../core/types';
import { getDictionary } from '../i18n/i18n';
import { level1 } from './level1';
import { level2 } from './level2';
import { level3 } from './level3';
import { level9 } from './level9';

/**
 * Niveau 9 — « Le Clocher de l'Aube » (thème `brass`) : dernier niveau du jeu.
 * Signature : LA CADENCE (leviers à fenêtre échelonnés), vagues déclenchées par un mécanisme (contrepoids), runes à vision
 * partagée + zone à tenir (verger des échos). Aucune tactique de boss, aucune salle sombre, aucun brasero.
 */

// ───────────────────────────── Aides ─────────────────────────────

const PLAYER_COUNTS = [1, 2, 3, 4] as const;
const ALLOWED_SPEAKERS = ['narrator', 'aldric', 'lyssa', 'heroes'];
const MAX_TEXT = 90;
const COLOR_FR = ['bleu', 'rouge', 'vert', 'jaune'] as const;
const COLOR_EN = ['blue', 'red', 'green', 'yellow'] as const;
const GROUND_KINDS: readonly EnemyKind[] = ['slime', 'skeleton', 'spider', 'knight'];
const ROOM_IDS = ['forecourt', 'gallery', 'bellguard', 'counterweight', 'echoorchard', 'nave', 'ropehall', 'belfry'];
const BOSS_ROOMS = ['bellguard', 'ropehall', 'belfry'];

function room(id: string): RoomDef {
  const r = level9.rooms.find((x) => x.id === id);
  if (!r) throw new Error(`salle introuvable : ${id}`);
  return r;
}

function enemiesAt(r: RoomDef, n: number): EnemySpawnDef[] {
  return r.enemies.filter((e) => (e.minPlayers ?? 1) <= n);
}

function totalEnemies(level: LevelDef, n: number): number {
  return level.rooms.reduce((sum, r) => sum + enemiesAt(r, n).length, 0);
}

function isFloor(r: RoomDef, x: number, y: number): boolean {
  const g = r.layout[y]?.[x];
  return g === '.' || g === ',';
}

function levers(r: RoomDef): LeverDef[] {
  return r.mechanisms.filter((m): m is LeverDef => m.type === 'lever');
}

function plates(r: RoomDef): PlateDef[] {
  return r.mechanisms.filter((m): m is PlateDef => m.type === 'plate');
}

function door(r: RoomDef, id: string): DoorDef {
  const d = r.mechanisms.find((m) => m.id === id);
  if (!d || d.type !== 'door') throw new Error(`porte introuvable : ${r.id}.${id}`);
  return d;
}

/** Distance (en tuiles) d'une tuile au rectangle de tuiles le plus proche (0 si dedans). */
function distToRect(t: TileXY, rc: { x: number; y: number; w: number; h: number }): number {
  const dx = Math.max(rc.x - t[0], 0, t[0] - (rc.x + rc.w - 1));
  const dy = Math.max(rc.y - t[1], 0, t[1] - (rc.y + rc.h - 1));
  return Math.hypot(dx, dy);
}

/** Temps (ms) mis par un héros de vitesse moyenne (David) pour parcourir `tiles` tuiles à vol d'oiseau. */
function travelMs(tiles: number): number {
  return ((tiles * TILE) / getCharacter('david').speed) * 1000;
}

function readPart(lang: 'fr' | 'en'): Record<string, string> {
  return Object.fromEntries(Object.entries(getDictionary(lang)).filter(([k]) => k.includes('level9')));
}

function placeholders(value: string): string[] {
  return Array.from(new Set(Array.from(value.matchAll(/\{(\w+)\}/g), (m) => m[1]))).sort();
}

// ───────────────────────────── Validité globale ─────────────────────────────

describe('level9 — validation', () => {
  it('validateLevel (dictionnaires fr + en, orateurs) ne retourne aucune erreur (1, 2, 3 et 4 joueurs)', () => {
    const errors = validateLevel(level9, {
      dictionaries: { fr: getDictionary('fr'), en: getDictionary('en') },
      checkSpeakers: true,
    });
    expect(errors).toEqual([]);
  });

  it('validateBossStructure : au moins 2 demi-boss à tous les nombres de joueurs, salle finale avec boss', () => {
    expect(validateBossStructure(level9, { minMiniBosses: 2 })).toEqual([]);
  });

  it('identité du niveau : id, thème brass partout, nom fr/en, durée estimée', () => {
    expect(level9.id).toBe('level9');
    expect(level9.theme).toBe('brass');
    expect(level9.nameKey).toBe('level.level9.name');
    expect(getDictionary('fr')['level.level9.name']).toBe("Le Clocher de l'Aube");
    expect(getDictionary('en')['level.level9.name']).toBe('The Dawn Belfry');
    expect(level9.estimatedMinutes).toBeGreaterThanOrEqual(5);
    expect(level9.estimatedMinutes).toBeLessThanOrEqual(10);
    for (const r of level9.rooms) expect(r.theme, r.id).toBe('brass');
  });

  it('compte 8 salles, dans l\'ordre prévu', () => {
    expect(level9.rooms.map((r) => r.id)).toEqual(ROOM_IDS);
  });

  it('chaque salle est vaste (54..86 × 40..52 tuiles), avec 4 spawns groupés, un indice et au moins deux panneaux', () => {
    for (const r of level9.rooms) {
      const w = r.layout[0].length;
      const h = r.layout.length;
      expect(w, `${r.id} largeur`).toBeGreaterThanOrEqual(54);
      expect(w, `${r.id} largeur`).toBeLessThanOrEqual(86);
      expect(h, `${r.id} hauteur`).toBeGreaterThanOrEqual(40);
      expect(h, `${r.id} hauteur`).toBeLessThanOrEqual(52);
      expect(r.playerSpawns.length, `${r.id} spawns`).toBeGreaterThanOrEqual(4);
      const [sx, sy] = r.playerSpawns[0];
      for (const [x, y] of r.playerSpawns) expect(Math.max(Math.abs(x - sx), Math.abs(y - sy)), `${r.id} spawns groupés`).toBeLessThanOrEqual(1);
      expect(r.layout[0]).toMatch(/^#+$/);
      expect(r.layout[h - 1]).toMatch(/^#+$/);
      for (const row of r.layout) {
        expect(row[0]).toBe('#');
        expect(row[w - 1]).toBe('#');
      }
      expect(r.nameKey, r.id).toBe(`room.level9.${r.id}.name`);
      expect(r.introHintKey, r.id).toBe(`hintroom.level9.${r.id}`);
      expect((r.signs ?? []).length, `${r.id} panneaux`).toBeGreaterThanOrEqual(2);
      expect((r.decor ?? []).length, `${r.id} décors`).toBeGreaterThan(0);
    }
  });

  it('les tuiles de porte forment un passage du sol dans la grille', () => {
    for (const r of level9.rooms) {
      const grid = new RoomGrid(r.layout);
      for (const m of r.mechanisms) {
        if (m.type !== 'door') continue;
        expect(m.tiles.length, `${r.id}.${m.id}`).toBe(4);
        for (const [x, y] of m.tiles) expect(grid.blocksMovement(x, y), `${r.id}.${m.id} [${x},${y}]`).toBe(false);
      }
    }
  });

  it('est sérialisable en JSON sans perte (aucune fonction, aucune classe)', () => {
    expect(JSON.parse(JSON.stringify(level9))).toEqual(level9);
  });
});

// ───────────────────────────── Objectifs ─────────────────────────────

describe('level9 — objectifs personnels', () => {
  it('un objectif par slot 0..3, de types variés, répartis sur au moins 3 salles', () => {
    expect(level9.objectives.map((o) => o.slot).sort()).toEqual([0, 1, 2, 3]);
    expect(new Set(level9.objectives.map((o) => o.kind)).size).toBeGreaterThanOrEqual(3);
    expect(new Set(level9.objectives.map((o) => o.roomId)).size).toBeGreaterThanOrEqual(3);
    expect(level9.objectives.find((o) => o.id === 'bell')).toMatchObject({ slot: 0, kind: 'mechanism', roomId: 'forecourt', mechanismId: 'forecourtDoor' });
    expect(level9.objectives.find((o) => o.id === 'measure')).toMatchObject({ slot: 1, kind: 'zone', roomId: 'echoorchard', zoneId: 'measureZone', seconds: 15 });
    expect(level9.objectives.find((o) => o.id === 'sweep')).toMatchObject({ slot: 2, kind: 'kills', roomId: 'nave', count: 6 });
    expect(level9.objectives.find((o) => o.id === 'weights')).toMatchObject({ slot: 3, kind: 'mechanism', roomId: 'counterweight', mechanismId: 'counterweightDoor' });
  });

  it('les salles porteuses d\'objectifs ne se quittent qu\'une fois ceux-ci accomplis', () => {
    expect(room('forecourt').exit.requires).toContain('forecourtDoor');
    expect(room('counterweight').exit.requires).toContain('counterweightDoor');
    expect(room('nave').exit.requires).toContain('obj:sweep');
    expect(door(room('echoorchard'), 'orchardDoor').requires).toContain('obj:measure');
    expect(room('echoorchard').exit.requires).toContain('orchardDoor');
  });

  it('aucune exigence « zone: » (sémantique non éprouvée en jeu) : on passe par « obj: »', () => {
    for (const r of level9.rooms) {
      const reqs = [...r.exit.requires, ...r.mechanisms.flatMap((m) => (m.type === 'door' ? m.requires : [])), ...r.enemies.map((e) => e.when ?? '')];
      for (const q of reqs) expect(q.startsWith('zone:'), `${r.id} ${q}`).toBe(false);
    }
  });
});

// ───────────────────────────── La cadence ─────────────────────────────

describe('level9 — la cadence (leviers à fenêtre échelonnés)', () => {
  const gallery = room('gallery');
  const ls = levers(gallery);
  const gate = door(gallery, 'galleryDoor');

  it('six leviers à fenêtre : 2 de base sans propriétaire + 4 de couleur ; la porte les exige TOUS', () => {
    expect(ls).toHaveLength(6);
    for (const l of ls) expect(l.windowMs ?? 0, l.id).toBeGreaterThan(0);
    const base = ls.filter((l) => l.ownerSlot === undefined);
    expect(base.map((l) => l.id).sort()).toEqual(['galleryLeverA', 'galleryLeverB']);
    for (const l of base) expect(l.minPlayers).toBeUndefined();
    expect(ls.filter((l) => l.ownerSlot !== undefined).map((l) => l.ownerSlot).sort()).toEqual([0, 1, 2, 3]);
    expect([...gate.requires].sort()).toEqual(ls.map((l) => l.id).sort());
    expect(gallery.exit.requires).toEqual(expect.arrayContaining(['galleryDoor', 'clear']));
  });

  it('les fenêtres sont échelonnées par la géométrie : plus un levier est loin de la porte, plus sa fenêtre est longue (strictement)', () => {
    const doorX = gate.tiles[0][0];
    const byDistance = [...ls].sort((a, b) => doorX - a.tile[0] - (doorX - b.tile[0]));
    // du plus proche au plus lointain : fenêtres strictement croissantes
    for (let i = 1; i < byDistance.length; i++) {
      expect(byDistance[i].windowMs as number, `${byDistance[i].id} plus loin que ${byDistance[i - 1].id}`).toBeGreaterThan(byDistance[i - 1].windowMs as number);
    }
    // le levier le plus lointain est un levier de base (jamais « absent » à un petit nombre de joueurs)
    expect(byDistance[byDistance.length - 1].ownerSlot).toBeUndefined();
  });

  it('SEUL, un héros tire les trois leviers qui existent (A, bleu, B) dans la fenêtre élargie : fenêtre ≥ 1,6 × trajet restant + 3 s', () => {
    const solo = ls.filter((l) => (l.minPlayers ?? 1) <= 1).sort((a, b) => a.tile[0] - b.tile[0]);
    expect(solo.map((l) => l.id)).toEqual(['galleryLeverA', 'galleryLeverBlue', 'galleryLeverB']);
    for (let i = 0; i < solo.length; i++) {
      let remaining = 0;
      for (let j = i; j + 1 < solo.length; j++) remaining += Math.hypot(solo[j + 1].tile[0] - solo[j].tile[0], solo[j + 1].tile[1] - solo[j].tile[1]);
      const win = effectiveLeverWindowMs(gallery, 1, solo[i]);
      expect(win, `${solo[i].id} fenêtre effective (${win} ms) vs trajet restant ${Math.round(travelMs(remaining))} ms`).toBeGreaterThanOrEqual(1.6 * travelMs(remaining) + 3000);
    }
  });

  it('à chaque nombre de joueurs, chaque levier a une fenêtre effective d\'au moins 8 s (élargie en proportion des leviers par joueur)', () => {
    for (const n of PLAYER_COUNTS) {
      for (const l of ls.filter((x) => (x.minPlayers ?? 1) <= n)) expect(effectiveLeverWindowMs(gallery, n, l), `n=${n} ${l.id}`).toBeGreaterThanOrEqual(8000);
    }
  });

  it('les leviers de couleur ne tombent qu\'à leur propriétaire : minPlayers = slot + 1 ; le levier bleu est le levier de base', () => {
    for (const l of ls) {
      if (l.ownerSlot === undefined) continue;
      expect(l.minPlayers ?? 1, l.id).toBe(l.ownerSlot + 1);
    }
    expect(ls.find((l) => l.id === 'galleryLeverBlue')?.ownerSlot).toBe(0);
  });

  it('le parvis apprend la fenêtre : levier loin de la porte, plaque devant la porte, fenêtre ≥ 1,3 × le trajet levier → plaque', () => {
    const fc = room('forecourt');
    const lever = levers(fc)[0];
    const plate = plates(fc)[0];
    expect(levers(fc)).toHaveLength(1);
    expect(plates(fc)).toHaveLength(1);
    expect(plate.minPlayers).toBeUndefined();
    expect(lever.minPlayers).toBeUndefined();
    const d = door(fc, 'forecourtDoor');
    expect([...d.requires].sort()).toEqual(['forecourtLever', 'forecourtPlate']);
    const path = Math.hypot(plate.tile[0] - lever.tile[0], plate.tile[1] - lever.tile[1]);
    expect(path).toBeGreaterThanOrEqual(30); // « loin » de la plaque
    expect(effectiveLeverWindowMs(fc, 1, lever)).toBeGreaterThanOrEqual(1.3 * travelMs(path));
    // le héros jouable le plus LENT (Grok) garde une marge réelle, pas seulement David : trajet à vol d'oiseau × 1,3 (le chemin réel est plus long que la ligne droite)
    const slowest = Math.min(...(['david', 'sandrine', 'romain', 'valentine', 'aelith', 'brokk', 'grok', 'mira'] as const).map((c) => getCharacter(c).speed));
    const slowMs = ((path * TILE) / slowest) * 1000;
    expect(effectiveLeverWindowMs(fc, 1, lever), `héros le plus lent (${slowest} px/s) : trajet ${Math.round(slowMs)} ms`).toBeGreaterThanOrEqual(1.3 * slowMs);
  });
});

// ───────────────────────────── Les contrepoids : vagues déclenchées par un mécanisme ─────────────────────────────

describe('level9 — contrepoids (blocs 2×2, plaques et vagues)', () => {
  const cw = room('counterweight');
  const blocks = cw.mechanisms.filter((m): m is BlockDef => m.type === 'block');

  it('trois blocs 2×2, une plaque au fond de chaque couloir fermé ; un bloc ne peut avancer que vers l\'est (aucun blocage définitif)', () => {
    expect(blocks).toHaveLength(3);
    expect(plates(cw)).toHaveLength(3);
    for (const b of blocks) {
      expect(b.playersRequired, b.id).toBeUndefined(); // 2 pousseurs, plafonnés au nombre de joueurs (1 seul si l'équipe est seule)
      const letter = b.id.replace('counterweightBlock', '');
      const plate = plates(cw).find((p) => p.id === `counterweightPlate${letter}`);
      expect(plate, `plaque de ${b.id}`).toBeDefined();
      const [bx, by] = b.tile;
      const [px, py] = plate!.tile;
      expect(py, `${b.id} : plaque sur la ligne du bloc`).toBeGreaterThanOrEqual(by);
      expect(py, `${b.id} : plaque sur la ligne du bloc`).toBeLessThanOrEqual(by + 1);
      expect(px - bx, `${b.id} : au moins 5 tuiles de poussée`).toBeGreaterThanOrEqual(5);
      // couloir de 2 tuiles de large, du bloc à la plaque : sol ; haut, bas et fond : mur
      for (let x = bx; x <= px; x++) {
        for (const y of [by, by + 1]) expect(isFloor(cw, x, y), `${b.id} couloir [${x},${y}]`).toBe(true);
        expect(isFloor(cw, x, by - 1), `${b.id} mur nord [${x},${by - 1}]`).toBe(false);
        expect(isFloor(cw, x, by + 2), `${b.id} mur sud [${x},${by + 2}]`).toBe(false);
      }
      for (const y of [by, by + 1]) expect(isFloor(cw, px + 1, y), `${b.id} fond du couloir [${px + 1},${y}]`).toBe(false);
      // le bloc entre par l'ouest (la salle) : le côté est est fermé, donc personne ne peut le repousser vers l'ouest
      for (const y of [by, by + 1]) expect(isFloor(cw, bx - 1, y), `${b.id} entrée [${bx - 1},${y}]`).toBe(true);
    }
  });

  it('chaque plaque déclenche une vague : tous les ennemis conditionnés de la salle sont attachés à une plaque, aucune zone d\'embuscade', () => {
    const plateIds = plates(cw).map((p) => p.id);
    expect(cw.zones ?? []).toHaveLength(0);
    const waved = cw.enemies.filter((e) => e.when !== undefined);
    expect(waved.length).toBeGreaterThan(0);
    for (const e of waved) expect(plateIds, `${e.kind} [${e.tile}] when=${e.when}`).toContain(e.when);
    for (const id of plateIds) {
      const w = waved.filter((e) => e.when === id);
      expect(w.filter((e) => (e.minPlayers ?? 1) <= 1).length, `${id} à 1 joueur`).toBeGreaterThanOrEqual(8);
      expect(w.length, `${id} à 4 joueurs`).toBeLessThanOrEqual(16);
      expect(w.length, `${id} à 4 joueurs`).toBeGreaterThanOrEqual(14);
    }
    // quelques rôdeurs d'emblée avant les vagues
    expect(cw.enemies.filter((e) => e.when === undefined).length).toBeGreaterThanOrEqual(5);
  });

  it('les vagues surgissent à plus de 12 tuiles de l\'arrivée et la salle n\'a aucun abîme', () => {
    for (const e of cw.enemies) {
      for (const s of cw.playerSpawns) expect(Math.hypot(e.tile[0] - s[0], e.tile[1] - s[1]), `${e.kind} [${e.tile}]`).toBeGreaterThanOrEqual(12);
    }
    expect(cw.layout.some((row) => row.includes('~'))).toBe(false);
  });

  it('la porte des contrepoids exige les trois plaques ; la sortie exige la porte et la salle vidée', () => {
    const d = door(cw, 'counterweightDoor');
    expect([...d.requires].sort()).toEqual(plates(cw).map((p) => p.id).sort());
    expect(cw.exit.requires).toEqual(expect.arrayContaining(['counterweightDoor', 'clear']));
  });
});

// ───────────────────────────── Le verger des échos : runes à vision partagée + mesure ─────────────────────────────

describe('level9 — verger des échos (runes lues par UN héros, zone à tenir)', () => {
  const orchard = room('echoorchard');
  const runes = orchard.mechanisms.find((m): m is RunePuzzleDef => m.type === 'runePuzzle') as RunePuzzleDef;

  it('la séquence de 4 runes n\'est visible que du héros rouge (slot 1) ; seul, c\'est l\'unique joueur qui la lit', () => {
    expect(runes).toBeDefined();
    expect(runes.visibleToSlot).toBe(1);
    expect(runes.sequence).toHaveLength(4);
    expect(new Set(runes.sequence).size).toBe(4);
    expect(runes.pedestals.length).toBeGreaterThanOrEqual(5);
    for (const s of runes.sequence) expect(runes.pedestals.some((p) => p.symbol === s), `piédestal ${s}`).toBe(true);
    expect(new Set(runes.pedestals.map((p) => p.symbol)).size).toBe(runes.pedestals.length);
    expect(resolveSlot(runes.visibleToSlot, 1)).toBe(0);
    expect(resolveSlot(runes.visibleToSlot, 2)).toBe(1);
  });

  it('l\'affichage est loin de tous les piédestaux (au moins 15 tuiles) : il faut annoncer la séquence à voix haute', () => {
    for (const p of runes.pedestals) {
      expect(Math.hypot(p.tile[0] - runes.displayTile[0], p.tile[1] - runes.displayTile[1]), `piédestal ${p.symbol}`).toBeGreaterThanOrEqual(15);
    }
  });

  it('tenir la mesure : zone objective du héros rouge, exigée avec les runes par la porte du verger', () => {
    expect(orchard.zones).toHaveLength(1);
    const zone = (orchard.zones ?? [])[0];
    const obj = level9.objectives.find((o) => o.id === 'measure');
    expect(obj).toMatchObject({ slot: 1, kind: 'zone', zoneId: zone.id });
    const d = door(orchard, 'orchardDoor');
    expect([...d.requires].sort()).toEqual(['obj:measure', 'orchardRunes']);
    expect(orchard.exit.requires).toEqual(expect.arrayContaining(['orchardDoor', 'clear']));
  });

  it('l\'embuscade de la zone surgit à plus de 6 tuiles de la zone, et elle ne se contourne pas (la zone est exigée par la porte, la sortie exige « clear »)', () => {
    const zone = (orchard.zones ?? [])[0];
    const ambush = orchard.enemies.filter((e) => e.when === `enter:${zone.id}`);
    expect(ambush.length).toBeGreaterThan(0);
    expect(ambush.filter((e) => (e.minPlayers ?? 1) <= 1).length).toBeGreaterThanOrEqual(4);
    for (const e of ambush) expect(distToRect(e.tile, zone.rect), `${e.kind} [${e.tile}]`).toBeGreaterThanOrEqual(6);
    // toute autre condition d'apparition est inexistante : les gardiens sont présents d'emblée
    for (const e of orchard.enemies) expect([undefined, `enter:${zone.id}`], `${e.kind} [${e.tile}]`).toContain(e.when);
    // la porte exige la mesure tenue : sans entrer dans la zone, impossible de sortir
    expect(door(orchard, 'orchardDoor').requires).toContain('obj:measure');
  });
});

// ───────────────────────────── La nef : abîmes et plaques de couleur ─────────────────────────────

describe('level9 — nef aux fosses', () => {
  const nave = room('nave');

  it('bandes d\'abîme, ennemis TERRESTRES uniquement (aucun volant ne reste suspendu au-dessus du vide)', () => {
    expect(nave.layout.some((row) => row.includes('~'))).toBe(true);
    for (const e of nave.enemies) expect(GROUND_KINDS, `${e.kind} [${e.tile}]`).toContain(e.kind);
  });

  it('quatre plaques de couleur (minPlayers = slot + 1) que la porte exige ENSEMBLE ; un coup de chasse du héros vert', () => {
    const ps = plates(nave);
    expect(ps).toHaveLength(4);
    expect(ps.map((p) => p.colorSlot).sort()).toEqual([0, 1, 2, 3]);
    for (const p of ps) expect(p.minPlayers ?? 1, p.id).toBe((p.colorSlot as number) + 1);
    expect([...door(nave, 'naveDoor').requires].sort()).toEqual(ps.map((p) => p.id).sort());
    expect(nave.exit.requires).toEqual(expect.arrayContaining(['naveDoor', 'clear', 'obj:sweep']));
    expect(level9.objectives.find((o) => o.id === 'sweep')?.slot).toBe(2);
  });

  it('les chevaliers n\'apparaissent jamais en solo ni à deux (leur nombre ne dépend que des joueurs)', () => {
    const knights = nave.enemies.filter((e) => e.kind === 'knight');
    expect(knights.length).toBeGreaterThanOrEqual(2);
    for (const k of knights) expect(k.minPlayers ?? 1).toBeGreaterThanOrEqual(3);
  });
});

// ───────────────────────────── Ennemis ─────────────────────────────

describe('level9 — ennemis', () => {
  it('nettement plus d\'ennemis que les niveaux 1 à 3 : planchers de 170 à 1 joueur et de 295 à 4 joueurs (≥ +25 % du maximum)', () => {
    expect(totalEnemies(level9, 1)).toBeGreaterThanOrEqual(170);
    expect(totalEnemies(level9, 4)).toBeGreaterThanOrEqual(295);
    for (const n of [1, 4]) {
      const max = Math.max(totalEnemies(level1, n), totalEnemies(level2, n), totalEnemies(level3, n));
      expect(totalEnemies(level9, n), `n=${n}`).toBeGreaterThanOrEqual(Math.ceil(max * 1.25));
    }
  });

  it('le nombre d\'ennemis ne dépend que du nombre de joueurs (minPlayers) et croît strictement avec lui ; ratio n1/n4 dans ]0,5 ; 0,75[', () => {
    const counts = PLAYER_COUNTS.map((n) => totalEnemies(level9, n));
    for (let i = 1; i < counts.length; i++) expect(counts[i]).toBeGreaterThan(counts[i - 1]);
    expect(counts[0] / counts[3]).toBeGreaterThan(0.5);
    expect(counts[0] / counts[3]).toBeLessThan(0.75);
    for (const r of level9.rooms) {
      for (const e of r.enemies) {
        expect(Object.keys(e).every((k) => ['kind', 'tile', 'wave', 'when', 'minPlayers'].includes(k)), `${r.id} ${e.kind}`).toBe(true);
        if (e.minPlayers !== undefined) expect([2, 3, 4]).toContain(e.minPlayers);
      }
    }
  });

  it('aucun ennemi à moins de 12 tuiles de l\'arrivée des joueurs', () => {
    for (const r of level9.rooms) {
      for (const e of r.enemies) {
        for (const s of r.playerSpawns) {
          expect(Math.hypot(e.tile[0] - s[0], e.tile[1] - s[1]), `${r.id} ${e.kind} [${e.tile}] vs spawn [${s}]`).toBeGreaterThanOrEqual(12);
        }
      }
    }
  });

  it('AUCUNE tactique de boss dans ce niveau (EnemySpawnDef.tactics absent partout)', () => {
    for (const r of level9.rooms) for (const e of r.enemies) expect('tactics' in e, `${r.id} ${e.kind}`).toBe(false);
  });

  it('aucune salle sombre, aucun brasero', () => {
    for (const r of level9.rooms) {
      expect(r.dark, r.id).not.toBe(true);
      expect(r.mechanisms.some((m) => m.type === 'brazier'), r.id).toBe(false);
    }
  });

  it('les embuscades du niveau sont rares : seule celle du verger est conditionnée à une zone', () => {
    const ambushRooms = level9.rooms.filter((r) => r.enemies.some((e) => e.when?.startsWith('enter:')));
    expect(ambushRooms.map((r) => r.id)).toEqual(['echoorchard']);
  });
});

// ───────────────────────────── Demi-boss et boss ─────────────────────────────

describe('level9 — demi-boss et boss de fin', () => {
  it('deux demi-boss (pyromancien puis spectre), présents à tous les nombres de joueurs, sortie sur « clear »', () => {
    const where = level9.rooms
      .map((r) => ({ r, minis: r.enemies.filter((e) => isMiniBossKind(e.kind)) }))
      .filter((x) => x.minis.length > 0);
    expect(where.map((x) => x.r.id)).toEqual(['bellguard', 'ropehall']);
    expect(where.map((x) => x.minis[0].kind)).toEqual(['pyromancer', 'wraith']);
    for (const w of where) {
      expect(w.minis).toHaveLength(1);
      expect(w.minis[0].minPlayers).toBeUndefined();
      expect(w.r.exit.requires).toContain('clear');
    }
  });

  it('arènes pures (aucun mécanisme, aucun abîme) ; sbires étagés par joueurs : ≥ 12 dès 1 joueur pour un demi-boss', () => {
    for (const id of BOSS_ROOMS) {
      const r = room(id);
      expect(r.mechanisms, `${id} sans mécanisme`).toHaveLength(0);
      expect(r.layout.some((row) => row.includes('~')), `${id} sans abîme`).toBe(false);
      const minions = PLAYER_COUNTS.map((n) => enemiesAt(r, n).filter((e) => !isMiniBossKind(e.kind) && !isBossKind(e.kind)).length);
      for (let i = 1; i < minions.length; i++) expect(minions[i], `${id} sbires`).toBeGreaterThan(minions[i - 1]);
      expect(minions[3], `${id} sbires à 4`).toBeGreaterThanOrEqual(20);
      if (id !== 'belfry') expect(minions[0], `${id} sbires à 1`).toBeGreaterThanOrEqual(12);
    }
  });

  it('le spectre est escorté de volants (chauves-souris, feux follets) ; le pyromancien de sbires variés', () => {
    const wraithRoom = room('ropehall');
    for (const e of wraithRoom.enemies) expect(['wraith', 'bat', 'wisp'], `${e.kind}`).toContain(e.kind);
    expect(new Set(room('bellguard').enemies.map((e) => e.kind)).size).toBeGreaterThanOrEqual(5);
  });

  it('exactement 3 cristaux de soin par arène de demi-boss ou de boss (2 sans minPlayers + 1 à 3 joueurs), aucun ailleurs', () => {
    for (const r of level9.rooms) {
      const crystals = r.healCrystals ?? [];
      if (!BOSS_ROOMS.includes(r.id)) {
        expect(crystals, r.id).toHaveLength(0);
        continue;
      }
      expect(crystals, r.id).toHaveLength(3);
      expect(crystals.filter((c) => c.minPlayers === undefined)).toHaveLength(2);
      expect(crystals.filter((c) => c.minPlayers === 3)).toHaveLength(1);
      expect(new Set(crystals.map((c) => c.id)).size).toBe(3);
    }
  });

  it('salle finale : exit.final scellée, seigneur du Néant présent à tous les n, exigences complètes ; seule salle finale et seul boss de fin', () => {
    const last = level9.rooms[level9.rooms.length - 1];
    expect(last.id).toBe('belfry');
    expect(last.exit.final).toBe(true);
    expect(last.exit.sealed).toBe(true);
    expect(last.exit.requires).toEqual(['clear', 'obj:bell', 'obj:measure', 'obj:sweep', 'obj:weights']);
    const bosses = last.enemies.filter((e) => isBossKind(e.kind));
    expect(bosses).toHaveLength(1);
    expect(bosses[0].kind).toBe('voidlord');
    expect(bosses[0].minPlayers).toBeUndefined();
    expect(level9.rooms.filter((r) => r.exit.final)).toHaveLength(1);
    expect(level9.rooms.slice(0, -1).some((r) => r.enemies.some((e) => isBossKind(e.kind)))).toBe(false);
  });
});

// ───────────────────────────── Coopération adaptative ─────────────────────────────

describe('level9 — coop adaptative (1 à 4 joueurs)', () => {
  it('plaques, leviers, clés, portes à clé et braseros de couleur : minPlayers = slot + 1', () => {
    for (const r of level9.rooms) {
      for (const m of r.mechanisms) {
        let slot: number | undefined;
        if (m.type === 'plate') slot = m.colorSlot;
        else if (m.type === 'lever' || m.type === 'key') slot = m.ownerSlot;
        else if (m.type === 'brazier') slot = m.ownerSlot;
        else if (m.type === 'door' && m.keyId) {
          const k = r.mechanisms.find((x) => x.id === m.keyId);
          slot = k && k.type === 'key' ? k.ownerSlot : undefined;
        }
        if (slot === undefined) continue;
        expect(m.minPlayers ?? 1, `${r.id}.${m.id}`).toBe(slot + 1);
      }
    }
  });

  it('chaque salle à mécanismes a au moins un mécanisme coopératif sans minPlayers (jouable seul)', () => {
    for (const r of level9.rooms) {
      if (r.mechanisms.length === 0) continue;
      const solo = r.mechanisms.filter((m: MechanismDef) => ['plate', 'lever', 'block', 'runePuzzle'].includes(m.type) && (m.minPlayers ?? 1) <= 1);
      expect(solo.length, r.id).toBeGreaterThan(0);
    }
  });

  it('les consignes citent la bonne couleur de slot (objectifs, plaques et leviers de couleur)', () => {
    const fr = getDictionary('fr');
    const en = getDictionary('en');
    for (const o of level9.objectives) {
      expect(fr[o.labelKey].toLowerCase(), o.id).toContain(`héros ${COLOR_FR[o.slot]}`);
      expect(en[o.labelKey].toLowerCase(), o.id).toContain(`${COLOR_EN[o.slot]} hero`);
    }
    for (const p of plates(room('nave'))) {
      const slot = p.colorSlot as number;
      expect(fr[p.labelKey as string], p.id).toContain(['bleue', 'rouge', 'verte', 'jaune'][slot]);
      expect(en[p.labelKey as string].toLowerCase(), p.id).toContain(COLOR_EN[slot]);
    }
    for (const l of levers(room('gallery'))) {
      if (l.ownerSlot === undefined) continue;
      expect(fr[l.labelKey as string], l.id).toContain(COLOR_FR[l.ownerSlot]);
      expect(en[l.labelKey as string].toLowerCase(), l.id).toContain(COLOR_EN[l.ownerSlot]);
    }
    expect(fr['sign.level9.echoorchard.seer']).toMatch(/rouge/);
    expect(en['sign.level9.echoorchard.seer']).toMatch(/red/);
    expect(fr['sign.level9.counterweight.door']).toMatch(/jaune/);
    expect(fr['sign.level9.nave.sweep']).toMatch(/vert/);
    // cohérence avec les données : verger = slot 1 (rouge), contrepoids = slot 3 (jaune), nef = slot 2 (vert)
    expect(level9.objectives.find((o) => o.id === 'measure')?.slot).toBe(1);
    expect(level9.objectives.find((o) => o.id === 'weights')?.slot).toBe(3);
    expect(level9.objectives.find((o) => o.id === 'sweep')?.slot).toBe(2);
  });
});

// ───────────────────────────── i18n ─────────────────────────────

describe('level9 — textes (parts i18n)', () => {
  const fr = readPart('fr');
  const en = readPart('en');
  const base = getDictionary('fr');

  it('parité fr/en stricte, aucune valeur vide, mêmes {placeholders}', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(fr).sort());
    for (const k of Object.keys(fr)) {
      expect(fr[k].trim().length, `fr ${k}`).toBeGreaterThan(0);
      expect(en[k].trim().length, `en ${k}`).toBeGreaterThan(0);
      expect(placeholders(en[k]), `placeholders ${k}`).toEqual(placeholders(fr[k]));
    }
  });

  it('toutes les clés requises par le niveau sont fournies (les orateurs existants viennent de la base), et aucune clé orpheline', () => {
    const required = new Set(collectRequiredI18nKeys(level9, { checkSpeakers: true }).map((r) => r.key));
    const own = new Set([...required].filter((k) => !k.startsWith('speaker.')));
    expect(new Set(Object.keys(fr))).toEqual(own);
    for (const k of required) {
      expect(Object.prototype.hasOwnProperty.call(getDictionary('en'), k), `en ${k}`).toBe(true);
      expect(base[k], k).toBeTruthy();
    }
  });

  it('clés bien formées, préfixées par la convention de DESIGN.md §6, aucun nouvel orateur', () => {
    const prefixes = ['level.level9.', 'room.level9.', 'objective.level9.', 'mech.level9.', 'sign.level9.', 'hintroom.level9.'];
    for (const k of Object.keys(fr)) {
      expect(k, k).toMatch(/^[A-Za-z0-9_]+(\.[A-Za-z0-9_-]+)+$/);
      expect(prefixes.some((p) => k.startsWith(p)), k).toBe(true);
    }
  });

  it('textes courts et lisibles à l\'écran (≤ 90 caractères) dans les deux langues', () => {
    for (const dict of [fr, en]) {
      for (const [k, v] of Object.entries(dict)) expect(v.length, `${k} (${v.length})`).toBeLessThanOrEqual(MAX_TEXT);
    }
  });

  it('histoire : intro de 4 répliques (3 à 5), outro de 4 (2 à 4), numérotées, orateurs autorisés', () => {
    expect(level9.intro.length).toBeGreaterThanOrEqual(3);
    expect(level9.intro.length).toBeLessThanOrEqual(5);
    expect(level9.outro.length).toBeGreaterThanOrEqual(2);
    expect(level9.outro.length).toBeLessThanOrEqual(4);
    level9.intro.forEach((l, i) => expect(l.textKey).toBe(`level.level9.intro.${i + 1}`));
    level9.outro.forEach((l, i) => expect(l.textKey).toBe(`level.level9.outro.${i + 1}`));
    for (const l of [...level9.intro, ...level9.outro]) expect(ALLOWED_SPEAKERS).toContain(l.speaker);
  });

  it('dernier niveau du jeu : l\'outro est la conclusion (cloche, aube, lanterne et dessert) et reprend mot pour mot la fin de la saga', () => {
    expect(fr['level.level9.outro.1']).toMatch(/cloche/);
    expect(fr['level.level9.outro.1']).toMatch(/aube/i);
    expect(en['level.level9.outro.1']).toMatch(/bell/);
    expect(fr['level.level9.outro.2']).toBe("C'est fini... L'ombre ancienne s'apaise. Chacun de vous a éclairé la route des autres.");
    expect(fr['level.level9.outro.3']).toBe("Le Cristal brille plus fort que jamais. Vaelorn ne craindra plus ni l'ombre ni la nuit !");
    expect(fr['level.level9.outro.4']).toBe('On rentre ? Cette fois, c\'est moi qui porte la lanterne... et le dessert.');
    expect(en['level.level9.outro.2']).toBe('It is over... The ancient shadow is at peace. Each of you lit the road for the others.');
    expect(en['level.level9.outro.3']).toBe('The Crystal shines brighter than ever. Vaelorn will fear neither shadow nor night!');
    expect(en['level.level9.outro.4']).toBe('Shall we go home? This time I carry the lantern... and dessert.');
  });
});

// ───────────────────────────── Déterminisme des données ─────────────────────────────

describe('level9 — données déterministes', () => {
  it('les spawns sont sur le sol et aucun mécanisme n\'est un doublon d\'id dans une salle', () => {
    for (const r of level9.rooms) {
      const ids = r.mechanisms.map((m: MechanismDef) => m.id);
      expect(new Set(ids).size, r.id).toBe(ids.length);
      for (const [x, y] of r.playerSpawns) expect(isFloor(r, x, y), `${r.id} spawn [${x},${y}]`).toBe(true);
    }
  });

  it('tous les ennemis sont posés sur du sol', () => {
    for (const r of level9.rooms) for (const e of r.enemies) expect(isFloor(r, e.tile[0], e.tile[1]), `${r.id} ${e.kind} [${e.tile}]`).toBe(true);
  });
});
