/**
 * Harnais de test du tutoriel : rejoue la MÊME boucle que `GameScene` (partenaire scripté + directeur + `knockDown`) avec un
 * « humain » scripté qui suit l'étape affichée. Aucune écriture dans `sim.state` : uniquement des `ActionFrame`.
 * Sert aux tests d'intégration (`tutorial.run.test.ts`) : le tutoriel est TERMINABLE, saute-able, déterministe, et le partenaire
 * ne perd jamais de PV.
 */
import { SIM_STEP_MS } from '../core/constants';
import { createSimulation, type GameSimulation } from '../core/simulation';
import type { ActionFrame, CharacterId, GameState, PlayerId, SimEvent, Vec2 } from '../core/types';
import { TUTORIAL_LEVEL_ID, TUTORIAL_SEED, tutorialLevel } from '../levels/tutorial';
import { applyScripted } from '../entities/tutorialRuntime';
import { TutorialDirector } from '../tutorial/TutorialDirector';
import type { HudRegionId } from '../tutorial/types';

export const ALL_REGIONS: readonly HudRegionId[] = ['roomGoals', 'personalGoal', 'hearts', 'gear', 'special', 'keys', 'torch', 'prompt', 'sign'];

const px = (tx: number, ty: number): Vec2 => ({ x: (tx + 0.5) * 16, y: (ty + 0.5) * 16 });

/** Entrées vides. */
export function idleFrame(): ActionFrame {
  return { moveX: 0, moveY: 0, attack: false, interact: false, revive: false, special: false, call: false, heart: false };
}

/** Stratégie de l'humain scripté. */
export type HumanStrategy = 'solver' | 'idle' | 'rush' | 'hitAndRun' | 'spamSpecial';

export interface TutorialRunOptions {
  seed?: number;
  human?: CharacterId;
  partner?: CharacterId;
  startRoomIndex?: number;
  strategy?: HumanStrategy;
  /** Ids d'étapes à sauter dès qu'elles s'affichent (variante « tout passer »). */
  skipAll?: boolean;
  /** Mise à terre du joueur (mort d'équipe réelle) : à ce tick dans la salle 0. */
  dieAtMs?: number;
  /** Stratégie 'idle' : appuie sur B (soin, 2 pas) toutes les `pressHeartEveryMs` ms (appui prématuré, loin du partenaire). */
  pressHeartEveryMs?: number;
}

/** Exécution headless d'un tutoriel. */
export class TutorialRun {
  readonly sim: GameSimulation;
  readonly director: TutorialDirector;
  readonly events: SimEvent[] = [];
  readonly stepsSeen: string[] = [];
  /** PV minimal atteint par le partenaire, par salle. */
  partnerMinHp = Infinity;
  skips = 0;
  roomSkips = 0;
  private pulse = 0;
  private blockedMs = 0;
  private last: Vec2 | null = null;
  private dieDone = false;

  constructor(readonly opts: TutorialRunOptions = {}) {
    this.sim = createSimulation(
      {
        levelId: TUTORIAL_LEVEL_ID,
        players: [
          { id: 0, characterId: opts.human ?? 'david', difficulty: 1 },
          { id: 1, characterId: opts.partner ?? 'sandrine', difficulty: 1 },
        ],
        seed: opts.seed ?? TUTORIAL_SEED,
        startRoomIndex: opts.startRoomIndex,
        // comme GameScene (`modeSimFlags`) : l'équipement est actif (rangée du HUD, ramassage, échange) mais AUCUN butin aléatoire, de vie ou d'équipement (les cœurs et objets sont posés par le script)
        gear: true,
        gearDrops: false,
        loot: false,
        autoCall: true, // l'appel automatique y est actif : cœur, objet moins puissant, échange d'accessoire, croix rouge
        heartSlot: true, // emplacement cœur : ranger, B sur soi, B sur un coéquipier blessé
      },
      tutorialLevel,
    );
    this.director = new TutorialDirector(tutorialLevel, { startRoomIndex: opts.startRoomIndex });
    this.partnerMinHp = this.sim.state.players[1].maxHp;
  }

  get state(): GameState {
    return this.sim.state;
  }

