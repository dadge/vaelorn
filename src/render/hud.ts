/**
 * HUD par joueur, dessiné DANS SA VUE (caméra d'interface plein écran, éléments positionnés dans le rectangle du joueur) :
 * cœurs, nom en couleur, objectifs personnels, clés, indicateur « à terre », invites contextuelles, bulles de panneaux,
 * flèches vers les alliés à terre hors de vue, notifications — et panneau d'équipe (3 joueurs).
 *
 * La partie PURE (formatage des cœurs et pourcentages, description des objectifs, invite contextuelle, sortie ouverte,
 * fondu, rapport de relevage…) est testée sans Phaser ; Phaser n'est utilisé que par TYPE.
 * Aucune chaîne en dur : tout texte passe par `t(clé)`.
 */
import type Phaser from 'phaser';
import { INTERACT_RANGE, PLAYER_COLORS, PLAYER_COLOR_NAMES, REVIVE_RANGE, ROOM_CLEAR_DELAY_MS, TILE, TORCH_MAX_MS, WIPE_RESTART_DELAY_MS } from '../core/constants';
import { CHARACTERS, specialFraction } from '../core/characters';
import { hourglassLeverIndex, requiredPushers, statueRotationTarget } from '../core/mechanisms';
import { reviveDurationFor } from '../core/players';
import { resolveSlot } from '../core/slots';
import type {
  BrazierDef,
  EnemyState,
  GamePhase,
  GameState,
  KeyDef,
  LevelDef,
  PlayerId,
  PlayerState,
  RoomDef,
  SignDef,
  Vec2,
} from '../core/types';
import { t } from '../i18n/i18n';
import { ATLAS_KEY } from './art';
import { heartFrame, hourglassFrame, lanternFrame, torchIconFrame, uiKeyFrame } from './art/animations';
import {
  activeHourglass,
  hourglassBarColor,
  hourglassBarWidth,
  hourglassBlinkAlpha,
  lanternBearers,
  lanternHudInfo,
  type HourglassLevel,
} from './mechHud';
import { edgeIndicator } from './camera';
import { hex } from './palettes';
import {
  MAX_GOAL_LINES,
  computeExitOpen,
  describePersonalObjectives,
  describeRoomGoals,
  enemiesRemaining,
  goalLineText,
  objectiveLineText,
  roomIndexOf,
  teamObjectiveText,
  type GoalLine,
} from './roomGoals';
import { mixColor as mixHex } from './specialFx';
import { SEPARATOR_COLOR, type ScreenRect, type SplitLayout } from './splitscreen';
import { showTorchHud, torchBarColor, torchBarWidth, torchBlinkAlpha, torchFraction, torchLevel, type TorchLevel } from './torchHud';
import type { ViewContext } from '../entities/common';

// ───────────────────────────── Partie pure ─────────────────────────────

/** PV représentés par un cœur. */
export const HP_PER_HEART = 10;
/** Nombre max de cœurs affichés (150 PV de résistance 10 ⇒ 15 ; marge de sécurité). */
export const MAX_HEARTS = 20;
/** Distance (px) à laquelle un panneau affiche son texte. */
export const SIGN_RANGE = 30;
/** Distance (px) à laquelle l'invite « relever » apparaît près d'un allié à terre. */
export const REVIVE_PROMPT_RANGE = REVIVE_RANGE * 1.8;

/** Nombre de cœurs pour des PV max donnés (au moins 1, au plus MAX_HEARTS). */
export function heartCount(maxHp: number): number {
  if (!Number.isFinite(maxHp) || maxHp <= 0) return 1;
  return Math.max(1, Math.min(MAX_HEARTS, Math.ceil(maxHp / HP_PER_HEART)));
}

/** Noms de frames des cœurs (pleins / demi / vides) pour `hp` sur `maxHp`. */
export function heartFrames(hp: number, maxHp: number): string[] {
  const n = heartCount(maxHp);
  const safeHp = Number.isFinite(hp) ? Math.max(0, Math.min(maxHp, hp)) : 0;
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(heartFrame(i, safeHp, HP_PER_HEART));
  return out;
}

/** Progression 0..1 du relevage SUR `target` (0 si personne ne le relève). */
export function reviveRatioFor(target: PlayerState, players: readonly PlayerState[]): number {
  if (target.status !== 'down' || target.reviverId === null || !(target.reviveProgressMs > 0)) return 0;
  const reviver = players.find((p) => p.id === target.reviverId);
  if (!reviver) return 0;
  const dur = reviveDurationFor(reviver);
  return dur > 0 ? Math.max(0, Math.min(1, target.reviveProgressMs / dur)) : 0;
}

/** Proportion de PV du boss (0..1). */
export function bossBarRatio(e: Pick<EnemyState, 'hp' | 'maxHp'>): number {
  if (!(e.maxHp > 0)) return 0;
  return Math.max(0, Math.min(1, e.hp / e.maxHp));
}

// Aides d'objectifs (sortie ouverte, ennemis restants, objectifs visibles…) : voir `roomGoals.ts` (ré-exportées ici).
export {
  ENEMY_COUNTER_MAX,
  computeExitOpen,
  describeObjective,
  enemiesRemaining,
  formatPercent,
  objectiveTotals,
  pendingSpawnCount,
  visibleObjectives,
  type ObjectiveLine,
} from './roomGoals';

/** Les flèches de bord vers les derniers ennemis apparaissent à partir de ce nombre. */
export const ENEMY_ARROW_MAX = 3;

/** Positions des ennemis vivants, du plus proche de `from` au plus éloigné (au plus `max`). */
export function nearestEnemyPositions(state: GameState, from: Vec2, max: number): Vec2[] {
  const list: { pos: Vec2; d: number }[] = [];
  for (const e of state.room.enemies) {
    if (e.dead) continue;
    list.push({ pos: e.pos, d: Math.hypot(e.pos.x - from.x, e.pos.y - from.y) });
  }
  list.sort((a, b) => a.d - b.d);
  return list.slice(0, Math.max(0, max)).map((l) => l.pos);
}

/** Opacité (0..1) du fondu au noir : fermeture en fin de salle/défaite, ouverture à l'arrivée dans une salle. */
export function fadeAlpha(phase: GamePhase, phaseTimerMs: number, sinceEnterMs: number): number {
  const FADE_OUT_MS = 600;
  const FADE_IN_MS = 550;
  let out = 0;
  if (phase === 'roomCleared') out = Math.max(0, Math.min(1, (phaseTimerMs - (ROOM_CLEAR_DELAY_MS - FADE_OUT_MS)) / FADE_OUT_MS));
  else if (phase === 'wipe') out = Math.max(0, Math.min(1, (phaseTimerMs - (WIPE_RESTART_DELAY_MS - FADE_OUT_MS)) / FADE_OUT_MS));
  const inn = sinceEnterMs >= FADE_IN_MS ? 0 : Math.max(0, 1 - Math.max(0, sinceEnterMs) / FADE_IN_MS);
  return Math.max(out, inn);
}

/** Clé i18n du nom de couleur d'un joueur (`hint.slotcolor.blue` …). */
export function colorNameKey(playerId: number): string {
  return `hint.slotcolor.${PLAYER_COLOR_NAMES[((playerId % 4) + 4) % 4]}`;
}

/** Panneau à portée du joueur (le plus proche à ≤ SIGN_RANGE), ou null. */
export function nearestSign(room: RoomDef, p: Pick<PlayerState, 'pos' | 'status'>): SignDef | null {
  if (p.status !== 'alive' || !room.signs) return null;
  let best: SignDef | null = null;
  let bestD = SIGN_RANGE;
  for (const s of room.signs) {
    const d = Math.hypot(p.pos.x - (s.tile[0] + 0.5) * TILE, p.pos.y - (s.tile[1] + 0.5) * TILE);
    if (d <= bestD) {
      bestD = d;
      best = s;
    }
  }
  return best;
}

/** Slot propriétaire d'une clé, cherchée dans toutes les salles du niveau (icône de clé détenue). */
export function keyOwnerSlot(level: LevelDef, keyId: string): number | undefined {
  for (const r of level.rooms) {
    for (const m of r.mechanisms) if (m.type === 'key' && m.id === keyId) return m.ownerSlot;
  }
  return undefined;
}

/** Invite contextuelle : clé i18n + paramètres + couleur d'accent (slot concerné) éventuelle. */
export interface ContextPrompt {
  key: string;
  params?: Record<string, string | number>;
  /** Couleur d'accent (joueur concerné), ou null. */
  color: number | null;
  /** Catégorie (tests, icône) : 'revive' | 'lever' | 'door' | 'key' | 'rune' | 'block' | 'exit' | 'brazier'. */
  kind: 'revive' | 'lever' | 'door' | 'key' | 'rune' | 'block' | 'exit' | 'brazier' | 'statue' | 'hourglass';
}

function slotParams(slot: number, n: number): { params: Record<string, string>; color: number } {
  const pid = resolveSlot(slot, n);
  return { params: { color: t(colorNameKey(pid)) }, color: PLAYER_COLORS[pid] };
}

/**
 * Invite d'un brasero à portée : « recharger ta torche » (allumé, torche pas pleine), « allumer le brasero » (éteint,
 * torche non vide), « torche éteinte » (éteint et torche vide) ou « réservé au joueur X » (ownerSlot d'un autre).
 * Retourne null s'il n'y a rien à proposer (brasero allumé et torche pleine). `lit` : brasero allumé.
 */
