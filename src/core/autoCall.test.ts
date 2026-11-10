/**
 * Tests de l'APPEL AUTOMATIQUE (objet laissé aux coéquipiers) : détection du déclencheur (cœur / demi-cœur avec PV pleins, objet d'équipement 'ignore',
 * exceptions : verrou, 'swap', à terre, solo), destinataires utiles, anti-spam (couple joueur/objet, délai par joueur), priorité de l'appel manuel,
 * absence de gel et de consommation du délai manuel, remise à zéro, tolérance des anciens états, simulation de bout en bout à 2 joueurs
 * et NON-RÉGRESSION (même graine avec / sans appel automatique : états de jeu identiques hors des champs d'appel automatique).
 * Aucune horloge réelle : tout passe par des pas fixes.
 */
import { describe, expect, it } from 'vitest';
import { normalizeAutoCallFields, stepAutoCalls } from './autoCall';
import { AUTO_CALL_COOLDOWN_MS, AUTO_CALL_DURATION_MS, AUTO_CALL_REARM_MARGIN, GEAR_PICKUP_RADIUS, GEAR_TTL_MS, PICKUP_RADIUS, PICKUP_TTL_MS } from './balance';
import { CALL_DURATION_MS, ROOM_CLEAR_DELAY_MS, SIM_STEP_MS } from './constants';
import { createEnemyState } from './ai';
import { tileCenter } from './geometry';
import { canConsumeHeart } from './loot';
import { makeTestLayout, makeTestLevel, makeTestRoom } from './levelValidation';
import {
  applyDamageToPlayer,
  canStartCall,
  cancelAutoCall,
  createPlayerState,
  hasAutoCall,
  markPlayerDown,
  resetAutoCall,
  resetPlayersForRoom,
  startCall,
  stepAutoCallTimers,
  stepPlayerTimers,
} from './players';
import { createSimulation, GameSimulation } from './simulation';
import type {
  ActionFrame,
  GearDropState,
  GearItem,
  LevelDef,
  PickupState,
  PlayerId,
  PlayerState,
  SimEvent,
  TickInputs,
} from './types';

const DT = SIM_STEP_MS;

// ───────────────────────────── Outils ─────────────────────────────

function mkPlayer(id: PlayerId, x = 100, y = 100): PlayerState {
  return createPlayerState({ id, characterId: 'david', difficulty: 2 }, { x, y });
}

/** Deux joueurs (ou plus) éloignés l'un de l'autre : l'allié est à 200 px, hors de tout rayon de contact. */
function team(n = 2): PlayerState[] {
  return Array.from({ length: n }, (_, i) => mkPlayer(i as PlayerId, 100 + i * 200, 100));
}

let nextId = 1;
function heart(x: number, y: number, kind: PickupState['kind'] = 'full'): PickupState {
  return { id: nextId++, kind, pos: { x, y }, ttlMs: PICKUP_TTL_MS };
}
function drop(item: GearItem, x: number, y: number, lockedFor: PlayerId | null = null): GearDropState {
  return { id: nextId++, item, pos: { x, y }, ttlMs: GEAR_TTL_MS, lockedFor, lockMode: 'life' };
}
const weapon = (level: 1 | 2 | 3): GearItem => ({ slot: 'weapon', level });
const accessory = (kind: GearItem['accessory'], level: 1 | 2 | 3): GearItem => ({ slot: 'accessory', level, accessory: kind });

function wound(p: PlayerState, missing = 20): void {
  p.hp = Math.max(1, p.maxHp - missing);
}

/** Pas pur : un seul appel de `stepAutoCalls`. */
const run = (players: PlayerState[], pk: PickupState[] = [], gd: GearDropState[] = []): SimEvent[] => stepAutoCalls(players, pk, gd);

/** Avance les timers de tous les joueurs d'un pas puis la détection (équivalent du début d'un pas de simulation). */
function tick(players: PlayerState[], pk: PickupState[], gd: GearDropState[], steps = 1): SimEvent[] {
  const out: SimEvent[] = [];
  for (let i = 0; i < steps; i++) {
    for (const p of players) stepPlayerTimers(p, DT);
    out.push(...stepAutoCalls(players, pk, gd));
  }
  return out;
}

const autoEvents = (ev: readonly SimEvent[]): Extract<SimEvent, { type: 'autoCallStarted' }>[] =>
  ev.filter((e): e is Extract<SimEvent, { type: 'autoCallStarted' }> => e.type === 'autoCallStarted');

// ───────────────────────────── Règle de consommation d'un cœur ─────────────────────────────

describe('canConsumeHeart (règle de consommation unique)', () => {
  it('PV pleins : non ; un seul PV manquant : oui (aucun seuil) ; à terre : non', () => {
    const p = mkPlayer(0);
    expect(canConsumeHeart(p)).toBe(false);
    p.hp = p.maxHp - 1;
    expect(canConsumeHeart(p)).toBe(true);
    markPlayerDown(p);
    expect(canConsumeHeart(p)).toBe(false);
  });
});

// ───────────────────────────── Déclencheur : cœurs ─────────────────────────────

