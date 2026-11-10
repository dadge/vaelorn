/**
 * EMPLACEMENT CŒUR : fonctions pures (`heartSlot.ts`) et simulation de bout en bout (1 et 2 joueurs) : rangement (vide / plein, blessé ou non, demi / entier, aucun cumul),
 * bouton B (cibles a / b / c / d et priorités, soin plafonné, aucun gaspillage, joueur à terre, relevage prioritaire, gel d'appel, front montant, phase), perte à la chute (cœur au
 * sol, défaite d'équipe stricte), aimant, cristal volontaire, option `heartSlot` fausse = ancien comportement exact, flux aléatoires intacts, sérialisation et tolérance.
 * Aucune horloge réelle : tout passe par des pas fixes.
 */
import { describe, expect, it } from 'vitest';
import { HEAL_CRYSTAL_HEAL, HEAL_CRYSTAL_RADIUS, HEART_HEAL_RADIUS, LOOT_FULL_HEAL, LOOT_HALF_HEAL, PICKUP_RADIUS, PICKUP_TTL_MS } from './balance';
import { REVIVE_RANGE, SIM_STEP_MS, WIPE_RESTART_DELAY_MS } from './constants';
import { canStoreHeart, heartCollectorFor, heartUseAmount, isHeartKind, isWounded, normalizeHeartField, planHeartUse, woundedAllyNear } from './heartSlot';
import { makeTestLevel, makeTestRoom } from './levelValidation';
import { createPlayerState } from './players';
import { createSimulation, GameSimulation } from './simulation';
import type { ActionFrame, CharacterId, HealCrystalDef, PickupKind, PlayerId, PlayerState, SimEvent, TickInputs } from './types';

const DT = SIM_STEP_MS;

// ───────────────────────────── Outils ─────────────────────────────

function mkPlayer(id: PlayerId, x: number, y: number, hp?: number): PlayerState {
  const p = createPlayerState({ id, characterId: 'david', difficulty: 2 }, { x, y });
  if (hp !== undefined) p.hp = hp;
  return p;
}

const ofType = <T extends SimEvent['type']>(events: readonly SimEvent[], type: T): Extract<SimEvent, { type: T }>[] =>
  events.filter((e): e is Extract<SimEvent, { type: T }> => e.type === type);

function frame(over: Partial<ActionFrame> = {}): ActionFrame {
  return { moveX: 0, moveY: 0, attack: false, interact: false, revive: false, special: false, call: false, heart: false, ...over };
}
const B: ActionFrame = frame({ heart: true });

interface MkOpts {
  heartSlot?: boolean;
  seed?: number;
  crystals?: HealCrystalDef[];
  characters?: CharacterId[];
  gear?: boolean;
}

/** Salle sans ennemi (sortie loin des joueurs). Le butin est ACTIF (les cristaux existent) ; l'équipement est désactivé par défaut. */
function mk(n: number, opts: MkOpts = {}): GameSimulation {
  const room = makeTestRoom({ id: 'r1', exit: { rect: { x: 9, y: 5, w: 2, h: 2 }, requires: [] }, healCrystals: opts.crystals });
  const level = makeTestLevel({ rooms: [{ ...room, exit: { ...room.exit, final: true } }] });
  const chars: CharacterId[] = opts.characters ?? ['david', 'sandrine', 'romain', 'valentine'];
  return createSimulation(
    {
      levelId: level.id,
      players: Array.from({ length: n }, (_, i) => ({ id: i as PlayerId, characterId: chars[i], difficulty: 2 as const })),
      seed: opts.seed ?? 7,
      gear: opts.gear === true,
      heartSlot: opts.heartSlot !== false,
    },
    level,
  );
}

function stepN(s: GameSimulation, n: number, inputs: TickInputs | ((i: number) => TickInputs) = {}): SimEvent[] {
  const all: SimEvent[] = [];
  for (let i = 0; i < n; i++) all.push(...s.step(DT, typeof inputs === 'function' ? inputs(i) : inputs));
  return all;
}

function put(s: GameSimulation, id: PlayerId, x: number, y: number): void {
  s.state.players[id].pos = { x, y };
}

function addPickup(s: GameSimulation, kind: PickupKind, x: number, y: number, ttlMs = PICKUP_TTL_MS): number {
  const id = s.state.nextPickupId ?? 1;
  s.state.nextPickupId = id + 1;
  s.state.room.pickups?.push({ id, kind, pos: { x, y }, ttlMs });
  return id;
}

/** Appui puis relâchement de B (deux pas) ; retourne les événements. */
function pressB(s: GameSimulation, id: PlayerId = 0): SimEvent[] {
  const ev = s.step(DT, { [id]: B });
  ev.push(...s.step(DT, {}));
  return ev;
}

// ───────────────────────────── Fonctions pures ─────────────────────────────

