/**
 * TRAIT D'APPEL « PARLE BEAUCOUP » (Romain, `callTraits.ts`, constantes [B31]) : fonctions pures de lecture du trait, appel MANUEL sans attente (mais jamais pendant le signal),
 * appel AUTOMATIQUE d'objet sans délai (anti-spam par couple conservé, remplacement immédiat, manuel prioritaire), CROIX ROUGE toutes les 3 s (sans trou, son plus doux aux répétitions),
 * cohésion (le trait suit le HÉROS, pas l'indice du joueur), simulation de bout en bout à 2 joueurs et NON-RÉGRESSION (les autres héros : octet pour octet ; flux aléatoires inchangés).
 * Aucune horloge réelle : tout passe par des pas fixes.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { normalizeAutoCallFields, pickupRef, stepAutoCalls } from './autoCall';
import { AUTO_CALL_COOLDOWN_MS, AUTO_CALL_COOLDOWN_MS_CHATTY, AUTO_CALL_DURATION_MS, AUTO_CALL_MIN_SHOW_MS_CHATTY, CALL_COOLDOWN_MS_CHATTY, CROSS_CALL_REPEAT_MS, CROSS_CALL_REPEAT_MS_CHATTY, PICKUP_TTL_MS } from './balance';
import {
  DEFAULT_CALL_TRAITS,
  autoCallCooldownFor,
  autoCallsWithoutWait,
  callCooldownFor,
  callTraitsFor,
  callTraitsOfCharacter,
  crossRepeatMsFor,
  crossSoftRepeatFor,
  resetCallTraitsCache,
} from './callTraits';
import { CHARACTER_IDS, CHARACTERS } from './characters';
import { CALL_COOLDOWN_MS, CALL_DURATION_MS, CALL_FREEZE_MS, SIM_STEP_MS } from './constants';
import { createEnemyState } from './ai';
import { makeTestLayout, makeTestLevel, makeTestRoom } from './levelValidation';
import { canStartCall, createPlayerState, isCallFrozen, markPlayerDown, resetPlayersForRoom, startCall, stepPlayerTimers } from './players';
import { createSimulation, GameSimulation } from './simulation';
import { sfxForEvent, sfxVolume } from '../entities/sfx';
import type { ActionFrame, CharacterId, GearDropState, GearItem, LevelDef, PickupState, PlayerId, PlayerState, SimEvent, TickInputs } from './types';

const DT = SIM_STEP_MS;

/** Empreinte 53 bits (cyrb53) en hexadécimal : pur, sans dépendance (pas de module Node), assez large pour détecter la moindre différence de sérialisation. */
class Digest {
  private h1 = 0xdeadbeef;
  private h2 = 0x41c6ce57;
  update(text: string): void {
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      this.h1 = Math.imul(this.h1 ^ c, 2654435761);
      this.h2 = Math.imul(this.h2 ^ c, 1597334677);
    }
    this.h1 = Math.imul(this.h1 ^ (this.h1 >>> 16), 2246822507) ^ Math.imul(this.h2 ^ (this.h2 >>> 13), 3266489909);
    this.h2 = Math.imul(this.h2 ^ (this.h2 >>> 16), 2246822507) ^ Math.imul(this.h1 ^ (this.h1 >>> 13), 3266489909);
  }
  hex(): string {
    return (this.h2 >>> 0).toString(16).padStart(8, '0') + (this.h1 >>> 0).toString(16).padStart(8, '0');
  }
}
type AutoEvent = Extract<SimEvent, { type: 'autoCallStarted' }>;

// ───────────────────────────── Outils ─────────────────────────────

function mk(id: PlayerId, character: CharacterId = 'david', x = 100 + id * 200, y = 100): PlayerState {
  return createPlayerState({ id, characterId: character, difficulty: 2 }, { x, y });
}

let nextId = 1;
function heart(x: number, y: number): PickupState {
  return { id: nextId++, kind: 'full', pos: { x, y }, ttlMs: PICKUP_TTL_MS };
}

const autoEvents = (ev: readonly SimEvent[]): AutoEvent[] => ev.filter((e): e is AutoEvent => e.type === 'autoCallStarted');
const crossEvents = (ev: readonly SimEvent[]): AutoEvent[] => autoEvents(ev).filter((e) => e.icon === 'cross');

/** Un pas pur : minuteurs puis `stepAutoCalls` (équivalent du début d'un pas de simulation), avec l'emplacement cœur. Retourne les événements du pas. */
function tick(players: PlayerState[], pickups: PickupState[] = [], heartSlot = false): SimEvent[] {
  for (const p of players) stepPlayerTimers(p, DT);
  return stepAutoCalls(players, pickups, [], [], { heartSlot });
}

/** `n` pas ; retourne, pour chaque événement, le numéro du pas (0 = premier pas de cet appel) où il est parti. */
function run(players: PlayerState[], n: number, pickups: PickupState[] = [], each?: (i: number) => void): { step: number; e: AutoEvent }[] {
  const out: { step: number; e: AutoEvent }[] = [];
  for (let i = 0; i < n; i++) {
    each?.(i);
    for (const e of autoEvents(tick(players, pickups))) out.push({ step: i, e });
  }
  return out;
}

const steps = (ms: number): number => Math.round(ms / DT);
const hpAt = (p: PlayerState, fraction: number): void => {
  p.hp = p.maxHp * fraction;
};
const wound = (p: PlayerState): void => {
  p.hp = p.maxHp - 20;
};

// ───────────────────────────── Fonctions pures de trait ─────────────────────────────

describe('trait d\'appel : fonctions pures (data-driven) et constantes [B31]', () => {
  it('constantes [B31] : aucune attente (manuel, objets) et croix toutes les 3 s ; défauts = valeurs d\'origine (5 s, 4 s, 10 s)', () => {
    expect(CALL_COOLDOWN_MS_CHATTY).toBe(0);
    expect(AUTO_CALL_COOLDOWN_MS_CHATTY).toBe(0);
    expect(CROSS_CALL_REPEAT_MS_CHATTY).toBe(3000);
    expect(DEFAULT_CALL_TRAITS).toEqual({ manualCooldownMs: 5000, autoCooldownMs: 4000, crossRepeatMs: 10_000, crossSoftRepeat: false });
    expect(DEFAULT_CALL_TRAITS.manualCooldownMs).toBe(CALL_COOLDOWN_MS);
    expect(DEFAULT_CALL_TRAITS.autoCooldownMs).toBe(AUTO_CALL_COOLDOWN_MS);
    expect(DEFAULT_CALL_TRAITS.crossRepeatMs).toBe(CROSS_CALL_REPEAT_MS);
    expect(CROSS_CALL_REPEAT_MS_CHATTY).toBe(AUTO_CALL_DURATION_MS); // la croix est quasi continue : une répétition par durée de signal
  });

  it('Romain : appel manuel et automatique sans attente, croix toutes les 3 s, répétitions douces', () => {
    const r = mk(0, 'romain');
    expect(callCooldownFor(r)).toBe(0);
    expect(autoCallCooldownFor(r)).toBe(0);
    expect(autoCallsWithoutWait(r)).toBe(true);
    expect(crossRepeatMsFor(r)).toBe(3000);
    expect(crossSoftRepeatFor(r)).toBe(true);
    expect(callTraitsFor(r)).toEqual({ manualCooldownMs: 0, autoCooldownMs: 0, crossRepeatMs: 3000, crossSoftRepeat: true });
  });

  it('les 7 autres héros : exactement les valeurs d\'origine (5 s / 4 s / 10 s), aucun trait déclaré', () => {
    for (const id of CHARACTER_IDS) {
      if (id === 'romain') continue;
      expect(CHARACTERS[id].callTraits, id).toBeUndefined();
      const p = mk(0, id);
      expect(callTraitsFor(p), id).toBe(DEFAULT_CALL_TRAITS);
      expect(callCooldownFor(p), id).toBe(5000);
      expect(autoCallCooldownFor(p), id).toBe(4000);
      expect(autoCallsWithoutWait(p), id).toBe(false);
      expect(crossRepeatMsFor(p), id).toBe(10_000);
      expect(crossSoftRepeatFor(p), id).toBe(false);
    }
  });

  it('data-driven : seul Romain déclare un trait ; un identifiant inconnu (état corrompu) retombe sur les défauts sans lever', () => {
    expect(CHARACTER_IDS.filter((id) => CHARACTERS[id].callTraits !== undefined)).toEqual(['romain']);
    expect(() => callTraitsOfCharacter('inconnu' as CharacterId)).not.toThrow();
    expect(callTraitsOfCharacter('inconnu' as CharacterId)).toBe(DEFAULT_CALL_TRAITS);
  });

  it('le trait suit le HÉROS : changer de personnage change le trait, quel que soit l\'indice du joueur', () => {
    const team = [mk(0, 'david'), mk(1, 'mira'), mk(2, 'romain'), mk(3, 'valentine')];
    expect(team.map((p) => callCooldownFor(p))).toEqual([5000, 5000, 0, 5000]);
    expect(team.map((p) => crossRepeatMsFor(p))).toEqual([10_000, 10_000, 3000, 10_000]);
    const swapped = [mk(0, 'romain'), mk(1, 'brokk'), mk(2, 'sandrine'), mk(3, 'grok')];
    expect(swapped.map((p) => callCooldownFor(p))).toEqual([0, 5000, 5000, 5000]);
    team[0].characterId = 'romain'; // choix de héros modifié (menu) : le trait suit
    expect(callCooldownFor(team[0])).toBe(0);
    team[0].characterId = 'david';
    expect(callCooldownFor(team[0])).toBe(5000);
  });
});

