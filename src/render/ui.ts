/**
 * Composants d'interface réutilisables (Phaser 3) pour Boot / Menu / CharacterSelect / Dialogue / Result.
 *
 * Ce module n'importe Phaser QUE pour ses types (`import type`) : il se charge donc sous Node/Vitest et ses
 * parties pures (géométrie de panneau, typewriter, matrices de pixels, barres) sont testées dans ui.test.ts.
 * Toute chaîne affichée doit venir de `t()` : ce module ne contient aucun texte de jeu en dur.
 *
 * Contenu :
 *  - thème (couleurs, police monospace bold en tailles multiples de 8) ;
 *  - panneau pixel art « nine-slice » dessiné par code (`panelRects`, `drawPanel`, `createPanel`) ;
 *  - texte contour/ombre (`createText`), bouton (`UiButton`), barre segmentée (`SegmentBar`) ;
 *  - machine à écrire (`Typewriter`, `prewrapText`) ;
 *  - écouteurs de langue sans fuite (`bindLanguage`) et transitions de scène (`beginScene`, `transitionTo`) ;
 *  - décors : aube + cristal brisé (`createDawnBackground`), fond thématique de niveau (`createThemeBackground`),
 *    portraits d'orateurs (`createPortrait`).
 */
import type Phaser from 'phaser';
import { GAME_HEIGHT, GAME_WIDTH, PLAYER_COLORS } from '../core/constants';
import type { CharacterId, PlayerId, ZoneTheme } from '../core/types';
import { onLanguageChange, type Language } from '../i18n/i18n';
import { ATLAS_KEY } from './art/contract';
import { bossFrame, heroFrame, stepOf, tileFrame, torchFrame } from './art/animations';
import { hash01, mixColor, portraitKindOf, skyBandColors } from './menuLogic';
import { OUTLINE, THEME_PALETTES, hex, lighten } from './palettes';

// ───────────────────────────── Thème ─────────────────────────────

/** Police : monospace système en gras (les tailles sont des multiples de 8 pour rester « pixel »). */
export const UI_FONT_FAMILY = '"Courier New", Consolas, "Lucida Console", monospace';

/** Tailles de police nommées (px, multiples de 8). */
export const FONT_SIZES = { sm: 16, md: 24, lg: 32, xl: 48, xxl: 64 } as const;
export type FontSizeName = keyof typeof FONT_SIZES;

/** Couleurs de l'interface (0xRRGGBB). */
export const UI_THEME = {
  bg: 0x0b0a14,
  panelFill: 0x1b1832,
  panelFillAlt: 0x262248,
  panelEdge: 0x6a64a0,
  accent: 0xffd36b,
  accentDeep: 0xb8451c,
  text: 0xf4f0ff,
  textDim: 0xa8a2c8,
  good: 0x5be37d,
  bad: 0xff5a5a,
  disabled: 0x5a5670,
} as const;

/** Convertit une couleur numérique ou chaîne CSS en chaîne CSS. */
export function css(color: number | string): string {
  return typeof color === 'string' ? color : hex(color);
}

/** Couleur 0xRRGGBB du joueur `id` (borne/replie l'indice sur 0..3). */
export function playerColor(id: number): number {
  const n = PLAYER_COLORS.length;
  return PLAYER_COLORS[((Math.floor(id) % n) + n) % n];
}

/** Couleur CSS du joueur `id`. */
export function playerColorCss(id: number): string {
  return hex(playerColor(id));
}

// ───────────────────────────── Panneaux « nine-slice » ─────────────────────────────

/** Style d'un panneau pixel art (toutes les couleurs sont opaques ; utiliser `setAlpha` pour la transparence). */
export interface PanelStyle {
  /** Remplissage. */
  fill: number;
  /** Liseré (anneau de 2 px). */
  edge: number;
  /** Reflet (bords haut/gauche intérieurs). */
  highlight: number;
  /** Contour extérieur sombre (2 px) et ombre intérieure. */
  shadow: number;
  /** Épaisseur totale du cadre (px, ≥ 4 conseillé). */
  border: number;
  /** Taille de l'encoche (coin « escalier ») en px. */
  notch: number;
}

/** Rectangle élémentaire d'un panneau, relatif à son coin haut-gauche. */
export interface PanelRect {
  x: number;
  y: number;
  w: number;
  h: number;
  color: number;
  alpha: number;
}

/** Construit un style de panneau depuis un remplissage et un liseré. */
export function makePanelStyle(fill: number, edge: number, opts: { border?: number; notch?: number } = {}): PanelStyle {
  return { fill, edge, highlight: lighten(fill, 0.14), shadow: OUTLINE, border: opts.border ?? 4, notch: opts.notch ?? 4 };
}

/** Styles de panneau prédéfinis. */
export const PANEL_STYLES = {
  default: makePanelStyle(UI_THEME.panelFill, UI_THEME.panelEdge),
  dark: makePanelStyle(0x100e20, 0x4a4670),
  raised: makePanelStyle(UI_THEME.panelFillAlt, 0x8a84c0),
  selected: makePanelStyle(0x3a2e5c, UI_THEME.accent),
  disabled: makePanelStyle(0x15132a, 0x3a3652),
  good: makePanelStyle(0x163a2a, UI_THEME.good),
  bad: makePanelStyle(0x3a1620, UI_THEME.bad),
} as const satisfies Record<string, PanelStyle>;

