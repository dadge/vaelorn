/**
 * DIRECTEUR du tutoriel (PUR : ni Phaser, ni DOM, ni Date, ni Math.random). Il observe la simulation (événements + état,
 * à CHAQUE pas de simulation) et décide : quelle étape afficher, quand la valider, quoi faire faire au partenaire scripté, quand
 * demander une mise à terre scénarisée (`GameSimulation.knockDown`) et quelle carte d'interruption afficher.
 *
 * Horloge : uniquement le temps de SIMULATION (`dtMs` passé à `observe`) : le tutoriel se fige avec la pause et ne saute rien
 * lors d'une frame longue. Tout l'état est du JSON pur (`snapshot()` / `restore()`).
 *
 * Règles :
 *  - étape `do` : validée quand sa condition `done` est vraie ET que `minMs` d'affichage se sont écoulés (si l'état est déjà
 *    vrai, la carte reste lisible `minMs`) ; étape `tip` : se ferme seule après `minMs`, ne bloque jamais ;
 *  - le temps d'affichage ne court que dans la phase 'playing' et quand la porte (`gate`) de l'étape est ouverte ;
 *  - `roomEntered` : 'next' / 'start' → première étape non faite de la salle ; 'restart' (vraie défaite) → retour à la première
 *    étape `do` de la salle (sauf la démonstration `wipe` déjà faite) ;
 *  - interruptions prioritaires : joueur à terre (le partenaire vient le relever), partenaire à terre hors scénario, relevage interrompu ;
 *  - sauter une étape garde ses opérations « essentielles » du partenaire (plaque tenue, levier tiré, cercle tenu) : ainsi sauter
 *    ne bloque jamais le partenaire ; sauter une étape `exit.*`, une étape `prerequisite` (levier, bloc : la suite serait impossible),
 *    une étape devenue irrécupérable (`stuckWhen`, ex. bloc coincé) ou toute étape après 45 s sans progrès, saute la SALLE.
 */
import { SIM_STEP_MS } from '../core/constants';
import type { ActionFrame, GameState, LevelDef, PlayerId, RoomDef, SimEvent } from '../core/types';
import {
  HUMAN_ID,
  LOGGED_EVENT_TYPES,
  MAX_LOGGED_EVENTS,
  PARTNER_ID,
  evalCondition,
  stepSignNear,
  type ConditionCtx,
} from './conditions';
import { tileCenterPx } from '../core/mechanisms';
import { loadProgram, newVm, resolveTarget, stepVm } from './partnerScript';
import { TUTORIAL_STEPS, firstStepIndexOfRoom, isExitStep } from './steps';
import type {
  Condition,
  HudRegionId,
  MarkerSpec,
  PartnerOp,
  ResolvedMarker,
  ScriptedAction,
  TutorialState,
  TutorialStepDef,
  TutorialView,
} from './types';

/** Durée (ms de simulation) sans progrès au bout de laquelle la puce devient « Salle suivante ». */
export const STUCK_MS = 45_000;
/** Durée (ms) d'affichage de la carte « relevage interrompu ». */
export const FLASH_MS = 3500;
/** Plafond du déplacement compté par pas (px) : un téléport (changement de salle) ne valide pas « se déplacer ». */
const MAX_MOVE_PER_STEP_PX = 6;
/** Étapes pendant lesquelles un partenaire à terre est NORMAL (scénario) : pas de carte d'interruption. */
const PARTNER_DOWN_SCENARIO = new Set(['revive', 'wipe']);

/** Environnement d'un pas d'observation (fourni par la scène : zones du HUD actuellement visibles). */
export interface ObserveEnv {
  regions: readonly HudRegionId[];
}

function cloneOps(ops: readonly PartnerOp[]): PartnerOp[] {
  return ops.map((o) => ({ ...o }));
}

