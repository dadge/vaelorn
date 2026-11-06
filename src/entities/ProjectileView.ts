/**
 * Vues des projectiles : pool indexé par id (création à la volée, retrait quand le projectile disparaît de l'état),
 * sprite orienté selon la vitesse, léger halo, projectiles ennemis teintés de rouge pour se distinguer.
 */
import type Phaser from 'phaser';
import type { ProjectileState } from '../core/types';
import { ATLAS_KEY } from '../render/art';
import { projectileFrame } from '../render/art/animations';
import { FX_GLOW_KEY } from '../render/fx';
import { PosInterp } from './animation';
import { DEPTH, ySortDepth, type ViewContext } from './common';

const HALO_COLORS: Record<string, number> = {
  arrow: 0xfff0b0,
  bolt: 0x66f2ff,
  orb: 0xe05aff,
  shard: 0x9a8aff,
  heal: 0x5be37d,
};

class ProjectileView {
  readonly interp: PosInterp;
  seen = 0;
  private readonly sprite: Phaser.GameObjects.Image;
  private readonly halo: Phaser.GameObjects.Image;
  private readonly hostile: boolean;
  private lastRot = 0;

  constructor(ctx: ViewContext, p: ProjectileState) {
    const { scene, rig } = ctx;
    this.hostile = p.owner.type === 'enemy';
    this.interp = new PosInterp(p.pos.x, p.pos.y);
    this.halo = rig.registerWorld(scene.add.image(0, 0, FX_GLOW_KEY));
    this.halo.setBlendMode(1);
    this.halo.setTint(this.hostile ? 0xff5a3a : (HALO_COLORS[p.kind] ?? 0xffffff));
    this.halo.setScale(0.32).setAlpha(0.55).setDepth(DEPTH.telegraph - 2);
    this.sprite = rig.registerWorld(scene.add.image(0, 0, ATLAS_KEY, projectileFrame(p.kind)));
    if (this.hostile) this.sprite.setTint(0xffb0a0);
  }

  update(p: ProjectileState, stepped: boolean, alpha: number): void {
    if (stepped) this.interp.push(p.pos.x, p.pos.y);
    const { x, y } = this.interp.at(alpha);
    if (p.vel.x !== 0 || p.vel.y !== 0) this.lastRot = Math.atan2(p.vel.y, p.vel.x);
    this.sprite.setPosition(x, y);
    this.sprite.setRotation(this.lastRot);
    this.sprite.setDepth(ySortDepth(y) + 400);
    this.halo.setPosition(x, y);
  }

  destroy(): void {
    this.sprite.destroy();
    this.halo.destroy();
  }
}

/** Pool des vues de projectiles de la salle courante. */
export class ProjectileViews {
  private readonly views = new Map<number, ProjectileView>();
  private readonly list: ProjectileView[] = [];
  private readonly ids: number[] = [];
  private frameNo = 0;

  constructor(private readonly ctx: ViewContext) {}

  get size(): number {
    return this.list.length;
  }

  sync(projectiles: readonly ProjectileState[], stepped: boolean, alpha: number): void {
    this.frameNo++;
    for (let i = 0; i < projectiles.length; i++) {
      const p = projectiles[i];
      let v = this.views.get(p.id);
      if (!v) {
        v = new ProjectileView(this.ctx, p);
        this.views.set(p.id, v);
        this.list.push(v);
        this.ids.push(p.id);
      }
      v.seen = this.frameNo;
      v.update(p, stepped, alpha);
    }
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

  clear(): void {
    for (const v of this.list) v.destroy();
    this.list.length = 0;
    this.ids.length = 0;
    this.views.clear();
  }

  destroy(): void {
    this.clear();
  }
}
