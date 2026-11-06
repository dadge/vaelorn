/**
 * Tests de la logique pure « rejoindre par bouton » (emplacements de joueurs), des paramètres de démarrage rapide
 * `pads` / `kb`, de l'affichage des appareils et des clés i18n de la mission manette (parité fr/en).
 */
import { describe, expect, it } from 'vitest';
import { CHARACTERS, CHARACTER_IDS } from '../core/characters';
import { getDictionary } from '../i18n/i18n';
import { InputManager } from '../input/InputManager';
import { KeyboardSource } from '../input/KeyboardSource';
import {
  allClaimed,
  applyQuickDevices,
  claimSlot,
  claimSlotAt,
  claimedCount,
  createSlots,
  describeAssignment,
  describeSlotDevice,
  getMenuDevice,
  parseQuickParams,
  quickDeviceAssignments,
  releaseSlot,
  setMenuDevice,
  shortPadName,
  slotOf,
  slotsToDevices,
} from './menuLogic';

describe('emplacements de joueurs (rejoindre par bouton)', () => {
  it('N = 1..4 : créés libres', () => {
    for (let n = 1; n <= 4; n++) {
      const s = createSlots(n);
      expect(s.owners).toHaveLength(n);
      expect(claimedCount(s)).toBe(0);
      expect(allClaimed(s)).toBe(false);
    }
    expect(createSlots(9).owners).toHaveLength(4);
    expect(createSlots(0).owners).toHaveLength(1);
  });

  it("le premier appareil actif réclame le plus petit emplacement libre ; un appareil = un emplacement", () => {
    let s = createSlots(3);
    const a = claimSlot(s, 'gamepad:2');
    expect(a).toMatchObject({ result: 'claimed', slot: 0 });
    s = a.slots;
    expect(claimSlot(s, 'gamepad:2')).toMatchObject({ result: 'already', slot: 0 });
    const b = claimSlot(s, 'keyboard');
    expect(b).toMatchObject({ result: 'claimed', slot: 1 });
    s = b.slots;
    s = claimSlot(s, 'gamepad:0').slots;
    expect(allClaimed(s)).toBe(true);
    expect(s.owners).toEqual(['gamepad:2', 'keyboard', 'gamepad:0']);
    expect(claimSlot(s, 'gamepad:1')).toMatchObject({ result: 'full', slot: -1 });
  });

  it('immuabilité : la réclamation ne modifie pas l\'état précédent', () => {
    const s = createSlots(2);
    const r = claimSlot(s, 'keyboard');
    expect(s.owners).toEqual([null, null]);
    expect(r.slots).not.toBe(s);
  });

  it('relâcher libère l\'emplacement ; le suivant le reprend', () => {
    let s = createSlots(2);
    s = claimSlot(s, 'gamepad:0').slots;
    s = claimSlot(s, 'gamepad:1').slots;
    const rel = releaseSlot(s, 'gamepad:0');
    expect(rel.slot).toBe(0);
    expect(rel.slots.owners).toEqual([null, 'gamepad:1']);
    expect(releaseSlot(rel.slots, 'keyboard')).toMatchObject({ slot: -1 });
    expect(claimSlot(rel.slots, 'keyboard')).toMatchObject({ result: 'claimed', slot: 0 });
    expect(slotOf(rel.slots, 'gamepad:1')).toBe(1);
  });

  it('claimSlotAt (souris) : emplacement précis, refusé si occupé ou appareil déjà inscrit', () => {
    const s = createSlots(3);
    const a = claimSlotAt(s, 2, 'keyboard');
    expect(a).toMatchObject({ result: 'claimed', slot: 2 });
    expect(claimSlotAt(a.slots, 1, 'keyboard')).toMatchObject({ result: 'already', slot: 2 });
    expect(claimSlotAt(a.slots, 2, 'gamepad:0')).toMatchObject({ result: 'full' });
    expect(claimSlotAt(s, 7, 'gamepad:0')).toMatchObject({ result: 'full' });
  });

  it('4 joueurs : 4 manettes sans clavier, puis application à l\'InputManager', () => {
    let s = createSlots(4);
    for (const id of ['gamepad:3', 'gamepad:0', 'gamepad:1', 'gamepad:2']) s = claimSlot(s, id).slots;
    expect(allClaimed(s)).toBe(true);
    const devices = slotsToDevices(s);
    expect(devices).toEqual([
      { kind: 'gamepad', index: 3 },
      { kind: 'gamepad', index: 0 },
      { kind: 'gamepad', index: 1 },
      { kind: 'gamepad', index: 2 },
    ]);
    const keyboard = new KeyboardSource(undefined, null);
    const mgr = new InputManager({ keyboard, storage: null, padEventTarget: null, playerCount: 4, gamepadProvider: () => [] });
    devices.forEach((d, i) => mgr.assignDevice(i as 0 | 1 | 2 | 3, d));
    expect(mgr.getAssignments().map((a) => a.device)).toEqual(devices);
    expect(mgr.getAssignments().some((a) => a.label === 'keyboard')).toBe(false);
  });

  it('1 joueur : un seul emplacement, le clavier peut le réclamer', () => {
    let s = createSlots(1);
    s = claimSlot(s, 'keyboard').slots;
    expect(allClaimed(s)).toBe(true);
    expect(claimSlot(s, 'gamepad:0').result).toBe('full');
    expect(slotsToDevices(s)).toEqual([{ kind: 'keyboard' }]);
  });

  it('mémoire du périphérique du menu', () => {
    setMenuDevice('gamepad:1');
    expect(getMenuDevice()).toBe('gamepad:1');
    setMenuDevice(null);
    expect(getMenuDevice()).toBeNull();
  });
});

