/**
 * Éléments DOM superposés au canvas pour le salon réseau (`NetLobbyScene`) : zones de saisie / de texte (nom, code de salon, codes d'invitation et de réponse
 * WebRTC) et boutons « Copier » / « Coller » / « Valider ».
 *
 * Pourquoi du DOM : un code WebRTC (250 à 600 caractères) se COPIE et se COLLE avec le presse-papiers du système, ce que le canvas Phaser ne sait pas faire ; les
 * API de presse-papiers n'acceptent d'ailleurs que les vrais événements `click` du DOM (geste de l'utilisateur), pas un clic relayé par la boucle de Phaser. Le clavier
 * virtuel d'un téléphone n'apparaît lui aussi que pour de vrais champs.
 *
 * Fonctionnement : la scène décrit à chaque rendu les éléments voulus (`sync(champs, boutons)`, identifiants stables) ; les éléments déjà présents sont CONSERVÉS
 * (focus, texte saisi et sélection survivent aux rendus), les nouveaux sont créés, les absents retirés. Les positions sont données en pixels LOGIQUES du jeu
 * (1280 × 720) et converties en pixels CSS d'après le rectangle réel du canvas (`layout()`, appelé à chaque image : rotation, barre d'adresse, clavier virtuel, plein
 * écran). Tailles tactiles minimales : boutons ≥ 44 px CSS, police ≥ 16 px (en dessous, iOS zoome la page au focus d'un champ).
 *
 * Aucune fuite : tous les écouteurs (éléments, fenêtre, `visualViewport`) sont retirés par `destroy()` (appelé à la fermeture de la scène). Les touches tapées dans un
 * champ ne remontent pas jusqu'à la fenêtre (le jeu ne les voit pas) ; Échap ou Entrée (champ d'une ligne) quittent le champ.
 */
import { GAME_WIDTH } from '../core/constants';
import { logicalToCss, type LogicalRect } from '../render/netLobbyLogic';
import { UI_FONT_FAMILY, UI_THEME, css } from '../render/ui';

/** Taille tactile minimale (px CSS) d'un bouton / d'un champ. */
export const MIN_TOUCH_PX = 44;
/** Police minimale (px CSS) d'un champ (iOS zoome la page sous 16 px). */
export const MIN_FONT_PX = 16;
/** Police minimale (px CSS) d'un bouton (pas de zoom au focus : on peut descendre sous 16 px, ce qui laisse tenir « Valider » dans un bouton étroit). */
export const MIN_BUTTON_FONT_PX = 14;

export interface DomFieldSpec {
  id: string;
  kind: 'input' | 'textarea';
  rect: LogicalRect;
  /** Valeur initiale (appliquée à la CRÉATION seulement : ensuite, c'est le joueur qui tient le texte). */
  value?: string;
  readOnly?: boolean;
  placeholder?: string;
  /** Libellé accessible (lecteurs d'écran) : l'étiquette dessinée dans le canvas n'est pas lisible par le navigateur. */
  label?: string;
  maxLength?: number;
  /** Appelé à chaque saisie. */
  onInput?: (value: string) => void;
}

export interface DomButtonSpec {
  id: string;
  label: string;
  rect: LogicalRect;
  enabled?: boolean;
  onClick: () => void;
}

type Field = HTMLInputElement | HTMLTextAreaElement;

interface Entry {
  kind: 'input' | 'textarea' | 'button';
  el: HTMLElement;
  rect: LogicalRect;
  onInput?: (value: string) => void;
  onClick?: () => void;
  /** Retire les écouteurs de l'élément. */
  teardown: () => void;
}

/** Texte brut copié dans le presse-papiers : `'copied'` si c'est fait, `'manual'` si le joueur doit le faire (le champ `fallback` est alors sélectionné). */
export async function copyToClipboard(text: string, fallback?: Field | null): Promise<'copied' | 'manual'> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return 'copied';
    }
  } catch {
    /* contexte non sécurisé ou autorisation refusée : repli ci-dessous */
  }
  if (fallback) {
    try {
      fallback.focus();
      fallback.select();
      fallback.setSelectionRange(0, fallback.value.length);
      if (typeof document !== 'undefined' && typeof document.execCommand === 'function' && document.execCommand('copy')) return 'copied';
    } catch {
      /* sélection impossible : le joueur copie à la main */
    }
  }
  return 'manual';
}

/** Texte du presse-papiers, ou null s'il est illisible (autorisation refusée, contexte non sécurisé) : le joueur colle alors à la main dans la zone. */
export async function readFromClipboard(): Promise<string | null> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
      const text = await navigator.clipboard.readText();
      return typeof text === 'string' ? text : null;
    }
  } catch {
    /* refusé */
  }
  return null;
}