/** Style d'un panneau de joueur : liseré à la couleur du joueur ; `ready` éclaircit le fond. */
export function playerPanelStyle(playerId: number, ready = false): PanelStyle {
  const c = playerColor(playerId);
  return makePanelStyle(ready ? mixColor(0x163a2a, c, 0.18) : UI_THEME.panelFill, c);
}

/**
 * Géométrie PURE d'un panneau de `w`×`h` px : liste ordonnée de rectangles (du fond vers le dessus) —
 * contour sombre à coins en escalier, liseré, remplissage, reflet haut/gauche, ombre basse.
 * Tous les rectangles sont strictement dans [0,w]×[0,h] et non dégénérés.
 */
export function panelRects(w: number, h: number, style: PanelStyle): PanelRect[] {
  const out: PanelRect[] = [];
  const W = Math.max(0, Math.floor(w));
  const H = Math.max(0, Math.floor(h));
  const push = (x: number, y: number, rw: number, rh: number, color: number, alpha = 1): void => {
    const x0 = Math.max(0, x);
    const y0 = Math.max(0, y);
    const x1 = Math.min(W, x + rw);
    const y1 = Math.min(H, y + rh);
    if (x1 > x0 && y1 > y0) out.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0, color, alpha });
  };
  const notched = (x: number, y: number, rw: number, rh: number, n: number, color: number): void => {
    const k = Math.max(0, Math.min(n, Math.floor(Math.min(rw, rh) / 2)));
    push(x + k, y, rw - 2 * k, rh, color);
    push(x, y + k, rw, rh - 2 * k, color);
  };
  const b = Math.max(2, style.border);
  const n = Math.max(0, style.notch);
  notched(0, 0, W, H, n, style.shadow);
  notched(2, 2, W - 4, H - 4, Math.max(0, n - 2), style.edge);
  notched(b, b, W - 2 * b, H - 2 * b, Math.max(0, n - b), style.fill);
  push(b, b, W - 2 * b, 2, style.highlight);
  push(b, b + 2, 2, H - 2 * b - 4, style.highlight);
  push(b, H - b - 2, W - 2 * b, 2, style.shadow, 0.35);
  return out;
}

/** Surface minimale capable de dessiner des rectangles pleins (Phaser.GameObjects.Graphics, ou une doublure de test). */
export interface RectFiller {
  fillStyle(color: number, alpha?: number): unknown;
  fillRect(x: number, y: number, w: number, h: number): unknown;
}

/** Dessine un panneau sur `g` à la position (x, y). */
export function drawPanel(g: RectFiller, x: number, y: number, w: number, h: number, style: PanelStyle = PANEL_STYLES.default): void {
  for (const r of panelRects(w, h, style)) {
    g.fillStyle(r.color, r.alpha);
    g.fillRect(x + r.x, y + r.y, r.w, r.h);
  }
}

/** Crée un panneau (Graphics positionné en (x, y), dessiné en (0,0)). */
export function createPanel(
  scene: Phaser.Scene,
  x: number,
  y: number,
  w: number,
  h: number,
  style: PanelStyle = PANEL_STYLES.default,
): Phaser.GameObjects.Graphics {
  const g = scene.add.graphics();
  g.setPosition(x, y);
  drawPanel(g, 0, 0, w, h, style);
  return g;
}

/**
 * Dessine une matrice de pixels (lignes de caractères + table lettre → couleur) en rectangles `scale`×`scale`.
 * '.', ' ' et toute lettre absente de la table sont transparents. Les pixels contigus de même lettre sont fusionnés.
 */
export function drawPixelMatrix(
  g: RectFiller,
  rows: readonly string[],
  colors: Readonly<Record<string, number>>,
  x: number,
  y: number,
  scale: number,
): void {
  rows.forEach((row, ry) => {
    let cx = 0;
    while (cx < row.length) {
      const ch = row[cx];
      let run = 1;
      while (cx + run < row.length && row[cx + run] === ch) run++;
      const color = colors[ch];
      if (color !== undefined && ch !== '.' && ch !== ' ') {
        g.fillStyle(color, 1);
        g.fillRect(x + cx * scale, y + ry * scale, run * scale, scale);
      }
      cx += run;
    }
  });
}

/** Dessine un triangle (flèche de sélecteur) pointant à gauche ou à droite, centré sur (cx, cy). */
export function drawArrow(g: Phaser.GameObjects.Graphics, cx: number, cy: number, dir: 'left' | 'right', size: number, color: number): void {
  const s = size;
  g.fillStyle(OUTLINE, 1);
  if (dir === 'left') g.fillTriangle(cx - s - 2, cy, cx + s + 2, cy - s - 3, cx + s + 2, cy + s + 3);
  else g.fillTriangle(cx + s + 2, cy, cx - s - 2, cy - s - 3, cx - s - 2, cy + s + 3);
  g.fillStyle(color, 1);
  if (dir === 'left') g.fillTriangle(cx - s, cy, cx + s, cy - s, cx + s, cy + s);
  else g.fillTriangle(cx + s, cy, cx - s, cy - s, cx - s, cy + s);
}

