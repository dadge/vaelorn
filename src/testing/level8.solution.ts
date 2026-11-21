/**
 * Solution scriptée du niveau 8 (« Le Bastion des Stratèges »), jouée par les bots de `botKit` sur la VRAIE simulation.
 *
 * Uniquement des `ActionFrame` (via les actions de `botActions.ts` / `novelBots.ts`) : aucune écriture dans `sim.state`. Stratégie
 * COOPÉRATIVE voulue par le niveau :
 *  - parvis     : on vainc les gardes, puis chacun tient SA plaque de couleur (simultanément) ;
 *  - armurerie  : on vainc la garnison, un héros tire le levier central, puis chacun tire SON levier dans la fenêtre ;
 *  - veilleurs  : demi-boss n°1 (gardien à tactique de veille ; spécial des bots activé) ;
 *  - chicane    : on vainc le hall ouest, le héros rouge lit l'écran de runes et les autres frappent les piédestaux dans l'ordre, on vainc
 *                 le hall central, puis RELAIS au sablier (un héros retourne le levier lointain pendant que les autres franchissent la herse) ;
 *  - fosses     : on vainc la salle centrale, un héros se poste sur la plaque (poterne), le héros vert tient le rempart pendant l'embuscade
 *                 (à 1 joueur : après l'embuscade), puis chacun tire SON levier ;
 *  - vigie      : demi-boss n°2 (pyromancien, quatre tactiques ; spécial activé) ;
 *  - cabinet    : on vainc la grande salle, un héros par socle de statue (aller-retour en solo), on vainc la chambre des plans, un héros se
 *                 poste sur la plaque gardée par les archers ;
 *  - conseil    : tous contre le seigneur de la forge (six tactiques ; spécial activé).
 * Règle de prudence des bots (ils n'ont ni radio ni esquive fine) : on nettoie ENSEMBLE avant de se séparer (plaques, leviers, socles) ; les
 * alliés à terre sont relevés (`reviveTeam`) avant de quitter une salle.
 *
 * Particularités des bots de ce niveau :
 *  - dans les salles de demi-boss et de boss (`withSpecial`), ils lancent leur attaque spéciale dès qu'elle est prête et un ennemi à portée
 *    (le spécial DÉSTABILISE un boss tactique : il lâche son plan), reculent devant le télégraphe d'un boss et esquivent les projectiles ;
 *  - les bots par défaut n'ont ni `loot`, ni `gear`, ni appel automatique : les plans « bonus » et « appel » des boss tactiques ne se
 *    déclenchent donc pas dans ces parties (ils sont prouvés séparément : `tacticsFairness.run.test.ts` et la section « boss malins » de `level8.run.test.ts`) ;
 *  - difficulté : 2 (normal, défaut du menu) à 1, 2, 3 et 4 joueurs.
 */
import { PLAYER_RADIUS, REVIVE_RANGE, TILE } from '../core/constants';
import { canOccupy } from '../core/collision';
import { dist } from '../core/geometry';
import { getCharacter } from '../core/characters';
import { isAnyBossKind } from '../core/enemies';
import { tileCenterPx } from '../core/mechanisms';
import type { CharacterId, Difficulty, EnemyState, PlayerId, TileXY, Vec2 } from '../core/types';
import {
  BotRun,
  act,
  attackUntilClear,
  barrier,
  conds,
  crossHourglass,
  custom,
  decideCombat,
  decideRevive,
  flipHourglass,
  goNear,
  goTo,
  hourglassGateOpen,
  hourglassLeverTile,
  holdHourglass,
  nearestReachableTile,
  pressInteract,
  pullLever,
  rotateOtherStatue,
  roomScript,
  runLevelScripts,
  seq,
  standOn,
  toExit,
  unless,
  waitUntil,
  type ActionCtx,
  type ActionRunner,
  type BotAction,
  type BotPlayer,
  type Cond,
  type LevelRunOptions,
  type LevelRunResult,
  type RoomScript,
} from './botKit';
import { level8 } from '../levels/level8';

/** Personnages par nombre de joueurs : variés (mêlée / distance), solides. */
export const LEVEL8_CHARACTERS: Readonly<Record<number, readonly CharacterId[]>> = {
  1: ['david'],
  2: ['david', 'valentine'],
  3: ['david', 'valentine', 'aelith'],
  4: ['david', 'valentine', 'grok', 'aelith'],
};

/** Difficulté (normal, défaut du menu) de tous les bots, solo compris. */
export const LEVEL8_DIFFICULTY: Record<number, Difficulty> = { 1: 2, 2: 2, 3: 2, 4: 2 };

/** Preuve du boss final en SOLO à la difficulté par défaut : personnage et difficulté de `newLevel8SoloBossRun`. */
export const LEVEL8_SOLO_BOSS: { readonly character: CharacterId; readonly difficulty: Difficulty } = { character: 'aelith', difficulty: 2 };