describe('affichage des appareils', () => {
  it('emplacement libre / clavier / manette nommée / sans nom / débranchée / non standard', () => {
    expect(describeSlotDevice(null)).toMatchObject({ labelKey: 'pad.slot.empty', claimed: false });
    expect(describeSlotDevice('keyboard')).toMatchObject({ labelKey: 'pad.slot.keyboard', claimed: true });
    const v = describeSlotDevice('gamepad:1', [{ index: 1, name: 'Xbox 360 Controller (XInput STANDARD GAMEPAD)' }]);
    expect(v).toMatchObject({ labelKey: 'pad.slot.gamepad', params: { n: 2, name: 'Xbox 360 Controller' }, missing: false });
    expect(describeSlotDevice('gamepad:0', [{ index: 0, name: '' }])).toMatchObject({ labelKey: 'pad.slot.gamepadNoName', params: { n: 1 } });
    expect(describeSlotDevice('gamepad:2', [])).toMatchObject({ missing: true, claimed: true });
    expect(describeSlotDevice('gamepad:0', [{ index: 0, name: 'Pad', nonStandard: true }]).nonStandard).toBe(true);
  });

  it('shortPadName : retire les parenthèses techniques et tronque', () => {
    expect(shortPadName('Xbox 360 Controller (XInput STANDARD GAMEPAD)')).toBe('Xbox 360 Controller');
    expect(shortPadName('054c-09cc-Wireless Controller')).toBe('054c-09cc-Wireless Co…');
    expect(shortPadName('', 10)).toBe('');
    expect(shortPadName(undefined)).toBe('');
    expect(shortPadName('(Vendor: 045e)')).not.toBe('');
  });

  it('describeAssignment : info « non standard »', () => {
    const v = describeAssignment({ playerId: 1, label: 'gamepad', connected: true, assigned: true, gamepadIndex: 0, nonStandard: true });
    expect(v.infoKey).toBe('pad.nonStandard');
  });
});

