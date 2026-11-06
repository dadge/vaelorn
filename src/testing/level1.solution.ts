/**
 * SOLUTION du niveau 1 « Les Cryptes Oubliées » : scripts de résolution par salle pour les bots (`botKit`), à 1..4 joueurs.
 *
 * Ces scripts n'écrivent QUE des `ActionFrame` (via les actions de `botKit`) : aucune écriture dans `sim.state`. Ils appliquent
 * la vraie stratégie coopérative décrite dans l'en-tête de `src/levels/level1.ts` :
 *
 *  - vestibule    : un héros actionne le levier `lv1` (herse `d1`), tous vainquent la salle (`clear`) puis rejoignent la sortie ;
 *  - plates       : plaque A tenue par le slot 0, plaque B (min 2 joueurs) par le slot 1, simultanément, jusqu'à l'ouverture de `d2` ;
 *  - cells        : chaque slot réel ramasse SA clé (`k<slot>`) puis ouvre SA porte (`kd<slot>`) ;
 *  - ossuary      : levier `lv4` (vagues), élimination de tout (`clear`), objectif `o_kills` du slot 3 (voir `ossuaryKillPolicy`) ;
 *  - antechamber  : chaque slot son levier (fenêtre effective ×ceil(4/n)) ;
 *  - seal         : le propriétaire de `o_zone` (slot 1) tient le cercle 6 s cumulées, les autres le protègent ; sortie scellée.
 *
 * Braseros : les braseros ÉTEINTS exigés par une porte ou la sortie (`requires`) sont allumés (`interact`, torche non vide) ;
 * les autres sont ignorés (les braseros sont des obstacles solides, le chemin les évite). En salle sombre la torche n'affecte
 * que la visibilité : rien d'autre à faire pour les bots.
 */
import { TILE } from '../core/constants';
import type { ActionFrame, CharacterId, LevelDef, MechanismDef, PlayerId, RoomDef, Vec2 } from '../core/types';
import {
  BotRun,
  attackUntilClear,
  conds,
  custom,
  decideCombat,
  decideRevive,
  goNear,
  goTo,
  pickUpKey,
  pressInteract,
  pullLever,
  roomScript,
  say,
  seq,
  standOn,
  toExit,
  unless,
  useKey,
  wait,
  waitUntil,
  type ActionCtx,
  type ActionRunner,
  type BotAction,
  type BotRunOptions,
  type Cond,
  type RoomScript,
} from './botKit';

// ───────────────────────────── Configuration de partie ─────────────────────────────

/**
 * Personnages utilisés (par slot) : mêlée lourde (David, Brokk) + distance (Aelith) + éclaireur (Romain). « Variés mais solides » :
 * aucun personnage ultra-fragile (Sandrine, résistance 2, est évitée ici ; elle est couverte par une variante dans le test).
 */
export const LEVEL1_CHARACTERS: readonly CharacterId[] = ['david', 'aelith', 'brokk', 'romain'];

/** Graine par défaut (déterminisme). */
export const LEVEL1_SEED = 7;

/** Crée la partie de bots du niveau 1 (difficulté 2 pour tous, graine fixe). */
export function newLevel1Run(level: LevelDef, playerCount: number, opts: Partial<BotRunOptions> = {}): BotRun {
  return new BotRun(level, {
    playerCount,
    characters: LEVEL1_CHARACTERS,
    difficulties: [2, 2, 2, 2],
    seed: LEVEL1_SEED,
    ...opts,
  });
}

// ───────────────────────────── Actions utilitaires ─────────────────────────────

/** Les 4 slots de la couleur, dans l'ordre. */
const SLOTS = [0, 1, 2, 3] as const;

/**
 * Contournement d'une limite de `botKit` (voir engineBugs) : le tireur qui s'ALIGNE sur sa cible (`engageRanged`) avance en ligne
 * droite sans détection de blocage ; un pilier sur sa route le fige indéfiniment. Ici : si une frame de combat réclame un
 * déplacement mais que le joueur n'a pas bougé depuis ~1,2 s, il rejoint la cible la plus proche PAR LE PLANIFICATEUR
 * (`PathFollower`) pendant ~3 s puis reprend le combat normal.
 */
class Unstick {
  private lastX = NaN;
  private lastY = NaN;
  private stillMs = 0;
  private approachMs = 0;

