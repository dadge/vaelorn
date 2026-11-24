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
 * champ ne remontent pas jusqu'à la fenêtre (le jeu ne les voit pas) ; Échap ou Entrée (champ d'une ligne) quittent le champ. Entrée et Espace sur un BOUTON
 * focalisé déclenchent son clic sans remonter non plus (sinon le menu activerait en plus la ligne sélectionnée).
 *
 * QR CODES : en plus des champs et des boutons, `sync(champs, boutons, média)` gère
 *  - des zones QR (`DomQrSpec`) : un `<canvas>` posé comme les autres éléments, redessiné quand le code ou la taille changent (noir sur blanc, marge de 4 modules,
 *    nombre entier de pixels par module, sans lissage : `drawQrToCanvas`), centré dans son rectangle et SANS toucher (les doigts passent au travers) ;
 *  - une zone caméra (`DomCameraSpec`) : un `<video>` (`playsinline`, muet, `object-fit: cover`) dans un cadre noir avec cadre de visée, consigne, message d'état et
 *    bouton « Annuler ». Elle est au-dessus du canvas du jeu (même couche que les autres éléments) ; quand elle est retirée (ou à `destroy()`), toutes les pistes du
 *    flux de la vidéo sont ARRÊTÉES (ceinture et bretelles en plus de `QrScanner.stop()`) ;
 *  - des étiquettes de texte (`DomLabelSpec`) et un fond opaque (`backdrop`) pour les « feuilles » du mode portrait, où le canvas du jeu est un bandeau minuscule.
 */
import { GAME_WIDTH } from '../core/constants';
import { TOUCH_MIN_CSS, isActivationKey, logicalToCss, type LogicalRect } from '../render/netLobbyLogic';
import { UI_FONT_FAMILY, UI_THEME, css } from '../render/ui';
import { drawQrToCanvas, type QrMatrix } from '../net/qr/qrCode';

/** Taille tactile minimale (px CSS) d'un bouton / d'un champ. */
export const MIN_TOUCH_PX = TOUCH_MIN_CSS;
/** Police minimale (px CSS) d'un champ (iOS zoome la page sous 16 px). */
export const MIN_FONT_PX = 16;
/** Police minimale (px CSS) d'un bouton (pas de zoom au focus : on peut descendre sous 16 px, ce qui laisse tenir « Valider » dans un bouton étroit). */
export const MIN_BUTTON_FONT_PX = 14;

/** Identifiant interne du fond plein écran. */
const BACKDROP_ID = '__backdrop';

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

/** Zone d'un QR code : le canvas y est centré, au plus grand côté (entier de pixels par module) qui tient. */
export interface DomQrSpec {
  id: string;
  rect: LogicalRect;
  /** Matrice du QR code ; la MÊME référence tant que le code ne change pas (le canvas n'est redessiné que si elle change ou si la zone change de taille). */
  matrix: QrMatrix;
  /** Libellé accessible (lecteurs d'écran). */
  label: string;
}

export type DomTone = 'normal' | 'accent' | 'dim' | 'bad';

/** Texte DOM (feuilles portrait seulement : en paysage les textes sont dessinés dans le canvas). */
export interface DomLabelSpec {
  id: string;
  rect: LogicalRect;
  text: string;
  tone?: DomTone;
  /** Taille de dessin en pixels logiques (convertie en CSS, 14 px au minimum). */
  px?: number;
  align?: 'left' | 'center';
}

/** Zone caméra : vidéo + cadre de visée + consigne + message d'état + bouton d'annulation. */
export interface DomCameraSpec {
  id: string;
  rect: LogicalRect;
  /** Consigne affichée en haut (« Vise le code affiché sur… »). */
  caption: string;
  /** Message d'état affiché en bas, au-dessus du bouton (contenu écarté, ouverture…) ; null : aucun. */
  status: { text: string; tone: DomTone } | null;
  cancelLabel: string;
  onCancel: () => void;
}

