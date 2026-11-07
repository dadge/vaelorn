import { describe, expect, it } from 'vitest';

import { SIM_STEP_MS, TILE } from '../core/constants';
import { RoomGrid } from '../core/grid';
import { isBossKind, isMiniBossKind } from '../core/enemies';
import { collectRequiredI18nKeys, validateBossStructure, validateLevel } from '../core/levelValidation';
import { createRoomMechanisms, isMechanismSolved, tileCenterPx, updateMechanisms } from '../core/mechanisms';
import { createPlayerState } from '../core/players';
import { resolveSlot } from '../core/slots';
import type {
  EnemySpawnDef,
  LevelDef,
  LightBridgeDef,
  LightBridgeState,
  MechanismDef,
  PlayerId,
  PlayerState,
  RoomDef,
  TileXY,
} from '../core/types';
import { getDictionary } from '../i18n/i18n';
import { LEVELS, getLevel } from './index';
import { level1 } from './level1';
import { level2 } from './level2';
import { level3 } from './level3';
import { level6 } from './level6';

// ───────────────────────────── Aides ─────────────────────────────

const PLAYER_COUNTS = [1, 2, 3, 4] as const;
const ALLOWED_SPEAKERS = ['narrator', 'aldric', 'lyssa', 'heroes', 'voidlord'];
const MAX_TEXT = 90;
const COLOR_FR = ['bleu', 'rouge', 'vert', 'jaune'] as const;
const COLOR_EN = ['blue', 'red', 'green', 'yellow'] as const;
const DIRS4 = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

function room(id: string): RoomDef {
  const r = level6.rooms.find((x) => x.id === id);
  if (!r) throw new Error(`salle introuvable : ${id}`);
  return r;
}

function enemiesAt(r: RoomDef, n: number): EnemySpawnDef[] {
  return r.enemies.filter((e) => (e.minPlayers ?? 1) <= n);
}

function totalEnemies(level: LevelDef, n: number): number {
  return level.rooms.reduce((sum, r) => sum + enemiesAt(r, n).length, 0);
}

function bridgesOf(r: RoomDef): LightBridgeDef[] {
  return r.mechanisms.filter((m): m is LightBridgeDef => m.type === 'lightBridge');
}

function isFloor(r: RoomDef, x: number, y: number): boolean {
  const g = r.layout[y]?.[x];
  return g === '.' || g === ',';
}

const tk = (t: readonly [number, number]): string => `${t[0]},${t[1]}`;

/** Composantes connexes de sol HORS tuiles de pont : clé de tuile → numéro de composante. */
function components(r: RoomDef): Map<string, number> {
  const bridgeTiles = new Set<string>();
  for (const b of bridgesOf(r)) for (const t of b.tiles) bridgeTiles.add(tk(t));
  const comp = new Map<string, number>();
  let next = 0;
  for (let y = 0; y < r.layout.length; y++) {
    for (let x = 0; x < r.layout[0].length; x++) {
      if (!isFloor(r, x, y) || bridgeTiles.has(`${x},${y}`) || comp.has(`${x},${y}`)) continue;
      const id = next++;
      const queue: TileXY[] = [[x, y]];
      comp.set(`${x},${y}`, id);
      for (let i = 0; i < queue.length; i++) {
        const [cx, cy] = queue[i];
        for (const [dx, dy] of DIRS4) {
          const nx = cx + dx;
          const ny = cy + dy;
          const k = `${nx},${ny}`;
          if (!isFloor(r, nx, ny) || bridgeTiles.has(k) || comp.has(k)) continue;
          comp.set(k, id);
          queue.push([nx, ny]);
        }
      }
    }
  }
  return comp;
}

/** Composante de sol voisine (hors pont) d'une tuile de pont, ou -1. */
function neighbourComponent(r: RoomDef, comp: Map<string, number>, t: TileXY): number {
  for (const [dx, dy] of DIRS4) {
    const c = comp.get(`${t[0] + dx},${t[1] + dy}`);
    if (c !== undefined) return c;
  }
  return -1;
}

function readPart(lang: 'fr' | 'en'): Record<string, string> {
  return Object.fromEntries(Object.entries(getDictionary(lang)).filter(([k]) => k.includes('level6') || k === 'speaker.voidlord'));
}

function placeholders(value: string): string[] {
  return Array.from(new Set(Array.from(value.matchAll(/\{(\w+)\}/g), (m) => m[1]))).sort();
}

