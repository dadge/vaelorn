/**
 * Solution scriptée du niveau 4 (« Les Cavernes de Givre »), jouée par les bots de `botKit` sur la VRAIE simulation.
 *
 * Uniquement des `ActionFrame` (via les actions de `botActions.ts` et les primitives de statues de `novelBots.ts`) : aucune
 * écriture dans `sim.state`. Stratégie COOPÉRATIVE voulue par le niveau :
 *  - threshold   : le joueur 0 tient le socle A (tourne la statue B), le joueur 1 le socle B (tourne la statue A) ; en solo,
 *                  allers-retours entre les deux socles ; puis sortie ;
 *  - gallery     : chaque héros tient SA plaque de couleur (simultanément) → herse ; on nettoie la galerie puis sortie ;
 *  - echoes      : socles tenus par les joueurs 0 et 1 sous les vagues, le héros du slot 2 tient le cairn 8 s, puis on achève
 *                  les trois vagues ;
 *  - warden1     : tous contre le gardien de givre et sa meute (le héros du slot 3 doit porter 4 coups fatals) ;
 *  - deepdark    : chaque héros allume SON brasero de couleur (anneau, salle sombre) ; la porte s'ouvre ;
 *  - spire       : chacun s'annonce près de SON levier (bout d'un bras de la croix) puis tire dans la fenêtre de 25 s ;
 *  - antechamber : socles tenus par les joueurs 0 et 1, plaques de garde tenues par les slots 2 et 3 (3-4 joueurs) ; on
 *                  bat le second gardien et sa meute ;
 *  - throne      : tous contre la Reine du Givre (et sa garde, qui grossit avec le nombre de joueurs).
 */
import { CHARACTERS } from '../core/characters';
import { isAnyBossKind } from '../core/enemies';
import { dist } from '../core/geometry';
import type { CharacterId, Difficulty, PlayerId, TileXY } from '../core/types';
import {
  BotRun,
  attackUntilClear,
  barrier,
  conds,
  custom,
  decideRevive,
  goNear,
  goTo,
  pressInteract,
  pullLever,
  roomScript,
  rotateOtherStatue,
  runLevelScripts,
  standOn,
  toExit,
  waitUntil,
  type ActionCtx,
  type BotAction,
  type Cond,
  type LevelRunOptions,
  type LevelRunResult,
  type RoomScript,
} from './botKit';
import { level4 } from '../levels/level4';

/** Personnages par nombre de joueurs : variés (mêlée / distance), solides. */
export const LEVEL4_CHARACTERS: Readonly<Record<number, readonly CharacterId[]>> = {
  1: ['david'],
  2: ['david', 'aelith'],
  3: ['david', 'aelith', 'brokk'],
  4: ['david', 'aelith', 'brokk', 'valentine'],
};

const COLOR = ['Blue', 'Red', 'Green', 'Yellow'] as const;

/** Joueurs qui « existent » pour les mécanismes par slot : le slot k n'existe pour de vrai qu'à k+1 joueurs. */
function slots(run: BotRun): number[] {
  return Array.from({ length: run.playerCount }, (_, i) => i);
}

/**
 * Attaque spéciale « raisonnable » (les bots n'en font pas d'office) : prête et (≥ 3 ennemis à portée, ou un boss/demi-boss à portée) ;
 * la soigneuse (`healNova`) ne la déclenche que si un allié vivant est sous 55 % de PV.
 */
function maybeSpecial(ctx: ActionCtx): void {
  const p = ctx.player;
  if (p.status !== 'alive' || p.specialCooldownMs > 0) return;
  const kind = CHARACTERS[p.characterId].special?.kind;
  if (!kind) return;
  if (kind === 'healNova') {
    if (ctx.run.state.players.some((a) => a.status === 'alive' && a.hp < a.maxHp * 0.55)) ctx.set({ special: true });
    return;
  }
  const reach = kind === 'arrowFan' ? 110 : 60;
  const near = ctx.run.aliveEnemies.filter((e) => dist(e.pos, p.pos) <= reach);
  if (near.length >= 3 || near.some((e) => isAnyBossKind(e.kind))) ctx.set({ special: true });
}