/** Éléments « média » d'un rendu (tous facultatifs). */
export interface DomMedia {
  qrs?: readonly DomQrSpec[];
  labels?: readonly DomLabelSpec[];
  camera?: DomCameraSpec | null;
  /** Fond opaque plein écran sous les éléments (feuille portrait). */
  backdrop?: boolean;
}

type Field = HTMLInputElement | HTMLTextAreaElement;

interface Entry {
  kind: 'input' | 'textarea' | 'button' | 'qr' | 'label' | 'camera' | 'backdrop';
  el: HTMLElement;
  rect: LogicalRect;
  onInput?: (value: string) => void;
  onClick?: () => void;
  /** QR : matrice voulue, matrice et côté (px CSS de la zone) du dernier dessin, côté affiché. */
  matrix?: QrMatrix;
  drawn?: { matrix: QrMatrix; max: number; cssPx: number };
  /** Étiquette : taille de dessin (px logiques). */
  px?: number;
  /** Caméra : éléments internes. */
  cam?: { video: HTMLVideoElement; caption: HTMLElement; status: HTMLElement; cancel: HTMLButtonElement; onCancel: () => void };
  /** Retire les écouteurs de l'élément. */
  teardown: () => void;
}

/** true pour une entrée qui porte du texte saisissable (champ). */
function isFieldEntry(e: Entry): boolean {
  return e.kind === 'input' || e.kind === 'textarea';
}

/** Arrête toutes les pistes du flux d'une vidéo et la détache (aucune caméra ne reste allumée). */
export function releaseVideo(video: HTMLVideoElement): void {
  try {
    const stream = video.srcObject as { getTracks?: () => Array<{ stop(): void }> } | null;
    if (stream && typeof stream.getTracks === 'function') {
      for (const track of stream.getTracks()) {
        try {
          track.stop();
        } catch {
          /* piste déjà arrêtée */
        }
      }
    }
  } catch {
    /* flux illisible */
  }
  try {
    video.pause();
  } catch {
    /* vidéo détachée */
  }
  try {
    video.srcObject = null;
  } catch {
    /* sans importance */
  }
}