  /** Retourne la frame à jouer (celle du combat, ou une frame d'approche par chemin). */
  apply(ctx: ActionCtx, frame: ActionFrame): ActionFrame {
    const p = ctx.player;
    const wantsMove = !frame.attack && Math.hypot(frame.moveX, frame.moveY) > 0.5;
    const moved = Math.hypot(p.pos.x - this.lastX, p.pos.y - this.lastY) > 0.4;
    this.lastX = p.pos.x;
    this.lastY = p.pos.y;
    if (wantsMove && !moved) this.stillMs += ctx.dtMs;
    else if (this.approachMs <= 0) this.stillMs = 0;
    if (this.approachMs > 0 || this.stillMs > 1200) {
      if (this.approachMs <= 0) {
        this.approachMs = 3000;
        this.stillMs = 0;
      }
      this.approachMs -= ctx.dtMs;
      let best = null as { pos: Vec2; d: number } | null;
      for (const e of ctx.run.aliveEnemies) {
        const d = Math.hypot(e.pos.x - p.pos.x, e.pos.y - p.pos.y);
        if (best === null || d < best.d) best = { pos: e.pos, d };
      }
      if (best) {
        const r = ctx.bot.follower.follow(ctx.bot, { pos: best.pos, tolerance: 1, near: 40, avoidEnemies: false, replanMs: 300 });
        if (r.status === 'moving') return { ...frame, moveX: r.vec.x, moveY: r.vec.y, attack: false };
      }
    }
    return frame;
  }
}

/**
 * Combat « jusqu'à ce que la salle soit vide » : comme `attackUntilClear` mais ne se termine que lorsque l'exigence `clear`
 * (ennemis vivants + apparitions en attente applicables) est satisfaite, en attendant patiemment les vagues suivantes.
 * Relève les alliés à terre quand aucune cible n'est atteignable. Échoue si des ennemis vivants restent inaccessibles
 * `stallMs`, ou après `maxMs`.
 */
export function clearRoom(opts: { maxMs?: number; stallMs?: number } = {}): BotAction {
  return custom('clearRoom', () => {
    let stall = 0;
    const unstick = new Unstick();
    return {
      tick(ctx) {
        const run = ctx.run;
        if (run.requirementMet('clear')) return 'done';
        const left = run.aliveEnemies;
        if (ctx.elapsedMs > (opts.maxMs ?? 240000)) {
          return ctx.fail(`salle non vidée après ${opts.maxMs ?? 240000} ms : ${run.describeEnemies(left)} (+ ${run.pendingSpawnCount(false)} apparition(s) en attente)`);
        }
        if (ctx.player.revivingId !== null) {
          const r = decideRevive(ctx.bot);
          if (r) {
            stall = 0;
            ctx.set(r);
            return 'running';
          }
        }
        if (left.length > 0) {
          const c = decideCombat(ctx.bot, { mode: 'chase', radius: Infinity });
          if (c) {
            stall = 0;
            ctx.set(unstick.apply(ctx, c.frame));
            return 'running';
          }
        }
        const r = decideRevive(ctx.bot);
        if (r) {
          stall = 0;
          ctx.set(r);
          return 'running';
        }
        if (left.length > 0) {
          stall += ctx.dtMs;
          if (stall >= (opts.stallMs ?? 20000)) {
            return ctx.fail(`aucun ennemi accessible depuis ${opts.stallMs ?? 20000} ms : ${run.describeEnemies(left)}`);
          }
        }
        ctx.set({});
        return 'running';
      },
    };
  });
}

/** Allume le brasero `id` (va à portée, `interact`, vérifie qu'il est actif). Sans effet s'il est déjà allumé ou neutralisé. */
export function lightBrazier(id: string): BotAction {
  const lit: Cond = (run) => run.mechSolved(id);
  return seq(
    `lightBrazier(${id})`,
    unless(
      lit,
      seq(
        `lightBrazier(${id})/do`,
        goNear((run) => run.mechTile(id), { radius: 14 }),
        pressInteract({ expect: lit, settleMs: 300, retries: 3, label: `pressInteract(${id})` }),
      ),
    ),
  );
}

