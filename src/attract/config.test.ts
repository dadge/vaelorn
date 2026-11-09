import { describe, expect, it } from 'vitest';
import {
  ATTRACT_DEMO_MS,
  ATTRACT_IDLE_MS,
  ATTRACT_RETURN_GRACE_MS,
  defaultAttractConfig,
  getAttractConfig,
  parseAttractParams,
  setAttractConfig,
} from './config';
import { isSavingAllowed } from '../render/saveMenuLogic';

describe('constantes du mode démo', () => {
  it('conventions d\'arcade : 60 s d\'inactivité, 30 s de démo, grâce de 400 ms', () => {
    expect(ATTRACT_IDLE_MS).toBe(60_000);
    expect(ATTRACT_DEMO_MS).toBe(30_000);
    expect(ATTRACT_RETURN_GRACE_MS).toBe(400);
  });
});

describe('parseAttractParams', () => {
  it('par défaut : activée, 60 s / 30 s', () => {
    expect(parseAttractParams('')).toEqual({ enabled: true, idleMs: 60_000, demoMs: 30_000 });
    expect(parseAttractParams('?lang=en&touch=1').enabled).toBe(true);
  });

  it('?attract=0 désactive (aussi false / no / off)', () => {
    for (const v of ['0', 'false', 'no', 'off']) expect(parseAttractParams(`?attract=${v}`).enabled).toBe(false);
  });

  it('?attractIdle et ?attractDemo (secondes)', () => {
    const c = parseAttractParams('?attractIdle=5&attractDemo=10');
    expect(c).toEqual({ enabled: true, idleMs: 5000, demoMs: 10_000 });
    expect(parseAttractParams('?attractIdle=2.5').idleMs).toBe(2500);
  });

  it('valeurs illisibles ou hors bornes : valeur par défaut', () => {
    for (const bad of ['abc', '', '-3', '0', 'NaN', '99999']) {
      expect(parseAttractParams(`?attractIdle=${bad}`).idleMs, bad).toBe(60_000);
    }
    for (const bad of ['abc', '', '1', '-2', '0', '99999']) {
      expect(parseAttractParams(`?attractDemo=${bad}`).demoMs, bad).toBe(30_000);
    }
  });

  it('mode de test (quick, tutorial, nosave, dark, dev) : désactivée, sauf ?attract=1 explicite', () => {
    expect(parseAttractParams('?quick=1').enabled).toBe(false);
    expect(parseAttractParams('', { quick: true }).enabled).toBe(false);
    expect(parseAttractParams('', { tutorial: true }).enabled).toBe(false);
    expect(parseAttractParams('?tutorial=1').enabled).toBe(false);
    expect(parseAttractParams('?nosave=1').enabled).toBe(false);
    expect(parseAttractParams('?dark=1').enabled).toBe(false);
    expect(parseAttractParams('?dev=bosses').enabled).toBe(false);
    expect(parseAttractParams('?quick=1&attract=1').enabled).toBe(true);
    expect(parseAttractParams('?nosave=1&attract=1&attractIdle=3').enabled).toBe(true);
    expect(parseAttractParams('?quick=1&attract=0').enabled).toBe(false);
  });

  it('une chaîne de requête illisible ne lève pas', () => {
    expect(() => parseAttractParams('%%%')).not.toThrow();
    expect(parseAttractParams('%%%').enabled).toBe(true);
  });
});

describe('configuration courante', () => {
  it('set / get (copie défensive)', () => {
    const cfg = defaultAttractConfig();
    setAttractConfig({ ...cfg, enabled: false, idleMs: 1234 });
    expect(getAttractConfig()).toEqual({ enabled: false, idleMs: 1234, demoMs: 30_000 });
    setAttractConfig(defaultAttractConfig());
    expect(getAttractConfig().enabled).toBe(true);
  });
});

describe('sauvegarde : jamais en démo', () => {
  it('isSavingAllowed vaut false quand demo est vrai, quoi qu\'il y ait dans l\'URL', () => {
    expect(isSavingAllowed({ quick: false, search: '' })).toBe(true);
    expect(isSavingAllowed({ quick: false, search: '', demo: true })).toBe(false);
    expect(isSavingAllowed({ quick: false, search: '?lang=en', demo: true })).toBe(false);
    expect(isSavingAllowed({ quick: false, search: '', demo: false })).toBe(true);
  });
});
