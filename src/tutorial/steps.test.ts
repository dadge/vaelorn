import { describe, expect, it } from 'vitest';
import { getDictionary } from '../i18n/i18n';
import { tutorialLevel } from '../levels/tutorial';
import { BUTTON_NAMES, DEVICE_KINDS } from './deviceHints';
import { TUTORIAL_STEPS, firstStepIndexOfRoom, isExitStep } from './steps';
import type { Condition, PartnerOp } from './types';

const fr = getDictionary('fr') as Record<string, string>;
const en = getDictionary('en') as Record<string, string>;

const TOKENS = new Set(['move', 'action', 'attack', 'interact', 'special', 'call', 'heart', 'skip', 'pause', 'name', 'specialName']);

function placeholders(s: string): string[] {
  return Array.from(new Set(Array.from(s.matchAll(/\{(\w+)\}/g), (m) => m[1]))).sort();
}

function walkConditions(c: Condition | undefined, out: Condition[] = []): Condition[] {
  if (!c) return out;
  out.push(c);
  if (c.k === 'all' || c.k === 'any') for (const x of c.of) walkConditions(x, out);
  return out;
}

describe('étapes du tutoriel : données', () => {
  it('36 étapes aux ids uniques, regroupées par salle dans l ordre du niveau', () => {
    expect(TUTORIAL_STEPS.length).toBe(36);
    expect(new Set(TUTORIAL_STEPS.map((s) => s.id)).size).toBe(36);
    const roomOrder = tutorialLevel.rooms.map((r) => r.id);
    let last = -1;
    for (const s of TUTORIAL_STEPS) {
      const idx = roomOrder.indexOf(s.room);
      expect(idx, `salle de ${s.id}`).toBeGreaterThanOrEqual(0);
      expect(idx, `ordre de ${s.id}`).toBeGreaterThanOrEqual(last);
      last = idx;
    }
    for (const r of roomOrder) expect(firstStepIndexOfRoom(r), r).toBeGreaterThanOrEqual(0);
  });

  it('chaque salle (sauf la dernière) se termine par une étape de sortie `exit.*`', () => {
    for (const r of tutorialLevel.rooms) {
      const steps = TUTORIAL_STEPS.filter((s) => s.room === r.id);
      expect(isExitStep(steps[steps.length - 1]), r.id).toBe(true);
    }
  });

  it('une étape `do` a une condition `done`, une étape `tip` n en a pas et ne bloque jamais', () => {
    for (const s of TUTORIAL_STEPS) {
      if (s.kind === 'do') expect(s.done, s.id).toBeDefined();
      else expect(s.done, s.id).toBeUndefined();
    }
  });

  it('couvre toutes les mécaniques demandées (relevage, appel, panneaux, objectifs de salle et personnel)', () => {
    const ids = TUTORIAL_STEPS.map((s) => s.id);
    for (const must of ['move', 'sign', 'roomGoals', 'personalGoal', 'attack', 'special', 'specialRecharge', 'hearts', 'lever', 'plates', 'block', 'keyPick', 'keyDoor', 'refuel', 'lightBrazier', 'revive', 'heartStore', 'heartSelf', 'heartAlly', 'heartFull', 'callReceive', 'callSend', 'wipe', 'finalGoals']) {
      expect(ids, must).toContain(must);
    }
    const highlights = new Set(TUTORIAL_STEPS.flatMap((s) => s.highlights ?? []));
    for (const h of ['roomGoals', 'personalGoal', 'hearts', 'heartSlot', 'special', 'keys', 'torch']) expect(highlights.has(h as never), h).toBe(true);
  });

  it('les références (panneaux, mécanismes, zones, objectifs) existent dans la salle de l étape', () => {
    for (const s of TUTORIAL_STEPS) {
      const room = tutorialLevel.rooms.find((r) => r.id === s.room)!;
      const mechs = new Set(room.mechanisms.map((m) => m.id));
      const check = (token: string): void => {
        if (token === 'clear' || token.startsWith('obj:')) return;
        expect(mechs.has(token), `${s.id} : mécanisme ${token}`).toBe(true);
      };
      for (const c of [...walkConditions(s.done), ...walkConditions(s.gate)]) {
        if (c.k === 'req') check(c.token);
        if (c.k === 'nearSign') expect((room.signs ?? []).some((x) => x.id === c.id), `${s.id} : panneau ${c.id}`).toBe(true);
        if (c.k === 'objective') expect(tutorialLevel.objectives.some((o) => o.id === c.id), `${s.id} : objectif ${c.id}`).toBe(true);
      }
      for (const m of s.markers ?? []) {
        if ('mech' in m) expect(mechs.has(m.mech), `${s.id} : repère ${m.mech}`).toBe(true);
        if ('sign' in m) expect((room.signs ?? []).some((x) => x.id === m.sign), `${s.id} : repère panneau ${m.sign}`).toBe(true);
      }
      const ops: PartnerOp[] = s.partner ?? [];
      for (const op of ops) {
        if ((op.op === 'walk' || op.op === 'stand') && 'mech' in op.at) expect(mechs.has(op.at.mech), `${s.id} : partenaire ${op.at.mech}`).toBe(true);
        if ((op.op === 'stand') && 'zone' in op.at) expect((room.zones ?? []).some((z) => z.id === (op.at as { zone: string }).zone)).toBe(true);
        if (op.op === 'callEvery') expect(op.ms).toBeGreaterThanOrEqual(5200); // délai de récupération de l'appel : 5000 ms
      }
    }
  });

  it('le partenaire ne reçoit jamais d ordre d attaque : seules les opérations walk/stand/press/idle/callEvery/goExit existent', () => {
    for (const s of TUTORIAL_STEPS) for (const op of s.partner ?? []) expect(['idle', 'walk', 'stand', 'press', 'callEvery', 'reviveHuman', 'goExit']).toContain(op.op);
  });

  it('les opérations essentielles sont celles qui conditionnent la suite (plaque B, levier rouge, levier de la herse de sortie du relevage, cercle du sceau)', () => {
    const essential = TUTORIAL_STEPS.flatMap((s) => (s.partner ?? []).filter((o) => 'essential' in o && o.essential).map(() => s.id));
    expect(new Set(essential)).toEqual(new Set(['plates', 'teamGoal', 'exit.revive', 'finalGoals']));
  });
});

