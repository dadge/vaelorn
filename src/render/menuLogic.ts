/**
 * LOGIQUE PURE des scènes d'interface (menu, sélection de personnage, dialogues, résultats).
 *
 * Aucune dépendance à Phaser, au DOM ni à Math.random : tout est testable sous Node (voir menuLogic.test.ts).
 * Les scènes (MenuScene, CharacterSelectScene, DialogueScene, ResultScene, BootScene) ne contiennent que
 * du rendu et de l'entrée : les règles (unicité des personnages, construction de la session, enchaînement
 * des niveaux, paramètres d'URL de dev, formats d'affichage) vivent ici.
 *
 * Les fonctions « withXxx » / « moveCursor »… sont IMMUABLES : elles retournent de nouveaux objets.
 */
import { CHARACTERS, CHARACTER_IDS } from '../core/characters';
import { MAX_PLAYERS } from '../core/constants';
import type { CharacterDef, CharacterId, Difficulty, PlayerId, PlayerSetup } from '../core/types';
import { deviceFromId } from '../input/actions';
import type { DeviceAssignment, DeviceId } from '../input/actions';
import { inputManager } from '../input/InputManager';
import type { PlayerAssignment } from '../input/InputManager';
import { emptyStats, type GameSession } from './session';

/** Langues acceptées par le paramètre d'URL `lang` (miroir de i18n.Language, sans import runtime). */
export type UiLanguage = 'fr' | 'en';

// ───────────────────────────── Utilitaires numériques ─────────────────────────────

/** Entier borné dans [min, max] ; une valeur non finie retourne `fallback` (défaut `min`). */
export function clampInt(value: number, min: number, max: number, fallback: number = min): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

/** Indice replié dans [0, n) (n ≤ 0 → 0). Gère les négatifs. */
export function wrapIndex(index: number, n: number): number {
  if (!(n > 0)) return 0;
  return ((Math.floor(index) % n) + n) % n;
}

/** Fait avancer `value` de `delta` dans [min, max] avec repli (wrap) ou saturation. */
export function stepValue(value: number, delta: number, min: number, max: number, wrap = true): number {
  const next = value + delta;
  if (wrap) return min + wrapIndex(next - min, max - min + 1);
  return Math.max(min, Math.min(max, next));
}

// ───────────────────────────── Choix du menu → session ─────────────────────────────

/** Personnages proposés par défaut à J1..J4 (la famille, tous distincts). */
export const DEFAULT_CHARACTERS: readonly CharacterId[] = ['david', 'sandrine', 'romain', 'valentine'];

/** Choix faits dans le menu principal (JSON pur, mémorisé en localStorage). */
export interface MenuChoices {
  /** 1..4. */
  playerCount: number;
  /** Difficulté de J1..J4 (toujours 4 entrées ; seules les `playerCount` premières servent). */
  difficulties: Difficulty[];
  /** Niveau de départ, indice 0-based. */
  startLevel: number;
  /** Option « J1 à la manette » (utile à 2-4 joueurs). */
  player1Gamepad: boolean;
}

/** Choix par défaut : 1 joueur, difficulté normale partout, niveau 1. */
export function defaultMenuChoices(): MenuChoices {
  return { playerCount: 1, difficulties: [2, 2, 2, 2], startLevel: 0, player1Gamepad: false };
}

function asDifficulty(v: unknown, fallback: Difficulty = 2): Difficulty {
  return v === 1 || v === 2 || v === 3 ? v : fallback;
}

/** Nouveau nombre de joueurs (borné 1..4 ; les difficultés des autres joueurs sont conservées). */
export function withPlayerCount(choices: MenuChoices, n: number): MenuChoices {
  return { ...choices, difficulties: choices.difficulties.slice(), playerCount: clampInt(n, 1, MAX_PLAYERS, 1) };
}

/** Fait varier la difficulté d'un joueur (1→2→3→1…). Joueur hors plage : inchangé. */
export function withDifficulty(choices: MenuChoices, playerId: number, delta: number): MenuChoices {
  if (!Number.isInteger(playerId) || playerId < 0 || playerId >= MAX_PLAYERS) return choices;
  const difficulties = choices.difficulties.slice();
  difficulties[playerId] = stepValue(asDifficulty(difficulties[playerId]), delta, 1, 3, true) as Difficulty;
  return { ...choices, difficulties };
}

/** Fait varier le niveau de départ dans [0, levelCount) avec repli. */
export function withStartLevel(choices: MenuChoices, delta: number, levelCount: number): MenuChoices {
  const n = Math.max(1, Math.floor(levelCount));
  return { ...choices, startLevel: stepValue(clampInt(choices.startLevel, 0, n - 1, 0), delta, 0, n - 1, true) };
}

/** Bascule l'option « J1 à la manette ». */
export function withPlayer1Gamepad(choices: MenuChoices, enabled: boolean): MenuChoices {
  return { ...choices, player1Gamepad: enabled };
}

/**
 * Personnages par défaut pour `count` joueurs : on prend d'abord `preferred` (dans l'ordre, sans doublon,
 * valides), puis la famille, puis les autres personnages. Résultat : `count` identifiants TOUS DISTINCTS.
 */