const COLOR = ['Blue', 'Red', 'Green', 'Yellow'] as const;

/** Joueurs qui « existent » pour les mécanismes par slot : le slot k n'existe pour de vrai qu'à k+1 joueurs. */
function slots(run: BotRun): number[] {
  return Array.from({ length: run.playerCount }, (_, i) => i);
}

// ───────────────────────────── Combat : spécial, recul, esquive ─────────────────────────────

/** Portée (px) à laquelle un bot déclenche son attaque spéciale sur un ennemi (zone d'effet moyenne des spéciaux). */
const SPECIAL_RANGE_PX = 62;

/**
 * Spécial « raisonnable » d'un joueur ordinaire dans une salle ordinaire : lancé dès qu'il est prêt et qu'au moins `minNear` ennemis sont à
 * portée de frappe (sans quoi on le garde). Sans effet pour les héros sans spécial.
 */
function crowdSpecial(ctx: ActionCtx, minNear = 2): void {
  const p = ctx.player;
  if (p.status !== 'alive' || p.specialCooldownMs > 0 || ctx.frame.special) return;
  let near = 0;
  for (const e of ctx.run.aliveEnemies) if (dist(e.pos, p.pos) <= SPECIAL_RANGE_PX) near++;
  if (near >= minNear) ctx.frame.special = true;
}

/**
 * Vecteur de recul (norme 1) devant le télégraphe d'un boss / demi-boss en `windup` : le héros qui se trouve dans (ou tout près de) la zone
 * annoncée s'en éloigne en ligne droite (jamais dans un mur). Null si aucun télégraphe ne le menace.
 */
function telegraphRetreat(run: BotRun, bot: BotPlayer): Vec2 | null {
  const p = bot.player;
  if (p.status !== 'alive') return null;
  for (const e of run.aliveEnemies as readonly EnemyState[]) {
    if (!isAnyBossKind(e.kind) || e.mode !== 'windup') continue;
    const radius = e.data.telegraphRadius ?? 0;
    if (!(radius > 0)) continue;
    const dd = e.data.telegraphDist ?? 0;
    const a = e.data.aimAngle ?? 0;
    const cx = e.pos.x + Math.cos(a) * dd;
    const cy = e.pos.y + Math.sin(a) * dd;
    if (Math.hypot(p.pos.x - cx, p.pos.y - cy) > radius + 26) continue;
    let ax = p.pos.x - e.pos.x;
    let ay = p.pos.y - e.pos.y;
    const len = Math.hypot(ax, ay);
    if (len < 1e-6) {
      ax = 1;
      ay = 0;
    } else {
      ax /= len;
      ay /= len;
    }
    for (const turn of [0, 0.6, -0.6, 1.2, -1.2, 1.9, -1.9]) {
      const c = Math.cos(turn);
      const sn = Math.sin(turn);
      const vx = ax * c - ay * sn;
      const vy = ax * sn + ay * c;
      if (canOccupy({ x: p.pos.x + vx * 10, y: p.pos.y + vy * 10 }, PLAYER_RADIUS, run.sim.grid, run.solids)) return { x: vx, y: vy };
    }
  }
  return null;
}

const DODGE_DIRS: readonly Vec2[] = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: -1 },
  { x: 0.707, y: 0.707 },
  { x: -0.707, y: 0.707 },
  { x: 0.707, y: -0.707 },
  { x: -0.707, y: -0.707 },
];

/**
 * Esquive de projectiles ennemis (boules de feu, éclats) : compare le mouvement voulu par l'action et quelques mouvements de remplacement
 * sur les 0,7 s à venir (projectiles supposés en ligne droite) et garde le moins touché ; ne remplace le mouvement voulu que s'il mène à un
 * impact. Réservé aux salles de demi-boss et de boss.
 */
