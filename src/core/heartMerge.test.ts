/**
 * EMPLACEMENT CŒUR : FUSION. Un joueur dont l'emplacement tient un DEMI-cœur qui touche un demi-cœur OU un cœur entier au sol les ramasse : l'emplacement passe à CŒUR ENTIER (demi + demi = entier,
 * demi + entier = entier, surplus perdu). Emplacement ENTIER : rien n'est ramassé (appel automatique). Emplacement vide : on range tel quel.
 * Tests purs (`canAcceptHeart`, `mergeHeart`, `heartCollectorFor`, `heartSlotUsefulTo`), simulation à 1 et 2 joueurs de bout en bout (B après fusion, ordre B / rangement, appel automatique vers un allié à demi-cœur,
 * aimant, durée de vie, salle terminée, perte à la chute, sauvegarde / reprise), `heartSlot` faux inchangé, retour (événement, son, texte). Aucune horloge réelle : pas fixes.
 */
import { describe, expect, it } from 'vitest';
import { heartSlotUsefulTo } from './autoCall';
import { PICKUP_RADIUS, PICKUP_TTL_MS } from './balance';
import { SIM_STEP_MS } from './constants';
import { canAcceptHeart, canStoreHeart, heartCollectorFor, mergeHeart } from './heartSlot';
import { makeTestLevel, makeTestRoom } from './levelValidation';
import { createPlayerState, markPlayerDown } from './players';
import { buildResumeSimConfig, newGameSave, withHearts } from './save';
import { createSimulation, GameSimulation } from './simulation';
import { sfxForEvent } from '../entities/sfx';
import { heartStoredTextKey } from '../render/heartSlotFx';
import { hasKey, setLanguage, t } from '../i18n/i18n';
import type { ActionFrame, CharacterId, PickupKind, PlayerId, PlayerState, SimConfig, SimEvent, TickInputs } from './types';

const DT = SIM_STEP_MS;

// ───────────────────────────── Outils ─────────────────────────────

const mkPlayer = (id: PlayerId, x: number, y: number): PlayerState => createPlayerState({ id, characterId: 'david', difficulty: 2 }, { x, y });

const ofType = <T extends SimEvent['type']>(events: readonly SimEvent[], type: T): Extract<SimEvent, { type: T }>[] =>
  events.filter((e): e is Extract<SimEvent, { type: T }> => e.type === type);

const frame = (over: Partial<ActionFrame> = {}): ActionFrame => ({ moveX: 0, moveY: 0, attack: false, interact: false, revive: false, special: false, call: false, heart: false, ...over });
const B: ActionFrame = frame({ heart: true });

interface MkOpts {
  heartSlot?: boolean;
  seed?: number;
  gear?: boolean;
  config?: Partial<SimConfig>;
}

/** Salle sans ennemi, butin actif, équipement désactivé par défaut ; `heartSlot` actif par défaut. */
function mk(n: number, opts: MkOpts = {}): GameSimulation {
  const room = makeTestRoom({ id: 'r1', exit: { rect: { x: 9, y: 5, w: 2, h: 2 }, requires: [] } });
  const level = makeTestLevel({ rooms: [{ ...room, exit: { ...room.exit, final: true } }] });
  const chars: CharacterId[] = ['david', 'sandrine', 'romain', 'valentine'];
  return createSimulation(
    {
      levelId: level.id,
      players: Array.from({ length: n }, (_, i) => ({ id: i as PlayerId, characterId: chars[i], difficulty: 2 as const })),
      seed: opts.seed ?? 7,
      gear: opts.gear === true,
      heartSlot: opts.heartSlot !== false,
      ...opts.config,
    },
    level,
  );
}

function stepN(s: GameSimulation, n: number, inputs: TickInputs | ((i: number) => TickInputs) = {}): SimEvent[] {
  const all: SimEvent[] = [];
  for (let i = 0; i < n; i++) all.push(...s.step(DT, typeof inputs === 'function' ? inputs(i) : inputs));
  return all;
}

