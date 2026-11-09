/**
 * Combat (logique pure, déterministe) : attaques de mêlée et à distance des joueurs, projectiles, impacts, soin,
 * dégâts joueur → ennemi et ennemi → joueur.
 *
 * Règles (DESIGN.md §3) :
 *  - dégâts infligés à un ennemi par le joueur P = `damageToEnemy(brut, difficulté(P))` (brut ÷ multPV de P) ;
 *  - dégâts reçus par un joueur = `applyDamageToPlayer` (difficulté DU joueur touché × résistance) ;
 *  - AUCUN dégât entre joueurs (pas de tir ami) ; seuls les projectiles de type 'heal' agissent sur les alliés : ils
 *    soignent de `HEAL_PROJECTILE_AMOUNT` PV un allié VIVANT blessé (jamais au-delà de `maxHp`) ; ils blessent aussi les
 *    ennemis (faiblement : dégâts de base × `damageMult` du personnage) ;
 *  - un joueur à terre ne subit jamais de dégâts et n'arrête pas les projectiles (ils le traversent) ;
 *  - mêlée : instantanée au déclenchement (l'animation `attackAnimMs` est purement visuelle), arc devant le joueur
 *    (`isInArc` de geometry.ts), ligne de vue requise (pas de coup à travers un mur ou une porte fermée) ;
 *  - un projectile non perforant disparaît à son premier impact ; un perforant n'atteint chaque cible qu'une fois.
 *
 * Ce module n'importe PAS ai.ts : la réaction d'un ennemi touché (recul, flash, étourdissement) est injectée via
 * `CombatContext.onEnemyHit` (la simulation y branche `onEnemyHit` de ai.ts).
 *
 * Les fonctions MUTENT uniquement ce que leur JSDoc indique (états joueurs/ennemis/projectiles, `ctx.events`, `ctx.killers`).
 */
import { PLAYER_RADIUS } from './constants';
import { damageToEnemy, playerBaseDamage, playerSpecialDamage } from './balance';
import { getCharacter } from './characters';
import { attackDamageMultiplier, effectiveAttack, effectiveSpecialCooldownMs, rageMultiplier } from './gear';
import { moveCircle, projectileHitsWall, segmentBlocked, type PixelRect } from './collision';
import { angleBetween, circleOverlap, dirVec, isInArc, vecFromAngle } from './geometry';
import { ENEMIES } from './enemies';
import { applyDamageToPlayer, isRescuing } from './players';
import type { RoomGrid } from './grid';
import type {
  Dir,
  EnemyState,
  PlayerId,
  PlayerState,
  ProjectileState,
  RoomState,
  SimEvent,
  SpecialDef,
  Vec2,
} from './types';

// ───────────────────────────── Constantes ─────────────────────────────

/** PV rendus à un allié vivant blessé touché par un projectile 'heal' (plafonné à `maxHp`). */
export const HEAL_PROJECTILE_AMOUNT = 12;
/** Longueur maximale (px) d'un sous-pas de déplacement de projectile (anti-tunnelage). */
export const PROJECTILE_SUBSTEP_PX = 3;
/** Nombre maximal de projectiles simultanés dans une salle (garde-fou). */
export const MAX_PROJECTILES = 200;
/** Durée minimale (ms) du clignotement d'un ennemi touché si l'IA n'en a pas posé. */
export const MIN_HIT_FLASH_MS = 90;
/** Part des PV max qu'un boss peut perdre par fenêtre de `BOSS_DAMAGE_WINDOW_MS` (plafond anti-cumul de spéciaux). */
export const BOSS_DAMAGE_CAP_FRACTION = 0.2;
/** Durée (ms) de la fenêtre du plafond de dégâts sur les boss ET les demi-boss. */
export const BOSS_DAMAGE_WINDOW_MS = 2000;
/** Part des PV max qu'un DEMI-boss (niveaux 4-6, `isMiniBoss`) peut perdre par fenêtre de `BOSS_DAMAGE_WINDOW_MS` (plafond plus doux). */
export const MINIBOSS_DAMAGE_CAP_FRACTION = 0.35;

// ───────────────────────────── Contexte ─────────────────────────────