describe('heartSlot.ts : fonctions pures', () => {
  it('isHeartKind : seulement half / full', () => {
    expect(isHeartKind('half')).toBe(true);
    expect(isHeartKind('full')).toBe(true);
    for (const v of ['banana', '', 5, null, undefined, {}, [], 'FULL']) expect(isHeartKind(v)).toBe(false);
  });

  it('canStoreHeart : vivant ET emplacement vide ; isWounded : vivant ET PV < max', () => {
    const p = mkPlayer(0, 0, 0);
    expect(canStoreHeart(p)).toBe(true);
    p.heart = 'half';
    expect(canStoreHeart(p)).toBe(false);
    delete p.heart;
    p.status = 'down';
    expect(canStoreHeart(p)).toBe(false);
    const q = mkPlayer(1, 0, 0);
    expect(isWounded(q)).toBe(false);
    q.hp = q.maxHp - 1; // un seul PV manquant suffit
    expect(isWounded(q)).toBe(true);
    q.status = 'down';
    expect(isWounded(q)).toBe(false);
  });

  it('heartCollectorFor : le plus proche à emplacement VIDE dans le rayon, blessé ou non ; égalité = plus petit id', () => {
    const a = mkPlayer(0, 100, 100); // PV pleins
    const b = mkPlayer(1, 105, 100);
    expect(heartCollectorFor([a, b], { x: 100, y: 100 }, PICKUP_RADIUS)?.id).toBe(0);
    a.heart = 'full'; // emplacement plein : l'allié le prend
    expect(heartCollectorFor([a, b], { x: 100, y: 100 }, PICKUP_RADIUS)?.id).toBe(1);
    b.status = 'down'; // à terre : personne
    expect(heartCollectorFor([a, b], { x: 100, y: 100 }, PICKUP_RADIUS)).toBeNull();
    delete a.heart;
    expect(heartCollectorFor([a, b], { x: 100 + PICKUP_RADIUS + 1, y: 100 }, PICKUP_RADIUS)).toBeNull(); // hors rayon
    const c = mkPlayer(0, 100, 100);
    const d = mkPlayer(1, 100, 100); // même distance
    expect(heartCollectorFor([d, c], { x: 100, y: 100 }, PICKUP_RADIUS)?.id).toBe(1); // ordre du tableau : le premier atteint la distance minimale
  });

  it('woundedAllyNear : vivant ET blessé, dans HEART_HEAL_RADIUS, le plus proche, jamais soi-même', () => {
    expect(HEART_HEAL_RADIUS).toBe(REVIVE_RANGE); // [B29] : la portée du relevage
    const u = mkPlayer(0, 100, 100, 10);
    const near = mkPlayer(1, 100 + 20, 100, 10);
    const nearer = mkPlayer(2, 100 + 10, 100, 10);
    expect(woundedAllyNear([u, near, nearer], u)?.id).toBe(2);
    nearer.hp = nearer.maxHp; // PV pleins : pas une cible
    expect(woundedAllyNear([u, near, nearer], u)?.id).toBe(1);
    near.status = 'down'; // à terre : pas une cible
    expect(woundedAllyNear([u, near, nearer], u)).toBeNull();
    near.status = 'alive';
    near.pos = { x: 100 + HEART_HEAL_RADIUS + 1, y: 100 }; // hors rayon
    expect(woundedAllyNear([u, near, nearer], u)).toBeNull();
  });

  it('woundedAllyNear : deux alliés blessés EXACTEMENT équidistants → premier dans l ordre des joueurs (= plus petit id) ; borne du rayon incluse', () => {
    const u = mkPlayer(0, 100, 100, 10);
    const a1 = mkPlayer(1, 110, 100, 10);
    const a2 = mkPlayer(2, 90, 100, 10);
    expect(woundedAllyNear([u, a1, a2], u)?.id).toBe(1);
    expect(woundedAllyNear([u, a2, a1], u)?.id).toBe(2); // c est bien l ordre du tableau (les joueurs de l état sont triés par id)
    const edge = mkPlayer(1, 100 + HEART_HEAL_RADIUS, 100, 10); // exactement au rayon : atteint
    expect(woundedAllyNear([u, edge], u)?.id).toBe(1);
    edge.pos = { x: 100 + HEART_HEAL_RADIUS + 0.01, y: 100 };
    expect(woundedAllyNear([u, edge], u)).toBeNull();
  });

  it('planHeartUse : (a) allié blessé + cœur > (b) cristal + blessé > (c) soi + cœur > (d) rien', () => {
    const u = mkPlayer(0, 100, 100);
    const ally = mkPlayer(1, 110, 100, 10);
    const all = [u, ally];
    // (d) rien : ni cœur, ni blessé
    expect(planHeartUse(all, u, null).kind).toBe('none');
    // un cœur mais personne n'a besoin de soin : rien (aucun gaspillage)
    ally.hp = ally.maxHp;
    u.heart = 'full';
    expect(planHeartUse(all, u, null).kind).toBe('none');
    // (c) soi : blessé + cœur
    u.hp = u.maxHp - 20;
    expect(planHeartUse(all, u, null).kind).toBe('self');
    // (b) cristal : blessé, cœur ou non (le cœur n'est pas touché)
    expect(planHeartUse(all, u, 'c1')).toEqual({ kind: 'crystal', crystalId: 'c1' });
    delete u.heart;
    expect(planHeartUse(all, u, 'c1')).toEqual({ kind: 'crystal', crystalId: 'c1' });
    // cristal mais joueur aux PV pleins : rien
    u.hp = u.maxHp;
    expect(planHeartUse(all, u, 'c1').kind).toBe('none');
    // (a) allié blessé + cœur : priorité sur le cristal et sur soi
    u.heart = 'half';
    u.hp = u.maxHp - 20;
    ally.hp = 10;
    const plan = planHeartUse(all, u, 'c1');
    expect(plan.kind).toBe('ally');
    if (plan.kind === 'ally') expect(plan.target.id).toBe(1);
    // allié blessé mais PAS de cœur : le cristal (b) passe devant
    delete u.heart;
    expect(planHeartUse(all, u, 'c1').kind).toBe('crystal');
    // à terre : rien
    u.heart = 'full';
    u.status = 'down';
    expect(planHeartUse(all, u, 'c1').kind).toBe('none');
  });

  it('heartUseAmount : min(valeur du cœur, manque) ; 0 sans cœur', () => {
    const u = mkPlayer(0, 0, 0);
    const t = mkPlayer(1, 0, 0);
    expect(heartUseAmount(u, t)).toBe(0);
    u.heart = 'full';
    t.hp = t.maxHp - 25;
    expect(heartUseAmount(u, t)).toBe(LOOT_FULL_HEAL);
    t.hp = t.maxHp - 3; // plafonné au manque
    expect(heartUseAmount(u, t)).toBe(3);
    u.heart = 'half';
    t.hp = t.maxHp - 25;
    expect(heartUseAmount(u, t)).toBe(LOOT_HALF_HEAL);
    t.hp = t.maxHp;
    expect(heartUseAmount(u, t)).toBe(0);
  });

  it('normalizeHeartField : valeur inconnue = vide, option fausse = toujours vide, n ajoute jamais de champ', () => {
    const p = mkPlayer(0, 0, 0);
    normalizeHeartField(p, true);
    expect('heart' in p).toBe(false);
    p.heart = 'full';
    normalizeHeartField(p, true);
    expect(p.heart).toBe('full');
    normalizeHeartField(p, false);
    expect('heart' in p).toBe(false);
    for (const hostile of ['banana', 5, null, {}, [], true]) {
      (p as unknown as { heart: unknown }).heart = hostile;
      normalizeHeartField(p, true);
      expect('heart' in p, String(hostile)).toBe(false);
    }
  });
});

// ───────────────────────────── Rangement ─────────────────────────────

