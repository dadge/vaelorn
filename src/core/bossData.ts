/**
 * Données des boss et demi-boss (logique pure, aucune dépendance à Phaser/DOM/Math.random/Date.now).
 *
 * Ce module contient UNIQUEMENT des données et de petites fonctions pures : les identifiants d'attaques
 * (`ENEMY_SPECIALS`), les spécifications d'attaques par type (`AttackSpec`, durées de télégraphe, projectiles…),
 * les séquences d'attaques par phase et le `BossProfile` de chaque type (seuils de phase, vol, invocations,
 * téléportation, style de déplacement). Le moteur (machine à états windup → attack → recover, mouvements,
 * invocations, téléportation) est dans `bosses.ts`.
 *
 * Boss existants : golem (Gorgrim, niveau 2), morvane (niveau 3).
 * Demi-boss (`isMiniBoss`, 2 phases, rage à 50 %) : warden (niveau 4), pyromancer (niveau 5), wraith (niveau 6).
 * Boss de fin (`isBoss`) : frostqueen (niveau 4, 3 phases), forgelord (niveau 5, 3 phases), voidlord (niveau 6, 4 phases).
 */
import type { EnemyKind } from './types';

// ───────────────────────────── Identifiants d'attaques ─────────────────────────────

/**
 * Identifiants numériques de l'attaque annoncée/en cours (`enemy.data.special`), à l'usage du rendu.
 * 0 = attaque de base / aucune. Valeurs stables (ne pas renuméroter ; on n'ajoute qu'à la fin).
 */
export const ENEMY_SPECIALS = {
  NONE: 0,
  /** Araignée : bond rapide en ligne droite. */
  LEAP: 1,
  /** Chauve-souris : piqué. */
  DIVE: 2,
  /** Archer : tir de flèche. */
  SHOT: 3,
  /** Feu follet : salve d'orbes (éventail ou paire). */
  VOLLEY: 4,
  /** Gorgrim / gardien de givre : frappe au sol (onde + anneau d'éclats). */
  SLAM: 5,
  /** Gorgrim : racines (lignes de projectiles). */
  ROOTS: 6,
  /** Boss : invocation de sbires. */
  SUMMON: 7,
  /** Gorgrim phase 3 : frappe au sol enchaînée, onde plus dense. */
  RAGE: 8,
  /** Morvane / reine du givre : éventail de projectiles. */
  FAN: 9,
  /** Morvane / spectre / seigneur du Néant : anneau de projectiles. */
  RING: 10,
  /** Morvane / seigneur du Néant : spirale de projectiles. */
  SPIRAL: 11,
  /** Morvane / gardien / seigneur de la forge / seigneur du Néant : charge en ligne droite. */
  CHARGE: 12,
  /** Téléportation (feu follet, boss téléporteurs). */
  TELEPORT: 13,
  /** Rugissement de changement de phase (aucune attaque). */
  ROAR: 14,
  /** Chevalier / gardien de givre : coup lourd. */
  HEAVY: 15,
  /** Seigneur de la forge : coup de marteau (zone devant lui) + onde de choc en anneau. */
  SHOCKWAVE: 16,
  /** Pyromancien (éventail) / seigneur de la forge (rafale balayée) : boules de feu. */
  FIREBALL: 17,
  /** Pyromancien : nova de feu autour de lui (zone + anneau d'orbes). */
  NOVA: 18,
  /** Spectre / seigneur du Néant : éventail de traits sombres. */
  DARKBOLT: 19,
  /** Seigneur du Néant : zones de danger (cercles posés sous les joueurs, qui persistent). */
  VOIDZONE: 20,
  /** Reine du givre : anneau d'éclats avec deux brèches (une vers la cible, une opposée). */
  BLIZZARD: 21,
  /** Reine du givre : glissade en ligne droite qui sème des éclats sur les côtés. */
  SLIDE: 22,
} as const;

const S = ENEMY_SPECIALS;

// ───────────────────────────── Types ─────────────────────────────

/** Entrée d'une séquence : [attaque, nombre de coups supplémentaires enchaînés (combo)]. */
export type SeqEntry = readonly [special: number, combo: number];

/** Types de projectile utilisables par les boss. */
export type BossProjectile = 'shard' | 'orb' | 'bolt';

