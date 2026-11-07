import { describe, expect, it } from 'vitest';
import { SAVE_ERROR_REASONS, SAVE_SCHEMA_VERSION, saveContextFromLevels, type SaveContext, type SaveGame } from '../core/save';
import type { SaveLoadResult } from '../core/saveRepository';
import { getDictionary } from '../i18n/i18n';
import { LEVELS } from '../levels';
import { DEFAULT_CHARACTERS, defaultMenuChoices, replaySession, sessionFromChoices } from './menuLogic';
import {
  choiceLabelKey,
  chooseInDialog,
  createResumeSelectState,
  eraseAction,
  errorReasonKey,
  hasStoredSave,
  isNoSaveRequested,
  isSavingAllowed,
  menuSaveState,
  newGameAction,
  openSaveDialog,
  resumeAutoClaimDevice,
  resumeDestination,
  saveDialogTexts,
  saveMenuLayout,
  sessionFromSave,
  stepSaveDialog,
  type MenuSaveState,
  type SaveDialog,
} from './saveMenuLogic';
import { moveCursor, cancelSelection, confirmSelection, allReady } from './menuLogic';

const CTX: SaveContext = {
  levels: [
    { id: 'level1', roomCount: 5 },
    { id: 'level2', roomCount: 6 },
  ],
};

const SAVE: SaveGame = {
  schemaVersion: SAVE_SCHEMA_VERSION,
  levelId: 'level2',
  roomIndex: 2,
  players: [
    { characterId: 'david', difficulty: 2 },
    { characterId: 'sandrine', difficulty: 1 },
  ],
  completedLevelIds: ['level1'],
};

const NONE: MenuSaveState = { kind: 'none' };
const VALID: MenuSaveState = menuSaveState({ status: 'ok', save: SAVE, migratedFrom: null }, CTX);
const CORRUPT: MenuSaveState = { kind: 'corrupt', error: { reason: 'invalidJson' } };
const UNAVAILABLE: MenuSaveState = { kind: 'unavailable' };

describe('état de la sauvegarde pour le menu', () => {
  it('menuSaveState : none / ok / corrupt / unavailable', () => {
    expect(menuSaveState({ status: 'none' }, CTX)).toEqual({ kind: 'none' });
    expect(VALID).toEqual({ kind: 'valid', save: SAVE, resume: { levelId: 'level2', level: 2, room: 3, roomCount: 6, playerCount: 2 } });
    const corrupt: SaveLoadResult = { status: 'corrupt', error: { reason: 'futureVersion' } };
    expect(menuSaveState(corrupt, CTX)).toEqual({ kind: 'corrupt', error: { reason: 'futureVersion' } });
    expect(menuSaveState({ status: 'unavailable', error: { code: 'quota', message: 'x' } }, CTX)).toEqual({ kind: 'unavailable' });
  });

  it('une sauvegarde valide dont le niveau a disparu du contexte devient « illisible » (jamais supprimée)', () => {
    const res = menuSaveState({ status: 'ok', save: { ...SAVE, levelId: 'level9' }, migratedFrom: null }, CTX);
    expect(res).toMatchObject({ kind: 'corrupt', error: { reason: 'unknownLevel' } });
  });

  it('« Continuer » n’est visible QUE s’il existe une sauvegarde valide', () => {
    expect(saveMenuLayout(NONE).showContinue).toBe(false);
    expect(saveMenuLayout(CORRUPT).showContinue).toBe(false);
    expect(saveMenuLayout(UNAVAILABLE).showContinue).toBe(false);
    expect(saveMenuLayout(VALID).showContinue).toBe(true);
  });

  it('libellé de la ligne de lancement : « Jouer » sans sauvegarde, « Nouvelle partie » sinon ; ligne par défaut', () => {
    expect(saveMenuLayout(NONE)).toMatchObject({ playLabelKey: 'menu.play', defaultRow: 'play', showErase: false, showCorruptRow: false });
    expect(saveMenuLayout(UNAVAILABLE)).toMatchObject({ playLabelKey: 'menu.play', defaultRow: 'play', showErase: false });
    expect(saveMenuLayout(VALID)).toMatchObject({ playLabelKey: 'save.newGame', defaultRow: 'continue', showErase: true, showCorruptRow: false });
    expect(saveMenuLayout(CORRUPT)).toMatchObject({ playLabelKey: 'save.newGame', defaultRow: 'corrupt', showErase: true, showCorruptRow: true });
  });

  it('« Nouvelle partie » : confirmation UNIQUEMENT s’il existe une sauvegarde (valide ou illisible)', () => {
    expect(newGameAction(NONE)).toBe('start');
    expect(newGameAction(UNAVAILABLE)).toBe('start');
    expect(newGameAction(VALID)).toBe('confirm');
    expect(newGameAction(CORRUPT)).toBe('confirm');
    expect(hasStoredSave(VALID)).toBe(true);
    expect(hasStoredSave(CORRUPT)).toBe(true);
    expect(hasStoredSave(NONE)).toBe(false);
  });

  it('« Effacer la sauvegarde » passe toujours par un dialogue (confirmation, ou décision si illisible)', () => {
    expect(eraseAction(VALID)).toBe('confirmErase');
    expect(eraseAction(CORRUPT)).toBe('corrupt');
    expect(eraseAction(NONE)).toBeNull();
    expect(eraseAction(UNAVAILABLE)).toBeNull();
  });
});

