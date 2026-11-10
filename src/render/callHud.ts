/**
 * Indicateur d'« appel » : PARTIE PHASER (dessin seulement). Tout le calcul (projection au bord, phases des demi-cercles,
 * couleurs, évitement de chevauchement, anneaux) est dans `callIndicator.ts` (pur, testé sous Node) ; ce module n'utilise
 * Phaser que par TYPE (`import type`) et ne décide d'aucune règle de jeu.
 *
 *  - `CallEdgeHud` : un par joueur (dans son HUD) ; dessine, au bord de SA vue, un point + 3 arcs concentriques (vers l'intérieur) par appelant HORS de
 *    sa vue. Pour un appel AUTOMATIQUE (objet laissé aux coéquipiers) le point est remplacé par un petit symbole (cœur / demi-cœur / icône de l'objet :
 *    image d'atlas, créée à la demande) sur un disque (clair pour un cœur, sombre pour un objet) cerclé de la couleur de l'émetteur. Un émetteur VISIBLE dans la vue (appel automatique seulement) n'a ni arcs ni anneaux : son symbole flotte au-dessus de sa tête, dans ce seul HUD (donc filtré par destinataire). Un seul objet `Graphics` réutilisé : il n'est redessiné que tant qu'un appel est affichable (puis vidé une fois).
 *  - `CallWorldFx` : un pour la scène ; dessine les anneaux d'onde autour de chaque appelant dans le monde (vus par toutes les
 *    caméras qui contiennent l'appelant, l'appelant compris).
 * Aucune allocation par frame : tableaux et points sont préalloués.
 */
import type Phaser from 'phaser';
import type { GameState, PlayerState, Vec2 } from '../core/types';
import type { ViewContext } from '../entities/common';
import { ATLAS_KEY } from './art/contract';
import {
  CALL_ARC_SPAN,
  CALL_DOT_RADIUS,
  CALL_SYMBOL_BACK_RADIUS,
  CALL_SYMBOL_RING_WIDTH,
  CALL_LINE_WIDTH,
  CALL_MAX_CALLERS,
  CALL_MIN_SEPARATION,
  CALL_RADII,
  CALL_WAVE_COUNT,
  autoCallOverheadPos,
  callArcCenterAngle,
  callColor,
  callEdgeIndicator,
  callEdgeMargin,
  callElapsedMs,
  callEndFade,
  callHudScale,
  callSignalElapsedMs,
  callSymbolBack,
  callSymbolDisplayScale,
  callSymbolEdgeMargin,
  callSymbolFor,
  callWaveAlphas,
  callWorldRings,
  collectCallers,
  isCallSignalActive,
  separateFromAnchors,
  type CallWorldRing,
} from './callIndicator';
import type { ScreenRect } from './splitscreen';

/** Couleur du contour sombre des demi-cercles (lisibilité sur tous les fonds), comme `SEPARATOR_COLOR`. */
const OUTLINE_COLOR = 0x0b0912;
const HALF_SPAN = CALL_ARC_SPAN / 2;

/** Demi-cercles d'appel au bord de la vue d'UN joueur. */
export class CallEdgeHud {
  private readonly gfx: Phaser.GameObjects.Graphics;
  private readonly scale: number;
  private readonly margin: number;
  /** Marge (centre → bord de la vue) d'un SYMBOLE d'appel automatique : plus grande que celle du point (le disque ne déborde pas de la vue). */
  private readonly symbolMargin: number;
  private readonly minSeparation: number;
  private readonly callers: PlayerState[] = [];
  private readonly alphas: number[] = [0, 0, 0];
  /** Points de travail : [autres indicateurs copiés…, puis un ancrage par appelant placé]. */
  private readonly work: Vec2[];
  /** Capacité du tableau de travail : `otherCapacity` + `CALL_MAX_CALLERS`. */
  private readonly workCapacity: number;
  private readonly otherCapacity: number;
  private readonly placedIdx: number[] = [];
  private readonly placedAngle: number[] = [];
  /** Vrai pour un symbole flottant au-dessus d'un émetteur visible (ni arcs ni projection au bord). */
  private readonly placedOverhead: boolean[] = [];
  private readonly placedCaller: PlayerState[] = [];
  /** Images des symboles (créées à la demande, une par appelant automatique affiché au plus) et frame courante de chacune. */
  private readonly symbols: Phaser.GameObjects.Image[] = [];
  private readonly symbolFrames: string[] = [];
  private symbolsShown = 0;
  private readonly depth: number;
  private viewerId = -1;
  private drawn = false;