/** Spécification d'une attaque (durées, zone annoncée, projectiles). Les champs optionnels valent 0/absent par défaut. */
export interface AttackSpec {
  windupMs: number;
  activeMs: number;
  recoverMs: number;
  /** Fraction initiale du télégraphe pendant laquelle la visée suit la cible (le reste : visée verrouillée). */
  trackFrac: number;
  /** Rayon (px) de la zone annoncée / de dégâts. */
  radius: number;
  /** Longueur (px) de la ligne annoncée (éventail, charge). */
  length: number;
  /** Ouverture totale (rad) de l'éventail annoncé. */
  spread: number;
  /** Distance (px) du centre de la zone par rapport au boss, dans la direction visée (0 = autour du boss). */
  dist?: number;
  /** Nombre de projectiles (anneau, éventail, racines) ; spirale : nombre d'émissions ; rafale : nombre de tirs ; zones : nombre de cercles. */
  count?: number;
  projSpeed?: number;
  projLife?: number;
  /** Multiplicateur de dégâts des projectiles (× `EnemyDef.damage`). */
  projDmg?: number;
  proj?: BossProjectile;
  /** Vitesse (px/s) d'une charge / glissade. */
  speed?: number;
  /** Multiplicateur des dégâts directs (zone, contact) × `EnemyDef.damage` ; 1 par défaut. */
  dmg?: number;
  /** Intervalle (ms) entre deux émissions (spirale, rafale, trace de glissade). */
  interval?: number;
  /** Spirale : nombre de bras. */
  arms?: number;
  /** Spirale : incrément d'angle (rad) entre deux émissions. */
  step?: number;
  /** Anneau : demi-largeur (rad) des brèches laissées vers la cible et à l'opposé. */
  gap?: number;
}

/** Profil d'IA d'un boss / demi-boss. */
export interface BossProfile {
  kind: EnemyKind;
  /** Seuils de PV (fractions décroissantes) : la phase k+1 est atteinte quand hp/maxHp ≤ thresholds[k-1] (au seuil exact : phase supérieure). */
  thresholds: readonly number[];
  /** Vole : les fosses ne le bloquent pas. */
  flying: boolean;
  /** 'brute' : marche vers la cible et frappe au contact ; 'hover' : garde une distance (orbite) et tire. */
  style: 'brute' | 'hover';
  /** Multiplicateur de vitesse par phase (index = phase - 1 ; au-delà : dernière valeur). */
  speedMults: readonly number[];
  /** brute : distance (px) en plus de rayon boss + joueur à laquelle il s'arrête. */
  stopPad?: number;
  /** brute : distance centre à centre max pour déclencher une attaque (Infinity = partout). */
  triggerDist?: (special: number) => number;
  /** brute : délai de poursuite (ms) après lequel il attaque de toute façon. */
  forceMs?: number;
  /** hover : distances de repli / de rapprochement (px). */
  hover?: { near: number; far: number };
  /** hover : distance sous laquelle un joueur « colle » le boss (px) ; en rester collé déclenche téléportation/panique. */
  crowdDist?: number;
  /** Se téléporte quand un joueur le colle trop longtemps (hover). */
  crowdTeleport?: boolean;
  /** Attaque de panique lancée immédiatement quand un joueur le colle (> 700 ms). */
  panicSpecial?: number;
  /** Séquences d'attaques par phase (1-indexé). */
  seq: Readonly<Record<number, readonly SeqEntry[]>>;
  /** Spécification d'une attaque pour une phase donnée ; `strike` = rang du coup dans un combo (0 = premier). */
  spec(special: number, phase: number, strike: number): AttackSpec;
  /** Invocations : types, plafond de sbires VIVANTS invoqués par ce boss, nombre par invocation, seuil d'autorisation. */
  minions?: {
    kinds: readonly EnemyKind[];
    cap: number;
    perCast: number;
    /** Une invocation n'est lancée que s'il reste au plus `gate(phase)` sbires vivants. */
    gate(phase: number): number;
  };
  /** Se téléporte après cette attaque (fin de combo) ? Absent = ne se téléporte jamais. */
  teleportAfter?: (phase: number, special: number) => boolean;
  /** Durée (ms) d'une téléportation (700 par défaut). */
  teleportMs?: number;
}

// ───────────────────────────── Spécifications ─────────────────────────────

