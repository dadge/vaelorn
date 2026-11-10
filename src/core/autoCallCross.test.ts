/**
 * CROIX ROUGE = DEMANDE DE SOINS (appel automatique, `icon: 'cross'`, constantes [B30]) : seuil de 30 % des PV max, répétition toutes les 10 s, réarmement à 60 % ou à l'entrée d'une salle,
 * joueur à terre, destinataires (emplacement cœur contenant un cœur utilisable, ou Valentine vivante), aucun soigneur, priorité (remplace un appel d'objet, jamais un appel manuel),
 * solo, anciens états, valeurs hostiles, simulation de bout en bout (2-3 joueurs) et NON-RÉGRESSION (flux aléatoires et état identiques hors champs d'appel automatique).
 * Aucune horloge réelle : tout passe par des pas fixes.
 */
import { describe, expect, it } from 'vitest';
import { CROSS_REF, canHealWithCross, isCrossLow, isCrossRearmed, normalizeAutoCallFields, stepAutoCalls } from './autoCall';
import { AUTO_CALL_COOLDOWN_MS, AUTO_CALL_DURATION_MS, CROSS_CALL_REARM_FRACTION, CROSS_CALL_REPEAT_MS, CROSS_CALL_THRESHOLD, GEAR_TTL_MS } from './balance';
import { SIM_STEP_MS } from './constants';
import { createEnemyState } from './ai';
import { makeTestLayout, makeTestLevel, makeTestRoom } from './levelValidation';
import { createPlayerState, markPlayerDown, resetAutoCall, resetPlayersForRoom, startCall, stepPlayerTimers } from './players';
import { createSimulation, GameSimulation } from './simulation';
import type { ActionFrame, CharacterId, GearDropState, LevelDef, PickupState, PlayerId, PlayerState, SimEvent, TickInputs } from './types';

const DT = SIM_STEP_MS;

// ───────────────────────────── Outils ─────────────────────────────

function mk(id: PlayerId, character: CharacterId = 'david', x = 100 + id * 200, y = 100): PlayerState {
  return createPlayerState({ id, characterId: character, difficulty: 2 }, { x, y });
}

/** Met le joueur à `fraction` de ses PV max. */
function hpAt(p: PlayerState, fraction: number): void {
  p.hp = p.maxHp * fraction;
}

const cross = (ev: readonly SimEvent[]): Extract<SimEvent, { type: 'autoCallStarted' }>[] =>
  ev.filter((e): e is Extract<SimEvent, { type: 'autoCallStarted' }> => e.type === 'autoCallStarted' && e.icon === 'cross');

/** Un pas : minuteurs de tous les joueurs puis `stepAutoCalls` (équivalent du début d'un pas de simulation), avec l'emplacement cœur. */
function tick(players: PlayerState[], steps = 1, gd: GearDropState[] = [], heartSlot = true, pickups: PickupState[] = []): SimEvent[] {
  const out: SimEvent[] = [];
  for (let i = 0; i < steps; i++) {
    for (const p of players) stepPlayerTimers(p, DT);
    out.push(...stepAutoCalls(players, pickups, gd, [], { heartSlot }));
  }
  return out;
}
const ms = (n: number): number => Math.ceil(n / DT);

/** Un patient (david) à 20 % et un soigneur (mira, cœur rangé). */
function duo(): { a: PlayerState; b: PlayerState } {
  const a = mk(0);
  const b = mk(1, 'mira');
  b.heart = 'full';
  hpAt(a, 0.2);
  return { a, b };
}

// ───────────────────────────── Constantes figées [B30] ─────────────────────────────

describe('constantes [B30]', () => {
  it('seuil 30 %, réarmement 60 %, répétition 10 s ; la croix ne dure pas plus que le signal des autres appels automatiques (3 s)', () => {
    expect(CROSS_CALL_THRESHOLD).toBe(0.3);
    expect(CROSS_CALL_REARM_FRACTION).toBe(0.6);
    expect(CROSS_CALL_REPEAT_MS).toBe(10_000);
    expect(AUTO_CALL_DURATION_MS).toBe(3000);
    expect(CROSS_CALL_REPEAT_MS).toBeGreaterThan(AUTO_CALL_DURATION_MS);
  });
});

// ───────────────────────────── Seuil ─────────────────────────────

