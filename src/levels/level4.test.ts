import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

import { LIGHT_FULL_TILES, SIM_STEP_MS } from '../core/constants';
import { isMiniBossKind } from '../core/enemies';
import { RoomGrid } from '../core/grid';
import { collectRequiredI18nKeys, validateBossStructure, validateLevel } from '../core/levelValidation';
import {
  areAllRequirementsMet,
  createRoomMechanisms,
  effectiveLeverWindowMs,
  statueRotationTarget,
  tileCenterPx,
  updateMechanisms,
} from '../core/mechanisms';
import { createObjectives, isObjectiveDone, updateObjectives } from '../core/objectives';
import { createPlayerState } from '../core/players';
import { resolveSlot } from '../core/slots';
import type {
  BrazierState,
  Dir,
  DoorState,
  EnemyKind,
  LeverState,
  LevelDef,
  MechanismDef,
  MechanismState,
  PlateState,
  PlayerId,
  PlayerState,
  RoomDef,
  StatuePairDef,
  StatuePairState,
  TickInputs,
  TileXY,
} from '../core/types';
import { getDictionary } from '../i18n/i18n';
import { level1 } from './level1';
import { level2 } from './level2';
import { level3 } from './level3';
import { level4 } from './level4';

// ───────────────────────────── Aides ─────────────────────────────

const PLAYER_COUNTS = [1, 2, 3, 4] as const;
const ALLOWED_SPEAKERS = ['narrator', 'aldric', 'lyssa', 'frostqueen', 'heroes'];
const MAX_TEXT = 90;
const ROOM_IDS = ['threshold', 'gallery', 'echoes', 'warden1', 'deepdark', 'spire', 'antechamber', 'throne'];
const STATUE_ROOMS = ['threshold', 'echoes', 'antechamber'];
const DIR_ORDER: Dir[] = ['up', 'right', 'down', 'left'];

function room(id: string): RoomDef {
  const r = level4.rooms.find((x) => x.id === id);
  if (!r) throw new Error(`salle introuvable : ${id}`);
  return r;
}

function mech<T extends MechanismDef['type']>(r: RoomDef, id: string, type: T): Extract<MechanismDef, { type: T }> {
  const m = r.mechanisms.find((x) => x.id === id);
  if (!m || m.type !== type) throw new Error(`mécanisme ${type} introuvable : ${id}`);
  return m as Extract<MechanismDef, { type: T }>;
}

function pairOf(r: RoomDef): StatuePairDef {
  const m = r.mechanisms.find((x) => x.type === 'statuePair');
  if (!m || m.type !== 'statuePair') throw new Error(`aucune paire de statues dans ${r.id}`);
  return m;
}

function enemiesAt(r: RoomDef, n: number) {
  return r.enemies.filter((e) => (e.minPlayers ?? 1) <= n);
}

function totalEnemies(level: LevelDef, n: number): number {
  return level.rooms.reduce((sum, r) => sum + enemiesAt(r, n).length, 0);
}

function turns(from: Dir, to: Dir): number {
  return (DIR_ORDER.indexOf(to) - DIR_ORDER.indexOf(from) + 4) % 4;
}

