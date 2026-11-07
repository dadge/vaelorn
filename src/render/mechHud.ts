/**
 * Logique PURE d'affichage des mécanismes des niveaux 4-6 (aucune dépendance à Phaser, aucune règle de jeu : on LIT l'état) :
 *  - statues jumelles : orientation, état « résolu », flèche de direction cible ;
 *  - sablier : niveau de sable, secondes restantes, alerte « presque vide », état de la herse tuile par tuile ;
 *  - pont de lumière : porteur de la lanterne, halo (source de lumière côté rendu uniquement), tuiles éclairées.
 * Testée sous Node (mechHud.test.ts) ; les vues Phaser (MechanismViews, hud.ts, DarkRoomView) s'en servent.
 */
import { TILE } from '../core/constants';
import type { LightSource } from '../core/light';
import { effectiveHourglassPeriodMs } from '../core/mechanisms';
import type {
  Dir,
  GameState,
  HourglassDef,
  HourglassState,
  LightBridgeDef,
  LightBridgeState,
  MechanismState,
  PlayerId,
  RoomDef,
  StatuePairDef,
  StatuePairState,
  Vec2,
} from '../core/types';

// ───────────────────────────── Statues jumelles ─────────────────────────────

/** Angle (rad, 0 = vers la droite, sens horaire à l'écran) d'une direction. */
export function dirAngle(dir: Dir): number {
  switch (dir) {
    case 'right':
      return 0;
    case 'down':
      return Math.PI / 2;
    case 'left':
      return Math.PI;
    default:
      return -Math.PI / 2;
  }
}

/** Vecteur unitaire (écran) d'une direction. */
export function dirUnit(dir: Dir): Vec2 {
  switch (dir) {
    case 'up':
      return { x: 0, y: -1 };
    case 'down':
      return { x: 0, y: 1 };
    case 'left':
      return { x: -1, y: 0 };
    default:
      return { x: 1, y: 0 };
  }
}

/** Les deux statues regardent-elles la direction cible (puzzle résolu ou neutralisé) ? */
export function statuesSolved(st: Pick<StatuePairState, 'active' | 'waived'>): boolean {
  return st.active || st.waived;
}

/** Une statue regarde-t-elle déjà la direction cible ? */
export function statueOnTarget(def: Pick<StatuePairDef, 'targetDir'>, st: Pick<StatuePairState, 'facings' | 'waived'>, index: 0 | 1): boolean {
  return st.waived || st.facings[index] === def.targetDir;
}

/**
 * Flèche « cible » flottant près d'une statue : décalage (px) du centre de la statue dans la direction `targetDir`, rotation
 * (rad, pour une image orientée vers le bas comme `fx_marker`) et opacité pulsée. Visible seulement si la statue ne regarde
 * pas encore la cible et que le puzzle n'est pas résolu.
 */
export function statueTargetArrow(
  def: Pick<StatuePairDef, 'targetDir'>,
  st: Pick<StatuePairState, 'facings' | 'waived' | 'active'>,
  index: 0 | 1,
  timeMs: number,
): { visible: boolean; dx: number; dy: number; rotation: number; alpha: number } {
  const u = dirUnit(def.targetDir);
  const pulse = 0.5 + 0.5 * Math.sin((Number.isFinite(timeMs) ? timeMs : 0) / 240);
  const visible = !statuesSolved(st) && !statueOnTarget(def, st, index);
  const reach = 12 + pulse * 2;
  // fx_marker pointe vers le bas : rotation = angle de la direction − 90°
  return { visible, dx: u.x * reach, dy: u.y * reach - 2, rotation: dirAngle(def.targetDir) - Math.PI / 2, alpha: 0.45 + 0.4 * pulse };
}

// ───────────────────────────── Sablier ─────────────────────────────

/** Sous cette fraction de sable restant, le sablier est « presque vide » (avertissement visuel). */
export const HOURGLASS_LOW_RATIO = 0.25;

export type HourglassLevel = 'ok' | 'low' | 'empty';