/** Repère résolu en coordonnées monde, ou null (cible absente, mécanisme déjà résolu…). */
export function resolveMarker(spec: MarkerSpec, state: GameState, room: RoomDef): ResolvedMarker | null {
  if ('tile' in spec) return resolveTarget({ tile: spec.tile }, room, state);
  if ('mech' in spec) {
    const st = state.room.mechanisms.find((m) => m.id === spec.mech);
    if (st && (st.active || st.waived) && st.type !== 'door' && st.type !== 'block') return null; // déjà fait : plus de repère
    return resolveTarget({ mech: spec.mech }, room, state);
  }
  if ('sign' in spec) {
    const sign = (room.signs ?? []).find((s) => s.id === spec.sign);
    return sign ? resolveTarget({ tile: sign.tile }, room, state) : null;
  }
  if ('partner' in spec) {
    const p = state.players[PARTNER_ID];
    return p ? { x: p.pos.x, y: p.pos.y } : null;
  }
  if ('exit' in spec) return resolveTarget({ exit: true }, room, state);
  // ennemi vivant le plus proche du joueur
  const human = state.players[HUMAN_ID];
  if (!human) return null;
  let best: ResolvedMarker | null = null;
  let bestD = Infinity;
  for (const e of state.room.enemies) {
    if (e.dead || e.hp <= 0) continue;
    const d = Math.hypot(e.pos.x - human.pos.x, e.pos.y - human.pos.y);
    if (d < bestD) {
      bestD = d;
      best = { x: e.pos.x, y: e.pos.y };
    }
  }
  return best;
}

export class TutorialDirector {
  private s: TutorialState;
  /** Dernier état observé (non sérialisé : sert aux repères et à `partnerFrame`). */
  private lastState: GameState | null = null;
  private regions: readonly HudRegionId[] = [];

  /**
   * @param level niveau-tutoriel
   * @param opts.startRoomIndex salle de départ (0-based, comme `SimConfig.startRoomIndex`) : la première étape de cette salle
   */
  constructor(
    private readonly level: LevelDef,
    opts: { startRoomIndex?: number } = {},
  ) {
    const idx = Math.max(0, Math.min(level.rooms.length - 1, Math.floor(Number.isFinite(opts.startRoomIndex ?? 0) ? (opts.startRoomIndex ?? 0) : 0)));
    const roomId = level.rooms[idx].id;
    this.s = {
      v: 1,
      roomId,
      stepIndex: 0,
      holding: false,
      finished: false,
      done: [],
      started: false,
      activeMs: 0,
      sinceProgressMs: 0,
      stuck: false,
      events: [],
      movedPx: 0,
      lastPos: null,
      signNear: { id: null, ms: 0 },
      wipeDone: false,
      knocked: false,
      pendingKnock: [],
      scripted: false,
      pendingScript: [],
      flash: null,
      phase: 'playing',
      backlog: [],
      backlogN: 0,
      vm: newVm(),
    };
    // les salles précédentes sont considérées faites (comme `createSimulation` avec `startRoomIndex`)
    for (const def of TUTORIAL_STEPS) {
      const ri = level.rooms.findIndex((r) => r.id === def.room);
      if (ri >= 0 && ri < idx) this.s.done.push(def.id);
    }
    const first = firstStepIndexOfRoom(roomId);
    this.setStep(first >= 0 ? first : 0, false);
  }

  // ───────────── Accès ─────────────

  get step(): TutorialStepDef {
    return TUTORIAL_STEPS[Math.min(this.s.stepIndex, TUTORIAL_STEPS.length - 1)];
  }

  get finished(): boolean {
    return this.s.finished;
  }

  /** Copie JSON de l'état (déterminisme, tests). */
  snapshot(): TutorialState {
    return JSON.parse(JSON.stringify(this.s)) as TutorialState;
  }

  static restore(state: TutorialState, level: LevelDef): TutorialDirector {
    const d = new TutorialDirector(level);
    d.s = JSON.parse(JSON.stringify(state)) as TutorialState;
    return d;
  }

  // ───────────── Pas de simulation ─────────────

  private ctx(state: GameState): ConditionCtx {
    return {
      level: this.level,
      state,
      room: this.level.rooms[state.roomIndex],
      events: this.s.events,
      movedPx: this.s.movedPx,
      signNear: this.s.signNear,
      regions: this.regions,
    };
  }

  private log(e: SimEvent): void {
    if (!LOGGED_EVENT_TYPES.has(e.type)) return;
    this.s.events.push(e);
    if (this.s.events.length > MAX_LOGGED_EVENTS) this.s.events.splice(0, this.s.events.length - MAX_LOGGED_EVENTS);
  }