// ───────────────────────────── Validité globale ─────────────────────────────

describe('level6 — validation', () => {
  it('validateLevel (dictionnaires fr + en, orateurs) ne retourne aucune erreur (1, 2, 3 et 4 joueurs)', () => {
    const errors = validateLevel(level6, {
      dictionaries: { fr: getDictionary('fr'), en: getDictionary('en') },
      checkSpeakers: true,
    });
    expect(errors).toEqual([]);
  });

  it('validateBossStructure : au moins 2 demi-boss à tous les nombres de joueurs, salle finale avec boss', () => {
    expect(validateBossStructure(level6, { minMiniBosses: 2 })).toEqual([]);
  });

  it('identité du niveau : id, thème void, nom, durée estimée, enregistré dans LEVELS', () => {
    expect(level6.id).toBe('level6');
    expect(level6.theme).toBe('void');
    expect(level6.nameKey).toBe('level.level6.name');
    expect(getDictionary('fr')['level.level6.name']).toBe('Les Abysses du Néant');
    expect(getDictionary('en')['level.level6.name']).toBe('The Abyss of the Void');
    expect(level6.estimatedMinutes).toBeGreaterThanOrEqual(5);
    expect(level6.estimatedMinutes).toBeLessThanOrEqual(10);
    for (const r of level6.rooms) expect(r.theme).toBe('void');
    expect(getLevel('level6')).toBe(level6);
    expect(LEVELS.indexOf(level6)).toBeGreaterThan(LEVELS.findIndex((l) => l.id === 'level3'));
  });

  it('compte 9 salles, dans l\'ordre prévu', () => {
    expect(level6.rooms.map((r) => r.id)).toEqual(['quay', 'islets', 'terrace', 'wraithhall', 'keys', 'embers', 'hearth', 'gauntlet', 'throne']);
  });

  it('chaque salle est vaste (54..86 × 40..52 tuiles, jamais visible en entier), avec 4 spawns groupés, un indice et un panneau', () => {
    for (const r of level6.rooms) {
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
      expect(r.nameKey, r.id).toBe(`room.level6.${r.id}.name`);
      expect(r.introHintKey, r.id).toBe(`hintroom.level6.${r.id}`);
      expect((r.signs ?? []).length, `${r.id} panneaux`).toBeGreaterThanOrEqual(2);
      expect((r.decor ?? []).length, `${r.id} décors`).toBeGreaterThan(0);
    }
  });

  it('les tuiles de porte forment un passage du sol dans la grille', () => {
    for (const r of level6.rooms) {
      const grid = new RoomGrid(r.layout);
      for (const m of r.mechanisms) {
        if (m.type !== 'door') continue;
        expect(m.tiles.length, `${r.id}.${m.id}`).toBe(4);
        for (const [x, y] of m.tiles) expect(grid.blocksMovement(x, y), `${r.id}.${m.id} [${x},${y}]`).toBe(false);
      }
    }
  });

  it('est sérialisable en JSON sans perte (aucune fonction, aucune classe)', () => {
    expect(JSON.parse(JSON.stringify(level6))).toEqual(level6);
  });
});

// ───────────────────────────── Objectifs ─────────────────────────────

describe('level6 — objectifs personnels', () => {
  it('un objectif par slot 0..3, de types variés, répartis sur au moins 3 salles', () => {
    expect(level6.objectives.map((o) => o.slot).sort()).toEqual([0, 1, 2, 3]);
    expect(new Set(level6.objectives.map((o) => o.kind)).size).toBeGreaterThanOrEqual(3);
    expect(new Set(level6.objectives.map((o) => o.roomId)).size).toBeGreaterThanOrEqual(3);
    expect(level6.objectives.find((o) => o.id === 'seal')).toMatchObject({ slot: 0, kind: 'mechanism', roomId: 'keys', mechanismId: 'doorBlue' });
    expect(level6.objectives.find((o) => o.id === 'beacon')).toMatchObject({ slot: 1, kind: 'zone', roomId: 'terrace', seconds: 8 });
    expect(level6.objectives.find((o) => o.id === 'hunt')).toMatchObject({ slot: 2, kind: 'kills', roomId: 'hearth', count: 4 });
    expect(level6.objectives.find((o) => o.id === 'ember')).toMatchObject({ slot: 3, kind: 'mechanism', roomId: 'embers', mechanismId: 'emberBrazierYellow' });
  });

  it('les salles porteuses d\'objectifs ne se quittent qu\'une fois ceux-ci accomplis', () => {
    expect(room('terrace').mechanisms.find((m) => m.id === 'terraceDoor' && m.type === 'door' && m.requires.includes('obj:beacon'))).toBeTruthy();
    expect(room('hearth').exit.requires).toContain('obj:hunt');
    // clé bleue / brasero jaune : l'objectif est exigé par la sortie de la salle via la porte / le brasero eux-mêmes
    expect(room('keys').exit.requires).toContain('doorBlue');
    const embersDoor = room('embers').mechanisms.find((m) => m.id === 'embersDoor');
    expect(embersDoor && embersDoor.type === 'door' && embersDoor.requires).toContain('emberBrazierYellow');
  });
});

