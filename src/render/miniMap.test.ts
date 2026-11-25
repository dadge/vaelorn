/**
 * Minicarte : logique pure (découverte, pions, clignotement, placement, préférence) — aucun Phaser.
 * Placement vérifié sur TOUTES les salles réelles des 9 niveaux x 1-4 joueurs x 1280x720 et 640x360.
 */
import { describe, expect, it } from 'vitest';
import { CROSS_CALL_THRESHOLD } from '../core/balance';
import { GAME_HEIGHT, GAME_WIDTH, LIGHT_EMPTY_TILES, LIGHT_FULL_TILES, PLAYER_COLORS, TILE, TORCH_MAX_MS } from '../core/constants';
import { makeTestRoom } from '../core/levelValidation';
import { createPlayerState } from '../core/players';
import type { PlayerId, PlayerState, RoomDef } from '../core/types';
import { LEVELS } from '../levels';
import { mapZone } from './mapZone';
import {
  MAP_LONG_PRESS_MS,
  MAP_REVEAL_HALF_H_TILES,
  MAP_REVEAL_HALF_W_TILES,
  MAP_SCALE_MAX_SHARED,
  MAP_SCALE_MAX_SINGLE,
  MAP_TILE,
  MAP_VISIBLE_STORAGE_KEY,
  MARKER_BLINK_PERIOD_MS,
  MARKER_CALL_MIN_ALPHA,
  MARKER_DOT_RADIUS,
  MARKER_DOWN_DOT_ALPHA,
  MARKER_DOWN_HALF,
  MARKER_DOWN_LINE,
  MARKER_HEAL_HALF,
  MARKER_SMALL_MAP_FACTOR,
  MapPress,
  blinkPulse,
  computeMarkers,
  createMapMemory,
  createMarkerVisual,
  heroLightRadiusTiles,
  heroUnderMap,
  heroesUnderMap,
  isTileKnown,
  loadMapVisible,
  mapBoxFor,
  mapPadFor,
  mapPlacement,
  mapToggleMessageKey,
  markerDotDepth,
  markerPriority,
  markerSizeFactor,
  markerVisual,
  placeMap,
  roomGridSize,
  saveMapVisible,
  updateMapMemory,
  worldToMapPx,
  type MapStorage,
} from './miniMap';
import { computeLayout, rectsOverlap, type ScreenRect } from './splitscreen';

// ───────────────────────────── Aides ─────────────────────────────

function hero(id: PlayerId, tx: number, ty: number, over: Partial<PlayerState> = {}): PlayerState {
  const p = createPlayerState({ id, characterId: (['david', 'sandrine', 'romain', 'valentine'] as const)[id], difficulty: 2 }, { x: tx * TILE + TILE / 2, y: ty * TILE + TILE / 2 });
  return Object.assign(p, over);
}

/** Salle claire 60x40 (murs sur le pourtour). */
function bigRoom(over: Partial<RoomDef> = {}): RoomDef {
  const cols = 60;
  const rows = 40;
  const layout: string[] = [];
  for (let y = 0; y < rows; y++) layout.push(y === 0 || y === rows - 1 ? '#'.repeat(cols) : `#${'.'.repeat(cols - 2)}#`);
  return makeTestRoom({ id: 'big', layout, ...over });
}

function knownTiles(room: RoomDef, m: ReturnType<typeof createMapMemory>): string[] {
  const out: string[] = [];
  for (let y = 0; y < m.rows; y++) for (let x = 0; x < m.cols; x++) if (isTileKnown(m, x, y)) out.push(`${x},${y}`);
  void room;
  return out;
}

// ───────────────────────────── Grille / classes de tuiles ─────────────────────────────

describe('createMapMemory : grille de la salle', () => {
  it('dimensions et classes des tuiles (sol, mur de contour, masse pleine, pilier, fosse, vide)', () => {
    const room = makeTestRoom({
      id: 'cls',
      layout: ['#######', '#.,o~.#', '#######', '#######', '  ###  '],
    });
    const m = createMapMemory(room);
    expect(roomGridSize(room)).toEqual({ cols: 7, rows: 5 });
    expect([m.cols, m.rows, m.knownCount]).toEqual([7, 5, 0]);
    const at = (x: number, y: number): number => m.tiles[y * m.cols + x];
    expect(at(1, 1)).toBe(MAP_TILE.floor);
    expect(at(2, 1)).toBe(MAP_TILE.floor);
    expect(at(3, 1)).toBe(MAP_TILE.edge); // pilier voisin d'un sol
    expect(at(4, 1)).toBe(MAP_TILE.pit);
    expect(at(0, 0)).toBe(MAP_TILE.edge); // coin : voisin diagonal praticable
    expect(at(3, 0)).toBe(MAP_TILE.edge);
    expect(at(3, 3)).toBe(MAP_TILE.solid); // masse pleine : aucun voisin praticable
    expect(at(0, 4)).toBe(MAP_TILE.void);
    expect(at(2, 4)).toBe(MAP_TILE.solid);
  });

  it('une grille aux lignes de longueurs inégales ne plante pas', () => {
    const room = makeTestRoom({ id: 'ragged', layout: ['###', '#.', '#####'] });
    const m = createMapMemory(room);
    expect(m.cols).toBe(5);
    expect(m.tiles.length).toBe(15);
    expect(m.tiles[1 * 5 + 4]).toBe(MAP_TILE.void);
  });
});

// ───────────────────────────── Découverte ─────────────────────────────