  /** Remise à zéro du suivi d'une étape et chargement du programme du partenaire (opérations essentielles restantes d'abord). */
  private setStep(idx: number, clearBacklog: boolean): void {
    const s = this.s;
    const def = TUTORIAL_STEPS[idx];
    s.stepIndex = idx;
    s.started = false;
    s.activeMs = 0;
    s.sinceProgressMs = 0;
    s.stuck = false;
    s.events = [];
    s.movedPx = 0;
    s.lastPos = null;
    s.signNear = { id: null, ms: 0 };
    s.knocked = false;
    s.scripted = false;
    if (clearBacklog) {
      s.backlog = [];
      s.backlogN = 0;
    }
    loadProgram(s.vm, [...s.backlog, ...cloneOps(def.partner ?? [])]);
    s.backlogN = s.backlog.length;
  }

  /** Valide l'étape courante et passe à la suivante ; en fin de salle, attend `roomEntered`. */
  private complete(skipped: boolean): void {
    const s = this.s;
    const def = this.step;
    if (!s.done.includes(def.id)) s.done.push(def.id);
    if (def.id === 'wipe') s.wipeDone = true;
    if (skipped) {
      for (const op of def.partner ?? []) if ('essential' in op && op.essential) s.backlog.push({ ...op });
    }
    const next = s.stepIndex + 1;
    if (next >= TUTORIAL_STEPS.length) {
      s.finished = true;
      return;
    }
    const sameRoom = TUTORIAL_STEPS[next].room === def.room;
    this.setStep(next, !sameRoom);
    if (!sameRoom) s.holding = true;
  }

  private goToRoom(roomId: string): void {
    const s = this.s;
    s.roomId = roomId;
    s.holding = false;
    let idx = TUTORIAL_STEPS.findIndex((d) => d.room === roomId && !s.done.includes(d.id));
    if (idx < 0) idx = firstStepIndexOfRoom(roomId);
    if (idx < 0) return;
    const changedRoom = TUTORIAL_STEPS[s.stepIndex]?.room !== roomId;
    this.setStep(idx, changedRoom);
  }

  /** Vraie défaite : on reprend la salle à sa première étape `do` (hors démonstration déjà faite). */
  private restartRoom(roomId: string): void {
    const s = this.s;
    s.roomId = roomId;
    s.holding = false;
    s.flash = null;
    const ids = TUTORIAL_STEPS.filter((d) => d.room === roomId).map((d) => d.id);
    s.done = s.done.filter((id) => !ids.includes(id) || (id === 'wipe' && s.wipeDone));
    const idx = TUTORIAL_STEPS.findIndex((d) => d.room === roomId && d.kind === 'do' && !(d.id === 'wipe' && s.wipeDone));
    this.setStep(idx >= 0 ? idx : Math.max(0, firstStepIndexOfRoom(roomId)), false);
  }

  private onRoomEntered(e: Extract<SimEvent, { type: 'roomEntered' }>): void {
    const s = this.s;
    if (e.reason === 'restart') {
      if (this.step.id === 'wipe' && this.step.room === e.roomId) {
        this.log(e); // la démonstration est terminée (condition `done` de l'étape)
        return;
      }
      this.restartRoom(e.roomId);
      return;
    }
    if (e.roomId === s.roomId && !s.holding && this.step.room === e.roomId) return; // 'start' de la salle déjà en cours
    this.goToRoom(e.roomId);
  }

