/**
 * FRAPPE EN DIAGONALE côté rendu et tutoriel : pose de l'arc d'épée, angles / vecteurs des effets de spéciaux, condition « coup en diagonale »,
 * étape `diagonal` du tutoriel, textes FR/EN.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Aim8, DiagDir, SimEvent } from '../core/types';
import { setLanguage, t } from '../i18n/i18n';
import enParts from '../i18n/parts/tutorial.en.json';
import frParts from '../i18n/parts/tutorial.fr.json';
import { slashFrame, slashPose } from '../render/art/animations';
import { dirAngle, dirUnit, playAim } from '../render/specialFx';
import { countEvents, isLoggedEvent } from '../tutorial/conditions';
import { TUTORIAL_STEPS } from '../tutorial/steps';
import { TutorialRun } from '../testing/tutorial.solution';
import { buttonLabels } from '../tutorial/deviceHints';
import type { Condition } from '../tutorial/types';

const DIAGS: DiagDir[] = ['upLeft', 'upRight', 'downLeft', 'downRight'];

describe('arc d épée en diagonale (slashPose)', () => {
  it('cardinal : l arc cardinal, rotation nulle (rendu inchangé)', () => {
    for (const d of ['up', 'down', 'left', 'right'] as const) expect(slashPose(d)).toEqual({ frame: slashFrame(d), rotation: 0 });
    expect(slashPose('up', undefined)).toEqual({ frame: 'fx_slash_up', rotation: 0 });
  });

  it('diagonale : l arc de la composante horizontale, pivoté de 45° vers la verticale (l arc pointe bien vers la diagonale)', () => {
    const pi4 = Math.PI / 4;
    expect(slashPose('right', 'downRight')).toEqual({ frame: 'fx_slash_right', rotation: pi4 });
    expect(slashPose('down', 'upRight')).toEqual({ frame: 'fx_slash_right', rotation: -pi4 });
    expect(slashPose('left', 'downLeft').frame).toBe('fx_slash_left');
    expect(slashPose('left', 'downLeft').rotation).toBeCloseTo(-pi4, 12);
    expect(slashPose('up', 'upLeft').frame).toBe('fx_slash_left');
    expect(slashPose('up', 'upLeft').rotation).toBeCloseTo(pi4, 12);
    // la direction obtenue (angle de la cardinale + rotation) est celle de la diagonale
    const base: Record<string, number> = { fx_slash_right: 0, fx_slash_left: Math.PI };
    const expected: Record<DiagDir, number> = { downRight: pi4, upRight: -pi4, downLeft: 3 * pi4, upLeft: -3 * pi4 };
    for (const d of DIAGS) {
      const pose = slashPose('up', d);
      const a = base[pose.frame] + pose.rotation;
      expect(Math.cos(a)).toBeCloseTo(Math.cos(expected[d]), 12);
      expect(Math.sin(a)).toBeCloseTo(Math.sin(expected[d]), 12);
    }
  });
});

describe('effets de spéciaux : angle et vecteur de la visée', () => {
  it('les cardinales gardent leurs valeurs historiques', () => {
    expect(dirAngle('right')).toBe(0);
    expect(dirAngle('down')).toBe(Math.PI / 2);
    expect(dirAngle('left')).toBe(Math.PI);
    expect(dirAngle('up')).toBe(-Math.PI / 2);
    expect(dirUnit('up')).toEqual({ x: 0, y: -1 });
    expect(dirUnit('right')).toEqual({ x: 1, y: 0 });
  });

  it('les diagonales sont à ±45° / ±135° et unitaires', () => {
    expect(dirAngle('downRight')).toBeCloseTo(Math.PI / 4, 12);
    expect(dirAngle('upRight')).toBeCloseTo(-Math.PI / 4, 12);
    expect(dirAngle('downLeft')).toBeCloseTo((3 * Math.PI) / 4, 12);
    expect(dirAngle('upLeft')).toBeCloseTo((-3 * Math.PI) / 4, 12);
    for (const d of DIAGS) expect(Math.hypot(dirUnit(d).x, dirUnit(d).y)).toBeCloseTo(1, 12);
  });

  it('playAim : la diagonale de l événement si présente, sinon la direction cardinale', () => {
    const a: Aim8 = playAim({ dir: 'right', aim: 'downRight' });
    expect(a).toBe('downRight');
    expect(playAim({ dir: 'up' })).toBe('up');
  });
});

afterEach(() => setLanguage('fr'));

describe('tutoriel : coup en diagonale', () => {
  const atk = (aim?: DiagDir): SimEvent => (aim ? { type: 'playerAttack', playerId: 0, dir: 'right', aim } : { type: 'playerAttack', playerId: 0, dir: 'right' });

  it('countEvents `has` : seuls les coups portant une visée diagonale comptent', () => {
    const c: Extract<Condition, { k: 'event' }> = { k: 'event', type: 'playerAttack', by: 0, has: ['aim'] };
    expect(countEvents([atk(), atk()], c)).toBe(0);
    expect(countEvents([atk(), atk('upRight')], c)).toBe(1);
    expect(countEvents([{ ...atk('upRight'), playerId: 1 } as SimEvent], c)).toBe(0); // un autre joueur ne compte pas
  });

  it('le journal d étape ne retient QUE les coups en diagonale (pas de bruit de chaque coup cardinal)', () => {
    expect(isLoggedEvent(atk())).toBe(false);
    expect(isLoggedEvent(atk('downLeft'))).toBe(true);
    expect(isLoggedEvent({ type: 'enemyDied', enemyId: 1, kind: 'slime', pos: { x: 0, y: 0 }, byPlayer: 0 })).toBe(true);
  });

  it('étape `diagonal` : dans la salle de combat, après `attack`, validée par un coup en diagonale ou par la salle vidée', () => {
    const ids = TUTORIAL_STEPS.map((s) => s.id);
    expect(ids.indexOf('diagonal')).toBe(ids.indexOf('attack') + 1);
    const step = TUTORIAL_STEPS[ids.indexOf('diagonal')];
    expect(step.room).toBe('t_yard');
    expect(step.kind).toBe('do');
    expect(JSON.stringify(step.done)).toContain('"has":["aim"]');
    expect(JSON.stringify(step.done)).toContain('enemiesGone'); // jamais de soft-lock : plus d'ennemi = étape validée
  });

  it('un joueur inactif reste sur l étape (la condition est vérifiable) ; le joueur scripté la franchit par un vrai coup en diagonale', () => {
    const idle = new TutorialRun({ strategy: 'idle' });
    for (let i = 0; i < 5; i++) idle.director.skipStep(); // welcome, move, sign, roomGoals, attack
    expect(idle.director.step.id).toBe('diagonal');
    for (let i = 0; i < 60 * 5; i++) idle.tick();
    expect(idle.director.step.id).toBe('diagonal');

    const run = new TutorialRun({});
    for (let i = 0; i < 60 * 600 && run.director.step.id !== 'diagonal'; i++) run.tick();
    expect(run.director.step.id).toBe('diagonal');
    const from = run.events.length;
    for (let i = 0; i < 60 * 30 && run.director.step.id === 'diagonal'; i++) run.tick();
    expect(run.director.step.id).not.toBe('diagonal');
    const diagAttacks = run.events.slice(from).filter((e) => e.type === 'playerAttack' && e.playerId === 0 && e.aim !== undefined);
    expect(diagAttacks.length).toBeGreaterThan(0);
    expect(run.sim.state.players[0].hp).toBeGreaterThan(0);
  });

  it('textes FR et EN présents, mêmes jetons, et ils nomment le déplacement et l attaque', () => {
    const fr = (frParts as Record<string, string>)['tutorial.step.diagonal'];
    const en = (enParts as Record<string, string>)['tutorial.step.diagonal'];
    expect(fr).toBeTruthy();
    expect(en).toBeTruthy();
    const tokens = (s: string): string[] => (s.match(/\{\w+\}/g) ?? []).sort();
    expect(tokens(fr)).toEqual(tokens(en));
    expect(tokens(fr)).toEqual(['{attack}', '{move}']);
  });

  it('texte résolu pour chaque appareil (clavier, manette, tactile) et chaque langue : lisible, sans parenthèses imbriquées ni jeton restant', () => {
    for (const lang of ['fr', 'en'] as const) {
      setLanguage(lang);
      for (const device of ['keyboard', 'gamepad', 'gamepadPs', 'touch'] as const) {
        const labels = buttonLabels(device);
        const text = t('tutorial.step.diagonal', { move: labels.move, attack: labels.attack });
        expect(text, `${lang}/${device}`).not.toMatch(/[{}]/);
        expect(text).toContain(labels.move);
        expect(text).toContain(labels.attack);
        // pas de parenthèse dans une parenthèse (le libellé clavier en contient déjà une : le texte ne doit pas en ajouter autour)
        let depth = 0;
        let max = 0;
        for (const ch of text) {
          if (ch === '(') max = Math.max(max, ++depth);
          if (ch === ')') depth--;
        }
        expect(max, `${lang}/${device} : ${text}`).toBeLessThanOrEqual(1);
        expect(text).not.toMatch(/\)\s*\(/); // ni deux parenthèses accolées
      }
    }
  });
});