describe('déclencheur : cœur / demi-cœur que le joueur ne peut pas consommer', () => {
  it('PV pleins sur un cœur entier, allié blessé : appel avec le symbole du cœur', () => {
    const [a, b] = team();
    wound(b);
    const pk = [heart(a.pos.x, a.pos.y, 'full')];
    const ev = autoEvents(run([a, b], pk));
    expect(ev).toEqual([{ type: 'autoCallStarted', playerId: 0, icon: 'heart', to: [1] }]);
    expect(a.autoCall).toEqual({ icon: 'heart', ref: `p${pk[0].id}`, ms: AUTO_CALL_DURATION_MS, to: [1] });
    expect(a.autoCallCooldownMs).toBe(AUTO_CALL_COOLDOWN_MS);
    expect(hasAutoCall(a)).toBe(true);
  });

  it('demi-cœur : symbole du demi-cœur', () => {
    const [a, b] = team();
    wound(b);
    const ev = autoEvents(run([a, b], [heart(a.pos.x, a.pos.y, 'half')]));
    expect(ev[0].icon).toBe('half');
    expect(a.autoCall?.icon).toBe('half');
  });

  it('le joueur est blessé (même 1 PV manquant) : il consomme le cœur, donc aucun appel', () => {
    const [a, b] = team();
    wound(b);
    a.hp = a.maxHp - 1;
    expect(run([a, b], [heart(a.pos.x, a.pos.y)])).toEqual([]);
    expect(a.autoCall).toBeUndefined();
  });

  it('cœur hors du rayon de contact : rien ; au bord du rayon : déclenche', () => {
    const [a, b] = team();
    wound(b);
    expect(run([a, b], [heart(a.pos.x + PICKUP_RADIUS + 0.5, a.pos.y)])).toEqual([]);
    expect(run([a, b], [heart(a.pos.x + PICKUP_RADIUS, a.pos.y)])).toHaveLength(1);
  });

  it("aucun allié utile (tous les alliés ont leurs PV pleins) : AUCUN appel, aucun champ créé", () => {
    const [a, b] = team();
    expect(run([a, b], [heart(a.pos.x, a.pos.y)])).toEqual([]);
    expect(a.autoCall).toBeUndefined();
    expect(a.autoCallCooldownMs).toBeUndefined();
    expect(a.autoCallSeen).toBeUndefined();
  });

  it("allié à terre : pas destinataire (il ne peut pas consommer) ; sans autre allié utile, aucun appel", () => {
    const [a, b] = team();
    wound(b);
    markPlayerDown(b);
    expect(run([a, b], [heart(a.pos.x, a.pos.y)])).toEqual([]);
  });

  it("destinataires multiples : seuls les alliés vivants et blessés sont listés, quelle que soit la distance", () => {
    const [a, b, c, d] = team(4);
    wound(b);
    wound(d);
    c.hp = c.maxHp; // allié plein : pas destinataire
    d.pos = { x: 5000, y: 5000 }; // très loin : destinataire quand même
    const ev = autoEvents(run([a, b, c, d], [heart(a.pos.x, a.pos.y)]));
    expect(ev[0].to).toEqual([1, 3]);
    expect(a.autoCall?.to).toEqual([1, 3]);
  });

  it("joueur à terre : n'émet aucun appel", () => {
    const [a, b] = team();
    wound(b);
    markPlayerDown(a);
    expect(run([a, b], [heart(a.pos.x, a.pos.y)])).toEqual([]);
  });

  it('solo : aucun appel (pas d\'allié)', () => {
    const [a] = team(1);
    expect(run([a], [heart(a.pos.x, a.pos.y)])).toEqual([]);
  });
});

// ───────────────────────────── Déclencheur : équipement ─────────────────────────────