export class NetLobbyDom {
  private readonly root: HTMLDivElement;
  private readonly entries = new Map<string, Entry>();
  private lastBox = '';
  private destroyed = false;
  private readonly relayout = (): void => {
    this.lastBox = '';
    this.layout();
  };

  /** @param canvas canvas du jeu (positions relatives à son rectangle à l'écran) ; null : repli sur la fenêtre (échelle 1). */
  constructor(private readonly canvas: HTMLCanvasElement | null) {
    this.root = document.createElement('div');
    this.root.setAttribute('data-net-lobby', '');
    // Sous le bouton plein écran (900), au-dessus de la manette tactile (800) et du canvas ; ne capte rien lui-même.
    this.root.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:850;pointer-events:none;';
    document.body.appendChild(this.root);
    window.addEventListener('resize', this.relayout);
    window.addEventListener('orientationchange', this.relayout);
    window.visualViewport?.addEventListener('resize', this.relayout);
  }

  /** true si un des champs a le focus (le clavier du téléphone est ouvert ou le joueur tape : la navigation clavier du menu doit se taire). */
  hasFocus(): boolean {
    const active = document.activeElement;
    if (!active) return false;
    for (const e of this.entries.values()) if (e.el === active && e.kind !== 'button') return true;
    return false;
  }

  /** Retire le focus du champ actif (ferme le clavier virtuel). */
  blur(): void {
    const active = document.activeElement;
    if (active instanceof HTMLElement && this.root.contains(active)) active.blur();
  }

  getValue(id: string): string {
    const e = this.entries.get(id);
    return e && e.kind !== 'button' ? (e.el as Field).value : '';
  }

  setValue(id: string, value: string): void {
    const e = this.entries.get(id);
    if (e && e.kind !== 'button') (e.el as Field).value = value;
  }

  /** Champ d'identifiant `id` (pour la sélection / la copie), ou null. */
  field(id: string): Field | null {
    const e = this.entries.get(id);
    return e && e.kind !== 'button' ? (e.el as Field) : null;
  }

  /** Donne le focus au champ (au toucher : ouvre le clavier si le navigateur l'autorise). */
  focus(id: string): void {
    this.field(id)?.focus();
  }

  /**
   * Fait correspondre les éléments à la description : crée les nouveaux, met à jour les présents (position, libellé, état), retire les absents. Les éléments conservés
   * gardent leur focus, leur texte et leur sélection.
   */
  sync(fields: readonly DomFieldSpec[], buttons: readonly DomButtonSpec[]): void {
    if (this.destroyed) return;
    const wanted = new Set<string>();
    for (const spec of fields) {
      wanted.add(spec.id);
      let e = this.entries.get(spec.id);
      if (e && e.kind !== spec.kind) {
        this.remove(spec.id);
        e = undefined;
      }
      if (!e) e = this.createField(spec);
      e.rect = spec.rect;
      e.onInput = spec.onInput;
      const el = e.el as Field;
      el.readOnly = spec.readOnly === true;
      el.placeholder = spec.placeholder ?? '';
      if (spec.label) el.setAttribute('aria-label', spec.label);
      el.style.opacity = spec.readOnly ? '0.92' : '1';
    }
    for (const spec of buttons) {
      wanted.add(spec.id);
      let e = this.entries.get(spec.id);
      if (e && e.kind !== 'button') {
        this.remove(spec.id);
        e = undefined;
      }
      if (!e) e = this.createButton(spec);
      e.rect = spec.rect;
      e.onClick = spec.onClick;
      const el = e.el as HTMLButtonElement;
      if (el.textContent !== spec.label) el.textContent = spec.label;
      const enabled = spec.enabled !== false;
      el.disabled = !enabled;
      el.style.opacity = enabled ? '1' : '0.45';
      el.style.cursor = enabled ? 'pointer' : 'default';
    }
    for (const id of Array.from(this.entries.keys())) if (!wanted.has(id)) this.remove(id);
    this.lastBox = '';
    this.layout();
  }

  /** Replace les éléments d'après le rectangle courant du canvas (peu coûteux : ne fait rien si le rectangle n'a pas bougé). */
  layout(): void {
    if (this.destroyed) return;
    const r = this.canvas ? this.canvas.getBoundingClientRect() : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
    const key = `${r.left}|${r.top}|${r.width}|${r.height}`;
    if (key === this.lastBox) return;
    this.lastBox = key;
    const box = { left: r.left, top: r.top, width: r.width, height: r.height };
    for (const e of this.entries.values()) {
      const isButton = e.kind === 'button';
      const css2 = logicalToCss(e.rect, box, GAME_WIDTH, { minW: isButton ? MIN_TOUCH_PX : undefined, minH: MIN_TOUCH_PX });
      const s = e.el.style;
      s.left = `${Math.round(css2.left)}px`;
      s.top = `${Math.round(css2.top)}px`;
      s.width = `${Math.round(css2.width)}px`;
      s.height = `${Math.round(css2.height)}px`;
      s.fontSize = `${Math.max(isButton ? MIN_BUTTON_FONT_PX : MIN_FONT_PX, Math.round(20 * css2.scale))}px`;
    }
  }