/** Rayon (px) de l'onde de choc proche de Gorgrim. */
export const GOLEM_SLAM_RADIUS = 52;
const CHARGE_SPEED = 300;
const CHARGE_LENGTH = 140;
const ROOT_LENGTH = 135;

function plain(windupMs: number, activeMs: number, recoverMs: number, trackFrac = 0, radius = 0): AttackSpec {
  return { windupMs, activeMs, recoverMs, trackFrac, radius, length: 0, spread: 0 };
}

/** Voies d'un éventail de `n` projectiles espacés de `step` rad. */
export function fanLanesFor(count: number, step: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push((i - (count - 1) / 2) * step);
  return out;
}

/** Ouverture totale d'un éventail de `n` voies espacées de `step`. */
export function fanSpread(count: number, step: number): number {
  return count > 1 ? (count - 1) * step : 0;
}

function fanSpec(
  windupMs: number,
  recoverMs: number,
  count: number,
  step: number,
  speed: number,
  life: number,
  dmg: number,
  proj: BossProjectile,
  trackFrac = 0.6,
  length = 130,
): AttackSpec {
  return {
    windupMs,
    activeMs: 200,
    recoverMs,
    trackFrac,
    radius: 0,
    length,
    spread: fanSpread(count, step),
    count,
    projSpeed: speed,
    projLife: life,
    projDmg: dmg,
    proj,
  };
}

function ringSpec(
  windupMs: number,
  recoverMs: number,
  count: number,
  speed: number,
  life: number,
  dmg: number,
  proj: BossProjectile,
  gap = 0,
): AttackSpec {
  return {
    windupMs,
    activeMs: 200,
    recoverMs,
    trackFrac: gap > 0 ? 0.6 : 0,
    radius: 0,
    length: 0,
    spread: 0,
    count,
    projSpeed: speed,
    projLife: life,
    projDmg: dmg,
    proj,
    gap,
  };
}

function chargeSpec(windupMs: number, activeMs: number, recoverMs: number, speed: number): AttackSpec {
  return {
    windupMs,
    activeMs,
    recoverMs,
    trackFrac: 0.7,
    radius: 0,
    length: (speed * activeMs) / 1000,
    spread: 0,
    speed,
  };
}

const SUMMON_SPEC = (windup: number, recover: number): AttackSpec => plain(windup, 300, recover, 0, 40);

// ── Gorgrim (golem) : valeurs historiques conservées à l'identique ──

function golemSpec(special: number, phase: number, strike: number): AttackSpec {
  const shardSpeed = phase >= 3 ? 105 : 95;
  switch (special) {
    case S.SLAM:
      return {
        windupMs: phase >= 2 ? 850 : 900,
        activeMs: 250,
        recoverMs: phase >= 2 ? 1200 : 1400,
        trackFrac: 0,
        radius: GOLEM_SLAM_RADIUS,
        length: 0,
        spread: 0,
        count: phase >= 2 ? 14 : 12,
        projSpeed: shardSpeed,
        projLife: 1400,
        projDmg: 0.5,
        proj: 'shard',
      };
    case S.RAGE:
      return {
        windupMs: 750,
        activeMs: 250,
        recoverMs: 1000,
        trackFrac: 0,
        radius: GOLEM_SLAM_RADIUS,
        length: 0,
        spread: 0,
        count: strike >= 1 ? 20 : 14,
        projSpeed: shardSpeed,
        projLife: 1400,
        projDmg: 0.5,
        proj: 'shard',
      };
    case S.ROOTS: {
      const lanes = phase >= 3 ? 5 : 3;
      const step = phase >= 3 ? 0.24 : 0.28;
      return {
        windupMs: phase >= 3 ? 700 : 800,
        activeMs: 700,
        recoverMs: phase >= 3 ? 900 : 1200,
        trackFrac: 0.6,
        radius: 0,
        length: ROOT_LENGTH,
        spread: fanSpread(lanes, step),
        count: lanes,
        projSpeed: 130,
        projLife: 1000,
        projDmg: 0.45,
        proj: 'shard',
        interval: 100,
      };
    }
    default:
      return plain(900, 300, 1100, 0, 40);
  }
}

// ── Morvane : valeurs historiques conservées à l'identique ──

