import { describe, expect, it } from 'vitest';
import { INTERACT_RANGE, PLAYER_RADIUS, SIM_STEP_MS, TILE, TORCH_LOW_FRACTION, TORCH_MAX_MS } from './constants';
import { canOccupy } from './collision';
import { RoomGrid } from './grid';
import { makeTestLayout, makeTestRoom } from './levelValidation';
import {
  areAllRequirementsMet,
  brazierAction,
  createRoomMechanisms,
  isRequirementMet,
  isTileBlockedByMechanism,
  mechanismBlocksProjectile,
  mechanismSolidRects,
  tileCenterPx,
  updateMechanisms,
  type RequirementContext,
} from './mechanisms';
import { createPlayerState, resetPlayersForRoom, stepPlayerTorch } from './players';
import type {
  BrazierState,
  DoorState,
  MechanismDef,
  MechanismState,
  PlayerId,
  PlayerState,
  RoomDef,
  SimEvent,
  TileXY,
} from './types';

// ───────────────────────────── Joueurs : torche ─────────────────────────────

function mkPlayer(id: PlayerId, tile: TileXY = [2, 2]): PlayerState {
  const c = tileCenterPx(tile);
  return createPlayerState({ id, characterId: 'david', difficulty: 2 }, c);
}

describe('createPlayerState / resetPlayersForRoom : torche', () => {
  it('torche pleine à la création', () => {
    expect(mkPlayer(0).torchMs).toBe(TORCH_MAX_MS);
  });

  it('resetPlayersForRoom remplit les torches (même à 0)', () => {
    const ps = [mkPlayer(0), mkPlayer(1)];
    ps[0].torchMs = 0;
    ps[1].torchMs = 1234;
    resetPlayersForRoom(ps, [{ x: 10, y: 10 }]);
    expect(ps.map((p) => p.torchMs)).toEqual([TORCH_MAX_MS, TORCH_MAX_MS]);
  });
});