// ───────────────────────────── Appel MANUEL ─────────────────────────────

describe('appel manuel : Romain sans attente (mais jamais pendant son signal)', () => {
  it('Romain : startCall ne pose AUCUN délai de récupération ; le signal (3 s) et l\'immobilisation (1 s) restent', () => {
    const r = mk(0, 'romain');
    expect(canStartCall(r)).toBe(true);
    startCall(r);
    expect(r.callMs).toBe(CALL_DURATION_MS);
    expect(r.callCooldownMs).toBe(0);
    expect(isCallFrozen(r)).toBe(true);
    for (let i = 0; i < steps(CALL_FREEZE_MS) + 2; i++) stepPlayerTimers(r, DT);
    expect(isCallFrozen(r)).toBe(false); // l'immobilisation dure 1 s, comme pour les autres
    expect(r.callMs).toBeGreaterThan(0); // le signal continue
  });

  it('pas de relance PENDANT le signal en cours (3 s), relance immédiate dès qu\'il est fini', () => {
    const r = mk(0, 'romain');
    startCall(r);
    let startedAgainEarly = false;
    let i = 0;
    while (r.callMs > 0 && i < 400) {
      stepPlayerTimers(r, DT);
      if (r.callMs > 0 && canStartCall(r)) startedAgainEarly = true;
      i++;
    }
    expect(startedAgainEarly).toBe(false);
    expect(i).toBe(steps(CALL_DURATION_MS)); // le signal a bien duré 3 s
    expect(r.callMs).toBe(0);
    expect(canStartCall(r)).toBe(true); // aucune attente après la fin du signal
    startCall(r);
    expect(r.callMs).toBe(CALL_DURATION_MS);
  });

  it('un autre héros (david) : délai de 5 s depuis l\'appui (2 s de repos après le signal)', () => {
    const d = mk(0, 'david');
    startCall(d);
    expect(d.callCooldownMs).toBe(CALL_COOLDOWN_MS);
    for (let i = 0; i < steps(CALL_DURATION_MS) + 2; i++) stepPlayerTimers(d, DT);
    expect(d.callMs).toBe(0);
    expect(canStartCall(d)).toBe(false); // il reste ≈ 2 s de repos
    for (let i = 0; i < steps(2000) + 2; i++) stepPlayerTimers(d, DT);
    expect(canStartCall(d)).toBe(true);
  });

  it('un joueur à terre ne peut pas appeler (Romain compris)', () => {
    const r = mk(0, 'romain');
    markPlayerDown(r);
    expect(canStartCall(r)).toBe(false);
  });

  it('simulation : Romain relance dès la fin du signal, jamais deux signaux qui se chevauchent ; david attend 5 s ; callCooldownMs de Romain reste 0', () => {
    const count = (id: CharacterId): { starts: number[]; maxCooldown: number } => {
      const s = makeSim(2, { chars: [id, 'valentine'] });
      stepN(s, 1);
      spread(s);
      const starts: number[] = [];
      let maxCooldown = 0;
      for (let i = 0; i < steps(13_000); i++) {
        const ev = s.step(DT, { 0: frame({ call: i % 20 < 10 }) }); // appuie en permanence (fronts montants toutes les 20 pas)
        if (ev.some((e) => e.type === 'callStarted' && e.playerId === 0)) starts.push(i);
        maxCooldown = Math.max(maxCooldown, s.state.players[0].callCooldownMs);
      }
      return { starts, maxCooldown };
    };
    const romain = count('romain');
    const david = count('david');
    expect(romain.maxCooldown).toBe(0);
    expect(david.maxCooldown).toBeGreaterThan(0);
    // Romain : un appel dès que le précédent est fini (≈ 180 pas = 3 s), donc ≥ 4 appels en 13 s ; jamais deux à moins de 3 s
    expect(romain.starts.length).toBeGreaterThanOrEqual(4);
    for (let k = 1; k < romain.starts.length; k++) expect(romain.starts[k] - romain.starts[k - 1]).toBeGreaterThanOrEqual(steps(CALL_DURATION_MS));
    // david : au moins 5 s entre deux appels
    expect(david.starts.length).toBeLessThan(romain.starts.length);
    for (let k = 1; k < david.starts.length; k++) expect(david.starts[k] - david.starts[k - 1]).toBeGreaterThanOrEqual(steps(CALL_COOLDOWN_MS));
  });
});

// ───────────────────────────── Appel AUTOMATIQUE d'objet ─────────────────────────────