function toneColor(tone: DomTone | undefined): string {
  switch (tone) {
    case 'accent':
      return css(UI_THEME.accent);
    case 'dim':
      return css(UI_THEME.textDim);
    case 'bad':
      return css(UI_THEME.bad);
    default:
      return css(UI_THEME.text);
  }
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

/**
 * Entrée / Espace sur un bouton focalisé : le navigateur déclenche le clic, mais la touche ne doit pas remonter jusqu'à la fenêtre où la source clavier du jeu l'attend :
 * le menu verrait un « confirmer » de plus et activerait la ligne sélectionnée (« Retour », « Niveau »…) juste après le clic. Échap et les flèches continuent de remonter.
 */
function keepActivationKeys(ev: KeyboardEvent): void {
  if (isActivationKey(ev)) ev.stopPropagation();
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
    for (const e of this.entries.values()) if (e.el === active && isFieldEntry(e)) return true;
    return false;
  }

  /** Retire le focus du champ actif (ferme le clavier virtuel). */
  blur(): void {
    const active = document.activeElement;
    if (active instanceof HTMLElement && this.root.contains(active)) active.blur();
  }

  getValue(id: string): string {
    const e = this.entries.get(id);
    return e && isFieldEntry(e) ? (e.el as Field).value : '';
  }

  setValue(id: string, value: string): void {
    const e = this.entries.get(id);
    if (e && isFieldEntry(e)) (e.el as Field).value = value;
  }

  /** Champ d'identifiant `id` (pour la sélection / la copie), ou null. */
  field(id: string): Field | null {
    const e = this.entries.get(id);
    return e && isFieldEntry(e) ? (e.el as Field) : null;
  }

  /** Donne le focus au champ (au toucher : ouvre le clavier si le navigateur l'autorise). */
  focus(id: string): void {
    this.field(id)?.focus();
  }

  /**
   * Fait correspondre les éléments à la description : crée les nouveaux, met à jour les présents (position, libellé, état), retire les absents. Les éléments conservés
   * gardent leur focus, leur texte et leur sélection (et la vidéo de la caméra son flux).
   */
  sync(fields: readonly DomFieldSpec[], buttons: readonly DomButtonSpec[], media: DomMedia = {}): void {
    if (this.destroyed) return;
    const wanted = new Set<string>();
    if (media.backdrop) {
      wanted.add(BACKDROP_ID);
      if (!this.entries.has(BACKDROP_ID)) this.createBackdrop();
    }
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
    for (const spec of media.labels ?? []) {
      wanted.add(spec.id);
      let e = this.entries.get(spec.id);
      if (e && e.kind !== 'label') {
        this.remove(spec.id);
        e = undefined;
      }
      if (!e) e = this.createLabel(spec);
      e.rect = spec.rect;
      e.px = spec.px ?? 22;
      if (e.el.textContent !== spec.text) e.el.textContent = spec.text;
      e.el.style.color = toneColor(spec.tone);
      e.el.style.textAlign = spec.align ?? 'left';
    }
    for (const spec of media.qrs ?? []) {
      wanted.add(spec.id);
      let e = this.entries.get(spec.id);
      if (e && e.kind !== 'qr') {
        this.remove(spec.id);
        e = undefined;
      }
      if (!e) e = this.createQr(spec);
      e.rect = spec.rect;
      e.matrix = spec.matrix;
      e.el.setAttribute('aria-label', spec.label);
    }
    if (media.camera) {
      const spec = media.camera;
      wanted.add(spec.id);
      let e = this.entries.get(spec.id);
      if (e && e.kind !== 'camera') {
        this.remove(spec.id);
        e = undefined;
      }
      if (!e) e = this.createCamera(spec);
      e.rect = spec.rect;
      const cam = e.cam;
      if (cam) {
        cam.onCancel = spec.onCancel;
        if (cam.caption.textContent !== spec.caption) cam.caption.textContent = spec.caption;
        const status = spec.status?.text ?? '';
        if (cam.status.textContent !== status) cam.status.textContent = status;
        cam.status.style.color = toneColor(spec.status?.tone);
        cam.status.style.display = status ? 'block' : 'none';
        if (cam.cancel.textContent !== spec.cancelLabel) cam.cancel.textContent = spec.cancelLabel;
      }
    }
    for (const id of Array.from(this.entries.keys())) if (!wanted.has(id)) this.remove(id);
    this.lastBox = '';
    this.layout();
  }

  /** Élément `<video>` de la zone caméra (pour `startQrScanner`), ou null si la zone n'est pas affichée. */
  cameraVideo(): HTMLVideoElement | null {
    for (const e of this.entries.values()) if (e.kind === 'camera' && e.cam) return e.cam.video;
    return null;
  }

  /** Rectangle courant du canvas du jeu (ou de la fenêtre sans canvas) et taille de la fenêtre, en pixels CSS : entrées de `viewMetrics`. */
  measure(): { box: { left: number; top: number; width: number; height: number }; viewport: { width: number; height: number } } {
    const r = this.canvas ? this.canvas.getBoundingClientRect() : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
    return { box: { left: r.left, top: r.top, width: r.width, height: r.height }, viewport: { width: window.innerWidth, height: window.innerHeight } };
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
      if (e.kind === 'backdrop') continue; // plein écran, rien à placer
      const s = e.el.style;
      if (e.kind === 'qr') {
        this.layoutQr(e, box);
        continue;
      }
      if (e.kind === 'label' || e.kind === 'camera') {
        const c = logicalToCss(e.rect, box, GAME_WIDTH);
        s.left = `${Math.round(c.left)}px`;
        s.top = `${Math.round(c.top)}px`;
        s.width = `${Math.round(c.width)}px`;
        s.height = `${Math.round(c.height)}px`;
        if (e.kind === 'label') s.fontSize = `${Math.max(MIN_BUTTON_FONT_PX, Math.round((e.px ?? 22) * c.scale))}px`;
        continue;
      }
      const isButton = e.kind === 'button';
      const css2 = logicalToCss(e.rect, box, GAME_WIDTH, { minW: isButton ? MIN_TOUCH_PX : undefined, minH: MIN_TOUCH_PX });
      s.left = `${Math.round(css2.left)}px`;
      s.top = `${Math.round(css2.top)}px`;
      s.width = `${Math.round(css2.width)}px`;
      s.height = `${Math.round(css2.height)}px`;
      s.fontSize = `${Math.max(isButton ? MIN_BUTTON_FONT_PX : MIN_FONT_PX, Math.round(20 * css2.scale))}px`;
    }
  }

  /** (Re)dessine le QR code d'une entrée si besoin, puis le centre dans sa zone. */
  private layoutQr(e: Entry, box: { left: number; top: number; width: number; height: number }): void {
    const matrix = e.matrix;
    if (!matrix) return;
    const c = logicalToCss(e.rect, box, GAME_WIDTH);
    const max = Math.max(1, Math.floor(Math.min(c.width, c.height)));
    const canvas = e.el as HTMLCanvasElement;
    if (!e.drawn || e.drawn.matrix !== matrix || e.drawn.max !== max) {
      try {
        const { cssPx } = drawQrToCanvas(canvas, matrix, max);
        e.drawn = { matrix, max, cssPx };
      } catch {
        e.drawn = { matrix, max, cssPx: 0 }; // pas de contexte 2D : rien à voir, le texte de repli reste
      }
    }
    const side = e.drawn.cssPx;
    canvas.style.left = `${Math.round(c.left + (c.width - side) / 2)}px`;
    canvas.style.top = `${Math.round(c.top + (c.height - side) / 2)}px`;
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
    const stopKeys = keepActivationKeys;
    el.addEventListener('keydown', stopKeys);
    el.addEventListener('keyup', stopKeys);
    entry.teardown = () => {
      el.removeEventListener('click', onClick);
      el.removeEventListener('keydown', stopKeys);
      el.removeEventListener('keyup', stopKeys);
    };
    this.root.appendChild(el);
    this.entries.set(spec.id, entry);
    return entry;
  }

  /** Fond opaque plein écran (feuille portrait) : sous tous les autres éléments (`z-index` négatif dans la couche du salon), il avale les touchers. */
  private createBackdrop(): Entry {
    const el = document.createElement('div');
    el.setAttribute('data-net-backdrop', '');
    el.style.cssText = `position:fixed;left:0;top:0;right:0;bottom:0;z-index:-1;pointer-events:auto;background:${css(UI_THEME.bg)};`;
    const entry: Entry = { kind: 'backdrop', el, rect: { x: 0, y: 0, w: 0, h: 0 }, teardown: () => undefined };
    this.root.appendChild(el);
    this.entries.set(BACKDROP_ID, entry);
    return entry;
  }

  private createLabel(spec: DomLabelSpec): Entry {
    const el = document.createElement('div');
    el.id = `net-lobby-${spec.id}`;
    el.style.cssText =
      'position:fixed;box-sizing:border-box;margin:0;padding:0;pointer-events:none;overflow:hidden;line-height:1.2;' +
      `font-family:${UI_FONT_FAMILY};font-weight:bold;`;
    const entry: Entry = { kind: 'label', el, rect: spec.rect, px: spec.px, teardown: () => undefined };
    this.root.appendChild(el);
    this.entries.set(spec.id, entry);
    return entry;
  }

  /** Canvas du QR code : aucun toucher (les doigts passent au travers, jusqu'à la manette virtuelle dessous), net (`pixelated`), dessiné à la mise en page. */
  private createQr(spec: DomQrSpec): Entry {
    const el = document.createElement('canvas');
    el.id = `net-lobby-${spec.id}`;
    el.setAttribute('role', 'img');
    el.style.cssText = 'position:fixed;margin:0;padding:0;pointer-events:none;image-rendering:pixelated;background:#ffffff;';
    const entry: Entry = { kind: 'qr', el, rect: spec.rect, matrix: spec.matrix, teardown: () => undefined };
    this.root.appendChild(el);
    this.entries.set(spec.id, entry);
    return entry;
  }

  /** Zone caméra : cadre noir, vidéo (muette, `playsinline`, `object-fit: cover`), cadre de visée, consigne en haut, message d'état et bouton « Annuler » en bas. */
  private createCamera(spec: DomCameraSpec): Entry {
    const el = document.createElement('div');
    el.id = `net-lobby-${spec.id}`;
    el.style.cssText = `position:fixed;box-sizing:border-box;margin:0;padding:0;overflow:hidden;pointer-events:auto;background:#000;border:2px solid ${css(UI_THEME.panelEdge)};`;

    const video = document.createElement('video');
    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;
    video.autoplay = true;
    video.setAttribute('playsinline', '');
    video.setAttribute('muted', '');
    video.setAttribute('disablepictureinpicture', '');
    video.setAttribute('aria-hidden', 'true');
    video.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;object-fit:cover;background:#000;pointer-events:none;';

    const aim = document.createElement('div');
    aim.setAttribute('aria-hidden', 'true');
    aim.style.cssText = `position:absolute;left:50%;top:50%;height:62%;width:auto;aspect-ratio:1/1;transform:translate(-50%,-50%);box-sizing:border-box;border:3px solid ${css(UI_THEME.accent)};border-radius:14px;box-shadow:0 0 0 9999px rgba(0,0,0,0.35);pointer-events:none;`;

    const textStyle = `position:absolute;left:0;right:0;box-sizing:border-box;margin:0;padding:6px 10px;text-align:center;font-family:${UI_FONT_FAMILY};font-weight:bold;font-size:16px;line-height:1.25;pointer-events:none;background:rgba(11,10,20,0.72);`;
    const caption = document.createElement('div');
    caption.style.cssText = `${textStyle}top:0;color:${css(UI_THEME.text)};`;
    const status = document.createElement('div');
    status.setAttribute('role', 'status');
    status.style.cssText = `${textStyle}bottom:${MIN_TOUCH_PX + 14}px;display:none;`;

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.style.cssText =
      `position:absolute;left:50%;bottom:6px;transform:translateX(-50%);box-sizing:border-box;margin:0;padding:0 18px;min-width:140px;height:${MIN_TOUCH_PX}px;border-radius:0;pointer-events:auto;white-space:nowrap;` +
      `border:2px solid ${css(UI_THEME.panelEdge)};background:${css(UI_THEME.panelFillAlt)};color:${css(UI_THEME.accent)};` +
      `font-family:${UI_FONT_FAMILY};font-weight:bold;font-size:${MIN_BUTTON_FONT_PX + 2}px;touch-action:manipulation;`;
    const cam = { video, caption, status, cancel, onCancel: spec.onCancel };
    const onClick = (): void => {
      cancel.blur();
      cam.onCancel();
    };
    cancel.addEventListener('click', onClick);
    cancel.addEventListener('keydown', keepActivationKeys);
    cancel.addEventListener('keyup', keepActivationKeys);

    el.append(video, aim, caption, status, cancel);
    const entry: Entry = {
      kind: 'camera',
      el,
      rect: spec.rect,
      cam,
      teardown: () => {
        cancel.removeEventListener('click', onClick);
        cancel.removeEventListener('keydown', keepActivationKeys);
        cancel.removeEventListener('keyup', keepActivationKeys);
        releaseVideo(video); // la caméra s'éteint avec la zone, quoi qu'il arrive au lecteur
      },
    };
    this.root.appendChild(el);
    this.entries.set(spec.id, entry);
    return entry;
  }
}