describe('updateMapMemory : découverte (salle claire)', () => {
  it('révèle un rectangle autour de chaque héros, borné à la grille', () => {
    const room = bigRoom();
    const m = createMapMemory(room);
    const r = updateMapMemory(m, room, [hero(0, 30, 20)], 0);
    expect(r).toEqual({ changed: true, reset: false });
    const w = MAP_REVEAL_HALF_W_TILES * 2 + 1;
    const h = MAP_REVEAL_HALF_H_TILES * 2 + 1;
    expect(m.knownCount).toBe(w * h);
    expect(isTileKnown(m, 30 - MAP_REVEAL_HALF_W_TILES, 20 - MAP_REVEAL_HALF_H_TILES)).toBe(true);
    expect(isTileKnown(m, 30 + MAP_REVEAL_HALF_W_TILES + 1, 20)).toBe(false);
    expect(isTileKnown(m, 30, 20 + MAP_REVEAL_HALF_H_TILES + 1)).toBe(false);
    // Coin de la salle : borné, aucune tuile hors grille.
    const m2 = createMapMemory(room);
    updateMapMemory(m2, room, [hero(0, 1, 1)], 0);
    expect(m2.knownCount).toBe((MAP_REVEAL_HALF_W_TILES + 2) * (MAP_REVEAL_HALF_H_TILES + 2));
    expect(isTileKnown(m2, -1, 0)).toBe(false);
    expect(isTileKnown(m2, 999, 0)).toBe(false);
  });

  it("union des zones vues par les 4 héros (position ET passé)", () => {
    const room = bigRoom();
    const m = createMapMemory(room);
    const players = [hero(0, 10, 10), hero(1, 50, 10), hero(2, 10, 30), hero(3, 50, 30)];
    updateMapMemory(m, room, players, 0);
    const one = (MAP_REVEAL_HALF_W_TILES * 2 + 1) * (MAP_REVEAL_HALF_H_TILES * 2 + 1);
    expect(m.knownCount).toBeGreaterThan(one * 3); // quatre zones séparées (les bords de la salle en rognent un peu)
    for (const p of players) expect(isTileKnown(m, Math.floor(p.pos.x / TILE), Math.floor(p.pos.y / TILE))).toBe(true);
    expect(isTileKnown(m, 30, 20)).toBe(false); // le centre de la salle n'a été vu par personne
  });

  it('monotone : une tuile découverte ne redevient jamais inconnue, même quand le héros repart', () => {
    const room = bigRoom();
    const m = createMapMemory(room);
    const p = hero(0, 10, 20);
    updateMapMemory(m, room, [p], 0);
    const before = new Set(knownTiles(room, m));
    let count = m.knownCount;
    for (let step = 1; step <= 40; step++) {
      p.pos.x += TILE; // le héros avance d'une tuile par pas
      updateMapMemory(m, room, [p], step * 100);
      expect(m.knownCount).toBeGreaterThanOrEqual(count);
      count = m.knownCount;
    }
    const after = new Set(knownTiles(room, m));
    for (const k of before) expect(after.has(k)).toBe(true);
    expect(after.size).toBeGreaterThan(before.size);
  });

  it("changed = faux (et révision inchangée) quand personne n'a changé de tuile", () => {
    const room = bigRoom();
    const m = createMapMemory(room);
    const p = hero(0, 30, 20);
    updateMapMemory(m, room, [p], 0);
    const rev = m.revision;
    p.pos.x += 3; // reste dans la même tuile
    const r = updateMapMemory(m, room, [p], 16);
    expect(r.changed).toBe(false);
    expect(m.revision).toBe(rev);
    p.pos.x += TILE; // tuile voisine : une colonne de plus
    expect(updateMapMemory(m, room, [p], 32).changed).toBe(true);
    expect(m.revision).toBeGreaterThan(rev);
  });

  it("un héros à terre a vu ce qu'il a vu : sa zone reste, et sa position est révélée", () => {
    const room = bigRoom();
    const m = createMapMemory(room);
    const p = hero(0, 20, 20);
    updateMapMemory(m, room, [p], 0);
    const n = m.knownCount;
    p.status = 'down';
    updateMapMemory(m, room, [p], 100);
    expect(m.knownCount).toBe(n);
    expect(isTileKnown(m, 20, 20)).toBe(true);
  });

  it("ignore une position non finie sans planter", () => {
    const room = bigRoom();
    const m = createMapMemory(room);
    const p = hero(0, 5, 5);
    p.pos.x = Number.NaN;
    expect(() => updateMapMemory(m, room, [p], 0)).not.toThrow();
    expect(m.knownCount).toBe(0);
  });
});

