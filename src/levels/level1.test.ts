import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { level1 } from './level1';
import { validateLevel, collectRequiredI18nKeys } from '../core/levelValidation';
import { getDictionary } from '../i18n/i18n';
import { RoomGrid } from '../core/grid';
import { TILE } from '../core/constants';
import { resolveSlot } from '../core/slots';
import { createPlayerState } from '../core/players';
import {
  areAllRequirementsMet,
  createRoomMechanisms,
  effectiveLeverWindowMs,
  tileCenterPx,
  updateMechanisms,
} from '../core/mechanisms';
import type { MechanismUpdateArgs } from '../core/mechanisms';
import { createObjectives, isObjectiveDone, isZoneOccupied, updateObjectives } from '../core/objectives';
import type {
  LeverDef,
  MechanismDef,
  ObjectiveState,
  PlayerId,
  PlayerState,
  RoomDef,
  TileXY,
} from '../core/types';

// ───────────────────────────── Aides ─────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
function onlyKeys(d: Record<string, string>, tag: string): Record<string, string> {
  return Object.fromEntries(Object.entries(d).filter(([k]) => k.includes(tag)));
}

function room(id: string): RoomDef {
  const r = level1.rooms.find((x) => x.id === id);
  if (!r) throw new Error(`salle introuvable : ${id}`);
  return r;
}

function mech<T extends MechanismDef['type']>(r: RoomDef, id: string, type: T): Extract<MechanismDef, { type: T }> {
  const m = r.mechanisms.find((x) => x.id === id);
  if (!m || m.type !== type) throw new Error(`mécanisme ${type} introuvable : ${id}`);
  return m as Extract<MechanismDef, { type: T }>;
}

function enemyCount(r: RoomDef, n: number): number {
  return r.enemies.filter((e) => (e.minPlayers ?? 1) <= n).length;
}

function makePlayers(r: RoomDef, n: number): PlayerState[] {
  const ids: PlayerId[] = [0, 1, 2, 3];
  return ids.slice(0, n).map((id) => {
    const s = r.playerSpawns[id];
    return createPlayerState({ id, characterId: 'david', difficulty: 2 }, tileCenterPx(s));
  });
}

/** Banc d'essai de mécanismes d'une salle (sans simulation complète). */
function bench(r: RoomDef, n: number) {
  const mechanisms = createRoomMechanisms(r, n);
  const players = makePlayers(r, n);
  const grid = new RoomGrid(r.layout);
  const objectives: ObjectiveState[] = createObjectives(level1, n);
  const step = (dtMs = 100, pressed: Partial<Record<PlayerId, boolean>> = {}): void => {
    const args: MechanismUpdateArgs = {
      room: r,
      grid,
      mechanisms,
      players,
      frames: {},
      interactPressed: pressed,
      dtMs,
      aliveEnemyCount: 0,
      objectiveDone: (id) => isObjectiveDone(objectives, id),
      zoneOccupied: (id) => isZoneOccupied(objectives, level1, r, players, id),
    };
    updateMechanisms(args);
  };
  const exitMet = (alive = 0): boolean =>
    areAllRequirementsMet(r.exit.requires, {
      mechanisms,
      aliveEnemyCount: alive,
      objectiveDone: (id) => isObjectiveDone(objectives, id),
      zoneOccupied: (id) => isZoneOccupied(objectives, level1, r, players, id),
    });
  const stateOf = (id: string) => mechanisms.find((m) => m.id === id)!;
  const teleport = (p: PlayerState, tile: TileXY): void => {
    p.pos.x = tileCenterPx(tile).x;
    p.pos.y = tileCenterPx(tile).y;
  };
  return { mechanisms, players, grid, objectives, step, exitMet, stateOf, teleport };
}

/** Distance (en tuiles, BFS 4-connexe sur le sol, portes ouvertes) entre deux tuiles. */
function pathLength(r: RoomDef, from: TileXY, to: TileXY): number {
  const grid = new RoomGrid(r.layout);
  const dist = new Map<number, number>();
  const key = (x: number, y: number): number => y * grid.width + x;
  const queue: TileXY[] = [from];
  dist.set(key(from[0], from[1]), 0);
  for (let i = 0; i < queue.length; i++) {
    const [x, y] = queue[i];
    const d = dist.get(key(x, y)) ?? 0;
    if (x === to[0] && y === to[1]) return d;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (grid.blocksMovement(nx, ny) || dist.has(key(nx, ny))) continue;
      dist.set(key(nx, ny), d + 1);
      queue.push([nx, ny]);
    }
  }
  return Infinity;
}

