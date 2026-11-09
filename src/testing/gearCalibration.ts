/**
 * Mesure de l'effet de l'ÉQUIPEMENT (équipement à 6 emplacements, accessoires, bonus temporaires) par simulations headless de bots.
 *
 * Sert (1) au test de calibration LÉGER de la suite normale (`gearCalibration.test.ts`) et (2) au script LONG à lancer à la demande
 * (`gearCalibration.long.test.ts`, non exécuté par `npm test` : voir le README, section « Équipement et bonus », « calibrage mesuré »).
 *
 * Deux modes comparés, à graine, niveau, joueurs et difficulté identiques, avec le butin de vie ACTIF dans les deux (nourriture + cristaux, brique `eat`) :
 *  - `gear: false` (avant) : aucun équipement ;
 *  - `gear: true` + brique `pickGear` (après) : les bots ramassent l'équipement strictement meilleur et les bonus temporaires proches.
 *
 * ATTENTION : les bots ne sont qu'un PROXY du joueur humain (voir l'en-tête de `lootCalibration.ts`) : pas d'esquive réelle, spéciaux inutilisés
 * (sauf niveau 5), APPEL jamais lancé (le cor de guerre n'est donc pas mesuré ici), pas d'échange manuel d'accessoire. Ils subissent plus de dégâts
 * évitables qu'un humain : les chiffres donnent la DIRECTION et l'ORDRE DE GRANDEUR de l'effet, pas le ressenti réel.
 *
 * Indice de PUISSANCE EFFECTIVE (`powerIndex`) : produit de ce que l'équipement change directement dans un combat, à vitesse et recharge près :
 *   puissance = (dégâts infligés × cadence d'attaque) / (dégâts reçus) × (1 + 0,3 × bonus de vitesse) × (1 + 0,2 × réduction de recharge du spécial)
 * avec, pour l'ARC d'un héros au corps à corps, un facteur ×1,5 (il tire à distance : moins de coups reçus pour le même effort) en plus de ses dégâts
 * ×0,7. Les ponts (0,3 / 0,2 / 1,5) sont des estimations de l'ingénieur d'équilibrage, pas des mesures : l'indice sert à comparer des réglages entre eux,
 * la mesure qui fait foi reste celle des défaites, du temps sous 50 % de PV et de la durée.
 */
import { getCharacter } from '../core/characters';
import type { CharacterId } from '../core/types';
import {
  attackDamageMultiplier,
  cloneGear,
  damageReduction,
  effectiveAttack,
  specialCooldownReduction,
  speedBonus,
} from '../core/gear';
import { isMiniBossKind, isBossKind } from '../core/enemies';
import { createLoadout, equipItem, pickGearItem, pickupDecision } from '../core/gear';
import { createRng, nextRandom } from '../core/rng';
import { mostWoundedFraction } from '../core/loot';
import type { PlayerGear, SimEvent } from '../core/types';
import type { BackgroundOptions, BotRun } from './botKit';
import { runLevelScripts, type LevelRunOptions } from './botKit';
import { CALIB_LEVELS, enableGear, enableLoot, mean, type CalibLevel } from './lootCalibration';

export { CALIB_LEVELS, mean };

/** Poids de la vitesse de déplacement dans l'indice de puissance (estimation, voir l'en-tête). */
export const POWER_SPEED_WEIGHT = 0.3;
/** Poids de la recharge du spécial dans l'indice de puissance (estimation, voir l'en-tête). */
export const POWER_SPECIAL_WEIGHT = 0.2;
/** Facteur de sécurité de l'arc d'un héros au corps à corps (il tire à distance ; estimation, voir l'en-tête). */
export const POWER_BOW_RANGE_FACTOR = 1.5;

/**
 * Indice de PUISSANCE EFFECTIVE d'un héros avec cet équipement (1 = sans équipement). Voir l'en-tête du module pour la définition.
 * Les bonus temporaires ne sont pas comptés (ils sont mesurés à part, par leur fréquence).
 */
