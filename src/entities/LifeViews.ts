/**
 * Vues des sources de vie ET de l'équipement au sol (objets d'équipement : dessin + halo doux de la couleur du niveau, SANS cadre, clignotement des
 * 4 dernières secondes) : nourriture au sol (cœur + halo, clignotement des 3 dernières secondes) et cristaux de soin
 * (cristal animé + halo vert, étiquette de proximité, version « vidée » après usage). Pur rendu : elles LISENT `GameState.room.pickups` /
 * `healCrystals` et ne décident de rien. Une instance vit le temps de la scène ; `build(room)` / `clear()` à chaque changement de salle.
 */
import type Phaser from 'phaser';
import { TILE } from '../core/constants';
import { swapCandidate } from '../core/gear';
import type { BuffDropState, GameState, GearDropState, HealCrystalDef, HealCrystalState, PickupState, RoomDef } from '../core/types';
import { t } from '../i18n/i18n';
import { ATLAS_KEY } from '../render/art';
import { DEPTH_LABELS, FX_GLOW_KEY, makeWorldText } from '../render/fx';
import { GEAR_SWAP_PROMPT_KEY, buffColor, buffFrame, gearAlpha, gearBob, gearFrame, gearLabel, gearLevelColor } from '../render/gearFx';
import { CRYSTAL_HALO_COLOR, crystalFrame, pickupAlpha, pickupBob, pickupFrame, pickupHaloColor } from '../render/lifeFx';
import { DEPTH, type ViewContext } from './common';

/** Rayon (px) autour d'un cristal dans lequel son étiquette apparaît. */
const CRYSTAL_LABEL_RADIUS = 56;

/** L'utilisateur demande-t-il moins d'animation (`prefers-reduced-motion`) ? Lu côté rendu ; faux si indisponible. */
function prefersReducedMotion(): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

interface PickupView {
  sprite: Phaser.GameObjects.Image;
  halo: Phaser.GameObjects.Image;
  seen: number;
}

interface CrystalView {
  def: HealCrystalDef;
  x: number;
  y: number;
  sprite: Phaser.GameObjects.Image;
  halo: Phaser.GameObjects.Image;
  label: Phaser.GameObjects.Text;
  labelAlpha: number;
}

export class LifeViews {
  private readonly pickups = new Map<number, PickupView>();
  /** Objets d'équipement au sol (par id de `GearDropState`). */
  private readonly gears = new Map<number, PickupView>();
  /** Bonus temporaires au sol (par id de `BuffDropState`). */
  private readonly buffs = new Map<number, PickupView>();
  /** Invites « A : échanger » au-dessus des accessoires échangeables (par id d'objet au sol). */
  private readonly swapLabels = new Map<number, Phaser.GameObjects.Text>();
  private crystals: CrystalView[] = [];
  private frameNo = 0;
  /** Moins d'animation demandé : pas de clignotement, de flottement ni de pulsation du halo (relu à chaque salle). */
  private reducedMotion = prefersReducedMotion();
  /** Ids de nourritures à retirer (réutilisé, pas d'allocation par frame). */
  private readonly stale: number[] = [];
  private readonly staleGear: number[] = [];
  private readonly staleBuff: number[] = [];
  private readonly staleLabel: number[] = [];

  constructor(private readonly ctx: ViewContext) {}

  /** Construit les cristaux de la salle (les nourritures, elles, se créent à la volée depuis l'état). */
  build(room: RoomDef): void {
    this.clear();
    this.reducedMotion = prefersReducedMotion();
    const { scene, rig, zoom } = this.ctx;
    for (const def of room.healCrystals ?? []) {
      const x = (def.tile[0] + 0.5) * TILE;
      const y = (def.tile[1] + 0.5) * TILE;
      const halo = rig.registerWorld(scene.add.image(x, y - 2, FX_GLOW_KEY));
      halo.setBlendMode(1).setTint(CRYSTAL_HALO_COLOR).setScale(1.2).setAlpha(0.3).setDepth(DEPTH.decal - 0.5);
      const sprite = rig.registerWorld(scene.add.image(x, y, ATLAS_KEY, crystalFrame(false, 0)));
      sprite.setDepth(DEPTH.ySortBase + y + TILE / 2 - 2);
      const label = rig.registerWorld(makeWorldText(scene, zoom, t('loot.crystal.label'), { size: 8, color: CRYSTAL_HALO_COLOR, wrap: 96 }));
      label.setDepth(DEPTH_LABELS).setAlpha(0).setVisible(false);
      // cristal absent à ce nombre de joueurs (minPlayers) : masqué tant que l'état ne le liste pas (voir `sync`)
      sprite.setVisible(false);
      halo.setVisible(false);
      this.crystals.push({ def, x, y, sprite, halo, label, labelAlpha: 0 });
    }
  }