// ───────────────────────────── Texte ─────────────────────────────

/** Options de `createText`. */
export interface TextOptions {
  /** Taille nommée ou en px (multiple de 8 conseillé). Défaut `md` (24). */
  size?: FontSizeName | number;
  /** Couleur du texte (défaut `UI_THEME.text`). */
  color?: number | string;
  align?: 'left' | 'center' | 'right';
  /** Origine [x, y] (0..1). Défaut [0, 0]. */
  origin?: readonly [number, number];
  /** Largeur de retour à la ligne automatique (px). */
  wrapWidth?: number;
  /** Couleur du contour ; `null` = aucun. Défaut : contour sombre pour les tailles ≥ 24. */
  stroke?: number | null;
  /** Ombre portée (défaut true). */
  shadow?: boolean;
  lineSpacing?: number;
  /** Gras (défaut true). */
  bold?: boolean;
}

/** Taille en px d'une option `size`. */
export function fontPx(size: FontSizeName | number | undefined): number {
  if (typeof size === 'number') return size;
  return FONT_SIZES[size ?? 'md'];
}

/** Crée un texte pixel-art : monospace bold, contour sombre (grandes tailles) et ombre portée nette. */
export function createText(scene: Phaser.Scene, x: number, y: number, content: string, opts: TextOptions = {}): Phaser.GameObjects.Text {
  const size = fontPx(opts.size);
  const style: Phaser.Types.GameObjects.Text.TextStyle = {
    fontFamily: UI_FONT_FAMILY,
    fontSize: `${size}px`,
    fontStyle: opts.bold === false ? 'normal' : 'bold',
    color: css(opts.color ?? UI_THEME.text),
    align: opts.align ?? 'left',
  };
  if (opts.lineSpacing !== undefined) style.lineSpacing = opts.lineSpacing;
  if (opts.wrapWidth !== undefined) style.wordWrap = { width: opts.wrapWidth, useAdvancedWrap: true };
  const txt = scene.add.text(x, y, content, style);
  const o = opts.origin ?? [0, 0];
  txt.setOrigin(o[0], o[1]);
  const stroke = opts.stroke === undefined ? (size >= 24 ? OUTLINE : null) : opts.stroke;
  if (stroke !== null) txt.setStroke(css(stroke), size >= 48 ? 8 : 4);
  if (opts.shadow !== false) txt.setShadow(2, 2, '#000000', 0, true, true);
  return txt;
}

/**
 * Découpe `full` en lignes d'après la largeur de retour à la ligne de `textObj` et les rejoint par '\n' :
 * le texte ne se « re-coupe » plus pendant l'effet machine à écrire (pas de mot qui saute de ligne).
 */
export function prewrapText(textObj: Phaser.GameObjects.Text, full: string): string {
  try {
    const lines = textObj.getWrappedText(full);
    return lines.length > 0 ? lines.join('\n') : full;
  } catch {
    return full;
  }
}

// ───────────────────────────── Machine à écrire (pur) ─────────────────────────────

/** Options du typewriter. */
export interface TypewriterOptions {
  /** Vitesse (caractères par seconde, défaut 45). */
  charsPerSecond?: number;
  /** Pause supplémentaire après . ! ? … : ; (ms, défaut 220). */
  sentencePauseMs?: number;
  /** Pause supplémentaire après une virgule (ms, défaut 90). */
  commaPauseMs?: number;
}

const SENTENCE_END = new Set(['.', '!', '?', '…', ':', ';']);

/**
 * Instants (ms depuis le début) auxquels chaque caractère devient visible : `timeline[i]` = instant d'apparition du
 * caractère i (donc `i+1` caractères visibles à partir de cet instant). Les retours à la ligne sont instantanés ;
 * la ponctuation ajoute une pause AVANT le caractère suivant (jamais sur un espace/fin de texte isolé).
 */
export function typewriterTimeline(chars: readonly string[], opts: TypewriterOptions = {}): number[] {
  const msPerChar = 1000 / Math.max(1, opts.charsPerSecond ?? 45);
  const sentence = Math.max(0, opts.sentencePauseMs ?? 220);
  const comma = Math.max(0, opts.commaPauseMs ?? 90);
  const out: number[] = [];
  let t = 0;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (c !== '\n') t += msPerChar;
    out.push(t);
    const next = chars[i + 1];
    if (next === undefined || next === ' ' || next === '\n') {
      if (SENTENCE_END.has(c)) t += sentence;
      else if (c === ',') t += comma;
    }
  }
  return out;
}