function morvaneSpec(special: number, phase: number): AttackSpec {
  switch (special) {
    case S.RING:
      return ringSpec(800, phase >= 3 ? 800 : 1000, phase >= 3 ? 20 : 16, 70, 3200, 0.5, 'orb');
    case S.SPIRAL:
      return {
        windupMs: 800,
        activeMs: 2400,
        recoverMs: 1300,
        trackFrac: 0.5,
        radius: 0,
        length: 0,
        spread: 0,
        count: 26,
        projSpeed: 75,
        projLife: 2800,
        projDmg: 0.45,
        proj: 'orb',
        interval: 90,
        arms: 2,
        step: 0.42,
      };
    case S.CHARGE:
      return { ...chargeSpec(900, 450, 1200, CHARGE_SPEED), length: CHARGE_LENGTH };
    case S.SUMMON:
      return SUMMON_SPEC(900, 1000);
    default:
      // FAN
      return fanSpec(750, phase >= 3 ? 800 : 1000, phase >= 3 ? 7 : 5, 0.24, phase >= 3 ? 95 : 85, 2600, 0.55, 'orb');
  }
}

// ── Gardien de givre (warden), demi-boss niveau 4 ──

function wardenSpec(special: number, phase: number): AttackSpec {
  const rage = phase >= 2;
  switch (special) {
    case S.HEAVY:
      return { ...plain(rage ? 700 : 800, 220, rage ? 800 : 1100, 0.5, 24), dist: 18, dmg: 1 };
    case S.SLAM:
      return {
        ...plain(rage ? 800 : 900, 250, rage ? 1000 : 1300, 0, 46),
        count: rage ? 10 : 0,
        projSpeed: 85,
        projLife: 1100,
        projDmg: 0.4,
        proj: 'shard',
      };
    case S.CHARGE:
      return rage ? chargeSpec(800, 600, 1100, 320) : chargeSpec(900, 550, 1400, 260);
    default:
      return SUMMON_SPEC(900, 1000);
  }
}

// ── Reine du givre (frostqueen), boss niveau 4 ──

function frostqueenSpec(special: number, phase: number): AttackSpec {
  switch (special) {
    case S.FAN:
      if (phase >= 3) return fanSpec(800, 800, 9, 0.2, 100, 2400, 0.5, 'shard');
      return fanSpec(800, phase === 2 ? 1000 : 1100, 5, 0.24, 90, 2400, 0.55, 'shard');
    case S.BLIZZARD:
      return ringSpec(900, phase >= 3 ? 900 : phase === 2 ? 1100 : 1200, phase >= 3 ? 22 : phase === 2 ? 18 : 16, phase >= 3 ? 85 : 70, 3200, 0.5, 'shard', 0.3);
    case S.SLIDE:
      return { ...chargeSpec(950, 600, 1300, 280), interval: 140, projSpeed: 60, projLife: 900, projDmg: 0.35, proj: 'shard' };
    default:
      return SUMMON_SPEC(900, 1100);
  }
}

// ── Pyromancien, demi-boss niveau 5 ──

function pyromancerSpec(special: number, phase: number): AttackSpec {
  const rage = phase >= 2;
  switch (special) {
    case S.FIREBALL:
      return rage
        ? fanSpec(650, 800, 5, 0.22, 105, 2200, 0.7, 'orb', 0.6, 140)
        : fanSpec(750, 1000, 3, 0.25, 100, 2200, 0.8, 'orb', 0.6, 140);
    case S.NOVA:
      return {
        ...plain(rage ? 900 : 1000, 250, rage ? 1100 : 1300, 0, 46),
        dmg: 1,
        count: rage ? 16 : 12,
        projSpeed: 60,
        projLife: 2400,
        projDmg: 0.5,
        proj: 'orb',
      };
    default:
      return SUMMON_SPEC(900, 1000);
  }
}

// ── Seigneur de la forge (forgelord), boss niveau 5 ──