const PLAYER_COUNTS = [1, 2, 3, 4] as const;

// ───────────────────────────── Validation statique ─────────────────────────────

describe('level1 : validation', () => {
  it('passe validateLevel (dictionnaires fr + en, orateurs vérifiés)', () => {
    const errors = validateLevel(level1, {
      dictionaries: { fr: getDictionary('fr'), en: getDictionary('en') },
      checkSpeakers: true,
    });
    expect(errors).toEqual([]);
  });

  it('a l\'identité attendue', () => {
    expect(level1.id).toBe('level1');
    expect(level1.theme).toBe('crypt');
    expect(level1.nameKey).toBe('level.level1.name');
    expect(level1.estimatedMinutes).toBe(7);
    expect(getDictionary('fr')['level.level1.name']).toBe('Les Cryptes Oubliées');
  });

  it('a 5 à 6 GRANDES salles (60-100 × 36-56 tuiles : jamais visibles en entier), thème crypt, 4+ spawns', () => {
    expect(level1.rooms.length).toBeGreaterThanOrEqual(5);
    expect(level1.rooms.length).toBeLessThanOrEqual(6);
    for (const r of level1.rooms) {
      const w = r.layout[0].length;
      const h = r.layout.length;
      expect(w, `largeur de ${r.id}`).toBeGreaterThanOrEqual(60);
      expect(w, `largeur de ${r.id}`).toBeLessThanOrEqual(100);
      expect(h, `hauteur de ${r.id}`).toBeGreaterThanOrEqual(36);
      expect(h, `hauteur de ${r.id}`).toBeLessThanOrEqual(56);
      // Au moins 3× la surface d'une salle de l'ancienne génération (≈ 28×18 = 504 tuiles).
      expect(w * h, `surface de ${r.id}`).toBeGreaterThanOrEqual(1500);
      expect(r.theme).toBe('crypt');
      expect(r.playerSpawns.length).toBeGreaterThanOrEqual(4);
      expect(r.introHintKey, `introHintKey de ${r.id}`).toBeTruthy();
    }
  });

  it('a une intro de 3-5 répliques et une outro de 2-4 répliques', () => {
    expect(level1.intro.length).toBeGreaterThanOrEqual(3);
    expect(level1.intro.length).toBeLessThanOrEqual(5);
    expect(level1.outro.length).toBeGreaterThanOrEqual(2);
    expect(level1.outro.length).toBeLessThanOrEqual(4);
    const allowed = new Set(['narrator', 'aldric', 'lyssa', 'morvane', 'gorgrim', 'heroes']);
    for (const l of [...level1.intro, ...level1.outro]) expect(allowed.has(l.speaker)).toBe(true);
  });

  it('relie au niveau 2 : Lyssa évoque le Bosquet Putride dans la conclusion', () => {
    const lyssaLines = level1.outro.filter((l) => l.speaker === 'lyssa');
    expect(lyssaLines.length).toBeGreaterThanOrEqual(1);
    const fr = getDictionary('fr');
    expect(lyssaLines.some((l) => fr[l.textKey].includes('Bosquet Putride'))).toBe(true);
  });
});

// ───────────────────────────── Contenu ─────────────────────────────