describe('seuil : 30 % des PV max ou moins', () => {
  it('isCrossLow / isCrossRearmed : bornes exactes (0,3 × PV max compris, 0,6 × PV max compris)', () => {
    const p = mk(0);
    p.maxHp = 50;
    p.hp = 15;
    expect(isCrossLow(p)).toBe(true); // 30 % pile
    p.hp = 15.5;
    expect(isCrossLow(p)).toBe(false);
    p.maxHp = 10;
    p.hp = 3; // 0,3 × 10 n'est pas exactement 3 en virgule flottante : la tolérance le compte quand même
    expect(isCrossLow(p)).toBe(true);
    p.hp = 4;
    expect(isCrossLow(p)).toBe(false);
    p.maxHp = 50;
    p.hp = 30;
    expect(isCrossRearmed(p)).toBe(true); // 60 % pile
    p.hp = 29;
    expect(isCrossRearmed(p)).toBe(false);
  });

  it('à 31 % : aucun appel ; à 30 % : appel avec le symbole de la croix', () => {
    const { a, b } = duo();
    a.maxHp = 100;
    a.hp = 31;
    expect(cross(tick([a, b]))).toEqual([]);
    expect(a.autoCall).toBeUndefined();
    a.hp = 30;
    const ev = cross(tick([a, b]));
    expect(ev).toEqual([{ type: 'autoCallStarted', playerId: 0, icon: 'cross', to: [1] }]);
    expect(a.autoCall).toEqual({ icon: 'cross', ref: CROSS_REF, ms: AUTO_CALL_DURATION_MS, to: [1] });
    expect(a.autoCallCross).toEqual({ ms: CROSS_CALL_REPEAT_MS });
  });

  it('le signal dure 3 s puis disparaît ; il ne fige pas, ne touche ni à l appel manuel ni au délai des appels d objets', () => {
    const { a, b } = duo();
    tick([a, b]);
    expect(a.callMs).toBe(0);
    expect(a.callCooldownMs).toBe(0);
    expect(a.autoCallCooldownMs).toBeUndefined();
    tick([a, b], ms(AUTO_CALL_DURATION_MS) + 1);
    expect(a.autoCall).toBeUndefined();
    expect(a.callCooldownMs).toBe(0);
    expect(a.autoCallCooldownMs).toBeUndefined();
  });
});

// ───────────────────────────── Joueur à terre, solo ─────────────────────────────

describe('joueur à terre, solo', () => {
  it('un joueur à terre ne déclenche pas la croix (il a déjà sa flèche) ; son suivi est remis à zéro par la chute', () => {
    const { a, b } = duo();
    tick([a, b]);
    expect(a.autoCallCross).toBeDefined();
    markPlayerDown(a);
    expect(a.autoCall).toBeUndefined();
    expect(a.autoCallCross).toBeUndefined();
    expect(cross(tick([a, b], 10))).toEqual([]);
    expect(a.autoCall).toBeUndefined();
  });

  it('solo : aucun appel (aucun allié)', () => {
    const a = mk(0, 'valentine');
    hpAt(a, 0.1);
    expect(stepAutoCalls([a], [], [], [], { heartSlot: true })).toEqual([]);
    expect(a.autoCall).toBeUndefined();
    expect(a.autoCallCross).toBeUndefined();
  });
});

// ───────────────────────────── Destinataires ─────────────────────────────

