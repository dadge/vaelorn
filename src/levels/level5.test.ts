import { describe, expect, it } from 'vitest';

import { INTERACT_RANGE, LIGHT_FULL_TILES, TILE } from '../core/constants';
import { getCharacter } from '../core/characters';
import { isBossKind, isMiniBossKind } from '../core/enemies';
import { RoomGrid } from '../core/grid';
import { collectRequiredI18nKeys, validateBossStructure, validateLevel } from '../core/levelValidation';
import { createRoomMechanisms, effectiveHourglassPeriodMs, requiredPushers } from '../core/mechanisms';
import { createObjectives } from '../core/objectives';
import { resolveSlot } from '../core/slots';
import type { EnemyKind, HourglassDef, MechanismDef, RoomDef, TileXY } from '../core/types';
import { getDictionary } from '../i18n/i18n';
import { LEVELS } from './index';
import { level1 } from './level1';
import { level2 } from './level2';
import { level3 } from './level3';
import { level5 } from './level5';

// ───────────────────────────── Aides ─────────────────────────────

const PLAYER_COUNTS = [1, 2, 3, 4] as const;
const ALLOWED_SPEAKERS = ['narrator', 'aldric', 'lyssa', 'heroes', 'forgelord'];
const MAX_TEXT = 90;

function room(id: string): RoomDef {
  const r = level5.rooms.find((x) => x.id === id);
  if (!r) throw new Error(`salle introuvable : ${id}`);
  return r;
}

function mech<T extends MechanismDef['type']>(r: RoomDef, id: string, type: T): Extract<MechanismDef, { type: T }> {
  const m = r.mechanisms.find((x) => x.id === id);
  if (!m || m.type !== type) throw new Error(`mécanisme ${type} introuvable : ${id}`);
  return m as Extract<MechanismDef, { type: T }>;
}

function hourglassesOf(r: RoomDef): HourglassDef[] {
  return r.mechanisms.filter((m): m is HourglassDef => m.type === 'hourglass');
}

function enemiesAt(r: RoomDef, n: number) {
  return r.enemies.filter((e) => (e.minPlayers ?? 1) <= n);
}

function totalEnemies(level: { rooms: readonly RoomDef[] }, n: number): number {
  return level.rooms.reduce((sum, r) => sum + enemiesAt(r, n).length, 0);
}

function tileKey(t: readonly [number, number]): number {
  return t[1] * 1000 + t[0];
}

/** Tuiles atteignables depuis `from` (4-connexe, sol uniquement) en traitant `blocked` comme des murs ; portes comptées ouvertes. */
function reach(r: RoomDef, from: TileXY, blocked: readonly TileXY[] = []): Set<number> {
  const grid = new RoomGrid(r.layout);
  const stop = new Set(blocked.map(tileKey));
  const seen = new Set<number>([tileKey(from)]);
  const queue: TileXY[] = [from];
  for (let i = 0; i < queue.length; i++) {
    const [x, y] = queue[i];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx;
      const ny = y + dy;
      const k = ny * 1000 + nx;
      if (grid.blocksMovement(nx, ny) || stop.has(k) || seen.has(k)) continue;
      seen.add(k);
      queue.push([nx, ny]);
    }
  }
  return seen;
}

/**
 * Longueur (tuiles) du plus court chemin à pied entre deux tuiles, diagonales permises (distance « octile », sans contrôle des
 * coins) ; portes et herses comptées ouvertes. Infinity si inaccessible. Un héros se déplace en continu : sa course est ≥ 0,92 × cette
 * longueur (la distance octile dépasse l'euclidienne de 8,2 % au plus) et ≤ 1,05 × quand le chemin est dégagé.
 */
function walkTiles(r: RoomDef, from: TileXY, to: TileXY): number {
  const grid = new RoomGrid(r.layout);
  const dist = new Map<number, number>([[tileKey(from), 0]]);
  const open: [number, TileXY][] = [[0, from]];
  while (open.length > 0) {
    open.sort((a, b) => a[0] - b[0]);
    const [d, [x, y]] = open.shift() as [number, TileXY];
    if (d > (dist.get(tileKey([x, y])) ?? Infinity)) continue;
    if (x === to[0] && y === to[1]) return d;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (grid.blocksMovement(nx, ny)) continue;
        const nd = d + (dx !== 0 && dy !== 0 ? Math.SQRT2 : 1);
        if (nd < (dist.get(tileKey([nx, ny])) ?? Infinity)) {
          dist.set(tileKey([nx, ny]), nd);
          open.push([nd, [nx, ny]]);
        }
      }
    }
  }
  return Infinity;
}

