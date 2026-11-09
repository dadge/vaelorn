/**
 * Actions de script des bots de test : fabriques de `BotAction` à empiler dans la file d'un joueur
 * (`run.queue(playerId, ...)`, `run.queueForSlot(slot, ...)`).
 *
 * Une action est une petite machine à états exécutée pas à pas par `BotPlayer` (aucune promesse) : elle lit la
 * partie via `ctx.run`, écrit une frame d'entrées via `ctx.set(...)` et retourne 'running' / 'done' / 'failed'
 * (`ctx.fail('raison')`). Une action qui termine SANS écrire de frame laisse la suivante démarrer dans le même pas.
 * Toute action échoue proprement (échec enregistré dans `run.failures`, joint aux diagnostics) au lieu de boucler
 * indéfiniment : chacune a un délai maximal (`maxMs`).
 *
 * Les actions de déplacement (`goTo`, `goNear`, `standOn`…) interrompent leur trajet pour combattre un ennemi à
 * moins de `reactRadius` px (option `fight`, activée par défaut, avec un budget de temps) ; les actions passives
 * (`wait`, `waitUntil`, `barrier`) laissent les comportements de fond (combat, relevage) agir.
 *
 * Les cibles sont des TUILES (`[x, y]`) ou des PIXELS (`{x, y}`), éventuellement calculées par une fonction
 * `(run, bot) => cible` évaluée à chaque pas (ex. `() => run.mechTile('lv1')`).
 */
import { BLOCK_SIZE_TILES, INTERACT_RANGE, PLAYER_RADIUS, REVIVE_RANGE, TILE } from '../core/constants';
import { canOccupy } from '../core/collision';
import { dist } from '../core/geometry';
import { requiredPushers } from '../core/mechanisms';
import type { BlockState, Dir, EnemyKind, PlayerId, TileXY, Vec2 } from '../core/types';
import { decideCombat, decideEat, decideInPlace, decideRevive, moveVector, stepDistanceOf, type FollowGoal } from './botBrain';
import {
  makeAction,
  resolveTarget,
  targetToPx,
  type ActionCtx,
  type ActionRunner,
  type ActionStatus,
  type BotAction,
  type Cond,
  type Target,
  type TargetLike,
} from './botTypes';

// ───────────────────────────── Aides ─────────────────────────────

const DIR_VEC: Readonly<Record<Dir, Vec2>> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

function describeTarget(t: TargetLike): string {
  if (typeof t === 'function') return 'fn';
  if (Array.isArray(t)) return `tuile ${t[0]},${t[1]}`;
  return `px ${Math.round(t.x)},${Math.round(t.y)}`;
}

function fmt(n: number): string {
  return String(Math.round(n));
}

/** Boucle de séquence partagée par `seq` : exécute des actions l'une après l'autre (les instantanées s'enchaînent dans le pas). */
class SequenceRunner implements ActionRunner {
  private idx = 0;
  private cur: ActionRunner | null = null;
  private curLabel = '';
  private subElapsed = 0;

  constructor(private readonly actions: readonly BotAction[]) {}

  tick(ctx: ActionCtx): ActionStatus {
    const mutable = ctx as { elapsedMs: number };
    const outer = ctx.elapsedMs;
    try {
      for (let guard = 0; guard < 64; guard++) {
        if (!this.cur) {
          if (this.idx >= this.actions.length) return 'done';
          const a = this.actions[this.idx++];
          this.cur = a.create();
          this.curLabel = a.label;
          this.subElapsed = 0;
        }
        mutable.elapsedMs = this.subElapsed;
        const st = this.cur.tick(ctx);
        if (st === 'running') {
          this.subElapsed += ctx.dtMs;
          return 'running';
        }
        if (st === 'failed') return 'failed';
        this.cur = null;
        if (ctx.consumed) return this.idx >= this.actions.length ? 'done' : 'running';
      }
      return 'running';
    } finally {
      mutable.elapsedMs = outer;
    }
  }
}

/**
 * Enchaîne plusieurs actions en UNE action (les sous-actions instantanées s'exécutent dans le même pas).
 * @param label libellé (diagnostics)
 * @param actions sous-actions, dans l'ordre
 */
export function seq(label: string, ...actions: BotAction[]): BotAction {
  return makeAction(label, () => new SequenceRunner(actions));
}

/** N'exécute `action` que si `skipIf(run)` est faux AU MOMENT où l'action démarre (sinon terminée aussitôt). */
export function unless(skipIf: Cond, action: BotAction): BotAction {
  return makeAction(`unless(${action.label})`, () => {
    let inner: ActionRunner | null = null;
    let decided = false;
    return {
      tick(ctx) {
        if (!decided) {
          decided = true;
          if (skipIf(ctx.run)) return 'done';
          inner = action.create();
        }
        return (inner as ActionRunner).tick(ctx);
      },
    };
  });
}

// ───────────────────────────── Déplacements ─────────────────────────────