describe('level1 : contenu', () => {
  it('n\'utilise que slime, bat et skeleton (aucun boss)', () => {
    const kinds = new Set(level1.rooms.flatMap((r) => r.enemies.map((e) => e.kind)));
    expect([...kinds].sort()).toEqual(['bat', 'skeleton', 'slime']);
  });

  it('combine plaques, leviers, clés et portes', () => {
    const types = new Set(level1.rooms.flatMap((r) => r.mechanisms.map((m) => m.type)));
    for (const t of ['plate', 'lever', 'key', 'door']) expect(types.has(t as MechanismDef['type'])).toBe(true);
  });

  it('chaque salle a un mécanisme présent dès 1 joueur', () => {
    for (const r of level1.rooms) {
      expect(
        r.mechanisms.some((m) => (m.minPlayers ?? 1) <= 1 && ['plate', 'lever', 'key'].includes(m.type)),
        r.id,
      ).toBe(true);
    }
  });

  it('suit la progression imposée salle par salle', () => {
    expect(level1.rooms.map((r) => r.id)).toEqual(['vestibule', 'plates', 'cells', 'ossuary', 'antechamber', 'seal']);
    // 1 : un levier simple qui ouvre la porte, panneaux d'explication, slimes + chauves-souris
    const v = room('vestibule');
    const lv1 = mech(v, 'lv1', 'lever');
    expect(lv1.ownerSlot).toBeUndefined();
    expect(lv1.windowMs).toBeUndefined();
    expect(mech(v, 'd1', 'door').requires).toEqual(['lv1']);
    expect(v.signs?.length).toBeGreaterThanOrEqual(2);
    expect(new Set(v.enemies.map((e) => e.kind))).toEqual(new Set(['slime', 'bat']));
    // 2 : porte à 2 plaques simultanées, 2e plaque minPlayers 2, couleurs de slot
    const p = room('plates');
    const d2 = mech(p, 'd2', 'door');
    expect(d2.requires).toEqual(['pA', 'pB']);
    expect(mech(p, 'pA', 'plate').minPlayers ?? 1).toBe(1);
    expect(mech(p, 'pB', 'plate').minPlayers).toBe(2);
    expect(mech(p, 'pA', 'plate').colorSlot).toBe(0);
    expect(mech(p, 'pB', 'plate').colorSlot).toBe(1);
    // 3 : squelettes (embuscade) + panneau de relevage + 4 clés personnelles / 4 portes
    const c = room('cells');
    expect(c.enemies.every((e) => e.kind === 'skeleton')).toBe(true);
    expect(c.signs?.some((s) => s.id === 's_revive')).toBe(true);
    const keys = c.mechanisms.filter((m) => m.type === 'key');
    expect(keys.map((k) => (k.type === 'key' ? k.ownerSlot : -1)).sort()).toEqual([0, 1, 2, 3]);
    expect(c.mechanisms.filter((m) => m.type === 'door')).toHaveLength(4);
    // 4 : combat en vagues
    const o = room('ossuary');
    expect(new Set(o.enemies.map((e) => e.wave ?? 0)).size).toBeGreaterThanOrEqual(3);
    // 5 : un levier à fenêtre par slot
    const a = room('antechamber');
    const levers = a.mechanisms.filter((m): m is LeverDef => m.type === 'lever');
    expect(levers.map((l) => l.ownerSlot).sort()).toEqual([0, 1, 2, 3]);
    expect(levers.every((l) => (l.windowMs ?? 0) > 0)).toBe(true);
    // 6 : salle finale, sortie scellée
    const s = room('seal');
    expect(s.exit.final).toBe(true);
    expect(s.exit.sealed).toBe(true);
  });

  it('couvre les 4 slots avec des objectifs variés, tous exigés par la sortie scellée', () => {
    expect(level1.objectives).toHaveLength(4);
    expect(level1.objectives.map((o) => o.slot).sort()).toEqual([0, 1, 2, 3]);
    expect(new Set(level1.objectives.map((o) => o.kind))).toEqual(new Set(['mechanism', 'zone', 'kills']));
    const finalRoom = level1.rooms[level1.rooms.length - 1];
    expect([...finalRoom.exit.requires].sort()).toEqual(level1.objectives.map((o) => `obj:${o.id}`).sort());
  });

  it('n\'a aucune sortie finale hors de la dernière salle', () => {
    const finals = level1.rooms.filter((r) => r.exit.final);
    expect(finals).toHaveLength(1);
    expect(finals[0]).toBe(level1.rooms[level1.rooms.length - 1]);
    for (const r of level1.rooms.slice(0, -1)) {
      expect(r.exit.final).toBeUndefined();
      expect(r.exit.sealed).toBeUndefined();
    }
  });

  it('exige dans chaque salle l\'objectif qu\'elle porte (aucun objectif ne peut être raté)', () => {
    for (const o of level1.objectives) {
      const r = room(o.roomId);
      if (r.exit.final) continue;
      // L'objectif doit être accompli avant de quitter la salle : soit exigé, soit accompli par un prérequis de sortie.
      const explicit = r.exit.requires.includes(`obj:${o.id}`);
      const viaMechanism = o.kind === 'mechanism' && o.mechanismId !== undefined && r.exit.requires.includes(o.mechanismId);
      const viaDoorDeps = o.kind === 'mechanism' && o.mechanismId !== undefined && doorDependsOn(r, r.exit.requires, o.mechanismId);
      expect(explicit || viaMechanism || viaDoorDeps, `${o.id} dans ${r.id}`).toBe(true);
    }
  });

  it('le nombre d\'ennemis ne dépend que du nombre de joueurs (minPlayers), de façon croissante', () => {
    for (const r of level1.rooms) {
      const counts = PLAYER_COUNTS.map((n) => enemyCount(r, n));
      expect(counts[0], `${r.id} : au moins un ennemi à 1 joueur`).toBeGreaterThanOrEqual(1);
      for (let i = 1; i < counts.length; i++) expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1]);
      // 14 à 45 ennemis par salle à 4 joueurs ; ≈ 55-65 % de ce nombre à 1 joueur.
      expect(counts[3], `${r.id} : ennemis à 4 joueurs`).toBeGreaterThanOrEqual(14);
      expect(counts[3], `${r.id} : ennemis à 4 joueurs`).toBeLessThanOrEqual(45);
      const ratio = counts[0] / counts[3];
      expect(ratio, `${r.id} : ratio 1 joueur / 4 joueurs`).toBeGreaterThanOrEqual(0.5);
      expect(ratio, `${r.id} : ratio 1 joueur / 4 joueurs`).toBeLessThanOrEqual(0.7);
      // Aucun champ de difficulté : seuls kind/tile/wave/when/minPlayers existent.
      for (const e of r.enemies) {
        expect(Object.keys(e).every((k) => ['kind', 'tile', 'wave', 'when', 'minPlayers'].includes(k))).toBe(true);
      }
    }
    // Le niveau reste intéressant à 4 joueurs : bien plus d'ennemis qu'en solo.
    const total = (n: number): number => level1.rooms.reduce((s, r) => s + enemyCount(r, n), 0);
    expect(total(4)).toBeGreaterThan(total(1));
    expect(total(1)).toBeGreaterThanOrEqual(90);
    expect(total(4)).toBeGreaterThanOrEqual(150);
    expect(total(4)).toBeLessThanOrEqual(220);
  });

  it('arrivée calme : aucun ennemi à moins de 12 tuiles d\'un point d\'arrivée', () => {
    for (const r of level1.rooms) {
      for (const e of r.enemies) {
        const d = Math.min(...r.playerSpawns.map((s) => Math.hypot(s[0] - e.tile[0], s[1] - e.tile[1])));
        expect(d, `${r.id} : ennemi en ${e.tile}`).toBeGreaterThanOrEqual(12);
      }
    }
  });

  it('écarte les éléments d\'une même épreuve (plaques, clés, leviers) : il faut se disperser', () => {
    const p = room('plates');
    expect(pathLength(p, mech(p, 'pA', 'plate').tile, mech(p, 'pB', 'plate').tile)).toBeGreaterThanOrEqual(35);
    const c = room('cells');
    const keys = c.mechanisms.flatMap((m) => (m.type === 'key' ? [m.tile] : []));
    expect(keys).toHaveLength(4);
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        expect(pathLength(c, keys[i], keys[j]), `clés ${i}/${j}`).toBeGreaterThanOrEqual(25);
      }
    }
    const a = room('antechamber');
    const levers = a.mechanisms.filter((m): m is LeverDef => m.type === 'lever');
    for (let i = 0; i < levers.length; i++) {
      for (let j = i + 1; j < levers.length; j++) {
        expect(pathLength(a, levers[i].tile, levers[j].tile), `leviers ${i}/${j}`).toBeGreaterThanOrEqual(30);
      }
    }
    // Le levier de la herse est loin du point d'arrivée.
    const v = room('vestibule');
    expect(pathLength(v, v.playerSpawns[0], mech(v, 'lv1', 'lever').tile)).toBeGreaterThanOrEqual(30);
  });

  it('l\'objectif de victoires a assez d\'ennemis à tout nombre de joueurs (marge ≥ 3×)', () => {
    const o = level1.objectives.find((x) => x.kind === 'kills')!;
    const r = room(o.roomId);
    for (const n of PLAYER_COUNTS) expect(enemyCount(r, n)).toBeGreaterThanOrEqual((o.count ?? 1) * 3);
  });

  it('place chaque élément sur sa propre tuile (aucun chevauchement dans une salle)', () => {
    for (const r of level1.rooms) {
      const seen = new Map<string, string>();
      const claim = (tile: TileXY, what: string, wallOk = false): void => {
        const k = `${tile[0]},${tile[1]}`;
        if (wallOk) return;
        expect(seen.has(k), `${r.id} : ${what} chevauche ${seen.get(k)} en ${k}`).toBe(false);
        seen.set(k, what);
      };
      r.playerSpawns.forEach((t, i) => claim(t, `spawn${i}`));
      r.enemies.forEach((e, i) => claim(e.tile, `ennemi${i}`));
      r.signs?.forEach((s) => claim(s.tile, `panneau ${s.id}`));
      for (const m of r.mechanisms) {
        if (m.type === 'plate' || m.type === 'lever' || m.type === 'key') claim(m.tile, m.id);
        if (m.type === 'door') m.tiles.forEach((t) => claim(t, m.id));
      }
      r.decor?.forEach((d, i) => claim(d.tile, `décor${i}`, d.type === 'torch' || d.type === 'banner'));
    }
  });

  it('place les portes dans des percées de 2 tuiles au moins (jamais de couloir étroit)', () => {
    for (const r of level1.rooms) {
      const grid = new RoomGrid(r.layout);
      for (const m of r.mechanisms) {
        if (m.type !== 'door') continue;
        expect(m.tiles.length, `${r.id}/${m.id}`).toBeGreaterThanOrEqual(2);
        for (const [x, y] of m.tiles) expect(grid.blocksMovement(x, y)).toBe(false);
      }
    }
  });

  it('tient dans les limites de longueur des textes (≤ 90 caractères, fr et en)', () => {
    const fr = getDictionary('fr');
    const en = getDictionary('en');
    const keys = collectRequiredI18nKeys(level1, { checkSpeakers: false })
      .map((r) => r.key)
      .filter((k) => k.startsWith('level.level1.') || k.startsWith('sign.level1.') || k.startsWith('hintroom.level1.'));
    expect(keys.length).toBeGreaterThan(20);
    for (const k of keys) {
      expect(fr[k].length, `fr ${k}`).toBeLessThanOrEqual(90);
      expect(en[k].length, `en ${k}`).toBeLessThanOrEqual(90);
    }
  });

  it('fournit des clés i18n valides : parité fr/en, aucune valeur vide, mêmes placeholders', () => {
    const fr = onlyKeys(getDictionary('fr'), 'level1');
    const en = onlyKeys(getDictionary('en'), 'level1');
    expect(Object.keys(en)).toEqual(Object.keys(fr));
    const ph = (s: string): string[] => Array.from(new Set(Array.from(s.matchAll(/\{(\w+)\}/g), (m) => m[1]))).sort();
    for (const [k, v] of Object.entries(fr)) {
      expect(v.trim().length, `fr ${k}`).toBeGreaterThan(0);
      expect(en[k].trim().length, `en ${k}`).toBeGreaterThan(0);
      expect(ph(en[k]), k).toEqual(ph(v));
      expect(k).toMatch(/^[A-Za-z0-9_]+(\.[A-Za-z0-9_-]+)+$/);
    }
    const keys = Object.keys(fr);
    expect(keys).toEqual([...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    // Toutes les clés des parts sont utilisées par le niveau (aucune clé orpheline).
    const used = new Set(collectRequiredI18nKeys(level1).map((r) => r.key));
    for (const k of keys) expect(used.has(k), `clé orpheline : ${k}`).toBe(true);
  });
});