describe('destinataires : ceux qui PEUVENT soigner', () => {
  it('cœur rangé (entier ou demi-cœur) : destinataire ; emplacement vide : non ; allié à terre avec un cœur : non', () => {
    for (const kind of ['full', 'half'] as const) {
      const a = mk(0);
      hpAt(a, 0.2);
      const b = mk(1);
      b.heart = kind;
      const c = mk(2); // emplacement vide
      const d = mk(3);
      d.heart = 'full';
      markPlayerDown(d); // à terre : ne soigne pas (et perd son cœur à la chute, mais on le remet pour prouver le statut)
      d.heart = 'full';
      const ev = cross(tick([a, b, c, d]));
      expect(ev, kind).toEqual([{ type: 'autoCallStarted', playerId: 0, icon: 'cross', to: [1] }]);
    }
  });

  it('Valentine vivante : destinataire SANS cœur rangé ; Valentine à terre : non ; plusieurs soigneurs : tous', () => {
    const a = mk(0);
    hpAt(a, 0.2);
    const v = mk(1, 'valentine'); // aucun cœur
    const b = mk(2);
    b.heart = 'half';
    const c = mk(3); // rien
    expect(cross(tick([a, v, b, c]))[0].to).toEqual([1, 2]);

    const a2 = mk(0);
    hpAt(a2, 0.2);
    const v2 = mk(1, 'valentine');
    markPlayerDown(v2);
    expect(cross(tick([a2, v2, mk(2)]))).toEqual([]);
  });

  it('un patient Valentine n est pas son propre destinataire ; les autres alliés avec un cœur le soignent', () => {
    const v = mk(0, 'valentine');
    hpAt(v, 0.1);
    const b = mk(1);
    b.heart = 'full';
    expect(cross(tick([v, b]))[0].to).toEqual([1]);
    const alone = [mk(0, 'valentine'), mk(1)];
    hpAt(alone[0], 0.1);
    expect(cross(tick(alone))).toEqual([]); // l'autre allié n'a ni cœur ni Valentine
  });

  it('aucun allié qui puisse soigner (emplacements vides, pas de Valentine) : aucun appel, et rien n est armé ; dès qu un soigneur apparaît, la croix part', () => {
    const a = mk(0);
    hpAt(a, 0.2);
    const b = mk(1);
    expect(cross(tick([a, b], 30))).toEqual([]);
    expect(a.autoCall).toBeUndefined();
    expect(a.autoCallCross).toBeUndefined();
    b.heart = 'half'; // évaluée au déclenchement : un soigneur qui apparaît ensuite déclenche
    expect(cross(tick([a, b]))).toHaveLength(1);
  });

  it('un cœur sans PV à rendre n est pas « utilisable » (patient aux PV pleins) ; Valentine soigne toujours', () => {
    const healer = mk(1);
    healer.heart = 'full';
    const patient = mk(0);
    expect(canHealWithCross(healer, patient, true)).toBe(false); // PV pleins : rien à rendre
    hpAt(patient, 0.2);
    expect(canHealWithCross(healer, patient, true)).toBe(true);
    expect(canHealWithCross(healer, patient, false)).toBe(false); // règle d'origine : pas d'emplacement
    expect(canHealWithCross(mk(2, 'valentine'), patient, false)).toBe(true);
    expect(canHealWithCross(healer, healer, true)).toBe(false);
  });

  it("sans l'option heartSlot (règle d'origine) : seule Valentine reçoit la croix", () => {
    const a = mk(0);
    hpAt(a, 0.2);
    const b = mk(1);
    b.heart = 'full'; // ignoré : pas d'emplacement cœur
    expect(cross(tick([a, b], 5, [], false))).toEqual([]);
    const v = mk(2, 'valentine');
    expect(cross(tick([a, b, v], 1, [], false))[0].to).toEqual([2]);
  });
});

// ───────────────────────────── Répétition, réarmement ─────────────────────────────