/** Options communes aux déplacements. */
export interface MoveOptions {
  /** Interrompre le trajet pour combattre un ennemi à moins de `reactRadius` px (défaut true). */
  fight?: boolean;
  /** Temps maximal (ms) cumulé passé à combattre pendant ce déplacement avant de l'ignorer (défaut 10000). */
  fightBudgetMs?: number;
  /** Délai maximal de l'action (ms, hors temps à terre) avant échec (défaut 45000). */
  maxMs?: number;
  /** Éviter les ennemis dans le choix du chemin (défaut true). */
  avoidEnemies?: boolean;
  /**
   * Comportement si aucun chemin n'existe pour l'instant : 'wait' (défaut) = réessayer jusqu'à `maxMs` (une porte peut
   * s'ouvrir, un bloc bouger) ; 'fail' = échouer après `unreachableGraceMs`.
   */
  onUnreachable?: 'wait' | 'fail';
  /** Délai (ms) avant d'échouer en mode 'fail' (défaut 1500). */
  unreachableGraceMs?: number;
  /** Libellé personnalisé (diagnostics). */
  label?: string;
}

/** Options de `goTo`. */
export interface GoToOptions extends MoveOptions {
  /** Distance d'arrivée (px) : défaut 3. */
  tolerance?: number;
}

interface MoveState {
  fightMs: number;
  unreachableMs: number;
}

function moveStep(ctx: ActionCtx, goal: FollowGoal, st: MoveState, o: MoveOptions, what: string): ActionStatus {
  const maxMs = o.maxMs ?? 45000;
  if (ctx.elapsedMs > maxMs) {
    return ctx.fail(`délai dépassé (${maxMs} ms) pour atteindre ${what} (position ${fmt(ctx.player.pos.x)},${fmt(ctx.player.pos.y)})`);
  }
  if ((o.fight ?? true) && st.fightMs < (o.fightBudgetMs ?? 10000)) {
    const c = decideCombat(ctx.bot, { mode: 'chase', radius: ctx.bot.opts.reactRadius });
    if (c) {
      st.fightMs += ctx.dtMs;
      ctx.set(c.frame);
      return 'running';
    }
  }
  const r = ctx.bot.follower.follow(ctx.bot, goal);
  switch (r.status) {
    case 'arrived':
      return 'done';
    case 'moving':
      st.unreachableMs = 0;
      ctx.set({ moveX: r.vec.x, moveY: r.vec.y });
      return 'running';
    case 'blocked':
      return ctx.fail(`bloqué physiquement en allant vers ${what} (position ${fmt(ctx.player.pos.x)},${fmt(ctx.player.pos.y)})`);
    case 'unreachable':
      st.unreachableMs += ctx.dtMs;
      if ((o.onUnreachable ?? 'wait') === 'fail' && st.unreachableMs >= (o.unreachableGraceMs ?? 1500)) {
        return ctx.fail(`aucun chemin vers ${what} (position ${fmt(ctx.player.pos.x)},${fmt(ctx.player.pos.y)})`);
      }
      if (!ctx.useBackground({ regroup: false })) ctx.set({});
      return 'running';
  }
}

/**
 * Va jusqu'à une cible (tuile ou pixel) en suivant un chemin sur la grille de tuiles (murs, fosses, portes fermées,
 * blocs évités ; ennemis évités quand c'est possible). Le chemin est replanifié si le décor change (porte qui s'ouvre,
 * bloc déplacé) et en cas de blocage ; un ennemi qui arrive au contact est combattu (`fight`).
 * Termine quand le joueur est à ≤ `tolerance` px du centre de la cible (défaut 3 px).
 * Échecs : délai `maxMs` dépassé (cible inatteignable en mode 'wait'), blocage physique répété.
 */
export function goTo(target: TargetLike, opts: GoToOptions = {}): BotAction {
  const label = opts.label ?? `goTo(${describeTarget(target)})`;
  return makeAction(label, () => {
    const st: MoveState = { fightMs: 0, unreachableMs: 0 };
    return {
      tick(ctx) {
        const pos = resolveTarget(target, ctx.run, ctx.bot);
        const goal: FollowGoal = { pos, tolerance: opts.tolerance ?? 3, avoidEnemies: opts.avoidEnemies ?? true };
        return moveStep(ctx, goal, st, opts, `${describeTarget(target)} (${fmt(pos.x)},${fmt(pos.y)})`);
      },
    };
  });
}

/** Options de `goNear`. */
export interface GoNearOptions extends MoveOptions {
  /** Distance d'arrivée (px) : défaut 18 (portée d'interaction = 20). */
  radius?: number;
}

/**
 * Va à portée d'une cible sans l'atteindre exactement : la destination est la tuile libre la plus proche (en chemin) dont le
 * centre est à ≤ `radius − 1,5` px de la cible ; arrivée à ≤ `radius` px. Idéal pour les portes (solides tant qu'elles sont
 * fermées), les leviers, un joueur à terre.
 */
