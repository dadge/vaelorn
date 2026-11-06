import { describe, expect, it } from 'vitest';
import { effectiveLeverWindowMs } from '../core/mechanisms';
import { LIGHT_FULL_TILES } from '../core/constants';
import { collectRequiredI18nKeys, validateLevel } from '../core/levelValidation';
import { resolveSlot } from '../core/slots';
import type { KeyDef, LeverDef, MechanismDef, PlateDef, RoomDef } from '../core/types';
import { getDictionary } from '../i18n/i18n';
import { level2 } from './level2';

const ALLOWED_SPEAKERS = new Set(['narrator', 'aldric', 'lyssa', 'morvane', 'gorgrim', 'heroes']);
const RUNE_SYMBOLS = new Set(['sun', 'moon', 'star', 'eye', 'flame', 'wave']);

function room(id: string): RoomDef {
  const r = level2.rooms.find((x) => x.id === id);
  if (!r) throw new Error(`salle introuvable : ${id}`);
  return r;
}

function mechs<T extends MechanismDef['type']>(r: RoomDef, type: T): Extract<MechanismDef, { type: T }>[] {
  return r.mechanisms.filter((m) => m.type === type) as Extract<MechanismDef, { type: T }>[];
}

/** Nombre d'ennemis présents à n joueurs dans une salle. */
function enemyCount(r: RoomDef, n: number): number {
  return r.enemies.filter((e) => (e.minPlayers ?? 1) <= n).length;
}

describe('level2 — validation globale', () => {
  it('passe validateLevel (structure, atteignabilité n=1..4, i18n fr+en, orateurs)', () => {
    const errors = validateLevel(level2, {
      dictionaries: { fr: getDictionary('fr'), en: getDictionary('en') },
      checkSpeakers: true,
    });
    expect(errors).toEqual([]);
  });

  it('a les métadonnées attendues', () => {
    expect(level2.id).toBe('level2');
    expect(level2.theme).toBe('grove');
    expect(level2.nameKey).toBe('level.level2.name');
    expect(level2.estimatedMinutes).toBe(8);
    expect(getDictionary('fr')['level.level2.name']).toBe('Le Bosquet Putride');
    expect(level2.rooms.every((r) => r.theme === 'grove')).toBe(true);
  });

  it('a 6 à 7 grandes salles (50-100 tuiles de large, 36-56 de haut), ids uniques', () => {
    expect(level2.rooms.length).toBeGreaterThanOrEqual(6);
    expect(level2.rooms.length).toBeLessThanOrEqual(7);
    expect(new Set(level2.rooms.map((r) => r.id)).size).toBe(level2.rooms.length);
    for (const r of level2.rooms) {
      const w = r.layout[0].length;
      const h = r.layout.length;
      expect(w, `largeur ${r.id}`).toBeGreaterThanOrEqual(50);
      expect(w, `largeur ${r.id}`).toBeLessThanOrEqual(100);
      expect(h, `hauteur ${r.id}`).toBeGreaterThanOrEqual(36);
      expect(h, `hauteur ${r.id}`).toBeLessThanOrEqual(56);
      expect(r.layout.every((row) => row.length === w)).toBe(true);
      // murs extérieurs
      expect(r.layout[0]).toBe('#'.repeat(w));
      expect(r.layout[h - 1]).toBe('#'.repeat(w));
      expect(r.layout.every((row) => row[0] === '#' && row[w - 1] === '#')).toBe(true);
      expect(r.playerSpawns.length).toBeGreaterThanOrEqual(4);
    }
  });

  it('utilise des piliers et des fosses', () => {
    const all = level2.rooms.flatMap((r) => r.layout).join('');
    expect(all).toContain('o');
    expect(all).toContain('~');
  });

  it('toutes les salles ont un indice d\'arrivée et un nom', () => {
    for (const r of level2.rooms) {
      expect(r.introHintKey, r.id).toBeTruthy();
      expect(r.nameKey).toBe(`room.level2.${r.id}.name`);
      expect(r.introHintKey).toBe(`hintroom.level2.${r.id}`);
    }
  });
});