function forgelordSpec(special: number, phase: number): AttackSpec {
  switch (special) {
    case S.SHOCKWAVE:
      return {
        ...plain(phase >= 3 ? 780 : phase === 2 ? 900 : 950, 300, phase >= 3 ? 900 : phase === 2 ? 1200 : 1400, 0.45, 36),
        dist: 30,
        dmg: 1,
        count: phase >= 3 ? 20 : phase === 2 ? 16 : 14,
        projSpeed: phase >= 3 ? 115 : 100,
        projLife: 900,
        projDmg: 0.5,
        proj: 'orb',
      };
    case S.FIREBALL: {
      const count = phase >= 3 ? 10 : phase === 2 ? 8 : 6;
      const interval = phase >= 3 ? 150 : phase === 2 ? 190 : 220;
      return {
        windupMs: 850,
        activeMs: count * interval + 100,
        recoverMs: phase >= 3 ? 1000 : 1300,
        trackFrac: 0.5,
        radius: 0,
        length: 150,
        spread: 0.7,
        count,
        projSpeed: 105,
        projLife: 2400,
        projDmg: 0.5,
        proj: 'orb',
        interval,
      };
    }
    case S.CHARGE:
      return chargeSpec(900, 500, 1300, 300);
    default:
      return SUMMON_SPEC(1000, 1000);
  }
}

// ── Spectre (wraith), demi-boss niveau 6 ──

function wraithSpec(special: number, phase: number): AttackSpec {
  const rage = phase >= 2;
  switch (special) {
    case S.RING:
      return ringSpec(800, 900, 12, 70, 2800, 0.5, 'orb');
    default:
      // DARKBOLT
      return rage
        ? fanSpec(650, 700, 5, 0.22, 140, 2200, 0.7, 'bolt', 0.6, 160)
        : fanSpec(700, 900, 3, 0.22, 125, 2200, 0.7, 'bolt', 0.6, 160);
  }
}

// ── Seigneur du Néant (voidlord), boss niveau 6 (4 phases) ──

function voidlordSpec(special: number, phase: number): AttackSpec {
  const late = phase >= 3;
  switch (special) {
    case S.DARKBOLT:
      return phase >= 2
        ? fanSpec(750, late ? 800 : 1000, 7, 0.2, 125, 2400, 0.6, 'bolt', 0.6, 160)
        : fanSpec(750, 1000, 5, 0.2, 120, 2400, 0.6, 'bolt', 0.6, 160);
    case S.RING:
      return ringSpec(800, late ? 800 : 1000, phase >= 4 ? 24 : late ? 22 : 18, 70, 3200, 0.5, 'orb');
    case S.SPIRAL:
      return {
        windupMs: 850,
        activeMs: phase >= 4 ? 2800 : 2400,
        recoverMs: phase >= 4 ? 1100 : 1300,
        trackFrac: 0.5,
        radius: 0,
        length: 0,
        spread: 0,
        count: phase >= 4 ? 30 : 26,
        projSpeed: phase >= 4 ? 82 : 75,
        projLife: 2800,
        projDmg: 0.45,
        proj: 'orb',
        interval: 90,
        arms: phase >= 4 ? 3 : 2,
        step: phase >= 4 ? 0.36 : 0.42,
      };
    case S.VOIDZONE:
      return {
        windupMs: phase >= 4 ? 950 : 1100,
        activeMs: 1400,
        recoverMs: phase >= 4 ? 1000 : 1300,
        trackFrac: 0.55,
        radius: phase >= 4 ? 38 : phase === 3 ? 34 : 30,
        length: 0,
        spread: 0,
        count: phase >= 4 ? 3 : 2,
        dmg: 1,
        interval: 350,
      };
    case S.CHARGE:
      return chargeSpec(900, 450, 1200, CHARGE_SPEED);
    default:
      return SUMMON_SPEC(900, 1000);
  }
}

// ───────────────────────────── Séquences ─────────────────────────────

const GOLEM_SEQ: Readonly<Record<number, readonly SeqEntry[]>> = {
  1: [[S.SLAM, 0]],
  2: [
    [S.SUMMON, 0],
    [S.ROOTS, 0],
    [S.SLAM, 0],
    [S.ROOTS, 0],
  ],
  3: [
    [S.RAGE, 1],
    [S.ROOTS, 0],
    [S.RAGE, 1],
    [S.SUMMON, 0],
  ],
};

const MORVANE_SEQ: Readonly<Record<number, readonly SeqEntry[]>> = {
  1: [
    [S.FAN, 0],
    [S.FAN, 1],
  ],
  2: [
    [S.SUMMON, 0],
    [S.RING, 0],
    [S.FAN, 0],
    [S.RING, 0],
    [S.FAN, 1],
  ],
  3: [
    [S.SPIRAL, 0],
    [S.CHARGE, 0],
    [S.FAN, 0],
    [S.RING, 0],
    [S.SPIRAL, 0],
    [S.SUMMON, 0],
  ],
};