describe('rangement : un cœur touché est RANGÉ, jamais consommé', () => {
  it('emplacement vide : rangé (PV pleins ou blessé), il disparaît du sol, aucun soin', () => {
    for (const hurt of [false, true]) {
      for (const kind of ['full', 'half'] as const) {
        const s = mk(1);
        s.step(DT, {});
        const hp0 = (s.state.players[0].hp = hurt ? 30 : s.state.players[0].maxHp);
        put(s, 0, 60, 60);
        const id = addPickup(s, kind, 62, 60);
        const ev = stepN(s, 2);
        expect(s.state.players[0].heart, `${kind} ${hurt}`).toBe(kind);
        expect(s.state.room.pickups).toHaveLength(0);
        expect(s.state.players[0].hp).toBe(hp0); // JAMAIS de soin au contact
        const stored = ofType(ev, 'heartStored');
        expect(stored).toHaveLength(1);
        expect(stored[0]).toMatchObject({ playerId: 0, pickupId: id, kind });
        expect(ofType(ev, 'pickupCollected')).toHaveLength(0);
      }
    }
  });

  it('emplacement ENTIER : on ne le ramasse pas, il reste au sol (aucun cumul, aucun remplacement)', () => {
    const s = mk(1);
    s.step(DT, {});
    s.state.players[0].heart = 'full';
    s.state.players[0].hp = 20; // blessé : l'ancien comportement l'aurait consommé
    put(s, 0, 60, 60);
    addPickup(s, 'half', 62, 60);
    const ev = stepN(s, 30);
    expect(s.state.players[0].heart).toBe('full'); // inchangé
    expect(s.state.players[0].hp).toBe(20);
    expect(s.state.room.pickups).toHaveLength(1);
    expect(ofType(ev, 'heartStored')).toHaveLength(0);
  });

  it('un allié à l emplacement libre prend l objet qu un joueur à l emplacement plein refuse ; le plus proche d abord', () => {
    const s = mk(2);
    s.step(DT, {});
    s.state.players[0].heart = 'full';
    put(s, 0, 60, 60);
    put(s, 1, 66, 60);
    addPickup(s, 'half', 62, 60);
    stepN(s, 2);
    expect(s.state.players[1].heart).toBe('half');
    expect(s.state.players[0].heart).toBe('full');
    expect(s.state.room.pickups).toHaveLength(0);
  });

  it('un joueur à terre ne range rien', () => {
    const s = mk(2);
    s.step(DT, {});
    s.knockDown(1);
    put(s, 1, 60, 60);
    put(s, 0, 140, 90);
    addPickup(s, 'full', 62, 60);
    stepN(s, 5);
    expect(s.state.players[1].heart).toBeUndefined();
    expect(s.state.room.pickups).toHaveLength(1);
  });

  it('la nourriture vieillit toujours (durée de vie) : un cœur au sol qu on ne prend pas finit par disparaître', () => {
    const s = mk(1);
    s.step(DT, {});
    s.state.players[0].heart = 'full';
    put(s, 0, 140, 90);
    addPickup(s, 'full', 40, 40, 100);
    stepN(s, 10);
    expect(s.state.room.pickups).toHaveLength(0);
  });
});

// ───────────────────────────── B : cibles et priorités ─────────────────────────────