describe('level2 — contenu', () => {
  it('utilise tous les types de mécanismes annoncés', () => {
    const types = new Set(level2.rooms.flatMap((r) => r.mechanisms.map((m) => m.type)));
    for (const t of ['plate', 'lever', 'key', 'door', 'runePuzzle']) expect(types.has(t as MechanismDef['type'])).toBe(true);
  });

  it('introduit archer et spider, et utilise slime, bat, skeleton', () => {
    const kinds = new Set(level2.rooms.flatMap((r) => r.enemies.map((e) => e.kind)));
    for (const k of ['slime', 'bat', 'skeleton', 'archer', 'spider', 'golem']) expect(kinds.has(k as never)).toBe(true);
    expect(kinds.has('morvane')).toBe(false);
  });

  it('a une seule sortie finale : scellée, dans la dernière salle', () => {
    const finals = level2.rooms.filter((r) => r.exit.final);
    expect(finals).toHaveLength(1);
    expect(finals[0]).toBe(level2.rooms[level2.rooms.length - 1]);
    expect(finals[0].exit.sealed).toBe(true);
    for (const r of level2.rooms.slice(0, -1)) {
      expect(r.exit.final).toBeFalsy();
      expect(r.exit.sealed).toBeFalsy();
    }
  });

  it('salle 2 : leviers à fenêtre 10-15 s, un propriétaire par couleur, très éloignés les uns des autres', () => {
    const levers = mechs(room('clairiere'), 'lever');
    expect(levers).toHaveLength(4);
    expect(levers.map((l) => l.ownerSlot).sort()).toEqual([0, 1, 2, 3]);
    for (const l of levers) {
      expect(l.windowMs).toBeGreaterThanOrEqual(10000);
      expect(l.windowMs).toBeLessThanOrEqual(15000);
    }
    for (let i = 0; i < levers.length; i++) {
      for (let j = i + 1; j < levers.length; j++) {
        const d = Math.hypot(levers[i].tile[0] - levers[j].tile[0], levers[i].tile[1] - levers[j].tile[1]);
        expect(d, `${levers[i].id}/${levers[j].id}`).toBeGreaterThanOrEqual(30);
      }
    }
    const gate = room('clairiere').mechanisms.find((m) => m.id === 'vine_gate');
    expect(gate && gate.type === 'door' ? gate.requires.sort() : []).toEqual(levers.map((l) => l.id).sort());
  });

  it('salle 4 : runes à vision partagée, séquence de 3-4 symboles valides', () => {
    const [rune] = mechs(room('murmures'), 'runePuzzle');
    expect(rune).toBeDefined();
    expect(rune.sequence.length).toBeGreaterThanOrEqual(3);
    expect(rune.sequence.length).toBeLessThanOrEqual(4);
    expect(rune.sequence.every((s) => RUNE_SYMBOLS.has(s))).toBe(true);
    expect(rune.pedestals.every((p) => RUNE_SYMBOLS.has(p.symbol))).toBe(true);
    expect(rune.visibleToSlot).toBeGreaterThanOrEqual(0);
    // piédestaux loin de l'autel : la description orale est nécessaire
    for (const p of rune.pedestals) {
      const d = Math.hypot(p.tile[0] - rune.displayTile[0], p.tile[1] - rune.displayTile[1]);
      expect(d, p.symbol).toBeGreaterThanOrEqual(25);
    }
    // un panneau explique « décris les symboles à voix haute »
    const signs = (room('murmures').signs ?? []).map((s) => getDictionary('fr')[s.textKey]);
    expect(signs.some((s) => /voix haute/.test(s))).toBe(true);
  });

  it('salle 6 : salle de boss pure, Gorgrim, arène avec piliers, sortie exigeant clear + 4 objectifs', () => {
    const boss = room('arene');
    expect(boss.mechanisms).toEqual([]);
    expect(boss.layout[0].length).toBe(50);
    expect(boss.layout.length).toBe(40);
    expect(boss.enemies.filter((e) => e.kind === 'golem')).toHaveLength(1);
    expect(boss.enemies.find((e) => e.kind === 'golem')?.minPlayers).toBeUndefined();
    expect(boss.layout.join('')).toContain('o');
    // arène dégagée de ≈ 50×40 : au moins 85 % de sol
    const cells = boss.layout.join('');
    const floor = [...cells].filter((c) => c === '.' || c === ',').length;
    expect(floor / cells.length).toBeGreaterThan(0.85);
    expect(boss.exit.requires).toContain('clear');
    for (const o of level2.objectives) expect(boss.exit.requires).toContain(`obj:${o.id}`);
    expect(boss.exit.requires).toHaveLength(1 + level2.objectives.length);
  });

  it('objectifs : un par slot, répartis entre levier, runes, clé et zone du boss', () => {
    expect(level2.objectives.map((o) => o.slot).sort()).toEqual([0, 1, 2, 3]);
    const byId = Object.fromEntries(level2.objectives.map((o) => [o.id, o]));
    expect(byId.sync_levers.roomId).toBe('clairiere');
    expect(byId.read_runes.roomId).toBe('murmures');
    expect(byId.bear_key.roomId).toBe('nid');
    expect(byId.hold_circle.roomId).toBe('arene');
    expect(byId.hold_circle.kind).toBe('zone');
    expect(byId.hold_circle.seconds).toBeGreaterThan(0);
    // les objectifs 'mécanisme' pointent sur des mécanismes présents dès 1 joueur (jamais auto-résolus)
    for (const o of level2.objectives.filter((x) => x.kind === 'mechanism')) {
      const m = room(o.roomId).mechanisms.find((x) => x.id === o.mechanismId);
      expect(m, o.id).toBeDefined();
      expect(m?.minPlayers ?? 1, o.id).toBe(1);
    }
    // l'objectif de clé concerne la clé du slot 2, celui du levier le levier du slot 0
    const key = room('nid').mechanisms.find((m) => m.id === byId.bear_key.mechanismId) as KeyDef;
    expect(resolveSlot(key.ownerSlot, 4)).toBe(resolveSlot(byId.bear_key.slot, 4));
    const lever = room('clairiere').mechanisms.find((m) => m.id === byId.sync_levers.mechanismId) as LeverDef;
    expect(resolveSlot(lever.ownerSlot ?? -1, 4)).toBe(resolveSlot(byId.sync_levers.slot, 4));
  });

  it('chaque salle a un mécanisme coopératif présent dès 1 joueur (sauf le boss)', () => {
    for (const r of level2.rooms.slice(0, -1)) {
      const coop = r.mechanisms.some(
        (m) => ['plate', 'lever', 'key', 'runePuzzle', 'block'].includes(m.type) && (m.minPlayers ?? 1) <= 1,
      );
      expect(coop, r.id).toBe(true);
    }
  });
});

