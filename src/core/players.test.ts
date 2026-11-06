import { describe, expect, it } from 'vitest';
import { damageToEnemy, damageToPlayer, maxHpFor, REVIVE_INVULN_MS } from './balance';
import { getCharacter } from './characters';
import {
  PLAYER_INVULN_MS,
  REVIVE_DURATION_MS,
  REVIVE_RANGE,
  SIM_STEP_MS,
} from './constants';
import {
  applyDamageToPlayer,
  countAlive,
  createPlayerState,
  isRescuing,
  isTeamWiped,
  resetPlayersForRoom,
  reviveAllDowned,
  stepPlayerTimers,
  updateRevive,
} from './players';
import type { CharacterId, Difficulty, PlayerId, PlayerState, SimEvent } from './types';

// ───────────── helpers ─────────────

function mk(id: PlayerId, characterId: CharacterId = 'david', difficulty: Difficulty = 2, x = 100, y = 100): PlayerState {
  return createPlayerState({ id, characterId, difficulty }, { x, y });
}

/** Tue un joueur (en passant par la vraie fonction de dégâts). */
function knockDown(p: PlayerState): void {
  p.invulnMs = 0;
  const r = applyDamageToPlayer(p, 100000);
  expect(r.downed).toBe(true);
}

interface Ctx {
  held: Set<PlayerId>;
  threat: boolean;
}

/** Joue `ms` millisecondes de relevage par pas de SIM_STEP_MS ; retourne tous les événements. */
function run(players: PlayerState[], ctx: Ctx, ms: number): SimEvent[] {
  const events: SimEvent[] = [];
  const steps = Math.round(ms / SIM_STEP_MS);
  for (let i = 0; i < steps; i++) {
    events.push(...updateRevive(players, (id) => ctx.held.has(id), () => ctx.threat, SIM_STEP_MS));
  }
  return events;
}

/** Joue jusqu'à ce que `p` soit relevé (max `limitMs`) ; retourne le temps écoulé en ms (ou -1). */
function timeToRevive(players: PlayerState[], target: PlayerState, ctx: Ctx, limitMs = 20000): number {
  let t = 0;
  while (t < limitMs) {
    updateRevive(players, (id) => ctx.held.has(id), () => ctx.threat, SIM_STEP_MS);
    t += SIM_STEP_MS;
    if (target.status === 'alive') return t;
  }
  return -1;
}

const ofType = <T extends SimEvent['type']>(events: SimEvent[], type: T) =>
  events.filter((e): e is Extract<SimEvent, { type: T }> => e.type === type);

// ───────────── création ─────────────

describe('createPlayerState', () => {
  it('PV pleins selon la résistance, vivant, orienté vers le bas', () => {
    const p = mk(0, 'david', 2, 48, 64);
    expect(p.maxHp).toBe(maxHpFor(getCharacter('david')));
    expect(p.hp).toBe(p.maxHp);
    expect(p.status).toBe('alive');
    expect(p.facing).toBe('down');
    expect(p.pos).toEqual({ x: 48, y: 64 });
    expect(p.revivingId).toBeNull();
    expect(p.reviverId).toBeNull();
    expect(p.keys).toEqual([]);
    expect(p.downCount).toBe(0);
    expect(p.kills).toBe(0);
  });

  it('copie la position (pas d\'alias) et est JSON pur', () => {
    const spawn = { x: 10, y: 20 };
    const p = createPlayerState({ id: 1, characterId: 'mira', difficulty: 1 }, spawn);
    spawn.x = 999;
    expect(p.pos.x).toBe(10);
    expect(JSON.parse(JSON.stringify(p))).toEqual(p);
  });
});

// ───────────── dégâts ─────────────

