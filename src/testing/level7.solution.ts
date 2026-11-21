/**
 * Solution scriptée du niveau 7 (« Le Carillon Englouti »), jouée par les bots de `botKit` sur la VRAIE simulation.
 *
 * Uniquement des `ActionFrame` (via les actions de `botActions.ts` / `novelBots.ts`) : aucune écriture dans `sim.state`.
 * Stratégie COOPÉRATIVE voulue par le niveau :
 *  - shoal       : on vainc les rôdeurs, puis chacun tient SA plaque de couleur (simultanément) → porte ;
 *  - pearlcave   : salle sombre : on vainc les habitants, chacun allume SON brasero de couleur (porte), le héros du slot 1 veille 20 s dans la perle ;
 *  - dyke        : demi-boss n°1 (spécial des bots activé) ;
 *  - mirrorpools : « Phare et Écho » : le héros du slot 1 LIT la séquence sur l'écran de la rive ouest, on se regroupe, le porteur (slot 0)
 *                  guide le pont (`escortLightBridge`), embuscade de l'île, les autres joueurs frappent les piédestaux dans l'ordre (en solo : le
 *                  même joueur, de mémoire), embuscade de la rive est ;
 *  - sluice      : le bloc 2×2 est poussé à deux (ou seul à 1 joueur) jusqu'au socle, on vainc les gardiens des galeries, le slot 0 tient la
 *                  pompe et le slot 1 la marée (3+ joueurs : les autres défendent), puis on vainc les gardiens de l'est ;
 *  - choir       : trois vagues d'embuscade (bandes), puis chacun s'annonce près de SON levier et tire dans la fenêtre ;
 *  - stormdeck   : demi-boss n°2 (spécial des bots activé) ;
 *  - glassheart  : tous contre l'écho de Morvane (spécial des bots activé).
 *
 * Particularités des bots de ce niveau :
 *  - les bots n'esquivent pas intelligemment dans les salles ordinaires ; dans les salles de demi-boss et de boss (`withSpecial`) ils lancent
 *    leur spécial dès qu'il est prêt et sidestepent les projectiles (esquive prospective sur 0,7 s) ;
 *  - un bot immobile contre un ennemi collé à un pilier avance droit dessus (`unstick`) ;
 *  - difficulté : 2 (normal, défaut du menu) à 1, 2, 3 et 4 joueurs.
 */
import { PLAYER_RADIUS, REVIVE_RANGE, TORCH_MAX_MS } from '../core/constants';
import { canOccupy } from '../core/collision';
import { dist } from '../core/geometry';
import { getCharacter } from '../core/characters';
import type { CharacterId, Difficulty, EnemyState, PlayerId, TileXY, Vec2 } from '../core/types';
import {
  BotRun,
  act,
  attackUntilClear,
  barrier,
  conds,
  custom,
  escortLightBridge,
  goNear,
  goTo,
  pressInteract,
  pullLever,
  reachableTiles,
  roomScript,
  runLevelScripts,
  seq,
  standOn,
  tileOfPx,
  toExit,
  waitUntil,
  type ActionCtx,
  type ActionRunner,
  type BotAction,
  type LevelRunOptions,
  type LevelRunResult,
  type RoomScript,
} from './botKit';
import { level7 } from '../levels/level7';

/** Personnages par nombre de joueurs : variés (mêlée / distance), solides. */
export const LEVEL7_CHARACTERS: Readonly<Record<number, readonly CharacterId[]>> = {
  1: ['david'],
  2: ['david', 'valentine'],
  3: ['david', 'valentine', 'aelith'],
  4: ['david', 'valentine', 'grok', 'aelith'],
};

/** Difficulté des bots par nombre de joueurs : 2 (normal, défaut du menu) partout, solo compris. */
export const LEVEL7_DIFFICULTY: Record<number, Difficulty> = { 1: 2, 2: 2, 3: 2, 4: 2 };

/**
 * Partie SOLO sur la seule salle du boss final, à la difficulté et avec le personnage donnés (défaut : une archère, difficulté 2).
 * Les objectifs des salles précédentes sont considérés accomplis (comme pour tout `startRoomIndex`).
 */