export function powerIndex(characterId: CharacterId, g: PlayerGear): number {
  const ch = getCharacter(characterId);
  const atk = effectiveAttack(ch, g);
  const rate = ch.attack.cooldownMs / Math.max(1, atk.cooldownMs);
  let dmg = attackDamageMultiplier(ch, g);
  if (g.weapon === 3 && ch.attack.kind !== 'ranged') dmg *= POWER_BOW_RANGE_FACTOR;
  const offense = dmg * rate;
  const defense = 1 / Math.max(0.01, 1 - damageReduction(g));
  const mobility = 1 + POWER_SPEED_WEIGHT * speedBonus(g);
  const cooldown = 1 + POWER_SPECIAL_WEIGHT * specialCooldownReduction(g);
  return offense * defense * mobility * cooldown;
}

/**
 * Puissance ATTENDUE d'un héros après `drops` objets tirés (un par salle de combat et par héros : le budget), SANS aucune perte, en pur calcul (aucune
 * simulation) : tirages `pickGearItem` (poids d'emplacement et de niveau de `balance.ts`, emplacement vide ×2), ramassés seulement s'ils sont STRICTEMENT
 * meilleurs (`pickupDecision` : 'equip' ou 'upgrade'). Moyenne de `samples` héros, graine fixe : déterministe.
 * Donne le « budget de puissance » théorique : voir le README. Le moins équipé étant lui-même (un seul héros), le x2 des emplacements vides s'applique à lui.
 * @param playerCount nombre de joueurs de la partie (la magie est exclue du tirage à 1 joueur)
 */
export function expectedPower(characterId: CharacterId, drops: number, playerCount: number, samples = 2000, seed = 4242): number {
  const rng = createRng(seed);
  const random = (): number => nextRandom(rng);
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const hero = { id: 0 as const, status: 'alive' as const, loadout: createLoadout() };
    for (let k = 0; k < drops; k++) {
      const item = pickGearItem(random, [hero], playerCount);
      if (!item) continue;
      const d = pickupDecision(hero.loadout, item);
      if (d === 'equip' || d === 'upgrade') equipItem(hero.loadout, item);
    }
    sum += powerIndex(characterId, hero.loadout);
  }
  return sum / samples;
}

/** Nombre de pièces portées (emplacements non vides, accessoire compris) et somme des niveaux (accessoire compris). */
export function gearSummary(g: PlayerGear): { pieces: number; levels: number } {
  const lv = [g.boots, g.protection, g.artifact, g.magic, g.weapon, g.accessory?.level ?? 0];
  return { pieces: lv.filter((x) => x > 0).length, levels: lv.reduce((a, b) => a + b, 0) };
}

/** Instantané de l'équipement (moyenne sur TOUS les joueurs, à terre compris) à la première entrée dans une salle. */
export interface GearSnap {
  roomIndex: number;
  /** Pièces portées par joueur (0 à 6). */
  pieces: number;
  /** Niveau moyen d'une pièce portée (1 à 3 ; 0 si aucune). */
  avgLevel: number;
  /** Indice de puissance moyen par joueur (1 = sans équipement). */
  power: number;
}

/** Résultat d'UNE partie mesurée avec ou sans équipement (butin de vie actif dans les deux cas). */
export interface GearRunResult {
  level: number;
  players: number;
  seed: number;
  gear: boolean;
  completed: boolean;
  /** Durée simulée (s). */
  timeS: number;
  wipes: number;
  /** PV perdus (tous joueurs). */
  hpLost: number;
  /** Nombre de salles du niveau. */
  rooms: number;
  downs: number;
  roomWipes: Record<string, number>;
  /** Défaites collectives dans les salles de boss ou demi-boss. */
  bossWipes: number;
  /** Objets d'équipement tombés (hors éparpillement) par salle (id) et nombre de fois que chaque salle de combat a été jouée : où le budget est-il dépensé ? */
  roomDrops: Record<string, number>;
  roomPlays: Record<string, number>;
  /** Salles de COMBAT jouées (au moins un ennemi qui peut laisser un objet, hors boss final ; chaque redémarrage de salle compte). */
  combatRooms: number;
  kills: number;
  /** Objets d'équipement tombés d'un ennemi (hors éparpillement de perte, hors lâchés par échange). */
  gearDrops: number;
  /** Objets éparpillés par une perte (chute). */
  scattered: number;
  picked: number;
  /** Chutes qui ont fait perdre de l'équipement, et nombre de pièces perdues. */
  lossEvents: number;
  lostItems: number;
  buffDrops: number;
  buffsStarted: number;
  /** Pas de simulation observés, pas sous 50 % et sous 25 % de PV (joueur vivant le plus blessé). */
  steps: number;
  lowSteps: number;
  criticalSteps: number;
  /** Puissance : somme des indices des joueurs VIVANTS échantillonnés toutes les 30 pas, et nombre d'échantillons. */
  powerSum: number;
  powerSamples: number;
  snaps: GearSnap[];
}