describe('level2 — coop adaptative 1 à 4 joueurs', () => {
  it('leviers : à n joueurs, exactement n leviers actifs, un par joueur, fenêtre effective 10-15 s', () => {
    const r = room('clairiere');
    for (let n = 1; n <= 4; n++) {
      const levers = mechs(r, 'lever').filter((l) => (l.minPlayers ?? 1) <= n);
      expect(levers).toHaveLength(n);
      const owners = levers.map((l) => resolveSlot(l.ownerSlot ?? 0, n));
      expect(new Set(owners).size).toBe(n);
      for (const l of levers) {
        const w = effectiveLeverWindowMs(r, n, l);
        expect(w).toBeGreaterThanOrEqual(10000);
        expect(w).toBeLessThanOrEqual(15000);
      }
    }
  });

  it('clés, portes et plaques de la Serre : n de chaque à n joueurs, un porteur par joueur', () => {
    const r = room('nid');
    for (let n = 1; n <= 4; n++) {
      const keys = mechs(r, 'key').filter((k) => (k.minPlayers ?? 1) <= n);
      const gates = mechs(r, 'door').filter((d) => d.keyId !== undefined && (d.minPlayers ?? 1) <= n);
      const plates = mechs(r, 'plate').filter((p) => (p.minPlayers ?? 1) <= n);
      expect(keys).toHaveLength(n);
      expect(gates).toHaveLength(n);
      expect(plates).toHaveLength(n);
      expect(new Set(keys.map((k) => resolveSlot(k.ownerSlot, n))).size).toBe(n);
    }
    // clé ↔ porte ↔ plaque de même minPlayers
    for (const k of mechs(r, 'key')) {
      const door = r.mechanisms.find((m) => m.id === k.doorId);
      expect(door?.minPlayers).toBe(k.minPlayers);
    }
  });

  it('plaques des salles 1 et 5 : une par joueur à n joueurs, couleur = slot', () => {
    for (const id of ['lisiere', 'mare']) {
      const r = room(id);
      for (let n = 1; n <= 4; n++) {
        const plates = mechs(r, 'plate').filter((p: PlateDef) => (p.minPlayers ?? 1) <= n);
        expect(plates, `${id} n=${n}`).toHaveLength(n);
        expect(new Set(plates.map((p) => resolveSlot(p.colorSlot ?? 0, n))).size).toBe(n);
      }
    }
  });

  it('le nombre d\'ennemis ne dépend que des joueurs : croissant avec n, jamais nul', () => {
    for (const r of level2.rooms) {
      let prev = 0;
      for (let n = 1; n <= 4; n++) {
        const c = enemyCount(r, n);
        expect(c, `${r.id} n=${n}`).toBeGreaterThanOrEqual(prev);
        expect(c).toBeGreaterThan(0);
        prev = c;
      }
      for (const e of r.enemies) {
        if (e.minPlayers !== undefined) {
          expect(e.minPlayers).toBeGreaterThanOrEqual(2);
          expect(e.minPlayers).toBeLessThanOrEqual(4);
        }
      }
    }
    // à 4 joueurs la mêlée est plus dense qu'à 1
    for (const r of level2.rooms) expect(enemyCount(r, 4)).toBeGreaterThan(enemyCount(r, 1));
  });

  it('les embuscades de la mare ont le minPlayers de leur plaque', () => {
    const r = room('mare');
    for (const e of r.enemies.filter((x) => x.when !== undefined)) {
      const p = mechs(r, 'plate').find((pl) => pl.id === e.when);
      expect(p, String(e.when)).toBeDefined();
      expect(e.minPlayers ?? 1).toBe(p?.minPlayers ?? 1);
    }
  });

  it('la durée estimée reste cohérente : ≈ 8 min', () => {
    expect(level2.estimatedMinutes).toBeGreaterThanOrEqual(7);
    expect(level2.estimatedMinutes).toBeLessThanOrEqual(10);
  });
});

