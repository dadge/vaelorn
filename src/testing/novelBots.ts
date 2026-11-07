/**
 * PRIMITIVES DE BOTS pour les trois mécanismes inédits des niveaux 4-6 : statues jumelles, sablier partagé, pont de lumière.
 * Ce sont des briques réutilisables par les scripts de solution de niveau (voir `level3.solution.ts` pour le style) : elles
 * produisent des `BotAction` (machines à états pas à pas, aucune écriture dans `sim.state`) ou remplissent directement les files
 * d'actions des joueurs (`run.queue`). Toutes sont réexportées par `botKit.ts` (`import { solveStatuePair, … } from './botKit'`).
 *
 * Rappel du moteur (`src/core/mechanisms.ts`, ordre et priorités documentés en tête de ce fichier) :
 *  - le pathfinding des bots (`BotRun.navMap()`) est construit à partir de `sim.solidRects()` = `mechanismSolidRects` : les statues,
 *    les tuiles de herse FERMÉES et les tuiles de pont NON éclairées sont donc des obstacles, replanifiés dès qu'ils changent
 *    (`run.solidsKey`). Un `goTo` vers un point derrière une herse fermée ou un pont éteint reste donc en attente
 *    ('unreachable' puis réessai) jusqu'à `maxMs` (mode 'fail' possible via `onUnreachable`) ;
 *  - une interaction n'actionne qu'UN mécanisme : porte à clé > levier > rune > statue > sablier > brasero.
 *
 * ════════════════════════════ STATUES JUMELLES ════════════════════════════
 * Un joueur sur le SOCLE (`standTile`) de la statue `i` + interact fait pivoter l'AUTRE statue (`1 - i`) d'un quart de tour horaire ;
 * résolue quand les deux regardent `targetDir`. Aucune simultanéité n'est requise (les rotations sont indépendantes) : un seul joueur
 * peut tout faire en allant d'un socle à l'autre.
 *  - `solveStatuePair(run, 'sp')` : met dans les files, pour 1..4 joueurs, tout ce qu'il faut. À 1 joueur : socle 0 (statue 1 tournée
 *    jusqu'à `targetDir`) puis socle 1 (statue 0). À 2+ joueurs : le joueur 0 tient le socle 0, le joueur 1 le socle 1 (option `players`
 *    pour désigner d'autres joueurs), les autres ne sont pas sollicités. Par défaut chaque joueur sollicité attend ensuite que le
 *    mécanisme soit résolu (`waitSolved`). Retourne les ids des joueurs sollicités.
 *  - `rotateOtherStatue('sp', socket)` : action unitaire « va sur le socle `socket` et appuie jusqu'à ce que l'autre statue regarde
 *    `targetDir` » (terminée immédiatement si c'est déjà le cas ou si le mécanisme est waived/résolu).
 *  - `statueSocketTile(run, 'sp', socket)` : tuile du socle (pour un `goTo` manuel).
 *
 * ════════════════════════════ SABLIER PARTAGÉ ════════════════════════════
 * Sable = `periodMs` (× 2 en solo) après chaque retournement ; la herse est ouverte tant qu'il reste du sable, se referme ensuite tuile
 * par tuile. État initial : sable vide, herse fermée. Un joueur doit donc retourner le sablier à un levier avant de traverser.
 *  - `flipHourglass('hg', { leverIndex? })` : va près du levier (le plus proche par défaut) et le retourne UNE fois (vérifie que le sable
 *    remonte). Solo : `[flipHourglass('hg'), crossHourglass('hg', dest)]` suffit (la période est doublée).
 *  - `holdHourglass('hg', { until, leverIndex?, refillBelowFrac?, finalFlip? })` : le « tenant » : reste près d'un levier, le retourne
 *    dès l'arrivée puis chaque fois que le sable tombe sous `refillBelowFrac` (défaut 0,5) de la période effective, jusqu'à ce que
 *    `until(run)` soit vrai. Avec `finalFlip: true`, il retourne UNE dernière fois à ce moment (sable plein pour sa propre traversée).
 *    Il combat sur place et relève un allié à portée sans quitter le levier.
 *  - `crossHourglass('hg', dest, moveOpts?)` : approche la herse par le côté courant (point accessible le plus proche), attend qu'elle
 *    soit ouverte (`hourglassGateOpen`), puis `goTo(dest)`. Aucun retournement : un autre joueur doit tenir le sablier.
 *  - `relayHourglass(run, 'hg', { dest, fromLever?, toLever?, holder?, relay? })` : scénario complet à 1..4 joueurs. Solo : retourner puis
 *    courir. 2+ : le tenant (joueur 0) retourne le sablier au levier `fromLever` pendant que TOUS les autres traversent vers
 *    `dest(id)` ; le relais (par défaut le premier autre joueur) retourne ensuite le levier `toLever` de l'autre côté ; quand tous les
 *    autres sont passés, le tenant fait un dernier retournement et traverse à son tour. `dest` : tuile unique ou `(id) => tuile`.
 *    Après l'appel, chaque joueur a ses actions de traversée en file ; ajouter ensuite ce que l'on veut (`run.queueExit()`…).
 *  - helpers : `hourglassGateOpen(run, 'hg')`, `hourglassSandMs(run, 'hg')`, `hourglassLeverTile(run, 'hg', i)`.
 *
 * ════════════════════════════ PONT DE LUMIÈRE ════════════════════════════
 * Les tuiles du pont ne sont praticables que dans le halo du porteur (joueur `lanternSlot % n`, rayon `radiusTiles`) ou sous un joueur
 * qui les occupe. Le porteur doit donc avancer tuile par tuile en gardant les autres dans son halo.
 *  - `escortLightBridge(run, 'br', { dest, route?, gap? })` : met dans les files (1..4 joueurs) : le PORTEUR rejoint le point accessible
 *    le plus proche du pont puis avance de tuile en tuile le long de `route` (par défaut `def.tiles` dans l'ordre ; `reverse: true`
 *    pour l'inverse), en attendant les suiveurs trop en retard ; les SUIVEURS restent `gap` tuile(s) (défaut 1) derrière le porteur
 *    puis rejoignent `dest(id)` quand il a terminé. En solo le porteur traverse seul dans son propre halo. Retourne les ids concernés.
 *    La route doit être une suite de tuiles adjacentes dont l'espacement est inférieur au rayon du halo (≥ 2 tuiles recommandé).
 *    Limite : un joueur à terre sur le pont n'est pas attendu ; si le porteur tombe, le joueur vivant le plus proche reprend la lanterne
 *    (`lightBridgeBearer`) mais l'escorte scriptée, elle, ne s'adapte pas : à éviter dans une solution de niveau (ennemis éliminés avant).
 *  - `nearestReachableTile(run, from, target)` : tuile accessible depuis `from` (au sens de la navigation courante) la plus proche de
 *    `target` — point d'attente avant un obstacle dynamique.
 *
 * Toutes ces primitives échouent proprement (`ctx.fail`, consigné dans `run.failures` et les diagnostics) au lieu de boucler.
 */