describe('dialogues : navigation clavier / manette, jamais de suppression sans confirmation', () => {
  it('le choix SÛR est présélectionné (annuler / conserver)', () => {
    for (const kind of ['confirmNewGame', 'confirmErase', 'corrupt', 'confirmReset'] as const) {
      const d = openSaveDialog(kind);
      expect(d.index).toBe(0);
      expect(['cancel', 'keep']).toContain(d.choices[0]);
    }
  });

  it('« Confirmer » (Entrée / A) sur le choix par défaut ne déclenche AUCUN effet destructeur', () => {
    for (const kind of ['confirmNewGame', 'confirmErase', 'confirmReset'] as const) {
      const step = stepSaveDialog(openSaveDialog(kind), 'confirm');
      expect(step.effect).toBeNull();
    }
    expect(stepSaveDialog(openSaveDialog('corrupt'), 'confirm')).toEqual({ dialog: null, effect: null });
  });

  it('nouvelle partie : se déplacer puis confirmer écrase ; annuler ou « retour » ne fait rien', () => {
    const d = openSaveDialog('confirmNewGame');
    const moved = stepSaveDialog(d, 'right');
    expect(moved.dialog?.index).toBe(1);
    expect(stepSaveDialog(moved.dialog as SaveDialog, 'confirm')).toEqual({ dialog: null, effect: 'startNewGame' });
    expect(stepSaveDialog(d, 'back')).toEqual({ dialog: null, effect: null });
    // retour depuis le choix « confirmer » valide quand même le choix SÛR
    expect(stepSaveDialog(moved.dialog as SaveDialog, 'back')).toEqual({ dialog: null, effect: null });
  });

  it('effacer la sauvegarde : confirmation explicite requise', () => {
    const d = openSaveDialog('confirmErase');
    const onConfirm = stepSaveDialog(stepSaveDialog(d, 'down').dialog as SaveDialog, 'confirm');
    expect(onConfirm).toEqual({ dialog: null, effect: 'eraseSave' });
    expect(stepSaveDialog(d, 'confirm').effect).toBeNull();
  });

  it('sauvegarde illisible : « conserver » ferme sans rien toucher ; « repartir de zéro » demande UNE confirmation de plus', () => {
    const d = openSaveDialog('corrupt');
    expect(d.choices).toEqual(['keep', 'reset']);
    expect(chooseInDialog(d, 'keep')).toEqual({ dialog: null, effect: null });
    const toReset = chooseInDialog(d, 'reset');
    expect(toReset.effect).toBeNull();
    expect(toReset.dialog?.kind).toBe('confirmReset');
    // refuser la confirmation revient à la décision (rien n'est supprimé)
    const back = stepSaveDialog(toReset.dialog as SaveDialog, 'back');
    expect(back.effect).toBeNull();
    expect(back.dialog?.kind).toBe('corrupt');
    // confirmer efface
    const yes = stepSaveDialog(stepSaveDialog(toReset.dialog as SaveDialog, 'right').dialog as SaveDialog, 'confirm');
    expect(yes).toEqual({ dialog: null, effect: 'eraseSave' });
  });

  it('haut / bas / gauche / droite : la sélection boucle', () => {
    let d: SaveDialog = openSaveDialog('confirmErase');
    d = stepSaveDialog(d, 'left').dialog as SaveDialog;
    expect(d.index).toBe(1);
    d = stepSaveDialog(d, 'up').dialog as SaveDialog;
    expect(d.index).toBe(0);
    d = stepSaveDialog(d, 'down').dialog as SaveDialog;
    expect(d.index).toBe(1);
    d = stepSaveDialog(d, 'right').dialog as SaveDialog;
    expect(d.index).toBe(0);
  });

  it('clic souris sur un choix : même résultat que le clavier', () => {
    const d = openSaveDialog('confirmNewGame');
    expect(chooseInDialog(d, 'confirm').effect).toBe('startNewGame');
    expect(chooseInDialog(d, 'cancel').effect).toBeNull();
  });
});