// ───────────────────────────── Mécanisme inédit : le pont de lumière ─────────────────────────────

describe('level6 — pont de lumière', () => {
  it('le mécanisme inédit est utilisé dans au moins 3 salles (6 ici), avec des porteurs de lanterne variés', () => {
    const rooms = level6.rooms.filter((r) => bridgesOf(r).length > 0);
    expect(rooms.length).toBeGreaterThanOrEqual(3);
    expect(rooms.map((r) => r.id)).toEqual(['quay', 'islets', 'terrace', 'keys', 'embers', 'gauntlet']);
    const slotsUsed = new Set(rooms.flatMap((r) => bridgesOf(r).map((b) => b.lanternSlot)));
    expect([...slotsUsed].sort()).toEqual([0, 1, 2, 3]);
    // la salle des quatre ponts : un porteur différent à chaque pont, dans l'ordre des slots
    expect(bridgesOf(room('gauntlet')).map((b) => b.lanternSlot)).toEqual([0, 1, 2, 3]);
    expect(bridgesOf(room('islets')).map((b) => b.lanternSlot)).toEqual([1, 2]);
  });

  it('les ponts font une tuile de large, forment une route continue entre deux rives distinctes (le pont est indispensable)', () => {
    for (const r of level6.rooms) {
      const comp = components(r);
      for (const b of bridgesOf(r)) {
        const label = `${r.id}.${b.id}`;
        expect(b.tiles.length, label).toBeGreaterThanOrEqual(8);
        b.tiles.forEach((t, i) => {
          expect(isFloor(r, t[0], t[1]), `${label} tuile ${i} est du sol`).toBe(true);
          if (i === 0) return;
          const p = b.tiles[i - 1];
          expect(Math.abs(t[0] - p[0]) + Math.abs(t[1] - p[1]), `${label} tuiles ${i - 1}→${i} adjacentes`).toBe(1);
        });
        // une tuile intérieure n'a pour voisines de sol que la précédente et la suivante (pont d'une tuile de large)
        const set = new Set(b.tiles.map(tk));
        b.tiles.forEach((t, i) => {
          const floorNeighbours = DIRS4.filter(([dx, dy]) => isFloor(r, t[0] + dx, t[1] + dy));
          if (i > 0 && i < b.tiles.length - 1) {
            expect(floorNeighbours.length, `${label} tuile ${i} : voisines de sol`).toBe(2);
            for (const [dx, dy] of floorNeighbours) expect(set.has(`${t[0] + dx},${t[1] + dy}`), `${label} tuile ${i} : voisine hors pont`).toBe(true);
          }
        });
        const from = neighbourComponent(r, comp, b.tiles[0]);
        const to = neighbourComponent(r, comp, b.tiles[b.tiles.length - 1]);
        expect(from, `${label} rive de départ`).toBeGreaterThanOrEqual(0);
        expect(to, `${label} rive d'arrivée`).toBeGreaterThanOrEqual(0);
        expect(from, `${label} : deux rives différentes`).not.toBe(to);
        expect(b.radiusTiles, label).toBeGreaterThanOrEqual(2.5);
      }
    }
  });

  it('apprentissage calme d\'abord (quai : pont court, droit, halo généreux, salle éclairée), puis ponts plus longs et sinueux', () => {
    const quay = room('quay');
    const first = bridgesOf(quay)[0];
    expect(quay.dark).not.toBe(true);
    expect(first.tiles.length).toBeLessThanOrEqual(14);
    expect(new Set(first.tiles.map((t) => t[1])).size).toBe(1); // droit
    expect(first.radiusTiles).toBeGreaterThanOrEqual(3.5);
    expect(enemiesAt(quay, 4).length).toBeLessThanOrEqual(16); // calme
    // les salles suivantes ont des ponts plus longs, avec des coudes
    const turns = (b: LightBridgeDef): number => b.tiles.filter((t, i) => i > 1 && i < b.tiles.length && (t[0] - b.tiles[i - 1][0]) * (b.tiles[i - 1][1] - b.tiles[i - 2][1]) !== (t[1] - b.tiles[i - 1][1]) * (b.tiles[i - 1][0] - b.tiles[i - 2][0])).length;
    const long = level6.rooms.flatMap(bridgesOf).filter((b) => b.tiles.length >= 35);
    expect(long.length).toBeGreaterThanOrEqual(2);
    for (const b of long) expect(turns(b)).toBeGreaterThanOrEqual(2);
    expect(Math.max(...level6.rooms.flatMap(bridgesOf).map((b) => b.tiles.length))).toBeGreaterThanOrEqual(45);
    // les premiers ponts de l'îlot de repos sont courts
    for (const b of bridgesOf(room('islets'))) expect(b.tiles.length).toBeLessThanOrEqual(14);
  });

  it('plusieurs salles sombres (les suiveurs ne voient plus rien hors du halo), avec points de recharge de torche', () => {
    const dark = level6.rooms.filter((r) => r.dark === true);
    expect(dark.map((r) => r.id)).toEqual(['islets', 'keys', 'embers', 'gauntlet']);
    for (const r of dark) {
      const lit = r.mechanisms.filter((m) => m.type === 'brazier' && m.lit === true);
      expect(lit.length, `${r.id} braseros allumés`).toBeGreaterThanOrEqual(5);
      expect(bridgesOf(r).length, `${r.id} ponts`).toBeGreaterThan(0);
    }
  });

  it('combine le pont avec les mécanismes connus (leviers, plaques, clés, braseros, portes)', () => {
    const kinds = (id: string): Set<string> => new Set(room(id).mechanisms.map((m) => m.type));
    expect(kinds('terrace').has('lever')).toBe(true);
    expect(kinds('terrace').has('door')).toBe(true);
    expect(kinds('wraithhall').has('plate')).toBe(true);
    expect(kinds('keys').has('key')).toBe(true);
    expect(kinds('embers').has('brazier')).toBe(true);
    expect(kinds('hearth').has('lever')).toBe(true);
  });

  for (const n of PLAYER_COUNTS) {
    it(`à ${n} joueur(s), chaque pont est éclairé par le joueur lanternSlot % n, et seulement dans son halo`, () => {
      for (const r of level6.rooms) {
        for (const b of bridgesOf(r)) {
          const grid = new RoomGrid(r.layout);
          const players: PlayerState[] = Array.from({ length: n }, (_, i) =>
            createPlayerState({ id: i as PlayerId, characterId: 'david', difficulty: 2 }, tileCenterPx(r.playerSpawns[i])),
          );
          const mechanisms = createRoomMechanisms(r, n);
          const step = (): LightBridgeState => {
            updateMechanisms({
              room: r,
              grid,
              mechanisms,
              players,
              frames: {},
              interactPressed: {},
              dtMs: SIM_STEP_MS,
              aliveEnemyCount: 0,
              objectiveDone: () => false,
              zoneOccupied: () => false,
            });
            return mechanisms.find((m) => m.id === b.id) as LightBridgeState;
          };
          // porteur au départ du spawn : le pont est éteint (loin du halo), personne n'est dessus
          let st = step();
          const bearer = resolveSlot(b.lanternSlot, n);
          expect(st.bearerId, `${r.id}.${b.id}`).toBe(bearer);
          expect(st.lit.every((v) => !v), `${r.id}.${b.id} éteint au départ`).toBe(true);
          // le porteur se tient sur la première tuile : le halo allume les tuiles proches, pas les lointaines
          const c = tileCenterPx(b.tiles[0]);
          players[bearer].pos = { x: c.x, y: c.y };
          st = step();
          expect(st.lit[0]).toBe(true);
          const far = b.tiles.findIndex((t) => Math.hypot(t[0] - b.tiles[0][0], t[1] - b.tiles[0][1]) * TILE > b.radiusTiles * TILE + 1);
          expect(far, `${r.id}.${b.id} halo plus court que le pont`).toBeGreaterThan(0);
          expect(st.lit[far]).toBe(false);
          expect(isMechanismSolved(st)).toBe(true);
        }
      }
    });
  }
});