import { dist } from '../core/geometry';
import { effectiveHourglassPeriodMs, tileCenterPx } from '../core/mechanisms';
import type {
  Dir,
  HourglassDef,
  HourglassState,
  LightBridgeDef,
  PlayerId,
  StatuePairDef,
  StatuePairState,
  TileXY,
  Vec2,
} from '../core/types';
import { decideInPlace } from './botBrain';
import { goTo, act, seq, waitUntil, type MoveOptions } from './botActions';
import {
  makeAction,
  type ActionCtx,
  type ActionRunner,
  type ActionStatus,
  type BotAction,
  type Cond,
  type TargetLike,
} from './botTypes';
import type { BotRun } from './botKit';
import { reachableTiles, tileOfPx } from './pathfinding';

// ───────────────────────────── Aides communes ─────────────────────────────

/** Tuile ou fonction `(id) => tuile` (destination par joueur). */
export type TileForPlayer = TileXY | ((id: PlayerId) => TileXY);

function tileFor(t: TileForPlayer, id: PlayerId): TileXY {
  return typeof t === 'function' ? t(id) : t;
}

function sameTile(a: readonly [number, number], b: readonly [number, number]): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

/**
 * Tuile accessible depuis la position `from` (navigation courante : murs, fosses, solides dynamiques EXCLUS) la plus proche de
 * `target` (distance entre centres de tuiles ; ex-æquo : ordre de balayage). Sert à attendre devant une herse fermée ou un pont éteint.
 * Retourne la tuile de `from` si aucune autre n'est plus proche.
 */
export function nearestReachableTile(run: BotRun, from: Vec2, target: TileXY): TileXY {
  const nav = run.navMap();
  const start = tileOfPx(from);
  const reach = reachableTiles(nav, start);
  let best: TileXY = start;
  let bd = Math.hypot(start[0] - target[0], start[1] - target[1]);
  for (let ty = 0; ty < nav.height; ty++) {
    for (let tx = 0; tx < nav.width; tx++) {
      if (!reach[ty * nav.width + tx]) continue;
      const d = Math.hypot(tx - target[0], ty - target[1]);
      if (d < bd - 1e-9) {
        bd = d;
        best = [tx, ty];
      }
    }
  }
  return best;
}

/**
 * Gestionnaire d'appui d'interaction (front montant sur un pas, puis relâchement) avec vérification d'effet : après chaque appui,
 * `probe()` doit avoir « changé » (au sens de `changed`) dans les 4 pas suivants ; sinon nouvel appui ; échec après 4 appuis sans effet.
 */
class Presser {
  pending = false;
  private settle = 0;
  private fails = 0;
  private before: unknown = null;

  /** @returns 'success' (effet constaté), 'busy' (frame écrite : l'action reste en cours) ou 'fail' (4 appuis sans effet). */
  step(
    ctx: ActionCtx,
    probe: () => unknown,
    changed: (before: unknown, now: unknown) => boolean = (a, b) => a !== b,
  ): 'success' | 'busy' | 'fail' {
    if (this.pending) {
      this.settle++;
      if (changed(this.before, probe())) {
        this.pending = false;
        this.fails = 0;
        return 'success';
      }
      if (this.settle < 4) {
        ctx.set({});
        return 'busy';
      }
      this.pending = false;
      this.fails++;
      if (this.fails >= 4) return 'fail';
    }
    if (ctx.player.prev.interact) {
      ctx.set({});
      return 'busy';
    }
    this.before = probe();
    ctx.set({ interact: true });
    this.pending = true;
    this.settle = 0;
    return 'busy';
  }
}

