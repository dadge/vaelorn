/**
 * Vues des ennemis : un sprite par ennemi (pool indexé par id : création à la volée, retrait quand l'ennemi
 * disparaît de l'état), ombre, barre de PV (ennemis normaux), télégraphe d'attaque (clignotement blanc/rouge +
 * zone ou ligne de visée). LECTURE seule de EnemyState.
 */
import type Phaser from 'phaser';
import { ENEMIES } from '../core/enemies';
import type { EnemyState } from '../core/types';
import { ATLAS_KEY } from '../render/art';
import { enemyFrame } from '../render/art/animations';
import { enemySpriteInfo } from '../render/art/enemyTiers';
import { bossBarEntries, type BossBarEntry } from '../render/bossBars';
import { tacticShapes, type TacticShape } from '../render/tacticIndicator';
import { type EnemyVisual, PosInterp, computeEnemyVisual, createEnemyVisual } from './animation';
import { DEPTH, ySortDepth, type ViewContext } from './common';
import { telegraphShapes, voidZones } from './telegraph';

const SPAWN_FADE_MS = 260;
const BAR_SHOW_MS = 2600;
const BAR_FADE_MS = 600;

export class EnemyView {
  readonly interp: PosInterp;
  /** Demi-boss ou boss : pas de petite barre au-dessus de la tête (barre globale en haut de l'écran, voir overlay.ts). */
  readonly boss: boolean;
  /** Dernier numéro de frame de synchronisation où l'ennemi était présent dans l'état (balayage du pool). */
  seen = 0;
  private readonly sprite: Phaser.GameObjects.Image;
  private readonly shadow: Phaser.GameObjects.Image;
  private readonly barBg: Phaser.GameObjects.Rectangle | null;
  private readonly barFill: Phaser.GameObjects.Rectangle | null;
  private readonly drawOffsetY: number;
  private readonly footOffsetY: number;
  private readonly barW: number;
  private readonly shadowAlpha: number;
  private lastFrame = '';
  private lastHp: number;
  private lastHpChangeMs = -1e9;
  private ageMs: number;

  constructor(ctx: ViewContext, e: EnemyState, instant: boolean) {
    const { scene, rig } = ctx;
    const info = enemySpriteInfo(e.kind);
    this.boss = info.tier !== 'small';
    this.drawOffsetY = info.drawOffsetY;
    this.footOffsetY = info.footOffsetY ?? ENEMIES[e.kind]?.radius ?? 6;
    this.shadowAlpha = info.shadowAlpha;
    this.barW = this.boss ? 0 : 12;
    this.interp = new PosInterp(e.pos.x, e.pos.y);
    this.lastHp = e.hp;
    this.ageMs = instant ? SPAWN_FADE_MS : 0;
    this.shadow = rig.registerWorld(scene.add.image(0, 0, ATLAS_KEY, 'fx_shadow'));
    this.shadow.setAlpha(this.shadowAlpha).setDepth(DEPTH.shadow);
    if (this.boss) this.shadow.setScale(info.shadowScale[0], info.shadowScale[1]);
    this.sprite = rig.registerWorld(scene.add.image(0, 0, ATLAS_KEY, enemyFrame(e.kind, 0)));
    if (this.boss) {
      this.barBg = null;
      this.barFill = null;
    } else {
      this.barBg = rig.registerWorld(scene.add.rectangle(0, 0, this.barW + 2, 4, 0x14121f, 0.9));
      this.barFill = rig.registerWorld(scene.add.rectangle(0, 0, this.barW, 2, 0xff4058, 1));
      this.barFill.setOrigin(0, 0.5);
      this.barBg.setVisible(false);
      this.barFill.setVisible(false);
    }
  }