function dodgeProjectiles(ctx: ActionCtx): void {
  const p = ctx.player;
  const near = ctx.run.sim.state.room.projectiles.filter((pr) => pr.owner.type === 'enemy' && dist(pr.pos, p.pos) < 140);
  if (near.length === 0) return;
  const speed = getCharacter(p.characterId).speed;
  const solids = ctx.run.solids;
  const grid = ctx.run.sim.grid;
  const penalty = (dir: Vec2): number => {
    let pen = 0;
    for (let t = 0.1; t <= 0.7 + 1e-9; t += 0.1) {
      const pos = { x: p.pos.x + dir.x * speed * t, y: p.pos.y + dir.y * speed * t };
      if ((dir.x !== 0 || dir.y !== 0) && !canOccupy(pos, PLAYER_RADIUS, grid, solids)) {
        pen += 3;
        break;
      }
      for (const pr of near) {
        if (t * 1000 > pr.lifeMs) continue;
        const q = { x: pr.pos.x + pr.vel.x * t, y: pr.pos.y + pr.vel.y * t };
        if (dist(pos, q) < PLAYER_RADIUS + pr.radius + 2) pen += 2 - t;
      }
    }
    return pen;
  };
  const f = ctx.frame;
  const wantLen = Math.hypot(f.moveX, f.moveY);
  const want: Vec2 = wantLen > 0.01 ? { x: f.moveX / wantLen, y: f.moveY / wantLen } : { x: 0, y: 0 };
  const base = penalty(want);
  if (base <= 0) return;
  let best = want;
  let bp = base;
  for (const d of DODGE_DIRS) {
    const pen = penalty(d) + 0.05;
    if (pen < bp) {
      bp = pen;
      best = d;
    }
  }
  if (best !== want) {
    f.moveX = best.x;
    f.moveY = best.y;
  }
}

/**
 * Ajoute à une action de combat les gestes d'un joueur ordinaire contre un (demi-)boss : le SPÉCIAL du personnage dès qu'il est prêt et
 * qu'un ennemi est à portée (il déstabilise un boss tactique), le recul devant un télégraphe, l'esquive de projectiles. Réservé aux
 * salles de demi-boss et de boss.
 */
function withSpecial(action: BotAction): BotAction {
  return custom(`${action.label}+spécial`, () => {
    const inner = action.create();
    return {
      tick(ctx) {
        const st = inner.tick(ctx);
        if (st !== 'running') return st;
        const p = ctx.player;
        if (p.specialCooldownMs <= 0 && ctx.run.aliveEnemies.some((e) => dist(e.pos, p.pos) <= SPECIAL_RANGE_PX)) ctx.frame.special = true;
        const retreat = telegraphRetreat(ctx.run, ctx.bot);
        if (retreat) {
          ctx.frame.moveX = retreat.x;
          ctx.frame.moveY = retreat.y;
          ctx.frame.attack = false;
          ctx.frame.interact = false;
          ctx.frame.revive = false;
        } else {
          dodgeProjectiles(ctx);
        }
        return st;
      },
    };
  });
}

/**
 * Débloque un bot qui reste immobile à côté d'un ennemi (cas d'angle : ennemi en diagonale d'un pilier) : il s'avance droit sur lui en
 * frappant. Sans effet tant que l'action produit déjà un mouvement ou une attaque.
 */
function unstick(ctx: ActionCtx): void {
  const f = ctx.frame;
  if (f.moveX !== 0 || f.moveY !== 0 || f.attack || f.interact || f.revive) return;
  const p = ctx.player;
  let target: EnemyState | null = null;
  let best = 40;
  for (const e of ctx.run.aliveEnemies) {
    const d = dist(e.pos, p.pos);
    if (d < best) {
      best = d;
      target = e;
    }
  }
  if (!target || best < 1) return;
  f.moveX = (target.pos.x - p.pos.x) / best;
  f.moveY = (target.pos.y - p.pos.y) / best;
  f.attack = true;
}

/**
 * Combat jusqu'à ce que toutes les apparitions de la salle soient vaincues (exigence `clear` : ennemis vivants ET apparitions en attente) ;
 * une fois la salle vide, on relève les alliés à terre (`reviveTeam`).
 */
function clearAll(maxMs = 240000): BotAction {
  return custom('clearAll', () => {
    let inner = attackUntilClear({ maxMs, stallMs: 20000 }).create();
    let rescue: ActionRunner | null = null;
    return {
      tick(ctx) {
        if (ctx.run.requirementMet('clear')) {
          rescue ??= reviveTeam().create();
          return rescue.tick(ctx);
        }
        rescue = null;
        if (ctx.elapsedMs > maxMs) return ctx.fail(`salle non nettoyée après ${maxMs} ms : ${ctx.run.describeEnemies(ctx.run.aliveEnemies)}`);
        const st = inner.tick(ctx);
        if (st === 'failed') return 'failed';
        if (st === 'done') {
          inner = attackUntilClear({ maxMs, stallMs: 20000 }).create();
          if (!ctx.consumed && !ctx.useBackground({ regroup: false })) ctx.set({});
        }
        unstick(ctx);
        crowdSpecial(ctx);
        return 'running';
      },
    };
  });
}

/**
 * Nettoie une ZONE de la salle (prédicat sur les coordonnées de tuile) : ennemis vivants dans la zone ET apparitions en attente dont la
 * tuile est dans la zone. Les ennemis hors zone (ex. derrière une porte fermée) sont ignorés. Termine quand la zone est vide (alliés relevés).
 */