const put = (s: GameSimulation, id: PlayerId, x: number, y: number): void => {
  s.state.players[id].pos = { x, y };
};

function addPickup(s: GameSimulation, kind: PickupKind, x: number, y: number, ttlMs = PICKUP_TTL_MS): number {
  const id = s.state.nextPickupId ?? 1;
  s.state.nextPickupId = id + 1;
  s.state.room.pickups?.push({ id, kind, pos: { x, y }, ttlMs });
  return id;
}

/** Appui puis relâchement de B (deux pas). */
function pressB(s: GameSimulation, id: PlayerId = 0): SimEvent[] {
  const ev = s.step(DT, { [id]: B });
  ev.push(...s.step(DT, {}));
  return ev;
}

// ───────────────────────────── Fonctions pures ─────────────────────────────

describe('fusion : fonctions pures', () => {
  it('canAcceptHeart : vivant ET (vide OU demi-cœur) ; entier et à terre : non ; canStoreHeart reste « vide seulement »', () => {
    const p = mkPlayer(0, 0, 0);
    expect(canAcceptHeart(p)).toBe(true);
    p.heart = 'half';
    expect(canAcceptHeart(p)).toBe(true);
    expect(canStoreHeart(p)).toBe(false);
    p.heart = 'full';
    expect(canAcceptHeart(p)).toBe(false);
    delete p.heart;
    markPlayerDown(p);
    expect(canAcceptHeart(p)).toBe(false);
    const q = mkPlayer(1, 0, 0);
    q.heart = 'half';
    markPlayerDown(q);
    expect(canAcceptHeart(q)).toBe(false);
  });

  it('mergeHeart : vide → tel quel ; demi + (demi | entier) → entier ; entier → refusé (null)', () => {
    expect(mergeHeart(undefined, 'half')).toBe('half');
    expect(mergeHeart(undefined, 'full')).toBe('full');
    expect(mergeHeart('half', 'half')).toBe('full');
    expect(mergeHeart('half', 'full')).toBe('full');
    expect(mergeHeart('full', 'half')).toBeNull();
    expect(mergeHeart('full', 'full')).toBeNull();
  });

  it('heartCollectorFor : un porteur de demi-cœur est un preneur (le plus proche) ; un porteur entier est ignoré même s il est plus proche ; tous entiers : null', () => {
    const a = mkPlayer(0, 100, 100);
    const b = mkPlayer(1, 100 + PICKUP_RADIUS - 2, 100);
    a.heart = 'full';
    b.heart = 'half';
    expect(heartCollectorFor([a, b], { x: 100, y: 100 }, PICKUP_RADIUS)?.id).toBe(1);
    b.heart = 'full';
    expect(heartCollectorFor([a, b], { x: 100, y: 100 }, PICKUP_RADIUS)).toBeNull();
    a.heart = 'half';
    b.heart = 'half';
    expect(heartCollectorFor([a, b], { x: 100, y: 100 }, PICKUP_RADIUS)?.id).toBe(0); // le plus proche
  });

  it('heartSlotUsefulTo (appel automatique) : vide et demi-cœur utiles, entier non', () => {
    const p = mkPlayer(0, 0, 0);
    expect(heartSlotUsefulTo(p)).toBe(true);
    p.heart = 'half';
    expect(heartSlotUsefulTo(p)).toBe(true);
    p.heart = 'full';
    expect(heartSlotUsefulTo(p)).toBe(false);
  });
});

// ───────────────────────────── Simulation, 1 joueur ─────────────────────────────

