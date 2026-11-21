/**
 * Niveau 7 (« Le Carillon Englouti ») — tests de données : validation, structure, objectifs, signatures coopératives (« Phare et Écho »,
 * « Chœur »), ennemis, demi-boss et boss, coop adaptative, textes. La preuve par la simulation (bots) est dans `level7.run.test.ts`.
 * L'enregistrement dans `LEVELS` / `getLevel` relève de l'étape d'intégration.
 */
import { describe, expect, it } from 'vitest';

import { SIM_STEP_MS, TILE } from '../core/constants';
import { RoomGrid } from '../core/grid';
import { isAnyBossKind, isBossKind, isMiniBossKind } from '../core/enemies';
import { collectRequiredI18nKeys, validateBossStructure, validateLevel } from '../core/levelValidation';
import { createRoomMechanisms, effectiveLeverWindowMs, isMechanismSolved, tileCenterPx, updateMechanisms } from '../core/mechanisms';
import { createPlayerState } from '../core/players';
import { resolveSlot } from '../core/slots';
import type {
  EnemyKind,
  EnemySpawnDef,
  LeverDef,
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
import { level1 } from './level1';
import { level2 } from './level2';
import { level3 } from './level3';
import { level7 } from './level7';

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
const FLYING: readonly EnemyKind[] = ['bat', 'wisp', 'wraith', 'morvane', 'voidlord'];

function room(id: string): RoomDef {
  const r = level7.rooms.find((x) => x.id === id);
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

/** Composantes connexes de sol HORS tuiles de pont ET hors tuiles de porte : clé de tuile → numéro de composante. */
function components(r: RoomDef, opts: { cutDoors?: boolean } = {}): Map<string, number> {
  const blocked = new Set<string>();
  for (const b of bridgesOf(r)) for (const t of b.tiles) blocked.add(tk(t));
  if (opts.cutDoors) for (const m of r.mechanisms) if (m.type === 'door') for (const t of m.tiles) blocked.add(tk(t));
  const comp = new Map<string, number>();
  let next = 0;
  for (let y = 0; y < r.layout.length; y++) {
    for (let x = 0; x < r.layout[0].length; x++) {
      if (!isFloor(r, x, y) || blocked.has(`${x},${y}`) || comp.has(`${x},${y}`)) continue;
      const id = next++;
      const queue: TileXY[] = [[x, y]];
      comp.set(`${x},${y}`, id);
      for (let i = 0; i < queue.length; i++) {
        const [cx, cy] = queue[i];
        for (const [dx, dy] of DIRS4) {
          const nx = cx + dx;
          const ny = cy + dy;
          const k = `${nx},${ny}`;
          if (!isFloor(r, nx, ny) || blocked.has(k) || comp.has(k)) continue;
          comp.set(k, id);
          queue.push([nx, ny]);
        }
      }
    }
  }
  return comp;
}

function neighbourComponent(r: RoomDef, comp: Map<string, number>, t: TileXY): number {
  for (const [dx, dy] of DIRS4) {
    const c = comp.get(`${t[0] + dx},${t[1] + dy}`);
    if (c !== undefined) return c;
  }
  return -1;
}

function readPart(lang: 'fr' | 'en'): Record<string, string> {
  return Object.fromEntries(Object.entries(getDictionary(lang)).filter(([k]) => k.includes('level7')));
}

function placeholders(value: string): string[] {
  return Array.from(new Set(Array.from(value.matchAll(/\{(\w+)\}/g), (m) => m[1]))).sort();
}

function mech<T extends MechanismDef['type']>(r: RoomDef, id: string, type: T): Extract<MechanismDef, { type: T }> {
  const m = r.mechanisms.find((x) => x.id === id);
  if (!m || m.type !== type) throw new Error(`mécanisme ${type} « ${id} » introuvable dans ${r.id}`);
  return m as Extract<MechanismDef, { type: T }>;
}

// ───────────────────────────── Validité globale ─────────────────────────────

describe('level7 — validation', () => {
  it('validateLevel (dictionnaires fr + en, orateurs) ne retourne aucune erreur (1, 2, 3 et 4 joueurs)', () => {
    const errors = validateLevel(level7, { dictionaries: { fr: getDictionary('fr'), en: getDictionary('en') }, checkSpeakers: true });
    expect(errors).toEqual([]);
  });

  it('validateBossStructure : au moins 2 demi-boss à tous les nombres de joueurs, salle finale avec boss', () => {
    expect(validateBossStructure(level7, { minMiniBosses: 2 })).toEqual([]);
  });

  it('identité du niveau : id, thème tide partout, nom fr/en, durée estimée', () => {
    expect(level7.id).toBe('level7');
    expect(level7.theme).toBe('tide');
    expect(level7.nameKey).toBe('level.level7.name');
    expect(getDictionary('fr')['level.level7.name']).toBe('Le Carillon Englouti');
    expect(getDictionary('en')['level.level7.name']).toBe('The Drowned Chime');
    expect(level7.estimatedMinutes).toBeGreaterThanOrEqual(5);
    expect(level7.estimatedMinutes).toBeLessThanOrEqual(10);
    for (const r of level7.rooms) expect(r.theme, r.id).toBe('tide');
  });

  it("compte 8 salles, dans l'ordre prévu", () => {
    expect(level7.rooms.map((r) => r.id)).toEqual(['shoal', 'pearlcave', 'dyke', 'mirrorpools', 'sluice', 'choir', 'stormdeck', 'glassheart']);
  });

  it('chaque salle est vaste (54..86 × 40..52 tuiles), avec 4 spawns groupés, un indice, ≥ 2 panneaux et un décor', () => {
    for (const r of level7.rooms) {
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
      expect(r.nameKey, r.id).toBe(`room.level7.${r.id}.name`);
      expect(r.introHintKey, r.id).toBe(`hintroom.level7.${r.id}`);
      expect((r.signs ?? []).length, `${r.id} panneaux`).toBeGreaterThanOrEqual(2);
      expect((r.decor ?? []).length, `${r.id} décors`).toBeGreaterThan(0);
    }
  });

  it('les tuiles de porte forment un passage du sol dans la grille (4 tuiles)', () => {
    for (const r of level7.rooms) {
      const grid = new RoomGrid(r.layout);
      for (const m of r.mechanisms) {
        if (m.type !== 'door') continue;
        expect(m.tiles.length, `${r.id}.${m.id}`).toBe(4);
        for (const [x, y] of m.tiles) expect(grid.blocksMovement(x, y), `${r.id}.${m.id} [${x},${y}]`).toBe(false);
      }
    }
  });

  it('est sérialisable en JSON sans perte (aucune fonction, aucune classe)', () => {
    expect(JSON.parse(JSON.stringify(level7))).toEqual(level7);
  });

  it("n'utilise aucune tactique de boss (`tactics`, réservées au niveau 8)", () => {
    for (const r of level7.rooms) for (const e of r.enemies) expect('tactics' in e, `${r.id} ${e.kind}`).toBe(false);
  });
});

// ───────────────────────────── Objectifs ─────────────────────────────

describe('level7 — objectifs personnels', () => {
  it('un objectif par slot 0..3, de types variés, répartis sur au moins 3 salles', () => {
    expect(level7.objectives.map((o) => o.slot).sort()).toEqual([0, 1, 2, 3]);
    expect(new Set(level7.objectives.map((o) => o.kind)).size).toBeGreaterThanOrEqual(3);
    expect(new Set(level7.objectives.map((o) => o.roomId)).size).toBeGreaterThanOrEqual(3);
    expect(level7.objectives.find((o) => o.id === 'chime')).toMatchObject({ slot: 0, kind: 'mechanism', roomId: 'choir', mechanismId: 'choirDoor' });
    expect(level7.objectives.find((o) => o.id === 'pearl')).toMatchObject({ slot: 1, kind: 'zone', roomId: 'pearlcave', zoneId: 'pearlZone', seconds: 20 });
    expect(level7.objectives.find((o) => o.id === 'bones')).toMatchObject({ slot: 2, kind: 'kills', roomId: 'shoal', count: 3, enemyKind: 'skeleton' });
    expect(level7.objectives.find((o) => o.id === 'echo')).toMatchObject({ slot: 3, kind: 'mechanism', roomId: 'mirrorpools', mechanismId: 'mirrorRunes' });
  });

  it("les salles porteuses d'objectifs ne se quittent qu'une fois ceux-ci accomplis", () => {
    expect(room('pearlcave').exit.requires).toContain('obj:pearl');
    const choirDoor = mech(room('choir'), 'choirDoor', 'door');
    expect(choirDoor.requires).toEqual(COLOR_EN.map((_, i) => `choirLever${['Blue', 'Red', 'Green', 'Yellow'][i]}`));
    expect(room('choir').exit.requires).toContain('choirDoor');
    expect(mech(room('mirrorpools'), 'mirrorDoor', 'door').requires).toEqual(['mirrorRunes']);
    expect(room('mirrorpools').exit.requires).toContain('mirrorDoor');
    expect(room('shoal').exit.requires).toContain('clear');
    // la sortie finale exige les quatre objectifs et AUCUNE exigence `zone:` (sémantique non prouvée en jeu)
    const last = level7.rooms[level7.rooms.length - 1];
    expect(last.exit.requires).toEqual(['clear', 'obj:chime', 'obj:pearl', 'obj:bones', 'obj:echo']);
    for (const r of level7.rooms) expect(r.exit.requires.some((q) => q.startsWith('zone:')), r.id).toBe(false);
  });
});

// ───────────────────────────── Salle 1 : plaques de couleur ─────────────────────────────

describe('level7 — Hauts-Fonds (plaques de couleur, bassins)', () => {
  it('quatre plaques de couleur (minPlayers = slot + 1) autour de la porte, abîmes, aucun volant', () => {
    const r = room('shoal');
    const plates = r.mechanisms.filter((m) => m.type === 'plate');
    expect(plates).toHaveLength(4);
    expect(plates.map((m) => (m.type === 'plate' ? m.colorSlot : -1))).toEqual([0, 1, 2, 3]);
    const door = mech(r, 'shoalDoor', 'door');
    expect(door.requires).toHaveLength(4);
    expect(r.layout.some((row) => row.includes('~'))).toBe(true);
    for (const e of r.enemies) expect(FLYING, `${e.kind}`).not.toContain(e.kind);
    // l'objectif « bones » : au moins 3 squelettes dès 1 joueur
    expect(enemiesAt(r, 1).filter((e) => e.kind === 'skeleton').length).toBeGreaterThanOrEqual(3);
  });
});

// ───────────────────────────── Salle 2 : salle sombre, braseros, perle ─────────────────────────────

describe('level7 — Grotte des Perles (salle sombre, braseros de couleur, veille)', () => {
  const r = room('pearlcave');

  it('salle sombre : un brasero neutre allumé de référence, quatre braseros de couleur ÉTEINTS ouvrant une porte ; la sortie ne cite aucun brasero', () => {
    expect(r.dark).toBe(true);
    const braziers = r.mechanisms.filter((m) => m.type === 'brazier');
    const lit = braziers.filter((m) => m.type === 'brazier' && m.lit === true && m.ownerSlot === undefined);
    expect(lit.length).toBeGreaterThanOrEqual(1);
    const colored = braziers.filter((m) => m.type === 'brazier' && m.ownerSlot !== undefined);
    expect(colored).toHaveLength(4);
    for (const m of colored) expect(m.type === 'brazier' && m.lit !== true, m.id).toBe(true);
    const door = mech(r, 'pearlDoor', 'door');
    expect(door.requires.sort()).toEqual(colored.map((m) => m.id).sort());
    const ids = new Set(braziers.map((m) => m.id));
    for (const q of r.exit.requires) expect(ids.has(q), `exit.requires cite le brasero ${q}`).toBe(false);
  });

  it('les quatre braseros de couleur sont AUX QUATRE COINS documentés (bleu [15,10], rouge [40,10], vert [15,35], jaune [40,35]) et celui devant la porte à [47,22]', () => {
    const at = (id: string): TileXY | undefined => {
      const m = r.mechanisms.find((x) => x.id === id);
      return m && m.type === 'brazier' ? m.tile : undefined;
    };
    expect(at('pearlBrazierBlue')).toEqual([15, 10]);
    expect(at('pearlBrazierRed')).toEqual([40, 10]);
    expect(at('pearlBrazierGreen')).toEqual([15, 35]);
    expect(at('pearlBrazierYellow')).toEqual([40, 35]);
    expect(at('pearlFire6')).toEqual([47, 22]);
  });

  it('la perle : zone de veille de 20 s exigée par la sortie (objectif du héros rouge), au centre de la grotte', () => {
    const o = level7.objectives.find((x) => x.id === 'pearl');
    expect(o?.slot).toBe(1);
    expect(o?.zoneId).toBe('pearlZone');
    const z = (r.zones ?? []).find((x) => x.id === 'pearlZone');
    expect(z).toBeDefined();
    expect(r.exit.requires).toEqual(expect.arrayContaining(['pearlDoor', 'obj:pearl', 'clear']));
    // la perle est éclairée : un brasero allumé à ≤ 8 tuiles de son centre
    const cx = (z?.rect.x ?? 0) + (z?.rect.w ?? 0) / 2;
    const cy = (z?.rect.y ?? 0) + (z?.rect.h ?? 0) / 2;
    const near = r.mechanisms.some((m) => m.type === 'brazier' && m.lit === true && Math.hypot(m.tile[0] - cx, m.tile[1] - cy) <= 8);
    expect(near).toBe(true);
  });

  it('libellés de braseros : « allumé » commence par le libellé « éteint » sans sa parenthèse, verbes fr/en de recharge', () => {
    const fr = getDictionary('fr');
    const en = getDictionary('en');
    for (const m of r.mechanisms) {
      if (m.type !== 'brazier' || m.lit === true) continue;
      const stem = (s: string): string => s.replace(/\s*\(.*\)\s*$/, '').trim();
      expect(fr[m.litLabelKey as string].startsWith(stem(fr[m.labelKey as string])), m.id).toBe(true);
      expect(fr[m.litLabelKey as string]).toMatch(/recharge/);
      expect(en[m.litLabelKey as string]).toMatch(/refuel/);
    }
  });
});

// ───────────────────────────── Salle 4 : « Phare et Écho » ─────────────────────────────

describe('level7 — Bassins-Miroirs : « Phare et Écho » (information asymétrique + lanterne)', () => {
  const r = room('mirrorpools');
  const runes = mech(r, 'mirrorRunes', 'runePuzzle');
  const bridge = mech(r, 'mirrorBridge', 'lightBridge');

  it('la séquence (≥ 3 symboles) n\'est visible que par le héros rouge (slot 1) ; le porteur de la lanterne est le héros bleu (slot 0)', () => {
    expect(runes.visibleToSlot).toBe(1);
    expect(runes.sequence.length).toBeGreaterThanOrEqual(3);
    expect(bridge.lanternSlot).toBe(0);
    expect(bridge.radiusTiles).toBeGreaterThanOrEqual(2.5);
    expect(bridge.tiles.length).toBeGreaterThanOrEqual(8);
    // plus de piédestaux que de symboles joués (un leurre)
    expect(runes.pedestals.length).toBeGreaterThan(runes.sequence.length);
  });

  it("le pont est INDISPENSABLE : l'écran des runes et le départ sont sur la rive ouest, tous les piédestaux sur une île sans autre accès", () => {
    const comp = components(r);
    const spawnComp = comp.get(tk(r.playerSpawns[0])) as number;
    expect(comp.get(tk(runes.displayTile))).toBe(spawnComp);
    const from = neighbourComponent(r, comp, bridge.tiles[0]);
    const to = neighbourComponent(r, comp, bridge.tiles[bridge.tiles.length - 1]);
    expect(from).toBe(spawnComp);
    expect(to).not.toBe(spawnComp);
    for (const p of runes.pedestals) expect(comp.get(tk(p.tile)), `piédestal ${p.symbol}`).toBe(to);
    // pont d'une tuile de large, route continue
    bridge.tiles.forEach((t, i) => {
      expect(isFloor(r, t[0], t[1])).toBe(true);
      if (i > 0) expect(Math.abs(t[0] - bridge.tiles[i - 1][0]) + Math.abs(t[1] - bridge.tiles[i - 1][1])).toBe(1);
      if (i > 0 && i < bridge.tiles.length - 1) {
        const set = new Set(bridge.tiles.map(tk));
        const fl = DIRS4.filter(([dx, dy]) => isFloor(r, t[0] + dx, t[1] + dy));
        expect(fl.length, `tuile ${i}`).toBe(2);
        for (const [dx, dy] of fl) expect(set.has(`${t[0] + dx},${t[1] + dy}`)).toBe(true);
      }
    });
  });

  it('l\'écran et les piédestaux sont trop éloignés pour être vus ensemble (≥ 30 tuiles)', () => {
    for (const p of runes.pedestals) {
      expect(Math.hypot(p.tile[0] - runes.displayTile[0], p.tile[1] - runes.displayTile[1]), p.symbol).toBeGreaterThanOrEqual(30);
    }
  });

  it("aucun ennemi n'attaque pendant la traversée : rive ouest nettoyable avant, île et rive est en embuscade ≥ 6 tuiles de l'atterrissage", () => {
    const comp = components(r);
    const spawnComp = comp.get(tk(r.playerSpawns[0])) as number;
    const landing = bridge.tiles[bridge.tiles.length - 1];
    const zones = new Map((r.zones ?? []).map((z) => [z.id, z.rect] as const));
    const islandComp = neighbourComponent(r, comp, landing);
    for (const e of r.enemies) {
      const c = comp.get(tk(e.tile));
      expect(c, `${e.kind} [${e.tile}] sur une rive`).toBeDefined();
      if (c === spawnComp) {
        expect(e.when, `${e.kind} [${e.tile}] : rive de départ, présent d'emblée`).toBeUndefined();
        continue;
      }
      expect(e.when, `${e.kind} [${e.tile}] : rive d'arrivée en embuscade`).toMatch(/^enter:/);
      expect(zones.has((e.when as string).slice(6))).toBe(true);
      if (c === islandComp) {
        expect(Math.hypot(e.tile[0] - landing[0], e.tile[1] - landing[1]), `${e.kind} [${e.tile}] trop près de l'atterrissage`).toBeGreaterThanOrEqual(5.9);
      }
    }
    // les zones d'embuscade de l'île restent à ≥ 6 tuiles de l'atterrissage
    const iz = zones.get('islandZone') as { x: number; y: number; w: number; h: number };
    for (let y = iz.y; y < iz.y + iz.h; y++) {
      for (let x = iz.x; x < iz.x + iz.w; x++) {
        if (!isFloor(r, x, y)) continue;
        expect(Math.hypot(x - landing[0], y - landing[1]), `zone île [${x},${y}]`).toBeGreaterThanOrEqual(5.9);
      }
    }
  });

  it("aucune embuscade ne se contourne : sans entrer dans la zone de l'île on n'atteint ni un piédestal ni la porte ; sans entrer dans la zone est on n'atteint pas la sortie", () => {
    const comp = components(r);
    const landing = bridge.tiles[bridge.tiles.length - 1];
    const islandComp = neighbourComponent(r, comp, landing);
    const zones = new Map((r.zones ?? []).map((z) => [z.id, z.rect] as const));
    const inRect = (rc: { x: number; y: number; w: number; h: number }, x: number, y: number): boolean => x >= rc.x && x < rc.x + rc.w && y >= rc.y && y < rc.y + rc.h;
    const NEIGH8 = [...DIRS4, [1, 1], [1, -1], [-1, 1], [-1, -1]] as const;
    const reach = (startKeys: string[], hidden: (x: number, y: number) => boolean): Set<string> => {
      const seen = new Set<string>(startKeys);
      const queue: TileXY[] = startKeys.map((k) => k.split(',').map(Number) as TileXY);
      for (let i = 0; i < queue.length; i++) {
        for (const [dx, dy] of NEIGH8) {
          const x = queue[i][0] + dx;
          const y = queue[i][1] + dy;
          const k = `${x},${y}`;
          if (!isFloor(r, x, y) || seen.has(k) || !hidden(x, y)) continue;
          seen.add(k);
          queue.push([x, y]);
        }
      }
      return seen;
    };
    // île : depuis l'atterrissage, sans entrer dans la zone, on n'atteint aucun piédestal, ni la porte, ni la sortie
    const iz = zones.get('islandZone') as { x: number; y: number; w: number; h: number };
    const fromLanding = DIRS4.map(([dx, dy]) => `${landing[0] + dx},${landing[1] + dy}`).filter((k) => {
      const [x, y] = k.split(',').map(Number);
      return comp.get(k) === islandComp && !inRect(iz, x, y);
    });
    const seen = reach(fromLanding, (x, y) => !inRect(iz, x, y));
    for (const p of runes.pedestals) expect(seen.has(tk(p.tile)), `piédestal ${p.symbol} atteignable sans déclencher l'embuscade`).toBe(false);
    const door = mech(r, 'mirrorDoor', 'door');
    for (const t of door.tiles) expect(seen.has(tk(t))).toBe(false);
    for (let y = r.exit.rect.y; y < r.exit.rect.y + r.exit.rect.h; y++) for (let x = r.exit.rect.x; x < r.exit.rect.x + r.exit.rect.w; x++) expect(seen.has(`${x},${y}`)).toBe(false);
    // rive est : la sortie est entièrement DANS la zone est
    const ez = zones.get('eastZone') as { x: number; y: number; w: number; h: number };
    for (let y = r.exit.rect.y; y < r.exit.rect.y + r.exit.rect.h; y++) for (let x = r.exit.rect.x; x < r.exit.rect.x + r.exit.rect.w; x++) if (isFloor(r, x, y)) expect(inRect(ez, x, y)).toBe(true);
    // et l'île est en deux parties : la porte ferme l'accès à la rive est sans les runes
    const noDoor = components(r, { cutDoors: true });
    const exitTile: TileXY = [r.exit.rect.x, r.exit.rect.y];
    expect(noDoor.get(tk(exitTile))).not.toBe(noDoor.get(tk(r.playerSpawns[0])));
  });

  it("jeu à 1..4 joueurs : le voyant (slot 1) est un autre joueur que le porteur dès 2 joueurs ; en solo c'est le même (énigme de mémoire)", () => {
    for (const n of PLAYER_COUNTS) {
      const seer = resolveSlot(runes.visibleToSlot, n);
      const bearer = resolveSlot(bridge.lanternSlot, n);
      if (n === 1) expect(seer).toBe(bearer);
      else expect(seer).not.toBe(bearer);
    }
  });

  for (const n of PLAYER_COUNTS) {
    it(`à ${n} joueur(s), le pont est éclairé par le joueur lanternSlot % n, dans son halo seulement`, () => {
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
        return mechanisms.find((m) => m.id === bridge.id) as LightBridgeState;
      };
      let st = step();
      const bearerId = resolveSlot(bridge.lanternSlot, n);
      expect(st.bearerId).toBe(bearerId);
      expect(st.lit.every((v) => !v)).toBe(true);
      players[bearerId].pos = { ...tileCenterPx(bridge.tiles[0]) };
      st = step();
      expect(st.lit[0]).toBe(true);
      const far = bridge.tiles.findIndex((t) => Math.hypot(t[0] - bridge.tiles[0][0], t[1] - bridge.tiles[0][1]) * TILE > bridge.radiusTiles * TILE + 1);
      expect(far).toBeGreaterThan(0);
      expect(st.lit[far]).toBe(false);
      expect(isMechanismSolved(st)).toBe(true);
    });
  }

  it("un joueur À TERRE sur une tuile du pont, loin du halo du porteur, la garde allumée (jamais éjecté au-dessus de l'abîme) ; relevé, la tuile s'éteint à nouveau", () => {
    const grid = new RoomGrid(r.layout);
    const players: PlayerState[] = [0, 1].map((i) => createPlayerState({ id: i as PlayerId, characterId: 'david', difficulty: 2 }, tileCenterPx(r.playerSpawns[i])));
    const mechanisms = createRoomMechanisms(r, 2);
    const step = (): LightBridgeState => {
      updateMechanisms({ room: r, grid, mechanisms, players, frames: {}, interactPressed: {}, dtMs: SIM_STEP_MS, aliveEnemyCount: 0, objectiveDone: () => false, zoneOccupied: () => false });
      return mechanisms.find((m) => m.id === bridge.id) as LightBridgeState;
    };
    const bearerId = resolveSlot(bridge.lanternSlot, 2);
    const otherId = 1 - bearerId;
    const far = bridge.tiles.findIndex((t) => Math.hypot(t[0] - bridge.tiles[0][0], t[1] - bridge.tiles[0][1]) * TILE > bridge.radiusTiles * TILE + 1);
    expect(far).toBeGreaterThan(0);
    players[bearerId].pos = { ...tileCenterPx(bridge.tiles[0]) };
    players[otherId].pos = { ...tileCenterPx(bridge.tiles[far]) };
    expect(step().lit[far]).toBe(true); // vivant : occupation
    players[otherId].status = 'down';
    players[otherId].hp = 0;
    expect(step().lit[far], 'à terre : la tuile reste allumée').toBe(true);
    players[otherId].status = 'alive';
    players[otherId].hp = players[otherId].maxHp;
    players[otherId].pos = { x: players[otherId].pos.x, y: players[otherId].pos.y - TILE * 3 };
    expect(step().lit[far], 'plus personne dessus : éteinte').toBe(false);
  });
});

// ───────────────────────────── Salle 5 : l'écluse (bloc) ─────────────────────────────

describe("level7 — Écluse (bloc 2×2, couloir fermé, deux plaques)", () => {
  const r = room('sluice');

  it('le bloc est dans un couloir de 2 tuiles de large fermé sur les côtés et au fond, le socle tout au fond (30 tuiles de poussée)', () => {
    const block = mech(r, 'sluiceBlock', 'block');
    const socket = mech(r, 'sluiceSocket', 'socket');
    expect(socket.blockId).toBe('sluiceBlock');
    expect(socket.tile[0] - block.tile[0]).toBe(30);
    expect(socket.tile[1]).toBe(block.tile[1]);
    for (let x = block.tile[0]; x <= socket.tile[0] + 1; x++) {
      for (const y of [block.tile[1], block.tile[1] + 1]) expect(isFloor(r, x, y), `couloir [${x},${y}]`).toBe(true);
      expect(isFloor(r, x, block.tile[1] - 1), `mur nord [${x}]`).toBe(false);
      expect(isFloor(r, x, block.tile[1] + 2), `mur sud [${x}]`).toBe(false);
    }
    expect(isFloor(r, socket.tile[0] + 2, block.tile[1])).toBe(false); // fond muré
  });

  it('deux plaques : la pompe (sans minPlayers) et la marée (dès 2 joueurs), à tenir avec le socle rempli pour ouvrir la porte ; abîmes, ennemis terrestres', () => {
    const pump = mech(r, 'sluicePlatePump', 'plate');
    const tide = mech(r, 'sluicePlateTide', 'plate');
    expect(pump.minPlayers).toBeUndefined();
    expect(tide.minPlayers).toBe(2);
    expect(mech(r, 'sluiceDoor', 'door').requires.sort()).toEqual(['sluicePlatePump', 'sluicePlateTide', 'sluiceSocket']);
    expect(r.layout.some((row) => row.includes('~'))).toBe(true);
    for (const e of r.enemies) expect(FLYING, e.kind).not.toContain(e.kind);
  });
});

// ───────────────────────────── Salle 6 : « Chœur » ─────────────────────────────

describe('level7 — Chœur de Nacre : « Chœur » (quatre leviers à fenêtre, trois vagues)', () => {
  const r = room('choir');
  const levers = r.mechanisms.filter((m): m is LeverDef => m.type === 'lever');

  it('quatre leviers de couleur à fenêtre (ownerSlot 0..3, minPlayers = slot + 1, le bleu est la base) aux coins d\'un anneau, ≈ 10 tuiles d\'écart', () => {
    expect(levers.map((l) => l.ownerSlot)).toEqual([0, 1, 2, 3]);
    expect(levers[0].minPlayers).toBeUndefined();
    levers.forEach((l, i) => {
      if (i > 0) expect(l.minPlayers).toBe(i + 1);
      expect(l.windowMs ?? 0).toBeGreaterThan(0);
    });
    const [b, rd, g, y] = levers.map((l) => l.tile);
    expect(Math.abs(rd[0] - b[0])).toBeGreaterThanOrEqual(9);
    expect(Math.abs(rd[0] - b[0])).toBeLessThanOrEqual(12);
    expect(Math.abs(g[1] - b[1])).toBeGreaterThanOrEqual(9);
    expect(Math.abs(g[1] - b[1])).toBeLessThanOrEqual(12);
    expect(y[0]).toBe(rd[0]);
    expect(y[1]).toBe(g[1]);
    const door = mech(r, 'choirDoor', 'door');
    expect(door.requires).toEqual(levers.map((l) => l.id));
  });

  it('fenêtre de levier dimensionnée : ≥ 1,6 × le temps du plus long trajet entre deux leviers + 3 s, à tous les nombres de joueurs', () => {
    const speed = 68; // px/s du héros le plus lent (David)
    // trajet entre deux leviers voisins de l'anneau (détours de piliers : × 1,4)
    const travel = (a: TileXY, b: TileXY): number => (Math.hypot(a[0] - b[0], a[1] - b[1]) * TILE * 1.4) / speed;
    const t = levers.map((l) => l.tile);
    const adjacent = Math.max(travel(t[0], t[1]), travel(t[0], t[2]), travel(t[1], t[3]), travel(t[2], t[3]));
    for (const n of PLAYER_COUNTS) {
      for (const l of levers) {
        if ((l.minPlayers ?? 1) > n) continue;
        expect(effectiveLeverWindowMs(r, n, l) / 1000, `n=${n} ${l.id}`).toBeGreaterThanOrEqual(1.6 * adjacent + 3);
      }
    }
  });

  it('trois vagues d\'embuscade en bandes pleine hauteur (impossibles à contourner), chaque vague à l\'est de sa bande', () => {
    const zones = new Map((r.zones ?? []).map((z) => [z.id, z.rect] as const));
    const waves = ['choirGate', 'choirMid', 'choirRing'];
    for (const id of waves) {
      const z = zones.get(id);
      expect(z, id).toBeDefined();
      expect(z!.y, id).toBeLessThanOrEqual(2);
      expect(z!.y + z!.h, id).toBeGreaterThanOrEqual(r.layout.length - 2);
      const foes = r.enemies.filter((e) => e.when === `enter:${id}`);
      expect(foes.length, id).toBeGreaterThan(8);
      for (const e of foes) expect(e.tile[0] - z!.x, `${id} ${e.kind} [${e.tile}]`).toBeGreaterThanOrEqual(6); // ≥ 6 tuiles du bord ouest de la bande
    }
    // les bandes sont dans l'ordre vers l'est et la dernière englobe les deux leviers de l'ouest
    const xs = waves.map((id) => zones.get(id)!.x);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
    const ring = zones.get('choirRing')!;
    for (const l of [levers[0], levers[2]]) expect(l.tile[0] >= ring.x && l.tile[0] < ring.x + ring.w, l.id).toBe(true);
    // tout ennemi de la salle est conditionné à une vague
    for (const e of r.enemies) expect(waves.map((w) => `enter:${w}`)).toContain(e.when);
  });

  it('le sanctuaire central est muré : la sortie n\'est accessible que par la porte du chœur', () => {
    const noDoor = components(r, { cutDoors: true });
    expect(noDoor.get(tk([r.exit.rect.x, r.exit.rect.y]))).not.toBe(noDoor.get(tk(r.playerSpawns[0])));
    expect(r.exit.requires).toContain('choirDoor');
  });
});

// ───────────────────────────── Ennemis ─────────────────────────────

describe('level7 — ennemis', () => {
  it("nettement plus d'ennemis que les niveaux 1 à 3 (≥ +25 % du maximum à 1 ET à 4 joueurs) ; planchers durs 170 / 295", () => {
    for (const n of [1, 4]) {
      const max = Math.max(totalEnemies(level1, n), totalEnemies(level2, n), totalEnemies(level3, n));
      const mine = totalEnemies(level7, n);
      expect(mine, `n=${n} : ${mine} ennemis vs max des niveaux 1-3 = ${max}`).toBeGreaterThanOrEqual(Math.ceil(max * 1.25));
    }
    expect(totalEnemies(level7, 1)).toBeGreaterThanOrEqual(170);
    expect(totalEnemies(level7, 4)).toBeGreaterThanOrEqual(295);
  });

  it("le nombre d'ennemis ne dépend que du nombre de joueurs (minPlayers) et croît strictement avec lui ; n1/n4 dans ]0,5 ; 0,75[", () => {
    const counts = PLAYER_COUNTS.map((n) => totalEnemies(level7, n));
    for (let i = 1; i < counts.length; i++) expect(counts[i]).toBeGreaterThan(counts[i - 1]);
    expect(counts[0] / counts[3]).toBeGreaterThan(0.5);
    expect(counts[0] / counts[3]).toBeLessThan(0.75);
    for (const r of level7.rooms) {
      for (const e of r.enemies) {
        expect(Object.keys(e).every((k) => ['kind', 'tile', 'wave', 'when', 'minPlayers'].includes(k)), `${r.id} ${e.kind}`).toBe(true);
        if (e.minPlayers !== undefined) expect([2, 3, 4]).toContain(e.minPlayers);
      }
    }
  });

  it("aucun ennemi à moins de 12 tuiles de l'arrivée des joueurs", () => {
    for (const r of level7.rooms) {
      for (const e of r.enemies) {
        for (const s of r.playerSpawns) {
          expect(Math.hypot(e.tile[0] - s[0], e.tile[1] - s[1]), `${r.id} ${e.kind} [${e.tile}] vs spawn [${s}]`).toBeGreaterThanOrEqual(12);
        }
      }
    }
  });

  it("les salles à abîme n'ont que des ennemis TERRESTRES (aucun volant ne peut rester suspendu)", () => {
    for (const r of level7.rooms) {
      if (!r.layout.some((row) => row.includes('~'))) continue;
      for (const e of r.enemies) expect(FLYING, `${r.id} ${e.kind}`).not.toContain(e.kind);
    }
  });

  it('les créatures dangereuses pour un petit groupe sont réservées aux groupes plus grands (chevaliers : 3+, archers et feux follets : 2+)', () => {
    for (const r of level7.rooms) {
      for (const e of r.enemies) {
        if (e.kind === 'knight') expect(e.minPlayers ?? 1, `${r.id} knight`).toBeGreaterThanOrEqual(3);
        if (e.kind === 'archer' || e.kind === 'wisp') expect(e.minPlayers ?? 1, `${r.id} ${e.kind}`).toBeGreaterThanOrEqual(2);
      }
    }
  });
});

// ───────────────────────────── Demi-boss et boss ─────────────────────────────

describe('level7 — demi-boss et boss de fin', () => {
  it('deux demi-boss (gardien `warden`, spectre `wraith`), présents à tous les nombres de joueurs, sortie sur « clear »', () => {
    const where = level7.rooms
      .map((r, i) => ({ r, i, minis: r.enemies.filter((e) => isMiniBossKind(e.kind)) }))
      .filter((x) => x.minis.length > 0);
    expect(where.map((x) => x.r.id)).toEqual(['dyke', 'stormdeck']);
    expect(where.map((x) => x.minis[0].kind)).toEqual(['warden', 'wraith']);
    for (const w of where) {
      expect(w.minis).toHaveLength(1);
      expect(w.minis[0].minPlayers).toBeUndefined();
      expect(w.r.exit.requires).toContain('clear');
    }
  });

  it('salles de demi-boss et de boss : salles PURES (aucun mécanisme, aucun abîme, aucune herse), sbires étagés (≥ 12 dès 1 joueur pour un demi-boss), 3 cristaux de soin', () => {
    for (const id of ['dyke', 'stormdeck', 'glassheart']) {
      const r = room(id);
      expect(r.mechanisms, id).toHaveLength(0);
      expect(r.layout.some((row) => row.includes('~')), `${id} sans abîme`).toBe(false);
      const minions = PLAYER_COUNTS.map((n) => enemiesAt(r, n).filter((e) => !isAnyBossKind(e.kind)).length);
      for (let i = 1; i < minions.length; i++) expect(minions[i], `${id} sbires`).toBeGreaterThan(minions[i - 1]);
      if (id !== 'glassheart') expect(minions[0], `${id} sbires à 1 joueur`).toBeGreaterThanOrEqual(12);
      expect(r.healCrystals, id).toHaveLength(3);
      expect(r.healCrystals?.filter((c) => c.minPlayers === undefined)).toHaveLength(2);
      expect(r.healCrystals?.filter((c) => c.minPlayers === 3)).toHaveLength(1);
    }
    // effectifs annoncés
    expect(PLAYER_COUNTS.map((n) => enemiesAt(room('dyke'), n).filter((e) => !isAnyBossKind(e.kind)).length)).toEqual([12, 18, 23, 27]);
    expect(PLAYER_COUNTS.map((n) => enemiesAt(room('stormdeck'), n).filter((e) => !isAnyBossKind(e.kind)).length)).toEqual([12, 18, 25, 30]);
    expect(PLAYER_COUNTS.map((n) => enemiesAt(room('glassheart'), n).filter((e) => !isAnyBossKind(e.kind)).length)).toEqual([9, 18, 30, 40]);
  });

  it('le spectre est dans une salle volante sans abîme, le gardien dans la salle à mi-parcours', () => {
    expect(level7.rooms.findIndex((r) => r.id === 'dyke')).toBe(2);
    expect(room('stormdeck').enemies.filter((e) => FLYING.includes(e.kind)).length).toBeGreaterThan(5);
  });

  it("salle finale : exit.final scellée, Morvane présent à tous les n, arène sans abîme ni mécanisme, exigences complètes ; une seule salle finale", () => {
    const last = level7.rooms[level7.rooms.length - 1];
    expect(last.id).toBe('glassheart');
    expect(last.exit.final).toBe(true);
    expect(last.exit.sealed).toBe(true);
    const bosses = last.enemies.filter((e) => isBossKind(e.kind));
    expect(bosses).toHaveLength(1);
    expect(bosses[0].kind).toBe('morvane');
    expect(bosses[0].minPlayers).toBeUndefined();
    expect(level7.rooms.filter((r) => r.exit.final)).toHaveLength(1);
    expect(level7.rooms.slice(0, -1).some((r) => r.enemies.some((e) => isBossKind(e.kind)))).toBe(false);
  });

  it('aucun cristal de soin hors des salles de (demi-)boss', () => {
    for (const r of level7.rooms) {
      const hasBoss = r.enemies.some((e) => isAnyBossKind(e.kind));
      expect((r.healCrystals ?? []).length, r.id).toBe(hasBoss ? 3 : 0);
    }
  });
});

// ───────────────────────────── Coopération adaptative ─────────────────────────────

describe('level7 — coop adaptative (1 à 4 joueurs)', () => {
  it('plaques de couleur, leviers, braseros de couleur : minPlayers = slot + 1', () => {
    for (const r of level7.rooms) {
      for (const m of r.mechanisms) {
        let slot: number | undefined;
        if (m.type === 'plate') slot = m.colorSlot;
        else if (m.type === 'lever' || m.type === 'key') slot = m.ownerSlot;
        else if (m.type === 'brazier') slot = m.ownerSlot;
        if (slot === undefined) continue;
        expect(m.minPlayers ?? 1, `${r.id}.${m.id}`).toBe(slot + 1);
      }
    }
  });

  it('les consignes citent la bonne couleur de slot (porteur du pont, voyant des runes, perle, chasse)', () => {
    const fr = getDictionary('fr');
    const en = getDictionary('en');
    const bridge = mech(room('mirrorpools'), 'mirrorBridge', 'lightBridge');
    expect(fr[bridge.labelKey as string]).toContain(`héros ${COLOR_FR[bridge.lanternSlot]}`);
    expect(en[bridge.labelKey as string]).toContain(`${COLOR_EN[bridge.lanternSlot]} hero`);
    expect(fr['sign.level7.mirrorpools.reader']).toMatch(/rouge/);
    expect(en['sign.level7.mirrorpools.reader']).toMatch(/red/);
    expect(fr['sign.level7.mirrorpools.bridge']).toMatch(/bleu/);
    expect(en['sign.level7.mirrorpools.bridge']).toMatch(/blue/);
    expect(fr['sign.level7.pearlcave.pearl']).toMatch(/rouge/);
    expect(en['sign.level7.pearlcave.pearl']).toMatch(/red/);
    expect(fr['sign.level7.shoal.bones']).toMatch(/vert/);
    expect(en['sign.level7.shoal.bones']).toMatch(/green/);
    expect(fr['mech.level7.mirrorpools.mirrorRunes']).toMatch(/rouge/);
    // cohérence avec les données : perle = slot 1 (rouge), os = slot 2 (vert), voyant = slot 1
    expect(level7.objectives.find((o) => o.id === 'pearl')?.slot).toBe(1);
    expect(level7.objectives.find((o) => o.id === 'bones')?.slot).toBe(2);
    expect(mech(room('mirrorpools'), 'mirrorRunes', 'runePuzzle').visibleToSlot).toBe(1);
  });
});

// ───────────────────────────── i18n ─────────────────────────────

describe('level7 — textes (parts i18n)', () => {
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

  it('toutes les clés requises par le niveau sont fournies (les orateurs viennent de la base), et aucune clé orpheline', () => {
    const required = new Set(collectRequiredI18nKeys(level7, { checkSpeakers: true }).map((r) => r.key));
    const own = new Set([...required].filter((k) => !k.startsWith('speaker.')));
    expect(new Set(Object.keys(fr))).toEqual(own);
    for (const k of required) {
      expect(Object.prototype.hasOwnProperty.call(getDictionary('en'), k), `en ${k}`).toBe(true);
      expect(base[k], k).toBeTruthy();
    }
  });

  it('clés bien formées, préfixées par la convention de DESIGN.md §6', () => {
    const prefixes = ['level.level7.', 'room.level7.', 'objective.level7.', 'mech.level7.', 'sign.level7.', 'hintroom.level7.'];
    for (const k of Object.keys(fr)) {
      expect(k, k).toMatch(/^[A-Za-z0-9_]+(\.[A-Za-z0-9_-]+)+$/);
      expect(prefixes.some((p) => k.startsWith(p)), k).toBe(true);
    }
  });

  it("textes courts et lisibles à l'écran (≤ 90 caractères) dans les deux langues", () => {
    for (const dict of [fr, en]) {
      for (const [k, v] of Object.entries(dict)) expect(v.length, `${k} (${v.length})`).toBeLessThanOrEqual(MAX_TEXT);
    }
  });

  it("histoire : intro de 3 à 5 répliques, outro de 2 à 4 (DESIGN §7), numérotées, orateurs autorisés, aucun nouvel orateur", () => {
    expect(level7.intro.length).toBeGreaterThanOrEqual(3);
    expect(level7.intro.length).toBeLessThanOrEqual(5);
    expect(level7.outro.length).toBeGreaterThanOrEqual(2);
    expect(level7.outro.length).toBeLessThanOrEqual(4);
    level7.intro.forEach((l, i) => expect(l.textKey).toBe(`level.level7.intro.${i + 1}`));
    level7.outro.forEach((l, i) => expect(l.textKey).toBe(`level.level7.outro.${i + 1}`));
    for (const l of [...level7.intro, ...level7.outro]) expect(ALLOWED_SPEAKERS).toContain(l.speaker);
    expect(Object.keys(fr).some((k) => k.startsWith('speaker.'))).toBe(false);
    // le niveau n'est pas le dernier : l'outro ne conclut pas la saga
    expect(fr['level.level7.outro.1']).toMatch(/lueur/);
  });
});

// ───────────────────────────── Déterminisme des données ─────────────────────────────

describe('level7 — données déterministes', () => {
  it("les spawns sont sur le sol et aucun mécanisme n'est un doublon d'id dans une salle", () => {
    for (const r of level7.rooms) {
      const ids = r.mechanisms.map((m: MechanismDef) => m.id);
      expect(new Set(ids).size, r.id).toBe(ids.length);
      for (const [x, y] of r.playerSpawns) expect(isFloor(r, x, y), `${r.id} spawn [${x},${y}]`).toBe(true);
    }
  });
});