  /** Synchronise la vue avec l'état. `visual` est un objet de travail réutilisé. */
  update(e: EnemyState, timeMs: number, stepped: boolean, alpha: number, dtMs: number, visual: EnemyVisual): void {
    if (stepped) this.interp.push(e.pos.x, e.pos.y);
    const { x, y } = this.interp.at(alpha);
    this.ageMs += dtMs;
    if (e.hp !== this.lastHp) {
      this.lastHp = e.hp;
      this.lastHpChangeMs = timeMs;
    }
    computeEnemyVisual(e, timeMs, visual);
    if (visual.frame !== this.lastFrame) {
      this.sprite.setFrame(visual.frame);
      this.lastFrame = visual.frame;
    }
    const spawnA = this.ageMs >= SPAWN_FADE_MS ? 1 : this.ageMs / SPAWN_FADE_MS;
    this.sprite.setPosition(x + visual.offsetX, y + this.drawOffsetY + visual.offsetY);
    this.sprite.setFlipX(visual.flipX);
    this.sprite.setAlpha(visual.alpha * spawnA);
    if (visual.tintFill >= 0) this.sprite.setTintFill(visual.tintFill);
    else if (visual.tint !== 0xffffff) this.sprite.setTint(visual.tint);
    else this.sprite.clearTint();
    this.sprite.setDepth(ySortDepth(y + this.footOffsetY));
    this.shadow.setPosition(x, y + this.footOffsetY - 2);
    this.shadow.setAlpha(this.shadowAlpha * visual.alpha * spawnA);

    if (this.barBg && this.barFill) {
      const since = timeMs - this.lastHpChangeMs;
      const show = e.hp < e.maxHp && e.hp > 0 && since < BAR_SHOW_MS + BAR_FADE_MS;
      this.barBg.setVisible(show);
      this.barFill.setVisible(show);
      if (show) {
        const a = since < BAR_SHOW_MS ? 1 : 1 - (since - BAR_SHOW_MS) / BAR_FADE_MS;
        const ratio = Math.max(0, Math.min(1, e.hp / Math.max(1, e.maxHp)));
        const by = y - (this.footOffsetY + 11);
        this.barBg.setPosition(x, by).setAlpha(a).setDepth(ySortDepth(y) + 300);
        this.barFill.setPosition(x - this.barW / 2, by).setAlpha(a).setDepth(ySortDepth(y) + 301);
        this.barFill.setSize(Math.max(1, this.barW * ratio), 2);
      }
    }
  }

  destroy(): void {
    this.sprite.destroy();
    this.shadow.destroy();
    this.barBg?.destroy();
    this.barFill?.destroy();
  }
}

/**
 * Pool des vues d'ennemis d'une salle, indexé par id. `sync` crée/retire les vues pour refléter exactement
 * `state.room.enemies` (aucune fuite entre salles : `clear()` à chaque changement de salle).
 */
export class EnemyViews {
  private readonly views = new Map<number, EnemyView>();
  private readonly list: EnemyView[] = [];
  private readonly ids: number[] = [];
  private readonly visual = createEnemyVisual();
  private readonly telegraph: Phaser.GameObjects.Graphics;
  private telegraphDirty = false;
  /** Indicateur des tactiques de boss (icône, ligne pointillée, anneau d'ancre) : dessiné seulement pour un boss tactique. */
  private readonly tactics: Phaser.GameObjects.Graphics;
  private tacticsDirty = false;
  private frameNo = 0;
  private instantNext = true;
  private bossState: EnemyState | null = null;
  private barEntries: BossBarEntry[] = [];

  constructor(private readonly ctx: ViewContext) {
    this.telegraph = ctx.rig.registerWorld(ctx.scene.add.graphics());
    this.telegraph.setDepth(DEPTH.telegraph);
    this.tactics = ctx.rig.registerWorld(ctx.scene.add.graphics());
    this.tactics.setDepth(DEPTH.telegraph + 1);
  }

  /** Ennemi boss vivant de la salle (le plus prioritaire), ou null. */
  get boss(): EnemyState | null {
    return this.bossState;
  }

  /** Barres de PV globales : boss puis demi-boss vivants de la salle (au plus MAX_BOSS_BARS), recalculées à chaque `sync`. */
  get bossBars(): readonly BossBarEntry[] {
    return this.barEntries;
  }