describe('répétition toutes les 10 s et réarmement à 60 %', () => {
  it('tant que le joueur reste à 30 % ou moins : un nouvel appel toutes les 10 s (pas avant)', () => {
    const { a, b } = duo();
    let started = cross(tick([a, b])).length;
    expect(started).toBe(1);
    started += cross(tick([a, b], ms(CROSS_CALL_REPEAT_MS) - 3)).length;
    expect(started).toBe(1); // 9,95 s : pas encore
    expect(a.autoCall).toBeUndefined(); // le signal de 3 s est fini
    started += cross(tick([a, b], 6)).length;
    expect(started).toBe(2); // ≈ 10 s : repart
    started += cross(tick([a, b], ms(CROSS_CALL_REPEAT_MS) + 2)).length;
    expect(started).toBe(3);
  });

  it('PV entre 30 % et 60 % : pas de croix, mais le délai de répétition CONTINUE de courir (hystérésis) : la croix repart dès que les PV retombent si les 10 s sont écoulées', () => {
    const { a, b } = duo();
    tick([a, b]);
    hpAt(a, 0.45); // soigné un peu : toujours « désarmé » (< 60 %)
    expect(cross(tick([a, b], ms(CROSS_CALL_REPEAT_MS) * 2))).toEqual([]);
    expect(a.autoCallCross).toEqual({ ms: 0 }); // le délai a couru jusqu'à 0 (il n'est PAS relancé au-dessus du seuil)
    hpAt(a, 0.2); // retombe : la répétition est due, la croix repart tout de suite
    expect(cross(tick([a, b]))).toHaveLength(1);
    expect(a.autoCallCross).toEqual({ ms: CROSS_CALL_REPEAT_MS });
  });

  it('retombée avant la fin des 10 s : pas de croix avant l échéance de la répétition (pas de spam par yo-yo), et jamais plus tard que 10 s après la précédente', () => {
    const { a, b } = duo();
    tick([a, b]); // croix à t = 0
    hpAt(a, 0.45);
    tick([a, b], ms(4000));
    hpAt(a, 0.2); // retombe à t ≈ 4 s
    expect(cross(tick([a, b], ms(5000)))).toEqual([]); // t ≈ 9 s : pas encore
    expect(cross(tick([a, b], ms(1200)))).toHaveLength(1); // t ≈ 10 s : repart
  });

  it('rebond des PV entre 29 % et 31 % toutes les 5 s pendant 60 s (anneau du vampire, petit soin) : la demande se répète toutes les 10 s, elle n est pas muselée', () => {
    const { a, b } = duo();
    let started = 0;
    for (let i = 0; i < 12; i++) {
      a.maxHp = 100;
      a.hp = i % 2 === 0 ? 29 : 31;
      started += cross(tick([a, b], ms(5000))).length;
    }
    expect(started).toBeGreaterThanOrEqual(5); // PV fixes à 29 % : 6 croix en 60 s ; avec le rebond : aucune n'est perdue
  });

  it('PV remontés à 60 % ou plus : croix réarmée (champ supprimé) ; la prochaine chute à 30 % la redéclenche tout de suite', () => {
    const { a, b } = duo();
    tick([a, b]);
    hpAt(a, 0.6);
    tick([a, b]);
    expect(a.autoCallCross).toBeUndefined();
    hpAt(a, 0.3);
    expect(cross(tick([a, b]))).toHaveLength(1);
  });

  it('59 % : toujours désarmée ; 60 % : réarmée', () => {
    const { a, b } = duo();
    tick([a, b]);
    a.maxHp = 100;
    a.hp = 59;
    tick([a, b]);
    expect(a.autoCallCross).toBeDefined();
    a.hp = 60;
    tick([a, b]);
    expect(a.autoCallCross).toBeUndefined();
  });

  it('entrée d une nouvelle salle (resetPlayersForRoom) et chute : tout est remis à zéro', () => {
    const { a, b } = duo();
    tick([a, b]);
    expect(a.autoCallCross).toBeDefined();
    resetPlayersForRoom([a, b], [{ x: 10, y: 10 }, { x: 20, y: 20 }]);
    expect(a.autoCall).toBeUndefined();
    expect(a.autoCallCross).toBeUndefined();
    const c = mk(0);
    c.autoCallCross = { ms: 5 };
    resetAutoCall(c);
    expect(c.autoCallCross).toBeUndefined();
  });
});

// ───────────────────────────── Priorités ─────────────────────────────