// ───────────────────────────── Ennemis ─────────────────────────────

describe('level6 — ennemis', () => {
  it('nettement plus d\'ennemis que les niveaux 1 à 3 (≥ +25 % du maximum, à 1 ET à 4 joueurs)', () => {
    for (const n of [1, 4]) {
      const max = Math.max(totalEnemies(level1, n), totalEnemies(level2, n), totalEnemies(level3, n));
      const mine = totalEnemies(level6, n);
      expect(mine, `n=${n} : ${mine} ennemis vs max des niveaux 1-3 = ${max}`).toBeGreaterThanOrEqual(Math.ceil(max * 1.25));
    }
  });

  it('le nombre d\'ennemis ne dépend que du nombre de joueurs (minPlayers) et croît avec lui ; ≈ 60 % dès 1 joueur', () => {
    const counts = PLAYER_COUNTS.map((n) => totalEnemies(level6, n));
    for (let i = 1; i < counts.length; i++) expect(counts[i]).toBeGreaterThan(counts[i - 1]);
    expect(counts[0] / counts[3]).toBeGreaterThan(0.5);
    expect(counts[0] / counts[3]).toBeLessThan(0.75);
    for (const r of level6.rooms) {
      for (const e of r.enemies) {
        expect(Object.keys(e).every((k) => ['kind', 'tile', 'wave', 'when', 'minPlayers'].includes(k)), `${r.id} ${e.kind}`).toBe(true);
        if (e.minPlayers !== undefined) expect([2, 3, 4]).toContain(e.minPlayers);
      }
    }
  });

  it('aucun ennemi à moins de 12 tuiles de l\'arrivée des joueurs', () => {
    for (const r of level6.rooms) {
      for (const e of r.enemies) {
        for (const s of r.playerSpawns) {
          expect(Math.hypot(e.tile[0] - s[0], e.tile[1] - s[1]), `${r.id} ${e.kind} [${e.tile}] vs spawn [${s}]`).toBeGreaterThanOrEqual(12);
        }
      }
    }
  });

  it('AUCUN ennemi n\'attaque pendant une traversée : rive de départ nettoyable avant, rives d\'arrivée en embuscade lointaine', () => {
    for (const r of level6.rooms) {
      const bridges = bridgesOf(r);
      if (bridges.length === 0) continue;
      const comp = components(r);
      const spawnComp = comp.get(tk(r.playerSpawns[0])) as number;
      const zones = new Map((r.zones ?? []).map((z) => [z.id, z.rect] as const));
      // composantes d'arrivée → pont(s) qui y atterrissent
      const landings = new Map<number, TileXY[]>();
      for (const b of bridges) {
        const c = neighbourComponent(r, comp, b.tiles[b.tiles.length - 1]);
        landings.set(c, [...(landings.get(c) ?? []), b.tiles[b.tiles.length - 1]]);
      }
      for (const e of r.enemies) {
        const c = comp.get(tk(e.tile));
        expect(c, `${r.id} ${e.kind} [${e.tile}] sur une rive`).toBeDefined();
        if (c === spawnComp) {
          expect(e.when, `${r.id} ${e.kind} [${e.tile}] : rive de départ, présent d'emblée`).toBeUndefined();
          continue;
        }
        // rive atteinte par un pont : embuscade conditionnée à une zone située à ≥ 6 tuiles de l'atterrissage
        expect(e.when, `${r.id} ${e.kind} [${e.tile}] : ennemi d'une rive d'arrivée sans embuscade`).toMatch(/^enter:/);
        const zone = zones.get((e.when as string).slice(6));
        expect(zone, `${r.id} zone ${e.when}`).toBeDefined();
        for (const land of landings.get(c as number) ?? []) {
          expect(Math.hypot(e.tile[0] - land[0], e.tile[1] - land[1]), `${r.id} ${e.kind} [${e.tile}] surgit trop près de l'atterrissage [${land}]`).toBeGreaterThanOrEqual(5.9);
          for (let y = zone!.y; y < zone!.y + zone!.h; y++) {
            for (let x = zone!.x; x < zone!.x + zone!.w; x++) {
              if (comp.get(`${x},${y}`) !== c) continue;
              expect(Math.hypot(x - land[0], y - land[1]), `${r.id} zone ${e.when} [${x},${y}] trop près de l'atterrissage [${land}]`).toBeGreaterThanOrEqual(5.9);
            }
          }
        }
      }
    }
  });

  it('aucune embuscade ne se contourne : dans les salles dont la sortie exige « clear », tout chemin de l\'atterrissage au pont suivant (ou à la sortie) traverse la zone', () => {
    type Rc = { x: number; y: number; w: number; h: number };
    const NEIGH8 = [...DIRS4, [1, 1], [1, -1], [-1, 1], [-1, -1]] as const;
    const inRect = (rc: Rc, x: number, y: number): boolean => x >= rc.x && x < rc.x + rc.w && y >= rc.y && y < rc.y + rc.h;
    let checked = 0;
    for (const r of level6.rooms) {
      const bridges = bridgesOf(r);
      if (bridges.length === 0 || !r.exit.requires.includes('clear')) continue;
      const comp = components(r);
      const zones = new Map((r.zones ?? []).map((z) => [z.id, z.rect as Rc] as const));
      // atterrissages : composante d'arrivée → dernières tuiles des ponts qui y mènent
      const landings = new Map<number, TileXY[]>();
      for (const b of bridges) {
        const c = neighbourComponent(r, comp, b.tiles[b.tiles.length - 1]);
        landings.set(c, [...(landings.get(c) ?? []), b.tiles[b.tiles.length - 1]]);
      }
      for (const [c, lands] of landings) {
        // zones d'embuscade de cette rive
        const ambushZones = new Set<string>();
        for (const e of r.enemies) if (e.when?.startsWith('enter:') && comp.get(tk(e.tile)) === c) ambushZones.add(e.when.slice(6));
        expect(ambushZones.size, `${r.id} rive ${c} : une embuscade`).toBeGreaterThan(0);
        const rects = [...ambushZones].map((id) => zones.get(id) as Rc);
        const hidden = (x: number, y: number): boolean => !rects.some((rc) => inRect(rc, x, y));
        // cibles : tuiles de la rive voisines (8 voisins) du départ d'un pont suivant, et tuiles de la sortie
        const targets = new Set<string>();
        for (const b of bridges) {
          if (neighbourComponent(r, comp, b.tiles[0]) !== c) continue;
          for (const [dx, dy] of NEIGH8) {
            const k = `${b.tiles[0][0] + dx},${b.tiles[0][1] + dy}`;
            if (comp.get(k) === c) targets.add(k);
          }
        }
        for (let y = r.exit.rect.y; y < r.exit.rect.y + r.exit.rect.h; y++) {
          for (let x = r.exit.rect.x; x < r.exit.rect.x + r.exit.rect.w; x++) if (comp.get(`${x},${y}`) === c) targets.add(`${x},${y}`);
        }
        expect(targets.size, `${r.id} rive ${c} : un pont suivant ou la sortie`).toBeGreaterThan(0);
        // BFS (8 voisins, le plus permissif) sur la rive en évitant la zone : aucune cible ne doit être atteinte
        for (const land of lands) {
          const seen = new Set<string>();
          const queue: TileXY[] = [];
          for (const [dx, dy] of DIRS4) {
            const x = land[0] + dx;
            const y = land[1] + dy;
            if (comp.get(`${x},${y}`) === c && hidden(x, y)) {
              seen.add(`${x},${y}`);
              queue.push([x, y]);
            }
          }
          for (let i = 0; i < queue.length; i++) {
            for (const [dx, dy] of NEIGH8) {
              const x = queue[i][0] + dx;
              const y = queue[i][1] + dy;
              const k = `${x},${y}`;
              if (comp.get(k) !== c || !hidden(x, y) || seen.has(k)) continue;
              seen.add(k);
              queue.push([x, y]);
            }
          }
          const bypass = [...targets].filter((k) => seen.has(k));
          expect(bypass, `${r.id} atterrissage [${land}] : cible(s) atteignable(s) SANS entrer dans la zone d'embuscade ${[...ambushZones].join(',')}`).toEqual([]);
          checked++;
        }
      }
    }
    expect(checked, 'au moins les 4 atterrissages du Grand Pont').toBeGreaterThanOrEqual(4);
  });

  it('chaque embuscade a au moins quelques ennemis à tous les nombres de joueurs sauf le tout premier quai', () => {
    for (const r of level6.rooms) {
      const byZone = new Map<string, number[]>();
      for (const e of r.enemies) {
        if (!e.when?.startsWith('enter:')) continue;
        const arr = byZone.get(e.when) ?? [0, 0, 0, 0];
        for (let n = 1; n <= 4; n++) if ((e.minPlayers ?? 1) <= n) arr[n - 1]++;
        byZone.set(e.when, arr);
      }
      for (const [z, arr] of byZone) expect(arr[0], `${r.id} ${z} à 1 joueur`).toBeGreaterThanOrEqual(r.id === 'quay' ? 3 : 4);
    }
  });
});

