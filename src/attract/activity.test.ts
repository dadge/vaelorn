import { describe, expect, it } from 'vitest';
import { ActivityWatcher, AXIS_ACTIVITY_THRESHOLD, AXIS_REANCHOR_POLLS, PadActivityDetector, POINTER_MOVE_THRESHOLD_PX, carryActivity, takeCarriedActivity, type ActivityTarget } from './activity';
import { VIRTUAL_PAD_INDEX, VirtualPad } from '../input/VirtualPad';
import type { GamepadLike } from '../input/GamepadSource';

function pad(index: number, opts: { buttons?: number[]; axes?: number[] } = {}): GamepadLike {
  const down = new Set(opts.buttons ?? []);
  return {
    index,
    id: `pad ${index}`,
    mapping: 'standard',
    connected: true,
    axes: opts.axes ?? [0, 0, 0, 0],
    buttons: Array.from({ length: 16 }, (_, i) => ({ pressed: down.has(i), value: down.has(i) ? 1 : 0 })),
  };
}

describe('PadActivityDetector', () => {
  it('le premier sondage ne fait que mémoriser (pas d\'activité), même avec un bouton déjà tenu', () => {
    const d = new PadActivityDetector();
    expect(d.check([pad(0, { buttons: [0] })])).toBe(false);
    expect(d.check([pad(0, { buttons: [0] })])).toBe(false); // toujours tenu : pas une nouvelle activité
  });

  it('un bouton nouvellement appuyé est une activité, puis le relâcher puis le ré-appuyer aussi', () => {
    const d = new PadActivityDetector();
    d.check([pad(0)]);
    expect(d.check([pad(0, { buttons: [3] })])).toBe(true);
    expect(d.check([pad(0, { buttons: [3] })])).toBe(false);
    expect(d.check([pad(0)])).toBe(false);
    expect(d.check([pad(0, { buttons: [3] })])).toBe(true);
  });

  it('un stick au-delà du seuil est une activité ; une dérive sous le seuil non', () => {
    const d = new PadActivityDetector();
    d.check([pad(0)]);
    expect(d.check([pad(0, { axes: [AXIS_ACTIVITY_THRESHOLD - 0.1, 0.05, 0, 0] })])).toBe(false);
    expect(d.check([pad(0, { axes: [AXIS_ACTIVITY_THRESHOLD + 0.1, 0, 0, 0] })])).toBe(true);
    expect(d.check([pad(0, { axes: [0, -0.9, 0, 0] })])).toBe(true);
  });

  it("stick tenu au premier sondage puis relâché : l'activité cesse (la référence se recale), plus d'activité permanente", () => {
    const d = new PadActivityDetector();
    d.check([pad(0, { axes: [0, 0.9, 0, 0] })]); // tenu au 1er sondage : référence
    expect(d.check([pad(0, { axes: [0, 0.9, 0, 0] })])).toBe(false);
    expect(d.check([pad(0, { axes: [0, 0, 0, 0] })])).toBe(true); // relâché : mouvement réel
    let last = true;
    for (let i = 0; i < AXIS_REANCHOR_POLLS + 5; i++) last = d.check([pad(0, { axes: [0, 0, 0, 0] })]);
    expect(last).toBe(false);
    for (let i = 0; i < 20; i++) expect(d.check([pad(0, { axes: [0, 0, 0, 0] })])).toBe(false);
    // et une vraie poussée est de nouveau détectée
    expect(d.check([pad(0, { axes: [0, 0.9, 0, 0] })])).toBe(true);
  });

  it('un axe au repos à -1 (gâchette analogique d\'une manette non standard) n\'est pas une activité', () => {
    const d = new PadActivityDetector();
    d.check([pad(0, { axes: [0, 0, -1, -1] })]);
    expect(d.check([pad(0, { axes: [0, 0, -1, -1] })])).toBe(false);
    expect(d.check([pad(0, { axes: [0, 0, 0.2, -1] })])).toBe(true); // elle bouge vraiment
  });

  it('une manette qui apparaît est une simple observation ; une manette qui disparaît est oubliée', () => {
    const d = new PadActivityDetector();
    expect(d.check([])).toBe(false);
    expect(d.check([pad(1, { buttons: [0] })])).toBe(false);
    expect(d.check([])).toBe(false);
    expect(d.check([pad(1, { buttons: [0] })])).toBe(false); // revue comme une première observation
  });

  it('la manette virtuelle tactile (stick, boutons) est vue comme une manette', () => {
    const vp = new VirtualPad();
    vp.setConnected(true);
    const d = new PadActivityDetector();
    d.check([vp.snapshot()]);
    expect(d.check([vp.snapshot()])).toBe(false);
    vp.pressButton(1, 'a');
    expect(d.check([vp.snapshot()])).toBe(true);
    vp.releaseAll();
    expect(d.check([vp.snapshot()])).toBe(false);
    vp.beginStick(2, 40, 0, 50);
    expect(d.check([vp.snapshot()])).toBe(true);
    expect(vp.snapshot().index).toBe(VIRTUAL_PAD_INDEX);
  });
});