describe('bouton B : utiliser le cœur (cibles a / b / c / d)', () => {
  it('(c) sur soi : cœur entier +10, demi-cœur +5, cœur consommé, événement heartUsed', () => {
    for (const [kind, amount] of [['full', LOOT_FULL_HEAL], ['half', LOOT_HALF_HEAL]] as const) {
      const s = mk(1);
      s.step(DT, {});
      const p = s.state.players[0];
      p.hp = 30;
      p.heart = kind;
      put(s, 0, 60, 60);
      const ev = pressB(s);
      expect(p.hp, kind).toBe(30 + amount);
      expect(p.heart).toBeUndefined();
      expect(ofType(ev, 'heartUsed')).toEqual([{ type: 'heartUsed', playerId: 0, targetId: 0, kind, amount, pos: { x: 60, y: 60 } }]);
    }
  });

  it('soin PLAFONNÉ au manque : le reste est perdu, le cœur est quand même consommé', () => {
    const s = mk(1);
    s.step(DT, {});
    const p = s.state.players[0];
    p.hp = p.maxHp - 3;
    p.heart = 'full';
    const ev = pressB(s);
    expect(p.hp).toBe(p.maxHp);
    expect(ofType(ev, 'heartUsed')[0].amount).toBe(3);
    expect(p.heart).toBeUndefined();
  });

  it('(d) AUCUN gaspillage : PV pleins et personne à soigner : le cœur n est PAS consommé (heartRefused, rien d autre)', () => {
    const s = mk(2);
    s.step(DT, {});
    s.state.players[0].heart = 'full';
    put(s, 0, 60, 60);
    put(s, 1, 61, 60);
    const ev = pressB(s);
    expect(s.state.players[0].heart).toBe('full');
    expect(ofType(ev, 'heartUsed')).toHaveLength(0);
    expect(ofType(ev, 'heartRefused')).toEqual([{ type: 'heartRefused', playerId: 0 }]);
  });

  it('(d) emplacement vide et blessé : rien (heartRefused)', () => {
    const s = mk(1);
    s.step(DT, {});
    s.state.players[0].hp = 10;
    const ev = pressB(s);
    expect(s.state.players[0].hp).toBe(10);
    expect(ofType(ev, 'heartRefused')).toHaveLength(1);
  });

  it('(a) un coéquipier blessé à portée : on LE soigne (priorité sur soi), même si on est blessé aussi ; le plus proche si plusieurs', () => {
    const s = mk(3);
    s.step(DT, {});
    const [u, a1, a2] = s.state.players;
    u.hp = 20;
    u.heart = 'full';
    a1.hp = 10;
    a2.hp = 10;
    put(s, 0, 60, 60);
    put(s, 1, 60 + 20, 60);
    put(s, 2, 60 + 8, 60);
    const ev = pressB(s);
    expect(a2.hp).toBe(20); // le plus proche (8 px)
    expect(a1.hp).toBe(10);
    expect(u.hp).toBe(20); // pas soi-même
    expect(u.heart).toBeUndefined();
    expect(ofType(ev, 'heartUsed')[0]).toMatchObject({ playerId: 0, targetId: 2, amount: 10 });
  });

  it('(a) hors du rayon de contact : on se soigne soi-même ; un allié aux PV pleins n est pas une cible', () => {
    const s = mk(2);
    s.step(DT, {});
    const [u, a] = s.state.players;
    u.hp = 20;
    u.heart = 'half';
    a.hp = 10;
    put(s, 0, 60, 60);
    put(s, 1, 60 + HEART_HEAL_RADIUS + 2, 60); // juste hors portée
    pressB(s);
    expect(u.hp).toBe(25);
    expect(a.hp).toBe(10);
    // allié aux PV pleins à portée : soi
    const s2 = mk(2);
    s2.step(DT, {});
    s2.state.players[0].hp = 20;
    s2.state.players[0].heart = 'half';
    put(s2, 0, 60, 60);
    put(s2, 1, 62, 60);
    pressB(s2);
    expect(s2.state.players[0].hp).toBe(25);
  });

  it('soin d un coéquipier plafonné à SON manque ; joueur à terre : pas soignable, B ne le cible pas (on se soigne soi-même)', () => {
    const s = mk(2);
    s.step(DT, {});
    const [u, a] = s.state.players;
    u.heart = 'full';
    a.hp = a.maxHp - 4;
    put(s, 0, 60, 60);
    put(s, 1, 70, 60);
    const ev = pressB(s);
    expect(a.hp).toBe(a.maxHp);
    expect(ofType(ev, 'heartUsed')[0].amount).toBe(4);
    // à terre : jamais soigné
    const s2 = mk(2);
    s2.step(DT, {});
    s2.state.players[0].heart = 'full';
    s2.state.players[0].hp = 30;
    put(s2, 0, 60, 60);
    put(s2, 1, 62, 60);
    s2.knockDown(1);
    pressB(s2);
    expect(s2.state.players[1].status).toBe('down');
    expect(s2.state.players[1].hp).toBe(0);
    expect(s2.state.players[0].hp).toBe(40); // lui-même
  });

  it('un joueur À TERRE ne peut pas utiliser B', () => {
    const s = mk(2);
    s.step(DT, {});
    s.state.players[0].hp = 10;
    s.state.players[0].heart = 'full';
    s.knockDown(0); // perd son cœur (au sol) : on simule un état incohérent en le lui rendant
    s.state.players[0].heart = 'full';
    s.state.players[1].hp = 5;
    put(s, 0, 60, 60);
    put(s, 1, 62, 60);
    const ev = pressB(s);
    expect(ofType(ev, 'heartUsed')).toHaveLength(0);
    expect(s.state.players[1].hp).toBe(5);
  });

  it('front montant : B maintenu = UN seul effet ; relâcher puis ré-appuyer = un nouvel effet', () => {
    const s = mk(1);
    s.step(DT, {});
    const p = s.state.players[0];
    p.hp = 20;
    p.heart = 'half';
    const ev = stepN(s, 30, { 0: B });
    expect(ofType(ev, 'heartUsed')).toHaveLength(1);
    expect(p.hp).toBe(25);
    expect(ofType(ev, 'heartRefused')).toHaveLength(0); // le maintien ne rejoue rien
    // nouvel appui avec un autre cœur
    p.heart = 'full';
    stepN(s, 1, {});
    const ev2 = stepN(s, 1, { 0: B });
    expect(ofType(ev2, 'heartUsed')).toHaveLength(1);
    expect(p.hp).toBe(35);
  });

  it('B tenu AVANT le pas où l option démarre (p.prev.heart) : pas de front montant fantôme', () => {
    const s = mk(1);
    s.step(DT, { 0: B }); // B tenu dès le premier pas, rien à utiliser : un refus, mais prev.heart est mémorisé
    s.state.players[0].hp = 20;
    s.state.players[0].heart = 'full';
    const ev = stepN(s, 5, { 0: B }); // toujours tenu : aucun nouveau front montant
    expect(ofType(ev, 'heartUsed')).toHaveLength(0);
    expect(s.state.players[0].heart).toBe('full');
  });

  it('un appui B pendant un RELEVAGE (A tenu, allié à terre à portée) n a aucun effet : le relevage reste prioritaire', () => {
    const s = mk(2);
    s.step(DT, {});
    const [u, a] = s.state.players;
    u.hp = 10;
    u.heart = 'full';
    put(s, 0, 60, 60);
    put(s, 1, 70, 60);
    s.knockDown(1);
    const ev = stepN(s, 3, { 0: frame({ revive: true, heart: true }) });
    expect(ofType(ev, 'heartUsed')).toHaveLength(0);
    expect(ofType(ev, 'reviveStarted')).toHaveLength(1);
    expect(u.heart).toBe('full');
    expect(a.status).toBe('down');
  });

  it('B ne déclenche AUCUNE autre action : pas d attaque, pas d interaction, pas d appel', () => {
    const s = mk(2);
    s.step(DT, {});
    s.state.players[0].heart = 'full';
    const ev = stepN(s, 3, { 0: B });
    expect(ofType(ev, 'playerAttack')).toHaveLength(0);
    expect(ofType(ev, 'callStarted')).toHaveLength(0);
    expect(s.state.players[0].callMs).toBe(0);
    expect(s.state.players[0].attackAnimMs).toBe(0);
  });

  it('un appui d APPEL le même pas prime : B est perdu (pas rejoué), et pendant le gel de l appel B est ignoré', () => {
    const s = mk(2);
    s.step(DT, {});
    const p = s.state.players[0];
    p.hp = 10;
    p.heart = 'full';
    const ev = stepN(s, 1, { 0: frame({ call: true, heart: true }) });
    expect(ofType(ev, 'callStarted')).toHaveLength(1);
    expect(ofType(ev, 'heartUsed')).toHaveLength(0);
    // pendant le gel : B (nouveau front montant) ignoré
    stepN(s, 1, {});
    const ev2 = stepN(s, 1, { 0: B });
    expect(ofType(ev2, 'heartUsed')).toHaveLength(0);
    expect(ofType(ev2, 'heartRefused')).toHaveLength(0);
    expect(p.heart).toBe('full');
  });

  it('B n a aucun effet hors des phases playing / roomCleared (niveau terminé, défaite d équipe)', () => {
    const s = mk(1);
    s.step(DT, {});
    s.state.players[0].hp = 10;
    s.state.players[0].heart = 'full';
    s.state.phase = 'levelComplete';
    const ev = pressB(s);
    expect(ofType(ev, 'heartUsed')).toHaveLength(0);
    expect(ofType(ev, 'heartRefused')).toHaveLength(0);
    expect(s.state.players[0].hp).toBe(10);
  });
});

// ───────────────────────────── Cristal de soin volontaire ─────────────────────────────

