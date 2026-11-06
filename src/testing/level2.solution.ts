/**
 * Script de résolution du niveau 2 (« Le Bosquet Putride ») pour la bibliothèque de bots (`botKit`).
 *
 * Aucune écriture dans `sim.state` : uniquement des `ActionFrame` produites par les actions des bots. Chaque salle est
 * jouée avec la VRAIE stratégie coopérative :
 *  - lisiere  : chaque joueur tient la plaque de sa couleur (simultanément) jusqu'à l'ouverture de la porte de racines ;
 *  - clairiere: chaque joueur va à son levier (ownerSlot), tous attendent d'être en place (« à trois », oralement) puis
 *               actionnent dans la même fenêtre ; ils combattent sur place en attendant ;
 *  - nid      : chacun ramasse SA clé, ouvre SA porte, va tenir SA plaque (toutes ensemble) ;
 *  - murmures : le joueur « lecteur » (visibleToSlot) va lire l'autel (la séquence n'est connue des autres QU'À travers lui :
 *               variable `heard`, équivalent de la description orale), puis les pas de la séquence sont répartis entre tous
 *               et joués dans l'ordre (chaque joueur attend que la progression atteigne son pas) ;
 *  - mare     : traversée groupée, chacun tient la plaque de sa couleur (embuscades) ;
 *  - arene    : tout le monde bat Gorgrim et ses renforts, le propriétaire du cercle tient la zone 8 s, puis sortie.
 */
import type { CharacterId, PlayerId, TileXY } from '../core/types';
import { resolveSlot } from '../core/slots';
import { decideCombat, decideInPlace, decideRevive } from './botBrain';
import {
  BotRun,
  attackUntilClear,
  barrier,
  conds,
  custom,
  goTo,
  pickUpKey,
  pressInteract,
  roomScript,
  runLevelScripts,
  standOn,
  toExit,
  useKey,
  waitUntil,
  type ActionCtx,
  type BotAction,
  type LevelRunOptions,
  type LevelRunResult,
  type RoomScript,
} from './botKit';
import { level2 } from '../levels/level2';

/** Personnages joués (variés : mêlée solide, archère, tank, soigneuse-archère), par nombre de joueurs. */
export const LEVEL2_CHARACTERS: Readonly<Record<number, readonly CharacterId[]>> = {
  1: ['david'],
  2: ['david', 'aelith'],
  3: ['david', 'aelith', 'brokk'],
  4: ['david', 'aelith', 'brokk', 'valentine'],
};

/** Graine fixe par nombre de joueurs (déterminisme). */
export const LEVEL2_SEEDS: Readonly<Record<number, number>> = { 1: 11, 2: 22, 3: 33, 4: 44 };

/** Crée la partie de bots du niveau 2 (difficulté 2 pour tous). */
export function createLevel2Run(playerCount: number, opts: { seed?: number; characters?: readonly CharacterId[] } = {}): BotRun {
  const n = Math.max(1, Math.min(4, playerCount));
  return new BotRun(level2, {
    playerCount: n,
    characters: opts.characters ?? LEVEL2_CHARACTERS[n],
    difficulties: [2, 2, 2, 2],
    seed: opts.seed ?? LEVEL2_SEEDS[n],
  });
}

/** Mesures relevées pendant la partie (lecture seule pour les tests). */
export interface Level2Probe {
  /** Instants (temps de jeu, ms) où chaque levier a été actionné avec succès. */
  leverPressMs: number[];
  /** Instant où le lecteur a lu la séquence (ms), null si pas encore. */
  runesHeardAtMs: number | null;
  /** Joueurs qui ont actionné au moins un piédestal. */
  runePressers: Set<PlayerId>;
}

const probes = new WeakMap<BotRun, Level2Probe>();

/** Mesures de la partie `run` (créées à la demande). */
export function level2Probe(run: BotRun): Level2Probe {
  let p = probes.get(run);
  if (!p) {
    p = { leverPressMs: [], runesHeardAtMs: null, runePressers: new Set() };
    probes.set(run, p);
  }
  return p;
}

// ───────────────────────────── Aides ─────────────────────────────

/** Action « sur place » : combat/relevage sans bouger tant que `cond` n'est pas vraie, puis termine. */
function holdUntil(label: string, cond: (run: BotRun) => boolean, maxMs: number): BotAction {
  return custom(label, () => ({
    tick(ctx) {
      if (cond(ctx.run)) return 'done';
      if (ctx.elapsedMs > maxMs) return ctx.fail(`${label} : condition non satisfaite après ${maxMs} ms`);
      const f = decideInPlace(ctx.bot);
      ctx.set(f ?? {});
      return 'running';
    },
  }));
}