/**
 * Leviers À FENÊTRE : tient ces leviers actifs jusqu'à ce que `done` soit vrai. Chaque fois qu'un des leviers (de ce joueur) est
 * retombé (fenêtre expirée), le joueur retourne le réactiver ; tant que tous sont actifs, il attend à côté (combat de fond).
 * C'est ce que font des joueurs humains quand un coéquipier a été retardé (à terre, combat) : on re-tire sa manette.
 */
export function leversUntil(ids: readonly string[], done: Cond, opts: { maxMs?: number } = {}): BotAction {
  return custom(`leversUntil(${ids.join(',')})`, () => {
    let inner: ActionRunner | null = null;
    return {
      tick(ctx) {
        const run = ctx.run;
        if (done(run)) return 'done';
        if (ctx.elapsedMs > (opts.maxMs ?? 240000)) return ctx.fail(`leviers ${ids.join(',')} : porte jamais ouverte après ${opts.maxMs ?? 240000} ms`);
        if (inner === null) {
          const pending = ids.find((id) => !run.mechSolved(id));
          if (pending === undefined) {
            if (!ctx.useBackground({ regroup: false })) ctx.set({});
            return 'running';
          }
          inner = pullLever(pending).create();
        }
        const st = inner.tick(ctx);
        if (st === 'running') return 'running';
        inner = null;
        return st === 'failed' ? 'failed' : 'running';
      },
    };
  });
}

/** Braseros éteints qu'une porte de la salle ou sa sortie EXIGE (jetons `requires`), à allumer pour progresser. */
function requiredBraziers(room: RoomDef): Extract<MechanismDef, { type: 'brazier' }>[] {
  const needed = new Set<string>(room.exit.requires);
  for (const m of room.mechanisms) if (m.type === 'door') for (const r of m.requires) needed.add(r);
  const out: Extract<MechanismDef, { type: 'brazier' }>[] = [];
  for (const m of room.mechanisms) if (m.type === 'brazier' && !m.lit && needed.has(m.id)) out.push(m);
  return out;
}

/**
 * Prélude générique : répartit l'allumage des braseros exigés entre les joueurs (respecte `ownerSlot`), puis chacun attend
 * qu'ils soient tous allumés. Sans effet s'il n'y en a aucun.
 */
function queueRequiredBraziers(run: BotRun): void {
  const list = requiredBraziers(run.room);
  if (list.length === 0) return;
  list.forEach((b, i) => {
    const owner: PlayerId = b.ownerSlot !== undefined ? run.playerFor(b.ownerSlot) : ((i % run.playerCount) as PlayerId);
    run.queue(owner, lightBrazier(b.id));
  });
  run.queueEach(() => waitUntil(conds.requirements(list.map((b) => b.id)), 120000, { label: 'braseros exigés allumés' }));
}

/** Tous : attendre une exigence puis rejoindre la sortie. */
function thenExit(run: BotRun, ready: Cond | null, label: string, maxWaitMs = 150000): void {
  run.queueEach(() => [...(ready ? [waitUntil(ready, maxWaitMs, { label })] : []), ...toExit()]);
}

// ───────────────────────────── Politique de l'objectif « kills » (ossuaire) ─────────────────────────────

/**
 * Objectif `o_kills` (slot 3, 2 coups fatals dans l'ossuaire) : la sortie exige `clear` ET cet objectif. Si les AUTRES joueurs
 * tuent tout avant que le propriétaire ait ses 2 coups fatals, la salle est verrouillée (voir levelBugs).
 *  - `'natural'`      : tout le monde chasse tout (comportement naïf) ;
 *  - `'ownerFirst'`   : tant que `o_kills` n'est pas accompli, les autres joueurs ne frappent QUE les ennemis qui s'approchent
 *                       à portée de réaction (garde du propriétaire), alors que le propriétaire chasse activement. C'est ce que
 *                       fait une équipe humaine coordonnée (« laisse-lui les 2 derniers »).
 *  - `'ownerLast'`    : comme 'ownerFirst' mais les autres se retiennent de tuer quand il ne reste que `reserve` ennemis (le
 *                       propriétaire n'a pas fini) : empêche explicitement le verrou.
 */
export type OssuaryKillPolicy = 'natural' | 'ownerFirst' | 'ownerLast';

/** Politique par défaut des scripts. */
export const DEFAULT_OSSUARY_POLICY: OssuaryKillPolicy = 'ownerLast';

/** Nombre d'ennemis vivants (ou à venir) en dessous duquel les non-propriétaires cessent de tuer (politique 'ownerLast'). */
const OWNER_RESERVE = 2;