export const LEVEL7_SOLO_BOSS: { readonly character: CharacterId; readonly difficulty: Difficulty } = { character: 'aelith', difficulty: 2 };

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
 * Esquive de projectiles ennemis : compare le mouvement voulu par l'action et quelques mouvements de remplacement sur les 0,7 s à venir
 * (projectiles supposés en ligne droite) et garde le moins touché ; ne remplace le mouvement voulu que si celui-ci mène à un impact.
 * Réservé aux salles de demi-boss et de boss.
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
 * produite par l'action reçoit `special: true`. Raisonnable : un joueur humain l'utiliserait ainsi contre un demi-boss / un boss ; le
 * spécial n'est PAS activé dans les salles ordinaires.
 */
export function withSpecial(action: BotAction): BotAction {
  return custom(`${action.label}+spécial`, () => {
    const inner = action.create();
    return {
      tick(ctx) {
        const st = inner.tick(ctx);
        const p = ctx.player;
        if (st === 'running' && p.specialCooldownMs <= 0 && ctx.run.aliveEnemies.some((e) => dist(e.pos, p.pos) <= SPECIAL_RANGE_PX)) {
          ctx.frame.special = true;
        }
        if (st === 'running') dodgeProjectiles(ctx);
        return st;
      },
    };
  });
}

/** Distance (px) en dessous de laquelle un ennemi empêche d'aller relever un allié (on se bat d'abord). */
const REVIVE_SAFE_PX = 70;

/** Un allié est à terre et aucun ennemi n'est sur nous : un joueur raisonnable va le relever tout de suite. */
function shouldRescue(ctx: ActionCtx): boolean {
  const down = ctx.run.sim.state.players.some((q) => q.status === 'down' && q.id !== ctx.id);
  return down && !ctx.run.aliveEnemies.some((e) => dist(e.pos, ctx.player.pos) < REVIVE_SAFE_PX);
}

/**
 * Combat jusqu'à ce que toutes les apparitions de la salle soient vaincues (exigence `clear` : ennemis vivants ET apparitions en attente).
 * Pour les salles SANS embuscade à venir. Un allié à terre est relevé dès qu'aucun ennemi n'est sur le joueur.
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
        if (shouldRescue(ctx)) {
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
        if (shouldRescue(ctx)) {
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
          // braseros allumés ATTEIGNABLES depuis ma position
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

/**
 * Tient une plaque jusqu'à ce que `until` soit vrai. Si un allié tombe pendant ce temps (typiquement le détenteur de l'autre plaque, au
 * milieu des gardiens), le détenteur quitte sa plaque, relève l'allié (`reviveTeam`), puis reprend sa place : sans cela, une plaque lâchée
 * par un joueur à terre laisserait tout le monde attendre indéfiniment une porte qui ne s'ouvre plus.
 */
function holdPlate(tile: TileXY, until: (run: BotRun) => boolean): BotAction {
  return custom(`holdPlate(${tile.join(',')})`, () => {
    let hold: ActionRunner | null = null;
    let rescue: ActionRunner | null = null;
    return {
      tick(ctx) {
        if (until(ctx.run)) return 'done';
        const mateDown = ctx.player.status === 'alive' && ctx.run.sim.state.players.some((q) => q.status === 'down' && q.id !== ctx.id);
        if (mateDown) {
          rescue ??= reviveTeam().create();
          hold = null;
          const st = rescue.tick(ctx);
          if (st === 'failed') return 'failed';
          if (st === 'done') rescue = null;
          return 'running';
        }
        rescue = null;
        hold ??= seq('tenir la plaque', goTo(tile), standOn(tile, { until })).create();
        const st = hold.tick(ctx);
        if (st === 'done') return 'done';
        return st;
      },
    };
  });
}

/** Va à un point d'une zone d'embuscade (tolérance large : il suffit d'y entrer). */
function enterZone(tile: TileXY): BotAction {
  return goTo(tile, { tolerance: 14, label: `entrer dans la zone ${tile.join(',')}` });
}

// ───────────────────────────── Salles ─────────────────────────────

const shoalScript = roomScript('shoal', (run) => {
  run.queueEach(() => clearAll());
  for (const s of slots(run)) {
    const plate = run.mechTile(`shoalPlate${COLOR[s]}`);
    run.queueForSlot(s, holdPlate(plate, conds.mechActive('shoalDoor')));
  }
  run.queueEach(() => exitWhenReady());
});