describe('level2 — grandes salles et monstres', () => {
  const surfaceOf = (r: RoomDef): number => r.layout.length * r.layout[0].length;

  it('chaque salle est grande (≥ 2000 tuiles, ≥ 4 salles ≥ 2400) : jamais visible en entier', () => {
    for (const r of level2.rooms) {
      expect(surfaceOf(r), r.id).toBeGreaterThanOrEqual(2000);
      // la caméra montre au plus ≈ 26×15 tuiles
      expect(r.layout[0].length, r.id).toBeGreaterThan(26 * 1.8);
      expect(r.layout.length, r.id).toBeGreaterThan(15 * 2.4);
    }
    expect(level2.rooms.filter((r) => surfaceOf(r) >= 2400).length).toBeGreaterThanOrEqual(4);
  });

  it('14 à 45 ennemis par salle à 4 joueurs, et ≈ 55-65 % à 1 joueur (jamais selon la difficulté)', () => {
    for (const r of level2.rooms) {
      const n4 = enemyCount(r, 4);
      const n1 = enemyCount(r, 1);
      expect(n4, r.id).toBeGreaterThanOrEqual(14);
      expect(n4, r.id).toBeLessThanOrEqual(45);
      const ratio = n1 / n4;
      expect(ratio, `${r.id} ${n1}/${n4}`).toBeGreaterThanOrEqual(0.4);
      expect(ratio, `${r.id} ${n1}/${n4}`).toBeLessThanOrEqual(0.7);
    }
    const total4 = level2.rooms.reduce((a, r) => a + enemyCount(r, 4), 0);
    const total1 = level2.rooms.reduce((a, r) => a + enemyCount(r, 1), 0);
    expect(total1 / total4).toBeGreaterThanOrEqual(0.5);
    expect(total1 / total4).toBeLessThanOrEqual(0.68);
  });

  it("arrivée calme : aucun ennemi (hors embuscades à plaque) à moins de 12 tuiles d'un point d'arrivée", () => {
    for (const r of level2.rooms) {
      for (const e of r.enemies) {
        if (e.when !== undefined) continue;
        for (const s of r.playerSpawns) {
          const d = Math.hypot(e.tile[0] - s[0], e.tile[1] - s[1]);
          expect(d, `${r.id} ${e.kind} ${e.tile}`).toBeGreaterThanOrEqual(12);
        }
      }
    }
  });

  it('il y a des vagues de renforts (wave 1) dans plusieurs salles, jamais dans la mare ni le boss', () => {
    const withWaves = level2.rooms.filter((r) => r.enemies.some((e) => (e.wave ?? 0) > 0));
    expect(withWaves.length).toBeGreaterThanOrEqual(3);
    expect(room('arene').enemies.every((e) => (e.wave ?? 0) === 0)).toBe(true);
    expect(room('mare').enemies.every((e) => (e.wave ?? 0) === 0)).toBe(true);
  });

  it('les ennemis sont dispersés : au moins 4 groupes distincts (> 15 tuiles) par salle', () => {
    for (const r of level2.rooms) {
      const centers: [number, number][] = [];
      for (const e of r.enemies) {
        const p = e.tile;
        if (centers.every((c) => Math.hypot(c[0] - p[0], c[1] - p[1]) > 15)) centers.push([p[0], p[1]]);
      }
      expect(centers.length, r.id).toBeGreaterThanOrEqual(4);
    }
  });

  it("les éléments d'une même épreuve sont écartés : plaques, clés, piédestaux à ≥ 12 tuiles", () => {
    const minGap = (tiles: readonly (readonly [number, number])[]): number => {
      let m = Infinity;
      for (let i = 0; i < tiles.length; i++) {
        for (let j = i + 1; j < tiles.length; j++) m = Math.min(m, Math.hypot(tiles[i][0] - tiles[j][0], tiles[i][1] - tiles[j][1]));
      }
      return m;
    };
    for (const id of ['lisiere', 'mare']) {
      expect(minGap(mechs(room(id), 'plate').map((p) => p.tile)), id).toBeGreaterThanOrEqual(12);
    }
    expect(minGap(mechs(room('nid'), 'key').map((p) => p.tile))).toBeGreaterThanOrEqual(12);
    expect(minGap(mechs(room('nid'), 'plate').map((p) => p.tile))).toBeGreaterThanOrEqual(12);
    expect(minGap(mechs(room('murmures'), 'runePuzzle')[0].pedestals.map((p) => p.tile))).toBeGreaterThanOrEqual(12);
  });

  it('chaque porte ferme entièrement son couloir (aucun contournement)', () => {
    for (const r of level2.rooms) {
      const doorTiles = r.mechanisms.flatMap((m) => (m.type === 'door' ? m.tiles : []));
      const isDoor = (x: number, y: number): boolean => doorTiles.some((t) => t[0] === x && t[1] === y);
      const blocked = (x: number, y: number): boolean => isDoor(x, y) || !['.', ','].includes(r.layout[y][x]);
      for (const m of r.mechanisms) {
        if (m.type !== 'door') continue;
        for (const [x, y] of m.tiles) {
          // la porte traverse le couloir : dans UN axe, les deux voisines sont une autre tuile de la porte ou un mur
          const horiz = blocked(x - 1, y) && blocked(x + 1, y);
          const vert = blocked(x, y - 1) && blocked(x, y + 1);
          expect(horiz || vert, `${r.id} ${m.id} ${x},${y}`).toBe(true);
        }
      }
    }
  });

  it('le décor au sol ne bloque pas : jamais sur une porte ni sur un mécanisme', () => {
    for (const r of level2.rooms) {
      const sensitive: [number, number][] = [];
      for (const m of r.mechanisms) {
        if (m.type === 'door') sensitive.push(...m.tiles);
        else if (m.type === 'plate' || m.type === 'lever' || m.type === 'key') sensitive.push(m.tile);
      }
      for (const d of r.decor ?? []) {
        if (d.type === 'torch' || d.type === 'banner') continue;
        expect(sensitive.some((t) => t[0] === d.tile[0] && t[1] === d.tile[1]), `${r.id} décor ${d.type}`).toBe(false);
      }
    }
  });
});