/**
 * Sauvetage « comme un vrai joueur » : si un allié est à terre et que JE suis l'allié debout le plus proche, je vais le
 * relever, en éliminant d'abord les ennemis qui l'entourent. Écrit la frame dans `ctx` et retourne true si j'ai agi.
 */
function rescueStep(ctx: ActionCtx): boolean {
  const r = ctx.run;
  const me = ctx.player;
  for (const t of r.state.players) {
    if (t.status !== 'down') continue;
    let bd = Math.hypot(me.pos.x - t.pos.x, me.pos.y - t.pos.y);
    let mine = true;
    for (const q of r.state.players) {
      if (q.status !== 'alive' || q.id === me.id) continue;
      const dq = Math.hypot(q.pos.x - t.pos.x, q.pos.y - t.pos.y);
      if (dq < bd - 1e-6) {
        mine = false;
        break;
      }
    }
    if (!mine) continue;
    let foe: { id: number; d: number } | null = null;
    for (const e of r.aliveEnemies) {
      const de = Math.hypot(e.pos.x - t.pos.x, e.pos.y - t.pos.y);
      const dm = Math.hypot(e.pos.x - me.pos.x, e.pos.y - me.pos.y);
      if ((de < 70 || dm < 55) && (foe === null || de < foe.d)) foe = { id: e.id, d: de };
    }
    if (foe) {
      const c = decideCombat(ctx.bot, { mode: 'chase', radius: Infinity, forcedTargetId: foe.id });
      if (c) {
        ctx.set(c.frame);
        return true;
      }
    }
    const rv = decideRevive(ctx.bot);
    if (rv) {
      ctx.set(rv);
      return true;
    }
    bd = 0;
  }
  return false;
}

/**
 * Tient une plaque : reste dessus (combat sur place), mais la quitte brièvement pour repousser un ennemi qui menace ou pour
 * relever un allié à terre quand on en est le plus proche (comme des joueurs réels), puis y revient. Termine quand `until`.
 */
function holdPlate(plateId: string, until: (run: BotRun) => boolean, maxMs: number): BotAction {
  return custom(`tenir ${plateId}`, () => ({
    tick(ctx) {
      const r = ctx.run;
      if (until(r)) return 'done';
      if (ctx.elapsedMs > maxMs) return ctx.fail(`${plateId} : porte jamais ouverte après ${maxMs} ms`);
      const def = r.mechDef(plateId);
      if (def.type !== 'plate') return ctx.fail(`${plateId} n'est pas une plaque`);
      const target = { x: (def.tile[0] + 0.5) * 16, y: (def.tile[1] + 0.5) * 16 };
      const me = ctx.player;
      const d = Math.hypot(me.pos.x - target.x, me.pos.y - target.y);
      if (rescueStep(ctx)) return 'running';
      if (d <= 3) {
        const f = decideInPlace(ctx.bot);
        if (f) {
          ctx.set(f);
          return 'running';
        }
      }
      const threat = r.aliveEnemies.some((e) => Math.hypot(e.pos.x - me.pos.x, e.pos.y - me.pos.y) < 48);
      if (threat) {
        const c = decideCombat(ctx.bot, { mode: 'chase', radius: 55 });
        if (c) {
          ctx.set(c.frame);
          return 'running';
        }
      }
      if (d > 2) {
        const res = ctx.bot.follower.follow(ctx.bot, { pos: target, tolerance: 1.5, avoidEnemies: false });
        if (res.status === 'moving') {
          ctx.set({ moveX: res.vec.x, moveY: res.vec.y });
          return 'running';
        }
      } else ctx.bot.follower.idle();
      ctx.set({});
      return 'running';
    },
  }));
}

/** Plaques tenues simultanément (salles 1 et 5) : chaque joueur tient la plaque de sa couleur jusqu'à l'ouverture de `doorId`. */
function platesScript(doorId: string): (run: BotRun) => void {
  return (run) => {
    const holders = new Set<PlayerId>();
    for (const def of run.room.mechanisms) {
      if (def.type !== 'plate' || run.mech(def.id).waived) continue;
      const pid = run.playerFor(def.colorSlot ?? 0);
      holders.add(pid);
      run.queue(
        pid,
        goTo(def.tile, { tolerance: 2, label: `aller à ${def.id}`, maxMs: 120000, fightBudgetMs: 40000 }),
        holdPlate(def.id, conds.mechActive(doorId), 120000),
        ...toExit(),
      );
    }
    for (const b of run.bots) if (!holders.has(b.id)) run.queue(b.id, waitUntil(conds.mechActive(doorId), 120000, { label: doorId }), ...toExit());
  };
}

// ───────────────────────────── Salle 2 : leviers synchronisés ─────────────────────────────