/** Cible d'événements factice. */
function fakeTarget(): ActivityTarget & { emit(type: string, ev?: object): void; count(): number } {
  const map = new Map<string, Set<(ev: unknown) => void>>();
  return {
    addEventListener(type, listener) {
      if (!map.has(type)) map.set(type, new Set());
      map.get(type)!.add(listener);
    },
    removeEventListener(type, listener) {
      map.get(type)?.delete(listener);
    },
    emit(type, ev = {}) {
      for (const l of map.get(type) ?? []) l(ev);
    },
    count() {
      let n = 0;
      for (const set of map.values()) n += set.size;
      return n;
    },
  };
}

describe('ActivityWatcher', () => {
  it('clavier, souris, toucher, molette : chacun est une activité (consommée par poll)', () => {
    for (const type of ['keydown', 'mousedown', 'pointerdown', 'touchstart', 'wheel']) {
      const target = fakeTarget();
      const w = new ActivityWatcher({ target, gamepads: () => [] });
      w.start();
      expect(w.poll(), type).toBe(false);
      target.emit(type);
      expect(w.poll(), type).toBe(true);
      expect(w.poll(), type).toBe(false); // consommée
      w.stop();
    }
  });

  it('un déplacement de pointeur compte au-delà du seuil seulement (le tremblement et la 1re position non)', () => {
    const target = fakeTarget();
    const w = new ActivityWatcher({ target, gamepads: () => [] });
    w.start();
    target.emit('pointermove', { clientX: 100, clientY: 100 }); // référence
    expect(w.poll()).toBe(false);
    target.emit('pointermove', { clientX: 100 + POINTER_MOVE_THRESHOLD_PX - 2, clientY: 100 });
    expect(w.poll()).toBe(false);
    target.emit('pointermove', { clientX: 100 + POINTER_MOVE_THRESHOLD_PX + 2, clientY: 100 });
    expect(w.poll()).toBe(true);
    target.emit('mousemove', { clientX: 300, clientY: 300 });
    expect(w.poll()).toBe(true);
  });

  it('les manettes (y compris virtuelle) sont sondées à chaque poll', () => {
    const target = fakeTarget();
    let pads: GamepadLike[] = [pad(0)];
    const w = new ActivityWatcher({ target, gamepads: () => pads });
    w.start();
    expect(w.poll()).toBe(false);
    pads = [pad(0, { buttons: [0] })];
    expect(w.poll()).toBe(true);
    expect(w.poll()).toBe(false);
    pads = [pad(0), pad(VIRTUAL_PAD_INDEX, { axes: [0.9, 0, 0, 0] })];
    w.poll(); // nouvelle manette : observation
    pads = [pad(0), pad(VIRTUAL_PAD_INDEX, { axes: [0, 0.8, 0, 0] })];
    expect(w.poll()).toBe(true);
  });

  it('notify() (changement de langue…) compte comme une activité', () => {
    const w = new ActivityWatcher({ target: fakeTarget(), gamepads: () => [] });
    w.start();
    w.notify();
    expect(w.poll()).toBe(true);
  });

  it('start / stop sont idempotents et nettoient tous les écouteurs ; arrêté, poll vaut false', () => {
    const target = fakeTarget();
    const w = new ActivityWatcher({ target, gamepads: () => [] });
    w.start();
    w.start();
    expect(target.count()).toBeGreaterThan(0);
    w.stop();
    w.stop();
    expect(target.count()).toBe(0);
    expect(w.poll()).toBe(false);
    expect(w.isStarted).toBe(false);
  });

  it('sans cible (Node) ni manette : ne lève pas', () => {
    const w = new ActivityWatcher({ target: null, gamepads: () => [] });
    expect(() => {
      w.start();
      w.poll();
      w.stop();
    }).not.toThrow();
  });

  it('une action du joueur pendant le fondu du menu est transportée à la démo (une seule fois)', () => {
    expect(takeCarriedActivity()).toBe(false);
    carryActivity();
    expect(takeCarriedActivity()).toBe(true);
    expect(takeCarriedActivity()).toBe(false);
  });
});