/** Fait un pas vers `pos` (arrivée à ≤ `near` px). 'near' : arrivé ; 'moved' : frame écrite ; sinon statut d'échec/attente. */
function stepToward(ctx: ActionCtx, pos: Vec2, near: number): 'near' | 'moved' | 'unreachable' | 'blocked' {
  if (dist(ctx.player.pos, pos) <= near) {
    ctx.bot.follower.idle();
    return 'near';
  }
  const r = ctx.bot.follower.follow(ctx.bot, { pos, tolerance: 1, near, avoidEnemies: true });
  switch (r.status) {
    case 'arrived':
      return 'near';
    case 'moving':
      ctx.set({ moveX: r.vec.x, moveY: r.vec.y });
      return 'moved';
    case 'blocked':
      return 'blocked';
    case 'unreachable':
      if (!ctx.useBackground({ regroup: false })) ctx.set({});
      return 'unreachable';
  }
}

/** Sur place : combat sans bouger / relevage d'un allié à portée, sinon rien. */
function holdStill(ctx: ActionCtx): void {
  const f = decideInPlace(ctx.bot);
  ctx.set(f ?? {});
}

function fmt(n: number): string {
  return String(Math.round(n));
}

// ───────────────────────────── Statues jumelles ─────────────────────────────

function statuePairOf(run: BotRun, id: string): { def: StatuePairDef; st: StatuePairState } {
  const def = run.mechDef(id);
  const st = run.mech(id);
  if (def.type !== 'statuePair' || st.type !== 'statuePair') throw new Error(`${id} n'est pas une paire de statues`);
  return { def, st };
}

/** Tuile du socle (`standTile`) de la statue `socket` (0|1) de la paire `mechId` : s'y tenir pour faire pivoter l'AUTRE statue. */
export function statueSocketTile(run: BotRun, mechId: string, socket: 0 | 1): TileXY {
  const t = statuePairOf(run, mechId).def.statues[socket].standTile;
  return [t[0], t[1]];
}

/**
 * Va sur le socle `socket` de la paire `mechId` et appuie sur « interagir » jusqu'à ce que l'AUTRE statue (`1 - socket`) regarde
 * `targetDir` (un appui = un quart de tour horaire, donc 0 à 3 appuis). Terminée tout de suite si c'est déjà le cas, si la paire est
 * résolue ou waived. Combat sur place et relève un allié à portée pendant l'attente. Échecs : délai `maxMs` (défaut 60000), 4 appuis
 * sans effet (mauvais joueur, socle occupé par un autre mécanisme prioritaire…), socle inatteignable ou blocage physique.
 */
export function rotateOtherStatue(mechId: string, socket: 0 | 1, opts: { maxMs?: number } = {}): BotAction {
  return makeAction(`rotateOtherStatue(${mechId}, socle ${socket})`, () => {
    const presser = new Presser();
    return {
      tick(ctx: ActionCtx): ActionStatus {
        const { def, st } = statuePairOf(ctx.run, mechId);
        const other = (1 - socket) as 0 | 1;
        const finished = (): boolean => st.waived || st.active || st.facings[other] === def.targetDir;
        if (!presser.pending && finished()) return 'done';
        const maxMs = opts.maxMs ?? 60000;
        if (ctx.elapsedMs > maxMs) {
          return ctx.fail(`statue ${other} de ${mechId} : ${st.facings[other]} après ${maxMs} ms (cible ${def.targetDir})`);
        }
        const stand = def.statues[socket].standTile;
        const center = tileCenterPx(stand);
        if (!presser.pending) {
          const here = tileOfPx(ctx.player.pos);
          const centered = sameTile(here, stand) && dist(ctx.player.pos, center) <= 6;
          if (!centered) {
            const r = stepToward(ctx, center, 3);
            if (r === 'moved' || r === 'unreachable') return 'running';
            if (r === 'blocked') return ctx.fail(`bloqué en allant sur le socle ${stand.join(',')} de ${mechId}`);
          }
          const f = decideInPlace(ctx.bot);
          if (f) {
            ctx.set(f);
            return 'running';
          }
        }
        const res = presser.step(ctx, () => st.facings[other]);
        if (res === 'fail') {
          return ctx.fail(`4 appuis sans effet sur le socle ${stand.join(',')} de ${mechId} (statue ${other} reste ${st.facings[other]})`);
        }
        return 'running';
      },
    };
  });
}

/** Options de `solveStatuePair`. */
export interface SolveStatuePairOptions {
  /** Joueurs qui tiennent le socle 0 et le socle 1 (défaut `[0, 1 % nbJoueurs]`). Le même joueur peut tenir les deux (solo). */
  players?: readonly [PlayerId, PlayerId];
  /** Chaque joueur sollicité attend ensuite la résolution (défaut true). */
  waitSolved?: boolean;
  /** Délai maximal d'attente de la résolution (ms, défaut 120000). */
  maxMs?: number;
}