const SAMPLE_EVERY_STEPS = 30;

/** Branche les compteurs sur `run.stepOnce` (sans rien modifier d'autre). */
function attach(run: BotRun, r: GearRunResult): void {
  const inner = run.stepOnce.bind(run);
  const seen = new Set<number>();
  const chars = run.state.players.map((p) => p.characterId);
  let tick = 0;
  let curRoom = run.level.rooms[run.state.roomIndex]?.id ?? '';
  // salle « de combat » : au moins un ennemi qui peut laisser un objet (ni boss final ; les invoqués ne comptent pas) ; le budget y est dépensé
  const eligible = run.level.rooms.map((room) => room.enemies.some((en) => !isBossKind(en.kind)));
  run.stepOnce = (frames) => {
    const events: SimEvent[] = inner(frames);
    const s = run.state;
    const f = mostWoundedFraction(s.players);
    r.steps++;
    if (f < 0.5) r.lowSteps++;
    if (f < 0.25) r.criticalSteps++;
    if (++tick % SAMPLE_EVERY_STEPS === 0) {
      for (const p of s.players) {
        if (p.status !== 'alive') continue;
        r.powerSum += powerIndex(chars[p.id], p.loadout);
        r.powerSamples++;
      }
    }
    for (const e of events) {
      switch (e.type) {
        case 'roomEntered': {
          if (eligible[e.roomIndex]) {
            r.combatRooms++;
            r.roomPlays[e.roomId] = (r.roomPlays[e.roomId] ?? 0) + 1;
          }
          curRoom = e.roomId;
          if (e.reason !== 'restart' && !seen.has(e.roomIndex)) {
            seen.add(e.roomIndex);
            let pieces = 0;
            let levels = 0;
            let power = 0;
            for (const p of s.players) {
              const g = gearSummary(p.loadout);
              pieces += g.pieces;
              levels += g.levels;
              power += powerIndex(chars[p.id], p.loadout);
            }
            const n = Math.max(1, s.players.length);
            r.snaps.push({ roomIndex: e.roomIndex, pieces: pieces / n, avgLevel: pieces > 0 ? levels / pieces : 0, power: power / n });
          }
          break;
        }
        case 'enemyDied':
          r.kills++;
          break;
        case 'gearDropped':
          if (e.scattered) r.scattered++;
          else {
            r.gearDrops++;
            r.roomDrops[curRoom] = (r.roomDrops[curRoom] ?? 0) + 1;
          }
          break;
        case 'gearPicked':
          r.picked++;
          break;
        case 'gearLost':
          r.lossEvents++;
          r.lostItems += e.items.length;
          break;
        case 'buffDropped':
          r.buffDrops++;
          break;
        case 'buffStarted':
          if (e.kind !== 'horn') r.buffsStarted++;
          break;
        default:
          break;
      }
    }
    return events;
  };
}

/** Salles de boss ou de demi-boss d'un niveau (ids). */
export function bossRoomIds(calib: CalibLevel): string[] {
  return calib.level.rooms.filter((room) => room.enemies.some((e) => isBossKind(e.kind) || isMiniBossKind(e.kind))).map((room) => room.id);
}

/** Résultat vierge (compteurs à zéro). */
function blankResult(calib: CalibLevel, n: number, seed: number, gear: boolean): GearRunResult {
  return {
    level: calib.no, players: n, seed, gear, completed: false, timeS: 0, wipes: 0, hpLost: 0, rooms: calib.level.rooms.length, downs: 0,
    roomWipes: {}, roomDrops: {}, roomPlays: {}, bossWipes: 0, combatRooms: 0, kills: 0, gearDrops: 0, scattered: 0, picked: 0, lossEvents: 0, lostItems: 0,
    buffDrops: 0, buffsStarted: 0, steps: 0, lowSteps: 0, criticalSteps: 0, powerSum: 0, powerSamples: 0, snaps: [],
  };
}