/** Vitesse (px/s) du héros « moyen » de référence pour la course vers la herse : david, un héros de mêlée de vitesse ordinaire. */
const REFERENCE_SPEED = getCharacter('david').speed;

function readPart(lang: 'fr' | 'en'): Record<string, string> {
  return Object.fromEntries(Object.entries(getDictionary(lang)).filter(([k]) => k.includes('level5') || k === 'speaker.forgelord'));
}

function placeholders(value: string): string[] {
  return Array.from(new Set(Array.from(value.matchAll(/\{(\w+)\}/g), (m) => m[1]))).sort();
}

// ───────────────────────────── Validité globale ─────────────────────────────

describe('level5 — validation', () => {
  it('validateLevel (dictionnaires fr + en, orateurs) ne retourne aucune erreur à 1, 2, 3 et 4 joueurs', () => {
    const errors = validateLevel(level5, {
      dictionaries: { fr: getDictionary('fr'), en: getDictionary('en') },
      checkSpeakers: true,
    });
    expect(errors).toEqual([]);
  });

  it('validateBossStructure : au moins 2 demi-boss à tout n, sorties exigeant clear, boss final présent', () => {
    expect(validateBossStructure(level5, { minMiniBosses: 2 })).toEqual([]);
  });

  it('identité du niveau : id, thème ember, nom, durée estimée', () => {
    expect(level5.id).toBe('level5');
    expect(level5.theme).toBe('ember');
    expect(level5.nameKey).toBe('level.level5.name');
    expect(getDictionary('fr')['level.level5.name']).toBe('Les Forges Ardentes');
    expect(level5.estimatedMinutes).toBeGreaterThanOrEqual(5);
    expect(level5.estimatedMinutes).toBeLessThanOrEqual(10);
    for (const r of level5.rooms) expect(r.theme, r.id).toBe('ember');
  });

  it("compte 7 à 9 salles, dans l'ordre prévu", () => {
    expect(level5.rooms.length).toBeGreaterThanOrEqual(7);
    expect(level5.rooms.length).toBeLessThanOrEqual(9);
    expect(level5.rooms.map((r) => r.id)).toEqual([
      'ashgate',
      'slagworks',
      'crucible',
      'pyre',
      'cinderpit',
      'blindforge',
      'bellows',
      'emberhold',
      'forgeheart',
    ]);
  });

  it('est enregistré dans LEVELS, après les niveaux 1 à 3, avant un éventuel niveau 6', () => {
    const ids = LEVELS.map((l) => l.id);
    expect(ids).toContain('level5');
    expect(ids.indexOf('level5')).toBeGreaterThan(ids.indexOf('level3'));
    if (ids.includes('level6')) expect(ids.indexOf('level5')).toBeLessThan(ids.indexOf('level6'));
    expect(LEVELS.find((l) => l.id === 'level5')).toBe(level5);
  });

  it('chaque salle est GRANDE (54..86 × 40..52 tuiles), entourée de murs, avec 4 spawns groupés', () => {
    for (const r of level5.rooms) {
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

  it("chaque salle a un nom, un indice d'arrivée, des panneaux et des décors", () => {
    for (const r of level5.rooms) {
      expect(r.nameKey).toBe(`room.level5.${r.id}.name`);
      expect(r.introHintKey).toBe(`hintroom.level5.${r.id}`);
      expect((r.signs ?? []).length, `${r.id} panneaux`).toBeGreaterThanOrEqual(1);
      expect((r.decor ?? []).length, `${r.id} décors`).toBeGreaterThanOrEqual(3);
      for (const s of r.signs ?? []) expect(s.textKey).toBe(`sign.level5.${s.id}`);
    }
  });

  it('tous les sols sont atteignables depuis l’arrivée (herses et portes comptées franchissables) : aucune poche fermée', () => {
    for (const r of level5.rooms) {
      const seen = reach(r, r.playerSpawns[0]);
      let floors = 0;
      r.layout.forEach((row, y) =>
        [...row].forEach((c, x) => {
          if (c === '.' || c === ',') {
            floors++;
            expect(seen.has(tileKey([x, y])), `${r.id} sol [${x},${y}] inatteignable`).toBe(true);
          }
        }),
      );
      expect(floors).toBeGreaterThan(1000);
    }
  });
});

// ───────────────────────────── Textes et i18n ─────────────────────────────

describe('level5 — textes', () => {
  it('toutes les clés référencées existent en français ET en anglais (valeurs non vides)', () => {
    const refs = collectRequiredI18nKeys(level5, { checkSpeakers: true });
    expect(refs.length).toBeGreaterThan(80);
    for (const lang of ['fr', 'en'] as const) {
      const dict = getDictionary(lang);
      for (const { key, context } of refs) expect(dict[key]?.trim().length ?? 0, `${lang} ${key} (${context})`).toBeGreaterThan(0);
    }
  });

  it('parité fr/en des clés du niveau, mêmes paramètres {x}, aucune clé orpheline, textes courts', () => {
    const fr = readPart('fr');
    const en = readPart('en');
    expect(Object.keys(en).sort()).toEqual(Object.keys(fr).sort());
    const used = new Set(collectRequiredI18nKeys(level5, { checkSpeakers: true }).map((r) => r.key));
    for (const key of Object.keys(fr)) {
      expect(used.has(key), `clé non utilisée : ${key}`).toBe(true);
      expect(placeholders(fr[key]), key).toEqual(placeholders(en[key]));
      expect(fr[key].length, `${key} fr`).toBeLessThanOrEqual(MAX_TEXT);
      expect(en[key].length, `${key} en`).toBeLessThanOrEqual(MAX_TEXT);
    }
  });

  it("dialogues : intro de 3 à 6 répliques, outro de 2 à 6, orateurs connus (nouvel orateur : speaker.forgelord)", () => {
    expect(level5.intro.length).toBeGreaterThanOrEqual(3);
    expect(level5.intro.length).toBeLessThanOrEqual(6);
    expect(level5.outro.length).toBeGreaterThanOrEqual(2);
    expect(level5.outro.length).toBeLessThanOrEqual(6);
    level5.intro.forEach((l, i) => expect(l.textKey).toBe(`level.level5.intro.${i + 1}`));
    level5.outro.forEach((l, i) => expect(l.textKey).toBe(`level.level5.outro.${i + 1}`));
    for (const l of [...level5.intro, ...level5.outro]) expect(ALLOWED_SPEAKERS).toContain(l.speaker);
    for (const lang of ['fr', 'en'] as const) expect(getDictionary(lang)['speaker.forgelord']?.length).toBeGreaterThan(0);
  });
});

// ───────────────────────────── Ennemis ─────────────────────────────

describe('level5 — ennemis', () => {
  it("nettement plus d'ennemis que les niveaux 1 à 3 : au moins +25 % du maximum à 1 joueur ET à 4 joueurs", () => {
    for (const n of [1, 4]) {
      const max = Math.max(totalEnemies(level1, n), totalEnemies(level2, n), totalEnemies(level3, n));
      const mine = totalEnemies(level5, n);
      expect(mine, `n=${n} : ${mine} ennemis contre un maximum de ${max} aux niveaux 1-3`).toBeGreaterThanOrEqual(Math.ceil(max * 1.25));
    }
  });

  it('le total croît avec les joueurs ; chaque salle a au moins un ennemi dès 1 joueur', () => {
    const totals = PLAYER_COUNTS.map((n) => totalEnemies(level5, n));
    for (let i = 1; i < totals.length; i++) expect(totals[i]).toBeGreaterThan(totals[i - 1]);
    for (const r of level5.rooms) {
      let prev = 0;
      for (const n of PLAYER_COUNTS) {
        const count = enemiesAt(r, n).length;
        expect(count, `${r.id} à ${n} joueur(s)`).toBeGreaterThanOrEqual(prev);
        prev = count;
      }
      expect(enemiesAt(r, 1).length, `${r.id} à 1 joueur`).toBeGreaterThanOrEqual(1);
    }
  });

  it("le nombre d'ennemis ne dépend que des joueurs : champs autorisés, minPlayers 1..4 (jamais de difficulté)", () => {
    const allowed = new Set(['kind', 'tile', 'wave', 'when', 'minPlayers']);
    for (const r of level5.rooms) {
      for (const e of r.enemies) {
        for (const k of Object.keys(e)) expect(allowed.has(k), `${r.id} champ ${k}`).toBe(true);
        if (e.minPlayers !== undefined) {
          expect(Number.isInteger(e.minPlayers)).toBe(true);
          expect(e.minPlayers).toBeGreaterThanOrEqual(1);
          expect(e.minPlayers).toBeLessThanOrEqual(4);
        }
      }
    }
  });

  it("arrivée calme : aucun ennemi à moins de 12 tuiles des spawns ; jamais deux ennemis sur la même tuile", () => {
    for (const r of level5.rooms) {
      const seen = new Set<string>();
      for (const e of r.enemies) {
        for (const sp of r.playerSpawns) {
          expect(Math.hypot(e.tile[0] - sp[0], e.tile[1] - sp[1]), `${r.id} ${e.kind} ${e.tile}`).toBeGreaterThanOrEqual(12);
        }
        const k = `${e.tile[0]},${e.tile[1]}`;
        expect(seen.has(k), `${r.id} doublon ${k}`).toBe(false);
        seen.add(k);
      }
    }
  });

  it("densité : 20 à 46 ennemis par salle à 4 joueurs (hors arène de boss), les types d'ennemis ordinaires sont tous présents", () => {
    const used = new Set<EnemyKind>();
    for (const r of level5.rooms.slice(0, -1)) {
      const at4 = enemiesAt(r, 4).length;
      expect(at4, `${r.id} à 4 joueurs`).toBeGreaterThanOrEqual(20);
      expect(at4, `${r.id} à 4 joueurs`).toBeLessThanOrEqual(46);
      for (const e of r.enemies) used.add(e.kind);
    }
    for (const k of ['slime', 'bat', 'skeleton', 'archer', 'spider', 'wisp', 'knight'] as const) expect(used.has(k), k).toBe(true);
  });

  it('la salle d’apprentissage est calme : aucun ennemi du côté de l’arrivée, ni avant la herse', () => {
    const r = room('ashgate');
    const hg = hourglassesOf(r)[0];
    const gateX = hg.gate[0][0];
    for (const e of r.enemies) expect(e.tile[0], `${e.kind} ${e.tile}`).toBeGreaterThan(gateX + 10);
  });
});

// ───────────────────────────── Demi-boss et boss ─────────────────────────────

describe('level5 — demi-boss et boss', () => {
  const minis = level5.rooms.flatMap((r, index) => r.enemies.filter((e) => isMiniBossKind(e.kind)).map((e) => ({ room: r, index, e })));

  it('deux demi-boss pyromanciens, présents à TOUS les nombres de joueurs, sans condition d’apparition', () => {
    expect(minis.length).toBe(2);
    for (const m of minis) {
      expect(m.e.kind).toBe('pyromancer');
      expect(m.e.minPlayers ?? 1).toBe(1);
      expect(m.e.when).toBeUndefined();
      expect((m.e.wave ?? 0)).toBe(0);
      // accompagné de sbires dont le nombre suit les joueurs
      const others = (n: number) => enemiesAt(m.room, n).filter((e) => !isMiniBossKind(e.kind)).length;
      expect(others(1)).toBeGreaterThanOrEqual(10);
      expect(others(4)).toBeGreaterThan(others(1));
    }
  });

  it('un demi-boss à mi-parcours (25 à 65 % du niveau), un autre dans une salle clé plus tard', () => {
    const last = level5.rooms.length - 1;
    const mid = minis[0];
    const later = minis[1];
    expect(mid.index / last).toBeGreaterThanOrEqual(0.25);
    expect(mid.index / last).toBeLessThanOrEqual(0.65);
    expect(later.index).toBeGreaterThan(mid.index + 1);
    expect(later.index).toBeLessThan(last);
    // salle clé : clés personnelles et portes à clé
    expect(later.room.mechanisms.some((m) => m.type === 'key')).toBe(true);
    expect(later.room.mechanisms.some((m) => m.type === 'door' && m.keyId !== undefined)).toBe(true);
  });

  it('la sortie de chaque salle de demi-boss exige clear ; ils sont donc obligatoires à vaincre', () => {
    for (const m of minis) expect(m.room.exit.requires, m.room.id).toContain('clear');
  });

  it("aucune herse de sablier dans une salle de boss : le boss se téléporte n'importe où dans la salle, il ne doit jamais être coupé des héros", () => {
    for (const r of level5.rooms) {
      if (!r.enemies.some((e) => isMiniBossKind(e.kind) || isBossKind(e.kind))) continue;
      expect(hourglassesOf(r), `${r.id} sablier`).toEqual([]);
      // seules des portes à clé (levées avant le combat) ; aucune porte qui reste fermée dans l'arène
      for (const m of r.mechanisms) {
        if (m.type === 'door') expect(m.keyId, `${r.id} ${m.id}`).toBeDefined();
      }
    }
    // salle de demi-boss 1 : arène pure
    expect(room('cinderpit').mechanisms).toEqual([]);
  });

  it('salle finale : exit.final scellée, arène de boss pure avec le Seigneur de la Forge, exige clear et les quatre objectifs', () => {
    const last = level5.rooms[level5.rooms.length - 1];
    const finals = level5.rooms.filter((r) => r.exit.final === true);
    expect(finals).toEqual([last]);
    for (const r of level5.rooms.slice(0, -1)) {
      expect(r.exit.final, r.id).toBeFalsy();
      expect(r.exit.sealed, r.id).toBeFalsy();
    }
    expect(last.id).toBe('forgeheart');
    expect(last.mechanisms).toEqual([]);
    expect(last.enemies.map((e) => e.kind)).toEqual(['forgelord']);
    expect(last.enemies[0].minPlayers ?? 1).toBe(1);
    expect(last.enemies[0].when).toBeUndefined();
    expect(isBossKind('forgelord')).toBe(true);
    expect(last.exit.sealed).toBe(true);
    expect(last.exit.requires).toContain('clear');
    for (const o of level5.objectives) expect(last.exit.requires).toContain(`obj:${o.id}`);
    const pillars = last.layout.join('').split('o').length - 1;
    expect(pillars).toBeGreaterThanOrEqual(12);
  });

  it('le boss est le seul boss de fin du niveau ; aucun autre boss que le pyromancien ailleurs', () => {
    for (const r of level5.rooms.slice(0, -1)) {
      for (const e of r.enemies) expect(isBossKind(e.kind), `${r.id} ${e.kind}`).toBe(false);
    }
  });
});

// ───────────────────────────── Sablier partagé ─────────────────────────────

describe('level5 — sablier partagé (mécanisme inédit)', () => {
  const rooms = level5.rooms.filter((r) => hourglassesOf(r).length > 0);

  it('le sablier est utilisé dans au moins 3 salles (ici 6), dont une salle à DEUX sabliers successifs', () => {
    expect(rooms.length).toBeGreaterThanOrEqual(3);
    expect(rooms.map((r) => r.id)).toEqual(['ashgate', 'slagworks', 'crucible', 'pyre', 'blindforge', 'bellows']);
    expect(hourglassesOf(room('crucible')).length).toBe(2);
    for (const r of rooms) if (r.id !== 'crucible') expect(hourglassesOf(r).length, r.id).toBe(1);
  });

  it('chaque sablier : herse de 3 tuiles qui ferme tout le couloir, un levier de CHAQUE côté, jamais exigé par une porte', () => {
    for (const r of rooms) {
      const grid = new RoomGrid(r.layout);
      for (const hg of hourglassesOf(r)) {
        expect(hg.levers.length, hg.id).toBe(2);
        expect(hg.gate.length, hg.id).toBe(3);
        const gx = hg.gate[0][0];
        const ys = hg.gate.map((t) => t[1]);
        for (const t of hg.gate) expect(t[0], hg.id).toBe(gx);
        // la herse occupe toute la largeur du couloir : murs juste au-dessus et juste en dessous
        expect(grid.blocksMovement(gx, Math.min(...ys) - 1), `${hg.id} mur au-dessus`).toBe(true);
        expect(grid.blocksMovement(gx, Math.max(...ys) + 1), `${hg.id} mur en dessous`).toBe(true);
        // un levier de chaque côté
        expect(hg.levers[0][0], hg.id).toBeLessThan(gx);
        expect(hg.levers[1][0], hg.id).toBeGreaterThan(gx);
        // levier voisin de la herse (de l'autre côté de la zone d'arrivée) : 4 à 12 tuiles ; levier côté arrivée : loin (voir « relais »)
        expect(Math.abs(hg.levers[1][0] - gx), `${hg.id} levier voisin`).toBeGreaterThanOrEqual(4);
        expect(Math.abs(hg.levers[1][0] - gx), `${hg.id} levier voisin`).toBeLessThanOrEqual(12);
        expect(hg.labelKey).toBe(`mech.level5.${r.id}.${hg.id}`);
      }
      for (const m of r.mechanisms) {
        if (m.type === 'door') for (const hg of hourglassesOf(r)) expect(m.requires, `${r.id} ${m.id}`).not.toContain(hg.id);
      }
      // jamais exigé non plus par la sortie : c'est un obstacle physique
      for (const hg of hourglassesOf(r)) expect(r.exit.requires).not.toContain(hg.id);
    }
  });

  it("passage OBLIGATOIRE : sans traverser les herses, la sortie est inatteignable ; chaque herse sépare ses deux leviers", () => {
    for (const r of rooms) {
      const gates = hourglassesOf(r).flatMap((h) => h.gate);
      const exitTile: TileXY = [r.exit.rect.x, r.exit.rect.y];
      const exitTiles: TileXY[] = [];
      for (let y = r.exit.rect.y; y < r.exit.rect.y + r.exit.rect.h; y++) for (let x = r.exit.rect.x; x < r.exit.rect.x + r.exit.rect.w; x++) exitTiles.push([x, y]);
      expect(exitTile).toBeDefined();
      const fromSpawn = reach(r, r.playerSpawns[0], gates);
      expect(
        exitTiles.some((t) => fromSpawn.has(tileKey(t))),
        `${r.id} : la sortie ne doit pas être atteignable sans les herses`,
      ).toBe(false);
      // chaque herse sépare ses deux leviers (même avec les autres herses ouvertes)
      for (const hg of hourglassesOf(r)) {
        const side = reach(r, hg.levers[0], hg.gate);
        expect(side.has(tileKey(hg.levers[0]))).toBe(true);
        expect(side.has(tileKey(hg.levers[1])), `${hg.id} sépare ses leviers`).toBe(false);
      }
    }
  });

  it('anti-verrou : au départ (et après un redémarrage de salle) la herse est fermée mais le levier de l’arrivée est du côté des joueurs', () => {
    for (const r of rooms) {
      const first = hourglassesOf(r)[0];
      const spawnSide = reach(r, r.playerSpawns[0], first.gate);
      expect(spawnSide.has(tileKey(first.levers[0])), `${first.id} : levier côté arrivée`).toBe(true);
      for (const n of PLAYER_COUNTS) {
        const states = createRoomMechanisms(r, n);
        for (const hg of hourglassesOf(r)) {
          const st = states.find((s) => s.id === hg.id);
          expect(st?.type === 'hourglass' && st.sandMs).toBe(0);
          expect(st?.type === 'hourglass' && st.closedCount).toBe(hg.gate.length);
        }
      }
      // aucun ennemi ni spawn sur la herse ou sur un levier
      const blocked = new Set(hourglassesOf(r).flatMap((h) => [...h.gate, ...h.levers]).map(tileKey));
      for (const e of r.enemies) expect(blocked.has(tileKey(e.tile)), `${r.id} ${e.kind}`).toBe(false);
      for (const s of r.playerSpawns) expect(blocked.has(tileKey(s))).toBe(false);
    }
  });

  it("sable COURT (4 s), herse rapide ; la période est doublée en solo ; l'apprentissage a la herse la plus lente", () => {
    const tuto = hourglassesOf(room('ashgate'))[0];
    const all = rooms.flatMap(hourglassesOf);
    expect(tuto.closeStepMs ?? 700).toBe(Math.max(...all.map((h) => h.closeStepMs ?? 700)));
    for (const h of all) {
      expect(effectiveHourglassPeriodMs(h, 1)).toBe(2 * h.periodMs);
      expect(effectiveHourglassPeriodMs(h, 2)).toBe(h.periodMs);
      expect(effectiveHourglassPeriodMs(h, 4)).toBe(h.periodMs);
      expect(h.periodMs, h.id).toBeGreaterThanOrEqual(4000);
      expect(h.periodMs, h.id).toBeLessThanOrEqual(4000);
      expect(h.closeStepMs ?? 700, h.id).toBeLessThanOrEqual(400);
    }
  });

  it("RELAIS OBLIGATOIRE (géométrie) : du levier côté arrivée, même sans détour, la course jusqu'à la herse dure plus que sable + fermeture", () => {
    for (const r of rooms) {
      for (const hg of hourglassesOf(r)) {
        // dernière tuile fermée = celle qu'un retardataire pourrait encore franchir ; borne basse de la course d'un héros de vitesse ordinaire
        const last = hg.gate[hg.gate.length - 1];
        const walk = walkTiles(r, hg.levers[0], last);
        const tiles = walk * 0.92;
        expect(Number.isFinite(walk), `${hg.id} : herse atteignable depuis le levier lointain`).toBe(true);
        const runPx = tiles * TILE - INTERACT_RANGE - TILE;
        const runMs = (runPx / REFERENCE_SPEED) * 1000;
        const closedMs = hg.periodMs + hg.gate.length * (hg.closeStepMs ?? 700);
        expect(runMs, `${hg.id} : course ${Math.round(runMs)} ms contre herse close après ${closedMs} ms`).toBeGreaterThan(closedMs + 150);
        expect(tiles, `${hg.id} : levier d'arrivée à ${tiles.toFixed(1)} tuiles`).toBeGreaterThanOrEqual(24);
        // un héros SEUL (sable doublé) passe encore, même le plus lent (borne haute : chemin + 5 % de détours), avant la dernière fermeture
        const slowest = Math.min(...(['david', 'sandrine', 'romain', 'valentine', 'aelith', 'brokk', 'grok', 'mira'] as const).map((c) => getCharacter(c).speed));
        const soloMs = ((walk * 1.05 * TILE - INTERACT_RANGE) / slowest) * 1000;
        expect(soloMs, `${hg.id} : course solo du plus lent ${Math.round(soloMs)} ms contre sable doublé ${2 * hg.periodMs} ms`).toBeLessThan(effectiveHourglassPeriodMs(hg, 1) + (hg.gate.length - 1) * (hg.closeStepMs ?? 700));
      }
    }
  });

  it("levier voisin de la herse : une zone d'au moins 5 tuiles sans ennemi (le coéquipier resté en arrière en dépend)", () => {
    for (const r of rooms) {
      for (const hg of hourglassesOf(r)) {
        for (const e of r.enemies) {
          expect(Math.hypot(e.tile[0] - hg.levers[1][0], e.tile[1] - hg.levers[1][1]), `${hg.id} ${e.kind} ${e.tile}`).toBeGreaterThanOrEqual(5);
        }
      }
    }
  });

  it("combiné aux mécanismes connus : plaques (porche), salle sombre + braseros, bloc 2×2 + socle, clés personnelles", () => {
    expect(room('pyre').mechanisms.some((m) => m.type === 'plate')).toBe(true);
    expect(room('pyre').mechanisms.some((m) => m.type === 'door')).toBe(true);
    const dark = room('blindforge');
    expect(dark.dark).toBe(true);
    expect(dark.mechanisms.some((m) => m.type === 'brazier' && m.lit === true)).toBe(true);
    expect(dark.mechanisms.filter((m) => m.type === 'brazier' && m.lit !== true).length).toBe(4);
    const bellows = room('bellows');
    expect(bellows.mechanisms.some((m) => m.type === 'block')).toBe(true);
    expect(bellows.mechanisms.some((m) => m.type === 'socket')).toBe(true);
    expect(room('emberhold').mechanisms.filter((m) => m.type === 'key').length).toBe(4);
    // les rooms combinées gardent le sablier comme passage obligatoire
    for (const id of ['pyre', 'blindforge', 'bellows']) expect(hourglassesOf(room(id)).length, id).toBe(1);
  });

  it('salle sombre : arrivée éclairée, brasero allumé de recharge près de chaque arrivée, torches près des épreuves', () => {
    const dark = room('blindforge');
    const lit = dark.mechanisms.filter((m) => m.type === 'brazier' && m.lit === true);
    const sources: TileXY[] = [
      ...lit.map((m) => (m.type === 'brazier' ? m.tile : [0, 0] as TileXY)),
      ...(dark.decor ?? []).filter((d) => d.type === 'torch').map((d) => d.tile),
    ];
    for (const sp of dark.playerSpawns) {
      expect(sources.some((t) => Math.hypot(t[0] - sp[0], t[1] - sp[1]) <= LIGHT_FULL_TILES), `spawn ${sp}`).toBe(true);
    }
    expect(lit.length).toBeGreaterThanOrEqual(5);
    for (const r of level5.rooms) if (r.id !== 'blindforge') expect(r.dark, r.id).toBeFalsy();
  });
});

// ───────────────────────────── Coopération adaptative ─────────────────────────────

describe('level5 — coopération adaptative (1 à 4 joueurs)', () => {
  it('plaques, clés, portes à clé et braseros de couleur : un par slot, minPlayers = slot + 1', () => {
    const plates = room('pyre').mechanisms.filter((m) => m.type === 'plate');
    const keys = room('emberhold').mechanisms.filter((m) => m.type === 'key');
    const braziers = room('blindforge').mechanisms.filter((m) => m.type === 'brazier' && m.lit !== true);
    for (const group of [plates, keys, braziers]) {
      expect(group.length).toBe(4);
      group.forEach((m, slot) => {
        expect(m.minPlayers ?? 1, m.id).toBe(slot === 0 ? 1 : slot + 1);
        if (m.type === 'key' || m.type === 'brazier') expect(m.ownerSlot).toBe(slot);
        if (m.type === 'plate') expect(m.colorSlot).toBe(slot);
      });
    }
    for (const door of room('emberhold').mechanisms.filter((m) => m.type === 'door')) {
      const key = keys.find((k) => k.type === 'key' && k.doorId === door.id);
      expect(door.minPlayers ?? 1).toBe(key?.minPlayers ?? 1);
    }
    // la porte du porche exige toutes les plaques, celle de la forge tous les braseros
    expect(mech(room('pyre'), 'pyreDoor', 'door').requires.length).toBe(4);
    expect(mech(room('blindforge'), 'hearthDoor', 'door').requires.length).toBe(4);
  });

  it('bloc des soufflets : pousseurs requis = min(2, nombre de joueurs) ; couloir fermé jusqu’au socle (aucun coincement possible)', () => {
    const r = room('bellows');
    const block = mech(r, 'bellowsBlock', 'block');
    const socket = mech(r, 'bellowsSocket', 'socket');
    for (const n of PLAYER_COUNTS) expect(requiredPushers(block, n)).toBe(Math.min(2, n));
    const grid = new RoomGrid(r.layout);
    const [bx, by] = block.tile;
    const [tx, ty] = socket.tile;
    expect(ty).toBe(by);
    expect(tx - bx).toBeGreaterThanOrEqual(28);
    for (let x = bx; x <= tx + 1; x++) {
      for (const [dx, dy] of [[0, 0], [0, 1]] as const) expect(grid.blocksMovement(x + dx, by + dy), `trajet [${x},${by + dy}]`).toBe(false);
      expect(grid.blocksMovement(x, by - 1), `mur nord x=${x}`).toBe(true);
      expect(grid.blocksMovement(x, by + 2), `mur sud x=${x}`).toBe(true);
    }
    expect(grid.blocksMovement(tx + 2, by)).toBe(true);
    expect(grid.blocksMovement(tx + 2, by + 1)).toBe(true);
    for (const dx of [-1, -2]) {
      expect(grid.blocksMovement(bx + dx, by)).toBe(false);
      expect(grid.blocksMovement(bx + dx, by + 1)).toBe(false);
    }
    for (const e of r.enemies) expect(e.tile[0] >= bx && e.tile[0] <= tx + 1 && e.tile[1] >= by && e.tile[1] <= by + 1, `ennemi ${e.tile} dans le couloir`).toBe(false);
  });
});

// ───────────────────────────── Objectifs ─────────────────────────────

describe('level5 — objectifs personnels', () => {
  it('un objectif par slot 0..3, de types variés, répartis sur 4 salles différentes (jamais la salle de boss)', () => {
    expect(level5.objectives.map((o) => o.slot).sort()).toEqual([0, 1, 2, 3]);
    expect(new Set(level5.objectives.map((o) => o.kind))).toEqual(new Set(['mechanism', 'zone', 'kills']));
    expect(new Set(level5.objectives.map((o) => o.roomId)).size).toBe(4);
    for (const o of level5.objectives) {
      expect(o.labelKey).toBe(`objective.level5.${o.id}`);
      expect(o.roomId).not.toBe('forgeheart');
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

  it("on ne peut pas quitter une salle sans avoir accompli l'objectif qu'elle porte (aucun objectif manquable)", () => {
    for (const o of level5.objectives) {
      const tokens = requiredTokens(room(o.roomId));
      const gated = tokens.has(`obj:${o.id}`) || (o.mechanismId !== undefined && tokens.has(o.mechanismId));
      expect(gated, `objectif ${o.id} dans ${o.roomId}`).toBe(true);
    }
  });

  it('chaque objectif a le bon propriétaire à 1, 2, 3 et 4 joueurs (slot % n) et reste accomplissable (mécanisme existant ou neutralisé)', () => {
    for (const n of PLAYER_COUNTS) {
      const objs = createObjectives(level5, n);
      for (const o of level5.objectives) expect(objs.find((s) => s.id === o.id)?.ownerId, `${o.id} à ${n}`).toBe(resolveSlot(o.slot, n));
    }
    const torch = level5.objectives.find((o) => o.id === 'torch');
    const yellow = mech(room('blindforge'), 'brazierYellow', 'brazier');
    expect(torch?.mechanismId).toBe('brazierYellow');
    expect(yellow.minPlayers).toBe(4);
    const hold = level5.objectives.find((o) => o.id === 'hold');
    const zone = room('crucible').zones?.find((z) => z.id === hold?.zoneId);
    expect(zone).toBeDefined();
    expect(hold?.seconds).toBe(8);
    expect(level5.objectives.find((o) => o.id === 'slayer')?.count).toBe(5);
  });
});
