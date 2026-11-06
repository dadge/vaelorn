/**
 * Vue d'un héros : sprite animé (direction, marche, attaque, à terre), ombre, anneau/marqueur de la couleur du joueur,
 * arc d'épée, clignotement d'invulnérabilité, flash de dégâts, barre et effet de relevage.
 * LECTURE seule de PlayerState.
 */
import type Phaser from 'phaser';
import { PLAYER_COLORS } from '../core/constants';
import { CHARACTERS } from '../core/characters';
import type { Dir, PlayerState, SpecialKind } from '../core/types';
import { ATLAS_KEY } from '../render/art';
import { heroFrame, slashFrame } from '../render/art/animations';
import { DEPTH_FX, type FxManager } from '../render/fx';
import { HERO_HIT_FLASH_MS, PosInterp, dirVector, heroFrameFor, invulnVisible, reviveFxFrame, slashAlpha } from './animation';
import { DEPTH, ySortDepth, type ViewContext } from './common';

const HERO_DRAW_OFFSET_Y = -3;
const BAR_W = 16;
/** Durée (ms) du flash blanc du héros quand il déclenche son spécial. */
const SPECIAL_FLASH_MS = 110;
/** Durée (ms) d'un quart de tour du tourbillon / de la danse des lames. */
const SPIN_STEP_MS = 55;
const SPIN_DIRS: readonly Dir[] = ['down', 'right', 'up', 'left'];

/** Direction affichée pendant une rotation (tourbillon, danse des lames) : un quart de tour toutes les `SPIN_STEP_MS`. */
export function spinDir(animMsLeft: number, offset = 0): Dir {
  const i = Math.floor(Math.max(0, animMsLeft) / SPIN_STEP_MS) + offset;
  return SPIN_DIRS[((i % 4) + 4) % 4];
}

/** Le spécial `kind` fait-il tourner le héros sur lui-même ? */
export function specialSpins(kind: SpecialKind | undefined): boolean {
  return kind === 'whirlwind' || kind === 'bladeDance';
}

export class PlayerView {
  readonly interp: PosInterp;
  private readonly hero: Phaser.GameObjects.Image;
  private readonly shadow: Phaser.GameObjects.Image;
  private readonly ring: Phaser.GameObjects.Ellipse;
  private readonly marker: Phaser.GameObjects.Image;
  private readonly slash: Phaser.GameObjects.Image;
  private readonly downIcon: Phaser.GameObjects.Image;
  private readonly reviveFx: Phaser.GameObjects.Image;
  private readonly barBg: Phaser.GameObjects.Rectangle;
  private readonly barFill: Phaser.GameObjects.Rectangle;
  private readonly color: number;
  private readonly melee: boolean;
  private readonly slashMs: number;
  private readonly fx: FxManager;
  private readonly special: SpecialKind | undefined;
  private specialFlashLeftMs = 0;
  private prevSpecialAnim = 0;
  private lastFrame = '';
  private lastSlash = '';
  private hitFlashLeftMs = 0;

  constructor(
    ctx: ViewContext,
    readonly playerId: number,
    p: PlayerState,
  ) {
    const { scene, rig } = ctx;
    this.fx = ctx.fx;
    this.special = CHARACTERS[p.characterId].special?.kind;
    this.color = PLAYER_COLORS[playerId] ?? 0xffffff;
    const def = CHARACTERS[p.characterId];
    this.melee = def.attack.kind === 'melee';
    this.slashMs = def.attack.animMs;
    this.interp = new PosInterp(p.pos.x, p.pos.y);

    this.ring = rig.registerWorld(scene.add.ellipse(0, 0, 15, 8, this.color, 0.28));
    this.ring.setStrokeStyle(1, this.color, 0.95);
    this.ring.setDepth(DEPTH.ring);
    this.shadow = rig.registerWorld(scene.add.image(0, 0, ATLAS_KEY, 'fx_shadow'));
    this.shadow.setAlpha(0.4).setDepth(DEPTH.shadow);
    this.hero = rig.registerWorld(scene.add.image(0, 0, ATLAS_KEY, heroFrameFor(p, 0)));
    this.marker = rig.registerWorld(scene.add.image(0, 0, ATLAS_KEY, 'fx_marker'));
    this.marker.setTint(this.color);
    this.slash = rig.registerWorld(scene.add.image(0, 0, ATLAS_KEY, slashFrame('down')));
    this.slash.setVisible(false);
    this.downIcon = rig.registerWorld(scene.add.image(0, 0, ATLAS_KEY, 'ui_down'));
    this.downIcon.setVisible(false);
    this.reviveFx = rig.registerWorld(scene.add.image(0, 0, ATLAS_KEY, 'fx_revive_0'));
    this.reviveFx.setVisible(false);
    this.barBg = rig.registerWorld(scene.add.rectangle(0, 0, BAR_W + 2, 4, 0x14121f, 0.9));
    this.barBg.setVisible(false);
    this.barFill = rig.registerWorld(scene.add.rectangle(0, 0, BAR_W, 2, 0x7dffb0, 1));
    this.barFill.setOrigin(0, 0.5).setVisible(false);
    this.update(p, 0, false, 1, 0, 0);
  }

  /** Position interpolée courante (px monde) — la caméra du joueur suit ce point. */
  get x(): number {
    return this.interp.x;
  }
  get y(): number {
    return this.interp.y;
  }