/** Données et callbacks fournis par la simulation à chaque appel de combat. */
export interface CombatContext {
  /** Salle courante : `enemies` et `projectiles` sont lus ET mutés (projectiles : le tableau est remplacé). */
  room: RoomState;
  /** Tous les joueurs (mutés : PV, cooldown, animation…). */
  players: PlayerState[];
  /** Grille statique de la salle. */
  grid: RoomGrid;
  /** Rectangles solides dynamiques (portes fermées, blocs) — arrêtent les projectiles et la ligne de vue. */
  solids: readonly PixelRect[];
  /** Tampon d'événements (poussé en fin de tableau). */
  events: SimEvent[];
  /** Fournit un nouvel identifiant d'entité unique. */
  nextId(): number;
  /** Réaction d'un ennemi touché (ai.ts `onEnemyHit` : flash, recul, étourdissement). */
  onEnemyHit(enemy: EnemyState, hitFrom: Vec2, rawDamage: number): void;
  /** Attribution des morts : id d'ennemi → dernier joueur l'ayant frappé (rempli par `damageEnemy`). */
  killers: Map<number, PlayerId>;
  /** Faux ⇒ aucun dégât infligé ni subi (phases 'roomCleared', 'levelComplete', 'wipe'). */
  damageEnabled: boolean;
  /** Appelé quand un joueur vient de tomber à terre (la simulation y teste la mort d'équipe). */
  onPlayerDowned?(player: PlayerState): void;
  /** Étourdissement par un spécial (ai.ts `stunEnemy` ; boss : simple retard). Absent => pas d'étourdissement. */
  stunEnemy?(enemy: EnemyState, ms: number): void;
  /** Recul fort par un spécial (ai.ts `knockEnemy`, vitesse initiale px/s). Absent => pas de recul supplémentaire. */
  knockEnemy?(enemy: EnemyState, from: Vec2, speed: number): void;
}

// ───────────────────────────── Aides pures ─────────────────────────────

/** Rayon maximal (px) utilisé pour tester les murs avec un projectile de joueur (évite les tirs « fantômes » le long d'un coin). */
export const PLAYER_PROJECTILE_WALL_RADIUS = 2;

/** Rayon de collision MUR d'un projectile de joueur : réduit (min(rayon, 2)) ; le rayon complet reste utilisé contre les ennemis. */
export function playerProjectileWallRadius(radius: number): number {
  return Math.min(radius, PLAYER_PROJECTILE_WALL_RADIUS);
}

/** Rayon de collision (px) d'un ennemi d'après `ENEMIES` (6 px par défaut pour un type inconnu). */
export function enemyRadius(e: Pick<EnemyState, 'kind'>): number {
  return ENEMIES[e.kind]?.radius ?? 6;
}

/** Angle (radians, repère écran, 0 = droite) d'une direction cardinale. */
export function dirAngle(dir: Dir): number {
  const v = dirVec(dir);
  return Math.atan2(v.y, v.x);
}

/** Un joueur peut-il déclencher une attaque maintenant ? (vivant et cooldown écoulé) */
export function canPlayerAttack(p: PlayerState): boolean {
  return p.status === 'alive' && p.attackCooldownMs <= 0;
}

/**
 * Ennemis touchés par l'attaque de MÊLÉE de `player` dans sa direction `dir` (défaut : `player.facing`).
 * Pure (ne mute rien). Un ennemi est touché si :
 *  - il est vivant (`!dead`, `hp > 0`) ;
 *  - il est dans l'arc (`isInArc` : portée `attack.range` depuis le centre du joueur, ouverture `attack.arcDeg`, rayon de l'ennemi pris en compte) ;
 *  - aucun mur/porte fermée/bloc ne coupe le segment joueur → ennemi.
 * Retourne `[]` pour un personnage à distance.
 * @param player attaquant
 * @param enemies candidats
 * @param grid grille statique (ligne de vue)
 * @param solids portes fermées et blocs (ligne de vue)
 * @param dir direction de l'attaque (défaut : facing)
 */
export function meleeTargets(
  player: PlayerState,
  enemies: readonly EnemyState[],
  grid: RoomGrid,
  solids: readonly PixelRect[],
  dir: Dir = player.facing,
): EnemyState[] {
  const atk = getCharacter(player.characterId).attack;
  if (atk.kind !== 'melee') return [];
  const angle = dirAngle(dir);
  const arc = atk.arcDeg ?? 90;
  const out: EnemyState[] = [];
  for (const e of enemies) {
    if (e.dead || e.hp <= 0) continue;
    if (!isInArc(player.pos, angle, e.pos, atk.range, arc, enemyRadius(e))) continue;
    if (segmentBlocked(player.pos, e.pos, grid, solids)) continue;
    out.push(e);
  }
  return out;
}

/**
 * Soigne `target` de `amount` PV sans dépasser `maxHp` (muté). Sans effet sur un joueur à terre.
 * @returns PV réellement rendus (0 si à terre ou déjà au maximum)
 */
