/**
 * Interface du tutoriel : PARTIE PHASER (dessin seulement). Tout le calcul (placement, cadres, rebond, bord de vue, repli compact) est
 * dans `tutorialHudLogic.ts` (pur, testé) ; le contenu vient du `TutorialView` du directeur (`src/tutorial/`). Aucune règle de jeu ici.
 *
 * Éléments (cohérents avec le HUD existant : même police, mêmes fonds sombres, liseré or) :
 *  - CARTE d'instruction (bas-centre, au-dessus de l'invite et du panneau ; repli en haut) : « Tutoriel n/total », le texte de l'étape
 *    (jetons de boutons résolus par appareil), la puce de saut ; se replie sur UNE ligne (« 4/31 · Attaque : X ») après lecture ;
 *  - CADRES pulsants (or + légende : jamais la couleur seule) autour des zones du HUD (`PlayerHud.regions()`) ;
 *  - REPÈRES du monde : flèche qui rebondit au-dessus de la cible (panneau, levier, plaque, clé, porte, brasero, partenaire, sortie, ennemi) ;
 *  - BARRE pulsante au bord de la vue qui regarde le partenaire hors champ (leçon de l'appel) ;
 *  - puce « Passer » / « Salle suivante » (cliquable à la souris et au doigt) ;
 *  - CARTE DE FIN (bravo, « rien n'a été sauvegardé », bouton « Retour au menu »).
 * Profondeur : au-dessus des bandeaux, sous le fondu et la pause.
 */
import type Phaser from 'phaser';
import { ATLAS_KEY } from './art';
import { GAME_HEIGHT, GAME_WIDTH } from '../core/constants';
import { hasKey, t } from '../i18n/i18n';
import type { ViewContext } from '../entities/common';
import { HUD_DEPTH, hudRect, hudText, type ScreenBounds } from './hud';
import {
  cardFontSize,
  cardWidth,
  compactButton,
  highlightFrames,
  isCompact,
  labelFontSize,
  LEGEND_RESERVE,
  legendPosition,
  markerBounce,
  partnerEdge,
  placeCard,
  pulseAlpha,
  skipChipRect,
  type HighlightFrame,
} from './tutorialHudLogic';
import type { ScreenRect } from './splitscreen';
import type { ButtonName, HudRegionId, TutorialView } from '../tutorial/types';

type Text = Phaser.GameObjects.Text;
type Rect = Phaser.GameObjects.Rectangle;

const GOLD = 0xf5c53d;
const DEPTH = HUD_DEPTH.banner + 5;
const MAX_MARKERS = 3;
const MAX_LEGENDS = 3;

/** Données d'une mise à jour de l'interface (une par frame de rendu). */
export interface TutorialHudUpdate {
  view: TutorialView;
  /** Libellés de boutons résolus pour l'appareil courant. */
  labels: Record<ButtonName, string>;
  partnerName: string;
  specialName: string;
  regions: Partial<Record<HudRegionId, ScreenBounds>>;
  camCenter: { x: number; y: number };
  timeMs: number;
  touch: boolean;
}

export class TutorialHud {
  private readonly vp: ScreenRect;
  private readonly zoom: number;
  private readonly card: Rect;
  private readonly title: Text;
  private readonly skipHint: Text;
  private readonly body: Text;
  private readonly chip: Rect;
  private readonly chipText: Text;
  private readonly frames: Phaser.GameObjects.Graphics;
  private readonly legends: Text[] = [];
  private readonly markers: Phaser.GameObjects.Image[] = [];
  private readonly edge: Phaser.GameObjects.Graphics;
  private end: Phaser.GameObjects.GameObject[] = [];
  private endShown = false;
  private sig = '';
  private chipSig = '';
  private onSkip: () => void = () => undefined;
  private onEnd: () => void = () => undefined;
  private endArgs: { labels: Record<ButtonName, string>; solo: boolean } | null = null;
  private visible = false;