describe('priorités : appel d objet, appel manuel, délais', () => {
  it('avec un VRAI cœur au sol sous le joueur : l appel de cœur part, puis la croix le REMPLACE ; une fois la croix finie l appel de cœur REPART (sa référence est oubliée)', () => {
    const a = mk(0, 'david', 100, 100);
    const v = mk(1, 'valentine', 400, 300); // reçoit le cœur (emplacement libre) ET la croix (soigneuse)
    a.heart = 'full'; // emplacement plein : il ne peut pas ranger le cœur au sol
    const pk: PickupState[] = [{ id: 3, kind: 'full', pos: { ...a.pos }, ttlMs: 60_000 }];
    const first = tick([a, v], 1, [], true, pk);
    expect(first.map((e) => (e.type === 'autoCallStarted' ? e.icon : e.type))).toEqual(['heart']);
    expect(a.autoCallSeen).toEqual(['p3']);
    hpAt(a, 0.2); // il tombe à 20 % : la croix, plus urgente, remplace l'appel d'objet
    const second = tick([a, v], 1, [], true, pk);
    expect(cross(second)).toHaveLength(1);
    expect(a.autoCall?.icon).toBe('cross');
    expect(a.autoCallSeen).toBeUndefined(); // l'objet remplacé sera re-signalé
    expect(a.autoCallCooldownMs).toBeGreaterThan(3900); // délai de récupération de l'appel d'objet intact
    const later = tick([a, v], ms(AUTO_CALL_COOLDOWN_MS), [], true, pk);
    const icons = later.filter((e) => e.type === 'autoCallStarted').map((e) => (e as Extract<SimEvent, { type: 'autoCallStarted' }>).icon);
    expect(icons).toEqual(['heart']); // ré-émis une fois le délai de 4 s écoulé, le joueur étant toujours dessus
  });

  it('la croix REMPLACE un appel automatique d objet en cours (plus urgent) sans toucher à son délai de récupération', () => {
    const { a, b } = duo();
    a.autoCall = { icon: 'heart', ref: 'p9', ms: 2000, to: [1] };
    a.autoCallCooldownMs = 3000;
    const ev = cross(tick([a, b]));
    expect(ev).toHaveLength(1);
    expect(a.autoCall?.icon).toBe('cross');
    expect(a.autoCall?.ms).toBe(AUTO_CALL_DURATION_MS);
    expect(a.autoCallCooldownMs).toBeGreaterThan(2900); // inchangé (aux pas écoulés près)
    expect(a.autoCallCooldownMs).toBeLessThanOrEqual(3000);
  });

  it('elle n est pas soumise au délai de 4 s des appels d objets (même en plein délai) ni à l anti-doublon des objets', () => {
    const { a, b } = duo();
    a.autoCallCooldownMs = AUTO_CALL_COOLDOWN_MS;
    a.autoCallSeen = ['g1', 'p2'];
    expect(cross(tick([a, b]))).toHaveLength(1);
  });

  it('soigné au-dessus du seuil : le signal de croix en cours s arrête tout de suite (la demande est satisfaite)', () => {
    const { a, b } = duo();
    tick([a, b]);
    expect(a.autoCall?.icon).toBe('cross');
    hpAt(a, 0.5);
    tick([a, b]);
    expect(a.autoCall).toBeUndefined();
    expect(a.autoCallCross).toBeDefined(); // toujours désarmée (< 60 %)
  });

  it('un signal de croix en cours n est jamais remplacé par un appel d objet (délai de récupération et signal actif)', () => {
    const { a, b } = duo();
    tick([a, b]);
    const sig = a.autoCall;
    // un objet refusé sous les pieds du joueur
    b.heart = 'full';
    const drops: GearDropState[] = [{ id: 1, item: { slot: 'weapon', level: 1 }, pos: { ...a.pos }, ttlMs: GEAR_TTL_MS, lockedFor: null, lockMode: 'life' }];
    a.loadout.weapon = 3;
    b.loadout.weapon = 0;
    expect(tick([a, b], 3, drops).filter((e) => e.type === 'autoCallStarted')).toEqual([]);
    expect(a.autoCall).toBe(sig);
  });

  it('un appel MANUEL en cours n est jamais interrompu : la croix attend la fin de l appel, puis part si le joueur est toujours à 30 % ou moins', () => {
    const { a, b } = duo();
    startCall(a);
    expect(cross(tick([a, b], 30))).toEqual([]);
    expect(a.callMs).toBeGreaterThan(0);
    expect(a.autoCall).toBeUndefined();
    const ev = cross(tick([a, b], ms(3000)));
    expect(ev).toHaveLength(1); // l'appel manuel (3 s) est fini
    expect(a.callMs).toBe(0);
  });

  it('un appel manuel qui démarre efface l icône de la croix (il l emporte) mais pas son suivi de répétition', () => {
    const { a, b } = duo();
    tick([a, b]);
    expect(a.autoCall?.icon).toBe('cross');
    startCall(a);
    expect(a.autoCall).toBeUndefined();
    expect(a.autoCallCross).toBeDefined();
    expect(cross(tick([a, b], 5))).toEqual([]);
  });
});

// ───────────────────────────── Tolérance : anciens états, valeurs hostiles ─────────────────────────────