export function healPlayer(target: PlayerState, amount: number): number {
  if (target.status !== 'alive' || !(amount > 0)) return 0;
  const before = target.hp;
  target.hp = Math.min(target.maxHp, target.hp + amount);
  return target.hp - before;
}

/**
 * Construit (sans l'ajouter nulle part) le projectile d'une attaque à distance (celle du personnage, ou celle de l'ARC équipé : `effectiveAttack`),
 * ou null si l'attaque effective n'est pas à distance ou si le départ est dans un mur. Dégâts BRUTS = `playerBaseDamage(personnage)` × multiplicateur d'arme ; durée de vie = `projectile.lifeMs` ;
 * perforation = `projectile.pierce`. Le projectile part devant le joueur dans la direction `dir`.
 * @param player tireur
 * @param id identifiant du projectile
 * @param grid grille statique (départ dans un mur ⇒ null)
 * @param solids portes fermées / blocs
 * @param dir direction du tir (défaut : facing)
 */
export function buildPlayerProjectile(
  player: PlayerState,
  id: number,
  grid: RoomGrid,
  solids: readonly PixelRect[],
  dir: Dir = player.facing,
): ProjectileState | null {
  const character = getCharacter(player.characterId);
  const atk = effectiveAttack(character, player.loadout); // l'Arc fait tirer un héros au corps à corps
  const proj = atk.projectile;
  if (atk.kind !== 'ranged' || !proj) return null;
  const v = dirVec(dir);
  const offsets = [PLAYER_RADIUS + proj.radius, PLAYER_RADIUS, 0];
  for (const off of offsets) {
    const pos = { x: player.pos.x + v.x * off, y: player.pos.y + v.y * off };
    if (projectileHitsWall(pos, playerProjectileWallRadius(proj.radius), grid, solids)) continue;
    return {
      id,
      kind: proj.kind,
      owner: { type: 'player', id: player.id },
      pos,
      vel: { x: v.x * proj.speed, y: v.y * proj.speed },
      damage: playerBaseDamage(character) * attackDamageMultiplier(character, player.loadout),
      radius: proj.radius,
      lifeMs: proj.lifeMs,
      pierce: proj.pierce,
      hitIds: [],
    };
  }
  return null;
}

// ───────────────────────────── Dégâts ─────────────────────────────

/**
 * Plafond glissant de dégâts sur un boss : au plus `fraction` des PV max par fenêtre de `BOSS_DAMAGE_WINDOW_MS`
 * (`BOSS_DAMAGE_CAP_FRACTION` = 20 % pour un boss de fin, `MINIBOSS_DAMAGE_CAP_FRACTION` = 35 % pour un demi-boss ;
 * horloge = `room.elapsedMs`, état = `enemy.data.dmgWinStartMs` / `dmgWinTaken`, JSON pur et déterministe).
 * Empêche le cumul de spéciaux de réduire un boss à néant (et de sauter les phases). Retourne les dégâts autorisés.
 */
function capBossDamage(ctx: CombatContext, enemy: EnemyState, applied: number, fraction: number): number {
  const now = Number.isFinite(ctx.room.elapsedMs) ? ctx.room.elapsedMs : 0;
  const start = enemy.data.dmgWinStartMs;
  if (!Number.isFinite(start) || now < start || now - start >= BOSS_DAMAGE_WINDOW_MS) {
    enemy.data.dmgWinStartMs = now;
    enemy.data.dmgWinTaken = 0;
  }
  const cap = enemy.maxHp * fraction;
  const taken = Number.isFinite(enemy.data.dmgWinTaken) ? enemy.data.dmgWinTaken : 0;
  const allowed = Math.max(0, Math.min(applied, cap - taken));
  enemy.data.dmgWinTaken = taken + allowed;
  return allowed;
}

/**
 * Inflige des dégâts BRUTS à un ennemi : retire `damageToEnemy(brut, difficulté de l'attaquant)` PV, émet `enemyHit`,
 * appelle `ctx.onEnemyHit` (recul/flash) et, si les PV tombent à 0, marque `dead = true` et mémorise l'auteur dans
 * `ctx.killers` (la simulation émet `enemyDied` et retire l'ennemi plus tard dans le pas).
 * Sans effet si `ctx.damageEnabled` est faux ou si l'ennemi est déjà mort.
 * @param ctx contexte de combat
 * @param enemy ennemi touché (muté)
 * @param rawDamage dégâts bruts (`playerBaseDamage`, `ProjectileState.damage`)
 * @param attacker joueur à l'origine du coup (null ⇒ difficulté « normal », aucune attribution)
 * @param hitFrom point d'origine du coup (sens du recul)
 * @param impact position de l'impact pour l'événement (défaut : position de l'ennemi)
 * @returns PV réellement retirés (0 si sans effet)
 */