function leversScript(run: BotRun): void {
  const owners = new Map<PlayerId, string>();
  for (const def of run.room.mechanisms) {
    if (def.type !== 'lever' || run.mech(def.id).waived) continue;
    owners.set(run.playerFor(def.ownerSlot ?? 0), def.id);
  }
  const ready = new Set<PlayerId>();
  for (const [pid, leverId] of owners) {
    const tile = run.mechTile(leverId);
    run.queue(
      pid,
      goTo(tile, { tolerance: 3, label: `aller au levier ${leverId}`, maxMs: 120000, fightBudgetMs: 60000 }),
      custom(`synchroniser ${leverId}`, () => {
        return {
          tick(ctx) {
            const r = ctx.run;
            if (r.mechSolved('vine_gate')) return 'done';
            ready.add(pid);
            if (ctx.elapsedMs > 150000) return ctx.fail('leviers jamais synchronisés');
            const everyoneReady = ready.size >= owners.size && [...owners.keys()].every((q) => r.player(q).status === 'alive');
            if (everyoneReady && !r.mechSolved(leverId) && !ctx.player.prev.interact) {
              ctx.set({ interact: true });
              level2Probe(r).leverPressMs.push(r.timeMs);
              return 'running';
            }
            if (rescueStep(ctx)) return 'running';
            const f = decideInPlace(ctx.bot);
            ctx.set(f ?? {});
            return 'running';
          },
        };
      }),
      ...toExit(),
    );
  }
  for (const b of run.bots) if (!owners.has(b.id)) run.queue(b.id, waitUntil(conds.mechActive('vine_gate'), 150000, { label: 'vine_gate' }), ...toExit());
}

// ───────────────────────────── Salle 3 : clés → portes → plaques ─────────────────────────────

function nidScript(run: BotRun): void {
  const used = new Set<PlayerId>();
  for (const def of run.room.mechanisms) {
    if (def.type !== 'key' || run.mech(def.id).waived) continue;
    const color = def.id.slice('key_'.length);
    const pid = run.playerFor(def.ownerSlot);
    used.add(pid);
    const plate = run.mechDef(`plate_${color}`);
    if (plate.type !== 'plate') throw new Error('plaque attendue');
    run.queue(
      pid,
      pickUpKey(def.id, { maxMs: 120000, fightBudgetMs: 40000 }),
      useKey(def.doorId, { maxMs: 120000, fightBudgetMs: 40000 }),
      goTo(plate.tile, { tolerance: 2, maxMs: 120000 }),
      holdPlate(plate.id, conds.mechActive('grille'), 150000),
      ...toExit(),
    );
  }
  for (const b of run.bots) if (!used.has(b.id)) run.queue(b.id, waitUntil(conds.mechActive('grille'), 150000, { label: 'grille' }), ...toExit());
}

// ───────────────────────────── Salle 4 : runes à vision partagée ─────────────────────────────

