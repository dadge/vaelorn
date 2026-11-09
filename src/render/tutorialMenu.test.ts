/** Entrée « Tutoriel » : session, paramètres d URL, absence de sauvegarde, campagne inchangée. */
import { describe, expect, it } from 'vitest';
import { LEVELS } from '../levels';
import { parseQuickParams, sessionForTutorial, sessionFromChoices, defaultMenuChoices } from './menuLogic';
import { isSavingAllowed } from './saveMenuLogic';

describe('sessionForTutorial', () => {
  it('1 joueur humain, difficulté facile, niveau 0, statistiques vides, marque `tutorial`', () => {
    const s = sessionForTutorial(['sandrine', 'david'], 'touch', 3);
    expect(s.playerCount).toBe(1);
    expect(s.players).toEqual([{ id: 0, characterId: 'sandrine', difficulty: 1 }]);
    expect(s.levelIndex).toBe(0);
    expect(s.tutorial).toEqual({ initialDevice: 'touch', campaignPlayers: 3 });
    expect(s.stats.kills).toEqual([0]);
    expect(s.completedLevelIds).toBeUndefined();
  });

  it('personnage par défaut sans choix mémorisé ; appareil facultatif ; JSON pur', () => {
    const s = sessionForTutorial();
    expect(s.players[0].characterId).toBe('david');
    expect(s.tutorial).toEqual({ campaignPlayers: 1 });
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });

  it('une partie normale n a pas de champ `tutorial`', () => {
    expect(sessionFromChoices(defaultMenuChoices(), [], LEVELS.length).tutorial).toBeUndefined();
  });
});

describe('paramètres d URL', () => {
  it('?tutorial=1 est reconnu (avec &room, &chars) ; absent par défaut', () => {
    expect(parseQuickParams('').tutorial).toBe(false);
    expect(parseQuickParams('?quick=1').tutorial).toBe(false);
    const q = parseQuickParams('?tutorial=1&room=3&chars=valentine&lang=en&touch=1');
    expect(q.tutorial).toBe(true);
    expect(q.quick).toBe(false);
    expect(q.session.startRoomIndex).toBe(3);
    expect(q.session.players[0].characterId).toBe('valentine');
    expect(q.language).toBe('en');
  });
});

describe('aucune sauvegarde', () => {
  it('isSavingAllowed refuse le tutoriel, par option ou par URL ; la campagne sauvegarde toujours', () => {
    expect(isSavingAllowed({ quick: false, search: '', tutorial: true })).toBe(false);
    expect(isSavingAllowed({ quick: false, search: '?tutorial=1' })).toBe(false);
    expect(isSavingAllowed({ quick: false, search: '?tutorial=0' })).toBe(true);
    expect(isSavingAllowed({ quick: false, search: '' })).toBe(true);
    expect(isSavingAllowed({ quick: true, search: '' })).toBe(false);
  });
});
