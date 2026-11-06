import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { INTERACT_RANGE, LIGHT_FULL_TILES, PLAYER_RADIUS, SIM_STEP_MS, TILE, TORCH_MAX_MS } from '../core/constants';
import { RoomGrid } from '../core/grid';
import { collectRequiredI18nKeys, validateLevel } from '../core/levelValidation';
import {
  areAllRequirementsMet,
  createRoomMechanisms,
  effectiveLeverWindowMs,
  requiredPushers,
  tileCenterPx,
  updateMechanisms,
} from '../core/mechanisms';
import { createObjectives, isObjectiveDone, updateObjectives } from '../core/objectives';
import { createPlayerState } from '../core/players';
import { resolveSlot } from '../core/slots';
import type {
  BlockState,
  BrazierDef,
  BrazierState,
  DoorState,
  EnemyKind,
  KeyState,
  LeverState,
  MechanismDef,
  MechanismState,
  PlateState,
  PlayerId,
  PlayerState,
  RoomDef,
  RuneState,
  SocketState,
  TickInputs,
  TileXY,
} from '../core/types';
import { getDictionary } from '../i18n/i18n';
import { level3 } from './level3';

// ───────────────────────────── Aides ─────────────────────────────

const PLAYER_COUNTS = [1, 2, 3, 4] as const;
const NORMAL_KINDS: readonly EnemyKind[] = ['slime', 'bat', 'skeleton', 'archer', 'spider', 'wisp', 'knight'];
const ALLOWED_SPEAKERS = ['narrator', 'aldric', 'lyssa', 'morvane', 'gorgrim', 'heroes'];
const MAX_TEXT = 90;
/** Fenêtre des leviers des Balcons (ms) : voir level3.ts. */
const LEVER_WINDOW_MS = 20000;
/** Vitesse de marche lente (tuiles/s) : ≈ 54 px/s à 16 px par tuile. */
const SLOW_TILES_PER_S = 3.4;

/** Distances (en tuiles de sol, 4-connexe, portes ouvertes) depuis une tuile : clé = y*1000+x. */
function pathDistances(r: RoomDef, from: TileXY): Map<number, number> {
  const grid = new RoomGrid(r.layout);
  const dist = new Map<number, number>([[from[1] * 1000 + from[0], 0]]);
  const queue: TileXY[] = [from];
  for (let i = 0; i < queue.length; i++) {
    const [x, y] = queue[i];
    const d = dist.get(y * 1000 + x) ?? 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (grid.blocksMovement(nx, ny) || dist.has(ny * 1000 + nx)) continue;
      dist.set(ny * 1000 + nx, d + 1);
      queue.push([nx, ny]);
    }
  }
  return dist;
}

function room(id: string): RoomDef {
  const r = level3.rooms.find((x) => x.id === id);
  if (!r) throw new Error(`salle introuvable : ${id}`);
  return r;
}

function mech<T extends MechanismDef['type']>(r: RoomDef, id: string, type: T): Extract<MechanismDef, { type: T }> {
  const m = r.mechanisms.find((x) => x.id === id);
  if (!m || m.type !== type) throw new Error(`mécanisme ${type} introuvable : ${id}`);
  return m as Extract<MechanismDef, { type: T }>;
}

function enemiesAt(r: RoomDef, n: number) {
  return r.enemies.filter((e) => (e.minPlayers ?? 1) <= n);
}

function totalEnemies(n: number): number {
  return level3.rooms.reduce((sum, r) => sum + enemiesAt(r, n).length, 0);
}

function readPart(lang: 'fr' | 'en'): Record<string, string> {
  return Object.fromEntries(Object.entries(getDictionary(lang)).filter(([k]) => k.includes('level3')));
}

function placeholders(value: string): string[] {
  return Array.from(new Set(Array.from(value.matchAll(/\{(\w+)\}/g), (m) => m[1]))).sort();
}

/** Harnais minimal de simulation des mécanismes (réutilise les vraies fonctions du cœur). */
class Harness {
  readonly grid: RoomGrid;
  readonly mechanisms: MechanismState[];
  readonly players: PlayerState[];
  readonly objectives;
  elapsedMs = 0;

  constructor(
    readonly room: RoomDef,
    readonly n: number,
  ) {
    this.grid = new RoomGrid(room.layout);
    this.mechanisms = createRoomMechanisms(room, n);
    this.players = Array.from({ length: n }, (_, i) =>
      createPlayerState({ id: i as PlayerId, characterId: 'david', difficulty: 2 }, tileCenterPx(room.playerSpawns[i])),
    );
    this.objectives = createObjectives(level3, n);
  }

  put(id: PlayerId, tile: TileXY): void {
    const c = tileCenterPx(tile);
    this.players[id].pos = { x: c.x, y: c.y };
  }

  state<T extends MechanismState>(id: string): T {
    const s = this.mechanisms.find((m) => m.id === id);
    if (!s) throw new Error(`état introuvable : ${id}`);
    return s as T;
  }

  isOpen(doorId: string): boolean {
    return this.state<DoorState>(doorId).open;
  }

  /** Un pas : mécanismes puis objectifs. `press` = joueurs qui appuient sur Action (front montant) ce pas. */
  tick(press: PlayerId[] = [], frames: TickInputs = {}, deaths: { byPlayer: PlayerId | null }[] = []): void {
    const interactPressed: Partial<Record<PlayerId, boolean>> = {};
    for (const id of press) interactPressed[id] = true;
    updateMechanisms({
      room: this.room,
      grid: this.grid,
      mechanisms: this.mechanisms,
      players: this.players,
      frames,
      interactPressed,
      dtMs: SIM_STEP_MS,
      aliveEnemyCount: 0,
      objectiveDone: (id) => isObjectiveDone(this.objectives, id),
      zoneOccupied: () => false,
    });
    updateObjectives({
      level: level3,
      room: this.room,
      objectives: this.objectives,
      players: this.players,
      mechanisms: this.mechanisms,
      deaths: deaths.map((d) => ({ kind: 'skeleton' as const, byPlayer: d.byPlayer, roomId: this.room.id })),
      dtMs: SIM_STEP_MS,
    });
    this.elapsedMs += SIM_STEP_MS;
  }

  wait(ms: number, frames: TickInputs = {}): void {
    const ticks = Math.ceil(ms / SIM_STEP_MS);
    for (let i = 0; i < ticks; i++) this.tick([], frames);
  }

  /** Les exigences de sortie sont-elles satisfaites (hors 'clear', fourni par `alive`) ? */
  exitMet(alive = 0): boolean {
    return areAllRequirementsMet(this.room.exit.requires, {
      mechanisms: this.mechanisms,
      aliveEnemyCount: alive,
      objectiveDone: (id) => isObjectiveDone(this.objectives, id),
      zoneOccupied: () => false,
    });
  }

  objectiveDone(id: string): boolean {
    return isObjectiveDone(this.objectives, id);
  }
}

/** Place `count` pousseurs sur la face ouest d'un bloc (deux de front, décalés de 8 et 24 px). */
function placeWestPushers(h: Harness, blockTile: TileXY, count: number): PlayerId[] {
  const ids: PlayerId[] = [];
  for (let i = 0; i < count; i++) {
    h.players[i].pos = { x: blockTile[0] * TILE - PLAYER_RADIUS - 1, y: blockTile[1] * TILE + (i % 2 === 0 ? 8 : 24) };
    ids.push(i as PlayerId);
  }
  return ids;
}

function pushEast(ids: PlayerId[]): TickInputs {
  const f: TickInputs = {};
  for (const id of ids) f[id] = { moveX: 1, moveY: 0, attack: false, interact: false, revive: false };
  return f;
}

// ───────────────────────────── Validité globale ─────────────────────────────