describe('fusion : simulation à 1 joueur', () => {
  it('demi + demi = entier : le second demi-cœur disparaît du sol, l emplacement passe à « full », événement heartStored { merged: true }, aucun soin', () => {
    const s = mk(1);
    s.step(DT, {});
    const p = s.state.players[0];
    p.hp = 20;
    put(s, 0, 60, 60);
    addPickup(s, 'half', 62, 60);
    const ev1 = stepN(s, 2);
    expect(p.heart).toBe('half');
    expect(ofType(ev1, 'heartStored')).toHaveLength(1);
    expect('merged' in ofType(ev1, 'heartStored')[0]).toBe(false); // rangement simple : champ absent
    addPickup(s, 'half', 63, 60);
    const ev2 = stepN(s, 2);
    expect(p.heart).toBe('full');
    expect(s.state.room.pickups).toHaveLength(0);
    const stored = ofType(ev2, 'heartStored');
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ playerId: 0, kind: 'half', merged: true });
    expect(p.hp).toBe(20); // aucun soin au contact
    expect(ofType(ev2, 'pickupCollected')).toHaveLength(0);
  });

  it('demi + entier = entier : le cœur entier disparaît du sol (le surplus du demi-cœur est perdu) ; B rend alors 10 PV (et non 5)', () => {
    const s = mk(1);
    s.step(DT, {});
    const p = s.state.players[0];
    p.heart = 'half';
    p.hp = p.maxHp - 30;
    put(s, 0, 60, 60);
    addPickup(s, 'full', 62, 60);
    const ev = stepN(s, 2);
    expect(p.heart).toBe('full');
    expect(s.state.room.pickups).toHaveLength(0);
    expect(ofType(ev, 'heartStored')[0]).toMatchObject({ kind: 'full', merged: true });
    const ev2 = pressB(s);
    expect(ofType(ev2, 'heartUsed')[0]).toMatchObject({ playerId: 0, targetId: 0, kind: 'full', amount: 10 });
    expect(p.hp).toBe(p.maxHp - 20);
    expect(p.heart).toBeUndefined();
  });

  it('fusion puis B : un demi-cœur + un demi-cœur soignent 10 PV d un seul appui', () => {
    const s = mk(1);
    s.step(DT, {});
    const p = s.state.players[0];
    p.heart = 'half';
    p.hp = p.maxHp - 12;
    put(s, 0, 60, 60);
    addPickup(s, 'half', 61, 60);
    stepN(s, 2);
    expect(p.heart).toBe('full');
    expect(ofType(pressB(s), 'heartUsed')[0]).toMatchObject({ amount: 10 });
    expect(p.hp).toBe(p.maxHp - 2);
  });

  it('emplacement ENTIER : un cœur ou un demi-cœur au sol n est pas ramassé (aucun événement, aucun cumul)', () => {
    for (const kind of ['full', 'half'] as const) {
      const s = mk(1);
      s.step(DT, {});
      const p = s.state.players[0];
      p.heart = 'full';
      put(s, 0, 60, 60);
      addPickup(s, kind, 62, 60);
      const ev = stepN(s, 30);
      expect(p.heart, kind).toBe('full');
      expect(s.state.room.pickups, kind).toHaveLength(1);
      expect(ofType(ev, 'heartStored'), kind).toHaveLength(0);
    }
  });

  it('emplacement VIDE : on range tel quel (demi → demi, entier → entier), sans fusion', () => {
    for (const kind of ['half', 'full'] as const) {
      const s = mk(1);
      s.step(DT, {});
      put(s, 0, 60, 60);
      addPickup(s, kind, 62, 60);
      const ev = stepN(s, 2);
      expect(s.state.players[0].heart).toBe(kind);
      expect('merged' in ofType(ev, 'heartStored')[0]).toBe(false);
    }
  });

  it('un seul objet par pas : deux cœurs au sol sous les pieds d un porteur de demi-cœur : le premier fusionne, le second est refusé (entier)', () => {
    const s = mk(1);
    s.step(DT, {});
    const p = s.state.players[0];
    p.heart = 'half';
    put(s, 0, 60, 60);
    addPickup(s, 'full', 61, 60);
    addPickup(s, 'full', 62, 60);
    const ev = stepN(s, 5);
    expect(p.heart).toBe('full');
    expect(ofType(ev, 'heartStored')).toHaveLength(1);
    expect(s.state.room.pickups).toHaveLength(1);
  });

  it('demi-cœur au sol périmé : pas de fusion ; avec une durée de vie suffisante : fusion au premier pas', () => {
    const s = mk(1);
    s.step(DT, {});
    const p = s.state.players[0];
    p.heart = 'half';
    put(s, 0, 60, 60);
    addPickup(s, 'half', 61, 60, DT); // périmé dès le prochain pas
    stepN(s, 2);
    expect(p.heart).toBe('half');
    expect(s.state.room.pickups).toHaveLength(0);
    addPickup(s, 'half', 61, 60, DT * 3);
    stepN(s, 1);
    expect(p.heart).toBe('full');
  });

  it('phase roomCleared : la fusion a lieu aussi (le rangement reste actif pendant le délai de salle terminée)', () => {
    const s = mk(1);
    s.step(DT, {});
    s.state.phase = 'roomCleared';
    s.state.phaseTimerMs = 0;
    const p = s.state.players[0];
    p.heart = 'half';
    put(s, 0, 60, 60);
    addPickup(s, 'half', 60, 60);
    const ev = s.step(DT, {});
    expect(ofType(ev, 'heartStored')[0]).toMatchObject({ merged: true });
    expect(p.heart).toBe('full');
  });

  it('un joueur à terre ne fusionne pas : l objet reste au sol', () => {
    const s = mk(2);
    s.step(DT, {});
    s.state.players[1].heart = 'half';
    put(s, 1, 60, 60);
    put(s, 0, 200, 60);
    expect(s.knockDown(1)).toBe(true);
    s.step(DT, {}); // la chute lâche le demi-cœur au sol
    const before = s.state.room.pickups?.length ?? 0;
    addPickup(s, 'half', 61, 60);
    stepN(s, 3);
    expect(s.state.players[1].heart).toBeUndefined();
    expect(s.state.room.pickups?.length).toBe(before + 1);
  });

  it('ORDRE B / rangement dans un même pas : B est traité D\'ABORD (le demi-cœur utilisé libère l emplacement), l objet touché est ensuite RANGÉ tel quel : pas de fusion', () => {
    const s = mk(1);
    s.step(DT, {});
    const p = s.state.players[0];
    p.heart = 'half';
    p.hp = 20;
    put(s, 0, 60, 60);
    addPickup(s, 'half', 61, 60);
    const ev = s.step(DT, { 0: B });
    expect(ofType(ev, 'heartUsed')).toHaveLength(1);
    expect(p.hp).toBe(25);
    const stored = ofType(ev, 'heartStored');
    expect(stored).toHaveLength(1);
    expect('merged' in stored[0]).toBe(false);
    expect(p.heart).toBe('half');
    expect(s.state.room.pickups).toHaveLength(0);
  });

  it('ordre B / rangement, emplacement entier : B vide l emplacement ce pas-là, l objet au sol touché est rangé dans le MÊME pas', () => {
    const s = mk(1);
    s.step(DT, {});
    const p = s.state.players[0];
    p.heart = 'full';
    p.hp = 20;
    put(s, 0, 60, 60);
    addPickup(s, 'half', 61, 60);
    const ev = s.step(DT, { 0: B });
    expect(ofType(ev, 'heartUsed')[0]).toMatchObject({ amount: 10 });
    expect(p.heart).toBe('half');
    expect(s.state.room.pickups).toHaveLength(0);
  });

  it('plus de flux aléatoire touché : avec des ennemis tués (les trois flux avancent), la fusion ne change ni les états aléatoires ni le butin par rapport à un refus (emplacement entier)', () => {
    const run = (merge: boolean): { rng: unknown; loot: unknown; start: unknown; merged: number; left: number } => {
      const room = makeTestRoom({ id: 'r1', enemies: [{ kind: 'slime', tile: [14, 9] }, { kind: 'slime', tile: [15, 9] }], exit: { rect: { x: 9, y: 5, w: 2, h: 2 }, requires: [] } });
      const level = makeTestLevel({ rooms: [{ ...room, exit: { ...room.exit, final: true } }] });
      const s = createSimulation({ levelId: level.id, players: [{ id: 0, characterId: 'david', difficulty: 2 }], seed: 11, gear: true, heartSlot: true }, level);
      const st = s.state as unknown as Record<string, unknown>;
      const streams = (): unknown[] => [st.rngState, st.lootRngState, st.gearRngState];
      s.step(DT, {});
      const start = streams();
      s.state.players[0].heart = merge ? 'half' : 'full';
      put(s, 0, 60, 60);
      addPickup(s, 'half', 61, 60);
      for (const e of s.state.room.enemies) e.hp = 0; // butin tiré (flux de butin et d'équipement) au même pas dans les deux variantes
      const ev = stepN(s, 30);
      return { rng: streams(), loot: st.lootState, start, merged: ofType(ev, 'heartStored').filter((e) => e.merged === true).length, left: s.state.room.pickups?.filter((p) => p.pos.x === 61).length ?? 0 };
    };
    const a = run(true);
    const b = run(false);
    expect(a.merged).toBe(1); // la fusion a bien eu lieu dans la variante « fusion »
    expect(b.merged).toBe(0);
    expect(b.left).toBe(1); // et le refus laisse le cœur au sol
    expect(a.rng).not.toEqual(a.start); // le test n'est pas trivial : les flux ont avancé (ennemis tués)
    expect(a.rng).toEqual(b.rng);
    expect(a.loot).toEqual(b.loot);
  });
});