describe('updateMapMemory : une mémoire par salle', () => {
  it("remise à zéro quand l'id de salle change (la grille aussi)", () => {
    const a = bigRoom({ id: 'a' });
    const b = makeTestRoom({ id: 'b' }); // 12x8
    const m = createMapMemory(a);
    updateMapMemory(m, a, [hero(0, 30, 20)], 5000);
    expect(m.knownCount).toBeGreaterThan(0);
    const rev = m.revision;
    const r = updateMapMemory(m, b, [hero(0, 2, 2)], 0);
    expect(r.reset).toBe(true);
    expect(r.changed).toBe(true);
    expect(m.roomId).toBe('b');
    expect([m.cols, m.rows]).toEqual([12, 8]);
    expect(m.revision).toBeGreaterThan(rev);
    // La découverte repart de zéro : seulement ce que voit le héros dans la NOUVELLE salle.
    expect(m.knownCount).toBeLessThanOrEqual(12 * 8);
    expect(isTileKnown(m, 2, 2)).toBe(true);
  });

  it("remise à zéro quand la salle redémarre (le temps écoulé recule), même id", () => {
    const room = bigRoom();
    const m = createMapMemory(room);
    updateMapMemory(m, room, [hero(0, 10, 10)], 0);
    updateMapMemory(m, room, [hero(0, 50, 30)], 60000);
    const big = m.knownCount;
    const r = updateMapMemory(m, room, [hero(0, 10, 10)], 0); // défaite : redémarrage
    expect(r.reset).toBe(true);
    expect(m.knownCount).toBeLessThan(big);
    expect(isTileKnown(m, 50, 30)).toBe(false);
    expect(isTileKnown(m, 10, 10)).toBe(true);
  });

  it("pas de remise à zéro tant que le temps avance", () => {
    const room = bigRoom();
    const m = createMapMemory(room);
    updateMapMemory(m, room, [hero(0, 10, 10)], 1000);
    expect(updateMapMemory(m, room, [hero(0, 10, 10)], 1016).reset).toBe(false);
    expect(updateMapMemory(m, room, [hero(0, 10, 10)], 1016).reset).toBe(false); // temps identique (pause)
  });

  it("ne touche ni les joueurs ni la salle (aucune écriture dans l'état)", () => {
    const room = bigRoom();
    const players = [hero(0, 30, 20), hero(1, 31, 20)];
    const snapRoom = JSON.stringify(room);
    const snapPlayers = JSON.stringify(players);
    updateMapMemory(createMapMemory(room), room, players, 0);
    expect(JSON.stringify(room)).toBe(snapRoom);
    expect(JSON.stringify(players)).toBe(snapPlayers);
  });
});

describe('updateMapMemory : salle sombre', () => {
  it('révèle un disque de la taille de la lumière du héros, pas la vue caméra', () => {
    const room = bigRoom({ dark: true });
    const m = createMapMemory(room);
    const p = hero(0, 30, 20); // torche pleine
    updateMapMemory(m, room, [p], 0);
    const r = LIGHT_FULL_TILES;
    expect(isTileKnown(m, 30 + Math.floor(r), 20)).toBe(true);
    expect(isTileKnown(m, 30 + Math.ceil(r) + 1, 20)).toBe(false);
    expect(isTileKnown(m, 30, 20 + Math.ceil(r) + 1)).toBe(false);
    // Un disque, pas un rectangle : le coin du carré circonscrit reste dans le noir.
    expect(isTileKnown(m, 30 + Math.floor(r), 20 + Math.floor(r))).toBe(false);
    expect(m.knownCount).toBeLessThan((MAP_REVEAL_HALF_W_TILES * 2 + 1) * (MAP_REVEAL_HALF_H_TILES * 2 + 1) / 2);
  });

  it('une torche presque éteinte découvre bien moins ; un héros à terre garde au plus la lueur minimale', () => {
    const room = bigRoom({ dark: true });
    const full = createMapMemory(room);
    updateMapMemory(full, room, [hero(0, 30, 20)], 0);
    const low = createMapMemory(room);
    updateMapMemory(low, room, [hero(0, 30, 20, { torchMs: 0 })], 0);
    expect(low.knownCount).toBeLessThan(full.knownCount / 3);
    expect(heroLightRadiusTiles({ torchMs: TORCH_MAX_MS, status: 'down' })).toBeCloseTo(LIGHT_EMPTY_TILES, 9);
    expect(heroLightRadiusTiles({ torchMs: TORCH_MAX_MS, status: 'alive' })).toBeCloseTo(LIGHT_FULL_TILES, 9);
    expect(heroLightRadiusTiles({ torchMs: Number.NaN, status: 'alive' })).toBeCloseTo(LIGHT_EMPTY_TILES, 9);
  });

  it("la torche qui baisse sans que le héros bouge ne retire rien, et un rayon qui change relance le calcul", () => {
    const room = bigRoom({ dark: true });
    const m = createMapMemory(room);
    const p = hero(0, 30, 20, { torchMs: TORCH_MAX_MS * 0.3 });
    updateMapMemory(m, room, [p], 0);
    const n = m.knownCount;
    p.torchMs = TORCH_MAX_MS; // il rallume à un brasero : la lumière grandit sur place
    expect(updateMapMemory(m, room, [p], 100).changed).toBe(true);
    expect(m.knownCount).toBeGreaterThan(n);
    p.torchMs = 0;
    expect(updateMapMemory(m, room, [p], 200).changed).toBe(false);
    expect(m.knownCount).toBeGreaterThan(n);
  });

  it('la même position en salle claire et sombre : la sombre découvre moins', () => {
    const lit = bigRoom();
    const dark = bigRoom({ dark: true });
    const a = createMapMemory(lit);
    const b = createMapMemory(dark);
    updateMapMemory(a, lit, [hero(0, 30, 20)], 0);
    updateMapMemory(b, dark, [hero(0, 30, 20)], 0);
    expect(b.knownCount).toBeLessThan(a.knownCount);
  });
});