  get done(): boolean {
    return this.director.finished || this.sim.state.phase === 'levelComplete';
  }

  /** Un pas, exactement comme `GameScene.update`. */
  tick(): void {
    const state = this.sim.state;
    const stepId = this.director.step.id;
    if (this.stepsSeen[this.stepsSeen.length - 1] !== stepId) this.stepsSeen.push(stepId);
    if (this.opts.skipAll && this.director.view().visible) {
      const kind = this.director.skipKind();
      if (kind === 'step') {
        this.director.skipStep();
        this.skips++;
      }
    }
    const human = this.humanFrame(state);
    const partner = this.director.partnerFrame(state);
    const events = this.sim.step(SIM_STEP_MS, { 0: human, 1: partner });
    this.director.observe(events, state, { regions: ALL_REGIONS });
    for (const id of this.director.takeKnockDowns()) this.sim.knockDown(id);
    for (const a of this.director.takeScripted()) applyScripted(this.sim, a);
    for (const e of events) this.events.push(e);
    if (state.roomIndex === 0) this.partnerMinHp = Math.min(this.partnerMinHp, state.players[1].hp);
    if (this.opts.dieAtMs !== undefined && !this.dieDone && state.timeMs >= this.opts.dieAtMs && state.roomIndex === 0) {
      this.dieDone = true;
      this.sim.knockDown(0);
      this.sim.knockDown(1);
    }
  }

  /** Joue jusqu'à la fin du tutoriel ou `maxMs` ms simulées. Retourne le temps écoulé. */
  run(maxMs: number): number {
    const start = this.sim.state.timeMs;
    while (!this.done && this.sim.state.timeMs - start < maxMs) this.tick();
    return this.sim.state.timeMs - start;
  }

  // ───────────── L'humain ─────────────

  private walk(from: Vec2, to: Vec2, arrive = 3): { f: ActionFrame; arrived: boolean } {
    const f = idleFrame();
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const d = Math.hypot(dx, dy);
    if (d <= arrive) return { f, arrived: true };
    // déblocage : si immobile trop longtemps, léger détour
    if (this.last && Math.hypot(from.x - this.last.x, from.y - this.last.y) < 0.05) this.blockedMs += SIM_STEP_MS;
    else this.blockedMs = 0;
    this.last = { x: from.x, y: from.y };
    let ux = dx / d;
    let uy = dy / d;
    if (this.blockedMs > 400) {
      const sign = Math.floor(this.blockedMs / 600) % 2 === 0 ? 1 : -1;
      const tx = -uy * sign;
      const ty = ux * sign;
      ux = tx * 0.8 + ux * 0.2;
      uy = ty * 0.8 + uy * 0.2;
    }
    f.moveX = ux;
    f.moveY = uy;
    return { f, arrived: false };
  }

  private nearestEnemy(state: GameState, from: Vec2): Vec2 | null {
    let best: Vec2 | null = null;
    let bd = Infinity;
    for (const e of state.room.enemies) {
      if (e.dead || e.hp <= 0) continue;
      const d = Math.hypot(e.pos.x - from.x, e.pos.y - from.y);
      if (d < bd) {
        bd = d;
        best = e.pos;
      }
    }
    return best;
  }

  private fight(state: GameState, me: Vec2, special = false): ActionFrame {
    const target = this.nearestEnemy(state, me);
    if (!target) return idleFrame();
    const { f } = this.walk(me, target, 14);
    const d = Math.hypot(target.x - me.x, target.y - me.y);
    if (d < 26) {
      f.attack = true;
      if (special) {
        this.pulse++;
        f.special = this.pulse % 20 === 0;
      }
    }
    return f;
  }

