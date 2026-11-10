/**
 * Logique PURE de l'interface du tutoriel (aucune dépendance à Phaser, testée sans lui) : placement de la carte d'instruction
 * sans recouvrir les zones du HUD, cadres de mise en évidence, puce « Passer », paramètres de texte, rebond des repères.
 * Aucune règle de jeu ici : tout vient du `TutorialView` du directeur.
 */
import { edgeIndicator } from './camera';
import { boundsOverlap, type ScreenBounds } from './hud';
import type { ScreenRect } from './splitscreen';
import type { ButtonName, HudRegionId, TutorialView } from '../tutorial/types';

/** Marge (px écran) entre la carte et les bords / les autres éléments. */
export const CARD_MARGIN = 12;
/** Marge (px) des cadres de mise en évidence autour de leur zone. */
export const HIGHLIGHT_PAD = 5;
/** Après ce temps d'affichage (ms de simulation), la carte d'une étape à bouton se replie sur une ligne. */
export const COMPACT_AFTER_MS = 9000;
/** Hauteur (px) réservée au-dessus d'un cadre d'invite / de panneau pour sa légende (texte de ~20 px + contour + marge). */
export const LEGEND_RESERVE = 40;
/** Taille de police logique des légendes de cadres et du titre de la carte (20 px ; 22 px en tactile : lisible sur téléphone). */
export function labelFontSize(touch: boolean): number {
  return touch ? 22 : 20;
}

/** Largeur de la carte (px) : au plus 54 % de la vue (60 % en tactile), bornée. */
export function cardWidth(vp: ScreenRect, touch: boolean): number {
  return Math.round(Math.max(220, Math.min(vp.w * (touch ? 0.6 : 0.54), 720)));
}

/** Taille de police logique du texte de la carte (22 px ; 26 px en tactile). */
export function cardFontSize(touch: boolean): number {
  return touch ? 26 : 22;
}

function inside(b: ScreenBounds, vp: ScreenRect): boolean {
  return b.x0 >= vp.x && b.y0 >= vp.y && b.x1 <= vp.x + vp.w && b.y1 <= vp.y + vp.h;
}

/**
 * Place la carte (de taille `size`) dans la vue `vp` : en bas au centre, juste au-dessus de l'invite et de la bulle de panneau
 * (`avoid` = leurs rectangles + les cadres de mise en évidence) ; si cela recouvre une zone à éviter, en haut au centre ; en
 * dernier recours, en bas (la carte reste lisible, elle est au-dessus de tout).
 */
export function placeCard(vp: ScreenRect, size: { w: number; h: number }, avoid: readonly ScreenBounds[], prompts: readonly ScreenBounds[] = []): ScreenBounds {
  const cx = vp.x + vp.w / 2;
  const x0 = Math.round(cx - size.w / 2);
  const bottomEdge = vp.y + vp.h - CARD_MARGIN;
  let bottomLimit = bottomEdge;
  for (const p of prompts) bottomLimit = Math.min(bottomLimit, p.y0 - CARD_MARGIN);
  const bottom: ScreenBounds = { x0, y0: Math.round(bottomLimit - size.h), x1: x0 + size.w, y1: Math.round(bottomLimit) };
  const top: ScreenBounds = { x0, y0: Math.round(vp.y + CARD_MARGIN), x1: x0 + size.w, y1: Math.round(vp.y + CARD_MARGIN + size.h) };
  const clear = (b: ScreenBounds): boolean => inside(b, vp) && !avoid.some((a) => boundsOverlap(a, b));
  if (clear(bottom)) return bottom;
  if (clear(top)) return top;
  // dernier recours : en bas, sans sortir de la vue
  const fallback: ScreenBounds = { x0, y0: Math.round(bottomEdge - size.h), x1: x0 + size.w, y1: Math.round(bottomEdge) };
  return inside(fallback, vp) ? fallback : bottom;
}

/** Cadre de mise en évidence d'une zone du HUD. */
export interface HighlightFrame {
  id: HudRegionId;
  bounds: ScreenBounds;
  /** Clé i18n de la légende (`tutorial.legend.<id>`). */
  legendKey: string;
}

/**
 * Cadres à dessiner : uniquement les zones demandées par l'étape ET actuellement exposées par `PlayerHud.regions()`
 * (zone absente ou masquée → pas de cadre). Chaque cadre déborde de `HIGHLIGHT_PAD` px.
 */
export function highlightFrames(ids: readonly HudRegionId[], regions: Partial<Record<HudRegionId, ScreenBounds>>): HighlightFrame[] {
  const out: HighlightFrame[] = [];
  for (const id of ids) {
    const b = regions[id];
    if (!b) continue;
    out.push({ id, bounds: { x0: b.x0 - HIGHLIGHT_PAD, y0: b.y0 - HIGHLIGHT_PAD, x1: b.x1 + HIGHLIGHT_PAD, y1: b.y1 + HIGHLIGHT_PAD }, legendKey: `tutorial.legend.${id}` });
  }
  return out;
}

/** Zones du HUD actuellement visibles (condition `regionVisible` du directeur). */
export function visibleRegionIds(regions: Partial<Record<HudRegionId, ScreenBounds>>): HudRegionId[] {
  return (Object.keys(regions) as HudRegionId[]).filter((k) => regions[k] !== undefined);
}