describe('textes (clés i18n) fr / en', () => {
  // Dictionnaires effectifs (fr.json + parts/*.json fusionnés par Vite/Vitest, ou fr.json seul après `npm run i18n:merge`).
  const dictFr = getDictionary('fr');
  const dictEn = getDictionary('en');
  const fr = Object.fromEntries(Object.entries(dictFr).filter(([k]) => k.startsWith('save.')));
  const en = Object.fromEntries(Object.entries(dictEn).filter(([k]) => k.startsWith('save.')));

  it('les textes de sauvegarde existent en fr ET en, avec les mêmes clés et placeholders, sans valeur vide', () => {
    const keys = Object.keys(fr);
    expect(keys.length).toBeGreaterThan(30);
    expect(Object.keys(en).sort()).toEqual(keys.slice().sort());
    for (const k of keys) {
      expect(fr[k].trim().length, k).toBeGreaterThan(0);
      expect(en[k].trim().length, k).toBeGreaterThan(0);
      const ph = (str: string): string[] => Array.from(str.matchAll(/\{(\w+)\}/g), (m) => m[1]).sort();
      expect(ph(en[k]), k).toEqual(ph(fr[k]));
    }
  });

  it('toutes les causes d’invalidité ont un message', () => {
    for (const reason of SAVE_ERROR_REASONS) {
      const key = errorReasonKey({ reason });
      expect(fr[key], key).toBeTruthy();
      expect(en[key], key).toBeTruthy();
    }
  });

  it('tous les dialogues et leurs boutons ont un titre, un message et des libellés', () => {
    const states: MenuSaveState[] = [VALID, CORRUPT];
    for (const kind of ['confirmNewGame', 'confirmErase', 'corrupt', 'confirmReset'] as const) {
      for (const state of states) {
        const texts = saveDialogTexts(openSaveDialog(kind), state);
        for (const key of [texts.titleKey, texts.messageKey, ...texts.choiceKeys]) {
          expect(dictFr[key], key).toBeTruthy();
          expect(dictEn[key], key).toBeTruthy();
        }
      }
    }
    expect(choiceLabelKey('confirmNewGame', 'confirm')).toBe('save.newGame.confirm.yes');
    expect(choiceLabelKey('confirmErase', 'confirm')).toBe('save.erase.confirm.yes');
  });

  it('le message de nouvelle partie diffère si la sauvegarde est illisible', () => {
    const d = openSaveDialog('confirmNewGame');
    expect(saveDialogTexts(d, VALID).messageKey).toBe('save.newGame.confirm.message');
    expect(saveDialogTexts(d, CORRUPT).messageKey).toBe('save.newGame.confirm.messageCorrupt');
  });

  it('libellé de reprise : « Niveau X — Salle Y » / « Level X — Room Y »', () => {
    expect(fr['save.resume'].replace('{level}', '2').replace('{room}', '3')).toBe('Niveau 2 — Salle 3');
    expect(en['save.resume'].replace('{level}', '2').replace('{room}', '3')).toBe('Level 2 — Room 3');
    expect(fr['save.continue']).toBe('Continuer');
    expect(fr['save.newGame']).toBe('Nouvelle partie');
    expect(fr['save.erase']).toBe('Effacer la sauvegarde');
  });
});