describe('étapes du tutoriel : i18n fr / en', () => {
  it('chaque étape a son texte en fr et en, avec les mêmes jetons, tous autorisés', () => {
    for (const s of TUTORIAL_STEPS) {
      expect(s.textKey).toBe(`tutorial.step.${s.id}`);
      expect(fr[s.textKey], `fr ${s.textKey}`).toBeTruthy();
      expect(en[s.textKey], `en ${s.textKey}`).toBeTruthy();
      expect(placeholders(fr[s.textKey]), s.textKey).toEqual(placeholders(en[s.textKey]));
      for (const p of placeholders(fr[s.textKey])) expect(TOKENS.has(p), `${s.textKey} : jeton {${p}}`).toBe(true);
    }
  });

  it('les cartes d interruption, la fin, la puce et les légendes existent en fr et en', () => {
    const keys = [
      'tutorial.card.progress', 'tutorial.card.compact', 'tutorial.card.wait', 'tutorial.card.stuck', 'tutorial.card.partnerDown',
      'tutorial.card.youDown', 'tutorial.card.reviveInterrupted', 'tutorial.skip.step', 'tutorial.skip.room', 'tutorial.skip.hint',
      'tutorial.quit.hint', 'tutorial.end.title', 'tutorial.end.body', 'tutorial.end.nosave', 'tutorial.end.solo', 'tutorial.end.press',
      'tutorial.end.menu', 'tutorial.key.space', 'tutorial.key.enter', 'tutorial.key.escape', 'menu.tutorial', 'menu.tutorial.hint',
      ...['roomGoals', 'personalGoal', 'hearts', 'special', 'keys', 'torch', 'prompt', 'sign'].map((x) => `tutorial.legend.${x}`),
      ...BUTTON_NAMES.map((b) => `tutorial.name.${b}`),
    ];
    for (const k of keys) {
      expect(fr[k], `fr ${k}`).toBeTruthy();
      expect(en[k], `en ${k}`).toBeTruthy();
      expect(placeholders(fr[k]), k).toEqual(placeholders(en[k]));
    }
  });

  it('chaque bouton a un libellé pour chaque appareil, en fr et en', () => {
    for (const dev of DEVICE_KINDS) {
      for (const b of BUTTON_NAMES) {
        if (dev === 'keyboard' && !['move', 'skip', 'pause'].includes(b)) continue; // clavier : touches des bindings (`tutorial.btn.key`)
        const key = `tutorial.btn.${b}.${dev}`;
        expect(fr[key], `fr ${key}`).toBeTruthy();
        expect(en[key], `en ${key}`).toBeTruthy();
        expect(placeholders(fr[key]), key).toEqual(placeholders(en[key]));
      }
    }
    for (const k of ['tutorial.btn.key', 'tutorial.btn.move.custom']) {
      expect(placeholders(fr[k])).toEqual(placeholders(en[k]));
    }
  });
});

