/**
 * Validation et copie d'un `GameState` REÇU par le réseau (miroir d'un invité : `GameSimulation.applyMirrorState`, docs/NET.md § 7.3).
 *
 * L'état arrive d'un pair : il n'est JAMAIS cru. On vérifie la FORME (types, plages, bornes de taille, identifiants connus du niveau) pour que ni les vues
 * ni l'interface ne puissent lever une exception en lisant un état hostile ou corrompu ; on ne re-simule rien. Fonctions PURES : aucun état, aucune horloge,
 * aucun hasard (comme tout `src/core`).
 *
 * Le contrôle se fait en deux temps : un passage générique sur tout l'objet (JSON pur, nombres finis, profondeur et nombre de noeuds bornés, aucune clé
 * `__proto__`), puis des vérifications structurées (joueurs, ennemis, projectiles, mécanismes, objectifs, objets au sol).
 */
import { CHARACTER_IDS } from './characters';
import { MAX_PROJECTILES } from './combat';
import { ENEMY_KINDS } from './enemies';
import { validGearItem } from './autoCall';
import type { LevelDef, MechanismDef, RoomDef } from './types';

/** Bornes de taille (un état légitime est très en dessous : le plafond d'ennemis vivants est 40). */
export const MIRROR_LIMITS = {
  /** Noeuds JSON au plus dans tout l'état (un état de pire cas en compte ≈ 6 000). */
  MAX_NODES: 40000,
  MAX_DEPTH: 12,
  MAX_ENEMIES: 128,
  MAX_PROJECTILES: Math.max(256, MAX_PROJECTILES),
  MAX_GROUND_ITEMS: 128,
  MAX_STRING: 200,
  MAX_ENEMY_DATA_KEYS: 96,
} as const;

type Obj = Record<string, unknown>;

const DIRS = ['up', 'down', 'left', 'right'] as const;
const DIAGS = ['upLeft', 'upRight', 'downLeft', 'downRight'] as const;
const PHASES = ['playing', 'roomCleared', 'levelComplete', 'wipe'] as const;
const PROJECTILE_KINDS = ['arrow', 'bolt', 'orb', 'shard', 'heal', 'wave', 'axe'] as const;
const ACCESSORY_KINDS_LOCAL = ['lantern', 'magnet', 'warhorn', 'vampire'] as const;
const BUFF_KINDS = ['speed', 'rage', 'star', 'horn'] as const;
const DROPPED_BUFF_KINDS = ['speed', 'rage', 'star'] as const;
const AUTO_CALL_ICONS = ['heart', 'half', 'gear', 'cross'] as const;
const HEART_KINDS = ['half', 'full'] as const;
const GEAR_BASIC_SLOTS = ['boots', 'protection', 'artifact', 'magic', 'weapon'] as const;

// ───────────────────────────── Petits prédicats ─────────────────────────────

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isInt = (v: unknown): v is number => isNum(v) && Number.isInteger(v);
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isStr = (v: unknown, max: number = MIRROR_LIMITS.MAX_STRING): v is string => typeof v === 'string' && v.length <= max;
const isVec = (v: unknown): boolean => isObj(v) && isNum(v.x) && isNum(v.y);
const oneOf = (list: readonly unknown[], v: unknown): boolean => list.includes(v);
/** Identifiant de joueur 0..3 ou null. */
const isIdOrNull = (v: unknown): boolean => v === null || (isInt(v) && v >= 0 && v <= 3);
const isTile = (v: unknown): boolean => Array.isArray(v) && v.length === 2 && isNum(v[0]) && isNum(v[1]);
const arrayOf = (v: unknown, max: number, each: (x: unknown, i: number) => boolean): boolean => Array.isArray(v) && v.length <= max && v.every((x, i) => each(x, i));
const optional = (v: unknown, test: (x: unknown) => boolean): boolean => v === undefined || test(v);

// ───────────────────────────── Passage générique ─────────────────────────────