describe('reprise (Continuer)', () => {
  it('sessionFromSave : équipe figée, niveau, salle, niveaux terminés ; statistiques à zéro', () => {
    const s = sessionFromSave(SAVE, CTX);
    expect(s).not.toBeNull();
    expect(s).toMatchObject({
      playerCount: 2,
      levelIndex: 1,
      startRoomIndex: 2,
      completedLevelIds: ['level1'],
      players: [
        { id: 0, characterId: 'david', difficulty: 2 },
        { id: 1, characterId: 'sandrine', difficulty: 1 },
      ],
    });
    expect(s?.stats).toEqual({ timeMs: 0, downs: [0, 0], kills: [0, 0] });
    expect(sessionFromSave({ ...SAVE, levelId: 'inconnu' }, CTX)).toBeNull();
  });

  it('la session de reprise ne partage pas de tableau avec la sauvegarde', () => {
    const s = sessionFromSave(SAVE, CTX);
    s?.completedLevelIds?.push('x');
    expect(SAVE.completedLevelIds).toEqual(['level1']);
  });

  it('avec les vrais niveaux : levelIndex correspond à l’ordre de LEVELS', () => {
    const ctx = saveContextFromLevels(LEVELS);
    const s = sessionFromSave({ ...SAVE, levelId: LEVELS[LEVELS.length - 1].id, roomIndex: 0, completedLevelIds: [] }, ctx);
    expect(s?.levelIndex).toBe(LEVELS.length - 1);
  });

  it('introduction du niveau seulement si l’on reprend au début (salle 0), sinon directement le jeu', () => {
    expect(resumeDestination({ startRoomIndex: 0 })).toBe('dialogue');
    expect(resumeDestination({})).toBe('dialogue');
    expect(resumeDestination({ startRoomIndex: 3 })).toBe('game');
  });

  it('salle d’attente : personnages sauvegardés VERROUILLÉS (tous prêts), non modifiables ni annulables', () => {
    const session = sessionFromSave(SAVE, CTX);
    if (!session) throw new Error('session attendue');
    const st = createResumeSelectState(session);
    expect(st.cursors).toEqual(['david', 'sandrine']);
    expect(st.ready).toEqual([true, true]);
    expect(allReady(st)).toBe(true);
    // le curseur ne bouge pas, « confirmer » ne change rien
    expect(moveCursor(st, 0, 1)).toBe(st);
    expect(confirmSelection(st, 0).result).toBe('already');
  });

  it('salle d’attente : appareil auto-attribué à la place 1 = celui qui a validé « Continuer »', () => {
    expect(resumeAutoClaimDevice('keyboard')).toBe('keyboard');
    expect(resumeAutoClaimDevice('gamepad:2')).toBe('gamepad:2');
    expect(resumeAutoClaimDevice(null)).toBeNull(); // souris : chacun rejoint par un appui
    expect(resumeAutoClaimDevice('network:1')).toBeNull();
    // (cancelSelection est volontairement neutralisé côté scène en mode reprise)
    expect(cancelSelection(createResumeSelectState({ players: SAVE.players.map((p, i) => ({ id: i as 0 | 1, ...p })) }), 0).result).toBe('unready');
  });

  it('replaySession : une victoire repart de zéro (aucun niveau terminé), une défaite conserve la progression', () => {
    const base = sessionFromChoices({ ...defaultMenuChoices(), playerCount: 2 }, [...DEFAULT_CHARACTERS], 3);
    const session = { ...base, levelIndex: 2, startRoomIndex: 4, completedLevelIds: ['level1', 'level2'] };
    const victory = replaySession(session, 'victory');
    expect(victory.completedLevelIds).toBeUndefined();
    expect(victory.startRoomIndex).toBeUndefined();
    expect(victory.levelIndex).toBe(0);
    const defeat = replaySession(session, 'defeat');
    expect(defeat.completedLevelIds).toEqual(['level1', 'level2']);
    expect(defeat.completedLevelIds).not.toBe(session.completedLevelIds);
    expect(defeat.startRoomIndex).toBeUndefined();
  });
});

describe('sauvegarde autorisée ou non (mode quick, ?nosave=1, dev)', () => {
  it('?nosave=1 / true / sans valeur sont reconnus ; 0 et absence non', () => {
    expect(isNoSaveRequested('?nosave=1')).toBe(true);
    expect(isNoSaveRequested('?a=1&nosave=true')).toBe(true);
    expect(isNoSaveRequested('?nosave')).toBe(true);
    expect(isNoSaveRequested('?nosave=0')).toBe(false);
    expect(isNoSaveRequested('')).toBe(false);
  });

  it('le mode quick ne sauvegarde jamais ; ?nosave=1 non plus ; ?dark=1 (dev) non plus', () => {
    expect(isSavingAllowed({ quick: false, search: '' })).toBe(true);
    expect(isSavingAllowed({ quick: false, search: '?lang=en' })).toBe(true);
    expect(isSavingAllowed({ quick: true, search: '' })).toBe(false);
    expect(isSavingAllowed({ quick: true, search: '?quick=1&players=2&level=2&room=3' })).toBe(false);
    expect(isSavingAllowed({ quick: false, search: '?nosave=1' })).toBe(false);
    expect(isSavingAllowed({ quick: false, search: '?dark=1' })).toBe(false);
    expect(isSavingAllowed({ quick: false, search: '?dark=0' })).toBe(true);
    expect(isSavingAllowed({ quick: false, search: '?dev=statues' })).toBe(false);
  });
});