/**
 * Joue UNE partie complète d'un niveau, butin de vie ACTIF, avec ou sans équipement.
 * @param calib niveau (`CALIB_LEVELS`)
 * @param n nombre de joueurs (1 à 4)
 * @param seed graine de la simulation
 * @param gear équipement actif (+ brique `pickGear`) ou non
 * @param override surcharge éventuelle des budgets (tests courts)
 * @param bg surcharge des briques de fond des bots (`eatRadius`, `gearRadius`…)
 */
export function measureGearRun(
  calib: CalibLevel,
  n: number,
  seed: number,
  gear: boolean,
  override: Partial<LevelRunOptions> = {},
  bg: Partial<BackgroundOptions> = {},
): GearRunResult {
  const run = calib.make(n, seed);
  enableLoot(run);
  if (gear) enableGear(run, bg);
  const r = blankResult(calib, n, seed, gear);
  // la salle de départ est comptée par l'événement `roomEntered` 'start' (émis au premier pas, une fois `enableGear` appliqué)
  attach(run, r);
  const res = runLevelScripts(run, calib.scripts(), { ...calib.run, ...override });
  r.completed = res.completed;
  r.timeS = res.timeMs / 1000;
  r.wipes = run.stats.wipes;
  r.hpLost = run.stats.players.reduce((a, p) => a + p.hpLost, 0);
  r.downs = run.stats.players.reduce((a, p) => a + p.downs, 0);
  r.roomWipes = Object.fromEntries(run.stats.rooms.map((x) => [x.roomId, x.wipes]));
  const boss = new Set(bossRoomIds(calib));
  r.bossWipes = run.stats.rooms.filter((x) => boss.has(x.roomId)).reduce((a, x) => a + x.wipes, 0);
  return r;
}

/** Agrégat d'un lot de parties (même niveau / joueurs / mode). */
export interface GearAggregate {
  runs: number;
  completed: number;
  /** Durée moyenne (s) des parties TERMINÉES. */
  timeS: number;
  wipes: number;
  bossWipes: number;
  hpLostPerRoom: number;
  downs: number;
  lowPct: number;
  criticalPct: number;
  /** Objets d'équipement tombés par salle d'ennemis jouée et par héros (cible ~1). */
  dropsPerRoomPerHero: number;
  /** Objets d'équipement tombés par partie. */
  dropsPerRun: number;
  buffDropsPerRoomPerHero: number;
  picked: number;
  /** Chutes avec perte d'équipement, pièces perdues, par partie. */
  lossEvents: number;
  lostItems: number;
  /** Puissance moyenne (indice, joueurs vivants, tout au long de la partie). */
  power: number;
  /** Équipement moyen à l'entrée de la salle du milieu / de la 4e salle / de la dernière salle : pièces, niveau moyen, puissance. */
  mid: GearSnapAvg;
  fourth: GearSnapAvg;
  end: GearSnapAvg;
}

export interface GearSnapAvg {
  pieces: number;
  avgLevel: number;
  power: number;
}

function snapAt(rs: readonly GearRunResult[], pick: (r: GearRunResult) => number): GearSnapAvg {
  const xs = rs.flatMap((r) => {
    const target = pick(r);
    const s = r.snaps.find((x) => x.roomIndex === target);
    return s ? [s] : [];
  });
  return { pieces: mean(xs.map((x) => x.pieces)), avgLevel: mean(xs.map((x) => x.avgLevel)), power: mean(xs.map((x) => x.power)) };
}

/** Agrège des résultats (moyennes par partie ; durée sur les parties terminées seulement). */
export function aggregateGear(rs: readonly GearRunResult[]): GearAggregate {
  const done = rs.filter((r) => r.completed);
  const steps = Math.max(1, rs.reduce((a, r) => a + r.steps, 0));
  const heroRooms = Math.max(1, rs.reduce((a, r) => a + r.combatRooms * r.players, 0));
  return {
    runs: rs.length,
    completed: done.length,
    timeS: mean(done.map((r) => r.timeS)),
    wipes: mean(rs.map((r) => r.wipes)),
    bossWipes: mean(rs.map((r) => r.bossWipes)),
    hpLostPerRoom: mean(rs.map((r) => r.hpLost / r.rooms)),
    downs: mean(rs.map((r) => r.downs)),
    lowPct: (100 * rs.reduce((a, r) => a + r.lowSteps, 0)) / steps,
    criticalPct: (100 * rs.reduce((a, r) => a + r.criticalSteps, 0)) / steps,
    dropsPerRoomPerHero: rs.reduce((a, r) => a + r.gearDrops, 0) / heroRooms,
    dropsPerRun: mean(rs.map((r) => r.gearDrops)),
    buffDropsPerRoomPerHero: rs.reduce((a, r) => a + r.buffDrops, 0) / heroRooms,
    picked: mean(rs.map((r) => r.picked)),
    lossEvents: mean(rs.map((r) => r.lossEvents)),
    lostItems: mean(rs.map((r) => r.lostItems)),
    power: rs.reduce((a, r) => a + r.powerSum, 0) / Math.max(1, rs.reduce((a, r) => a + r.powerSamples, 0)),
    mid: snapAt(rs, (r) => Math.floor(r.rooms / 2)),
    fourth: snapAt(rs, () => 3),
    end: snapAt(rs, (r) => r.rooms - 1),
  };
}