/**
 * Résout une paire de statues jumelles avec 1..4 joueurs (voir l'en-tête du fichier). Remplit les files de `run` :
 * le joueur A (socle 0) tourne la statue 1 jusqu'à `targetDir`, le joueur B (socle 1) tourne la statue 0 ; A = B en solo (les deux
 * actions se suivent dans sa file). Les deux joueurs travaillent en parallèle, sans coordination nécessaire.
 * @returns ids des joueurs sollicités (sans doublon)
 */
export function solveStatuePair(run: BotRun, mechId: string, opts: SolveStatuePairOptions = {}): PlayerId[] {
  statuePairOf(run, mechId); // validation du type
  const n = run.playerCount;
  const [a, b] = opts.players ?? ([0, (1 % n) as PlayerId] as const);
  run.queue(a, rotateOtherStatue(mechId, 0));
  run.queue(b, rotateOtherStatue(mechId, 1));
  const ids = a === b ? [a] : [a, b];
  if (opts.waitSolved ?? true) {
    for (const id of ids) {
      run.queue(id, waitUntil((r) => r.mechSolved(mechId), opts.maxMs ?? 120000, { label: `statues ${mechId} résolues` }));
    }
  }
  return ids;
}

// ───────────────────────────── Sablier partagé ─────────────────────────────

function hourglassOf(run: BotRun, id: string): { def: HourglassDef; st: HourglassState } {
  const def = run.mechDef(id);
  const st = run.mech(id);
  if (def.type !== 'hourglass' || st.type !== 'hourglass') throw new Error(`${id} n'est pas un sablier`);
  return { def, st };
}

/** Sable restant (ms) du sablier `mechId`. */
export function hourglassSandMs(run: BotRun, mechId: string): number {
  return hourglassOf(run, mechId).st.sandMs;
}

/** La herse du sablier est-elle entièrement ouverte (waived, ou sable restant et aucune tuile fermée) ? */
export function hourglassGateOpen(run: BotRun, mechId: string): boolean {
  const { st } = hourglassOf(run, mechId);
  return st.waived || (st.sandMs > 0 && st.closedCount === 0);
}

/** Tuile du levier `index` du sablier `mechId`. */
export function hourglassLeverTile(run: BotRun, mechId: string, index: number): TileXY {
  const { def } = hourglassOf(run, mechId);
  const t = def.levers[index];
  if (!t) throw new Error(`Le sablier ${mechId} n'a pas de levier ${index} (${def.levers.length} levier(s))`);
  return [t[0], t[1]];
}

function nearestLeverIndex(def: HourglassDef, pos: Vec2): number {
  let best = 0;
  let bd = Infinity;
  def.levers.forEach((t, i) => {
    const d = dist(pos, tileCenterPx(t));
    if (d < bd) {
      bd = d;
      best = i;
    }
  });
  return best;
}

/** Distance (px) à laquelle un bot se tient d'un levier pour l'actionner (portée d'interaction : 20). */
const LEVER_STAND_PX = 12;
/** Au-delà de cette distance (px) un tenant retourne près de son levier. */
const LEVER_DRIFT_PX = 15;

/**
 * Va près d'un levier du sablier (le plus proche par défaut) et le retourne UNE fois : le sable doit remonter (échec après 4 appuis
 * sans effet). Ne fait rien si le sablier est waived. Échecs : délai `maxMs` (défaut 60000), levier inatteignable/bloqué.
 * Attention : un autre mécanisme prioritaire à portée (porte à clé, levier, rune, statue) peut consommer l'appui.
 */
export function flipHourglass(mechId: string, opts: { leverIndex?: number; maxMs?: number } = {}): BotAction {
  return makeAction(`flipHourglass(${mechId})`, () => {
    const presser = new Presser();
    let lever = -1;
    return {
      tick(ctx: ActionCtx): ActionStatus {
        const { def, st } = hourglassOf(ctx.run, mechId);
        if (st.waived) return 'done';
        if (ctx.elapsedMs > (opts.maxMs ?? 60000)) return ctx.fail(`sablier ${mechId} non retourné après ${opts.maxMs ?? 60000} ms`);
        if (lever < 0) lever = opts.leverIndex ?? nearestLeverIndex(def, ctx.player.pos);
        if (!presser.pending) {
          const r = stepToward(ctx, tileCenterPx(def.levers[lever]), LEVER_STAND_PX);
          if (r === 'moved' || r === 'unreachable') return 'running';
          if (r === 'blocked') return ctx.fail(`bloqué en allant au levier ${lever} du sablier ${mechId}`);
        }
        const res = presser.step(ctx, () => st.sandMs, (before, now) => (now as number) > (before as number));
        if (res === 'success') return 'done';
        if (res === 'fail') return ctx.fail(`4 appuis sans effet sur le levier ${lever} du sablier ${mechId} (sable ${fmt(st.sandMs)} ms)`);
        return 'running';
      },
    };
  });
}