describe('tolérance : anciens états et valeurs hostiles', () => {
  it('un joueur sans champ de croix est valide (rien n est ajouté par la normalisation)', () => {
    const p = mk(0);
    const before = JSON.stringify(p);
    normalizeAutoCallFields(p);
    expect(JSON.stringify(p)).toBe(before);
    expect(before).not.toContain('autoCall');
  });

  it('signal de croix valide conservé ; ref incorrecte, durée hors bornes ou objet manquant : supprimé', () => {
    const good = mk(0);
    good.autoCall = { icon: 'cross', ref: CROSS_REF, ms: 1500, to: [1] };
    normalizeAutoCallFields(good);
    expect(good.autoCall).toBeDefined();
    for (const bad of [
      { icon: 'cross', ref: 'p1', ms: 1500, to: [1] },
      { icon: 'cross', ref: CROSS_REF, ms: 0, to: [1] },
      { icon: 'cross', ref: CROSS_REF, ms: AUTO_CALL_DURATION_MS + 1, to: [1] },
      { icon: 'cross', ref: CROSS_REF, ms: Number.NaN, to: [1] },
      { icon: 'cross', ref: CROSS_REF, ms: 1000, to: 'x' },
      { icon: 'cross', ref: 5, ms: 1000, to: [1] },
    ]) {
      const p = mk(0);
      (p as unknown as { autoCall: unknown }).autoCall = bad;
      normalizeAutoCallFields(p);
      expect(p.autoCall, JSON.stringify(bad)).toBeUndefined();
    }
  });

  it('suivi de la croix : { ms } fini dans [0, 10 s] conservé ; tout le reste supprimé', () => {
    for (const ok of [0, 1, CROSS_CALL_REPEAT_MS]) {
      const p = mk(0);
      p.autoCallCross = { ms: ok };
      normalizeAutoCallFields(p);
      expect(p.autoCallCross, String(ok)).toEqual({ ms: ok });
    }
    for (const bad of [{ ms: -1 }, { ms: CROSS_CALL_REPEAT_MS + 1 }, { ms: Number.NaN }, { ms: Infinity }, { ms: '5' }, {}, null, 7, 'x', true, []]) {
      const p = mk(0);
      (p as unknown as { autoCallCross: unknown }).autoCallCross = bad;
      normalizeAutoCallFields(p);
      expect(p.autoCallCross, JSON.stringify(bad)).toBeUndefined();
    }
  });

  it('PV non finis, PV max nuls ou négatifs : aucun appel, aucune exception', () => {
    for (const [hp, maxHp] of [
      [Number.NaN, 40],
      [10, Number.NaN],
      [10, 0],
      [10, -40],
      [Infinity, 40],
      [-Infinity, 40],
    ] as const) {
      const a = mk(0);
      const b = mk(1, 'valentine');
      a.hp = hp;
      a.maxHp = maxHp;
      expect(() => tick([a, b], 3), `${hp}/${maxHp}`).not.toThrow();
      expect(a.autoCall, `${hp}/${maxHp}`).toBeUndefined();
    }
  });
});

// ───────────────────────────── Simulation de bout en bout ─────────────────────────────

function arena(): LevelDef {
  return makeTestLevel({
    rooms: [
      makeTestRoom({
        id: 'r1',
        layout: makeTestLayout(30, 20),
        playerSpawns: [[5, 5], [6, 5], [5, 6], [6, 6]],
        mechanisms: [],
        exit: { rect: { x: 27, y: 17, w: 2, h: 2 }, requires: [] },
      }),
      makeTestRoom({ id: 'r2', exit: { rect: { x: 9, y: 5, w: 2, h: 2 }, requires: [], final: true } }),
    ],
    objectives: [0, 1, 2, 3].map((slot) => ({ id: `o${slot}`, slot, roomId: 'r1', kind: 'kills' as const, labelKey: `objective.test.o${slot}`, count: 99 })),
  });
}

const CHARS: readonly CharacterId[] = ['david', 'mira', 'valentine', 'brokk'];

function makeSim(n: number, opts: { autoCall?: boolean; heartSlot?: boolean; chars?: readonly CharacterId[]; seed?: number } = {}): GameSimulation {
  const chars = opts.chars ?? CHARS;
  return createSimulation(
    {
      levelId: 'test',
      seed: opts.seed ?? 7,
      loot: true,
      gear: true,
      autoCall: opts.autoCall,
      heartSlot: opts.heartSlot ?? true,
      players: Array.from({ length: n }, (_, i) => ({ id: i as PlayerId, characterId: chars[i], difficulty: 2 as const })),
    },
    arena(),
  );
}

const frame = (over: Partial<ActionFrame> = {}): ActionFrame => ({ moveX: 0, moveY: 0, attack: false, interact: false, revive: false, ...over });

function stepN(s: GameSimulation, n: number, inputs: TickInputs | ((i: number) => TickInputs) = {}): SimEvent[] {
  const all: SimEvent[] = [];
  for (let i = 0; i < n; i++) all.push(...s.step(DT, typeof inputs === 'function' ? inputs(i) : inputs));
  return all;
}

/** Joueurs éloignés les uns des autres (aucun contact). */
function spread(s: GameSimulation): void {
  s.state.players.forEach((p, i) => (p.pos = { x: 100 + i * 120, y: 100 + i * 60 }));
}