describe('étapes du tutoriel : emplacement cœur (salle t_heart)', () => {
  const heartSteps = TUTORIAL_STEPS.filter((s) => s.room === 't_heart');

  it('5 étapes dans l ordre : ranger, B sur soi, B sur un coéquipier blessé, emplacement plein = appel automatique, sortie', () => {
    expect(heartSteps.map((s) => s.id)).toEqual(['heartStore', 'heartSelf', 'heartAlly', 'heartFull', 'exit.heart']);
    expect(tutorialLevel.rooms.map((r) => r.id)).toContain('t_heart');
  });

  it('les cœurs posés par le script sont sur la rangée 6, dans la salle, et reconnaissables (cœur / demi-cœur) ; les blessures visent le joueur ou le partenaire', () => {
    const room = tutorialLevel.rooms.find((r) => r.id === 't_heart')!;
    for (const s of heartSteps) {
      for (const h of s.script?.hearts ?? []) {
        expect(h.tile[1], s.id).toBe(6);
        expect(room.layout[h.tile[1]][h.tile[0]], s.id).toBe('.');
        expect(['half', 'full']).toContain(h.kind);
      }
      for (const w of s.script?.wound ?? []) {
        expect([0, 1]).toContain(w.id);
        expect(w.fraction).toBeGreaterThan(0);
        expect(w.fraction).toBeLessThan(1);
      }
    }
  });

  it('chaque étape de soin nomme le bouton B quand elle demande de l utiliser, et son texte emploie le jeton {heart}', () => {
    for (const id of ['heartSelf', 'heartAlly']) {
      const s = heartSteps.find((x) => x.id === id)!;
      expect(s.buttons, id).toContain('heart');
      expect(fr[s.textKey], id).toContain('{heart}');
      expect(en[s.textKey], id).toContain('{heart}');
    }
  });

  it('les conditions de réussite sont des ACTIONS du joueur (événements de l emplacement), jamais une simple lecture', () => {
    const done = (id: string): Condition | undefined => heartSteps.find((s) => s.id === id)?.done;
    expect(JSON.stringify(done('heartSelf'))).toContain('heartUsed');
    expect(JSON.stringify(done('heartAlly'))).toContain('"targetId":1');
    expect(JSON.stringify(done('heartFull'))).toContain('autoCallStarted');
  });

  it('chaque étape i18n de la salle a son texte en fr et en ; le partenaire de heartFull vient prendre le cœur resté au sol après l appel automatique', () => {
    for (const s of heartSteps) {
      expect(fr[s.textKey], s.id).toBeTruthy();
      expect(en[s.textKey], s.id).toBeTruthy();
    }
    const full = heartSteps.find((s) => s.id === 'heartFull')!;
    expect(full.partner?.some((op) => op.op === 'walk' && 'pickup' in op.at)).toBe(true);
  });
});
