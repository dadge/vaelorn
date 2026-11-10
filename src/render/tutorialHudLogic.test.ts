import { describe, expect, it } from 'vitest';
import { boundsOverlap, type ScreenBounds } from './hud';
import {
  COMPACT_AFTER_MS,
  CARD_MARGIN,
  HIGHLIGHT_PAD,
  cardFontSize,
  cardWidth,
  compactButton,
  highlightFrames,
  isCompact,
  legendPosition,
  markerBounce,
  partnerEdge,
  placeCard,
  pulseAlpha,
  skipChipRect,
  visibleRegionIds,
} from './tutorialHudLogic';

const FULL = { x: 0, y: 0, w: 1280, h: 720 };
const SMALL = { x: 0, y: 0, w: 640, h: 360 };

function inside(b: ScreenBounds, vp: { x: number; y: number; w: number; h: number }): boolean {
  return b.x0 >= vp.x && b.y0 >= vp.y && b.x1 <= vp.x + vp.w && b.y1 <= vp.y + vp.h;
}

describe('placement de la carte', () => {
  const goals: ScreenBounds = { x0: 900, y0: 10, x1: 1270, y1: 110 };
  const personal: ScreenBounds = { x0: 10, y0: 120, x1: 300, y1: 200 };
  const prompt: ScreenBounds = { x0: 500, y0: 670, x1: 780, y1: 710 };
  const sign: ScreenBounds = { x0: 400, y0: 600, x1: 880, y1: 660 };

  it('largeur : ≤ 54 % de la vue (60 % en tactile), bornée ; police 22 px (26 px en tactile)', () => {
    expect(cardWidth(FULL, false)).toBeLessThanOrEqual(1280 * 0.54);
    expect(cardWidth(FULL, true)).toBeLessThanOrEqual(1280 * 0.6);
    expect(cardWidth(SMALL, false)).toBeGreaterThanOrEqual(220);
    expect(cardWidth(SMALL, false)).toBeLessThanOrEqual(640 * 0.54 + 1);
    expect(cardFontSize(false)).toBe(22);
    expect(cardFontSize(true)).toBe(26);
  });

  it('1280×720 : en bas au centre, au-dessus de l invite et de la bulle de panneau, sans les recouvrir', () => {
    const size = { w: 690, h: 130 };
    const b = placeCard(FULL, size, [prompt, sign], [prompt, sign]);
    expect(inside(b, FULL)).toBe(true);
    expect(boundsOverlap(b, prompt)).toBe(false);
    expect(boundsOverlap(b, sign)).toBe(false);
    expect(b.y1).toBeLessThanOrEqual(sign.y0 - CARD_MARGIN + 1);
    expect(Math.round((b.x0 + b.x1) / 2)).toBe(640);
  });

  it('1280×720 sans invite : collée en bas ; ne recouvre pas les cadres de mise en évidence', () => {
    const size = { w: 690, h: 130 };
    const b = placeCard(FULL, size, [goals, personal], []);
    expect(b.y1).toBe(720 - CARD_MARGIN);
    expect(boundsOverlap(b, goals)).toBe(false);
    expect(boundsOverlap(b, personal)).toBe(false);
  });

  it('repli en haut si le bas est occupé par une zone à encadrer', () => {
    const size = { w: 690, h: 130 };
    const bottomFrame: ScreenBounds = { x0: 300, y0: 560, x1: 980, y1: 700 };
    const b = placeCard(FULL, size, [bottomFrame], []);
    expect(inside(b, FULL)).toBe(true);
    expect(boundsOverlap(b, bottomFrame)).toBe(false);
    expect(b.y0).toBe(CARD_MARGIN);
  });

  it('640×360 (vue à 4 joueurs) : la carte reste dans la vue', () => {
    const size = { w: cardWidth(SMALL, false), h: 90 };
    const p: ScreenBounds = { x0: 240, y0: 320, x1: 400, y1: 350 };
    const b = placeCard(SMALL, size, [p], [p]);
    expect(inside(b, SMALL)).toBe(true);
    expect(boundsOverlap(b, p)).toBe(false);
  });

  it('une vue décalée (quadrant) : le placement suit la vue', () => {
    const vp = { x: 642, y: 362, w: 638, h: 358 };
    const b = placeCard(vp, { w: 300, h: 80 }, [], []);
    expect(inside(b, vp)).toBe(true);
  });
});