/** Nombre de caractères visibles à l'instant `elapsedMs` (recherche dichotomique dans la ligne de temps). */
export function visibleCountAt(timeline: readonly number[], elapsedMs: number): number {
  let lo = 0;
  let hi = timeline.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (timeline[mid] <= elapsedMs) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Effet machine à écrire : pur (aucun Phaser), piloté par `update(dtMs)`. Compte des points de code (pas des unités UTF-16). */
export class Typewriter {
  private chars: string[] = [];
  private timeline: number[] = [];
  private elapsed = 0;
  private count = 0;

  constructor(
    text: string,
    private readonly opts: TypewriterOptions = {},
  ) {
    this.reset(text);
  }

  /** Recommence avec un nouveau texte (ou le même si omis). */
  reset(text?: string): void {
    if (text !== undefined) this.chars = Array.from(text);
    this.timeline = typewriterTimeline(this.chars, this.opts);
    this.elapsed = 0;
    this.count = 0;
  }

  /** Fait avancer le temps ; retourne true si le nombre de caractères visibles a changé. */
  update(dtMs: number): boolean {
    if (this.done) return false;
    this.elapsed += Math.max(0, Number.isFinite(dtMs) ? dtMs : 0);
    const next = visibleCountAt(this.timeline, this.elapsed);
    const changed = next !== this.count;
    this.count = next;
    return changed;
  }

  /** Affiche immédiatement tout le texte. */
  skip(): void {
    this.count = this.chars.length;
    this.elapsed = this.timeline.length > 0 ? this.timeline[this.timeline.length - 1] : 0;
  }

  /** true quand tout le texte est visible. */
  get done(): boolean {
    return this.count >= this.chars.length;
  }

  get visibleCount(): number {
    return this.count;
  }

  get total(): number {
    return this.chars.length;
  }

  /** Texte actuellement visible. */
  get visible(): string {
    return this.chars.slice(0, this.count).join('');
  }

  /** Texte complet. */
  get full(): string {
    return this.chars.join('');
  }
}

// ───────────────────────────── Barres segmentées ─────────────────────────────

/** Nombre de segments allumés pour `value` sur `max` (borné). */
export function barFill(value: number, max: number, segments: number): number {
  if (!(max > 0) || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(segments, Math.round((value / max) * segments)));
}

/** Barre de progression / de statistique en segments pixel art (Graphics). */
export class SegmentBar {
  readonly graphics: Phaser.GameObjects.Graphics;
  private value = 0;
  private max = 1;

  constructor(
    scene: Phaser.Scene,
    x: number,
    y: number,
    private readonly width: number,
    private readonly height: number,
    private readonly segments: number,
    private color: number,
  ) {
    this.graphics = scene.add.graphics();
    this.graphics.setPosition(x, y);
    this.redraw();
  }

  /** Met à jour la valeur (0..max) et redessine. */
  setValue(value: number, max = 1): void {
    this.value = value;
    this.max = max;
    this.redraw();
  }

  setColor(color: number): void {
    this.color = color;
    this.redraw();
  }

  private redraw(): void {
    const g = this.graphics;
    g.clear();
    const gap = 2;
    const segW = Math.max(2, Math.floor((this.width - gap * (this.segments - 1)) / this.segments));
    const lit = barFill(this.value, this.max, this.segments);
    for (let i = 0; i < this.segments; i++) {
      const sx = i * (segW + gap);
      g.fillStyle(OUTLINE, 1);
      g.fillRect(sx - 1, -1, segW + 2, this.height + 2);
      if (i < lit) {
        g.fillStyle(this.color, 1);
        g.fillRect(sx, 0, segW, this.height);
        g.fillStyle(lighten(this.color, 0.45), 1);
        g.fillRect(sx, 0, segW, Math.max(1, Math.floor(this.height / 3)));
      } else {
        g.fillStyle(0x2a2440, 1);
        g.fillRect(sx, 0, segW, this.height);
      }
    }
  }

  destroy(): void {
    this.graphics.destroy();
  }
}

// ───────────────────────────── Langue : écouteurs sans fuite ─────────────────────────────

/**
 * Abonne `cb` aux changements de langue ET le désabonne automatiquement à la fermeture de la scène
 * (`shutdown` ou `destroy`). Retourne la fonction de désabonnement manuel (idempotente).
 * À appeler dans `create()` : chaque démarrage de la scène crée un abonnement qui disparaît à sa fermeture.
 */
export function bindLanguage(scene: Phaser.Scene, cb: (lang: Language) => void): () => void {
  let off: (() => void) | null = onLanguageChange(cb);
  const release = (): void => {
    if (off) {
      off();
      off = null;
    }
    scene.events.off('shutdown', release);
    scene.events.off('destroy', release);
  };
  scene.events.once('shutdown', release);
  scene.events.once('destroy', release);
  return release;
}

// ───────────────────────────── Transitions de scène ─────────────────────────────

const transitioning = new WeakSet<Phaser.Scene>();

/** À appeler au début de `create()` : réarme les transitions et fait un fondu d'entrée (0 = sans fondu). */
export function beginScene(scene: Phaser.Scene, fadeInMs = 250): void {
  transitioning.delete(scene);
  if (fadeInMs > 0) scene.cameras.main.fadeIn(fadeInMs, 0, 0, 0);
}

/**
 * Démarre une autre scène après un fondu de sortie. Idempotent : un second appel pendant la transition est ignoré.
 * Un filet de sécurité temporel garantit le changement même si l'événement de fin de fondu n'arrive pas
 * (onglet en arrière-plan).
 */
export function transitionTo(scene: Phaser.Scene, key: string, data?: object, fadeOutMs = 250): void {
  if (transitioning.has(scene)) return;
  transitioning.add(scene);
  let started = false;
  const go = (): void => {
    if (started) return;
    started = true;
    scene.scene.start(key, data);
  };
  if (fadeOutMs <= 0) {
    go();
    return;
  }
  scene.cameras.main.once('camerafadeoutcomplete', go);
  scene.cameras.main.fadeOut(fadeOutMs, 0, 0, 0);
  scene.time.delayedCall(fadeOutMs + 600, go);
}

// ───────────────────────────── Boutons ─────────────────────────────

/** Options de `UiButton`. */
export interface ButtonOptions {
  width: number;
  height: number;
  /** Libellé recalculé à chaque `refresh()` (ex. `() => t('menu.play')`). */
  label: () => string;
  fontSize?: FontSizeName | number;
  style?: PanelStyle;
  selectedStyle?: PanelStyle;
  disabledStyle?: PanelStyle;
  textColor?: number | string;
  onClick?: () => void;
  onHover?: () => void;
}

/** Bouton pixel art (panneau + libellé), sélectionnable au clavier/à la manette et cliquable à la souris. */
export class UiButton {
  readonly container: Phaser.GameObjects.Container;
  private readonly normal: Phaser.GameObjects.Graphics;
  private readonly selectedG: Phaser.GameObjects.Graphics;
  private readonly disabledG: Phaser.GameObjects.Graphics;
  private readonly text: Phaser.GameObjects.Text;
  private isSelected = false;
  private isEnabled = true;

  constructor(
    scene: Phaser.Scene,
    x: number,
    y: number,
    private readonly opts: ButtonOptions,
  ) {
    const { width: w, height: h } = opts;
    this.normal = createPanel(scene, 0, 0, w, h, opts.style ?? PANEL_STYLES.default);
    this.selectedG = createPanel(scene, 0, 0, w, h, opts.selectedStyle ?? PANEL_STYLES.selected);
    this.disabledG = createPanel(scene, 0, 0, w, h, opts.disabledStyle ?? PANEL_STYLES.disabled);
    this.text = createText(scene, w / 2, h / 2, opts.label(), {
      size: opts.fontSize ?? 'md',
      color: opts.textColor ?? UI_THEME.text,
      origin: [0.5, 0.5],
      align: 'center',
    });
    const zone = scene.add.zone(0, 0, w, h).setOrigin(0, 0);
    this.container = scene.add.container(x, y, [this.normal, this.selectedG, this.disabledG, this.text, zone]);
    zone.setInteractive({ useHandCursor: true });
    zone.on('pointerover', () => {
      if (this.isEnabled) opts.onHover?.();
    });
    zone.on('pointerdown', () => {
      if (this.isEnabled) opts.onClick?.();
    });
    this.applyState();
  }

  setSelected(selected: boolean): void {
    this.isSelected = selected;
    this.applyState();
  }

  setEnabled(enabled: boolean): void {
    this.isEnabled = enabled;
    this.applyState();
  }

  get selected(): boolean {
    return this.isSelected;
  }

  get enabled(): boolean {
    return this.isEnabled;
  }

  /** Recalcule le libellé (changement de langue). */
  refresh(): void {
    this.text.setText(this.opts.label());
  }

  private applyState(): void {
    this.normal.setVisible(this.isEnabled && !this.isSelected);
    this.selectedG.setVisible(this.isEnabled && this.isSelected);
    this.disabledG.setVisible(!this.isEnabled);
    this.text.setColor(css(this.isEnabled ? (this.opts.textColor ?? (this.isSelected ? UI_THEME.accent : UI_THEME.text)) : UI_THEME.disabled));
  }

  destroy(): void {
    this.container.destroy();
  }
}

// ───────────────────────────── Décors : aube et cristal brisé ─────────────────────────────

/** Décor animé : `update(timeMs)` à appeler depuis `scene.update`, `destroy()` à la fermeture. */
export interface DecorHandle {
  update(timeMs: number): void;
  destroy(): void;
}

/** Options du fond « aube ». */
export interface DawnOptions {
  /** Voile sombre (0..1) pour faire ressortir l'interface. */
  dim?: number;
  /** Cristal brisé : centre (px écran) et échelle entière du sprite 16×16 ; absent = pas de cristal. */
  crystal?: { x: number; y: number; scale: number } | null;
  /** Profondeur de tous les éléments (défaut -100). */
  depth?: number;
}

function hasAtlas(scene: Phaser.Scene): boolean {
  return scene.textures.exists(ATLAS_KEY);
}

/**
 * Fond « aube » : ciel en bandes (violet nuit → orangé), étoiles scintillantes, deux silhouettes de montagnes et,
 * si demandé, le Cristal de l'Aube brisé en deux moitiés flottantes entourées d'éclats en orbite.
 */
export function createDawnBackground(scene: Phaser.Scene, opts: DawnOptions = {}): DecorHandle {
  const depth = opts.depth ?? -100;
  const objects: Phaser.GameObjects.GameObject[] = [];

  const sky = scene.add.graphics().setDepth(depth);
  const bands = skyBandColors(15, 0x0a0820, 0x9a4a5c);
  const bandH = Math.ceil(GAME_HEIGHT / bands.length);
  bands.forEach((c, i) => {
    sky.fillStyle(c, 1);
    sky.fillRect(0, i * bandH, GAME_WIDTH, bandH);
  });
  objects.push(sky);

  const stars = scene.add.graphics().setDepth(depth + 1);
  objects.push(stars);
  const starCount = 90;
  const starData = Array.from({ length: starCount }, (_, i) => ({
    x: Math.floor(hash01(i, 1, 11) * GAME_WIDTH),
    y: Math.floor(hash01(i, 2, 11) * GAME_HEIGHT * 0.62),
    big: hash01(i, 3, 11) > 0.82,
    phase: hash01(i, 4, 11) * Math.PI * 2,
  }));
  let lastStars = -1000;
  const drawStars = (timeMs: number): void => {
    stars.clear();
    for (const s of starData) {
      const a = 0.35 + 0.65 * Math.max(0, Math.sin(timeMs * 0.0024 + s.phase));
      stars.fillStyle(0xfff4d0, a);
      const size = s.big ? 4 : 2;
      stars.fillRect(s.x, s.y, size, size);
    }
  };
  drawStars(0);

  const mountains = scene.add.graphics().setDepth(depth + 2);
  objects.push(mountains);
  const layer = (base: number, amp: number, color: number, seed: number): void => {
    mountains.fillStyle(color, 1);
    for (let cx = 0; cx < GAME_WIDTH; cx += 16) {
      const n = hash01(Math.floor(cx / 64), seed, 5) * 0.6 + hash01(Math.floor(cx / 16), seed, 6) * 0.4;
      const top = Math.floor((base - n * amp) / 16) * 16;
      mountains.fillRect(cx, top, 16, GAME_HEIGHT - top);
    }
  };
  layer(520, 110, 0x2a1a3e, 1);
  layer(600, 80, 0x150f26, 2);

  const parts: Array<{ update(t: number): void }> = [];
  if (opts.crystal && hasAtlas(scene)) {
    const { x, y, scale } = opts.crystal;
    const glow = scene.add.graphics().setDepth(depth + 3);
    objects.push(glow);
    const left = scene.add.image(x - 6 * scale * 0.5, y, ATLAS_KEY, 'decor_crystal').setScale(scale).setDepth(depth + 4);
    const right = scene.add.image(x + 6 * scale * 0.5, y, ATLAS_KEY, 'decor_crystal').setScale(scale).setDepth(depth + 4);
    left.setCrop(0, 0, 8, 16);
    right.setCrop(8, 0, 8, 16);
    const crack = scene.add.graphics().setDepth(depth + 5);
    objects.push(left, right, crack);
    const shards = Array.from({ length: 7 }, (_, i) => {
      const img = scene.add.image(x, y, ATLAS_KEY, i % 2 === 0 ? 'fx_shard' : 'decor_crystal').setDepth(depth + 4);
      img.setScale(i % 2 === 0 ? Math.max(2, Math.round(scale / 2)) : Math.max(1, Math.round(scale / 4)));
      objects.push(img);
      return { img, orbit: scale * (8 + (i % 3) * 3), speed: 0.0004 + (i % 4) * 0.00012, phase: (i / 7) * Math.PI * 2 };
    });
    parts.push({
      update: (t: number): void => {
        const bob = Math.sin(t * 0.0014) * 6;
        left.setPosition(x - scale * 3, y + bob);
        right.setPosition(x + scale * 3, y - bob);
        left.setAngle(-5 + Math.sin(t * 0.0011) * 2);
        right.setAngle(5 + Math.sin(t * 0.0013) * 2);
        glow.clear();
        const pulse = 0.5 + 0.5 * Math.sin(t * 0.002);
        for (let k = 3; k >= 1; k--) {
          glow.fillStyle(0x46e6ff, 0.05 + 0.025 * pulse);
          glow.fillCircle(x, y, scale * (6 + k * 4));
        }
        crack.clear();
        crack.fillStyle(0xffffff, 0.35 + 0.35 * pulse);
        crack.fillRect(x - 2, y - scale * 7 + bob, 4, scale * 14);
        for (const s of shards) {
          const a = s.phase + t * s.speed;
          s.img.setPosition(x + Math.cos(a) * s.orbit, y + Math.sin(a * 1.3) * s.orbit * 0.55);
          s.img.setAngle((a * 57) % 360);
        }
      },
    });
  }

  if (opts.dim && opts.dim > 0) {
    const veil = scene.add.graphics().setDepth(depth + 6);
    veil.fillStyle(0x000000, Math.min(1, opts.dim));
    veil.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);
    objects.push(veil);
  }

  return {
    update(timeMs: number): void {
      if (timeMs - lastStars >= 110) {
        lastStars = timeMs;
        drawStars(timeMs);
      }
      for (const p of parts) p.update(timeMs);
    },
    destroy(): void {
      for (const o of objects) o.destroy();
    },
  };
}