const pearlcaveScript = roomScript(
  'pearlcave',
  (run) => {
    run.queueEach(() => [clearAll(), refuelTorch()]);
    // chacun allume SON brasero de couleur
    for (const s of slots(run)) {
      const id = `pearlBrazier${COLOR[s]}`;
      run.queueForSlot(
        s,
        goNear((r) => r.mechTile(id), { radius: 18 }),
        pressInteract({ expect: conds.mechActive(id), settleMs: 300, retries: 3, label: `allumer ${id}` }),
      );
    }
    // le héros du slot 1 veille dans la perle jusqu'à accomplir l'objectif (20 s cumulées)
    run.queue(
      run.playerFor(1),
      refuelTorch(),
      goTo([23, 22]),
      standOn([23, 22], { until: (r) => r.requirementMet('obj:pearl'), tolerance: 6, maxMs: 120000, label: 'veiller dans la perle' }),
    );
    run.queueEach(() => exitWhenReady());
  },
  { maxMs: 420000 },
);

const dykeScript = roomScript(
  'dyke',
  (run) => {
    run.queueEach(() => [withSpecial(clearAll(300000)), ...exitWhenReady()]);
  },
  { maxMs: 360000 },
);

const mirrorpoolsScript = roomScript(
  'mirrorpools',
  (run, info) => {
    const def = run.mechDef('mirrorRunes');
    if (def.type !== 'runePuzzle') throw new Error('mirrorRunes attendu');
    const seer: PlayerId = run.playerFor(def.visibleToSlot);
    // 1. rive ouest : on vainc les rôdeurs, le voyant lit la séquence sur l'écran, tout le monde se regroupe avant le pont
    run.queueEach(() => clearStage());
    run.queue(seer, goTo(def.displayTile, { label: "goTo(écran des runes)" }), act(() => undefined, 'lecture de la séquence'));
    run.queueEach(() => [barrier(`mirror:${info.attempt}`, run.playerCount, 240000), clearStage()]);
    // 2. le porteur (slot 0) guide le pont ; embuscade de l'île
    escortLightBridge(run, 'mirrorBridge', { dest: [40, 30] });
    run.queueEach(() => [enterZone([48, 28]), clearStage()]);
    // 3. les piédestaux, dans l'ordre (en solo : le voyant lui-même, de mémoire)
    const actuators: PlayerId[] = run.playerCount === 1 ? [seer] : run.bots.map((b) => b.id).filter((id) => id !== seer);
    const stepsByPlayer = new Map<PlayerId, number[]>();
    def.sequence.forEach((_, i) => {
      const who = actuators[i % actuators.length];
      stepsByPlayer.set(who, [...(stepsByPlayer.get(who) ?? []), i]);
    });
    for (const who of actuators) {
      for (const i of stepsByPlayer.get(who) ?? []) {
        const ped = def.pedestals.find((q) => q.symbol === def.sequence[i]);
        if (!ped) throw new Error(`piédestal ${def.sequence[i]} introuvable`);
        run.queue(
          who,
          standOn(ped.tile, {
            tolerance: 3,
            until: (r) => {
              const st = r.mech('mirrorRunes');
              return st.type === 'runePuzzle' && (st.active || st.progress >= i);
            },
            maxMs: 120000,
            label: `rune ${i} : à son poste`,
          }),
          pressInteract({
            expect: (r) => {
              const st = r.mech('mirrorRunes');
              return st.type === 'runePuzzle' && (st.active || st.progress >= i + 1);
            },
            settleMs: 250,
            retries: 0,
            label: `rune ${def.sequence[i]}`,
          }),
        );
      }
    }
    // 4. la porte s'ouvre : embuscade de la rive est, puis sortie
    run.queueEach(() => [
      waitUntil(conds.mechActive('mirrorDoor'), 240000, { label: 'porte du miroir' }),
      enterZone([62, 22]),
      clearStage(),
      ...exitWhenReady(),
    ]);
  },
  { maxMs: 480000 },
);

