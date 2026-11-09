/**
 * Mesure de l'effet des sources de vie (butin + cristaux de soin) par simulations headless de bots.
 *
 * Sert (1) au test de calibration LÉGER de la suite normale (`lootCalibration.test.ts`) et (2) au script LONG à lancer à la demande
 * (`lootCalibration.long.test.ts`, non exécuté par `npm test` : voir le README, section « calibrage mesuré »).
 *
 * ATTENTION : les bots ne sont qu'un PROXY du joueur humain. Ils n'esquivent pas vraiment (esquive simple des projectiles seulement),
 * n'utilisent pas les spéciaux (sauf niveau 5), ne choisissent pas leur moment pour se soigner : ils subissent donc plus de dégâts évitables
 * qu'un humain et ils se soignent « au plus près ». Les chiffres mesurent la DIRECTION et l'ORDRE DE GRANDEUR de l'effet, pas le ressenti réel.
 *
 * Deux modes comparés, à graine, niveau, joueurs et difficulté identiques :
 *  - `loot: false` (avant) : aucune source de vie (comportement historique des bots) ;
 *  - `loot: true` + brique `eat` (après) : nourriture au sol + cristaux, les bots ramassent ce qui est proche quand PV < 70 %.
 */
import { level1 } from '../levels/level1';
import { level2 } from '../levels/level2';
import { level3 } from '../levels/level3';
import { level4 } from '../levels/level4';
import { level5 } from '../levels/level5';
import { level6 } from '../levels/level6';
import { mostWoundedFraction } from '../core/loot';
import { createHealCrystalStates } from '../core/simulation';
import type { LevelDef, SimEvent } from '../core/types';
import { BotRun, runLevelScripts, type BackgroundOptions, type LevelRunOptions, type RoomScript } from './botKit';
import { level1Scripts, newLevel1Run } from './level1.solution';
import { createLevel2Run, level2Scripts } from './level2.solution';
import { level3Scripts, newLevel3Run } from './level3.solution';
import { level4Scripts, newLevel4Run } from './level4.solution';
import { level5Scripts, newLevel5Run } from './level5.solution';
import { level6Scripts, newLevel6Run } from './level6.solution';

/** Un niveau mesurable : fabrique de partie de bots + scripts + budgets (identiques à ceux des tests de niveau existants). */
export interface CalibLevel {
  no: number;
  level: LevelDef;
  /** Crée la partie ; `startRoomIndex` (défaut 0) : salle de départ (non supporté par le niveau 2). */
  make(n: number, seed: number, startRoomIndex?: number): BotRun;
  scripts(): RoomScript[];
  run: LevelRunOptions;
}

/** Les 6 niveaux, avec les budgets des `solveLevelN` existants. */
export const CALIB_LEVELS: readonly CalibLevel[] = [
  {
    no: 1,
    level: level1,
    make: (n, seed, startRoomIndex) => newLevel1Run(level1, n, { seed, startRoomIndex }),
    scripts: level1Scripts,
    run: { maxTotalMs: 20 * 60_000, maxRoomMs: 300000 },
  },
  {
    no: 2,
    level: level2,
    make: (n, seed, startRoomIndex) => {
      if (startRoomIndex) throw new Error('niveau 2 : salle de départ non supportée par la calibration');
      return createLevel2Run(n, { seed });
    },
    scripts: level2Scripts,
    run: { maxTotalMs: 1_200_000, maxWipesPerRoom: 4 },
  },
  {
    no: 3,
    level: level3,
    make: (n, seed, startRoomIndex) => newLevel3Run(n, { seed, startRoomIndex }),
    scripts: level3Scripts,
    run: { maxTotalMs: 20 * 60_000, maxRoomMs: 240000, maxWipesPerRoom: 4 },
  },
  {
    no: 4,
    level: level4,
    make: (n, seed, startRoomIndex) => newLevel4Run(n, { seed, startRoomIndex }),
    scripts: level4Scripts,
    run: { maxTotalMs: 20 * 60_000, maxRoomMs: 300000, maxWipesPerRoom: 4 },
  },
  {
    no: 5,
    level: level5,
    make: (n, seed, startRoomIndex) => newLevel5Run(n, { seed, startRoomIndex }),
    scripts: level5Scripts,
    run: { maxTotalMs: 20 * 60_000, maxRoomMs: 300000, maxWipesPerRoom: 4 },
  },
  {
    no: 6,
    level: level6,
    make: (n, seed, startRoomIndex) => newLevel6Run(n, { seed, startRoomIndex }),
    scripts: level6Scripts,
    run: { maxTotalMs: 20 * 60_000, maxRoomMs: 240000, maxWipesPerRoom: 4 },
  },
];

