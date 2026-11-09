/**
 * ÉQUIPEMENT (bonus « à la Bubble Bobble ») — logique PURE et déterministe : aucun Phaser/DOM/Math.random/Date. Les tirages passent par une
 * fonction `random()` fournie par l'appelant (la simulation passe son PRNG ISOLÉ `GameState.gearRngState`, jamais `rngState` ni `lootRngState`).
 * Toutes les valeurs numériques vivent dans `balance.ts` ([B18]..[B25]).
 *
 * ── Accessoires et bonus temporaires ──
 *  - ACCESSOIRE (6e emplacement) : une sorte à la fois. Lanterne (torche), aimant (cœurs ET objets), cor de guerre (l'APPEL donne un bonus de vitesse aux alliés
 *    proches), anneau du vampire (niveau III seulement). Même sorte de niveau supérieur → amélioration automatique ; même sorte de niveau égal / inférieur →
 *    ignoré ; sorte DIFFÉRENTE → jamais d'échange automatique : 'swap' manuel par l'action A (`swapCandidate`), l'ancien est lâché aux pieds du joueur.
 *  - BONUS TEMPORAIRES (`ActiveBuff`) : potion de vitesse, éclair de rage (8 s), étoile (4 s, invulnérable) ; 'horn' = bonus du cor d'un allié (3 s).
 *    Perdus à la chute (`stripLoadout`). Un budget séparé et fractionnaire (~0,3 par héros et par salle) en pose au sol.
 *
 * ── Modèle ──
 *  - 6 emplacements (`GEAR_SLOTS`) : bottes, protection, artefact, magie, arme, accessoire. Chaque emplacement simple porte un niveau 0 (vide)
 *    ou 1..3 (I, II, III) dans `PlayerGear` ; l'accessoire porte une sorte ET un niveau.
 *  - `PlayerLoadout` = `PlayerGear` + bonus temporaires (`buffs`) + compteur de l'anneau (`ringKills`). Valeurs par défaut : tout vide.
 *  - RAMASSAGE (`pickupDecision`) : un objet simple n'est ramassé que s'il est STRICTEMENT meilleur (niveau supérieur) que celui de l'emplacement ;
 *    sinon il reste au sol (un allié peut le prendre). Accessoire : emplacement vide → équipe ; même sorte de niveau supérieur → amélioration ;
 *    même sorte de niveau égal/inférieur → ignoré ; sorte différente → 'swap' (échange manuel, jamais automatique).
 *  - TIRAGE (`rollGearDrop`) : budget par salle = nombre de joueurs ; chaque ennemi ordinaire tué tire un objet avec la probabilité qui répartit
 *    le budget restant sur les ennemis restants (poids `GEAR_ENEMY_WEIGHTS`), compensée par l'exclusion mutuelle avec le cœur de vie ; le demi-boss
 *    consomme un objet du budget (niveau >= `GEAR_MINIBOSS_MIN_LEVEL`) ; les ennemis invoqués et les boss finaux ne laissent rien.
 *  - EFFETS : vitesse, dégâts reçus, recharge du spécial, temps de relevage, arme (dégâts, cadence, arc) via les fonctions de ce module, appelées
 *    par `players.ts`, `combat.ts` et `simulation.ts`. Chaque famille est plafonnée (`GEAR_CAPS`).
 */
import {
  ACCESSORY_BONUS,
  ACCESSORY_KIND_WEIGHTS,
  BUFF_BUDGET_PER_PLAYER,
  BUFF_DURATION_MS,
  BUFF_KIND_WEIGHTS,
  BUFF_RAGE_BONUS,
  BUFF_SPEED_BONUS,
  BUFF_SPEED_TOTAL_CAP,
  BUFF_STAR_DURATION_MS,
  GEAR_AXE_COOLDOWN_MULT,
  GEAR_BONUS,
  GEAR_BOW_ARROW_RADIUS,
  GEAR_BOW_ARROW_SPEED,
  GEAR_BOW_MELEE_DAMAGE_MULT,
  GEAR_BOW_RANGE_PX,
  GEAR_BOW_RANGED_BONUS,
  GEAR_CAPS,
  GEAR_EMPTY_SLOT_FACTOR,
  GEAR_ENEMY_WEIGHTS,
  GEAR_LEVEL_WEIGHTS,
  GEAR_MINIBOSS_MIN_LEVEL,
  GEAR_PICKUP_RADIUS,
  GEAR_SCATTER_RADIUS,
  GEAR_SLOT_WEIGHTS,
  HORN_DURATION_MS,
  MAGNET_PULL_SPEED,
  VAMPIRE_HEAL_HP,
  VAMPIRE_KILLS_PER_HEAL,
} from './balance';
import { lootTierOf } from './loot';
import type {
  AccessoryKind,
  ActiveBuff,
  AttackDef,
  BasicGearSlot,
  BuffKind,
  CharacterDef,
  DroppedBuffKind,
  EnemyKind,
  GearDropState,
  GearItem,
  GearLevel,
  GearSlot,
  PlayerGear,
  PlayerLoadout,
  PlayerState,
  Vec2,
} from './types';