  /** Nombre de vues actives (tests/debug). */
  get size(): number {
    return this.list.length;
  }

  /** Les prochains ennemis créés apparaissent sans fondu (entrée de salle). */
  markInstant(): void {
    this.instantNext = true;
  }

  sync(enemies: readonly EnemyState[], timeMs: number, stepped: boolean, alpha: number, dtMs: number): void {
    this.frameNo++;
    this.bossState = null;
    this.barEntries = bossBarEntries(enemies, (k) => ENEMIES[k as keyof typeof ENEMIES]);
    let drew = false;
    let drewTactics = false;
    const g = this.telegraph;
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (e.dead) continue;
      let v = this.views.get(e.id);
      if (!v) {
        v = new EnemyView(this.ctx, e, this.instantNext);
        this.views.set(e.id, v);
        this.list.push(v);
        this.ids.push(e.id);
      }
      v.seen = this.frameNo;
      v.update(e, timeMs, stepped, alpha, dtMs, this.visual);
      if (v.boss && e.hp > 0 && (!this.bossState || enemySpriteInfo(e.kind).tier === 'boss')) this.bossState = e;
      if ((e.data.tactKind ?? 0) > 0) {
        if (!drewTactics) {
          this.tactics.clear();
          drewTactics = true;
        }
        this.drawTactics(this.tactics, tacticShapes(e.data, v.interp.x, v.interp.y, ENEMIES[e.kind].radius * 2 + 12, timeMs));
      }
      if (this.visual.windup || voidZones(e).length > 0) {
        if (!drew) {
          g.clear();
          drew = true;
        }
        this.drawTelegraph(g, e, v.interp.x, v.interp.y, timeMs);
      }
    }
    this.instantNext = false;
    if (!drew && this.telegraphDirty) g.clear();
    this.telegraphDirty = drew;
    if (!drewTactics && this.tacticsDirty) this.tactics.clear();
    this.tacticsDirty = drewTactics;
    // balayage : retrait des vues absentes de l'état
    for (let i = this.list.length - 1; i >= 0; i--) {
      const v = this.list[i];
      if (v.seen === this.frameNo) continue;
      v.destroy();
      this.views.delete(this.ids[i]);
      const last = this.list.length - 1;
      this.list[i] = this.list[last];
      this.ids[i] = this.ids[last];
      this.list.pop();
      this.ids.pop();
    }
  }

  /** Dessine l'indicateur d'un boss tactique (formes pures de `tacticIndicator.ts`) : une forme distincte par tactique, pas seulement une couleur. */
  private drawTactics(g: Phaser.GameObjects.Graphics, shapes: readonly TacticShape[]): void {
    for (const s of shapes) {
      switch (s.kind) {
        case 'icon': {
          g.fillStyle(0x14121f, 0.75 * s.alpha);
          g.fillCircle(s.x, s.y, s.size + 2);
          g.lineStyle(1.5, s.color, s.alpha);
          g.fillStyle(s.color, s.alpha);
          const r = s.size;
          switch (s.icon) {
            case 'ring':
              g.strokeCircle(s.x, s.y, r);
              break;
            case 'diamond':
              g.fillPoints([{ x: s.x, y: s.y - r }, { x: s.x + r, y: s.y }, { x: s.x, y: s.y + r }, { x: s.x - r, y: s.y }], true);
              break;
            case 'cross':
              g.fillRect(s.x - r, s.y - 1.5, r * 2, 3);
              g.fillRect(s.x - 1.5, s.y - r, 3, r * 2);
              break;
            case 'triangle':
              g.fillPoints([{ x: s.x, y: s.y - r }, { x: s.x + r, y: s.y + r * 0.8 }, { x: s.x - r, y: s.y + r * 0.8 }], true);
              break;
            case 'square':
              g.fillRect(s.x - r * 0.8, s.y - r * 0.8, r * 1.6, r * 1.6);
              break;
            case 'chevron':
              g.lineStyle(2, s.color, s.alpha);
              g.strokePoints([{ x: s.x - r, y: s.y - r * 0.3 }, { x: s.x, y: s.y + r * 0.7 }, { x: s.x + r, y: s.y - r * 0.3 }], false);
              break;
            case 'dazed':
              g.strokeCircle(s.x, s.y, r);
              g.lineBetween(s.x - r * 0.6, s.y - r * 0.6, s.x + r * 0.6, s.y + r * 0.6);
              break;
          }
          break;
        }
        case 'stars':
          for (let i = 0; i < 3; i++) {
            const a = s.phase + (i * Math.PI * 2) / 3;
            g.fillStyle(s.color, 0.9);
            g.fillCircle(s.x + Math.cos(a) * s.r, s.y + Math.sin(a) * s.r * 0.4, 1.5);
          }
          break;
        case 'dashed': {
          const dx = s.x1 - s.x0;
          const dy = s.y1 - s.y0;
          const len = Math.hypot(dx, dy);
          if (len < 6) break;
          g.lineStyle(1, s.color, s.alpha);
          for (let t = 0; t < len; t += 8) {
            const t1 = Math.min(len, t + 4);
            g.lineBetween(s.x0 + (dx * t) / len, s.y0 + (dy * t) / len, s.x0 + (dx * t1) / len, s.y0 + (dy * t1) / len);
          }
          break;
        }
        case 'anchor':
          g.lineStyle(1.5, s.color, s.alpha);
          g.strokeCircle(s.x, s.y, s.r);
          break;
      }
    }
  }

  private drawTelegraph(g: Phaser.GameObjects.Graphics, e: EnemyState, x: number, y: number, timeMs: number): void {
    const pulse = 0.55 + 0.35 * Math.sin(timeMs / 70);
    const fillA = 0.14 * pulse + 0.06;
    const shapes = telegraphShapes(e, x, y);
    for (let i = 0; i < shapes.length; i++) {
      const s = shapes[i];
      g.fillStyle(0xff3a3a, fillA);
      g.lineStyle(1, 0xff3a3a, pulse);
      switch (s.kind) {
        case 'circle':
          g.fillCircle(s.x, s.y, s.r);
          g.strokeCircle(s.x, s.y, s.r);
          break;
        case 'ring':
          g.lineStyle(1, 0xff3a3a, pulse * 0.6);
          g.strokeCircle(s.x, s.y, s.r);
          break;
        case 'corridor': {
          const dx = s.x1 - s.x0;
          const dy = s.y1 - s.y0;
          const len = Math.hypot(dx, dy) || 1;
          const nx = (-dy / len) * s.halfWidth;
          const ny = (dx / len) * s.halfWidth;
          const pts = [
            { x: s.x0 + nx, y: s.y0 + ny },
            { x: s.x1 + nx, y: s.y1 + ny },
            { x: s.x1 - nx, y: s.y1 - ny },
            { x: s.x0 - nx, y: s.y0 - ny },
          ];
          g.fillPoints(pts, true);
          g.strokePoints(pts, true);
          break;
        }
        case 'fan':
          g.beginPath();
          g.moveTo(s.x, s.y);
          g.arc(s.x, s.y, s.r, s.a0, s.a1, false);
          g.closePath();
          g.fillPath();
          g.strokePath();
          break;
        case 'line':
          g.lineBetween(s.x0, s.y0, s.x1, s.y1);
          g.fillStyle(0xff3a3a, pulse);
          g.fillCircle(s.x1, s.y1, 1.5);
          break;
      }
    }
  }

  /** Détruit toutes les vues (changement de salle, fin de scène). */
  clear(): void {
    for (const v of this.list) v.destroy();
    this.list.length = 0;
    this.ids.length = 0;
    this.views.clear();
    this.telegraph.clear();
    this.telegraphDirty = false;
    this.tactics.clear();
    this.tacticsDirty = false;
    this.bossState = null;
    this.barEntries = [];
    this.instantNext = true;
  }

  destroy(): void {
    this.clear();
    this.telegraph.destroy();
    this.tactics.destroy();
  }
}