describe('découverte : toutes les salles réelles', () => {
  it('chaque salle : le départ des joueurs est découvert, jamais plus de tuiles que la grille, remise à zéro propre', () => {
    for (const level of LEVELS) {
      const m = createMapMemory(level.rooms[0]);
      for (const room of level.rooms) {
        const players = room.playerSpawns.slice(0, 4).map((s, i) => hero(i as PlayerId, s[0], s[1]));
        const r = updateMapMemory(m, room, players, 0);
        expect(m.roomId).toBe(room.id);
        expect(m.cols * m.rows).toBe(m.known.length);
        expect(m.knownCount).toBeGreaterThan(0);
        expect(m.knownCount).toBeLessThanOrEqual(m.cols * m.rows);
        for (const p of players) expect(isTileKnown(m, Math.floor(p.pos.x / TILE), Math.floor(p.pos.y / TILE))).toBe(true);
        void r;
      }
    }
  });
});

// ───────────────────────────── Pions ─────────────────────────────

describe('computeMarkers : états et priorités', () => {
  it("un pion par joueur présent, avec la couleur du joueur ; les absents n'en ont pas", () => {
    const two = computeMarkers([hero(0, 3, 4), hero(1, 5, 6)]);
    expect(two.map((m) => m.id)).toEqual([0, 1]);
    expect(two[0].color).toBe(PLAYER_COLORS[0]);
    expect(two[1].color).toBe(PLAYER_COLORS[1]);
    expect([two[0].x, two[0].y]).toEqual([3 * TILE + TILE / 2, 4 * TILE + TILE / 2]);
    expect(computeMarkers([hero(0, 1, 1)])).toHaveLength(1);
    expect(computeMarkers([])).toHaveLength(0);
  });

  it('vivant sans souci : aucun drapeau (point plein)', () => {
    const [m] = computeMarkers([hero(0, 1, 1)]);
    expect([m.down, m.heal, m.calling]).toEqual([false, false, false]);
  });

  it('appel manuel (callMs > 0) et appel automatique (autoCall) : calling', () => {
    expect(computeMarkers([hero(0, 1, 1, { callMs: 1500 })])[0].calling).toBe(true);
    expect(computeMarkers([hero(0, 1, 1, { callMs: 0 })])[0].calling).toBe(false);
    const auto = hero(0, 1, 1, { autoCall: { icon: 'heart', ref: 'p1', ms: 2000, to: [1] } });
    expect(computeMarkers([auto])[0].calling).toBe(true);
    const expired = hero(0, 1, 1, { autoCall: { icon: 'heart', ref: 'p1', ms: 0, to: [1] } });
    expect(computeMarkers([expired])[0].calling).toBe(false);
  });

  it("à soigner : PV au seuil de la croix rouge (constante de balance.ts) ou suivi de croix présent", () => {
    const max = 100;
    const atThreshold = hero(0, 1, 1, { maxHp: max, hp: max * CROSS_CALL_THRESHOLD });
    expect(computeMarkers([atThreshold])[0].heal).toBe(true);
    expect(computeMarkers([hero(0, 1, 1, { maxHp: max, hp: max * CROSS_CALL_THRESHOLD + 1 })])[0].heal).toBe(false);
    // Croix déjà partie (réarmement à 60 %) : reste « à soigner » même au-dessus du seuil.
    expect(computeMarkers([hero(0, 1, 1, { maxHp: max, hp: 45, autoCallCross: { ms: 5000 } })])[0].heal).toBe(true);
    expect(computeMarkers([hero(0, 1, 1, { maxHp: max, hp: 100 })])[0].heal).toBe(false);
  });

  it("à terre : prioritaire, ni appel ni soins (la croix ✕ marque l'endroit où il est tombé)", () => {
    const down = hero(2, 7, 9, {
      status: 'down',
      hp: 0,
      callMs: 2000,
      autoCallCross: { ms: 100 },
      autoCall: { icon: 'cross', ref: 'x', ms: 1000, to: [0] },
    });
    const [m] = computeMarkers([down]);
    expect([m.down, m.heal, m.calling]).toEqual([true, false, false]);
    expect([m.x, m.y]).toEqual([7 * TILE + TILE / 2, 9 * TILE + TILE / 2]);
  });

  it("l'appel se cumule avec la croix médicale (point qui clignote + croix)", () => {
    const [m] = computeMarkers([hero(0, 1, 1, { maxHp: 100, hp: 20, callMs: 800, autoCall: { icon: 'cross', ref: 'x', ms: 2000, to: [1] } })]);
    expect([m.down, m.heal, m.calling]).toEqual([false, true, true]);
  });

  it('réutilise le tableau passé : mêmes objets, longueur ajustée, rien ne traîne', () => {
    const out = computeMarkers([hero(0, 1, 1), hero(1, 2, 2), hero(2, 3, 3)]);
    const first = out[0];
    const again = computeMarkers([hero(0, 4, 4, { callMs: 100 }), hero(1, 2, 2)], out);
    expect(again).toBe(out);
    expect(again[0]).toBe(first);
    expect(again).toHaveLength(2);
    expect(again[0].calling).toBe(true);
    expect(again[0].x).toBe(4 * TILE + TILE / 2);
  });
});

