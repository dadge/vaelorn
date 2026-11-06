/**
 * Solution scriptée du niveau 3 (« La Citadelle de Morvane »), jouée par les bots de `botKit` sur la VRAIE simulation.
 *
 * Uniquement des `ActionFrame` (via les actions de `botActions.ts`) : aucune écriture dans `sim.state`.
 * La stratégie est la stratégie COOPÉRATIVE voulue par le niveau :
 *  - gate     : chaque héros tient SA plaque de couleur (simultanément) → herse ; on nettoie la cour est puis sortie ;
 *  - seals    : chacun SA clé dans SA chambre, puis SA porte ;
 *  - forge    : le bloc 2×2 est poussé à deux (ou seul à 1 joueur) sur 30 tuiles jusqu'au socle ; les autres défendent ;
 *  - sanctum  : le héros du slot 1 « voit » la séquence (écran de la niche), les autres frappent les piédestaux dans l'ordre ;
 *  - balconies: chacun s'annonce près de SON levier (rendez-vous) puis tire dans la fenêtre ;
 *  - abyss    : deux héros poussent le bloc sur la plaque du fond ; le héros du slot 2 tient la plaque de l'îlot (3+ joueurs) ;
 *  - arena    : tocsin puis cinq vagues ;
 *  - dais     : le héros du slot 1 tient le dais, le slot 0 le sceau lointain (2+ joueurs), les autres protègent ;
 *  - throne   : tous contre Morvane.
 */
import type { CharacterId, Difficulty } from '../core/types';
import {
  BotRun,
  act,
  attackUntilClear,
  barrier,
  conds,
  custom,
  goNear,
  goTo,
  pickUpKey,
  pressInteract,
  pullLever,
  roomScript,
  runLevelScripts,
  standOn,
  toExit,
  useKey,
  waitUntil,
  type ActionRunner,
  type BotAction,
  type LevelRunOptions,
  type LevelRunResult,
  type RoomScript,
} from './botKit';
import { level3 } from '../levels/level3';
import type { PlayerId, TileXY } from '../core/types';