export function pickDistinctCharacters(count: number, preferred: readonly (CharacterId | undefined)[] = []): CharacterId[] {
  const n = clampInt(count, 1, MAX_PLAYERS, 1);
  const out: (CharacterId | undefined)[] = Array.from({ length: n }, () => undefined);
  const used = new Set<CharacterId>();
  // Les préférés gardent leur position d'origine tant qu'ils sont valides et uniques.
  for (let i = 0; i < n; i++) {
    const p = preferred[i];
    if (p && CHARACTERS[p] && !used.has(p)) {
      used.add(p);
      out[i] = p;
    }
  }
  const pool: CharacterId[] = [...DEFAULT_CHARACTERS, ...CHARACTER_IDS];
  for (let i = 0; i < n; i++) {
    if (out[i] !== undefined) continue;
    // 8 personnages pour 4 joueurs max : un candidat libre existe toujours.
    const next = pool.find((id) => !used.has(id)) ?? CHARACTER_IDS[0];
    used.add(next);
    out[i] = next;
  }
  return out as CharacterId[];
}

/**
 * Construit une GameSession depuis les choix du menu. Les personnages sont ceux de `characters`
 * (complétés/dédoublonnés par `pickDistinctCharacters`) ; les statistiques sont remises à zéro.
 */
export function sessionFromChoices(
  choices: MenuChoices,
  characters: readonly (CharacterId | undefined)[] = [],
  levelCount = 3,
): GameSession {
  const playerCount = clampInt(choices.playerCount, 1, MAX_PLAYERS, 1);
  const chars = pickDistinctCharacters(playerCount, characters);
  const players: PlayerSetup[] = chars.map((characterId, i) => ({
    id: i as PlayerId,
    characterId,
    difficulty: asDifficulty(choices.difficulties[i]),
  }));
  return {
    playerCount,
    players,
    levelIndex: clampInt(choices.startLevel, 0, Math.max(0, levelCount - 1), 0),
    stats: emptyStats(playerCount),
  };
}

/** Restaure les choix du menu depuis une session précédente (retour au menu) ; sans session : défauts. */
export function choicesFromSession(session: GameSession | undefined | null, base: MenuChoices = defaultMenuChoices()): MenuChoices {
  if (!session) return base;
  const difficulties = base.difficulties.slice();
  for (const p of session.players) {
    if (p.id >= 0 && p.id < MAX_PLAYERS) difficulties[p.id] = asDifficulty(p.difficulty);
  }
  return {
    ...base,
    playerCount: clampInt(session.playerCount, 1, MAX_PLAYERS, 1),
    difficulties,
    startLevel: Math.max(0, Math.floor(session.levelIndex) || 0),
  };
}

/** Clé localStorage des choix du menu. */
export const MENU_CHOICES_STORAGE_KEY = 'vaelorn.menu.v1';

/** Sérialise les choix (JSON). */
export function serializeChoices(choices: MenuChoices): string {
  return JSON.stringify(choices);
}

/**
 * Relit des choix sérialisés. Valeur NON FIABLE (localStorage) : tout est validé/replié ;
 * un JSON illisible retourne `null`.
 */
export function parseChoices(raw: string | null | undefined, levelCount = 3): MenuChoices | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Record<string, unknown> | null;
    if (!o || typeof o !== 'object') return null;
    const base = defaultMenuChoices();
    const diffs = Array.isArray(o.difficulties) ? o.difficulties : [];
    return {
      playerCount: clampInt(Number(o.playerCount), 1, MAX_PLAYERS, base.playerCount),
      difficulties: base.difficulties.map((d, i) => asDifficulty(diffs[i], d)),
      startLevel: clampInt(Number(o.startLevel), 0, Math.max(0, levelCount - 1), 0),
      player1Gamepad: o.player1Gamepad === true,
    };
  } catch {
    return null;
  }
}

// ───────────────────────────── Sélection de personnage ─────────────────────────────

/** État de l'écran de sélection : un curseur et un drapeau « prêt » par joueur actif. */
export interface SelectState {
  cursors: CharacterId[];
  ready: boolean[];
}

/** Résultat d'une confirmation. `taken` : personnage déjà pris par `takenBy` (index joueur). */
export type ConfirmResult =
  | { result: 'ready'; state: SelectState; bumped: number[] }
  | { result: 'already'; state: SelectState }
  | { result: 'taken'; state: SelectState; takenBy: number };

/** Résultat d'une annulation : `menu` = quitter vers le menu, `unready` = reprise du choix, `none` = rien. */
export type CancelResult = { result: 'menu' | 'unready' | 'none'; state: SelectState };

/** État initial : curseurs sur les personnages de la session, personne n'est prêt. */
export function createSelectState(session: GameSession): SelectState {
  const cursors = pickDistinctCharacters(
    session.playerCount,
    session.players.map((p) => p.characterId),
  );
  return { cursors, ready: cursors.map(() => false) };
}