/** Une des exigences (récursivement via les portes de la salle) dépend-elle du mécanisme `target` ? */
function doorDependsOn(r: RoomDef, reqs: readonly string[], target: string, depth = 0): boolean {
  if (depth > 8) return false;
  for (const req of reqs) {
    if (req === target) return true;
    const m = r.mechanisms.find((x) => x.id === req);
    if (m?.type === 'door' && doorDependsOn(r, m.requires, target, depth + 1)) return true;
  }
  return false;
}

// ───────────────────────────── Résolution à 1..4 joueurs ─────────────────────────────

// ───────────────────────────── Salle sombre (torches) ─────────────────────────────

describe('level1 : salle sombre (torches et braseros)', () => {
  const braziers = (r: RoomDef) => r.mechanisms.flatMap((m) => (m.type === 'brazier' ? [m] : []));

  it("seule l'ossuaire est sombre, et c'est la première salle sombre du jeu", () => {
    expect(level1.rooms.filter((r) => r.dark === true).map((r) => r.id)).toEqual(['ossuary']);
    expect(level1.rooms.find((r) => r.dark === true)).toBe(room('ossuary'));
  });

  it('ossuary : plusieurs braseros allumés espacés le long du trajet + des braseros éteints facultatifs', () => {
    const o = room('ossuary');
    const lit = braziers(o).filter((b) => b.lit === true);
    const off = braziers(o).filter((b) => b.lit !== true);
    expect(lit.length).toBeGreaterThanOrEqual(3);
    expect(off.length).toBeGreaterThanOrEqual(2);
    expect(off.length).toBeLessThanOrEqual(3);
    // Un brasero allumé au départ ; les allumés s'étalent d'ouest en est (pas de zone noire de plus de ~30 tuiles).
    const xs = lit.map((b) => b.tile[0]).sort((a, b) => a - b);
    for (let i = 1; i < xs.length; i++) expect(xs[i] - xs[i - 1], `écart ${xs[i - 1]}→${xs[i]}`).toBeLessThanOrEqual(30);
    // Le levier de l'arène est visible (brasero allumé ou torche proche) ; les décors torch existent.
    const lever = mech(o, 'lv4', 'lever').tile;
    const near = lit.some((b) => Math.hypot(b.tile[0] - lever[0], b.tile[1] - lever[1]) <= 6);
    expect(near).toBe(true);
    expect((o.decor ?? []).filter((d) => d.type === 'torch').length).toBeGreaterThan(3);
  });

  it("ossuary : spawns éclairés (≤ 6 tuiles d'un brasero allumé) et tous les braseros atteignables", () => {
    const o = room('ossuary');
    const lit = braziers(o).filter((b) => b.lit === true);
    for (const sp of o.playerSpawns) {
      const d = Math.min(...lit.map((b) => Math.hypot(b.tile[0] - sp[0], b.tile[1] - sp[1])));
      expect(d, `spawn ${sp}`).toBeLessThanOrEqual(6);
    }
    for (const b of braziers(o)) {
      const [x, y] = b.tile;
      const d = Math.min(...[[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dy]) => pathLength(o, o.playerSpawns[0], [x + dx, y + dy])));
      expect(Number.isFinite(d), `brasero ${b.id} atteignable`).toBe(true);
    }
  });

  it("ossuary : le panneau d'enseignement de la torche est dès l'entrée, à côté d'un brasero allumé", () => {
    const o = room('ossuary');
    const sign = o.signs?.find((s) => s.id === 's_torch');
    expect(sign).toBeDefined();
    const fr = getDictionary('fr');
    expect(fr[sign!.textKey]).toMatch(/torche/i);
    expect(fr[o.introHintKey!]).toMatch(/torche/i);
    const start = braziers(o).find((b) => b.id === 'br_start')!;
    expect(start.lit).toBe(true);
    expect(Math.hypot(start.tile[0] - sign!.tile[0], start.tile[1] - sign!.tile[1])).toBeLessThanOrEqual(4);
    expect(Math.hypot(start.tile[0] - o.playerSpawns[0][0], start.tile[1] - o.playerSpawns[0][1])).toBeLessThanOrEqual(6);
    // Aucune salle précédente n'est sombre : le tutoriel de la torche n'apparaît qu'ici.
    for (const r of level1.rooms.slice(0, 3)) expect(r.dark).toBeUndefined();
  });

  it("ossuary : aucun brasero n'est exigé pour progresser (tâche annexe, solvable à 1..4 joueurs)", () => {
    const o = room('ossuary');
    const ids = new Set(braziers(o).map((b) => b.id));
    for (const req of o.exit.requires) expect(ids.has(req), req).toBe(false);
    for (const m of o.mechanisms) if (m.type === 'door') for (const req of m.requires) expect(ids.has(req), req).toBe(false);
    for (const e of o.enemies) if (e.when) expect(ids.has(e.when)).toBe(false);
    for (const b of braziers(o)) {
      expect(b.minPlayers).toBeUndefined();
      expect(b.ownerSlot).toBeUndefined();
    }
  });

  it("les braseros allumés sont actifs d'office, les éteints non, à tout nombre de joueurs", () => {
    const o = room('ossuary');
    for (const n of PLAYER_COUNTS) {
      const b = bench(o, n);
      for (const br of braziers(o)) expect(b.stateOf(br.id).active, `${br.id} à ${n}`).toBe(br.lit === true);
    }
  });
});

