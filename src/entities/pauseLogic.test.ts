import { describe, expect, it } from 'vitest';
import { effectivePauseOwner, pauseIntentAllowed, pauseOwnerForPad, resolvePauseBack, resolvePauseConfirm } from './pauseLogic';

describe('menu pause : propriétaire (constat 4)', () => {
  it('seule la source qui a ouvert la pause est écoutée', () => {
    const owner = pauseOwnerForPad(1);
    expect(pauseIntentAllowed(owner, 'gamepad:1')).toBe(true);
    expect(pauseIntentAllowed(owner, 'gamepad:0')).toBe(false);
    expect(pauseIntentAllowed(owner, 'gamepad:2')).toBe(false);
    expect(pauseIntentAllowed(owner, 'keyboard')).toBe(false);
    expect(pauseIntentAllowed('keyboard', 'gamepad:0')).toBe(false);
    expect(pauseIntentAllowed('keyboard', 'keyboard')).toBe(true);
  });

  it('pause de déconnexion (sans propriétaire) : tout le monde peut piloter', () => {
    expect(pauseIntentAllowed(null, 'gamepad:3')).toBe(true);
    expect(pauseIntentAllowed(null, 'keyboard')).toBe(true);
  });

  it('manette propriétaire débranchée : la pause redevient pilotable par tous', () => {
    expect(effectivePauseOwner('gamepad:1', [0, 1])).toBe('gamepad:1');
    expect(effectivePauseOwner('gamepad:1', [0])).toBeNull();
    expect(effectivePauseOwner('keyboard', [])).toBe('keyboard');
    expect(effectivePauseOwner(null, [0])).toBeNull();
  });
});

describe('menu pause : confirmation avant de quitter (constat 4)', () => {
  it('« Quitter » ne quitte pas directement : il demande confirmation', () => {
    expect(resolvePauseConfirm(false, 'quit')).toBe('askQuit');
    expect(resolvePauseConfirm(false, 'resume')).toBe('resume');
  });

  it('dans la confirmation : « Non » (ligne 0, défaut) annule, « Oui » quitte', () => {
    expect(resolvePauseConfirm(true, 'resume')).toBe('cancelQuit');
    expect(resolvePauseConfirm(true, 'quit')).toBe('quit');
  });

  it('« retour » annule la confirmation, sinon reprend', () => {
    expect(resolvePauseBack(true)).toBe('cancelQuit');
    expect(resolvePauseBack(false)).toBe('resume');
  });

  it('un seul « confirmer » depuis « Reprendre » ne peut jamais quitter', () => {
    // down + confirm (Quitter) puis confirm sur la confirmation : 3 gestes ; un confirm seul ne quitte jamais
    let confirming = false;
    const first = resolvePauseConfirm(confirming, 'quit');
    expect(first).not.toBe('quit');
    confirming = first === 'askQuit';
    expect(resolvePauseConfirm(confirming, 'resume')).not.toBe('quit'); // curseur remis sur « Non »
  });
});