describe('simulation : 2 et 3 joueurs', () => {
  it('2 joueurs (david blessé, mira avec un cœur rangé) : la croix part au pas où les PV passent à 30 %, vers mira seule', () => {
    const s = makeSim(2);
    stepN(s, 1);
    spread(s);
    const [a, b] = s.state.players;
    b.heart = 'full';
    expect(cross(stepN(s, 5))).toEqual([]); // PV pleins
    a.hp = a.maxHp * 0.31;
    expect(cross(stepN(s, 2))).toEqual([]);
    a.hp = a.maxHp * 0.3;
    expect(cross(stepN(s, 2))).toEqual([{ type: 'autoCallStarted', playerId: 0, icon: 'cross', to: [1] }]);
    expect(a.autoCall?.icon).toBe('cross');
    // elle ne fige pas le joueur : il marche pendant le signal
    const x0 = a.pos.x;
    stepN(s, 30, { 0: frame({ moveX: 1 }) });
    expect(a.pos.x).toBeGreaterThan(x0 + 10);
    expect(a.autoCall).toBeDefined();
    expect(a.callMs).toBe(0);
    expect(a.callCooldownMs).toBe(0);
    stepN(s, 160);
    expect(a.autoCall).toBeUndefined();
  });

  it('3 joueurs (david blessé, valentine sans cœur, mira avec un cœur, une 3e sans rien) : destinataires = valentine et mira', () => {
    const s = makeSim(4, { chars: ['david', 'valentine', 'mira', 'brokk'] });
    stepN(s, 1);
    spread(s);
    const [a, v, m] = s.state.players;
    m.heart = 'half';
    a.hp = a.maxHp * 0.1;
    const ev = cross(stepN(s, 2));
    expect(ev).toEqual([{ type: 'autoCallStarted', playerId: 0, icon: 'cross', to: [v.id, m.id] }]);
  });

  it('personne ne peut soigner (ni cœur rangé ni Valentine) : aucun événement, aucun champ ajouté', () => {
    const s = makeSim(3, { chars: ['david', 'mira', 'brokk', 'david'] });
    stepN(s, 1);
    spread(s);
    s.state.players[0].hp = 2;
    expect(cross(stepN(s, 120))).toEqual([]);
    expect(s.serialize()).not.toContain('autoCall');
  });

  it('solo : aucun appel (même à 1 PV avec Valentine)', () => {
    const s = makeSim(1, { chars: ['valentine', 'david', 'mira', 'brokk'] });
    stepN(s, 1);
    s.state.players[0].hp = 1;
    expect(cross(stepN(s, 60))).toEqual([]);
  });

  it('l option autoCall: false (démo, bots) désactive aussi la croix', () => {
    const s = makeSim(2, { autoCall: false });
    stepN(s, 1);
    spread(s);
    s.state.players[1].heart = 'full';
    s.state.players[0].hp = 1;
    expect(cross(stepN(s, 60))).toEqual([]);
    expect(s.state.autoCallDisabled).toBe(true);
  });

  it('un joueur tombé à terre (chute scénarisée) perd son signal et son suivi', () => {
    const s = makeSim(2);
    stepN(s, 1);
    spread(s);
    s.state.players[1].heart = 'full';
    s.state.players[0].hp = 3;
    stepN(s, 2);
    expect(s.state.players[0].autoCall?.icon).toBe('cross');
    expect(s.knockDown(0)).toBe(true);
    expect(s.state.players[0].autoCall).toBeUndefined();
    expect(s.state.players[0].autoCallCross).toBeUndefined();
    expect(cross(stepN(s, 60))).toEqual([]);
  });

  it('soigné par B avec le cœur rangé : la croix s arrête de se répéter (PV remontés) et le suivi est réarmé quand les PV passent à 60 %', () => {
    const s = makeSim(2);
    stepN(s, 1);
    const [a, b] = s.state.players;
    a.pos = { x: 100, y: 100 };
    b.pos = { x: 104, y: 100 };
    b.heart = 'full';
    a.maxHp = 40;
    a.hp = 8;
    expect(cross(stepN(s, 2))).toHaveLength(1);
    // B : le cœur rend 10 PV (8 → 18 = 45 %) : désarmée, aucune répétition
    stepN(s, 2, { 1: frame({ heart: true }) });
    stepN(s, 1);
    expect(a.hp).toBe(18);
    expect(cross(stepN(s, 60 * 12))).toEqual([]);
    expect(a.autoCallCross).toBeDefined();
    a.hp = 24; // 60 % : réarmée
    stepN(s, 2);
    expect(a.autoCallCross).toBeUndefined();
  });

  it('répétition en simulation : un appel toutes les 10 s tant que le joueur reste à 30 % ou moins', () => {
    const s = makeSim(2);
    stepN(s, 1);
    spread(s);
    s.state.players[1].heart = 'full';
    s.state.players[0].hp = 2;
    const ev = cross(stepN(s, 60 * 35));
    expect(ev.length).toBeGreaterThanOrEqual(3);
    expect(ev.length).toBeLessThanOrEqual(4);
  });

  it('restauration d un ancien état, ou d un état aux champs de croix mal formés : valide / nettoyé', () => {
    const s = makeSim(2);
    stepN(s, 1);
    const snap = s.serialize();
    expect(snap).not.toContain('autoCall');
    expect(() => GameSimulation.restore(snap, s.level).step(DT, {})).not.toThrow();
    const st = JSON.parse(snap);
    st.players[0].autoCallCross = { ms: 4000 };
    st.players[0].autoCall = { icon: 'cross', ref: 'x', ms: 1200, to: [1] };
    const ok = GameSimulation.restore(JSON.stringify(st), s.level).state.players[0];
    expect(ok.autoCallCross).toEqual({ ms: 4000 });
    expect(ok.autoCall?.icon).toBe('cross');
    st.players[0].autoCallCross = { ms: -5 };
    st.players[0].autoCall = { icon: 'cross', ref: 'g3', ms: 1200, to: [1] };
    const bad = GameSimulation.restore(JSON.stringify(st), s.level).state.players[0];
    expect(bad.autoCallCross).toBeUndefined();
    expect(bad.autoCall).toBeUndefined();
  });
});