// ───────────────────────────── Aimant ─────────────────────────────

describe('fusion : aimant', () => {
  const MAGNET = { kind: 'magnet' as const, level: 3 as const };

  function magnetSim(heart?: PickupKind): GameSimulation {
    const s = mk(1, { gear: true });
    s.step(DT, {});
    s.state.players[0].loadout.accessory = { ...MAGNET };
    if (heart) s.state.players[0].heart = heart;
    put(s, 0, 60, 60);
    return s;
  }

  it('demi-cœur rangé : l aimant tire le cœur / demi-cœur lointain, qui fusionne', () => {
    for (const kind of ['half', 'full'] as const) {
      const s = magnetSim('half');
      addPickup(s, kind, 60 + 70, 60);
      stepN(s, 200);
      expect(s.state.players[0].heart, kind).toBe('full');
      expect(s.state.room.pickups, kind).toHaveLength(0);
    }
  });

  it('cœur ENTIER rangé : l aimant ne tire rien (le cœur reste où il est)', () => {
    const s = magnetSim('full');
    const id = addPickup(s, 'half', 60 + 70, 60);
    stepN(s, 120);
    expect(s.state.room.pickups?.find((p) => p.id === id)?.pos.x).toBe(130);
    expect(s.state.players[0].heart).toBe('full');
  });

  it('priorité entre deux porteurs : l aimant du porteur ENTIER est ignoré, celui du porteur à demi-cœur tire l objet', () => {
    const s = mk(2, { gear: true });
    s.step(DT, {});
    for (const p of s.state.players) p.loadout.accessory = { ...MAGNET };
    s.state.players[0].heart = 'full'; // le plus proche mais ne peut rien accepter
    s.state.players[1].heart = 'half';
    put(s, 0, 100, 60);
    put(s, 1, 160, 60);
    addPickup(s, 'half', 130, 60);
    stepN(s, 120);
    expect(s.state.players[1].heart).toBe('full');
    expect(s.state.players[0].heart).toBe('full');
    expect(s.state.room.pickups).toHaveLength(0);
  });
});