/**
 * Active les sources de vie sur une partie de bots déjà créée (les fabriques des niveaux ne passent pas `loot`) : bascule l'interrupteur de
 * l'état, recrée les cristaux de la salle courante (les salles suivantes les créent elles-mêmes) et active la brique `eat` de tous les bots
 * (`eat` : surcharge de `eatBelowFrac` / `eatRadius`, ou `eat: false` pour des bots « passifs » qui ne ramassent que par contact fortuit).
 */
export function enableLoot(run: BotRun, eat: Partial<BackgroundOptions> = {}): void {
  run.state.lootEnabled = true;
  run.state.room.healCrystals = createHealCrystalStates(run.room, run.playerCount, true);
  run.setBackground('all', { eat: true, ...eat });
}

/** Compteurs d'événements de sources de vie, cumulés sur une partie. */
export interface LootTally {
  /** Ennemis tués (tous, invoqués compris). */
  kills: number;
  /** Objets de nourriture tombés. */
  drops: number;
  /** Objets de nourriture ramassés (même à PV partiellement pleins). */
  collected: number;
  /** PV rendus par la nourriture. */
  foodHealed: number;
  /** Cristaux utilisés. */
  crystalsUsed: number;
  /** PV rendus par les cristaux. */
  crystalHealed: number;
  /** Pas de simulation observés (phase de jeu). */
  steps: number;
  /** Pas pendant lesquels le joueur vivant le plus blessé est sous 50 % de ses PV. */
  lowSteps: number;
  /** Pas pendant lesquels il est sous 25 % de ses PV (danger critique). */
  criticalSteps: number;
}

/** Résultat d'UNE partie mesurée. */
export interface CalibResult {
  level: number;
  players: number;
  seed: number;
  loot: boolean;
  completed: boolean;
  /** Durée simulée (s). */
  timeS: number;
  /** Défaites collectives. */
  wipes: number;
  /** PV perdus (somme des dégâts subis, tous joueurs). */
  hpLost: number;
  /** Dégâts subis exprimés en barres de vie complètes (somme des PV perdus / PV max moyen). */
  bars: number;
  /** Nombre de salles du niveau. */
  rooms: number;
  /** Fois à terre (tous joueurs). */
  downs: number;
  /** Défaites collectives par salle (id de salle → nombre) : où se concentrent les échecs. */
  roomWipes: Record<string, number>;
  /** Dégâts subis par salle (id de salle → PV perdus, tous joueurs). */
  roomHpLost: Record<string, number>;
  tally: LootTally;
}

/** Branche le comptage des événements sur `run.stepOnce` (sans rien modifier d'autre). */
function attachTally(run: BotRun): LootTally {
  const t: LootTally = { kills: 0, drops: 0, collected: 0, foodHealed: 0, crystalsUsed: 0, crystalHealed: 0, steps: 0, lowSteps: 0, criticalSteps: 0 };
  const inner = run.stepOnce.bind(run);
  run.stepOnce = (frames) => {
    const events: SimEvent[] = inner(frames);
    const f = mostWoundedFraction(run.state.players);
    t.steps++;
    if (f < 0.5) t.lowSteps++;
    if (f < 0.25) t.criticalSteps++;
    for (const e of events) {
      if (e.type === 'enemyDied') t.kills++;
      else if (e.type === 'pickupDropped') t.drops++;
      else if (e.type === 'pickupCollected') {
        t.collected++;
        t.foodHealed += e.healed;
      } else if (e.type === 'crystalUsed') {
        t.crystalsUsed++;
        t.crystalHealed += e.healed;
      }
    }
    return events;
  };
  return t;
}

/**
 * Joue UNE partie complète d'un niveau (bots) avec ou sans sources de vie et retourne les mesures.
 * @param calib niveau (`CALIB_LEVELS`)
 * @param n nombre de joueurs (1 à 4)
 * @param seed graine de la simulation
 * @param loot sources de vie actives (+ brique `eat`) ou non
 * @param override surcharge éventuelle des budgets (tests courts)
 * @param eat surcharge de la brique de ramassage des bots (`eatRadius`, `eatBelowFrac`)
 */
export function measureRun(
  calib: CalibLevel,
  n: number,
  seed: number,
  loot: boolean,
  override: Partial<LevelRunOptions> = {},
  eat: Partial<BackgroundOptions> = {},
): CalibResult {
  const run = calib.make(n, seed);
  if (loot) enableLoot(run, eat);
  const tally = attachTally(run);
  const res = runLevelScripts(run, calib.scripts(), { ...calib.run, ...override });
  const maxHp = run.state.players.reduce((a, p) => a + p.maxHp, 0) / Math.max(1, run.state.players.length);
  const hpLost = run.stats.players.reduce((a, p) => a + p.hpLost, 0);
  return {
    level: calib.no,
    players: n,
    seed,
    loot,
    completed: res.completed,
    timeS: res.timeMs / 1000,
    wipes: run.stats.wipes,
    hpLost,
    bars: hpLost / maxHp,
    rooms: calib.level.rooms.length,
    downs: run.stats.players.reduce((a, p) => a + p.downs, 0),
    roomWipes: Object.fromEntries(run.stats.rooms.map((r) => [r.roomId, r.wipes])),
    roomHpLost: Object.fromEntries(run.stats.rooms.map((r) => [r.roomId, r.hpLost.reduce((a, b) => a + b, 0)])),
    tally,
  };
}