/** Index du joueur (≠ `except`) qui a VERROUILLÉ ce personnage, ou -1. */
export function takenBy(state: SelectState, characterId: CharacterId, except = -1): number {
  for (let i = 0; i < state.cursors.length; i++) {
    if (i !== except && state.ready[i] && state.cursors[i] === characterId) return i;
  }
  return -1;
}

/** true si le personnage est verrouillé par un autre joueur que `playerIndex`. */
export function isTaken(state: SelectState, characterId: CharacterId, playerIndex: number): boolean {
  return takenBy(state, characterId, playerIndex) >= 0;
}

/** Prochain personnage libre (pour `playerIndex`) à partir de `from` dans le sens `dir` (+1/-1), inclus si `includeStart`. */
function nextFree(state: SelectState, playerIndex: number, from: number, dir: 1 | -1, includeStart: boolean): number {
  const n = CHARACTER_IDS.length;
  for (let k = includeStart ? 0 : 1; k <= n; k++) {
    const idx = wrapIndex(from + dir * k, n);
    if (!isTaken(state, CHARACTER_IDS[idx], playerIndex)) return idx;
  }
  return wrapIndex(from, n);
}

/**
 * Déplace le curseur d'un joueur de `delta` crans (±1) en SAUTANT les personnages déjà verrouillés par les autres.
 * Sans effet si le joueur est prêt ou hors plage.
 */
export function moveCursor(state: SelectState, playerIndex: number, delta: number): SelectState {
  if (playerIndex < 0 || playerIndex >= state.cursors.length || state.ready[playerIndex]) return state;
  const dir: 1 | -1 = delta < 0 ? -1 : 1;
  const steps = Math.max(1, Math.abs(Math.trunc(delta)));
  let idx = CHARACTER_IDS.indexOf(state.cursors[playerIndex]);
  for (let s = 0; s < steps; s++) idx = nextFree(state, playerIndex, idx, dir, false);
  const cursors = state.cursors.slice();
  cursors[playerIndex] = CHARACTER_IDS[idx];
  return { cursors, ready: state.ready };
}

/**
 * Place directement le curseur d'un joueur (clic souris). Refuse (`taken`) un personnage verrouillé par un autre ;
 * sans effet si le joueur est prêt.
 */
export function setCursor(
  state: SelectState,
  playerIndex: number,
  characterId: CharacterId,
): { state: SelectState; ok: boolean; takenBy: number } {
  if (playerIndex < 0 || playerIndex >= state.cursors.length || state.ready[playerIndex]) return { state, ok: false, takenBy: -1 };
  const owner = takenBy(state, characterId, playerIndex);
  if (owner >= 0) return { state, ok: false, takenBy: owner };
  const cursors = state.cursors.slice();
  cursors[playerIndex] = characterId;
  return { state: { cursors, ready: state.ready }, ok: true, takenBy: -1 };
}

/** Déplace les curseurs des joueurs NON prêts qui se trouvent sur un personnage verrouillé par un autre. Retourne les joueurs déplacés. */
export function reconcileCursors(state: SelectState): { state: SelectState; bumped: number[] } {
  const cursors = state.cursors.slice();
  const bumped: number[] = [];
  for (let i = 0; i < cursors.length; i++) {
    if (state.ready[i]) continue;
    if (isTaken({ cursors, ready: state.ready }, cursors[i], i)) {
      const idx = nextFree({ cursors, ready: state.ready }, i, CHARACTER_IDS.indexOf(cursors[i]), 1, false);
      cursors[i] = CHARACTER_IDS[idx];
      bumped.push(i);
    }
  }
  return { state: { cursors, ready: state.ready }, bumped };
}

/** Confirme (verrouille) le personnage du curseur. Refus si déjà pris. Les autres curseurs en conflit sont déplacés. */
export function confirmSelection(state: SelectState, playerIndex: number): ConfirmResult {
  if (playerIndex < 0 || playerIndex >= state.cursors.length || state.ready[playerIndex]) return { result: 'already', state };
  const owner = takenBy(state, state.cursors[playerIndex], playerIndex);
  if (owner >= 0) return { result: 'taken', state, takenBy: owner };
  const ready = state.ready.slice();
  ready[playerIndex] = true;
  const { state: next, bumped } = reconcileCursors({ cursors: state.cursors, ready });
  return { result: 'ready', state: next, bumped };
}

/**
 * Annule : un joueur prêt redevient libre ; un joueur non prêt demande le retour au menu
 * UNIQUEMENT si personne n'est prêt (évite qu'un appui accidentel de B ne fasse quitter les autres).
 */
export function cancelSelection(state: SelectState, playerIndex: number): CancelResult {
  if (playerIndex < 0 || playerIndex >= state.cursors.length) return { result: 'none', state };
  if (state.ready[playerIndex]) {
    const ready = state.ready.slice();
    ready[playerIndex] = false;
    return { result: 'unready', state: { cursors: state.cursors, ready } };
  }
  if (!state.ready.some(Boolean)) return { result: 'menu', state };
  return { result: 'none', state };
}

/** Bascule prêt/pas prêt (clic sur le bouton « Prêt »). */
export function toggleReady(state: SelectState, playerIndex: number): ConfirmResult | CancelResult {
  return state.ready[playerIndex] ? cancelSelection(state, playerIndex) : confirmSelection(state, playerIndex);
}