const sluiceScript = roomScript(
  'sluice',
  (run) => {
    const pump = run.mechTile('sluicePlatePump');
    const tide = run.mechTile('sluicePlateTide');
    // le bloc est poussé à deux (seul à 1 joueur) ; les autres défendent le hall ouest puis attendent le socle rempli
    const pushers = run.pushBlockTogether('sluiceBlock', 'right', 30);
    for (const b of run.bots) {
      if (!pushers.includes(b.id)) run.queue(b.id, waitUntil(conds.mechActive('sluiceSocket'), 240000, { label: 'socle rempli' }));
    }
    // socle rempli : pompe (slot 0) et marée (slot 1) tenues ensemble (plaques près du hall : les gardiens des galeries se battent sur place)
    run.queueForSlot(0, holdPlate(pump, conds.mechActive('sluiceDoor')));
    if (run.playerCount >= 2) run.queueForSlot(1, holdPlate(tide, conds.mechActive('sluiceDoor')));
    // porte ouverte : les gardiens de l'est, puis sortie
    run.queueEach(() => [waitUntil(conds.mechActive('sluiceDoor'), 240000, { label: "porte de l'écluse" }), clearAll(), ...exitWhenReady()]);
  },
  { maxMs: 480000 },
);

const choirScript = roomScript(
  'choir',
  (run, info) => {
    // trois vagues (bandes pleine hauteur) : on avance de bande en bande en vainquant chaque vague
    run.queueEach(() => [enterZone([17, 26]), clearStage(), enterZone([27, 26]), clearStage(), enterZone([35, 26]), clearStage()]);
    // chacun s'annonce près de SON levier puis tire dans la fenêtre
    for (const s of slots(run)) {
      const lever = `choirLever${COLOR[s]}`;
      run.queueForSlot(s, goNear((r) => r.mechTile(lever), { radius: 12 }), barrier(`choir:${info.attempt}`, run.playerCount, 120000), pullLever(lever));
    }
    run.queueEach(() => exitWhenReady());
  },
  { maxMs: 480000 },
);

const stormdeckScript = roomScript(
  'stormdeck',
  (run) => {
    run.queueEach(() => [withSpecial(clearAll(420000)), ...exitWhenReady()]);
  },
  { maxMs: 480000 },
);

const glassheartScript = roomScript(
  'glassheart',
  (run) => {
    run.queueEach(() => [withSpecial(clearAll(420000)), ...exitWhenReady()]);
  },
  { maxMs: 480000 },
);

/** Tous les scripts du niveau 7, dans l'ordre des salles. */
export function level7Scripts(): RoomScript[] {
  return [shoalScript, pearlcaveScript, dykeScript, mirrorpoolsScript, sluiceScript, choirScript, stormdeckScript, glassheartScript];
}

/** Options de partie pour n joueurs (difficulté 2, graine fixe). */
export function level7RunOptions(n: number, seed = 7) {
  return {
    playerCount: n,
    characters: LEVEL7_CHARACTERS[n],
    difficulties: Array.from({ length: n }, () => LEVEL7_DIFFICULTY[n] ?? 2),
    seed,
  };
}

/** Nouvelle partie de bots sur le niveau 7. */
export function newLevel7Run(n: number, opts: { seed?: number; startRoomIndex?: number } = {}): BotRun {
  return new BotRun(level7, { ...level7RunOptions(n, opts.seed ?? 7), startRoomIndex: opts.startRoomIndex });
}

/** Partie SOLO sur la seule salle du boss final (défaut : `LEVEL7_SOLO_BOSS`). */
export function newLevel7SoloBossRun(opts: { seed?: number; character?: CharacterId; difficulty?: Difficulty } = {}): BotRun {
  return new BotRun(level7, {
    playerCount: 1,
    characters: [opts.character ?? LEVEL7_SOLO_BOSS.character],
    difficulties: [opts.difficulty ?? LEVEL7_SOLO_BOSS.difficulty],
    seed: opts.seed ?? 7,
    startRoomIndex: level7.rooms.length - 1,
  });
}

/** Joue le niveau 7 de bout en bout pour n joueurs. */
export function solveLevel7(
  n: number,
  opts: { seed?: number; startRoomIndex?: number; level?: LevelRunOptions } = {},
): { run: BotRun; result: LevelRunResult } {
  const run = newLevel7Run(n, opts);
  const result = runLevelScripts(run, level7Scripts(), { maxTotalMs: 20 * 60 * 1000, maxRoomMs: 240000, maxWipesPerRoom: 4, ...(opts.level ?? {}) });
  return { run, result };
}