describe('applyDamageToPlayer', () => {
  it("dégâts → passage à 'down' à 0 PV (compteurs et liens remis à zéro)", () => {
    const p = mk(0, 'sandrine'); // 70 PV
    p.revivingId = 1;
    p.reviveProgressMs = 123;
    const r = applyDamageToPlayer(p, 1000);
    expect(r.downed).toBe(true);
    expect(r.applied).toBeGreaterThan(0);
    expect(p.hp).toBe(0);
    expect(p.status).toBe('down');
    expect(p.downCount).toBe(1);
    expect(p.revivingId).toBeNull();
    expect(p.reviverId).toBeNull();
    expect(p.reviveProgressMs).toBe(0);
  });

  it('un coup non létal retire des PV et donne de l\'invulnérabilité', () => {
    const p = mk(0, 'david', 2);
    const expected = damageToPlayer(10, getCharacter('david'), 2);
    const r = applyDamageToPlayer(p, 10);
    expect(r).toEqual({ applied: expected, downed: false });
    expect(p.hp).toBe(p.maxHp - expected);
    expect(p.invulnMs).toBe(PLAYER_INVULN_MS);
    expect(p.status).toBe('alive');
  });

  it("respecte l'invulnérabilité", () => {
    const p = mk(0);
    applyDamageToPlayer(p, 10);
    const hp = p.hp;
    const r = applyDamageToPlayer(p, 10);
    expect(r).toEqual({ applied: 0, downed: false });
    expect(p.hp).toBe(hp);
    stepPlayerTimers(p, PLAYER_INVULN_MS);
    expect(applyDamageToPlayer(p, 10).applied).toBeGreaterThan(0);
  });

  it('un joueur à terre ne peut pas être achevé', () => {
    const p = mk(0);
    knockDown(p);
    expect(p.downCount).toBe(1);
    const r = applyDamageToPlayer(p, 9999);
    expect(r).toEqual({ applied: 0, downed: false });
    expect(p.hp).toBe(0);
    expect(p.status).toBe('down');
    expect(p.downCount).toBe(1); // pas de double comptage
  });

  it('dégâts nuls ou négatifs : aucun effet', () => {
    const p = mk(0);
    expect(applyDamageToPlayer(p, 0)).toEqual({ applied: 0, downed: false });
    expect(applyDamageToPlayer(p, -5)).toEqual({ applied: 0, downed: false });
    expect(p.hp).toBe(p.maxHp);
    expect(p.invulnMs).toBe(0);
  });
});

// ───────────── relevage ─────────────