  constructor(
    private readonly ctx: ViewContext,
    vp: ScreenRect,
  ) {
    this.vp = vp;
    this.zoom = ctx.zoom;
    this.frames = ctx.scene.add.graphics();
    this.frames.setDepth(DEPTH - 1);
    ctx.rig.registerHud(this.frames);
    this.edge = ctx.scene.add.graphics();
    this.edge.setDepth(DEPTH - 1);
    ctx.rig.registerHud(this.edge);

    this.card = hudRect(ctx, 0, 0, 10, 10, 0x0b0912, 0.9, DEPTH);
    this.card.setOrigin(0, 0).setStrokeStyle(3, GOLD, 0.95).setVisible(false);
    this.title = hudText(ctx, 0, 0, '', { size: labelFontSize(false), color: GOLD, depth: DEPTH + 1 });
    this.skipHint = hudText(ctx, 0, 0, '', { size: labelFontSize(false), color: 0xb8b4d0, originX: 1, depth: DEPTH + 1 });
    this.body = hudText(ctx, 0, 0, '', { size: 22, color: 0xffffff, depth: DEPTH + 1, strokeThickness: 2 });
    for (const o of [this.title, this.skipHint, this.body]) o.setVisible(false);

    this.chip = hudRect(ctx, 0, 0, 10, 10, 0x1c1530, 0.9, DEPTH + 2);
    this.chip.setOrigin(0, 0).setStrokeStyle(2, GOLD, 0.95).setVisible(false);
    this.chipText = hudText(ctx, 0, 0, '', { size: 20, color: 0xfff6d8, originX: 0.5, originY: 0.5, depth: DEPTH + 3 });
    this.chipText.setVisible(false);
    this.chip.setInteractive({ useHandCursor: true });
    this.chip.on('pointerdown', () => {
      if (this.visible && !this.endShown) this.onSkip();
    });

    for (let i = 0; i < MAX_LEGENDS; i++) {
      const l = hudText(ctx, 0, 0, '', { size: labelFontSize(false), color: GOLD, depth: DEPTH + 1 });
      l.setVisible(false);
      this.legends.push(l);
    }
    for (let i = 0; i < MAX_MARKERS; i++) {
      const m = ctx.rig.registerWorld(ctx.scene.add.image(0, 0, ATLAS_KEY, 'fx_marker'));
      m.setOrigin(0.5, 1).setTint(0xffe27a).setDepth(6000).setVisible(false);
      this.markers.push(m);
    }
  }

  /** Callback de la puce « Passer ». */
  setSkipHandler(fn: () => void): void {
    this.onSkip = fn;
  }

  get isEndShown(): boolean {
    return this.endShown;
  }

  /** Force le recalcul des textes (changement de langue) au prochain `update`. */
  retranslate(endLabels?: Record<ButtonName, string>): void {
    this.sig = '';
    this.chipSig = '';
    if (this.endShown && this.endArgs) {
      if (endLabels) this.endArgs.labels = endLabels;
      this.destroyEnd();
      this.buildEnd(this.endArgs.labels, this.endArgs.solo);
    }
  }

  // ───────────── Mise à jour ─────────────