describe('stepPlayerTorch', () => {
  const thr = TORCH_MAX_MS * TORCH_LOW_FRACTION;

  it('salle claire : aucun effet', () => {
    const p = mkPlayer(0);
    expect(stepPlayerTorch(p, 1000, false)).toEqual([]);
    expect(p.torchMs).toBe(TORCH_MAX_MS);
  });

  it('salle sombre : 1 ms de combustible par ms de jeu', () => {
    const p = mkPlayer(0);
    stepPlayerTorch(p, 1000, true);
    expect(p.torchMs).toBe(TORCH_MAX_MS - 1000);
    stepPlayerTorch(p, SIM_STEP_MS, true);
    expect(p.torchMs).toBeCloseTo(TORCH_MAX_MS - 1000 - SIM_STEP_MS, 6);
  });

  it('un joueur à terre ne consomme pas', () => {
    const p = mkPlayer(0);
    p.status = 'down';
    expect(stepPlayerTorch(p, 5000, true)).toEqual([]);
    expect(p.torchMs).toBe(TORCH_MAX_MS);
  });

  it('dt non positif ou NaN : aucun effet', () => {
    const p = mkPlayer(0);
    expect(stepPlayerTorch(p, 0, true)).toEqual([]);
    expect(stepPlayerTorch(p, -5, true)).toEqual([]);
    expect(stepPlayerTorch(p, Number.NaN, true)).toEqual([]);
    expect(p.torchMs).toBe(TORCH_MAX_MS);
  });

  it('torchLow émis UNE seule fois au franchissement du seuil', () => {
    const p = mkPlayer(0);
    p.torchMs = thr + 10;
    expect(stepPlayerTorch(p, 5, true)).toEqual([]);
    expect(stepPlayerTorch(p, 10, true)).toEqual([{ type: 'torchLow', playerId: 0 }]);
    expect(stepPlayerTorch(p, 100, true)).toEqual([]);
    expect(stepPlayerTorch(p, 100, true)).toEqual([]);
  });

  it('torchOut à 0, une seule fois, plancher à 0', () => {
    const p = mkPlayer(1);
    p.torchMs = 50; // déjà sous le seuil « faible » : seul torchOut est émis
    const ev = stepPlayerTorch(p, 100, true);
    expect(ev).toEqual([{ type: 'torchOut', playerId: 1 }]);
    // franchissement direct du seuil jusqu'à 0 (gros pas) : low puis out
    const q = mkPlayer(2);
    q.torchMs = thr + 10;
    expect(stepPlayerTorch(q, 1e6, true)).toEqual([{ type: 'torchLow', playerId: 2 }, { type: 'torchOut', playerId: 2 }]);
    expect(p.torchMs).toBe(0);
    expect(stepPlayerTorch(p, 100, true)).toEqual([]);
    expect(p.torchMs).toBe(0);
  });

  it('après une recharge, les alertes se redéclenchent', () => {
    const p = mkPlayer(0);
    p.torchMs = thr - 1;
    expect(stepPlayerTorch(p, 1, true)).toEqual([]); // déjà sous le seuil : pas de nouvel événement low
    p.torchMs = TORCH_MAX_MS; // recharge
    p.torchMs = thr + 1;
    expect(stepPlayerTorch(p, 2, true)).toEqual([{ type: 'torchLow', playerId: 0 }]);
  });

  it('durée totale = TORCH_MAX_MS', () => {
    const p = mkPlayer(0);
    let ticks = 0;
    let out = false;
    while (!out && ticks < 100000) {
      ticks++;
      out = stepPlayerTorch(p, 100, true).some((e) => e.type === 'torchOut');
    }
    expect(ticks * 100).toBeCloseTo(TORCH_MAX_MS, -2);
  });

  it('valeur corrompue (NaN) : ramenée à 0 sans planter', () => {
    const p = mkPlayer(0);
    p.torchMs = Number.NaN;
    expect(stepPlayerTorch(p, 100, true)).toEqual([]);
    expect(p.torchMs).toBe(0);
  });
});

// ───────────────────────────── Mécanismes : brasero ─────────────────────────────

class Harness {
  readonly grid: RoomGrid;
  readonly mechanisms: MechanismState[];
  readonly players: PlayerState[];
  readonly allEvents: SimEvent[] = [];
  zones: Record<string, boolean> = {};

  constructor(
    readonly room: RoomDef,
    readonly n: number,
  ) {
    this.grid = new RoomGrid(room.layout);
    this.mechanisms = createRoomMechanisms(room, n);
    this.players = Array.from({ length: n }, (_, i) => mkPlayer(i as PlayerId, room.playerSpawns[i]));
  }

  put(id: PlayerId, tile: TileXY, dx = 0, dy = 0): void {
    const c = tileCenterPx(tile);
    this.players[id].pos = { x: c.x + dx, y: c.y + dy };
  }

  press(ids: PlayerId[] = [0], ticks = 1): SimEvent[] {
    const out: SimEvent[] = [];
    for (let i = 0; i < ticks; i++) {
      const interactPressed: Partial<Record<PlayerId, boolean>> = {};
      if (i === 0) for (const id of ids) interactPressed[id] = true;
      out.push(
        ...updateMechanisms({
          room: this.room,
          grid: this.grid,
          mechanisms: this.mechanisms,
          players: this.players,
          frames: {},
          interactPressed,
          dtMs: SIM_STEP_MS,
          aliveEnemyCount: 0,
          objectiveDone: () => false,
          zoneOccupied: () => false,
          zoneEntered: (z) => this.zones[z] === true,
        }),
      );
    }
    this.allEvents.push(...out);
    return out;
  }

  get<T extends MechanismState>(id: string): T {
    const s = this.mechanisms.find((m) => m.id === id);
    if (!s) throw new Error(`mécanisme introuvable ${id}`);
    return s as T;
  }