// ───────────────────────────── Simulation, 2 joueurs ─────────────────────────────

describe('fusion : simulation à 2 joueurs', () => {
  it('deux joueurs à demi-cœur touchent le MÊME cœur au même pas : un seul le prend (le plus proche, égalité = plus petit id), l autre reste à demi-cœur', () => {
    const s = mk(2);
    s.step(DT, {});
    for (const p of s.state.players) p.heart = 'half';
    put(s, 0, 60, 60);
    put(s, 1, 64, 60);
    addPickup(s, 'full', 62, 60); // à égale distance
    const ev = stepN(s, 3);
    expect(ofType(ev, 'heartStored')).toHaveLength(1);
    expect(s.state.players[0].heart).toBe('full');
    expect(s.state.players[1].heart).toBe('half');
    // plus proche du second : c est lui
    const s2 = mk(2);
    s2.step(DT, {});
    for (const p of s2.state.players) p.heart = 'half';
    put(s2, 0, 60, 60);
    put(s2, 1, 66, 60);
    addPickup(s2, 'full', 65, 60);
    stepN(s2, 3);
    expect(s2.state.players[0].heart).toBe('half');
    expect(s2.state.players[1].heart).toBe('full');
  });

  it('un porteur ENTIER plus proche laisse le cœur à l allié à demi-cœur (lui peut fusionner)', () => {
    const s = mk(2);
    s.step(DT, {});
    s.state.players[0].heart = 'full';
    s.state.players[1].heart = 'half';
    put(s, 0, 60, 60);
    put(s, 1, 70, 60);
    addPickup(s, 'half', 61, 60);
    const ev = stepN(s, 3);
    expect(s.state.players[0].heart).toBe('full');
    expect(s.state.players[1].heart).toBe('full');
    expect(ofType(ev, 'heartStored')[0]).toMatchObject({ playerId: 1, merged: true });
  });

  it('APPEL AUTOMATIQUE : un porteur entier laisse un cœur ; un allié à demi-cœur est destinataire (même pour un demi-cœur au sol), le signal s arrête quand l allié le fusionne', () => {
    for (const kind of ['full', 'half'] as const) {
      const s = mk(2);
      s.step(DT, {});
      const [a, b] = s.state.players;
      a.heart = 'full';
      b.heart = 'half';
      put(s, 0, 40, 40);
      put(s, 1, 140, 40);
      const id = addPickup(s, kind, 41, 40);
      const ev = stepN(s, 3);
      expect(ofType(ev, 'autoCallStarted'), kind).toEqual([{ type: 'autoCallStarted', playerId: 0, icon: kind === 'full' ? 'heart' : 'half', to: [1] }]);
      expect(a.autoCall?.ref, kind).toBe(`p${id}`);
      expect(s.state.room.pickups, kind).toHaveLength(1);
      // l allié vient, fusionne : l objet disparaît, le signal de A s arrête
      put(s, 1, 41, 40);
      stepN(s, 2);
      expect(b.heart, kind).toBe('full');
      expect(s.state.room.pickups, kind).toHaveLength(0);
      expect(a.autoCall, kind).toBeUndefined();
    }
  });

  it('APPEL AUTOMATIQUE : un allié à emplacement ENTIER n est pas destinataire (aucun appel)', () => {
    const s = mk(2);
    s.step(DT, {});
    const [a, b] = s.state.players;
    a.heart = 'full';
    b.heart = 'full';
    put(s, 0, 40, 40);
    put(s, 1, 140, 40);
    addPickup(s, 'half', 41, 40);
    const ev = stepN(s, 5);
    expect(ofType(ev, 'autoCallStarted')).toHaveLength(0);
    expect(a.autoCall).toBeUndefined();
  });

  it('APPEL AUTOMATIQUE : un porteur à demi-cœur qui se tient sur un cœur ne déclenche rien (il le fusionne)', () => {
    const s = mk(2);
    s.step(DT, {});
    s.state.players[0].heart = 'half';
    put(s, 0, 40, 40);
    put(s, 1, 140, 40);
    addPickup(s, 'half', 41, 40);
    const ev = stepN(s, 5);
    expect(ofType(ev, 'autoCallStarted')).toHaveLength(0);
    expect(s.state.players[0].heart).toBe('full');
  });

  it('anti-spam / refus puis usage de B : le cœur refusé (emplacement entier) est ramassé au pas suivant quand B libère l emplacement alors que le joueur est toujours dessus (signal arrêté)', () => {
    const s = mk(2);
    s.step(DT, {});
    const [a, b] = s.state.players;
    a.heart = 'full';
    a.hp = a.maxHp - 20;
    put(s, 0, 40, 40);
    put(s, 1, 140, 40);
    addPickup(s, 'half', 41, 40);
    stepN(s, 3);
    expect(a.autoCall).toBeDefined(); // refusé : l appel est parti
    expect(s.state.room.pickups).toHaveLength(1);
    // B : le cœur entier soigne A (aucun allié blessé) ; l emplacement est libre
    const evB = s.step(DT, { 0: B });
    expect(ofType(evB, 'heartUsed')).toHaveLength(1);
    // le demi-cœur touché pendant ce même pas est déjà rangé (B d abord, rangement ensuite)
    expect(a.heart).toBe('half');
    expect(s.state.room.pickups).toHaveLength(0);
    stepN(s, 2);
    expect(a.autoCall).toBeUndefined();
    expect(b.heart).toBeUndefined();
  });

  it('un cœur refusé par un porteur entier est ramassé (FUSION) quand son emplacement passe à demi-cœur alors qu il est toujours dessus', () => {
    const s = mk(1);
    s.step(DT, {});
    const p = s.state.players[0];
    p.heart = 'full';
    put(s, 0, 40, 40);
    addPickup(s, 'full', 41, 40);
    stepN(s, 3);
    expect(s.state.room.pickups).toHaveLength(1); // refusé
    p.heart = 'half'; // mise en scène : l emplacement passe à demi (ex. scénario)
    const ev = stepN(s, 1);
    expect(ofType(ev, 'heartStored')[0]).toMatchObject({ merged: true });
    expect(p.heart).toBe('full');
    expect(s.state.room.pickups).toHaveLength(0);
  });
});