  update(a: TutorialHudUpdate): void {
    if (this.endShown) {
      this.hideTutorial();
      return;
    }
    const v = a.view;
    this.visible = v.visible;
    if (!v.visible) {
      this.hideTutorial();
      return;
    }
    const fs = cardFontSize(a.touch);
    const params: Record<string, string> = { ...a.labels, name: a.partnerName, specialName: a.specialName };

    // texte de la carte
    let text: string;
    let size = fs;
    if (v.waiting) {
      // message d'attente propre à l'étape quand il existe (ce qu'on attend : le partenaire, la torche…), sinon le message générique
      const waitKey = `tutorial.wait.${v.stepId}`;
      text = hasKey(waitKey) ? t(waitKey, params) : t('tutorial.card.wait');
    } else if (isCompact(v)) {
      const b = compactButton(v.buttons);
      text = b ? t('tutorial.card.compact', { n: v.index, total: v.total, name: t(`tutorial.name.${b}`), label: a.labels[b] }) : t(v.textKey, params);
      size = Math.max(20, fs - 2);
    } else {
      text = t(v.textKey, params);
      if (v.stuck) text += `\n${t('tutorial.card.stuck', { skip: a.labels.skip })}`;
    }
    const frames = highlightFrames(v.highlights, a.regions);
    const sig = `${text}|${size}|${a.touch}|${frames.map((f) => `${f.id}:${f.bounds.x0}:${f.bounds.y0}:${f.bounds.x1}:${f.bounds.y1}`).join(',')}|${a.regions.prompt?.y0 ?? ''}|${a.regions.sign?.y0 ?? ''}|${v.interrupt ?? ''}`;
    if (sig !== this.sig) {
      this.sig = sig;
      this.layoutCard(text, size, v, a, frames);
    }
    this.skipHint.setText(t('tutorial.skip.hint', { skip: a.labels.skip }));

    this.drawFrames(frames, a.timeMs, a.touch);
    this.drawMarkers(v, a.timeMs);
    this.drawEdge(v, a);
    this.updateChip(v, a);
  }

  private hideTutorial(): void {
    this.card.setVisible(false);
    this.title.setVisible(false);
    this.skipHint.setVisible(false);
    this.body.setVisible(false);
    this.chip.setVisible(false);
    this.chipText.setVisible(false);
    this.frames.clear();
    this.edge.clear();
    for (const l of this.legends) l.setVisible(false);
    for (const m of this.markers) m.setVisible(false);
    this.sig = '';
  }

  private layoutCard(text: string, size: number, v: TutorialView, a: TutorialHudUpdate, frames: HighlightFrame[]): void {
    const pad = 14;
    const w = cardWidth(this.vp, a.touch);
    this.body.setStyle({ fontSize: `${size}px` });
    this.title.setStyle({ fontSize: `${labelFontSize(a.touch)}px` });
    this.skipHint.setStyle({ fontSize: `${labelFontSize(a.touch)}px` });
    this.body.setWordWrapWidth(w - 2 * pad, true);
    this.body.setText(text);
    this.title.setText(v.interrupt ? '!' : t('tutorial.card.progress', { n: v.index, total: v.total }));
    const compact = size < cardFontSize(a.touch);
    const headerH = compact ? 0 : this.title.height + 4;
    const h = Math.round(this.body.height + headerH + 2 * pad);
    const avoid: ScreenBounds[] = frames.map((f) => f.bounds);
    const prompts: ScreenBounds[] = [];
    // la légende d'un cadre d'invite / de panneau est posée AU-DESSUS du cadre : la carte doit s'arrêter au-dessus d'elle
    const reserve = (id: HudRegionId): number => (frames.some((f) => f.id === id) ? LEGEND_RESERVE : 0);
    if (a.regions.prompt) prompts.push({ ...a.regions.prompt, y0: a.regions.prompt.y0 - reserve('prompt') });
    if (a.regions.sign) prompts.push({ ...a.regions.sign, y0: a.regions.sign.y0 - reserve('sign') });
    for (const p of prompts) avoid.push(p);
    const b = placeCard(this.vp, { w, h }, avoid, prompts);
    this.card.setPosition(b.x0, b.y0).setSize(w, h).setVisible(true);
    this.title.setPosition(b.x0 + pad, b.y0 + pad - 2).setVisible(!compact);
    this.skipHint.setPosition(b.x1 - pad, b.y0 + pad - 2).setVisible(!compact && !a.touch);
    this.body.setPosition(b.x0 + pad, b.y0 + pad + headerH).setVisible(true);
    this.card.setStrokeStyle(3, v.interrupt ? 0xff8a6a : v.waiting ? 0x8890ac : GOLD, 0.95);
  }