describe('cadres de mise en évidence', () => {
  const regions = { roomGoals: { x0: 900, y0: 10, x1: 1270, y1: 110 }, hearts: { x0: 10, y0: 40, x1: 200, y1: 70 } };

  it('uniquement les zones demandées ET exposées (zone masquée : pas de cadre)', () => {
    const f = highlightFrames(['roomGoals', 'personalGoal', 'hearts'], regions);
    expect(f.map((x) => x.id)).toEqual(['roomGoals', 'hearts']);
    expect(f[0].legendKey).toBe('tutorial.legend.roomGoals');
    expect(f[0].bounds).toEqual({ x0: 900 - HIGHLIGHT_PAD, y0: 10 - HIGHLIGHT_PAD, x1: 1270 + HIGHLIGHT_PAD, y1: 110 + HIGHLIGHT_PAD });
    expect(highlightFrames([], regions)).toEqual([]);
  });

  it('visibleRegionIds liste les zones exposées', () => {
    expect(visibleRegionIds(regions).sort()).toEqual(['hearts', 'roomGoals']);
    expect(visibleRegionIds({})).toEqual([]);
  });

  it('cadre de la pile haut-gauche : légende À DROITE du cadre (jamais sur le nom, les cœurs ou la jauge voisins) ; repli si la droite est occupée', () => {
    const hearts: ScreenBounds = { x0: 10, y0: 40, x1: 130, y1: 70 };
    const p = legendPosition(hearts, FULL, { w: 160, h: 24 });
    expect(p.x).toBeGreaterThanOrEqual(hearts.x1);
    expect(p.y).toBeGreaterThanOrEqual(hearts.y0 - 4);
    expect(p.y + 24).toBeLessThanOrEqual(hearts.y1 + 4);
    // un autre cadre à droite : la légende ne le recouvre pas (repli au-dessus / en dessous)
    const other: ScreenBounds = { x0: 140, y0: 38, x1: 400, y1: 80 };
    const q = legendPosition(hearts, FULL, { w: 160, h: 24 }, [other]);
    expect(boundsOverlap({ x0: q.x, y0: q.y, x1: q.x + 160, y1: q.y + 24 }, other)).toBe(false);
  });

  it("l'emplacement cœur : la légende se décale à DROITE de la rangée d'équipement voisine (qui commence juste à droite de la case) au lieu de la recouvrir", () => {
    const heartSlot: ScreenBounds = { x0: 10, y0: 90, x1: 60, y1: 120 };
    const gearRow: ScreenBounds = { x0: 66, y0: 88, x1: 330, y1: 122 };
    const p = legendPosition(heartSlot, FULL, { w: 160, h: 24 }, [heartSlot, gearRow]);
    expect(boundsOverlap({ x0: p.x, y0: p.y, x1: p.x + 160, y1: p.y + 24 }, gearRow)).toBe(false);
    expect(p.x).toBeGreaterThanOrEqual(gearRow.x1);
    expect(p.y).toBeGreaterThanOrEqual(heartSlot.y0 - 4);
    expect(p.y + 24).toBeLessThanOrEqual(heartSlot.y1 + 4); // reste alignée sur la case
  });

  it('la légende se place au-dessus du cadre, sinon en dessous, toujours dans la vue', () => {
    const top = legendPosition({ x0: 900, y0: 10, x1: 1270, y1: 110 }, FULL, { w: 200, h: 20 });
    expect(top.y).toBeGreaterThan(110); // pas de place au-dessus : en dessous
    const mid = legendPosition({ x0: 700, y0: 300, x1: 900, y1: 360 }, FULL, { w: 200, h: 20 });
    expect(mid.y).toBeLessThan(300);
    expect(top.x + 200).toBeLessThanOrEqual(1280);
  });
});