// ───────────────────────────── Constantes ─────────────────────────────

/** Emplacements simples, dans l'ordre d'affichage. */
export const BASIC_GEAR_SLOTS: readonly BasicGearSlot[] = ['boots', 'protection', 'artifact', 'magic', 'weapon'];
/** Les 6 emplacements, dans l'ordre d'affichage du HUD (l'accessoire est le 6e). */
export const GEAR_SLOTS: readonly GearSlot[] = [...BASIC_GEAR_SLOTS, 'accessory'];
/** Sortes d'accessoires. */
export const ACCESSORY_KINDS: readonly AccessoryKind[] = ['lantern', 'magnet', 'warhorn', 'vampire'];
/** Niveaux d'objet. */
export const GEAR_LEVELS: readonly GearLevel[] = [1, 2, 3];
/** Chiffres romains du niveau (indice = niveau ; 0 = vide). */
export const ROMAN_LEVELS: readonly string[] = ['', 'I', 'II', 'III'];

// ───────────────────────────── Valeurs par défaut / normalisation ─────────────────────────────

/** Équipement vide. */
export function createGear(): PlayerGear {
  return { boots: 0, protection: 0, artifact: 0, magic: 0, weapon: 0, accessory: null };
}

/** Équipement vide, sans bonus temporaire (valeur par défaut de `PlayerState.loadout`). */
export function createLoadout(): PlayerLoadout {
  return { ...createGear(), buffs: [] };
}

/** Copie profonde d'un équipement (sans les buffs). */
export function cloneGear(g: PlayerGear): PlayerGear {
  return {
    boots: g.boots,
    protection: g.protection,
    artifact: g.artifact,
    magic: g.magic,
    weapon: g.weapon,
    accessory: g.accessory ? { kind: g.accessory.kind, level: g.accessory.level } : null,
  };
}

function asLevel(v: unknown): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 3 ? v : 0;
}

function asAccessory(v: unknown): PlayerGear['accessory'] {
  if (typeof v !== 'object' || v === null) return null;
  const a = v as { kind?: unknown; level?: unknown };
  const level = asLevel(a.level);
  if (level === 0 || typeof a.kind !== 'string' || !(ACCESSORY_KINDS as readonly string[]).includes(a.kind)) return null;
  const kind = a.kind as AccessoryKind;
  if (kind === 'vampire' && level !== 3) return null; // l'anneau du vampire n'existe qu'au niveau III
  return { kind, level: level as GearLevel };
}

/** Équipement « propre » depuis une donnée NON FIABLE (snapshot ancien / corrompu) : niveaux invalides → 0, accessoire invalide → aucun. */
export function normalizeGear(raw: unknown): PlayerGear {
  if (typeof raw !== 'object' || raw === null) return createGear();
  const r = raw as Record<string, unknown>;
  return {
    boots: asLevel(r.boots),
    protection: asLevel(r.protection),
    artifact: asLevel(r.artifact),
    magic: asLevel(r.magic),
    weapon: asLevel(r.weapon),
    accessory: asAccessory(r.accessory),
  };
}

/** Loadout « propre » depuis une donnée NON FIABLE : équipement normalisé, buffs valides conservés (sorte connue, durée > 0). */
export function normalizeLoadout(raw: unknown): PlayerLoadout {
  const gear = normalizeGear(raw);
  const buffs: ActiveBuff[] = [];
  const list = typeof raw === 'object' && raw !== null ? (raw as { buffs?: unknown }).buffs : undefined;
  if (Array.isArray(list)) {
    for (const b of list) {
      if (typeof b !== 'object' || b === null) continue;
      const { kind, remainingMs, power } = b as { kind?: unknown; remainingMs?: unknown; power?: unknown };
      if (typeof remainingMs !== 'number' || !Number.isFinite(remainingMs) || remainingMs <= 0) continue;
      if (kind === 'speed' || kind === 'rage' || kind === 'star') buffs.push({ kind, remainingMs });
      else if (kind === 'horn' && typeof power === 'number' && Number.isFinite(power) && power > 0) buffs.push({ kind, remainingMs, power: Math.min(power, 1) });
    }
  }
  const out: PlayerLoadout = { ...gear, buffs };
  const rk = typeof raw === 'object' && raw !== null ? (raw as { ringKills?: unknown }).ringKills : undefined;
  if (typeof rk === 'number' && Number.isInteger(rk) && rk > 0 && gear.accessory?.kind === 'vampire') out.ringKills = rk % VAMPIRE_KILLS_PER_HEAL;
  return out;
}

/** Pose un loadout par défaut sur un joueur qui n'en a pas (ancien snapshot, état construit à la main) ; normalise sinon. MUTE `p`. */
export function ensureLoadout(p: PlayerState): void {
  p.loadout = normalizeLoadout((p as { loadout?: unknown }).loadout);
}

// ───────────────────────────── Lecture ─────────────────────────────

/** Niveau équipé d'un emplacement (0 = vide ; accessoire : son niveau). */
export function gearLevelOf(g: PlayerGear, slot: GearSlot): number {
  return slot === 'accessory' ? (g.accessory?.level ?? 0) : g[slot];
}

