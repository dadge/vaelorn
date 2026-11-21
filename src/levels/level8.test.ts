import { describe, expect, it } from 'vitest';

import { RoomGrid } from '../core/grid';
import { isAnyBossKind, isBossKind, isMiniBossKind } from '../core/enemies';
import { collectRequiredI18nKeys, validateBossStructure, validateLevel } from '../core/levelValidation';
import type { BossTacticId, EnemyKind, EnemySpawnDef, HourglassDef, LevelDef, MechanismDef, RoomDef, TileXY } from '../core/types';
import { getDictionary } from '../i18n/i18n';
import { TACTIC_LABEL_KEYS } from '../render/tacticIndicator';
import { LEVELS, getLevel } from './index';
import { level1 } from './level1';
import { level2 } from './level2';
import { level3 } from './level3';
import { level8 } from './level8';

// ───────────────────────────── Aides ─────────────────────────────

const PLAYER_COUNTS = [1, 2, 3, 4] as const;
const ALLOWED_SPEAKERS = ['narrator', 'aldric', 'lyssa', 'heroes', 'morvane', 'gorgrim', 'forgelord', 'voidlord', 'frostqueen'];
const MAX_TEXT = 90;
const COLOR_FR = ['bleu', 'rouge', 'vert', 'jaune'] as const;
const COLOR_EN = ['blue', 'red', 'green', 'yellow'] as const;
const DIRS4 = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;
const FLYING: readonly EnemyKind[] = ['bat', 'wisp', 'morvane', 'wraith', 'voidlord', 'pyromancer'];
const GROUND_ONLY: readonly EnemyKind[] = ['slime', 'skeleton', 'spider', 'knight'];
const TACTICAL_ROOMS = ['veilleurs', 'vigie', 'conseil'] as const;