/** true si TOUS les joueurs sont prêts (et qu'il y en a au moins un). */
export function allReady(state: SelectState): boolean {
  return state.ready.length > 0 && state.ready.every(Boolean);
}

/** true si les personnages choisis sont tous distincts. */
export function hasUniqueCharacters(state: SelectState): boolean {
  return new Set(state.cursors).size === state.cursors.length;
}

/** Applique la sélection à la session (copie) : personnage de chaque joueur = son curseur. */
export function applySelection(session: GameSession, state: SelectState): GameSession {
  const players: PlayerSetup[] = session.players.map((p, i) => ({ ...p, characterId: state.cursors[i] ?? p.characterId }));
  return { ...session, players };
}

// ───────────────────────────── Statistiques affichées ─────────────────────────────

/** Convertit une vitesse (px/s) en note 1..10 pour la barre « Vitesse ». */
export function speedRating(speed: number): number {
  return clampInt(Math.round((speed - 40) / 7), 1, 10, 1);
}

/** Convertit le multiplicateur de durée de relevage en note 1..10 (1 → 5, 0.65 → 8). */
export function reviveRating(reviveTimeMult: number): number {
  if (!(reviveTimeMult > 0)) return 1;
  return clampInt(Math.round(5 / reviveTimeMult), 1, 10, 5);
}

/** Notes 1..10 des quatre barres de l'écran de sélection. */
export interface StatRatings {
  strength: number;
  resistance: number;
  speed: number;
  revive: number;
}

export function statRatings(def: Pick<CharacterDef, 'strength' | 'resistance' | 'speed' | 'reviveTimeMult'>): StatRatings {
  return {
    strength: clampInt(def.strength, 1, 10, 1),
    resistance: clampInt(def.resistance, 1, 10, 1),
    speed: speedRating(def.speed),
    revive: reviveRating(def.reviveTimeMult),
  };
}

// ───────────────────────────── Entrées : libellés ─────────────────────────────

/** Description d'une attribution d'entrée, sous forme de clés i18n (la scène appelle `t`). */
export interface AssignmentView {
  /** Clé i18n du libellé de l'entrée. */
  labelKey: string;
  labelParams?: { n: number };
  /** true si le périphérique est utilisable. */
  connected: boolean;
  /** Clé i18n d'avertissement (manette non détectée), sinon absente. */
  warnKey?: string;
  /** Clé i18n d'aide (comment brancher une manette), sinon absente. */
  hintKey?: string;
  /** Clé i18n d'information (manette non standard : mappage de repli), sinon absente. */
  infoKey?: string;
}

/**
 * Traduit une `PlayerAssignment` (InputManager.getAssignments) en clés d'affichage.
 * @param player1Gamepad option « J1 à la manette » (change le numéro de manette attendu : J1 → manette 1, sinon J2 → manette 1)
 */
export function describeAssignment(a: PlayerAssignment, player1Gamepad = false): AssignmentView {
  if (a.anyDevice) return { labelKey: 'select.input.anyDevice', connected: true };
  if (a.label === 'keyboard') return { labelKey: 'select.input.keyboard', connected: true };
  if (a.label === 'gamepad') {
    const n = a.gamepadIndex !== undefined ? a.gamepadIndex + 1 : Math.max(1, a.playerId + (player1Gamepad ? 1 : 0));
    const view: AssignmentView = { labelKey: 'select.input.gamepad', labelParams: { n }, connected: a.connected };
    if (a.nonStandard) view.infoKey = 'pad.nonStandard';
    if (!a.connected) {
      view.warnKey = 'select.input.gamepadMissing';
      view.hintKey = 'select.input.connectHint';
    }
    return view;
  }
  return { labelKey: 'select.input.keyboard', connected: a.connected };
}

// ───────────────────────────── Emplacements de joueurs (rejoindre par bouton) ─────────────────────────────

/**
 * Emplacements de joueurs de l'écran de sélection : `owners[i]` = identifiant du périphérique ('keyboard' |
 * 'gamepad:N') qui a RÉCLAMÉ l'emplacement i, ou null s'il est libre. Un périphérique = un emplacement.
 */
export interface SlotsState {
  owners: (DeviceId | null)[];
}

/** N emplacements libres (borné 1..4). */
export function createSlots(n: number): SlotsState {
  return { owners: Array.from({ length: clampInt(n, 1, MAX_PLAYERS, 1) }, () => null) };
}

/** Emplacement réclamé par ce périphérique, ou -1. */
export function slotOf(slots: SlotsState, device: DeviceId): number {
  return slots.owners.indexOf(device);
}

/** Résultat d'une réclamation : `claimed` (nouvel emplacement), `already` (déjà propriétaire), `full` (plus de place). */
export interface ClaimResult {
  result: 'claimed' | 'already' | 'full';
  slots: SlotsState;
  /** Emplacement du périphérique après l'opération (-1 si `full`). */
  slot: number;
}