describe('updateRevive', () => {
  it('relevage complet en ~3 s (tolérance un pas) avec événements start + revived', () => {
    const a = mk(0, 'david', 2, 100, 100);
    const b = mk(1, 'romain', 2, 110, 100);
    knockDown(b);
    const ctx: Ctx = { held: new Set([0]), threat: false };
    const events: SimEvent[] = [];
    let t = 0;
    while (b.status === 'down' && t < 10000) {
      events.push(...updateRevive([a, b], (id) => ctx.held.has(id), () => false, SIM_STEP_MS));
      t += SIM_STEP_MS;
    }
    expect(b.status).toBe('alive');
    expect(Math.abs(t - REVIVE_DURATION_MS)).toBeLessThanOrEqual(SIM_STEP_MS + 1e-6);
    expect(ofType(events, 'reviveStarted')).toEqual([{ type: 'reviveStarted', reviverId: 0, targetId: 1 }]);
    expect(ofType(events, 'playerRevived')).toEqual([{ type: 'playerRevived', playerId: 1, reviverId: 0 }]);
    expect(ofType(events, 'reviveInterrupted')).toHaveLength(0);
    expect(a.revivingId).toBeNull();
    expect(b.reviverId).toBeNull();
  });

  it('pas de relevage tant que personne ne maintient le bouton', () => {
    const a = mk(0);
    const b = mk(1, 'david', 2, 105, 100);
    knockDown(b);
    const events = run([a, b], { held: new Set(), threat: false }, 4000);
    expect(events).toHaveLength(0);
    expect(b.status).toBe('down');
    expect(b.reviveProgressMs).toBe(0);
  });

  it('pendant le relevage, le sauveteur est « en train de relever » (isRescuing)', () => {
    const a = mk(0);
    const b = mk(1, 'david', 2, 105, 100);
    knockDown(b);
    expect(isRescuing(a)).toBe(false);
    run([a, b], { held: new Set([0]), threat: false }, 500);
    expect(isRescuing(a)).toBe(true);
    expect(a.revivingId).toBe(1);
    expect(b.reviverId).toBe(0);
    expect(b.reviveProgressMs).toBeGreaterThan(400);
    expect(isRescuing(b)).toBe(false);
  });

  it('relevage interrompu si le bouton est relâché (progression remise à 0)', () => {
    const a = mk(0);
    const b = mk(1, 'david', 2, 105, 100);
    knockDown(b);
    const ctx: Ctx = { held: new Set([0]), threat: false };
    run([a, b], ctx, 1500);
    expect(b.reviveProgressMs).toBeGreaterThan(1000);
    ctx.held.clear();
    const events = run([a, b], ctx, SIM_STEP_MS);
    expect(ofType(events, 'reviveInterrupted')).toEqual([
      { type: 'reviveInterrupted', reviverId: 0, targetId: 1, reason: 'released' },
    ]);
    expect(b.reviveProgressMs).toBe(0);
    expect(b.reviverId).toBeNull();
    expect(a.revivingId).toBeNull();
    expect(b.status).toBe('down');
  });

  it('après une interruption, ré-appuyer repart de zéro', () => {
    const a = mk(0);
    const b = mk(1, 'david', 2, 105, 100);
    knockDown(b);
    const ctx: Ctx = { held: new Set([0]), threat: false };
    run([a, b], ctx, 2000);
    ctx.held.clear();
    run([a, b], ctx, 100);
    ctx.held.add(0);
    const t = timeToRevive([a, b], b, ctx);
    expect(Math.abs(t - REVIVE_DURATION_MS)).toBeLessThanOrEqual(SIM_STEP_MS * 2);
  });

  it('relevage interrompu si le sauveteur est trop loin', () => {
    const a = mk(0, 'david', 2, 100, 100);
    const b = mk(1, 'david', 2, 100 + REVIVE_RANGE - 2, 100);
    knockDown(b);
    const ctx: Ctx = { held: new Set([0]), threat: false };
    run([a, b], ctx, 1000);
    expect(b.reviveProgressMs).toBeGreaterThan(500);
    a.pos.x -= 10; // repoussé hors de portée
    const events = run([a, b], ctx, SIM_STEP_MS);
    expect(ofType(events, 'reviveInterrupted')).toEqual([
      { type: 'reviveInterrupted', reviverId: 0, targetId: 1, reason: 'range' },
    ]);
    expect(b.reviveProgressMs).toBe(0);
    expect(b.status).toBe('down');
    // et il ne recommence pas tant qu'il est loin
    run([a, b], ctx, 1000);
    expect(b.reviverId).toBeNull();
  });

  it('un sauveteur trop loin dès le départ ne commence pas', () => {
    const a = mk(0, 'david', 2, 0, 0);
    const b = mk(1, 'david', 2, REVIVE_RANGE + 1, 0);
    knockDown(b);
    const events = run([a, b], { held: new Set([0]), threat: false }, 1000);
    expect(events).toHaveLength(0);
  });

  it('sauveteur touché mais pas à terre ⇒ le relevage continue', () => {
    const a = mk(0, 'david', 2, 100, 100); // 140 PV
    const b = mk(1, 'romain', 2, 105, 100);
    knockDown(b);
    const ctx: Ctx = { held: new Set([0]), threat: false };
    const events: SimEvent[] = [];
    let t = 0;
    let hits = 0;
    while (b.status === 'down' && t < 10000) {
      // un coup léger toutes les secondes (hors invulnérabilité)
      if (Math.floor(t / 1000) > hits && a.invulnMs === 0) {
        hits++;
        const r = applyDamageToPlayer(a, 12);
        expect(r.applied).toBeGreaterThan(0);
        expect(r.downed).toBe(false);
      }
      stepPlayerTimers(a, SIM_STEP_MS);
      events.push(...updateRevive([a, b], (id) => ctx.held.has(id), () => false, SIM_STEP_MS));
      t += SIM_STEP_MS;
    }
    expect(hits).toBeGreaterThanOrEqual(2);
    expect(b.status).toBe('alive');
    expect(ofType(events, 'reviveInterrupted')).toHaveLength(0);
    expect(Math.abs(t - REVIVE_DURATION_MS)).toBeLessThanOrEqual(SIM_STEP_MS + 1e-6);
  });

  it('sauveteur qui tombe ⇒ relevage interrompu et la cible RESTE à terre', () => {
    const a = mk(0, 'sandrine', 2, 100, 100);
    const b = mk(1, 'david', 2, 105, 100);
    knockDown(b);
    const ctx: Ctx = { held: new Set([0]), threat: false };
    run([a, b], ctx, 1200);
    expect(b.reviveProgressMs).toBeGreaterThan(1000);
    a.invulnMs = 0;
    const r = applyDamageToPlayer(a, 10000);
    expect(r.downed).toBe(true);
    const events = run([a, b], ctx, 200); // le bouton reste tenu
    expect(ofType(events, 'reviveInterrupted')).toEqual([
      { type: 'reviveInterrupted', reviverId: 0, targetId: 1, reason: 'reviverDown' },
    ]);
    expect(ofType(events, 'playerRevived')).toHaveLength(0);
    expect(b.status).toBe('down');
    expect(b.hp).toBe(0);
    expect(b.reviveProgressMs).toBe(0);
    expect(b.reviverId).toBeNull();
    expect(a.revivingId).toBeNull();
    expect(a.status).toBe('down');
    expect(isTeamWiped([a, b])).toBe(true);
  });

  it('ennemi proche ⇒ relevage ralenti (plus long mais il finit)', () => {
    const mkPair = () => {
      const a = mk(0, 'david', 2, 100, 100);
      const b = mk(1, 'david', 2, 105, 100);
      knockDown(b);
      return [a, b] as const;
    };
    const [a1, b1] = mkPair();
    const calm = timeToRevive([a1, b1], b1, { held: new Set([0]), threat: false });
    const [a2, b2] = mkPair();
    const threatened = timeToRevive([a2, b2], b2, { held: new Set([0]), threat: true });
    expect(calm).toBeGreaterThan(0);
    expect(threatened).toBeGreaterThan(calm * 2);
    expect(threatened).toBeGreaterThanOrEqual(REVIVE_DURATION_MS / 0.35 - SIM_STEP_MS * 2);
    expect(b2.status).toBe('alive');
  });

  it("l'ennemi n'est testé que pour la cible dont le relevage progresse", () => {
    const a = mk(0);
    const b = mk(1, 'david', 2, 105, 100);
    knockDown(b);
    const asked: PlayerId[] = [];
    updateRevive([a, b], () => false, (d) => (asked.push(d.id), false), SIM_STEP_MS);
    expect(asked).toHaveLength(0);
    updateRevive([a, b], (id) => id === 0, (d) => (asked.push(d.id), false), SIM_STEP_MS);
    expect(asked).toEqual([1]);
  });

  it('relevage illimité : même joueur relevé 3 fois de suite', () => {
    const a = mk(0, 'david', 2, 100, 100);
    const b = mk(1, 'romain', 2, 105, 100);
    const ctx: Ctx = { held: new Set([0]), threat: false };
    for (let i = 1; i <= 3; i++) {
      stepPlayerTimers(b, 10000);
      knockDown(b);
      expect(b.downCount).toBe(i);
      const t = timeToRevive([a, b], b, ctx);
      expect(t).toBeGreaterThan(0);
      expect(Math.abs(t - REVIVE_DURATION_MS)).toBeLessThanOrEqual(SIM_STEP_MS * 2);
      expect(b.status).toBe('alive');
    }
  });

  it('joueur relevé = PV pleins + invulnérabilité courte + état propre', () => {
    const a = mk(0, 'david', 2, 100, 100);
    const b = mk(1, 'sandrine', 2, 105, 100);
    knockDown(b);
    expect(b.hp).toBe(0);
    timeToRevive([a, b], b, { held: new Set([0]), threat: false });
    expect(b.hp).toBe(b.maxHp);
    expect(b.status).toBe('alive');
    expect(b.invulnMs).toBe(REVIVE_INVULN_MS);
    expect(b.reviveProgressMs).toBe(0);
    expect(b.reviverId).toBeNull();
    expect(a.revivingId).toBeNull();
    // l'invulnérabilité protège le joueur relevé
    expect(applyDamageToPlayer(b, 50)).toEqual({ applied: 0, downed: false });
  });

  it('relevage de Valentine plus rapide (durée × reviveTimeMult)', () => {
    const run1 = (rescuer: CharacterId) => {
      const a = mk(0, rescuer, 2, 100, 100);
      const b = mk(1, 'david', 2, 105, 100);
      knockDown(b);
      return timeToRevive([a, b], b, { held: new Set([0]), threat: false });
    };
    const normal = run1('david');
    const fast = run1('valentine');
    expect(fast).toBeLessThan(normal);
    const expected = REVIVE_DURATION_MS * getCharacter('valentine').reviveTimeMult;
    expect(Math.abs(fast - expected)).toBeLessThanOrEqual(SIM_STEP_MS * 2);
  });

  it('un seul sauveteur à la fois : le premier arrivé garde la main', () => {
    const a = mk(0, 'david', 2, 100, 100);
    const c = mk(2, 'romain', 2, 100, 106); // plus loin que b mais arrive d'abord
    const b = mk(1, 'david', 2, 104, 100);
    const d = mk(3, 'valentine', 2, 100, 100);
    knockDown(b);
    const players = [a, b, c, d];
    const held = new Set<PlayerId>([2]); // c commence seul (distance ~7.2)
    const events: SimEvent[] = [];
    const step = (n: number) => {
      for (let i = 0; i < n; i++) events.push(...updateRevive(players, (id) => held.has(id), () => false, SIM_STEP_MS));
    };
    step(10);
    expect(b.reviverId).toBe(2);
    held.add(0); // a (plus proche) arrive ensuite
    held.add(3);
    step(30);
    expect(b.reviverId).toBe(2); // pas de vol de sauvetage
    expect(a.revivingId).toBeNull();
    expect(d.revivingId).toBeNull();
    expect(ofType(events, 'reviveStarted')).toEqual([{ type: 'reviveStarted', reviverId: 2, targetId: 1 }]);
    const t = timeToRevive(players, b, { held, threat: false });
    expect(t).toBeGreaterThan(0);
    expect(ofType(events, 'playerRevived')).toHaveLength(0); // relevé après (pas dans `events` de step)
    expect(b.status).toBe('alive');
  });

  it('plusieurs candidats sur le même pas : le plus proche (puis plus petit id) est choisi', () => {
    const a = mk(0, 'david', 2, 100, 100);
    const c = mk(2, 'david', 2, 100, 100);
    const b = mk(1, 'david', 2, 110, 100);
    knockDown(b);
    const players = [a, b, c];
    // a et c à même distance : id 0 gagne
    updateRevive(players, () => true, () => false, SIM_STEP_MS);
    expect(b.reviverId).toBe(0);
    // plus proche gagne
    const a2 = mk(0, 'david', 2, 90, 100);
    const c2 = mk(2, 'david', 2, 108, 100);
    const b2 = mk(1, 'david', 2, 110, 100);
    knockDown(b2);
    updateRevive([a2, b2, c2], () => true, () => false, SIM_STEP_MS);
    expect(b2.reviverId).toBe(2);
  });

  it('un sauveteur ne relève pas deux joueurs à la fois', () => {
    const a = mk(0, 'david', 2, 100, 100);
    const b = mk(1, 'david', 2, 105, 100);
    const c = mk(2, 'david', 2, 95, 100);
    knockDown(b);
    knockDown(c);
    updateRevive([a, b, c], (id) => id === 0, () => false, SIM_STEP_MS);
    expect(a.revivingId).toBe(1);
    expect(b.reviverId).toBe(0);
    expect(c.reviverId).toBeNull();
  });

  it('un joueur à terre ne peut pas relever (même bouton tenu)', () => {
    const a = mk(0);
    const b = mk(1, 'david', 2, 105, 100);
    knockDown(a);
    knockDown(b);
    const events = run([a, b], { held: new Set([0, 1]), threat: false }, 1000);
    expect(events).toHaveLength(0);
    expect(a.status).toBe('down');
    expect(b.status).toBe('down');
  });

  it('si le sauveteur lâche, un autre allié peut prendre le relais', () => {
    const a = mk(0, 'david', 2, 100, 100);
    const c = mk(2, 'david', 2, 108, 100);
    const b = mk(1, 'david', 2, 104, 100);
    knockDown(b);
    const held = new Set<PlayerId>([0, 2]);
    const players = [a, b, c];
    run(players, { held, threat: false }, 500);
    expect(b.reviverId).toBe(0);
    held.delete(0);
    const events = run(players, { held, threat: false }, SIM_STEP_MS);
    expect(ofType(events, 'reviveInterrupted')).toHaveLength(1);
    expect(ofType(events, 'reviveStarted')).toEqual([{ type: 'reviveStarted', reviverId: 2, targetId: 1 }]);
    expect(b.reviverId).toBe(2);
    expect(b.reviveProgressMs).toBeLessThan(50); // repart de zéro
  });

  it('ne modifie pas un joueur vivant (aucune progression résiduelle)', () => {
    const a = mk(0);
    const b = mk(1, 'david', 2, 105, 100);
    b.reviveProgressMs = 500;
    b.reviverId = 0;
    updateRevive([a, b], () => false, () => false, SIM_STEP_MS);
    expect(b.reviveProgressMs).toBe(0);
    expect(b.reviverId).toBeNull();
  });
});