  ctx(): RequirementContext {
    return {
      mechanisms: this.mechanisms,
      aliveEnemyCount: 0,
      objectiveDone: () => false,
      zoneOccupied: () => false,
      zoneEntered: (z) => this.zones[z] === true,
    };
  }
}

function roomWith(mechanisms: MechanismDef[], over: Partial<RoomDef> = {}): RoomDef {
  return makeTestRoom({ layout: makeTestLayout(16, 12), dark: true, mechanisms, ...over });
}

const types = (ev: readonly SimEvent[]): string[] => ev.map((e) => e.type);

describe('brasero : création', () => {
  it('lit:true ⇒ allumé d\'office ; sinon éteint ; waived ⇒ allumé', () => {
    const room = roomWith([
      { id: 'a', type: 'brazier', tile: [8, 6], lit: true },
      { id: 'b', type: 'brazier', tile: [9, 6] },
      { id: 'c', type: 'brazier', tile: [10, 6], minPlayers: 3 },
    ]);
    const st = createRoomMechanisms(room, 2) as BrazierState[];
    expect(st[0]).toMatchObject({ type: 'brazier', active: true, waived: false, litBy: null });
    expect(st[1]).toMatchObject({ type: 'brazier', active: false, waived: false, litBy: null });
    expect(st[2]).toMatchObject({ type: 'brazier', active: true, waived: true, litBy: null });
    const st3 = createRoomMechanisms(room, 3) as BrazierState[];
    expect(st3[2]).toMatchObject({ active: false, waived: false });
  });
});

describe('brasero : allumer', () => {
  const room = () => roomWith([{ id: 'b', type: 'brazier', tile: [8, 6] }]);

  it('un joueur à torche non vide l\'allume avec interact : événements brazierLit + mechanismChanged', () => {
    const h = new Harness(room(), 1);
    h.put(0, [7, 6]);
    const ev = h.press([0]);
    expect(h.get<BrazierState>('b')).toMatchObject({ active: true, litBy: 0 });
    expect(types(ev)).toEqual(['mechanismChanged', 'brazierLit']);
    expect(ev).toContainEqual({ type: 'brazierLit', brazierId: 'b', playerId: 0 });
  });

  it('il reste allumé (verrouillant)', () => {
    const h = new Harness(room(), 1);
    h.put(0, [7, 6]);
    h.press([0]);
    h.put(0, [2, 2]);
    h.press([], 30);
    expect(h.get<BrazierState>('b').active).toBe(true);
  });

  it('sans appui (front montant absent) : rien', () => {
    const h = new Harness(room(), 1);
    h.put(0, [7, 6]);
    expect(h.press([], 5)).toEqual([]);
    expect(h.get<BrazierState>('b').active).toBe(false);
  });

  it('torche vide : impossible d\'allumer, et l\'appui n\'est pas consommé', () => {
    const h = new Harness(room(), 1);
    h.put(0, [7, 6]);
    h.players[0].torchMs = 0;
    expect(h.press([0])).toEqual([]);
    expect(h.get<BrazierState>('b').active).toBe(false);
    // 1 ms de combustible suffit
    h.players[0].torchMs = 1;
    h.press([0]);
    expect(h.get<BrazierState>('b').active).toBe(true);
  });

  it('hors de portée : rien ; à la limite de portée : allume', () => {
    const h = new Harness(room(), 1);
    h.put(0, [3, 6]);
    expect(h.press([0])).toEqual([]);
    const c = tileCenterPx([8, 6]);
    h.players[0].pos = { x: c.x - INTERACT_RANGE + 0.01, y: c.y };
    h.press([0]);
    expect(h.get<BrazierState>('b').active).toBe(true);
  });

  it('un joueur à terre ne peut pas allumer', () => {
    const h = new Harness(room(), 1);
    h.put(0, [7, 6]);
    h.players[0].status = 'down';
    expect(h.press([0])).toEqual([]);
    expect(h.get<BrazierState>('b').active).toBe(false);
  });

  it('ownerSlot : seul le joueur désigné (slot % nbJoueurs) peut l\'allumer', () => {
    const r = roomWith([{ id: 'b', type: 'brazier', tile: [8, 6], ownerSlot: 1 }]);
    const h = new Harness(r, 2);
    h.put(0, [7, 6]);
    h.put(1, [9, 6]);
    expect(h.press([0])).toEqual([]);
    expect(h.get<BrazierState>('b').active).toBe(false);
    h.press([1]);
    expect(h.get<BrazierState>('b')).toMatchObject({ active: true, litBy: 1 });

    // à 1 joueur : slot 1 % 1 = 0
    const r1 = roomWith([{ id: 'b', type: 'brazier', tile: [8, 6], ownerSlot: 1 }]);
    const h1 = new Harness(r1, 1);
    h1.put(0, [7, 6]);
    h1.press([0]);
    expect(h1.get<BrazierState>('b').active).toBe(true);
  });

  it('waived (minPlayers > nbJoueurs) : déjà allumé, appui sans effet à torche pleine', () => {
    const r = roomWith([{ id: 'b', type: 'brazier', tile: [8, 6], minPlayers: 3 }]);
    const h = new Harness(r, 2);
    h.put(0, [7, 6]);
    expect(h.get<BrazierState>('b')).toMatchObject({ waived: true, active: true });
    expect(h.press([0])).toEqual([]);
    // mais il recharge quand même
    h.players[0].torchMs = 100;
    h.press([0]);
    expect(h.players[0].torchMs).toBe(TORCH_MAX_MS);
  });
});

