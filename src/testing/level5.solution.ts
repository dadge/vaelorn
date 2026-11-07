/**
 * Solution scriptée du niveau 5 (« Les Forges Ardentes »), jouée par les bots de `botKit` sur la VRAIE simulation.
 *
 * Uniquement des `ActionFrame` (via les actions de `botActions.ts` / `novelBots.ts`) : aucune écriture dans `sim.state`.
 * Stratégie COOPÉRATIVE voulue par le niveau (`relay` = franchissement d'une herse : tous les autres se postent devant la herse ;
 * le tenant, joueur 0, retourne le levier LOINTAIN (≈ 25 tuiles) et ne peut pas rejoindre la herse avant sa fermeture ; les autres
 * passent pendant le sable ; le relais, joueur 1, court au levier voisin de la herse, de l'autre côté, et le retourne pour que le
 * tenant passe à son tour) :
 *  - ashgate    : relais au sablier, puis combat ;
 *  - slagworks  : relais au sablier, puis nettoyage de la fonderie ;
 *  - crucible   : relais à la herse A ; le héros du slot 1 tient le creuset 8 s pendant que tous nettoient la chambre B ; relais à la
 *                 herse B ; nettoyage de la chambre C ;
 *  - pyre       : le hall est nettoyé ensemble, puis chacun SA plaque (simultanément) → porte ; antichambre ; relais au sablier ; combat ;
 *  - cinderpit  : tous contre le pyromancien et ses sbires (arène pure) ;
 *  - blindforge : relais au sablier ; la forge est nettoyée ensemble ; chacun recharge si besoin sa torche puis allume SON brasero ;
 *  - bellows    : relais au sablier ; nettoyage du hall et des galeries ; le bloc est poussé à deux (seul à 1 joueur) ; salle de sortie ;
 *  - emberhold  : le grand hall est nettoyé ensemble ; chacun SA clé puis SA porte ; combat contre le pyromancien ;
 *  - forgeheart : tous contre le Seigneur de la Forge.
 * Règle de prudence des bots (ils n'ont ni radio ni esquive fine) : on nettoie ENSEMBLE avant de se séparer (plaques, braseros, clés)
 * et avant de franchir une herse : un héros isolé parmi les gardiens tomberait sans secours. Le relais ne se bloque jamais : un héros
 * à terre n'est pas attendu, et un héros qui attend devant une herse sans tenant retourne lui-même le levier de son côté.
 *
 * Les bots n'ont pas d'esquive intelligente de boss dans `botKit` (leur esquive ignore les boss). `enableBotTactics` leur ajoute,
 * sans toucher ni au moteur ni à `botKit.ts`, deux gestes de joueur ordinaire :
 *  - le SPÉCIAL du personnage (champ `special` d'un `ActionFrame`, comme à la manette) quand un demi-boss / boss est à portée, ou
 *    quand au moins trois ennemis le sont ;
 *  - le RECUL devant un télégraphe de boss : un boss en `windup` annonce sa zone (`data.telegraphRadius` autour du point situé à
 *    `data.telegraphDist` dans la direction `data.aimAngle`) ; le héros qui s'y trouve s'en éloigne au lieu de frapper.
 */
import { PLAYER_RADIUS, TILE } from '../core/constants';
import { tileCenterPx } from '../core/mechanisms';
import { canOccupy } from '../core/collision';
import { getCharacter } from '../core/characters';
import { isAnyBossKind } from '../core/enemies';
import type { ActionFrame, CharacterId, Difficulty, EnemyState, PlayerId, TileXY } from '../core/types';
import {
  BotRun,
  attackUntilClear,
  act,
  barrier,
  conds,
  crossHourglass,
  custom,
  flipHourglass,
  decideCombat,
  decideRevive,
  goNear,
  goTo,
  hourglassGateOpen,
  holdHourglass,
  hourglassLeverTile,
  nearestReachableTile,
  pickUpKey,
  pressInteract,
  pushBlock,
  pushersNeeded,
  roomScript,
  runLevelScripts,
  seq,
  standOn,
  toExit,
  unless,
  useKey,
  waitUntil,
  type ActionRunner,
  type BotAction,
  type BotPlayer,
  type LevelRunOptions,
  type LevelRunResult,
  type RoomScript,
} from './botKit';
import { level5 } from '../levels/level5';

/** Personnages par nombre de joueurs : variés (mêlée / distance), solides. */
export const LEVEL5_CHARACTERS: Readonly<Record<number, readonly CharacterId[]>> = {
  1: ['david'],
  2: ['david', 'romain'],
  3: ['david', 'aelith', 'brokk'],
  4: ['david', 'aelith', 'brokk', 'sandrine'],
};