/**
 * Combat d'un NON-propriétaire de `o_kills` : chasse tout, mais quand l'objectif n'est pas accompli et qu'il ne reste que peu
 * d'ennemis (et plus aucune apparition en attente), il se retient (reste passif près du propriétaire) pour lui laisser les
 * coups fatals. Les comportements défensifs (esquive) restent ceux du combat standard.
 */
function supportClear(objectiveId: string, policy: OssuaryKillPolicy): BotAction {
  return custom('supportClear', () => {
    let stall = 0;
    const unstick = new Unstick();
    return {
      tick(ctx) {
        const run = ctx.run;
        if (run.requirementMet('clear')) return 'done';
        const done = conds.objectiveDone(objectiveId)(run);
        const left = run.aliveEnemies;
        const pending = run.pendingSpawnCount(false);
        if (ctx.elapsedMs > 240000) return ctx.fail(`salle non vidée : ${run.describeEnemies(left)}`);
        if (ctx.player.revivingId !== null) {
          const r = decideRevive(ctx.bot);
          if (r) {
            ctx.set(r);
            return 'running';
          }
        }
        // Retenue : plus de vagues à venir, peu d'ennemis, objectif d'un autre pas accompli.
        const holdBack = policy === 'ownerLast' && !done && pending === 0 && left.length <= OWNER_RESERVE;
        if (left.length > 0 && !holdBack) {
          const radius = policy === 'ownerFirst' && !done ? ctx.bot.opts.reactRadius * 2.5 : Infinity;
          const c = decideCombat(ctx.bot, { mode: 'chase', radius });
          if (c) {
            stall = 0;
            ctx.set(unstick.apply(ctx, c.frame));
            return 'running';
          }
        }
        const r = decideRevive(ctx.bot);
        if (r) {
          ctx.set(r);
          return 'running';
        }
        if (holdBack) {
          // Défense minimale : ne frappe que si un ennemi est au contact (sinon il blesserait sans cesse).
          const c = decideCombat(ctx.bot, { mode: 'inPlace' });
          // L'ennemi au contact : on ne le tue pas s'il est parmi les dernières réserves ; on esquive simplement.
          void c;
          ctx.set({});
          return 'running';
        }
        if (left.length > 0) {
          stall += ctx.dtMs;
          if (stall >= 25000) return ctx.fail(`aucun ennemi accessible : ${run.describeEnemies(left)}`);
        }
        ctx.set({});
        return 'running';
      },
    };
  });
}

// ───────────────────────────── Scripts de salles ─────────────────────────────

/** Options des scripts de niveau. */
export interface Level1ScriptOptions {
  /** Politique de l'objectif de kills de l'ossuaire (défaut `DEFAULT_OSSUARY_POLICY`). */
  ossuaryPolicy?: OssuaryKillPolicy;
}

/**
 * Scripts de résolution du niveau 1, à passer à `runLevelScripts(run, level1Scripts())`.
 * @param opts politiques
 */