export function goNear(target: TargetLike, opts: GoNearOptions = {}): BotAction {
  const radius = opts.radius ?? 18;
  const label = opts.label ?? `goNear(${describeTarget(target)}, ${radius})`;
  return makeAction(label, () => {
    const st: MoveState = { fightMs: 0, unreachableMs: 0 };
    return {
      tick(ctx) {
        const pos = resolveTarget(target, ctx.run, ctx.bot);
        const goal: FollowGoal = { pos, tolerance: 1, near: radius, avoidEnemies: opts.avoidEnemies ?? true };
        return moveStep(ctx, goal, st, opts, `${describeTarget(target)} (${fmt(pos.x)},${fmt(pos.y)})`);
      },
    };
  });
}

/** Options de `standOn`. */
export interface StandOnOptions extends MoveOptions {
  /** Précision de placement (px) : défaut 2. */
  tolerance?: number;
  /**
   * Comportement une fois en place : 'inPlace' (défaut) = frappe/tire sur ce qui est à portée et relève un allié à portée
   * SANS bouger ; 'none' = ne fait rien.
   */
  hold?: 'inPlace' | 'none';
  /** Fin de l'action quand cette condition devient vraie (sinon : jamais). */
  until?: Cond;
  /** Fin de l'action après ce temps de maintien (ms). */
  forMs?: number;
}

/**
 * Va se placer au centre d'une tuile (ou d'un pixel) et y RESTE. Sans `until` ni `forMs`, l'action ne se termine jamais
 * (les actions suivantes de la file n'auront pas lieu : c'est l'usage voulu pour tenir une plaque jusqu'à ce que le script
 * soit remplacé). Une fois en place, un petit recentrage corrige les dérives (bloc qui entraîne, recul…).
 */
export function standOn(target: TargetLike, opts: StandOnOptions = {}): BotAction {
  const label = opts.label ?? `standOn(${describeTarget(target)})`;
  return makeAction(label, () => {
    const st: MoveState = { fightMs: 0, unreachableMs: 0 };
    let holding = false;
    let holdMs = 0;
    return {
      tick(ctx) {
        const pos = resolveTarget(target, ctx.run, ctx.bot);
        const tol = opts.tolerance ?? 2;
        if (!holding) {
          const goal: FollowGoal = { pos, tolerance: tol, avoidEnemies: opts.avoidEnemies ?? true };
          const s = moveStep(ctx, goal, st, opts, `${describeTarget(target)} (${fmt(pos.x)},${fmt(pos.y)})`);
          if (s !== 'done') return s;
          holding = true;
        }
        if (opts.until && opts.until(ctx.run)) return 'done';
        if (opts.forMs !== undefined && holdMs >= opts.forMs) return 'done';
        holdMs += ctx.dtMs;
        if ((opts.hold ?? 'inPlace') === 'inPlace') {
          const f = decideInPlace(ctx.bot);
          if (f) {
            ctx.set(f);
            return 'running';
          }
        }
        const d = dist(ctx.player.pos, pos);
        if (d > Math.max(1, tol * 0.6)) {
          const r = ctx.bot.follower.follow(ctx.bot, { pos, tolerance: Math.max(1, tol * 0.5), avoidEnemies: false });
          if (r.status === 'moving') ctx.set({ moveX: r.vec.x, moveY: r.vec.y });
          else ctx.set({});
        } else {
          ctx.bot.follower.idle();
          ctx.set({});
        }
        return 'running';
      },
    };
  });
}

/** Maintient une direction de déplacement pendant `ms` ms (entrée brute, sans collision intelligente). */
export function moveDir(dir: Dir, ms: number): BotAction {
  return makeAction(`moveDir(${dir}, ${ms})`, () => ({
    tick(ctx) {
      if (ctx.elapsedMs >= ms) return 'done';
      const v = DIR_VEC[dir];
      ctx.set({ moveX: v.x, moveY: v.y });
      return 'running';
    },
  }));
}

// ───────────────────────────── Interactions ─────────────────────────────

/** Options de `pressInteract`. */
export interface PressInteractOptions {
  /** Condition de succès vérifiée après l'appui ; sinon l'appui est répété (voir `retries`). */
  expect?: Cond;
  /** Temps (ms) d'attente de `expect` après un appui (défaut 300). */
  settleMs?: number;
  /** Nombre de nouveaux appuis autorisés si `expect` reste faux (défaut 2). */
  retries?: number;
  label?: string;
}

/**
 * Appuie UNE fois sur « interagir » (front montant d'un pas : la frame précédente est relâchée au besoin). Le joueur doit être
 * à portée du mécanisme (levier, piédestal, porte à clé : 20 px) — utiliser `goNear`/`goTo` avant. Avec `expect`, vérifie
 * l'effet et réessaie ; échoue (« interaction sans effet ») sinon.
 */
export function pressInteract(opts: PressInteractOptions = {}): BotAction {
  return makeAction(opts.label ?? 'pressInteract', () => {
    let stage: 'press' | 'settle' = 'press';
    let settle = 0;
    let tries = 0;
    return {
      tick(ctx) {
        if (stage === 'press') {
          if (ctx.player.prev.interact) {
            ctx.set({});
            return 'running';
          }
          ctx.set({ interact: true });
          if (!opts.expect) return 'done';
          stage = 'settle';
          settle = 0;
          return 'running';
        }
        settle += ctx.dtMs;
        if (opts.expect && opts.expect(ctx.run)) return 'done';
        if (settle >= (opts.settleMs ?? 300)) {
          if (tries < (opts.retries ?? 2)) {
            tries++;
            stage = 'press';
            return 'running';
          }
          return ctx.fail(`interaction sans effet (${tries + 1} appui(s), position ${fmt(ctx.player.pos.x)},${fmt(ctx.player.pos.y)})`);
        }
        return 'running';
      },
    };
  });
}