/** Options du fond thématique. */
export interface ThemeBackgroundOptions {
  /** Voile sombre général (0..1, défaut 0.3). */
  dim?: number;
  depth?: number;
}

/**
 * Fond thématique d'un niveau : sol et mur du thème (tuiles de l'atlas ×4), torches animées + halo, décor propre
 * au thème (statues / plantes / cristaux), voile sombre. Les couleurs viennent de la palette du thème.
 */
export function createThemeBackground(scene: Phaser.Scene, theme: ZoneTheme, opts: ThemeBackgroundOptions = {}): DecorHandle {
  const depth = opts.depth ?? -100;
  const pal = THEME_PALETTES[theme];
  const objects: Phaser.GameObjects.GameObject[] = [];
  const base = scene.add.graphics().setDepth(depth);
  base.fillStyle(pal.void, 1);
  base.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);
  objects.push(base);

  const flames: Array<{ img: Phaser.GameObjects.Image; glow: Phaser.GameObjects.Graphics; x: number; y: number; phase: number }> = [];
  if (hasAtlas(scene)) {
    const S = 4;
    const T = 16 * S;
    const cols = Math.ceil(GAME_WIDTH / T);
    const rows = Math.ceil(GAME_HEIGHT / T);
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        const glyph = cy === 0 || cy === 1 ? '#' : '.';
        const below = cy === 0 ? '#' : '.';
        const img = scene.add
          .image(cx * T, cy * T, ATLAS_KEY, tileFrame(theme, glyph, cx, cy, below))
          .setOrigin(0, 0)
          .setScale(S)
          .setDepth(depth + 1);
        objects.push(img);
      }
    }
    const put = (frame: string, col: number, row: number): Phaser.GameObjects.Image => {
      const img = scene.add
        .image(col * T, row * T, ATLAS_KEY, frame)
        .setOrigin(0, 0)
        .setScale(S)
        .setDepth(depth + 3);
      objects.push(img);
      return img;
    };
    const decorFrame = theme === 'crypt' ? 'decor_statue' : theme === 'grove' ? 'decor_plant' : 'decor_crystal';
    put(decorFrame, 1, 2);
    put(decorFrame, cols - 2, 2);
    put(theme === 'citadel' ? 'decor_banner' : decorFrame, Math.floor(cols / 2), 2);
    for (const col of [4, 8, 11, 15]) {
      const glow = scene.add.graphics().setDepth(depth + 2);
      objects.push(glow);
      const img = put(torchFrame(0), col, 1);
      flames.push({ img, glow, x: col * T + T / 2, y: T + T / 2, phase: hash01(col, 7) * 6 });
    }
  }

  const veil = scene.add.graphics().setDepth(depth + 4);
  veil.fillStyle(0x000000, opts.dim ?? 0.3);
  veil.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);
  for (let i = 0; i < 6; i++) {
    veil.fillStyle(0x000000, 0.1);
    veil.fillRect(0, GAME_HEIGHT - 48 * (i + 1) - 230, GAME_WIDTH, 48);
  }
  veil.fillStyle(0x000000, 0.35);
  veil.fillRect(0, GAME_HEIGHT - 230, GAME_WIDTH, 230);
  objects.push(veil);

  return {
    update(timeMs: number): void {
      for (const f of flames) {
        f.img.setFrame(torchFrame(timeMs + f.phase * 100));
        f.glow.clear();
        const a = 0.12 + 0.05 * Math.sin(timeMs * 0.008 + f.phase);
        f.glow.fillStyle(pal.accent, a);
        f.glow.fillCircle(f.x, f.y, 70);
        f.glow.fillStyle(pal.accent, a * 0.8);
        f.glow.fillCircle(f.x, f.y, 40);
      }
    },
    destroy(): void {
      for (const o of objects) o.destroy();
    },
  };
}

