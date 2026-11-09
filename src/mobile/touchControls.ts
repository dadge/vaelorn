/**
 * Manette virtuelle tactile (couche DOM mince). Toute la logique (état des boutons par pointeur, stick → axes,
 * instantané de manette standard) est dans `src/input/VirtualPad.ts` (pure, testée). Ce fichier ne fait que :
 *  - créer les éléments (stick à gauche ; losange A / B / X / Y à droite, le X étant le bouton APPEL ; PAUSE en haut au centre) ;
 *  - brancher les Pointer Events (multi-touch : chaque contrôle suit SON pointerId via `setPointerCapture`) ;
 *  - mettre à jour l'aspect (enfoncé) et décider de l'affichage (tactile + paysage, ou `?touch=1` ; masquée dès qu'une
 *    vraie manette est connectée ; `?touch=0` la force cachée) avec `shouldShowVirtualPad` (device.ts).
 * La manette virtuelle est enregistrée comme manette « extra » (`registerExtraGamepad`) : l'InputManager, les menus,
 * l'écran « rejoindre » et la pause la lisent comme une vraie manette d'indice `VIRTUAL_PAD_INDEX`.
 * Aucune erreur ne doit jamais empêcher de jouer : tout est protégé.
 */
import { defaultGamepadProvider, listGamepads, registerExtraGamepad } from '../input/GamepadSource';
import { inputManager } from '../input/InputManager';
import {
  BUTTON_SLIDE_TOLERANCE,
  VIRTUAL_PAD_INDEX,
  VirtualPad,
  hasRealGamepad,
  isInsideCircle,
  type VirtualButton,
} from '../input/VirtualPad';
import { handOverToRealPad, handOverToVirtualPad } from '../input/virtualPadHandover';
import { onLanguageChange, t } from '../i18n/i18n';
import { computeMobileUi, isPortrait, parseTouchParam, shouldShowVirtualPad } from './device';
import { readEnvironment } from './mobileUi';

/** Période (ms) du sondage léger des vraies manettes (certains navigateurs n'émettent pas `gamepadconnected` sans appui). */
const POLL_MS = 500;
/** Durée (ms) du retour haptique à l'appui d'un bouton. */
const HAPTIC_MS = 10;

const STYLE = `
#touch-controls {
  position: fixed; inset: 0; z-index: 800; pointer-events: none; overflow: hidden;
  --vp-base: clamp(88px, min(30vmin, 28vw), 150px);
  --vp-margin: 16px;
  --vp-rest: 0.45;
  font-family: 'Trebuchet MS', 'Segoe UI', sans-serif;
  touch-action: none; -webkit-user-select: none; user-select: none; -webkit-touch-callout: none;
}
#touch-controls[hidden] { display: none; }
#touch-controls * { box-sizing: border-box; touch-action: none; -webkit-user-select: none; user-select: none; -webkit-tap-highlight-color: transparent; }
#touch-controls .vp-stick {
  position: absolute; pointer-events: auto; width: var(--vp-base); height: var(--vp-base); border-radius: 50%;
  left: calc(env(safe-area-inset-left, 0px) + var(--vp-margin)); bottom: calc(env(safe-area-inset-bottom, 0px) + var(--vp-margin));
  background: rgba(240, 226, 176, 0.14); border: 2px solid rgba(240, 226, 176, 0.75); opacity: var(--vp-rest);
}
#touch-controls .vp-stick::before { content: ''; position: absolute; inset: -30%; border-radius: 50%; }
#touch-controls .vp-knob {
  position: absolute; left: 50%; top: 50%; width: calc(var(--vp-base) * 0.43); height: calc(var(--vp-base) * 0.43);
  margin: calc(var(--vp-base) * -0.215) 0 0 calc(var(--vp-base) * -0.215); border-radius: 50%; pointer-events: none;
  background: rgba(255, 210, 122, 0.6); border: 2px solid rgba(255, 232, 176, 0.95);
  transform: translate(var(--kx, 0px), var(--ky, 0px));
}
#touch-controls .vp-cluster {
  position: absolute; pointer-events: none; width: calc(var(--vp-base) * 1.25); height: calc(var(--vp-base) * 1.25);
  right: calc(env(safe-area-inset-right, 0px) + var(--vp-margin)); bottom: calc(env(safe-area-inset-bottom, 0px) + var(--vp-margin));
}
#touch-controls .vp-btn {
  position: absolute; pointer-events: auto; display: flex; align-items: center; justify-content: center; border-radius: 50%;
  width: var(--s); height: var(--s); left: calc(var(--cx) - var(--s) / 2); top: calc(var(--cy) - var(--s) / 2);
  background: rgba(11, 10, 20, 0.55); border: 2px solid rgba(240, 226, 176, 0.75); color: #f0e2b0;
  font-weight: 700; font-size: calc(var(--s) * 0.5); line-height: 1; opacity: var(--vp-rest);
  transition: transform 60ms ease-out, opacity 60ms ease-out, background-color 60ms ease-out;
}
#touch-controls .vp-btn::before { content: ''; position: absolute; inset: -12%; border-radius: 50%; }
#touch-controls .vp-a { --s: calc(var(--vp-base) * 0.5); --cx: calc(var(--vp-base) * 0.625); --cy: calc(var(--vp-base) * 0.995); border-color: #ffd27a; color: #ffd27a; }
#touch-controls .vp-b { --s: max(36px, calc(var(--vp-base) * 0.38)); --cx: calc(var(--vp-base) * 0.995); --cy: calc(var(--vp-base) * 0.625); }
#touch-controls .vp-y { --s: max(36px, calc(var(--vp-base) * 0.38)); --cx: calc(var(--vp-base) * 0.625); --cy: calc(var(--vp-base) * 0.255); }
#touch-controls .vp-call { --s: max(36px, calc(var(--vp-base) * 0.38)); --cx: calc(var(--vp-base) * 0.255); --cy: calc(var(--vp-base) * 0.625); }
#touch-controls .vp-pause {
  --s: clamp(34px, calc(var(--vp-base) * 0.34), 46px); position: absolute; pointer-events: auto; border-radius: 50%;
  width: var(--s); height: var(--s); top: calc(env(safe-area-inset-top, 0px) + 8px); left: 50%; margin-left: calc(var(--s) / -2);
  display: flex; align-items: center; justify-content: center; opacity: var(--vp-rest);
  background: rgba(11, 10, 20, 0.55); border: 2px solid rgba(240, 226, 176, 0.75);
  transition: transform 60ms ease-out, opacity 60ms ease-out, background-color 60ms ease-out;
}
#touch-controls .vp-pause::before { content: ''; position: absolute; inset: -20%; border-radius: 50%; }
#touch-controls .vp-icon { width: 58%; height: 58%; pointer-events: none; }
#touch-controls .vp-letter { pointer-events: none; }
#touch-controls .vp-btn.vp-down, #touch-controls .vp-pause.vp-down { opacity: 1; transform: scale(1.14); background: rgba(255, 210, 122, 0.45); }
#touch-controls .vp-stick.vp-down { opacity: 0.9; }
@media (prefers-reduced-motion: reduce) { #touch-controls .vp-btn, #touch-controls .vp-pause { transition: none; } }
`;