describe('appel automatique d\'objet : Romain sans délai de 4 s', () => {
  it('deux objets enchaînés : le 2e appel part tout de suite (le délai de 4 s n\'est jamais armé) ; david doit attendre', () => {
    for (const [id, immediate] of [['romain', true], ['david', false]] as const) {
      const p = mk(0, id);
      const ally = mk(1, 'brokk');
      wound(ally);
      const a = heart(100, 100);
      const b = heart(100, 300); // loin de A (hors rayon de ré-armement)
      p.pos = { x: 100, y: 100 };
      const first = run([p, ally], 1, [a, b]);
      expect(first.map((x) => x.e.icon)).toEqual(['heart']);
      expect(p.autoCall?.ref).toBe(pickupRef(a.id));
      if (immediate) expect(p.autoCallCooldownMs).toBeUndefined();
      else expect(p.autoCallCooldownMs).toBeGreaterThan(0);
      p.pos = { x: 100, y: 300 }; // il passe sur le 2e objet 1 s plus tard
      const second = run([p, ally], steps(1000), [a, b]);
      if (immediate) {
        expect(second).toHaveLength(1);
        // le signal du 1er objet a été affiché AUTO_CALL_MIN_SHOW_MS_CHATTY (lisible) : ce n'est pas un délai de récupération (rien n'est armé), l'objet suivant le remplace aussitôt après
        expect(second[0].step).toBeGreaterThanOrEqual(steps(AUTO_CALL_MIN_SHOW_MS_CHATTY) - 3);
        expect(second[0].step).toBeLessThanOrEqual(steps(AUTO_CALL_MIN_SHOW_MS_CHATTY));
        expect(p.autoCall?.ref).toBe(pickupRef(b.id));
        expect(p.autoCallCooldownMs).toBeUndefined();
      } else {
        expect(second).toHaveLength(0); // signal en cours, puis délai de 4 s
        expect(p.autoCall?.ref).toBe(pickupRef(a.id));
      }
    }
  });

  it('le signal de l\'objet suivant est relancé à 3 s pleines (nouvelle icône), l\'ancien est remplacé', () => {
    const r = mk(0, 'romain');
    const ally = mk(1, 'david');
    wound(ally);
    const a = heart(100, 100);
    const half: PickupState = { id: nextId++, kind: 'half', pos: { x: 100, y: 300 }, ttlMs: PICKUP_TTL_MS };
    r.pos = { x: 100, y: 100 };
    run([r, ally], steps(1500), [a, half]);
    expect(r.autoCall?.icon).toBe('heart');
    expect(r.autoCall?.ms).toBeLessThan(AUTO_CALL_DURATION_MS - 1000);
    r.pos = { x: 100, y: 300 };
    run([r, ally], 1, [a, half]);
    expect(r.autoCall?.icon).toBe('half');
    expect(r.autoCall?.ms).toBeGreaterThan(AUTO_CALL_DURATION_MS - 50);
  });

  it('anti-spam PAR COUPLE conservé : debout sur le même objet, un seul appel (deux objets superposés : 2 appels au total, pas de ping-pong)', () => {
    const r = mk(0, 'romain');
    const ally = mk(1, 'david');
    wound(ally);
    const a = heart(100, 100);
    r.pos = { x: 100, y: 100 };
    expect(run([r, ally], steps(12_000), [a])).toHaveLength(1);
    // deux objets au même endroit : A puis B (remplacement dès que A a été lisible 1 s), puis plus rien tant qu'il reste dessus
    const r2 = mk(0, 'romain');
    const b1 = heart(100, 100);
    const b2 = heart(104, 100);
    r2.pos = { x: 100, y: 100 };
    const ev = run([r2, ally], steps(12_000), [b1, b2]);
    expect(ev).toHaveLength(2);
    expect(ev[0].step).toBe(0);
    expect(ev[1].step).toBeGreaterThanOrEqual(steps(AUTO_CALL_MIN_SHOW_MS_CHATTY) - 3);
    expect(ev[1].step).toBeLessThanOrEqual(steps(AUTO_CALL_MIN_SHOW_MS_CHATTY));
  });

  it('il peut re-déclencher le même objet après être sorti du rayon (+ marge) puis revenu, sans attendre 4 s', () => {
    const r = mk(0, 'romain');
    const ally = mk(1, 'david');
    wound(ally);
    const a = heart(100, 100);
    r.pos = { x: 100, y: 100 };
    expect(run([r, ally], 5, [a])).toHaveLength(1);
    r.pos = { x: 100, y: 160 }; // sorti du rayon + marge
    run([r, ally], 2, [a]);
    r.pos = { x: 100, y: 100 };
    // le 1er signal est encore en cours de lecture (< 1 s) : le nouveau part dès qu'il a été lisible, bien avant les 4 s de délai des autres héros
    expect(run([r, ally], 5, [a])).toHaveLength(0);
    const ev = run([r, ally], steps(AUTO_CALL_MIN_SHOW_MS_CHATTY), [a]);
    expect(ev).toHaveLength(1);
    expect(r.autoCallCooldownMs).toBeUndefined();
  });

  it('l\'appel manuel en cours n\'est jamais interrompu et l\'emporte ; l\'appel d\'objet part après la fin du signal manuel', () => {
    const r = mk(0, 'romain');
    const ally = mk(1, 'david');
    wound(ally);
    const a = heart(100, 100);
    r.pos = { x: 100, y: 100 };
    startCall(r);
    expect(run([r, ally], steps(CALL_DURATION_MS) - 2, [a])).toHaveLength(0);
    expect(r.autoCall).toBeUndefined();
    const ev = run([r, ally], 5, [a]);
    expect(ev).toHaveLength(1);
    // un objet signalé puis un appel manuel : l'icône est effacée par l'appel manuel
    const r2 = mk(0, 'romain');
    r2.pos = { x: 100, y: 100 };
    run([r2, ally], 3, [a]);
    expect(r2.autoCall).toBeDefined();
    startCall(r2);
    expect(r2.autoCall).toBeUndefined();
  });

  it('les champs d\'attente ne sont jamais armés pour Romain sur 30 s de parcours d\'objets', () => {
    const r = mk(0, 'romain');
    const ally = mk(1, 'david');
    wound(ally);
    const hearts = [heart(100, 100), heart(100, 220), heart(100, 340), heart(220, 340)];
    let armed = false;
    run([r, ally], steps(30_000), hearts, (i) => {
      const spot = hearts[Math.floor(i / 120) % hearts.length].pos;
      r.pos = { x: spot.x, y: spot.y };
      if (r.autoCallCooldownMs !== undefined) armed = true;
    });
    expect(armed).toBe(false);
  });
});

// ───────────────────────────── Croix rouge ─────────────────────────────