describe("déclencheur : objet d'équipement que le joueur ne prend pas ('ignore')", () => {
  it('niveau inférieur et niveau égal : appel avec l\'icône de l\'objet ; allié qui en profite = destinataire', () => {
    for (const mine of [2, 3] as const) {
      const [a, b] = team();
      a.loadout.weapon = mine;
      const d = drop(weapon(2), a.pos.x, a.pos.y);
      const ev = autoEvents(run([a, b], [], [d]));
      expect(ev).toEqual([{ type: 'autoCallStarted', playerId: 0, icon: 'gear', to: [1] }]);
      expect(a.autoCall?.item).toEqual(weapon(2));
      expect(a.autoCall?.ref).toBe(`g${d.id}`);
    }
  });

  it('niveau supérieur au sien : il le prend (equip), donc aucun appel', () => {
    const [a, b] = team();
    a.loadout.weapon = 1;
    expect(run([a, b], [], [drop(weapon(2), a.pos.x, a.pos.y)])).toEqual([]);
  });

  it("l'icône est une copie : modifier le signal ne touche pas l'objet au sol", () => {
    const [a, b] = team();
    a.loadout.boots = 3;
    const d = drop({ slot: 'boots', level: 1 }, a.pos.x, a.pos.y);
    run([a, b], [], [d]);
    expect(a.autoCall?.item).not.toBe(d.item);
    expect(a.autoCall?.item).toEqual({ slot: 'boots', level: 1 });
  });

  it("aucun allié pour qui l'objet est utile (il a mieux ou pareil) : aucun appel", () => {
    const [a, b] = team();
    a.loadout.weapon = 3;
    b.loadout.weapon = 2;
    expect(run([a, b], [], [drop(weapon(2), a.pos.x, a.pos.y)])).toEqual([]);
  });

  it('accessoire de même sorte, niveau égal ou inférieur : appel (allié sans accessoire = destinataire)', () => {
    for (const lvl of [1, 2] as const) {
      const [a, b] = team();
      a.loadout.accessory = { kind: 'magnet', level: 2 };
      const ev = autoEvents(run([a, b], [], [drop(accessory('magnet', lvl), a.pos.x, a.pos.y)]));
      expect(ev, `niveau ${lvl}`).toHaveLength(1);
    }
  });

  it("accessoire d'une AUTRE sorte : 'swap' (échange manuel au choix du joueur) = pas un refus : aucun appel", () => {
    const [a, b] = team();
    a.loadout.accessory = { kind: 'lantern', level: 3 };
    expect(run([a, b], [], [drop(accessory('magnet', 1), a.pos.x, a.pos.y)])).toEqual([]);
  });

  it("allié en situation de 'swap' (accessoire d'une autre sorte) : pas destinataire ; allié qui ferait 'upgrade' : destinataire", () => {
    const [a, b, c] = team(3);
    a.loadout.accessory = { kind: 'magnet', level: 3 };
    b.loadout.accessory = { kind: 'lantern', level: 1 }; // swap : pas utile
    c.loadout.accessory = { kind: 'magnet', level: 1 }; // upgrade : utile
    const ev = autoEvents(run([a, b, c], [], [drop(accessory('magnet', 2), a.pos.x, a.pos.y)]));
    expect(ev[0].to).toEqual([2]);
    const [a2, b2] = team();
    a2.loadout.accessory = { kind: 'magnet', level: 3 };
    b2.loadout.accessory = { kind: 'lantern', level: 1 };
    expect(run([a2, b2], [], [drop(accessory('magnet', 2), a2.pos.x, a2.pos.y)])).toEqual([]);
  });

  it("anneau du vampire (niveau III seulement) : un porteur déjà équipé du même anneau le refuse ; un anneau invalide n'est utile à personne", () => {
    const [a, b] = team();
    a.loadout.accessory = { kind: 'vampire', level: 3 };
    expect(autoEvents(run([a, b], [], [drop(accessory('vampire', 3), a.pos.x, a.pos.y)]))).toHaveLength(1);
    const [a2, b2] = team();
    a2.loadout.accessory = { kind: 'vampire', level: 3 };
    expect(run([a2, b2], [], [drop(accessory('vampire', 1), a2.pos.x, a2.pos.y)])).toEqual([]); // vampire niveau I : invalide, ignoré de tous
  });

  it('objet verrouillé pour le joueur (ses propres objets lâchés) : aucun appel de sa part', () => {
    const [a, b] = team();
    a.loadout.weapon = 3;
    expect(run([a, b], [], [drop(weapon(1), a.pos.x, a.pos.y, 0)])).toEqual([]);
  });

  it("objet verrouillé pour l'allié : il n'est pas destinataire", () => {
    const [a, b] = team();
    a.loadout.weapon = 3;
    expect(run([a, b], [], [drop(weapon(1), a.pos.x, a.pos.y, 1)])).toEqual([]);
  });

  it("rayon de contact : hors rayon, rien ; l'objet attiré par un aimant sans chevauchement ne déclenche rien", () => {
    const [a, b] = team();
    a.loadout.weapon = 3;
    expect(run([a, b], [], [drop(weapon(1), a.pos.x + GEAR_PICKUP_RADIUS + 1, a.pos.y)])).toEqual([]);
  });

  it("les bonus temporaires ne sont pas concernés (ils ne sont pas dans les objets examinés)", () => {
    const [a, b] = team();
    wound(b);
    expect(run([a, b], [], [])).toEqual([]);
  });

  it("un cœur et un objet sous le joueur : un seul appel (le cœur d'abord), l'autre est bloqué par le délai de récupération", () => {
    const [a, b] = team();
    wound(b);
    a.loadout.weapon = 3;
    const ev = autoEvents(run([a, b], [heart(a.pos.x, a.pos.y)], [drop(weapon(1), a.pos.x, a.pos.y)]));
    expect(ev).toHaveLength(1);
    expect(ev[0].icon).toBe('heart');
  });
});

// ───────────────────────────── Anti-spam ─────────────────────────────

describe('anti-spam', () => {
  it('par couple (joueur, objet) : un seul déclenchement tant que le joueur reste dans le rayon', () => {
    const [a, b] = team();
    wound(b);
    const pk = [heart(a.pos.x, a.pos.y)];
    expect(autoEvents(tick([a, b], pk, [], 1))).toHaveLength(1);
    // le signal (3 s) et le délai (4 s) passent ; le joueur est toujours dessus : pas de nouvel appel
    expect(autoEvents(tick([a, b], pk, [], 60 * 10))).toHaveLength(0);
    expect(a.autoCall).toBeUndefined();
    expect(a.autoCallSeen).toEqual([`p${pk[0].id}`]);
  });

  it("ré-armement : dans la marge (rayon + marge) l'objet reste « vu » ; au-delà il est oublié, et un retour redéclenche après le délai", () => {
    const [a, b] = team();
    wound(b);
    const pk = [heart(a.pos.x, a.pos.y)];
    const origin = { ...a.pos };
    tick([a, b], pk, [], 1);
    a.pos = { x: origin.x + PICKUP_RADIUS + AUTO_CALL_REARM_MARGIN - 0.5, y: origin.y }; // hors rayon mais dans la marge
    tick([a, b], pk, [], 60 * 5);
    expect(a.autoCallSeen).toHaveLength(1);
    a.pos = { x: origin.x + PICKUP_RADIUS + AUTO_CALL_REARM_MARGIN + 1, y: origin.y }; // sorti
    tick([a, b], pk, [], 1);
    expect(a.autoCallSeen).toBeUndefined();
    a.pos = { ...origin }; // retour
    expect(autoEvents(tick([a, b], pk, [], 1))).toHaveLength(1);
  });

  it("par joueur : délai de récupération ~4 s ; un signal actif n'est pas remplacé par un autre objet avant son terme", () => {
    expect(AUTO_CALL_COOLDOWN_MS).toBeGreaterThan(AUTO_CALL_DURATION_MS);
    const [a, b] = team();
    wound(b);
    const h1 = heart(a.pos.x, a.pos.y);
    const h2 = heart(a.pos.x + 2, a.pos.y);
    const pk = [h1, h2];
    const first = autoEvents(tick([a, b], pk, [], 1));
    expect(first).toHaveLength(1);
    expect(a.autoCall?.ref).toBe(`p${h1.id}`);
    // pendant le signal puis le délai : le 2e cœur (toujours sous le joueur) ne déclenche rien
    let started = 0;
    for (let i = 0; i < Math.floor(AUTO_CALL_COOLDOWN_MS / DT) - 3; i++) started += autoEvents(tick([a, b], pk, [], 1)).length;
    expect(started).toBe(0);
    expect(a.autoCall).toBeUndefined(); // le signal du 1er s'est terminé (3 s) bien avant la fin du délai
    // le délai écoulé, le 2e (jamais signalé) déclenche
    for (let i = 0; i < 8; i++) started += autoEvents(tick([a, b], pk, [], 1)).length;
    expect(started).toBe(1);
    expect(a.autoCall?.ref).toBe(`p${h2.id}`);
  });

  it("un signal s'arrête quand son objet disparaît (ramassé par un allié, périmé)", () => {
    const [a, b] = team();
    wound(b);
    const pk = [heart(a.pos.x, a.pos.y)];
    tick([a, b], pk, [], 5);
    expect(a.autoCall).toBeDefined();
    pk.length = 0; // l'allié l'a mangé
    tick([a, b], pk, [], 1);
    expect(a.autoCall).toBeUndefined();
    expect(a.autoCallSeen).toBeUndefined();
  });
});