  private drawFrames(frames: HighlightFrame[], timeMs: number, touch: boolean): void {
    const g = this.frames;
    g.clear();
    const alpha = pulseAlpha(timeMs);
    frames.forEach((f, i) => {
      const w = f.bounds.x1 - f.bounds.x0;
      const h = f.bounds.y1 - f.bounds.y0;
      g.lineStyle(4, GOLD, alpha);
      g.strokeRect(f.bounds.x0, f.bounds.y0, w, h);
      // coins marqués (forme : le cadre ne repose pas sur la seule couleur)
      g.lineStyle(7, 0xffffff, alpha);
      const c = Math.min(14, w / 3, h / 3);
      for (const [cx, cy, sx, sy] of [[f.bounds.x0, f.bounds.y0, 1, 1], [f.bounds.x1, f.bounds.y0, -1, 1], [f.bounds.x0, f.bounds.y1, 1, -1], [f.bounds.x1, f.bounds.y1, -1, -1]] as const) {
        g.beginPath();
        g.moveTo(cx + sx * c, cy);
        g.lineTo(cx, cy);
        g.lineTo(cx, cy + sy * c);
        g.strokePath();
      }
      const leg = this.legends[i];
      if (leg) {
        leg.setText(t(f.legendKey));
        leg.setStyle({ fontSize: `${labelFontSize(touch)}px` });
        const pos = legendPosition(f.bounds, this.vp, { w: leg.width, h: leg.height }, frames.map((o) => o.bounds));
        leg.setPosition(pos.x, pos.y).setVisible(true).setAlpha(Math.max(0.8, alpha));
      }
    });
    for (let i = frames.length; i < this.legends.length; i++) this.legends[i].setVisible(false);
  }

  private drawMarkers(v: TutorialView, timeMs: number): void {
    const bounce = markerBounce(timeMs);
    for (let i = 0; i < this.markers.length; i++) {
      const m = this.markers[i];
      const spec = v.markers[i];
      if (!spec) {
        m.setVisible(false);
        continue;
      }
      m.setPosition(spec.x, spec.y - 14 + bounce).setVisible(true);
    }
  }

  private drawEdge(v: TutorialView, a: TutorialHudUpdate): void {
    const g = this.edge;
    g.clear();
    if (!v.edgeToPartner) return;
    const e = partnerEdge(v.partnerPos, a.camCenter, this.zoom, this.vp);
    if (!e.visible) return;
    const alpha = pulseAlpha(a.timeMs);
    // pointe orientée vers le partenaire, avec un contour sombre (lisible sur tous les fonds)
    const len = 26;
    const half = 17;
    const ca = Math.cos(e.angle);
    const sa = Math.sin(e.angle);
    const tip = { x: e.x + ca * len, y: e.y + sa * len };
    const l = { x: e.x - ca * 6 - sa * half, y: e.y - sa * 6 + ca * half };
    const r = { x: e.x - ca * 6 + sa * half, y: e.y - sa * 6 - ca * half };
    g.fillStyle(0x0b0912, 0.9);
    g.fillTriangle(tip.x + ca * 4, tip.y + sa * 4, l.x - sa * 4, l.y + ca * 4, r.x + sa * 4, r.y - ca * 4);
    g.fillStyle(GOLD, alpha);
    g.fillTriangle(tip.x, tip.y, l.x, l.y, r.x, r.y);
  }