export function damageEnemy(
  ctx: CombatContext,
  enemy: EnemyState,
  rawDamage: number,
  attacker: PlayerState | null,
  hitFrom: Vec2,
  impact?: Vec2,
): number {
  if (!ctx.damageEnabled || enemy.dead || enemy.hp <= 0 || !(rawDamage > 0)) return 0;
  let applied = damageToEnemy(rawDamage, attacker ? attacker.difficulty : 2);
  const def = ENEMIES[enemy.kind];
  const capFraction = def?.isBoss ? BOSS_DAMAGE_CAP_FRACTION : def?.isMiniBoss ? MINIBOSS_DAMAGE_CAP_FRACTION : 0;
  if (capFraction > 0) {
    applied = capBossDamage(ctx, enemy, applied, capFraction);
    if (applied <= 0) {
      if (enemy.hitFlashMs < MIN_HIT_FLASH_MS) enemy.hitFlashMs = MIN_HIT_FLASH_MS;
      return 0;
    }
  }
  enemy.hp = Math.max(0, enemy.hp - applied);
  const at = impact ?? enemy.pos;
  ctx.events.push({
    type: 'enemyHit',
    enemyId: enemy.id,
    damage: applied,
    pos: { x: at.x, y: at.y },
    byPlayer: attacker ? attacker.id : null,
  });
  ctx.onEnemyHit(enemy, hitFrom, rawDamage);
  if (enemy.hitFlashMs < MIN_HIT_FLASH_MS) enemy.hitFlashMs = MIN_HIT_FLASH_MS;
  if (enemy.hp <= 0) {
    enemy.hp = 0;
    enemy.dead = true;
    if (attacker) ctx.killers.set(enemy.id, attacker.id);
  }
  return applied;
}

/**
 * Inflige des dégâts BRUTS d'ennemi à un joueur via `applyDamageToPlayer` (difficulté et résistance DU joueur touché).
 * Émet `playerHit` (dégâts réels) et `playerDown` si le coup met à terre (puis appelle `ctx.onPlayerDowned`).
 * Sans effet si `damageEnabled` est faux, si le joueur est à terre ou invulnérable.
 * @param impact position de l'impact pour l'événement (défaut : position du joueur)
 * @returns résultat de `applyDamageToPlayer`
 */
export function hurtPlayer(
  ctx: CombatContext,
  victim: PlayerState,
  rawDamage: number,
  impact?: Vec2,
): { applied: number; downed: boolean } {
  if (!ctx.damageEnabled || victim.status !== 'alive') return { applied: 0, downed: false };
  const res = applyDamageToPlayer(victim, rawDamage);
  if (res.applied > 0) {
    const at = impact ?? victim.pos;
    ctx.events.push({ type: 'playerHit', playerId: victim.id, damage: res.applied, pos: { x: at.x, y: at.y } });
  }
  if (res.downed) {
    ctx.events.push({ type: 'playerDown', playerId: victim.id });
    ctx.onPlayerDowned?.(victim);
  }
  return res;
}

/**
 * Attaque de zone d'ennemi : touche TOUS les joueurs vivants dont le disque (`PLAYER_RADIUS`) intersecte le cercle
 * (`center`, `radius`). Les joueurs à terre sont ignorés (jamais achevés).
 * @returns nombre de joueurs touchés (dégâts effectivement appliqués)
 */
export function damagePlayersInCircle(ctx: CombatContext, center: Vec2, radius: number, rawDamage: number): number {
  let n = 0;
  for (const p of ctx.players) {
    if (p.status !== 'alive') continue;
    if (!circleOverlap(center, radius, p.pos, PLAYER_RADIUS)) continue;
    if (hurtPlayer(ctx, p, rawDamage, center).applied > 0) n++;
  }
  return n;
}

// ───────────────────────────── Attaques de joueurs ─────────────────────────────

/**
 * Déclenche l'attaque de `player` (si `canPlayerAttack`) : pose cooldown, animation et direction d'attaque (= facing),
 * émet `playerAttack`, puis
 *  - mêlée : frappe immédiatement tous les ennemis de l'arc (`meleeTargets`) ;
 *  - distance : ajoute un projectile à `ctx.room.projectiles` (émet `projectileFired`), dans la limite de `MAX_PROJECTILES`.
 * Le cooldown est consommé même si rien n'est touché ou si le tir part dans un mur.
 * @param ctx contexte de combat
 * @param player attaquant (muté)
 * @returns true si une attaque a eu lieu
 */