describe('cristal de soin : volontaire (B), ne soigne plus au contact', () => {
  const CRYSTAL: HealCrystalDef[] = [{ id: 'c1', tile: [4, 4] }];
  const C1 = { x: 4.5 * 16, y: 4.5 * 16 };

  it('au contact : AUCUN soin, le cristal reste intact (même blessé)', () => {
    const s = mk(1, { crystals: CRYSTAL });
    s.step(DT, {});
    s.state.players[0].hp = 10;
    put(s, 0, C1.x, C1.y);
    const ev = stepN(s, 30);
    expect(s.state.players[0].hp).toBe(10);
    expect(s.state.room.healCrystals?.[0].used).toBe(false);
    expect(ofType(ev, 'crystalUsed')).toHaveLength(0);
  });

  it('(b) B sous les pieds, joueur blessé : le CRISTAL est utilisé (+50 plafonné) et le cœur rangé n est pas touché', () => {
    const s = mk(1, { crystals: CRYSTAL });
    s.step(DT, {});
    const p = s.state.players[0];
    p.hp = p.maxHp - 30;
    p.heart = 'full';
    put(s, 0, C1.x + 2, C1.y);
    const ev = pressB(s);
    expect(p.hp).toBe(p.maxHp); // plafonné au manque (30 < 50)
    expect(p.heart).toBe('full');
    expect(s.state.room.healCrystals?.[0].used).toBe(true);
    expect(ofType(ev, 'crystalUsed')).toEqual([{ type: 'crystalUsed', crystalId: 'c1', playerId: 0, healed: 30, pos: { x: C1.x, y: C1.y } }]);
    expect(ofType(ev, 'heartUsed')).toHaveLength(0);
  });

  it('soin complet du cristal : HEAL_CRYSTAL_HEAL PV ; il se vide à l usage et ne sert qu une fois', () => {
    const s = mk(1, { crystals: CRYSTAL });
    s.step(DT, {});
    s.state.players[0].hp = 10;
    put(s, 0, C1.x, C1.y);
    pressB(s);
    expect(s.state.players[0].hp).toBe(10 + HEAL_CRYSTAL_HEAL);
    s.state.players[0].hp = 10;
    pressB(s);
    expect(s.state.players[0].hp).toBe(10); // déjà utilisé : rien
  });

  it('PV pleins sous le cristal : B ne l utilise pas (aucun gaspillage)', () => {
    const s = mk(1, { crystals: CRYSTAL });
    s.step(DT, {});
    put(s, 0, C1.x, C1.y);
    const ev = pressB(s);
    expect(s.state.room.healCrystals?.[0].used).toBe(false);
    expect(ofType(ev, 'heartRefused')).toHaveLength(1);
  });

  it('hors du rayon de contact : B ne l utilise pas', () => {
    const s = mk(1, { crystals: CRYSTAL });
    s.step(DT, {});
    s.state.players[0].hp = 10;
    put(s, 0, C1.x + HEAL_CRYSTAL_RADIUS + 4, C1.y);
    pressB(s);
    expect(s.state.room.healCrystals?.[0].used).toBe(false);
    expect(s.state.players[0].hp).toBe(10);
  });

  it('priorité : un coéquipier blessé à portée ET un cœur rangé passent AVANT le cristal', () => {
    const s = mk(2, { crystals: CRYSTAL });
    s.step(DT, {});
    const [u, a] = s.state.players;
    u.hp = 10;
    u.heart = 'full';
    a.hp = 10;
    put(s, 0, C1.x, C1.y);
    put(s, 1, C1.x + 10, C1.y);
    pressB(s);
    expect(a.hp).toBe(20);
    expect(u.heart).toBeUndefined();
    expect(s.state.room.healCrystals?.[0].used).toBe(false);
  });
});

// ───────────────────────────── Perte à la chute ─────────────────────────────

describe('perte du cœur rangé : il tombe au sol aux pieds du joueur à terre', () => {
  it('chute scénarisée (knockDown) : heartLost + pickupDropped, ramassable sans verrou, durée de vie habituelle', () => {
    const s = mk(2);
    s.step(DT, {});
    s.state.players[1].heart = 'half';
    put(s, 1, 80, 60);
    put(s, 0, 40, 40);
    expect(s.knockDown(1)).toBe(true);
    const ev = s.step(DT, {});
    expect(s.state.players[1].heart).toBeUndefined();
    expect(ofType(ev, 'heartLost')).toEqual([{ type: 'heartLost', playerId: 1, kind: 'half', pos: { x: 80, y: 60 } }]);
    const dropped = ofType(ev, 'pickupDropped');
    expect(dropped).toHaveLength(1);
    expect(dropped[0].kind).toBe('half');
    const pk = s.state.room.pickups?.[0];
    expect(pk?.kind).toBe('half');
    expect(pk?.ttlMs).toBeGreaterThan(PICKUP_TTL_MS - 200);
    expect(Math.hypot((pk?.pos.x ?? 0) - 80, (pk?.pos.y ?? 0) - 60)).toBeLessThan(1); // aux pieds
    // l allié (emplacement libre) peut le ramasser : aucun verrou
    put(s, 0, 80, 60);
    stepN(s, 2);
    expect(s.state.players[0].heart).toBe('half');
    expect(s.state.room.pickups).toHaveLength(0);
  });

  it('chute AU COMBAT (un ennemi achève le joueur) : même règle', () => {
    const room = makeTestRoom({ id: 'r1', enemies: [{ kind: 'knight', tile: [4, 3] }], exit: { rect: { x: 9, y: 5, w: 2, h: 2 }, requires: ['p1'] } });
    const level = makeTestLevel({ rooms: [{ ...room, exit: { ...room.exit, final: true } }] });
    const s = createSimulation({ levelId: level.id, players: [{ id: 0, characterId: 'sandrine', difficulty: 3 }, { id: 1, characterId: 'david', difficulty: 3 }], seed: 3, gear: false, heartSlot: true }, level);
    s.step(DT, {});
    const p = s.state.players[0];
    p.heart = 'full';
    p.hp = 1;
    const e = s.state.room.enemies[0];
    p.pos = { x: e.pos.x - 6, y: e.pos.y };
    s.state.players[1].pos = { x: 140, y: 90 };
    let lost: SimEvent[] = [];
    for (let i = 0; i < 600 && p.status === 'alive'; i++) lost = ofType(s.step(DT, {}), 'heartLost');
    expect(p.status).toBe('down');
    expect(p.heart).toBeUndefined();
    expect(s.state.room.pickups?.some((pk) => pk.kind === 'full')).toBe(true);
    expect(lost.length + (s.state.room.pickups?.length ?? 0)).toBeGreaterThan(0);
  });

  it('défaite d équipe : TOUS les cœurs rangés sont perdus (strict), aucun n est restitué après le redémarrage de la salle', () => {
    const s = mk(2);
    s.step(DT, {});
    s.state.players[0].heart = 'full';
    s.state.players[1].heart = 'half';
    s.knockDown(0);
    s.knockDown(1);
    const ev = s.step(DT, {});
    expect(ofType(ev, 'heartLost').map((e) => e.playerId).sort()).toEqual([0, 1]);
    expect(s.state.players.every((p) => p.heart === undefined)).toBe(true);
    expect(s.state.phase).toBe('wipe');
    const after = stepN(s, Math.ceil(WIPE_RESTART_DELAY_MS / DT) + 10);
    expect(ofType(after, 'roomEntered').some((e) => e.reason === 'restart')).toBe(true);
    expect(s.state.players.every((p) => p.heart === undefined)).toBe(true);
    expect(s.state.room.pickups).toHaveLength(0); // sol neuf : aucun chemin pour « mourir exprès et retrouver »
  });

  it('idempotent : un joueur sans cœur qui tombe ne produit ni heartLost ni objet au sol ; une nouvelle perte ne se répète pas', () => {
    const s = mk(2);
    s.step(DT, {});
    s.knockDown(1);
    const ev = s.step(DT, {});
    expect(ofType(ev, 'heartLost')).toHaveLength(0);
    expect(s.state.room.pickups).toHaveLength(0);
  });

  it('le cœur rangé survit au changement de salle (comme l équipement) mais pas à une nouvelle simulation (nouveau niveau)', () => {
    const r1 = makeTestRoom({ id: 'r1', exit: { rect: { x: 9, y: 5, w: 2, h: 2 }, requires: [] } });
    const r2 = makeTestRoom({ id: 'r2', exit: { rect: { x: 9, y: 5, w: 2, h: 2 }, requires: [], final: true } });
    const level = makeTestLevel({ rooms: [r1, r2] });
    const s = createSimulation({ levelId: level.id, players: [{ id: 0, characterId: 'david', difficulty: 2 }], seed: 5, heartSlot: true }, level);
    s.step(DT, {});
    s.state.players[0].heart = 'full';
    s.state.players[0].pos = { x: 10 * 16, y: 6 * 16 };
    for (let i = 0; i < 400 && s.state.roomIndex === 0; i++) s.step(DT, {});
    expect(s.state.roomIndex).toBe(1);
    expect(s.state.players[0].heart).toBe('full');
    const fresh = createSimulation({ levelId: level.id, players: [{ id: 0, characterId: 'david', difficulty: 2 }], seed: 5, heartSlot: true }, level);
    expect(fresh.state.players[0].heart).toBeUndefined();
  });
});

