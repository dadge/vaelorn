/**
 * Retour visuel et sonore de « relevé = équipement récupérable » : texte flottant i18n fr / en (« Reprends tes objets ! »), anneau et halo à la couleur du propriétaire, pulsation lente
 * (jamais plus de 3 Hz), mouvement réduit respecté, son discret.
 */
import { describe, expect, it } from 'vitest';
import { PLAYER_COLORS } from '../core/constants';
import { createLoadout } from '../core/gear';
import { createSimulation } from '../core/simulation';
import { makeTestLevel, makeTestRoom } from '../core/levelValidation';
import type { ActionFrame, PlayerId, SimEvent } from '../core/types';
import { Sfx, sfxForEvent, sfxVolume } from '../entities/sfx';
import { getDictionary, setLanguage, t } from '../i18n/i18n';
import {
  GEAR_RECOVER_PULSE_PERIOD_MS,
  GEAR_RECOVER_RING_RADIUS,
  GEAR_RECOVER_TEXT_KEY,
  gearAlpha,
  gearOwnerCanRecover,
  gearRecoverColor,
  gearRecoverRingRadius,
  gearRecoverableText,
} from './gearFx';

describe('texte flottant du joueur relevé', () => {
  it('clé i18n présente en français ET en anglais, sans jeton, avec le texte attendu', () => {
    const fr = getDictionary('fr') as Record<string, string>;
    const en = getDictionary('en') as Record<string, string>;
    expect(GEAR_RECOVER_TEXT_KEY).toBe('gear.recoverable');
    expect(fr[GEAR_RECOVER_TEXT_KEY]).toBe('Reprends tes objets !');
    expect(en[GEAR_RECOVER_TEXT_KEY]).toBe('Grab your gear!');
    expect(fr[GEAR_RECOVER_TEXT_KEY]).not.toMatch(/\{/);
    expect(en[GEAR_RECOVER_TEXT_KEY]).not.toMatch(/\{/);
  });
  it('gearRecoverableText suit la langue courante', () => {
    setLanguage('fr');
    expect(gearRecoverableText(t)).toBe('Reprends tes objets !');
    setLanguage('en');
    expect(gearRecoverableText(t)).toBe('Grab your gear!');
    setLanguage('fr');
  });
  it('« aucun texte si aucun objet n\'est récupérable » : l\'événement n\'est jamais émis à zéro objet (la scène ne dessine le texte que sur cet événement)', () => {
    const lv = makeTestLevel({ rooms: [makeTestRoom({ id: 'r1', exit: { rect: { x: 9, y: 5, w: 2, h: 2 }, requires: [] } })] });
    const s = createSimulation({ levelId: lv.id, players: [{ id: 0, characterId: 'david', difficulty: 2 }, { id: 1, characterId: 'sandrine', difficulty: 2 }], seed: 3, gear: true, loot: false }, lv);
    s.state.players[0].pos = { x: 100, y: 60 };
    s.state.players[1].pos = { x: 102, y: 60 };
    s.state.players.forEach((p) => (p.invulnMs = 0));
    s.knockDown(0); // sans équipement : rien à reprendre
    const held: ActionFrame = { moveX: 0, moveY: 0, attack: false, interact: false, revive: true };
    const events: SimEvent[] = [];
    for (let i = 0; i < 260; i++) events.push(...s.step(1000 / 60, { 1: held }));
    expect(events.some((e) => e.type === 'playerRevived')).toBe(true);
    expect(events.some((e) => e.type === 'gearRecoverable')).toBe(false);
    expect(s.state.players[0].loadout).toEqual(createLoadout());
  });
});

describe('anneau et halo des objets récupérables', () => {
  it('couleur = celle du joueur propriétaire ; aucune pour un objet ordinaire ni quand le propriétaire est de nouveau à terre', () => {
    for (let id = 0; id < PLAYER_COLORS.length; id++) expect(gearRecoverColor(id as PlayerId, true)).toBe(PLAYER_COLORS[id]);
    expect(new Set(PLAYER_COLORS.map((_, id) => gearRecoverColor(id as PlayerId, true))).size).toBe(PLAYER_COLORS.length);
    expect(gearRecoverColor(undefined, true)).toBeNull();
    expect(gearRecoverColor(0, false)).toBeNull();
    expect(gearRecoverColor(9 as PlayerId, true)).toBe(0xffffff); // identifiant inattendu : blanc, jamais d'erreur
  });
  it("le signal suit la règle de ramassage : le propriétaire qui ne PEUT PLUS prendre l'objet (il porte mieux, ou un autre accessoire) ou qui est à terre ou absent n'a plus d'anneau ; un allié, lui, garde la possibilité de le prendre", () => {
    const empty = { status: 'alive', loadout: createLoadout() };
    const boots2 = { slot: 'boots', level: 2 } as const;
    expect(gearOwnerCanRecover(empty, boots2)).toBe(true);
    expect(gearOwnerCanRecover({ status: 'down', loadout: createLoadout() }, boots2)).toBe(false);
    expect(gearOwnerCanRecover(undefined, boots2)).toBe(false);
    expect(gearOwnerCanRecover({ status: 'alive', loadout: { ...createLoadout(), boots: 2 } }, boots2)).toBe(false); // niveau égal : refusé
    expect(gearOwnerCanRecover({ status: 'alive', loadout: { ...createLoadout(), boots: 3 } }, boots2)).toBe(false); // mieux : refusé
    const lantern = { slot: 'accessory', level: 1, accessory: 'lantern' } as const;
    expect(gearOwnerCanRecover(empty, lantern)).toBe(true);
    expect(gearOwnerCanRecover({ status: 'alive', loadout: { ...createLoadout(), accessory: { kind: 'magnet', level: 1 } } }, lantern)).toBe(false); // autre sorte : échange manuel, pas une reprise automatique
    // couplé à la couleur : jamais de couleur quand le propriétaire ne peut pas le prendre
    expect(gearRecoverColor(0, gearOwnerCanRecover({ status: 'alive', loadout: { ...createLoadout(), boots: 3 } }, boots2))).toBeNull();
    expect(gearRecoverColor(0, gearOwnerCanRecover(empty, boots2))).toBe(PLAYER_COLORS[0]);
  });
  it('pulsation lente : une période par seconde (bien en dessous de 3 Hz), amplitude de 1 px autour du rayon de base ; fixe avec prefers-reduced-motion', () => {
    expect(GEAR_RECOVER_PULSE_PERIOD_MS).toBeGreaterThanOrEqual(1000 / 3); // jamais plus de 3 cycles par seconde
    for (let ms = 0; ms <= 2000; ms += 7) {
      const r = gearRecoverRingRadius(ms);
      expect(Math.abs(r - GEAR_RECOVER_RING_RADIUS)).toBeLessThanOrEqual(1 + 1e-9);
      expect(gearRecoverRingRadius(ms + GEAR_RECOVER_PULSE_PERIOD_MS)).toBeCloseTo(r, 6); // périodique : un cycle par période
    }
    // variation maximale entre deux images à 60 Hz : bien inférieure à 1 px (aucun saut, donc aucun scintillement)
    for (let ms = 0; ms < 2000; ms += 16) expect(Math.abs(gearRecoverRingRadius(ms + 16.7) - gearRecoverRingRadius(ms))).toBeLessThan(0.15);
    for (const ms of [0, 250, 777, 5000]) expect(gearRecoverRingRadius(ms, true)).toBe(GEAR_RECOVER_RING_RADIUS);
  });
  it('l\'anneau suit le clignotement de fin de vie de l\'objet (même fonction, ≤ 3 Hz) : opaque tant qu\'il reste du temps, fixe en mouvement réduit', () => {
    expect(gearAlpha(8000, 1234)).toBe(1); // grâce de 8 s : opaque
    const flashes = new Set<number>();
    for (let ms = 0; ms < 1000; ms += 10) flashes.add(gearAlpha(900, ms));
    expect(flashes.size).toBeLessThanOrEqual(2);
    expect(gearAlpha(500, 123, true)).toBe(gearAlpha(500, 9999, true));
  });
});

describe('son', () => {
  it('gearRecoverable a un son propre, discret (plus doux que le ramassage), jouable sans audio sans lever', () => {
    expect(sfxForEvent({ type: 'gearRecoverable', playerId: 0, count: 3, pos: { x: 0, y: 0 } })).toBe('gearRecover');
    expect(sfxVolume('gearRecover')).toBeLessThan(sfxVolume('gearPick'));
    expect(sfxVolume('gearRecover')).toBeLessThanOrEqual(0.04);
    const s = new Sfx();
    expect(() => s.play('gearRecover')).not.toThrow();
    s.destroy();
  });
  it('les sons voisins gardent leur nom (ramassage, perte)', () => {
    expect(sfxForEvent({ type: 'gearLost', playerId: 0, items: [], pos: { x: 0, y: 0 } })).toBe('gearLost');
    expect(sfxForEvent({ type: 'gearPicked', dropId: 1, playerId: 0, item: { slot: 'boots', level: 1 }, replaced: null, pos: { x: 0, y: 0 }, recovered: true })).toBe('gearPick');
  });
});