export function performPlayerAttack(ctx: CombatContext, player: PlayerState): boolean {
  if (!ctx.damageEnabled || !canPlayerAttack(player)) return false;
  const character = getCharacter(player.characterId);
  const atk = effectiveAttack(character, player.loadout); // hache : cadence plus lente ; arc : tir à distance
  player.attackCooldownMs = atk.cooldownMs;
  player.attackAnimMs = atk.animMs;
  player.attackDir = player.facing;
  ctx.events.push({ type: 'playerAttack', playerId: player.id, dir: player.facing });

  if (atk.kind === 'melee') {
    const raw = playerBaseDamage(character) * attackDamageMultiplier(character, player.loadout);
    for (const e of meleeTargets(player, ctx.room.enemies, ctx.grid, ctx.solids, player.facing)) {
      damageEnemy(ctx, e, raw, player, player.pos);
    }
  } else if (ctx.room.projectiles.length < MAX_PROJECTILES) {
    const p = buildPlayerProjectile(player, ctx.nextId(), ctx.grid, ctx.solids, player.facing);
    if (p) {
      ctx.room.projectiles.push(p);
      ctx.events.push({ type: 'projectileFired', projectileId: p.id, kind: p.kind, pos: { x: p.pos.x, y: p.pos.y } });
    }
  }
  return true;
}

// ───────────────────────────── Projectiles ─────────────────────────────

/**
 * Fait avancer tous les projectiles de la salle d'UN pas `dtMs` et résout les impacts. Remplace `ctx.room.projectiles`
 * par les survivants. Déplacement par sous-pas de `PROJECTILE_SUBSTEP_PX` au plus (pas de tunnelage).
 *
 *  - un projectile qui touche un mur/pilier/vide, une porte fermée ou un bloc disparaît (pas les fosses) ;
 *  - sa durée de vie diminue de `dtMs` ; à 0 il disparaît (après avoir pu toucher une dernière fois) ;
 *  - projectile de joueur : touche les ennemis vivants (dégâts `damageEnemy` avec la difficulté du tireur) ; type 'heal' :
 *    soigne aussi le premier allié vivant BLESSÉ touché (les alliés à pleine santé et les joueurs à terre sont traversés) ;
 *  - projectile d'ennemi : touche les joueurs VIVANTS (les joueurs à terre sont traversés) via `hurtPlayer` ; un joueur
 *    invulnérable arrête le projectile sans subir de dégâts ;
 *  - non perforant : disparaît à son premier impact ; perforant : mémorise les cibles touchées (`hitIds`) ;
 *  - si `ctx.damageEnabled` est faux, les projectiles se déplacent et heurtent les murs mais ne touchent personne.
 *
 * @param ctx contexte de combat
 * @param dtMs durée du pas (ms)
 */
export function stepProjectiles(ctx: CombatContext, dtMs: number): void {
  const survivors: ProjectileState[] = [];
  for (const p of ctx.room.projectiles) {
    if (stepOneProjectile(ctx, p, dtMs)) survivors.push(p);
  }
  ctx.room.projectiles = survivors;
}

/** Fait avancer un projectile ; retourne true s'il survit. */
function stepOneProjectile(ctx: CombatContext, p: ProjectileState, dtMs: number): boolean {
  if (!Number.isFinite(p.pos.x) || !Number.isFinite(p.pos.y) || !Number.isFinite(p.vel.x) || !Number.isFinite(p.vel.y)) {
    return false;
  }
  p.lifeMs -= dtMs;
  const dx = (p.vel.x * dtMs) / 1000;
  const dy = (p.vel.y * dtMs) / 1000;
  const n = Math.min(24, Math.max(1, Math.ceil(Math.hypot(dx, dy) / PROJECTILE_SUBSTEP_PX)));
  const attacker =
    p.owner.type === 'player' ? ctx.players.find((q) => q.id === (p.owner as { id: PlayerId }).id) ?? null : null;
  if (p.owner.type === 'player' && !attacker) return false;

  for (let i = 0; i < n; i++) {
    p.pos.x += dx / n;
    p.pos.y += dy / n;
    const wallR = p.owner.type === 'player' ? playerProjectileWallRadius(p.radius) : p.radius;
    if (projectileHitsWall(p.pos, wallR, ctx.grid, ctx.solids)) return false;
    if (!ctx.damageEnabled) continue;
    const consumed = p.owner.type === 'player' ? hitFromPlayerProjectile(ctx, p, attacker!) : hitFromEnemyProjectile(ctx, p);
    if (consumed) return false;
  }
  return p.lifeMs > 0;
}