/** Maintient « interagir » pendant `ms` ms (le front montant a lieu au premier pas). */
export function holdInteract(ms: number): BotAction {
  return makeAction(`holdInteract(${ms})`, () => ({
    tick(ctx) {
      if (ctx.elapsedMs >= ms) return 'done';
      ctx.set({ interact: true });
      return 'running';
    },
  }));
}

/** Maintient « relever » pendant `ms` ms (utile pour des tests précis ; l'auto-relevage suffit d'habitude). */
export function holdRevive(ms: number): BotAction {
  return makeAction(`holdRevive(${ms})`, () => ({
    tick(ctx) {
      if (ctx.elapsedMs >= ms) return 'done';
      ctx.set({ revive: true });
      return 'running';
    },
  }));
}

// ───────────────────────────── Attente ─────────────────────────────

/**
 * Attend `ms` ms de jeu. Par défaut les comportements de fond (combat, relevage) restent actifs ; avec `passive: true` le joueur
 * ne fait absolument rien (il ne se bat pas, ne relève personne : utile pour « laisser » des ennemis à un autre joueur).
 */
export function wait(ms: number, opts: { passive?: boolean } = {}): BotAction {
  const a = makeAction(`wait(${ms})`, () => ({
    tick(ctx) {
      if (ctx.elapsedMs >= ms) return 'done';
      if (!opts.passive) ctx.useBackground({ regroup: false });
      else ctx.set({});
      return 'running';
    },
  }));
  return opts.passive ? a : Object.assign(a, { background: true as const });
}

/** Options de `waitUntil`. */
export interface WaitUntilOptions {
  /** Échouer si le délai est dépassé (défaut true) ; sinon terminer silencieusement. */
  failOnTimeout?: boolean;
  /** Ne rien faire du tout pendant l'attente (ni combat ni relevage) : voir `wait`. Défaut false. */
  passive?: boolean;
  label?: string;
}

/**
 * Attend que `cond(run)` devienne vraie, au plus `maxMs` ms (défaut 60000). Les comportements de fond restent actifs.
 * Échoue au délai (sauf `failOnTimeout: false`).
 */
export function waitUntil(cond: Cond, maxMs = 60000, opts: WaitUntilOptions = {}): BotAction {
  const a = makeAction(opts.label ?? 'waitUntil', () => ({
    tick(ctx) {
      if (cond(ctx.run)) return 'done';
      if (ctx.elapsedMs >= maxMs) {
        return opts.failOnTimeout === false ? 'done' : ctx.fail(`condition non satisfaite après ${maxMs} ms (${opts.label ?? 'waitUntil'})`);
      }
      if (!opts.passive) ctx.useBackground({ regroup: false });
      else ctx.set({});
      return 'running';
    },
  }));
  return opts.passive ? a : Object.assign(a, { background: true as const });
}

/**
 * Point de rendez-vous nommé : attend que `parties` joueurs (défaut : tous) soient arrivés au point `name`, puis les libère
 * ensemble. Réutilisable une fois que tous sont repartis. Échoue après `maxMs` (défaut 60000).
 */
export function barrier(name: string, parties?: number, maxMs = 60000): BotAction {
  const a = makeAction(`barrier(${name})`, () => {
    let arrived = false;
    let leaving = false;
    return {
      tick(ctx) {
        const b = ctx.run.barrierFor(name);
        const need = parties ?? ctx.run.playerCount;
        if (!arrived) {
          b.arrived.add(ctx.id);
          arrived = true;
        }
        if (b.arrived.size >= need || leaving) {
          if (!leaving) {
            leaving = true;
            b.left++;
          }
          if (b.left >= b.arrived.size) ctx.run.barriers.delete(name);
          return 'done';
        }
        if (ctx.elapsedMs >= maxMs) {
          b.arrived.delete(ctx.id);
          return ctx.fail(`rendez-vous « ${name} » : ${b.arrived.size}/${need} joueur(s) après ${maxMs} ms`);
        }
        ctx.useBackground({ regroup: false });
        return 'running';
      },
    };
  });
  return Object.assign(a, { background: true as const });
}

/** Ajoute une trace de debug (`run.trace`, reprise dans les diagnostics) et passe immédiatement à la suite. */
export function say(label: string): BotAction {
  return makeAction(`say(${label})`, () => ({
    tick(ctx) {
      ctx.run.addTrace(ctx.id, label);
      return 'done';
    },
  }));
}

