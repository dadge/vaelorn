/**
 * LOGIQUE PURE des écrans liés à la sauvegarde (menu principal, dialogues de confirmation, reprise).
 *
 * Aucune dépendance à Phaser/DOM : tout est testable sous Node (voir saveMenuLogic.test.ts). MenuScene et
 * CharacterSelectScene ne font que le rendu et l'entrée ; les règles (quand afficher « Continuer », quand demander une
 * confirmation, que faire d'une sauvegarde corrompue, construction de la session de reprise…) vivent ici.
 *
 * Règle d'or : AUCUNE donnée n'est supprimée sans confirmation explicite. Les dialogues proposent toujours en premier
 * (sélection par défaut) le choix SÛR (annuler / conserver).
 */
import type { MenuAction } from '../input/actions';
import { cloneGear } from '../core/gear';
import { playersOfSave, describeResume, type ResumeInfo, type SaveContext, type SaveGame, type SaveParseError } from '../core/save';
import type { SaveLoadResult } from '../core/saveRepository';
import { emptyStats, type GameSession } from './session';
import type { SelectState } from './menuLogic';

// ───────────────────────────── État de la sauvegarde vu par le menu ─────────────────────────────

/** État de la sauvegarde pour le menu. `corrupt` : donnée présente mais illisible (elle est CONSERVÉE). */
export type MenuSaveState =
  | { kind: 'none' }
  | { kind: 'valid'; save: SaveGame; resume: ResumeInfo }
  | { kind: 'corrupt'; error: SaveParseError }
  | { kind: 'unavailable' };

/** Convertit un résultat de `SaveRepository.load()` en état de menu. */
export function menuSaveState(result: SaveLoadResult, ctx: SaveContext): MenuSaveState {
  switch (result.status) {
    case 'none':
      return { kind: 'none' };
    case 'unavailable':
      return { kind: 'unavailable' };
    case 'corrupt':
      return { kind: 'corrupt', error: result.error };
    case 'ok': {
      const resume = describeResume(result.save, ctx);
      // Une sauvegarde valide dont le niveau a disparu du contexte est traitée comme illisible (jamais supprimée).
      return resume ? { kind: 'valid', save: result.save, resume } : { kind: 'corrupt', error: { reason: 'unknownLevel', field: 'levelId' } };
    }
  }
}

/** Une donnée existe-t-elle dans le stockage (valide OU corrompue) ? Alors « Nouvelle partie » doit demander confirmation. */
export function hasStoredSave(state: MenuSaveState): boolean {
  return state.kind === 'valid' || state.kind === 'corrupt';
}

/** « Nouvelle partie » : lancer directement, ou demander confirmation avant d'écraser une sauvegarde existante. */
export function newGameAction(state: MenuSaveState): 'start' | 'confirm' {
  return hasStoredSave(state) ? 'confirm' : 'start';
}

/** Lignes du menu principal liées à la sauvegarde. */
export interface SaveMenuLayout {
  /** « Continuer » : UNIQUEMENT si une sauvegarde valide existe. */
  showContinue: boolean;
  /** Ligne d'alerte « sauvegarde illisible » (ouvre le dialogue de décision). */
  showCorruptRow: boolean;
  /** « Effacer la sauvegarde » (options) : sauvegarde valide ou corrompue. */
  showErase: boolean;
  /** Libellé de la ligne qui lance une partie : « Jouer » sans sauvegarde, « Nouvelle partie » sinon. */
  playLabelKey: 'menu.play' | 'save.newGame';
  /** Ligne sélectionnée à l'ouverture du menu. */
  defaultRow: 'continue' | 'corrupt' | 'play';
}

export function saveMenuLayout(state: MenuSaveState): SaveMenuLayout {
  const valid = state.kind === 'valid';
  const corrupt = state.kind === 'corrupt';
  return {
    showContinue: valid,
    showCorruptRow: corrupt,
    showErase: valid || corrupt,
    playLabelKey: valid || corrupt ? 'save.newGame' : 'menu.play',
    defaultRow: valid ? 'continue' : corrupt ? 'corrupt' : 'play',
  };
}

/** Que fait « Effacer la sauvegarde » ? Sauvegarde valide → confirmation ; corrompue → dialogue de décision ; sinon rien. */
export function eraseAction(state: MenuSaveState): SaveDialogKind | null {
  if (state.kind === 'valid') return 'confirmErase';
  if (state.kind === 'corrupt') return 'corrupt';
  return null;
}

/** Clé i18n de la cause d'invalidité (`save.error.<reason>`). */
export function errorReasonKey(error: SaveParseError): string {
  return `save.error.${error.reason}`;
}