  /** Déclenche le flash blanc du lancement d'un spécial. */
  flashSpecial(): void {
    this.specialFlashLeftMs = SPECIAL_FLASH_MS;
  }

  /** Déclenche le flash rouge de dégâts. */
  flashHit(): void {
    this.hitFlashLeftMs = HERO_HIT_FLASH_MS;
  }

  /**
   * Synchronise la vue avec l'état.
   * @param stepped true si au moins un pas de simulation a eu lieu depuis le dernier appel
   * @param alpha part du pas de simulation écoulée (interpolation)
   * @param reviveRatio progression 0..1 du relevage SUR ce joueur (0 si aucun)
   * @param dtMs temps réel écoulé (flash de dégâts)
   */
  update(p: PlayerState, timeMs: number, stepped: boolean, alpha: number, reviveRatio: number, dtMs: number): void {
    if (stepped) this.interp.push(p.pos.x, p.pos.y);
    const { x, y } = this.interp.at(alpha);
    const down = p.status === 'down';
    const bob = Math.sin(timeMs / 220 + this.playerId) * 1;

    const specialOn = p.specialAnimMs > 0 && !down;
    const frame = specialOn && specialSpins(this.special) ? heroFrame(p.characterId, spinDir(p.specialAnimMs), 0, 'attack') : heroFrameFor(p, timeMs);
    if (frame !== this.lastFrame) {
      this.hero.setFrame(frame);
      this.lastFrame = frame;
    }
    this.hero.setPosition(x, y + HERO_DRAW_OFFSET_Y);
    this.hero.setDepth(ySortDepth(y + 5));
    this.hero.setAlpha(down || invulnVisible(p.invulnMs) ? 1 : 0.35);
    if (this.hitFlashLeftMs > 0) {
      this.hitFlashLeftMs -= dtMs;
      this.hero.setTintFill(0xff4040);
    } else if (this.specialFlashLeftMs > 0) {
      this.specialFlashLeftMs -= dtMs;
      this.hero.setTintFill(0xffffff);
    } else {
      this.hero.clearTint();
    }

    this.updateSpecial(p, x, y, dtMs);

    this.shadow.setPosition(x, y + 4);
    this.ring.setPosition(x, y + 4);
    this.ring.setAlpha(down ? 0.55 + 0.25 * Math.sin(timeMs / 260) : 1);

    // marqueur de couleur au-dessus de la tête (pointe vers le bas)
    this.marker.setPosition(x, y - 15 + bob);
    this.marker.setDepth(ySortDepth(y + 5) + 0.5);
    this.marker.setVisible(!down);

    // arc d'épée (mêlée)
    if (this.melee && p.attackAnimMs > 0 && !down) {
      const a = slashAlpha(p.attackAnimMs, this.slashMs);
      const sf = slashFrame(p.attackDir);
      if (sf !== this.lastSlash) {
        this.slash.setFrame(sf);
        this.lastSlash = sf;
      }
      const v = dirVector(p.attackDir);
      this.slash.setPosition(x + v.x * 12, y + v.y * 12 + HERO_DRAW_OFFSET_Y);
      this.slash.setDepth(ySortDepth(y + 5) + (p.attackDir === 'up' ? -0.5 : 0.5));
      this.slash.setAlpha(a);
      this.slash.setVisible(a > 0);
    } else {
      this.slash.setVisible(false);
    }

    // à terre : icône + relevage
    this.downIcon.setVisible(down);
    if (down) {
      this.downIcon.setPosition(x, y - 14 + bob);
      this.downIcon.setDepth(DEPTH_FX - 5);
    }
    const reviving = down && reviveRatio > 0;
    this.reviveFx.setVisible(reviving);
    this.barBg.setVisible(down);
    this.barFill.setVisible(reviving);
    if (down) {
      this.barBg.setPosition(x, y - 21);
      this.barBg.setDepth(DEPTH_FX - 4);
      this.barBg.setAlpha(reviving ? 0.95 : 0);
    }
    if (reviving) {
      const r = reviveRatio > 1 ? 1 : reviveRatio;
      this.barFill.setPosition(x - BAR_W / 2, y - 21);
      this.barFill.setDepth(DEPTH_FX - 3);
      this.barFill.setSize(Math.max(1, BAR_W * r), 2);
      this.reviveFx.setFrame(reviveFxFrame(timeMs));
      this.reviveFx.setPosition(x, y - 6);
      this.reviveFx.setDepth(DEPTH_FX - 6);
    }
  }

  /** Fin de la ruée : nuage de poussière à l'arrivée (la traînée d'images rémanentes est tracée par `SpecialFx`). */
  private updateSpecial(p: PlayerState, x: number, y: number, dtMs: number): void {
    if (this.special === 'dash' && dtMs > 0 && this.prevSpecialAnim > 0 && !(p.specialAnimMs > 0)) {
      this.fx.dust(x, y + 4, 7, 7);
      this.fx.ring(x, y + 4, 0xc9c2b4, 14, 260, false);
    }
    this.prevSpecialAnim = p.specialAnimMs;
  }

  destroy(): void {
    this.hero.destroy();
    this.shadow.destroy();
    this.ring.destroy();
    this.marker.destroy();
    this.slash.destroy();
    this.downIcon.destroy();
    this.reviveFx.destroy();
    this.barBg.destroy();
    this.barFill.destroy();
  }
}