  /** Synchronise nourritures et cristaux avec l'état (appelé à chaque frame de rendu). */
  sync(state: GameState, timeMs: number): void {
    this.frameNo++;
    const list: readonly PickupState[] = state.room.pickups ?? [];
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      let v = this.pickups.get(p.id);
      if (!v) {
        v = this.createPickup(p);
        this.pickups.set(p.id, v);
      }
      v.seen = this.frameNo;
      const rm = this.reducedMotion;
      const bob = pickupBob(timeMs, p.id, rm);
      const a = pickupAlpha(p.ttlMs, timeMs, rm);
      v.sprite.setPosition(p.pos.x, p.pos.y - 3 + bob).setAlpha(a);
      v.halo.setPosition(p.pos.x, p.pos.y - 3 + bob).setAlpha(a * (rm ? 0.4 : 0.4 + 0.12 * Math.sin(timeMs / 170 + p.id)));
      v.sprite.setDepth(DEPTH.flat + 0.5);
      v.halo.setDepth(DEPTH.flat + 0.4);
    }
    if (this.pickups.size > list.length) {
      this.stale.length = 0;
      this.pickups.forEach((v, id) => {
        if (v.seen !== this.frameNo) this.stale.push(id);
      });
      for (let i = 0; i < this.stale.length; i++) {
        const v = this.pickups.get(this.stale[i]);
        if (v) {
          v.sprite.destroy();
          v.halo.destroy();
        }
        this.pickups.delete(this.stale[i]);
      }
    }
    this.syncGear(state.room.gearDrops ?? [], timeMs);
    this.syncBuffDrops(state.room.buffDrops ?? [], timeMs);
    this.syncSwapPrompts(state);
    this.syncCrystals(state, timeMs);
  }

  /** Objets d'équipement au sol : même halo doux que les cœurs (teinté par le niveau), clignotement des 4 dernières secondes, `prefers-reduced-motion` respecté. */
  private syncGear(list: readonly GearDropState[], timeMs: number): void {
    const { scene, rig } = this.ctx;
    const rm = this.reducedMotion;
    for (let i = 0; i < list.length; i++) {
      const g = list[i];
      let v = this.gears.get(g.id);
      if (!v) {
        const halo = rig.registerWorld(scene.add.image(g.pos.x, g.pos.y, FX_GLOW_KEY));
        halo.setBlendMode(1).setTint(gearLevelColor(g.item.level)).setScale(0.9);
        const sprite = rig.registerWorld(scene.add.image(g.pos.x, g.pos.y, ATLAS_KEY, gearFrame(g.item)));
        v = { sprite, halo, seen: 0 };
        this.gears.set(g.id, v);
      }
      v.seen = this.frameNo;
      const bob = gearBob(timeMs, g.id, rm);
      const a = gearAlpha(g.ttlMs, timeMs, rm);
      v.sprite.setPosition(g.pos.x, g.pos.y - 3 + bob).setAlpha(a).setDepth(DEPTH.flat + 0.6);
      v.halo.setPosition(g.pos.x, g.pos.y - 3 + bob).setAlpha(a * (rm ? 0.4 : 0.4 + 0.12 * Math.sin(timeMs / 170 + g.id))).setDepth(DEPTH.flat + 0.45);
    }
    if (this.gears.size > list.length) {
      this.staleGear.length = 0;
      this.gears.forEach((v, id) => {
        if (v.seen !== this.frameNo) this.staleGear.push(id);
      });
      for (let i = 0; i < this.staleGear.length; i++) {
        const v = this.gears.get(this.staleGear[i]);
        if (v) {
          v.sprite.destroy();
          v.halo.destroy();
        }
        this.gears.delete(this.staleGear[i]);
      }
    }
  }

  /** Bonus temporaires au sol : même halo doux (teinté par la sorte), clignotement des 4 dernières secondes, `prefers-reduced-motion` respecté. */
  private syncBuffDrops(list: readonly BuffDropState[], timeMs: number): void {
    const { scene, rig } = this.ctx;
    const rm = this.reducedMotion;
    for (let i = 0; i < list.length; i++) {
      const g = list[i];
      let v = this.buffs.get(g.id);
      if (!v) {
        const halo = rig.registerWorld(scene.add.image(g.pos.x, g.pos.y, FX_GLOW_KEY));
        halo.setBlendMode(1).setTint(buffColor(g.kind)).setScale(0.9);
        const sprite = rig.registerWorld(scene.add.image(g.pos.x, g.pos.y, ATLAS_KEY, buffFrame(g.kind)));
        v = { sprite, halo, seen: 0 };
        this.buffs.set(g.id, v);
      }
      v.seen = this.frameNo;
      const bob = gearBob(timeMs, g.id, rm);
      const a = gearAlpha(g.ttlMs, timeMs, rm);
      v.sprite.setPosition(g.pos.x, g.pos.y - 3 + bob).setAlpha(a).setDepth(DEPTH.flat + 0.6);
      v.halo.setPosition(g.pos.x, g.pos.y - 3 + bob).setAlpha(a * (rm ? 0.4 : 0.4 + 0.12 * Math.sin(timeMs / 170 + g.id))).setDepth(DEPTH.flat + 0.45);
    }
    if (this.buffs.size > list.length) {
      this.staleBuff.length = 0;
      this.buffs.forEach((v, id) => {
        if (v.seen !== this.frameNo) this.staleBuff.push(id);
      });
      for (let i = 0; i < this.staleBuff.length; i++) {
        const v = this.buffs.get(this.staleBuff[i]);
        if (v) {
          v.sprite.destroy();
          v.halo.destroy();
        }
        this.buffs.delete(this.staleBuff[i]);
      }
    }
  }

  /**
   * Invite « A : échanger » (+ nom de l'accessoire) au-dessus d'un accessoire d'une autre sorte que celui d'un joueur vivant qui se tient dessus (`swapCandidate`,
   * la même règle que la simulation). Un seul texte par objet, quel que soit le nombre de joueurs concernés.
   */
  private syncSwapPrompts(state: GameState): void {
    const drops = state.room.gearDrops ?? [];
    const seen = this.frameNo;
    if (drops.length > 0) {
      for (const p of state.players) {
        const d = swapCandidate(drops, p);
        if (!d) continue;
        let label = this.swapLabels.get(d.id);
        if (!label) {
          const { scene, rig, zoom } = this.ctx;
          label = rig.registerWorld(makeWorldText(scene, zoom, `${gearLabel(d.item, t)}\n${t(GEAR_SWAP_PROMPT_KEY)}`, { size: 8, color: 0xffffff, wrap: 96 }));
          label.setDepth(DEPTH_LABELS);
          this.swapLabels.set(d.id, label);
        }
        label.setVisible(true).setAlpha(1).setPosition(d.pos.x, d.pos.y - 16).setData('seen', seen);
      }
    }
    if (this.swapLabels.size > 0) {
      this.staleLabel.length = 0;
      this.swapLabels.forEach((l, id) => {
        if (l.getData('seen') !== seen) this.staleLabel.push(id);
      });
      for (let i = 0; i < this.staleLabel.length; i++) {
        this.swapLabels.get(this.staleLabel[i])?.destroy();
        this.swapLabels.delete(this.staleLabel[i]);
      }
    }
  }

  private createPickup(p: PickupState): PickupView {
    const { scene, rig } = this.ctx;
    const halo = rig.registerWorld(scene.add.image(p.pos.x, p.pos.y, FX_GLOW_KEY));
    halo.setBlendMode(1).setTint(pickupHaloColor(p.kind)).setScale(p.kind === 'full' ? 0.9 : 0.7);
    const sprite = rig.registerWorld(scene.add.image(p.pos.x, p.pos.y, ATLAS_KEY, pickupFrame(p.kind)));
    return { sprite, halo, seen: 0 };
  }

  private syncCrystals(state: GameState, timeMs: number): void {
    const states = state.room.healCrystals ?? [];
    for (let ci = 0; ci < this.crystals.length; ci++) {
      const c = this.crystals[ci];
      let st: HealCrystalState | undefined;
      for (let k = 0; k < states.length; k++) {
        if (states[k].id === c.def.id) {
          st = states[k];
          break;
        }
      }
      if (!st) {
        c.sprite.setVisible(false);
        c.halo.setVisible(false);
        c.label.setVisible(false);
        continue;
      }
      c.sprite.setVisible(true).setFrame(crystalFrame(st.used, this.reducedMotion ? 0 : timeMs));
      c.halo.setVisible(!st.used).setAlpha(this.reducedMotion ? 0.28 : 0.28 + 0.07 * Math.sin(timeMs / 210 + c.x));
      // étiquette de proximité : seulement tant que le cristal est intact et qu'un joueur vivant est proche
      let best = Infinity;
      if (!st.used) {
        for (const p of state.players) {
          if (p.status !== 'alive') continue;
          best = Math.min(best, Math.hypot(p.pos.x - c.x, p.pos.y - c.y));
        }
      }
      const target = best <= CRYSTAL_LABEL_RADIUS ? 1 : 0;
      c.labelAlpha += (target - c.labelAlpha) * 0.25;
      if (c.labelAlpha < 0.02) c.label.setVisible(false);
      else c.label.setVisible(true).setAlpha(c.labelAlpha).setPosition(c.x, c.y - 14);
    }
  }

  /** Re-traduit les étiquettes (changement de langue). */
  retranslate(): void {
    for (const c of this.crystals) c.label.setText(t('loot.crystal.label'));
    for (const l of this.swapLabels.values()) l.destroy(); // recréées dans la nouvelle langue au prochain `sync`
    this.swapLabels.clear();
  }

  /** Détruit tout (changement de salle). */
  clear(): void {
    for (const v of this.pickups.values()) {
      v.sprite.destroy();
      v.halo.destroy();
    }
    this.pickups.clear();
    for (const v of this.gears.values()) {
      v.sprite.destroy();
      v.halo.destroy();
    }
    this.gears.clear();
    for (const v of this.buffs.values()) {
      v.sprite.destroy();
      v.halo.destroy();
    }
    this.buffs.clear();
    for (const l of this.swapLabels.values()) l.destroy();
    this.swapLabels.clear();
    for (const c of this.crystals) {
      c.sprite.destroy();
      c.halo.destroy();
      c.label.destroy();
    }
    this.crystals = [];
  }

  destroy(): void {
    this.clear();
  }
}