const WARDEN_SEQ: Readonly<Record<number, readonly SeqEntry[]>> = {
  1: [
    [S.HEAVY, 0],
    [S.CHARGE, 0],
    [S.SLAM, 0],
  ],
  2: [
    [S.HEAVY, 1],
    [S.CHARGE, 0],
    [S.SLAM, 0],
    [S.HEAVY, 0],
  ],
};

const FROSTQUEEN_SEQ: Readonly<Record<number, readonly SeqEntry[]>> = {
  1: [
    [S.FAN, 0],
    [S.BLIZZARD, 0],
    [S.FAN, 1],
  ],
  2: [
    [S.SUMMON, 0],
    [S.BLIZZARD, 0],
    [S.FAN, 1],
    [S.BLIZZARD, 0],
  ],
  3: [
    [S.SLIDE, 0],
    [S.FAN, 1],
    [S.BLIZZARD, 0],
    [S.SLIDE, 0],
    [S.SUMMON, 0],
    [S.BLIZZARD, 0],
  ],
};

const PYROMANCER_SEQ: Readonly<Record<number, readonly SeqEntry[]>> = {
  1: [
    [S.FIREBALL, 0],
    [S.FIREBALL, 0],
    [S.NOVA, 0],
    [S.SUMMON, 0],
  ],
  2: [
    [S.FIREBALL, 1],
    [S.NOVA, 0],
    [S.FIREBALL, 0],
    [S.SUMMON, 0],
    [S.NOVA, 0],
  ],
};

const FORGELORD_SEQ: Readonly<Record<number, readonly SeqEntry[]>> = {
  1: [
    [S.SHOCKWAVE, 0],
    [S.FIREBALL, 0],
    [S.SHOCKWAVE, 0],
  ],
  2: [
    [S.SUMMON, 0],
    [S.SHOCKWAVE, 1],
    [S.FIREBALL, 0],
    [S.SHOCKWAVE, 0],
    [S.FIREBALL, 0],
  ],
  3: [
    [S.SHOCKWAVE, 1],
    [S.FIREBALL, 0],
    [S.SHOCKWAVE, 1],
    [S.CHARGE, 0],
    [S.FIREBALL, 0],
  ],
};

const WRAITH_SEQ: Readonly<Record<number, readonly SeqEntry[]>> = {
  1: [
    [S.DARKBOLT, 0],
    [S.DARKBOLT, 0],
  ],
  2: [
    [S.DARKBOLT, 1],
    [S.RING, 0],
    [S.DARKBOLT, 0],
  ],
};

const VOIDLORD_SEQ: Readonly<Record<number, readonly SeqEntry[]>> = {
  1: [
    [S.DARKBOLT, 0],
    [S.RING, 0],
    [S.DARKBOLT, 1],
  ],
  2: [
    [S.SUMMON, 0],
    [S.SPIRAL, 0],
    [S.VOIDZONE, 0],
    [S.RING, 0],
  ],
  3: [
    [S.VOIDZONE, 1],
    [S.SPIRAL, 0],
    [S.DARKBOLT, 1],
    [S.RING, 0],
    [S.SUMMON, 0],
    [S.CHARGE, 0],
  ],
  4: [
    [S.SPIRAL, 0],
    [S.VOIDZONE, 1],
    [S.RING, 0],
    [S.SPIRAL, 0],
    [S.DARKBOLT, 1],
    [S.CHARGE, 0],
  ],
};

// ───────────────────────────── Profils ─────────────────────────────

/** Plafond historique d'invocations vivantes de Gorgrim et Morvane. */
export const MAX_BOSS_MINIONS = 4;