function clearArea(inArea: (tx: number, ty: number) => boolean, label: string, maxMs = 240000): BotAction {
  return custom(`clearArea(${label})`, () => {
    let stallMs = 0;
    let rescue: ActionRunner | null = null;
    return {
      tick(ctx) {
        const run = ctx.run;
        const alive = run.aliveEnemies.filter((e) => inArea(Math.floor(e.pos.x / TILE), Math.floor(e.pos.y / TILE)));
        const spawned = run.state.room.spawnedSpawnIdx;
        const pending = run.room.enemies.some((d, i) => (d.minPlayers ?? 1) <= run.playerCount && !spawned.includes(i) && inArea(d.tile[0], d.tile[1]) && !d.when);
        if (alive.length === 0 && !pending) {
          rescue ??= reviveTeam().create();
          return rescue.tick(ctx);
        }
        rescue = null;
        if (ctx.elapsedMs > maxMs) return ctx.fail(`zone ${label} non nettoyée après ${maxMs} ms : ${run.describeEnemies(alive)}`);
        if (ctx.player.revivingId !== null) {
          const r = decideRevive(ctx.bot);
          if (r) {
            ctx.set(r);
            return 'running';
          }
        }
        const sorted = alive
          .slice()
          .sort(
            (a, b) =>
              Math.hypot(a.pos.x - ctx.player.pos.x, a.pos.y - ctx.player.pos.y) - Math.hypot(b.pos.x - ctx.player.pos.x, b.pos.y - ctx.player.pos.y) ||
              a.id - b.id,
          );
        for (const e of sorted.slice(0, 4)) {
          const c = decideCombat(ctx.bot, { mode: 'chase', radius: Infinity, forcedTargetId: e.id });
          if (c) {
            stallMs = 0;
            ctx.set(c.frame);
            unstick(ctx);
            crowdSpecial(ctx);
            return 'running';
          }
        }
        const r = decideRevive(ctx.bot);
        if (r) {
          stallMs = 0;
          ctx.set(r);
          return 'running';
        }
        if (alive.length === 0) {
          // seules des apparitions en attente (plafond d'ennemis vivants) : laisser faire le fond
          if (!ctx.useBackground({ regroup: false })) ctx.set({});
          return 'running';
        }
        stallMs += ctx.dtMs;
        if (stallMs >= 20000) return ctx.fail(`aucun ennemi accessible dans ${label} depuis 20000 ms : ${run.describeEnemies(alive)}`);
        ctx.set({});
        return 'running';
      },
    };
  });
}

/**
 * Relève les alliés à terre : termine quand tous les joueurs sont debout (le joueur courant rejoint le premier allié à terre et maintient
 * le relevage). À placer avant de quitter une zone : on ne laisse personne derrière.
 */
function reviveTeam(): BotAction {
  return custom('reviveTeam', () => {
    let waited = 0;
    return {
      tick(ctx) {
        const down = ctx.run.sim.state.players.find((q) => q.status === 'down' && q.id !== ctx.id);
        if (!down) return 'done';
        const d = dist(ctx.player.pos, down.pos);
        if (d <= REVIVE_RANGE - 3) {
          ctx.bot.follower.idle();
          ctx.set({ revive: true });
          return 'running';
        }
        const r = ctx.bot.follower.follow(ctx.bot, { pos: down.pos, tolerance: 1, near: REVIVE_RANGE - 6, avoidEnemies: false });
        if (r.status === 'moving') ctx.set({ moveX: r.vec.x, moveY: r.vec.y });
        else ctx.set({ revive: r.status === 'arrived' });
        waited += ctx.dtMs;
        return waited > 120000 ? ctx.fail(`allié J${down.id + 1} jamais relevé`) : 'running';
      },
    };
  });
}

/**
 * SAUVETEUR : tant qu'un allié est à terre, le joueur vivant le PLUS PROCHE de lui (égalité : le plus petit id) court le relever et maintient
 * le relevage quoi que fassent les ennemis alentour (un joueur ordinaire le ferait, derrière un pilier ou sous la menace) ; les autres
 * continuent leur action (frapper le boss : c'est ce qui le déstabilise et libère la veille). Sans allié à terre, l'action est inchangée.
 * Utilisé dans les salles à boss tactique, où le relevage est le contre-jeu à tester.
 */
function withRescue(action: BotAction): BotAction {
  return custom(`${action.label}+sauveteur`, () => {
    const inner = action.create();
    let rescue: ActionRunner | null = null;
    return {
      tick(ctx) {
        const run = ctx.run;
        const me = ctx.player;
        if (me.status === 'alive') {
          const down = run.state.players.filter((q) => q.status === 'down');
          if (down.length > 0) {
            const target = down.reduce((a, b) => (dist(a.pos, me.pos) <= dist(b.pos, me.pos) ? a : b));
            const alive = run.state.players.filter((q) => q.status === 'alive');
            const closest = alive.reduce((a, b) => {
              const da = dist(a.pos, target.pos);
              const db = dist(b.pos, target.pos);
              return da < db || (da === db && a.id < b.id) ? a : b;
            });
            if (closest.id === ctx.id) {
              rescue ??= reviveTeam().create();
              const st = rescue.tick(ctx);
              if (st === 'running') return 'running';
              rescue = null;
            } else {
              rescue = null;
            }
          } else {
            rescue = null;
          }
        }
        return inner.tick(ctx);
      },
    };
  });
}