function runesScript(run: BotRun): void {
  const def = run.mechDef('runes');
  if (def.type !== 'runePuzzle') throw new Error('runes attendues');
  const readerId: PlayerId = resolveSlot(def.visibleToSlot, run.playerCount);
  /** Séquence « décrite à voix haute » : vide tant que le lecteur n'a pas lu l'autel. */
  let heard: string[] | null = null;
  const display: TileXY = [def.displayTile[0], def.displayTile[1]];

  // Le lecteur va à l'autel (là où la séquence est affichée dans SA vue) et la lit.
  run.queue(
    readerId,
    goTo(display, { tolerance: 24, maxMs: 90000, fightBudgetMs: 40000, label: "aller lire l'autel" }),
    custom('lire la séquence', () => ({
      tick(ctx) {
        const d = ctx.run.mechDef('runes');
        if (d.type === 'runePuzzle') heard = [...d.sequence];
        level2Probe(ctx.run).runesHeardAtMs = ctx.run.timeMs;
        return 'done';
      },
    })),
  );
  const steps = def.sequence.length;
  for (const b of run.bots) {
    if (b.id !== readerId) run.queue(b.id, waitUntil(() => heard !== null, 90000, { label: 'attendre la description orale' }));
  }
  // Répartition des pas entre tous les joueurs, dans l'ordre annoncé.
  const actions = new Map<PlayerId, BotAction[]>();
  for (let i = 0; i < steps; i++) {
    const pid = run.bots[i % run.playerCount].id;
    const step = custom(`rune ${i + 1}`, () => {
      let phase = 'go' as 'go' | 'wait' | 'press' | 'check';
      let settle = 0;
      return {
        tick(ctx) {
          const r = ctx.run;
          const st = r.mech('runes');
          if (st.type !== 'runePuzzle') return ctx.fail('runes absentes');
          if (st.active) return 'done';
          const sym = heard ? heard[i] : undefined;
          if (!sym) return ctx.fail('séquence inconnue du joueur (personne ne la lui a décrite)');
          const ped = def.pedestals.find((q) => q.symbol === sym);
          if (!ped) return ctx.fail(`piédestal inconnu ${sym}`);
          if (phase === 'go') {
            const res = ctx.bot.follower.follow(ctx.bot, { pos: { x: (ped.tile[0] + 0.5) * 16, y: (ped.tile[1] + 0.5) * 16 }, tolerance: 3, avoidEnemies: true });
            if (res.status === 'arrived') phase = 'wait';
            else if (res.status === 'moving') {
              const c = decideCombat(ctx.bot, { mode: 'chase', radius: ctx.bot.opts.reactRadius + 8 });
              ctx.set(c ? c.frame : { moveX: res.vec.x, moveY: res.vec.y });
              return 'running';
            } else {
              // 'blocked' / 'unreachable' : on laisse le suivi replanifier (un ennemi ou un allié peut barrer le passage un instant).
              if (ctx.elapsedMs > 150000) return ctx.fail('piédestal inaccessible');
              ctx.set({});
              return 'running';
            }
          }
          if ((phase as string) !== 'go' && Math.hypot(ctx.player.pos.x - (ped.tile[0] + 0.5) * 16, ctx.player.pos.y - (ped.tile[1] + 0.5) * 16) > 8) phase = 'go';
          if (phase === 'wait') {
            if (st.progress < i) {
              if (rescueStep(ctx)) return 'running';
              ctx.set(decideInPlace(ctx.bot) ?? {});
              return 'running';
            }
            if (st.progress > i) return 'done';
            phase = 'press';
          }
          if (phase === 'press') {
            if (ctx.player.prev.interact) {
              ctx.set({});
              return 'running';
            }
            ctx.set({ interact: true });
            level2Probe(r).runePressers.add(ctx.id);
            phase = 'check';
            settle = 0;
            return 'running';
          }
          settle += ctx.dtMs;
          if (st.progress > i || st.active) return 'done';
          if (settle > 400) {
            phase = 'wait';
          }
          ctx.set({});
          return 'running';
        },
      };
    });
    const list = actions.get(pid) ?? [];
    list.push(step);
    actions.set(pid, list);
  }
  for (const [pid, list] of actions) run.queue(pid, ...list);
  for (const b of run.bots) run.queue(b.id, waitUntil(conds.mechActive('seal'), 90000, { label: 'seal' }), ...toExit());
}

// ───────────────────────────── Salle 6 : Gorgrim ─────────────────────────────

function areneScript(run: BotRun): void {
  const circleOwner = run.playerFor(3);
  const zone = run.room.zones?.find((z) => z.id === 'circle');
  if (!zone) throw new Error('zone circle absente');
  const center: TileXY = [zone.rect.x + Math.floor(zone.rect.w / 2), zone.rect.y + Math.floor(zone.rect.h / 2)];
  for (const b of run.bots) {
    const fight = attackUntilClear({ maxMs: 400000, stallMs: 30000 });
    if (b.id === circleOwner) {
      run.queue(
        b.id,
        fight,
        goTo(center, { tolerance: 4, maxMs: 90000 }),
        standOn(center, { until: conds.objectiveDone('hold_circle'), label: 'tenir le cercle', maxMs: 90000 }),
        ...toExit(),
      );
    } else {
      run.queue(b.id, fight, ...toExit());
    }
  }
}

// ───────────────────────────── Scripts du niveau ─────────────────────────────

/** Scripts de salle du niveau 2. */
export function level2Scripts(): RoomScript[] {
  return [
    roomScript('lisiere', platesScript('root_door'), { maxMs: 240000 }),
    roomScript('clairiere', leversScript, { maxMs: 300000 }),
    roomScript('nid', nidScript, { maxMs: 300000 }),
    roomScript('murmures', runesScript, { maxMs: 300000 }),
    roomScript('mare', platesScript('portal'), { maxMs: 300000 }),
    roomScript('arene', areneScript, { maxMs: 400000 }),
  ];
}

/** Joue le niveau 2 de bout en bout avec `playerCount` joueurs. */
export function playLevel2(playerCount: number, opts: { seed?: number; characters?: readonly CharacterId[]; run?: LevelRunOptions } = {}): { run: BotRun; result: LevelRunResult } {
  const run = createLevel2Run(playerCount, opts);
  const result = runLevelScripts(run, level2Scripts(), { maxTotalMs: 1_200_000, maxWipesPerRoom: 4, ...(opts.run ?? {}) });
  return { run, result };
}