function dist2(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/** Préfixes des clés du niveau 4 (DESIGN.md §6) et de son orateur propre. */
const LEVEL4_KEY_PREFIXES = ['level.level4.', 'room.level4.', 'objective.level4.', 'mech.level4.', 'sign.level4.', 'hintroom.level4.'];

/**
 * Textes du niveau 4 : la « part » `src/i18n/parts/level4.<lang>.json` tant qu'elle existe ; après `npm run i18n:merge` (qui fusionne
 * puis SUPPRIME les parts), les mêmes clés sont déduites du dictionnaire fusionné (`getDictionary`, qui marche avant comme après).
 * Jamais appelée à la collecte : la lecture se fait dans `beforeAll`.
 */
function level4Texts(lang: 'fr' | 'en', partsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'i18n', 'parts')): Record<string, string> {
  const file = path.join(partsDir, `level4.${lang}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(getDictionary(lang))) {
    if (k === 'speaker.frostqueen' || LEVEL4_KEY_PREFIXES.some((p) => k.startsWith(p))) out[k] = v;
  }
  return out;
}

function readPart(lang: 'fr' | 'en'): Record<string, string> {
  return level4Texts(lang);
}

function placeholders(value: string): string[] {
  return Array.from(new Set(Array.from(value.matchAll(/\{(\w+)\}/g), (m) => m[1]))).sort();
}

/** Distances (en pas, 4-connexe, solides de mécanismes ignorés sauf braseros/statues) depuis des tuiles : clé = y*1000+x. */
function flood(r: RoomDef, from: readonly TileXY[]): Map<number, number> {
  const grid = new RoomGrid(r.layout);
  const solid = new Set<number>();
  for (const m of r.mechanisms) {
    if (m.type === 'brazier') solid.add(m.tile[1] * 1000 + m.tile[0]);
    if (m.type === 'statuePair') for (const s of m.statues) solid.add(s.tile[1] * 1000 + s.tile[0]);
  }
  const dist = new Map<number, number>();
  const queue: TileXY[] = [];
  for (const f of from) {
    dist.set(f[1] * 1000 + f[0], 0);
    queue.push([f[0], f[1]]);
  }
  for (let i = 0; i < queue.length; i++) {
    const [x, y] = queue[i];
    const d = dist.get(y * 1000 + x) ?? 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx;
      const ny = y + dy;
      const k = ny * 1000 + nx;
      if (grid.blocksMovement(nx, ny) || solid.has(k) || dist.has(k)) continue;
      dist.set(k, d + 1);
      queue.push([nx, ny]);
    }
  }
  return dist;
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
    this.objectives = createObjectives(level4, n);
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

  tick(press: PlayerId[] = [], frames: TickInputs = {}): void {
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
      level: level4,
      room: this.room,
      objectives: this.objectives,
      players: this.players,
      mechanisms: this.mechanisms,
      deaths: [],
      dtMs: SIM_STEP_MS,
    });
    this.elapsedMs += SIM_STEP_MS;
  }

  wait(ms: number): void {
    const ticks = Math.ceil(ms / SIM_STEP_MS);
    for (let i = 0; i < ticks; i++) this.tick();
  }

  exitMet(alive = 0): boolean {
    return areAllRequirementsMet(this.room.exit.requires, {
      mechanisms: this.mechanisms,
      aliveEnemyCount: alive,
      objectiveDone: (id) => isObjectiveDone(this.objectives, id),
      zoneOccupied: () => false,
    });
  }
}

// ───────────────────────────── Validité globale ─────────────────────────────

describe('level4 — validation', () => {
  it('validateLevel (dictionnaires fr + en, orateurs) ne retourne aucune erreur à 1, 2, 3 et 4 joueurs', () => {
    // validateLevel contrôle l'atteignabilité et la satisfiabilité pour n = 1..4 (voir levelValidation.ts)
    const errors = validateLevel(level4, {
      dictionaries: { fr: getDictionary('fr'), en: getDictionary('en') },
      checkSpeakers: true,
    });
    expect(errors).toEqual([]);
  });

  it('validateBossStructure (≥ 2 demi-boss, boss final) ne retourne aucune erreur', () => {
    expect(validateBossStructure(level4, { minMiniBosses: 2 })).toEqual([]);
  });

  it('identité du niveau : id, thème frost, nom, durée estimée', () => {
    expect(level4.id).toBe('level4');
    expect(level4.theme).toBe('frost');
    expect(level4.nameKey).toBe('level.level4.name');
    expect(getDictionary('fr')['level.level4.name']).toBe('Les Cavernes de Givre');
    expect(level4.estimatedMinutes).toBeGreaterThanOrEqual(5);
    expect(level4.estimatedMinutes).toBeLessThanOrEqual(10);
    for (const r of level4.rooms) expect(r.theme).toBe('frost');
  });

  it('compte 8 salles dans l\'ordre prévu (au moins 6 exigées)', () => {
    expect(level4.rooms.length).toBeGreaterThanOrEqual(6);
    expect(level4.rooms.map((r) => r.id)).toEqual(ROOM_IDS);
  });

  it('chaque salle est vaste (54..86 × 40..52 tuiles), murée sur le pourtour, avec 4 spawns groupés', () => {
    for (const r of level4.rooms) {
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
    }
  });

  it("chaque salle a un nom, un indice d'arrivée, au moins un panneau et trois décors", () => {
    for (const r of level4.rooms) {
      expect(r.nameKey).toBe(`room.level4.${r.id}.name`);
      expect(r.introHintKey).toBe(`hintroom.level4.${r.id}`);
      expect((r.signs ?? []).length, `${r.id} panneaux`).toBeGreaterThanOrEqual(1);
      expect((r.decor ?? []).length, `${r.id} décors`).toBeGreaterThanOrEqual(3);
    }
  });

  it('est sérialisable en JSON sans perte (aucune fonction, aucune classe)', () => {
    expect(JSON.parse(JSON.stringify(level4))).toEqual(level4);
  });

  it("n'utilise aucune source d'aléatoire ni d'horloge (déterministe)", () => {
    const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'level4.ts'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/Math\.random|Date\.now|new Date|performance\.now/);
  });
});

// ───────────────────────────── Demi-boss, boss, sortie finale ─────────────────────────────

describe('level4 — demi-boss et boss de fin', () => {
  const last = level4.rooms[level4.rooms.length - 1];
  const miniRooms = level4.rooms.filter((r) => r.enemies.some((e) => isMiniBossKind(e.kind)));

  it('au moins deux salles de demi-boss (gardien de givre), présents à tout nombre de joueurs', () => {
    expect(miniRooms.length).toBeGreaterThanOrEqual(2);
    for (const r of miniRooms) {
      for (const e of r.enemies.filter((x) => isMiniBossKind(x.kind))) {
        expect(e.kind).toBe('warden');
        expect(e.minPlayers ?? 1, `${r.id} demi-boss`).toBe(1);
        expect(e.when, `${r.id} demi-boss`).toBeUndefined();
      }
    }
  });

  it('un demi-boss est à mi-parcours (index de salle entre 25 % et 65 %) et un autre dans une salle clé plus tard', () => {
    const idx = level4.rooms.map((r, i) => (miniRooms.includes(r) ? i : -1)).filter((i) => i >= 0);
    const fractions = idx.map((i) => i / (level4.rooms.length - 1));
    expect(fractions.some((f) => f >= 0.25 && f <= 0.65), `fractions ${fractions}`).toBe(true);
    expect(Math.max(...idx)).toBeGreaterThan(Math.min(...idx));
    expect(Math.max(...fractions)).toBeGreaterThan(0.65);
  });

  it("la sortie de chaque salle de demi-boss exige 'clear', et ils sont accompagnés de sbires qui suivent les joueurs", () => {
    for (const r of miniRooms) {
      expect(r.exit.requires, r.id).toContain('clear');
      const minions = (n: number) => enemiesAt(r, n).filter((e) => !isMiniBossKind(e.kind)).length;
      expect(minions(1), `${r.id} sbires à 1 joueur`).toBeGreaterThanOrEqual(12);
      expect(minions(4), `${r.id} sbires à 4 joueurs`).toBeGreaterThan(minions(1));
    }
  });

  it('la dernière salle est une arène de boss sans mécanisme : la Reine du Givre (présente à tout n), sortie scellée', () => {
    expect(last.id).toBe('throne');
    expect(last.mechanisms).toEqual([]);
    const queens = last.enemies.filter((e) => e.kind === 'frostqueen');
    expect(queens.length).toBe(1);
    expect(queens[0].minPlayers ?? 1).toBe(1);
    expect(queens[0].when).toBeUndefined();
    expect(queens[0].wave).toBeUndefined();
    expect(last.exit.final).toBe(true);
    expect(last.exit.sealed).toBe(true);
    expect(last.exit.requires).toContain('clear');
    for (const o of level4.objectives) expect(last.exit.requires).toContain(`obj:${o.id}`);
    for (const r of level4.rooms.slice(0, -1)) {
      expect(r.exit.final, r.id).toBeFalsy();
      expect(r.exit.sealed, r.id).toBeFalsy();
      expect(r.enemies.some((e) => e.kind === 'frostqueen'), r.id).toBe(false);
    }
    const pillars = last.layout.join('').split('o').length - 1;
    expect(pillars).toBeGreaterThanOrEqual(12);
  });

  it("la garde de la Reine grossit avec les joueurs : seule à 1 joueur, escortée dès 2, et le climax ne se réduit pas à un duel à 4", () => {
    const guard = (n: number) => enemiesAt(last, n).filter((e) => e.kind !== 'frostqueen');
    expect(guard(1)).toEqual([]);
    expect(guard(2).length).toBeGreaterThanOrEqual(3);
    expect(guard(3).length).toBeGreaterThan(guard(2).length);
    expect(guard(4).length).toBeGreaterThan(guard(3).length);
    expect(guard(4).length).toBeGreaterThanOrEqual(10);
    const normal: readonly EnemyKind[] = ['slime', 'bat', 'skeleton', 'archer', 'spider', 'wisp', 'knight'];
    for (const e of last.enemies.filter((x) => x.kind !== 'frostqueen')) {
      expect(normal, `${e.kind} ${e.tile}`).toContain(e.kind);
      expect(e.minPlayers ?? 1, `${e.kind} ${e.tile}`).toBeGreaterThanOrEqual(2);
      expect(e.when).toBeUndefined();
      expect(e.wave).toBeUndefined();
    }
    // la garde ne touche pas au boss : mêmes PV de Reine à tout n (aucun champ de PV dans les données du niveau)
    expect(Object.keys(last.enemies.find((e) => e.kind === 'frostqueen') ?? {}).sort()).toEqual(['kind', 'tile']);
  });

  it("la sortie finale reste scellée tant qu'un objectif manque, et s'ouvre quand tout est accompli", () => {
    const h = new Harness(last, 2);
    expect(h.exitMet(1)).toBe(false);
    expect(h.exitMet(0)).toBe(false);
    for (const st of h.objectives) st.done = true;
    expect(h.exitMet(1)).toBe(false);
    expect(h.exitMet(0)).toBe(true);
  });
});

// ───────────────────────────── Ennemis ─────────────────────────────

describe('level4 — ennemis', () => {
  it("à CHAQUE effectif (n = 1, 2, 3 et 4), au moins 25 % d'ennemis de plus que le MAXIMUM des niveaux 1, 2 et 3 au même n", () => {
    for (const n of PLAYER_COUNTS) {
      const best = Math.max(totalEnemies(level1, n), totalEnemies(level2, n), totalEnemies(level3, n));
      const mine = totalEnemies(level4, n);
      expect(mine, `n=${n} : ${mine} vs max ${best}`).toBeGreaterThanOrEqual(Math.ceil(best * 1.25));
    }
  });

  it('le nombre d\'ennemis ne dépend que des joueurs : champs autorisés, minPlayers 1..4, croissance monotone', () => {
    const allowed = new Set(['kind', 'tile', 'wave', 'when', 'minPlayers']);
    for (const r of level4.rooms) {
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
    const totals = PLAYER_COUNTS.map((n) => totalEnemies(level4, n));
    for (let i = 1; i < totals.length; i++) expect(totals[i]).toBeGreaterThan(totals[i - 1]);
    expect(totals[0] / totals[3]).toBeGreaterThanOrEqual(0.5);
    expect(totals[0] / totals[3]).toBeLessThanOrEqual(0.7);
  });

  it("la courbe de difficulté en joueurs est régulière : de 1 à 4 joueurs, aucun palier ne pèse plus de la moitié de la montée totale", () => {
    const totals = PLAYER_COUNTS.map((n) => totalEnemies(level4, n));
    const rise = totals[3] - totals[0];
    for (let i = 1; i < totals.length; i++) {
      const step = totals[i] - totals[i - 1];
      expect(step, `palier ${i}→${i + 1} : ${totals}`).toBeGreaterThanOrEqual(rise * 0.2);
      expect(step, `palier ${i}→${i + 1} : ${totals}`).toBeLessThanOrEqual(rise * 0.5);
    }
  });

  it("à 1 joueur, jamais de chevalier (90 PV) : ils n'arrivent qu'à partir de 2 joueurs", () => {
    for (const r of level4.rooms) {
      for (const e of enemiesAt(r, 1)) expect(e.kind, `${r.id} ${e.tile}`).not.toBe('knight');
    }
    expect(level4.rooms.some((r) => enemiesAt(r, 2).some((e) => e.kind === 'knight'))).toBe(true);
  });

  it("arrivée calme : aucun ennemi à moins de 12 tuiles des spawns ; jamais deux ennemis sur la même tuile", () => {
    for (const r of level4.rooms) {
      const seen = new Set<string>();
      for (const e of r.enemies) {
        for (const sp of r.playerSpawns) {
          expect(dist2(e.tile, sp), `${r.id} ${e.kind} ${e.tile}`).toBeGreaterThanOrEqual(12);
        }
        const k = e.tile.join(',');
        expect(seen.has(k), `${r.id} doublon ${k}`).toBe(false);
        seen.add(k);
      }
    }
  });

  it('chaque ennemi conditionné (`when`) l\'est par un mécanisme de sa salle ; les vagues sont continues et non vides', () => {
    for (const r of level4.rooms) {
      for (const e of r.enemies) {
        if (e.when !== undefined) expect(r.mechanisms.some((m) => m.id === e.when), `${r.id} when ${e.when}`).toBe(true);
      }
    }
    const echoes = room('echoes');
    expect(new Set(echoes.enemies.map((e) => e.wave ?? 0))).toEqual(new Set([0, 1, 2]));
    for (const n of PLAYER_COUNTS) {
      for (let w = 0; w < 3; w++) {
        expect(enemiesAt(echoes, n).filter((e) => (e.wave ?? 0) === w).length, `vague ${w} à ${n}`).toBeGreaterThanOrEqual(6);
      }
    }
  });

  it('le calme du seuil : peu d\'ennemis dans la salle d\'apprentissage, et aucun ne garde un socle ni une statue', () => {
    const r = room('threshold');
    expect(enemiesAt(r, 4).length).toBeLessThanOrEqual(16);
    const pair = pairOf(r);
    for (const e of r.enemies) {
      for (const s of pair.statues) expect(dist2(e.tile, s.standTile), `${e.kind} ${e.tile}`).toBeGreaterThanOrEqual(8);
    }
  });

  it('aucun ennemi n\'est enfermé : tous atteignables à pied depuis les spawns (portes ouvertes)', () => {
    for (const r of level4.rooms) {
      const reach = flood(r, [r.playerSpawns[0]]);
      for (const e of r.enemies) expect(reach.has(e.tile[1] * 1000 + e.tile[0]), `${r.id} ${e.kind} en ${e.tile}`).toBe(true);
    }
  });
});

// ───────────────────────────── La statue jumelle ─────────────────────────────

describe('level4 — la statue jumelle (mécanisme inédit)', () => {
  it('est utilisée dans au moins 3 salles : apprentissage calme, sous les vagues, porte du boss', () => {
    const using = level4.rooms.filter((r) => r.mechanisms.some((m) => m.type === 'statuePair')).map((r) => r.id);
    expect(using.length).toBeGreaterThanOrEqual(3);
    expect(using).toEqual(STATUE_ROOMS);
    // l'apprentissage est la 1re salle et la plus calme
    expect(level4.rooms[0].id).toBe('threshold');
    const calm = enemiesAt(room('threshold'), 4).length;
    for (const r of level4.rooms.slice(1, -1)) expect(enemiesAt(r, 4).length, r.id).toBeGreaterThan(calm);
    // 2e paire : pendant des vagues d'ennemis ; 3e paire : commande une porte du boss
    expect(room('echoes').enemies.some((e) => (e.wave ?? 0) > 0)).toBe(true);
    const ante = room('antechamber');
    const bossDoor = mech(ante, 'bossDoor', 'door');
    expect(bossDoor.requires).toContain('bossPair');
    expect(ante.exit.requires).toContain('bossDoor');
    expect(ante.enemies.some((e) => e.kind === 'warden')).toBe(true);
  });

  for (const id of STATUE_ROOMS) {
    it(`${id} : statues aux extrémités opposées, socles éloignés, orientations initiales différentes, jamais résolue au départ`, () => {
      const r = room(id);
      const pair = pairOf(r);
      const [a, b] = pair.statues;
      expect(dist2(a.tile, b.tile), 'statues éloignées').toBeGreaterThanOrEqual(35);
      expect(dist2(a.standTile, b.standTile), 'socles éloignés').toBeGreaterThanOrEqual(30);
      expect(dist2(a.tile, a.standTile), 'socle proche de SA statue').toBeLessThanOrEqual(4);
      expect(dist2(b.tile, b.standTile), 'socle proche de SA statue').toBeLessThanOrEqual(4);
      expect(a.facing).not.toBe(b.facing);
      expect(a.facing === pair.targetDir && b.facing === pair.targetDir).toBe(false);
      // tuiles de sol, toutes distinctes
      const grid = new RoomGrid(r.layout);
      const all = [a.tile, b.tile, a.standTile, b.standTile];
      expect(new Set(all.map((t) => t.join(','))).size).toBe(4);
      for (const t of all) expect(grid.blocksMovement(t[0], t[1]), `${t}`).toBe(false);
      // ni ennemi ni autre mécanisme sur les socles
      for (const e of r.enemies) for (const t of all) expect(e.tile, `${e.kind}`).not.toEqual(t);
    });

    for (const n of PLAYER_COUNTS) {
      it(`${id} à ${n} joueur(s) : se résout depuis les deux socles (un joueur par socle, ou allers-retours en solo)`, () => {
        const r = room(id);
        const pair = pairOf(r);
        const h = new Harness(r, n);
        const st = () => h.state<StatuePairState>(pair.id);
        expect(st().active).toBe(false);
        // appuyer sur un socle sans que l'AUTRE statue soit mal tournée ne résout pas tout seul
        const pressesOnSocket0 = turns(pair.statues[1].facing, pair.targetDir); // le socle 0 tourne la statue 1
        const pressesOnSocket1 = turns(pair.statues[0].facing, pair.targetDir);
        expect(pressesOnSocket0).toBeGreaterThan(0);
        expect(pressesOnSocket1).toBeGreaterThan(0);
        const who0: PlayerId = 0;
        const who1: PlayerId = (1 % n) as PlayerId;
        h.put(who0, pair.statues[0].standTile);
        for (let i = 0; i < pressesOnSocket0; i++) h.tick([who0]);
        expect(st().facings[1]).toBe(pair.targetDir);
        expect(st().active, 'une seule statue alignée').toBe(false);
        h.put(who1, pair.statues[1].standTile); // en solo : même joueur, il a fait l'aller-retour
        for (let i = 0; i < pressesOnSocket1; i++) h.tick([who1]);
        expect(st().facings).toEqual([pair.targetDir, pair.targetDir]);
        expect(st().active).toBe(true);
        // verrouillée : aucune rotation ne la défait
        h.tick([who1]);
        expect(st().facings).toEqual([pair.targetDir, pair.targetDir]);
        // jamais verrouillante avant la résolution : 4 appuis ramènent à l'état d'origine (aucun blocage possible)
        const h2 = new Harness(r, n);
        h2.put(0, pair.statues[0].standTile);
        const before = h2.state<StatuePairState>(pair.id).facings[1];
        for (let i = 0; i < 4; i++) {
          // s'écarter de la bonne direction puis revenir : on ne s'arrête jamais sur une solution partielle bloquante
          h2.tick([0]);
        }
        expect(h2.state<StatuePairState>(pair.id).facings[1]).toBe(before);
      });
    }
  }

  it('un joueur qui n\'est sur aucun socle, ou qui est à terre, ne fait rien tourner', () => {
    const r = room('threshold');
    const pair = pairOf(r);
    const h = new Harness(r, 2);
    h.put(0, [20, 22]);
    h.tick([0]);
    expect(h.state<StatuePairState>(pair.id).facings).toEqual([pair.statues[0].facing, pair.statues[1].facing]);
    h.put(0, pair.statues[0].standTile);
    h.players[0].status = 'down';
    h.tick([0]);
    expect(h.state<StatuePairState>(pair.id).facings).toEqual([pair.statues[0].facing, pair.statues[1].facing]);
    h.players[0].status = 'alive';
    expect(statueRotationTarget(pair, h.state<StatuePairState>(pair.id), h.players[0])).toBe(1);
  });

  it('seuil : la porte ne s\'ouvre qu\'une fois les statues alignées ; la sortie exige la porte', () => {
    const r = room('threshold');
    const pair = pairOf(r);
    const h = new Harness(r, 2);
    expect(h.isOpen('twinsDoor')).toBe(false);
    expect(h.exitMet(0)).toBe(false);
    h.put(0, pair.statues[0].standTile);
    for (let i = 0; i < turns(pair.statues[1].facing, pair.targetDir); i++) h.tick([0]);
    h.tick();
    expect(h.isOpen('twinsDoor')).toBe(false);
    h.put(1, pair.statues[1].standTile);
    for (let i = 0; i < turns(pair.statues[0].facing, pair.targetDir); i++) h.tick([1]);
    h.tick();
    expect(h.isOpen('twinsDoor')).toBe(true);
    expect(h.exitMet(0)).toBe(true);
  });

  it('antichambre : la porte du boss exige la paire ET les plaques de garde existantes (3 et 4 joueurs)', () => {
    const r = room('antechamber');
    const pair = pairOf(r);
    for (const n of PLAYER_COUNTS) {
      const h = new Harness(r, n);
      const solve = (): void => {
        h.put(0, pair.statues[0].standTile);
        for (let i = 0; i < turns(pair.statues[1].facing, pair.targetDir); i++) h.tick([0]);
        h.put((1 % n) as PlayerId, pair.statues[1].standTile);
        for (let i = 0; i < turns(pair.statues[0].facing, pair.targetDir); i++) h.tick([(1 % n) as PlayerId]);
      };
      solve();
      h.tick();
      const plates = r.mechanisms.filter((m) => m.type === 'plate' && (m.minPlayers ?? 1) <= n);
      expect(plates.length, `plaques à ${n}`).toBe(Math.max(0, n - 2));
      if (plates.length > 0) {
        expect(h.isOpen('bossDoor'), `à ${n} : paire seule`).toBe(false);
        plates.forEach((m, i) => m.type === 'plate' && h.put((2 + i) as PlayerId, m.tile));
        h.tick();
      }
      expect(h.isOpen('bossDoor'), `à ${n} : paire + plaques`).toBe(true);
      // la porte reste ouverte quand les gardes de plaque s'en vont
      plates.forEach((_, i) => h.put((2 + i) as PlayerId, [5, 22]));
      h.wait(300);
      expect(h.isOpen('bossDoor')).toBe(true);
      expect(h.exitMet(0)).toBe(true);
      expect(h.exitMet(1)).toBe(false); // gardien vivant : « clear »
    }
  });

  it('la porte du boss est une grande porte (2×4) qui barre tout le passage', () => {
    const r = room('antechamber');
    const door = mech(r, 'bossDoor', 'door');
    expect(door.tiles.length).toBe(8);
    const xs = new Set(door.tiles.map((t) => t[0]));
    const ys = door.tiles.map((t) => t[1]);
    expect(xs.size).toBe(2);
    const grid = new RoomGrid(r.layout);
    for (const x of xs) {
      // au-dessus et au-dessous du passage : mur
      expect(grid.blocksMovement(x, Math.min(...ys) - 1)).toBe(true);
      expect(grid.blocksMovement(x, Math.max(...ys) + 1)).toBe(true);
    }
  });
});

// ───────────────────────────── Autres mécanismes (connus) ─────────────────────────────

describe('level4 — plaques, leviers, braseros, zone : coopération adaptative', () => {
  it('chaque salle a un mécanisme coopératif présent dès 1 joueur, ou est une arène de (demi-)boss pure', () => {
    const coop = new Set(['plate', 'lever', 'key', 'block', 'runePuzzle', 'brazier', 'statuePair']);
    for (const r of level4.rooms) {
      if (r.mechanisms.length === 0) {
        expect(r.enemies.some((e) => e.kind === 'warden' || e.kind === 'frostqueen'), r.id).toBe(true);
        continue;
      }
      expect(r.mechanisms.some((m) => coop.has(m.type) && (m.minPlayers ?? 1) <= 1), r.id).toBe(true);
    }
  });

  it('combine les mécanismes connus avec la statue : plaques, leviers à fenêtre, braseros de couleur, portes', () => {
    const types = new Set(level4.rooms.flatMap((r) => r.mechanisms.map((m) => m.type)));
    for (const t of ['plate', 'lever', 'brazier', 'door', 'statuePair'] as const) expect(types.has(t), t).toBe(true);
    expect(level4.rooms.flatMap((r) => r.mechanisms).some((m) => m.type === 'lever' && (m.windowMs ?? 0) > 0)).toBe(true);
  });

  it('chaque mécanisme porte une étiquette conforme à la convention mech.level4.<salle>.<id>', () => {
    for (const r of level4.rooms) {
      for (const m of r.mechanisms) {
        if (m.type === 'brazier') expect(m.labelKey?.startsWith(`mech.level4.${r.id}.`), `${r.id}.${m.id}`).toBe(true);
        else expect(m.labelKey, `${r.id}.${m.id}`).toBe(`mech.level4.${r.id}.${m.id}`);
      }
    }
  });

  it('galerie : plaques bleue/rouge/verte/jaune, minPlayers = slot + 1, loin les unes des autres et de l\'arrivée', () => {
    const r = room('gallery');
    const plates = r.mechanisms.filter((m) => m.type === 'plate');
    expect(plates.length).toBe(4);
    plates.forEach((m, slot) => {
      expect(m.minPlayers ?? 1).toBe(slot === 0 ? 1 : slot + 1);
      if (m.type === 'plate') expect(m.colorSlot).toBe(slot);
    });
    const tiles = plates.flatMap((m) => (m.type === 'plate' ? [m.tile] : []));
    for (let i = 0; i < tiles.length; i++) {
      for (let j = i + 1; j < tiles.length; j++) expect(dist2(tiles[i], tiles[j])).toBeGreaterThanOrEqual(30);
      expect(dist2(tiles[i], r.playerSpawns[0])).toBeGreaterThanOrEqual(14);
    }
    for (const n of PLAYER_COUNTS) {
      const live = plates.filter((m) => (m.minPlayers ?? 1) <= n);
      expect(live.length).toBe(n);
      if (n >= 2) {
        const h = new Harness(r, n);
        live.slice(0, -1).forEach((m, i) => m.type === 'plate' && h.put(i as PlayerId, m.tile));
        h.wait(400);
        expect(h.isOpen('galleryDoor')).toBe(false);
      }
      const h = new Harness(r, n);
      live.forEach((m, i) => m.type === 'plate' && h.put(i as PlayerId, m.tile));
      h.wait(200);
      expect(h.isOpen('galleryDoor')).toBe(true);
      h.put(0, [3, 3]);
      h.wait(300);
      expect(h.isOpen('galleryDoor')).toBe(true);
      expect(h.exitMet(0)).toBe(true);
      expect(h.exitMet(2)).toBe(false);
    }
  });

  it('flèche : leviers aux bouts de la croix, fenêtre de 25 s identique à tout n, simultanéité exigée', () => {
    const r = room('spire');
    const levers = r.mechanisms.filter((m) => m.type === 'lever');
    expect(levers.length).toBe(4);
    levers.forEach((m, slot) => {
      expect(m.minPlayers ?? 1).toBe(slot === 0 ? 1 : slot + 1);
      if (m.type === 'lever') {
        expect(m.ownerSlot).toBe(slot);
        expect(m.windowMs).toBe(25000);
      }
    });
    const tiles = levers.flatMap((m) => (m.type === 'lever' ? [m.tile] : []));
    for (let i = 0; i < tiles.length; i++) for (let j = i + 1; j < tiles.length; j++) expect(dist2(tiles[i], tiles[j])).toBeGreaterThanOrEqual(40);
    for (const n of PLAYER_COUNTS) {
      for (const m of levers) {
        if ((m.minPlayers ?? 1) <= n) expect(effectiveLeverWindowMs(r, n, m), `n=${n} ${m.id}`).toBe(25000);
      }
      const live = levers.filter((m) => (m.minPlayers ?? 1) <= n);
      // tirés ensemble : la porte s'ouvre
      const h = new Harness(r, n);
      live.forEach((m) => {
        if (m.type !== 'lever') return;
        const owner = resolveSlot(m.ownerSlot ?? 0, n);
        h.put(owner, m.tile);
        h.tick([owner]);
      });
      h.tick();
      expect(h.isOpen('spireDoor'), `n=${n} tirés ensemble`).toBe(true);
      // trop espacés (> 25 s) : la porte reste fermée
      if (n >= 2) {
        const g = new Harness(r, n);
        const first = live[0];
        if (first.type === 'lever') {
          const o = resolveSlot(first.ownerSlot ?? 0, n);
          g.put(o, first.tile);
          g.tick([o]);
          g.wait(26000);
          live.slice(1).forEach((m) => {
            if (m.type !== 'lever') return;
            const owner = resolveSlot(m.ownerSlot ?? 0, n);
            g.put(owner, m.tile);
            g.tick([owner]);
          });
          g.tick();
          expect(g.isOpen('spireDoor'), `n=${n} trop espacés`).toBe(false);
          expect(g.state<LeverState>(first.id).active).toBe(false);
        }
      }
    }
  });

  it('profondeurs : salle sombre unique, quatre braseros de couleur (un par slot), la porte exige les quatre', () => {
    expect(level4.rooms.filter((r) => r.dark === true).map((r) => r.id)).toEqual(['deepdark']);
    const r = room('deepdark');
    const colored = r.mechanisms.filter((m) => m.type === 'brazier' && m.lit !== true);
    expect(colored.length).toBe(4);
    colored.forEach((m, slot) => {
      if (m.type !== 'brazier') return;
      expect(m.ownerSlot).toBe(slot);
      expect(m.minPlayers ?? 1).toBe(slot === 0 ? 1 : slot + 1);
      expect(m.lightRadiusTiles ?? 0).toBeGreaterThan(0);
    });
    const door = mech(r, 'darkDoor', 'door');
    expect(door.requires.sort()).toEqual(colored.map((m) => m.id).sort());
    for (const n of PLAYER_COUNTS) {
      const h = new Harness(r, n);
      const live = colored.filter((m) => (m.minPlayers ?? 1) <= n);
      expect(h.isOpen('darkDoor')).toBe(false);
      for (const m of live) {
        if (m.type !== 'brazier') continue;
        const owner = resolveSlot(m.ownerSlot ?? 0, n);
        const c = tileCenterPx(m.tile);
        h.players[owner].pos = { x: c.x - 12, y: c.y };
        h.tick([owner]);
        expect(h.state<BrazierState>(m.id).active, m.id).toBe(true);
      }
      h.tick();
      expect(h.isOpen('darkDoor'), `n=${n}`).toBe(true);
    }
  });

  it('profondeurs : les braseros de couleur sont sur leurs tuiles prévues (coins de l’anneau), chacun encadré par sa torche repère', () => {
    const r = room('deepdark');
    const expected: TileXY[] = [[8, 7], [72, 7], [8, 43], [72, 43]];
    const colored = r.mechanisms.filter((m) => m.type === 'brazier' && m.lit !== true);
    const torches = (r.decor ?? []).filter((d) => d.type === 'torch').map((d) => d.tile);
    colored.forEach((m, slot) => {
      if (m.type !== 'brazier') return;
      expect(m.tile, m.id).toEqual(expected[slot]);
      expect(Math.min(...torches.map((t) => dist2(t, m.tile))), `torche repère de ${m.id}`).toBeLessThanOrEqual(1);
    });
    // aucun brasero allumé ne se pose sur la porte ni dans l'alcôve de sortie (son passage reste libre)
    const door = mech(r, 'darkDoor', 'door');
    for (const m of r.mechanisms) {
      if (m.type !== 'brazier') continue;
      for (const t of door.tiles) expect(m.tile, `${m.id} sur la porte`).not.toEqual(t);
      const e = r.exit.rect;
      expect(m.tile[0] >= e.x && m.tile[0] < e.x + e.w && m.tile[1] >= e.y && m.tile[1] < e.y + e.h, `${m.id} dans la sortie`).toBe(false);
    }
  });

  it('profondeurs : braseros allumés atteignables, départ éclairé, jamais loin d\'un point de recharge', () => {
    const r = room('deepdark');
    const lit = r.mechanisms.filter((m) => m.type === 'brazier' && m.lit === true);
    expect(lit.length).toBeGreaterThanOrEqual(6);
    const reach = flood(r, [r.playerSpawns[0]]);
    const torches = (r.decor ?? []).filter((d) => d.type === 'torch').map((d) => d.tile);
    const sources = [...lit.flatMap((m) => (m.type === 'brazier' ? [m.tile] : [])), ...torches];
    for (const s of r.playerSpawns) expect(Math.min(...sources.map((t) => dist2(t, s))), `spawn ${s}`).toBeLessThanOrEqual(LIGHT_FULL_TILES);
    const fromFires = flood(r, lit.flatMap((m) => (m.type === 'brazier' ? [m.tile] : [])));
    let worst = 0;
    for (const k of reach.keys()) worst = Math.max(worst, fromFires.get(k) ?? Infinity);
    expect(worst, "pas jusqu'au point de recharge le plus proche").toBeLessThanOrEqual(60);
  });

  it('échos : le cairn est une zone 3×3 au centre, tenue 8 s par le héros vert (slot 2), accomplie à tout n', () => {
    const r = room('echoes');
    const zone = r.zones?.find((z) => z.id === 'holdZone');
    expect(zone).toBeDefined();
    expect(zone?.rect.w).toBe(3);
    const obj = level4.objectives.find((o) => o.id === 'hold');
    expect(obj?.slot).toBe(2);
    expect(obj?.seconds).toBe(8);
    for (const n of PLAYER_COUNTS) {
      const objs = createObjectives(level4, n);
      expect(objs.find((o) => o.id === 'hold')?.ownerId).toBe(resolveSlot(2, n));
    }
  });
});

// ───────────────────────────── Objectifs ─────────────────────────────

describe('level4 — objectifs personnels', () => {
  it('un objectif par slot 0..3, de types variés, répartis sur quatre salles (jamais le trône)', () => {
    expect(level4.objectives.map((o) => o.slot).sort()).toEqual([0, 1, 2, 3]);
    expect(new Set(level4.objectives.map((o) => o.kind))).toEqual(new Set(['mechanism', 'zone', 'kills']));
    expect(new Set(level4.objectives.map((o) => o.roomId)).size).toBe(4);
    for (const o of level4.objectives) {
      expect(o.labelKey).toBe(`objective.level4.${o.id}`);
      expect(o.roomId).not.toBe('throne');
    }
  });

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

  it("on ne peut pas quitter une salle sans avoir accompli l'objectif qu'elle porte", () => {
    for (const o of level4.objectives) {
      const tokens = requiredTokens(room(o.roomId));
      const gated = tokens.has(`obj:${o.id}`) || (o.mechanismId !== undefined && tokens.has(o.mechanismId));
      expect(gated, `objectif ${o.id} dans ${o.roomId}`).toBe(true);
    }
  });

  it('chaque objectif est accomplissable à 1, 2, 3 et 4 joueurs, avec le bon propriétaire', () => {
    for (const n of PLAYER_COUNTS) {
      const objs = createObjectives(level4, n);
      for (const o of level4.objectives) expect(objs.find((s) => s.id === o.id)?.ownerId, `${o.id} à ${n}`).toBe(resolveSlot(o.slot, n));
    }
    // l'objectif « slayer » a assez d'ennemis à tout n
    const quota = level4.objectives.find((o) => o.id === 'slayer');
    for (const n of PLAYER_COUNTS) expect(enemiesAt(room('warden1'), n).length).toBeGreaterThanOrEqual((quota?.count ?? 1) * 3);
  });
});

// ───────────────────────────── Textes ─────────────────────────────

describe('level4 — textes (parts i18n, ou dictionnaires une fois les parts fusionnées)', () => {
  // lecture paresseuse : rien n'est lu sur le disque à la collecte (les parts disparaissent à `npm run i18n:merge`)
  const dictFr = getDictionary('fr');
  const dictEn = getDictionary('en');
  let fr: Record<string, string> = {};
  let en: Record<string, string> = {};
  beforeAll(() => {
    fr = readPart('fr');
    en = readPart('en');
  });

  it('le repli sans parts (après la fusion i18n) retrouve les clés du niveau dans les dictionnaires', () => {
    const fallback = level4Texts('fr', path.join(path.dirname(fileURLToPath(import.meta.url)), 'dossier-sans-parts'));
    expect(fallback['level.level4.name']).toBe('Les Cavernes de Givre');
    expect(fallback['speaker.frostqueen']).toBeTruthy();
    const refs = collectRequiredI18nKeys(level4, { checkSpeakers: true }).map((r) => r.key);
    for (const k of Object.keys(fallback)) expect(refs, `clé ${k}`).toContain(k);
    for (const k of refs) if (k !== 'speaker.narrator' && LEVEL4_KEY_PREFIXES.some((p) => k.startsWith(p))) expect(fallback[k], k).toBeTruthy();
  });

  it('parité fr/en stricte, aucune valeur vide, mêmes {placeholders}', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(fr).sort());
    for (const k of Object.keys(fr)) {
      expect(fr[k].trim().length, `fr ${k}`).toBeGreaterThan(0);
      expect(en[k].trim().length, `en ${k}`).toBeGreaterThan(0);
      expect(placeholders(en[k]), `placeholders ${k}`).toEqual(placeholders(fr[k]));
    }
  });

  it('toutes les clés requises par le niveau existent en fr ET en (via getDictionary), et aucune clé orpheline', () => {
    const refs = collectRequiredI18nKeys(level4, { checkSpeakers: true });
    for (const r of refs) {
      expect(dictFr[r.key], `fr ${r.key}`).toBeTruthy();
      expect(dictEn[r.key], `en ${r.key}`).toBeTruthy();
    }
    const required = new Set(refs.map((r) => r.key));
    for (const k of Object.keys(fr)) expect(required.has(k), `clé orpheline ${k}`).toBe(true);
  });

  it('clés bien formées, préfixées par la convention de DESIGN.md §6 (speaker.<id> pour le nouvel orateur)', () => {
    const prefixes = ['level.level4.', 'room.level4.', 'objective.level4.', 'mech.level4.', 'sign.level4.', 'hintroom.level4.', 'speaker.'];
    for (const k of Object.keys(fr)) {
      expect(k, k).toMatch(/^[A-Za-z0-9_]+(\.[A-Za-z0-9_-]+)+$/);
      expect(prefixes.some((p) => k.startsWith(p)), k).toBe(true);
    }
    expect(fr['speaker.frostqueen']).toBeTruthy();
  });

  it("textes courts et lisibles à l'écran (≤ 90 caractères) dans les deux langues", () => {
    for (const dict of [fr, en]) for (const [k, v] of Object.entries(dict)) expect(v.length, `${k} (${v.length})`).toBeLessThanOrEqual(MAX_TEXT);
  });

  it('intro de 3 à 6 répliques, outro de 2 à 4, orateurs autorisés, Lyssa ouvre sur la suite', () => {
    expect(level4.intro.length).toBeGreaterThanOrEqual(3);
    expect(level4.intro.length).toBeLessThanOrEqual(6);
    expect(level4.outro.length).toBeGreaterThanOrEqual(2);
    expect(level4.outro.length).toBeLessThanOrEqual(4);
    for (const l of [...level4.intro, ...level4.outro]) expect(ALLOWED_SPEAKERS).toContain(l.speaker);
    expect(level4.intro.some((l) => l.speaker === 'frostqueen')).toBe(true);
    const last = level4.outro[level4.outro.length - 1];
    expect(last.speaker).toBe('lyssa');
    expect(dictFr[last.textKey]).toMatch(/forge|montagne/);
  });

  it("l'outro du niveau 3 ne conclut plus la saga : le gel s'étend, il reste des fragments à retrouver", () => {
    const outroFr = level3.outro.map((l) => dictFr[l.textKey]).join(' ');
    const outroEn = level3.outro.map((l) => dictEn[l.textKey]).join(' ');
    expect(outroFr).toMatch(/gel|ténèbres/);
    expect(outroFr).toMatch(/fragments? à retrouver|Il en manque/);
    expect(outroFr).not.toMatch(/entier ! Regardez|L'aube revient enfin/);
    expect(outroEn).toMatch(/frost|darkness/);
    expect(outroEn).toMatch(/fragments? to find|missing/);
    expect(outroEn).not.toMatch(/whole! Look|Dawn returns at last/);
    // clés inchangées : 4 répliques, mêmes clés
    expect(level3.outro.map((l) => l.textKey)).toEqual([1, 2, 3, 4].map((i) => `level.level3.outro.${i}`));
  });

  it('les consignes citent la bonne couleur de slot (vert = cairn, jaune = tueur et plaques, rouge = levier nord)', () => {
    expect(fr['sign.level4.echoes.cairn']).toMatch(/vert/);
    expect(fr['sign.level4.warden1.cover']).toMatch(/jaune/);
    expect(fr['sign.level4.antechamber.plates']).toMatch(/vert/);
    expect(en['sign.level4.echoes.cairn']).toMatch(/green/);
    expect(en['sign.level4.warden1.cover']).toMatch(/yellow/);
    expect(level4.objectives.find((o) => o.id === 'hold')?.slot).toBe(2);
    expect(level4.objectives.find((o) => o.id === 'slayer')?.slot).toBe(3);
    expect(mech(room('antechamber'), 'guardPlateA', 'plate').colorSlot).toBe(2);
    expect(mech(room('antechamber'), 'guardPlateB', 'plate').colorSlot).toBe(3);
    // chaque statue/paire a un panneau « socle » dans les salles à statues
    for (const id of STATUE_ROOMS) expect((room(id).signs ?? []).some((s) => s.id.includes('socket')), id).toBe(true);
  });
});

// ───────────────────────────── Garde-fous divers ─────────────────────────────

describe('level4 — enregistrement et cohérence', () => {
  it('les sols sont atteignables : validateLevel ne signale aucune tuile inaccessible', () => {
    const errors = validateLevel(level4).filter((e) => /inatteignable/.test(e));
    expect(errors).toEqual([]);
  });

  it('les tuiles de porte sont du sol dans la grille', () => {
    for (const r of level4.rooms) {
      const grid = new RoomGrid(r.layout);
      for (const m of r.mechanisms) {
        if (m.type !== 'door') continue;
        for (const [x, y] of m.tiles) expect(grid.blocksMovement(x, y), `${r.id}.${m.id} [${x},${y}]`).toBe(false);
      }
    }
  });

  it('les ennemis conditionnés par une porte fermée ne bloquent pas la progression : la sortie reste atteignable sans eux', () => {
    // toutes les apparitions `when`/`wave` sont soit absentes, soit déclenchées par la mort des vagues précédentes
    for (const r of level4.rooms) for (const e of r.enemies) expect(e.when, `${r.id}`).toBeUndefined();
  });

  it('les types d\'ennemis restent des ennemis normaux (hors demi-boss/boss) en dehors des salles de boss', () => {
    const normal: readonly EnemyKind[] = ['slime', 'bat', 'skeleton', 'archer', 'spider', 'wisp', 'knight'];
    for (const r of level4.rooms) {
      for (const e of r.enemies) {
        if (e.kind === 'warden' || e.kind === 'frostqueen') continue;
        expect(normal, `${r.id}`).toContain(e.kind);
      }
    }
  });
});