/** Vérifie que `value` est du JSON pur sûr (nombres finis, pas de clé `__proto__`, profondeur et taille bornées) ; renvoie la raison ou null. */
export function jsonProblem(value: unknown): string | null {
  const budget = { n: 0 };
  return walk(value, 0, budget);
}

function walk(v: unknown, depth: number, budget: { n: number }): string | null {
  if (++budget.n > MIRROR_LIMITS.MAX_NODES) return 'état trop volumineux';
  if (v === null) return null;
  switch (typeof v) {
    case 'number':
      return Number.isFinite(v) ? null : 'nombre non fini';
    case 'string':
      return v.length <= MIRROR_LIMITS.MAX_STRING ? null : 'chaîne trop longue';
    case 'boolean':
      return null;
    case 'object': {
      if (depth >= MIRROR_LIMITS.MAX_DEPTH) return 'état trop profond';
      if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) {
          const r = walk(v[i], depth + 1, budget);
          if (r !== null) return r;
        }
        return null;
      }
      const proto = Object.getPrototypeOf(v) as unknown;
      if (proto !== Object.prototype && proto !== null) return 'objet non simple';
      for (const k of Object.keys(v as Obj)) {
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') return 'clé interdite';
        const r = walk((v as Obj)[k], depth + 1, budget);
        if (r !== null) return r;
      }
      return null;
    }
    default:
      return 'type interdit';
  }
}

/** Copie profonde d'un JSON déjà validé (objets simples, tableaux, primitives). */
export function cloneJson<T>(v: T): T {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => cloneJson(x)) as unknown as T;
  const out: Obj = {};
  for (const k of Object.keys(v as Obj)) out[k] = cloneJson((v as Obj)[k]);
  return out as T;
}

// ───────────────────────────── Joueurs ─────────────────────────────

const PLAYER_NUMBERS = ['invulnMs', 'attackCooldownMs', 'attackAnimMs', 'reviveProgressMs', 'kills', 'downCount', 'specialCooldownMs', 'specialAnimMs', 'torchMs', 'callMs', 'callCooldownMs'] as const;

function checkLoadout(l: unknown): boolean {
  if (!isObj(l)) return false;
  for (const slot of GEAR_BASIC_SLOTS) if (!isInt(l[slot]) || l[slot] < 0 || l[slot] > 3) return false;
  const acc = l.accessory;
  if (acc !== null && !(isObj(acc) && oneOf(ACCESSORY_KINDS_LOCAL, acc.kind) && isInt(acc.level) && acc.level >= 1 && acc.level <= 3)) return false;
  if (!arrayOf(l.buffs, 16, (b) => isObj(b) && oneOf(BUFF_KINDS, b.kind) && isNum(b.remainingMs) && optional(b.power, isNum))) return false;
  return optional(l.ringKills, isNum);
}