/** Exécute une fonction une fois (au démarrage de l'action) puis passe à la suite : hook pour des vérifications ou du code libre. */
export function act(fn: (run: ActionCtx['run'], bot: ActionCtx['bot']) => void, label = 'act'): BotAction {
  return makeAction(label, () => ({
    tick(ctx) {
      fn(ctx.run, ctx.bot);
      return 'done';
    },
  }));
}

/**
 * Action entièrement personnalisée : `tick` est appelé à chaque pas (voir `ActionRunner`). `create` est appelé à chaque
 * activation (pour porter un état local).
 */
export function custom(label: string, create: () => ActionRunner): BotAction {
  return makeAction(label, create);
}

// ───────────────────────────── Combat ─────────────────────────────

/** Options de `attackUntilClear`. */
export interface AttackUntilClearOptions {
  /** Délai maximal (ms, défaut 90000) avant échec. */
  maxMs?: number;
  /** Ne compter/viser que ces types d'ennemis (défaut : tous). */
  kinds?: readonly EnemyKind[];
  /** Échec si aucune cible n'est accessible pendant ce temps (ms, défaut 8000). */
  stallMs?: number;
  /** Relever aussi les alliés à terre quand aucun ennemi n'est atteignable (défaut true). */
  revive?: boolean;
}

/**
 * Chasse et attaque les ennemis vivants de la salle (n'importe quelle distance) jusqu'à ce qu'il n'en reste plus (et qu'aucune
 * apparition non conditionnée n'attende). Utilise le contrôleur de combat du personnage (mêlée au contact en regardant la cible,
 * distance en s'alignant sur la cible). Les cibles inatteignables sont ignorées 1,5 s puis retentées. Échecs : délai `maxMs`,
 * ou `stallMs` sans cible accessible (message listant les ennemis restants). Si l'option de fond `eat` est active (calibrage des sources de vie),
 * le joueur blessé ramasse d'abord la nourriture / le cristal proche (`decideEat`) : sans effet par défaut.
 */
export function attackUntilClear(opts: AttackUntilClearOptions = {}): BotAction {
  const kinds = opts.kinds;
  return makeAction('attackUntilClear', () => {
    let stallMs = 0;
    let pendingMs = 0;
    return {
      tick(ctx) {
        const run = ctx.run;
        const left = run.aliveEnemies.filter((e) => !kinds || kinds.includes(e.kind));
        if (left.length === 0) {
          if (!kinds && run.pendingSpawnCount(true) > 0 && pendingMs < 1200) {
            pendingMs += ctx.dtMs;
            ctx.useBackground({ regroup: false });
            return 'running';
          }
          return 'done';
        }
        pendingMs = 0;
        if (ctx.elapsedMs > (opts.maxMs ?? 90000)) {
          return ctx.fail(`ennemis encore vivants après ${opts.maxMs ?? 90000} ms : ${run.describeEnemies(left)}`);
        }
        if (ctx.player.revivingId !== null && (opts.revive ?? true)) {
          const r = decideRevive(ctx.bot);
          if (r) {
            stallMs = 0;
            ctx.set(r);
            return 'running';
          }
        }
        // Brique « ramasse la nourriture proche quand PV < 70 % » (option `eat`, désactivée par défaut : sans effet pour les bots existants).
        const eat = ctx.bot.opts.eat ? decideEat(ctx.bot) : null;
        if (eat) {
          stallMs = 0;
          ctx.set(eat);
          return 'running';
        }
        const c = decideCombat(ctx.bot, { mode: 'chase', radius: Infinity, kinds });
        if (c) {
          stallMs = 0;
          ctx.set(c.frame);
          return 'running';
        }
        if (opts.revive ?? true) {
          const r = decideRevive(ctx.bot);
          if (r) {
            stallMs = 0;
            ctx.set(r);
            return 'running';
          }
        }
        stallMs += ctx.dtMs;
        if (stallMs >= (opts.stallMs ?? 8000)) {
          return ctx.fail(`aucun ennemi accessible depuis ${opts.stallMs ?? 8000} ms : ${run.describeEnemies(left)}`);
        }
        ctx.set({});
        return 'running';
      },
    };
  });
}

/**
 * Combat ciblé : poursuit et attaque l'ennemi `enemyId` jusqu'à sa mort (ou sa disparition). Échoue après `maxMs`
 * (défaut 30000) ou si la cible reste inaccessible `stallMs` (défaut 8000).
 */
export function faceAndAttack(enemyId: number, opts: { maxMs?: number; stallMs?: number } = {}): BotAction {
  return makeAction(`faceAndAttack(${enemyId})`, () => {
    let stallMs = 0;
    return {
      tick(ctx) {
        const e = ctx.run.aliveEnemies.find((x) => x.id === enemyId);
        if (!e) return 'done';
        if (ctx.elapsedMs > (opts.maxMs ?? 30000)) return ctx.fail(`ennemi ${enemyId} (${e.kind}) toujours vivant (PV ${fmt(e.hp)}/${fmt(e.maxHp)})`);
        const c = decideCombat(ctx.bot, { mode: 'chase', radius: Infinity, forcedTargetId: enemyId });
        if (c) {
          stallMs = 0;
          ctx.set(c.frame);
          return 'running';
        }
        stallMs += ctx.dtMs;
        if (stallMs >= (opts.stallMs ?? 8000)) return ctx.fail(`ennemi ${enemyId} (${e.kind}) inaccessible`);
        ctx.set({});
        return 'running';
      },
    };
  });
}