  /**
   * À appeler APRÈS chaque `sim.step` avec ses événements (dt = SIM_STEP_MS par défaut).
   * @param env zones du HUD visibles (condition `regionVisible`)
   */
  observe(events: readonly SimEvent[], state: GameState, env: ObserveEnv = { regions: [] }, dtMs: number = SIM_STEP_MS): void {
    const s = this.s;
    this.lastState = state;
    this.regions = env.regions;
    s.phase = state.phase;
    if (s.finished) return;

    for (const e of events) {
      if (e.type === 'roomEntered') {
        this.onRoomEntered(e);
      } else if (e.type === 'levelCompleted') {
        this.log(e);
        s.finished = true;
        return;
      } else {
        if (e.type === 'reviveInterrupted' && e.reviverId === HUMAN_ID) s.flash = { kind: 'reviveInterrupted', ms: FLASH_MS };
        this.log(e);
      }
    }
    if (s.holding) return;

    const def = this.step;
    const human = state.players[HUMAN_ID];
    const room = this.level.rooms[state.roomIndex];
    const playing = state.phase === 'playing';

    if (human) {
      if (s.lastPos) s.movedPx += Math.min(MAX_MOVE_PER_STEP_PX, Math.hypot(human.pos.x - s.lastPos.x, human.pos.y - s.lastPos.y));
      s.lastPos = { x: human.pos.x, y: human.pos.y };
    }
    s.signNear = stepSignNear(s.signNear, state, room, dtMs);

    const ctx = this.ctx(state);
    const gateOpen = s.started || !def.gate || evalCondition(def.gate, ctx);
    if (gateOpen) s.started = true;
    if (playing) {
      if (s.flash) {
        s.flash.ms -= dtMs;
        if (s.flash.ms <= 0) s.flash = null;
      }
      s.sinceProgressMs += dtMs;
      if (s.sinceProgressMs >= STUCK_MS) s.stuck = true;
      if (!s.stuck && def.stuckWhen && evalCondition(def.stuckWhen, ctx)) s.stuck = true;
      if (gateOpen) s.activeMs += dtMs;
      if (def.knockDown && !s.knocked && gateOpen && s.activeMs >= def.knockDown.afterMs) {
        s.knocked = true;
        for (const id of def.knockDown.ids) if (!s.pendingKnock.includes(id)) s.pendingKnock.push(id);
      }
      if (def.script && !s.scripted && gateOpen && s.activeMs >= def.script.afterMs) {
        s.scripted = true;
        for (const q of def.script.equip ?? []) s.pendingScript.push({ k: 'equip', id: q.id, item: { ...q.item } });
        for (const g of def.script.giveHeart ?? []) s.pendingScript.push({ k: 'giveHeart', id: g.id, kind: g.kind });
        for (const w of def.script.wound ?? []) s.pendingScript.push({ k: 'wound', id: w.id, fraction: w.fraction });
        for (const h of def.script.hearts ?? []) {
          const at = tileCenterPx(h.tile);
          s.pendingScript.push({ k: 'heart', x: at.x, y: at.y, kind: h.kind });
        }
        for (const g of def.script.gear ?? []) {
          const at = tileCenterPx(g.tile);
          s.pendingScript.push({ k: 'gear', x: at.x, y: at.y, item: { ...g.item } });
        }
      }
    }
    // cœur redonné (`script.keepHeart`) : le joueur a gaspillé son cœur sur lui-même avant d'avoir soigné le partenaire
    if (playing && s.scripted && def.script?.keepHeart && !s.pendingScript.some((a) => a.k === 'giveHeart')) {
      for (const g of def.script.giveHeart ?? []) {
        const q = state.players[g.id];
        if (q && q.status === 'alive' && q.heart === undefined && !s.events.some((e) => e.type === 'heartUsed' && e.playerId === g.id && e.targetId !== g.id)) {
          s.pendingScript.push({ k: 'giveHeart', id: g.id, kind: g.kind });
        }
      }
    }
    // validation (aussi hors phase 'playing' : `roomCleared` / `levelCompleted` arrivent au pas où la phase change)
    if (gateOpen && s.activeMs >= def.minMs) {
      if (def.kind === 'tip') {
        if (playing) this.complete(false);
      } else if (def.done && evalCondition(def.done, ctx)) {
        this.complete(false);
      }
    }
  }

  // ───────────── Partenaire ─────────────

  /**
   * Entrées du partenaire pour le PROCHAIN pas de simulation. À appeler UNE fois par pas (avant `sim.step`) : la machine virtuelle
   * avance à chaque appel.
   */
  partnerFrame(state: GameState, dtMs: number = SIM_STEP_MS): ActionFrame {
    const s = this.s;
    const ctx = this.ctx(state);
    const human = state.players[HUMAN_ID];
    const partner = state.players[PARTNER_ID];
    // joueur à terre et partenaire debout : le partenaire vient le relever (interruption, hors programme)
    const override: PartnerOp | undefined =
      human && partner && human.status === 'down' && partner.status === 'alive' && state.phase === 'playing' ? { op: 'reviveHuman' } : undefined;
    const frame = stepVm(
      s.vm,
      { dtMs, state, room: this.level.rooms[state.roomIndex], level: this.level, evalCond: (c: Condition) => evalCondition(c, ctx) },
      override,
    );
    // les opérations « essentielles » déjà exécutées quittent la file d'attente
    if (s.backlogN > 0 && s.vm.pc > 0) {
      const consumed = Math.min(s.vm.pc, s.backlogN);
      s.backlog.splice(0, consumed);
      s.backlogN -= consumed;
    }
    return frame;
  }