/**
 * Tient une tuile (plaque, zone) jusqu'à `until`, mais quitte son poste pour relever un allié à terre quand c'est possible ; il retourne
 * ensuite sur la tuile (sans quoi un tenant seul debout laisserait ses alliés à terre indéfiniment).
 */
function holdWithRevive(tile: TileXY, until: Cond, maxMs: number): BotAction {
  return custom(`holdWithRevive(${tile.join(',')})`, () => {
    const stand = standOn(tile, { until, maxMs, fightBudgetMs: 60000 }).create();
    return {
      tick(ctx) {
        if (until(ctx.run)) return 'done';
        if (ctx.run.state.players.some((p) => p.status === 'down')) {
          const r = decideRevive(ctx.bot);
          if (r) {
            ctx.set(r);
            return 'running';
          }
        }
        return stand.tick(ctx);
      },
    };
  });
}

/** Attend que toutes les exigences de sortie de la salle soient remplies, puis va à la sortie. */
function exitWhenReady(): BotAction[] {
  return [
    reviveTeam(),
    waitUntil((run) => run.room.exit.requires.every((r) => run.requirementMet(r)), 240000, { label: 'exigences de sortie' }),
    ...toExit(),
  ];
}

/** Va à un point d'une zone d'embuscade (tolérance large : il suffit d'y entrer). */
function enterZone(tile: TileXY): BotAction {
  return goTo(tile, { tolerance: 14, label: `entrer dans la zone ${tile.join(',')}` });
}

// ───────────────────────────── Relais au sablier (copie du niveau 5, jamais bloquant) ─────────────────────────────

/** Héros déjà passés de l'autre côté d'une herse, par partie et par relais (mémoire des bots, rien dans `GameState`). */
const crossedStores = new WeakMap<BotRun, Map<string, Set<PlayerId>>>();

function crossedSet(run: BotRun, key: string): Set<PlayerId> {
  let m = crossedStores.get(run);
  if (!m) {
    m = new Map();
    crossedStores.set(run, m);
  }
  let set = m.get(key);
  if (!set) {
    set = new Set();
    m.set(key, set);
  }
  return set;
}

/** Index du levier du sablier situé du MÊME côté de la herse (verticale) que le joueur. */
function leverOnMySide(run: BotRun, mechId: string, bot: BotPlayer): number {
  const def = run.mechDef(mechId);
  if (def.type !== 'hourglass') throw new Error(`${mechId} n'est pas un sablier`);
  const gx = def.gate[0][0];
  const west = bot.player.pos.x / TILE < gx;
  const i = def.levers.findIndex((t) => t[0] < gx === west);
  return i < 0 ? 0 : i;
}

/**
 * Franchit la herse `mechId` vers `dest`. Si personne ne retourne le sablier (le tenant est à terre ou en retard), le héros qui attend
 * retourne lui-même le levier de SON côté après `waitMs` : jamais d'attente sans fin.
 */
function crossAnyway(mechId: string, dest: TileXY, waitMs = 40000): BotAction {
  return custom(`traverser ${mechId}`, () => {
    let inner: ActionRunner | null = null;
    return {
      tick(ctx) {
        if (!inner) {
          inner = seq(
            `traverser ${mechId}`,
            goTo(
              (r, bot) => {
                const def = r.mechDef(mechId);
                if (def.type !== 'hourglass') throw new Error('sablier attendu');
                const g = def.gate[Math.floor(def.gate.length / 2)];
                return nearestReachableTile(r, bot.player.pos, g);
              },
              { tolerance: 4, label: `approche de la herse ${mechId}` },
            ),
            waitUntil((r) => hourglassGateOpen(r, mechId), waitMs, { failOnTimeout: false, label: `herse ${mechId} ouverte` }),
            unless((r) => hourglassGateOpen(r, mechId), flipHourglass(mechId, { leverIndex: leverOnMySide(ctx.run, mechId, ctx.bot) })),
            crossHourglass(mechId, dest),
          ).create();
        }
        return inner.tick(ctx);
      },
    };
  });
}

/**
 * Après le franchissement : si des ennemis restent coincés du côté de départ, va tenir le levier voisin de la herse pour la rouvrir et les
 * laisser passer, jusqu'à ce qu'il n'en reste plus (au plus `maxMs`). Sans effet s'il n'y a personne de ce côté.
 */