describe('markerVisual : formes et clignotement', () => {
  const vis = createMarkerVisual();

  it('point plein sans signal', () => {
    markerVisual({ down: false, heal: false, calling: false }, 123, vis);
    expect(vis).toMatchObject({ dotAlpha: 1, ringVisible: false, healCross: false, downCross: false });
  });

  it("à terre : croix ✕ + point atténué, ni anneau ni croix médicale (même si l'appel / les soins sont posés)", () => {
    markerVisual({ down: true, heal: true, calling: true }, 77, vis);
    expect(vis).toMatchObject({ dotAlpha: MARKER_DOWN_DOT_ALPHA, ringVisible: false, healCross: false, downCross: true });
  });

  it("à soigner : croix médicale, point plein ; avec appel : croix ET clignotement", () => {
    markerVisual({ down: false, heal: true, calling: false }, 10, vis);
    expect(vis).toMatchObject({ dotAlpha: 1, ringVisible: false, healCross: true, downCross: false });
    markerVisual({ down: false, heal: true, calling: true }, 10, vis);
    expect(vis.healCross).toBe(true);
    expect(vis.ringVisible).toBe(true);
  });

  it('appel : le point pulse entre MIN et 1, anneau qui grossit et pâlit, périodique', () => {
    let lo = 1;
    let hi = 0;
    let ringLo = 9;
    let ringHi = 0;
    for (let t = 0; t < MARKER_BLINK_PERIOD_MS; t += 5) {
      markerVisual({ down: false, heal: false, calling: true }, t, vis);
      expect(vis.ringVisible).toBe(true);
      lo = Math.min(lo, vis.dotAlpha);
      hi = Math.max(hi, vis.dotAlpha);
      ringLo = Math.min(ringLo, vis.ringScale);
      ringHi = Math.max(ringHi, vis.ringScale);
      expect(vis.ringAlpha).toBeGreaterThan(0);
      expect(vis.ringAlpha).toBeLessThanOrEqual(1);
    }
    expect(lo).toBeGreaterThanOrEqual(MARKER_CALL_MIN_ALPHA - 1e-9);
    expect(lo).toBeLessThan(MARKER_CALL_MIN_ALPHA + 0.05);
    expect(hi).toBeGreaterThan(0.95);
    expect(ringLo).toBeGreaterThanOrEqual(1);
    expect(ringHi).toBeGreaterThan(1.5);
  });

  it('le clignotement ne dépend que du temps (2 Hz, indépendant du nombre de frames) et reste dans [0, 1]', () => {
    expect(MARKER_BLINK_PERIOD_MS).toBe(500);
    for (let t = 0; t < 5000; t += 7) {
      const v = blinkPulse(t);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      expect(blinkPulse(t + MARKER_BLINK_PERIOD_MS)).toBeCloseTo(v, 9);
    }
    // 60 fps et 144 fps échantillonnent la même fonction du temps.
    expect(blinkPulse(1000 / 3)).toBe(blinkPulse(1000 / 3));
    expect(blinkPulse(Number.NaN)).toBe(1);
  });
});

// ───────────────────────────── Placement ─────────────────────────────

/** Toutes les salles réelles avec leurs dimensions. */
const REAL_ROOMS = LEVELS.flatMap((l) => l.rooms.map((r) => ({ level: l.id, room: r, ...roomGridSize(r) })));

function inside(inner: ScreenRect, outer: ScreenRect): boolean {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
}

describe('mapBoxFor : boîte de la carte', () => {
  it('2 à 4 joueurs : exactement la zone réservée de mapZone.ts ; elle contient le croisement / séparateur central', () => {
    for (const n of [2, 3, 4]) {
      const layout = computeLayout(n);
      expect(mapBoxFor(layout)).toEqual(mapZone(layout));
      const box = mapBoxFor(layout);
      expect(Math.abs(box.x + box.w / 2 - GAME_WIDTH / 2)).toBeLessThanOrEqual(1);
      expect(Math.abs(box.y + box.h / 2 - GAME_HEIGHT / 2)).toBeLessThanOrEqual(1);
    }
  });

  it('1 joueur : bord droit, centrée verticalement, plus petite que la zone centrale', () => {
    const layout = computeLayout(1);
    const box = mapBoxFor(layout);
    const zone = mapZone(computeLayout(2))!;
    expect(box.w).toBeLessThan(zone.w);
    expect(box.h).toBeLessThanOrEqual(zone.h);
    expect(box.x + box.w).toBeLessThanOrEqual(GAME_WIDTH);
    expect(box.x + box.w).toBeGreaterThan(GAME_WIDTH - 20); // collée au bord droit
    expect(Math.abs(box.y + box.h / 2 - GAME_HEIGHT / 2)).toBeLessThanOrEqual(1);
    // Ne couvre pas le centre de l'écran où se tient le héros (vue centrée sur lui).
    expect(box.x).toBeGreaterThan(GAME_WIDTH * 0.8);
  });
});