describe('croix rouge : Romain toutes les 3 s', () => {
  /** Romain à 20 % de PV et un soigneur (Valentine). */
  function duo(character: CharacterId = 'romain'): { r: PlayerState; v: PlayerState } {
    const r = mk(0, character);
    const v = mk(1, 'valentine');
    hpAt(r, 0.2);
    return { r, v };
  }

  it('répétition toutes les 3 s tant qu\'il reste à 30 % ou moins (david : toutes les 10 s) ; seule la 1re croix est « pleine »', () => {
    const { r, v } = duo();
    const ev = run([r, v], steps(21_000));
    const times = ev.map((x) => x.step);
    expect(times.length).toBe(7); // 0, 3, 6, … 18 s (la suivante, à 21 s, tombe après les 1260 pas joués)
    for (let k = 1; k < times.length; k++) expect(times[k] - times[k - 1], `écart ${k}`).toBe(steps(3000));
    expect(ev.every((x) => x.e.icon === 'cross' && x.e.playerId === 0 && x.e.to.length === 1 && x.e.to[0] === 1)).toBe(true);
    expect(ev[0].e.repeat).toBeUndefined();
    expect(ev.slice(1).every((x) => x.e.repeat === true)).toBe(true);
    const d = duo('david');
    const evD = run([d.r, d.v], steps(31_000));
    expect(evD.map((x) => x.step)).toEqual([0, steps(10_000), steps(20_000), steps(30_000)]);
    expect(evD.some((x) => 'repeat' in x.e)).toBe(false); // événements des autres héros : aucun champ ajouté
  });

  it('quasi continue : le signal de croix est affiché à CHAQUE pas (aucun trou ni clignotement parasite entre deux répétitions)', () => {
    const { r, v } = duo();
    let holes = 0;
    let signals = 0;
    run([r, v], steps(30_000), [], () => undefined);
    // on rejoue en mesurant l'état après chaque pas complet (minuteurs puis détection)
    const { r: r2, v: v2 } = duo();
    for (let i = 0; i < steps(30_000); i++) {
      tick([r2, v2]);
      if (r2.autoCall?.icon === 'cross' && r2.autoCall.ms > 0) signals++;
      else holes++;
    }
    expect(holes).toBe(0);
    expect(signals).toBe(steps(30_000));
    expect(r.autoCall?.icon).toBe('cross');
  });

  it('jamais plus d\'un événement par répétition (pas de re-déclenchement plus rapide : donc pas de son plus rapide)', () => {
    const { r, v } = duo();
    const ev = run([r, v], steps(60_000));
    expect(ev.length).toBe(60_000 / 3000); // une par période de 3 s (0, 3, … 57 s) : jamais plus
    const sounds = ev.map((x) => sfxForEvent(x.e));
    expect(sounds[0]).toBe('autoCallCross');
    expect(sounds.slice(1).every((s) => s === 'autoCallCrossRepeat')).toBe(true);
  });

  it('seuil (30 %), réarmement (60 %), destinataires et priorités inchangés', () => {
    // 31 % : rien ; 30 % : croix
    const { r, v } = duo();
    hpAt(r, 0.31);
    expect(run([r, v], 5)).toHaveLength(0);
    hpAt(r, 0.3);
    expect(run([r, v], 2)).toHaveLength(1);
    // destinataires : seulement ceux qui peuvent soigner (Valentine ; pas un allié sans cœur rangé)
    const p = mk(0, 'romain');
    const v2 = mk(1, 'valentine');
    const m = mk(2, 'mira');
    hpAt(p, 0.1);
    const ev = run([p, v2, m], 2);
    expect(ev[0].e.to).toEqual([1]);
    // aucun soigneur : aucune croix
    const solo = mk(0, 'romain');
    const m2 = mk(1, 'mira');
    hpAt(solo, 0.1);
    expect(run([solo, m2], steps(5000))).toHaveLength(0);
    // solo : aucune croix
    const alone = mk(0, 'romain');
    hpAt(alone, 0.1);
    expect(run([alone], steps(5000))).toHaveLength(0);
  });

  it('rebond de PV entre 30 % et 60 % : pas de croix mais le délai de 3 s CONTINUE de courir ; la croix repart à l\'échéance si Romain est de nouveau bas', () => {
    const { r, v } = duo();
    expect(run([r, v], 1)).toHaveLength(1);
    hpAt(r, 0.4); // petit soin à t≈0
    expect(run([r, v], steps(1000))).toHaveLength(0);
    expect(r.autoCall).toBeUndefined(); // soigné au-dessus du seuil : le signal s'arrête
    hpAt(r, 0.25); // retombe à t≈1 s : pas de croix avant l'échéance (3 s)
    const ev = run([r, v], steps(2000) + 4);
    expect(ev).toHaveLength(1);
    expect(ev[0].step).toBeGreaterThanOrEqual(steps(2000) - 3);
    expect(ev[0].step).toBeLessThanOrEqual(steps(2000) + 3);
    expect(ev[0].e.repeat).toBe(true);
  });

  it('remonté à 60 % : croix réarmée (champ supprimé), la suivante part tout de suite et avec le son complet', () => {
    const { r, v } = duo();
    run([r, v], 5);
    hpAt(r, 0.7);
    run([r, v], 2);
    expect(r.autoCallCross).toBeUndefined();
    hpAt(r, 0.2);
    const ev = run([r, v], 2);
    expect(ev).toHaveLength(1);
    expect(ev[0].e.repeat).toBeUndefined();
    expect(sfxForEvent(ev[0].e)).toBe('autoCallCross');
  });

  it('à terre : pas de croix, suivi remis à zéro ; relevé (PV pleins) puis de nouveau bas : la croix repart', () => {
    const { r, v } = duo();
    run([r, v], 5);
    markPlayerDown(r);
    expect(r.autoCall).toBeUndefined();
    expect(r.autoCallCross).toBeUndefined();
    expect(run([r, v], steps(5000))).toHaveLength(0);
    r.status = 'alive';
    r.hp = r.maxHp;
    run([r, v], 3);
    hpAt(r, 0.2);
    expect(run([r, v], 2)).toHaveLength(1);
  });

  it('entrée d\'une salle : tout est remis à zéro ; la croix repart si Romain est encore bas', () => {
    const { r, v } = duo();
    run([r, v], 5);
    resetPlayersForRoom([r, v], [{ x: 50, y: 50 }]);
    expect(r.autoCallCross).toBeUndefined();
    expect(r.hp).toBe(r.maxHp); // PV pleins à l'entrée : plus de demande
    hpAt(r, 0.2);
    expect(run([r, v], 2)).toHaveLength(1);
  });

  it('priorités : la croix remplace un appel d\'objet en cours ; un appel MANUEL en cours l\'emporte, puis la croix revient immédiatement', () => {
    const { r, v } = duo();
    r.hp = r.maxHp; // PV pleins : il ne peut pas consommer le cœur au sol, donc l'appel d'objet part
    wound(v);
    const a = heart(100, 100);
    r.pos = { x: 100, y: 100 };
    run([r, v], 3, [a]);
    expect(r.autoCall?.icon).toBe('heart');
    hpAt(r, 0.2);
    run([r, v], 2, [a]);
    expect(r.autoCall?.icon).toBe('cross'); // plus urgente
    // appel manuel : il efface l'icône de croix, la croix ne repart pas pendant le signal, puis revient aussitôt
    startCall(r);
    expect(r.autoCall).toBeUndefined();
    let during = 0;
    for (let i = 0; i < steps(CALL_DURATION_MS) - 2; i++) {
      tick([r, v], [a]);
      if (r.autoCall) during++;
    }
    expect(during).toBe(0);
    let backAt = -1;
    for (let i = 0; i < 10 && backAt < 0; i++) {
      tick([r, v], [a]);
      if (r.autoCall?.icon === 'cross') backAt = i;
    }
    expect(backAt).toBeGreaterThanOrEqual(0);
  });

  it('un signal de croix en cours n\'est jamais remplacé par un appel d\'objet, même sans attente', () => {
    const { r, v } = duo();
    const a = heart(100, 100);
    r.pos = { x: 100, y: 100 };
    wound(v);
    run([r, v], steps(10_000), [a]);
    expect(r.autoCall?.icon).toBe('cross');
  });

  it('normalisation : une répétition à 3 s (suivi ≤ 3 s) est valide ; le suivi n\'est jamais ajouté', () => {
    const { r } = duo();
    r.autoCallCross = { ms: 3000 };
    normalizeAutoCallFields(r);
    expect(r.autoCallCross).toEqual({ ms: 3000 });
    const d = mk(0, 'david');
    normalizeAutoCallFields(d);
    expect(d.autoCallCross).toBeUndefined();
  });
});

// ───────────────────────────── Sons ─────────────────────────────