function purgeBehindGate(mechId: string, maxMs = 30000): BotAction {
  return custom(`vider l'autre côté de ${mechId}`, () => {
    let inner: ActionRunner | null = null;
    let startMs = -1;
    return {
      tick(ctx) {
        const def = ctx.run.mechDef(mechId);
        if (def.type !== 'hourglass') throw new Error(`${mechId} n'est pas un sablier`);
        const gx = def.gate[0][0];
        const stuck = (r: BotRun): boolean => r.aliveEnemies.some((e) => e.pos.x / TILE < gx);
        if (!stuck(ctx.run)) return 'done';
        if (startMs < 0) startMs = ctx.run.timeMs;
        if (!inner) {
          inner = holdHourglass(mechId, {
            leverIndex: 1,
            until: (r) => !stuck(r) || r.timeMs - startMs > maxMs,
            maxMs: maxMs + 30000,
          }).create();
        }
        return inner.tick(ctx);
      },
    };
  });
}

/** Le héros `id` est-il posté devant la herse `mechId` (à moins de 6 tuiles de son centre) ? */
function postedAtGate(run: BotRun, mechId: string, id: PlayerId): boolean {
  const def = run.mechDef(mechId);
  if (def.type !== 'hourglass') throw new Error(`${mechId} n'est pas un sablier`);
  const c = tileCenterPx(def.gate[Math.floor(def.gate.length / 2)]);
  const p = run.player(id);
  return Math.hypot(p.pos.x - c.x, p.pos.y - c.y) <= 6 * TILE;
}

/**
 * Franchissement coopératif d'une herse de sablier, 1..4 joueurs :
 *  - SOLO : retourner le levier lointain, puis courir à la herse (la période est doublée en solo) ;
 *  - 2+ joueurs : les AUTRES se postent devant la herse ; le TENANT (joueur 0) va au levier lointain, attend que tous soient postés, le
 *    retourne puis court vers la herse (il arrive trop tard : elle est refermée) ; les autres passent pendant le sable ; chaque héros passé
 *    tient ensuite le levier voisin de la herse, de l'autre côté, jusqu'à ce que tous soient passés (le tenant compris).
 */
function relay(run: BotRun, mechId: string, dest: (id: PlayerId) => TileXY, lastMs = 150000): void {
  const ids = run.bots.map((b) => b.id);
  if (ids.length === 1) {
    run.queue(ids[0], flipHourglass(mechId, { leverIndex: 0 }), crossHourglass(mechId, dest(ids[0])), purgeBehindGate(mechId));
    return;
  }
  const key = `relay:${mechId}:${run.roomEnterCount}`;
  const holder = ids[0];
  const others = ids.slice(1);
  const mark = (id: PlayerId): BotAction => act((r) => void crossedSet(r, key).add(id), `passé ${mechId}`);
  const settled = (r: BotRun, list: readonly PlayerId[]): boolean => list.every((id) => crossedSet(r, key).has(id) || r.player(id).status !== 'alive');
  const othersPosted = (r: BotRun): boolean => others.every((id) => postedAtGate(r, mechId, id) || crossedSet(r, key).has(id) || r.player(id).status !== 'alive');
  for (const id of others) {
    const rest = ids.filter((x) => x !== id);
    run.queue(id, crossAnyway(mechId, dest(id)), mark(id), holdHourglass(mechId, { leverIndex: 1, until: (r) => settled(r, rest), maxMs: lastMs }));
    run.queue(id, purgeBehindGate(mechId));
  }
  run.queue(
    holder,
    goTo((r) => hourglassLeverTile(r, mechId, 0), { tolerance: 10, label: `levier lointain de ${mechId}` }),
    waitUntil(othersPosted, 90000, { failOnTimeout: false, label: 'les autres sont postés devant la herse' }),
    flipHourglass(mechId, { leverIndex: 0 }),
    crossAnyway(mechId, dest(holder)),
    mark(holder),
    purgeBehindGate(mechId),
  );
}

// ───────────────────────────── Salles ─────────────────────────────

const parvisScript = roomScript(
  'parvis',
  (run) => {
    run.queueEach(() => clearAll(300000));
    for (const s of slots(run)) {
      const plate = run.mechTile(`parvisPlate${COLOR[s]}`);
      run.queueForSlot(s, goTo(plate), standOn(plate, { until: conds.mechActive('parvisDoor') }));
    }
    run.queueEach(() => exitWhenReady());
  },
  { maxMs: 360000 },
);