describe('placeMap / mapPlacement : la carte tient toujours', () => {
  const sizes: [number, number][] = [
    [GAME_WIDTH, GAME_HEIGHT],
    [GAME_WIDTH / 2, GAME_HEIGHT / 2],
  ];

  it('salles réelles des 9 niveaux x 1-4 joueurs x 1280x720 et 640x360 : dans la boîte, échelle entière >= 1, taille > 0', () => {
    expect(REAL_ROOMS.length).toBeGreaterThanOrEqual(9 * 5);
    let checked = 0;
    for (const [w, h] of sizes) {
      for (let n = 1; n <= 4; n++) {
        const layout = computeLayout(n, w, h);
        const box = mapBoxFor(layout, w, h);
        for (const { level, room, cols, rows } of REAL_ROOMS) {
          const pl = mapPlacement(layout, cols, rows, w, h);
          const tag = `${level}/${room.id} n=${n} ${w}x${h}`;
          expect(Number.isInteger(pl.scale), `échelle entière ${tag}`).toBe(true);
          expect(pl.scale, `échelle >= 1 ${tag}`).toBeGreaterThanOrEqual(1);
          expect(pl.scale, `échelle <= max ${tag}`).toBeLessThanOrEqual(n < 2 ? MAP_SCALE_MAX_SINGLE : MAP_SCALE_MAX_SHARED);
          expect(pl.map.w, tag).toBe(cols * pl.scale);
          expect(pl.map.h, tag).toBe(rows * pl.scale);
          expect(pl.map.w).toBeGreaterThan(0);
          expect(pl.map.h).toBeGreaterThan(0);
          expect(inside(pl.map, pl.panel), `carte dans le panneau ${tag}`).toBe(true);
          expect(inside(pl.panel, box), `panneau dans la boîte ${tag}`).toBe(true);
          expect(pl.panel.w - pl.map.w).toBe(2 * pl.pad);
          expect(Number.isInteger(pl.map.x) && Number.isInteger(pl.map.y), `pixels entiers ${tag}`).toBe(true);
          checked++;
        }
      }
    }
    expect(checked).toBe(REAL_ROOMS.length * 4 * 2);
  });

  it('à 2-4 joueurs la carte reste dans la zone centrale réservée (aucun texte permanent n\'y est)', () => {
    for (let n = 2; n <= 4; n++) {
      const layout = computeLayout(n);
      const zone = mapZone(layout)!;
      for (const { cols, rows } of REAL_ROOMS) expect(inside(mapPlacement(layout, cols, rows).panel, zone)).toBe(true);
    }
  });

  it('centrée dans la zone partagée ; collée au bord droit de sa boîte à 1 vue', () => {
    const l2 = computeLayout(2);
    const box = mapBoxFor(l2);
    const pl = mapPlacement(l2, 60, 38);
    expect(Math.abs(pl.panel.x + pl.panel.w / 2 - (box.x + box.w / 2))).toBeLessThanOrEqual(1);
    expect(Math.abs(pl.panel.y + pl.panel.h / 2 - (box.y + box.h / 2))).toBeLessThanOrEqual(1);
    const l1 = computeLayout(1);
    const b1 = mapBoxFor(l1);
    const p1 = mapPlacement(l1, 60, 38);
    expect(p1.panel.x + p1.panel.w).toBe(b1.x + b1.w);
  });

  it('prend la plus grande échelle entière qui tient (jusqu\'au maximum)', () => {
    const box: ScreenRect = { x: 100, y: 100, w: 301, h: 200 };
    expect(placeMap(10, 10, box, 3).scale).toBe(MAP_SCALE_MAX_SHARED); // petite salle : plafonnée
    expect(placeMap(60, 38, box, 3, 9).scale).toBe(4); // (301-6)/60 = 4,9 ; (200-6)/38 = 5,1
    expect(placeMap(86, 52, box, 3, 9).scale).toBe(3); // (200-6)/52 = 3,7
    expect(placeMap(86, 52, { x: 0, y: 0, w: 150, h: 100 }, 2).scale).toBe(1);
  });

  it("salle démesurée / boîte minuscule : échelle fractionnaire, mais elle TIENT, taille jamais nulle ni négative", () => {
    const box: ScreenRect = { x: 10, y: 10, w: 40, h: 30 };
    for (const [c, r] of [[500, 300], [86, 52], [1, 1], [0, 0], [-5, 3], [Number.NaN, 8]] as const) {
      const pl = placeMap(c, r, box, 3);
      expect(pl.scale).toBeGreaterThan(0);
      expect(pl.map.w).toBeGreaterThan(0);
      expect(pl.map.h).toBeGreaterThan(0);
      expect(inside(pl.panel, box)).toBe(true);
    }
    expect(placeMap(500, 300, box, 3).scale).toBeLessThan(1);
    const tiny = placeMap(86, 52, { x: 0, y: 0, w: 2, h: 2 }, 3);
    expect(tiny.scale).toBeGreaterThan(0);
  });

  it('marge adaptée à la taille de l\'écran', () => {
    expect(mapPadFor(GAME_WIDTH)).toBe(3);
    expect(mapPadFor(GAME_WIDTH / 2)).toBe(2);
    expect(mapPadFor(10)).toBe(1);
  });
});

describe('worldToMapPx : du monde à la carte', () => {
  it('place les coins de la salle sur les coins de la carte et reste borné', () => {
    const layout = computeLayout(3);
    const pl = mapPlacement(layout, 64, 38);
    const out = { x: 0, y: 0 };
    worldToMapPx(pl, 0, 0, out);
    expect(out).toEqual({ x: pl.map.x, y: pl.map.y });
    worldToMapPx(pl, 64 * TILE, 38 * TILE, out);
    expect(out).toEqual({ x: pl.map.x + pl.map.w, y: pl.map.y + pl.map.h });
    worldToMapPx(pl, -999, 99999, out);
    expect(out.x).toBe(pl.map.x);
    expect(out.y).toBe(pl.map.y + pl.map.h);
    worldToMapPx(pl, 10 * TILE, 5 * TILE, out);
    expect(out).toEqual({ x: pl.map.x + 10 * pl.scale, y: pl.map.y + 5 * pl.scale });
    worldToMapPx(pl, Number.NaN, 0, out);
    expect(Number.isFinite(out.x)).toBe(true);
  });
});