// ───────────────────────────── Non-régression : purement informatif ─────────────────────────────

/** Retire de l'état tous les champs de l'appel automatique (pour comparer les parties avec / sans). */
function stripAuto(json: string): unknown {
  const st = JSON.parse(json);
  delete st.autoCallDisabled;
  for (const p of st.players) {
    delete p.autoCall;
    delete p.autoCallCooldownMs;
    delete p.autoCallSeen;
    delete p.autoCallCross;
  }
  return st;
}

function scripted(i: number): TickInputs {
  const a = (i / 40) % (2 * Math.PI);
  const b = (i / 55 + 1) % (2 * Math.PI);
  return {
    0: frame({ moveX: Math.cos(a), moveY: Math.sin(a), attack: i % 20 < 10 }),
    1: frame({ moveX: Math.sin(b), moveY: Math.cos(b), attack: i % 30 < 12 }),
  };
}

function populated(autoCall: boolean, seed: number): GameSimulation {
  const s = makeSim(2, { autoCall, seed, chars: ['david', 'valentine', 'mira', 'brokk'] });
  stepN(s, 1);
  for (let k = 0; k < 6; k++) s.state.room.enemies.push(createEnemyState('skeleton', { x: 200 + k * 30, y: 150 + (k % 3) * 40 }, s.state.nextEntityId++, 0));
  s.state.players[0].hp = s.state.players[0].maxHp * 0.25; // sous le seuil : la croix part vers Valentine
  return s;
}

describe("non-régression : la croix rouge n'a AUCUN effet sur le jeu", () => {
  for (const seed of [1, 7, 4242]) {
    it(`graine ${seed} : états et événements identiques hors champs d'appel automatique, flux aléatoires inchangés`, () => {
      const on = populated(true, seed);
      const off = populated(false, seed);
      let started = 0;
      for (let i = 0; i < 1500; i++) {
        const a = on.step(DT, scripted(i));
        const b = off.step(DT, scripted(i));
        started += cross(a).length;
        expect(a.filter((e) => e.type !== 'autoCallStarted')).toEqual(b);
        if (i % 100 === 0) expect(stripAuto(on.serialize())).toEqual(stripAuto(off.serialize()));
      }
      expect(stripAuto(on.serialize())).toEqual(stripAuto(off.serialize()));
      expect(started).toBeGreaterThan(0); // la croix est bien partie (sinon le test ne prouverait rien)
      const a = on.state;
      const b = off.state;
      expect([a.rngState, a.lootRngState, a.gearRngState]).toEqual([b.rngState, b.lootRngState, b.gearRngState]);
    });
  }

  it('déterminisme : deux simulations identiques donnent exactement le même état sérialisé', () => {
    const a = populated(true, 99);
    const b = populated(true, 99);
    for (let i = 0; i < 800; i++) {
      a.step(DT, scripted(i));
      b.step(DT, scripted(i));
    }
    expect(a.serialize()).toBe(b.serialize());
  });
});