// ───────────────────────────── Aimant ─────────────────────────────

describe('aimant : ne tire un cœur que vers un porteur qui peut le ranger', () => {
  const MAGNET = { kind: 'magnet' as const, level: 3 as const };

  function magnetSim(heart?: PickupKind): GameSimulation {
    const s = mk(1, { gear: true });
    s.step(DT, {});
    s.state.players[0].loadout.accessory = { ...MAGNET };
    if (heart) s.state.players[0].heart = heart;
    put(s, 0, 60, 60);
    return s;
  }

  it('emplacement vide (même aux PV pleins) : le cœur est tiré puis rangé', () => {
    const s = magnetSim();
    addPickup(s, 'half', 60 + 70, 60);
    stepN(s, 200);
    expect(s.state.players[0].heart).toBe('half');
    expect(s.state.room.pickups).toHaveLength(0);
  });

  it('emplacement plein (même blessé) : le cœur n est PAS tiré', () => {
    const s = magnetSim('full');
    s.state.players[0].hp = 10;
    const id = addPickup(s, 'half', 60 + 70, 60);
    stepN(s, 120);
    const pk = s.state.room.pickups?.find((p) => p.id === id);
    expect(pk?.pos.x).toBe(130);
    expect(s.state.players[0].heart).toBe('full');
  });
});

// ───────────────────────────── Option heartSlot fausse : ancien comportement exact ─────────────────────────────

describe('heartSlot faux (bots, calibration, démo) : ancien comportement exact', () => {
  it('le cœur est consommé au contact (blessé), refusé aux PV pleins ; le cristal soigne au contact ; B ne fait rien', () => {
    const s = mk(1, { heartSlot: false, crystals: [{ id: 'c1', tile: [4, 4] }] });
    s.step(DT, {});
    s.state.players[0].hp = 20;
    put(s, 0, 60, 60);
    addPickup(s, 'full', 62, 60);
    const ev = stepN(s, 2);
    expect(s.state.players[0].hp).toBe(30);
    expect(ofType(ev, 'pickupCollected')).toHaveLength(1);
    expect(s.state.players[0].heart).toBeUndefined();
    // B : aucun effet
    s.state.players[0].hp = 20;
    const ev2 = pressB(s);
    expect(ofType(ev2, 'heartRefused')).toHaveLength(0);
    expect(ofType(ev2, 'heartUsed')).toHaveLength(0);
    // cristal au contact
    put(s, 0, 4.5 * 16, 4.5 * 16);
    const ev3 = stepN(s, 2);
    expect(ofType(ev3, 'crystalUsed')).toHaveLength(1);
  });

  it('l état n a ni champ heartSlot, ni champ heart, ni prev.heart : identique à celui d avant l ajout', () => {
    const s = mk(2, { heartSlot: false });
    stepN(s, 30, { 0: B });
    expect('heartSlot' in s.state).toBe(false);
    for (const p of s.state.players) {
      expect('heart' in p).toBe(false);
      expect(Object.keys(p.prev).sort()).toEqual(['attack', 'call', 'interact', 'revive', 'special']);
    }
    expect(JSON.stringify(s.state)).not.toContain('heart');
  });

  it('initialHearts est ignoré sans l option ; avec l option, les valeurs inconnues sont ignorées', () => {
    const level = makeTestLevel();
    const off = createSimulation({ levelId: level.id, players: [{ id: 0, characterId: 'david', difficulty: 2 }], seed: 1, initialHearts: ['full'] }, level);
    expect(off.state.players[0].heart).toBeUndefined();
    const on = createSimulation({ levelId: level.id, players: [{ id: 0, characterId: 'david', difficulty: 2 }, { id: 1, characterId: 'sandrine', difficulty: 2 }, { id: 2, characterId: 'romain', difficulty: 2 }], seed: 1, heartSlot: true, initialHearts: ['full', 'banana' as unknown as PickupKind, 'half'] }, level);
    expect(on.state.players.map((p) => p.heart)).toEqual(['full', undefined, 'half']);
    expect('heart' in on.state.players[1]).toBe(false);
  });
});