describe('heroUnderMap : le héros ne doit pas se retrouver sous la carte (1 vue)', () => {
  const panel: ScreenRect = { x: 1000, y: 280, w: 180, h: 150 };
  it('vrai quand le sprite (ou sa marge) recouvre le panneau, faux sinon', () => {
    expect(heroUnderMap(panel, 1100, 350, 3)).toBe(true);
    expect(heroUnderMap(panel, 640, 360, 3)).toBe(false); // héros centré
    expect(heroUnderMap(panel, 990, 350, 3)).toBe(true); // contre le bord : le sprite (24 px de demi-côté) touche
    expect(heroUnderMap(panel, 700, 350, 3)).toBe(false);
    expect(heroUnderMap(panel, 1100, 100, 3)).toBe(false); // au-dessus
    expect(heroUnderMap(panel, Number.NaN, 350, 3)).toBe(false);
  });
});

// ───────────────────────────── Préférence ─────────────────────────────

describe('préférence visible / masquée (touche Tab)', () => {
  function fake(initial?: string): MapStorage & { data: Map<string, string> } {
    const data = new Map<string, string>();
    if (initial !== undefined) data.set(MAP_VISIBLE_STORAGE_KEY, initial);
    return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
  }

  it('visible par défaut ; mémorise et relit', () => {
    const s = fake();
    expect(loadMapVisible(s)).toBe(true);
    saveMapVisible(false, s);
    expect(s.data.get(MAP_VISIBLE_STORAGE_KEY)).toBe('0');
    expect(loadMapVisible(s)).toBe(false);
    saveMapVisible(true, s);
    expect(loadMapVisible(s)).toBe(true);
    expect(loadMapVisible(fake('n importe quoi'))).toBe(true);
  });

  it("fonctionne sans stockage : absent, qui lève à la lecture, ou qui lève à l'écriture", () => {
    expect(loadMapVisible(null)).toBe(true);
    expect(() => saveMapVisible(false, null)).not.toThrow();
    const broken: MapStorage = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    expect(loadMapVisible(broken)).toBe(true);
    expect(() => saveMapVisible(false, broken)).not.toThrow();
  });

  it('sous Node (aucun localStorage) : valeurs par défaut sans erreur', () => {
    expect(() => loadMapVisible()).not.toThrow();
    expect(() => saveMapVisible(true)).not.toThrow();
  });

  it('clé du toast de bascule', () => {
    expect(mapToggleMessageKey(true)).toBe('map.shown');
    expect(mapToggleMessageKey(false)).toBe('map.hidden');
  });
});

describe('disposition : la zone centrale ne recouvre que ce qui doit (cohérence avec splitscreen)', () => {
  it('à 2-4 joueurs la boîte coupe le séparateur vertical ; à 1 joueur elle est entièrement dans la vue', () => {
    for (const n of [2, 3, 4]) {
      const layout = computeLayout(n);
      const box = mapBoxFor(layout);
      expect(layout.separators.some((s) => rectsOverlap(s, box))).toBe(true);
    }
    const l1 = computeLayout(1);
    expect(inside(mapBoxFor(l1), l1.viewports[0])).toBe(true);
  });
});

// ───────────────────────────── Non-régressions (relecture du chantier) ─────────────────────────────

describe('heroesUnderMap : fondu généralisé à toutes les vues', () => {
  const roomPx = { w: 86 * TILE, h: 52 * TILE };
  /** Centre de caméra comme `stepCameraCenter` : suit le héros, borné aux limites de la salle (la vue ne sort pas de la salle). */
  const clampedCenter = (pos: { x: number; y: number }, vp: { w: number; h: number; zoom: number }): { x: number; y: number } => ({
    x: Math.max(vp.w / vp.zoom / 2, Math.min(roomPx.w - vp.w / vp.zoom / 2, pos.x)),
    y: Math.max(vp.h / vp.zoom / 2, Math.min(roomPx.h - vp.h / vp.zoom / 2, pos.y)),
  });

  it('2 joueurs, salle 86x52 : un héros sur la dernière tuile praticable de la ligne médiane passe sous le panneau (il était masqué par la carte)', () => {
    const layout = computeLayout(2);
    const placement = mapPlacement(layout, 86, 52);
    const h = hero(0, 83, 20);
    const centers = [clampedCenter(h.pos, layout.viewports[0]), clampedCenter(h.pos, layout.viewports[1])];
    expect(heroesUnderMap(layout.viewports, placement.panel, [h], (v) => centers[v])).toBe(true);
    // même héros au milieu de la salle : la caméra le centre, la carte est loin
    const mid = hero(0, 40, 26);
    const midCenters = [clampedCenter(mid.pos, layout.viewports[0]), clampedCenter(mid.pos, layout.viewports[1])];
    expect(heroesUnderMap(layout.viewports, placement.panel, [mid], (v) => midCenters[v])).toBe(false);
  });

  it.each([3, 4])('%i joueurs : le coin sud-est de la vue du haut à gauche est couvert par la carte', (n) => {
    const layout = computeLayout(n);
    const placement = mapPlacement(layout, 86, 52);
    const h = hero(0, 83, 50);
    const centers = layout.viewports.map((vp) => clampedCenter(h.pos, vp));
    expect(heroesUnderMap(layout.viewports, placement.panel, [h], (v) => centers[v])).toBe(true);
  });

  it('un héros hors du rectangle d\'une vue n\'y est pas dessiné : il ne déclenche pas le fondu de cette vue', () => {
    const layout = computeLayout(2);
    const placement = mapPlacement(layout, 86, 52);
    const far = hero(1, 10, 10);
    // la vue 0 est centrée à l'autre bout de la salle : le héros est très loin à l'écran ; la vue 1 n'est pas interrogée
    expect(heroesUnderMap([layout.viewports[0]], placement.panel, [far], () => ({ x: 80 * TILE, y: 40 * TILE }))).toBe(false);
  });

  it('1 vue : même résultat que `heroUnderMap` sur chaque héros ; aucune vue : jamais', () => {
    const layout = computeLayout(1);
    const placement = mapPlacement(layout, 86, 52);
    const vp = layout.viewports[0];
    const h = hero(0, 70, 26);
    const cam = { x: h.pos.x - (placement.panel.x + placement.panel.w / 2 - (vp.x + vp.w / 2)) / vp.zoom, y: h.pos.y - (placement.panel.y + placement.panel.h / 2 - (vp.y + vp.h / 2)) / vp.zoom };
    expect(heroesUnderMap(layout.viewports, placement.panel, [h], () => cam)).toBe(true);
    expect(heroesUnderMap([], placement.panel, [h], () => cam)).toBe(false);
  });
});