  /** Mises à terre scénarisées à demander à la simulation (`sim.knockDown(id)`), une seule fois. */
  takeKnockDowns(): PlayerId[] {
    const out = this.s.pendingKnock;
    this.s.pendingKnock = [];
    return out;
  }

  /** Mises en scène du soin (blessures, cœurs posés) à appliquer à la simulation (`applyScripted`), une seule fois par étape. */
  takeScripted(): ScriptedAction[] {
    const out = this.s.pendingScript;
    this.s.pendingScript = [];
    return out;
  }

  // ───────────── Saut ─────────────

  /** Ce que ferait `skipStep()` : sauter l'étape, ou toute la salle. */
  skipKind(): 'step' | 'room' {
    return this.s.stuck || isExitStep(this.step) || this.step.prerequisite === true ? 'room' : 'step';
  }

  /**
   * Saute : 'step' = l'étape courante est marquée faite (les opérations essentielles du partenaire sont conservées) ;
   * 'room' = rien n'est modifié ici, la scène doit relancer la simulation à la salle suivante (`startRoomIndex + 1`).
   */
  skipStep(): 'step' | 'room' {
    if (this.s.finished) return 'room';
    if (this.skipKind() === 'room') return 'room';
    if (this.s.holding) return 'step';
    this.complete(true);
    return 'step';
  }

  // ───────────── Vue ─────────────

  /** Salle (indice) où se trouve le directeur (pour relancer à la salle suivante). */
  get roomIndex(): number {
    return Math.max(0, this.level.rooms.findIndex((r) => r.id === this.s.roomId));
  }

  /** Ce que l'interface doit afficher. */
  view(): TutorialView {
    const s = this.s;
    const def = this.step;
    const state = this.lastState;
    const human = state?.players[HUMAN_ID];
    const partner = state?.players[PARTNER_ID];
    const visible = !s.finished && !s.holding && s.phase === 'playing' && state !== null;

    let interrupt: TutorialView['interrupt'] = null;
    if (visible && human && partner) {
      if (human.status === 'down' && partner.status === 'alive') interrupt = 'youDown';
      else if (partner.status === 'down' && human.status === 'alive' && !PARTNER_DOWN_SCENARIO.has(def.id)) interrupt = 'partnerDown';
      else if (s.flash) interrupt = 'reviveInterrupted';
    }
    const room = state ? this.level.rooms[state.roomIndex] : undefined;
    const gateOpen = s.started || !def.gate || !state || !room ? true : evalCondition(def.gate, this.ctx(state));

    let markers: ResolvedMarker[] = [];
    if (visible && state && room) {
      const specs: MarkerSpec[] = interrupt === 'youDown' ? [] : interrupt === 'partnerDown' ? [{ partner: true }] : (def.markers ?? []);
      markers = specs.map((m) => resolveMarker(m, state, room)).filter((m): m is ResolvedMarker => m !== null);
    }
    return {
      visible,
      stepId: def.id,
      index: s.stepIndex + 1,
      total: TUTORIAL_STEPS.length,
      textKey: interrupt ? `tutorial.card.${interrupt}` : def.textKey,
      waiting: !interrupt && !gateOpen,
      interrupt,
      stuck: s.stuck,
      skipKind: this.skipKind(),
      noCompact: def.noCompact === true,
      buttons: interrupt === 'partnerDown' || interrupt === 'reviveInterrupted' ? ['action'] : interrupt === 'youDown' ? [] : (def.buttons ?? []),
      highlights: interrupt ? [] : (def.highlights ?? []),
      markers,
      // pendant l'appel du partenaire, c'est l'indicateur d'appel du jeu (point + 3 arcs) qui parle : la flèche du tutoriel le masquerait
      edgeToPartner: !interrupt && def.edgeToPartner === true && !(partner && partner.callMs > 0),
      partnerPos: partner ? { x: partner.pos.x, y: partner.pos.y } : null,
      activeMs: s.activeMs,
      finished: s.finished,
    };
  }
}