/** Le périphérique réclame le PLUS PETIT emplacement libre (un périphérique = un emplacement). Immuable. */
export function claimSlot(slots: SlotsState, device: DeviceId): ClaimResult {
  const existing = slotOf(slots, device);
  if (existing >= 0) return { result: 'already', slots, slot: existing };
  const free = slots.owners.indexOf(null);
  if (free < 0) return { result: 'full', slots, slot: -1 };
  const owners = slots.owners.slice();
  owners[free] = device;
  return { result: 'claimed', slots: { owners }, slot: free };
}

/**
 * Réclame un emplacement PRÉCIS (clic souris sur un panneau libre). Refusé si le périphérique possède déjà un
 * emplacement, ou si l'emplacement est occupé / hors plage.
 */
export function claimSlotAt(slots: SlotsState, slot: number, device: DeviceId): ClaimResult {
  const existing = slotOf(slots, device);
  if (existing >= 0) return { result: 'already', slots, slot: existing };
  if (!Number.isInteger(slot) || slot < 0 || slot >= slots.owners.length || slots.owners[slot] !== null) {
    return { result: 'full', slots, slot: -1 };
  }
  const owners = slots.owners.slice();
  owners[slot] = device;
  return { result: 'claimed', slots: { owners }, slot };
}

/** Relâche l'emplacement du périphérique (sans effet s'il n'en possède pas). `slot` = emplacement libéré ou -1. */
export function releaseSlot(slots: SlotsState, device: DeviceId): { slots: SlotsState; slot: number } {
  const slot = slotOf(slots, device);
  if (slot < 0) return { slots, slot: -1 };
  const owners = slots.owners.slice();
  owners[slot] = null;
  return { slots: { owners }, slot };
}

/** true si les N emplacements sont tous réclamés. */
export function allClaimed(slots: SlotsState): boolean {
  return slots.owners.length > 0 && slots.owners.every((o) => o !== null);
}

/** Nombre d'emplacements réclamés. */
export function claimedCount(slots: SlotsState): number {
  return slots.owners.filter((o) => o !== null).length;
}

/**
 * Par emplacement : true si le propriétaire est une manette ABSENTE (débranchée / batterie vide) : l'emplacement est
 * « orphelin » et ne peut plus être libéré par son propriétaire.
 */
export function missingSlots(slots: SlotsState, pads: readonly PadInfo[]): boolean[] {
  return slots.owners.map((o) => o !== null && describeSlotDevice(o, pads).missing);
}

/**
 * Comme `claimSlot`, mais quand tout est pris, le périphérique récupère le premier emplacement dont le propriétaire
 * est une manette absente. `full` seulement s'il n'y a aucun emplacement libre NI orphelin. Immuable.
 */
export function stealMissingSlot(slots: SlotsState, device: DeviceId, pads: readonly PadInfo[]): ClaimResult {
  const direct = claimSlot(slots, device);
  if (direct.result !== 'full') return direct;
  const orphan = missingSlots(slots, pads).indexOf(true);
  if (orphan < 0) return direct;
  const owners = slots.owners.slice();
  owners[orphan] = device;
  return { result: 'claimed', slots: { owners }, slot: orphan };
}

/** Libère tous les emplacements orphelins (manette absente). `released` = indices libérés. Immuable. */
export function releaseMissingSlots(slots: SlotsState, pads: readonly PadInfo[]): { slots: SlotsState; released: number[] } {
  const missing = missingSlots(slots, pads);
  const released = missing.flatMap((m, i) => (m ? [i] : []));
  if (released.length === 0) return { slots, released };
  return { slots: { owners: slots.owners.map((o, i) => (missing[i] ? null : o)) }, released };
}

/** Appareils à assigner à l'InputManager, par emplacement (null = emplacement libre ou identifiant inconnu). */
export function slotsToDevices(slots: SlotsState): (DeviceAssignment | null)[] {
  return slots.owners.map((o) => (o === null ? null : deviceFromId(o)));
}

/** Périphérique de menu actif lors de l'appui sur « Jouer » (mémoire inter-scènes ; manette → réclame l'emplacement 1). */
let lastMenuDevice: DeviceId | null = null;

/** Mémorise le périphérique qui pilote le menu (null = oublier). */
export function setMenuDevice(device: DeviceId | null): void {
  lastMenuDevice = device;
}

/** Périphérique qui pilotait le menu principal (null si inconnu). */
export function getMenuDevice(): DeviceId | null {
  return lastMenuDevice;
}

/**
 * Nom de manette lisible et court : retire les parenthèses techniques (« (STANDARD GAMEPAD Vendor: 045e… ») et
 * tronque à `maxChars` avec « … ». Chaîne vide si aucun nom exploitable.
 */
export function shortPadName(raw: string | undefined | null, maxChars = 22): string {
  if (!raw) return '';
  let s = raw.replace(/\([^)]*\)/g, ' ').replace(/\b(vendor|product):\s*[0-9a-f]+/gi, ' ').replace(/\s+/g, ' ').trim();
  if (s === '') s = raw.replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
  const max = Math.max(4, Math.floor(maxChars));
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/** Manette connue de l'interface de sélection (instantané). */
export interface PadInfo {
  index: number;
  name: string;
  nonStandard?: boolean;
}