// ───────────────────────────── Signal automatique ≠ appel manuel ─────────────────────────────

describe('signal automatique ≠ appel manuel', () => {
  it("ne touche pas au délai de l'appel manuel : on peut toujours appeler à la main", () => {
    const [a, b] = team();
    wound(b);
    tick([a, b], [heart(a.pos.x, a.pos.y)], [], 1);
    expect(a.autoCall).toBeDefined();
    expect(a.callMs).toBe(0);
    expect(a.callCooldownMs).toBe(0);
    expect(canStartCall(a)).toBe(true);
  });

  it("l'appel manuel l'emporte : il efface l'icône automatique (le délai automatique, lui, continue)", () => {
    const [a, b] = team();
    wound(b);
    tick([a, b], [heart(a.pos.x, a.pos.y)], [], 1);
    startCall(a);
    expect(a.autoCall).toBeUndefined();
    expect(a.callMs).toBe(CALL_DURATION_MS);
    expect(a.autoCallCooldownMs).toBeGreaterThan(0);
  });

  it("un appel manuel en cours n'est pas interrompu par un automatique (aucun déclenchement pendant l'appel manuel)", () => {
    const [a, b] = team();
    wound(b);
    startCall(a);
    expect(run([a, b], [heart(a.pos.x, a.pos.y)])).toEqual([]);
    expect(a.callMs).toBe(CALL_DURATION_MS);
    expect(a.autoCall).toBeUndefined();
  });

  it('timers : le signal décroît comme l\'appel manuel (3 s) puis le champ est supprimé ; le délai aussi', () => {
    const [a, b] = team();
    wound(b);
    run([a, b], [heart(a.pos.x, a.pos.y)]);
    const steps = Math.round(AUTO_CALL_DURATION_MS / DT);
    for (let i = 0; i < steps - 1; i++) stepAutoCallTimers(a, DT);
    expect(a.autoCall).toBeDefined();
    stepAutoCallTimers(a, DT);
    expect(a.autoCall).toBeUndefined();
    expect(a.autoCallCooldownMs).toBeGreaterThan(0);
    for (let i = 0; i < Math.round(AUTO_CALL_COOLDOWN_MS / DT); i++) stepAutoCallTimers(a, DT);
    expect(a.autoCallCooldownMs).toBeUndefined();
  });
});

// ───────────────────────────── Remise à zéro ─────────────────────────────

describe('remise à zéro', () => {
  const armed = (): PlayerState => {
    const [a, b] = team();
    wound(b);
    run([a, b], [heart(a.pos.x, a.pos.y)]);
    expect(a.autoCall).toBeDefined();
    return a;
  };

  it('chute au combat / scénarisée (markPlayerDown) : signal, délai et mémoire effacés', () => {
    const a = armed();
    markPlayerDown(a);
    expect(a.autoCall).toBeUndefined();
    expect(a.autoCallCooldownMs).toBeUndefined();
    expect(a.autoCallSeen).toBeUndefined();
  });

  it("dégâts mortels (applyDamageToPlayer) : idem", () => {
    const a = armed();
    a.invulnMs = 0;
    applyDamageToPlayer(a, 9999);
    expect(a.status).toBe('down');
    expect(a.autoCall).toBeUndefined();
  });

  it('entrée de salle (resetPlayersForRoom) : tout est effacé', () => {
    const a = armed();
    resetPlayersForRoom([a], [{ x: 10, y: 10 }]);
    expect(a.autoCall).toBeUndefined();
    expect(a.autoCallCooldownMs).toBeUndefined();
    expect(a.autoCallSeen).toBeUndefined();
  });

  it('cancelAutoCall n\'efface que le signal ; resetAutoCall efface tout', () => {
    const a = armed();
    cancelAutoCall(a);
    expect(a.autoCall).toBeUndefined();
    expect(a.autoCallCooldownMs).toBeGreaterThan(0);
    expect(a.autoCallSeen).toBeDefined();
    resetAutoCall(a);
    expect(a.autoCallCooldownMs).toBeUndefined();
    expect(a.autoCallSeen).toBeUndefined();
  });
});

// ───────────────────────────── Tolérance des anciens états ─────────────────────────────