const COLOR = ['Blue', 'Red', 'Green', 'Yellow'] as const;

/** Joueurs qui « existent » pour les mécanismes par slot : le slot k n'existe pour de vrai qu'à k+1 joueurs. */
function slots(run: BotRun): number[] {
  return Array.from({ length: run.playerCount }, (_, i) => i);
}

// ───────────────────────────── Spécial des bots ─────────────────────────────

/** Portée utile (px) du spécial d'un personnage pour décider de le lancer ; 0 = ne jamais le lancer (ruée). */
function specialReach(id: CharacterId): number {
  const sp = getCharacter(id).special;
  if (!sp) return 0;
  switch (sp.kind) {
    case 'whirlwind':
    case 'quake':
    case 'healNova':
      return sp.radius - 6;
    case 'smash':
      return sp.range - 8;
    case 'fireNova':
      return 56;
    case 'arrowFan':
      return 120;
    case 'bladeDance':
      return sp.radius - 6;
    default:
      return 0;
  }
}

/** Faut-il lancer le spécial ce pas ? (le joueur est en train d'attaquer, le spécial est prêt, un boss ou ≥ 3 ennemis à portée) */
function wantsSpecial(run: BotRun, bot: BotPlayer, frame: ActionFrame): boolean {
  const p = bot.player;
  if (p.status !== 'alive' || !frame.attack || p.specialCooldownMs > 0) return false;
  const reach = specialReach(p.characterId);
  if (reach <= 0) return false;
  let near = 0;
  let boss = false;
  for (const e of run.aliveEnemies as readonly EnemyState[]) {
    const d = Math.hypot(e.pos.x - p.pos.x, e.pos.y - p.pos.y);
    if (d > reach + 10) continue;
    near++;
    if (isAnyBossKind(e.kind)) boss = true;
  }
  return boss || near >= 3;
}

/**
 * Vecteur de recul (norme 1) devant le télégraphe d'un boss / demi-boss en `windup` : le héros qui se trouve dans (ou tout près de)
 * la zone annoncée s'en éloigne en ligne droite (jamais dans un mur : sinon il longe l'obstacle). Null si aucun télégraphe ne le menace.
 */