function checkPlayer(p: unknown, i: number): string | null {
  const where = `players[${i}]`;
  if (!isObj(p)) return where;
  if (p.id !== i) return `${where}.id`;
  if (!oneOf(CHARACTER_IDS, p.characterId)) return `${where}.characterId`;
  if (!oneOf([1, 2, 3], p.difficulty)) return `${where}.difficulty`;
  if (!isVec(p.pos)) return `${where}.pos`;
  if (!oneOf(DIRS, p.facing)) return `${where}.facing`;
  if (!isNum(p.hp) || !isNum(p.maxHp) || p.maxHp < 1 || p.maxHp > 1000) return `${where}.hp`;
  if (p.status !== 'alive' && p.status !== 'down') return `${where}.status`;
  for (const k of PLAYER_NUMBERS) if (!isNum(p[k])) return `${where}.${k}`;
  if (!oneOf(DIRS, p.attackDir)) return `${where}.attackDir`;
  if (!isIdOrNull(p.revivingId) || !isIdOrNull(p.reviverId)) return `${where}.reviving`;
  if (!arrayOf(p.keys, 16, (k) => isStr(k))) return `${where}.keys`;
  const prev = p.prev;
  if (!isObj(prev) || !isBool(prev.attack) || !isBool(prev.interact) || !isBool(prev.revive) || !optional(prev.special, isBool) || !optional(prev.call, isBool) || !optional(prev.heart, isBool)) return `${where}.prev`;
  if (!isBool(p.moving)) return `${where}.moving`;
  if (!optional(p.aim, (v) => oneOf(DIAGS, v)) || !optional(p.attackAim, (v) => oneOf(DIAGS, v)) || !optional(p.aimGraceMs, isNum)) return `${where}.aim`;
  if (
    !optional(p.autoCall, (a) => isObj(a) && oneOf(AUTO_CALL_ICONS, a.icon) && isStr(a.ref) && isNum(a.ms) && arrayOf(a.to, 4, (id) => isInt(id)) && optional(a.item, validGearItem))
  ) {
    return `${where}.autoCall`;
  }
  if (!optional(p.autoCallCooldownMs, isNum)) return `${where}.autoCallCooldownMs`;
  if (!optional(p.autoCallSeen, (s) => arrayOf(s, 64, (r) => isStr(r)))) return `${where}.autoCallSeen`;
  if (!optional(p.autoCallCross, (c) => isObj(c) && isNum(c.ms) && optional(c.idleMs, isNum))) return `${where}.autoCallCross`;
  if (!optional(p.heart, (h) => oneOf(HEART_KINDS, h))) return `${where}.heart`;
  if (!checkLoadout(p.loadout)) return `${where}.loadout`;
  return null;
}

// ───────────────────────────── Salle ─────────────────────────────

function checkEnemy(e: unknown, i: number): string | null {
  const where = `room.enemies[${i}]`;
  if (!isObj(e)) return where;
  if (!isNum(e.id)) return `${where}.id`;
  if (!oneOf(ENEMY_KINDS, e.kind)) return `${where}.kind`;
  if (!isVec(e.pos)) return `${where}.pos`;
  if (!oneOf(DIRS, e.facing)) return `${where}.facing`;
  if (!isNum(e.hp) || !isNum(e.maxHp)) return `${where}.hp`;
  if (!isStr(e.mode, 64)) return `${where}.mode`;
  if (!isNum(e.modeTimerMs) || !isNum(e.attackCooldownMs) || !isNum(e.hitFlashMs) || !isNum(e.phase) || !isNum(e.targetId) || !isNum(e.wave)) return `${where}.numbers`;
  if (!isBool(e.dead)) return `${where}.dead`;
  const data = e.data;
  if (!isObj(data)) return `${where}.data`;
  const keys = Object.keys(data);
  if (keys.length > MIRROR_LIMITS.MAX_ENEMY_DATA_KEYS) return `${where}.data`;
  for (const k of keys) if (!isNum(data[k])) return `${where}.data.${k}`;
  return null;
}

function checkProjectile(p: unknown, i: number): string | null {
  const where = `room.projectiles[${i}]`;
  if (!isObj(p)) return where;
  if (!isNum(p.id) || !oneOf(PROJECTILE_KINDS, p.kind)) return `${where}.id`;
  const o = p.owner;
  if (!isObj(o) || !((o.type === 'player' && isInt(o.id) && o.id >= 0 && o.id <= 3) || (o.type === 'enemy' && isNum(o.id)))) return `${where}.owner`;
  if (!isVec(p.pos) || !isVec(p.vel)) return `${where}.pos`;
  if (!isNum(p.damage) || !isNum(p.radius) || !isNum(p.lifeMs) || !isBool(p.pierce)) return `${where}.numbers`;
  if (!arrayOf(p.hitIds, 64, (h) => isNum(h))) return `${where}.hitIds`;
  return null;
}