/**
 * Position de la légende d'un cadre. Pour un cadre de la moitié GAUCHE de la vue (pile d'infos du coin haut-gauche : nom, cœurs, spécial,
 * clés, objectif), la légende va À DROITE du cadre, alignée sur lui : au-dessus ou en dessous elle tomberait sur le texte ou les icônes
 * voisins. Sinon (ou si la droite est occupée / hors vue) : au-dessus du cadre si la place existe, sinon en dessous.
 * `avoid` : autres rectangles que la légende ne doit pas recouvrir (autres cadres).
 */
export function legendPosition(
  frame: ScreenBounds,
  vp: ScreenRect,
  textSize: { w: number; h: number },
  avoid: readonly ScreenBounds[] = [],
): { x: number; y: number } {
  if (frame.x0 < vp.x + vp.w / 2) {
    let x = frame.x1 + 8;
    const y = Math.max(vp.y + 2, Math.round(frame.y0 + (frame.y1 - frame.y0 - textSize.h) / 2));
    // à droite du cadre ; si un autre rectangle à éviter s'y trouve (autre cadre, rangée d'équipement voisine de l'emplacement cœur), on se décale à droite de CE rectangle (3 essais au plus)
    for (let attempt = 0; attempt < 3; attempt++) {
      const box: ScreenBounds = { x0: x, y0: y, x1: x + textSize.w, y1: y + textSize.h };
      if (box.x1 > vp.x + vp.w - 4) break;
      const hit = avoid.find((o) => o !== frame && boundsOverlap(o, box));
      if (!hit) return { x: Math.round(x), y };
      x = hit.x1 + 8;
    }
  }
  const x = Math.max(vp.x + 4, Math.min(frame.x1 - textSize.w, vp.x + vp.w - textSize.w - 4));
  const above = frame.y0 - textSize.h - 4;
  return { x: Math.round(x), y: Math.round(above >= vp.y + 2 ? above : frame.y1 + 4) };
}

/**
 * Rectangle de la puce « Passer ». Clavier / manette : en haut au centre, SOUS le bandeau de nom de salle (qui finit vers y = 111) et
 * au-dessus des toasts (centrés vers y = 0,24 × hauteur). Tactile : sur le bord DROIT, à mi-hauteur (hors de la colonne centrale où
 * passent bandeau, toasts et repères du monde, et au-dessus du losange de boutons), avec une cible de 96 px logiques (≈ 48 px à
 * l'échelle téléphone, au-dessus du minimum de 44 px).
 */
export function skipChipRect(vp: ScreenRect, touch: boolean): ScreenBounds {
  if (touch) {
    const w = 260;
    const h = 96;
    const x1 = Math.round(vp.x + vp.w - 12);
    const y0 = Math.round(vp.y + vp.h * 0.45 - h / 2);
    return { x0: x1 - w, y0, x1, y1: y0 + h };
  }
  const w = 230;
  const h = 44;
  const x0 = Math.round(vp.x + vp.w / 2 - w / 2);
  const y0 = Math.round(vp.y + 112);
  return { x0, y0, x1: x0 + w, y1: y0 + h };
}

/** Texte replié d'une ligne (« 4/31 · Attaque : X ») : seulement si l'étape nomme un bouton et que la lecture a eu lieu. */
export function isCompact(view: Pick<TutorialView, 'buttons' | 'activeMs' | 'waiting' | 'interrupt' | 'stuck'> & { noCompact?: boolean }): boolean {
  return view.noCompact !== true && view.buttons.length > 0 && view.activeMs >= COMPACT_AFTER_MS && !view.waiting && view.interrupt === null && !view.stuck;
}

/** Premier bouton nommé par l'étape qui a un nom court (`tutorial.name.<bouton>`), ou null. */
export function compactButton(buttons: readonly ButtonName[]): ButtonName | null {
  return buttons.find((b) => b !== 'skip' && b !== 'pause') ?? null;
}

/** Décalage vertical (px) du rebond d'un repère monde. */
export function markerBounce(timeMs: number, amplitude = 3): number {
  return Math.round(Math.sin(timeMs / 180) * amplitude);
}

/** Opacité pulsante (0.55..1) des cadres et de la barre de bord. */
export function pulseAlpha(timeMs: number): number {
  return 0.775 + 0.225 * Math.sin(timeMs / 220);
}

/**
 * Barre pulsante au bord de la vue qui regarde le partenaire : visible seulement s'il est HORS de la vue. Coordonnées dans le
 * repère de l'écran (la vue commence en `vp.x, vp.y`).
 */
export function partnerEdge(
  partner: { x: number; y: number } | null,
  camCenter: { x: number; y: number },
  zoom: number,
  vp: ScreenRect,
): { visible: boolean; x: number; y: number; angle: number } {
  if (!partner) return { visible: false, x: 0, y: 0, angle: 0 };
  const e = edgeIndicator((partner.x - camCenter.x) * zoom, (partner.y - camCenter.y) * zoom, vp.w, vp.h, 18);
  return { visible: e.visible, x: vp.x + e.x, y: vp.y + e.y, angle: e.angle };
}
