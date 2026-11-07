/**
 * Solution scriptée du niveau 6 (« Les Abysses du Néant »), jouée par les bots de `botKit` sur la VRAIE simulation.
 *
 * Uniquement des `ActionFrame` (via les actions de `botActions.ts` / `novelBots.ts`) : aucune écriture dans `sim.state`.
 * Stratégie COOPÉRATIVE voulue par le niveau :
 *  - quay       : on vainc les rôdeurs de la rive de départ, le porteur (slot 0) guide tout le monde sur le pont (`escortLightBridge`),
 *                 on s'avance dans la zone d'embuscade de l'autre rive, on la vainc, puis sortie ;
 *  - islets     : deux ponts (porteurs : slots 1 puis 2) séparés par un îlot d'embuscade, puis embuscade de la rive d'arrivée ;
 *  - terrace    : long pont sinueux (slot 3), embuscade de l'île, le héros du slot 1 tient la balise, chacun tire SON levier ;
 *  - wraithhall : demi-boss n°1 (spécial des bots activé), puis chacun tient SA plaque de couleur ;
 *  - keys       : chacun ramasse SA clé dans SA chambre, on se regroupe, pont long (slot 0), embuscade, chacun ouvre SA porte ;
 *  - embers     : pont sinueux (slot 1), embuscade, recharge de torche, chacun allume SON brasero ;
 *  - hearth     : demi-boss n°2 + horde de sbires (spécial des bots activé), puis chacun tire SON levier ;
 *  - gauntlet   : quatre ponts à la suite (porteurs : slots 0, 1, 2, 3), une embuscade après chaque atterrissage ;
 *  - throne     : tous contre le seigneur du Néant (spécial des bots activé).
 * Règle d'or : aucun ennemi vivant pendant une traversée — chaque rive est nettoyée (`clearStage`) AVANT d'engager le pont suivant, et les
 * alliés à terre sont relevés (`reviveTeam`) : l'escorte n'attend pas un joueur à terre.
 *
 * Particularités des bots de ce niveau (voir `issues` du rapport) :
 *  - les bots n'esquivent pas intelligemment dans les salles ordinaires ; en revanche, dans les salles de demi-boss et de boss
 *    (`withSpecial`), ils lancent leur attaque spéciale dès qu'elle est prête et ennemi à portée, sortent des zones de danger verrouillées du
 *    seigneur du Néant et sidestepent les projectiles (esquive prospective sur 0,7 s) ;
 *  - un bot immobile contre un ennemi collé à un pilier (cas d'angle du contrôleur de combat) avance droit dessus (`unstick`) ;
 *  - difficulté : 2 (normal, défaut du menu) à 1, 2, 3 et 4 joueurs. Depuis le rééquilibrage du seigneur du Néant (2000 PV, dégâts 17 au lieu
 *    de 2300 PV / 24), David (mêlée) le vainc seul à difficulté 2 ; le niveau COMPLET en solo à difficulté 2 est prouvé (≈ 11-12 min simulées,
 *    2-3 défaites collectives de bot : la fenêtre solo est de 12 min). `LEVEL6_SOLO_BOSS` / `newLevel6SoloBossRun` isolent la salle du trône.
 */
import { PLAYER_RADIUS, REVIVE_RANGE, TORCH_MAX_MS } from '../core/constants';
import { ENEMY_SPECIALS } from '../core/bosses';
import { canOccupy } from '../core/collision';
import { dist } from '../core/geometry';
import { getCharacter } from '../core/characters';
import type { CharacterId, Difficulty, EnemyState, TileXY, Vec2 } from '../core/types';
import {
  BotRun,
  attackUntilClear,
  barrier,
  conds,
  custom,
  escortLightBridge,
  goNear,
  goTo,
  pickUpKey,
  pressInteract,
  pullLever,
  reachableTiles,
  roomScript,
  runLevelScripts,
  seq,
  standOn,
  tileOfPx,
  toExit,
  useKey,
  waitUntil,
  type ActionCtx,
  type ActionRunner,
  type BotAction,
  type LevelRunOptions,
  type LevelRunResult,
  type RoomScript,
} from './botKit';
import { level6 } from '../levels/level6';