/** Impacts d'un projectile de joueur ; retourne true si le projectile est consommé. */
function hitFromPlayerProjectile(ctx: CombatContext, p: ProjectileState, attacker: PlayerState): boolean {
  for (const e of ctx.room.enemies) {
    if (e.dead || e.hp <= 0 || p.hitIds.includes(e.id)) continue;
    if (!circleOverlap(p.pos, p.radius, e.pos, enemyRadius(e))) continue;
    p.hitIds.push(e.id);
    damageEnemy(ctx, e, p.damage, attacker, p.pos, p.pos);
    if (!p.pierce) return true;
  }
  if (p.kind === 'heal') {
    for (const ally of ctx.players) {
      if (ally.id === attacker.id || ally.status !== 'alive' || ally.hp >= ally.maxHp) continue;
      if (!circleOverlap(p.pos, p.radius, ally.pos, PLAYER_RADIUS)) continue;
      healPlayer(ally, HEAL_PROJECTILE_AMOUNT);
      if (!p.pierce) return true;
    }
  }
  return false;
}

/** Impacts d'un projectile d'ennemi ; retourne true si le projectile est consommé. */
function hitFromEnemyProjectile(ctx: CombatContext, p: ProjectileState): boolean {
  for (const pl of ctx.players) {
    if (pl.status !== 'alive' || p.hitIds.includes(pl.id)) continue;
    if (!circleOverlap(p.pos, p.radius, pl.pos, PLAYER_RADIUS)) continue;
    p.hitIds.push(pl.id);
    hurtPlayer(ctx, pl, p.damage, p.pos);
    if (!p.pierce) return true;
  }
  return false;
}

// ───────────────────────────── Attaques spéciales ─────────────────────────────

/** Vitesse (px/s) des projectiles de la volée d'étoiles. */
export const ARROW_FAN_SPEED = 260;
/** Vitesse initiale (px/s) du recul supplémentaire du Fracas du troll. */
export const SMASH_KNOCKBACK_SPEED = 240;

/** Un joueur peut-il déclencher son spécial maintenant ? Vivant, pas en train de relever, recharge écoulée, spécial défini. */
export function canPlayerSpecial(p: PlayerState): boolean {
  if (p.status !== 'alive' || isRescuing(p)) return false;
  if (!getCharacter(p.characterId).special) return false;
  return !(p.specialCooldownMs > 0);
}

function liveEnemies(ctx: CombatContext): EnemyState[] {
  return ctx.room.enemies.filter((e) => !e.dead && e.hp > 0);
}

/** Frappe un ennemi avec le spécial : dégâts bruts, puis étourdissement / recul supplémentaires s'il survit. */
function specialHit(
  ctx: CombatContext,
  e: EnemyState,
  raw: number,
  player: PlayerState,
  from: Vec2,
  def: SpecialDef,
): void {
  damageEnemy(ctx, e, raw, player, from);
  if (e.dead || e.hp <= 0) return;
  if (def.stunMs && def.stunMs > 0) ctx.stunEnemy?.(e, def.stunMs);
  if (def.kind === 'smash') ctx.knockEnemy?.(e, from, SMASH_KNOCKBACK_SPEED);
}

/** Ennemis vivants dans le disque (centre, rayon + rayon de l'ennemi) avec ligne de vue depuis `losFrom`. */
function enemiesInCircle(ctx: CombatContext, center: Vec2, radius: number, losFrom: Vec2): EnemyState[] {
  const out: EnemyState[] = [];
  for (const e of liveEnemies(ctx)) {
    const r = radius + enemyRadius(e);
    const dx = e.pos.x - center.x;
    const dy = e.pos.y - center.y;
    if (dx * dx + dy * dy > r * r) continue;
    if (segmentBlocked(losFrom, e.pos, ctx.grid, ctx.solids)) continue;
    out.push(e);
  }
  return out;
}

/** Distance d'un point à un segment [a, b]. */
function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  const t = len2 < 1e-9 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2));
  return Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t));
}