describe.each(PLAYER_COUNTS)('level1 : résolution à %i joueur(s)', (n) => {
  it('vestibule : le levier ouvre la herse', () => {
    const r = room('vestibule');
    const b = bench(r, n);
    expect(b.stateOf('d1')).toMatchObject({ open: false });
    expect(b.exitMet(0)).toBe(false);
    b.teleport(b.players[0], mech(r, 'lv1', 'lever').tile);
    b.step(100, { 0: true });
    expect(b.stateOf('lv1').active).toBe(true);
    b.step(100);
    expect(b.stateOf('d1')).toMatchObject({ open: true });
    expect(b.exitMet(1)).toBe(false); // il faut encore vaincre les ennemis
    expect(b.exitMet(0)).toBe(true);
  });

  it('plates : la porte exige les plaques actives (waived selon le nombre de joueurs)', () => {
    const r = room('plates');
    const b = bench(r, n);
    expect(b.stateOf('pB').waived).toBe(n < 2);
    // Personne sur les plaques : porte fermée.
    b.step();
    expect(b.stateOf('d2')).toMatchObject({ open: false });
    // J1 sur la plaque A.
    b.teleport(b.players[0], mech(r, 'pA', 'plate').tile);
    b.step();
    if (n === 1) {
      expect(b.stateOf('d2')).toMatchObject({ open: true });
    } else {
      expect(b.stateOf('d2')).toMatchObject({ open: false });
      b.teleport(b.players[1], mech(r, 'pB', 'plate').tile);
      b.step();
      expect(b.stateOf('d2')).toMatchObject({ open: true });
    }
    // La porte reste ouverte quand on quitte les plaques.
    b.teleport(b.players[0], r.playerSpawns[0]);
    b.step();
    expect(b.stateOf('d2')).toMatchObject({ open: true });
    expect(b.exitMet(2)).toBe(true);
  });

  it('cells : chaque joueur ramasse sa clé et ouvre sa porte ; les portes en trop sont neutralisées', () => {
    const r = room('cells');
    const b = bench(r, n);
    for (let slot = 0; slot < 4; slot++) {
      expect(b.stateOf(`kd${slot}`).waived).toBe(slot >= n);
      expect(b.stateOf(`k${slot}`).waived).toBe(slot >= n);
    }
    expect(b.exitMet()).toBe(false);
    for (let slot = 0; slot < n; slot++) {
      const key = mech(r, `k${slot}`, 'key');
      const door = mech(r, `kd${slot}`, 'door');
      const owner = b.players[resolveSlot(slot, n)];
      expect(owner.id).toBe(slot); // 1 joueur par slot non neutralisé
      b.teleport(owner, key.tile);
      b.step();
      expect(owner.keys).toContain(key.id);
      // Le propriétaire marche jusqu'à la tuile voisine de sa porte (côté salle, x = 21).
      b.teleport(owner, [door.tiles[0][0] - 1, door.tiles[0][1]]);
      b.step(100, { [owner.id]: true } as Partial<Record<PlayerId, boolean>>);
      expect(b.stateOf(door.id)).toMatchObject({ open: true });
      expect(owner.keys).not.toContain(key.id);
    }
    expect(b.exitMet()).toBe(true);
  });

  it('cells : la clé d\'un autre joueur ne se ramasse pas', () => {
    if (n < 2) return;
    const r = room('cells');
    const b = bench(r, n);
    b.teleport(b.players[0], mech(r, 'k1', 'key').tile);
    b.step();
    expect(b.players[0].keys).not.toContain('k1');
  });

  it('ossuary : le levier est utilisable et l\'objectif de victoires est atteignable', () => {
    const r = room('ossuary');
    const b = bench(r, n);
    b.teleport(b.players[0], mech(r, 'lv4', 'lever').tile);
    b.step(100, { 0: true });
    expect(b.stateOf('lv4').active).toBe(true);
    const o = level1.objectives.find((x) => x.kind === 'kills')!;
    const owner = resolveSlot(o.slot, n);
    const deaths = Array.from({ length: o.count ?? 1 }, () => ({ kind: 'slime' as const, byPlayer: owner, roomId: 'ossuary' }));
    updateObjectives({ level: level1, room: r, objectives: b.objectives, players: b.players, mechanisms: b.mechanisms, deaths, dtMs: 100 });
    expect(isObjectiveDone(b.objectives, o.id)).toBe(true);
  });

  it('antechamber : les 4 leviers à fenêtre ouvrent la grande porte quand on enchaîne les tours', () => {
    const r = room('antechamber');
    const b = bench(r, n);
    const levers = r.mechanisms.filter((m): m is LeverDef => m.type === 'lever');
    const windowMs = effectiveLeverWindowMs(r, n, levers[0]);
    expect(windowMs).toBe(24000 * Math.ceil(4 / n));

    // Temps de parcours estimé du plus long tour d'un joueur (vitesse du personnage le plus lent : 54 px/s).
    const slowest = 54;
    const toursByPlayer = new Map<PlayerId, LeverDef[]>();
    for (const l of levers) {
      const id = resolveSlot(l.ownerSlot ?? 0, n);
      toursByPlayer.set(id, [...(toursByPlayer.get(id) ?? []), l]);
    }
    let longestTourMs = 0;
    for (const tour of toursByPlayer.values()) {
      let tiles = 0;
      for (let i = 1; i < tour.length; i++) tiles += pathLength(r, tour[i - 1].tile, tour[i].tile);
      longestTourMs = Math.max(longestTourMs, (tiles * TILE * 1000) / slowest);
    }
    expect(longestTourMs, 'le tour le plus long doit tenir dans la fenêtre avec marge').toBeLessThan(windowMs * 0.8);

    // Simulation chronométrée : chaque joueur part de son point d'arrivée, marche (54 px/s) jusqu'à son premier
    // levier, l'actionne, puis enchaîne ses autres leviers ; durées = longueur BFS réelle du chemin.
    expect(b.stateOf('d5')).toMatchObject({ open: false });
    const events: { t: number; pid: PlayerId; tile: TileXY }[] = [];
    for (const [pid, tour] of toursByPlayer.entries()) {
      let t = 0;
      let from: TileXY = r.playerSpawns[pid];
      for (const lever of tour) {
        t += (pathLength(r, from, lever.tile) * TILE * 1000) / slowest;
        events.push({ t, pid, tile: lever.tile });
        from = lever.tile;
      }
    }
    events.sort((x, y) => x.t - y.t);
    let clock = 0;
    for (let guard = 0; guard < 4000 && !b.stateOf('d5').active; guard++) {
      const pressed: Partial<Record<PlayerId, boolean>> = {};
      for (const ev of events) {
        if (ev.t > clock && ev.t <= clock + 100) {
          b.teleport(b.players[ev.pid], ev.tile);
          pressed[ev.pid] = true;
        }
      }
      b.step(100, pressed);
      clock += 100;
    }
    expect(b.stateOf('d5')).toMatchObject({ open: true });
    expect(b.exitMet()).toBe(true);
    const o = level1.objectives.find((x) => x.id === 'o_lever')!;
    updateObjectives({ level: level1, room: r, objectives: b.objectives, players: b.players, mechanisms: b.mechanisms, deaths: [], dtMs: 100 });
    expect(isObjectiveDone(b.objectives, o.id)).toBe(true);
  });

  it('antechamber : un levier seul retombe après la fenêtre (la porte reste fermée)', () => {
    if (n < 2) return;
    const r = room('antechamber');
    const b = bench(r, n);
    const l0 = mech(r, 'lev0', 'lever');
    b.teleport(b.players[0], l0.tile);
    b.step(100, { 0: true });
    expect(b.stateOf('lev0').active).toBe(true);
    for (let t = 0; t < 500; t++) b.step(100); // 50 s > fenêtre maximale (48 s à 2-3 joueurs)
    expect(b.stateOf('lev0').active).toBe(false);
    expect(b.stateOf('d5')).toMatchObject({ open: false });
  });

  it('seal : tenir le cercle accomplit o_zone et la sortie scellée exige les 4 objectifs', () => {
    const r = room('seal');
    const b = bench(r, n);
    const zoneObj = level1.objectives.find((x) => x.kind === 'zone')!;
    const owner = b.players[resolveSlot(zoneObj.slot, n)];
    const zone = r.zones![0].rect;
    expect(b.exitMet()).toBe(false);
    // Les trois autres objectifs accomplis dans les salles précédentes.
    for (const o of b.objectives) if (o.id !== zoneObj.id) o.done = true;
    expect(b.exitMet()).toBe(false);
    // Le propriétaire entre dans le cercle et y reste 6 s.
    b.teleport(owner, [zone.x + 1, zone.y + 1]);
    for (let t = 0; t < 59; t++) {
      updateObjectives({ level: level1, room: r, objectives: b.objectives, players: b.players, mechanisms: b.mechanisms, deaths: [], dtMs: 100 });
    }
    expect(isObjectiveDone(b.objectives, zoneObj.id)).toBe(false);
    for (let t = 0; t < 3; t++) {
      updateObjectives({ level: level1, room: r, objectives: b.objectives, players: b.players, mechanisms: b.mechanisms, deaths: [], dtMs: 100 });
    }
    expect(isObjectiveDone(b.objectives, zoneObj.id)).toBe(true);
    expect(b.exitMet()).toBe(true);
  });

  it('seal : la plaque du sceau est actionnable (les gardiens apparaissent à son activation)', () => {
    const r = room('seal');
    const b = bench(r, n);
    expect(b.stateOf('pcirc').active).toBe(false);
    b.teleport(b.players[0], mech(r, 'pcirc', 'plate').tile);
    b.step();
    expect(b.stateOf('pcirc').active).toBe(true);
    // Les gardiens (ennemis à condition) sont tous conditionnés par cette plaque ; des sentinelles rôdent sans condition.
    expect(r.enemies.filter((e) => e.when !== undefined).every((e) => e.when === 'pcirc')).toBe(true);
    expect(r.enemies.filter((e) => e.when === undefined).length).toBeGreaterThanOrEqual(6);
    expect(r.enemies.filter((e) => e.when === 'pcirc').length).toBeGreaterThanOrEqual(14);
  });
});