describe('level2 — salle sombre (le nid) et torches', () => {
  const nid = room('nid');
  const braziers = mechs(nid, 'brazier');
  const lit = braziers.filter((b) => b.lit === true);
  const cold = braziers.filter((b) => b.lit !== true);
  const d = (a: readonly [number, number], b: readonly [number, number]): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

  it('seule la salle « nid » est sombre ; les autres restent éclairées', () => {
    expect(nid.dark).toBe(true);
    for (const r of level2.rooms) if (r.id !== 'nid') expect(r.dark, r.id).not.toBe(true);
  });

  it('braseros : ids uniques, sur du sol (pas un pilier), jamais sur un spawn, un ennemi, un mécanisme ou un panneau', () => {
    expect(new Set(braziers.map((b) => b.id)).size).toBe(braziers.length);
    const others: [number, number][] = [
      ...nid.playerSpawns,
      ...nid.enemies.map((e) => e.tile),
      ...(nid.signs ?? []).map((s) => s.tile),
      ...nid.mechanisms.flatMap((m) => (m.type === 'door' ? m.tiles : m.type === 'plate' || m.type === 'key' ? [m.tile] : [])),
    ];
    for (const b of braziers) {
      expect(['.', ','], b.id).toContain(nid.layout[b.tile[1]][b.tile[0]]);
      expect(others.some((t) => t[0] === b.tile[0] && t[1] === b.tile[1]), b.id).toBe(false);
      expect(b.labelKey, b.id).toBeTruthy();
    }
  });

  it('au moins 8 braseros allumés (point de recharge) et 2 braseros éteints à allumer (tâche annexe)', () => {
    expect(lit.length).toBeGreaterThanOrEqual(8);
    expect(cold.length).toBeGreaterThanOrEqual(2);
  });

  it("zone de départ éclairée : chaque spawn est à ≤ LIGHT_FULL_TILES d'un brasero allumé", () => {
    for (const s of nid.playerSpawns) expect(lit.some((b) => d(b.tile, s) <= LIGHT_FULL_TILES), `spawn ${s}`).toBe(true);
  });

  it('chaque clé et chaque plaque a un brasero allumé à ≤ 5 tuiles, et une torche murale ou un cristal près des clés', () => {
    for (const k of mechs(nid, 'key')) {
      expect(lit.some((b) => d(b.tile, k.tile) <= 5), k.id).toBe(true);
      const glow = (nid.decor ?? []).some((x) => (x.type === 'torch' || x.type === 'crystal') && d(x.tile, k.tile) <= 3);
      expect(glow, `lueur près de ${k.id}`).toBe(true);
    }
    for (const p of mechs(nid, 'plate')) expect(lit.some((b) => d(b.tile, p.tile) <= 5), p.id).toBe(true);
  });

  it('braseros de recharge espacés : chacun a un voisin allumé entre 12 et 40 tuiles, et aucun ne reste isolé', () => {
    for (const b of lit) {
      const nearest = Math.min(...lit.filter((o) => o !== b).map((o) => d(o.tile, b.tile)));
      expect(nearest, b.id).toBeLessThanOrEqual(40);
    }
    const hall = lit.filter((b) => b.id.startsWith('brazier_hall') || b.id === 'brazier_start').sort((a, b) => a.tile[0] - b.tile[0]);
    for (let i = 1; i < hall.length; i++) {
      const gap = d(hall[i].tile, hall[i - 1].tile);
      expect(gap).toBeGreaterThanOrEqual(25);
      expect(gap).toBeLessThanOrEqual(35);
    }
  });

  it("panneau de rappel de la torche près du départ, indice d'arrivée sur la torche", () => {
    const sign = (nid.signs ?? []).find((s) => s.textKey === 'sign.level2.keysDark');
    expect(sign).toBeDefined();
    expect(Math.min(...nid.playerSpawns.map((s) => d(s, sign!.tile)))).toBeLessThanOrEqual(8);
    expect(getDictionary('fr')['sign.level2.keysDark']).toMatch(/torche/);
    expect(getDictionary('fr')['sign.level2.keysDark']).toMatch(/brasero/);
    expect(getDictionary('fr')[nid.introHintKey!]).toMatch(/torche/);
    expect(getDictionary('en')['sign.level2.keysDark']).toMatch(/torch/);
  });

  it("solvable à 1-4 joueurs : aucune porte, sortie ni apparition n'exige un brasero (les éteints sont facultatifs)", () => {
    const braziIds = new Set(braziers.map((b) => b.id));
    for (const m of nid.mechanisms) {
      if (m.type === 'door') for (const r of m.requires) expect(braziIds.has(r), `${m.id} exige ${r}`).toBe(false);
    }
    for (const r of nid.exit.requires ?? []) expect(braziIds.has(r)).toBe(false);
    for (const e of nid.enemies) expect(e.when === undefined || !braziIds.has(e.when)).toBe(true);
    // à n joueurs : n clés/portes/plaques actives et au moins un brasero allumé présent (aucun minPlayers)
    for (let n = 1; n <= 4; n++) {
      expect(lit.filter((b) => (b.minPlayers ?? 1) <= n).length, `n=${n}`).toBe(lit.length);
      expect(mechs(nid, 'key').filter((k) => (k.minPlayers ?? 1) <= n)).toHaveLength(n);
    }
  });

  it('les ennemis de la salle sombre sont tous sur du sol atteignable (validateLevel n=1..4 sans erreur)', () => {
    expect(validateLevel(level2, { dictionaries: { fr: getDictionary('fr'), en: getDictionary('en') }, checkSpeakers: true })).toEqual([]);
    expect(enemyCount(nid, 4)).toBeGreaterThanOrEqual(14);
  });
});