describe('démarrage rapide : pads=1 et kb=n', () => {
  it('sans pads ni kb : comportement par défaut conservé (aucune attribution)', () => {
    const q = parseQuickParams('?quick=1&players=3');
    expect(q.pads).toBe(false);
    expect(q.keyboardPlayer).toBeNull();
    expect(quickDeviceAssignments(q)).toBeNull();
  });

  it('pads=1 : tous sur manettes 0..N-1', () => {
    const q = parseQuickParams('?quick=1&players=3&pads=1');
    expect(quickDeviceAssignments(q)).toEqual([
      { kind: 'gamepad', index: 0 },
      { kind: 'gamepad', index: 1 },
      { kind: 'gamepad', index: 2 },
    ]);
  });

  it('kb=n : le joueur n (1-based) au clavier, les autres sur manettes 0, 1…', () => {
    const q = parseQuickParams('?quick=1&players=3&kb=2');
    expect(q.keyboardPlayer).toBe(1);
    expect(quickDeviceAssignments(q)).toEqual([{ kind: 'gamepad', index: 0 }, { kind: 'keyboard' }, { kind: 'gamepad', index: 1 }]);
    expect(parseQuickParams('?quick=1&players=2&pads=1&kb=1').keyboardPlayer).toBe(0);
  });

  it('kb invalide (hors plage, non numérique) ignoré ; 1 joueur', () => {
    expect(parseQuickParams('?quick=1&players=2&kb=3').keyboardPlayer).toBeNull();
    expect(parseQuickParams('?quick=1&players=2&kb=abc').keyboardPlayer).toBeNull();
    expect(quickDeviceAssignments(parseQuickParams('?quick=1&pads=1'))).toEqual([{ kind: 'gamepad', index: 0 }]);
  });

  it('applyQuickDevices applique les attributions à un gestionnaire', () => {
    const calls: unknown[] = [];
    const target = { assignDevice: (p: number, d: unknown) => calls.push([p, d]) };
    expect(applyQuickDevices(parseQuickParams('?quick=1&players=2'), target)).toBe(false);
    expect(calls).toHaveLength(0);
    expect(applyQuickDevices(parseQuickParams('?quick=1&players=2&pads=1'), target)).toBe(true);
    expect(calls).toEqual([
      [0, { kind: 'gamepad', index: 0 }],
      [1, { kind: 'gamepad', index: 1 }],
    ]);
  });
});

describe('i18n de la mission manette', () => {
  const fr = getDictionary('fr');
  const en = getDictionary('en');
  const padKeys = (d: Readonly<Record<string, string>>): string[] => Object.keys(d).filter((k) => k.startsWith('pad.')).sort();
  const placeholders = (s: string): string[] => (s.match(/\{[a-zA-Z]+\}/g) ?? []).sort();

  it('clés pad.* : parité fr/en, aucune valeur vide, mêmes {placeholders}', () => {
    expect(padKeys(fr).length).toBeGreaterThan(15);
    expect(padKeys(fr)).toEqual(padKeys(en));
    for (const k of padKeys(fr)) {
      expect(fr[k].trim(), k).not.toBe('');
      expect(en[k].trim(), k).not.toBe('');
      expect(placeholders(fr[k]), k).toEqual(placeholders(en[k]));
    }
  });

  it('les clés utilisées par les scènes existent', () => {
    for (const k of ['pad.slot.empty', 'pad.slot.emptyKb', 'pad.slot.keyboard', 'pad.slot.gamepad', 'pad.slot.gamepadNoName', 'pad.slot.missing', 'pad.select.special', 'pad.select.joined', 'pad.game.disconnected', 'pad.menu.hint', 'pad.nonStandard']) {
      expect(fr[k], k).toBeTruthy();
    }
    expect(fr['pad.game.disconnected']).toContain('Manette du joueur {n} déconnectée');
  });

  it('chaque personnage déclare une attaque spéciale (nameKey / descKey normalisés)', () => {
    for (const id of CHARACTER_IDS) {
      const sp = CHARACTERS[id].special;
      expect(sp, id).toBeDefined();
      expect(sp?.nameKey).toBe(`character.${id}.special.name`);
    }
  });
});