describe('level3 — validation', () => {
  it('validateLevel (dictionnaires fr + en, orateurs) ne retourne aucune erreur', () => {
    const errors = validateLevel(level3, {
      dictionaries: { fr: getDictionary('fr'), en: getDictionary('en') },
      checkSpeakers: true,
    });
    expect(errors).toEqual([]);
  });

  it('identité du niveau : id, thème, nom, durée estimée', () => {
    expect(level3.id).toBe('level3');
    expect(level3.theme).toBe('citadel');
    expect(level3.nameKey).toBe('level.level3.name');
    expect(getDictionary('fr')['level.level3.name']).toBe('La Citadelle de Morvane');
    expect(level3.estimatedMinutes).toBe(10);
    for (const r of level3.rooms) expect(r.theme).toBe('citadel');
  });

  it('compte 8 à 9 salles, dans l\'ordre prévu', () => {
    expect(level3.rooms.length).toBeGreaterThanOrEqual(8);
    expect(level3.rooms.length).toBeLessThanOrEqual(9);
    expect(level3.rooms.map((r) => r.id)).toEqual([
      'gate',
      'seals',
      'forge',
      'sanctum',
      'balconies',
      'abyss',
      'arena',
      'dais',
      'throne',
    ]);
  });

  it('chaque salle est vaste (50..100 × 36..56 tuiles, jamais visible en entier), avec 4 spawns groupés', () => {
    for (const r of level3.rooms) {
      const w = r.layout[0].length;
      const h = r.layout.length;
      expect(w, `${r.id} largeur`).toBeGreaterThanOrEqual(50);
      expect(w, `${r.id} largeur`).toBeLessThanOrEqual(100);
      expect(h, `${r.id} hauteur`).toBeGreaterThanOrEqual(36);
      expect(h, `${r.id} hauteur`).toBeLessThanOrEqual(56);
      // bien plus grand que la caméra à 1 joueur (≈ 26×15 tuiles) comme à 4 (≈ 20×11)
      expect(w * h, `${r.id} surface`).toBeGreaterThanOrEqual(2000);
      expect(r.playerSpawns.length, `${r.id} spawns`).toBeGreaterThanOrEqual(4);
      const [sx, sy] = r.playerSpawns[0];
      for (const [x, y] of r.playerSpawns) {
        expect(Math.max(Math.abs(x - sx), Math.abs(y - sy)), `${r.id} spawns groupés`).toBeLessThanOrEqual(1);
      }
      // murs extérieurs
      expect(r.layout[0]).toMatch(/^#+$/);
      expect(r.layout[h - 1]).toMatch(/^#+$/);
      for (const row of r.layout) {
        expect(row[0]).toBe('#');
        expect(row[w - 1]).toBe('#');
      }
    }
  });

  it('chaque salle a un nom, un indice d\'arrivée, au moins un panneau et un décor', () => {
    for (const r of level3.rooms) {
      expect(r.nameKey).toBe(`room.level3.${r.id}.name`);
      expect(r.introHintKey).toBe(`hintroom.level3.${r.id}`);
      expect((r.signs ?? []).length, `${r.id} panneaux`).toBeGreaterThanOrEqual(1);
      expect((r.decor ?? []).length, `${r.id} décors`).toBeGreaterThanOrEqual(3);
    }
  });
});

// ───────────────────────────── Structure, boss et sortie finale ─────────────────────────────

describe('level3 — sortie finale et boss', () => {
  const last = level3.rooms[level3.rooms.length - 1];

  it('aucune sortie finale hors de la dernière salle', () => {
    const finals = level3.rooms.filter((r) => r.exit.final === true);
    expect(finals).toEqual([last]);
    for (const r of level3.rooms.slice(0, -1)) {
      expect(r.exit.final, r.id).toBeFalsy();
      expect(r.exit.sealed, r.id).toBeFalsy();
    }
  });

  it('la dernière salle est une arène de boss pure : Morvane seul, aucun mécanisme, sortie scellée', () => {
    expect(last.id).toBe('throne');
    expect(last.mechanisms).toEqual([]);
    expect(last.enemies.map((e) => e.kind)).toEqual(['morvane']);
    expect(last.enemies[0].minPlayers ?? 1).toBe(1);
    expect(last.enemies[0].when).toBeUndefined();
    expect(last.exit.sealed).toBe(true);
    expect(last.exit.final).toBe(true);
    const pillars = last.layout.join('').split('o').length - 1;
    expect(pillars).toBeGreaterThanOrEqual(12);
  });

  it('la sortie finale exige « clear » et les quatre objectifs', () => {
    expect(last.exit.requires).toContain('clear');
    for (const o of level3.objectives) expect(last.exit.requires).toContain(`obj:${o.id}`);
  });

  it('Morvane est le seul boss du niveau (pas de Gorgrim), uniquement dans la dernière salle', () => {
    for (const r of level3.rooms.slice(0, -1)) {
      for (const e of r.enemies) expect(['golem', 'morvane'], `${r.id}`).not.toContain(e.kind);
    }
  });

  it('la sortie finale reste scellée tant qu\'un objectif manque, et s\'ouvre quand tout est accompli', () => {
    const h = new Harness(last, 2);
    expect(h.exitMet(1)).toBe(false); // Morvane vivant, objectifs manquants
    expect(h.exitMet(0)).toBe(false); // Morvane vaincu mais objectifs manquants
    for (const st of h.objectives) st.done = true;
    expect(h.exitMet(1)).toBe(false);
    expect(h.exitMet(0)).toBe(true);
  });
});

// ───────────────────────────── Ennemis ─────────────────────────────

describe('level3 — ennemis', () => {
  it('utilise tous les ennemis non-boss ; chevalier et feu follet absents des trois premières salles', () => {
    const used = new Set<EnemyKind>();
    for (const r of level3.rooms.slice(0, -1)) for (const e of r.enemies) used.add(e.kind);
    for (const k of NORMAL_KINDS) expect(used.has(k), `type ${k}`).toBe(true);
    for (const r of level3.rooms.slice(0, 3)) {
      for (const e of r.enemies) expect(['knight', 'wisp'], r.id).not.toContain(e.kind);
    }
    const firstWith = (kind: EnemyKind) => level3.rooms.findIndex((r) => r.enemies.some((e) => e.kind === kind));
    expect(level3.rooms[firstWith('wisp')].id).toBe('sanctum');
    expect(level3.rooms[firstWith('knight')].id).toBe('balconies');
  });

  it('le nombre d\'ennemis ne dépend que des joueurs : champs autorisés, minPlayers 1..4, croissance monotone', () => {
    const allowed = new Set(['kind', 'tile', 'wave', 'when', 'minPlayers']);
    for (const r of level3.rooms) {
      for (const e of r.enemies) {
        for (const k of Object.keys(e)) expect(allowed.has(k), `${r.id} champ ${k}`).toBe(true);
        if (e.minPlayers !== undefined) {
          expect(Number.isInteger(e.minPlayers)).toBe(true);
          expect(e.minPlayers).toBeGreaterThanOrEqual(1);
          expect(e.minPlayers).toBeLessThanOrEqual(4);
        }
      }
      let prev = 0;
      for (const n of PLAYER_COUNTS) {
        const count = enemiesAt(r, n).length;
        expect(count, `${r.id} à ${n} joueur(s)`).toBeGreaterThanOrEqual(prev);
        prev = count;
      }
      expect(enemiesAt(r, 1).length, `${r.id} à 1 joueur`).toBeGreaterThanOrEqual(1);
    }
  });

  it('le total d\'ennemis augmente avec les joueurs, dans une fourchette raisonnable', () => {
    const totals = PLAYER_COUNTS.map(totalEnemies);
    for (let i = 1; i < totals.length; i++) expect(totals[i]).toBeGreaterThan(totals[i - 1]);
    expect(totals[0]).toBeGreaterThanOrEqual(110);
    expect(totals[3]).toBeLessThanOrEqual(300);
    // ≈ 55-65 % des ennemis du jeu à 4 joueurs sont déjà là à 1 joueur
    expect(totals[0] / totals[3]).toBeGreaterThanOrEqual(0.5);
    expect(totals[0] / totals[3]).toBeLessThanOrEqual(0.7);
  });

  it("salles denses : 14 à 45 ennemis à 4 joueurs, 50-70 % d'entre eux dès 1 joueur (hors boss)", () => {
    for (const r of level3.rooms.slice(0, -1)) {
      const at4 = enemiesAt(r, 4).length;
      const at1 = enemiesAt(r, 1).length;
      expect(at4, `${r.id} à 4 joueurs`).toBeGreaterThanOrEqual(14);
      expect(at4, `${r.id} à 4 joueurs`).toBeLessThanOrEqual(45);
      expect(at1 / at4, `${r.id} ratio 1 joueur / 4 joueurs`).toBeGreaterThanOrEqual(0.5);
      expect(at1 / at4, `${r.id} ratio 1 joueur / 4 joueurs`).toBeLessThanOrEqual(0.7);
    }
  });

  it('arrivée calme : aucun ennemi à moins de 12 tuiles des spawns ; jamais deux ennemis sur la même tuile', () => {
    for (const r of level3.rooms.slice(0, -1)) {
      const seen = new Set<string>();
      for (const e of r.enemies) {
        for (const sp of r.playerSpawns) {
          expect(Math.hypot(e.tile[0] - sp[0], e.tile[1] - sp[1]), `${r.id} ${e.kind} ${e.tile}`).toBeGreaterThanOrEqual(11.5);
        }
        const k = `${e.tile[0]},${e.tile[1]}`;
        expect(seen.has(k), `${r.id} doublon ${k}`).toBe(false);
        seen.add(k);
        // pas sur la tuile d'un mécanisme
        for (const m of r.mechanisms) {
          if (m.type === 'plate' || m.type === 'lever' || m.type === 'key') expect(m.tile, `${r.id} ${m.id}`).not.toEqual(e.tile);
        }
      }
    }
  });

  it('chaque ennemi conditionné (`when`) l\'est par un mécanisme de sa salle', () => {
    for (const r of level3.rooms) {
      for (const e of r.enemies) {
        if (e.when === undefined) continue;
        expect(r.mechanisms.some((m) => m.id === e.when), `${r.id} when ${e.when}`).toBe(true);
      }
    }
  });

  it("l'arène : toutes les vagues attendent le tocsin, cinq vagues non vides à tout n, assez d'ennemis pour le quota", () => {
    const arena = room('arena');
    expect(arena.enemies.every((e) => e.when === 'bell')).toBe(true);
    expect(new Set(arena.enemies.map((e) => e.wave ?? 0))).toEqual(new Set([0, 1, 2, 3, 4]));
    for (const n of PLAYER_COUNTS) {
      for (let w = 0; w < 5; w++) {
        expect(enemiesAt(arena, n).filter((e) => (e.wave ?? 0) === w).length, `vague ${w} à ${n}`).toBeGreaterThanOrEqual(1);
      }
    }
    const quota = level3.objectives.find((o) => o.id === 'slayer');
    expect(quota?.count).toBe(3);
    // marge confortable même à 1 joueur (les coups fatals ne peuvent pas être « volés » jusqu'à l'échec)
    expect(enemiesAt(arena, 1).length).toBeGreaterThanOrEqual((quota?.count ?? 1) * 2);
  });
});

// ───────────────────────────── Mécanismes ─────────────────────────────

describe('level3 — mécanismes', () => {
  const all = level3.rooms.flatMap((r) => r.mechanisms);

  it('combine tous les types de mécanismes, dont blocs sur socle ET sur plaque, leviers à fenêtre, runes', () => {
    const types = new Set(all.map((m) => m.type));
    for (const t of ['plate', 'lever', 'key', 'door', 'block', 'socket', 'runePuzzle'] as const) {
      expect(types.has(t), t).toBe(true);
    }
    expect(all.some((m) => m.type === 'lever' && (m.windowMs ?? 0) > 0)).toBe(true);
    expect(all.some((m) => m.type === 'lever' && (m.windowMs ?? 0) === 0)).toBe(true);
    const blocks = all.filter((m) => m.type === 'block');
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    expect(all.some((m) => m.type === 'socket')).toBe(true);
    // un bloc destiné à une plaque : la plaque est exactement sous le bloc une fois au fond du couloir
    const abyss = room('abyss');
    const block = mech(abyss, 'abyssBlock', 'block');
    const plate = mech(abyss, 'plateBlock', 'plate');
    expect(plate.tile[0]).toBeGreaterThan(block.tile[0]);
    expect(plate.tile[1]).toBe(block.tile[1]);
  });

  it('chaque mécanisme porte une étiquette ; clés, leviers, plaques colorées désignent un slot 0..3', () => {
    for (const r of level3.rooms) {
      for (const m of r.mechanisms) {
        // convention mech.level3.<salle>.<id> ; les braseros peuvent partager une étiquette de salle (fire, pyre…)
        if (m.type === 'brazier') expect(m.labelKey?.startsWith(`mech.level3.${r.id}.`), `${r.id}.${m.id}`).toBe(true);
        else expect(m.labelKey, `${r.id}.${m.id}`).toBe(`mech.level3.${r.id}.${m.id}`);
      }
    }
    for (const m of all) {
      if (m.type === 'key') expect([0, 1, 2, 3]).toContain(m.ownerSlot);
      // le tocsin de l'arène est volontairement ouvert à tous (pas de propriétaire)
      if (m.type === 'lever' && m.id !== 'bell') expect([0, 1, 2, 3]).toContain(m.ownerSlot);
    }
    expect(mech(room('arena'), 'bell', 'lever').ownerSlot).toBeUndefined();
  });

  it('clés, leviers et plaques colorées : un par slot, minPlayers = slot + 1 (coop adaptative)', () => {
    const keys = room('seals').mechanisms.filter((m) => m.type === 'key');
    const levers = room('balconies').mechanisms.filter((m) => m.type === 'lever');
    const plates = room('gate').mechanisms.filter((m) => m.type === 'plate');
    for (const group of [keys, levers, plates]) {
      expect(group.length).toBe(4);
      group.forEach((m, slot) => {
        expect(m.minPlayers ?? 1, m.id).toBe(slot === 0 ? 1 : slot + 1);
        if (m.type === 'key' || m.type === 'lever') expect(m.ownerSlot).toBe(slot);
        if (m.type === 'plate') expect(m.colorSlot).toBe(slot);
      });
    }
    // portes de clés : même minPlayers que leur clé
    for (const door of room('seals').mechanisms.filter((m) => m.type === 'door')) {
      const key = keys.find((k) => k.type === 'key' && k.doorId === door.id);
      expect(door.minPlayers ?? 1).toBe(key?.minPlayers ?? 1);
    }
  });

  it('la fenêtre effective des leviers est identique (20 s) quel que soit le nombre de joueurs', () => {
    const balconies = room('balconies');
    for (const n of PLAYER_COUNTS) {
      for (const m of balconies.mechanisms) {
        if (m.type !== 'lever' || (m.minPlayers ?? 1) > n) continue;
        expect(effectiveLeverWindowMs(balconies, n, m), `n=${n} ${m.id}`).toBe(LEVER_WINDOW_MS);
      }
    }
  });

  it("balcons : fenêtre adaptée aux distances (écart d'arrivée entre leviers + marge, marche lente 3,4 tuiles/s)", () => {
    const r = room('balconies');
    const dist = pathDistances(r, r.playerSpawns[0]);
    const d = r.mechanisms.flatMap((m) => (m.type === 'lever' ? [dist.get(m.tile[1] * 1000 + m.tile[0]) ?? Infinity] : []));
    expect(d.length).toBe(4);
    for (const x of d) expect(Number.isFinite(x)).toBe(true);
    const spreadS = (Math.max(...d) - Math.min(...d)) / SLOW_TILES_PER_S;
    const farthestS = Math.max(...d) / SLOW_TILES_PER_S;
    expect(farthestS, "trajet le plus long depuis l'arrivée").toBeLessThanOrEqual(30);
    expect(LEVER_WINDOW_MS / 1000, "fenêtre ≥ écart d'arrivée + 10 s de marge").toBeGreaterThanOrEqual(spreadS + 10);
  });

  it('épreuves écartées : clés, plaques, leviers et piédestaux sont loin les uns des autres et de l\'arrivée', () => {
    const minPairDist = (tiles: TileXY[]): number => {
      let best = Infinity;
      for (let i = 0; i < tiles.length; i++) {
        for (let j = i + 1; j < tiles.length; j++) {
          best = Math.min(best, Math.hypot(tiles[i][0] - tiles[j][0], tiles[i][1] - tiles[j][1]));
        }
      }
      return best;
    };
    const tilesOf = (roomId: string, type: 'key' | 'plate' | 'lever'): TileXY[] =>
      room(roomId).mechanisms.flatMap((m) => (m.type === type ? [m.tile] : []));
    expect(minPairDist(tilesOf('seals', 'key'))).toBeGreaterThanOrEqual(30);
    expect(minPairDist(tilesOf('gate', 'plate'))).toBeGreaterThanOrEqual(25);
    expect(minPairDist(tilesOf('balconies', 'lever'))).toBeGreaterThanOrEqual(40);
    const rune = mech(room('sanctum'), 'sanctumRunes', 'runePuzzle');
    expect(minPairDist(rune.pedestals.map((p) => p.tile))).toBeGreaterThanOrEqual(15);
    const cases: [string, 'key' | 'plate' | 'lever'][] = [['gate', 'plate'], ['seals', 'key'], ['balconies', 'lever']];
    for (const [roomId, type] of cases) {
      const sp = room(roomId).playerSpawns[0];
      for (const t of tilesOf(roomId, type)) {
        expect(Math.hypot(t[0] - sp[0], t[1] - sp[1]), `${roomId} ${t}`).toBeGreaterThanOrEqual(14);
      }
    }
  });

  it('les piédestaux de runes sont assez éloignés pour ne pas se déclencher mutuellement', () => {
    const rune = mech(room('sanctum'), 'sanctumRunes', 'runePuzzle');
    expect(rune.visibleToSlot).toBe(1);
    expect(rune.sequence.length).toBe(4);
    expect(rune.pedestals.length).toBe(6);
    for (let i = 0; i < rune.pedestals.length; i++) {
      for (let j = i + 1; j < rune.pedestals.length; j++) {
        const a = tileCenterPx(rune.pedestals[i].tile);
        const b = tileCenterPx(rune.pedestals[j].tile);
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(2 * INTERACT_RANGE);
      }
    }
  });

  it('chaque salle a au moins un mécanisme coopératif présent dès 1 joueur (sauf le boss)', () => {
    const coop = new Set(['plate', 'lever', 'key', 'block', 'runePuzzle']);
    for (const r of level3.rooms.slice(0, -1)) {
      expect(r.mechanisms.some((m) => coop.has(m.type) && (m.minPlayers ?? 1) <= 1), r.id).toBe(true);
    }
  });
});

// ───────────────────────────── Objectifs ─────────────────────────────

describe('level3 — objectifs personnels', () => {
  it('un objectif par slot 0..3, de types variés, répartis sur plusieurs salles', () => {
    expect(level3.objectives.map((o) => o.slot).sort()).toEqual([0, 1, 2, 3]);
    expect(new Set(level3.objectives.map((o) => o.kind))).toEqual(new Set(['mechanism', 'zone', 'kills']));
    expect(new Set(level3.objectives.map((o) => o.roomId)).size).toBe(4);
    for (const o of level3.objectives) {
      expect(o.labelKey).toBe(`objective.level3.${o.id}`);
      expect(o.roomId).not.toBe('throne');
    }
  });

  /** Jetons obligatoires pour sortir d'une salle : exit.requires + fermeture récursive via les portes. */
  function requiredTokens(r: RoomDef): Set<string> {
    const seen = new Set<string>();
    const visit = (token: string): void => {
      if (seen.has(token)) return;
      seen.add(token);
      const m = r.mechanisms.find((x) => x.id === token);
      if (m?.type === 'door') {
        m.requires.forEach(visit);
        if (m.keyId) visit(m.keyId);
      }
    };
    r.exit.requires.forEach(visit);
    return seen;
  }

  it('on ne peut pas quitter une salle sans avoir accompli l\'objectif qu\'elle porte (aucun objectif manquable)', () => {
    for (const o of level3.objectives) {
      const tokens = requiredTokens(room(o.roomId));
      const gated = tokens.has(`obj:${o.id}`) || (o.mechanismId !== undefined && tokens.has(o.mechanismId));
      expect(gated, `objectif ${o.id} dans ${o.roomId}`).toBe(true);
    }
  });

  it('chaque objectif est accomplissable à 1, 2, 3 et 4 joueurs avec le bon propriétaire', () => {
    for (const n of PLAYER_COUNTS) {
      const objs = createObjectives(level3, n);
      for (const o of level3.objectives) {
        const st = objs.find((s) => s.id === o.id);
        expect(st?.ownerId, `${o.id} à ${n}`).toBe(resolveSlot(o.slot, n));
      }
    }
  });
});

// ───────────────────────────── Anti-verrou des blocs ─────────────────────────────

describe('level3 — blocs : couloirs fermés, aucun verrou possible', () => {
  const cases: { roomId: string; blockId: string; target: (r: RoomDef) => TileXY }[] = [
    { roomId: 'forge', blockId: 'forgeBlock', target: (r) => mech(r, 'forgeSocket', 'socket').tile },
    { roomId: 'abyss', blockId: 'abyssBlock', target: (r) => mech(r, 'plateBlock', 'plate').tile },
  ];

  for (const c of cases) {
    it(`${c.roomId} : le bloc avance droit dans un couloir 2×2 fermé jusqu'à sa cible, avec de l'espace derrière`, () => {
      const r = room(c.roomId);
      const grid = new RoomGrid(r.layout);
      const block = mech(r, c.blockId, 'block');
      const [bx, by] = block.tile;
      const [tx, ty] = c.target(r);
      expect(ty).toBe(by);
      expect(tx).toBeGreaterThan(bx);
      expect(tx - bx, `${c.roomId} trajet droit long`).toBeGreaterThanOrEqual(28);
      for (let x = bx; x <= tx; x++) {
        // 2×2 libres sur tout le trajet
        for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
          expect(grid.blocksMovement(x + dx, by + dy), `${c.roomId} trajet [${x + dx},${by + dy}]`).toBe(false);
        }
      }
      // murs de part et d'autre du couloir sur toute sa longueur (pas de poussée latérale, pas d'accès à l'avant du bloc)
      for (let x = bx; x <= tx + 1; x++) {
        expect(grid.blocksMovement(x, by - 1), `${c.roomId} mur nord x=${x}`).toBe(true);
        expect(grid.blocksMovement(x, by + 2), `${c.roomId} mur sud x=${x}`).toBe(true);
      }
      // fond fermé juste après la cible : le bloc s'arrête exactement dessus
      expect(grid.blocksMovement(tx + 2, by)).toBe(true);
      expect(grid.blocksMovement(tx + 2, by + 1)).toBe(true);
      // espace derrière le bloc pour deux pousseurs de front (2 tuiles de profondeur)
      for (const dx of [-1, -2]) {
        expect(grid.blocksMovement(bx + dx, by)).toBe(false);
        expect(grid.blocksMovement(bx + dx, by + 1)).toBe(false);
      }
      // aucun ennemi ni panneau dans le couloir
      for (const e of r.enemies) {
        const inLane = e.tile[0] >= bx && e.tile[0] <= tx + 1 && e.tile[1] >= by && e.tile[1] <= by + 1;
        expect(inLane, `${c.roomId} ennemi dans le couloir`).toBe(false);
      }
    });

    for (const n of PLAYER_COUNTS) {
      it(`${c.roomId} : à ${n} joueur(s), ${Math.min(2, n)} pousseur(s) amènent le bloc exactement sur sa cible`, () => {
        const r = room(c.roomId);
        const block = mech(r, c.blockId, 'block');
        const target = c.target(r);
        expect(requiredPushers(block, n)).toBe(Math.min(2, n));
        const h = new Harness(r, n);
        const pushers = placeWestPushers(h, block.tile, Math.min(2, n));
        const frames = pushEast(pushers);
        let ticks = 0;
        while (h.state<BlockState>(c.blockId).tile[0] !== target[0] || h.state<BlockState>(c.blockId).moving !== null) {
          h.tick([], frames);
          if (++ticks * SIM_STEP_MS > 20000) throw new Error(`bloc bloqué en ${JSON.stringify(h.state<BlockState>(c.blockId).tile)}`);
        }
        expect(h.state<BlockState>(c.blockId).tile).toEqual(target);
        expect(h.state<BlockState>(c.blockId).pos).toEqual({ x: target[0] * TILE, y: target[1] * TILE });
      });
    }

    it(`${c.roomId} : à 2+ joueurs, un seul pousseur ne suffit pas`, () => {
      const r = room(c.roomId);
      const block = mech(r, c.blockId, 'block');
      const h = new Harness(r, 2);
      const pushers = placeWestPushers(h, block.tile, 1);
      h.wait(3000, pushEast(pushers));
      expect(h.state<BlockState>(c.blockId).tile).toEqual(block.tile);
    });
  }
});

// ───────────────────────────── Résolution des salles, 1 à 4 joueurs ─────────────────────────────

describe.each(PLAYER_COUNTS)('level3 — résolution à %i joueur(s)', (n) => {
  it('gate : les plaques existantes tenues ensemble ouvrent la herse ; une plaque libre la garde fermée', () => {
    const r = room('gate');
    const live = r.mechanisms.filter((m) => m.type === 'plate' && (m.minPlayers ?? 1) <= n);
    expect(live.length).toBe(n);
    // une plaque non tenue : la herse reste fermée (à 1 joueur il n'y a qu'une plaque : on ne teste que n >= 2)
    if (n >= 2) {
      const h = new Harness(r, n);
      live.slice(0, -1).forEach((m, i) => m.type === 'plate' && h.put(i as PlayerId, m.tile));
      h.wait(500);
      expect(h.isOpen('gateDoor')).toBe(false);
    }
    const h = new Harness(r, n);
    live.forEach((m, i) => m.type === 'plate' && h.put(i as PlayerId, m.tile));
    h.wait(200);
    expect(h.isOpen('gateDoor')).toBe(true);
    // la herse reste ouverte une fois les joueurs partis
    h.put(0, [3, 3]);
    h.wait(300);
    expect(h.isOpen('gateDoor')).toBe(true);
    expect(h.exitMet(0)).toBe(true);
    expect(h.exitMet(2)).toBe(false); // gardiens vivants : « clear » non satisfait
  });

  it('seals : chaque héros ramasse sa clé et ouvre sa porte ; les portes des slots absents sont ouvertes d\'office', () => {
    const r = room('seals');
    const h = new Harness(r, n);
    const keys = r.mechanisms.filter((m) => m.type === 'key');
    for (const key of keys) {
      if (key.type !== 'key' || (key.minPlayers ?? 1) > n) continue;
      const owner = resolveSlot(key.ownerSlot, n);
      // un non-propriétaire ne ramasse pas la clé
      if (n >= 2) {
        const other = ((owner + 1) % n) as PlayerId;
        h.put(other, key.tile);
        h.tick();
        expect(h.state<KeyState>(key.id).collected, `${key.id} volée`).toBe(false);
        h.put(other, [30, 24]);
      }
      h.put(owner, key.tile);
      h.tick();
      expect(h.state<KeyState>(key.id).collected, key.id).toBe(true);
      expect(h.players[owner].keys).toContain(key.id);
      // la porte ne s'ouvre qu'avec Action, à portée
      const door = mech(r, key.doorId, 'door');
      const [dx, dy] = door.tiles[0];
      h.put(owner, [dx - 1, dy]);
      h.tick();
      expect(h.isOpen(door.id)).toBe(false);
      h.tick([owner]);
      expect(h.isOpen(door.id), door.id).toBe(true);
    }
    for (const door of r.mechanisms.filter((m) => m.type === 'door')) expect(h.isOpen(door.id), door.id).toBe(true);
    expect(h.exitMet(0)).toBe(true);
    expect(h.objectiveDone('seal')).toBe(true);
  });

  it('forge : le socle rempli ouvre la porte de la galerie nord', () => {
    const r = room('forge');
    const block = mech(r, 'forgeBlock', 'block');
    const h = new Harness(r, n);
    const frames = pushEast(placeWestPushers(h, block.tile, Math.min(2, n)));
    expect(h.isOpen('forgeDoor')).toBe(false);
    h.wait(14000, frames); // 30 tuiles à ≈ 0,35 s
    expect(h.state<SocketState>('forgeSocket').active).toBe(true);
    expect(h.isOpen('forgeDoor')).toBe(true);
    expect(h.exitMet()).toBe(true);
  });

  it('sanctum : la séquence de runes dans l\'ordre résout l\'énigme ; une erreur la remet à zéro', () => {
    const r = room('sanctum');
    const rune = mech(r, 'sanctumRunes', 'runePuzzle');
    expect(resolveSlot(rune.visibleToSlot, n)).toBeLessThan(n);
    const h = new Harness(r, n);
    const ped = (symbol: string): TileXY => {
      const p = rune.pedestals.find((x) => x.symbol === symbol);
      if (!p) throw new Error(symbol);
      return p.tile;
    };
    // erreur : symbole absent de la séquence en premier
    h.put(0, ped('sun'));
    h.tick([0]);
    expect(h.state<RuneState>('sanctumRunes').progress).toBe(0);
    expect(h.state<RuneState>('sanctumRunes').errorFlashMs).toBeGreaterThan(0);
    // bonne séquence, un pas par pression
    rune.sequence.forEach((symbol, i) => {
      const actor = (i % n) as PlayerId; // plusieurs héros se partagent les piédestaux
      h.put(actor, ped(symbol));
      h.tick([actor]);
      expect(h.state<RuneState>('sanctumRunes').progress).toBe(i + 1);
    });
    expect(h.state<RuneState>('sanctumRunes').active).toBe(true);
    expect(h.isOpen('sanctumDoor')).toBe(true);
  });

  it('balconies : leviers pulsés dans la fenêtre ouvrent la herse ; trop espacés, elle reste fermée', () => {
    const r = room('balconies');
    const levers = r.mechanisms.filter((m) => m.type === 'lever' && (m.minPlayers ?? 1) <= n);
    expect(levers.length).toBe(n);
    // dans la fenêtre : 800 ms entre chaque tirage (les joueurs se sont annoncés)
    const h = new Harness(r, n);
    for (const lv of levers) {
      if (lv.type !== 'lever') continue;
      const owner = resolveSlot(lv.ownerSlot ?? 0, n);
      h.put(owner, lv.tile);
      h.tick([owner]);
      h.wait(800);
    }
    expect(h.isOpen('balconyDoor')).toBe(true);
    expect(h.objectiveDone('lever')).toBe(true);
    // un levier réservé ne s'actionne pas par un autre héros
    if (n >= 2) {
      const h2 = new Harness(r, n);
      const lv = levers[1];
      if (lv.type === 'lever') {
        h2.put(0, lv.tile);
        h2.tick([0]);
        expect(h2.state<LeverState>(lv.id).active).toBe(false);
      }
    }
    // trop espacés : le premier levier est retombé avant le dernier tirage
    if (n >= 2) {
      const h3 = new Harness(r, n);
      for (const lv of levers) {
        if (lv.type !== 'lever') continue;
        const owner = resolveSlot(lv.ownerSlot ?? 0, n);
        h3.put(owner, lv.tile);
        h3.tick([owner]);
        h3.wait(LEVER_WINDOW_MS + 1000);
      }
      expect(h3.isOpen('balconyDoor')).toBe(false);
    }
  });

  it('abyss : bloc sur la plaque + plaque de l\'îlot (3+ joueurs) ouvrent la porte', () => {
    const r = room('abyss');
    const block = mech(r, 'abyssBlock', 'block');
    const island = mech(r, 'plateIsland', 'plate');
    const h = new Harness(r, n);
    const pushers = placeWestPushers(h, block.tile, Math.min(2, n));
    h.wait(14000, pushEast(pushers));
    expect(h.state<PlateState>('plateBlock').pressedBy).toBe('block');
    if (n >= 3) {
      expect(h.isOpen('abyssDoor')).toBe(false);
      h.put(2, island.tile);
      h.wait(100);
    } else {
      expect(h.state<PlateState>('plateIsland').waived).toBe(true);
    }
    expect(h.isOpen('abyssDoor')).toBe(true);
    expect(h.exitMet()).toBe(true);
  });

  it('arena : le tocsin se tire une seule fois ; le quota du héros vert est accompli par ses propres coups fatals', () => {
    const r = room('arena');
    const bell = mech(r, 'bell', 'lever');
    const h = new Harness(r, n);
    h.put(0, bell.tile);
    h.tick([0]);
    expect(h.state<LeverState>('bell').active).toBe(true);
    h.wait(5000);
    expect(h.state<LeverState>('bell').active).toBe(true); // verrouillant
    const slayer = resolveSlot(2, n);
    const other = ((slayer + 1) % n) as PlayerId;
    if (n >= 2) {
      for (let i = 0; i < 5; i++) h.tick([], {}, [{ byPlayer: other }]);
      expect(h.objectiveDone('slayer')).toBe(false);
    }
    for (let i = 0; i < 3; i++) h.tick([], {}, [{ byPlayer: slayer }]);
    expect(h.objectiveDone('slayer')).toBe(true);
    // sortie : tocsin + arène nettoyée + objectif
    expect(h.exitMet(0)).toBe(true);
    expect(h.exitMet(1)).toBe(false);
  });

  it('dais : tenir le dais 10 s (+ sceau tenu à 2+ joueurs) ouvre la porte ; sans le sceau elle reste fermée', () => {
    const r = room('dais');
    const holder = resolveSlot(1, n);
    const guard = resolveSlot(0, n);
    const daisTile = mech(r, 'daisPlate', 'plate').tile;
    const sealTile = mech(r, 'sealPlate', 'plate').tile;

    // sans le sceau (n >= 2) : objectif accompli mais porte fermée
    if (n >= 2) {
      const h = new Harness(r, n);
      h.put(holder, daisTile);
      h.wait(11000);
      expect(h.objectiveDone('hold')).toBe(true);
      expect(h.isOpen('daisDoor')).toBe(false);
      h.put(guard, sealTile);
      h.tick();
      expect(h.isOpen('daisDoor')).toBe(true);
    }

    // chemin nominal : les deux plaques tenues tout du long
    const h = new Harness(r, n);
    h.put(holder, daisTile);
    if (n >= 2) h.put(guard, sealTile);
    h.wait(9000);
    expect(h.objectiveDone('hold')).toBe(false);
    expect(h.isOpen('daisDoor')).toBe(false);
    h.wait(2000);
    expect(h.objectiveDone('hold')).toBe(true);
    expect(h.isOpen('daisDoor')).toBe(true);
    expect(h.exitMet(0)).toBe(true);
    expect(h.exitMet(1)).toBe(false);
  });
});

// ───────────────────────────── Salles sombres et torches ─────────────────────────────

/** Les trois salles sombres, de natures différentes : forge (blocs 2×2), sanctuaire (énigme d'allumage), gouffre (traversée). */
const DARK_ROOMS = ['forge', 'sanctum', 'abyss'] as const;
const COLOR_IDS = ['Blue', 'Red', 'Green', 'Yellow'] as const;
const NEIGHBORS = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;

function brazierDefs(r: RoomDef): BrazierDef[] {
  return r.mechanisms.filter((m): m is BrazierDef => m.type === 'brazier');
}

function litBraziers(r: RoomDef): BrazierDef[] {
  return brazierDefs(r).filter((b) => b.lit === true);
}

function torchTiles(r: RoomDef): TileXY[] {
  return (r.decor ?? []).filter((d) => d.type === 'torch').map((d) => d.tile);
}

function dist2(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/**
 * Distances de marche (4-connexe, sol, braseros solides) depuis `sources` (tuiles de départ, même solides).
 * `closedDoors` : ids de portes considérées FERMÉES (tuiles bloquantes) ; les autres sont franchissables.
 */
function flood(r: RoomDef, sources: TileXY[], closedDoors: string[] = []): Map<number, number> {
  const grid = new RoomGrid(r.layout);
  const solid = new Set<number>();
  for (const b of brazierDefs(r)) solid.add(b.tile[1] * 1000 + b.tile[0]);
  for (const m of r.mechanisms) {
    if (m.type === 'door' && closedDoors.includes(m.id)) for (const [x, y] of m.tiles) solid.add(y * 1000 + x);
  }
  const dist = new Map<number, number>();
  const queue: TileXY[] = [];
  for (const s of sources) {
    dist.set(s[1] * 1000 + s[0], 0);
    queue.push(s);
  }
  for (let i = 0; i < queue.length; i++) {
    const [x, y] = queue[i];
    const d = dist.get(y * 1000 + x) ?? 0;
    for (const [dx, dy] of NEIGHBORS) {
      const k = (y + dy) * 1000 + (x + dx);
      if (dist.has(k) || solid.has(k) || grid.blocksMovement(x + dx, y + dy)) continue;
      dist.set(k, d + 1);
      queue.push([x + dx, y + dy]);
    }
  }
  return dist;
}

/** La tuile (ou une voisine) est-elle atteinte par `reach` ? (mécanismes solides : on les atteint depuis une voisine) */
function touches(reach: Map<number, number>, t: TileXY): boolean {
  return reach.has(t[1] * 1000 + t[0]) || NEIGHBORS.some(([dx, dy]) => reach.has((t[1] + dy) * 1000 + (t[0] + dx)));
}

/** Une tuile de sol voisine (4-connexe) d'un mécanisme solide, pour y poser un héros à portée d'Action. */
function standNear(r: RoomDef, tile: TileXY): TileXY {
  const grid = new RoomGrid(r.layout);
  const occupied = new Set(brazierDefs(r).map((b) => `${b.tile[0]},${b.tile[1]}`));
  for (const [dx, dy] of [[0, 1], [1, 0], [-1, 0], [0, -1]] as const) {
    const x = tile[0] + dx;
    const y = tile[1] + dy;
    if (!grid.blocksMovement(x, y) && !occupied.has(`${x},${y}`)) return [x, y];
  }
  throw new Error(`aucune tuile libre près de ${tile}`);
}

describe('level3 — salles sombres et torches', () => {
  it("la forge, le sanctuaire et le gouffre sont sombres ; l'arène et le trône ne le sont pas", () => {
    expect(level3.rooms.filter((r) => r.dark === true).map((r) => r.id).sort()).toEqual([...DARK_ROOMS].sort());
    expect(room('arena').dark).not.toBe(true);
    expect(room('throne').dark).not.toBe(true);
    // trois natures différentes : bloc sur socle, énigme d'allumage, traversée de gouffre
    expect(room('forge').mechanisms.some((m) => m.type === 'socket')).toBe(true);
    expect(room('sanctum').mechanisms.some((m) => m.type === 'runePuzzle')).toBe(true);
    expect(room('abyss').layout.some((row) => row.includes('~'))).toBe(true);
  });

  for (const id of DARK_ROOMS) {
    it(`${id} : braseros allumés accessibles à pied, départ éclairé, jamais loin d'un point de recharge`, () => {
      const r = room(id);
      const lit = litBraziers(r);
      expect(lit.length, 'braseros allumés').toBeGreaterThanOrEqual(id === 'abyss' ? 8 : 4);
      const reach = flood(r, [r.playerSpawns[0]]);
      for (const b of lit) {
        expect(touches(reach, b.tile), `${b.id} atteignable`).toBe(true);
        expect(b.minPlayers ?? 1, `${b.id} présent dès 1 joueur`).toBe(1);
        expect(b.ownerSlot, `${b.id} ouvert à tous`).toBeUndefined();
      }
      // départ éclairé : chaque spawn à ≤ LIGHT_FULL_TILES d'un brasero allumé ou d'une torche
      const sources = [...lit.map((b) => b.tile), ...torchTiles(r)];
      for (const s of r.playerSpawns) {
        expect(Math.min(...sources.map((t) => dist2(t, s))), `spawn ${s}`).toBeLessThanOrEqual(LIGHT_FULL_TILES);
      }
      // tout point praticable est à ≤ 45 pas de marche d'un brasero allumé (une torche de 75 s ≈ 250 pas : large marge)
      const fromFires = flood(r, lit.map((b) => b.tile));
      let worst = 0;
      for (const k of reach.keys()) worst = Math.max(worst, fromFires.get(k) ?? Infinity);
      expect(worst, "pas jusqu'au point de recharge le plus proche").toBeLessThanOrEqual(45);
      // points de recharge espacés (pas d'empilement)
      for (let i = 0; i < lit.length; i++) {
        for (let j = i + 1; j < lit.length; j++) {
          expect(dist2(lit[i].tile, lit[j].tile), `${lit[i].id} / ${lit[j].id}`).toBeGreaterThanOrEqual(8);
        }
      }
    });

    it(`${id} : peu de torches murales (reste sombre), braseros solides sans gêner spawns, ennemis ni portes`, () => {
      const r = room(id);
      expect(torchTiles(r).length).toBeLessThanOrEqual(16);
      const fires = brazierDefs(r);
      const taken = new Set<string>([
        ...r.playerSpawns.map((t) => t.join(',')),
        ...r.enemies.map((e) => e.tile.join(',')),
        ...r.mechanisms.flatMap((m) => (m.type === 'door' ? m.tiles.map((t) => t.join(',')) : [])),
      ]);
      const grid = new RoomGrid(r.layout);
      for (const b of fires) {
        expect(taken.has(b.tile.join(',')), `${b.id} recouvre quelque chose`).toBe(false);
        expect(grid.blocksMovement(b.tile[0], b.tile[1]), `${b.id} sur du sol`).toBe(false);
        expect(b.labelKey?.startsWith(`mech.level3.${id}.`), `${b.id} étiquette`).toBe(true);
      }
      // couloir du bloc : aucun brasero dans (ni derrière) la voie du bloc
      for (const m of r.mechanisms) {
        if (m.type !== 'block') continue;
        for (const b of fires) {
          const inLane = b.tile[1] >= m.tile[1] && b.tile[1] <= m.tile[1] + 1 && b.tile[0] >= m.tile[0] && b.tile[0] <= 46;
          expect(inLane, `${b.id} dans le couloir de ${m.id}`).toBe(false);
        }
      }
      // aucun ennemi enfermé : tous atteignables à pied (portes ouvertes), braseros solides compris
      const reach = flood(r, [r.playerSpawns[0]]);
      for (const e of r.enemies) expect(reach.has(e.tile[1] * 1000 + e.tile[0]), `${e.kind} en ${e.tile}`).toBe(true);
    });

    it(`${id} : tout reste faisable dans le noir (épreuves à moins de 3 tuiles d'une torche ou d'un brasero)`, () => {
      const r = room(id);
      const torches = torchTiles(r);
      const lit = litBraziers(r).map((b) => b.tile);
      const seen = (t: readonly number[], radius: number): boolean => torches.some((s) => dist2(s, t) <= radius);
      if (id === 'forge') {
        const socket = mech(r, 'forgeSocket', 'socket').tile;
        expect(seen([socket[0] + 0.5, socket[1] + 0.5], 3), 'socle').toBe(true);
        expect(seen(mech(r, 'forgeBlock', 'block').tile, 3.2), 'départ du bloc').toBe(true);
        expect(seen(mech(r, 'forgeDoor', 'door').tiles[0], 3), 'porte').toBe(true);
      }
      if (id === 'abyss') {
        expect(seen(mech(r, 'plateBlock', 'plate').tile, 3), 'plaque du bloc').toBe(true);
        expect(seen(mech(r, 'abyssDoor', 'door').tiles[0], 3), 'porte').toBe(true);
        // la plaque de l'îlot est tenue sous le feu des archers : brasero allumé sur l'îlot, à portée de lumière
        expect(Math.min(...lit.map((t) => dist2(t, mech(r, 'plateIsland', 'plate').tile))), 'îlot').toBeLessThanOrEqual(5);
        expect(Math.min(...lit.map((t) => dist2(t, mech(r, 'abyssBlock', 'block').tile))), 'bloc').toBeLessThanOrEqual(10);
      }
      if (id === 'sanctum') {
        const rune = mech(r, 'sanctumRunes', 'runePuzzle');
        expect(seen(rune.displayTile, 3.1), 'séquence de runes').toBe(true);
        for (const sym of rune.sequence) {
          const t = rune.pedestals.find((p) => p.symbol === sym)?.tile as TileXY;
          expect(seen(t, 3), `piédestal ${sym}`).toBe(true);
          expect(Math.min(...lit.map((b) => dist2(b, t))), `recharge près de ${sym}`).toBeLessThanOrEqual(8);
        }
        expect(seen(mech(r, 'nicheDoor', 'door').tiles[0], 3), 'porte de la niche').toBe(true);
        expect(seen(mech(r, 'sanctumDoor', 'door').tiles[0], 3), 'porte du sanctuaire').toBe(true);
      }
    });
  }

  it("forge et gouffre : les braseros éteints sont facultatifs (aucune exigence ne dépend d'eux)", () => {
    for (const id of ['forge', 'abyss'] as const) {
      const r = room(id);
      const unlit = brazierDefs(r).filter((b) => b.lit !== true);
      expect(unlit.length, id).toBeGreaterThanOrEqual(1);
      const ids = new Set(unlit.map((b) => b.id));
      const tokens = [
        ...r.exit.requires,
        ...r.mechanisms.flatMap((m) => (m.type === 'door' ? m.requires : [])),
        ...r.enemies.flatMap((e) => (e.when ? [e.when] : [])),
      ];
      for (const t of tokens) expect(ids.has(t), `${id} : "${t}" ne doit pas dépendre d'un brasero facultatif`).toBe(false);
    }
  });

  it("l'arène reste éclairée par des braseros allumés (ambiance) sans être sombre ; le tocsin est hors de portée", () => {
    const r = room('arena');
    const lit = litBraziers(r);
    expect(r.dark).not.toBe(true);
    expect(lit.length).toBeGreaterThanOrEqual(4);
    for (const b of lit) expect(b.lightRadiusTiles ?? 0, b.id).toBeGreaterThanOrEqual(6);
    const bell = mech(r, 'bell', 'lever').tile;
    for (const b of lit) expect(dist2(b.tile, bell), `${b.id} / tocsin`).toBeGreaterThan(3);
    expect(touches(flood(r, [r.playerSpawns[0]]), bell)).toBe(true);
  });

  it('une torche vide se recharge au brasero allumé (moteur réel)', () => {
    for (const id of DARK_ROOMS) {
      const r = room(id);
      const fire = litBraziers(r)[0];
      const h = new Harness(r, 1);
      h.players[0].torchMs = 1000;
      h.put(0, standNear(r, fire.tile));
      h.tick([0]);
      expect(h.players[0].torchMs, id).toBe(TORCH_MAX_MS);
    }
  });

  it('la première salle sombre du niveau (forge) enseigne la torche ; chaque salle sombre le rappelle', () => {
    expect(level3.rooms.find((r) => r.dark === true)?.id).toBe('forge');
    const fr = readPart('fr');
    const en = readPart('en');
    expect(fr['sign.level3.forge.dark']).toMatch(/torche/);
    expect(fr['sign.level3.forge.dark']).toMatch(/brasero/);
    expect(en['sign.level3.forge.dark']).toMatch(/torch/);
    expect(en['sign.level3.forge.dark']).toMatch(/brazier/);
    for (const id of DARK_ROOMS) {
      const r = room(id);
      expect((r.signs ?? []).some((s) => s.textKey === `sign.level3.${id}.dark`), `${id} panneau`).toBe(true);
      expect(fr[`hintroom.level3.${id}`], id).toMatch(/brasero/);
      expect(en[`hintroom.level3.${id}`], id).toMatch(/brazier/);
    }
    expect(fr['sign.level3.abyss.dark']).toMatch(/brasero/);
    expect(fr['sign.level3.sanctum.niche']).toMatch(/braseros/);
  });
});

describe('level3 — sanctuaire : chacun allume SON brasero', () => {
  const r = room('sanctum');
  const colored = COLOR_IDS.map((c) => mech(r, `sanctumBrazier${c}`, 'brazier'));

  it('quatre braseros éteints, un par slot (ownerSlot 0..3), minPlayers = slot + 1, rayon de lumière défini', () => {
    expect(colored.length).toBe(4);
    colored.forEach((b, slot) => {
      expect(b.lit, b.id).not.toBe(true);
      expect(b.ownerSlot, b.id).toBe(slot);
      expect(b.minPlayers ?? 1, b.id).toBe(slot === 0 ? 1 : slot + 1);
      expect(b.lightRadiusTiles ?? 0, b.id).toBeGreaterThan(0);
    });
    // éloignés des piédestaux (l'Action d'un brasero ne vole jamais celle d'un piédestal)
    const rune = mech(r, 'sanctumRunes', 'runePuzzle');
    for (const b of colored) {
      for (const p of rune.pedestals) {
        const a = tileCenterPx(b.tile);
        const c = tileCenterPx(p.tile);
        expect(Math.hypot(a.x - c.x, a.y - c.y), `${b.id} / ${p.symbol}`).toBeGreaterThan(2 * INTERACT_RANGE);
      }
    }
    // quatre coins du hall : écartés les uns des autres
    for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) expect(dist2(colored[i].tile, colored[j].tile)).toBeGreaterThanOrEqual(12);
  });

  it("la porte de la niche exige les quatre braseros ; l'exigence de sortie existante est conservée", () => {
    const door = mech(r, 'nicheDoor', 'door');
    expect([...door.requires].sort()).toEqual(colored.map((b) => b.id).sort());
    expect(door.minPlayers ?? 1).toBe(1);
    expect(r.exit.requires).toEqual(['sanctumDoor']);
    expect(mech(r, 'sanctumDoor', 'door').requires).toEqual(['sanctumRunes']);
    // fermée, la porte coupe vraiment l'accès à la niche des runes ; les six piédestaux restent accessibles
    const rune = mech(r, 'sanctumRunes', 'runePuzzle');
    const closed = flood(r, [r.playerSpawns[0]], ['nicheDoor']);
    expect(closed.has(rune.displayTile[1] * 1000 + rune.displayTile[0]), 'niche fermée').toBe(false);
    for (const p of rune.pedestals) expect(touches(closed, p.tile), p.symbol).toBe(true);
    const open = flood(r, [r.playerSpawns[0]]);
    expect(open.has(rune.displayTile[1] * 1000 + rune.displayTile[0]), 'niche ouverte').toBe(true);
  });

  for (const n of PLAYER_COUNTS) {
    it(`à ${n} joueur(s) : chaque héros allume le brasero de sa couleur, la niche s'ouvre quand tous brûlent`, () => {
      const h = new Harness(r, n);
      // braseros des slots absents : allumés d'office (waived)
      colored.forEach((b, slot) => {
        const st = h.state<BrazierState>(b.id);
        expect(st.waived, b.id).toBe(slot >= n);
        expect(st.active, b.id).toBe(slot >= n);
      });
      expect(h.isOpen('nicheDoor')).toBe(false);
      for (let slot = 0; slot < n; slot++) {
        const b = colored[slot];
        // un autre héros (s'il y en a un) n'allume pas le brasero d'autrui
        if (n > 1) {
          const other = ((slot + 1) % n) as PlayerId;
          h.put(other, standNear(r, b.tile));
          h.tick([other]);
          expect(h.state<BrazierState>(b.id).active, `${b.id} allumé par un autre`).toBe(false);
        }
        const owner = resolveSlot(b.ownerSlot as number, n) as PlayerId;
        expect(owner).toBe(slot);
        h.put(owner, standNear(r, b.tile));
        h.tick([owner]);
        expect(h.state<BrazierState>(b.id).active, b.id).toBe(true);
        expect(h.state<BrazierState>(b.id).litBy, b.id).toBe(owner);
        h.tick();
        expect(h.isOpen('nicheDoor'), `après ${slot + 1} brasero(s) sur ${n}`).toBe(slot === n - 1);
      }
      // la sortie de la salle exige toujours les runes : la niche ouverte ne suffit pas
      expect(h.isOpen('sanctumDoor')).toBe(false);
      expect(h.exitMet()).toBe(false);
    });
  }

  it('une torche vide ne peut pas allumer un brasero ; elle se recharge au brasero allumé puis allume', () => {
    const h = new Harness(r, 1);
    const blue = colored[0];
    h.players[0].torchMs = 0;
    h.put(0, standNear(r, blue.tile));
    h.tick([0]);
    expect(h.state<BrazierState>(blue.id).active).toBe(false);
    const fire = litBraziers(r)[0];
    h.put(0, standNear(r, fire.tile));
    h.tick([0]);
    expect(h.players[0].torchMs).toBe(TORCH_MAX_MS);
    h.put(0, standNear(r, blue.tile));
    h.tick([0]);
    expect(h.state<BrazierState>(blue.id).active).toBe(true);
    expect(h.isOpen('nicheDoor')).toBe(true);
  });
});

// ───────────────────────────── i18n ─────────────────────────────

describe('level3 — textes (parts i18n)', () => {
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

  it('toutes les clés requises par le niveau sont fournies, et aucune clé orpheline', () => {
    const required = new Set(collectRequiredI18nKeys(level3, { checkSpeakers: true }).map((r) => r.key));
    // les clés speaker.* viennent du dictionnaire de base
    const own = new Set([...required].filter((k) => !k.startsWith('speaker.')));
    expect(new Set(Object.keys(fr))).toEqual(own);
    for (const k of required) expect(Object.prototype.hasOwnProperty.call(getDictionary('en'), k), k).toBe(true);
    for (const k of required) expect(base[k], k).toBeTruthy();
  });

  it('clés bien formées, préfixées par la convention de DESIGN.md §6', () => {
    const prefixes = ['level.level3.', 'room.level3.', 'objective.level3.', 'mech.level3.', 'sign.level3.', 'hintroom.level3.'];
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

  it('intro de 3 à 5 répliques, outro de 2 à 4, orateurs autorisés, Lyssa ouvre sur la suite', () => {
    expect(level3.intro.length).toBeGreaterThanOrEqual(3);
    expect(level3.intro.length).toBeLessThanOrEqual(5);
    expect(level3.outro.length).toBeGreaterThanOrEqual(2);
    expect(level3.outro.length).toBeLessThanOrEqual(4);
    for (const l of [...level3.intro, ...level3.outro]) expect(ALLOWED_SPEAKERS).toContain(l.speaker);
    expect(level3.intro.some((l) => l.speaker === 'morvane')).toBe(true);
    const lastOutro = level3.outro[level3.outro.length - 1];
    expect(lastOutro.speaker).toBe('lyssa');
    expect(fr[lastOutro.textKey]).toMatch(/ombre/);
    expect(en[lastOutro.textKey]).toMatch(/shadow/);
  });

  it('les consignes citent la bonne couleur de slot (rouge = vision des runes et dais, vert = quota et îlot, bleu = sceau)', () => {
    expect(fr['sign.level3.sanctum.seer']).toMatch(/rouge/);
    expect(fr['sign.level3.dais.hold']).toMatch(/rouge/);
    expect(fr['sign.level3.dais.seal']).toMatch(/bleu/);
    expect(fr['sign.level3.arena.quota']).toMatch(/vert/);
    expect(fr['sign.level3.abyss.island']).toMatch(/vert/);
    expect(en['sign.level3.sanctum.seer']).toMatch(/red/);
    expect(en['sign.level3.arena.quota']).toMatch(/green/);
    // les couleurs correspondent aux données : vision des runes = slot 1 (rouge), plaque de l'îlot = slot 2 (vert)
    expect(mech(room('sanctum'), 'sanctumRunes', 'runePuzzle').visibleToSlot).toBe(1);
    expect(mech(room('abyss'), 'plateIsland', 'plate').colorSlot).toBe(2);
    expect(mech(room('dais'), 'daisPlate', 'plate').colorSlot).toBe(1);
    expect(mech(room('dais'), 'sealPlate', 'plate').colorSlot).toBe(0);
    expect(level3.objectives.find((o) => o.id === 'hold')?.slot).toBe(1);
    expect(level3.objectives.find((o) => o.id === 'slayer')?.slot).toBe(2);
  });
});

// ───────────────────────────── Immutabilité / pureté ─────────────────────────────

describe('level3 — données pures', () => {
  it('est sérialisable en JSON sans perte (aucune fonction, aucune classe)', () => {
    const copy = JSON.parse(JSON.stringify(level3)) as typeof level3;
    expect(copy).toEqual(level3);
  });

  it('les tuiles de porte sont du sol dans la grille et forment un passage de 2 tuiles de large', () => {
    for (const r of level3.rooms) {
      const grid = new RoomGrid(r.layout);
      for (const m of r.mechanisms) {
        if (m.type !== 'door') continue;
        expect(m.tiles.length, `${r.id}.${m.id}`).toBe(4);
        for (const [x, y] of m.tiles) expect(grid.blocksMovement(x, y), `${r.id}.${m.id} [${x},${y}]`).toBe(false);
      }
    }
  });
});