// ───────────────────────────── Équipement de départ et salle isolée (test léger) ─────────────────────────────

/** Équipement « typique » vers la 4e salle (3 pièces de niveau ~1,3 : bottes II, protection I, artefact I) : puissance ≈ +21 %. */
export const TYPICAL_GEAR: Readonly<PlayerGear> = { boots: 2, protection: 1, artifact: 1, magic: 0, weapon: 0, accessory: null };
/** Équipement « tout au niveau III » (arc, sans accessoire) : le maximum de puissance de la table. */
export const FULL_GEAR: Readonly<PlayerGear> = { boots: 3, protection: 3, artifact: 3, magic: 3, weapon: 3, accessory: null };

/** Pose un équipement de départ à TOUS les joueurs d'une partie (aucun tirage, aucun événement) et active l'équipement dans l'état. */
export function giveGear(run: BotRun, g: Readonly<PlayerGear>): void {
  run.state.gearEnabled = true;
  for (const p of run.state.players) Object.assign(p.loadout, cloneGear({ ...g }));
}

/** Résultat d'UNE salle jouée isolément (voir `measureGearRoom`). */
export interface GearRoomResult extends GearRunResult {
  roomId: string;
  /** La salle a été validée (la partie est allée jusqu'à la salle suivante, ou a fini le niveau). */
  cleared: boolean;
}

/**
 * Joue UNE SEULE salle d'un niveau (départ en PV pleins à l'entrée, comme dans le jeu), butin de vie ACTIF, avec les bots :
 *  - `start` : équipement posé à tous les joueurs à l'entrée (`TYPICAL_GEAR`, `FULL_GEAR`…) ; absent = aucun ;
 *  - `drops` : l'équipement est actif (budget, tirages, brique `pickGear`) ; sinon seul l'équipement de départ compte.
 * Les scripts des autres salles sont absents (mode `strict`) : la partie s'arrête à l'entrée de la salle suivante. Sert au test léger.
 */
export function measureGearRoom(
  calib: CalibLevel,
  n: number,
  seed: number,
  roomId: string,
  opts: { start?: Readonly<PlayerGear>; drops?: boolean } = {},
): GearRoomResult {
  const idx = calib.level.rooms.findIndex((x) => x.id === roomId);
  if (idx < 0) throw new Error(`salle inconnue : ${roomId}`);
  const run = calib.make(n, seed, idx);
  enableLoot(run);
  if (opts.drops) enableGear(run);
  if (opts.start) giveGear(run, opts.start);
  const r = blankResult(calib, n, seed, !!(opts.drops || opts.start));
  attach(run, r);
  const scripts = calib.scripts().filter((sc) => sc.roomId === roomId);
  const res = runLevelScripts(run, scripts, { ...calib.run, strict: true });
  const st = run.stats.rooms.find((x) => x.roomId === roomId);
  r.timeS = res.timeMs / 1000;
  r.wipes = st?.wipes ?? 0;
  r.hpLost = st ? st.hpLost.reduce((a, b) => a + b, 0) : 0;
  r.downs = st ? st.downs.reduce((a, b) => a + b, 0) : 0;
  r.completed = res.completed;
  r.combatRooms = run.level.rooms[idx].enemies.some((en) => !isBossKind(en.kind)) ? 1 : 0; // la salle suivante, simplement « entrée », ne compte pas
  const stoppedAtNextRoom = (res.failure ?? '').startsWith('aucun script pour la salle');
  return { ...r, roomId, cleared: res.completed || stoppedAtNextRoom };
}