describe('puce « Passer », repli compact, animations', () => {
  it('la puce est en haut au centre, plus basse en tactile (sous le bouton pause)', () => {
    const k = skipChipRect(FULL, false);
    const t = skipChipRect(FULL, true);
    expect(Math.round((k.x0 + k.x1) / 2)).toBe(640);
    expect(t.y0).toBeGreaterThan(k.y0);
    expect(t.x1 - t.x0).toBeGreaterThan(k.x1 - k.x0);
    expect(inside(k, FULL) && inside(t, FULL)).toBe(true);
  });

  it('la puce ne recouvre ni le bandeau de salle (y ≤ 111), ni les toasts (y 158-188), ni la colonne centrale en tactile ; cible tactile ≥ 90 px logiques', () => {
    const k = skipChipRect(FULL, false);
    expect(k.y0).toBeGreaterThanOrEqual(112);
    expect(k.y1).toBeLessThanOrEqual(158);
    const t = skipChipRect(FULL, true);
    expect(t.y1 - t.y0).toBeGreaterThanOrEqual(90);
    expect(t.x0).toBeGreaterThan(FULL.w / 2 + 150); // à droite du centre (toasts, bandeau, repères)
    expect(t.y1 <= 158 || t.y0 >= 188 || t.x0 > 840).toBe(true);
    expect(inside(skipChipRect(SMALL, true), SMALL) && inside(skipChipRect(SMALL, false), SMALL)).toBe(true);
  });

  it('isCompact : jamais pour une étape `noCompact` (maintenir, durées)', () => {
    const v = { buttons: ['action' as const], activeMs: COMPACT_AFTER_MS * 2, waiting: false, interrupt: null, stuck: false };
    expect(isCompact(v)).toBe(true);
    expect(isCompact({ ...v, noCompact: true })).toBe(false);
  });

  it('repli compact seulement pour une étape à bouton, lue depuis assez longtemps, sans attente ni interruption', () => {
    const v = { buttons: ['attack' as const], activeMs: COMPACT_AFTER_MS, waiting: false, interrupt: null, stuck: false };
    expect(isCompact(v)).toBe(true);
    expect(isCompact({ ...v, activeMs: COMPACT_AFTER_MS - 1 })).toBe(false);
    expect(isCompact({ ...v, buttons: [] })).toBe(false);
    expect(isCompact({ ...v, waiting: true })).toBe(false);
    expect(isCompact({ ...v, interrupt: 'youDown' })).toBe(false);
    expect(isCompact({ ...v, stuck: true })).toBe(false);
    expect(compactButton(['skip', 'pause', 'special'])).toBe('special');
    expect(compactButton(['skip'])).toBeNull();
  });

  it('rebond et pulsation bornés', () => {
    for (let t = 0; t < 5000; t += 37) {
      expect(Math.abs(markerBounce(t))).toBeLessThanOrEqual(3);
      expect(pulseAlpha(t)).toBeGreaterThanOrEqual(0.55);
      expect(pulseAlpha(t)).toBeLessThanOrEqual(1);
    }
  });

  it('barre de bord : visible seulement si le partenaire est hors de la vue', () => {
    const cam = { x: 200, y: 100 };
    expect(partnerEdge(null, cam, 3, FULL).visible).toBe(false);
    expect(partnerEdge({ x: 210, y: 100 }, cam, 3, FULL).visible).toBe(false);
    const far = partnerEdge({ x: 800, y: 100 }, cam, 3, FULL);
    expect(far.visible).toBe(true);
    expect(far.x).toBeGreaterThan(1100); // bord droit
    expect(far.x).toBeLessThanOrEqual(1280);
    expect(Math.abs(far.angle)).toBeLessThan(0.1);
  });
});