  private humanFrame(state: GameState): ActionFrame {
    const me = state.players[0];
    if (me.status !== 'alive') return idleFrame();
    const strat = this.opts.strategy ?? 'solver';
    if (strat === 'idle') {
      const f = idleFrame();
      const every = this.opts.pressHeartEveryMs;
      if (every !== undefined && every > 0) f.heart = Math.floor(state.timeMs / SIM_STEP_MS) % Math.max(3, Math.round(every / SIM_STEP_MS)) < 2;
      return f;
    }
    const pos = me.pos;
    const room = tutorialLevel.rooms[state.roomIndex];
    if (strat !== 'solver') return this.combatOnly(strat, state, pos);

    const id = this.director.step.id;
    const mechPos = (mid: string): Vec2 => {
      const def = room.mechanisms.find((m) => m.id === mid);
      if (!def || !('tile' in def)) return pos;
      return px(def.tile[0], def.tile[1]);
    };
    const exitCenter = (): Vec2 => ({ x: (room.exit.rect.x + room.exit.rect.w / 2) * 16, y: (room.exit.rect.y + room.exit.rect.h / 2) * 16 });
    const pulseInteract = (f: ActionFrame): ActionFrame => {
      this.pulse++;
      f.interact = this.pulse % 6 < 3;
      return f;
    };
    switch (id) {
      case 'move':
        return { ...idleFrame(), moveX: 1 };
      case 'sign':
        return this.walk(pos, px(9, 5)).f;
      case 'attack':
      case 'personalGoal':
      case 'clearYard':
      case 'specialRecharge':
        return this.fight(state, pos);
      case 'special': {
        const f = this.fight(state, pos);
        this.pulse++;
        f.special = this.pulse % 10 < 3;
        return f;
      }
      case 'lever': {
        const w = this.walk(pos, px(13, 3), 4);
        return w.arrived ? pulseInteract(w.f) : w.f;
      }
      case 'plates':
      case 'teamGoal':
        return this.walk(pos, mechPos('pA')).f;
      case 'block': {
        // se place à gauche du bloc (rangée du bloc) puis pousse vers la droite
        const block = state.room.mechanisms.find((m) => m.id === 'b');
        const by = block && block.type === 'block' ? block.pos.y + 16 : 64;
        const bx = block && block.type === 'block' ? block.pos.x : 128;
        if (pos.x < bx && Math.abs(pos.y - by) <= 8) return { ...idleFrame(), moveX: 1, moveY: Math.max(-1, Math.min(1, (by - pos.y) / 4)) };
        return this.walk(pos, { x: bx - 24, y: by }, 3).f;
      }
      case 'keyPick': {
        // le bloc posé sur le socle barre les rangées 3-4 : on contourne par la rangée 6 puis on franchit la porte du socle
        if (pos.x < 270) return this.walk(pos, pos.y < 90 && pos.x > 190 ? { x: 205, y: 104 } : { x: 285, y: 104 }, 3).f;
        return this.walk(pos, mechPos('k0')).f;
      }
      case 'keyDoor': {
        const w = this.walk(pos, { x: 25.5 * 16, y: 6.5 * 16 }, 3);
        return w.arrived ? pulseInteract(w.f) : w.f;
      }
      case 'refuel': {
        const w = this.walk(pos, px(14, 5), 3);
        return w.arrived ? pulseInteract(w.f) : w.f;
      }
      case 'lightBrazier': {
        const w = this.walk(pos, px(22, 5), 3);
        return w.arrived ? pulseInteract(w.f) : w.f;
      }
      case 'revive': {
        const partner = state.players[1];
        if (partner.status === 'down') {
          const w = this.walk(pos, partner.pos, 10);
          return w.arrived ? { ...idleFrame(), revive: true } : w.f;
        }
        return idleFrame();
      }
      case 'heartStore': {
        // marche sur le cœur posé au sol (rangée 6)
        const pk = state.room.pickups?.[0];
        return pk ? this.walk(pos, pk.pos, 2).f : idleFrame();
      }
      case 'heartSelf': {
        // blessé avec un cœur rangé : appui court sur B (front montant). Le joueur attend la blessure mise en scène par l'étape (PV à 50 %) : un héros déjà blessé en arrivant (Romain, 100 PV max)
        // ne doit pas consommer son cœur AVANT elle (il ne serait plus « blessé par la mise en scène » et l'étape ne se validerait pas)
        if (me.hp > me.maxHp * 0.5 + 1) return idleFrame();
        this.pulse++;
        return { ...idleFrame(), heart: this.pulse % 6 < 3 };
      }
      case 'heartAlly': {
        // sans cœur rangé : va ramasser celui du sol ; avec un cœur : se place SUR le coéquipier blessé et appuie sur B
        const partner = state.players[1];
        if (me.heart === undefined) {
          const pk = state.room.pickups?.[0];
          return pk ? this.walk(pos, pk.pos, 2).f : idleFrame();
        }
        const w = this.walk(pos, partner.pos, 6);
        if (!w.arrived) return w.f;
        this.pulse++;
        return { ...idleFrame(), heart: this.pulse % 6 < 3 };
      }
      case 'heartFull': {
        // deux cœurs au sol : le premier est rangé, en passant sur le second l'emplacement est plein (appel automatique)
        const target = state.room.pickups?.[0];
        return target ? this.walk(pos, target.pos, 2).f : idleFrame();
      }
      case 'gearLeft': {
        // marche sur l'objet moins puissant posé au sol : il n'est pas pris, l'appel part, le partenaire vient le prendre (l'objet disparaît)
        const drop = state.room.gearDrops?.[0];
        return drop ? this.walk(pos, drop.pos, 2).f : idleFrame();
      }
      case 'gearSwap': {
        // se place sur l'accessoire d'une autre sorte posé au sol puis appuie sur A (l'ancien, verrouillé pour lui, est repris par le partenaire)
        const drop = state.room.gearDrops?.find((d) => d.item.slot === 'accessory' && d.lockedFor === null);
        if (!drop) return idleFrame();
        const w = this.walk(pos, drop.pos, 2);
        return w.arrived ? pulseInteract(w.f) : w.f;
      }
      case 'crossCall': {
        // le partenaire est tombé à 20 % de ses PV : se place SUR lui et appuie sur B (cœur rangé d'office)
        const partner = state.players[1];
        const w = this.walk(pos, partner.pos, 6);
        if (!w.arrived) return w.f;
        this.pulse++;
        return { ...idleFrame(), heart: this.pulse % 6 < 3 };
      }
      case 'crossWho':
      case 'autoCallRecap1':
      case 'autoCallRecap2':
        return idleFrame();
      case 'callReceive':
        return this.walk(pos, state.players[1].pos, 30).f;
      case 'callSend': {
        if (!this.director.view().waiting) {
          this.pulse++;
          return { ...idleFrame(), call: this.pulse % 20 < 2 };
        }
        return idleFrame();
      }
      case 'welcome':
      case 'roomGoals':
      case 'hearts':
      case 'darkIntro':
      case 'wipe':
      case 'finalGoals':
        return idleFrame();
      default:
        if (id.startsWith('exit.')) return this.walk(pos, exitCenter(), 6).f;
        return idleFrame();
    }
  }