describe('brasero : recharge', () => {
  const room = () => roomWith([{ id: 'b', type: 'brazier', tile: [8, 6], lit: true }]);

  it('interact à portée d\'un brasero allumé recharge la torche au max (torchRefueled)', () => {
    const h = new Harness(room(), 1);
    h.put(0, [7, 6]);
    h.players[0].torchMs = 1000;
    const ev = h.press([0]);
    expect(h.players[0].torchMs).toBe(TORCH_MAX_MS);
    expect(ev).toEqual([{ type: 'torchRefueled', playerId: 0, brazierId: 'b' }]);
  });

  it('recharge possible avec une torche vide', () => {
    const h = new Harness(room(), 1);
    h.put(0, [7, 6]);
    h.players[0].torchMs = 0;
    h.press([0]);
    expect(h.players[0].torchMs).toBe(TORCH_MAX_MS);
  });

  it('torche pleine : l\'appui ne fait rien et n\'est PAS consommé (le levier voisin le reçoit)', () => {
    const r = roomWith([
      { id: 'b', type: 'brazier', tile: [8, 6], lit: true },
      { id: 'lv', type: 'lever', tile: [8, 8] },
    ]);
    const h = new Harness(r, 1);
    // à portée du brasero (centre 8.5,6.5) ET du levier (centre 8.5,8.5)
    const c = tileCenterPx([8, 7]);
    h.players[0].pos = { x: c.x, y: c.y };
    expect(brazierAction(r.mechanisms[0] as never, h.get<BrazierState>('b'), h.players[0], 1)).toBeNull();
    const ev = h.press([0]);
    expect(types(ev)).not.toContain('torchRefueled');
    expect(h.get<{ active: boolean } & MechanismState>('lv').active).toBe(true);
  });

  it('priorité : levier > brasero quand les deux sont actionnables', () => {
    const r = roomWith([
      { id: 'b', type: 'brazier', tile: [8, 6], lit: true },
      { id: 'lv', type: 'lever', tile: [8, 8] },
    ]);
    const h = new Harness(r, 1);
    const c = tileCenterPx([8, 7]);
    h.players[0].pos = { x: c.x, y: c.y };
    h.players[0].torchMs = 10; // le brasero serait actionnable
    h.press([0]);
    expect(h.get<MechanismState>('lv').active).toBe(true);
    expect(h.players[0].torchMs).toBe(10); // pas de recharge : l'appui est consommé par le levier
    h.press([0]); // le levier est déjà actif : l'appui tombe sur le brasero
    expect(h.players[0].torchMs).toBe(TORCH_MAX_MS);
  });

  it('un appui = un seul brasero (le plus proche)', () => {
    const r = roomWith([
      { id: 'b1', type: 'brazier', tile: [7, 6] },
      { id: 'b2', type: 'brazier', tile: [9, 6] },
    ]);
    const h = new Harness(r, 1);
    const c = tileCenterPx([8, 6]);
    h.players[0].pos = { x: c.x + 3, y: c.y }; // plus proche de b2
    h.press([0]);
    expect(h.get<BrazierState>('b1').active).toBe(false);
    expect(h.get<BrazierState>('b2').active).toBe(true);
  });

  it('allumer puis recharger : cycle complet à 2 joueurs, deux appuis distincts', () => {
    const r = roomWith([{ id: 'b', type: 'brazier', tile: [8, 6] }]);
    const h = new Harness(r, 2);
    h.put(0, [7, 6]);
    h.put(1, [9, 6]);
    h.players[1].torchMs = 500;
    h.press([0]); // J0 allume
    expect(h.get<BrazierState>('b').litBy).toBe(0);
    h.press([1]); // J1 recharge
    expect(h.players[1].torchMs).toBe(TORCH_MAX_MS);
  });
});