// ───────────────────────────── Dialogues ─────────────────────────────

export type SaveDialogKind = 'confirmNewGame' | 'confirmErase' | 'corrupt' | 'confirmReset';
export type SaveDialogChoice = 'cancel' | 'confirm' | 'keep' | 'reset';

/** État d'un dialogue modal : choix proposés (le PREMIER est le choix sûr) et choix sélectionné. */
export interface SaveDialog {
  kind: SaveDialogKind;
  choices: readonly SaveDialogChoice[];
  index: number;
}

/** Effet à exécuter par la scène (le seul qui modifie des données ou lance une partie). */
export type SaveDialogEffect = 'startNewGame' | 'eraseSave';

/** Résultat d'une interaction : nouveau dialogue (null = fermé) et effet éventuel. */
export interface SaveDialogStep {
  dialog: SaveDialog | null;
  effect: SaveDialogEffect | null;
}

const DIALOG_CHOICES: Readonly<Record<SaveDialogKind, readonly SaveDialogChoice[]>> = {
  confirmNewGame: ['cancel', 'confirm'],
  confirmErase: ['cancel', 'confirm'],
  corrupt: ['keep', 'reset'],
  confirmReset: ['cancel', 'confirm'],
};

/** Ouvre un dialogue, avec le choix SÛR (annuler / conserver) présélectionné. */
export function openSaveDialog(kind: SaveDialogKind): SaveDialog {
  return { kind, choices: DIALOG_CHOICES[kind], index: 0 };
}

/** Clés i18n (titre, message, libellé de chaque choix) d'un dialogue. */
export interface SaveDialogTexts {
  titleKey: string;
  messageKey: string;
  choiceKeys: string[];
}

export function saveDialogTexts(dialog: SaveDialog, state: MenuSaveState): SaveDialogTexts {
  const choiceKeys = dialog.choices.map((c) => choiceLabelKey(dialog.kind, c));
  switch (dialog.kind) {
    case 'confirmNewGame':
      return {
        titleKey: 'save.newGame.confirm.title',
        messageKey: state.kind === 'corrupt' ? 'save.newGame.confirm.messageCorrupt' : 'save.newGame.confirm.message',
        choiceKeys,
      };
    case 'confirmErase':
      return { titleKey: 'save.erase.confirm.title', messageKey: 'save.erase.confirm.message', choiceKeys };
    case 'corrupt':
      return { titleKey: 'save.corrupt.title', messageKey: 'save.corrupt.message', choiceKeys };
    case 'confirmReset':
      return { titleKey: 'save.reset.confirm.title', messageKey: 'save.reset.confirm.message', choiceKeys };
  }
}

/** Clé i18n du libellé d'un choix. */
export function choiceLabelKey(kind: SaveDialogKind, choice: SaveDialogChoice): string {
  switch (choice) {
    case 'cancel':
      return 'save.dialog.cancel';
    case 'keep':
      return 'save.corrupt.keep';
    case 'reset':
      return 'save.corrupt.reset';
    case 'confirm':
      return kind === 'confirmNewGame' ? 'save.newGame.confirm.yes' : 'save.erase.confirm.yes';
  }
}

/** Valide le choix `choice` du dialogue (clic souris ou confirmation clavier/manette). */
export function chooseInDialog(dialog: SaveDialog, choice: SaveDialogChoice): SaveDialogStep {
  switch (dialog.kind) {
    case 'confirmNewGame':
      return choice === 'confirm' ? { dialog: null, effect: 'startNewGame' } : { dialog: null, effect: null };
    case 'confirmErase':
      return choice === 'confirm' ? { dialog: null, effect: 'eraseSave' } : { dialog: null, effect: null };
    case 'corrupt':
      // « Conserver » ferme sans rien toucher ; « Repartir de zéro » demande encore une confirmation.
      return choice === 'reset' ? { dialog: openSaveDialog('confirmReset'), effect: null } : { dialog: null, effect: null };
    case 'confirmReset':
      return choice === 'confirm' ? { dialog: null, effect: 'eraseSave' } : { dialog: openSaveDialog('corrupt'), effect: null };
  }
}

/**
 * Interaction clavier / manette : haut/gauche et bas/droite déplacent la sélection (avec repli), « confirmer » valide le
 * choix sélectionné, « retour » valide le choix SÛR (le premier).
 */