export interface HourglassStatus {
  /** Fraction de sable restant 0..1. */
  ratio: number;
  /** Sable restant (ms). */
  sandMs: number;
  /** Période effective (ms) d'un retournement (doublée en solo). */
  periodMs: number;
  /** Secondes restantes (arrondi au supérieur, 0 si vide). */
  seconds: number;
  level: HourglassLevel;
  /** Tuiles de herse fermées / total. */
  closed: number;
  total: number;
  /** Mécanisme neutralisé (herse ouverte en permanence) : pas d'indicateur. */
  waived: boolean;
}

/** Fraction de sable restant (0..1), robuste aux valeurs non finies et à une période incohérente. */
export function sandRatio(sandMs: number, periodMs: number): number {
  const sand = Number.isFinite(sandMs) ? Math.max(0, sandMs) : 0;
  const period = Math.max(Number.isFinite(periodMs) ? periodMs : 0, sand);
  return period > 0 ? Math.min(1, sand / period) : 0;
}

/** Niveau d'alerte du sablier. */
export function hourglassLevel(sandMs: number, ratio: number): HourglassLevel {
  if (!(sandMs > 0)) return 'empty';
  return ratio < HOURGLASS_LOW_RATIO ? 'low' : 'ok';
}

/** Statut d'affichage d'un sablier (`playerCount` : la période effective est doublée en solo, voir `effectiveHourglassPeriodMs`). */
export function hourglassStatus(def: HourglassDef, st: HourglassState, playerCount: number): HourglassStatus {
  const periodMs = effectiveHourglassPeriodMs(def, playerCount);
  const sandMs = Number.isFinite(st.sandMs) ? Math.max(0, st.sandMs) : 0;
  const ratio = sandRatio(sandMs, periodMs);
  const total = def.gate.length;
  const closed = Math.max(0, Math.min(total, Number.isFinite(st.closedCount) ? Math.floor(st.closedCount) : 0));
  return { ratio, sandMs, periodMs, seconds: sandMs > 0 ? Math.ceil(sandMs / 1000) : 0, level: hourglassLevel(sandMs, ratio), closed, total, waived: st.waived };
}

/** Couleur de la barre de sable selon le niveau (ambre / orange / rouge). */
export function hourglassBarColor(level: HourglassLevel): number {
  switch (level) {
    case 'ok':
      return 0xe8b44a;
    case 'low':
      return 0xff7a2a;
    default:
      return 0xff3a3a;
  }
}

/** Opacité (0..1) du clignotement d'alerte : stable à 1 si ok, lent si presque vide, rapide si vide. Pure fonction du temps. */
export function hourglassBlinkAlpha(level: HourglassLevel, timeMs: number): number {
  if (level === 'ok') return 1;
  const period = level === 'low' ? 650 : 360;
  const s = 0.5 + 0.5 * Math.sin(((Number.isFinite(timeMs) ? timeMs : 0) / period) * Math.PI * 2);
  return level === 'low' ? 0.55 + 0.45 * s : 0.3 + 0.7 * s;
}

/** Largeur (px) de la partie remplie d'une barre de `fullW` px : au moins 1 px tant qu'il reste du sable. */
export function hourglassBarWidth(ratio: number, fullW: number): number {
  if (!(ratio > 0)) return 0;
  return Math.max(1, Math.round(fullW * Math.min(1, ratio)));
}

/** État fermé/ouvert de chaque tuile de herse (les `closedCount` premières sont fermées). */
export function gateClosedFlags(closedCount: number, total: number): boolean[] {
  const n = Math.max(0, Math.floor(Number.isFinite(closedCount) ? closedCount : 0));
  return Array.from({ length: Math.max(0, total) }, (_, i) => i < n);
}

/** Sablier de la salle à signaler dans le HUD : le premier non neutralisé (avec sa définition), ou null. */
export function activeHourglass(state: Pick<GameState, 'room' | 'playerCount'>, room: Pick<RoomDef, 'mechanisms'>): { def: HourglassDef; status: HourglassStatus } | null {
  for (const def of room.mechanisms) {
    if (def.type !== 'hourglass') continue;
    const st = findState(state.room.mechanisms, def.id);
    if (!st || st.type !== 'hourglass' || st.waived) continue;
    return { def, status: hourglassStatus(def, st, state.playerCount) };
  }
  return null;
}