// ───────────── équipe ─────────────

describe('isTeamWiped / countAlive', () => {
  it('tous à terre ⇒ vrai ; un seul debout ⇒ faux', () => {
    const ps = [mk(0), mk(1, 'romain'), mk(2, 'mira')];
    expect(isTeamWiped(ps)).toBe(false);
    expect(countAlive(ps)).toBe(3);
    knockDown(ps[0]);
    knockDown(ps[1]);
    expect(isTeamWiped(ps)).toBe(false);
    expect(countAlive(ps)).toBe(1);
    knockDown(ps[2]);
    expect(isTeamWiped(ps)).toBe(true);
    expect(countAlive(ps)).toBe(0);
  });

  it('solo : 1 joueur à terre ⇒ défaite', () => {
    const solo = [mk(0)];
    expect(isTeamWiped(solo)).toBe(false);
    knockDown(solo[0]);
    expect(isTeamWiped(solo)).toBe(true);
  });

  it('liste vide : pas de défaite', () => {
    expect(isTeamWiped([])).toBe(false);
    expect(countAlive([])).toBe(0);
  });
});

describe('reviveAllDowned / resetPlayersForRoom / stepPlayerTimers', () => {
  it('reviveAllDowned : PV pleins pour les joueurs à terre, liens effacés', () => {
    const a = mk(0);
    const b = mk(1, 'sandrine');
    const c = mk(2, 'brokk');
    knockDown(b);
    knockDown(c);
    a.hp = 30;
    a.revivingId = 1;
    b.reviverId = 0;
    b.reviveProgressMs = 900;
    const revived = reviveAllDowned([a, b, c]);
    expect(revived).toEqual([1, 2]);
    expect(b.status).toBe('alive');
    expect(b.hp).toBe(b.maxHp);
    expect(c.hp).toBe(c.maxHp);
    expect(a.hp).toBe(30); // un joueur debout n'est pas soigné
    expect(a.revivingId).toBeNull();
    expect(b.reviverId).toBeNull();
    expect(b.reviveProgressMs).toBe(0);
    expect(isRescuing(a)).toBe(false);
  });

  it('resetPlayersForRoom : PV, positions, statuts, timers ; conserve downCount et kills (par défaut)', () => {
    const a = mk(0, 'david', 2, 5, 5);
    const b = mk(1, 'romain', 2, 6, 6);
    knockDown(b);
    a.hp = 10;
    a.invulnMs = 300;
    a.attackCooldownMs = 200;
    a.attackAnimMs = 100;
    a.keys = ['k1'];
    a.kills = 7;
    a.moving = true;
    a.facing = 'left';
    a.prev = { attack: true, interact: false, revive: true };
    const spawns = [
      { x: 20, y: 30 },
      { x: 40, y: 50 },
    ];
    resetPlayersForRoom([a, b], spawns);
    expect(a.pos).toEqual({ x: 20, y: 30 });
    expect(b.pos).toEqual({ x: 40, y: 50 });
    expect(a.pos).not.toBe(spawns[0]); // copie
    expect(a.hp).toBe(a.maxHp);
    expect(b.hp).toBe(b.maxHp);
    expect(b.status).toBe('alive');
    expect(a.invulnMs).toBe(0);
    expect(a.attackCooldownMs).toBe(0);
    expect(a.attackAnimMs).toBe(0);
    expect(a.keys).toEqual([]);
    expect(a.moving).toBe(false);
    expect(a.kills).toBe(7);
    expect(b.downCount).toBe(1);
    expect(a.facing).toBe('left');
    expect(a.prev).toEqual({ attack: true, interact: false, revive: true });
  });

  it('resetPlayersForRoom : option resetKills et spawns cycliques', () => {
    const ps = [mk(0), mk(1), mk(2)];
    ps.forEach((p) => (p.kills = 3));
    resetPlayersForRoom(ps, [{ x: 1, y: 2 }], { resetKills: true });
    expect(ps.map((p) => p.kills)).toEqual([0, 0, 0]);
    expect(ps.every((p) => p.pos.x === 1 && p.pos.y === 2)).toBe(true);
  });

  it('stepPlayerTimers décrémente invuln / cooldown / anim sans passer sous 0', () => {
    const p = mk(0);
    p.invulnMs = 100;
    p.attackCooldownMs = 50;
    p.attackAnimMs = 20;
    stepPlayerTimers(p, 30);
    expect([p.invulnMs, p.attackCooldownMs, p.attackAnimMs]).toEqual([70, 20, 0]);
    stepPlayerTimers(p, 1000);
    expect([p.invulnMs, p.attackCooldownMs, p.attackAnimMs]).toEqual([0, 0, 0]);
  });
});