// ───────────────────────────── Perte, sauvegarde, reprise ─────────────────────────────

describe('fusion : perte à la chute, sauvegarde et reprise', () => {
  it('le cœur entier issu d une fusion tombe en ENTIER à la chute (heartLost + pickupDropped)', () => {
    const s = mk(2);
    s.step(DT, {});
    s.state.players[1].heart = 'half';
    put(s, 1, 80, 60);
    put(s, 0, 200, 60);
    addPickup(s, 'half', 81, 60);
    stepN(s, 2);
    expect(s.state.players[1].heart).toBe('full');
    expect(s.knockDown(1)).toBe(true);
    const ev = s.step(DT, {});
    expect(ofType(ev, 'heartLost')[0]).toMatchObject({ playerId: 1, kind: 'full' });
    expect(ofType(ev, 'pickupDropped')[0]).toMatchObject({ kind: 'full' });
  });

  it('sauvegarde : l emplacement fusionné s écrit comme avant (valeur \'full\', schéma inchangé) ; reprise : un demi-cœur sauvegardé fusionne normalement', () => {
    const s = mk(1);
    s.step(DT, {});
    s.state.players[0].heart = 'half';
    put(s, 0, 60, 60);
    addPickup(s, 'half', 61, 60);
    stepN(s, 2);
    const heart = s.state.players[0].heart;
    expect(heart).toBe('full');
    const saved = withHearts(newGameSave([{ id: 0, characterId: 'david', difficulty: 2 }], 'level1'), [heart]);
    expect(saved.players[0].heart).toBe('full');
    const resumed = withHearts(newGameSave([{ id: 0, characterId: 'david', difficulty: 2 }], 'level1'), ['half']);
    const cfg = buildResumeSimConfig(resumed, 1);
    expect(cfg.initialHearts).toEqual(['half']);
    const s2 = mk(1, { config: { initialHearts: cfg.initialHearts } });
    s2.step(DT, {});
    expect(s2.state.players[0].heart).toBe('half');
    put(s2, 0, 60, 60);
    addPickup(s2, 'full', 61, 60);
    stepN(s2, 2);
    expect(s2.state.players[0].heart).toBe('full');
    expect(JSON.parse(s2.serialize()).players[0].heart).toBe('full');
  });
});