export function stepSaveDialog(dialog: SaveDialog, action: MenuAction): SaveDialogStep {
  const n = dialog.choices.length;
  switch (action) {
    case 'up':
    case 'left':
      return { dialog: { ...dialog, index: (dialog.index + n - 1) % n }, effect: null };
    case 'down':
    case 'right':
      return { dialog: { ...dialog, index: (dialog.index + 1) % n }, effect: null };
    case 'confirm':
      return chooseInDialog(dialog, dialog.choices[dialog.index]);
    case 'back':
      return chooseInDialog(dialog, dialog.choices[0]);
  }
}

// ───────────────────────────── Reprise ─────────────────────────────

/**
 * Session de reprise : équipe, niveau et salle de la sauvegarde ; statistiques remises à zéro ; niveaux terminés reportés.
 * `startRoomIndex` est lu par GameScene (`SimConfig.startRoomIndex`). Niveau inconnu : null.
 */
export function sessionFromSave(save: SaveGame, ctx: SaveContext): GameSession | null {
  const levelIndex = ctx.levels.findIndex((l) => l.id === save.levelId);
  if (levelIndex < 0) return null;
  const players = playersOfSave(save);
  const session: GameSession = {
    playerCount: players.length,
    players,
    levelIndex,
    stats: emptyStats(players.length),
    startRoomIndex: save.roomIndex,
    completedLevelIds: save.completedLevelIds.slice(),
  };
  // « Continuer » restitue l'équipement sauvegardé (champ absent si personne n'en porte)
  if (save.players.some((p) => p.gear)) session.startGear = save.players.map((p) => (p.gear ? cloneGear(p.gear) : undefined));
  // idem pour le cœur rangé (emplacement cœur)
  if (save.players.some((p) => p.heart)) session.startHearts = save.players.map((p) => p.heart);
  return session;
}

/**
 * Après la salle d'attente de la reprise : dialogue d'introduction du niveau si on reprend en SALLE 0 (début de niveau),
 * directement le jeu sinon (on ne rejoue pas l'introduction au milieu d'un niveau).
 */
export function resumeDestination(session: Pick<GameSession, 'startRoomIndex'>): 'dialogue' | 'game' {
  return typeof session.startRoomIndex === 'number' && session.startRoomIndex > 0 ? 'game' : 'dialogue';
}

/** État de la salle d'attente de reprise : personnages sauvegardés, tous VERROUILLÉS (prêts) ; seuls les appareils se choisissent. */
export function createResumeSelectState(session: Pick<GameSession, 'players'>): SelectState {
  return { cursors: session.players.map((p) => p.characterId), ready: session.players.map(() => true) };
}

/**
 * Périphérique à réclamer automatiquement à l'emplacement 1 de la salle d'attente de reprise : celui qui a validé
 * « Continuer » (clavier ou manette), ou null (souris : chacun rejoint en appuyant sur un bouton).
 */
export function resumeAutoClaimDevice(menuSource: string | null): string | null {
  if (menuSource === 'keyboard') return 'keyboard';
  return menuSource !== null && menuSource.startsWith('gamepad:') ? menuSource : null;
}

// ───────────────────────────── Sauvegarde autorisée ? ─────────────────────────────

function truthy(v: string | null): boolean {
  if (v === null) return false;
  const s = v.trim().toLowerCase();
  return s === '' ? true : s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

/** `?nosave=1` (ou `true`/`yes`/`on`, ou sans valeur) présent dans la chaîne de requête ? */
export function isNoSaveRequested(search: string): boolean {
  try {
    return truthy(new URLSearchParams(search).get('nosave'));
  } catch {
    return false;
  }
}

/**
 * La partie en cours a-t-elle le droit d'écrire la sauvegarde ? NON pour : le démarrage rapide (`?quick=1`),
 * `?nosave=1`, les paramètres de dev qui modifient le jeu (`?dark=1`), le TUTORIEL (`tutorial: true` ou `?tutorial=1`) et la DÉMO
 * (`demo: true`, mode « attract »). Ces parties
 * ne touchent JAMAIS à la vraie sauvegarde.
 */
export function isSavingAllowed(opts: { quick: boolean; search: string; tutorial?: boolean; demo?: boolean }): boolean {
  if (opts.quick) return false;
  if (opts.tutorial === true) return false;
  if (opts.demo === true) return false;
  if (isNoSaveRequested(opts.search)) return false;
  try {
    const params = new URLSearchParams(opts.search);
    if (truthy(params.get('dark'))) return false;
    if (truthy(params.get('tutorial'))) return false;
    // Salles de test de dev (?dev=statues|hourglass|bridge|bosses) : jamais de sauvegarde.
    if (params.get('dev')) return false;
  } catch {
    /* chaîne de requête illisible : on ne dit rien de plus */
  }
  return true;
}
