import { beforeAll, describe, expect, it } from 'vitest';
import { createRoomMechanisms } from '../core/mechanisms';
import type { BrazierDef, GameState, MechanismDef, RoomDef } from '../core/types';
import { makeTestRoom } from '../core/levelValidation';
import { setLanguage, t } from '../i18n/i18n';
import { RoomView, refreshLabel, type RefreshableLabel } from './RoomView';

/** Double minimal d'un Phaser.GameObjects.Text : enregistre les appels à setText. */
function fakeLabel(key: string): RefreshableLabel & { calls: string[] } {
  const calls: string[] = [];
  return { key, calls, text: { setText: (v: string) => calls.push(v) } };
}

describe('refreshLabel (libellé de brasero mis à jour sans recréer le texte à chaque image)', () => {
  const tr = (k: string): string => `T(${k})`;

  it('clé identique : aucun setText', () => {
    const l = fakeLabel('a');
    for (let i = 0; i < 100; i++) expect(refreshLabel(l, 'a', tr)).toBe(false);
    expect(l.calls).toEqual([]);
  });

  it('changement de clé : un seul setText, avec la traduction courante, puis plus rien', () => {
    const l = fakeLabel('cold');
    expect(refreshLabel(l, 'lit', tr)).toBe(true);
    expect(l.calls).toEqual(['T(lit)']);
    expect(l.key).toBe('lit');
    for (let i = 0; i < 50; i++) refreshLabel(l, 'lit', tr);
    expect(l.calls).toHaveLength(1);
  });

  it("retour à l'état éteint : le libellé d'éteint revient", () => {
    const l = fakeLabel('cold');
    refreshLabel(l, 'lit', tr);
    refreshLabel(l, 'cold', tr);
    expect(l.calls).toEqual(['T(lit)', 'T(cold)']);
  });

  it('clé indéfinie : libellé inchangé', () => {
    const l = fakeLabel('cold');
    expect(refreshLabel(l, undefined, tr)).toBe(false);
    expect(l.calls).toEqual([]);
    expect(l.key).toBe('cold');
  });

  it('changement de langue : la clé mémorisée est la clé COURANTE (retranslate re-traduit le bon libellé)', () => {
    let lang = 'fr';
    const t2 = (k: string): string => `${lang}:${k}`;
    const l = fakeLabel('cold');
    refreshLabel(l, 'lit', t2);
    lang = 'en';
    l.text.setText(t2(l.key)); // ce que fait RoomView.retranslate()
    expect(l.calls).toEqual(['fr:lit', 'en:lit']);
  });
});

/** Faux Phaser.GameObjects.Text chaînable : enregistre les setText. */
function fakeText(initial: string): { setText(v: string): unknown; value: string; calls: string[] } & Record<string, unknown> {
  const o: Record<string, unknown> & { value: string; calls: string[] } = { value: initial, calls: [] };
  const chain = (): unknown => o;
  for (const k of ['setDepth', 'setAlpha', 'setVisible', 'setPosition', 'setResolution', 'setScale', 'setOrigin']) o[k] = chain;
  o.setText = (v: string): unknown => {
    o.value = v;
    o.calls.push(v);
    return o;
  };
  return o as never;
}

type RoomViewInternals = {
  ctx: unknown;
  room: RoomDef;
  labels: { text: ReturnType<typeof fakeText>; key: string; dyn: MechanismDef | null }[];
  objs: unknown[];
  mechViews: { id: string; center: { x: number; y: number } }[];
  sealed: boolean;
  exitCenter: { x: number; y: number };
  buildLabels(room: RoomDef): void;
  updateLabels(state: GameState): void;
};

/** RoomView « sans Phaser » : prototype réel (buildLabels / updateLabels réels), scène factice. */
function bareRoomView(room: RoomDef): RoomViewInternals {
  const v = Object.create(RoomView.prototype) as RoomViewInternals;
  const scene = { add: { text: (_x: number, _y: number, str: string) => fakeText(str) } };
  v.ctx = { scene, zoom: 1, playerCount: 2, rig: { registerWorld: <T,>(o: T): T => o } };
  v.room = room;
  v.labels = [];
  v.objs = [];
  v.mechViews = room.mechanisms.map((m) => ({ id: m.id, center: { x: 100, y: 100 }, update() {}, destroy() {} }));
  v.sealed = false;
  v.exitCenter = { x: 400, y: 400 };
  return v;
}

describe("RoomView : libellé de brasero branché sur l'état de simulation (vue réelle, scène factice)", () => {
  beforeAll(() => setLanguage('fr'));
  const COLD: BrazierDef = { id: 'b', type: 'brazier', tile: [5, 5], labelKey: 'mech.tutorial.br_b', litLabelKey: 'mech.tutorial.br_a' };
  const PLAIN: BrazierDef = { id: 'p', type: 'brazier', tile: [8, 5], lit: true, labelKey: 'mech.tutorial.br_decor' };
  const LEVER: MechanismDef = { id: 'l', type: 'lever', tile: [2, 2], labelKey: 'mech.level1.lv1' };

  function setup(): { v: RoomViewInternals; state: GameState; label: (id: string) => ReturnType<typeof fakeText> } {
    const room = makeTestRoom({ mechanisms: [COLD, PLAIN, LEVER] });
    const v = bareRoomView(room);
    v.buildLabels(room);
    const state = { players: [{ status: 'alive', pos: { x: 100, y: 100 } }], room: { mechanisms: createRoomMechanisms(room, 1) } } as unknown as GameState;
    const label = (id: string): ReturnType<typeof fakeText> => {
      const i = room.mechanisms.findIndex((m) => m.id === id);
      return v.labels[i].text; // un libellé par mécanisme (puis la sortie), dans l'ordre des mécanismes
    };
    return { v, state, label };
  }

  it("seul le brasero à litLabelKey est dynamique (les autres mécanismes et les braseros sans litLabelKey restent statiques)", () => {
    const { v } = setup();
    expect(v.labels.map((l) => l.dyn?.id ?? null).slice(0, 3)).toEqual(['b', null, null]);
  });

  it("au passage à allumé le texte du monde change UNE fois (langue courante), puis redevient « éteint » si l'état repasse à éteint", () => {
    const { v, state, label } = setup();
    const b = label('b');
    expect(b.value).toBe(t('mech.tutorial.br_b'));
    for (let i = 0; i < 20; i++) v.updateLabels(state);
    expect(b.calls).toEqual([]); // éteint : aucun setText par image
    const st = state.room.mechanisms.find((m) => m.id === 'b')!;
    st.active = true;
    for (let i = 0; i < 20; i++) v.updateLabels(state);
    expect(b.calls).toEqual([t('mech.tutorial.br_a')]);
    st.active = false;
    v.updateLabels(state);
    expect(b.calls).toEqual([t('mech.tutorial.br_a'), t('mech.tutorial.br_b')]);
    expect(label('p').calls).toEqual([]);
    expect(label('l').calls).toEqual([]);
  });

  it('brasero « waived » (coop adaptative) : libellé allumé dès le premier pas', () => {
    const { v, state, label } = setup();
    const st = state.room.mechanisms.find((m) => m.id === 'b')!;
    st.waived = true;
    v.updateLabels(state);
    expect(label('b').value).toBe(t('mech.tutorial.br_a'));
  });
});