describe('tolérance : états anciens ou mal formés', () => {
  it('un joueur sans aucun champ d\'appel automatique est valide (rien n\'est ajouté)', () => {
    const p = mkPlayer(0);
    const before = JSON.stringify(p);
    normalizeAutoCallFields(p);
    expect(JSON.stringify(p)).toBe(before);
    expect(Object.keys(p)).not.toContain('autoCall');
    expect(Object.keys(p)).not.toContain('autoCallSeen');
    expect(Object.keys(p)).not.toContain('autoCallCooldownMs');
  });

  it('champs mal formés : supprimés ; champ bien formé : conservé', () => {
    const p = mkPlayer(0) as unknown as Record<string, unknown>;
    p.autoCall = { icon: 'poire', ref: 3, ms: 'x', to: 'y' };
    p.autoCallCooldownMs = 'beaucoup';
    p.autoCallSeen = [1, 2];
    normalizeAutoCallFields(p as unknown as PlayerState);
    expect(p.autoCall).toBeUndefined();
    expect(p.autoCallCooldownMs).toBeUndefined();
    expect(p.autoCallSeen).toBeUndefined();
    p.autoCall = { icon: 'gear', item: { slot: 'weapon', level: 2 }, ref: 'g1', ms: 1200, to: [1] };
    p.autoCallSeen = ['g1'];
    normalizeAutoCallFields(p as unknown as PlayerState);
    expect(p.autoCall).toBeDefined();
    expect(p.autoCallSeen).toEqual(['g1']);
  });

  it("restore : un snapshot sans champ d'appel automatique se charge et fonctionne ; un snapshot avec signal valide le conserve", () => {
    const s = makeSim();
    const snap = s.serialize();
    expect(snap).not.toContain('autoCall'); // un état sans appel automatique est identique à celui d'avant l'ajout
    const r = GameSimulation.restore(snap, s.level);
    expect(() => r.step(DT, {})).not.toThrow();
    const st = JSON.parse(snap);
    st.players[0].autoCall = { icon: 'heart', ref: 'p1', ms: 900, to: [1] };
    const r2 = GameSimulation.restore(JSON.stringify(st), s.level);
    expect(r2.state.players[0].autoCall?.ms).toBe(900);
    st.players[0].autoCall = { icon: 'heart', ref: 'p1', ms: -4, to: [1] };
    expect(GameSimulation.restore(JSON.stringify(st), s.level).state.players[0].autoCall).toBeUndefined();
  });
});

// ───────────────────────────── Simulation de bout en bout (2 joueurs) ─────────────────────────────

function arena(): LevelDef {
  return makeTestLevel({
    rooms: [
      makeTestRoom({
        id: 'r1',
        layout: makeTestLayout(30, 20),
        playerSpawns: [
          [5, 5],
          [6, 5],
          [5, 6],
          [6, 6],
        ],
        mechanisms: [],
        exit: { rect: { x: 27, y: 17, w: 2, h: 2 }, requires: [] },
      }),
      makeTestRoom({ id: 'r2', exit: { rect: { x: 9, y: 5, w: 2, h: 2 }, requires: [], final: true } }),
    ],
    objectives: [0, 1, 2, 3].map((slot) => ({ id: `o${slot}`, slot, roomId: 'r1', kind: 'kills' as const, labelKey: `objective.test.o${slot}`, count: 99 })),
  });
}

function makeSim(n = 2, opts: { autoCall?: boolean; loot?: boolean; gear?: boolean; seed?: number; level?: LevelDef } = {}): GameSimulation {
  return createSimulation(
    {
      levelId: 'test',
      seed: opts.seed ?? 7,
      loot: opts.loot ?? true,
      gear: opts.gear ?? true,
      autoCall: opts.autoCall,
      players: Array.from({ length: n }, (_, i) => ({ id: i as PlayerId, characterId: (['david', 'valentine', 'mira', 'brokk'] as const)[i], difficulty: 2 as const })),
    },
    opts.level ?? arena(),
  );
}

const frame = (over: Partial<ActionFrame> = {}): ActionFrame => ({ moveX: 0, moveY: 0, attack: false, interact: false, revive: false, ...over });

function stepN(s: GameSimulation, n: number, inputs: TickInputs | ((i: number) => TickInputs) = {}): SimEvent[] {
  const all: SimEvent[] = [];
  for (let i = 0; i < n; i++) all.push(...s.step(DT, typeof inputs === 'function' ? inputs(i) : inputs));
  return all;
}

/** Place un cœur au sol (ids propres au butin de vie) et retourne son id. */
function putHeart(s: GameSimulation, x: number, y: number, kind: PickupState['kind'] = 'full'): number {
  const id = s.state.nextPickupId ?? 1;
  s.state.nextPickupId = id + 1;
  (s.state.room.pickups as PickupState[]).push({ id, kind, pos: { x, y }, ttlMs: PICKUP_TTL_MS });
  return id;
}

function putDrop(s: GameSimulation, item: GearItem, x: number, y: number, lockedFor: PlayerId | null = null): number {
  const id = s.state.nextGearDropId ?? 1;
  s.state.nextGearDropId = id + 1;
  (s.state.room.gearDrops as GearDropState[]).push({ id, item, pos: { x, y }, ttlMs: GEAR_TTL_MS, lockedFor, lockMode: 'life' });
  return id;
}

/** Joueurs éloignés l'un de l'autre (p0 en (100,100), p1 en (400,300)). */
function spread(s: GameSimulation): void {
  s.state.players[0].pos = { x: 100, y: 100 };
  s.state.players[1].pos = { x: 400, y: 300 };
}