/** Icône pause (deux barres). */
const PAUSE_ICON = `<svg class="vp-icon" viewBox="0 0 24 24" fill="#f0e2b0" aria-hidden="true" focusable="false"><rect x="6" y="4.5" width="4.2" height="15" rx="1.2"/><rect x="13.8" y="4.5" width="4.2" height="15" rx="1.2"/></svg>`;

export interface TouchControlsHandle {
  /** La manette virtuelle (pour inspection / tests manuels). */
  readonly pad: VirtualPad;
  /** Retire l'overlay et la manette extra. */
  destroy(): void;
}

function haptic(): void {
  try {
    if (typeof navigator.vibrate === 'function') navigator.vibrate(HAPTIC_MS);
  } catch {
    /* vibration non prise en charge / bloquée : sans importance */
  }
}

/** Installe la manette virtuelle. À appeler une fois, après `installMobileUi`. Ne lève jamais (retourne null en cas d'échec). */
export function installTouchControls(): TouchControlsHandle | null {
  try {
    return build();
  } catch {
    return null;
  }
}

function build(): TouchControlsHandle {
  const param = parseTouchParam(window.location.search);
  const pad = new VirtualPad({ label: t('touch.padName') });
  const unregister = registerExtraGamepad(() => pad.asExtraGamepad());

  const style = document.createElement('style');
  style.id = 'touch-controls-style';
  style.textContent = STYLE;

  const root = document.createElement('div');
  root.id = 'touch-controls';
  root.hidden = true;
  root.setAttribute('role', 'group');
  for (const type of ['contextmenu', 'dragstart', 'selectstart']) root.addEventListener(type, (e) => e.preventDefault());

  // ───────────── Éléments ─────────────
  const stick = document.createElement('div');
  stick.className = 'vp-stick';
  stick.setAttribute('role', 'group');
  const knob = document.createElement('div');
  knob.className = 'vp-knob';
  stick.append(knob);

  const cluster = document.createElement('div');
  cluster.className = 'vp-cluster';

  interface ButtonView {
    button: VirtualButton;
    el: HTMLElement;
    /** Pointeurs qui ont commencé sur ce bouton (et le suivent par capture). */
    pointers: Set<number>;
  }
  const views: ButtonView[] = [];
  const makeButton = (button: VirtualButton, className: string, content: string | null, html: string | null): ButtonView => {
    const el = document.createElement('div');
    el.className = className;
    el.setAttribute('role', 'button');
    if (content !== null) {
      const letter = document.createElement('span');
      letter.className = 'vp-letter';
      letter.setAttribute('aria-hidden', 'true');
      letter.textContent = content; // lettre du bouton (A B Y) : identique dans toutes les langues
      el.append(letter);
    } else if (html !== null) {
      el.innerHTML = html; // SVG statique défini dans ce fichier
    }
    const view: ButtonView = { button, el, pointers: new Set() };
    views.push(view);
    return view;
  };
  const a = makeButton('a', 'vp-btn vp-a', 'A', null);
  const b = makeButton('b', 'vp-btn vp-b', 'B', null);
  const y = makeButton('y', 'vp-btn vp-y', 'Y', null);
  const call = makeButton('call', 'vp-btn vp-call', 'X', null); // lettre X (l'appel est LB) : le losange garde A B X Y
  const pause = makeButton('pause', 'vp-pause', null, PAUSE_ICON);
  cluster.append(y.el, call.el, b.el, a.el);
  root.append(stick, cluster, pause.el);

  const labels = (): void => {
    pad.setLabel(t('touch.padName'));
    root.setAttribute('aria-label', t('touch.group'));
    stick.setAttribute('aria-label', t('touch.stick'));
    a.el.setAttribute('aria-label', t('touch.a'));
    b.el.setAttribute('aria-label', t('touch.b'));
    y.el.setAttribute('aria-label', t('touch.y'));
    call.el.setAttribute('aria-label', t('touch.call'));
    pause.el.setAttribute('aria-label', t('touch.pause'));
  };
  labels();
  const offLanguage = onLanguageChange(labels);

  // ───────────── Aspect ─────────────
  const setKnob = (kx: number, ky: number): void => {
    knob.style.setProperty('--kx', `${kx.toFixed(1)}px`);
    knob.style.setProperty('--ky', `${ky.toFixed(1)}px`);
  };
  const render = (): void => {
    for (const v of views) {
      const down = pad.isButtonDown(v.button);
      v.el.classList.toggle('vp-down', down);
      v.el.setAttribute('aria-pressed', down ? 'true' : 'false');
    }
    stick.classList.toggle('vp-down', pad.isStickActive());
    if (!pad.isStickActive()) setKnob(0, 0);
  };

  // ───────────── Stick ─────────────
  let stickPointer: number | null = null;
  let stickCx = 0;
  let stickCy = 0;
  let stickRadius = 1;
  /** Fraction du débattement des axes utilisée visuellement : le bouton du stick reste DANS la base (rayon - rayon du bouton). */
  let knobTravel = 1;
  stick.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const rect = stick.getBoundingClientRect();
    stickCx = rect.left + rect.width / 2;
    stickCy = rect.top + rect.height / 2;
    stickRadius = rect.width / 2;
    knobTravel = rect.width > 0 ? Math.max(0, 1 - knob.offsetWidth / rect.width) : 1;
    const r = pad.beginStick(e.pointerId, e.clientX - stickCx, e.clientY - stickCy, stickRadius);
    if (!r) return;
    stickPointer = e.pointerId;
    try {
      stick.setPointerCapture(e.pointerId);
    } catch {
      /* capture impossible (pointeur déjà terminé) */
    }
    setKnob(r.knobX * knobTravel, r.knobY * knobTravel);
    render();
  });
  stick.addEventListener('pointermove', (e) => {
    if (e.pointerId !== stickPointer) return;
    e.preventDefault();
    const r = pad.moveStick(e.pointerId, e.clientX - stickCx, e.clientY - stickCy, stickRadius);
    if (r) setKnob(r.knobX * knobTravel, r.knobY * knobTravel);
  });
  const endStick = (e: PointerEvent): void => {
    if (e.pointerId !== stickPointer) return;
    stickPointer = null;
    pad.releasePointer(e.pointerId);
    render();
  };
  stick.addEventListener('pointerup', endStick);
  stick.addEventListener('pointercancel', endStick);
  stick.addEventListener('lostpointercapture', endStick);

  // ───────────── Boutons ─────────────
  for (const v of views) {
    const { el, button, pointers } = v;
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (!pad.pressButton(e.pointerId, button)) return;
      pointers.add(e.pointerId);
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* capture impossible */
      }
      haptic();
      render();
    });
    el.addEventListener('pointermove', (e) => {
      if (!pointers.has(e.pointerId)) return;
      // Sous capture, `pointerleave` ne part pas : on teste la position (glisser hors du bouton le relâche, y revenir le ré-appuie).
      // Le centre vient du rectangle (le `scale` d'appui est centré), le rayon de `offsetWidth` (insensible aux transformations).
      const rect = el.getBoundingClientRect();
      const inside = isInsideCircle(
        e.clientX,
        e.clientY,
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
        (el.offsetWidth / 2) * BUTTON_SLIDE_TOLERANCE,
      );
      if (inside && !pad.isPointerActive(e.pointerId)) {
        if (pad.pressButton(e.pointerId, button)) {
          haptic();
          render();
        }
      } else if (!inside && pad.isPointerActive(e.pointerId)) {
        pad.releasePointer(e.pointerId);
        render();
      }
    });
    const end = (e: PointerEvent): void => {
      if (!pointers.delete(e.pointerId)) return;
      pad.releasePointer(e.pointerId);
      render();
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('lostpointercapture', end);
  }

  // ───────────── Relâchement général / visibilité ─────────────
  const releaseEverything = (): void => {
    pad.releaseAll();
    stickPointer = null;
    for (const v of views) v.pointers.clear();
    render();
  };

  /**
   * Le joueur inscrit avec la manette virtuelle suit l'appareil utilisable : vraie manette apparue (overlay masqué) →
   * il la reprend ; vraie manette disparue (overlay réaffiché) → il reprend la manette virtuelle. Sinon il resterait
   * « déconnecté » (pause sans issue) alors qu'un appareil est disponible (cf. `virtualPadHandover.ts`).
   */
  const handOver = (shown: boolean, realGamepad: boolean): void => {
    try {
      const list = listGamepads();
      if (shown) handOverToVirtualPad(inputManager, list.map((g) => g.index));
      else if (realGamepad) handOverToRealPad(inputManager, list.filter((g) => g.index < VIRTUAL_PAD_INDEX).map((g) => g.index));
    } catch {
      /* jamais bloquant */
    }
  };

  let visible = false;
  let lastLandscape: boolean | null = null;
  const update = (): void => {
    try {
      const env = readEnvironment();
      const landscape = !isPortrait(env.width, env.height);
      if (lastLandscape !== null && landscape !== lastLandscape) releaseEverything(); // rotation
      lastLandscape = landscape;
      const realGamepad = hasRealGamepad(defaultGamepadProvider());
      const next = shouldShowVirtualPad({
        touch: computeMobileUi(env).touch,
        landscape,
        param,
        realGamepad,
      });
      if (next === visible) return;
      visible = next;
      if (!next) releaseEverything(); // masquée : manette déconnectée ET aucun appui résiduel
      pad.setConnected(next);
      root.hidden = !next;
      handOver(next, realGamepad);
    } catch {
      /* jamais bloquant */
    }
  };

  const onBlur = (): void => releaseEverything();
  const onOrientation = (): void => {
    releaseEverything();
    update();
  };
  const onVisibility = (): void => {
    if (document.visibilityState !== 'visible') releaseEverything();
    update();
  };
  // Écouteurs (retirés par `destroy`)
  const listen = <T extends EventTarget>(target: T | undefined | null, type: string, fn: () => void): void => {
    if (!target) return;
    target.addEventListener(type, fn);
    cleanups.push(() => target.removeEventListener(type, fn));
  };
  const cleanups: Array<() => void> = [];
  listen(window, 'blur', onBlur);
  listen(window, 'pagehide', onBlur);
  listen(window, 'orientationchange', onOrientation);
  listen(document, 'visibilitychange', onVisibility);
  listen(window, 'resize', update);
  listen(window.visualViewport, 'resize', update);
  // Plein écran : seul l'élément plein écran (le div que Phaser crée autour du canvas) et ses descendants sont rendus ;
  // l'overlay doit donc y être rattaché, puis revenir dans <body> à la sortie (Phaser retire alors son div). Notre écouteur
  // s'enregistre APRÈS celui de Phaser (le jeu est créé avant) ; quel que soit l'ordre, le résultat est le même.
  // Le déplacement dans le DOM coupe les captures de pointeur : on relâche tout.
  const reparent = (): void => {
    try {
      const doc = document as Document & { webkitFullscreenElement?: Element | null };
      const host = doc.fullscreenElement ?? doc.webkitFullscreenElement ?? document.body;
      if (root.parentNode !== host) {
        releaseEverything();
        host.append(root);
      }
    } catch {
      /* jamais bloquant */
    }
  };
  const onFullscreen = (): void => {
    reparent();
    update();
  };
  listen(document, 'fullscreenchange', onFullscreen);
  listen(document, 'webkitfullscreenchange', onFullscreen);
  listen(window, 'gamepadconnected', update);
  listen(window, 'gamepaddisconnected', update);
  const timer = window.setInterval(update, POLL_MS);

  document.head.append(style);
  document.body.append(root);
  update();

  return {
    pad,
    destroy(): void {
      window.clearInterval(timer);
      for (const c of cleanups) c();
      offLanguage();
      unregister();
      releaseEverything();
      pad.setConnected(false);
      root.remove();
      style.remove();
    },
  };
}
