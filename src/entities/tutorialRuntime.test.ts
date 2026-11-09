import { describe, expect, it } from 'vitest';
import { SIM_STEP_MS } from '../core/constants';
import { createSimulation } from '../core/simulation';
import type { TickInputs } from '../core/types';
import { VIRTUAL_PAD_INDEX } from '../input/VirtualPad';
import { TUTORIAL_LEVEL_ID, TUTORIAL_SEED, tutorialLevel } from '../levels/tutorial';
import { PARTNER_PREFERENCE, TutorialRuntime, pickPartnerCharacter, tutorialPlayers } from './tutorialRuntime';

describe('partenaire et joueurs simulés', () => {
  it('le partenaire est le premier personnage de la famille différent du joueur', () => {
    expect(pickPartnerCharacter('david')).toBe('sandrine');
    expect(pickPartnerCharacter('sandrine')).toBe('valentine');
    expect(pickPartnerCharacter('mira')).toBe('sandrine');
    for (const c of PARTNER_PREFERENCE) expect(pickPartnerCharacter(c)).not.toBe(c);
  });

  it('2 joueurs, difficulté facile, ids 0 et 1', () => {
    const p = tutorialPlayers({ id: 0, characterId: 'romain', difficulty: 3 });
    expect(p).toEqual([
      { id: 0, characterId: 'romain', difficulty: 1 },
      { id: 1, characterId: 'sandrine', difficulty: 1 },
    ]);
    expect(tutorialPlayers(undefined)[0].characterId).toBe('david');
  });
});

describe('TutorialRuntime', () => {
  function make(startRoomIndex = 0) {
    const sim = createSimulation({ levelId: TUTORIAL_LEVEL_ID, players: tutorialPlayers(undefined), seed: TUTORIAL_SEED, startRoomIndex }, tutorialLevel);
    return { sim, rt: new TutorialRuntime(tutorialLevel, { startRoomIndex }) };
  }

  it('decorate ajoute les entrées du partenaire (joueur 1) sans toucher celles du joueur', () => {
    const { sim, rt } = make(0);
    const human: TickInputs = { 0: { moveX: 1, moveY: 0, attack: true, interact: false, revive: false } };
    const out = rt.decorate(human, sim.state);
    expect(out[0]).toBe(human[0]);
    expect(out[1]).toBeDefined();
    expect(out[1]?.attack).toBe(false);
  });

  it('appareil : clavier par défaut, appareil du menu avant la première touche, manette virtuelle, puis clavier dès qu une touche est pressée', () => {
    const { rt } = make(0);
    expect(rt.currentDevice).toBe('keyboard');
    const rt2 = new TutorialRuntime(tutorialLevel, { initialDevice: 'gamepadPs' });
    expect(rt2.currentDevice).toBe('gamepadPs');
    rt2.refreshDevice({ label: 'keyboard', virtualPadConnected: false });
    expect(rt2.currentDevice).toBe('gamepadPs');
    rt2.noteKeyboard();
    expect(rt2.refreshDevice({ label: 'keyboard', virtualPadConnected: false })).toBe(true);
    expect(rt2.currentDevice).toBe('keyboard');
    const rt3 = new TutorialRuntime(tutorialLevel);
    rt3.refreshDevice({ label: 'keyboard', virtualPadConnected: true });
    expect(rt3.currentDevice).toBe('touch');
    rt3.refreshDevice({ label: 'gamepad', gamepadIndex: VIRTUAL_PAD_INDEX, virtualPadConnected: true });
    expect(rt3.currentDevice).toBe('touch');
  });

  it('les libellés suivent l appareil (tactile : boutons de la manette virtuelle)', () => {
    const rt = new TutorialRuntime(tutorialLevel, { initialDevice: 'touch' });
    rt.refreshDevice({ label: 'keyboard', virtualPadConnected: true });
    expect(rt.labels().action).toContain('A');
    expect(rt.labels().move).toContain('stick');
  });

  it('skip : une étape ordinaire est sautée ; une étape de sortie propose la salle suivante', () => {
    const { rt } = make(0);
    expect(rt.skip()).toEqual({ kind: 'step', nextRoomIndex: 1 });
    for (let i = 0; i < 9; i++) rt.skip();
    expect(rt.view().stepId).toBe('exit.yard');
    expect(rt.skip()).toEqual({ kind: 'room', nextRoomIndex: 1 });
  });

  it('observe + takeKnockDowns : la mise à terre scénarisée est demandée une fois, appliquée par la simulation', () => {
    const { sim, rt } = make(4);
    const frames = Math.ceil(1500 / SIM_STEP_MS);
    const downs: number[] = [];
    for (let i = 0; i < frames; i++) {
      const events = sim.step(SIM_STEP_MS, rt.decorate({}, sim.state));
      rt.observe(events, sim.state, []);
      for (const id of rt.takeKnockDowns()) {
        downs.push(id);
        sim.knockDown(id);
      }
    }
    expect(downs).toEqual([1]);
    expect(sim.state.players[1].status).toBe('down');
  });
});