/** Personnages par nombre de joueurs : variés (mêlée / distance), solides. */
export const LEVEL6_CHARACTERS: Readonly<Record<number, readonly CharacterId[]>> = {
  1: ['david'],
  2: ['david', 'valentine'],
  3: ['david', 'valentine', 'aelith'],
  4: ['david', 'valentine', 'grok', 'aelith'],
};

/** Difficulté des bots par nombre de joueurs : 2 (normal, défaut du menu) partout, solo compris (boss final rééquilibré, voir l'en-tête). */
export const LEVEL6_DIFFICULTY: Record<number, Difficulty> = { 1: 2, 2: 2, 3: 2, 4: 2 };

/**
 * Preuve du boss final en SOLO à la difficulté par défaut (2) : une archère (Aelith, à distance) vient à bout du seigneur du Néant depuis
 * le début de la salle du trône (PV pleins : la reprise après défaite se fait au début de la salle). Le même bot ne tient pas toutes les
 * salles ordinaires en solo à difficulté 2 (embuscades de la terrasse et du Grand Pont) : le niveau COMPLET est prouvé en solo à
 * difficulté 2 avec David (test « solo à la difficulté par défaut »). Le nombre d'ennemis ne dépend pas de la difficulté.
 */
export const LEVEL6_SOLO_BOSS: { readonly character: CharacterId; readonly difficulty: Difficulty } = { character: 'aelith', difficulty: 2 };

const COLOR = ['Blue', 'Red', 'Green', 'Yellow'] as const;

/** Joueurs qui « existent » pour les mécanismes par slot : le slot k n'existe pour de vrai qu'à k+1 joueurs. */
function slots(run: BotRun): number[] {
  return Array.from({ length: run.playerCount }, (_, i) => i);
}

/**
 * Débloque un bot qui reste immobile à côté d'un ennemi (cas d'angle : ennemi en diagonale d'un pilier, que le contrôleur de combat
 * ne sait pas contourner) : il s'avance droit sur lui en frappant. Sans effet tant que l'action produit déjà un mouvement ou une attaque.
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

/** Portée (px) à laquelle un bot déclenche son attaque spéciale sur un ennemi (zone d'effet moyenne des spéciaux). */
const SPECIAL_RANGE_PX = 62;

/**
 * Esquive de base des ZONES DE DANGER du seigneur du Néant (`data.zoneX0..2/zoneY0..2/zoneRadius`, `special === ENEMY_SPECIALS.VOIDZONE`) :
 * dès que les cercles sont verrouillés (fin du suivi pendant le télégraphe, ou mode 'attack'), un joueur qui se trouve dedans en sort en
 * ligne droite. C'est ce que fait n'importe quel humain ; sans cela les bots restent plantés dans les cercles persistants.
 */