export function level1Scripts(opts: Level1ScriptOptions = {}): RoomScript[] {
  const policy = opts.ossuaryPolicy ?? DEFAULT_OSSUARY_POLICY;
  return [
    // 1. Vestibule : levier lv1 → herse d1 ; vider la salle ; sortie.
    roomScript(
      'vestibule',
      (run) => {
        queueRequiredBraziers(run);
        run.queueForSlot(0, pullLever('lv1'));
        run.queueEach(() => [
          waitUntil(conds.mechActive('d1'), 120000, { label: 'herse d1 ouverte' }),
          clearRoom(),
          ...toExit(),
        ]);
      },
      { maxMs: 240000 },
    ),

    // 2. Plaques : A (slot 0) et B (slot 1, dès 2 joueurs) tenues en même temps jusqu'à l'ouverture de d2.
    roomScript(
      'plates',
      (run) => {
        queueRequiredBraziers(run);
        const open = conds.mechActive('d2');
        run.queueForSlot(0, standOn(run.mechTile('pA'), { until: open, label: 'tenir pA' }));
        if (!run.mech('pB').waived) {
          run.queueForSlot(1, standOn(run.mechTile('pB'), { until: open, label: 'tenir pB' }));
        }
        // Les autres joueurs (3-4 joueurs) gardent le départ en attendant (combat de fond), puis tous vont à la sortie.
        for (let id = 0; id < run.playerCount; id++) {
          const holds = id === run.playerFor(0) || (!run.mech('pB').waived && id === run.playerFor(1));
          if (!holds) run.queue(id as PlayerId, waitUntil(open, 120000, { label: 'porte d2' }));
        }
        thenExit(run, open, 'porte d2');
      },
      { maxMs: 240000 },
    ),

    // 3. Cellules : chacun SA clé puis SA porte ; la sortie exige les 4 portes (neutralisées comptées).
    roomScript(
      'cells',
      (run) => {
        queueRequiredBraziers(run);
        for (const slot of SLOTS) {
          if (run.mech(`k${slot}`).waived) continue;
          run.queueForSlot(slot, pickUpKey(`k${slot}`), useKey(`kd${slot}`));
        }
        thenExit(run, conds.requirements(['kd0', 'kd1', 'kd2', 'kd3']), 'portes des cellules');
      },
      { maxMs: 300000 },
    ),

    // 4. Ossuaire (salle sombre) : levier lv4 → vagues ; tout vaincre ; o_kills du slot 3 ; sortie.
    roomScript(
      'ossuary',
      (run) => {
        queueRequiredBraziers(run);
        run.queueForSlot(0, pullLever('lv4'));
        const owner = run.playerFor(3);
        for (let id = 0; id < run.playerCount; id++) {
          const pid = id as PlayerId;
          const lead: BotAction[] = [waitUntil(conds.mechActive('lv4'), 120000, { label: 'levier lv4' })];
          if (policy === 'natural' || pid === owner) run.queue(pid, ...lead, clearRoom());
          else run.queue(pid, ...lead, supportClear('o_kills', policy));
        }
        // Le propriétaire de o_kills peut avoir fini de tout vaincre sans l'objectif : la salle est alors bloquée (verrou) ;
        // on attend l'exigence complète (clear + objectif) avant la sortie.
        thenExit(run, conds.requirements(['lv4', 'clear', 'obj:o_kills']), 'clear + o_kills', 60000);
      },
      { maxMs: 420000 },
    ),

    // 5. Antichambre : un levier par slot (fenêtre ×ceil(4/n)), puis la porte d5 et la sortie.
    roomScript(
      'antechamber',
      (run) => {
        queueRequiredBraziers(run);
        const open = conds.mechActive('d5');
        for (let id = 0; id < run.playerCount; id++) {
          const mine = SLOTS.filter((slot) => run.playerFor(slot) === id && !run.mech(`lev${slot}`).waived).map((slot) => `lev${slot}`);
          run.queue(id as PlayerId, leversUntil(mine, open));
        }
        thenExit(run, open, 'porte d5', 180000);
      },
      { maxMs: 360000 },
    ),

    // 6. Sceau : le propriétaire de o_zone tient le cercle (plaque pcirc au centre) ; les autres protègent ; sortie scellée.
    roomScript(
      'seal',
      (run) => {
        queueRequiredBraziers(run);
        const zoneOwner = run.playerFor(1);
        const done = conds.objectiveDone('o_zone');
        const circle = run.mechTile('pcirc');
        for (let id = 0; id < run.playerCount; id++) {
          const pid = id as PlayerId;
          if (pid === zoneOwner) {
            run.queue(pid, say('tient le cercle'), standOn(circle, { until: done, label: 'tenir le cercle', tolerance: 3 }));
          } else {
            // Garde rapprochée : va près du cercle, combat de fond tant que l'objectif n'est pas accompli.
            run.queue(pid, goTo(() => [circle[0] + 3 + (pid % 2) * 2, circle[1] + (pid % 3) - 1], { fightBudgetMs: 60000 }), waitUntil(done, 180000, { label: 'o_zone accompli' }));
          }
        }
        thenExit(run, done, 'o_zone', 5000);
      },
      { maxMs: 420000 },
    ),
  ];
}

/** Rappel : 1 tuile = 16 px (utile aux tests de géométrie qui importent ce module). */
export const LEVEL1_TILE_PX = TILE;

/** Temps de jeu (ms) en minutes, pour l'affichage. */
export function minutes(ms: number): string {
  return (ms / 60000).toFixed(2);
}

// Réexports utiles aux tests.
export { attackUntilClear, wait };