  private updateChip(v: TutorialView, a: TutorialHudUpdate): void {
    const label = t(v.skipKind === 'room' ? 'tutorial.skip.room' : 'tutorial.skip.step');
    const sig = `${label}|${a.touch}`;
    const r = skipChipRect(this.vp, a.touch);
    if (sig !== this.chipSig) {
      this.chipSig = sig;
      this.chipText.setText(label).setStyle({ fontSize: `${a.touch ? 26 : 20}px` });
      this.chip.setPosition(r.x0, r.y0).setSize(r.x1 - r.x0, r.y1 - r.y0);
      this.chip.input?.hitArea?.setSize?.(r.x1 - r.x0, r.y1 - r.y0);
      this.chipText.setPosition((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2);
    }
    this.chip.setVisible(true).setAlpha(v.skipKind === 'room' ? 1 : 0.85);
    this.chipText.setVisible(true);
  }

  // ───────────── Carte de fin ─────────────

  /** Affiche la carte de fin ; `onConfirm` est appelé au clic / toucher sur le bouton ou l'écran. */
  showEnd(labels: Record<ButtonName, string>, solo: boolean, onConfirm: () => void): void {
    if (this.endShown) return;
    this.endShown = true;
    this.onEnd = onConfirm;
    this.endArgs = { labels, solo };
    this.hideTutorial();
    this.buildEnd(labels, solo);
  }

  private buildEnd(labels: Record<ButtonName, string>, solo: boolean): void {
    const ctx = this.ctx;
    const objs: Phaser.GameObjects.GameObject[] = [];
    const cx = GAME_WIDTH / 2;
    const veil = hudRect(ctx, cx, GAME_HEIGHT / 2, GAME_WIDTH, GAME_HEIGHT, 0x000000, 0.62, DEPTH + 10);
    veil.setInteractive();
    veil.on('pointerdown', () => this.onEnd());
    objs.push(veil);
    const pw = 860;
    const ph = solo ? 490 : 430;
    const py = (GAME_HEIGHT - ph) / 2;
    const panel = hudRect(ctx, cx, GAME_HEIGHT / 2, pw, ph, 0x0b0912, 0.95, DEPTH + 11);
    panel.setStrokeStyle(4, GOLD, 1);
    objs.push(panel);
    let y = py + 26;
    const title = hudText(ctx, cx, y, t('tutorial.end.title'), { size: 38, color: GOLD, originX: 0.5, depth: DEPTH + 12, align: 'center' });
    objs.push(title);
    y += title.height + 16;
    const body = hudText(ctx, cx, y, t('tutorial.end.body'), { size: 22, originX: 0.5, depth: DEPTH + 12, align: 'center', wrap: pw - 80, strokeThickness: 2 });
    objs.push(body);
    y += body.height + 14;
    const nosave = hudText(ctx, cx, y, t('tutorial.end.nosave'), { size: 22, color: 0x8dffa8, originX: 0.5, depth: DEPTH + 12, align: 'center', wrap: pw - 80, strokeThickness: 2 });
    objs.push(nosave);
    y += nosave.height + 12;
    if (solo) {
      const soloNote = hudText(ctx, cx, y, t('tutorial.end.solo'), { size: 22, color: 0xf0e2b0, originX: 0.5, depth: DEPTH + 12, align: 'center', wrap: pw - 80, strokeThickness: 2 });
      objs.push(soloNote);
      y += soloNote.height + 12;
    }
    const press = hudText(ctx, cx, y, t('tutorial.end.press', { action: labels.action }), { size: 22, color: 0xb8b4d0, originX: 0.5, depth: DEPTH + 12, align: 'center', wrap: pw - 80, strokeThickness: 2 });
    objs.push(press);
    const by = py + ph - 52;
    const btn = hudRect(ctx, cx, by, 320, 54, 0x1c1530, 1, DEPTH + 12);
    btn.setStrokeStyle(3, GOLD, 1).setInteractive({ useHandCursor: true });
    btn.on('pointerdown', () => this.onEnd());
    objs.push(btn);
    objs.push(hudText(ctx, cx, by, t('tutorial.end.menu'), { size: 24, color: 0xfff6d8, originX: 0.5, originY: 0.5, depth: DEPTH + 13 }));
    this.end = objs;
  }

  private destroyEnd(): void {
    for (const o of this.end) o.destroy();
    this.end = [];
  }

  destroy(): void {
    this.destroyEnd();
    const all: Phaser.GameObjects.GameObject[] = [this.card, this.title, this.skipHint, this.body, this.chip, this.chipText, this.frames, this.edge, ...this.legends, ...this.markers];
    for (const o of all) o.destroy();
    this.legends.length = 0;
    this.markers.length = 0;
  }
}