describe('pions : priorité d\'affichage et taille minimale lisible', () => {
  const flags = { down: false, heal: false, calling: false };

  it('priorité : à terre (3) > à soigner (2) > appel (1) > normal (0)', () => {
    expect(markerPriority(flags)).toBe(0);
    expect(markerPriority({ ...flags, calling: true })).toBe(1);
    expect(markerPriority({ ...flags, heal: true })).toBe(2);
    expect(markerPriority({ ...flags, heal: true, calling: true })).toBe(2); // appel + soins : la croix médicale prime
    expect(markerPriority({ ...flags, down: true, heal: true, calling: true })).toBe(3);
  });

  it('profondeur du point : croît avec la priorité, puis avec l\'identifiant ; reste sous les croix (base + 0.2)', () => {
    const base = 16.3;
    const d = (id: number, f: Partial<typeof flags>): number => markerDotDepth(base, { id: id as PlayerId, ...flags, ...f });
    // le point d'un héros à terre / à soigner / qui appelle passe AU-DESSUS de celui d'un héros normal d'identifiant plus élevé
    expect(d(0, { down: true })).toBeGreaterThan(d(3, { heal: true }));
    expect(d(0, { heal: true })).toBeGreaterThan(d(3, { calling: true }));
    expect(d(0, { calling: true })).toBeGreaterThan(d(3, {}));
    // à priorité égale : l'identifiant le plus haut dessus (ordre stable)
    expect(d(2, {})).toBeGreaterThan(d(1, {}));
    for (let id = 0; id < 4; id++) for (const f of [{}, { calling: true }, { heal: true }, { down: true }]) {
      expect(d(id, f)).toBeGreaterThanOrEqual(base);
      expect(d(id, f)).toBeLessThan(base + 0.2);
    }
  });

  it('taille : normale à 3 px par tuile ou plus, agrandie en dessous ; les croix sont plus grandes que le point', () => {
    expect(markerSizeFactor(3)).toBe(1);
    expect(markerSizeFactor(2)).toBe(MARKER_SMALL_MAP_FACTOR);
    expect(markerSizeFactor(0.8)).toBe(MARKER_SMALL_MAP_FACTOR);
    expect(MARKER_SMALL_MAP_FACTOR).toBeGreaterThan(1);
    expect(MARKER_HEAL_HALF).toBeGreaterThan(MARKER_DOT_RADIUS);
    expect(MARKER_DOWN_HALF).toBeGreaterThan(MARKER_HEAL_HALF);
    expect(MARKER_DOWN_LINE).toBeGreaterThanOrEqual(3); // un trait de 1,5 px (ancien rendu à 640x360) n'était plus un ✕ lisible
  });
});

describe('appui long sur le panneau (MapPress)', () => {
  it('bascule quand la durée atteint le seuil, exactement au seuil', () => {
    const p = new MapPress();
    p.down(1000);
    expect(p.up(1000 + MAP_LONG_PRESS_MS - 1)).toBeNull();
    p.down(2000);
    expect(p.up(2000 + MAP_LONG_PRESS_MS)).toBe('toggle');
    p.down(3000);
    expect(p.up(3000 + MAP_LONG_PRESS_MS * 10)).toBe('toggle'); // au-delà aussi
  });

  it('appui court : rien ; up sans down : rien ; cancel annule ; après un up, un nouvel appui repart de zéro', () => {
    const p = new MapPress();
    expect(p.up(500)).toBeNull(); // jamais de down
    expect(p.pressing).toBe(false);
    p.down(100);
    expect(p.pressing).toBe(true);
    expect(p.up(100 + MAP_LONG_PRESS_MS - 1)).toBeNull();
    expect(p.pressing).toBe(false);
    p.down(100);
    p.cancel();
    expect(p.pressing).toBe(false);
    expect(p.up(100 + MAP_LONG_PRESS_MS * 2)).toBeNull(); // annulé : même une longue durée ne compte plus
    p.down(5000);
    expect(p.up(5000 + MAP_LONG_PRESS_MS)).toBe('toggle');
    expect(p.pressing).toBe(false);
  });

  it('un second down pendant un appui en cours repart du nouveau début', () => {
    const p = new MapPress();
    p.down(0);
    p.down(1000); // re-appui (rebond) : on repart de 1000
    expect(p.up(1000 + MAP_LONG_PRESS_MS - 1)).toBeNull();
    expect(p.up(1000 + MAP_LONG_PRESS_MS)).toBeNull(); // up sans down actif
  });
});