describe('simulation : appel automatique de bout en bout (2 joueurs)', () => {
  it('cœur sous un joueur plein, allié blessé et loin : événement, signal visible, SANS immobilisation ni délai manuel', () => {
    const s = makeSim();
    stepN(s, 1);
    spread(s);
    s.state.players[1].hp = 20;
    putHeart(s, 100, 100);
    const ev = stepN(s, 1, { 0: frame({ moveX: 1 }) });
    const auto = ev.filter((e) => e.type === 'autoCallStarted');
    expect(auto).toEqual([{ type: 'autoCallStarted', playerId: 0, icon: 'heart', to: [1] }]);
    expect(ev.some((e) => e.type === 'callStarted')).toBe(false); // pas l'appel manuel : pas d'animation d'immobilisation
    const p0 = s.state.players[0];
    expect(p0.autoCall?.ms).toBe(AUTO_CALL_DURATION_MS);
    expect(p0.callMs).toBe(0);
    expect(p0.callCooldownMs).toBe(0);
    // il continue de marcher pendant le signal
    const x0 = p0.pos.x;
    stepN(s, 30, { 0: frame({ moveX: 1 }) });
    expect(p0.pos.x).toBeGreaterThan(x0 + 10);
    expect(p0.autoCall).toBeDefined();
    // le signal dure 3 s
    stepN(s, 160);
    expect(p0.autoCall).toBeUndefined();
  });

  it('cœur à portée du blessé aussi : il est consommé, aucun appel', () => {
    const s = makeSim();
    stepN(s, 1);
    s.state.players[0].pos = { x: 100, y: 100 };
    s.state.players[1].pos = { x: 104, y: 100 };
    s.state.players[1].hp = 20;
    putHeart(s, 100, 100);
    const ev = stepN(s, 2);
    expect(ev.some((e) => e.type === 'pickupCollected')).toBe(true);
    expect(ev.some((e) => e.type === 'autoCallStarted')).toBe(false);
    expect(s.state.players[0].autoCall).toBeUndefined();
  });

  it("un appui d'appel manuel remplace le signal automatique (callStarted, immobilisation, délai de 5 s)", () => {
    const s = makeSim();
    stepN(s, 1);
    spread(s);
    s.state.players[1].hp = 20;
    putHeart(s, 100, 100);
    stepN(s, 2);
    expect(s.state.players[0].autoCall).toBeDefined();
    const ev = stepN(s, 1, { 0: frame({ call: true }) });
    expect(ev.some((e) => e.type === 'callStarted')).toBe(true);
    const p0 = s.state.players[0];
    expect(p0.autoCall).toBeUndefined();
    expect(p0.callMs).toBeGreaterThan(0);
    expect(p0.callCooldownMs).toBeGreaterThan(0);
  });

  it("objet d'équipement refusé : appel avec l'icône ; l'objet reste au sol ; quand l'allié le ramasse, le signal s'arrête", () => {
    const s = makeSim();
    stepN(s, 1);
    spread(s);
    s.state.players[0].loadout.weapon = 3;
    const id = putDrop(s, weapon(2), 100, 100);
    const ev = stepN(s, 2);
    expect(ev.filter((e) => e.type === 'autoCallStarted')).toEqual([{ type: 'autoCallStarted', playerId: 0, icon: 'gear', to: [1] }]);
    expect(s.state.room.gearDrops?.some((d) => d.id === id)).toBe(true);
    expect(s.state.players[0].autoCall?.item).toEqual(weapon(2));
    // l'allié vient le prendre
    s.state.players[1].pos = { x: 100, y: 100 };
    const ev2 = stepN(s, 2);
    expect(ev2.some((e) => e.type === 'gearPicked')).toBe(true);
    expect(s.state.players[0].autoCall).toBeUndefined();
  });

  it("solo, tutoriel / démo (option autoCall: false) : aucun appel, et l'option est portée par l'état", () => {
    const solo = makeSim(1);
    stepN(solo, 1);
    solo.state.players[0].pos = { x: 100, y: 100 };
    putHeart(solo, 100, 100);
    expect(stepN(solo, 5).some((e) => e.type === 'autoCallStarted')).toBe(false);

    const off = makeSim(2, { autoCall: false });
    expect(off.state.autoCallDisabled).toBe(true);
    stepN(off, 1);
    spread(off);
    off.state.players[1].hp = 20;
    putHeart(off, 100, 100);
    expect(stepN(off, 5).some((e) => e.type === 'autoCallStarted')).toBe(false);
    expect(GameSimulation.restore(off.serialize(), off.level).state.autoCallDisabled).toBe(true);

    const on = makeSim(2);
    expect(on.state.autoCallDisabled).toBeUndefined(); // défaut : actif, aucun champ ajouté à l'état
  });

  it("à la chute du joueur et à l'entrée de la salle suivante : le signal est remis à zéro", () => {
    const s = makeSim();
    stepN(s, 1);
    spread(s);
    s.state.players[1].hp = 20;
    putHeart(s, 100, 100);
    stepN(s, 2);
    expect(s.state.players[0].autoCall).toBeDefined();
    // salle suivante : les deux joueurs rejoignent la sortie (le cœur reste derrière)
    const exit = tileCenter(27, 17);
    s.state.players[0].pos = { x: exit.x + 4, y: exit.y + 4 };
    s.state.players[1].pos = { x: exit.x + 8, y: exit.y + 8 };
    const ev: SimEvent[] = [];
    for (let i = 0; i < Math.ceil(ROOM_CLEAR_DELAY_MS / DT) + 40 && s.state.roomIndex === 0; i++) ev.push(...s.step(DT, {}));
    expect(s.state.roomIndex).toBe(1);
    for (const p of s.state.players) {
      expect(p.autoCall).toBeUndefined();
      expect(p.autoCallCooldownMs).toBeUndefined();
      expect(p.autoCallSeen).toBeUndefined();
    }
    // chute scénarisée
    const s2 = makeSim();
    stepN(s2, 1);
    spread(s2);
    s2.state.players[1].hp = 20;
    putHeart(s2, 100, 100);
    stepN(s2, 2);
    expect(s2.knockDown(0)).toBe(true);
    expect(s2.state.players[0].autoCall).toBeUndefined();
    stepN(s2, 2);
    expect(s2.state.players[0].autoCall).toBeUndefined();
  });

  it('plusieurs émetteurs : chacun son signal, destinataires distincts', () => {
    const s = makeSim(3);
    stepN(s, 1);
    s.state.players[0].pos = { x: 100, y: 100 };
    s.state.players[1].pos = { x: 300, y: 100 };
    s.state.players[2].pos = { x: 500, y: 300 };
    s.state.players[2].hp = 10; // seul blessé
    putHeart(s, 100, 100);
    putHeart(s, 300, 100, 'half');
    const ev = stepN(s, 2).filter((e) => e.type === 'autoCallStarted');
    expect(ev).toEqual([
      { type: 'autoCallStarted', playerId: 0, icon: 'heart', to: [2] },
      { type: 'autoCallStarted', playerId: 1, icon: 'half', to: [2] },
    ]);
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
  }
  return st;
}

/** Entrées déterministes (marche circulaire + attaques périodiques), sans aucun hasard ni horloge. */
function script(i: number): TickInputs {
  const a = (i / 40) % (2 * Math.PI);
  const b = (i / 55 + 1) % (2 * Math.PI);
  return {
    0: frame({ moveX: Math.cos(a), moveY: Math.sin(a), attack: i % 20 < 10 }),
    1: frame({ moveX: Math.sin(b), moveY: Math.cos(b), attack: i % 30 < 12 }),
  };
}

function populated(autoCall: boolean, seed: number): GameSimulation {
  const s = makeSim(2, { autoCall, seed });
  stepN(s, 1);
  // ennemis (butin de vie et d'équipement actifs : flux aléatoires dédiés) + objets posés sur le trajet des joueurs
  for (let k = 0; k < 6; k++) {
    const e = createEnemyState('skeleton', { x: 200 + k * 30, y: 150 + (k % 3) * 40 }, s.state.nextEntityId++, 0);
    s.state.room.enemies.push(e);
  }
  s.state.players[1].hp = 15; // l'allié est blessé : les cœurs sont utiles
  const p0 = s.state.players[0];
  p0.loadout.weapon = 3; // le joueur 0 refuse les armes inférieures
  const c = tileCenter(5, 5);
  putHeart(s, c.x, c.y);
  putHeart(s, c.x + 40, c.y + 10, 'half');
  putDrop(s, weapon(1), c.x + 3, c.y + 3);
  putDrop(s, weapon(2), c.x + 60, c.y + 20);
  return s;
}

describe("non-régression : l'appel automatique n'a AUCUN effet sur le jeu", () => {
  for (const seed of [1, 7, 4242]) {
    it(`graine ${seed} : états identiques hors des champs d'appel automatique, flux aléatoires inchangés`, () => {
      const on = populated(true, seed);
      const off = populated(false, seed);
      let started = 0;
      let startedOff = 0;
      for (let i = 0; i < 1500; i++) {
        const a = on.step(DT, script(i));
        const b = off.step(DT, script(i));
        started += a.filter((e) => e.type === 'autoCallStarted').length;
        startedOff += b.filter((e) => e.type === 'autoCallStarted').length;
        // les événements de jeu sont identiques (hors autoCallStarted)
        expect(a.filter((e) => e.type !== 'autoCallStarted')).toEqual(b);
        if (i % 100 === 0) expect(stripAuto(on.serialize())).toEqual(stripAuto(off.serialize()));
      }
      expect(stripAuto(on.serialize())).toEqual(stripAuto(off.serialize()));
      expect(started).toBeGreaterThan(0); // le scénario déclenche bien des appels (sinon le test ne prouverait rien)
      expect(startedOff).toBe(0);
      const a = on.state;
      const b = off.state;
      expect([a.rngState, a.lootRngState, a.gearRngState]).toEqual([b.rngState, b.lootRngState, b.gearRngState]);
    });
  }

  it('sans objet au sol ni allié utile, la sérialisation est strictement celle d\'avant (aucun champ ajouté)', () => {
    const s = makeSim(2, { loot: false, gear: false });
    stepN(s, 600, script);
    expect(s.serialize()).not.toContain('autoCall');
  });
});

// ───────────────────────────── Corrections après relecture ─────────────────────────────

describe("anti-spam : objet d'ÉQUIPEMENT (miroir du cœur)", () => {
  const setup = (): { a: PlayerState; b: PlayerState; gd: GearDropState[] } => {
    const [a, b] = team();
    a.loadout.weapon = 3;
    return { a, b, gd: [drop(weapon(2), a.pos.x, a.pos.y)] };
  };

  it('par couple : un seul déclenchement tant que le joueur reste sur l\'objet, même après le délai de récupération', () => {
    const { a, b, gd } = setup();
    expect(autoEvents(tick([a, b], [], gd, 1))).toHaveLength(1);
    expect(autoEvents(tick([a, b], [], gd, Math.ceil((AUTO_CALL_COOLDOWN_MS + AUTO_CALL_DURATION_MS) / DT)))).toHaveLength(0);
    expect(a.autoCallSeen).toEqual([`g${gd[0].id}`]);
  });

  it("ré-armement (valeurs figées : rayon 14 px, marge 4 px) : à 18 px l'objet reste « vu », à plus de 18 px il est oublié, et le retour redéclenche", () => {
    expect(GEAR_PICKUP_RADIUS).toBe(14);
    expect(AUTO_CALL_REARM_MARGIN).toBe(4);
    expect(AUTO_CALL_COOLDOWN_MS).toBe(4000);
    const { a, b, gd } = setup();
    const origin = { ...a.pos };
    tick([a, b], [], gd, 1);
    a.pos = { x: origin.x + 18, y: origin.y }; // pile au bord rayon + marge : encore « vu »
    tick([a, b], [], gd, 1);
    expect(a.autoCallSeen).toHaveLength(1);
    a.pos = { x: origin.x + 18.5, y: origin.y }; // juste au-delà : oublié
    tick([a, b], [], gd, 1);
    expect(a.autoCallSeen).toBeUndefined();
    a.pos = { ...origin };
    expect(autoEvents(tick([a, b], [], gd, Math.ceil(AUTO_CALL_COOLDOWN_MS / DT) + 1))).toHaveLength(1); // une fois le délai du joueur écoulé, le retour redéclenche
  });

  it('bord exact du rayon de contact (14 px) : déclenche ; 14,5 px : rien', () => {
    const [a, b] = team();
    a.loadout.weapon = 3;
    expect(run([a, b], [], [drop(weapon(2), a.pos.x + 14.5, a.pos.y)])).toEqual([]);
    expect(run([a, b], [], [drop(weapon(2), a.pos.x + 14, a.pos.y)])).toHaveLength(1);
  });
});

describe("un signal s'arrête quand SON objet disparaît, même s'il reste un autre objet au sol", () => {
  it('deux objets au sol : le signal de A est purgé quand A disparaît (B reste)', () => {
    const [a, b] = team();
    wound(b);
    const hA = heart(a.pos.x, a.pos.y);
    const hB = heart(a.pos.x + 500, a.pos.y + 500); // loin de tout le monde
    const pk = [hA, hB];
    run([a, b], pk);
    expect(a.autoCall?.ref).toBe(`p${hA.id}`);
    pk.splice(0, 1); // A disparaît, B reste
    run([a, b], pk);
    expect(a.autoCall).toBeUndefined();
  });
});

describe('garde-fou de fin de pas : un joueur à terre sans markPlayerDown', () => {
  it("son signal automatique est effacé au pas suivant même si l'état a été forcé", () => {
    const s = makeSim();
    stepN(s, 1);
    spread(s);
    s.state.players[1].hp = 20;
    putHeart(s, 100, 100);
    stepN(s, 2);
    expect(s.state.players[0].autoCall).toBeDefined();
    s.state.players[0].status = 'down'; // forcé, sans passer par markPlayerDown
    stepN(s, 1);
    expect(s.state.players[0].autoCall).toBeUndefined();
  });
});

describe("phase 'roomCleared' : l'équipement reste ramassable, l'appel suit", () => {
  const cleared = (): GameSimulation => {
    const s = makeSim();
    stepN(s, 1);
    spread(s);
    s.state.players[0].loadout.weapon = 3;
    s.state.phase = 'roomCleared';
    s.state.phaseTimerMs = 0;
    return s;
  };

  it("déclenchement en 'roomCleared' : l'allié peut encore prendre l'objet, il est prévenu", () => {
    const s = cleared();
    putDrop(s, weapon(2), 100, 100);
    const ev = stepN(s, 3);
    expect(ev.filter((e) => e.type === 'autoCallStarted')).toEqual([{ type: 'autoCallStarted', playerId: 0, icon: 'gear', to: [1] }]);
    expect(s.state.phase).toBe('roomCleared');
  });

  it("plus d'appel fantôme : l'allié prend l'objet en 'roomCleared', le signal s'arrête aussitôt", () => {
    const s = cleared();
    const id = putDrop(s, weapon(2), 100, 100);
    stepN(s, 3);
    expect(s.state.players[0].autoCall?.ref).toBe(`g${id}`);
    s.state.players[1].pos = { x: 100, y: 100 };
    const ev = stepN(s, 2);
    expect(ev.some((e) => e.type === 'gearPicked')).toBe(true);
    expect(s.state.room.gearDrops?.length ?? 0).toBe(0);
    expect(s.state.players[0].autoCall).toBeUndefined();
  });
});

describe('tolérance bornée : valeurs hostiles', () => {
  const norm = (patch: Record<string, unknown>): Record<string, unknown> => {
    const p = mkPlayer(0) as unknown as Record<string, unknown>;
    Object.assign(p, patch);
    normalizeAutoCallFields(p as unknown as PlayerState);
    return p;
  };

  it('durée du signal et délai bornés par leurs constantes', () => {
    expect(norm({ autoCall: { icon: 'heart', ref: 'p1', ms: 1e12, to: [1] } }).autoCall).toBeUndefined();
    expect(norm({ autoCall: { icon: 'heart', ref: 'p1', ms: AUTO_CALL_DURATION_MS, to: [1] } }).autoCall).toBeDefined();
    expect(norm({ autoCallCooldownMs: 1e15 }).autoCallCooldownMs).toBeUndefined();
    expect(norm({ autoCallCooldownMs: AUTO_CALL_COOLDOWN_MS }).autoCallCooldownMs).toBe(AUTO_CALL_COOLDOWN_MS);
  });

  it("objet d'équipement hors catalogue : signal supprimé (aucune frame d'atlas inexistante)", () => {
    const gear = (item: unknown): unknown => norm({ autoCall: { icon: 'gear', item, ref: 'g1', ms: 1000, to: [1] } }).autoCall;
    expect(gear({ slot: 'foo', level: 1 })).toBeUndefined();
    expect(gear({ slot: 'weapon', level: 9 })).toBeUndefined();
    expect(gear({ slot: 'weapon', level: 0 })).toBeUndefined();
    expect(gear({ slot: 'accessory', level: 1, accessory: 'zzz' })).toBeUndefined();
    expect(gear({ slot: 'weapon', level: 3 })).toBeDefined();
    expect(gear({ slot: 'accessory', level: 2, accessory: 'magnet' })).toBeDefined();
  });
});

describe('sans allocation de tableau quand rien ne part', () => {
  it("les événements sont ajoutés au tableau fourni (et retournés) ; aucun événement : le tableau reste vide", () => {
    const [a, b] = team();
    wound(b);
    const out: SimEvent[] = [];
    expect(stepAutoCalls([a, b], [], [], out)).toBe(out);
    expect(out).toEqual([]);
    stepAutoCalls([a, b], [heart(a.pos.x, a.pos.y)], [], out);
    expect(out).toHaveLength(1);
  });
});