/** Forme de l'état d'un mécanisme d'après sa définition (même type et même identifiant, champs propres au type). */
function checkMechanism(m: unknown, def: MechanismDef, i: number): string | null {
  const where = `room.mechanisms[${i}]`;
  if (!isObj(m)) return where;
  if (m.id !== def.id || m.type !== def.type) return `${where}.id`;
  if (!isBool(m.waived) || !isBool(m.active)) return `${where}.flags`;
  switch (def.type) {
    case 'plate':
      return m.pressedBy === null || m.pressedBy === 'block' || (isInt(m.pressedBy) && m.pressedBy >= 0 && m.pressedBy <= 3) ? null : `${where}.pressedBy`;
    case 'lever':
      return isNum(m.remainingMs) ? null : `${where}.remainingMs`;
    case 'key':
      return isBool(m.collected) && isIdOrNull(m.holderId) ? null : `${where}.key`;
    case 'door':
      return isBool(m.open) ? null : `${where}.open`;
    case 'block': {
      const mv = m.moving;
      const ok = isVec(m.pos) && isTile(m.tile) && isNum(m.pushMs) && (mv === null || (isObj(mv) && isTile(mv.to) && isNum(mv.progress)));
      return ok ? null : `${where}.block`;
    }
    case 'socket':
      return null;
    case 'runePuzzle':
      return isNum(m.progress) && isNum(m.errorFlashMs) && isNum(m.lastPedestal) ? null : `${where}.rune`;
    case 'brazier':
      return isIdOrNull(m.litBy) ? null : `${where}.litBy`;
    case 'statuePair':
      return Array.isArray(m.facings) && m.facings.length === 2 && oneOf(DIRS, m.facings[0]) && oneOf(DIRS, m.facings[1]) && (m.lastRotated === -1 || m.lastRotated === 0 || m.lastRotated === 1) ? null : `${where}.statue`;
    case 'hourglass':
      return isNum(m.sandMs) && isNum(m.closedCount) && isNum(m.stepMs) && isNum(m.lastLever) ? null : `${where}.hourglass`;
    case 'lightBridge':
      return isIdOrNull(m.bearerId) && Array.isArray(m.lit) && m.lit.length === def.tiles.length && m.lit.every(isBool) ? null : `${where}.lightBridge`;
    default:
      return `${where}.type`;
  }
}

function checkRoom(r: unknown, def: RoomDef): string | null {
  if (!isObj(r)) return 'room';
  if (r.roomId !== def.id) return 'room.roomId';
  if (!arrayOf(r.enemies, MIRROR_LIMITS.MAX_ENEMIES, (e, i) => checkEnemy(e, i) === null)) return firstProblem(r.enemies, MIRROR_LIMITS.MAX_ENEMIES, checkEnemy, 'room.enemies');
  if (!arrayOf(r.projectiles, MIRROR_LIMITS.MAX_PROJECTILES, (p, i) => checkProjectile(p, i) === null)) return firstProblem(r.projectiles, MIRROR_LIMITS.MAX_PROJECTILES, checkProjectile, 'room.projectiles');
  const mechs = r.mechanisms;
  if (!Array.isArray(mechs) || mechs.length !== def.mechanisms.length) return 'room.mechanisms';
  for (let i = 0; i < mechs.length; i++) {
    const bad = checkMechanism(mechs[i], def.mechanisms[i], i);
    if (bad !== null) return bad;
  }
  if (!arrayOf(r.spawnedSpawnIdx, 512, (n) => isInt(n))) return 'room.spawnedSpawnIdx';
  if (!isNum(r.elapsedMs)) return 'room.elapsedMs';
  const max = MIRROR_LIMITS.MAX_GROUND_ITEMS;
  if (!optional(r.pickups, (a) => arrayOf(a, max, (p) => isObj(p) && isNum(p.id) && oneOf(HEART_KINDS, p.kind) && isVec(p.pos) && isNum(p.ttlMs)))) return 'room.pickups';
  if (!optional(r.healCrystals, (a) => arrayOf(a, 16, (c) => isObj(c) && isStr(c.id) && isBool(c.used)))) return 'room.healCrystals';
  if (
    !optional(r.gearDrops, (a) =>
      arrayOf(
        a,
        max,
        (d) => isObj(d) && isNum(d.id) && validGearItem(d.item) && isVec(d.pos) && isNum(d.ttlMs) && isIdOrNull(d.lockedFor) && (d.lockMode === 'life' || d.lockMode === 'leave') && optional(d.recoverFor, (x) => isInt(x) && x >= 0 && x <= 3),
      ),
    )
  ) {
    return 'room.gearDrops';
  }
  if (!optional(r.buffDrops, (a) => arrayOf(a, max, (d) => isObj(d) && isNum(d.id) && oneOf(DROPPED_BUFF_KINDS, d.kind) && isVec(d.pos) && isNum(d.ttlMs)))) return 'room.buffDrops';
  if (!optional(r.gearBudget, isNum) || !optional(r.buffBudget, isNum)) return 'room.budget';
  return null;
}