  /**
   * @param ctx contexte de vue (scène, rig, zoom)
   * @param vp rectangle d'écran de la vue du joueur
   * @param depth profondeur d'affichage
   * @param otherCapacity nombre maximal d'autres indicateurs de bord (`others` de `update`) : fourni par l'appelant, qui possède
   *   les flèches (alliés à terre + derniers ennemis), pour ne pas dupliquer leur nombre ici
   */
  constructor(
    private readonly ctx: ViewContext,
    private readonly vp: ScreenRect,
    depth: number,
    otherCapacity: number,
  ) {
    this.depth = depth;
    this.otherCapacity = Math.max(0, Math.floor(otherCapacity));
    this.workCapacity = this.otherCapacity + CALL_MAX_CALLERS;
    this.work = Array.from({ length: this.workCapacity }, () => ({ x: 0, y: 0 }));
    this.scale = callHudScale(ctx.zoom);
    this.margin = callEdgeMargin(this.scale);
    this.symbolMargin = callSymbolEdgeMargin(this.scale);
    this.minSeparation = CALL_MIN_SEPARATION * this.scale;
    this.gfx = ctx.scene.add.graphics();
    this.gfx.setDepth(depth);
    ctx.rig.registerHud(this.gfx);
  }

  /**
   * Met à jour l'affichage.
   * @param state état de simulation (lecture seule)
   * @param viewerId joueur propriétaire de cette vue (son propre appel n'a pas d'indicateur de bord)
   * @param camCenter centre monde de sa caméra
   * @param others autres indicateurs de bord déjà placés (centres en repère de la vue) : on s'en écarte
   * @param otherCount nombre d'éléments significatifs de `others`
   */
  update(state: GameState, viewerId: number, camCenter: Vec2, others: readonly Vec2[], otherCount: number): void {
    this.viewerId = viewerId;
    const n = collectCallers(state.players, viewerId, this.callers);
    if (n === 0) {
      this.clearOnce();
      return;
    }
    const { vp, ctx } = this;
    let workN = Math.min(otherCount, this.otherCapacity);
    for (let i = 0; i < workN; i++) {
      this.work[i].x = others[i].x;
      this.work[i].y = others[i].y;
    }
    let placed = 0;
    for (let i = 0; i < n && workN < this.workCapacity; i++) {
      const c = this.callers[i];
      const isSymbol = callSymbolFor(c, viewerId) !== null;
      const margin = isSymbol ? this.symbolMargin : this.margin;
      const e = callEdgeIndicator(c.pos, camCenter, ctx.zoom, vp.w, vp.h, margin);
      if (!e.visible) {
        // l'appelant est dans la vue : appel manuel = anneaux du monde (CallWorldFx), pas d'indicateur de bord ; appel automatique = symbole au-dessus de sa tête (ce HUD seul)
        if (!isSymbol) continue;
        const o = this.work[workN];
        autoCallOverheadPos(c.pos, camCenter, ctx.zoom, vp.w, vp.h, margin, o);
        this.placedIdx[placed] = workN;
        this.placedAngle[placed] = 0;
        this.placedOverhead[placed] = true;
        this.placedCaller[placed] = c;
        placed++;
        workN++;
        continue;
      }
      const a = this.work[workN];
      a.x = e.x;
      a.y = e.y;
      separateFromAnchors(a, this.work, workN, vp.w, vp.h, margin, this.minSeparation);
      this.placedIdx[placed] = workN;
      this.placedAngle[placed] = e.angle;
      this.placedOverhead[placed] = false;
      this.placedCaller[placed] = c;
      placed++;
      workN++;
    }
    if (placed === 0) {
      this.clearOnce();
      return;
    }
    this.draw(placed);
  }

  private clearOnce(): void {
    if (!this.drawn) return;
    this.gfx.clear();
    this.hideSymbols(0);
    this.drawn = false;
  }

  /** Masque les images de symbole à partir de l'indice `from` (celles qui ne servent pas ce frame). */
  private hideSymbols(from: number): void {
    for (let i = from; i < this.symbolsShown; i++) this.symbols[i]?.setVisible(false);
    this.symbolsShown = from;
  }

  /** Image du symbole d'indice `i` (créée à la demande, enregistrée comme objet d'interface), positionnée en (`x`, `y`) au centre, mise à l'échelle et à l'opacité demandées. */
  private placeSymbol(i: number, frame: string, x: number, y: number, scale: number, alpha: number): void {
    let img = this.symbols[i];
    if (!img) {
      img = this.ctx.scene.add.image(x, y, ATLAS_KEY, frame);
      img.setOrigin(0.5, 0.5).setDepth(this.depth + 0.1);
      this.ctx.rig.registerHud(img);
      this.symbols[i] = img;
      this.symbolFrames[i] = frame;
    } else if (this.symbolFrames[i] !== frame) {
      img.setFrame(frame);
      this.symbolFrames[i] = frame;
    }
    img.setPosition(x, y).setScale(scale).setAlpha(alpha).setVisible(true);
  }