/** Résultat d'UNE salle jouée isolément (voir `measureRoom`). */
export interface RoomCalibResult {
  roomId: string;
  seed: number;
  loot: boolean;
  /** La salle a été validée (la partie est allée jusqu'à la salle suivante, ou a fini le niveau). */
  cleared: boolean;
  /** Défaites collectives dans la salle. */
  wipes: number;
  /** PV perdus dans la salle (tous joueurs, toutes tentatives). */
  hpLost: number;
  tally: LootTally;
}

/**
 * Joue UNE SEULE salle d'un niveau (départ en PV pleins à l'entrée, comme dans le jeu) avec les bots, avec ou sans sources de vie : les
 * scripts des autres salles sont absents (mode `strict`), la partie s'arrête donc proprement à l'entrée de la salle suivante. Sert au test
 * de calibration léger de la suite normale (quelques secondes) ; les salles de boss solo sont celles où le butin et les cristaux comptent.
 * @param calib niveau (`CALIB_LEVELS`, pas le niveau 2)
 * @param roomId id de la salle à jouer
 */
export function measureRoom(calib: CalibLevel, n: number, seed: number, roomId: string, loot: boolean, eat: Partial<BackgroundOptions> = {}): RoomCalibResult {
  const idx = calib.level.rooms.findIndex((r) => r.id === roomId);
  if (idx < 0) throw new Error(`salle inconnue : ${roomId}`);
  const run = calib.make(n, seed, idx);
  if (loot) enableLoot(run, eat);
  const tally = attachTally(run);
  const scripts = calib.scripts().filter((s) => s.roomId === roomId);
  const res = runLevelScripts(run, scripts, { ...calib.run, strict: true });
  const st = run.stats.rooms.find((r) => r.roomId === roomId);
  const stoppedAtNextRoom = (res.failure ?? '').startsWith('aucun script pour la salle');
  return {
    roomId,
    seed,
    loot,
    cleared: res.completed || stoppedAtNextRoom,
    wipes: st?.wipes ?? 0,
    hpLost: st ? st.hpLost.reduce((a, b) => a + b, 0) : 0,
    tally,
  };
}

/** Moyenne d'un tableau (0 si vide). */
export function mean(xs: readonly number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Agrégat d'un lot de parties (même niveau / joueurs / mode). */
export interface CalibAggregate {
  runs: number;
  completed: number;
  timeS: number;
  wipes: number;
  hpLostPerRoom: number;
  barsPerRoom: number;
  downs: number;
  foodHealed: number;
  crystalHealed: number;
  healed: number;
  drops: number;
  dropsPerKill: number;
  /** Part du temps (%) où le joueur vivant le plus blessé est sous 50 % de ses PV. */
  lowPct: number;
  /** Part du temps (%) où il est sous 25 % de ses PV. */
  criticalPct: number;
}

/** Agrège des résultats (moyennes par partie ; durée sur les parties TERMINÉES seulement). */
export function aggregate(rs: readonly CalibResult[]): CalibAggregate {
  const done = rs.filter((r) => r.completed);
  const kills = rs.reduce((a, r) => a + r.tally.kills, 0);
  const drops = rs.reduce((a, r) => a + r.tally.drops, 0);
  return {
    runs: rs.length,
    completed: done.length,
    timeS: mean(done.map((r) => r.timeS)),
    wipes: mean(rs.map((r) => r.wipes)),
    hpLostPerRoom: mean(rs.map((r) => r.hpLost / r.rooms)),
    barsPerRoom: mean(rs.map((r) => r.bars / r.rooms)),
    downs: mean(rs.map((r) => r.downs)),
    foodHealed: mean(rs.map((r) => r.tally.foodHealed)),
    crystalHealed: mean(rs.map((r) => r.tally.crystalHealed)),
    healed: mean(rs.map((r) => r.tally.foodHealed + r.tally.crystalHealed)),
    drops: mean(rs.map((r) => r.tally.drops)),
    dropsPerKill: kills > 0 ? drops / kills : 0,
    lowPct: (100 * rs.reduce((a, r) => a + r.tally.lowSteps, 0)) / Math.max(1, rs.reduce((a, r) => a + r.tally.steps, 0)),
    criticalPct: (100 * rs.reduce((a, r) => a + r.tally.criticalSteps, 0)) / Math.max(1, rs.reduce((a, r) => a + r.tally.steps, 0)),
  };
}