/** Première raison précise d'un tableau d'éléments invalides (pour un message utile) ; `fallback` si la taille est en cause. */
function firstProblem(list: unknown, max: number, check: (x: unknown, i: number) => string | null, fallback: string): string {
  if (!Array.isArray(list) || list.length > max) return fallback;
  for (let i = 0; i < list.length; i++) {
    const bad = check(list[i], i);
    if (bad !== null) return bad;
  }
  return fallback;
}

// ───────────────────────────── État entier ─────────────────────────────

/**
 * Valide un état reçu d'un pair pour la simulation d'un niveau. Renvoie `null` si l'état est acceptable, sinon la raison (courte, pour le journal).
 * @param next état reçu (n'importe quoi : c'est du JSON non fiable)
 * @param level niveau de la partie (même identifiant, salles et objectifs connus)
 * @param playerCount nombre de joueurs de la partie (l'état reçu doit avoir le même)
 */
export function validateMirrorState(next: unknown, level: LevelDef, playerCount: number): string | null {
  const generic = jsonProblem(next);
  if (generic !== null) return generic;
  if (!isObj(next)) return 'état absent';
  if (next.version !== 1) return 'version';
  if (next.levelId !== level.id) return 'levelId';
  if (!isNum(next.tick) || !isNum(next.timeMs) || !isNum(next.rngState) || !isNum(next.nextEntityId) || !isNum(next.phaseTimerMs)) return 'compteurs';
  if (!isInt(next.playerCount) || next.playerCount !== playerCount) return 'playerCount';
  if (!Array.isArray(next.players) || next.players.length !== playerCount) return 'players';
  for (let i = 0; i < next.players.length; i++) {
    const bad = checkPlayer(next.players[i], i);
    if (bad !== null) return bad;
  }
  if (!isInt(next.roomIndex) || next.roomIndex < 0 || next.roomIndex >= level.rooms.length) return 'roomIndex';
  if (!oneOf(PHASES, next.phase)) return 'phase';
  const roomBad = checkRoom(next.room, level.rooms[next.roomIndex]);
  if (roomBad !== null) return roomBad;
  const objectiveIds = new Set(level.objectives.map((o) => o.id));
  if (!arrayOf(next.objectives, 64, (o) => isObj(o) && isStr(o.id) && objectiveIds.has(o.id) && isInt(o.ownerId) && o.ownerId >= 0 && o.ownerId <= 3 && isBool(o.done) && isNum(o.progress))) return 'objectives';
  if (!arrayOf(next.clearedRooms, 64, (r) => isStr(r))) return 'clearedRooms';
  if (
    !optional(next.lootEnabled, isBool) ||
    !optional(next.lootRngState, isNum) ||
    !optional(next.lootDryKills, isNum) ||
    !optional(next.nextPickupId, isNum) ||
    !optional(next.gearEnabled, isBool) ||
    !optional(next.gearRngState, isNum) ||
    !optional(next.nextGearDropId, isNum) ||
    !optional(next.autoCallDisabled, isBool) ||
    !optional(next.gearDropsDisabled, isBool) ||
    !optional(next.heartSlot, isBool)
  ) {
    return 'options';
  }
  return null;
}
