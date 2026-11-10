/**
 * B est « retour » dans la pause et les menus, « utiliser le cœur » en jeu : le B qui ferme la pause ne doit JAMAIS soigner, et un B de la pause ne doit pas être rejoué en jeu au pas
 * suivant (front montant). Boucle de bout en bout SANS Phaser : vraie `InputManager` (manette factice) -> `HeartInputGuard` (comme `GameScene`) -> vraie simulation.
 */
import { describe, expect, it } from 'vitest';
import { SIM_STEP_MS } from '../core/constants';
import { makeTestLevel, makeTestRoom } from '../core/levelValidation';
import { createSimulation, type GameSimulation } from '../core/simulation';
import type { SimEvent } from '../core/types';
import { PAD_BUTTON } from '../input/defaultBindings';
import type { GamepadLike } from '../input/GamepadSource';
import { InputManager } from '../input/InputManager';
import { HeartInputGuard } from './loopLogic';
import { resolvePauseBack } from './pauseLogic';

function pad(pressed: number[]): GamepadLike {
  return { index: 0, id: 'Pad 0', connected: true, axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: pressed.includes(i), value: pressed.includes(i) ? 1 : 0 })) };
}

function setup(): { sim: GameSimulation; mgr: InputManager; setPad: (p: number[]) => void; guard: HeartInputGuard; frame: () => SimEvent[] } {
  const room = makeTestRoom({ id: 'r1', exit: { rect: { x: 9, y: 5, w: 2, h: 2 }, requires: [] } });
  const level = makeTestLevel({ rooms: [{ ...room, exit: { ...room.exit, final: true } }] });
  const sim = createSimulation({ levelId: level.id, players: [{ id: 0, characterId: 'david', difficulty: 2 }], seed: 3, gear: false, heartSlot: true }, level);
  sim.step(SIM_STEP_MS, {});
  sim.state.players[0].hp = 30;
  sim.state.players[0].heart = 'full';
  let held: number[] = [];
  const mgr = new InputManager({ gamepadProvider: () => [pad(held)], storage: null, padEventTarget: null, player1Gamepad: true });
  const guard = new HeartInputGuard();
  // une frame de jeu : lecture des entrées -> garde -> un pas de simulation (exactement la chaîne de GameScene.update)
  const frame = (): SimEvent[] => sim.step(SIM_STEP_MS, guard.filter(mgr.poll()));
  return { sim, mgr, setPad: (p) => (held = p), guard, frame };
}

const used = (ev: readonly SimEvent[]): number => ev.filter((e) => e.type === 'heartUsed').length;

describe('B de la pause : ne soigne jamais en jeu', () => {
  it('B est « retour » dans la pause (il la ferme) : la résolution de la touche ne dépend pas du cœur', () => {
    expect(resolvePauseBack(false)).toBe('resume');
    expect(resolvePauseBack(true)).toBe('cancelQuit');
  });

  it('B tenu au moment de fermer la pause puis maintenu en jeu : AUCUN soin tant qu il n est pas relâché ; ensuite un vrai appui soigne UNE fois', () => {
    const { sim, setPad, guard, frame } = setup();
    // le joueur appuie sur B pour fermer la pause : la scène arme la garde (closePause)
    guard.arm();
    setPad([PAD_BUTTON.B]);
    let healed = 0;
    for (let i = 0; i < 30; i++) healed += used(frame()); // B toujours tenu après la fermeture
    expect(healed).toBe(0);
    expect(sim.state.players[0].hp).toBe(30);
    expect(sim.state.players[0].heart).toBe('full');
    // relâché, puis nouvel appui volontaire
    setPad([]);
    frame();
    setPad([PAD_BUTTON.B]);
    healed += used(frame());
    for (let i = 0; i < 20; i++) healed += used(frame());
    expect(healed).toBe(1);
    expect(sim.state.players[0].hp).toBe(40);
    expect(sim.state.players[0].heart).toBeUndefined();
  });

  it('SANS la garde, le même B tenu ferait un front montant fantôme (preuve que la garde est nécessaire)', () => {
    const { sim, setPad, mgr } = setup();
    setPad([PAD_BUTTON.B]);
    const ev = sim.step(SIM_STEP_MS, mgr.poll()); // pas de garde : B lu directement
    expect(used(ev)).toBe(1);
  });

  it('une scène qui démarre avec B encore tenu (retour d un menu / dialogue) ne soigne pas non plus', () => {
    const { sim, setPad, frame } = setup(); // la garde est armée à la création
    setPad([PAD_BUTTON.B]);
    for (let i = 0; i < 10; i++) expect(used(frame())).toBe(0);
    expect(sim.state.players[0].heart).toBe('full');
  });

  it('A (action) n est jamais masqué par la garde : seul B l est', () => {
    const { setPad, guard, mgr } = setup();
    guard.arm();
    setPad([PAD_BUTTON.A, PAD_BUTTON.B]);
    const f = guard.filter(mgr.poll())[0]!;
    expect(f.attack).toBe(true);
    expect(f.heart).toBe(false);
  });
});
