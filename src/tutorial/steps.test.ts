import { describe, expect, it } from 'vitest';
import { GAME_HEIGHT, GAME_WIDTH } from '../core/constants';
import { getDictionary } from '../i18n/i18n';
import { CARD_MARGIN, cardFontSize, cardWidth } from '../render/tutorialHudLogic';
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
  it('44 étapes aux ids uniques, regroupées par salle dans l ordre du niveau', () => {
    expect(TUTORIAL_STEPS.length).toBe(44);
    expect(new Set(TUTORIAL_STEPS.map((s) => s.id)).size).toBe(44);
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
    for (const must of ['move', 'sign', 'roomGoals', 'personalGoal', 'attack', 'special', 'specialRecharge', 'hearts', 'lever', 'plates', 'block', 'keyPick', 'keyDoor', 'refuel', 'lightBrazier', 'revive', 'heartStore', 'heartSelf', 'heartAlly', 'heartFull', 'gearLeft', 'gearSwap', 'crossCall', 'crossWho', 'autoCallRecap1', 'autoCallRecap2', 'callReceive', 'callSend', 'wipe', 'finalGoals']) {
      expect(ids, must).toContain(must);
    }
    const highlights = new Set(TUTORIAL_STEPS.flatMap((s) => s.highlights ?? []));
    for (const h of ['roomGoals', 'personalGoal', 'hearts', 'heartSlot', 'gear', 'special', 'keys', 'torch']) expect(highlights.has(h as never), h).toBe(true);
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
      ...['roomGoals', 'personalGoal', 'hearts', 'heartSlot', 'gear', 'special', 'keys', 'torch', 'prompt', 'sign'].map((x) => `tutorial.legend.${x}`),
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

// ───────────────────────────── Appels automatiques : objets laissés, échange, croix rouge, récapitulatif ─────────────────────────────

describe('étapes du tutoriel : appels automatiques', () => {
  const byRoom = (id: string): string[] => TUTORIAL_STEPS.filter((s) => s.room === id).map((s) => s.id);
  const step = (id: string) => TUTORIAL_STEPS.find((s) => s.id === id)!;

  it('salle t_gear (objet moins puissant, échange d accessoire), salle t_cross (croix rouge), récapitulatif dans le grand couloir, dans cet ordre', () => {
    expect(byRoom('t_gear')).toEqual(['gearLeft', 'gearSwap', 'exit.gear']);
    expect(byRoom('t_cross')).toEqual(['crossCall', 'crossWho', 'exit.cross']);
    expect(byRoom('t_call')).toEqual(['callReceive', 'callSend', 'autoCallRecap1', 'autoCallRecap2', 'exit.call']);
    const rooms = tutorialLevel.rooms.map((r) => r.id);
    expect(rooms.indexOf('t_heart')).toBeLessThan(rooms.indexOf('t_gear'));
    expect(rooms.indexOf('t_gear')).toBeLessThan(rooms.indexOf('t_cross'));
    expect(rooms.indexOf('t_cross')).toBeLessThan(rooms.indexOf('t_call'));
  });

  it('les conditions de réussite sont des ACTIONS (l appel part avec le symbole de l objet, le partenaire en profite, l échange est fait, le partenaire est soigné)', () => {
    const j = (id: string): string => JSON.stringify(step(id).done);
    expect(j('gearLeft')).toContain('"icon":"gear"');
    expect(j('gearLeft')).toContain('gearPicked');
    expect(j('gearSwap')).toContain('gearSwapped');
    expect(j('gearSwap')).toContain('"icon":"gear"');
    expect(j('gearSwap')).toContain('gearPicked');
    expect(j('crossCall')).toContain('"icon":"cross"');
    expect(j('crossCall')).toContain('heartUsed');
    expect(j('crossCall')).toContain('"targetId":1');
  });

  it('mise en scène : le joueur reçoit de quoi REFUSER (protection II contre I) et de quoi ÉCHANGER (accessoire contre un autre) ; le partenaire est blessé SOUS 30 % et le joueur a un cœur rangé', () => {
    const left = step('gearLeft').script!;
    expect(left.equip).toEqual([{ id: 0, item: { slot: 'protection', level: 2 } }]);
    expect(left.gear?.[0].item).toEqual({ slot: 'protection', level: 1 });
    const swap = step('gearSwap').script!;
    expect(swap.equip?.[0].item.slot).toBe('accessory');
    expect(swap.gear?.[0].item.slot).toBe('accessory');
    expect(swap.gear?.[0].item.accessory).not.toBe(swap.equip?.[0].item.accessory); // une AUTRE sorte : « échange », pas « ignorer »
    const cross = step('crossCall').script!;
    expect(cross.giveHeart).toEqual([{ id: 0, kind: 'full' }]);
    expect(cross.wound?.[0].id).toBe(1);
    expect(cross.wound?.[0].fraction).toBeLessThan(0.3); // sous le seuil de la croix (30 %)
    expect(cross.wound?.[0].fraction).toBeGreaterThan(0);
  });

  it('les objets posés sont sur la rangée 6 (partenaire en ligne droite), dans la salle, sur une case libre ; le partenaire attend l appel puis vient prendre l objet', () => {
    const room = tutorialLevel.rooms.find((r) => r.id === 't_gear')!;
    for (const id of ['gearLeft', 'gearSwap']) {
      for (const g of step(id).script!.gear ?? []) {
        expect(g.tile[1], id).toBe(6);
        expect(room.layout[g.tile[1]][g.tile[0]], id).toBe('.');
      }
      const ops = step(id).partner!;
      expect(ops[0]).toMatchObject({ op: 'idle' });
      expect(JSON.stringify(ops[0])).toContain('autoCallStarted');
      expect(ops.some((o) => o.op === 'walk' && 'gear' in o.at)).toBe(true);
    }
  });

  it('le partenaire de la croix démarre loin du joueur (hors de la vue : la croix apparaît au bord de l écran) et sur la rangée 6', () => {
    const room = tutorialLevel.rooms.find((r) => r.id === 't_cross')!;
    const [a, b] = [room.playerSpawns[0], room.playerSpawns[1]];
    expect(b[1]).toBe(6);
    expect(b[0] - a[0]).toBeGreaterThan(40); // la vue montre ≈ 26,7 tuiles de large (≈ 32 sur un fond de téléphone large) : le partenaire est nettement hors de la vue, même à 23 tuiles il apparaissait au bord (puce « Passer » par-dessus)
  });

  it("l'étape heartFull n'est validée / attendue que par l'appel de CŒUR ENTIER du joueur (une croix rouge de sa part, blessé en arrivant, ne compte pas)", () => {
    const s = step('heartFull');
    expect(JSON.stringify(s.done)).toContain('"icon":"heart"');
    expect(JSON.stringify(s.partner![0])).toContain('"icon":"heart"');
  });

  it("la fusion est enseignée dans l'étape de rangement : deux demi-cœurs au sol, validée par l'événement de fusion ; heartFull pose deux cœurs ENTIERS (deux demi-cœurs ne refuseraient rien)", () => {
    const store = step('heartStore');
    expect(store.script?.hearts?.map((h) => h.kind)).toEqual(['half', 'half']);
    expect(JSON.stringify(store.done)).toContain('"count":2'); // deux rangements (le second fusionne) : robuste à un B entre les deux
    expect(fr['tutorial.step.heartStore']).toContain('deux demi-cœurs font un cœur entier');
    expect(en['tutorial.step.heartStore']).toContain('two half hearts make a full heart');
    expect(step('heartFull').script?.hearts?.map((h) => h.kind)).toEqual(['full', 'full', 'full']); // le troisième garantit le refus même si B a consommé le premier
  });

  it("l'étape crossCall redonne le cœur tant que le partenaire n'est pas soigné (keepHeart) : un B prématuré ne bloque pas", () => {
    expect(step('crossCall').script?.keepHeart).toBe(true);
  });

  it('les textes (fr et en) emploient les jetons de bouton attendus : {interact} pour l échange et {heart} pour soigner ; le récapitulatif cite l appel manuel {call}', () => {
    expect(step('gearSwap').buttons).toContain('interact');
    expect(fr['tutorial.step.gearSwap']).toContain('{interact}');
    expect(en['tutorial.step.gearSwap']).toContain('{interact}');
    expect(step('crossCall').buttons).toContain('heart');
    expect(fr['tutorial.step.crossCall']).toContain('{heart}');
    expect(en['tutorial.step.crossCall']).toContain('{heart}');
    for (const l of [fr, en]) expect(l['tutorial.step.autoCallRecap2']).toContain('{call}');
  });

  it('RÉCAPITULATIF : toutes les règles de l appel automatique figurent dans le tutoriel (fr et en) — déclencheurs, symbole, destinataires, durée, anti-spam, exceptions', () => {
    const recap = (l: Record<string, string>): string => `${l['tutorial.step.autoCallRecap1']}\n${l['tutorial.step.autoCallRecap2']}`.toLowerCase();
    const fr1 = recap(fr);
    // 4 déclencheurs
    expect(fr1).toContain('emplacement cœur contient déjà un cœur entier');
    expect(fr1).toContain('pas plus puissant'); // un niveau ÉGAL est aussi refusé
    expect(fr1).toContain('à terre'); // pas de croix à terre
    expect(fr1).toContain('échanger');
    expect(fr1).toContain('croix rouge');
    expect(fr1).toContain('30 %');
    // symbole à la place du point, qui le voit, durée, ne fige pas / appel manuel, anti-spam, solo, verrou, chute
    expect(fr1).toContain('symbole');
    expect(fr1).toContain('point');
    expect(fr1).toContain('seulement les alliés');
    expect(fr1).toContain('valentine');
    expect(fr1).toContain('3 s');
    expect(fr1).toContain('ne te fige pas');
    expect(fr1).toContain('appel manuel');
    expect(fr1).toContain('anti-spam');
    expect(fr1).toContain('4 s');
    expect(fr1).toContain('10 s');
    expect(fr1).toContain('jamais en solo');
    expect(fr1).toContain('verrouillé');
    expect(fr1).toContain('chute');
    const en1 = recap(en);
    for (const w of ['full', 'no stronger', 'swapped', 'downed', 'red cross', '30%', 'symbol', 'dot', 'only the allies', 'valentine', '3 s', 'does not freeze', 'manual call', 'anti-spam', '4 s', '10 s', 'never in solo', 'locked', 'fall']) {
      expect(en1, w).toContain(w);
    }
  });

  it('RÉCAPITULATIF : la règle de Romain (« parle beaucoup » : appels sans attente, croix rouge toutes les 3 s) figure en fr et en en ; l étape d appel et celle de la croix signalent l exception de Romain', () => {
    expect(fr['tutorial.step.autoCallRecap1']).toContain("Romain parle beaucoup : ses appels n'ont aucune attente, et sa croix rouge se répète toutes les 3 s.");
    expect(en['tutorial.step.autoCallRecap1']).toContain('Romain talks a lot: his calls have no wait, and his red cross repeats every 3 s.');
    // la phrase n'est pas dupliquée sur la page 2 (page déjà longue : elle débordait de la carte en tactile)
    expect(fr['tutorial.step.autoCallRecap2']).not.toContain('Romain');
    expect(en['tutorial.step.autoCallRecap2']).not.toContain('Romain');
    // l'appel manuel de Romain n'attend pas, mais ne se relance pas PENDANT son signal de 3 s : « dès la fin du signal », jamais « tout de suite »
    expect(fr['tutorial.step.callSend']).toContain('Romain : dès la fin du signal');
    expect(en['tutorial.step.callSend']).toContain('Romain: as soon as the signal ends');
    expect(fr['tutorial.step.callSend']).not.toContain('tout de suite');
    expect(en['tutorial.step.callSend']).not.toContain('right away');
    expect(fr['tutorial.step.crossWho']).toContain('toutes les 10 s (Romain : 3 s)');
    expect(en['tutorial.step.crossWho']).toContain('every 10 s (Romain: 3 s)');
    // la règle générale (10 s, 4 s) reste présente : Romain est une exception, pas un remplacement
    expect(fr['tutorial.step.autoCallRecap2']).toContain('10 s');
    expect(en['tutorial.step.autoCallRecap2']).toContain('10 s');
  });

  it('LONGUEUR : chaque page du récapitulatif tient dans la carte du tutoriel (police à chasse fixe 0,6 em, interligne 1,25), sur la vue logique, au clavier (22 px) comme en tactile (26 px), dans les deux langues', () => {
    /** Nombre de lignes après retour à la ligne aux espaces, à `cols` caractères par ligne. */
    const lines = (text: string, cols: number): number => {
      let n = 0;
      for (const para of text.split(String.fromCharCode(10))) {
        let len = 0;
        let count = 1;
        for (const w of para.split(' ')) {
          if (len === 0) len = w.length;
          else if (len + 1 + w.length <= cols) len += 1 + w.length;
          else {
            count++;
            len = w.length;
          }
        }
        n += count;
      }
      return n;
    };
    const vp = { x: 0, y: 0, w: GAME_WIDTH, h: GAME_HEIGHT };
    for (const touch of [false, true]) {
      const size = cardFontSize(touch);
      const cols = Math.floor((cardWidth(vp, touch) - 28) / (size * 0.6));
      const header = (touch ? 22 : 20) * 1.25 + 4;
      for (const id of ['autoCallRecap1', 'autoCallRecap2']) {
        for (const l of [fr, en]) {
          const text = l[`tutorial.step.${id}`].replace(/{w+}/g, 'XXXXXXXX');
          const h = lines(text, cols) * size * 1.25 + header + 28;
          expect(h, `${id} touch=${touch}`).toBeLessThanOrEqual(GAME_HEIGHT - 2 * CARD_MARGIN);
        }
      }
    }
  });

  it('chaque page du récapitulatif est une étape `tip` assez longue pour être lue (≥ 12 s)', () => {
    for (const id of ['autoCallRecap1', 'autoCallRecap2']) {
      expect(step(id).kind).toBe('tip');
      expect(step(id).minMs).toBeGreaterThanOrEqual(12_000);
    }
  });

  it('débit de lecture : les pages longues (récapitulatif, qui voit la croix) ne se ferment pas plus vite que ≈ 26 caractères / s, dans les deux langues', () => {
    for (const id of ['autoCallRecap1', 'autoCallRecap2', 'crossWho']) {
      for (const l of [fr, en]) {
        const chars = l[`tutorial.step.${id}`].length;
        expect(chars / (step(id).minMs / 1000), `${id} (${chars} car.)`).toBeLessThanOrEqual(26);
      }
    }
  });

  it("le texte de l'étape crossCall accorde le partenaire avec « {name} » (jamais « sur lui / elle ») et ne dit pas « tomber » (= à terre) pour un partenaire seulement blessé", () => {
    expect(fr['tutorial.step.crossCall']).not.toMatch(/sur (lui|elle)/);
    expect(fr['tutorial.step.crossCall']).not.toMatch(/tomb/);
    expect(fr['tutorial.step.crossCall']).toContain('sur {name}');
  });
});