// ───────────────────────────── Flux aléatoires intacts, déterminisme, sérialisation ─────────────────────────────

describe('non-régression : flux aléatoires, déterminisme, sérialisation', () => {
  function fight(heartSlot: boolean, withB: boolean): GameSimulation {
    const room = makeTestRoom({
      id: 'r1',
      enemies: [
        { kind: 'slime', tile: [6, 2] },
        { kind: 'slime', tile: [7, 3] },
        { kind: 'skeleton', tile: [8, 2] },
        { kind: 'knight', tile: [8, 4] },
        { kind: 'slime', tile: [5, 5] },
      ],
      exit: { rect: { x: 9, y: 5, w: 2, h: 2 }, requires: ['p1'] },
    });
    const level = makeTestLevel({ rooms: [{ ...room, exit: { ...room.exit, final: true } }] });
    const s = createSimulation({ levelId: level.id, players: [{ id: 0, characterId: 'david', difficulty: 1 }, { id: 1, characterId: 'sandrine', difficulty: 1 }], seed: 11, heartSlot }, level);
    for (let i = 0; i < 1500; i++) {
      const f0 = frame({ attack: i % 3 !== 0, moveX: Math.sin(i / 40), moveY: Math.cos(i / 55), heart: withB && i % 50 === 0 });
      s.step(DT, { 0: f0, 1: frame({ attack: true, moveX: Math.cos(i / 30), moveY: Math.sin(i / 70) }) });
    }
    return s;
  }

  it('avec ou sans emplacement cœur (B jamais utilisé) : rngState, lootRngState, gearRngState et ennemis identiques', () => {
    const a = fight(false, false);
    const b = fight(true, false);
    expect(b.state.rngState).toBe(a.state.rngState);
    expect(b.state.lootRngState).toBe(a.state.lootRngState);
    expect(b.state.gearRngState).toBe(a.state.gearRngState);
    expect(b.state.nextPickupId).toBe(a.state.nextPickupId);
    expect(JSON.stringify(b.state.room.enemies)).toBe(JSON.stringify(a.state.room.enemies));
  });

  it('utiliser B ne tire AUCUN flux aléatoire (les flux restent ceux de la partie sans B)', () => {
    const a = fight(true, false);
    const b = fight(true, true);
    expect(b.state.rngState).toBe(a.state.rngState);
    expect(b.state.lootRngState).toBe(a.state.lootRngState);
    expect(b.state.gearRngState).toBe(a.state.gearRngState);
  });

  it('déterminisme : même graine, mêmes entrées = même état (avec cœurs rangés et utilisés)', () => {
    expect(fight(true, true).serialize()).toBe(fight(true, true).serialize());
  });

  it('sérialisation / restauration : le cœur rangé, l option et la mémoire de B survivent ; la suite est identique', () => {
    const s = mk(2);
    s.step(DT, {});
    s.state.players[0].heart = 'full';
    s.state.players[1].hp = 10;
    put(s, 0, 60, 60);
    put(s, 1, 64, 60);
    s.step(DT, { 0: B });
    const snap = s.serialize();
    const r = GameSimulation.restore(snap, s.level);
    expect(r.state.heartSlot).toBe(true);
    expect(r.state.players[0].heart).toBeUndefined(); // consommé
    expect(r.state.players[0].prev.heart).toBe(true);
    // la suite de l état est strictement identique
    for (let i = 0; i < 20; i++) {
      s.step(DT, { 0: B });
      r.step(DT, { 0: B });
    }
    expect(r.serialize()).toBe(s.serialize());
    // un cœur rangé survit au snapshot
    const s2 = mk(1);
    s2.step(DT, {});
    s2.state.players[0].heart = 'half';
    expect(GameSimulation.restore(s2.serialize(), s2.level).state.players[0].heart).toBe('half');
  });

  it('restauration tolérante : ancien snapshot sans option ; valeur hostile (heart) = emplacement vide ; sans l option, jamais de cœur', () => {
    const s = mk(1);
    s.step(DT, {});
    const raw = JSON.parse(s.serialize()) as { players: Array<Record<string, unknown>>; heartSlot?: boolean };
    // hostile avec l option
    raw.players[0].heart = 'banana';
    expect(GameSimulation.restore(JSON.stringify(raw), s.level).state.players[0].heart).toBeUndefined();
    raw.players[0].heart = 42;
    expect('heart' in GameSimulation.restore(JSON.stringify(raw), s.level).state.players[0]).toBe(false);
    raw.players[0].heart = 'full';
    expect(GameSimulation.restore(JSON.stringify(raw), s.level).state.players[0].heart).toBe('full');
    // sans l option : le champ est supprimé (ancien comportement)
    delete raw.heartSlot;
    const legacy = GameSimulation.restore(JSON.stringify(raw), s.level);
    expect('heart' in legacy.state.players[0]).toBe(false);
    expect(legacy.state.heartSlot).toBeUndefined();
  });
});

// ───────────────────────────── Bout en bout ─────────────────────────────