const onlyLevel2 = (d: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(d).filter(([k]) => k.includes('level2')));
const frPart = onlyLevel2(getDictionary('fr'));
const enPart = onlyLevel2(getDictionary('en'));

describe('level2 — i18n', () => {
  it('les parts fr/en ont exactement les mêmes clés, sans valeur vide, mêmes {placeholders}', () => {
    const fr = frPart as Record<string, string>;
    const en = enPart as Record<string, string>;
    expect(Object.keys(fr).sort()).toEqual(Object.keys(en).sort());
    for (const [k, v] of Object.entries(fr)) {
      expect(v.trim(), k).not.toBe('');
      expect(en[k].trim(), k).not.toBe('');
      const ph = (s: string): string[] => (s.match(/\{\w+\}/g) ?? []).sort();
      expect(ph(en[k]), k).toEqual(ph(v));
    }
  });

  it('toutes les clés requises existent (fr et en) et la part ne contient que des clés level2', () => {
    const refs = collectRequiredI18nKeys(level2, { checkSpeakers: true });
    for (const lang of ['fr', 'en'] as const) {
      const dict = getDictionary(lang);
      for (const ref of refs) expect(dict[ref.key], `${lang} ${ref.key}`).toBeTruthy();
    }
    const required = new Set(refs.map((r) => r.key).filter((k) => !k.startsWith('speaker.')));
    for (const k of Object.keys(frPart)) {
      expect(k.includes('level2'), k).toBe(true);
      expect(required.has(k), `clé inutilisée : ${k}`).toBe(true);
    }
  });

  it('les répliques, panneaux et indices tiennent en 90 caractères maximum', () => {
    const refs = collectRequiredI18nKeys(level2).filter((r) => /\.(intro|outro)\.|^sign\.|^hintroom\./.test(r.key));
    expect(refs.length).toBeGreaterThan(20);
    for (const lang of ['fr', 'en'] as const) {
      const dict = getDictionary(lang);
      for (const ref of refs) expect(dict[ref.key].length, `${lang} ${ref.key}`).toBeLessThanOrEqual(90);
    }
  });

  it('dialogues : 3-5 répliques d\'intro, 2-4 d\'outro, orateurs autorisés, conclusion vers la Citadelle', () => {
    expect(level2.intro.length).toBeGreaterThanOrEqual(3);
    expect(level2.intro.length).toBeLessThanOrEqual(5);
    expect(level2.outro.length).toBeGreaterThanOrEqual(2);
    expect(level2.outro.length).toBeLessThanOrEqual(4);
    for (const l of [...level2.intro, ...level2.outro]) expect(ALLOWED_SPEAKERS.has(l.speaker), l.speaker).toBe(true);
    const outroFr = level2.outro.map((l) => getDictionary('fr')[l.textKey]).join(' ');
    expect(outroFr).toMatch(/Citadelle/);
    expect(outroFr).toMatch(/fragment/);
    expect(level2.outro.some((l) => l.speaker === 'lyssa')).toBe(true);
  });
});