/** Options de `holdHourglass`. */
export interface HoldHourglassOptions {
  /** Condition de fin (typiquement « les autres sont passés »). Évaluée à chaque pas. */
  until: Cond;
  /** Levier tenu (défaut : le plus proche du joueur au démarrage). */
  leverIndex?: number;
  /** Retourner dès que le sable tombe sous cette fraction de la période effective (défaut 0,5). */
  refillBelowFrac?: number;
  /** Retourner dès l'arrivée près du levier (défaut true). */
  flipFirst?: boolean;
  /** Retourner UNE dernière fois quand `until` devient vrai, puis terminer (défaut false). */
  finalFlip?: boolean;
  /** Délai maximal (ms, défaut 180000). */
  maxMs?: number;
}

/**
 * Le TENANT du sablier : se tient près d'un levier (`LEVER_STAND_PX`) et le retourne à l'arrivée puis chaque fois que le sable passe
 * sous `refillBelowFrac` × période effective, jusqu'à ce que `until(run)` soit vrai (avec `finalFlip`, après un dernier retournement).
 * Combat sur place / relève un allié à portée sans quitter le levier. Ne fait rien si le sablier est waived. Échecs : délai `maxMs`,
 * levier inatteignable, 4 appuis sans effet.
 */
export function holdHourglass(mechId: string, opts: HoldHourglassOptions): BotAction {
  return makeAction(`holdHourglass(${mechId})`, () => {
    const presser = new Presser();
    let lever = -1;
    let flippedOnce = false;
    let latched = false;
    let finalDone = false;
    return {
      tick(ctx: ActionCtx): ActionStatus {
        const { def, st } = hourglassOf(ctx.run, mechId);
        if (st.waived) return 'done';
        const maxMs = opts.maxMs ?? 180000;
        if (ctx.elapsedMs > maxMs) return ctx.fail(`sablier ${mechId} : fin de tenue jamais atteinte après ${maxMs} ms (sable ${fmt(st.sandMs)} ms)`);
        if (lever < 0) lever = opts.leverIndex ?? nearestLeverIndex(def, ctx.player.pos);
        if (!latched && opts.until(ctx.run)) latched = true;
        if (latched && (!opts.finalFlip || finalDone) && !presser.pending) return 'done';

        const eff = effectiveHourglassPeriodMs(def, ctx.run.playerCount);
        const lowSand = st.sandMs < (opts.refillBelowFrac ?? 0.5) * eff;
        const wantFlip =
          presser.pending ||
          (latched && opts.finalFlip === true && !finalDone) ||
          ((opts.flipFirst ?? true) && !flippedOnce) ||
          lowSand;
        const target = tileCenterPx(def.levers[lever]);
        const far = dist(ctx.player.pos, target) > (wantFlip ? LEVER_STAND_PX + 1 : LEVER_DRIFT_PX);
        if (far && !presser.pending) {
          const r = stepToward(ctx, target, LEVER_STAND_PX);
          if (r === 'moved' || r === 'unreachable') return 'running';
          if (r === 'blocked') return ctx.fail(`bloqué en allant au levier ${lever} du sablier ${mechId}`);
        }
        if (!wantFlip) {
          holdStill(ctx);
          return 'running';
        }
        const res = presser.step(ctx, () => st.sandMs, (before, now) => (now as number) > (before as number));
        if (res === 'success') {
          flippedOnce = true;
          if (latched && opts.finalFlip) finalDone = true;
          if (latched && finalDone) return 'done';
        } else if (res === 'fail') {
          return ctx.fail(`4 appuis sans effet sur le levier ${lever} du sablier ${mechId} (sable ${fmt(st.sandMs)} ms)`);
        }
        return 'running';
      },
    };
  });
}

/**
 * Approche la herse par le côté courant : si elle n'est pas ouverte, va au point accessible le plus proche de ses tuiles (navigation
 * courante, herse fermée = obstacle) ; sinon ne fait rien.
 */
function approachGate(mechId: string, moveOpts: MoveOptions): BotAction {
  return makeAction(`approachGate(${mechId})`, () => {
    let inner: ActionRunner | null = null;
    return {
      tick(ctx: ActionCtx): ActionStatus {
        if (hourglassGateOpen(ctx.run, mechId)) return 'done';
        if (!inner) {
          const { def } = hourglassOf(ctx.run, mechId);
          const cx = def.gate.reduce((a, t) => a + t[0], 0) / def.gate.length;
          const cy = def.gate.reduce((a, t) => a + t[1], 0) / def.gate.length;
          const stage = nearestReachableTile(ctx.run, ctx.player.pos, [Math.round(cx), Math.round(cy)]);
          inner = goTo(stage, { tolerance: 4, ...moveOpts, label: `approche de la herse ${mechId}` }).create();
        }
        return inner.tick(ctx);
      },
    };
  });
}

/**
 * Traverse la herse du sablier `mechId` vers `dest` (tuile, pixel ou fonction) : (1) approche la herse par le côté courant ; (2) attend
 * qu'elle soit ouverte (`hourglassGateOpen`, au plus 90 s ; un AUTRE joueur doit tenir/retourner le sablier) ; (3) `goTo(dest)`.
 * Si la herse se referme avant l'entrée, le chemin est replanifié et le joueur attend sa réouverture (mode 'wait' de `goTo`).
 */