/** Clé i18n + paramètres d'affichage du périphérique d'un emplacement. */
export interface SlotDeviceView {
  labelKey: string;
  params?: Record<string, string | number>;
  /** true si l'emplacement est réclamé. */
  claimed: boolean;
  /** true si la manette du propriétaire est introuvable (débranchée). */
  missing: boolean;
  /** true si la manette est non standard (info UI). */
  nonStandard: boolean;
}

/**
 * Affichage du périphérique propriétaire d'un emplacement :
 *  - libre → `pad.slot.empty` (« Appuie sur A pour rejoindre ») ;
 *  - clavier → `pad.slot.keyboard` ; manette → `pad.slot.gamepad` « Manette {n} ({name}) » (ou `…gamepadNoName`).
 */
export function describeSlotDevice(owner: DeviceId | null, pads: readonly PadInfo[] = []): SlotDeviceView {
  const none = { claimed: false, missing: false, nonStandard: false };
  if (owner === null) return { labelKey: 'pad.slot.empty', ...none };
  const dev = deviceFromId(owner);
  if (!dev) return { labelKey: 'pad.slot.empty', ...none };
  if (dev.kind === 'keyboard') return { labelKey: 'pad.slot.keyboard', claimed: true, missing: false, nonStandard: false };
  const pad = pads.find((p) => p.index === dev.index);
  const name = shortPadName(pad?.name);
  return {
    labelKey: name ? 'pad.slot.gamepad' : 'pad.slot.gamepadNoName',
    params: name ? { n: dev.index + 1, name } : { n: dev.index + 1 },
    claimed: true,
    missing: !pad,
    nonStandard: !!pad?.nonStandard,
  };
}

// ───────────────────────────── Dialogues et enchaînement des niveaux ─────────────────────────────

/** Orateurs connus → type de portrait. Tout orateur inconnu est traité comme `narrator`. */
export type PortraitKind = 'aldric' | 'lyssa' | 'morvane' | 'gorgrim' | 'heroes' | 'narrator';

/** Type de portrait d'un orateur (identifiant `speaker.<id>`). */
export function portraitKindOf(speakerId: string): PortraitKind {
  switch (speakerId) {
    case 'aldric':
    case 'lyssa':
    case 'morvane':
    case 'gorgrim':
    case 'heroes':
      return speakerId;
    default:
      return 'narrator';
  }
}

/** Couleur (0xRRGGBB) du nom d'un orateur dans la boîte de dialogue. */
export function speakerColor(speakerId: string): number {
  // Boss des niveaux 4 à 6 : couleur propre au nom, portrait de narrateur (pas de portrait dédié pour l'instant).
  switch (speakerId) {
    case 'frostqueen':
      return 0x8fd8ff;
    case 'forgelord':
      return 0xff9a3c;
    case 'voidlord':
      return 0xb07cff;
    default:
      break;
  }
  switch (portraitKindOf(speakerId)) {
    case 'aldric':
      return 0xffd36b;
    case 'lyssa':
      return 0x7df9ff;
    case 'morvane':
      return 0xff5a7a;
    case 'gorgrim':
      return 0x9ad45a;
    case 'heroes':
      return 0xffffff;
    default:
      return 0xc8c2e8;
  }
}

/** Suite d'un dialogue : lancer le jeu, enchaîner l'intro du niveau suivant, ou afficher le résultat final. */
export type AfterDialogue =
  | { to: 'game'; session: GameSession }
  | { to: 'dialogue'; session: GameSession; stage: 'intro' }
  | { to: 'result'; session: GameSession; outcome: 'victory' };

/** Session passée au niveau suivant (copie ; `startRoomIndex` de dev supprimé, statistiques conservées). */
export function advanceLevel(session: GameSession): GameSession {
  const next: GameSession = { ...session, levelIndex: session.levelIndex + 1 };
  delete next.startRoomIndex;
  return next;
}

/**
 * Où aller à la fin d'un dialogue ?
 *  - intro → Game ;
 *  - outro → intro du niveau suivant (levelIndex + 1) s'il existe, sinon Result (victoire) ; levelIndex reste sur le dernier niveau.
 */
export function nextAfterDialogue(session: GameSession, stage: 'intro' | 'outro', levelCount: number): AfterDialogue {
  if (stage === 'intro') return { to: 'game', session };
  if (session.levelIndex + 1 < levelCount) return { to: 'dialogue', session: advanceLevel(session), stage: 'intro' };
  return { to: 'result', session, outcome: 'victory' };
}

// ───────────────────────────── Résultats ─────────────────────────────