/** Combat jusqu'à ce que la salle soit entièrement nettoyée (ennemis vivants ET apparitions en attente, vagues comprises). */
function clearAll(maxMs = 300000): BotAction {
  return custom('clearAll', () => {
    let inner = attackUntilClear({ maxMs, stallMs: 20000 }).create();
    return {
      tick(ctx) {
        if (ctx.run.requirementMet('clear')) return 'done';
        if (ctx.elapsedMs > maxMs) return ctx.fail(`salle non nettoyée après ${maxMs} ms : ${ctx.run.describeEnemies(ctx.run.aliveEnemies)}`);
        const st = inner.tick(ctx);
        if (st === 'failed') return 'failed';
        maybeSpecial(ctx);
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
 * Tient une tuile (plaque) jusqu'à `until`, mais quitte son poste pour relever un allié à terre quand c'est possible (sans quoi
 * un tenant seul debout laisserait ses alliés à terre indéfiniment) ; il retourne ensuite sur la plaque.
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
    waitUntil((run) => run.room.exit.requires.every((r) => run.requirementMet(r)), 300000, { label: 'exigences de sortie' }),
    ...toExit(),
  ];
}

/**
 * Pose dans les files les rotations d'une paire de statues : le joueur A (socle 0) tourne la statue 1, le joueur B (socle 1)
 * tourne la statue 0 ; A = B en solo (les deux actions se suivent). Pas d'attente de résolution (voir `exitWhenReady`).
 */
function queueRotations(run: BotRun, mechId: string): { a: PlayerId; b: PlayerId } {
  const a: PlayerId = 0;
  const b = (1 % run.playerCount) as PlayerId;
  run.queue(a, rotateOtherStatue(mechId, 0, { maxMs: 90000 }));
  run.queue(b, rotateOtherStatue(mechId, 1, { maxMs: 90000 }));
  return { a, b };
}

// ───────────────────────────── Salles ─────────────────────────────

const thresholdScript = roomScript('threshold', (run) => {
  queueRotations(run, 'twins');
  for (const b of run.bots) run.queue(b.id, ...exitWhenReady());
});

const galleryScript = roomScript('gallery', (run) => {
  for (const s of slots(run)) {
    const plate = run.mechTile(`plate${COLOR[s]}`);
    run.queueForSlot(s, goTo(plate), holdWithRevive(plate, conds.mechActive('galleryDoor'), 300000), clearAll(), ...exitWhenReady());
  }
});

const echoesScript = roomScript(
  'echoes',
  (run) => {
    const cairn: TileXY = [40, 24];
    queueRotations(run, 'echoPair');
    const holder = run.playerFor(2);
    for (const b of run.bots) {
      if (b.id === holder) {
        run.queue(b.id, goTo(cairn), holdWithRevive(cairn, conds.objectiveDone('hold'), 240000));
      }
      run.queue(b.id, clearAll(), ...exitWhenReady());
    }
  },
  { maxMs: 420000 },
);

const warden1Script = roomScript(
  'warden1',
  (run) => {
    for (const b of run.bots) run.queue(b.id, clearAll(), ...exitWhenReady());
  },
  { maxMs: 420000 },
);

const deepdarkScript = roomScript('deepdark', (run) => {
  for (const s of slots(run)) {
    const id = `darkBrazier${COLOR[s]}`;
    run.queueForSlot(
      s,
      goNear((r) => r.mechTile(id), { radius: 18, maxMs: 90000 }),
      pressInteract({ expect: conds.mechActive(id), settleMs: 300, retries: 3, label: `allumer ${id}` }),
      ...exitWhenReady(),
    );
  }
});

const spireScript = roomScript(
  'spire',
  (run) => {
    // On nettoie d'abord la croix tous ensemble, puis on se sépare pour tirer les quatre leviers dans la fenêtre.
    for (const b of run.bots) run.queue(b.id, clearAll());
    for (const s of slots(run)) {
      const lever = `lever${COLOR[s]}`;
      run.queueForSlot(
        s,
        goNear((r) => r.mechTile(lever), { radius: 12, maxMs: 90000 }),
        barrier('levers', run.playerCount, 120000),
        pullLever(lever),
        ...exitWhenReady(),
      );
    }
  },
  { maxMs: 420000 },
);

const antechamberScript = roomScript(
  'antechamber',
  (run) => {
    // Le gardien et sa meute d'abord (tous ensemble), puis le puzzle de la porte du trône.
    for (const b of run.bots) run.queue(b.id, clearAll());
    queueRotations(run, 'bossPair');
    const plateHolders: { id: PlayerId; plate: string }[] = [];
    if (run.playerCount >= 3) plateHolders.push({ id: run.playerFor(2), plate: 'guardPlateA' });
    if (run.playerCount >= 4) plateHolders.push({ id: run.playerFor(3), plate: 'guardPlateB' });
    for (const b of run.bots) {
      const holds = plateHolders.find((h) => h.id === b.id);
      if (holds) {
        const tile = run.mechTile(holds.plate);
        run.queue(b.id, goTo(tile), holdWithRevive(tile, conds.mechActive('bossDoor'), 300000));
      }
      run.queue(b.id, ...exitWhenReady());
    }
  },
  { maxMs: 480000 },
);

const throneScript = roomScript(
  'throne',
  (run) => {
    for (const b of run.bots) run.queue(b.id, clearAll(400000), ...exitWhenReady());
  },
  { maxMs: 480000 },
);

/** Tous les scripts du niveau 4, dans l'ordre des salles. */
export function level4Scripts(): RoomScript[] {
  return [thresholdScript, galleryScript, echoesScript, warden1Script, deepdarkScript, spireScript, antechamberScript, throneScript];
}

/** Options de partie pour n joueurs (personnages solides, difficulté 2, graine fixe). */
export function level4RunOptions(n: number, seed = 7) {
  return {
    playerCount: n,
    characters: LEVEL4_CHARACTERS[n],
    difficulties: Array.from({ length: n }, () => 2 as Difficulty),
    seed,
  };
}

/** Nouvelle partie de bots sur le niveau 4. */
export function newLevel4Run(n: number, opts: { seed?: number; startRoomIndex?: number } = {}): BotRun {
  return new BotRun(level4, { ...level4RunOptions(n, opts.seed ?? 7), startRoomIndex: opts.startRoomIndex });
}

/** Joue le niveau 4 de bout en bout pour n joueurs. */
export function solveLevel4(
  n: number,
  opts: { seed?: number; startRoomIndex?: number; level?: LevelRunOptions } = {},
): { run: BotRun; result: LevelRunResult } {
  const run = newLevel4Run(n, opts);
  const result = runLevelScripts(run, level4Scripts(), { maxTotalMs: 20 * 60 * 1000, maxRoomMs: 300000, maxWipesPerRoom: 4, ...(opts.level ?? {}) });
  return { run, result };
}