describe('bout en bout : jouer avec l emplacement cœur', () => {
  it('1 joueur : un ennemi laisse un cœur, on le range en passant dessus (PV pleins), on se blesse, B le consomme', () => {
    const room = makeTestRoom({ id: 'r1', enemies: [{ kind: 'slime', tile: [5, 3] }], exit: { rect: { x: 9, y: 5, w: 2, h: 2 }, requires: ['p1'] } });
    const level = makeTestLevel({ rooms: [{ ...room, exit: { ...room.exit, final: true } }] });
    const s = createSimulation({ levelId: level.id, players: [{ id: 0, characterId: 'david', difficulty: 1 }], seed: 2, heartSlot: true }, level);
    s.step(DT, {});
    for (const e of s.state.room.enemies) e.hp = 0;
    s.step(DT, {});
    // quel que soit le tirage, on pose un cœur au sol pour la suite du scénario (le butin est aléatoire et testé ailleurs)
    s.state.room.pickups = [];
    const p = s.state.players[0];
    p.pos = { x: 40, y: 40 };
    addPickup(s, 'full', 42, 40);
    stepN(s, 2);
    expect(p.heart).toBe('full');
    expect(p.hp).toBe(p.maxHp); // rangé, pas consommé, même aux PV pleins
    p.hp = p.maxHp - 25;
    const ev = pressB(s);
    expect(p.hp).toBe(p.maxHp - 15);
    expect(ofType(ev, 'heartUsed')[0]).toMatchObject({ playerId: 0, targetId: 0, amount: 10 });
    expect(p.heart).toBeUndefined();
  });

  it('2 joueurs : J1 range un cœur, J2 est blessé ; J1 se place sur J2 et appuie sur B ; l emplacement plein de J1 déclenche l appel automatique', () => {
    const s = mk(2);
    s.step(DT, {});
    const [a, b] = s.state.players;
    b.hp = 15;
    put(s, 0, 40, 40);
    put(s, 1, 120, 40);
    addPickup(s, 'full', 42, 40);
    stepN(s, 2);
    expect(a.heart).toBe('full');
    // J1 range, puis un deuxième cœur au sol à ses pieds : emplacement ENTIER, J2 a l emplacement libre -> appel automatique avec le symbole du demi-cœur
    addPickup(s, 'half', 41, 40);
    const ev = stepN(s, 2);
    const calls = ofType(ev, 'autoCallStarted');
    expect(calls).toEqual([{ type: 'autoCallStarted', playerId: 0, icon: 'half', to: [1] }]);
    expect(a.heart).toBe('full'); // pas de remplacement
    // J1 rejoint J2 et le soigne
    put(s, 0, 112, 40);
    const ev2 = pressB(s);
    expect(ofType(ev2, 'heartUsed')[0]).toMatchObject({ playerId: 0, targetId: 1, amount: 10 });
    expect(b.hp).toBe(25);
    expect(a.heart).toBeUndefined();
    // J2 (emplacement libre) prend le demi-cœur resté au sol
    put(s, 1, 41, 40);
    stepN(s, 2);
    expect(b.heart).toBe('half');
  });

  it('rien n est jamais consommé tout seul : en traversant la salle blessé, aucun PV n est regagné', () => {
    const s = mk(1);
    s.step(DT, {});
    const p = s.state.players[0];
    p.hp = 10;
    addPickup(s, 'full', 60, 60);
    addPickup(s, 'half', 80, 60);
    put(s, 0, 60, 60);
    stepN(s, 2);
    put(s, 0, 80, 60);
    stepN(s, 2);
    expect(p.hp).toBe(10);
    expect(p.heart).toBe('full'); // le premier rangé ; le second est resté au sol (plein)
    expect(s.state.room.pickups).toHaveLength(1);
  });
});

describe('délai de salle terminée (roomCleared) : B et le rangement restent actifs', () => {
  const clearedSim = (n: number): GameSimulation => {
    const s = mk(n);
    s.step(DT, {});
    s.state.phase = 'roomCleared';
    s.state.phaseTimerMs = 0;
    return s;
  };

  it('B soigne soi-même pendant roomCleared (les PV passent à la salle suivante)', () => {
    const s = clearedSim(1);
    const p = s.state.players[0];
    p.hp = 20;
    p.heart = 'full';
    const ev = pressB(s);
    expect(ofType(ev, 'heartUsed')).toHaveLength(1);
    expect(p.hp).toBe(30);
    expect(p.heart).toBeUndefined();
  });

  it('B soigne un coéquipier blessé pendant roomCleared ; front montant (B tenu depuis avant : rien)', () => {
    const s = clearedSim(2);
    const [u, a] = s.state.players;
    u.heart = 'half';
    a.hp = 10;
    put(s, 0, 60, 60);
    put(s, 1, 70, 60);
    s.state.players[0].prev.heart = true; // B déjà tenu au pas précédent
    expect(ofType(s.step(DT, { 0: B }), 'heartUsed')).toHaveLength(0);
    s.step(DT, {});
    expect(ofType(s.step(DT, { 0: B }), 'heartUsed')).toHaveLength(1);
    expect(a.hp).toBe(15);
  });

  it('un cœur au sol (butin du dernier ennemi) est RANGÉ pendant roomCleared', () => {
    const s = clearedSim(1);
    put(s, 0, 60, 60);
    addPickup(s, 'full', 60, 60);
    const ev = s.step(DT, {});
    expect(ofType(ev, 'heartStored')).toHaveLength(1);
    expect(s.state.players[0].heart).toBe('full');
    expect(s.state.room.pickups).toHaveLength(0);
  });

  it('sans l option heartSlot : roomCleared ne range rien et B ne fait rien (ancien comportement)', () => {
    const s = mk(1, { heartSlot: false });
    s.step(DT, {});
    s.state.phase = 'roomCleared';
    s.state.phaseTimerMs = 0;
    put(s, 0, 60, 60);
    addPickup(s, 'full', 60, 60);
    const ev = stepN(s, 3, { 0: B });
    expect(ofType(ev, 'heartStored')).toHaveLength(0);
    expect(ofType(ev, 'heartUsed')).toHaveLength(0);
    expect(s.state.room.pickups).toHaveLength(1);
  });
});

describe('wound / spawnScriptedHeart (tutoriel)', () => {
  it('woundPlayer ramène les PV à la fraction demandée sans jamais soigner ni mettre à terre', () => {
    const s = mk(2);
    s.step(DT, {});
    const p = s.state.players[1];
    expect(s.woundPlayer(1, 0.5)).toBe(true);
    expect(p.hp).toBe(Math.floor(p.maxHp * 0.5));
    expect(s.woundPlayer(1, 0.9)).toBe(false); // plus bas déjà : ne soigne pas
    expect(p.hp).toBe(Math.floor(p.maxHp * 0.5));
    expect(s.woundPlayer(1, 0)).toBe(true);
    expect(p.hp).toBe(1); // jamais à terre
    expect(p.status).toBe('alive');
    expect(s.woundPlayer(9 as PlayerId, 0.5)).toBe(false);
    expect(s.woundPlayer(0, Number.NaN)).toBe(false);
  });

  it('spawnScriptedHeart pose un cœur à durée de vie longue, événement pickupDropped au pas suivant ; refuse les valeurs invalides', () => {
    const s = mk(1);
    s.step(DT, {});
    expect(s.spawnScriptedHeart({ x: 60, y: 60 }, 'full', 600_000)).toBe(true);
    expect(s.spawnScriptedHeart({ x: 60, y: 60 }, 'banana' as unknown as PickupKind, 1000)).toBe(false);
    expect(s.spawnScriptedHeart({ x: 60, y: 60 }, 'half', 0)).toBe(false);
    const ev = s.step(DT, {});
    expect(ofType(ev, 'pickupDropped')).toHaveLength(1);
    expect(s.state.room.pickups?.[0].ttlMs).toBeGreaterThan(599_000);
    expect(s.state.rngState).toBe(mk(1).state.rngState); // aucun tirage
  });
});