/** Objet équipé dans un emplacement, ou null s'il est vide. */
export function itemOfSlot(g: PlayerGear, slot: GearSlot): GearItem | null {
  if (slot === 'accessory') return g.accessory ? { slot, level: g.accessory.level, accessory: g.accessory.kind } : null;
  const level = g[slot];
  return level >= 1 ? { slot, level: level as GearLevel } : null;
}

/** Objets équipés, dans l'ordre des emplacements. */
export function equippedItems(g: PlayerGear): GearItem[] {
  const out: GearItem[] = [];
  for (const slot of GEAR_SLOTS) {
    const it = itemOfSlot(g, slot);
    if (it) out.push(it);
  }
  return out;
}

/** Nombre d'emplacements garnis (0..6). */
export function equippedCount(g: PlayerGear): number {
  let n = 0;
  for (const slot of GEAR_SLOTS) if (gearLevelOf(g, slot) > 0) n++;
  return n;
}

/** Équipement entièrement vide ? */
export function isGearEmpty(g: PlayerGear): boolean {
  return equippedCount(g) === 0;
}

/** Deux objets identiques (emplacement, niveau, sorte) ? */
export function sameItem(a: GearItem, b: GearItem): boolean {
  return a.slot === b.slot && a.level === b.level && (a.accessory ?? null) === (b.accessory ?? null);
}

/** Deux équipements identiques ? (comparaison de sauvegardes) */
export function sameGear(a: PlayerGear, b: PlayerGear): boolean {
  for (const slot of BASIC_GEAR_SLOTS) if (a[slot] !== b[slot]) return false;
  return (a.accessory?.kind ?? null) === (b.accessory?.kind ?? null) && (a.accessory?.level ?? 0) === (b.accessory?.level ?? 0);
}

// ───────────────────────────── Ramassage ─────────────────────────────

/** Issue d'un contact joueur / objet : 'equip' (équipe, remplace l'ancien), 'upgrade' (accessoire amélioré), 'swap' (échange MANUEL), 'ignore' (reste au sol). */
export type PickupDecision = 'equip' | 'upgrade' | 'swap' | 'ignore';

/**
 * Règle de ramassage d'un objet par un joueur (voir l'en-tête du module) :
 *  - emplacement simple : STRICTEMENT meilleur (niveau supérieur) → 'equip', sinon 'ignore' ;
 *  - accessoire : vide → 'equip' ; même sorte, niveau supérieur → 'upgrade' ; même sorte, niveau égal ou inférieur → 'ignore' ;
 *    sorte différente → 'swap' (jamais d'échange automatique).
 * Un objet invalide (accessoire sans sorte, anneau hors niveau III) est ignoré.
 */
export function pickupDecision(g: PlayerGear, item: GearItem): PickupDecision {
  if (item.slot !== 'accessory') return item.level > g[item.slot] ? 'equip' : 'ignore';
  if (!item.accessory || (item.accessory === 'vampire' && item.level !== 3)) return 'ignore';
  const cur = g.accessory;
  if (!cur) return 'equip';
  if (cur.kind === item.accessory) return item.level > cur.level ? 'upgrade' : 'ignore';
  return 'swap';
}

/**
 * Équipe un objet (MUTE `g`) et retourne l'objet remplacé (ou null si l'emplacement était vide). Ne vérifie PAS la règle de ramassage
 * (voir `pickupDecision`) : l'échange manuel d'accessoire passe aussi par ici.
 */
export function equipItem(g: PlayerGear, item: GearItem): GearItem | null {
  const old = itemOfSlot(g, item.slot);
  if (item.slot === 'accessory') {
    g.accessory = item.accessory ? { kind: item.accessory, level: item.level } : null;
    if (g.accessory?.kind !== 'vampire') delete (g as PlayerLoadout).ringKills; // le compteur de l'anneau n'a de sens que tant qu'il est porté
  } else g[item.slot] = item.level;
  return old;
}

/**
 * Retire TOUT l'équipement et les buffs (MUTE `loadout`) et retourne les objets perdus, dans l'ordre des emplacements. Appelé quand un joueur tombe.
 */
export function stripLoadout(l: PlayerLoadout): GearItem[] {
  const lost = equippedItems(l);
  const empty = createGear();
  for (const slot of BASIC_GEAR_SLOTS) l[slot] = empty[slot];
  l.accessory = null;
  l.buffs = [];
  delete l.ringKills;
  return lost;
}

// ───────────────────────────── Effets ─────────────────────────────

/** Bonus [B18] d'un emplacement simple pour son niveau équipé (0 si vide). */
function slotBonus(slot: BasicGearSlot, level: number): number {
  return level >= 1 && level <= 3 ? GEAR_BONUS[slot][level - 1] : 0;
}

/** Équipement avec, éventuellement, ses bonus temporaires (un `PlayerLoadout` complet convient, un `PlayerGear` aussi). */
export type GearWithBuffs = PlayerGear & { buffs?: readonly ActiveBuff[] };