// ───────────── difficulté ─────────────

describe('difficulté par joueur', () => {
  it("n'influence PAS les PV du joueur (maxHp identique pour difficulté 1/2/3)", () => {
    for (const cid of ['david', 'sandrine', 'grok'] as CharacterId[]) {
      const hps = ([1, 2, 3] as Difficulty[]).map((d) => mk(0, cid, d).maxHp);
      expect(new Set(hps).size).toBe(1);
      expect(hps[0]).toBe(maxHpFor(getCharacter(cid)));
    }
  });

  it('influence les dégâts reçus (facile < normal < difficile)', () => {
    const taken = ([1, 2, 3] as Difficulty[]).map((d) => {
      const p = mk(0, 'romain', d);
      return applyDamageToPlayer(p, 20).applied;
    });
    expect(taken[0]).toBeLessThan(taken[1]);
    expect(taken[1]).toBeLessThan(taken[2]);
    // romain : résistance 5 → -10 % ; 20 × 0.6 × 0.9 = 10.8 → 11 ; 18 ; 27
    expect(taken).toEqual([11, 18, 27]);
  });

  it('damageToEnemy scale avec la difficulté du joueur attaquant', () => {
    const raw = 20;
    expect(damageToEnemy(raw, 1)).toBeGreaterThan(damageToEnemy(raw, 2));
    expect(damageToEnemy(raw, 2)).toBeGreaterThan(damageToEnemy(raw, 3));
    expect(damageToEnemy(raw, 2)).toBe(20);
  });

  it('le temps de relevage ne dépend pas de la difficulté', () => {
    const t = ([1, 3] as Difficulty[]).map((d) => {
      const a = mk(0, 'david', d, 100, 100);
      const b = mk(1, 'david', d, 105, 100);
      knockDown(b);
      return timeToRevive([a, b], b, { held: new Set([0]), threat: false });
    });
    expect(t[0]).toBeCloseTo(t[1], 5);
  });
});