function leaveVoidZones(ctx: ActionCtx): boolean {
  const p = ctx.player;
  for (const e of ctx.run.aliveEnemies) {
    if (e.kind !== 'voidlord' || e.data.special !== ENEMY_SPECIALS.VOIDZONE) continue;
    const total = e.data.windupTotalMs || 1000;
    const locked = e.mode === 'attack' || (e.mode === 'windup' && e.modeTimerMs <= total * 0.5);
    if (!locked) continue;
    const n = Math.floor(e.data.zoneCount ?? 0);
    const r = (e.data.zoneRadius ?? 0) + 6;
    let ax = 0;
    let ay = 0;
    for (let i = 0; i < n; i++) {
      const c = { x: e.data[`zoneX${i}`], y: e.data[`zoneY${i}`] };
      const d = dist(c, p.pos);
      if (d > r) continue;
      ax += d < 1 ? 1 : (p.pos.x - c.x) / d;
      ay += d < 1 ? 0 : (p.pos.y - c.y) / d;
    }
    const len = Math.hypot(ax, ay);
    if (len > 0.01) {
      ctx.frame.moveX = ax / len;
      ctx.frame.moveY = ay / len;
      return true;
    }
  }
  return false;
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
 * Esquive de projectiles ennemis (traits sombres, anneaux, spirales) : compare le mouvement voulu par l'action et quelques mouvements de
 * remplacement sur les 0,7 s à venir (projectiles supposés en ligne droite) et garde le moins touché ; ne remplace le mouvement voulu que
 * si celui-ci mène à un impact. Plus attentif que l'esquive de fond de `botBrain` (qui se limite à ~35 % du temps) : réservé aux salles
 * de demi-boss et de boss.
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
 * Ajoute l'attaque spéciale à une action de combat : dès que le spécial est prêt et qu'un ennemi est à portée de frappe, la frame
 * produite par l'action reçoit `special: true` (la simulation détecte le front montant). Raisonnable : un joueur humain l'utiliserait
 * ainsi contre un demi-boss / un boss ; le spécial n'est PAS activé dans les salles ordinaires. Contre le seigneur du Néant, le bot
 * sort aussi des zones de danger verrouillées.
 */
function withSpecial(action: BotAction): BotAction {
  return custom(`${action.label}+spécial`, () => {
    const inner = action.create();
    return {
      tick(ctx) {
        const st = inner.tick(ctx);
        const p = ctx.player;
        if (st === 'running' && p.specialCooldownMs <= 0 && ctx.run.aliveEnemies.some((e) => dist(e.pos, p.pos) <= SPECIAL_RANGE_PX)) {
          ctx.frame.special = true;
        }
        if (st === 'running' && !leaveVoidZones(ctx)) dodgeProjectiles(ctx);
        return st;
      },
    };
  });
}

/**
 * Combat jusqu'à ce que toutes les apparitions de la salle soient vaincues (exigence `clear` : ennemis vivants ET apparitions en attente).
 * Pour les salles SANS embuscade à venir (salles de demi-boss et de boss).
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
        return 'running';
      },
    };
  });
}

/**
 * Nettoie une ÉTAPE : combat jusqu'à ce qu'aucun ennemi ne soit vivant et qu'aucune apparition imminente n'attende (les embuscades non
 * déclenchées ne comptent pas : elles surgiront quand on entrera dans leur zone). Indispensable avant d'engager un pont.
 */
function clearStage(maxMs = 240000): BotAction {
  return custom('clearStage', () => {
    let inner = attackUntilClear({ maxMs, stallMs: 20000 }).create();
    let rescue: ActionRunner | null = null;
    return {
      tick(ctx) {
        const run = ctx.run;
        if (run.aliveEnemies.length === 0 && run.pendingSpawnCount(true) === 0) {
          // étape nettoyée : on relève d'abord les alliés à terre (le pont ne doit jamais laisser quelqu'un derrière)
          rescue ??= reviveTeam().create();
          return rescue.tick(ctx);
        }
        rescue = null;
        if (ctx.elapsedMs > maxMs) return ctx.fail(`étape non nettoyée après ${maxMs} ms : ${run.describeEnemies(run.aliveEnemies)}`);
        const st = inner.tick(ctx);
        if (st === 'failed') return 'failed';
        if (st === 'done') {
          inner = attackUntilClear({ maxMs, stallMs: 20000 }).create();
          if (!ctx.consumed && !ctx.useBackground({ regroup: false })) ctx.set({});
        }
        unstick(ctx);
        return 'running';
      },
    };
  });
}

/**
 * Relève les alliés à terre : termine quand tous les joueurs sont debout (le joueur courant rejoint le premier allié à terre et maintient
 * le relevage). À placer avant d'engager un pont : l'escorte n'attend pas un joueur à terre et le laisserait derrière.
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
        // à portée : on ne bouge plus (la simulation fige le sauveteur) et on maintient « relever »
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

/** Recharge la torche au brasero allumé le plus proche si elle est sous la moitié (salle sombre). */
function refuelTorch(): BotAction {
  return custom('refuelTorch', () => {
    let inner: ActionRunner | null = null;
    return {
      tick(ctx) {
        if (!inner) {
          if (ctx.player.torchMs >= TORCH_MAX_MS * 0.5) return 'done';
          // braseros allumés ATTEIGNABLES depuis ma position (ni derrière une porte fermée, ni de l'autre côté d'un abîme)
          const reach = reachableTiles(ctx.run.navMap(), tileOfPx(ctx.player.pos));
          const nav = ctx.run.navMap();
          const touches = (t: TileXY): boolean =>
            ([[1, 0], [-1, 0], [0, 1], [0, -1]] as const).some(([dx, dy]) => reach[(t[1] + dy) * nav.width + t[0] + dx]);
          let best: TileXY | null = null;
          let bd = Infinity;
          for (const f of ctx.run.room.mechanisms) {
            if (f.type !== 'brazier' || f.lit !== true || !touches(f.tile)) continue;
            const d = dist(ctx.player.pos, { x: (f.tile[0] + 0.5) * 16, y: (f.tile[1] + 0.5) * 16 });
            if (d < bd) {
              bd = d;
              best = f.tile;
            }
          }
          if (!best) return 'done';
          const target = best;
          const id = ctx.id;
          inner = seq(
            'recharge de torche',
            goNear(target, { radius: 18 }),
            pressInteract({ expect: (r) => r.player(id).torchMs >= TORCH_MAX_MS - 1, settleMs: 300, retries: 3, label: 'recharger la torche' }),
          ).create();
        }
        return inner.tick(ctx);
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

// ───────────────────────────── Salles ─────────────────────────────

const quayScript = roomScript('quay', (run) => {
  run.queueEach(() => clearStage());
  escortLightBridge(run, 'quayBridge', { dest: [43, 22] });
  run.queueEach(() => [enterZone([51, 20]), clearStage(), ...exitWhenReady()]);
});

const isletsScript = roomScript('islets', (run) => {
  run.queueEach(() => clearStage());
  escortLightBridge(run, 'bridgeOne', { dest: [33, 24] });
  run.queueEach(() => [enterZone([39, 26]), clearStage()]);
  escortLightBridge(run, 'bridgeTwo', { dest: [54, 27] });
  run.queueEach(() => [enterZone([59, 24]), clearStage(), ...exitWhenReady()]);
});

const terraceScript = roomScript('terrace', (run) => {
  run.queueEach(() => clearStage());
  escortLightBridge(run, 'terraceBridge', { dest: [55, 30] });
  run.queueEach(() => [enterZone([63, 30]), clearStage()]);
  // le héros du slot 1 tient la balise (zone) 8 s
  run.queue(run.playerFor(1), standOn([60, 31], { until: (r) => r.requirementMet('obj:beacon'), label: 'tenir la balise' }));
  // puis chacun tire SON levier dans la fenêtre
  for (const s of slots(run)) {
    const lever = `terraceLever${COLOR[s]}`;
    run.queueForSlot(s, goNear((r) => r.mechTile(lever), { radius: 12 }), barrier('terraceLevers', run.playerCount, 120000), pullLever(lever));
  }
  run.queueEach(() => exitWhenReady());
});

const wraithhallScript = roomScript(
  'wraithhall',
  (run) => {
    run.queueEach(() => withSpecial(clearAll(300000)));
    for (const s of slots(run)) {
      const plate = run.mechTile(`wraithPlate${COLOR[s]}`);
      run.queueForSlot(s, goTo(plate), standOn(plate, { until: conds.mechActive('wraithDoor') }));
    }
    run.queueEach(() => exitWhenReady());
  },
  { maxMs: 360000 },
);

const keysScript = roomScript('keys', (run, info) => {
  for (const s of slots(run)) run.queueForSlot(s, pickUpKey(`key${COLOR[s]}`));
  run.queueEach(() => [barrier(`keys:${info.attempt}`, run.playerCount, 240000), clearStage()]);
  escortLightBridge(run, 'keysBridge', { dest: [60, 16] });
  run.queueEach(() => [enterZone([66, 20]), clearStage()]);
  for (const s of slots(run)) run.queueForSlot(s, useKey(`door${COLOR[s]}`));
  run.queueEach(() => exitWhenReady());
});

const embersScript = roomScript('embers', (run) => {
  run.queueEach(() => clearStage());
  escortLightBridge(run, 'embersBridge', { dest: [50, 15] });
  run.queueEach(() => [enterZone([60, 20]), clearStage(), refuelTorch()]);
  for (const s of slots(run)) {
    const id = `emberBrazier${COLOR[s]}`;
    run.queueForSlot(
      s,
      goNear((r) => r.mechTile(id), { radius: 18 }),
      pressInteract({ expect: conds.mechActive(id), settleMs: 300, retries: 3, label: `allumer ${id}` }),
    );
  }
  run.queueEach(() => exitWhenReady());
});

const hearthScript = roomScript(
  'hearth',
  (run, info) => {
    run.queueEach(() => withSpecial(clearAll(360000)));
    for (const s of slots(run)) {
      const lever = `hearthLever${COLOR[s]}`;
      run.queueForSlot(s, goNear((r) => r.mechTile(lever), { radius: 12 }), barrier(`hearth:${info.attempt}`, run.playerCount, 120000), pullLever(lever));
    }
    run.queueEach(() => exitWhenReady());
  },
  { maxMs: 420000 },
);

const gauntletScript = roomScript('gauntlet', (run) => {
  escortLightBridge(run, 'bridgeA', { dest: [32, 30] });
  run.queueEach(() => [enterZone([40, 30]), clearStage()]);
  escortLightBridge(run, 'bridgeB', { dest: [47, 14] });
  run.queueEach(() => [enterZone([54, 14]), clearStage()]);
  escortLightBridge(run, 'bridgeC', { dest: [66, 28] });
  run.queueEach(() => [enterZone([65, 35]), clearStage()]);
  escortLightBridge(run, 'bridgeD', { dest: [76, 18] });
  run.queueEach(() => [enterZone([80, 10]), clearStage(), ...exitWhenReady()]);
});

const throneScript = roomScript(
  'throne',
  (run) => {
    run.queueEach(() => [withSpecial(clearAll(420000)), ...exitWhenReady()]);
  },
  { maxMs: 480000 },
);

/** Tous les scripts du niveau 6, dans l'ordre des salles. */
export function level6Scripts(): RoomScript[] {
  return [quayScript, isletsScript, terraceScript, wraithhallScript, keysScript, embersScript, hearthScript, gauntletScript, throneScript];
}

/** Options de partie pour n joueurs (personnages solides, difficulté 2, graine fixe). */
export function level6RunOptions(n: number, seed = 7) {
  return {
    playerCount: n,
    characters: LEVEL6_CHARACTERS[n],
    difficulties: Array.from({ length: n }, () => LEVEL6_DIFFICULTY[n] ?? 2),
    seed,
  };
}

/** Nouvelle partie de bots sur le niveau 6. */
export function newLevel6Run(n: number, opts: { seed?: number; startRoomIndex?: number } = {}): BotRun {
  return new BotRun(level6, { ...level6RunOptions(n, opts.seed ?? 7), startRoomIndex: opts.startRoomIndex });
}

/**
 * Partie SOLO sur la seule salle du trône (boss final), à la difficulté et avec le personnage donnés (défaut : `LEVEL6_SOLO_BOSS`).
 * Les objectifs des salles précédentes sont considérés accomplis (comme pour tout `startRoomIndex`).
 */
export function newLevel6SoloBossRun(opts: { seed?: number; character?: CharacterId; difficulty?: Difficulty } = {}): BotRun {
  return new BotRun(level6, {
    playerCount: 1,
    characters: [opts.character ?? LEVEL6_SOLO_BOSS.character],
    difficulties: [opts.difficulty ?? LEVEL6_SOLO_BOSS.difficulty],
    seed: opts.seed ?? 7,
    startRoomIndex: level6.rooms.length - 1,
  });
}

/** Joue le niveau 6 de bout en bout pour n joueurs. */
export function solveLevel6(
  n: number,
  opts: { seed?: number; startRoomIndex?: number; level?: LevelRunOptions } = {},
): { run: BotRun; result: LevelRunResult } {
  const run = newLevel6Run(n, opts);
  const result = runLevelScripts(run, level6Scripts(), { maxTotalMs: 20 * 60 * 1000, maxRoomMs: 240000, maxWipesPerRoom: 4, ...(opts.level ?? {}) });
  return { run, result };
}