/**
 * Bonus de vitesse de déplacement (fraction >= 0) : bottes (plafonnées à `GEAR_CAPS.speed`) + effet TEMPORAIRE le plus fort entre la potion de vitesse et
 * le cor de guerre d'un allié (jamais cumulés), le tout sous `BUFF_SPEED_TOTAL_CAP`.
 */
export function speedBonus(l: GearWithBuffs | undefined): number {
  const boots = Math.min(GEAR_CAPS.speed, slotBonus('boots', l?.boots ?? 0));
  let temp = 0;
  for (const b of l?.buffs ?? []) {
    if (b.kind === 'speed') temp = Math.max(temp, BUFF_SPEED_BONUS);
    else if (b.kind === 'horn') temp = Math.max(temp, Math.max(0, b.power ?? 0));
  }
  return Math.min(BUFF_SPEED_TOTAL_CAP, boots + temp);
}

/** Réduction des dégâts reçus (fraction >= 0, plafonnée à `GEAR_CAPS.protection`), appliquée après la difficulté et la résistance. */
export function damageReduction(l: PlayerGear | undefined): number {
  return Math.min(GEAR_CAPS.protection, slotBonus('protection', l?.protection ?? 0));
}

/** Réduction de la recharge du spécial (fraction >= 0, plafonnée à `GEAR_CAPS.special`). */
export function specialCooldownReduction(l: PlayerGear | undefined): number {
  return Math.min(GEAR_CAPS.special, slotBonus('artifact', l?.artifact ?? 0));
}

/** Réduction du temps de relevage de CELUI QUI RELÈVE (fraction >= 0, plafonnée à `GEAR_CAPS.revive`). */
export function reviveTimeReduction(l: PlayerGear | undefined): number {
  return Math.min(GEAR_CAPS.revive, slotBonus('magic', l?.magic ?? 0));
}

/** Recharge effective (ms) du spécial : `base × (1 - réduction)`, arrondie. */
export function effectiveSpecialCooldownMs(baseMs: number, l: PlayerGear | undefined): number {
  return Math.round(baseMs * (1 - specialCooldownReduction(l)));
}

/** Famille d'arme équipée. */
export type WeaponMode = 'none' | 'sword' | 'axe' | 'bow';

/** Arme équipée : niveau I épée, II hache, III arc. */
export function weaponMode(l: PlayerGear | undefined): WeaponMode {
  const w = l?.weapon ?? 0;
  return w === 1 ? 'sword' : w === 2 ? 'axe' : w === 3 ? 'bow' : 'none';
}

/**
 * Attaque EFFECTIVE d'un héros avec son arme : la définition du personnage (même objet, aucune allocation) sans arme ou avec l'épée ;
 * hache → délai entre deux attaques × `GEAR_AXE_COOLDOWN_MULT` ; arc → un héros au corps à corps TIRE (flèche, portée `GEAR_BOW_RANGE_PX`,
 * même cadence et même animation que son corps à corps), un héros qui tire déjà garde son tir (inchangé).
 */
export function effectiveAttack(character: CharacterDef, l: PlayerGear | undefined): AttackDef {
  const atk = character.attack;
  switch (weaponMode(l)) {
    case 'axe':
      return { ...atk, cooldownMs: atk.cooldownMs * GEAR_AXE_COOLDOWN_MULT };
    case 'bow':
      if (atk.kind === 'ranged') return atk;
      return {
        kind: 'ranged',
        cooldownMs: atk.cooldownMs,
        range: GEAR_BOW_RANGE_PX,
        animMs: atk.animMs,
        damageMult: atk.damageMult,
        projectile: {
          kind: 'arrow',
          speed: GEAR_BOW_ARROW_SPEED,
          lifeMs: (GEAR_BOW_RANGE_PX / GEAR_BOW_ARROW_SPEED) * 1000,
          radius: GEAR_BOW_ARROW_RADIUS,
          pierce: false,
        },
      };
    default:
      return atk;
  }
}

/**
 * Multiplicateur des dégâts de l'ATTAQUE NORMALE (pas des spéciaux) : épée ×1,20 ; hache ×1,35 ; arc ×0,70 pour un héros au corps à corps
 * (il tire) et ×1,15 pour un héros qui tire déjà ; sans arme ×1.
 */
export function attackDamageMultiplier(character: CharacterDef, l: GearWithBuffs | undefined): number {
  return weaponDamageMultiplier(character, l) * rageMultiplier(l);
}

/** Multiplicateur de TOUS les dégâts infligés (attaque normale ET spécial) : éclair de rage ×1,5 tant qu'il dure, sinon ×1. */
export function rageMultiplier(l: { buffs?: readonly ActiveBuff[] } | undefined): number {
  return hasBuff(l, 'rage') ? 1 + BUFF_RAGE_BONUS : 1;
}

/** Part « arme » de `attackDamageMultiplier` (sans l'éclair de rage). */
function weaponDamageMultiplier(character: CharacterDef, l: PlayerGear | undefined): number {
  switch (weaponMode(l)) {
    case 'sword':
      return 1 + GEAR_BONUS.weapon[0];
    case 'axe':
      return 1 + GEAR_BONUS.weapon[1];
    case 'bow':
      return character.attack.kind === 'ranged' ? 1 + GEAR_BOW_RANGED_BONUS : GEAR_BOW_MELEE_DAMAGE_MULT;
    default:
      return 1;
  }
}