export function crossHourglass(mechId: string, dest: TargetLike, moveOpts: MoveOptions = {}): BotAction {
  return seq(
    `crossHourglass(${mechId})`,
    approachGate(mechId, moveOpts),
    waitUntil((run) => hourglassGateOpen(run, mechId), 90000, { label: `herse ${mechId} ouverte` }),
    goTo(dest, { label: `traversée de ${mechId}`, ...moveOpts }),
  );
}

/** Mémoire partagée des relais, par partie (rien dans `GameState`). */
const crossStores = new WeakMap<BotRun, Map<string, Set<PlayerId>>>();

function crossSet(run: BotRun, key: string): Set<PlayerId> {
  let m = crossStores.get(run);
  if (!m) {
    m = new Map();
    crossStores.set(run, m);
  }
  let s = m.get(key);
  if (!s) {
    s = new Set();
    m.set(key, s);
  }
  return s;
}

function markCrossed(key: string): BotAction {
  return act((run, bot) => {
    crossSet(run, key).add(bot.id);
  }, `traversée accomplie (${key})`);
}

function allCrossed(key: string, ids: readonly PlayerId[]): Cond {
  return (run) => ids.every((id) => crossSet(run, key).has(id));
}

/** Options de `relayHourglass`. */
export interface RelayHourglassOptions {
  /** Destination de chaque joueur de l'autre côté de la herse (tuile, ou `(id) => tuile`). */
  dest: TileForPlayer;
  /** Levier du côté de départ, tenu par le tenant (défaut 0). */
  fromLever?: number;
  /** Levier de l'autre côté, tenu par le relais (défaut 1). */
  toLever?: number;
  /** Le tenant (défaut : premier participant, soit le joueur 0). */
  holder?: PlayerId;
  /** Le relais (défaut : premier participant autre que le tenant ; aucun en solo). */
  relay?: PlayerId;
  /** Participants (défaut : tous les joueurs). */
  players?: readonly PlayerId[];
  /** Fraction du sable sous laquelle on retourne (défaut 0,5). */
  refillBelowFrac?: number;
  /** Options de déplacement des traversées. */
  move?: MoveOptions;
}

/**
 * Franchissement coopératif d'une herse de sablier, 1..4 joueurs (voir l'en-tête du fichier). Remplit les files de `run` :
 *  - SOLO : `flipHourglass(fromLever)` puis `crossHourglass(dest)` (la période est doublée en solo : la course doit tenir dedans) ;
 *  - 2+ joueurs : le TENANT tient `fromLever` (retournements réguliers) pendant que tous les AUTRES traversent vers `dest(id)` ; le
 *    RELAIS, une fois passé, tient `toLever` de l'autre côté jusqu'à ce que le tenant soit passé ; quand tous les autres sont passés,
 *    le tenant fait un dernier retournement et traverse à son tour.
 * Ne vide pas les files : à appeler dans un script de salle avant d'y ajouter la suite. Retourne les ids concernés.
 * @throws Error si le sablier n'a pas les leviers demandés ou si la liste de participants est vide
 */
export function relayHourglass(run: BotRun, mechId: string, opts: RelayHourglassOptions): PlayerId[] {
  const { def } = hourglassOf(run, mechId);
  const from = opts.fromLever ?? 0;
  const to = opts.toLever ?? Math.min(1, def.levers.length - 1);
  hourglassLeverTile(run, mechId, from);
  hourglassLeverTile(run, mechId, to);
  const players = (opts.players ?? run.bots.map((b) => b.id)).slice();
  if (players.length === 0) throw new Error('relayHourglass : aucun participant');
  const move = opts.move ?? {};
  if (players.length === 1) {
    const only = players[0];
    run.queue(only, flipHourglass(mechId, { leverIndex: from }), crossHourglass(mechId, tileFor(opts.dest, only), move));
    return players;
  }
  const holder = opts.holder ?? players[0];
  if (!players.includes(holder)) throw new Error(`relayHourglass : le tenant J${holder + 1} ne fait pas partie des participants`);
  const others = players.filter((id) => id !== holder);
  const relay = opts.relay ?? others[0];
  const key = `relay:${mechId}:${run.roomEnterCount}`;
  for (const id of others) {
    run.queue(id, crossHourglass(mechId, tileFor(opts.dest, id), move), markCrossed(key));
    if (id === relay) {
      run.queue(
        id,
        holdHourglass(mechId, {
          leverIndex: to,
          until: allCrossed(key, [holder]),
          refillBelowFrac: opts.refillBelowFrac,
        }),
      );
    }
  }
  run.queue(
    holder,
    holdHourglass(mechId, {
      leverIndex: from,
      until: allCrossed(key, others),
      finalFlip: true,
      refillBelowFrac: opts.refillBelowFrac,
    }),
    crossHourglass(mechId, tileFor(opts.dest, holder), move),
    markCrossed(key),
  );
  return players;
}

// ───────────────────────────── Pont de lumière ─────────────────────────────