export function brazierPrompt(def: Pick<BrazierDef, 'ownerSlot'>, lit: boolean, p: Pick<PlayerState, 'id' | 'torchMs'>, playerCount: number): ContextPrompt | null {
  if (lit) {
    if (p.torchMs >= TORCH_MAX_MS - 1) return null;
    return { key: 'hint.brazierRefuel', color: null, kind: 'brazier' };
  }
  if (def.ownerSlot !== undefined && resolveSlot(def.ownerSlot, playerCount) !== p.id) {
    const sp = slotParams(def.ownerSlot, playerCount);
    return { key: 'hint.slotRequired', params: sp.params, color: sp.color, kind: 'brazier' };
  }
  return { key: p.torchMs > 0 ? 'hint.brazierLight' : 'hint.brazierNoTorch', color: null, kind: 'brazier' };
}

/**
 * Invite contextuelle du joueur `playerId` (« Action : relever », levier, porte à clé, piédestal, bloc, sortie…),
 * ou null s'il n'y a rien à proposer. Priorité : relever un allié > mécanisme le plus proche > sortie.
 */
export function computeContextPrompt(state: GameState, level: LevelDef, room: RoomDef, playerId: PlayerId): ContextPrompt | null {
  const p = state.players[playerId];
  if (!p || p.status !== 'alive') return null;
  const n = state.playerCount;

  // 1. allié à terre à proximité
  let bestDown: PlayerState | null = null;
  let bestDownD = REVIVE_PROMPT_RANGE;
  for (const q of state.players) {
    if (q.id === p.id || q.status !== 'down') continue;
    const d = Math.hypot(p.pos.x - q.pos.x, p.pos.y - q.pos.y);
    if (d <= bestDownD) {
      bestDownD = d;
      bestDown = q;
    }
  }
  if (bestDown) {
    const name = t(CHARACTERS[bestDown.characterId].nameKey);
    return {
      key: p.revivingId === bestDown.id ? 'hud.reviving' : 'hud.reviveHold',
      params: { name },
      color: PLAYER_COLORS[bestDown.id],
      kind: 'revive',
    };
  }

  // 2. mécanismes
  let best: ContextPrompt | null = null;
  let bestD = Infinity;
  let brazierBest: ContextPrompt | null = null;
  let brazierBestD = Infinity;
  const consider = (d: number, prompt: ContextPrompt): void => {
    if (d < bestD) {
      bestD = d;
      best = prompt;
    }
  };
  for (let i = 0; i < room.mechanisms.length; i++) {
    const def = room.mechanisms[i];
    let st = state.room.mechanisms[i];
    if (!st || st.id !== def.id) st = state.room.mechanisms.find((m) => m.id === def.id) as typeof st;
    if (!st || st.waived) continue;
    switch (def.type) {
      case 'lever': {
        const d = Math.hypot(p.pos.x - (def.tile[0] + 0.5) * TILE, p.pos.y - (def.tile[1] + 0.5) * TILE);
        if (d > INTERACT_RANGE) break;
        if (def.ownerSlot !== undefined && resolveSlot(def.ownerSlot, n) !== p.id) {
          const sp = slotParams(def.ownerSlot, n);
          consider(d, { key: 'hint.slotRequired', params: sp.params, color: sp.color, kind: 'lever' });
        } else if (!st.active || (def.windowMs ?? 0) > 0) {
          consider(d, { key: 'hint.useLever', color: null, kind: 'lever' });
        }
        break;
      }
      case 'door': {
        if (st.type !== 'door' || st.open) break;
        let d = Infinity;
        for (const tile of def.tiles) {
          d = Math.min(d, Math.hypot(p.pos.x - (tile[0] + 0.5) * TILE, p.pos.y - (tile[1] + 0.5) * TILE));
        }
        if (d > INTERACT_RANGE + 4) break;
        if (def.keyId !== undefined) {
          if (p.keys.includes(def.keyId)) {
            consider(d, { key: 'hint.useKey', color: null, kind: 'door' });
          } else {
            const owner = room.mechanisms.find((m): m is KeyDef => m.type === 'key' && m.id === def.keyId);
            if (owner && resolveSlot(owner.ownerSlot, n) === p.id) consider(d, { key: 'hint.needKey', color: null, kind: 'door' });
            else if (owner) {
              const sp = slotParams(owner.ownerSlot, n);
              consider(d, { key: 'hint.slotRequired', params: sp.params, color: sp.color, kind: 'door' });
            }
          }
        } else {
          consider(d, { key: 'hint.locked', color: null, kind: 'door' });
        }
        break;
      }
      case 'key': {
        if (st.type !== 'key' || st.collected || st.active) break;
        const d = Math.hypot(p.pos.x - (def.tile[0] + 0.5) * TILE, p.pos.y - (def.tile[1] + 0.5) * TILE);
        if (d > INTERACT_RANGE + 8) break;
        if (resolveSlot(def.ownerSlot, n) === p.id) consider(d, { key: 'game.prompt.walkOverKey', color: PLAYER_COLORS[p.id], kind: 'key' });
        else {
          const sp = slotParams(def.ownerSlot, n);
          consider(d, { key: 'hint.slotRequired', params: sp.params, color: sp.color, kind: 'key' });
        }
        break;
      }
      case 'runePuzzle': {
        if (st.active) break;
        for (const ped of def.pedestals) {
          const d = Math.hypot(p.pos.x - (ped.tile[0] + 0.5) * TILE, p.pos.y - (ped.tile[1] + 0.5) * TILE);
          if (d <= INTERACT_RANGE) {
            consider(d, { key: 'game.prompt.pedestal', params: { symbol: t(`mech.symbol.${ped.symbol}`) }, color: null, kind: 'rune' });
          }
        }
        break;
      }
      case 'block': {
        if (st.type !== 'block') break;
        const need = requiredPushers(def, n);
        const bx = st.pos.x;
        const by = st.pos.y;
        const size = 2 * TILE;
        const dx = Math.max(bx - p.pos.x, 0, p.pos.x - (bx + size));
        const dy = Math.max(by - p.pos.y, 0, p.pos.y - (by + size));
        const d = Math.hypot(dx, dy);
        if (d <= 12 && need > 1) consider(d, { key: 'hint.pushBlock', color: null, kind: 'block' });
        break;
      }
      case 'brazier': {
        if (st.type !== 'brazier') break;
        const d = Math.hypot(p.pos.x - (def.tile[0] + 0.5) * TILE, p.pos.y - (def.tile[1] + 0.5) * TILE);
        if (d > INTERACT_RANGE || d >= brazierBestD) break;
        const bp = brazierPrompt(def, st.active, p, n);
        if (bp) {
          brazierBest = bp;
          brazierBestD = d;
        }
        break;
      }
      case 'statuePair': {
        // debout sur un socle : l'appui Action fait pivoter l'AUTRE statue (la simulation arbitre, on ne fait qu'annoncer)
        if (st.type !== 'statuePair' || statueRotationTarget(def, st, p) === null) break;
        consider(0, { key: 'hint.rotateStatue', color: null, kind: 'statue' });
        break;
      }
      case 'hourglass': {
        if (st.type !== 'hourglass') break;
        const li = hourglassLeverIndex(def, p);
        if (li < 0) break;
        const lt = def.levers[li];
        consider(Math.hypot(p.pos.x - (lt[0] + 0.5) * TILE, p.pos.y - (lt[1] + 0.5) * TILE), { key: 'hint.flipHourglass', color: null, kind: 'hourglass' });
        break;
      }
      default:
        break;
    }
  }
  // priorité d'un appui Action : porte à clé > levier > rune > brasero (l'invite affichée annonce ce que fera l'appui)
  const picked = best as ContextPrompt | null;
  if (picked && (picked.kind === 'door' || picked.kind === 'lever' || picked.kind === 'rune')) return picked;
  const brazierPick = brazierBest as ContextPrompt | null;
  if (brazierPick) return brazierPick;
  if (picked) return picked;

  // 3. sortie
  const er = room.exit.rect;
  const dxe = Math.max(er.x * TILE - p.pos.x, 0, p.pos.x - (er.x + er.w) * TILE);
  const dye = Math.max(er.y * TILE - p.pos.y, 0, p.pos.y - (er.y + er.h) * TILE);
  const de = Math.hypot(dxe, dye);
  if (de <= TILE * 3) {
    if (computeExitOpen(state, level, room)) return { key: 'hint.gatherAtExit', color: null, kind: 'exit' };
    if (room.exit.sealed && de <= TILE * 1.5) return { key: 'hint.sealedExit', color: null, kind: 'exit' };
  }
  return null;
}

// ───────────────────────────── Attaque spéciale : partie pure ─────────────────────────────

/** Couleur de la jauge de spécial quand elle est prête (or). */
export const SPECIAL_READY_COLOR = 0xf5c53d;
/** Couleur de l'icône de spécial pendant la recharge. */
export const SPECIAL_CHARGING_TINT = 0x6e6a82;

/** État d'affichage du spécial d'un joueur. */
export interface SpecialStatus {
  /** Le personnage a-t-il un spécial ? */
  has: boolean;
  /** Charge 0..1 (1 = prêt). */
  ratio: number;
  ready: boolean;
  /** Secondes restantes avant d'être prêt (arrondi au supérieur, 0 si prêt). */
  secondsLeft: number;
}

/** Niveau de charge du spécial du joueur `p` (utilise `specialFraction` du moteur). Pur. */
export function specialStatus(p: Pick<PlayerState, 'characterId' | 'specialCooldownMs'>): SpecialStatus {
  const def = CHARACTERS[p.characterId];
  if (!def || !def.special) return { has: false, ratio: 0, ready: false, secondsLeft: 0 };
  const ratio = specialFraction(p, def);
  const cd = Number.isFinite(p.specialCooldownMs) ? Math.max(0, p.specialCooldownMs) : 0;
  const ready = !(cd > 0);
  return { has: true, ratio: ready ? 1 : ratio, ready, secondsLeft: ready ? 0 : Math.ceil(cd / 1000) };
}