/**
 * Relève explicitement le joueur `targetId` : le rejoint et maintient `revive` jusqu'à ce qu'il soit debout. Échoue après
 * `maxMs` (défaut 30000). Termine tout de suite si la cible est déjà debout.
 */
export function revivePlayer(targetId: PlayerId, opts: { maxMs?: number } = {}): BotAction {
  return makeAction(`revivePlayer(${targetId})`, () => ({
    tick(ctx) {
      const t = ctx.run.sim.state.players.find((p) => p.id === targetId);
      if (!t || t.status === 'alive') return 'done';
      if (ctx.elapsedMs > (opts.maxMs ?? 30000)) return ctx.fail(`joueur ${targetId} toujours à terre`);
      const d = dist(ctx.player.pos, t.pos);
      if (d <= REVIVE_RANGE - 2) {
        ctx.bot.follower.idle();
        ctx.set({ revive: true });
        return 'running';
      }
      const r = ctx.bot.follower.follow(ctx.bot, { pos: t.pos, tolerance: 1, near: REVIVE_RANGE - 3, avoidEnemies: true });
      if (r.status === 'moving') ctx.set({ moveX: r.vec.x, moveY: r.vec.y, revive: d <= REVIVE_RANGE });
      else if (r.status === 'arrived') ctx.set({ revive: true });
      else if (r.status === 'blocked') return ctx.fail(`bloqué en allant relever le joueur ${targetId}`);
      else ctx.set({});
      return 'running';
    },
  }));
}

// ───────────────────────────── Mécanismes ─────────────────────────────

/**
 * Actionne un levier : va à portée de sa tuile, appuie sur « interagir » et vérifie qu'il est actif (3 essais). Ne fait rien
 * si le levier est déjà actif ou neutralisé (`waived`). Attention : un levier à `ownerSlot` n'obéit qu'à son propriétaire —
 * mettre l'action dans la file du bon joueur (`run.queueForSlot`).
 */
export function pullLever(leverId: string, opts: MoveOptions = {}): BotAction {
  const solved: Cond = (run) => {
    const st = run.mech(leverId);
    return st.waived || st.active;
  };
  return seq(
    `pullLever(${leverId})`,
    unless(
      solved,
      seq(
        `pullLever(${leverId})/do`,
        goNear((run) => run.mechTile(leverId), { radius: 12, ...opts }),
        pressInteract({ expect: solved, settleMs: 300, retries: 3, label: `pressInteract(${leverId})` }),
      ),
    ),
  );
}

/**
 * Ramasse la clé `keyId` (ramassage automatique à ≤ 10 px de sa tuile). Ne fait rien si la clé est déjà ramassée ou
 * neutralisée. Seul son propriétaire (`ownerSlot`) peut la ramasser : mettre l'action dans la file du bon joueur.
 */
export function pickUpKey(keyId: string, opts: MoveOptions = {}): BotAction {
  const got: Cond = (run) => {
    const st = run.mech(keyId);
    return st.waived || (st.type === 'key' && (st.collected || st.active));
  };
  return seq(
    `pickUpKey(${keyId})`,
    unless(
      got,
      seq(
        `pickUpKey(${keyId})/do`,
        goTo((run) => run.mechTile(keyId), { tolerance: 3, ...opts }),
        waitUntil(got, 1500, { label: `clé ${keyId} ramassée` }),
      ),
    ),
  );
}

/**
 * Ouvre la porte à clé `doorId` : attend que ses exigences (`requires`) soient satisfaites, va à portée d'une de ses tuiles,
 * interagit (avec la clé en main) et vérifie l'ouverture. Ne fait rien si la porte est déjà ouverte/neutralisée.
 */
export function useKey(doorId: string, opts: MoveOptions = {}): BotAction {
  const open: Cond = (run) => {
    const st = run.mech(doorId);
    return st.waived || st.active;
  };
  return seq(
    `useKey(${doorId})`,
    unless(
      open,
      seq(
        `useKey(${doorId})/do`,
        waitUntil((run) => run.doorRequirementsMet(doorId), 60000, { label: `exigences de ${doorId}` }),
        goNear(
          (run, bot) => {
            const tiles = run.mechTiles(doorId);
            let best = tiles[0];
            let bd = Infinity;
            for (const t of tiles) {
              const d = dist(bot.player.pos, targetToPx(t));
              if (d < bd) {
                bd = d;
                best = t;
              }
            }
            return best;
          },
          { radius: INTERACT_RANGE - 2, ...opts },
        ),
        pressInteract({ expect: open, settleMs: 400, retries: 3, label: `pressInteract(${doorId})` }),
      ),
    ),
  );
}

/**
 * Joue une séquence de runes : pour chaque symbole, va sur le piédestal correspondant et interagit. Par défaut utilise
 * la séquence attendue (`RunePuzzleDef.sequence`). Échoue si une rune est refusée (progression remise à zéro).
 * @param runeId id de l'énigme de runes
 * @param symbols séquence à jouer (défaut : celle de la définition)
 */