describe('sons : la croix répétée de Romain reste douce', () => {
  it('répétition : son distinct, plus court et plus bas que la croix complète ; les autres cas (autres héros, 1re croix, objets) inchangés', () => {
    const rep: SimEvent = { type: 'autoCallStarted', playerId: 0, icon: 'cross', to: [1], repeat: true };
    expect(sfxForEvent(rep)).toBe('autoCallCrossRepeat');
    expect(sfxForEvent({ type: 'autoCallStarted', playerId: 0, icon: 'cross', to: [1] })).toBe('autoCallCross');
    expect(sfxForEvent({ type: 'autoCallStarted', playerId: 0, icon: 'heart', to: [1] })).toBe('autoCall');
    expect(sfxVolume('autoCallCrossRepeat')).toBeLessThan(sfxVolume('autoCallCross'));
    expect(sfxVolume('autoCallCrossRepeat')).toBeLessThanOrEqual(0.03);
    expect(sfxVolume('autoCallCrossRepeat')).toBeLessThan(0.035); // moins fort que le tic d'un objet (autoCall)
    expect(sfxVolume('autoCallCrossRepeat')).toBeLessThan(sfxVolume('call'));
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

function makeSim(n: number, opts: { autoCall?: boolean; heartSlot?: boolean; chars?: readonly CharacterId[]; seed?: number } = {}): GameSimulation {
  const chars = opts.chars ?? (['romain', 'valentine', 'mira', 'brokk'] as const);
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

describe('simulation à 2 joueurs (Romain + un autre héros)', () => {
  it('croix de Romain : un événement toutes les 3 s tant qu\'il reste bas, signal sans trou, vers Valentine seule', () => {
    const s = makeSim(2);
    stepN(s, 1);
    spread(s);
    const [r] = s.state.players;
    hpAt(r, 0.2);
    r.invulnMs = 1e9; // aucun dégât parasite : seul l'appel est observé
    const startSteps: number[] = [];
    let holes = 0;
    for (let i = 0; i < steps(16_000); i++) {
      const ev = s.step(DT, {});
      for (const e of crossEvents(ev)) {
        startSteps.push(i);
        expect(e.to).toEqual([1]);
      }
      if (r.autoCall?.icon !== 'cross') holes++;
    }
    expect(holes).toBe(0);
    expect(startSteps.length).toBe(6); // 0, 3, 6, 9, 12, 15 s
    for (let k = 1; k < startSteps.length; k++) expect(startSteps[k] - startSteps[k - 1]).toBe(steps(3000));
  });

  it('l\'autre héros (Valentine blessée, Romain avec un cœur) n\'est pas modifié : croix toutes les 10 s', () => {
    const s = makeSim(2, { chars: ['valentine', 'romain'] });
    stepN(s, 1);
    spread(s);
    const [v] = s.state.players;
    hpAt(v, 0.2);
    s.state.players[1].heart = 'full';
    v.invulnMs = 1e9;
    const startSteps: number[] = [];
    for (let i = 0; i < steps(25_000); i++) if (crossEvents(s.step(DT, {})).length > 0) startSteps.push(i);
    expect(startSteps).toEqual([0, steps(10_000), steps(20_000)]);
  });

  it('Romain et son allié appellent à la main : seul Romain n\'attend pas (callCooldownMs de Romain toujours 0)', () => {
    const s = makeSim(2);
    stepN(s, 1);
    spread(s);
    const [r, v] = s.state.players;
    const starts: Record<number, number> = { 0: 0, 1: 0 };
    for (let i = 0; i < steps(12_000); i++) {
      const ev = s.step(DT, { 0: frame({ call: i % 20 < 10 }), 1: frame({ call: i % 20 < 10 }) });
      for (const e of ev) if (e.type === 'callStarted') starts[e.playerId]++;
      expect(r.callCooldownMs).toBe(0);
    }
    expect(starts[0]).toBeGreaterThanOrEqual(4);
    expect(starts[1]).toBeLessThanOrEqual(3); // 0, 5 s, 10 s
    expect(v.callCooldownMs).toBeGreaterThanOrEqual(0);
  });

  it('3-4 joueurs : Romain à n\'importe quel emplacement garde son trait, les autres non', () => {
    const chars: CharacterId[] = ['david', 'mira', 'valentine', 'romain'];
    const s = makeSim(4, { chars });
    stepN(s, 1);
    spread(s);
    expect(s.state.players.map((p) => callCooldownFor(p))).toEqual([5000, 5000, 5000, 0]);
    const r = s.state.players[3];
    hpAt(r, 0.2);
    r.invulnMs = 1e9;
    const starts: number[] = [];
    for (let i = 0; i < steps(7000); i++) if (crossEvents(s.step(DT, {})).some((e) => e.playerId === 3)) starts.push(i);
    expect(starts).toEqual([0, steps(3000), steps(6000)]);
  });
});

// ───────────────────────────── Non-régression ─────────────────────────────

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
    0: frame({ moveX: Math.cos(a), moveY: Math.sin(a), attack: i % 20 < 10, call: i % 400 < 6 }),
    1: frame({ moveX: Math.sin(b), moveY: Math.cos(b), attack: i % 30 < 12 }),
  };
}

function populated(chars: readonly CharacterId[], autoCall: boolean, seed: number): GameSimulation {
  const s = makeSim(2, { autoCall, seed, chars });
  stepN(s, 1);
  for (let k = 0; k < 6; k++) s.state.room.enemies.push(createEnemyState('skeleton', { x: 200 + k * 30, y: 150 + (k % 3) * 40 }, s.state.nextEntityId++, 0));
  s.state.players[0].hp = s.state.players[0].maxHp * 0.25;
  return s;
}

describe('non-régression : le trait n\'a aucun effet sur le jeu (flux aléatoires, états hors appel)', () => {
  for (const seed of [1, 7, 4242]) {
    it(`graine ${seed} : avec Romain, états et événements identiques hors champs d'appel automatique, flux aléatoires inchangés`, () => {
      const on = populated(['romain', 'valentine'], true, seed);
      const off = populated(['romain', 'valentine'], false, seed);
      let started = 0;
      for (let i = 0; i < 1500; i++) {
        const a = on.step(DT, scripted(i));
        const b = off.step(DT, scripted(i));
        started += autoEvents(a).length;
        expect(a.filter((e) => e.type !== 'autoCallStarted')).toEqual(b);
        if (i % 100 === 0) expect(stripAuto(on.serialize())).toEqual(stripAuto(off.serialize()));
      }
      expect(stripAuto(on.serialize())).toEqual(stripAuto(off.serialize()));
      expect(started).toBeGreaterThan(5);
      const a = on.state;
      const b = off.state;
      expect([a.rngState, a.lootRngState, a.gearRngState]).toEqual([b.rngState, b.lootRngState, b.gearRngState]);
    });
  }

  it('déterminisme : deux simulations identiques avec Romain donnent le même état sérialisé', () => {
    const a = populated(['romain', 'valentine'], true, 99);
    const b = populated(['romain', 'valentine'], true, 99);
    for (let i = 0; i < 800; i++) {
      a.step(DT, scripted(i));
      b.step(DT, scripted(i));
    }
    expect(a.serialize()).toBe(b.serialize());
  });

  it('l\'état sérialisé d\'une équipe SANS Romain ne contient aucun champ nouveau (pas de `repeat`, pas de trait dans l\'état)', () => {
    const s = populated(['david', 'valentine'], true, 5);
    const events: SimEvent[] = [];
    for (let i = 0; i < 1500; i++) events.push(...s.step(DT, scripted(i)));
    expect(autoEvents(events).length).toBeGreaterThan(0);
    expect(events.some((e) => e.type === 'autoCallStarted' && 'repeat' in e)).toBe(false);
    expect(s.serialize()).not.toContain('callTraits');
    expect(s.serialize()).not.toContain('"repeat"');
  });

  /**
   * Empreintes de référence (cyrb53 de la sérialisation complète après 2400 pas) de parties SANS Romain, calculées avec le code d'AVANT le trait : preuve que les autres héros
   * sont identiques octet pour octet (états ET événements, appels manuels et automatiques compris). Un changement volontaire de règle du jeu les invalide : les recalculer alors.
   */
  const GOLDEN: Record<string, string> = {
    '1': 'c0c7aa2a6a7728a1',
    '7': '89a1e9c1c4920749',
    '4242': 'e3451a7e12420235',
  };

  /** Compteurs du scénario d'empreinte (preuve qu'il exerce bien les appels manuels, automatiques et la croix). */
  const seen = { manual: 0, auto: 0, cross: 0 };

  function digest(seed: number): string {
    seen.manual = seen.auto = seen.cross = 0;
    const chars: CharacterId[] = ['david', 'valentine', 'mira', 'brokk'];
    const s = makeSim(4, { seed, chars });
    stepN(s, 1);
    for (let k = 0; k < 8; k++) s.state.room.enemies.push(createEnemyState('skeleton', { x: 200 + k * 30, y: 150 + (k % 3) * 40 }, s.state.nextEntityId++, 0));
    s.state.players[0].hp = s.state.players[0].maxHp * 0.25; // croix vers Valentine
    s.state.players[2].heart = 'full';
    s.state.players[1].hp = 12;
    const h = new Digest();
    const script = (i: number): TickInputs => {
      const out: Record<number, ActionFrame> = {};
      for (let k = 0; k < 4; k++) {
        const a = (i / (35 + 9 * k) + k) % (2 * Math.PI);
        out[k] = frame({ moveX: Math.cos(a), moveY: Math.sin(a), attack: (i + 7 * k) % 22 < 9, call: (i + 90 * k) % 330 < 5, heart: (i + 13 * k) % 500 < 3 });
      }
      return out;
    };
    for (let i = 0; i < 2400; i++) {
      const ev = s.step(DT, script(i));
      if (ev.length > 0) h.update(JSON.stringify(ev));
      seen.manual += ev.filter((e) => e.type === 'callStarted').length;
      seen.auto += autoEvents(ev).length;
      seen.cross += crossEvents(ev).length;
      if (i % 200 === 0) h.update(s.serialize());
    }
    h.update(s.serialize());
    return h.hex();
  }

  for (const seed of [1, 7, 4242]) {
    it(`graine ${seed} : partie à 4 héros sans Romain identique à celle d'avant le trait (empreinte)`, () => {
      const d = digest(seed);
      if (process.env.PRINT_GOLDEN) console.info(`GOLDEN ${seed} ${d}`);
      expect(seen.manual).toBeGreaterThan(3); // le scénario exerce bien l'appel manuel…
      expect(seen.cross).toBeGreaterThan(0); // …la croix rouge…
      expect(seen.auto).toBeGreaterThan(seen.cross - 1); // …et les appels automatiques
      expect(d).toBe(GOLDEN[String(seed)]);
    });
  }
});

// ───────────────────────────── Revue adversariale : corrections ─────────────────────────────

/** Scénario PUR d'empreinte des appels d'OBJETS et de la croix (sans simulation) : 4 héros SANS Romain marchent sur des cœurs et des objets d'équipement refusés / utiles ; empreinte des événements et des champs d'appel à chaque pas. */
function itemDigest(seed: number, heartSlot: boolean): { hex: string; items: number; cross: number } {
  const chars: CharacterId[] = ['david', 'brokk', 'mira', 'valentine'];
  const players = chars.map((c, i) => createPlayerState({ id: i as PlayerId, characterId: c, difficulty: 2 }, { x: 100, y: 100 }));
  let rnd = seed >>> 0;
  const next = (): number => {
    rnd = (Math.imul(rnd, 1664525) + 1013904223) >>> 0;
    return rnd / 4294967296;
  };
  // équipement : niveaux élevés (les objets de niveau 1-2 sont refusés), l'une des trois dernières places libre (objet utile pour elle)
  players.forEach((p, i) => {
    p.loadout.weapon = 3;
    p.loadout.boots = 2;
    p.loadout.protection = i === 2 ? 0 : 3;
    p.loadout.artifact = i === 3 ? 0 : 2;
    if (i === 0) p.loadout.accessory = { kind: 'lantern', level: 2 };
    if (heartSlot && i !== 1) p.heart = 'full';
  });
  const pickups: PickupState[] = [];
  for (let k = 0; k < 5; k++) pickups.push({ id: k + 1, kind: k % 2 === 0 ? 'full' : 'half', pos: { x: 60 + k * 14, y: 100 + (k % 2) * 10 }, ttlMs: PICKUP_TTL_MS });
  const slots = ['weapon', 'boots', 'protection', 'artifact', 'accessory'] as const;
  const gearDrops: GearDropState[] = [];
  for (let k = 0; k < 6; k++) {
    const slot = slots[k % slots.length];
    const item: GearItem = slot === 'accessory' ? { slot, level: ((k % 3) + 1) as 1 | 2 | 3, accessory: k % 2 === 0 ? 'lantern' : 'magnet' } : { slot, level: ((k % 3) + 1) as 1 | 2 | 3 };
    gearDrops.push({ id: 100 + k, item, pos: { x: 70 + k * 12, y: 95 + (k % 3) * 9 }, ttlMs: 20_000, lockedFor: k === 5 ? 1 : null, lockMode: k === 5 ? 'leave' : 'life' });
  }
  const h = new Digest();
  const target = players.map(() => ({ x: 100, y: 100 }));
  let items = 0;
  let cross = 0;
  for (let i = 0; i < 3000; i++) {
    players.forEach((p, k) => {
      if (i % 40 === (k * 9) % 40) target[k] = { x: 55 + next() * 90, y: 90 + next() * 30 };
      const dx = target[k].x - p.pos.x;
      const dy = target[k].y - p.pos.y;
      const d = Math.hypot(dx, dy) || 1;
      p.pos = { x: p.pos.x + (dx / d) * Math.min(d, 2), y: p.pos.y + (dy / d) * Math.min(d, 2) };
      if (i % 300 === 150 + k * 20) p.hp = Math.max(1, p.maxHp * next());
      if (i % 450 === 10 + k * 30) p.hp = p.maxHp;
    });
    for (const p of players) stepPlayerTimers(p, DT);
    const ev = stepAutoCalls(players, pickups, gearDrops, [], { heartSlot });
    for (const e of ev) {
      if (e.type !== 'autoCallStarted') continue;
      if (e.icon === 'cross') cross++;
      else items++;
    }
    if (ev.length > 0) h.update(JSON.stringify(ev));
    h.update(JSON.stringify(players.map((p) => [p.autoCall, p.autoCallCooldownMs, p.autoCallSeen, p.autoCallCross])));
  }
  return { hex: h.hex(), items, cross };
}

describe('non-régression (appels d\'OBJETS) : les 4 autres héros marchent sur des cœurs et de l\'équipement refusés, identiques à avant le trait', () => {
  /** Empreintes calculées avec le code d'AVANT le trait (HEAD) : identiques octet pour octet (événements et champs d'appel à chaque pas). */
  const GOLDEN_ITEMS: Record<string, string> = {
    '1:false': '7bc971aacdee1571',
    '1:true': 'df012d08c81f649f',
    '7:false': 'ce41435a3407db04',
    '7:true': '43b2e70744025f42',
    '4242:false': '0f9cfb685aa2162f',
    '4242:true': '9bc7435f6acc969f',
  };
  for (const seed of [1, 7, 4242]) {
    for (const slot of [false, true]) {
      it(`graine ${seed}, emplacement cœur ${slot ? 'oui' : 'non'} : empreinte inchangée, et le scénario exerce bien des appels d'objets (pas seulement des croix)`, () => {
        const r = itemDigest(seed, slot);
        if (process.env.PRINT_GOLDEN) console.info(`GOLDEN_ITEMS ${seed}:${slot} ${r.hex}`);
        expect(r.items).toBeGreaterThan(20); // cœurs ET équipement refusés : sinon une régression des délais passerait inaperçue
        expect(r.cross).toBeGreaterThan(0);
        expect(r.hex).toBe(GOLDEN_ITEMS[`${seed}:${slot}`]);
      });
    }
  }
});

describe('Romain : durée d\'affichage minimale d\'un signal d\'objet (lisibilité), sans délai de récupération', () => {
  it('le 1er objet reste AFFICHÉ au moins 1 s avant d\'être remplacé (jamais un seul pas), puis il n\'est pas re-signalé (anti-spam par couple)', () => {
    const r = mk(0, 'romain');
    const ally = mk(1, 'david');
    wound(ally);
    const a = heart(100, 100);
    const b: PickupState = { id: nextId++, kind: 'half', pos: { x: 104, y: 100 }, ttlMs: PICKUP_TTL_MS };
    r.pos = { x: 100, y: 100 };
    const icons: string[] = [];
    let shown = 0;
    for (let i = 0; i < steps(8000); i++) {
      for (const e of autoEvents(tick([r, ally], [a, b]))) icons.push(e.icon);
      if (r.autoCall?.icon === 'heart') shown++;
    }
    expect(icons).toEqual(['heart', 'half']);
    expect(shown).toBeGreaterThanOrEqual(steps(AUTO_CALL_MIN_SHOW_MS_CHATTY) - 2);
    expect(r.autoCallCooldownMs).toBeUndefined();
  });

  it('chaque objet d\'une rangée est signalé tour à tour, à 1 s d\'intervalle, sans le délai de 4 s (david : 4 s)', () => {
    const times: Record<string, number[]> = { romain: [], david: [] };
    for (const id of ['romain', 'david'] as const) {
      const p = mk(0, id);
      const ally = mk(1, 'brokk');
      wound(ally);
      const row = [heart(100, 100), heart(103, 100), heart(106, 100), heart(109, 100)];
      p.pos = { x: 104, y: 100 };
      for (let i = 0; i < steps(20_000); i++) for (const _e of autoEvents(tick([p, ally], row))) times[id].push(i);
    }
    const gaps = (xs: number[]): number[] => xs.slice(1).map((x, k) => x - xs[k]);
    expect(times.romain).toHaveLength(4);
    for (const g of gaps(times.romain)) {
      expect(g).toBeGreaterThanOrEqual(steps(AUTO_CALL_MIN_SHOW_MS_CHATTY) - 3);
      expect(g).toBeLessThanOrEqual(steps(AUTO_CALL_MIN_SHOW_MS_CHATTY) + 1);
    }
    for (const g of gaps(times.david)) expect(g).toBeGreaterThanOrEqual(steps(AUTO_CALL_COOLDOWN_MS) - 1);
  });

  it('l\'appel APRÈS ÉCHANGE d\'accessoire (verrou \'leave\') part à l\'instant du geste : il remplace un signal d\'objet tout juste lancé, sans attendre la durée d\'affichage', () => {
    const r = mk(0, 'romain');
    const ally = mk(1, 'david');
    wound(ally);
    const a = heart(100, 100);
    r.pos = { x: 100, y: 100 };
    expect(autoEvents(tick([r, ally], [a]))).toHaveLength(1); // un cœur signalé à l'instant
    const left: GearDropState = { id: 900, item: { slot: 'artifact', level: 1 }, pos: { x: 100, y: 102 }, ttlMs: 20_000, lockedFor: 0, lockMode: 'leave' };
    ally.loadout.artifact = 0; // l'objet laissé lui serait utile
    for (const p of [r, ally]) stepPlayerTimers(p, DT);
    const ev = autoEvents(stepAutoCalls([r, ally], [a], [left], [], {}));
    expect(ev.map((e) => e.icon)).toEqual(['gear']);
    expect(r.autoCall?.icon).toBe('gear');
  });
});

describe('croix de Romain : son complet pour une NOUVELLE alerte, son doux pour une vraie répétition', () => {
  /** Événements de croix de `n` pas (avec leur numéro de pas). */
  function crossRun(players: PlayerState[], n: number): { step: number; e: AutoEvent }[] {
    const out: { step: number; e: AutoEvent }[] = [];
    for (let i = 0; i < n; i++) for (const e of crossEvents(tick(players))) out.push({ step: i, e });
    return out;
  }

  it('PV remontés entre 30 et 60 % pendant 30 s puis retombés à 20 % : la croix repart avec le son COMPLET (pas de `repeat`)', () => {
    const r = mk(0, 'romain');
    const v = mk(1, 'valentine');
    hpAt(r, 0.2);
    const first = crossRun([r, v], 1);
    expect(first[0].e.repeat).toBeUndefined();
    const second = crossRun([r, v], steps(3000)); // vraie répétition à 3 s : son doux
    expect(second.map((x) => x.e.repeat)).toEqual([true]);
    hpAt(r, 0.45); // bande 30-60 % : suivi conservé
    expect(crossRun([r, v], steps(30_000))).toHaveLength(0);
    expect(r.autoCallCross).toBeDefined();
    hpAt(r, 0.2);
    const again = crossRun([r, v], 3);
    expect(again).toHaveLength(1);
    expect(again[0].e.repeat).toBeUndefined();
  });

  it('plus de soigneur pendant 60 s puis un soigneur arrive : la croix repart avec le son complet ; la répétition suivante (3 s) est douce', () => {
    const r = mk(0, 'romain');
    const v = mk(1, 'valentine');
    hpAt(r, 0.2);
    expect(crossRun([r, v], 1)).toHaveLength(1);
    v.status = 'down'; // personne ne peut soigner
    expect(crossRun([r, v], steps(60_000))).toHaveLength(0);
    v.status = 'alive';
    const back = crossRun([r, v], 3);
    expect(back).toHaveLength(1);
    expect(back[0].e.repeat).toBeUndefined();
    const next = crossRun([r, v], steps(3000));
    expect(next.map((x) => x.e.repeat)).toEqual([true]);
  });

  it('les autres héros n\'ont jamais le champ `idleMs` ni `repeat`', () => {
    const d = mk(0, 'david');
    const v = mk(1, 'valentine');
    hpAt(d, 0.2);
    const ev = crossRun([d, v], steps(30_000));
    expect(ev.length).toBeGreaterThan(1);
    expect(ev.every((x) => !('repeat' in x.e))).toBe(true);
    expect(JSON.stringify(d.autoCallCross)).not.toContain('idleMs');
    hpAt(d, 0.45);
    for (let i = 0; i < steps(30_000); i++) tick([d, v]);
    expect(JSON.stringify(d.autoCallCross)).not.toContain('idleMs');
  });

  it('normalisation : `idleMs` n\'est gardé que pour un héros à répétition douce et dans sa plage ; un champ mal formé est supprimé, jamais ajouté', () => {
    const r = mk(0, 'romain');
    r.autoCallCross = { ms: 0, idleMs: 100 };
    normalizeAutoCallFields(r);
    expect(r.autoCallCross).toEqual({ ms: 0, idleMs: 100 });
    for (const bad of [-1, Number.NaN, 'zz', 1e9, null]) {
      r.autoCallCross = { ms: 0, idleMs: bad as unknown as number };
      normalizeAutoCallFields(r);
      expect(r.autoCallCross).toEqual({ ms: 0 });
    }
    const d = mk(0, 'david');
    d.autoCallCross = { ms: 0, idleMs: 100 };
    normalizeAutoCallFields(d);
    expect(d.autoCallCross).toEqual({ ms: 0 });
  });
});

describe('trait data-driven : la restauration borne les champs d\'appel par la valeur du TRAIT du héros (pas par les constantes par défaut)', () => {
  it('un héros dont le trait dépasse les défauts (délai d\'objet 6 s, croix 20 s) conserve ses minuteurs à la restauration ; un héros sans trait reste borné à 4 s / 10 s', () => {
    const def = CHARACTERS.valentine;
    const saved = def.callTraits;
    try {
      def.callTraits = { autoCooldownMs: 6000, crossRepeatMs: 20_000 };
      resetCallTraitsCache();
      const v = mk(1, 'valentine');
      v.autoCallCooldownMs = 5500;
      v.autoCallCross = { ms: 15_000 };
      normalizeAutoCallFields(v);
      expect(v.autoCallCooldownMs).toBe(5500);
      expect(v.autoCallCross).toEqual({ ms: 15_000 });
      v.autoCallCooldownMs = 6500;
      v.autoCallCross = { ms: 25_000 };
      normalizeAutoCallFields(v);
      expect(v.autoCallCooldownMs).toBeUndefined();
      expect(v.autoCallCross).toBeUndefined();
    } finally {
      if (saved) def.callTraits = saved;
      else delete def.callTraits;
      resetCallTraitsCache();
    }
    const d = mk(0, 'david');
    d.autoCallCooldownMs = 5500;
    d.autoCallCross = { ms: 15_000 };
    normalizeAutoCallFields(d);
    expect(d.autoCallCooldownMs).toBeUndefined();
    expect(d.autoCallCross).toBeUndefined();
  });

  it('cache des traits : un identifiant inconnu n\'est jamais mémorisé (défaut) ; `resetCallTraitsCache` rend la valeur à jour après une modification de CHARACTERS', () => {
    expect(callTraitsOfCharacter('__proto__' as CharacterId)).toBe(DEFAULT_CALL_TRAITS);
    expect(callTraitsOfCharacter('constructor' as CharacterId)).toBe(DEFAULT_CALL_TRAITS);
    expect(callTraitsOfCharacter('inconnu' as CharacterId)).toBe(DEFAULT_CALL_TRAITS);
    const def = CHARACTERS.david;
    try {
      expect(callCooldownFor(mk(0, 'david'))).toBe(5000);
      def.callTraits = { manualCooldownMs: 1234 };
      expect(callCooldownFor(mk(0, 'david'))).toBe(5000); // périmé tant que le cache n'est pas vidé
      resetCallTraitsCache();
      expect(callCooldownFor(mk(0, 'david'))).toBe(1234);
    } finally {
      delete def.callTraits;
      resetCallTraitsCache();
    }
    expect(callCooldownFor(mk(0, 'david'))).toBe(5000);
  });
});

describe('cor de guerre : effet sur les alliés d\'un Romain qui enchaîne les appels (choix documenté, README et TODO)', () => {
  /** Part (0..1) des pas où l'allié a le bonus 'horn', l'appelant appuyant sur appel à chaque pas pendant 30 s, cor de niveau III. */
  function hornUptime(caller: CharacterId): { uptime: number; calls: number } {
    const s = makeSim(2, { chars: [caller, 'valentine'] });
    stepN(s, 1);
    spread(s);
    expect(s.equipScripted(0, { slot: 'accessory', level: 3, accessory: 'warhorn' })).toBe(true);
    s.state.players[0].invulnMs = 1e9;
    let on = 0;
    let calls = 0;
    const n = steps(30_000);
    for (let i = 0; i < n; i++) {
      for (const e of s.step(DT, { 0: frame({ call: i % 2 === 0 }) })) if (e.type === 'callStarted') calls++; // appui répété (front montant tous les 2 pas)
      if (s.state.players[1].loadout.buffs.some((b) => b.kind === 'horn')) on++;
    }
    return { uptime: on / n, calls };
  }

  it('Romain (aucune attente) entretient le bonus de vitesse de ses alliés en continu (≈ 100 %) ; les autres héros plafonnent à 3 s sur 5 s (60 %) : le prix est l\'immobilité de Romain, 1 s sur 3', () => {
    const rom = hornUptime('romain');
    const dav = hornUptime('david');
    expect(rom.uptime).toBeGreaterThan(0.95);
    expect(dav.uptime).toBeLessThan(0.65);
    expect(rom.calls).toBeGreaterThanOrEqual(9); // un appel toutes les 3 s
    expect(dav.calls).toBeLessThanOrEqual(6); // un appel toutes les 5 s
  });
});

describe('Romain : conséquences documentées de l\'appel manuel sans attente sur ses appels automatiques', () => {
  it('s\'il enchaîne les appels manuels, sa croix rouge n\'est presque jamais affichée (le manuel l\'emporte et efface le signal automatique : au plus UN pas par répétition) ; dès qu\'il s\'arrête, elle repart', () => {
    const r = mk(0, 'romain');
    const v = mk(1, 'valentine');
    hpAt(r, 0.2);
    let crosses = 0;
    let visible = 0;
    for (let i = 0; i < steps(12_000); i++) {
      if (canStartCall(r)) startCall(r); // il rappelle dès que possible
      crosses += crossEvents(tick([r, v])).length;
      if (r.autoCall?.icon === 'cross') visible++;
    }
    expect(visible).toBeLessThanOrEqual(crosses); // la croix part à l'instant où le signal manuel finit, puis le rappel suivant l'efface : un pas affiché par répétition
    expect(visible).toBeLessThan(steps(12_000) / 20);
    r.callMs = 0;
    let after = 0;
    for (let i = 0; i < steps(3100); i++) after += crossEvents(tick([r, v])).length; // au plus une période de répétition (3 s) plus tard
    expect(after).toBeGreaterThan(0);
  });

  it('la croix quasi continue prive ses appels d\'objet : bas et debout sur un cœur à signaler, seule la croix est émise (david : la croix puis le cœur à 3 s)', () => {
    const out: Record<string, string[]> = {};
    for (const id of ['romain', 'david'] as const) {
      const p = mk(0, id);
      const ally = mk(1, 'valentine');
      hpAt(p, 0.2);
      p.heart = 'full';
      const a = heart(100, 100);
      p.pos = { x: 100, y: 100 };
      const icons: string[] = [];
      for (let i = 0; i < steps(20_000); i++) for (const e of autoEvents(tick([p, ally], [a], true))) icons.push(e.icon);
      out[id] = icons;
    }
    expect(out.romain.every((i) => i === 'cross')).toBe(true);
    expect(out.david.slice(0, 2)).toEqual(['cross', 'heart']);
  });
});

// ───────────────────────────── i18n ─────────────────────────────

const I18N_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'i18n');
const readJson = (f: string): Record<string, string> => JSON.parse(fs.readFileSync(path.join(I18N_DIR, f), 'utf8')) as Record<string, string>;

describe('i18n : la description de Romain annonce son trait (fr / en)', () => {
  it('évoque qu\'il parle beaucoup (les valeurs chiffrées sont dans le README et le tutoriel) ; tient dans l\'espace de la description (≤ longueur des plus longues)', () => {
    const fr = readJson('fr.json');
    const en = readJson('en.json');
    const f = fr['character.romain.desc'];
    const e = en['character.romain.desc'];
    expect(f.toLowerCase()).toContain('parle beaucoup');
    expect(e.toLowerCase()).toContain('chatterbox');
    const longest = Math.max(...CHARACTER_IDS.filter((id) => id !== 'romain').map((id) => Math.max(fr[`character.${id}.desc`].length, en[`character.${id}.desc`].length)));
    expect(f.length).toBeLessThanOrEqual(longest);
    expect(e.length).toBeLessThanOrEqual(longest);
  });
});