// ───────────────────────────── Accessoires : effets ─────────────────────────────

/** Niveau (0 = absent) de l'accessoire de la sorte `kind` porté. */
export function accessoryLevel(g: PlayerGear | undefined, kind: AccessoryKind): number {
  return g?.accessory?.kind === kind ? g.accessory.level : 0;
}

/** Lanterne : fraction de consommation de la torche en moins (0 sans lanterne ; 0,3 / 0,5 / 0,7). */
export function lanternReduction(g: PlayerGear | undefined): number {
  const lv = accessoryLevel(g, 'lantern');
  return lv >= 1 ? ACCESSORY_BONUS.lantern[lv - 1] : 0;
}

/** Aimant à cœurs : rayon d'attraction (px) des cœurs et objets au sol (0 sans aimant ; 50 / 80 / 120). */
export function magnetRadius(g: PlayerGear | undefined): number {
  const lv = accessoryLevel(g, 'magnet');
  return lv >= 1 ? ACCESSORY_BONUS.magnet[lv - 1] : 0;
}

/** Cor de guerre : bonus de vitesse (fraction) donné aux alliés proches par l'APPEL du porteur (0 sans cor ; 0,2 / 0,3 / 0,4). */
export function hornSpeedBonus(g: PlayerGear | undefined): number {
  const lv = accessoryLevel(g, 'warhorn');
  return lv >= 1 ? ACCESSORY_BONUS.warhorn[lv - 1] : 0;
}

/** Le joueur porte-t-il l'anneau du vampire (niveau III) ? */
export function hasVampireRing(g: PlayerGear | undefined): boolean {
  return g?.accessory?.kind === 'vampire' && g.accessory.level === 3;
}

/**
 * Anneau du vampire : comptabilise la mort d'un ennemi (non invoqué) tué par le porteur (MUTE `l.ringKills`) ; retourne les PV à rendre
 * (`VAMPIRE_HEAL_HP` tous les `VAMPIRE_KILLS_PER_HEAL` ennemis, 0 sinon). Sans anneau : 0, rien n'est compté.
 */
export function registerRingKill(l: PlayerLoadout): number {
  if (!hasVampireRing(l)) return 0;
  const n = (l.ringKills ?? 0) + 1;
  if (n >= VAMPIRE_KILLS_PER_HEAL) {
    l.ringKills = 0;
    return VAMPIRE_HEAL_HP;
  }
  l.ringKills = n;
  return 0;
}

/** Cor de guerre : bonus de vitesse reçu par un allié depuis l'APPEL du porteur `horn` (3 s) ; null si le porteur n'a pas de cor. */
export function hornBuffFor(horn: PlayerGear | undefined): ActiveBuff | null {
  const power = hornSpeedBonus(horn);
  return power > 0 ? { kind: 'horn', remainingMs: HORN_DURATION_MS, power } : null;
}

// ───────────────────────────── Bonus temporaires ─────────────────────────────

/** Durée (ms) d'un bonus temporaire ramassé (potion et rage : 8 s ; étoile : 4 s). */
export function buffDurationMs(kind: DroppedBuffKind): number {
  return kind === 'star' ? BUFF_STAR_DURATION_MS : BUFF_DURATION_MS;
}

/** Le bonus `kind` est-il actif ? */
export function hasBuff(l: { buffs?: readonly ActiveBuff[] } | undefined, kind: BuffKind): boolean {
  return (l?.buffs ?? []).some((b) => b.kind === kind && b.remainingMs > 0);
}

/** Temps restant (ms) du bonus `kind` (0 s'il n'est pas actif). */
export function buffRemainingMs(l: { buffs?: readonly ActiveBuff[] } | undefined, kind: BuffKind): number {
  let best = 0;
  for (const b of l?.buffs ?? []) if (b.kind === kind) best = Math.max(best, b.remainingMs);
  return best;
}

/** L'étoile (invulnérabilité) est-elle active ? */
export function isStarActive(l: { buffs?: readonly ActiveBuff[] } | undefined): boolean {
  return hasBuff(l, 'star');
}

/**
 * Démarre (ou relance) un bonus temporaire (MUTE `l.buffs`) : un bonus déjà actif de la même sorte repart à la durée pleine (jamais cumulé, jamais raccourci ;
 * `horn` garde la plus forte des deux puissances). Retourne le bonus actif.
 */
export function addBuff(l: PlayerLoadout, buff: ActiveBuff): ActiveBuff {
  const cur = l.buffs.find((b) => b.kind === buff.kind);
  if (cur) {
    cur.remainingMs = Math.max(cur.remainingMs, buff.remainingMs);
    if (buff.power !== undefined) cur.power = Math.max(cur.power ?? 0, buff.power);
    return cur;
  }
  const fresh: ActiveBuff = buff.power !== undefined ? { kind: buff.kind, remainingMs: buff.remainingMs, power: buff.power } : { kind: buff.kind, remainingMs: buff.remainingMs };
  l.buffs.push(fresh);
  return fresh;
}