/** Personnages par nombre de joueurs : variés (mêlée / distance), solides. */
export const LEVEL3_CHARACTERS: Readonly<Record<number, readonly CharacterId[]>> = {
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
 * Combat jusqu'à ce que la salle soit entièrement nettoyée (exigence `clear` : ennemis vivants ET apparitions en attente),
 * y compris les vagues conditionnées. Ne termine que quand `clear` est vrai.
 */
function clearAll(maxMs = 240000): BotAction {
  return custom('clearAll', () => {
    let inner = attackUntilClear({ maxMs: maxMs, stallMs: 20000 }).create();
    return {
      tick(ctx) {
        if (ctx.run.requirementMet('clear')) return 'done';
        if (ctx.elapsedMs > maxMs) return ctx.fail(`salle non nettoyée après ${maxMs} ms : ${ctx.run.describeEnemies(ctx.run.aliveEnemies)}`);
        const st = inner.tick(ctx);
        if (st === 'failed') return 'failed';
        if (st === 'done') {
          inner = attackUntilClear({ maxMs: maxMs, stallMs: 20000 }).create();
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
 * Comme `clearAll`, mais retourne tenir la plaque `plate` dès qu'aucun ennemi n'est vivant alors que des apparitions attendent
 * (la vague suivante du dais est conditionnée à `daisPlate` pressée AU MOMENT où la précédente est vaincue).
 */
function clearAllHolding(plate: TileXY, maxMs = 300000): BotAction {
  return custom('clearAllHolding', () => {
    let attack = attackUntilClear({ maxMs, stallMs: 20000 }).create();
    let stand: ActionRunner | null = null;
    return {
      tick(ctx) {
        const run = ctx.run;
        if (run.requirementMet('clear')) return 'done';
        if (ctx.elapsedMs > maxMs) return ctx.fail(`salle non nettoyée après ${maxMs} ms`);
        if (run.aliveEnemies.length === 0) {
          stand ??= standOn(plate, { tolerance: 2, maxMs: 1e9, fightBudgetMs: 1e9 }).create();
          return stand.tick(ctx);
        }
        stand = null;
        const st = attack.tick(ctx);
        if (st === 'failed') return 'failed';
        if (st === 'done') {
          attack = attackUntilClear({ maxMs, stallMs: 20000 }).create();
          if (!ctx.consumed) ctx.set({});
        }
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

// ───────────────────────────── Salles ─────────────────────────────

const gateScript = roomScript('gate', (run) => {
  for (const s of slots(run)) {
    const plate = run.mechTile(`plate${COLOR[s]}`);
    run.queueForSlot(
      s,
      goTo(plate),
      standOn(plate, { until: conds.mechActive('gateDoor') }),
      clearAll(),
      ...exitWhenReady(),
    );
  }
});

const sealsScript = roomScript('seals', (run) => {
  for (const s of slots(run)) {
    const c = COLOR[s];
    run.queueForSlot(s, pickUpKey(`key${c}`), useKey(`door${c}`), ...exitWhenReady());
  }
});

const forgeScript = roomScript('forge', (run) => {
  const pushers = run.pushBlockTogether('forgeBlock', 'right', 30);
  for (const b of run.bots) {
    if (!pushers.includes(b.id)) run.queue(b.id, waitUntil(conds.mechActive('forgeSocket'), 180000, { label: 'socle rempli' }));
    run.queue(b.id, ...exitWhenReady());
  }
});

const sanctumScript = roomScript('sanctum', (run) => {
  const def = run.mechDef('sanctumRunes');
  if (def.type !== 'runePuzzle') throw new Error('sanctumRunes attendu');
  const seer: PlayerId = run.playerFor(def.visibleToSlot);
  let read = false;
  // Chaque héros allume SON brasero de couleur (la porte de la niche s'ouvre quand les quatre sont allumés).
  for (const s of slots(run)) {
    const id = `sanctumBrazier${COLOR[s]}`;
    run.queueForSlot(
      s,
      goNear((r) => r.mechTile(id), { radius: 18 }),
      pressInteract({ expect: conds.mechActive(id), settleMs: 300, retries: 3, label: `allumer ${id}` }),
    );
  }
  // Le voyant lit la séquence sur l'écran de la niche.
  run.queue(
    seer,
    waitUntil(conds.mechActive('nicheDoor'), 120000, { label: 'porte de la niche' }),
    goTo(def.displayTile, { label: 'goTo(écran des runes)' }),
    act(() => {
      read = true;
    }, 'lecture de la séquence'),
  );
  const actuators: PlayerId[] = run.playerCount === 1 ? [seer] : run.bots.map((b) => b.id).filter((id) => id !== seer);
  const myStepsByPlayer = new Map<PlayerId, number[]>();
  def.sequence.forEach((_, i) => {
    const who = actuators[i % actuators.length];
    myStepsByPlayer.set(who, [...(myStepsByPlayer.get(who) ?? []), i]);
  });
  for (const who of actuators) {
    const steps = myStepsByPlayer.get(who) ?? [];
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
            const st = r.mech('sanctumRunes');
            return st.type === 'runePuzzle' && (st.active || st.progress >= i);
          },
          maxMs: 120000,
          label: `rune ${i} : à son poste`,
        }),
        pressInteract({
          expect: (r) => {
            const st = r.mech('sanctumRunes');
            return st.type === 'runePuzzle' && (st.active || st.progress >= i + 1);
          },
          settleMs: 250,
          retries: 0,
          label: `rune ${def.sequence[i]}`,
        }),
      );
    }
  }
  for (const b of run.bots) run.queue(b.id, ...exitWhenReady());
});

const balconiesScript = roomScript('balconies', (run) => {
  for (const s of slots(run)) {
    const lever = `lever${COLOR[s]}`;
    run.queueForSlot(
      s,
      goNear((r) => r.mechTile(lever), { radius: 12 }),
      barrier('levers', run.playerCount, 120000),
      pullLever(lever),
      ...exitWhenReady(),
    );
  }
});

const abyssScript = roomScript('abyss', (run) => {
  const pushers = run.pushBlockTogether('abyssBlock', 'right', 30);
  const islandHolder = run.playerCount >= 3 ? run.playerFor(2) : null;
  for (const b of run.bots) {
    if (b.id === islandHolder) {
      const plate = run.mechTile('plateIsland');
      run.queue(b.id, goTo(plate), standOn(plate, { until: conds.mechActive('abyssDoor') }));
    } else if (!pushers.includes(b.id)) {
      run.queue(b.id, waitUntil(conds.mechActive('abyssDoor'), 240000, { label: 'porte du gouffre' }));
    }
    run.queue(b.id, ...exitWhenReady());
  }
});

const arenaScript = roomScript(
  'arena',
  (run) => {
    run.queue(0, pullLever('bell'));
    // Le héros du slot 2 (« slayer ») doit porter 3 coups fatals. Les autres le laissent chasser : tant que l'objectif n'est pas
    // accompli, ils ne font que se défendre au contact (rayon d'engagement réduit), puis ils achèvent la salle.
    const slayer = run.playerFor(2);
    const defaultEngage = run.bots[0].opts.engageRadius;
    for (const b of run.bots) {
      if (b.id !== 0) run.queue(b.id, waitUntil(conds.mechActive('bell'), 60000, { label: 'tocsin' }));
      if (b.id !== slayer) {
        run.queue(
          b.id,
          act((r) => r.setBackground(b.id, { engageRadius: 40 }), 'laisser chasser le héros du slot 2'),
          waitUntil((r) => r.requirementMet('obj:slayer') || r.requirementMet('clear'), 300000, { label: 'objectif slayer' }),
          act((r) => r.setBackground(b.id, { engageRadius: defaultEngage }), 'reprendre le combat'),
        );
      }
      run.queue(b.id, clearAll(), ...exitWhenReady());
    }
  },
  { maxMs: 360000 },
);

const daisScript = roomScript(
  'dais',
  (run) => {
    const holder = run.playerFor(1);
    const sealer = run.playerCount >= 2 ? run.playerFor(0) : null;
    const dais = run.mechTile('daisPlate');
    for (const b of run.bots) {
      if (b.id === holder) {
        run.queue(b.id, goTo(dais), standOn(dais, { until: conds.mechActive('daisDoor') }), clearAllHolding(dais));
      } else if (b.id === sealer) {
        const seal = run.mechTile('sealPlate');
        run.queue(b.id, goTo(seal), standOn(seal, { until: conds.mechActive('daisDoor') }), clearAll());
      } else {
        // protecteurs : s'installent près du dais puis chassent
        const guard: TileXY = [dais[0] - 3, dais[1] + (b.id % 2 === 0 ? 2 : -2)];
        run.queue(b.id, goTo(guard), clearAll());
      }
      run.queue(b.id, ...exitWhenReady());
    }
  },
  { maxMs: 360000 },
);

const throneScript = roomScript(
  'throne',
  (run) => {
    for (const b of run.bots) run.queue(b.id, clearAll(300000), ...exitWhenReady());
  },
  { maxMs: 420000 },
);

/** Tous les scripts du niveau 3, dans l'ordre des salles. */
export function level3Scripts(): RoomScript[] {
  return [gateScript, sealsScript, forgeScript, sanctumScript, balconiesScript, abyssScript, arenaScript, daisScript, throneScript];
}

/** Options de partie pour n joueurs (personnages solides, difficulté 2, graine fixe). */
export function level3RunOptions(n: number, seed = 7) {
  return {
    playerCount: n,
    characters: LEVEL3_CHARACTERS[n],
    difficulties: Array.from({ length: n }, () => 2 as Difficulty),
    seed,
  };
}

/** Nouvelle partie de bots sur le niveau 3. */
export function newLevel3Run(n: number, opts: { seed?: number; startRoomIndex?: number } = {}): BotRun {
  return new BotRun(level3, { ...level3RunOptions(n, opts.seed ?? 7), startRoomIndex: opts.startRoomIndex });
}

/** Joue le niveau 3 de bout en bout pour n joueurs. */
export function solveLevel3(n: number, opts: { seed?: number; startRoomIndex?: number; level?: LevelRunOptions } = {}): { run: BotRun; result: LevelRunResult } {
  const run = newLevel3Run(n, opts);
  const result = runLevelScripts(run, level3Scripts(), { maxTotalMs: 20 * 60 * 1000, maxRoomMs: 240000, maxWipesPerRoom: 4, ...(opts.level ?? {}) });
  return { run, result };
}