/** Retournement détecté : le sable a augmenté d'un coup (le sablier vient d'être retourné). */
export function sandJumped(prevSandMs: number, sandMs: number): boolean {
  return sandMs > prevSandMs + 250;
}

// ───────────────────────────── Pont de lumière et lanterne ─────────────────────────────

export interface LanternBearer {
  /** Joueur qui porte la lanterne. */
  playerId: PlayerId;
  mechanismId: string;
  /** Rayon du halo (px). */
  radiusPx: number;
}

/** Porteurs de lanterne de la salle (un par pont non neutralisé dont le porteur est vivant). */
export function lanternBearers(state: Pick<GameState, 'room'>, room: Pick<RoomDef, 'mechanisms'>): LanternBearer[] {
  const out: LanternBearer[] = [];
  for (const def of room.mechanisms) {
    if (def.type !== 'lightBridge') continue;
    const st = findState(state.room.mechanisms, def.id);
    if (!st || st.type !== 'lightBridge' || st.waived || st.bearerId === null) continue;
    out.push({ playerId: st.bearerId, mechanismId: def.id, radiusPx: bridgeRadiusPx(def) });
  }
  return out;
}

/** Rayon (px) du halo d'un pont de lumière. */
export function bridgeRadiusPx(def: Pick<LightBridgeDef, 'radiusTiles'>): number {
  return Math.max(0, def.radiusTiles) * TILE;
}

/** Le joueur `playerId` porte-t-il une lanterne ? */
export function isLanternBearer(bearers: readonly LanternBearer[], playerId: number): boolean {
  return bearers.some((b) => b.playerId === playerId);
}

/** Information de HUD sur la lanterne pour un joueur : porteur ou suiveur (nom du porteur à afficher), ou null. */
export function lanternHudInfo(bearers: readonly LanternBearer[], playerId: number): { isBearer: boolean; bearerId: PlayerId } | null {
  if (bearers.length === 0) return null;
  const mine = bearers.find((b) => b.playerId === playerId);
  if (mine) return { isBearer: true, bearerId: mine.playerId };
  return { isBearer: false, bearerId: bearers[0].playerId };
}

/**
 * Sources de lumière supplémentaires dues aux lanternes (RENDU seulement : `src/core/light.ts` n'est pas modifié).
 * `heroPos(playerId)` renvoie la position affichée (interpolée) du porteur, ou null (repli : position de l'état).
 * Le halo d'une lanterne éclaire exactement le rayon d'éclairage du pont (`radiusTiles`) : ce qui est visible est praticable.
 */
export function lanternLightSources(
  state: Pick<GameState, 'room' | 'players'>,
  room: Pick<RoomDef, 'mechanisms'>,
  heroPos?: (playerId: number) => Vec2 | null,
): LightSource[] {
  const out: LightSource[] = [];
  for (const b of lanternBearers(state, room)) {
    const p = state.players[b.playerId];
    if (!p || p.status !== 'alive' || !(b.radiusPx > 0)) continue;
    const pos = heroPos?.(b.playerId) ?? p.pos;
    out.push({ x: pos.x, y: pos.y, radius: b.radiusPx, kind: 'brazier', flicker: 0.2 });
  }
  return out;
}

/** Tuile du pont éclairée ? (index hors bornes = non éclairée.) */
export function bridgeTileLit(st: Pick<LightBridgeState, 'lit' | 'waived'>, index: number): boolean {
  return st.waived || st.lit[index] === true;
}

/** Centre (px monde) d'une tuile. */
export function tileCenterPx(tile: readonly [number, number]): Vec2 {
  return { x: (tile[0] + 0.5) * TILE, y: (tile[1] + 0.5) * TILE };
}

function findState(list: readonly MechanismState[], id: string): MechanismState | undefined {
  for (const m of list) if (m.id === id) return m;
  return undefined;
}