const armurerieScript = roomScript(
  'armurerie',
  (run, info) => {
    run.queueEach(() => clearAll(300000));
    // un héros tire le levier central (verrouillant), puis chacun tire SON levier dans la fenêtre
    run.queue(run.playerFor(0), goNear((r) => r.mechTile('armoryLeverBase'), { radius: 12 }), pullLever('armoryLeverBase'));
    for (const s of slots(run)) {
      const lever = `armoryLever${COLOR[s]}`;
      run.queueForSlot(s, goNear((r) => r.mechTile(lever), { radius: 12 }), barrier(`armory:${info.attempt}`, run.playerCount, 180000), pullLever(lever));
    }
    run.queueEach(() => exitWhenReady());
  },
  { maxMs: 360000 },
);

const veilleursScript = roomScript(
  'veilleurs',
  (run) => {
    run.queueEach(() => [withSpecial(withRescue(clearAll(420000))), ...exitWhenReady()]);
  },
  { maxMs: 480000 },
);

const chicaneScript = roomScript(
  'chicane',
  (run) => {
    const def = run.mechDef('chicaneRunes');
    if (def.type !== 'runePuzzle') throw new Error('chicaneRunes attendu');
    const seer: PlayerId = run.playerFor(def.visibleToSlot);
    let read = false;
    // 1. hall ouest vidé ensemble
    run.queueEach(() => clearArea((tx) => tx < 35, 'hall ouest'));
    // 2. le voyant lit l'écran ; les autres (ou lui seul en solo) frappent les piédestaux dans l'ordre annoncé
    run.queue(
      seer,
      goTo(def.displayTile, { label: "goTo(écran des runes)" }),
      act(() => {
        read = true;
      }, 'lecture de la séquence'),
    );
    const actuators: PlayerId[] = run.playerCount === 1 ? [seer] : run.bots.map((b) => b.id).filter((id) => id !== seer);
    const stepsByPlayer = new Map<PlayerId, number[]>();
    def.sequence.forEach((_, i) => {
      const who = actuators[i % actuators.length];
      stepsByPlayer.set(who, [...(stepsByPlayer.get(who) ?? []), i]);
    });
    for (const who of actuators) {
      const steps = stepsByPlayer.get(who) ?? [];
      if (steps.length === 0) continue;
      const firstPed = def.pedestals.find((q) => q.symbol === def.sequence[steps[0]]);
      if (firstPed) run.queue(who, standOn(firstPed.tile, { tolerance: 3, until: () => read, label: 'attendre la lecture' }));
      for (const i of steps) {
        const ped = def.pedestals.find((q) => q.symbol === def.sequence[i]);
        if (!ped) throw new Error(`piédestal ${def.sequence[i]} introuvable`);
        run.queue(
          who,
          standOn(ped.tile, {
            tolerance: 3,
            until: (r) => {
              const st = r.mech('chicaneRunes');
              return st.type === 'runePuzzle' && (st.active || st.progress >= i);
            },
            maxMs: 120000,
            label: `rune ${i} : à son poste`,
          }),
          pressInteract({
            expect: (r) => {
              const st = r.mech('chicaneRunes');
              return st.type === 'runePuzzle' && (st.active || st.progress >= i + 1);
            },
            settleMs: 250,
            retries: 0,
            label: `rune ${def.sequence[i]}`,
          }),
        );
      }
    }
    // 3. porte ouverte : le hall central est vidé ensemble
    run.queueEach(() => [waitUntil(conds.mechActive('chicaneRuneDoor'), 180000, { label: 'porte des runes' }), clearAll(300000)]);
    // 4. relais au sablier, puis sortie
    relay(run, 'chicaneHourglass', (id) => [70 + (id % 4), 16 + 3 * id] as TileXY);
    run.queueEach(() => exitWhenReady());
  },
  { maxMs: 480000 },
);

const fossesScript = roomScript(
  'fosses',
  (run, info) => {
    const rampart: TileXY = [62, 21];
    const holder = run.playerFor(2);
    // 1. salle centrale vidée ensemble (tout ce qui est à l'ouest de la poterne)
    run.queueEach(() => clearArea((tx) => tx <= 49, 'salle centrale'));
    // 2. un héros se poste sur la plaque (la poterne reste ouverte ensuite) ; les autres attendent
    const plateMan = run.playerFor(0);
    for (const b of run.bots) {
      if (b.id === plateMan) {
        const plate = run.mechTile('fossesPlate');
        run.queue(b.id, goTo(plate), standOn(plate, { until: conds.mechActive('fossesWicket'), maxMs: 120000 }));
      }
      run.queue(b.id, waitUntil(conds.mechActive('fossesWicket'), 180000, { label: 'poterne ouverte' }));
    }
    // 3. rempart : l'embuscade surgit ; le héros vert tient la zone pendant le combat (à 1 joueur : on se bat d'abord)
    for (const b of run.bots) {
      run.queue(b.id, enterZone([56, 21]));
      if (b.id === holder && run.playerCount > 1) {
        run.queue(b.id, goTo(rampart), holdWithRevive(rampart, conds.objectiveDone('rampart'), 240000));
      }
      run.queue(b.id, clearAll(300000));
      if (b.id === holder && run.playerCount === 1) {
        run.queue(b.id, goTo(rampart), holdWithRevive(rampart, conds.objectiveDone('rampart'), 240000));
      }
    }
    // 4. chacun tire SON levier dans la fenêtre
    for (const s of slots(run)) {
      const lever = `fossesLever${COLOR[s]}`;
      run.queueForSlot(s, goNear((r) => r.mechTile(lever), { radius: 12 }), barrier(`fosses:${info.attempt}`, run.playerCount, 180000), pullLever(lever));
    }
    run.queueEach(() => exitWhenReady());
  },
  { maxMs: 480000 },
);