/** Fait vieillir les bonus temporaires de `dtMs` et retire les échus (MUTE `l.buffs`, ordre conservé). */
export function stepBuffs(l: PlayerLoadout, dtMs: number): void {
  const buffs = l.buffs;
  if (buffs.length === 0) return;
  let w = 0;
  for (let i = 0; i < buffs.length; i++) {
    const b = buffs[i];
    b.remainingMs -= dtMs;
    if (b.remainingMs > 1e-6) buffs[w++] = b;
  }
  buffs.length = w;
}

// ───────────────────────────── Échange manuel d'accessoire ─────────────────────────────

/**
 * Objet au sol que le joueur peut ÉCHANGER (action A) : le plus proche, dans `GEAR_PICKUP_RADIUS`, dont la décision de ramassage est 'swap' (accessoire d'une
 * AUTRE sorte que celui porté) et qui n'est pas verrouillé pour lui. null si aucun. Fonction pure partagée par la simulation et l'invite « A : échanger ».
 */
export function swapCandidate(
  drops: readonly GearDropState[],
  player: Pick<PlayerState, 'id' | 'pos' | 'status' | 'loadout'>,
): GearDropState | null {
  if (player.status !== 'alive') return null;
  const r2 = GEAR_PICKUP_RADIUS * GEAR_PICKUP_RADIUS;
  let best: GearDropState | null = null;
  let bestD = Infinity;
  for (const d of drops) {
    if (d.lockedFor === player.id || d.ttlMs <= 0 || d.item.slot !== 'accessory') continue;
    const dx = d.pos.x - player.pos.x;
    const dy = d.pos.y - player.pos.y;
    const dd = dx * dx + dy * dy;
    if (dd > r2 || dd >= bestD) continue;
    if (pickupDecision(player.loadout, d.item) !== 'swap') continue;
    best = d;
    bestD = dd;
  }
  return best;
}

// ───────────────────────────── Aimant ─────────────────────────────

/**
 * Nouvelle position d'un objet tiré par l'aimant : `MAGNET_PULL_SPEED` px/s vers `to`, sans dépasser la cible. Pure.
 * L'appelant vérifie que la position est praticable (murs) avant de l'adopter.
 */
export function magnetStep(from: Vec2, to: Vec2, dtMs: number): Vec2 {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  const step = (MAGNET_PULL_SPEED * dtMs) / 1000;
  if (!(dist > 1e-6) || step >= dist) return { x: to.x, y: to.y };
  return { x: from.x + (dx / dist) * step, y: from.y + (dy / dist) * step };
}

// ───────────────────────────── Tirage ─────────────────────────────

/** Poids d'un ennemi dans la répartition du budget : `GEAR_ENEMY_WEIGHTS` de son palier ; 0 pour un demi-boss ou un boss final (règles propres). */
export function enemyGearWeight(kind: EnemyKind): number {
  const tier = lootTierOf(kind);
  return tier === 'none' || tier === 'miniBoss' ? 0 : GEAR_ENEMY_WEIGHTS[tier];
}

/** Joueur vivant le MOINS équipé (égalité : plus petit id), ou null s'il n'y en a aucun. */
export function leastEquippedAlive(players: readonly Pick<PlayerState, 'id' | 'status' | 'loadout'>[]): Pick<PlayerState, 'id' | 'status' | 'loadout'> | null {
  let best: Pick<PlayerState, 'id' | 'status' | 'loadout'> | null = null;
  let bestN = Infinity;
  for (const p of players) {
    if (p.status !== 'alive') continue;
    const n = equippedCount(p.loadout);
    if (n < bestN || (n === bestN && best !== null && p.id < best.id)) {
      best = p;
      bestN = n;
    }
  }
  return best;
}

/**
 * Poids de tirage de chaque emplacement : `GEAR_SLOT_WEIGHTS`, magie retirée à 1 joueur (poids redistribué par le tirage proportionnel), et poids
 * ×`GEAR_EMPTY_SLOT_FACTOR` pour les emplacements VIDES du joueur vivant le moins équipé.
 */
export function slotWeights(
  players: readonly Pick<PlayerState, 'id' | 'status' | 'loadout'>[],
  playerCount: number,
): Record<GearSlot, number> {
  const w: Record<GearSlot, number> = { ...GEAR_SLOT_WEIGHTS };
  if (playerCount <= 1) w.magic = 0;
  const needy = leastEquippedAlive(players);
  if (needy) {
    for (const slot of GEAR_SLOTS) if (gearLevelOf(needy.loadout, slot) === 0) w[slot] *= GEAR_EMPTY_SLOT_FACTOR;
  }
  return w;
}

/** Tirage pondéré d'un indice parmi `weights` (un seul `random()`) ; -1 si la somme est nulle. */
export function pickWeighted(weights: readonly number[], random: () => number): number {
  let total = 0;
  for (const x of weights) total += Math.max(0, x);
  if (!(total > 0)) return -1;
  let r = random() * total;
  for (let i = 0; i < weights.length; i++) {
    const x = Math.max(0, weights[i]);
    if (r < x) return i;
    r -= x;
  }
  for (let i = weights.length - 1; i >= 0; i--) if (weights[i] > 0) return i;
  return -1;
}