/** Profils d'IA par type (boss et demi-boss uniquement). */
export const BOSS_PROFILES: Readonly<Partial<Record<EnemyKind, BossProfile>>> = {
  golem: {
    kind: 'golem',
    thresholds: [0.66, 0.33],
    flying: false,
    style: 'brute',
    speedMults: [1, 1.15, 1.5],
    stopPad: 16,
    triggerDist: (sp) => (sp === S.SUMMON ? Infinity : 90),
    forceMs: 2200,
    seq: GOLEM_SEQ,
    spec: golemSpec,
    minions: {
      kinds: ['spider'],
      cap: MAX_BOSS_MINIONS,
      perCast: 2,
      gate: (phase) => (phase >= 3 ? 1 : MAX_BOSS_MINIONS - 2),
    },
  },
  morvane: {
    kind: 'morvane',
    thresholds: [0.7, 0.35],
    flying: true,
    style: 'hover',
    speedMults: [1, 1.1, 1.25],
    hover: { near: 70, far: 125 },
    crowdDist: 40,
    crowdTeleport: true,
    seq: MORVANE_SEQ,
    spec: morvaneSpec,
    minions: {
      kinds: ['skeleton', 'wisp'],
      cap: MAX_BOSS_MINIONS,
      perCast: 2,
      gate: (phase) => (phase >= 3 ? 1 : MAX_BOSS_MINIONS - 2),
    },
    teleportAfter: () => true,
  },
  warden: {
    kind: 'warden',
    thresholds: [0.5],
    flying: false,
    style: 'brute',
    speedMults: [1, 1.35],
    stopPad: 10,
    triggerDist: (sp) => (sp === S.HEAVY ? 56 : sp === S.SLAM ? 60 : 400),
    forceMs: 2200,
    seq: WARDEN_SEQ,
    spec: wardenSpec,
  },
  frostqueen: {
    kind: 'frostqueen',
    thresholds: [0.7, 0.4],
    flying: false,
    style: 'hover',
    speedMults: [1, 1.1, 1.3],
    hover: { near: 80, far: 130 },
    crowdDist: 40,
    crowdTeleport: true,
    seq: FROSTQUEEN_SEQ,
    spec: frostqueenSpec,
    minions: {
      kinds: ['bat', 'skeleton'],
      cap: MAX_BOSS_MINIONS,
      perCast: 2,
      gate: (phase) => (phase >= 3 ? 1 : 2),
    },
    teleportAfter: (phase) => phase >= 2,
  },
  pyromancer: {
    kind: 'pyromancer',
    thresholds: [0.5],
    flying: false,
    style: 'hover',
    speedMults: [1, 1.2],
    hover: { near: 85, far: 140 },
    crowdDist: 60,
    crowdTeleport: true,
    panicSpecial: S.NOVA,
    seq: PYROMANCER_SEQ,
    spec: pyromancerSpec,
    minions: { kinds: ['wisp'], cap: 2, perCast: 2, gate: () => 1 },
    teleportAfter: (_phase, special) => special === S.NOVA,
  },
  forgelord: {
    kind: 'forgelord',
    thresholds: [0.7, 0.35],
    flying: false,
    style: 'brute',
    speedMults: [1, 1.1, 1.45],
    stopPad: 16,
    triggerDist: (sp) => (sp === S.SHOCKWAVE ? 70 : sp === S.SUMMON ? Infinity : 400),
    forceMs: 2200,
    seq: FORGELORD_SEQ,
    spec: forgelordSpec,
    minions: { kinds: ['knight'], cap: 2, perCast: 1, gate: () => 1 },
  },
  wraith: {
    kind: 'wraith',
    thresholds: [0.5],
    flying: true,
    style: 'hover',
    speedMults: [1, 1.25],
    hover: { near: 60, far: 115 },
    crowdDist: 40,
    crowdTeleport: true,
    seq: WRAITH_SEQ,
    spec: wraithSpec,
    teleportAfter: () => true,
    teleportMs: 560,
  },
  voidlord: {
    kind: 'voidlord',
    thresholds: [0.75, 0.5, 0.25],
    flying: true,
    style: 'hover',
    speedMults: [1, 1.1, 1.2, 1.35],
    hover: { near: 75, far: 130 },
    crowdDist: 40,
    crowdTeleport: true,
    seq: VOIDLORD_SEQ,
    spec: voidlordSpec,
    minions: { kinds: ['bat', 'wisp'], cap: 3, perCast: 2, gate: (phase) => (phase >= 3 ? 0 : 1) },
    teleportAfter: () => true,
  },
};

/** Profil d'un type de boss / demi-boss (`undefined` pour un ennemi normal). */
export function getBossProfile(kind: EnemyKind): BossProfile | undefined {
  return BOSS_PROFILES[kind];
}

/** Nombre de phases (1..4) d'un type de boss / demi-boss (3 par défaut pour un type sans profil). */
export function bossPhaseCount(kind: EnemyKind): number {
  const p = BOSS_PROFILES[kind];
  return p ? p.thresholds.length + 1 : 3;
}