// ───────────────────────────── heartSlot faux : ancien comportement ─────────────────────────────

describe('fusion : option heartSlot fausse = ancien comportement exact', () => {
  it('cœur consommé au contact (blessé), aucun heartStored, aucune fusion ; refus aux PV pleins', () => {
    const s = mk(1, { heartSlot: false });
    s.step(DT, {});
    const p = s.state.players[0];
    p.hp = 20;
    put(s, 0, 60, 60);
    addPickup(s, 'half', 61, 60);
    const ev = stepN(s, 2);
    expect(p.hp).toBe(25);
    expect(ofType(ev, 'pickupCollected')).toHaveLength(1);
    expect(ofType(ev, 'heartStored')).toHaveLength(0);
    expect(p.heart).toBeUndefined();
    p.hp = p.maxHp;
    addPickup(s, 'half', 61, 60);
    stepN(s, 5);
    expect(s.state.room.pickups).toHaveLength(1); // PV pleins : pas ramassé
  });

  it('un demi-cœur d initialHearts est ignoré avec heartSlot faux : emplacement toujours vide', () => {
    const s = mk(1, { heartSlot: false, config: { initialHearts: ['half'] } });
    s.step(DT, {});
    expect(s.state.players[0].heart).toBeUndefined();
  });

  it('heartSlot faux ≡ option absente : même état sérialisé et mêmes événements (ennemis tués, butin, appuis sur B, cœurs au sol, deux joueurs)', () => {
    const run = (heartSlot: boolean | undefined): { snap: string; events: string } => {
      const room = makeTestRoom({ id: 'r1', enemies: [{ kind: 'slime', tile: [14, 9] }, { kind: 'slime', tile: [15, 9] }], exit: { rect: { x: 9, y: 5, w: 2, h: 2 }, requires: [] } });
      const level = makeTestLevel({ rooms: [{ ...room, exit: { ...room.exit, final: true } }] });
      const s = createSimulation(
        { levelId: level.id, players: [{ id: 0, characterId: 'david', difficulty: 2 }, { id: 1, characterId: 'sandrine', difficulty: 2 }], seed: 5, gear: true, ...(heartSlot === undefined ? {} : { heartSlot }) },
        level,
      );
      s.step(DT, {});
      s.state.players[0].hp = 30;
      put(s, 0, 60, 60);
      put(s, 1, 90, 60);
      addPickup(s, 'half', 61, 60);
      addPickup(s, 'full', 91, 60);
      for (const e of s.state.room.enemies) e.hp = 0;
      const ev = stepN(s, 60, (i) => (i % 7 < 2 ? { 0: B, 1: B } : {}));
      return { snap: s.serialize(), events: JSON.stringify(ev) };
    };
    const off = run(false);
    const absent = run(undefined);
    expect(off.events).toBe(absent.events);
    expect(off.snap).toBe(absent.snap);
    expect(off.events).not.toContain('heartStored'); // l'ancien comportement : jamais de rangement
  });
});