function room(id: string): RoomDef {
  const r = level8.rooms.find((x) => x.id === id);
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

const tk = (t: readonly [number, number]): string => `${t[0]},${t[1]}`;

/** Tuiles de sol atteintes depuis `from` (4-connexe), sans traverser les tuiles `blocked` ni celles de `skip`. */
function reach(r: RoomDef, from: TileXY, blocked: Set<string>, skip: (x: number, y: number) => boolean = () => false): Set<string> {
  const seen = new Set<string>([tk(from)]);
  const queue: TileXY[] = [from];
  for (let i = 0; i < queue.length; i++) {
    const [cx, cy] = queue[i];
    for (const [dx, dy] of DIRS4) {
      const x = cx + dx;
      const y = cy + dy;
      const k = `${x},${y}`;
      if (!isFloor(r, x, y) || blocked.has(k) || skip(x, y) || seen.has(k)) continue;
      seen.add(k);
      queue.push([x, y]);
    }
  }
  return seen;
}

function doorTilesOf(r: RoomDef, ids: string[]): Set<string> {
  const out = new Set<string>();
  for (const m of r.mechanisms) {
    if (m.type === 'door' && ids.includes(m.id)) for (const t of m.tiles) out.add(tk(t));
    if (m.type === 'hourglass' && ids.includes(m.id)) for (const t of m.gate) out.add(tk(t));
  }
  return out;
}

function readPart(lang: 'fr' | 'en'): Record<string, string> {
  return Object.fromEntries(Object.entries(getDictionary(lang)).filter(([k]) => k.includes('level8')));
}

function placeholders(value: string): string[] {
  return Array.from(new Set(Array.from(value.matchAll(/\{(\w+)\}/g), (m) => m[1]))).sort();
}

function tacticsOf(r: RoomDef): Record<string, readonly BossTacticId[]> {
  const out: Record<string, readonly BossTacticId[]> = {};
  for (const e of r.enemies) if (e.tactics) out[e.kind] = e.tactics;
  return out;
}

// ───────────────────────────── Validité globale ─────────────────────────────

describe('level8 — validation', () => {
  it('validateLevel (dictionnaires fr + en, orateurs) ne retourne aucune erreur (1, 2, 3 et 4 joueurs), tactiques comprises', () => {
    const errors = validateLevel(level8, { dictionaries: { fr: getDictionary('fr'), en: getDictionary('en') }, checkSpeakers: true });
    expect(errors).toEqual([]);
  });

  it('validateBossStructure : au moins 2 demi-boss à tous les nombres de joueurs, salle finale avec boss', () => {
    expect(validateBossStructure(level8, { minMiniBosses: 2 })).toEqual([]);
  });

  it('identité du niveau : id, thème dawn, nom, durée estimée, enregistré en 8e position de LEVELS', () => {
    expect(level8.id).toBe('level8');
    expect(level8.theme).toBe('dawn');
    expect(level8.nameKey).toBe('level.level8.name');
    expect(getDictionary('fr')['level.level8.name']).toBe('Le Bastion des Stratèges');
    expect(getDictionary('en')['level.level8.name']).toBe("The Strategists' Bastion");
    expect(level8.estimatedMinutes).toBeGreaterThanOrEqual(5);
    expect(level8.estimatedMinutes).toBeLessThanOrEqual(10);
    for (const r of level8.rooms) expect(r.theme).toBe('dawn');
    expect(getLevel('level8')).toBe(level8);
    expect(LEVELS[7]).toBe(level8);
  });

  it('compte 8 salles, dans l\'ordre prévu', () => {
    expect(level8.rooms.map((r) => r.id)).toEqual(['parvis', 'armurerie', 'veilleurs', 'chicane', 'fosses', 'vigie', 'cabinet', 'conseil']);
  });

  it('chaque salle est vaste (54..86 × 40..52 tuiles), avec 4 spawns groupés, un indice, ≥ 2 panneaux et des décors', () => {
    for (const r of level8.rooms) {
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
      expect(r.nameKey, r.id).toBe(`room.level8.${r.id}.name`);
      expect(r.introHintKey, r.id).toBe(`hintroom.level8.${r.id}`);
      expect((r.signs ?? []).length, `${r.id} panneaux`).toBeGreaterThanOrEqual(2);
      expect((r.decor ?? []).length, `${r.id} décors`).toBeGreaterThan(0);
      expect(r.dark, `${r.id} : aucune salle sombre`).not.toBe(true);
      expect(r.mechanisms.some((m) => m.type === 'brazier'), `${r.id} : aucun brasero`).toBe(false);
    }
  });

  it('les tuiles de porte forment un passage du sol dans la grille (4 tuiles)', () => {
    for (const r of level8.rooms) {
      const grid = new RoomGrid(r.layout);
      for (const m of r.mechanisms) {
        if (m.type !== 'door') continue;
        expect(m.tiles.length, `${r.id}.${m.id}`).toBe(4);
        for (const [x, y] of m.tiles) expect(grid.blocksMovement(x, y), `${r.id}.${m.id} [${x},${y}]`).toBe(false);
      }
    }
  });

  it('est sérialisable en JSON sans perte (aucune fonction, aucune classe)', () => {
    expect(JSON.parse(JSON.stringify(level8))).toEqual(level8);
  });
});

// ───────────────────────────── Objectifs ─────────────────────────────

describe('level8 — objectifs personnels', () => {
  it('un objectif par slot 0..3, de types variés, répartis sur quatre salles', () => {
    expect(level8.objectives.map((o) => o.slot).sort()).toEqual([0, 1, 2, 3]);
    expect(new Set(level8.objectives.map((o) => o.kind)).size).toBeGreaterThanOrEqual(3);
    expect(new Set(level8.objectives.map((o) => o.roomId)).size).toBe(4);
    expect(level8.objectives.find((o) => o.id === 'banner')).toMatchObject({ slot: 0, kind: 'mechanism', roomId: 'parvis', mechanismId: 'parvisDoor' });
    expect(level8.objectives.find((o) => o.id === 'arsenal')).toMatchObject({ slot: 1, kind: 'kills', roomId: 'armurerie' });
    expect(level8.objectives.find((o) => o.id === 'rampart')).toMatchObject({ slot: 2, kind: 'zone', roomId: 'fosses', zoneId: 'rampart', seconds: 18 });
    expect(level8.objectives.find((o) => o.id === 'plans')).toMatchObject({ slot: 3, kind: 'mechanism', roomId: 'cabinet', mechanismId: 'cabinetStatues' });
  });

  it('les salles porteuses d\'objectifs ne se quittent qu\'une fois ceux-ci accomplis ; aucune exigence `zone:`', () => {
    expect(room('parvis').exit.requires).toContain('parvisDoor');
    expect(room('armurerie').exit.requires).toContain('obj:arsenal');
    expect(room('fosses').exit.requires).toContain('obj:rampart');
    const door = room('cabinet').mechanisms.find((m) => m.id === 'cabinetDoor');
    expect(door && door.type === 'door' && door.requires).toContain('cabinetStatues');
    for (const r of level8.rooms) {
      expect(r.exit.requires.some((q) => q.startsWith('zone:')), r.id).toBe(false);
      for (const m of r.mechanisms) if (m.type === 'door') expect(m.requires.some((q) => q.startsWith('zone:')), `${r.id}.${m.id}`).toBe(false);
    }
  });

  it('la salle finale est scellée et exige le boss vaincu et les quatre objectifs', () => {
    const last = level8.rooms[level8.rooms.length - 1];
    expect(last.id).toBe('conseil');
    expect(last.exit.final).toBe(true);
    expect(last.exit.sealed).toBe(true);
    expect(last.exit.requires).toEqual(['clear', 'obj:banner', 'obj:arsenal', 'obj:rampart', 'obj:plans']);
    expect(level8.rooms.filter((r) => r.exit.final)).toHaveLength(1);
  });
});

// ───────────────────────────── Identité : les boss malins ─────────────────────────────

describe('level8 — boss malins (tactiques)', () => {
  it('liste EXACTE des tactiques par salle : progression demi-boss 1 → demi-boss 2 → boss final, rien ailleurs', () => {
    expect(tacticsOf(room('veilleurs'))).toEqual({ warden: ['guardDowned'] });
    expect(tacticsOf(room('vigie'))).toEqual({ pyromancer: ['guardDowned', 'campCrystal', 'heedCalls', 'seizeItems'] });
    expect(tacticsOf(room('conseil'))).toEqual({
      forgelord: ['guardDowned', 'campCrystal', 'heedCalls', 'interceptCarrier', 'seizeItems', 'huntWeak'],
    });
    for (const r of level8.rooms) {
      if ((TACTICAL_ROOMS as readonly string[]).includes(r.id)) continue;
      expect(r.enemies.some((e) => e.tactics !== undefined), `${r.id} : aucune tactique hors des trois salles de boss`).toBe(false);
    }
  });

  it('la tactique n\'est portée que par un boss / demi-boss présent à tous les nombres de joueurs (jamais par un sbire)', () => {
    for (const r of level8.rooms) {
      for (const e of r.enemies) {
        if (e.tactics === undefined) continue;
        expect(isAnyBossKind(e.kind), `${r.id} ${e.kind}`).toBe(true);
        expect(e.minPlayers, `${r.id} ${e.kind}`).toBeUndefined();
        expect(e.tactics.length).toBeGreaterThan(0);
        expect(new Set(e.tactics).size).toBe(e.tactics.length);
      }
    }
    const count = (id: string): number => Object.values(tacticsOf(room(id))).reduce((a, t) => a + t.length, 0);
    expect(count('veilleurs')).toBeLessThan(count('vigie'));
    expect(count('vigie')).toBeLessThan(count('conseil'));
  });

  it('salles tactiques : PURES (aucun mécanisme, aucun abîme), trois cristaux (2 + 1 dès 3 joueurs), sortie après `clear`', () => {
    for (const id of TACTICAL_ROOMS) {
      const r = room(id);
      expect(r.mechanisms, id).toHaveLength(0);
      expect(r.layout.some((row) => row.includes('~')), `${id} sans abîme`).toBe(false);
      expect(r.exit.requires, id).toContain('clear');
      const cs = r.healCrystals ?? [];
      expect(cs, id).toHaveLength(3);
      expect(cs.filter((c) => c.minPlayers === undefined), id).toHaveLength(2);
      expect(cs.filter((c) => c.minPlayers === 3), id).toHaveLength(1);
      expect(new Set(cs.map((c) => c.id)).size).toBe(3);
    }
    for (const r of level8.rooms) {
      if (!(TACTICAL_ROOMS as readonly string[]).includes(r.id)) expect(r.healCrystals ?? [], `${r.id} : aucun cristal hors salle de boss`).toHaveLength(0);
    }
  });

  it('la légende de chaque tactique utilisée existe en fr et en (`tactic.label.*`)', () => {
    const fr = getDictionary('fr');
    const en = getDictionary('en');
    for (const k of TACTIC_LABEL_KEYS) {
      expect(fr[k], `fr ${k}`).toBeTruthy();
      expect(en[k], `en ${k}`).toBeTruthy();
    }
    for (const r of level8.rooms) {
      for (const e of r.enemies) for (const t of e.tactics ?? []) expect(fr[`tactic.label.${t}`], t).toBeTruthy();
    }
  });

  it('les panneaux et indices des salles tactiques expliquent le comportement du boss et le contre-jeu', () => {
    const fr = getDictionary('fr');
    expect(fr['hintroom.level8.veilleurs']).toMatch(/veille/i);
    expect(fr['hintroom.level8.vigie']).toMatch(/plans|groupés/i);
    expect(fr['sign.level8.parvis.eye']).toMatch(/icône/);
    expect(fr['sign.level8.veilleurs.counter']).toMatch(/spécial/);
    expect(fr['sign.level8.vigie.counter']).toMatch(/groupés/);
    expect(fr['sign.level8.vigie.bonus']).toMatch(/bonus/);
    expect(fr['sign.level8.conseil.counter']).toMatch(/bonus/);
    // aucune action de jeu ne permet de LÂCHER un bonus : aucun panneau ne le prétend
    for (const k of Object.keys(fr)) if (k.startsWith('sign.level8.') || k.startsWith('hintroom.level8.')) expect(fr[k], k).not.toMatch(/leurre|lâchez|lâché/i);
  });
});

// ───────────────────────────── Signatures de puzzle ─────────────────────────────

describe('level8 — chicane (runes + sablier)', () => {
  const r = room('chicane');
  const runes = r.mechanisms.find((m) => m.type === 'runePuzzle');
  const glass = r.mechanisms.find((m): m is HourglassDef => m.type === 'hourglass');

  it('runes vues du seul héros rouge (slot 1), séquence de ≥ 3 symboles, piédestaux très loin de l\'écran', () => {
    expect(runes && runes.type === 'runePuzzle').toBe(true);
    if (!runes || runes.type !== 'runePuzzle') return;
    expect(runes.visibleToSlot).toBe(1);
    expect(runes.sequence.length).toBeGreaterThanOrEqual(3);
    for (const s of runes.sequence) expect(runes.pedestals.some((p) => p.symbol === s), s).toBe(true);
    for (const p of runes.pedestals) {
      expect(Math.hypot(p.tile[0] - runes.displayTile[0], p.tile[1] - runes.displayTile[1]), `piédestal ${p.symbol}`).toBeGreaterThanOrEqual(25);
    }
  });

  it('la porte des runes est l\'UNIQUE lien du hall ouest au hall central, et la herse à sablier l\'unique lien vers la sortie', () => {
    const spawn = r.playerSpawns[0];
    const noDoors = reach(r, spawn, doorTilesOf(r, ['chicaneRuneDoor', 'chicaneHourglass']));
    const exitTile: TileXY = [r.exit.rect.x, r.exit.rect.y];
    expect(noDoors.has(tk(exitTile))).toBe(false);
    const west = reach(r, spawn, doorTilesOf(r, ['chicaneRuneDoor']));
    const hallB: TileXY = [45, 20];
    expect(west.has(tk(hallB)), 'hall central inaccessible sans la porte des runes').toBe(false);
    const open = reach(r, spawn, new Set(), () => false);
    expect(open.has(tk(exitTile)), 'sortie accessible porte et herse ouvertes').toBe(true);
    // le levier lointain est du côté de l'arrivée (hall central), le voisin de l'autre côté de la herse
    expect(glass).toBeDefined();
    if (!glass) return;
    const gx = glass.gate[0][0];
    expect(glass.levers[0][0]).toBeLessThan(gx);
    expect(glass.levers[1][0]).toBeGreaterThan(gx);
    expect(Math.hypot(glass.levers[0][0] - gx, glass.levers[0][1] - glass.gate[1][1])).toBeGreaterThanOrEqual(20);
    expect(Math.abs(glass.levers[1][0] - gx)).toBeLessThanOrEqual(9);
    expect(glass.gate).toHaveLength(3);
  });

  it('aucun ennemi dans le hall de sortie (derrière la herse) ; ennemis volants et tireurs seulement dans les halls', () => {
    for (const e of r.enemies) expect(e.tile[0], `${e.kind} [${e.tile}]`).toBeLessThan(59);
    const kinds = new Set(r.enemies.map((e) => e.kind));
    for (const k of ['wisp', 'archer', 'skeleton'] as EnemyKind[]) expect(kinds.has(k), k).toBe(true);
  });
});

describe('level8 — cabinet (statues jumelles + plaque gardée)', () => {
  const r = room('cabinet');

  it('une paire de statues ouvre la chambre ; une plaque gardée par des archers ouvre la sortie ; AUCUN bloc dans le niveau', () => {
    const pair = r.mechanisms.find((m) => m.type === 'statuePair');
    expect(pair && pair.type === 'statuePair' && pair.targetDir).toBe('up');
    const plate = r.mechanisms.find((m) => m.type === 'plate');
    expect(plate).toBeDefined();
    if (!plate || plate.type !== 'plate') return;
    const archers = r.enemies.filter((e) => e.kind === 'archer' && Math.hypot(e.tile[0] - plate.tile[0], e.tile[1] - plate.tile[1]) <= 14);
    expect(archers.length, 'archers autour de la plaque (à 4 joueurs)').toBeGreaterThanOrEqual(8);
    for (const lv of level8.rooms) {
      for (const m of lv.mechanisms) expect(m.type === 'block' || m.type === 'socket', `${lv.id}.${m.id} : aucun bloc`).toBe(false);
    }
  });

  it('la porte des statues est l\'unique lien vers la plaque, et la herse l\'unique lien vers la sortie', () => {
    const spawn = r.playerSpawns[0];
    const plate = r.mechanisms.find((m) => m.type === 'plate');
    if (!plate || plate.type !== 'plate') return;
    expect(reach(r, spawn, doorTilesOf(r, ['cabinetDoor'])).has(tk(plate.tile))).toBe(false);
    expect(reach(r, spawn, doorTilesOf(r, ['cabinetGate'])).has(tk([r.exit.rect.x, r.exit.rect.y]))).toBe(false);
    expect(reach(r, spawn, new Set()).has(tk([r.exit.rect.x, r.exit.rect.y]))).toBe(true);
  });

  it('socles des statues loin l\'un de l\'autre (il faut se coordonner)', () => {
    const pair = r.mechanisms.find((m) => m.type === 'statuePair');
    if (!pair || pair.type !== 'statuePair') return;
    const [a, b] = pair.statues;
    expect(Math.hypot(a.standTile[0] - b.standTile[0], a.standTile[1] - b.standTile[1])).toBeGreaterThanOrEqual(30);
  });
});

describe('level8 — fosses (abîmes, rempart, embuscade)', () => {
  const r = room('fosses');

  it('salle à abîmes : uniquement des ennemis TERRESTRES, aucun volant', () => {
    expect(r.layout.some((row) => row.includes('~'))).toBe(true);
    for (const e of r.enemies) expect(GROUND_ONLY, `${e.kind}`).toContain(e.kind);
  });

  it('l\'embuscade ne se contourne pas : leviers, rempart et sortie sont DANS la zone `siege`, qui englobe la sortie du passage', () => {
    const zones = new Map((r.zones ?? []).map((z) => [z.id, z.rect] as const));
    const siege = zones.get('siege');
    expect(siege).toBeDefined();
    if (!siege) return;
    const inSiege = (t: readonly [number, number]): boolean => t[0] >= siege.x && t[0] < siege.x + siege.w && t[1] >= siege.y && t[1] < siege.y + siege.h;
    for (const m of r.mechanisms) if (m.type === 'lever') expect(inSiege(m.tile), m.id).toBe(true);
    expect(inSiege([r.exit.rect.x, r.exit.rect.y])).toBe(true);
    const rampart = zones.get('rampart');
    expect(rampart && inSiege([rampart.x, rampart.y]) && inSiege([rampart.x + rampart.w - 1, rampart.y + rampart.h - 1])).toBe(true);
    // BFS (poterne ouverte) hors de la zone : aucun levier ni sortie atteignable sans entrer dans `siege`
    const seen = reach(r, r.playerSpawns[0], new Set(), (x, y) => inSiege([x, y]));
    for (const m of r.mechanisms) if (m.type === 'lever') expect(seen.has(tk(m.tile)), `${m.id} atteint sans déclencher l'embuscade`).toBe(false);
    expect(seen.has(tk([r.exit.rect.x, r.exit.rect.y]))).toBe(false);
  });

  it('chaque ennemi de l\'embuscade est dans la zone, à ≥ 6 tuiles de la sortie du passage ; ≥ 10 dès 1 joueur', () => {
    const siege = (r.zones ?? []).find((z) => z.id === 'siege')?.rect;
    if (!siege) return;
    const landing: TileXY = [53, 21];
    const ambush = r.enemies.filter((e) => e.when === 'enter:siege');
    expect(ambush.length).toBeGreaterThan(0);
    for (const e of ambush) {
      expect(e.tile[0] >= siege.x && e.tile[0] < siege.x + siege.w, `${e.kind} [${e.tile}] dans la zone`).toBe(true);
      expect(Math.hypot(e.tile[0] - landing[0], e.tile[1] - landing[1]), `${e.kind} [${e.tile}] trop près du passage`).toBeGreaterThanOrEqual(5.9);
    }
    expect(enemiesAt(r, 1).filter((e) => e.when === 'enter:siege').length).toBeGreaterThanOrEqual(10);
    for (const e of r.enemies) if (e.when !== undefined) expect(e.when).toBe('enter:siege');
  });

  it('plaque (poterne) sans minPlayers ; leviers de couleur à fenêtre, un levier seul au moins à 1 joueur', () => {
    const plate = r.mechanisms.find((m) => m.type === 'plate');
    expect(plate?.minPlayers).toBeUndefined();
    const levers = r.mechanisms.filter((m) => m.type === 'lever');
    expect(levers).toHaveLength(4);
    for (const l of levers) if (l.type === 'lever') expect(l.windowMs).toBeGreaterThan(0);
  });
});

describe('level8 — parvis et armurerie', () => {
  it('parvis : aucun ennemi volant, quatre plaques de couleur et une porte', () => {
    const r = room('parvis');
    for (const e of r.enemies) expect(FLYING, e.kind).not.toContain(e.kind);
    expect(r.mechanisms.filter((m) => m.type === 'plate')).toHaveLength(4);
    expect(r.mechanisms.filter((m) => m.type === 'door')).toHaveLength(1);
  });

  it('armurerie : un levier de base (sans propriétaire ni fenêtre) + 4 leviers de couleur à fenêtre ; la porte les exige tous', () => {
    const r = room('armurerie');
    const base = r.mechanisms.find((m) => m.id === 'armoryLeverBase');
    expect(base && base.type === 'lever' && base.ownerSlot === undefined && base.windowMs === undefined).toBe(true);
    const colored = r.mechanisms.filter((m) => m.type === 'lever' && m.ownerSlot !== undefined);
    expect(colored).toHaveLength(4);
    const door = r.mechanisms.find((m) => m.type === 'door');
    expect(door && door.type === 'door' && door.requires.length).toBe(5);
    const kinds = new Set(r.enemies.map((e) => e.kind));
    expect([...kinds].sort()).toEqual(['archer', 'skeleton', 'spider']);
    expect(r.decor?.filter((d) => d.type === 'crate').length).toBeGreaterThanOrEqual(6);
  });
});

// ───────────────────────────── Ennemis ─────────────────────────────

describe('level8 — ennemis', () => {
  it('nettement plus d\'ennemis que les niveaux 1 à 3 (planchers n=1 ≥ 170 et n=4 ≥ 295, ≥ +25 % du maximum)', () => {
    for (const n of [1, 4]) {
      const max = Math.max(totalEnemies(level1, n), totalEnemies(level2, n), totalEnemies(level3, n));
      const mine = totalEnemies(level8, n);
      expect(mine, `n=${n} : ${mine} ennemis vs max des niveaux 1-3 = ${max}`).toBeGreaterThanOrEqual(Math.ceil(max * 1.25));
    }
    expect(totalEnemies(level8, 1)).toBeGreaterThanOrEqual(170);
    expect(totalEnemies(level8, 4)).toBeGreaterThanOrEqual(295);
  });

  it('le nombre d\'ennemis ne dépend que du nombre de joueurs (minPlayers), croît avec lui ; n1/n4 dans ]0,5 ; 0,75[', () => {
    const counts = PLAYER_COUNTS.map((n) => totalEnemies(level8, n));
    for (let i = 1; i < counts.length; i++) expect(counts[i]).toBeGreaterThan(counts[i - 1]);
    expect(counts[0] / counts[3]).toBeGreaterThan(0.5);
    expect(counts[0] / counts[3]).toBeLessThan(0.75);
    for (const r of level8.rooms) {
      for (const e of r.enemies) {
        expect(Object.keys(e).every((k) => ['kind', 'tile', 'wave', 'when', 'minPlayers', 'tactics'].includes(k)), `${r.id} ${e.kind}`).toBe(true);
        if (e.minPlayers !== undefined) expect([2, 3, 4]).toContain(e.minPlayers);
      }
    }
  });

  it('aucun ennemi à moins de 12 tuiles de l\'arrivée des joueurs', () => {
    for (const r of level8.rooms) {
      for (const e of r.enemies) {
        for (const s of r.playerSpawns) {
          expect(Math.hypot(e.tile[0] - s[0], e.tile[1] - s[1]), `${r.id} ${e.kind} [${e.tile}] vs spawn [${s}]`).toBeGreaterThanOrEqual(12);
        }
      }
    }
  });

  it('chaque tuile d\'apparition est du sol libre, sans doublon', () => {
    for (const r of level8.rooms) {
      const seen = new Set<string>();
      for (const e of r.enemies) {
        expect(isFloor(r, e.tile[0], e.tile[1]), `${r.id} ${e.kind} [${e.tile}]`).toBe(true);
        expect(seen.has(tk(e.tile)), `${r.id} doublon [${e.tile}]`).toBe(false);
        seen.add(tk(e.tile));
      }
    }
  });
});

// ───────────────────────────── Demi-boss et boss ─────────────────────────────

describe('level8 — demi-boss et boss de fin', () => {
  it('demi-boss : gardien (veilleurs) puis pyromancien (vigie), présents à tous les nombres de joueurs, sortie sur `clear`', () => {
    const where = level8.rooms.filter((r) => r.enemies.some((e) => isMiniBossKind(e.kind)));
    expect(where.map((r) => r.id)).toEqual(['veilleurs', 'vigie']);
    expect(where.map((r) => r.enemies.find((e) => isMiniBossKind(e.kind))?.kind)).toEqual(['warden', 'pyromancer']);
    for (const r of where) {
      expect(r.enemies.filter((e) => isMiniBossKind(e.kind))).toHaveLength(1);
      expect(r.enemies.find((e) => isMiniBossKind(e.kind))?.minPlayers).toBeUndefined();
      expect(r.exit.requires).toContain('clear');
    }
  });

  it('sbires à paliers EXPLICITES : veilleurs 14/20/25/30, vigie 16/22/28/33, conseil 14/19/23/27', () => {
    const minions = (id: string): number[] => PLAYER_COUNTS.map((n) => enemiesAt(room(id), n).filter((e) => !isAnyBossKind(e.kind)).length);
    expect(minions('veilleurs')).toEqual([14, 20, 25, 30]);
    expect(minions('vigie')).toEqual([16, 22, 28, 33]);
    expect(minions('conseil')).toEqual([14, 19, 23, 27]);
    expect(enemiesAt(room('vigie'), 1).length).toBeGreaterThan(enemiesAt(room('veilleurs'), 1).length);
  });

  it('salle finale : seigneur de la forge présent à tous les n, arène pure, seule salle avec un boss de fin', () => {
    const last = level8.rooms[level8.rooms.length - 1];
    const bosses = last.enemies.filter((e) => isBossKind(e.kind));
    expect(bosses).toHaveLength(1);
    expect(bosses[0].kind).toBe('forgelord');
    expect(bosses[0].minPlayers).toBeUndefined();
    expect(last.mechanisms).toHaveLength(0);
    expect(last.layout.some((row) => row.includes('~'))).toBe(false);
    expect(level8.rooms.slice(0, -1).some((r) => r.enemies.some((e) => isBossKind(e.kind)))).toBe(false);
  });
});

// ───────────────────────────── Coopération adaptative ─────────────────────────────

describe('level8 — coop adaptative (1 à 4 joueurs)', () => {
  it('plaques de couleur et leviers de couleur : minPlayers = slot + 1', () => {
    for (const r of level8.rooms) {
      for (const m of r.mechanisms) {
        let slot: number | undefined;
        if (m.type === 'plate') slot = m.colorSlot;
        else if (m.type === 'lever' || m.type === 'key') slot = m.ownerSlot;
        if (slot === undefined) continue;
        expect(m.minPlayers ?? 1, `${r.id}.${m.id}`).toBe(slot + 1);
      }
    }
  });

  it('chaque salle ordinaire a un mécanisme coopératif présent dès 1 joueur', () => {
    const coop = new Set(['plate', 'lever', 'key', 'block', 'runePuzzle', 'brazier', 'statuePair', 'hourglass', 'lightBridge']);
    for (const r of level8.rooms) {
      if (r.mechanisms.length === 0) continue;
      expect(r.mechanisms.some((m: MechanismDef) => coop.has(m.type) && (m.minPlayers ?? 1) <= 1), r.id).toBe(true);
    }
  });

  it('les consignes citent la bonne couleur de slot (objectifs, runes, rempart, statues)', () => {
    const fr = getDictionary('fr');
    const en = getDictionary('en');
    for (const o of level8.objectives) {
      expect(fr[o.labelKey], o.id).toContain(`Héros ${COLOR_FR[o.slot]}`);
      expect(en[o.labelKey], o.id).toContain(`${COLOR_EN[o.slot][0].toUpperCase()}${COLOR_EN[o.slot].slice(1)} hero`);
    }
    expect(fr['sign.level8.chicane.screen']).toMatch(/rouge/);
    expect(en['sign.level8.chicane.screen']).toMatch(/red/);
    expect(fr['sign.level8.fosses.rampart']).toMatch(/vert/);
    expect(en['sign.level8.fosses.rampart']).toMatch(/green/);
    expect(fr['sign.level8.cabinet.sockets']).toMatch(/jaune/);
    expect(fr['sign.level8.armurerie.arsenal']).toMatch(/rouge/);
    // cohérence avec les données
    const runes = room('chicane').mechanisms.find((m) => m.type === 'runePuzzle');
    expect(runes && runes.type === 'runePuzzle' && runes.visibleToSlot).toBe(1);
    expect(level8.objectives.find((o) => o.id === 'rampart')?.slot).toBe(2);
    expect(level8.objectives.find((o) => o.id === 'plans')?.slot).toBe(3);
  });
});

// ───────────────────────────── i18n ─────────────────────────────

describe('level8 — textes (parts i18n)', () => {
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
    const required = new Set(collectRequiredI18nKeys(level8, { checkSpeakers: true }).map((r) => r.key));
    const own = new Set([...required].filter((k) => !k.startsWith('speaker.')));
    expect(new Set(Object.keys(fr))).toEqual(own);
    for (const k of required) {
      expect(Object.prototype.hasOwnProperty.call(getDictionary('en'), k), `en ${k}`).toBe(true);
      expect(base[k], k).toBeTruthy();
    }
  });

  it('clés bien formées, préfixées par la convention de DESIGN.md §6 (aucun nouvel orateur)', () => {
    const prefixes = ['level.level8.', 'room.level8.', 'objective.level8.', 'mech.level8.', 'sign.level8.', 'hintroom.level8.'];
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

  it('histoire : intro de 3 à 5 répliques, outro de 2 à 4, orateurs autorisés, clés numérotées', () => {
    expect(level8.intro.length).toBeGreaterThanOrEqual(3);
    expect(level8.intro.length).toBeLessThanOrEqual(5);
    expect(level8.outro.length).toBeGreaterThanOrEqual(2);
    expect(level8.outro.length).toBeLessThanOrEqual(4);
    for (const l of [...level8.intro, ...level8.outro]) expect(ALLOWED_SPEAKERS).toContain(l.speaker);
    level8.intro.forEach((l, i) => expect(l.textKey).toBe(`level.level8.intro.${i + 1}`));
    level8.outro.forEach((l, i) => expect(l.textKey).toBe(`level.level8.outro.${i + 1}`));
  });

  it('le niveau ne conclut pas la saga : l\'outro annonce le dernier clocher', () => {
    expect(fr['level.level8.outro.1']).toMatch(/clocher/);
    expect(en['level.level8.outro.1']).toMatch(/belfry/);
  });
});

// ───────────────────────────── Déterminisme des données ─────────────────────────────

describe('level8 — données déterministes', () => {
  it('les spawns sont sur le sol et aucun mécanisme n\'est un doublon d\'id dans une salle', () => {
    for (const r of level8.rooms) {
      const ids = r.mechanisms.map((m: MechanismDef) => m.id);
      expect(new Set(ids).size, r.id).toBe(ids.length);
      for (const [x, y] of r.playerSpawns) expect(isFloor(r, x, y), `${r.id} spawn [${x},${y}]`).toBe(true);
    }
  });
});