// ───────────────────────────── Portraits d'orateurs ─────────────────────────────

/** Maître Aldric : vieil archiviste encapuchonné à longue barbe blanche (16×16). */
export const PORTRAIT_ALDRIC: readonly string[] = [
  '................',
  '.....oooooo.....',
  '....obbbbbbo....',
  '...obbbbbbbbo...',
  '..obbBBBBBBbbo..',
  '..obBsssssSBbo..',
  '..obBsessesBbo..',
  '..obBssSSssBbo..',
  '..obwwwwwwwwbo..',
  '..owwwWwwWwwwo..',
  '...owwwwwwwwo...',
  '...owwWwwWwwo...',
  '..obbowwwwobbo..',
  '.obbbbowwobbbbo.',
  '.obyybbbbbbyybo.',
  '.oooooooooooooo.',
];

/** Couleurs du portrait d'Aldric. */
export const PORTRAIT_ALDRIC_COLORS: Readonly<Record<string, number>> = {
  o: OUTLINE,
  b: 0x3358b8,
  B: 0x233e86,
  s: 0xf0b98a,
  S: 0xc98a62,
  e: 0x1b1530,
  w: 0xe8ecf4,
  W: 0xa9b6cc,
  y: 0xf5c53d,
};

/** Narrateur : grimoire ouvert (16×16). */
export const PORTRAIT_NARRATOR: readonly string[] = [
  '................',
  '................',
  '................',
  '..oooooooooooo..',
  '.orrrrrrrrrrrro.',
  'orpppppRRpppppro',
  'orpiiipRRpiiipro',
  'orpppppRRpppppro',
  'orpiiipRRpiiipro',
  'orpppppRRpppppro',
  'orpiiipRRpiiipro',
  '.orrrrrrrrrrrro.',
  '..oooooooooooo..',
  '................',
  '................',
  '................',
];