/** Centre de la nova ardente : `range` px devant le héros, ramené vers lui si ce point est dans un mur ou derrière un mur. */
function novaCenter(ctx: CombatContext, player: PlayerState, def: SpecialDef): Vec2 {
  const v = dirVec(player.facing);
  for (let d = def.range; d > 0; d -= 8) {
    const c = { x: player.pos.x + v.x * d, y: player.pos.y + v.y * d };
    if (!projectileHitsWall(c, 0, ctx.grid, ctx.solids) && !segmentBlocked(player.pos, c, ctx.grid, ctx.solids)) return c;
  }
  return { x: player.pos.x, y: player.pos.y };
}

/** Éventail de projectiles perforants (Volée d'étoiles). Retourne le nombre de projectiles créés. */
function fireArrowFan(ctx: CombatContext, player: PlayerState, def: SpecialDef, raw: number): number {
  const count = Math.max(1, Math.floor(def.count ?? 9));
  const spread = ((def.spreadDeg ?? 40) * Math.PI) / 180;
  const base = dirAngle(player.facing);
  const lifeMs = (def.range / ARROW_FAN_SPEED) * 1000;
  let made = 0;
  for (let i = 0; i < count; i++) {
    if (ctx.room.projectiles.length >= MAX_PROJECTILES) break;
    const angle = count === 1 ? base : base - spread + (2 * spread * i) / (count - 1);
    const v = vecFromAngle(angle);
    let pos: Vec2 | null = null;
    for (const off of [PLAYER_RADIUS + def.radius, PLAYER_RADIUS, 0]) {
      const c = { x: player.pos.x + v.x * off, y: player.pos.y + v.y * off };
      if (!projectileHitsWall(c, def.radius, ctx.grid, ctx.solids)) {
        pos = c;
        break;
      }
    }
    if (!pos) continue;
    const proj: ProjectileState = {
      id: ctx.nextId(),
      kind: 'arrow',
      owner: { type: 'player', id: player.id },
      pos,
      vel: { x: v.x * ARROW_FAN_SPEED, y: v.y * ARROW_FAN_SPEED },
      damage: raw,
      radius: def.radius,
      lifeMs,
      pierce: true,
      hitIds: [],
    };
    ctx.room.projectiles.push(proj);
    ctx.events.push({ type: 'projectileFired', projectileId: proj.id, kind: proj.kind, pos: { x: pos.x, y: pos.y } });
    made++;
  }
  return made;
}

/** Un coup de la Danse des lames : tous les ennemis dans le rayon autour de la position COURANTE de la danseuse. */
function bladeDanceStrike(ctx: CombatContext, player: PlayerState, def: SpecialDef, raw: number): void {
  for (const e of enemiesInCircle(ctx, player.pos, def.radius, player.pos)) specialHit(ctx, e, raw, player, player.pos, def);
}

/** Nombre de coups déjà portés de la Danse des lames quand il reste `animMs` ms d'animation (le 1er coup est immédiat). */
export function bladeDanceHitsDone(def: SpecialDef, animMs: number): number {
  const count = Math.max(1, Math.floor(def.count ?? 5));
  if (!(def.animMs > 0)) return count;
  const a = Math.min(def.animMs, Math.max(0, animMs));
  const interval = def.animMs / count;
  return Math.min(count, Math.floor((def.animMs - a) / interval + 1e-9) + 1);
}

/**
 * Coups différés d'un spécial qui dure (Danse des lames) : à appeler UNE fois par pas, avec `specialAnimMs` mesuré AVANT
 * `stepPlayerTimers` (`animBefore`). Frappe les coups dont l'instant est franchi pendant ce pas ; s'arrête si le joueur est à
 * terre ou si les dégâts sont désactivés. Sans effet pour les autres spéciaux. MUTE les ennemis / `ctx.events`.
 * @returns nombre de coups portés
 */
export function stepSpecialEffects(ctx: CombatContext, player: PlayerState, animBefore: number): number {
  if (!ctx.damageEnabled || player.status !== 'alive' || !(animBefore > 0)) return 0;
  const character = getCharacter(player.characterId);
  const def = character.special;
  if (!def || def.kind !== 'bladeDance') return 0;
  const due = bladeDanceHitsDone(def, player.specialAnimMs) - bladeDanceHitsDone(def, animBefore);
  const raw = playerSpecialDamage(character) * rageMultiplier(player.loadout); // éclair de rage : +50 % de dégâts
  for (let i = 0; i < due; i++) bladeDanceStrike(ctx, player, def, raw);
  return Math.max(0, due);
}

