/**
 * Solution scriptée du niveau 9 (« Le Clocher de l'Aube »), jouée par les bots de `botKit` sur la VRAIE simulation.
 *
 * Uniquement des `ActionFrame` (via les actions de `botActions.ts`) : aucune écriture dans `sim.state`.
 * Stratégie COOPÉRATIVE voulue par le niveau :
 *  - forecourt     : on vainc les rôdeurs ; à plusieurs, un héros tient la plaque pendant qu'un autre tire le levier (qui retombe en 19 s) ;
 *                    seul, il tire puis COURT à la plaque ;
 *  - gallery       : on vainc les archers/squelettes, puis LA CADENCE : chacun va à SON premier levier (le plus lointain d'abord), on se
 *                    synchronise, puis chacun tire ses leviers dans l'ordre de la galerie (de l'ouest vers la porte) ;
 *  - bellguard     : demi-boss n°1 (spécial des bots activé) ;
 *  - counterweight : trois blocs poussés l'un après l'autre sur leur plaque (à deux, ou seul à 1 joueur) ; chaque plaque appelle une vague
 *                    que toute l'équipe vainc avant le bloc suivant ;
 *  - echoorchard   : le héros rouge (slot 1) lit les runes dans la niche ; les autres frappent les piédestaux dans l'ordre PENDANT qu'il
 *                    tient la zone « mesure » 15 s (l'embuscade le vise seul un moment) ; seul, le héros enchaîne lecture, runes, mesure ;
 *  - nave          : chacun tient SA plaque de couleur (passages entre les abîmes) ;
 *  - ropehall      : demi-boss n°2 (spécial des bots activé) ;
 *  - belfry        : tous contre le seigneur du Néant (spécial des bots activé).
 * Les bots n'esquivent pas intelligemment dans les salles ordinaires ; dans les salles de demi-boss et de boss (`withSpecial`), ils lancent
 * leur attaque spéciale dès qu'elle est prête et sortent des zones de danger / esquivent les projectiles. Difficulté 2 à tous les nombres
 * de joueurs. `LEVEL9_SOLO_BOSS` / `newLevel9SoloBossRun` isolent la salle du clocher (boss final) pour les preuves en solo.
 */
import { PLAYER_RADIUS, REVIVE_RANGE } from '../core/constants';
import { ENEMY_SPECIALS } from '../core/bosses';
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
  goNear,
  goTo,
  pressInteract,
  pullLever,
  roomScript,
  runLevelScripts,
  standOn,
  toExit,
  waitUntil,
  type ActionCtx,
  type ActionRunner,
  type BotAction,
  type LevelRunOptions,
  type LevelRunResult,
  type RoomScript,
} from './botKit';
import { level9 } from '../levels/level9';

/** Personnages par nombre de joueurs : variés (mêlée / distance), solides. */
export const LEVEL9_CHARACTERS: Readonly<Record<number, readonly CharacterId[]>> = {
  1: ['david'],
  2: ['david', 'valentine'],
  3: ['david', 'valentine', 'aelith'],
  4: ['david', 'valentine', 'grok', 'aelith'],
};

/** Difficulté des bots par nombre de joueurs : 2 (normal, défaut du menu) partout, solo compris. */
export const LEVEL9_DIFFICULTY: Record<number, Difficulty> = { 1: 2, 2: 2, 3: 2, 4: 2 };

/**
 * Preuve du boss final en SOLO à la difficulté par défaut (2) : Aelith (à distance) puis David (mêlée) viennent à bout du seigneur du Néant et de
 * ses sbires depuis le début de la salle du clocher (PV pleins : la reprise après défaite se fait au début de la salle).
 */
export const LEVEL9_SOLO_BOSS: { readonly character: CharacterId; readonly difficulty: Difficulty } = { character: 'aelith', difficulty: 2 };

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
 * dès que les cercles sont verrouillés, un joueur qui se trouve dedans en sort en ligne droite.
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
 * Esquive de projectiles ennemis (boules de feu, traits sombres, anneaux, spirales) : compare le mouvement voulu par l'action et quelques
 * mouvements de remplacement sur les 0,7 s à venir (projectiles supposés en ligne droite) et garde le moins touché ; ne remplace le
 * mouvement voulu que si celui-ci mène à un impact. Réservé aux salles de demi-boss et de boss.
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
 * produite par l'action reçoit `special: true`. Réservé aux salles de demi-boss / de boss. Le bot sort aussi des zones de danger du
 * seigneur du Néant et esquive les projectiles.
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
 * Pour les salles SANS embuscade ni vague conditionnelle à venir (salles de demi-boss et de boss, galerie, nef).
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
 * Nettoie une ÉTAPE : combat jusqu'à ce qu'aucun ennemi ne soit vivant et qu'aucune apparition imminente n'attende (les embuscades et vagues
 * non déclenchées ne comptent pas : elles surgiront quand on entrera dans leur zone / posera le bloc sur la plaque).
 */