function lightBridgeOf(run: BotRun, id: string): LightBridgeDef {
  const def = run.mechDef(id);
  if (def.type !== 'lightBridge') throw new Error(`${id} n'est pas un pont de lumière`);
  return def;
}

/** Avancement partagé d'une escorte : index de la dernière tuile de route atteinte par le porteur, et par suiveur. */
interface EscortProgress {
  bearerIdx: number;
  followerIdx: Map<PlayerId, number>;
  followers: PlayerId[];
}

const escortStores = new WeakMap<BotRun, Map<string, EscortProgress>>();

function escortOf(run: BotRun, key: string, followers: PlayerId[]): EscortProgress {
  let m = escortStores.get(run);
  if (!m) {
    m = new Map();
    escortStores.set(run, m);
  }
  let p = m.get(key);
  if (!p) {
    p = { bearerIdx: -1, followerIdx: new Map(), followers };
    m.set(key, p);
  }
  return p;
}

/** Options de `escortLightBridge`. */
export interface EscortLightBridgeOptions {
  /** Destination de chaque joueur après le pont (tuile, ou `(id) => tuile`). */
  dest: TileForPlayer;
  /** Route : tuiles adjacentes dans l'ordre de traversée (défaut : `def.tiles`). */
  route?: readonly TileXY[];
  /** Parcourir `def.tiles` à l'envers (ignoré si `route` est fourni). */
  reverse?: boolean;
  /**
   * Tuile « d'atterrissage » juste après le pont (hors route) où le porteur attend que tous les suiveurs aient quitté le pont, avant de
   * rejoindre sa destination (défaut : prolongement de la route d'une tuile, ou `dest` si cette tuile est un mur).
   */
  landing?: TileXY;
  /** Retard (en tuiles de route) des suiveurs derrière le porteur (défaut 1 ; doit rester < rayon du halo). */
  gap?: number;
  /** Participants (défaut : tous les joueurs ; doit contenir le porteur). */
  players?: readonly PlayerId[];
  /** Options de déplacement. */
  move?: MoveOptions;
  /** Délai maximal (ms) de chaque suiveur (défaut 180000). */
  maxMs?: number;
}

/**
 * Attente du porteur : tous les suiveurs vivants doivent avoir atteint une tuile de route d'index ≥ `minIdx` ; avec `route`, ils doivent
 * en plus avoir QUITTÉ le pont (ne plus occuper aucune tuile de la route).
 */
function waitFollowers(key: string, minIdx: () => number, offRoute?: readonly TileXY[]): BotAction {
  return makeAction('attente des suiveurs du pont', () => ({
    tick(ctx: ActionCtx): ActionStatus {
      const p = escortOf(ctx.run, key, []);
      const need = minIdx();
      const ok = p.followers.every((id) => {
        const pl = ctx.run.player(id);
        if (pl.status !== 'alive') return true;
        if ((p.followerIdx.get(id) ?? -1) < need) return false;
        if (!offRoute) return true;
        const t = tileOfPx(pl.pos);
        return !offRoute.some((r) => sameTile(r, t));
      });
      if (ok) return 'done';
      if (ctx.elapsedMs > 60000) return ctx.fail(`suiveurs du pont en retard (index requis ${need}, atteints ${[...p.followerIdx].map(([i, v]) => `J${i + 1}:${v}`).join(' ')})`);
      if (!ctx.useBackground({ regroup: false })) ctx.set({});
      return 'running';
    },
  }));
}

/**
 * Escorte à travers un pont de lumière, 1..4 joueurs (voir l'en-tête du fichier). Remplit les files de `run` :
 *  - le PORTEUR (`run.playerFor(def.lanternSlot)`) rejoint le point accessible le plus proche du pont, puis marche de tuile en tuile le long
 *    de la route (chaque tuile est éclairée par son propre halo avant qu'il y entre), en attendant les suiveurs trop en retard, puis
 *    attend à l'atterrissage (tuile suivant le pont) que tous les suiveurs aient quitté le pont avant de rejoindre sa destination ;
 *  - chaque SUIVEUR vise la tuile de route `gap` tuile(s) derrière le porteur (donc toujours dans le halo), attend au point d'approche tant
 *    que le porteur n'est pas engagé, et rejoint `dest(id)` quand le porteur a fini.
 * Pont waived : tout est éclairé, la même procédure fonctionne. Solo : le porteur seul.
 * @returns ids des joueurs mis à contribution (porteur en premier)
 * @throws Error si le porteur ne fait pas partie des participants, ou si la route est vide
 */
