/**
 * Libellés de boutons PAR APPAREIL pour le tutoriel (PUR, testé). Les textes des étapes sont uniques et contiennent des jetons
 * (`{move}`, `{attack}`…) : AUCUNE variante par appareil dans le code des étapes. Ce module :
 *  - détermine la famille d'appareil du joueur (`resolveDevice`) : clavier, manette (Xbox / standard), manette PlayStation, tactile
 *    (manette virtuelle, indice `VIRTUAL_PAD_INDEX`) ;
 *  - produit, pour chaque nom de bouton, le texte traduit (`buttonLabels`) : au clavier, les touches COURANTES des bindings
 *    (remappage respecté), avec « Espace » / « Entrée » / « Échap » traduits (le `keyCodeLabel` du HUD les écrit en français).
 */
import type { Bindings } from '../input/actions';
import { createDefaultBindings } from '../input/defaultBindings';
import { VIRTUAL_PAD_INDEX } from '../input/VirtualPad';
import { t } from '../i18n/i18n';
import { keyCodeLabel } from '../render/hud';
import type { ButtonName, DeviceKind } from './types';

/** Tous les noms de boutons (ordre stable). */
export const BUTTON_NAMES: readonly ButtonName[] = ['move', 'action', 'attack', 'interact', 'special', 'call', 'skip', 'pause'];
/** Toutes les familles d'appareils. */
export const DEVICE_KINDS: readonly DeviceKind[] = ['keyboard', 'gamepad', 'gamepadPs', 'touch'];

/** Nom de manette PlayStation (DualShock / DualSense : identifiant navigateur « … Vendor: 054c … »). */
export function isPlayStationPad(name: string | undefined | null): boolean {
  return typeof name === 'string' && /playstation|dualshock|dualsense|054c/i.test(name);
}

/** Entrées de `resolveDevice`. */
export interface DeviceInput {
  /** Famille de l'entrée du joueur 1 (`PlayerAssignment.label`). */
  label: string;
  gamepadIndex?: number;
  gamepadName?: string;
  /** La manette virtuelle tactile est-elle connectée (visible) ? */
  virtualPadConnected: boolean;
  /** Appareil qui a lancé le tutoriel depuis le menu (si connu). */
  initialDevice?: DeviceKind;
  /** Une touche du clavier a-t-elle été pressée depuis le début du tutoriel ? */
  keyboardUsed: boolean;
}

/**
 * Famille d'appareil à afficher. En solo, l'`InputManager` démarre sur « clavier » tant qu'aucune manette n'a produit d'entrée :
 * tant qu'aucune activité clavier n'a été vue, on utilise donc l'appareil du menu (`initialDevice`), ou la manette virtuelle si
 * elle est affichée.
 */
export function resolveDevice(i: DeviceInput): DeviceKind {
  if (i.label === 'gamepad') {
    if (i.gamepadIndex === VIRTUAL_PAD_INDEX) return 'touch';
    return isPlayStationPad(i.gamepadName) ? 'gamepadPs' : 'gamepad';
  }
  if (!i.keyboardUsed) {
    if (i.initialDevice) return i.initialDevice;
    if (i.virtualPadConnected) return 'touch';
  }
  return 'keyboard';
}

/** Appareil déduit de la source de la dernière intention de menu (`'keyboard'`, `'gamepad:4'`, null = souris / toucher). */
export function initialDeviceFromMenuSource(source: string | null | undefined, padName?: string): DeviceKind | undefined {
  if (!source) return undefined;
  if (source === 'keyboard') return 'keyboard';
  const m = /^gamepad:(\d+)$/.exec(source);
  if (!m) return undefined;
  if (Number(m[1]) === VIRTUAL_PAD_INDEX) return 'touch';
  return isPlayStationPad(padName) ? 'gamepadPs' : 'gamepad';
}

/** Touches nommées en plus d'Espace / Entrée / Échap : code → clé i18n. */
const EXTRA_KEYS: Readonly<Record<string, string>> = {
  ShiftLeft: 'tutorial.key.shift',
  ShiftRight: 'tutorial.key.shift',
  ControlLeft: 'tutorial.key.ctrl',
  ControlRight: 'tutorial.key.ctrl',
  AltLeft: 'tutorial.key.alt',
  AltRight: 'tutorial.key.alt',
  Tab: 'tutorial.key.tab',
  Backspace: 'tutorial.key.backspace',
};

/** Libellé d'une touche (`KeyboardEvent.code`) : Espace / Entrée / Échap traduits, le reste via `keyCodeLabel`. */
export function keyLabel(code: string): string {
  if (code === 'Space') return t('tutorial.key.space');
  if (code === 'Enter' || code === 'NumpadEnter') return t('tutorial.key.enter');
  if (code === 'Escape') return t('tutorial.key.escape');
  // touches de modification fréquentes dans un remappage : traduites au lieu de sortir brutes (« ShiftLeft »)
  const named = EXTRA_KEYS[code];
  if (named) return t(named);
  return keyCodeLabel(code);
}

/** « Espace / E » : jusqu'à 2 touches distinctes. */
function joinKeys(codes: readonly string[]): string {
  const uniq = codes.filter((c, i) => codes.indexOf(c) === i).slice(0, 2);
  return uniq.map(keyLabel).join(' / ');
}

function sameKeys(a: Bindings['move']['keys'], b: Bindings['move']['keys']): boolean {
  return (['up', 'down', 'left', 'right'] as const).every((d) => a[d].join(',') === b[d].join(','));
}

/** Texte du déplacement au clavier : défaut (flèches / W A S D) ou touches remappées. */
function keyboardMove(b: Bindings): string {
  if (sameKeys(b.move.keys, createDefaultBindings().move.keys)) return t('tutorial.btn.move.keyboard');
  const first = (['up', 'left', 'down', 'right'] as const).map((d) => keyLabel(b.move.keys[d][0] ?? '?'));
  return t('tutorial.btn.move.custom', { keys: first.join(' ') });
}

/**
 * Libellé de chaque bouton pour l'appareil. Au clavier, lit les bindings COURANTS (défaut : `createDefaultBindings()`).
 * Ne renvoie jamais de chaîne vide (clés i18n présentes en fr et en : testé).
 */
export function buttonLabels(device: DeviceKind, bindings: Bindings = createDefaultBindings()): Record<ButtonName, string> {
  if (device === 'keyboard') {
    return {
      move: keyboardMove(bindings),
      action: t('tutorial.btn.key', { key: joinKeys(bindings.interact.keys) }),
      attack: t('tutorial.btn.key', { key: joinKeys(bindings.attack.keys) }),
      interact: t('tutorial.btn.key', { key: joinKeys(bindings.interact.keys) }),
      special: t('tutorial.btn.key', { key: joinKeys(bindings.special.keys) }),
      call: t('tutorial.btn.key', { key: joinKeys(bindings.call.keys) }),
      skip: t('tutorial.btn.skip.keyboard'),
      pause: t('tutorial.btn.pause.keyboard'),
    };
  }
  const out = {} as Record<ButtonName, string>;
  for (const name of BUTTON_NAMES) out[name] = t(`tutorial.btn.${name}.${device}`);
  return out;
}