/** Pulsation 0..1 (~1,6 Hz) de l'état « PRÊT ». */
export function specialPulse(timeMs: number): number {
  return 0.5 + 0.5 * Math.sin(timeMs / 160);
}

/** Libellé court d'une touche (`KeyF` -> `F`, `Digit1` -> `1`, `Space` -> `Espace`...). */
export function keyCodeLabel(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Pav.${code.slice(6)}`;
  if (code === 'Space') return 'Espace';
  if (code.startsWith('Arrow')) return ({ ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' } as Record<string, string>)[code] ?? code;
  return code;
}

const PAD_LABELS = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT'];

/** Libellé d'un bouton de manette (mapping standard : 0..7 ; au-delà `B<n>`). */
export function padButtonLabel(index: number): string {
  return PAD_LABELS[index] ?? `B${index}`;
}

/** Entrée attribuée à un joueur (sous-ensemble de `PlayerAssignment`). */
export interface HintAssignment {
  label: string;
  anyDevice?: boolean;
}

/** Touches / boutons du spécial (sous-ensemble de `Bindings.special`). */
export interface HintBinding {
  keys: readonly string[];
  pad: readonly number[];
}

/**
 * Rappel du bouton du spécial pour un joueur : touches clavier (« F/X »), bouton de manette (« Y »), ou les deux
 * (« F/X / Y ») en solo « première source utilisée ». Sans information : « F/X » (valeurs par défaut).
 */
export function specialHintLabel(assignment: HintAssignment | undefined, binding: HintBinding | undefined): string {
  const keys = binding && binding.keys.length > 0 ? binding.keys : ['KeyF', 'KeyX'];
  const pad = binding && binding.pad.length > 0 ? binding.pad : [3];
  const kb = keys.slice(0, 2).map(keyCodeLabel).join('/');
  const pd = padButtonLabel(pad[0]);
  if (!assignment) return kb;
  if (assignment.anyDevice) return `${kb} / ${pd}`;
  return assignment.label === 'gamepad' ? pd : kb;
}

// ───────────────────────────── Fabriques d'éléments (Phaser) ─────────────────────────────

type Text = Phaser.GameObjects.Text;
type Img = Phaser.GameObjects.Image;
type Rect = Phaser.GameObjects.Rectangle;

/** Profondeurs de l'interface. */
export const HUD_DEPTH = { overlay: 5, bg: 10, content: 11, banner: 20, fade: 100, pause: 200 } as const;

export interface HudTextOptions {
  size?: number;
  color?: number;
  bold?: boolean;
  originX?: number;
  originY?: number;
  wrap?: number;
  depth?: number;
  align?: 'left' | 'center' | 'right';
  strokeThickness?: number;
}

/** Crée un texte d'interface (enregistré dans la caméra d'interface seulement). */
export function hudText(ctx: ViewContext, x: number, y: number, str: string, o: HudTextOptions = {}): Text {
  const size = o.size ?? 14;
  const txt = ctx.scene.add.text(x, y, str, {
    fontFamily: 'monospace',
    fontStyle: o.bold === false ? 'normal' : 'bold',
    fontSize: `${size}px`,
    color: hex(o.color ?? 0xffffff),
    stroke: '#0b0912',
    strokeThickness: o.strokeThickness ?? Math.max(2, Math.round(size / 5)),
    align: o.align ?? 'left',
    wordWrap: o.wrap && o.wrap > 0 ? { width: o.wrap, useAdvancedWrap: true } : undefined,
  });
  txt.setOrigin(o.originX ?? 0, o.originY ?? 0);
  txt.setDepth(o.depth ?? HUD_DEPTH.content);
  ctx.rig.registerHud(txt);
  return txt;
}

/** Crée un rectangle plein d'interface. */
export function hudRect(ctx: ViewContext, x: number, y: number, w: number, h: number, color: number, alpha = 1, depth: number = HUD_DEPTH.bg): Rect {
  const r = ctx.scene.add.rectangle(x, y, w, h, color, alpha);
  r.setDepth(depth);
  ctx.rig.registerHud(r);
  return r;
}

/** Crée une icône d'atlas d'interface (échelle entière `scale`, origine en haut à gauche). */
export function hudIcon(ctx: ViewContext, x: number, y: number, frame: string, scale: number, depth: number = HUD_DEPTH.content): Img {
  const img = ctx.scene.add.image(x, y, ATLAS_KEY, frame);
  img.setOrigin(0, 0).setScale(scale).setDepth(depth);
  ctx.rig.registerHud(img);
  return img;
}

/** Fond translucide qui épouse un texte. */
function fitBg(bg: Rect, text: Text, padX: number, padY: number): void {
  bg.setSize(text.width + padX * 2, text.height + padY * 2);
}

/** Met à jour un texte seulement si la chaîne change (évite de re-rasteriser le canvas). */
export function setTextIfChanged(text: Text, value: string): boolean {
  if (text.text === value) return false;
  text.setText(value);
  return true;
}

// ───────────────────────────── Environnement ─────────────────────────────

export interface HudEnv {
  ctx: ViewContext;
  level: LevelDef;
  layout: SplitLayout;
  /** Rappel du bouton du spécial pour un joueur (« F/X », « Y »...), fourni par la scène (absent = « F/X »). */
  specialHint?: (playerId: PlayerId) => string;
}

/** Rectangle en coordonnées écran. */
export interface ScreenBounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Deux rectangles se recouvrent-ils (bords qui se touchent = non) ? Pur. */
export function boundsOverlap(a: ScreenBounds, b: ScreenBounds): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

/** Données passées à chaque mise à jour du HUD d'un joueur. */
export interface PlayerHudUpdate {
  /** Rectangles écran des bandeaux d'arrivée de salle / de sortie affichés (le bloc d'objectif de salle s'efface dessous). */
  banners?: readonly ScreenBounds[];
  state: GameState;
  room: RoomDef;
  dtMs: number;
  timeMs: number;
  exitOpen: boolean;
  /** Centre monde de la caméra de ce joueur et taille de sa vue (flèches vers les alliés hors champ). */
  camCenter: { x: number; y: number };
}

const REFRESH_MS = 60;

// ───────────────────────────── HUD d'un joueur ─────────────────────────────

/** HUD d'UN joueur, dans SA vue. */
export class PlayerHud {
  private readonly env: HudEnv;
  private readonly vp: ScreenRect;
  private readonly u: number;
  private readonly fs: number;
  private readonly color: number;
  private readonly name: Text;
  private readonly hp: Text;
  private readonly hearts: Img[] = [];
  private readonly heartFramesCache: string[] = [];
  private readonly keyIcons: Img[] = [];
  private readonly objHeader: Text;
  private readonly objIcons: Img[] = [];
  private readonly objTexts: Text[] = [];
  private readonly objBg: Rect;
  private readonly promptBg: Rect;
  private readonly promptText: Text;
  private readonly signBg: Rect;
  private readonly signText: Text;
  private readonly downOverlay: Rect;
  private readonly downIcon: Img;
  private readonly downTitle: Text;
  private readonly downSub: Text;
  private readonly barBg: Rect;
  private readonly barFill: Rect;
  private readonly toastBg: Rect;
  private readonly toastText: Text;
  private readonly arrows: Img[] = [];
  private readonly enemyArrows: Img[] = [];
  // bloc « Objectif de la salle » (haut à droite) : fond, en-tête, lignes cochables (icône + texte)
  private readonly goalBg: Rect;
  private readonly goalHeader: Text;
  private readonly goalIcons: Img[] = [];
  private readonly goalTexts: Text[] = [];
  private readonly goalRight: number;
  private readonly goalTop: number;
  private readonly goalIconCol: number;
  private goalSig = '';
  private goalShown = false;
  /** Bord bas (écran) du bloc d'objectif de salle, ou son bord haut s'il est masqué : les bandeaux et notifications se placent en dessous. */
  private goalBottom: number;
  private goalLeft: number;
  /** Bloc masqué parce qu'un bandeau d'arrivée de salle passerait dessus (il réapparaît quand le bandeau s'efface). */
  private goalBlocked = false;
  private readonly goalRect: ScreenBounds = { x0: 0, y0: 0, x1: 0, y1: 0 };
  private enemyLeft: number | null = null;
  private readonly frameGfx: Phaser.GameObjects.Graphics;
  private readonly torchIcon: Img;
  private readonly torchBarBg: Rect;
  private readonly torchBarFill: Rect;
  private readonly torchBarW: number;
  private torchShown = false;
  private torchLvl: TorchLevel = 'full';
  private torchFrameCache = '';
  private torchWCache = -1;
  private torchFlashUntilMs = 0;
  private readonly spIcon: Img;
  private readonly spBarBg: Rect;
  private readonly spBarFill: Rect;
  private readonly spText: Text;
  private readonly spBarW: number;
  // sablier partagé (niveau 5) et lanterne du pont de lumière (niveau 6) : bandeaux en haut à droite de la vue
  private readonly puzBg: Rect;
  private readonly hgIcon: Img;
  private readonly hgBarBg: Rect;
  private readonly hgBarFill: Rect;
  private readonly hgText: Text;
  private readonly lanBg: Rect;
  private readonly lanIcon: Img;
  private readonly lanText: Text;
  private readonly hgBarW: number;
  private readonly puzRight: number;
  private puzTop: number;
  private hgShown = false;
  private hgLevel: HourglassLevel = 'ok';
  private hgRatio = 0;
  private hgFrame = '';
  private hgSig = '';
  private hgW = -1;
  private lanShown = false;
  private lanSig = '';
  private lanFrame = '';
  private spName = '';
  private spSig = '';
  private spHint = '';
  private spHintAccumMs = 1e9;
  private spFlashMs = 0;
  private spReadyPrev = true;
  private toastLeftMs = 0;
  private refreshAccum = REFRESH_MS;
  private objSig = '';
  private keySig = '';
  private promptSig = '';
  private signSig = '';
  private heartsN: number;

  constructor(env: HudEnv, readonly playerId: PlayerId, p: PlayerState) {
    this.env = env;
    const { ctx, layout } = env;
    this.vp = layout.viewports[playerId];
    this.u = layout.zoom;
    this.fs = this.u >= 3 ? 17 : 13;
    this.color = PLAYER_COLORS[playerId];
    const { x: vx, y: vy, w: vw, h: vh } = this.vp;
    const m = 10;
    const u = this.u;

    // cadre coloré (liseré) autour de la vue, seulement en écran partagé
    this.frameGfx = ctx.scene.add.graphics();
    this.frameGfx.setDepth(HUD_DEPTH.bg);
    ctx.rig.registerHud(this.frameGfx);
    if (layout.playerCount > 1) {
      this.frameGfx.lineStyle(3, this.color, 0.95);
      this.frameGfx.strokeRect(vx + 1.5, vy + 1.5, vw - 3, vh - 3);
    }

    this.downOverlay = hudRect(ctx, vx + vw / 2, vy + vh / 2, vw, vh, 0x501018, 0.28, HUD_DEPTH.overlay);
    this.downOverlay.setVisible(false);

    this.name = hudText(ctx, vx + m, vy + m, t(CHARACTERS[p.characterId].nameKey), { size: this.fs + 2, color: this.color });
    this.hp = hudText(ctx, vx + m + 120, vy + m + 2, '', { size: this.fs - 2, color: 0xffffff });

    this.heartsN = heartCount(p.maxHp);
    const hy = vy + m + this.fs + 10;
    for (let i = 0; i < this.heartsN; i++) {
      const h = hudIcon(ctx, vx + m + i * (8 * u + u), hy, 'ui_heart_full', u);
      this.hearts.push(h);
      this.heartFramesCache.push('ui_heart_full');
    }
    // indicateur d'attaque spéciale : icône + jauge + texte, sous les cœurs
    const sy = hy + 8 * u + 6;
    const rowMid = sy + 4 * u;
    this.spBarW = Math.max(64, Math.min(96, Math.floor(vw * 0.2)));
    this.spIcon = hudIcon(ctx, vx + m, sy, 'ui_special', u);
    const bx = vx + m + 8 * u + 6;
    this.spBarBg = hudRect(ctx, bx - 2, rowMid, this.spBarW + 4, Math.max(10, u * 3 + 4), 0x0b0912, 0.85);
    this.spBarBg.setOrigin(0, 0.5);
    this.spBarFill = hudRect(ctx, bx, rowMid, 1, Math.max(6, u * 3), this.color, 1, HUD_DEPTH.content);
    this.spBarFill.setOrigin(0, 0.5);
    this.spText = hudText(ctx, bx + this.spBarW + 10, rowMid, '', { size: this.fs - 1, originY: 0.5, color: 0xffffff });
    const spDef = CHARACTERS[p.characterId].special;
    for (const o of [this.spIcon, this.spBarBg, this.spBarFill, this.spText]) o.setVisible(!!spDef);
    this.spName = spDef ? t(spDef.nameKey) : '';
    const ky = sy + 8 * u + 6;
    for (let i = 0; i < 3; i++) {
      const k = hudIcon(ctx, vx + m + i * (8 * u + u), ky, 'ui_key_0', u);
      k.setVisible(false);
      this.keyIcons.push(k);
    }

    // jauge de torche (salles sombres seulement) : icône + fine barre, à droite des clés
    const tx0 = vx + m + 3 * (8 * u + u) + 10;
    this.torchBarW = 14 * u;
    this.torchIcon = hudIcon(ctx, tx0, ky, torchIconFrame(1), u);
    const barH = Math.max(3, u + 1);
    const barY = ky + Math.round((8 * u - barH) / 2);
    this.torchBarBg = hudRect(ctx, tx0 + 8 * u + 4 - 1, barY - 1, this.torchBarW + 2, barH + 2, 0x0b0912, 0.85);
    this.torchBarBg.setOrigin(0, 0);
    this.torchBarFill = hudRect(ctx, tx0 + 8 * u + 4, barY, this.torchBarW, barH, torchBarColor('full'), 1, HUD_DEPTH.content);
    this.torchBarFill.setOrigin(0, 0);
    for (const o of [this.torchIcon, this.torchBarBg, this.torchBarFill]) o.setVisible(false);

    const oy = ky + 8 * u + 8;
    this.objBg = hudRect(ctx, vx + m - 4, oy - 3, 10, 10, 0x0b0912, 0.55);
    this.objBg.setOrigin(0, 0).setVisible(false);
    this.objHeader = hudText(ctx, vx + m, oy, '', { size: this.fs - 1, color: 0xf0e2b0 });
    // largeur réduite : le bloc « Objectif de la salle » occupe le haut à droite (jusqu'à 40 % de la vue)
    const wrapW = Math.min(Math.floor(vw * 0.45), 460);
    for (let i = 0; i < 4; i++) {
      const ly = oy + this.fs + 6 + i * (this.fs + 8);
      const ic = hudIcon(ctx, vx + m, ly + 1, 'ui_cross', Math.max(1, u - 1));
      ic.setVisible(false);
      this.objIcons.push(ic);
      const tx = hudText(ctx, vx + m + 8 * Math.max(1, u - 1) + 6, ly, '', { size: this.fs - 1, color: 0xffffff, wrap: wrapW });
      tx.setVisible(false);
      this.objTexts.push(tx);
    }

    // invite contextuelle (bas de la vue) et bulle de panneau (au-dessus)
    this.promptBg = hudRect(ctx, vx + vw / 2, vy + vh - 26, 10, 10, 0x0b0912, 0.72);
    this.promptBg.setVisible(false);
    this.promptText = hudText(ctx, vx + vw / 2, vy + vh - 26, '', { size: this.fs, originX: 0.5, originY: 0.5, align: 'center', wrap: Math.floor(vw * 0.8) });
    this.promptText.setVisible(false);
    this.signBg = hudRect(ctx, vx + vw / 2, vy + vh - 80, 10, 10, 0x1c1530, 0.86);
    this.signBg.setStrokeStyle(2, 0xf0e2b0, 0.9).setVisible(false);
    this.signText = hudText(ctx, vx + vw / 2, vy + vh - 80, '', { size: this.fs, originX: 0.5, originY: 0.5, align: 'center', wrap: Math.floor(vw * 0.72), color: 0xfff6d8 });
    this.signText.setVisible(false);

    // à terre
    this.downIcon = hudIcon(ctx, vx + vw / 2 - 4 * u * 2, vy + vh * 0.28, 'ui_down', u * 2, HUD_DEPTH.banner);
    this.downIcon.setVisible(false);
    this.downTitle = hudText(ctx, vx + vw / 2, vy + vh * 0.28 + 8 * u * 2 + 10, t('hud.down'), { size: this.fs + 8, color: 0xff6a6a, originX: 0.5, depth: HUD_DEPTH.banner });
    this.downTitle.setVisible(false);
    this.downSub = hudText(ctx, vx + vw / 2, vy + vh * 0.28 + 8 * u * 2 + 10 + this.fs + 14, '', { size: this.fs, color: 0xffffff, originX: 0.5, align: 'center', wrap: Math.floor(vw * 0.8), depth: HUD_DEPTH.banner });
    this.downSub.setVisible(false);
    const bw = Math.min(260, Math.floor(vw * 0.5));
    this.barBg = hudRect(ctx, vx + vw / 2, vy + vh * 0.28 + 8 * u * 2 + 10 + this.fs * 2 + 40, bw + 4, 12, 0x0b0912, 0.9, HUD_DEPTH.banner);
    this.barFill = hudRect(ctx, vx + vw / 2 - bw / 2, this.barBg.y, bw, 8, 0x7dffb0, 1, HUD_DEPTH.banner + 1);
    this.barFill.setOrigin(0, 0.5);
    this.barBg.setVisible(false);
    this.barFill.setVisible(false);

    // notification
    this.toastBg = hudRect(ctx, vx + vw / 2, vy + Math.round(vh * 0.24), 10, 10, 0x0b0912, 0.78, HUD_DEPTH.banner);
    this.toastBg.setVisible(false);
    this.toastText = hudText(ctx, vx + vw / 2, vy + Math.round(vh * 0.24), '', { size: this.fs, originX: 0.5, originY: 0.5, align: 'center', wrap: Math.floor(vw * 0.7), depth: HUD_DEPTH.banner + 1 });
    this.toastText.setVisible(false);

    // flèches vers les alliés à terre hors champ
    for (let i = 0; i < 3; i++) {
      const a = hudIcon(ctx, 0, 0, 'fx_marker', u, HUD_DEPTH.banner);
      a.setOrigin(0.5, 0.5).setVisible(false);
      this.arrows.push(a);
    }
    // flèches (rouges) vers les derniers ennemis quand la sortie exige « tout vaincre »
    for (let i = 0; i < ENEMY_ARROW_MAX; i++) {
      const a = hudIcon(ctx, 0, 0, 'fx_marker', u, HUD_DEPTH.banner);
      a.setOrigin(0.5, 0.5).setTint(0xff5a4a).setVisible(false);
      this.enemyArrows.push(a);
    }
    // bloc « Objectif de la salle » (haut à droite de la vue) : fusionne l'ancien compteur d'ennemis restants
    this.goalRight = vx + vw - m - 6;
    this.goalTop = vy + m;
    this.goalLeft = this.goalRight;
    this.goalBottom = this.goalTop;
    const goalScale = Math.max(1, u - 1);
    this.goalIconCol = 8 * goalScale + 6;
    const goalWrap = Math.max(120, Math.min(420, Math.floor(vw * 0.4)) - this.goalIconCol);
    this.goalBg = hudRect(ctx, this.goalRight, this.goalTop, 10, 10, 0x0b0912, 0.66);
    this.goalBg.setOrigin(0, 0).setStrokeStyle(2, 0xf0e2b0, 0.7).setVisible(false);
    this.goalHeader = hudText(ctx, this.goalRight, this.goalTop, '', { size: this.fs - 1, color: 0xf0e2b0 });
    this.goalHeader.setVisible(false);
    for (let i = 0; i < MAX_GOAL_LINES; i++) {
      const ic = hudIcon(ctx, this.goalRight, this.goalTop, 'ui_cross', goalScale);
      ic.setVisible(false);
      this.goalIcons.push(ic);
      const tx = hudText(ctx, this.goalRight, this.goalTop, '', { size: this.fs - 1, color: 0xffffff, wrap: goalWrap });
      tx.setVisible(false);
      this.goalTexts.push(tx);
    }

    // bandeaux « sablier » et « lanterne » : sous le bloc d'objectif de salle, alignés à droite (repositionnés dynamiquement)
    this.puzRight = vx + vw - m;
    this.puzTop = vy + m + 4;
    this.hgBarW = Math.max(70, Math.min(120, Math.floor(vw * 0.18)));
    this.puzBg = hudRect(ctx, this.puzRight + 4, this.puzTop - 4, 10, 10, 0x0b0912, 0.62);
    this.puzBg.setOrigin(1, 0).setStrokeStyle(2, 0xe8b44a, 0.8).setVisible(false);
    this.hgIcon = hudIcon(ctx, this.puzRight - 32, this.puzTop, hourglassFrame(1), 2);
    const hgBarX = this.puzRight - 32 - 6 - this.hgBarW;
    const hgBarY = this.puzTop + this.fs + 8;
    this.hgBarBg = hudRect(ctx, hgBarX - 1, hgBarY - 1, this.hgBarW + 2, 10, 0x0b0912, 0.9);
    this.hgBarBg.setOrigin(0, 0);
    this.hgBarFill = hudRect(ctx, hgBarX, hgBarY, this.hgBarW, 8, hourglassBarColor('ok'), 1, HUD_DEPTH.content);
    this.hgBarFill.setOrigin(0, 0);
    this.hgText = hudText(ctx, this.puzRight - 32 - 6, this.puzTop + 2, '', { size: this.fs - 2, originX: 1, color: 0xffe08a });
    for (const o of [this.hgIcon, this.hgBarBg, this.hgBarFill, this.hgText]) o.setVisible(false);
    this.lanBg = hudRect(ctx, this.puzRight + 4, this.puzTop - 4, 10, 10, 0x0b0912, 0.62);
    this.lanBg.setOrigin(1, 0).setStrokeStyle(2, 0xffd86a, 0.8).setVisible(false);
    this.lanIcon = hudIcon(ctx, this.puzRight - 24, this.puzTop, lanternFrame(0), 3);
    this.lanText = hudText(ctx, this.puzRight - 24 - 6, this.puzTop + 12, '', { size: this.fs - 2, originX: 1, originY: 0.5, color: 0xffe9a8, wrap: Math.floor(vw * 0.4), align: 'right' });
    for (const o of [this.lanIcon, this.lanText]) o.setVisible(false);
  }

  /** Force la re-traduction des textes au prochain rafraîchissement (changement de langue). */
  retranslate(p: PlayerState): void {
    this.name.setText(t(CHARACTERS[p.characterId].nameKey));
    this.downTitle.setText(t('hud.down'));
    const sp = CHARACTERS[p.characterId].special;
    this.spName = sp ? t(sp.nameKey) : '';
    this.spSig = '';
    this.hgSig = '';
    this.lanSig = '';
    this.objSig = '';
    this.goalSig = '';
    this.promptSig = '';
    this.signSig = '';
    this.refreshAccum = REFRESH_MS;
  }

  /** Affiche une notification brève dans la vue du joueur. */
  showToast(text: string, color = 0xffffff, durationMs = 2600): void {
    // largeur disponible : à gauche du bloc d'objectif de salle et des bandeaux sablier/lanterne (jamais par-dessus ni sous eux)
    const avail = Math.max(80, Math.min(Math.floor(this.vp.w * 0.7), this.toastRightLimit() - this.vp.x - 8) - 24);
    this.toastText.setWordWrapWidth(avail, true);
    this.toastText.setText(text).setColor(hex(color));
    fitBg(this.toastBg, this.toastText, 12, 6);
    this.toastText.setVisible(true);
    this.toastBg.setVisible(true);
    this.toastLeftMs = durationMs;
    this.placeToast();
  }

  /** Bord droit (écran) que la notification ne doit pas dépasser : bord gauche du bloc d'objectif de salle / des bandeaux sablier-lanterne. */
  private toastRightLimit(): number {
    let limit = this.vp.x + this.vp.w;
    if (this.goalShown) limit = Math.min(limit, this.goalLeft - 8);
    if (this.puzBg.visible) limit = Math.min(limit, this.puzBg.x - this.puzBg.width - 8);
    if (this.lanBg.visible) limit = Math.min(limit, this.lanBg.x - this.lanBg.width - 8);
    return limit;
  }

  /** Place la notification au centre haut de la vue, décalée vers la gauche pour ne pas recouvrir le bloc d'objectif de salle ni les bandeaux. */
  private placeToast(): void {
    const { x: vx, y: vy, w: vw, h: vh } = this.vp;
    const y = vy + Math.round(vh * 0.24);
    const w = this.toastBg.width;
    let cx = vx + vw / 2;
    const limit = this.toastRightLimit();
    if (cx + w / 2 > limit) cx = Math.max(vx + 4 + w / 2, limit - w / 2);
    if (this.toastBg.y !== y || this.toastBg.x !== cx) {
      this.toastBg.setPosition(cx, y);
      this.toastText.setPosition(cx, y);
    }
  }

  /** Flash de l'indicateur de spécial (il vient de redevenir prêt). */
  flashSpecialReady(): void {
    this.spFlashMs = 650;
  }

  /** Fait clignoter brièvement la jauge de torche (rechargement, alerte). */
  flashTorch(timeMs: number, durationMs = 700): void {
    this.torchFlashUntilMs = timeMs + durationMs;
  }

  /** Met à jour le HUD (texte rafraîchi ~16 Hz ; flèches, jauge de torche et notification à chaque frame). */
  update(a: PlayerHudUpdate): void {
    const { state } = a;
    const p = state.players[this.playerId];
    if (!p) return;
    this.updateTorchBlink(a.timeMs);
    this.refreshAccum += a.dtMs;
    if (this.refreshAccum >= REFRESH_MS) {
      this.refreshAccum = 0;
      this.refresh(p, a);
    }
    this.updateArrows(state, a);
    this.updateSpecial(p, a);
    this.blinkHourglass(a.timeMs);
    if (this.toastLeftMs > 0) {
      this.toastLeftMs -= a.dtMs;
      if (this.toastLeftMs <= 0) {
        this.toastText.setVisible(false);
        this.toastBg.setVisible(false);
      } else if (this.toastLeftMs < 400) {
        const al = Math.max(0, this.toastLeftMs / 400);
        this.toastText.setAlpha(al);
        this.toastBg.setAlpha(al * 0.78);
      } else {
        this.toastText.setAlpha(1);
        this.toastBg.setAlpha(0.78);
      }
    }
  }

  /** Clignotement de la jauge de torche (à chaque frame : seulement l'opacité). */
  private updateTorchBlink(timeMs: number): void {
    if (!this.torchShown) return;
    let al = torchBlinkAlpha(this.torchLvl, timeMs);
    if (timeMs < this.torchFlashUntilMs) al = Math.max(0, Math.min(1, 0.4 + 0.6 * Math.abs(Math.sin(timeMs / 70))));
    this.torchIcon.setAlpha(al);
    this.torchBarFill.setAlpha(al);
  }

  /** Jauge de torche : visible seulement en salle sombre ; icône, largeur et couleur selon le combustible. */
  private refreshTorch(p: PlayerState, room: RoomDef): void {
    const show = showTorchHud(room);
    if (show !== this.torchShown) {
      this.torchShown = show;
      this.torchIcon.setVisible(show);
      this.torchBarBg.setVisible(show);
      this.torchBarFill.setVisible(show);
      this.torchWCache = -1;
      if (!show) {
        this.torchIcon.setAlpha(1);
        this.torchBarFill.setAlpha(1);
      }
    }
    if (!show) return;
    const lvl = torchLevel(p.torchMs);
    if (lvl !== this.torchLvl) {
      this.torchLvl = lvl;
      this.torchBarFill.setFillStyle(torchBarColor(lvl), 1);
    }
    const f = torchIconFrame(torchFraction(p.torchMs));
    if (f !== this.torchFrameCache) {
      this.torchFrameCache = f;
      this.torchIcon.setFrame(f);
    }
    const w = torchBarWidth(p.torchMs, this.torchBarW);
    if (w !== this.torchWCache) {
      this.torchWCache = w;
      this.torchBarFill.setSize(Math.max(0.001, w), this.torchBarFill.height);
      this.torchBarFill.setVisible(w > 0);
    }
  }

  private refresh(p: PlayerState, a: PlayerHudUpdate): void {
    const { state, room } = a;
    const { level } = this.env;
    const down = p.status === 'down';
    this.refreshGoals(a, down);
    this.refreshTorch(p, room);
    this.refreshPuzzles(p, a);
    if (this.toastLeftMs > 0) this.placeToast();

    // PV
    const hpStr = `${t('hud.hp')} ${Math.max(0, Math.ceil(p.hp))}/${p.maxHp}`;
    setTextIfChanged(this.hp, hpStr);
    this.hp.setX(this.vp.x + 10 + this.name.width + 14);
    for (let i = 0; i < this.hearts.length; i++) {
      const f = heartFrame(i, Math.max(0, p.hp), HP_PER_HEART);
      if (f !== this.heartFramesCache[i]) {
        this.hearts[i].setFrame(f);
        this.heartFramesCache[i] = f;
      }
    }

    // clés détenues
    const keySlots: number[] = [];
    for (const id of p.keys) {
      const s = keyOwnerSlot(level, id);
      if (s !== undefined) keySlots.push(s);
    }
    const keySig = keySlots.join(',');
    if (keySig !== this.keySig) {
      this.keySig = keySig;
      for (let i = 0; i < this.keyIcons.length; i++) {
        const k = this.keyIcons[i];
        if (i < keySlots.length) k.setFrame(uiKeyFrame(keySlots[i])).setVisible(true);
        else k.setVisible(false);
      }
    }

    // objectifs personnels (en-tête et lignes seulement s'il y a au moins une ligne à montrer)
    const pv = describePersonalObjectives(state, level, p.id, room);
    const header = pv.header;
    const lines = pv.lines;
    let sig = header;
    for (const l of lines) sig += `|${l.id}:${l.done ? 1 : 0}:${l.detail}:${l.percent}:${l.where}`;
    if (sig !== this.objSig) {
      this.objSig = sig;
      this.objHeader.setText(header).setVisible(header !== '');
      let maxW = this.objHeader.width;
      let bottom = this.objHeader.y + this.objHeader.height;
      for (let i = 0; i < this.objTexts.length; i++) {
        const tx = this.objTexts[i];
        const ic = this.objIcons[i];
        const l = lines[i];
        if (!l) {
          tx.setVisible(false);
          ic.setVisible(false);
          continue;
        }
        tx.setText(objectiveLineText(l));
        tx.setColor(l.done ? '#8dffa8' : '#ffffff');
        tx.setVisible(true);
        ic.setFrame(l.done ? 'ui_check' : 'ui_cross').setVisible(true);
        maxW = Math.max(maxW, tx.x - this.objHeader.x + tx.width);
        bottom = Math.max(bottom, tx.y + tx.height);
      }
      // empile verticalement selon la hauteur réelle de chaque texte
      let y = this.objHeader.y + this.objHeader.height + 4;
      for (let i = 0; i < this.objTexts.length; i++) {
        const tx = this.objTexts[i];
        if (!tx.visible) continue;
        tx.setY(y);
        this.objIcons[i].setY(y + 1);
        y += tx.height + 4;
        bottom = y;
      }
      const showBg = header !== '';
      this.objBg.setVisible(showBg);
      if (showBg) {
        this.objBg.setPosition(this.objHeader.x - 6, this.objHeader.y - 4);
        this.objBg.setSize(maxW + 14, bottom - this.objHeader.y + 6);
      }
    }

    // invite contextuelle
    const prompt = down ? null : computeContextPrompt(state, level, room, p.id);
    const promptStr = prompt ? t(prompt.key, prompt.params) : '';
    if (promptStr !== this.promptSig) {
      this.promptSig = promptStr;
      const show = promptStr !== '';
      this.promptText.setVisible(show);
      this.promptBg.setVisible(show);
      if (show) {
        this.promptText.setText(promptStr);
        this.promptText.setColor(prompt && prompt.color !== null ? hex(prompt.color) : '#ffffff');
        fitBg(this.promptBg, this.promptText, 14, 7);
        this.promptBg.setStrokeStyle(2, prompt && prompt.color !== null ? prompt.color : 0x8890ac, 0.9);
      }
    }

    // bulle de panneau
    const sign = down ? null : nearestSign(room, p);
    const signStr = sign ? t(sign.textKey) : '';
    if (signStr !== this.signSig) {
      this.signSig = signStr;
      const show = signStr !== '';
      this.signText.setVisible(show);
      this.signBg.setVisible(show);
      if (show) {
        this.signText.setText(signStr);
        fitBg(this.signBg, this.signText, 16, 10);
      }
    }

    // à terre
    this.downOverlay.setVisible(down);
    this.downIcon.setVisible(down);
    this.downTitle.setVisible(down);
    this.downSub.setVisible(down);
    const ratio = down ? reviveRatioFor(p, state.players) : 0;
    this.barBg.setVisible(down && ratio > 0);
    this.barFill.setVisible(down && ratio > 0);
    if (down) {
      const reviver = p.reviverId !== null ? state.players[p.reviverId] : undefined;
      const sub = reviver ? t('hud.beingRevived', { name: t(CHARACTERS[reviver.characterId].nameKey) }) : t('game.downedWait');
      setTextIfChanged(this.downSub, sub);
      if (ratio > 0) this.barFill.setSize(Math.max(1, (this.barBg.width - 4) * ratio), 8);
    }
  }

  /**
   * Bloc « Objectif de la salle » (haut à droite) : ce qu'il faut faire pour ouvrir la sortie, une ligne cochable par exigence
   * (ennemis restants fusionnés dedans). Masqué quand le joueur est à terre. Repositionne ensuite les bandeaux sablier/lanterne
   * sous le bloc. Re-dessiné seulement quand sa signature change.
   */
  private refreshGoals(a: PlayerHudUpdate, down: boolean): void {
    const { state, room } = a;
    const { level } = this.env;
    this.enemyLeft = enemiesRemaining(state, room);
    // le bandeau de nom de salle / d'indice est centré sur tout l'écran : il recouvrirait le bloc de la vue de gauche
    let blocked = false;
    if (this.goalShown && a.banners) {
      const r = this.goalRect;
      r.x0 = this.goalLeft;
      r.x1 = this.goalRight;
      r.y0 = this.goalTop;
      r.y1 = this.goalBottom;
      for (let i = 0; i < a.banners.length && !blocked; i++) blocked = boundsOverlap(r, a.banners[i]);
    }
    if (blocked !== this.goalBlocked) {
      this.goalBlocked = blocked;
      this.goalSig = '';
    }
    const lines: readonly GoalLine[] = down ? [] : describeRoomGoals(state, level, room);
    let sig = '';
    for (const l of lines) sig += `|${l.id}:${l.done ? 1 : 0}${l.highlight ? 1 : 0}:${l.label}:${l.detail}`;
    if (sig !== this.goalSig) {
      this.goalSig = sig;
      this.layoutGoals(lines);
    }
    this.applyPuzTop(this.goalShown ? this.goalBottom + 12 : this.goalTop + 4);
  }

  /** Remplit et dispose le bloc d'objectif de salle (largeur ajustée au contenu, aligné à droite). */
  private layoutGoals(lines: readonly GoalLine[]): void {
    const show = lines.length > 0;
    this.goalShown = show;
    const vis = show && !this.goalBlocked;
    this.goalBg.setVisible(vis);
    this.goalHeader.setVisible(vis);
    if (!show) {
      for (let i = 0; i < this.goalTexts.length; i++) {
        this.goalTexts[i].setVisible(false);
        this.goalIcons[i].setVisible(false);
      }
      this.goalBottom = this.goalTop;
      this.goalLeft = this.goalRight;
      return;
    }
    const pad = 5;
    const gap = 3;
    this.goalHeader.setText(t(lines.length > 1 ? 'goal.header.other' : 'goal.header.one'));
    let maxW = this.goalHeader.width;
    let highlight = false;
    for (let i = 0; i < this.goalTexts.length; i++) {
      const tx = this.goalTexts[i];
      const ic = this.goalIcons[i];
      const l = lines[i];
      if (!l) {
        tx.setVisible(false);
        ic.setVisible(false);
        continue;
      }
      if (l.highlight) highlight = true;
      tx.setText(goalLineText(l));
      tx.setColor(l.highlight ? '#ffe08a' : l.done ? '#8dffa8' : '#ffffff');
      tx.setVisible(vis);
      ic.setFrame(l.done || l.highlight ? 'ui_check' : 'ui_cross').setVisible(vis);
      maxW = Math.max(maxW, this.goalIconCol + tx.width);
    }
    const x0 = this.goalRight - maxW;
    let y = this.goalTop + pad;
    this.goalHeader.setPosition(x0, y);
    y += this.goalHeader.height + gap;
    for (let i = 0; i < this.goalTexts.length; i++) {
      const tx = this.goalTexts[i];
      if (!lines[i]) continue;
      tx.setPosition(x0 + this.goalIconCol, y);
      this.goalIcons[i].setPosition(x0, y + 1);
      y += tx.height + gap;
    }
    const h = y - gap + pad - this.goalTop;
    this.goalBg.setPosition(x0 - pad, this.goalTop);
    this.goalBg.setSize(maxW + 2 * pad, h);
    this.goalBg.setStrokeStyle(2, highlight ? 0x8dffa8 : 0xf0e2b0, highlight ? 0.9 : 0.7);
    this.goalLeft = x0 - pad;
    this.goalBottom = this.goalTop + h;
  }

  /** Décale les bandeaux sablier/lanterne pour que leur bord haut soit à `top` (écran). */
  private applyPuzTop(top: number): void {
    const dy = top - this.puzTop;
    if (dy === 0) return;
    this.puzTop = top;
    for (const o of [this.puzBg, this.hgIcon, this.hgBarBg, this.hgBarFill, this.hgText]) o.setY(o.y + dy);
  }

  /** Sablier (temps de sable restant) et lanterne (porteur) : bandeaux de la vue, rafraîchis à ~16 Hz. */
  private refreshPuzzles(p: PlayerState, a: PlayerHudUpdate): void {
    const { state, room } = a;
    const hg = activeHourglass(state, room);
    const showHg = hg !== null && p.status === 'alive';
    if (showHg !== this.hgShown) {
      this.hgShown = showHg;
      for (const o of [this.hgIcon, this.hgBarBg, this.hgBarFill, this.hgText]) o.setVisible(showHg);
      this.hgSig = '';
    }
    let rowBottom = this.puzTop;
    let any = false;
    if (showHg && hg) {
      any = true;
      const s = hg.status;
      this.hgRatio = s.ratio;
      this.hgLevel = s.level;
      const f = hourglassFrame(s.ratio);
      if (f !== this.hgFrame) {
        this.hgFrame = f;
        this.hgIcon.setFrame(f);
      }
      const sig = s.level === 'empty' ? 'e' : `s${s.seconds}`;
      if (sig !== this.hgSig) {
        this.hgSig = sig;
        this.hgText.setText(s.level === 'empty' ? t('hud.hourglass.empty') : t('hud.hourglass.sand', { seconds: s.seconds }));
        this.hgBarFill.setFillStyle(hourglassBarColor(s.level), 1);
        this.hgW = -1;
        const w = Math.max(this.hgBarW + 38, this.hgText.width + 44);
        this.puzBg.setSize(w + 8, 32 + 8);
      }
      const bw = hourglassBarWidth(s.ratio, this.hgBarW);
      if (bw !== this.hgW) {
        this.hgW = bw;
        this.hgBarFill.setSize(Math.max(0.001, bw), 8);
        this.hgBarFill.setVisible(bw > 0);
      }
      rowBottom = this.puzTop + 40;
    }
    this.puzBg.setVisible(any);

    const info = lanternHudInfo(lanternBearers(state, room), p.id);
    const showLan = info !== null && p.status === 'alive';
    if (showLan !== this.lanShown) {
      this.lanShown = showLan;
      this.lanIcon.setVisible(showLan);
      this.lanText.setVisible(showLan);
      this.lanBg.setVisible(showLan);
      this.lanSig = '';
    }
    if (showLan && info) {
      const sig = `${info.isBearer ? 'b' : 'f'}${info.bearerId}`;
      const y0 = any ? rowBottom + 6 : this.puzTop;
      if (sig !== this.lanSig || this.lanIcon.y !== y0) {
        this.lanSig = sig;
        const bearer = state.players[info.bearerId];
        const name = bearer ? t(CHARACTERS[bearer.characterId].nameKey) : '';
        this.lanText.setText(info.isBearer ? t('hud.lantern.bearer') : t('hud.lantern.follow', { name }));
        this.lanText.setColor(info.isBearer ? '#ffe9a8' : hex(PLAYER_COLORS[info.bearerId] ?? 0xffffff));
        this.lanIcon.setY(y0);
        this.lanText.setY(y0 + 12);
        const w = this.lanText.width + 24 + 18;
        this.lanBg.setPosition(this.puzRight + 4, y0 - 4).setSize(w, 32);
      }
      const lf = lanternFrame(a.timeMs);
      if (lf !== this.lanFrame) {
        this.lanFrame = lf;
        this.lanIcon.setFrame(lf);
      }
    }
  }

  /** Clignotement du bandeau de sablier quand il est presque vide / vide (à chaque frame : seulement l'opacité). */
  private blinkHourglass(timeMs: number): void {
    if (!this.hgShown) return;
    const al = hourglassBlinkAlpha(this.hgLevel, timeMs);
    this.hgIcon.setAlpha(al);
    this.hgBarFill.setAlpha(al);
    this.hgText.setAlpha(this.hgLevel === 'ok' ? 1 : 0.6 + 0.4 * al);
  }

  /** Jauge du spécial : remplissage, pulsation « PRÊT », flash au retour de la charge, texte (clé i18n). */
  private updateSpecial(p: PlayerState, a: PlayerHudUpdate): void {
    const st = specialStatus(p);
    if (!st.has) return;
    const vis = p.status !== 'down';
    this.spIcon.setVisible(vis);
    this.spBarBg.setVisible(vis);
    this.spBarFill.setVisible(vis);
    this.spText.setVisible(vis);
    if (!vis) return;
    if (st.ready && !this.spReadyPrev) this.spFlashMs = Math.max(this.spFlashMs, 650);
    this.spReadyPrev = st.ready;
    if (this.spFlashMs > 0) this.spFlashMs = Math.max(0, this.spFlashMs - a.dtMs);
    const flashing = this.spFlashMs > 0 && Math.floor(this.spFlashMs / 90) % 2 === 0;
    const pulse = specialPulse(a.timeMs);
    this.spBarFill.setSize(Math.max(1, Math.round(this.spBarW * st.ratio)), this.spBarFill.height);
    if (st.ready) {
      this.spBarFill.setFillStyle(flashing ? 0xffffff : mixHex(SPECIAL_READY_COLOR, 0xffffff, pulse * 0.7), 1);
      this.spBarBg.setStrokeStyle(2, mixHex(SPECIAL_READY_COLOR, 0xffffff, pulse), 1);
      this.spIcon.clearTint();
      this.spIcon.setAlpha(0.75 + 0.25 * pulse);
      if (flashing) this.spIcon.setTintFill(0xffffff);
    } else {
      this.spBarFill.setFillStyle(this.color, 1);
      this.spBarBg.setStrokeStyle(0, 0x000000, 0);
      this.spIcon.setTint(SPECIAL_CHARGING_TINT);
      this.spIcon.setAlpha(0.8);
    }
    // texte : seulement quand il change (re-rasterisation coûteuse) ; rappel du bouton relu toutes les secondes
    this.spHintAccumMs += a.dtMs;
    if (this.spHintAccumMs >= 1000) {
      this.spHintAccumMs = 0;
      this.spHint = this.env.specialHint ? this.env.specialHint(this.playerId) : '';
    }
    if (!this.spHint) this.spHint = specialHintLabel(undefined, undefined);
    const sig = st.ready ? `r|${this.spHint}` : `w|${st.secondsLeft}`;
    if (sig !== this.spSig) {
      this.spSig = sig;
      this.spText.setText(st.ready ? `${t('specialhud.ready')} [${this.spHint}]` : `${this.spName} ${t('specialhud.wait', { seconds: st.secondsLeft })}`);
      this.spText.setColor(st.ready ? hex(SPECIAL_READY_COLOR) : '#c8cde0');
    }
  }

  private updateArrows(state: GameState, a: PlayerHudUpdate): void {
    const { ctx } = this.env;
    const { x: vx, y: vy, w: vw, h: vh } = this.vp;
    const me = state.players[this.playerId];
    let n = 0;
    if (me) {
      for (let i = 0; i < state.players.length && n < this.arrows.length; i++) {
        const q = state.players[i];
        if (q.id === this.playerId || q.status !== 'down') continue;
        const e = edgeIndicator((q.pos.x - a.camCenter.x) * ctx.zoom, (q.pos.y - a.camCenter.y) * ctx.zoom, vw, vh, 22);
        if (!e.visible) continue;
        const arrow = this.arrows[n++];
        arrow.setVisible(true);
        arrow.setPosition(vx + e.x, vy + e.y);
        arrow.setRotation(e.angle - Math.PI / 2);
        arrow.setTint(PLAYER_COLORS[q.id]);
      }
    }
    for (; n < this.arrows.length; n++) this.arrows[n].setVisible(false);

    // flèches vers les derniers ennemis (≤ ENEMY_ARROW_MAX restants), seulement s'ils sont hors champ
    let k = 0;
    if (me && this.enemyLeft !== null && this.enemyLeft <= ENEMY_ARROW_MAX) {
      const targets = nearestEnemyPositions(state, a.camCenter, this.enemyArrows.length);
      for (let i = 0; i < targets.length && k < this.enemyArrows.length; i++) {
        const e = edgeIndicator((targets[i].x - a.camCenter.x) * ctx.zoom, (targets[i].y - a.camCenter.y) * ctx.zoom, vw, vh, 22);
        if (!e.visible) continue;
        const arrow = this.enemyArrows[k++];
        arrow.setVisible(true);
        arrow.setPosition(vx + e.x, vy + e.y);
        arrow.setRotation(e.angle - Math.PI / 2);
      }
    }
    for (; k < this.enemyArrows.length; k++) this.enemyArrows[k].setVisible(false);
  }

  destroy(): void {
    const all: Phaser.GameObjects.GameObject[] = [
      this.frameGfx, this.name, this.hp, ...this.hearts, ...this.keyIcons, this.objHeader, ...this.objIcons, ...this.objTexts, this.objBg,
      this.promptBg, this.promptText, this.signBg, this.signText, this.downOverlay, this.downIcon, this.downTitle, this.downSub,
      this.barBg, this.barFill, this.toastBg, this.toastText, ...this.arrows, ...this.enemyArrows, this.goalBg, this.goalHeader, ...this.goalIcons, ...this.goalTexts, this.torchIcon, this.torchBarBg, this.torchBarFill, this.spIcon, this.spBarBg, this.spBarFill, this.spText,
      this.puzBg, this.hgIcon, this.hgBarBg, this.hgBarFill, this.hgText, this.lanBg, this.lanIcon, this.lanText,
    ];
    for (const o of all) o.destroy();
    this.hearts.length = 0;
    this.keyIcons.length = 0;
    this.objIcons.length = 0;
    this.objTexts.length = 0;
    this.arrows.length = 0;
    this.enemyArrows.length = 0;
    this.goalIcons.length = 0;
    this.goalTexts.length = 0;
  }
}

// ───────────────────────────── Panneau d'équipe (3 joueurs) ─────────────────────────────

interface TeamRow {
  spIcon: Img;
  spBg: Rect;
  spFill: Rect;
  spW: number;
  /** Mini jauge de torche (salles sombres). */
  tIcon: Img;
  tBg: Rect;
  tFill: Rect;
  tW: number;
  tShown: boolean;
  tLvl: TorchLevel;
  tW0: number;
  tFrame: string;
  swatch: Rect;
  name: Text;
  state: Text;
  hearts: Img[];
  keys: Img[];
  obj: Text;
  frames: string[];
  sig: string;
}

/** Panneau d'équipe : 4ᵉ quadrant quand il n'y a que 3 joueurs (PV, état, objectif, clés de chaque joueur). */
export class TeamPanelHud {
  private readonly rows: TeamRow[] = [];
  private readonly title: Text;
  private readonly bg: Rect;
  private readonly roomText: Text;
  private refreshAccum = REFRESH_MS;
  private roomSig = '';

  constructor(
    private readonly env: HudEnv,
    private readonly panel: ScreenRect,
    players: readonly PlayerState[],
  ) {
    const { ctx } = env;
    const { x, y, w, h } = panel;
    this.bg = hudRect(ctx, x + w / 2, y + h / 2, w, h, 0x14121f, 1, HUD_DEPTH.bg - 1);
    this.title = hudText(ctx, x + 12, y + 8, t('hud.team'), { size: 15, color: 0xf0e2b0 });
    this.roomText = hudText(ctx, x + w - 12, y + 9, '', { size: 12, color: 0xb8c0d8, originX: 1, bold: false });
    const rowH = Math.floor((h - 34) / Math.max(1, players.length));
    players.forEach((p, i) => {
      const ry = y + 32 + i * rowH;
      const color = PLAYER_COLORS[p.id];
      const swatch = hudRect(ctx, x + 12, ry, 6, rowH - 8, color, 1, HUD_DEPTH.content);
      swatch.setOrigin(0, 0);
      const name = hudText(ctx, x + 26, ry - 2, t(CHARACTERS[p.characterId].nameKey), { size: 15, color });
      const state = hudText(ctx, x + w - 12, ry - 1, '', { size: 13, originX: 1, color: 0xffffff });
      const hearts: Img[] = [];
      const n = heartCount(p.maxHp);
      for (let k = 0; k < n; k++) hearts.push(hudIcon(ctx, x + 26 + k * 13, ry + 20, 'ui_heart_full', 1.5));
      const keys: Img[] = [];
      for (let k = 0; k < 3; k++) {
        const ic = hudIcon(ctx, x + 26 + k * 14, ry + 38, 'ui_key_0', 1.5);
        ic.setVisible(false);
        keys.push(ic);
      }
      const obj = hudText(ctx, x + 26 + 3 * 14 + 4, ry + 36, '', { size: 12, bold: false, wrap: w - 190 });
      // mini jauge de spécial (à droite de la ligne des cœurs)
      const spW = 64;
      const spX = x + w - 12 - spW;
      const spIcon = hudIcon(ctx, spX - 16, ry + 17, 'ui_special', 1.5);
      const spBg = hudRect(ctx, spX - 1, ry + 23, spW + 2, 8, 0x0b0912, 0.85);
      spBg.setOrigin(0, 0.5);
      const spFill = hudRect(ctx, spX, ry + 23, 1, 6, color, 1, HUD_DEPTH.content);
      spFill.setOrigin(0, 0.5);
      const hasSp = !!CHARACTERS[p.characterId].special;
      for (const o of [spIcon, spBg, spFill]) o.setVisible(hasSp);
      // mini jauge de torche (ligne des clés, à droite) : visible seulement dans une salle sombre
      const tW = spW;
      const tIcon = hudIcon(ctx, spX - 16, ry + 36, torchIconFrame(1), 1.5);
      const tBg = hudRect(ctx, spX - 1, ry + 42, tW + 2, 8, 0x0b0912, 0.85);
      tBg.setOrigin(0, 0.5);
      const tFill = hudRect(ctx, spX, ry + 42, tW, 6, torchBarColor('full'), 1, HUD_DEPTH.content);
      tFill.setOrigin(0, 0.5);
      for (const o of [tIcon, tBg, tFill]) o.setVisible(false);
      this.rows.push({ spIcon, spBg, spFill, spW, tIcon, tBg, tFill, tW, tShown: false, tLvl: 'full', tW0: -1, tFrame: '', swatch, name, state, hearts, keys, obj, frames: hearts.map(() => 'ui_heart_full'), sig: '' });
    });
  }

  retranslate(players: readonly PlayerState[]): void {
    this.title.setText(t('hud.team'));
    players.forEach((p, i) => this.rows[i]?.name.setText(t(CHARACTERS[p.characterId].nameKey)));
    for (const r of this.rows) r.sig = '';
    this.roomSig = '';
    this.refreshAccum = REFRESH_MS;
  }

  update(state: GameState, room: RoomDef, dtMs: number): void {
    this.refreshAccum += dtMs;
    if (this.refreshAccum < REFRESH_MS) return;
    this.refreshAccum = 0;
    const { level } = this.env;
    const idx = roomIndexOf(level, room.id);
    const roomStr = `${t(room.nameKey)} (${t('hud.room.number', { n: idx + 1, total: level.rooms.length })})`;
    if (roomStr !== this.roomSig) {
      this.roomSig = roomStr;
      this.roomText.setText(roomStr);
    }
    for (let i = 0; i < this.rows.length; i++) {
      const p = state.players[i];
      const row = this.rows[i];
      if (!p) continue;
      for (let k = 0; k < row.hearts.length; k++) {
        const f = heartFrame(k, Math.max(0, p.hp), HP_PER_HEART);
        if (f !== row.frames[k]) {
          row.hearts[k].setFrame(f);
          row.frames[k] = f;
        }
      }
      const sp = specialStatus(p);
      if (sp.has) {
        row.spFill.setSize(Math.max(1, Math.round(row.spW * sp.ratio)), 6);
        row.spFill.setFillStyle(sp.ready ? mixHex(SPECIAL_READY_COLOR, 0xffffff, specialPulse(state.timeMs) * 0.6) : PLAYER_COLORS[p.id], 1);
        row.spIcon.setTint(sp.ready ? 0xffffff : SPECIAL_CHARGING_TINT);
        if (sp.ready) row.spIcon.clearTint();
      }
      this.updateTorchRow(row, p, room, state.timeMs);
      const status = p.status === 'down' ? t('hud.down') : `${t('hud.hp')} ${Math.max(0, Math.ceil(p.hp))}/${p.maxHp}`;
      setTextIfChanged(row.state, status);
      row.state.setColor(p.status === 'down' ? '#ff6a6a' : '#ffffff');
      const keySlots: number[] = [];
      for (const id of p.keys) {
        const s = keyOwnerSlot(level, id);
        if (s !== undefined) keySlots.push(s);
      }
      for (let k = 0; k < row.keys.length; k++) {
        if (k < keySlots.length) row.keys[k].setFrame(uiKeyFrame(keySlots[k])).setVisible(true);
        else row.keys[k].setVisible(false);
      }
      const objStr = teamObjectiveText(state, level, p.id, room);
      setTextIfChanged(row.obj, objStr);
    }
  }

  /** Mini jauge de torche d'un joueur (visible seulement dans une salle sombre). */
  private updateTorchRow(row: TeamRow, p: PlayerState, room: RoomDef, timeMs: number): void {
    const show = showTorchHud(room);
    if (show !== row.tShown) {
      row.tShown = show;
      row.tW0 = -1;
      for (const o of [row.tIcon, row.tBg, row.tFill]) o.setVisible(show);
    }
    if (!show) return;
    const lvl = torchLevel(p.torchMs);
    if (lvl !== row.tLvl) {
      row.tLvl = lvl;
      row.tFill.setFillStyle(torchBarColor(lvl), 1);
    }
    const f = torchIconFrame(torchFraction(p.torchMs));
    if (f !== row.tFrame) {
      row.tFrame = f;
      row.tIcon.setFrame(f);
    }
    const w = torchBarWidth(p.torchMs, row.tW);
    if (w !== row.tW0) {
      row.tW0 = w;
      row.tFill.setSize(Math.max(0.001, w), row.tFill.height);
      row.tFill.setVisible(w > 0);
    }
    const al = torchBlinkAlpha(lvl, timeMs);
    row.tIcon.setAlpha(al);
    row.tFill.setAlpha(al);
  }

  destroy(): void {
    this.bg.destroy();
    this.title.destroy();
    this.roomText.destroy();
    for (const r of this.rows) {
      r.swatch.destroy();
      r.name.destroy();
      r.state.destroy();
      for (const h of r.hearts) h.destroy();
      for (const k of r.keys) k.destroy();
      r.obj.destroy();
      r.spIcon.destroy();
      r.spBg.destroy();
      r.spFill.destroy();
      r.tIcon.destroy();
      r.tBg.destroy();
      r.tFill.destroy();
    }
    this.rows.length = 0;
  }
}

// ───────────────────────────── Séparateurs ─────────────────────────────

/** Dessine les séparateurs nets de 4 px entre les vues (une seule fois, caméra d'interface). */
export function createSeparators(ctx: ViewContext, layout: SplitLayout): Phaser.GameObjects.Graphics {
  const g = ctx.scene.add.graphics();
  g.setDepth(HUD_DEPTH.bg + 5);
  ctx.rig.registerHud(g);
  g.fillStyle(SEPARATOR_COLOR, 1);
  for (const s of layout.separators) g.fillRect(s.x, s.y, s.w, s.h);
  return g;
}