function telegraphRetreat(run: BotRun, bot: BotPlayer): { x: number; y: number } | null {
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
    const d = Math.hypot(p.pos.x - cx, p.pos.y - cy);
    if (d > radius + 26) continue;
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
    // direction de fuite : à l'opposé du boss, sinon de biais (± 45°, ± 90°) si un mur gêne
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

/**
 * Branche le spécial et le recul de télégraphe sur les pilotes d'une partie : la frame calculée par le pilote reçoit `special: true`
 * quand `wantsSpecial`, ou est remplacée par un recul quand un boss annonce une zone sur le héros.
 * (Surcharge d'instance de `computeFrame` : ni `botKit.ts` ni le moteur ne sont modifiés.)
 */
export function enableBotTactics(run: BotRun): void {
  for (const bot of run.bots) {
    const original = bot.computeFrame.bind(bot);
    bot.computeFrame = (dtMs: number): ActionFrame => {
      const frame = original(dtMs);
      const retreat = telegraphRetreat(run, bot);
      if (retreat) return { moveX: retreat.x, moveY: retreat.y, attack: false, interact: false, revive: false };
      if (wantsSpecial(run, bot, frame)) frame.special = true;
      return frame;
    };
  }
}

// ───────────────────────────── Actions de combat ─────────────────────────────

/**
 * Combat jusqu'à ce que la salle soit entièrement nettoyée (exigence `clear` : ennemis vivants ET apparitions en attente),
 * y compris les vagues conditionnées. Ne termine que quand `clear` est vrai.
 */
function clearAll(maxMs = 240000): BotAction {
  return custom('clearAll', () => {
    let inner = attackUntilClear({ maxMs, stallMs: 20000 }).create();
    return {
      tick(ctx) {
        if (ctx.run.requirementMet('clear')) return 'done';
        if (ctx.elapsedMs > maxMs) return ctx.fail(`salle non nettoyée après ${maxMs} ms : ${ctx.run.describeEnemies(ctx.run.aliveEnemies)}`);
        const st = inner.tick(ctx);
        if (st === 'failed') return 'failed';
        if (st === 'done') {
          inner = attackUntilClear({ maxMs, stallMs: 20000 }).create();
          if (!ctx.consumed) {
            if (!ctx.useBackground({ regroup: false })) ctx.set({});
          }
        }
        return 'running';
      },
    };
  });
}

/**
 * Nettoie une ZONE de la salle (prédicat sur les coordonnées de tuile) : ennemis vivants dans la zone ET apparitions en attente dont
 * la tuile est dans la zone. Les ennemis hors zone (ex. derrière une herse fermée) sont ignorés. Termine quand la zone est vide.
 */
function clearArea(inArea: (tx: number, ty: number) => boolean, label: string, maxMs = 240000): BotAction {
  return custom(`clearArea(${label})`, () => {
    let stallMs = 0;
    return {
      tick(ctx) {
        const run = ctx.run;
        const alive = run.aliveEnemies.filter((e) => inArea(Math.floor(e.pos.x / TILE), Math.floor(e.pos.y / TILE)));
        const spawned = run.state.room.spawnedSpawnIdx;
        const pending = run.room.enemies.some(
          (d, i) => (d.minPlayers ?? 1) <= run.playerCount && !spawned.includes(i) && inArea(d.tile[0], d.tile[1]),
        );
        if (alive.length === 0 && !pending) return 'done';
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

/** Attend que toutes les exigences de sortie de la salle soient remplies, puis va à la sortie. */
function exitWhenReady(): BotAction[] {
  return [
    waitUntil((run) => run.room.exit.requires.every((r) => run.requirementMet(r)), 240000, { label: 'exigences de sortie' }),
    ...toExit(),
  ];
}

/**
 * Allume SON brasero de couleur : si la torche est à moins de la moitié du combustible, passe d'abord recharger au brasero allumé le
 * plus proche (Action à côté), puis allume le sien (Action, torche non vide). Ne fait rien si le brasero est déjà allumé / neutralisé.
 */
function lightBrazier(id: string): BotAction {
  const nearestLit = (run: BotRun, bot: BotPlayer): TileXY => {
    let best: TileXY = run.mechTile(id);
    let bd = Infinity;
    for (const m of run.room.mechanisms) {
      if (m.type !== 'brazier' || m.lit !== true) continue;
      const d = Math.hypot((m.tile[0] + 0.5) * TILE - bot.player.pos.x, (m.tile[1] + 0.5) * TILE - bot.player.pos.y);
      if (d < bd) {
        bd = d;
        best = [m.tile[0], m.tile[1]];
      }
    }
    return best;
  };
  const light = seq(
    `allumer ${id}/do`,
    goNear((run) => run.mechTile(id), { radius: 18, avoidEnemies: false, fightBudgetMs: 60000, maxMs: 150000 }),
    pressInteract({ expect: conds.mechActive(id), settleMs: 300, retries: 3, label: `allumer ${id}` }),
  );
  const refuel = seq(
    `recharger avant ${id}`,
    goNear(nearestLit, { radius: 18, avoidEnemies: false, fightBudgetMs: 60000, maxMs: 150000 }),
    pressInteract({ settleMs: 100, retries: 0, label: 'recharger la torche' }),
  );
  return unless(
    conds.mechActive(id),
    custom(`allumer ${id}`, () => {
      let inner: ReturnType<BotAction['create']> | null = null;
      return {
        tick(ctx) {
          if (!inner) inner = (ctx.player.torchMs < 40000 ? seq(`allumer ${id}`, refuel, light) : light).create();
          return inner.tick(ctx);
        },
      };
    }),
  );
}

// ───────────────────────────── Relais au sablier ─────────────────────────────

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
 * retourne lui-même le levier de SON côté après `waitMs` : jamais d'attente sans fin (variante robuste de `crossHourglass`).
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
 * Après le franchissement : si des ennemis restent coincés du côté de départ (ils ont suivi les héros jusqu'à la herse, qui s'est
 * refermée), va tenir le levier voisin de la herse pour la rouvrir et les laisser passer, jusqu'à ce qu'il n'en reste plus (au plus
 * `maxMs`). Sans effet s'il n'y a personne de ce côté.
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

/** Le héros `id` est-il posté devant la herse `mechId` (à moins de 6 tuiles de son centre : ils se tassent devant la herse) ? */
export function postedAtGate(run: BotRun, mechId: string, id: PlayerId): boolean {
  const def = run.mechDef(mechId);
  if (def.type !== 'hourglass') throw new Error(`${mechId} n'est pas un sablier`);
  const c = tileCenterPx(def.gate[Math.floor(def.gate.length / 2)]);
  const p = run.player(id);
  return Math.hypot(p.pos.x - c.x, p.pos.y - c.y) <= 6 * TILE;
}

/**
 * Franchissement coopératif d'une herse de sablier, 1..4 joueurs (variante de `relayHourglass` qui ne se bloque jamais) :
 *  - SOLO : retourner le levier lointain, puis courir à la herse (la période est doublée en solo) ;
 *  - 2+ joueurs : les AUTRES se postent devant la herse ; le TENANT (joueur 0) va au levier lointain, attend que tous soient postés
 *    (ou à terre : on ne les attend pas), le retourne puis court vers la herse (il arrive trop tard : elle est refermée) ; les autres
 *    passent pendant le sable ; le RELAIS (joueur 1), une fois passé, tient le levier voisin de la herse, de l'autre côté, jusqu'à ce
 *    que le tenant soit passé à son tour.
 */
export function relay(run: BotRun, mechId: string, dest: (id: PlayerId) => TileXY, lastMs = 150000): void {
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
    // chaque héros passé tient ensuite le levier voisin jusqu'à ce que TOUS les autres (tenant compris) soient passés : si l'un d'eux
    // a raté la fenêtre (cohue devant la herse), un autre le relaie
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

/** Destination de chaque joueur de l'autre côté d'une herse : une tuile par joueur dans la zone dégagée du levier. */
function spread(x: number, y: number): (id: PlayerId) => TileXY {
  return (id) => [x + (id % 2), y + Math.floor(id / 2) * 2];
}

const ashgateScript = roomScript('ashgate', (run) => {
  relay(run, 'hgAsh', spread(37, 18));
  for (const b of run.bots) run.queue(b.id, clearAll(), ...exitWhenReady());
});

const slagworksScript = roomScript('slagworks', (run) => {
  relay(run, 'hgSlag', spread(36, 21));
  for (const b of run.bots) run.queue(b.id, clearAll(), ...exitWhenReady());
});

const crucibleScript = roomScript(
  'crucible',
  (run) => {
    const inB = (tx: number) => tx >= 28 && tx <= 57;
    relay(run, 'hgForgeA', spread(33, 21));
    // le héros du slot 1 tient le creuset pendant que les autres nettoient la chambre B
    const holder = run.playerFor(1);
    for (const b of run.bots) {
      if (b.id === holder) {
        run.queue(b.id, standOn([42, 22], { tolerance: 2, until: conds.objectiveDone('hold'), maxMs: 120000, fightBudgetMs: 1e9 }));
      }
      run.queue(b.id, clearArea(inB, 'chambre B'));
    }
    for (const b of run.bots) run.queue(b.id, barrier('crucibleB', run.playerCount, 180000));
    relay(run, 'hgForgeB', spread(71, 21));
    for (const b of run.bots) run.queue(b.id, clearAll(), ...exitWhenReady());
  },
  { maxMs: 360000 },
);

const pyreScript = roomScript(
  'pyre',
  (run) => {
    // le hall est nettoyé ENSEMBLE avant de se séparer sur les plaques (un héros isolé parmi les gardiens tomberait sans secours)
    for (const b of run.bots) run.queue(b.id, clearArea((tx) => tx <= 31, 'hall'), barrier('pyrePlates', run.playerCount, 180000));
    for (const s of slots(run)) {
      const plate = run.mechTile(`plate${COLOR[s]}`);
      run.queueForSlot(s, goTo(plate), standOn(plate, { until: conds.mechActive('pyreDoor') }));
    }
    // tout ce qui est avant la herse (hall, antichambre) est nettoyé AVANT de passer : on ne laisse rien derrière une herse close
    for (const b of run.bots) run.queue(b.id, clearArea((tx) => tx <= 51, 'hall et antichambre'));
    for (const b of run.bots) run.queue(b.id, barrier('pyreGate', run.playerCount, 180000));
    relay(run, 'hgPyre', spread(62, 19));
    for (const b of run.bots) run.queue(b.id, clearAll(), ...exitWhenReady());
  },
  { maxMs: 360000 },
);

const cinderpitScript = roomScript(
  'cinderpit',
  (run) => {
    for (const b of run.bots) run.queue(b.id, clearAll(300000), ...exitWhenReady());
  },
  { maxMs: 360000 },
);

const blindforgeScript = roomScript(
  'blindforge',
  (run) => {
    relay(run, 'hgDark', spread(38, 21));
    // la forge est nettoyée ENSEMBLE avant que chacun n'aille allumer son brasero dans son coin (la torche se recharge au besoin)
    for (const b of run.bots) run.queue(b.id, clearAll(), barrier('darkBraziers', run.playerCount, 180000));
    for (const s of slots(run)) run.queueForSlot(s, lightBrazier(`brazier${COLOR[s]}`));
    for (const b of run.bots) run.queue(b.id, waitUntil(conds.mechActive('hearthDoor'), 180000, { label: 'porte de la forge' }), ...exitWhenReady());
  },
  { maxMs: 360000 },
);

const bellowsScript = roomScript(
  'bellows',
  (run) => {
    // tout sauf la salle de sortie (x ≥ 60, y ≤ 15), inaccessible tant que la porte est fermée
    const notExitRoom = (tx: number, ty: number) => !(tx >= 60 && ty <= 15);
    relay(run, 'hgBellows', spread(34, 27));
    for (const b of run.bots) run.queue(b.id, clearArea(notExitRoom, 'hall et galeries'));
    const need = pushersNeeded(run, 'bellowsBlock');
    const pushers = run.alivePlayers().slice(0, need).map((p) => p.id);
    pushers.forEach((id, i) => {
      run.queue(id, barrier('bellowsPush', pushers.length, 120000), pushBlock('bellowsBlock', 'right', 30, { lane: i }));
    });
    for (const b of run.bots) {
      run.queue(b.id, waitUntil(conds.mechActive('bellowsDoor'), 120000, { label: 'porte des soufflets' }), clearAll(), ...exitWhenReady());
    }
  },
  { maxMs: 360000 },
);

const emberholdScript = roomScript(
  'emberhold',
  (run) => {
    // le grand hall est nettoyé ENSEMBLE avant que chacun n'aille chercher sa clé dans son coin
    for (const b of run.bots) run.queue(b.id, clearArea((tx) => tx <= 45, 'grand hall'), barrier('emberKeys', run.playerCount, 180000));
    for (const s of slots(run)) {
      const c = COLOR[s];
      run.queueForSlot(s, pickUpKey(`key${c}`, { avoidEnemies: false, fightBudgetMs: 60000, maxMs: 150000 }), useKey(`door${c}`, { avoidEnemies: false, fightBudgetMs: 60000, maxMs: 150000 }));
    }
    const doors = COLOR.map((c) => `door${c}`);
    for (const b of run.bots) {
      run.queue(b.id, waitUntil(conds.requirements(doors), 180000, { label: 'les quatre portes' }), clearAll(), ...exitWhenReady());
    }
  },
  { maxMs: 360000 },
);

const forgeheartScript = roomScript(
  'forgeheart',
  (run) => {
    for (const b of run.bots) run.queue(b.id, clearAll(360000), ...exitWhenReady());
  },
  { maxMs: 420000 },
);

/** Tous les scripts du niveau 5, dans l'ordre des salles. */
export function level5Scripts(): RoomScript[] {
  return [
    ashgateScript,
    slagworksScript,
    crucibleScript,
    pyreScript,
    cinderpitScript,
    blindforgeScript,
    bellowsScript,
    emberholdScript,
    forgeheartScript,
  ];
}

/** Options de partie pour n joueurs (personnages solides, difficulté 2, graine fixe). */
export function level5RunOptions(n: number, seed = 11) {
  return {
    playerCount: n,
    characters: LEVEL5_CHARACTERS[n],
    difficulties: Array.from({ length: n }, () => 2 as Difficulty),
    seed,
  };
}

/** Nouvelle partie de bots sur le niveau 5 (spécial des bots activé). */
export function newLevel5Run(
  n: number,
  opts: { seed?: number; startRoomIndex?: number; specials?: boolean; characters?: readonly CharacterId[] } = {},
): BotRun {
  const base = level5RunOptions(n, opts.seed ?? 11);
  const run = new BotRun(level5, { ...base, characters: opts.characters ?? base.characters, startRoomIndex: opts.startRoomIndex });
  if (opts.specials ?? true) enableBotTactics(run);
  return run;
}

/** Joue le niveau 5 de bout en bout pour n joueurs. */
export function solveLevel5(
  n: number,
  opts: { seed?: number; startRoomIndex?: number; specials?: boolean; characters?: readonly CharacterId[]; level?: LevelRunOptions } = {},
): { run: BotRun; result: LevelRunResult } {
  const run = newLevel5Run(n, opts);
  const result = runLevelScripts(run, level5Scripts(), { maxTotalMs: 20 * 60 * 1000, maxRoomMs: 300000, maxWipesPerRoom: 4, ...(opts.level ?? {}) });
  return { run, result };
}