/** Couleurs du portrait du narrateur. */
export const PORTRAIT_NARRATOR_COLORS: Readonly<Record<string, number>> = {
  o: OUTLINE,
  r: 0xc02848,
  R: 0x82182e,
  p: 0xf0e2b0,
  i: 0x4a3420,
};

/** Héros à aligner dans le portrait « heroes ». */
export interface PortraitHero {
  characterId: CharacterId;
  playerId: PlayerId;
}

/** Échelle entière des sprites 16×16 du portrait « heroes » pour `count` héros (largeur totale ≤ 192 px). */
export function heroesPortraitScale(count: number): number {
  if (count <= 2) return 6;
  if (count === 3) return 4;
  return 3;
}

/** Portrait d'orateur (cadre + illustration animée). */
export interface PortraitHandle {
  container: Phaser.GameObjects.Container;
  /** Change d'orateur (reconstruit l'illustration). */
  setSpeaker(speakerId: string): void;
  update(timeMs: number): void;
  destroy(): void;
}

/**
 * Cadre de portrait (w×h) à la position (x, y). Illustrations : Aldric (matrice de pixels), narrateur (grimoire),
 * Lyssa (cristal pulsant), Morvane et Gorgrim (sprites de boss 48×48 ×3), héros (sprites alignés avec marqueur de couleur).
 */