// ───────────────────────────── Retour visuel, sonore et textuel ─────────────────────────────

describe('fusion : retour (son, texte)', () => {
  it('le son de fusion est distinct du rangement simple ; sans « merged » : « heartStore »', () => {
    const base = { type: 'heartStored', playerId: 0, pickupId: 1, kind: 'half', pos: { x: 0, y: 0 } } as const;
    expect(sfxForEvent(base)).toBe('heartStore');
    expect(sfxForEvent({ ...base, merged: true })).toBe('heartMerge');
  });

  it('texte flottant : « Cœur complet » / « Full heart » pour une fusion, quel que soit l objet ramassé ; rangements simples inchangés', () => {
    expect(heartStoredTextKey('half', true)).toBe('heart.merged');
    expect(heartStoredTextKey('full', true)).toBe('heart.merged');
    expect(heartStoredTextKey('half')).toBe('heart.stored.half');
    expect(heartStoredTextKey('full', false)).toBe('heart.stored.full');
    for (const lang of ['fr', 'en'] as const) {
      setLanguage(lang);
      expect(hasKey('heart.merged')).toBe(true);
      expect(t('heart.merged')).not.toBe('heart.merged');
    }
    setLanguage('fr');
    expect(t('heart.merged')).toBe('♥ Cœur complet');
    setLanguage('en');
    expect(t('heart.merged')).toBe('♥ Full heart');
    setLanguage('fr');
  });
});