/** Formate une durée : `m:ss` (minutes sur 2 chiffres), ou `h:mm:ss` à partir d'une heure. Négatif/NaN → 00:00. */
export function formatTime(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const two = (n: number): string => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${two(m)}:${two(s)}`;
}

/** Ligne de statistiques d'un joueur. */
export interface ResultRow {
  playerId: PlayerId;
  characterId: CharacterId;
  downs: number;
  kills: number;
}

function safeCount(v: number | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/** Une ligne par joueur de la session (valeurs manquantes ou invalides → 0). */
export function resultRows(session: GameSession): ResultRow[] {
  return session.players.map((p) => ({
    playerId: p.id,
    characterId: p.characterId,
    downs: safeCount(session.stats.downs[p.id]),
    kills: safeCount(session.stats.kills[p.id]),
  }));
}

/** Totaux d'équipe. */
export function resultTotals(rows: readonly ResultRow[]): { downs: number; kills: number } {
  return rows.reduce((acc, r) => ({ downs: acc.downs + r.downs, kills: acc.kills + r.kills }), { downs: 0, kills: 0 });
}

/**
 * Objectifs accomplis / total. `objectiveCounts[i]` = nombre d'objectifs du niveau i.
 * Victoire : tous les niveaux sont terminés (tout est accompli). Défaite : les niveaux AVANT le niveau courant seulement.
 */
export function objectivesSummary(
  session: Pick<GameSession, 'levelIndex'>,
  outcome: 'victory' | 'defeat',
  objectiveCounts: readonly number[],
): { done: number; total: number } {
  const total = objectiveCounts.reduce((a, b) => a + b, 0);
  if (outcome === 'victory') return { done: total, total };
  const done = objectiveCounts.slice(0, Math.max(0, session.levelIndex)).reduce((a, b) => a + b, 0);
  return { done, total };
}

/** La victoire affichée est-elle la fin de l'histoire (dernier niveau terminé) ? */
export function isFinalVictory(session: Pick<GameSession, 'levelIndex'>, outcome: 'victory' | 'defeat', levelCount: number): boolean {
  return outcome === 'victory' && session.levelIndex >= levelCount - 1;
}

/**
 * Session de « Rejouer » : mêmes joueurs/difficultés, statistiques remises à zéro.
 * Victoire → retour au niveau 1 ; défaite → on retente le niveau courant.
 */
export function replaySession(session: GameSession, outcome: 'victory' | 'defeat'): GameSession {
  const next: GameSession = {
    ...session,
    players: session.players.map((p) => ({ ...p })),
    levelIndex: outcome === 'victory' ? 0 : Math.max(0, session.levelIndex),
    stats: emptyStats(session.playerCount),
  };
  delete next.startRoomIndex;
  // Victoire : nouvelle partie complète, aucun niveau terminé ; défaite : on retente le niveau, la progression est conservée.
  if (outcome === 'victory') delete next.completedLevelIds;
  else if (session.completedLevelIds) next.completedLevelIds = session.completedLevelIds.slice();
  return next;
}

// ───────────────────────────── Paramètres d'URL (dev / tests automatiques) ─────────────────────────────

/** Résultat de l'analyse des paramètres d'URL. */
export interface QuickParams {
  /** true si `?quick=1` : saute Menu/CharacterSelect/Dialogue et lance Game directement. */
  quick: boolean;
  /** true si `?debug=1` (ou quick) : expose `window.__vaelorn`. */
  debug: boolean;
  /** Langue forcée par `?lang=fr|en`, sinon absente. */
  language?: UiLanguage;
  /** Option `?p1pad=1` : J1 à la manette. */
  player1Gamepad: boolean;
  /** Option `?pads=1` : tous les joueurs sur manettes 0..N-1 (attribution explicite). */
  pads: boolean;
  /** Option `?kb=n` : le joueur n (1-based) au clavier ; indice 0-based, ou null. Les autres joueurs prennent les manettes 0, 1, 2… */
  keyboardPlayer: number | null;
  /** Session construite depuis `players`, `chars`, `diff`, `level`, `room` (valable même si `quick` est faux). */
  session: GameSession;
}

function truthy(v: string | null): boolean {
  if (v === null) return false;
  const s = v.trim().toLowerCase();
  return s === '' ? true : s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

/**
 * Analyse `?quick=1&players=2&level=2&chars=david,sandrine&diff=1,2&lang=en&room=3&p1pad=1&debug=1`.
 *  - `players` : 1..4 (défaut : nombre de `chars` s'il y en a, sinon 1) ;
 *  - `chars` : identifiants séparés par des virgules (invalides/doublons ignorés, complétés par des personnages distincts) ;
 *  - `diff` : une valeur (pour tous) ou une liste par joueur (1..3, défaut 2) ;
 *  - `level` : 1-based (borné au nombre de niveaux) ; `room` : indice 0-based de la salle de départ ;
 *  - `lang` : `fr` ou `en` ;
 *  - `pads=1` : tous les joueurs sur manettes 0..N-1 ; `kb=n` : le joueur n (1..N) au clavier, les autres sur manettes 0.. .
 *    Sans `pads` ni `kb`, le comportement par défaut est conservé (J1 clavier, J2..J4 manettes 0..2).
 * Fonction pure : n'accède pas à `window`.
 */
export function parseQuickParams(search: string, levelCount = 3): QuickParams {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search);
  } catch {
    params = new URLSearchParams();
  }
  const quick = truthy(params.get('quick'));
  const debug = quick || truthy(params.get('debug'));

  const rawChars = (params.get('chars') ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  const validChars = rawChars.filter((s): s is CharacterId => (CHARACTER_IDS as readonly string[]).includes(s));
  const uniqueChars = validChars.filter((c, i) => validChars.indexOf(c) === i);

  const playersParam = params.get('players');
  const playerCount =
    playersParam !== null && playersParam.trim() !== ''
      ? clampInt(Number(playersParam), 1, MAX_PLAYERS, 1)
      : clampInt(uniqueChars.length || 1, 1, MAX_PLAYERS, 1);

  const diffList = (params.get('diff') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => asDifficulty(Number(s)));
  const difficulties: Difficulty[] = [0, 1, 2, 3].map((i) => (diffList.length === 1 ? diffList[0] : (diffList[i] ?? 2)));

  const levelParam = params.get('level');
  const startLevel = levelParam !== null ? clampInt(Number(levelParam) - 1, 0, Math.max(0, levelCount - 1), 0) : 0;

  const choices: MenuChoices = { playerCount, difficulties, startLevel, player1Gamepad: truthy(params.get('p1pad')) };
  const session = sessionFromChoices(choices, uniqueChars, levelCount);

  const roomParam = params.get('room');
  if (roomParam !== null && roomParam.trim() !== '' && Number.isFinite(Number(roomParam))) {
    session.startRoomIndex = Math.max(0, Math.floor(Number(roomParam)));
  }

  const lang = (params.get('lang') ?? '').trim().toLowerCase();
  const language: UiLanguage | undefined = lang === 'fr' || lang === 'en' ? lang : undefined;

  const kbRaw = params.get('kb');
  const kbNum = kbRaw !== null && kbRaw.trim() !== '' ? Number(kbRaw) : Number.NaN;
  const keyboardPlayer = Number.isInteger(kbNum) && kbNum >= 1 && kbNum <= playerCount ? kbNum - 1 : null;

  const out: QuickParams = {
    quick,
    debug,
    player1Gamepad: choices.player1Gamepad,
    pads: truthy(params.get('pads')),
    keyboardPlayer,
    session,
  };
  if (language) out.language = language;
  return out;
}

let currentQuickParams: QuickParams | null = null;

/**
 * Attribution d'appareils du démarrage rapide, par joueur ; `null` si ni `pads` ni `kb` (comportement par défaut).
 * `kb=n` : le joueur n au clavier, les autres sur les manettes 0, 1, 2… dans l'ordre ; sinon (`pads=1`) manette i pour le joueur i.
 */
export function quickDeviceAssignments(q: Pick<QuickParams, 'pads' | 'keyboardPlayer'> & { session: Pick<GameSession, 'playerCount'> }): DeviceAssignment[] | null {
  if (!q.pads && q.keyboardPlayer === null) return null;
  const out: DeviceAssignment[] = [];
  let pad = 0;
  for (let i = 0; i < q.session.playerCount; i++) {
    out.push(i === q.keyboardPlayer ? { kind: 'keyboard' } : { kind: 'gamepad', index: pad++ });
  }
  return out;
}

/** Applique `quickDeviceAssignments` à un gestionnaire d'entrées. Retourne true si une attribution a été faite. */
export function applyQuickDevices(
  q: Pick<QuickParams, 'pads' | 'keyboardPlayer'> & { session: Pick<GameSession, 'playerCount'> },
  target: { assignDevice(playerId: PlayerId, device: DeviceAssignment | null): void },
): boolean {
  const list = quickDeviceAssignments(q);
  if (!list) return false;
  list.forEach((d, i) => target.assignDevice(i as PlayerId, d));
  return true;
}

/**
 * Mémorise les paramètres d'URL analysés par main.ts (lus par BootScene). En démarrage rapide, applique aussi
 * `?pads=1` / `?kb=n` à l'InputManager (BootScene ne connaît pas ces options) ; sans ces options, rien ne change.
 */
export function setQuickParams(q: QuickParams | null): void {
  currentQuickParams = q;
  if (q?.quick) applyQuickDevices(q, inputManager);
}

/** Paramètres d'URL mémorisés (null hors démarrage rapide ou avant main.ts). */
export function getQuickParams(): QuickParams | null {
  return currentQuickParams;
}

// ───────────────────────────── Fond dégradé (bandes) ─────────────────────────────

/** Interpolation linéaire de deux couleurs 0xRRGGBB (t dans [0,1]). */
export function mixColor(a: number, b: number, t: number): number {
  const k = Math.max(0, Math.min(1, t));
  const ch = (shift: number): number => {
    const x = (a >> shift) & 255;
    const y = (b >> shift) & 255;
    return Math.round(x + (y - x) * k);
  };
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

/**
 * Couleurs de `count` bandes horizontales (de haut en bas) interpolées entre `top` et `bottom` :
 * le « dégradé » reste en aplats, fidèle au pixel art.
 */
export function skyBandColors(count: number, top: number, bottom: number): number[] {
  const n = Math.max(1, Math.floor(count));
  return Array.from({ length: n }, (_, i) => mixColor(top, bottom, n === 1 ? 0 : i / (n - 1)));
}

/** Hachage entier déterministe (étoiles, silhouettes) → [0, 1). */
export function hash01(a: number, b = 0, seed = 0): number {
  let h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263) + Math.imul(seed | 0, 2147483647)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