export function createPortrait(
  scene: Phaser.Scene,
  x: number,
  y: number,
  w: number,
  h: number,
  getHeroes: () => readonly PortraitHero[],
): PortraitHandle {
  const frame = createPanel(scene, 0, 0, w, h, PANEL_STYLES.dark);
  const container = scene.add.container(x, y, [frame]);
  let content: Phaser.GameObjects.GameObject[] = [];
  let tick: (t: number) => void = () => undefined;

  const clear = (): void => {
    for (const o of content) o.destroy();
    content = [];
    tick = () => undefined;
  };
  const add = <T extends Phaser.GameObjects.GameObject>(o: T): T => {
    container.add(o);
    content.push(o);
    return o;
  };

  const setSpeaker = (speakerId: string): void => {
    clear();
    const kind = portraitKindOf(speakerId);
    const cx = w / 2;
    const cy = h / 2;
    const atlas = hasAtlas(scene);
    if (kind === 'aldric' || kind === 'narrator' || !atlas) {
      const g = add(scene.add.graphics());
      const rows = kind === 'aldric' ? PORTRAIT_ALDRIC : PORTRAIT_NARRATOR;
      const colors = kind === 'aldric' ? PORTRAIT_ALDRIC_COLORS : PORTRAIT_NARRATOR_COLORS;
      const scale = Math.max(1, Math.floor(Math.min(w, h) / 16) - 1);
      drawPixelMatrix(g, rows, colors, Math.floor(cx - 8 * scale), Math.floor(cy - 8 * scale), scale);
      tick = (t) => g.setY(Math.round(Math.sin(t * 0.002) * 2));
      return;
    }
    if (kind === 'lyssa') {
      const glow = add(scene.add.graphics());
      const img = add(scene.add.image(cx, cy, ATLAS_KEY, 'decor_crystal').setScale(8));
      tick = (t) => {
        const p = 0.5 + 0.5 * Math.sin(t * 0.003);
        glow.clear();
        glow.fillStyle(0x46e6ff, 0.12 + 0.1 * p);
        glow.fillCircle(cx, cy, 70 + 10 * p);
        glow.fillStyle(0xc8faff, 0.08 + 0.08 * p);
        glow.fillCircle(cx, cy, 44 + 6 * p);
        img.setY(cy + Math.sin(t * 0.0018) * 5);
      };
      return;
    }
    if (kind === 'morvane' || kind === 'gorgrim') {
      const bossKind = kind === 'morvane' ? 'morvane' : 'golem';
      const img = add(scene.add.image(cx, cy, ATLAS_KEY, bossFrame(bossKind, 0)).setScale(3));
      tick = (t) => img.setFrame(bossFrame(bossKind, Math.floor(t / 420)));
      return;
    }
    // heroes
    const heroes = getHeroes();
    const count = Math.max(1, heroes.length);
    const scale = heroesPortraitScale(count);
    const size = 16 * scale;
    const totalW = count * size;
    const startX = cx - totalW / 2 + size / 2;
    const sprites = heroes.map((hero, i) => {
      const px = startX + i * size;
      const img = add(scene.add.image(px, cy - 6, ATLAS_KEY, heroFrame(hero.characterId, 'down', 0)).setScale(scale));
      const mark = add(scene.add.graphics());
      mark.fillStyle(OUTLINE, 1);
      mark.fillRect(px - size / 2 + 2, cy + size / 2 - 2, size - 4, 8);
      mark.fillStyle(playerColor(hero.playerId), 1);
      mark.fillRect(px - size / 2 + 4, cy + size / 2, size - 8, 4);
      return { img, hero, i };
    });
    tick = (t) => {
      for (const s of sprites) {
        s.img.setFrame(heroFrame(s.hero.characterId, 'down', stepOf(Math.floor(t / 320 + s.i))));
        s.img.setY(cy - 6 + (Math.floor(t / 320 + s.i) % 2 === 0 ? 0 : -3));
      }
    };
  };

  return {
    container,
    setSpeaker,
    update: (t: number) => tick(t),
    destroy: () => {
      clear();
      container.destroy();
    },
  };
}