// ───────────────────────────── Demi-boss et boss ─────────────────────────────

describe('level6 — demi-boss et boss de fin', () => {
  it('deux demi-boss « wraith » (volants), présents à tous les nombres de joueurs, dont un à mi-parcours', () => {
    const where = level6.rooms
      .map((r, i) => ({ r, i, minis: r.enemies.filter((e) => isMiniBossKind(e.kind)) }))
      .filter((x) => x.minis.length > 0);
    expect(where.map((x) => x.r.id)).toEqual(['wraithhall', 'hearth']);
    for (const w of where) {
      expect(w.minis).toHaveLength(1);
      expect(w.minis[0].kind).toBe('wraith');
      expect(w.minis[0].minPlayers).toBeUndefined();
      // la sortie exige 'clear'
      expect(w.r.exit.requires).toContain('clear');
    }
    const ratio = (i: number): number => i / (level6.rooms.length - 1);
    const mid = where.filter((x) => ratio(x.i) >= 0.25 && ratio(x.i) <= 0.65);
    expect(mid.length).toBeGreaterThanOrEqual(1);
    expect(where.some((x) => ratio(x.i) > 0.65)).toBe(true); // le second est dans une salle clé plus tard
  });

  it('les sbires des demi-boss suivent le nombre de joueurs ; arènes sans aucun abîme', () => {
    for (const id of ['wraithhall', 'hearth']) {
      const r = room(id);
      const minions = PLAYER_COUNTS.map((n) => enemiesAt(r, n).filter((e) => !isMiniBossKind(e.kind)).length);
      for (let i = 1; i < minions.length; i++) expect(minions[i], `${id} sbires`).toBeGreaterThan(minions[i - 1]);
      expect(minions[0]).toBeGreaterThanOrEqual(12);
      expect(r.layout.some((row) => row.includes('~')), `${id} sans abîme`).toBe(false);
      expect(bridgesOf(r)).toHaveLength(0);
    }
    expect(enemiesAt(room('hearth'), 1).length).toBeGreaterThan(enemiesAt(room('wraithhall'), 1).length);
  });

  it('salle finale : exit.final scellée, seigneur du Néant présent à tous les n, arène sans abîme ni mécanisme, exigences complètes', () => {
    const last = level6.rooms[level6.rooms.length - 1];
    expect(last.id).toBe('throne');
    expect(last.exit.final).toBe(true);
    expect(last.exit.sealed).toBe(true);
    expect(last.exit.requires).toEqual(expect.arrayContaining(['clear', 'obj:seal', 'obj:beacon', 'obj:hunt', 'obj:ember']));
    const bosses = last.enemies.filter((e) => isBossKind(e.kind));
    expect(bosses).toHaveLength(1);
    expect(bosses[0].kind).toBe('voidlord');
    expect(bosses[0].minPlayers).toBeUndefined();
    expect(last.mechanisms).toHaveLength(0);
    expect(last.layout.some((row) => row.includes('~'))).toBe(false);
    // une seule salle finale, et seule la salle finale contient un boss de fin
    expect(level6.rooms.filter((r) => r.exit.final)).toHaveLength(1);
    expect(level6.rooms.slice(0, -1).some((r) => r.enemies.some((e) => isBossKind(e.kind)))).toBe(false);
  });
});