  private combatOnly(strat: HumanStrategy, state: GameState, pos: Vec2): ActionFrame {
    const room = tutorialLevel.rooms[state.roomIndex];
    if (state.roomIndex !== 0) {
      // hors de la cour : rejoint simplement la sortie
      const exit = { x: (room.exit.rect.x + room.exit.rect.w / 2) * 16, y: (room.exit.rect.y + room.exit.rect.h / 2) * 16 };
      return this.walk(pos, exit, 6).f;
    }
    this.pulse++;
    const target = this.nearestEnemy(state, pos);
    if (!target) return this.walk(pos, px(33, 6), 6).f;
    const d = Math.hypot(target.x - pos.x, target.y - pos.y);
    const f = this.walk(pos, target, 10).f;
    if (strat === 'rush') {
      f.attack = d < 28;
    } else if (strat === 'spamSpecial') {
      f.attack = d < 28;
      f.special = this.pulse % 12 < 2;
    } else {
      // hit-and-run : frappe puis recule vers l'ouest sans jamais dépasser x = 14 tuiles
      const cycle = this.pulse % 90;
      if (cycle < 45) f.attack = d < 28;
      else {
        f.moveX = pos.x > 14 * 16 ? -1 : 0;
        f.moveY = 0;
      }
    }
    return f;
  }
}

/** Identifiants des joueurs (lisibilité des tests). */
export const HUMAN: PlayerId = 0;
export const PARTNER: PlayerId = 1;