  /** Retire tous les éléments et tous les écouteurs (idempotent). */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    window.removeEventListener('resize', this.relayout);
    window.removeEventListener('orientationchange', this.relayout);
    window.visualViewport?.removeEventListener('resize', this.relayout);
    for (const id of Array.from(this.entries.keys())) this.remove(id);
    this.root.remove();
  }

  // ───────────────────────────── Interne ─────────────────────────────

  private remove(id: string): void {
    const e = this.entries.get(id);
    if (!e) return;
    e.teardown();
    e.el.remove();
    this.entries.delete(id);
  }

  private createField(spec: DomFieldSpec): Entry {
    const el: Field = spec.kind === 'textarea' ? document.createElement('textarea') : document.createElement('input');
    if (el instanceof HTMLInputElement) el.type = 'text';
    el.id = `net-lobby-${spec.id}`;
    el.autocomplete = 'off';
    el.spellcheck = false;
    el.setAttribute('autocapitalize', 'off');
    el.setAttribute('autocorrect', 'off');
    el.setAttribute('enterkeyhint', spec.kind === 'input' ? 'done' : 'enter');
    if (spec.maxLength !== undefined) el.maxLength = spec.maxLength;
    if (spec.value !== undefined) el.value = spec.value;
    el.style.cssText =
      'position:fixed;box-sizing:border-box;margin:0;padding:6px 10px;resize:none;outline:none;border-radius:0;pointer-events:auto;' +
      `border:2px solid ${css(UI_THEME.panelEdge)};background:${css(UI_THEME.panelFill)};color:${css(UI_THEME.text)};` +
      `font-family:${UI_FONT_FAMILY};font-weight:bold;caret-color:${css(UI_THEME.accent)};` +
      'user-select:text;-webkit-user-select:text;touch-action:pan-y;' +
      (spec.kind === 'textarea' ? 'overflow-y:auto;overflow-wrap:anywhere;word-break:break-all;line-height:1.25;' : 'overflow:hidden;');

    const entry: Entry = { kind: spec.kind, el, rect: spec.rect, onInput: spec.onInput, teardown: () => undefined };
    const onInput = (): void => entry.onInput?.(el.value);
    const onKeyDown = (ev: KeyboardEvent): void => {
      ev.stopPropagation(); // le jeu (KeyboardSource sur window) ne doit pas voir la frappe
      if (ev.key === 'Escape' || (ev.key === 'Enter' && el instanceof HTMLInputElement)) {
        ev.preventDefault();
        el.blur();
      }
    };
    const onKeyUp = (ev: KeyboardEvent): void => ev.stopPropagation();
    const onFocus = (): void => {
      if (el.readOnly) el.select(); // un code à copier : tout sélectionner d'un toucher
    };
    const node: HTMLElement = el; // (l'union input / textarea fausse la surcharge de addEventListener)
    node.addEventListener('input', onInput);
    node.addEventListener('keydown', onKeyDown);
    node.addEventListener('keyup', onKeyUp);
    node.addEventListener('focus', onFocus);
    entry.teardown = () => {
      node.removeEventListener('input', onInput);
      node.removeEventListener('keydown', onKeyDown);
      node.removeEventListener('keyup', onKeyUp);
      node.removeEventListener('focus', onFocus);
    };
    this.root.appendChild(el);
    this.entries.set(spec.id, entry);
    return entry;
  }

  private createButton(spec: DomButtonSpec): Entry {
    const el = document.createElement('button');
    el.type = 'button';
    el.id = `net-lobby-${spec.id}`;
    el.style.cssText =
      'position:fixed;box-sizing:border-box;margin:0;padding:0 4px;border-radius:0;pointer-events:auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' +
      `border:2px solid ${css(UI_THEME.panelEdge)};background:${css(UI_THEME.panelFillAlt)};color:${css(UI_THEME.accent)};` +
      `font-family:${UI_FONT_FAMILY};font-weight:bold;touch-action:manipulation;`;
    const entry: Entry = { kind: 'button', el, rect: spec.rect, onClick: spec.onClick, teardown: () => undefined };
    const onClick = (): void => {
      if (el.disabled) return;
      el.blur(); // le focus ne reste pas sur le bouton (Entrée / Espace ne le redéclenchent pas)
      entry.onClick?.();
    };
    el.addEventListener('click', onClick);
    entry.teardown = () => el.removeEventListener('click', onClick);
    this.root.appendChild(el);
    this.entries.set(spec.id, entry);
    return entry;
  }
}