// ───────────────────────────── Coopération adaptative ─────────────────────────────

describe('level6 — coop adaptative (1 à 4 joueurs)', () => {
  it('plaques, leviers, clés, portes à clé et braseros de couleur : minPlayers = slot + 1', () => {
    for (const r of level6.rooms) {
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

  it('les consignes citent la bonne couleur de slot (porteurs, balise, chasse, sanctuaire)', () => {
    const fr = getDictionary('fr');
    const en = getDictionary('en');
    for (const r of level6.rooms) {
      for (const b of bridgesOf(r)) {
        expect(fr[b.labelKey as string], b.id).toContain(`héros ${COLOR_FR[b.lanternSlot]}`);
        expect(en[b.labelKey as string], b.id).toContain(`${COLOR_EN[b.lanternSlot]} hero`);
      }
    }
    expect(fr['sign.level6.quay.lantern']).toMatch(/bleu/);
    expect(fr['sign.level6.terrace.winding']).toMatch(/jaune/);
    expect(fr['sign.level6.terrace.beacon']).toMatch(/rouge/);
    expect(fr['sign.level6.hearth.hunt']).toMatch(/vert/);
    expect(fr['sign.level6.keys.bridge']).toMatch(/bleu/);
    expect(fr['sign.level6.embers.winding']).toMatch(/rouge/);
    expect(en['sign.level6.terrace.beacon']).toMatch(/red/);
    expect(en['sign.level6.hearth.hunt']).toMatch(/green/);
    // cohérence avec les données : balise = slot 1 (rouge), chasse = slot 2 (vert)
    expect(level6.objectives.find((o) => o.id === 'beacon')?.slot).toBe(1);
    expect(level6.objectives.find((o) => o.id === 'hunt')?.slot).toBe(2);
  });
});

// ───────────────────────────── i18n ─────────────────────────────

describe('level6 — textes (parts i18n)', () => {
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
    const required = new Set(collectRequiredI18nKeys(level6, { checkSpeakers: true }).map((r) => r.key));
    const own = new Set([...required].filter((k) => !['speaker.aldric', 'speaker.heroes', 'speaker.lyssa', 'speaker.narrator'].includes(k)));
    expect(new Set(Object.keys(fr))).toEqual(own);
    for (const k of required) {
      expect(Object.prototype.hasOwnProperty.call(getDictionary('en'), k), `en ${k}`).toBe(true);
      expect(base[k], k).toBeTruthy();
    }
  });

  it('clés bien formées, préfixées par la convention de DESIGN.md §6', () => {
    const prefixes = ['level.level6.', 'room.level6.', 'objective.level6.', 'mech.level6.', 'sign.level6.', 'hintroom.level6.', 'speaker.voidlord'];
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

  it('histoire : intro de 3 à 5 répliques, outro de 2 à 4 (DESIGN §7), orateurs autorisés, le seigneur du Néant parle dans l\'intro', () => {
    expect(level6.intro.length).toBeGreaterThanOrEqual(3);
    expect(level6.intro.length).toBeLessThanOrEqual(5);
    expect(level6.outro.length).toBeGreaterThanOrEqual(2);
    expect(level6.outro.length).toBeLessThanOrEqual(4);
    for (const l of [...level6.intro, ...level6.outro]) expect(ALLOWED_SPEAKERS).toContain(l.speaker);
    expect(level6.intro.some((l) => l.speaker === 'voidlord')).toBe(true);
    expect(fr['speaker.voidlord']).toBe('Le Seigneur du Néant');
    expect(en['speaker.voidlord']).toBe('The Void Lord');
  });

  it('dernier niveau du jeu : les textes de fin racontent la victoire sur le Néant (plus de « à suivre »)', () => {
    const frAll = getDictionary('fr');
    const enAll = getDictionary('en');
    expect(frAll['story.end.line.1']).toMatch(/Néant/);
    expect(enAll['story.end.line.1']).toMatch(/Void/);
    expect(frAll['story.end.tbc']).not.toMatch(/suivre/i);
    expect(enAll['story.end.tbc']).not.toMatch(/continued/i);
    for (const k of ['story.end.title', 'story.end.line.1', 'story.end.line.2', 'story.end.line.3', 'story.end.line.4', 'story.end.tbc']) {
      expect(frAll[k], `fr ${k}`).toBeTruthy();
      expect(enAll[k], `en ${k}`).toBeTruthy();
      expect(frAll[k]).not.toMatch(/Morvane n'est plus/);
    }
  });
});

// ───────────────────────────── Déterminisme des données ─────────────────────────────

describe('level6 — données déterministes', () => {
  it('les spawns sont sur le sol et aucun mécanisme n\'est un doublon d\'id dans une salle', () => {
    for (const r of level6.rooms) {
      const ids = r.mechanisms.map((m: MechanismDef) => m.id);
      expect(new Set(ids).size, r.id).toBe(ids.length);
      for (const [x, y] of r.playerSpawns) expect(isFloor(r, x, y), `${r.id} spawn [${x},${y}]`).toBe(true);
    }
  });
});