describe('brasero : solidité', () => {
  const room = roomWith([{ id: 'b', type: 'brazier', tile: [8, 6], lit: true }]);

  it('occupe sa tuile (rectangle solide), même waived', () => {
    const st = createRoomMechanisms(room, 1);
    expect(mechanismSolidRects(room, st)).toEqual([{ x: 8 * TILE, y: 6 * TILE, w: TILE, h: TILE }]);
    const w = roomWith([{ id: 'b', type: 'brazier', tile: [8, 6], minPlayers: 4 }]);
    expect(mechanismSolidRects(w, createRoomMechanisms(w, 1))).toHaveLength(1);
  });

  it('bloque les personnages (canOccupy) et la tuile est signalée bloquée', () => {
    const st = createRoomMechanisms(room, 1);
    const grid = new RoomGrid(room.layout);
    const solids = mechanismSolidRects(room, st);
    const c = tileCenterPx([8, 6]);
    expect(canOccupy(c, PLAYER_RADIUS, grid, solids)).toBe(false);
    expect(canOccupy(tileCenterPx([6, 6]), PLAYER_RADIUS, grid, solids)).toBe(true);
    expect(isTileBlockedByMechanism(room, st, 8, 6)).toBe(true);
    expect(isTileBlockedByMechanism(room, st, 7, 6)).toBe(false);
    expect(mechanismBlocksProjectile(room, st, c)).toBe(true);
  });

  it('un bloc poussé ne passe pas à travers un brasero', () => {
    const r = roomWith([
      { id: 'blk', type: 'block', tile: [4, 4] },
      { id: 'br', type: 'brazier', tile: [6, 4] },
    ]);
    const h = new Harness(r, 2);
    h.put(0, [3, 4]);
    h.put(1, [3, 5]);
    const frames = { 0: { moveX: 1, moveY: 0, attack: false, interact: false, revive: false }, 1: { moveX: 1, moveY: 0, attack: false, interact: false, revive: false } };
    for (let i = 0; i < 60; i++) {
      updateMechanisms({
        room: h.room,
        grid: h.grid,
        mechanisms: h.mechanisms,
        players: h.players,
        frames,
        interactPressed: {},
        dtMs: SIM_STEP_MS,
        aliveEnemyCount: 0,
        objectiveDone: () => false,
        zoneOccupied: () => false,
      });
    }
    const blk = h.get<MechanismState & { tile: TileXY }>('blk');
    expect(blk.tile).toEqual([4, 4]);
  });
});