export function escortLightBridge(run: BotRun, mechId: string, opts: EscortLightBridgeOptions): PlayerId[] {
  const def = lightBridgeOf(run, mechId);
  const route: TileXY[] = (opts.route ?? (opts.reverse ? def.tiles.slice().reverse() : def.tiles)).map((t) => [t[0], t[1]] as TileXY);
  if (route.length === 0) throw new Error(`escortLightBridge : route vide pour ${mechId}`);
  const bearer = run.playerFor(def.lanternSlot);
  const players = (opts.players ?? run.bots.map((b) => b.id)).slice();
  if (!players.includes(bearer)) throw new Error(`escortLightBridge : le porteur J${bearer + 1} de ${mechId} doit faire partie des participants`);
  const followers = players.filter((id) => id !== bearer);
  const gap = Math.max(0, Math.floor(opts.gap ?? 1));
  const key = `escort:${mechId}:${run.roomEnterCount}`;
  const store = escortOf(run, key, followers);
  store.bearerIdx = -1;
  store.followerIdx.clear();
  store.followers = followers;
  const move = opts.move ?? {};
  const L = route.length;

  // Porteur : approche, puis tuile par tuile.
  const steps: BotAction[] = [
    goTo((r, bot) => nearestReachableTile(r, bot.player.pos, route[0]), { tolerance: 3, label: 'approche du pont', ...move }),
  ];
  route.forEach((t, i) => {
    steps.push(
      waitFollowers(key, () => i - 2 - gap),
      goTo(t, { tolerance: 3, label: `pont : tuile ${i} (${t.join(',')})`, ...move }),
      act(() => {
        store.bearerIdx = i;
      }, `pont : porteur en tuile ${i}`),
    );
  });
  // Atterrissage juste après le pont : le halo couvre les dernières tuiles pendant que les suiveurs descendent du pont.
  const lastTile = route[L - 1];
  const prevTile = L >= 2 ? route[L - 2] : null;
  let landing: TileXY = opts.landing ?? tileFor(opts.dest, bearer);
  if (!opts.landing && prevTile) {
    const ext: TileXY = [lastTile[0] + (lastTile[0] - prevTile[0]), lastTile[1] + (lastTile[1] - prevTile[1])];
    if (!run.sim.grid.blocksMovement(ext[0], ext[1])) landing = ext;
  }
  steps.push(
    waitFollowers(key, () => L - 2 - gap),
    goTo(landing, { tolerance: 3, label: 'pont : atterrissage du porteur', ...move }),
    act(() => {
      store.bearerIdx = L;
    }, 'pont : porteur à l’atterrissage'),
    waitFollowers(key, () => L - 1, route),
    goTo(tileFor(opts.dest, bearer), { tolerance: 3, label: 'pont : destination du porteur', ...move }),
  );
  run.queue(bearer, seq(`escortLightBridge(${mechId}) : porteur`, ...steps));

  // Suiveurs.
  for (const id of followers) {
    run.queue(id, followBearer(mechId, route, key, gap, tileFor(opts.dest, id), move, opts.maxMs ?? 180000));
  }
  return [bearer, ...followers];
}

/** Suiveur d'escorte : reste `gap` tuiles derrière le porteur sur la route, puis rejoint sa destination. */
function followBearer(mechId: string, route: readonly TileXY[], key: string, gap: number, dest: TileXY, move: MoveOptions, maxMs: number): BotAction {
  return makeAction(`suivre le porteur de ${mechId}`, () => {
    let final: ActionRunner | null = null;
    return {
      tick(ctx: ActionCtx): ActionStatus {
        const p = escortOf(ctx.run, key, []);
        if (ctx.elapsedMs > maxMs) return ctx.fail(`escorte de ${mechId} non terminée après ${maxMs} ms (porteur en tuile ${p.bearerIdx}/${route.length})`);
        // Mise à jour de l'index de route atteint (tuile de route occupée).
        const here = tileOfPx(ctx.player.pos);
        const onRoute = route.findIndex((t) => sameTile(t, here));
        if (onRoute >= 0) p.followerIdx.set(ctx.id, Math.max(p.followerIdx.get(ctx.id) ?? -1, onRoute));
        if (p.bearerIdx >= route.length) {
          final ??= goTo(dest, { tolerance: 3, label: `pont : destination de J${ctx.id + 1}`, ...move }).create();
          return final.tick(ctx);
        }
        const targetIdx = p.bearerIdx - gap;
        const target: TileXY =
          targetIdx >= 0 ? route[Math.min(targetIdx, route.length - 1)] : nearestReachableTile(ctx.run, ctx.player.pos, route[0]);
        const center = tileCenterPx(target);
        const r = stepToward(ctx, center, 2.5);
        if (r === 'blocked') return ctx.fail(`bloqué sur le pont ${mechId} en allant vers ${target.join(',')}`);
        if (r === 'near') {
          if (targetIdx >= 0) {
            p.followerIdx.set(ctx.id, Math.max(p.followerIdx.get(ctx.id) ?? -1, targetIdx));
          } else {
            // en attente au point d'approche : le porteur n'est pas encore engagé
            p.followerIdx.set(ctx.id, Math.max(p.followerIdx.get(ctx.id) ?? -1, -1));
          }
          if (!ctx.useBackground({ regroup: false })) holdStill(ctx);
        }
        return 'running';
      },
    };
  });
}

/** Nombre de quarts de tour horaires pour passer de `from` à `to` (0..3) : utilitaire pour les scripts de statues et leurs assertions. */
export function quarterTurnsBetween(from: Dir, to: Dir): number {
  const order: Dir[] = ['up', 'right', 'down', 'left'];
  return (order.indexOf(to) - order.indexOf(from) + 4) % 4;
}