/** Niveau tiré selon `GEAR_LEVEL_WEIGHTS` (un seul `random()`), au moins `minLevel` (les niveaux inférieurs sont exclus et leur poids perdu). */
export function pickGearLevel(random: () => number, minLevel = 1): GearLevel {
  const weights = GEAR_LEVEL_WEIGHTS.map((w, i) => (i + 1 >= minLevel ? w : 0));
  const i = pickWeighted(weights, random);
  return ((i < 0 ? Math.max(1, Math.min(3, minLevel)) : i + 1) as GearLevel);
}

/**
 * Poids de tirage de la sorte d'accessoire (dans l'ordre de `ACCESSORY_KINDS`). Le cor de guerre n'agit que sur les ALLIÉS : en solo (1 joueur) il serait sans
 * effet, son poids est donc retiré (redistribué, comme la magie) — jamais d'accessoire inutile tiré en solo.
 */
export function accessoryKindWeights(playerCount: number): number[] {
  return ACCESSORY_KINDS.map((kind) => (kind === 'warhorn' && playerCount <= 1 ? 0 : ACCESSORY_KIND_WEIGHTS[kind]));
}

/**
 * Tire un objet complet : emplacement (`slotWeights`) PUIS niveau (`pickGearLevel`) — 2 appels de `random()` (3 pour un accessoire : la sorte).
 * Accessoire : sorte tirée selon `ACCESSORY_KIND_WEIGHTS` (lanterne / aimant / cor de guerre à égalité, anneau du vampire RARE ; cor de guerre retiré en solo) ; l'anneau est toujours de
 * niveau III (le tirage du niveau a lieu quand même : flux stable).
 */
export function pickGearItem(
  random: () => number,
  players: readonly Pick<PlayerState, 'id' | 'status' | 'loadout'>[],
  playerCount: number,
  minLevel = 1,
): GearItem | null {
  const w = slotWeights(players, playerCount);
  const si = pickWeighted(GEAR_SLOTS.map((s) => w[s]), random);
  if (si < 0) return null;
  const slot = GEAR_SLOTS[si];
  const level = pickGearLevel(random, minLevel);
  if (slot !== 'accessory') return { slot, level };
  const k = pickWeighted(accessoryKindWeights(playerCount), random);
  const kind = ACCESSORY_KINDS[Math.max(0, k)];
  return { slot, level: kind === 'vampire' ? 3 : level, accessory: kind };
}

// ───────────────────────────── Tirage des bonus temporaires ─────────────────────────────

/** Sortes de bonus temporaires ramassables. */
export const DROPPED_BUFF_KINDS: readonly DroppedBuffKind[] = ['speed', 'rage', 'star'];

/**
 * Budget entier de bonus temporaires d'une salle : `floor(0,3 n)` + 1 avec la probabilité du reste (UN `random()` ; 0 appel si le reste est nul). L'espérance
 * est exactement `BUFF_BUDGET_PER_PLAYER × n` (~0,3 par héros).
 */
export function rollBuffBudget(playerCount: number, random: () => number): number {
  const exact = Math.max(0, playerCount) * BUFF_BUDGET_PER_PLAYER;
  const whole = Math.floor(exact + 1e-9);
  const frac = exact - whole;
  if (!(frac > 1e-9)) return whole;
  return whole + (random() < frac ? 1 : 0);
}

/** Sorte de bonus tirée selon `BUFF_KIND_WEIGHTS` (un seul `random()`). */
export function pickBuffKind(random: () => number): DroppedBuffKind {
  const i = pickWeighted(DROPPED_BUFF_KINDS.map((k) => BUFF_KIND_WEIGHTS[k]), random);
  return DROPPED_BUFF_KINDS[Math.max(0, i)];
}

/** Entrées du tirage d'un bonus temporaire laissé par un ennemi mort. */
export interface BuffRollInput {
  kind: EnemyKind;
  summoned: boolean;
  /** L'ennemi laisse DÉJÀ un cœur ou un objet d'équipement : pas de bonus (le budget reste pour les suivants). */
  hasDrop: boolean;
  /** Probabilité que CET ennemi laisse un cœur ou un objet (compensation de l'exclusion mutuelle). */
  otherDropChance: number;
  /** Budget de bonus RESTANT dans la salle. */
  budget: number;
  /** Somme des poids des ennemis ordinaires restants, CET ENNEMI INCLUS. */
  weightLeft: number;
  random: () => number;
}

/**
 * Tire le bonus temporaire d'un ennemi mort : mêmes règles de répartition que l'équipement (`budgetRestant × poids / poidsRestants`, compensée par l'exclusion
 * avec le cœur et l'objet), demi-boss et boss finaux exclus. Un seul tirage de décision, puis un pour la sorte.
 */
export function rollBuffDrop(input: BuffRollInput): DroppedBuffKind | null {
  if (input.summoned || input.hasDrop) return null;
  const w = enemyGearWeight(input.kind);
  if (!(w > 0) || !(input.budget > 0)) return null;
  const base = input.budget * (w / Math.max(w, input.weightLeft));
  const keep = 1 - Math.min(0.9, Math.max(0, input.otherDropChance));
  const p = Math.min(1, base / keep);
  if (!(input.random() < p)) return null;
  return pickBuffKind(input.random);
}