  private draw(placed: number): void {
    const g = this.gfx;
    const s = this.scale;
    const lw = CALL_LINE_WIDTH * s;
    let symbols = 0;
    g.clear();
    for (let k = 0; k < placed; k++) {
      const caller = this.placedCaller[k];
      const p = this.work[this.placedIdx[k]];
      const cx = this.vp.x + p.x;
      const cy = this.vp.y + p.y;
      const center = callArcCenterAngle(this.placedAngle[k]);
      const color = callColor(caller.id);
      const elapsed = callSignalElapsedMs(caller);
      const fade = callEndFade(elapsed);
      callWaveAlphas(elapsed, this.alphas);
      for (let i = 0; i < (this.placedOverhead[k] ? 0 : CALL_WAVE_COUNT); i++) {
        const r = CALL_RADII[i] * s;
        const alpha = this.alphas[i] * fade;
        // les arcs partent du point (collé au bord) vers l'INTÉRIEUR de la vue, à l'opposé de l'appelant
        g.lineStyle(lw + 2 * s, OUTLINE_COLOR, 0.6 * alpha);
        g.beginPath();
        g.arc(cx, cy, r, center - HALF_SPAN, center + HALF_SPAN, false);
        g.strokePath();
        g.lineStyle(lw, color, alpha);
        g.beginPath();
        g.arc(cx, cy, r, center - HALF_SPAN, center + HALF_SPAN, false);
        g.strokePath();
      }
      const symbol = callSymbolFor(caller, this.viewerId);
      if (symbol === null) {
        // point d'origine de l'onde (centre des arcs), collé au bord de la vue (appel manuel : inchangé)
        g.fillStyle(OUTLINE_COLOR, 0.8 * fade);
        g.fillCircle(cx, cy, CALL_DOT_RADIUS * s);
        g.fillStyle(color, fade);
        g.fillCircle(cx, cy, (CALL_DOT_RADIUS - 1) * s);
      } else {
        // appel automatique : le point devient un petit symbole sur un disque (clair pour un cœur, sombre pour un objet) cerclé de la couleur de l'émetteur (lisible sur tout fond)
        const back = callSymbolBack(symbol, OUTLINE_COLOR);
        g.fillStyle(back.color, back.alpha * fade);
        g.fillCircle(cx, cy, CALL_SYMBOL_BACK_RADIUS * s);
        g.lineStyle(CALL_SYMBOL_RING_WIDTH * s, color, fade);
        g.strokeCircle(cx, cy, CALL_SYMBOL_BACK_RADIUS * s);
        this.placeSymbol(symbols, symbol, cx, cy, callSymbolDisplayScale(s), fade);
        symbols++;
      }
    }
    this.hideSymbols(symbols);
    this.drawn = true;
  }

  destroy(): void {
    this.gfx.destroy();
    for (const img of this.symbols) img.destroy();
    this.symbols.length = 0;
    this.symbolsShown = 0;
    this.callers.length = 0;
    this.placedCaller.length = 0;
  }
}

/** Anneaux d'onde autour des appelants dans le monde (visibles par toutes les caméras dont la vue contient l'appelant). */
export class CallWorldFx {
  private readonly gfx: Phaser.GameObjects.Graphics;
  private readonly rings: CallWorldRing[] = [];
  private drawn = false;

  /**
   * @param ctx contexte de vue
   * @param depth profondeur d'affichage monde (au-dessus de l'obscurité des salles sombres : un appel doit se voir dans le noir)
   */
  constructor(
    private readonly ctx: ViewContext,
    depth: number,
  ) {
    this.gfx = ctx.scene.add.graphics();
    this.gfx.setDepth(depth);
    ctx.rig.registerWorld(this.gfx);
  }

  /**
   * @param state état de simulation (lecture seule)
   * @param posOf position monde d'affichage d'un joueur (position interpolée du sprite), null si inconnue
   */
  update(state: GameState, posOf: (playerId: number) => Vec2 | null): void {
    const g = this.gfx;
    let any = false;
    for (let i = 0; i < state.players.length; i++) {
      const p = state.players[i];
      if (!isCallSignalActive(p)) continue;
      const pos = posOf(p.id);
      if (!pos) continue;
      if (!any) {
        g.clear();
        any = true;
      }
      const color = callColor(p.id);
      const elapsed = callElapsedMs(p);
      const fade = callEndFade(elapsed);
      const n = callWorldRings(elapsed, this.rings);
      // trait de 1,5 px monde (3 à 4,5 px d'écran) : net aux deux zooms
      for (let k = 0; k < n; k++) {
        const ring = this.rings[k];
        g.lineStyle(2.5, OUTLINE_COLOR, 0.5 * ring.alpha * fade);
        g.strokeCircle(pos.x, pos.y, ring.radius);
        g.lineStyle(1.5, color, ring.alpha * fade);
        g.strokeCircle(pos.x, pos.y, ring.radius);
      }
    }
    if (any) this.drawn = true;
    else if (this.drawn) {
      g.clear();
      this.drawn = false;
    }
  }

  /** Efface tout (changement de salle). */
  clear(): void {
    this.gfx.clear();
    this.drawn = false;
  }

  destroy(): void {
    this.gfx.destroy();
    this.rings.length = 0;
  }
}