function clearStage(maxMs = 240000): BotAction {
  return custom('clearStage', () => {
    let inner = attackUntilClear({ maxMs, stallMs: 20000 }).create();
    let rescue: ActionRunner | null = null;
    return {
      tick(ctx) {
        const run = ctx.run;
        if (run.aliveEnemies.length === 0 && run.pendingSpawnCount(true) === 0) {
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
 * le relevage).
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

/** Attend que toutes les exigences de sortie de la salle soient remplies, puis va à la sortie. */
function exitWhenReady(): BotAction[] {
  return [
    reviveTeam(),
    waitUntil((run) => run.room.exit.requires.every((r) => run.requirementMet(r)), 240000, { label: 'exigences de sortie' }),
    ...toExit(),
  ];
}

// ───────────────────────────── Le parvis : levier à fenêtre puis plaque ─────────────────────────────

/**
 * Parvis : à plusieurs, le héros du slot 1 tient la plaque pendant que le héros du slot 0 tire le levier ; seul, le héros tire PUIS court
 * à la plaque (fenêtre de 19 s). Exposé pour les preuves du test d'exécution.
 */
function forecourtScript(): RoomScript {
  return roomScript('forecourt', (run, info) => {
    run.queueEach(() => [clearAll(300000), barrier(`forecourt:${info.attempt}`, run.playerCount, 240000)]);
    const plate = run.mechTile('forecourtPlate');
    const puller = run.playerFor(0);
    const holder = run.playerFor(1);
    if (holder !== puller) {
      run.queue(holder, goTo(plate), standOn(plate, { until: conds.mechActive('forecourtDoor') }));
      run.queue(puller, waitUntil(conds.mechActive('forecourtPlate'), 120000, { label: 'plaque tenue' }), pullLever('forecourtLever'));
    } else {
      // seul : tirer puis courir à la plaque dans la fenêtre
      run.queue(puller, pullLever('forecourtLever'), standOn(plate, { until: conds.mechActive('forecourtDoor') }));
    }
    run.queueEach(() => exitWhenReady());
  });
}

// ───────────────────────────── La galerie : la cadence ─────────────────────────────

/** Leviers de la galerie dans l'ordre de la galerie (de l'ouest, le plus lointain, vers la porte) et propriétaire (slot) ; `null` : sans propriétaire. */
export const GALLERY_LEVERS: readonly { id: string; slot: number | null; bearer: number }[] = [
  { id: 'galleryLeverA', slot: null, bearer: 0 },
  { id: 'galleryLeverRed', slot: 1, bearer: 1 },
  { id: 'galleryLeverBlue', slot: 0, bearer: 0 },
  { id: 'galleryLeverGreen', slot: 2, bearer: 2 },
  { id: 'galleryLeverB', slot: null, bearer: 1 },
  { id: 'galleryLeverYellow', slot: 3, bearer: 3 },
];

/** Met dans les files le relais de la galerie : chaque joueur va à son premier levier, rendez-vous, puis tire les siens dans l'ordre de la galerie. */
export function queueCadence(run: BotRun, attempt: number): void {
  const byPlayer = new Map<PlayerId, string[]>();
  for (const l of GALLERY_LEVERS) {
    const who = run.playerFor(l.bearer);
    byPlayer.set(who, [...(byPlayer.get(who) ?? []), l.id]);
  }
  for (const b of run.bots) {
    const mine = byPlayer.get(b.id) ?? [];
    // premier levier existant de ce joueur (les leviers waived n'existent pas à ce nombre de joueurs)
    const first = mine.find((id) => !run.mech(id).waived);
    const steps: BotAction[] = [];
    if (first) steps.push(goNear((r) => r.mechTile(first), { radius: 14 }));
    steps.push(barrier(`cadence:${attempt}`, run.playerCount, 240000));
    for (const id of mine) steps.push(pullLever(id));
    run.queue(b.id, steps);
  }
}

const galleryScript = roomScript(
  'gallery',
  (run, info) => {
    run.queueEach(() => clearAll(300000));
    queueCadence(run, info.attempt);
    run.queueEach(() => exitWhenReady());
  },
  { maxMs: 360000 },
);

// ───────────────────────────── Les contrepoids : blocs et vagues ─────────────────────────────

const counterweightScript = roomScript(
  'counterweight',
  (run, info) => {
    run.queueEach(() => clearStage());
    ['A', 'B', 'C'].forEach((name, i) => {
      const block = run.mechDef(`counterweightBlock${name}`);
      const plate = run.mechDef(`counterweightPlate${name}`);
      if (block.type !== 'block' || plate.type !== 'plate') throw new Error('contrepoids : bloc et plaque attendus');
      run.pushBlockTogether(`counterweightBlock${name}`, 'right', plate.tile[0] - block.tile[0] - 1); // le bloc 2×2 couvre la plaque quand son coin est une tuile avant elle
      // les pousseurs ont fini : toute l'équipe se retrouve, puis vainc la vague de la plaque
      run.queueEach(() => [barrier(`cw${i}:${info.attempt}`, run.playerCount, 240000), clearStage(300000)]);
    });
    run.queueEach(() => [waitUntil(conds.mechActive('counterweightDoor'), 120000, { label: 'porte des contrepoids' }), ...exitWhenReady()]);
  },
  { maxMs: 420000 },
);

// ───────────────────────────── Le verger : runes puis mesure ─────────────────────────────

/** Tient la zone `zoneTile` jusqu'à ce que `done` soit vrai : combat tout ennemi vivant (la zone ne compte que quand on y est), puis revient s'y tenir. */
function holdZone(zoneTile: TileXY, done: (run: BotRun) => boolean): BotAction {
  return custom('tenir la zone', () => {
    let fight = attackUntilClear({ maxMs: 300000, stallMs: 20000 }).create();
    let stand = standOn(zoneTile, { tolerance: 8, until: done, maxMs: 300000, label: 'tenir la mesure' }).create();
    return {
      tick(ctx) {
        if (done(ctx.run)) return 'done';
        if (ctx.run.aliveEnemies.length > 0) {
          const st = fight.tick(ctx);
          if (st === 'failed') return 'failed';
          if (st === 'done') fight = attackUntilClear({ maxMs: 300000, stallMs: 20000 }).create();
          unstick(ctx);
          return 'running';
        }
        const st = stand.tick(ctx);
        if (st === 'failed') return 'failed';
        if (st === 'done') return 'done';
        return 'running';
      },
    };
  });
}

const echoorchardScript = roomScript(
  'echoorchard',
  (run, info) => {
    const def = run.mechDef('orchardRunes');
    if (def.type !== 'runePuzzle') throw new Error('orchardRunes attendu');
    const seer: PlayerId = run.playerFor(def.visibleToSlot);
    const holder: PlayerId = run.playerFor(1);
    let read = false;
    run.queueEach(() => [clearStage(300000), barrier(`orchard:${info.attempt}`, run.playerCount, 240000)]);
    // Le voyant lit la séquence dans la niche.
    run.queue(
      seer,
      goTo(def.displayTile, { label: 'goTo(niche des runes)' }),
      act(() => {
        read = true;
      }, 'lecture de la séquence'),
    );
    // Les autres (ou le voyant seul) frappent les piédestaux dans l'ordre dicté.
    const actuators: PlayerId[] = run.playerCount === 1 ? [seer] : run.bots.map((b) => b.id).filter((id) => id !== seer);
    const stepsOf = new Map<PlayerId, number[]>();
    def.sequence.forEach((_, i) => {
      const who = actuators[i % actuators.length];
      stepsOf.set(who, [...(stepsOf.get(who) ?? []), i]);
    });
    for (const who of actuators) {
      const steps = stepsOf.get(who) ?? [];
      if (steps.length === 0) continue;
      for (const i of steps) {
        const ped = def.pedestals.find((q) => q.symbol === def.sequence[i]);
        if (!ped) throw new Error(`piédestal ${def.sequence[i]} introuvable`);
        run.queue(
          who,
          waitUntil(
            (r) => {
              const st = r.mech('orchardRunes');
              return read && st.type === 'runePuzzle' && (st.active || st.progress >= i);
            },
            180000,
            { label: `rune ${i} : attendre la lecture / la précédente` },
          ),
          goTo(ped.tile, { tolerance: 3 }),
          waitUntil(
            (r) => {
              const st = r.mech('orchardRunes');
              return st.type === 'runePuzzle' && (st.active || st.progress >= i);
            },
            180000,
            { label: `rune ${i} : à son poste` },
          ),
          pressInteract({
            expect: (r) => {
              const st = r.mech('orchardRunes');
              return st.type === 'runePuzzle' && (st.active || st.progress >= i + 1);
            },
            settleMs: 250,
            retries: 0,
            label: `rune ${def.sequence[i]}`,
          }),
        );
      }
    }
    // Tenir la mesure : le héros rouge dans la zone (objectif), les autres l'entourent et défendent.
    const zoneC: TileXY = [23, 24];
    for (const b of run.bots) {
      // À plusieurs, le héros rouge tient la mesure PENDANT que les autres jouent les runes (l'embuscade le vise seul un moment) ; seul, il enchaîne.
      const mine: BotAction[] = b.id === holder && run.playerCount > 1 ? [] : [waitUntil(conds.mechActive('orchardRunes'), 240000, { label: 'runes jouées' })];
      if (b.id === holder) mine.push(holdZone(zoneC, (r) => r.requirementMet('obj:measure')));
      else mine.push(goNear(zoneC, { radius: 140 }), clearStage(300000), waitUntil((r) => r.requirementMet('obj:measure'), 240000, { label: 'mesure tenue' }));
      run.queue(b.id, mine);
    }
    run.queueEach(() => [clearAll(300000), ...exitWhenReady()]);
  },
  { maxMs: 480000 },
);

// ───────────────────────────── La nef : plaques de couleur ─────────────────────────────

const naveScript = roomScript(
  'nave',
  (run, info) => {
    run.queueEach(() => [clearAll(300000), barrier(`nave:${info.attempt}`, run.playerCount, 240000)]);
    for (const s of slots(run)) {
      const plate = run.mechTile(`navePlate${COLOR[s]}`);
      run.queueForSlot(s, goTo(plate), standOn(plate, { until: conds.mechActive('naveDoor') }));
    }
    run.queueEach(() => exitWhenReady());
  },
  { maxMs: 420000 },
);

// ───────────────────────────── Arènes de demi-boss et de boss ─────────────────────────────

const bellguardScript = roomScript(
  'bellguard',
  (run) => {
    run.queueEach(() => [withSpecial(clearAll(360000)), ...exitWhenReady()]);
  },
  { maxMs: 420000 },
);

const ropehallScript = roomScript(
  'ropehall',
  (run) => {
    run.queueEach(() => [withSpecial(clearAll(360000)), ...exitWhenReady()]);
  },
  { maxMs: 420000 },
);

const belfryScript = roomScript(
  'belfry',
  (run) => {
    run.queueEach(() => [withSpecial(clearAll(420000)), ...exitWhenReady()]);
  },
  { maxMs: 480000 },
);

/** Tous les scripts du niveau 9, dans l'ordre des salles. */
export function level9Scripts(): RoomScript[] {
  return [forecourtScript(), galleryScript, bellguardScript, counterweightScript, echoorchardScript, naveScript, ropehallScript, belfryScript];
}

/** Options de partie pour n joueurs (personnages solides, difficulté 2, graine fixe). */
export function level9RunOptions(n: number, seed = 7) {
  return {
    playerCount: n,
    characters: LEVEL9_CHARACTERS[n],
    difficulties: Array.from({ length: n }, () => LEVEL9_DIFFICULTY[n] ?? 2),
    seed,
  };
}

/** Nouvelle partie de bots sur le niveau 9. */
export function newLevel9Run(n: number, opts: { seed?: number; startRoomIndex?: number } = {}): BotRun {
  return new BotRun(level9, { ...level9RunOptions(n, opts.seed ?? 7), startRoomIndex: opts.startRoomIndex });
}

/**
 * Partie SOLO sur la seule salle du clocher (boss final), à la difficulté et avec le personnage donnés (défaut : `LEVEL9_SOLO_BOSS`).
 * Les objectifs des salles précédentes sont considérés accomplis (comme pour tout `startRoomIndex`).
 */
export function newLevel9SoloBossRun(opts: { seed?: number; character?: CharacterId; difficulty?: Difficulty } = {}): BotRun {
  return new BotRun(level9, {
    playerCount: 1,
    characters: [opts.character ?? LEVEL9_SOLO_BOSS.character],
    difficulties: [opts.difficulty ?? LEVEL9_SOLO_BOSS.difficulty],
    seed: opts.seed ?? 7,
    startRoomIndex: level9.rooms.length - 1,
  });
}

/** Joue le niveau 9 de bout en bout pour n joueurs. */
export function solveLevel9(
  n: number,
  opts: { seed?: number; startRoomIndex?: number; level?: LevelRunOptions } = {},
): { run: BotRun; result: LevelRunResult } {
  const run = newLevel9Run(n, opts);
  const result = runLevelScripts(run, level9Scripts(), { maxTotalMs: 20 * 60 * 1000, maxRoomMs: 240000, maxWipesPerRoom: 4, ...(opts.level ?? {}) });
  return { run, result };
}