/** Entrées du tirage d'un ennemi mort. */
export interface GearRollInput {
  kind: EnemyKind;
  /** Invoqué en cours de combat : jamais d'objet. */
  summoned: boolean;
  /** L'ennemi laisse DÉJÀ un cœur de vie : pas d'objet (exclusion mutuelle), le budget reste pour les suivants. */
  hasHeart: boolean;
  /** Probabilité de cœur de CET ennemi (compensation de l'exclusion mutuelle ; 0 si le butin de vie est désactivé). */
  heartChance: number;
  /** Budget d'objets RESTANT dans la salle. */
  budget: number;
  /** Demi-boss encore à vaincre (vivants ou en attente d'apparition), HORS cet ennemi : chacun réserve un objet du budget. */
  reservedForMiniBosses: number;
  /** Somme des poids des ennemis ordinaires restants (vivants + à venir), CET ENNEMI INCLUS. */
  weightLeft: number;
  playerCount: number;
  players: readonly Pick<PlayerState, 'id' | 'status' | 'loadout'>[];
  /** PRNG isolé de l'équipement. Consommé UNIQUEMENT pour un ennemi éligible (1 appel de décision, puis 2-3 si un objet tombe). */
  random: () => number;
}

/**
 * Probabilité qu'un ennemi ordinaire laisse un objet : `budgetDisponible × poids / poidsRestants`, divisée par `(1 - heartChance)` (le cœur exclut
 * l'objet : on compense pour que l'espérance reste ~ le budget), bornée à 1. 0 si le budget (hors demi-boss à venir) est épuisé.
 */
export function gearDropChance(input: Pick<GearRollInput, 'kind' | 'budget' | 'reservedForMiniBosses' | 'weightLeft' | 'heartChance'>): number {
  const w = enemyGearWeight(input.kind);
  const available = input.budget - input.reservedForMiniBosses;
  if (!(w > 0) || !(available > 0)) return 0;
  const base = available * (w / Math.max(w, input.weightLeft));
  const keep = 1 - Math.min(0.9, Math.max(0, input.heartChance));
  return Math.min(1, base / keep);
}

/**
 * Tire l'objet d'un ennemi mort (voir l'en-tête du module) :
 *  - invoqué, boss final : rien, aucun tirage ;
 *  - demi-boss : un objet du budget s'il en reste (niveau >= `GEAR_MINIBOSS_MIN_LEVEL`), même s'il laisse aussi un cœur ;
 *  - ennemi ordinaire : rien s'il laisse un cœur ; sinon UN tirage de décision (`gearDropChance`), puis le tirage de l'objet.
 * Retourne l'objet (le budget à décrémenter est l'affaire de l'appelant : 1 si un objet est retourné).
 */
export function rollGearDrop(input: GearRollInput): GearItem | null {
  if (input.summoned) return null;
  const tier = lootTierOf(input.kind);
  if (tier === 'none') return null;
  if (tier === 'miniBoss') {
    if (!(input.budget >= 1)) return null;
    return pickGearItem(input.random, input.players, input.playerCount, GEAR_MINIBOSS_MIN_LEVEL);
  }
  if (input.hasHeart) return null;
  const p = gearDropChance(input);
  if (!(p > 0)) return null;
  if (!(input.random() < p)) return null;
  return pickGearItem(input.random, input.players, input.playerCount);
}

// ───────────────────────────── Vie au sol ─────────────────────────────

/**
 * Fait vieillir les objets au sol de `dtMs` et retire les périmés (`ttlMs` <= 0). MUTE le tableau (suppression en place, ordre conservé) ;
 * retourne les objets retirés.
 */
export function ageGearDrops<T extends { ttlMs: number }>(drops: T[], dtMs: number): T[] {
  const expired: T[] = [];
  let w = 0;
  for (let i = 0; i < drops.length; i++) {
    const d = drops[i];
    d.ttlMs -= dtMs;
    if (d.ttlMs <= 1e-6) expired.push(d);
    else drops[w++] = d;
  }
  drops.length = w;
  return expired;
}

// ───────────────────────────── Éparpillement ─────────────────────────────

/**
 * Points d'éparpillement de `count` objets autour de `center` : régulièrement répartis sur un cercle de `GEAR_SCATTER_RADIUS` px (premier objet
 * en haut), déterministes. Un seul objet : posé à `GEAR_SCATTER_RADIUS` au-dessus. La simulation ramène ensuite chaque point sur une case praticable.
 */
export function scatterPoints(center: Vec2, count: number): Vec2[] {
  const out: Vec2[] = [];
  for (let k = 0; k < count; k++) {
    const a = -Math.PI / 2 + (2 * Math.PI * k) / Math.max(1, count);
    out.push({ x: center.x + Math.cos(a) * GEAR_SCATTER_RADIUS, y: center.y + Math.sin(a) * GEAR_SCATTER_RADIUS });
  }
  return out;
}