export function runeSequence(runeId: string, symbols?: readonly string[]): BotAction {
  return makeAction(`runeSequence(${runeId})`, () => {
    let inner: ActionRunner | null = null;
    return {
      tick(ctx) {
        if (!inner) {
          const def = ctx.run.mechDef(runeId);
          if (def.type !== 'runePuzzle') return ctx.fail(`${runeId} n'est pas une énigme de runes`);
          const seqSyms = symbols ?? def.sequence;
          const steps: BotAction[] = [];
          seqSyms.forEach((sym, i) => {
            const ped = def.pedestals.find((q) => q.symbol === sym);
            if (!ped) {
              steps.push(
                makeAction(`rune ${sym}`, () => ({ tick: (c) => c.fail(`symbole inconnu « ${sym} » pour ${runeId}`) })),
              );
              return;
            }
            steps.push(
              goTo(ped.tile, { tolerance: 3 }),
              pressInteract({
                expect: (run) => {
                  const st = run.mech(runeId);
                  return st.type === 'runePuzzle' && (st.active || st.progress >= i + 1);
                },
                settleMs: 250,
                retries: 0,
                label: `rune ${sym}`,
              }),
            );
          });
          inner = new SequenceRunner(steps);
        }
        return inner.tick(ctx);
      },
    };
  });
}

// ───────────────────────────── Blocs poussables ─────────────────────────────

/** Options de `pushBlock`. */
export interface PushBlockOptions {
  /** Voie de poussée (0 = rangée haute / colonne gauche du bloc, 1 = rangée basse / colonne droite) : sépare deux pousseurs. */
  lane?: number;
  /** Délai maximal (ms, défaut 60000). */
  maxMs?: number;
  /** Échec si le bloc ne progresse plus pendant ce temps (ms, défaut 15000) — un second pousseur peut tarder. */
  stallMs?: number;
}

/**
 * Pousse le bloc `blockId` de `tiles` tuiles dans la direction `dir` : se place derrière le bloc (face opposée à `dir`, sur
 * la voie `lane`), puis pousse à pleine vitesse jusqu'à ce que le bloc ait atteint sa tuile cible (position de départ +
 * `dir` × `tiles`) et soit à l'arrêt. Le bloc est un obstacle pour le chemin : le joueur le contourne pour aller derrière.
 *
 * Les blocs 2 joueurs (`playersRequired` ≥ 2, plafonné au nombre de joueurs) exigent plusieurs pousseurs simultanés : voir
 * `BotRun.pushBlockTogether` qui met l'action dans la file des bons joueurs. Chaque pousseur attend l'autre (le bloc ne
 * démarre que lorsque le nombre requis est au contact).
 * Échecs : aucune position derrière le bloc, bloc immobile `stallMs`, délai `maxMs`.
 */