const vigieScript = roomScript(
  'vigie',
  (run) => {
    run.queueEach(() => [withSpecial(withRescue(clearAll(420000))), ...exitWhenReady()]);
  },
  { maxMs: 480000 },
);

const cabinetScript = roomScript(
  'cabinet',
  (run) => {
    // 1. grande salle vidée ensemble (tout ce qui est avant la porte des statues)
    run.queueEach(() => clearArea((tx) => tx <= 49, 'grande salle'));
    // 2. un héros par socle (aller-retour en solo) : A tourne la statue 1, B tourne la statue 0
    const a: PlayerId = 0;
    const b = (1 % run.playerCount) as PlayerId;
    run.queue(a, rotateOtherStatue('cabinetStatues', 0, { maxMs: 90000 }));
    run.queue(b, rotateOtherStatue('cabinetStatues', 1, { maxMs: 90000 }));
    // 3. chambre des plans : on la vide ensemble (les archers gardent la plaque), puis un héros se poste sur la plaque
    run.queueEach(() => [waitUntil(conds.mechActive('cabinetDoor'), 180000, { label: 'porte des statues' }), clearAll(300000)]);
    const plateMan = run.playerFor(0);
    for (const bot of run.bots) {
      if (bot.id === plateMan) {
        const plate = run.mechTile('cabinetPlate');
        run.queue(bot.id, goTo(plate), standOn(plate, { until: conds.mechActive('cabinetGate'), maxMs: 120000 }));
      }
      run.queue(bot.id, ...exitWhenReady());
    }
  },
  { maxMs: 480000 },
);

const conseilScript = roomScript(
  'conseil',
  (run) => {
    run.queueEach(() => [withSpecial(withRescue(clearAll(480000))), ...exitWhenReady()]);
  },
  { maxMs: 540000 },
);

/** Scripts du niveau 8, dans l'ordre des salles. */
export function level8Scripts(): RoomScript[] {
  return [parvisScript, armurerieScript, veilleursScript, chicaneScript, fossesScript, vigieScript, cabinetScript, conseilScript];
}

/** Options de partie pour n joueurs (difficulté 2, graine fixe). */
export function level8RunOptions(n: number, seed = 7) {
  return {
    playerCount: n,
    characters: LEVEL8_CHARACTERS[n],
    difficulties: Array.from({ length: n }, () => LEVEL8_DIFFICULTY[n] ?? 2),
    seed,
  };
}

/** Nouvelle partie de bots sur le niveau 8. */
export function newLevel8Run(n: number, opts: { seed?: number; startRoomIndex?: number } = {}): BotRun {
  return new BotRun(level8, { ...level8RunOptions(n, opts.seed ?? 7), startRoomIndex: opts.startRoomIndex });
}

/** Partie SOLO sur la seule salle du boss final, à la difficulté et avec le personnage donnés (défaut : `LEVEL8_SOLO_BOSS`). */
export function newLevel8SoloBossRun(opts: { seed?: number; character?: CharacterId; difficulty?: Difficulty } = {}): BotRun {
  return new BotRun(level8, {
    playerCount: 1,
    characters: [opts.character ?? LEVEL8_SOLO_BOSS.character],
    difficulties: [opts.difficulty ?? LEVEL8_SOLO_BOSS.difficulty],
    seed: opts.seed ?? 7,
    startRoomIndex: level8.rooms.length - 1,
  });
}

/** Joue le niveau 8 de bout en bout pour n joueurs. */
export function solveLevel8(
  n: number,
  opts: { seed?: number; startRoomIndex?: number; level?: LevelRunOptions } = {},
): { run: BotRun; result: LevelRunResult } {
  const run = newLevel8Run(n, opts);
  const result = runLevelScripts(run, level8Scripts(), { maxTotalMs: 20 * 60 * 1000, maxRoomMs: 240000, maxWipesPerRoom: 4, ...(opts.level ?? {}) });
  return { run, result };
}