describe('exigences : brasero et enter:', () => {
  it('un brasero allumé satisfait un jeton « id » ; éteint non ; waived oui', () => {
    const r = roomWith([
      { id: 'b1', type: 'brazier', tile: [8, 6], lit: true },
      { id: 'b2', type: 'brazier', tile: [9, 6] },
      { id: 'b3', type: 'brazier', tile: [10, 6], minPlayers: 4 },
    ]);
    const h = new Harness(r, 1);
    const ctx = h.ctx();
    expect(isRequirementMet('b1', ctx)).toBe(true);
    expect(isRequirementMet('b2', ctx)).toBe(false);
    expect(isRequirementMet('b3', ctx)).toBe(true);
  });

  it('porte « allume les 3 braseros » : s\'ouvre quand le dernier est allumé', () => {
    const r = roomWith([
      { id: 'b1', type: 'brazier', tile: [4, 3] },
      { id: 'b2', type: 'brazier', tile: [4, 6] },
      { id: 'b3', type: 'brazier', tile: [4, 9] },
      { id: 'd', type: 'door', tiles: [[10, 5], [10, 6]], requires: ['b1', 'b2', 'b3'] },
    ]);
    const h = new Harness(r, 3);
    h.put(0, [5, 3]);
    h.put(1, [5, 6]);
    h.put(2, [5, 9]);
    h.press([0]);
    h.press([1]);
    expect(h.get<DoorState>('d').open).toBe(false);
    const ev = h.press([2]);
    expect(h.get<DoorState>('d').open).toBe(true);
    expect(ev).toContainEqual({ type: 'doorOpened', doorId: 'd' });
    expect(areAllRequirementsMet(['b1', 'b2', 'b3'], h.ctx())).toBe(true);
  });

  it('même porte à 2 joueurs : le 3e brasero (minPlayers 3) est waived', () => {
    const r = roomWith([
      { id: 'b1', type: 'brazier', tile: [4, 3] },
      { id: 'b2', type: 'brazier', tile: [4, 6] },
      { id: 'b3', type: 'brazier', tile: [4, 9], minPlayers: 3 },
      { id: 'd', type: 'door', tiles: [[10, 5]], requires: ['b1', 'b2', 'b3'] },
    ]);
    const h = new Harness(r, 2);
    h.put(0, [5, 3]);
    h.put(1, [5, 6]);
    h.press([0]);
    h.press([1]);
    expect(h.get<DoorState>('d').open).toBe(true);
  });

  it('enter:<zone> : satisfait quand zoneEntered le dit ; absent du contexte ⇒ faux', () => {
    const r = roomWith([{ id: 'p', type: 'plate', tile: [3, 3] }]);
    const h = new Harness(r, 1);
    expect(isRequirementMet('enter:z1', h.ctx())).toBe(false);
    h.zones.z1 = true;
    expect(isRequirementMet('enter:z1', h.ctx())).toBe(true);
    expect(isRequirementMet('enter:z2', h.ctx())).toBe(false);
    const { zoneEntered: _omit, ...legacy } = h.ctx();
    expect(isRequirementMet('enter:z1', legacy)).toBe(false);
  });

  it('une porte exigeant enter:<zone> s\'ouvre quand la zone est atteinte (et reste ouverte)', () => {
    const r = roomWith(
      [
        { id: 'p', type: 'plate', tile: [3, 3] },
        { id: 'd', type: 'door', tiles: [[10, 5]], requires: ['enter:z1'] },
      ],
      { zones: [{ id: 'z1', rect: { x: 5, y: 5, w: 2, h: 2 } }] },
    );
    const h = new Harness(r, 1);
    h.press([], 3);
    expect(h.get<DoorState>('d').open).toBe(false);
    h.zones.z1 = true;
    h.press([], 1);
    expect(h.get<DoorState>('d').open).toBe(true);
    h.zones.z1 = false;
    h.press([], 3);
    expect(h.get<DoorState>('d').open).toBe(true);
  });
});