export function pushBlock(blockId: string, dir: Dir, tiles: number, opts: PushBlockOptions = {}): BotAction {
  return makeAction(`pushBlock(${blockId}, ${dir}, ${tiles})`, () => {
    const st: MoveState = { fightMs: 0, unreachableMs: 0 };
    let target: TileXY | null = null;
    let phase: 'stage' | 'push' = 'stage';
    let lastKey = '';
    let lastProgressMs = 0;
    const lane = opts.lane ?? 0;
    return {
      tick(ctx) {
        const run = ctx.run;
        const b = run.mech(blockId);
        if (b.type !== 'block') return ctx.fail(`${blockId} n'est pas un bloc`);
        const bs: BlockState = b;
        const v = DIR_VEC[dir];
        if (target === null) {
          target = [bs.tile[0] + v.x * tiles, bs.tile[1] + v.y * tiles];
          lastKey = `${bs.tile.join(',')}|${bs.moving ? 1 : 0}`;
          lastProgressMs = ctx.elapsedMs;
        }
        if (bs.moving === null && bs.tile[0] === target[0] && bs.tile[1] === target[1]) return 'done';
        const maxMs = opts.maxMs ?? 60000;
        if (ctx.elapsedMs > maxMs) {
          return ctx.fail(`bloc ${blockId} pas arrivé en ${target.join(',')} après ${maxMs} ms (tuile ${bs.tile.join(',')})`);
        }
        const key = `${bs.tile.join(',')}|${bs.moving ? 1 : 0}`;
        if (key !== lastKey) {
          lastKey = key;
          lastProgressMs = ctx.elapsedMs;
        }
        if (phase === 'push' && ctx.elapsedMs - lastProgressMs > (opts.stallMs ?? 15000)) {
          return ctx.fail(
            `bloc ${blockId} immobile en ${bs.tile.join(',')} depuis ${opts.stallMs ?? 15000} ms (obstacle sur ${[bs.tile[0] + v.x, bs.tile[1] + v.y].join(',')} ? second pousseur absent ?)`,
          );
        }

        const rect = { x: bs.pos.x, y: bs.pos.y, w: BLOCK_SIZE_TILES * TILE, h: BLOCK_SIZE_TILES * TILE };
        const horizontal = dir === 'left' || dir === 'right';
        const p = ctx.player.pos;
        // Coordonnée de la voie (axe perpendiculaire à la poussée) et position « contre la face ».
        const laneCoord = (row: number): number => (horizontal ? rect.y : rect.x) + 8 + 16 * row;
        const faceCoord = (): number => {
          switch (dir) {
            case 'right':
              return rect.x - PLAYER_RADIUS;
            case 'left':
              return rect.x + rect.w + PLAYER_RADIUS;
            case 'down':
              return rect.y - PLAYER_RADIUS;
            case 'up':
              return rect.y + rect.h + PLAYER_RADIUS;
          }
        };
        const pointBehind = (row: number, gap: number): Vec2 => {
          const f = faceCoord() - v.x * gap - v.y * gap;
          return horizontal ? { x: f, y: laneCoord(row) } : { x: laneCoord(row), y: f };
        };
        const freeAt = (pt: Vec2): boolean => canOccupy(pt, PLAYER_RADIUS, run.sim.grid, run.solids);

        if (phase === 'stage') {
          let goalPos: Vec2 | null = null;
          for (const row of [lane % 2, 1 - (lane % 2)]) {
            for (const gap of [11, 6, 1]) {
              const pt = pointBehind(row, gap);
              if (freeAt(pt)) {
                goalPos = pt;
                break;
              }
            }
            if (goalPos) break;
          }
          if (!goalPos) return ctx.fail(`aucune position libre derrière le bloc ${blockId} pour pousser vers ${dir}`);
          const s = moveStep(ctx, { pos: goalPos, tolerance: 1.5, avoidEnemies: true }, st, { fight: false, maxMs }, `derrière le bloc ${blockId}`);
          if (s === 'done') {
            phase = 'push';
            lastProgressMs = ctx.elapsedMs;
          } else return s;
        }
        // Dernier déplacement lancé (la tuile logique du bloc est déjà la cible) : on cesse de pousser, sinon le bloc repartirait
        // d'une tuile de plus dès la fin du mouvement (les pousseurs au contact enchaînent). On attend qu'il s'arrête.
        if (phase === 'push' && bs.tile[0] === target[0] && bs.tile[1] === target[1]) {
          ctx.set({});
          return 'running';
        }
        // Phase de poussée : avancer vers le bloc en gardant la voie. Si on s'est trop éloigné (repoussé), on se replace.
        const behind = horizontal ? (v.x > 0 ? rect.x - p.x : p.x - (rect.x + rect.w)) : v.y > 0 ? rect.y - p.y : p.y - (rect.y + rect.h);
        const perpPos = horizontal ? p.y : p.x;
        const perpMin = (horizontal ? rect.y : rect.x) - 2;
        const perpMax = (horizontal ? rect.y : rect.x) + rect.w + 2;
        if (behind > 30 || behind < -(BLOCK_SIZE_TILES * TILE + 4) || perpPos < perpMin - 6 || perpPos > perpMax + 6) {
          phase = 'stage';
          ctx.set({});
          return 'running';
        }
        const laneRow = lane % 2;
        const perpErr = laneCoord(laneRow) - perpPos;
        const stepDist = stepDistanceOf(ctx.player);
        const corr = Math.abs(perpErr) < 0.8 ? 0 : Math.max(-1, Math.min(1, perpErr / stepDist));
        const mv = horizontal ? { moveX: v.x, moveY: corr } : { moveX: corr, moveY: v.y };
        ctx.set(mv);
        return 'running';
      },
    };
  });
}

// ───────────────────────────── Sortie de salle ─────────────────────────────

/**
 * Actions « aller à la sortie de la salle et y rester » pour le joueur courant (une tuile de sortie distincte par joueur,
 * voir `BotRun.exitTile`). Termine par un `standOn` sans fin : la file du joueur est donc terminée par cette séquence.
 * Les joueurs à terre sont ignorés par la simulation (seuls les vivants doivent être dans la zone).
 */
export function toExit(): BotAction[] {
  const spot = (run: ActionCtx['run'], bot: ActionCtx['bot']): Target => run.exitTile(bot.id);
  return [goTo(spot, { label: 'goTo(sortie)' }), standOn(spot, { tolerance: 3, label: 'standOn(sortie)' })];
}

/** Cible de pixel utilitaire : centre d'une tuile. */
export function tilePx(tx: number, ty: number): Vec2 {
  return { x: (tx + 0.5) * TILE, y: (ty + 0.5) * TILE };
}

/** Distance de portée d'interaction (réexport pratique). */
export const INTERACT_REACH_PX = INTERACT_RANGE;

/** Convertit `requiredPushers` pour les scripts de niveau : nombre de pousseurs requis d'un bloc pour ce nombre de joueurs. */
export function pushersNeeded(run: ActionCtx['run'], blockId: string): number {
  const def = run.mechDef(blockId);
  if (def.type !== 'block') throw new Error(`${blockId} n'est pas un bloc`);
  return requiredPushers(def, run.playerCount);
}