/**
 * Déclenche l'attaque spéciale de `player` si `canPlayerSpecial` (et dégâts activés) : pose la recharge
 * (`specialCooldownMs = def.cooldownMs`) et l'animation (`specialAnimMs = def.animMs`), émet `specialUsed`
 * (pos : origine de l'effet = position du héros, ou centre de la nova ardente ; dir : `facing`) puis applique l'effet :
 *  - whirlwind : tous les ennemis dans `radius` autour du héros ;
 *  - fireNova : explosion centrée `range` px devant (ramenée si mur), rayon `radius` ;
 *  - dash : ruée de `range` px (collisions respectées), invulnérable `invulnMs`, blesse les ennemis traversés ;
 *  - healNova : soigne `healFraction` des PV max des alliés VIVANTS dans `radius` (héros inclus, jamais de relevage),
 *    blesse les ennemis ;
 *  - arrowFan : `count` flèches perforantes sur ±`spreadDeg` ;
 *  - quake : onde de choc `radius`, étourdit `stunMs` ;
 *  - smash : cône `arcDeg` sur `range`, fort recul ;
 *  - bladeDance : `count` coups sur `animMs` (le 1er immédiat, les suivants via `stepSpecialEffects`), invulnérable.
 * Dégâts bruts par touche = `playerSpecialDamage` ; `damageEnemy` applique la difficulté de l'attaquant et crédite les kills.
 * @returns true si le spécial a été lancé
 */
export function performPlayerSpecial(ctx: CombatContext, player: PlayerState): boolean {
  if (!ctx.damageEnabled || !canPlayerSpecial(player)) return false;
  const character = getCharacter(player.characterId);
  const def = character.special as SpecialDef;
  const raw = playerSpecialDamage(character) * rageMultiplier(player.loadout); // éclair de rage : +50 % de dégâts
  const origin = { x: player.pos.x, y: player.pos.y };
  player.specialCooldownMs = effectiveSpecialCooldownMs(def.cooldownMs, player.loadout); // Artefact : recharge réduite
  player.specialAnimMs = def.animMs;
  player.attackDir = player.facing;
  let eventPos: Vec2 = origin;

  switch (def.kind) {
    case 'whirlwind':
    case 'quake':
      for (const e of enemiesInCircle(ctx, origin, def.radius, origin)) specialHit(ctx, e, raw, player, origin, def);
      break;
    case 'fireNova': {
      const c = novaCenter(ctx, player, def);
      eventPos = c;
      for (const e of enemiesInCircle(ctx, c, def.radius, c)) specialHit(ctx, e, raw, player, c, def);
      break;
    }
    case 'dash': {
      const v = dirVec(player.facing);
      const end = moveCircle(origin, { x: v.x * def.range, y: v.y * def.range }, PLAYER_RADIUS, ctx.grid, ctx.solids);
      if (Number.isFinite(end.x) && Number.isFinite(end.y)) player.pos = end;
      const to = player.pos;
      player.invulnMs = Math.max(player.invulnMs, def.invulnMs ?? def.animMs);
      for (const e of liveEnemies(ctx)) {
        if (distToSegment(e.pos, origin, to) <= def.radius + enemyRadius(e)) specialHit(ctx, e, raw, player, origin, def);
      }
      break;
    }
    case 'healNova': {
      const frac = def.healFraction ?? 0;
      for (const ally of ctx.players) {
        if (ally.status !== 'alive') continue;
        if (Math.hypot(ally.pos.x - origin.x, ally.pos.y - origin.y) > def.radius) continue;
        healPlayer(ally, Math.round(ally.maxHp * frac));
      }
      for (const e of enemiesInCircle(ctx, origin, def.radius, origin)) specialHit(ctx, e, raw, player, origin, def);
      break;
    }
    case 'arrowFan':
      fireArrowFan(ctx, player, def, raw);
      break;
    case 'smash': {
      const angle = dirAngle(player.facing);
      for (const e of liveEnemies(ctx)) {
        if (!isInArc(origin, angle, e.pos, def.range, def.arcDeg ?? 150, enemyRadius(e))) continue;
        if (segmentBlocked(origin, e.pos, ctx.grid, ctx.solids)) continue;
        specialHit(ctx, e, raw, player, origin, def);
      }
      break;
    }
    case 'bladeDance':
      player.invulnMs = Math.max(player.invulnMs, def.invulnMs ?? def.animMs);
      bladeDanceStrike(ctx, player, def, raw);
      break;
  }
  ctx.events.push({
    type: 'specialUsed',
    playerId: player.id,
    kind: def.kind,
    pos: { x: eventPos.x, y: eventPos.y },
    dir: player.facing,
  });
  return true;
}
