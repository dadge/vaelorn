import { describe, expect, it } from 'vitest';
import { LIGHT_FULL_TILES } from '../core/constants';
import { collectRequiredI18nKeys, validateLevel } from '../core/levelValidation';
import { createSimulation } from '../core/simulation';
import { saveContextFromLevels } from '../core/save';
import { getDictionary } from '../i18n/i18n';
import { isSavingAllowed } from '../render/saveMenuLogic';
import { LEVELS, getLevel, getLevelByIndex } from './index';
import { TUTORIAL_LANE_ROW, TUTORIAL_LEVEL_ID, TUTORIAL_SEED, tutorialLevel } from './tutorial';

describe('niveau-tutoriel : données', () => {
  it('est valide pour 1, 2, 3 et 4 joueurs, fr et en, orateurs compris', () => {
    const errors = validateLevel(tutorialLevel, {
      dictionaries: { fr: getDictionary('fr') as Record<string, string>, en: getDictionary('en') as Record<string, string> },
      checkSpeakers: true,
    });
    expect(errors).toEqual([]);
  });

  it('a toutes ses clés i18n en fr et en', () => {
    for (const ref of collectRequiredI18nKeys(tutorialLevel, { checkSpeakers: true })) {
      expect(getDictionary('fr')[ref.key], `${ref.context} (fr)`).toBeTruthy();
      expect(getDictionary('en')[ref.key], `${ref.context} (en)`).toBeTruthy();
    }
  });

  it("n'est PAS dans la campagne : LEVELS inchangé (6 niveaux), introuvable par id et par indice", () => {
    expect(LEVELS.length).toBe(6);
    expect(getLevel(TUTORIAL_LEVEL_ID)).toBeUndefined();
    expect(LEVELS.some((l) => l.id === TUTORIAL_LEVEL_ID)).toBe(false);
    expect(getLevelByIndex(6)).toBeUndefined();
  });

  it("n'apparaît pas dans le contexte de sauvegarde de la campagne, et ne sauvegarde jamais", () => {
    const ctx = saveContextFromLevels(LEVELS);
    expect(ctx.levels.map((l) => l.id)).not.toContain(TUTORIAL_LEVEL_ID);
    expect(isSavingAllowed({ quick: false, search: '', tutorial: true })).toBe(false);
    expect(isSavingAllowed({ quick: false, search: '?tutorial=1' })).toBe(false);
    // la campagne normale, elle, sauvegarde toujours
    expect(isSavingAllowed({ quick: false, search: '' })).toBe(true);
  });

  it('a 7 salles, la dernière est finale, aucune n a de bandeau d indice (la carte du tutoriel en tient lieu)', () => {
    expect(tutorialLevel.rooms.map((r) => r.id)).toEqual(['t_yard', 't_workshop', 't_vault', 't_dark', 't_revive', 't_call', 't_seal']);
    expect(tutorialLevel.rooms[tutorialLevel.rooms.length - 1].exit.final).toBe(true);
    for (const r of tutorialLevel.rooms) expect(r.introHintKey).toBeUndefined();
  });

  it('le partenaire (spawn 1) est hors de la vue du joueur dans t_call (> 40 tuiles)', () => {
    const r = tutorialLevel.rooms.find((x) => x.id === 't_call')!;
    const [a, b] = [r.playerSpawns[0], r.playerSpawns[1]];
    expect(Math.hypot(b[0] - a[0], b[1] - a[1])).toBeGreaterThan(40);
  });

  it('chaque salle a un mécanisme présent dès 1 joueur et tous les spawns sont éclairés dans la salle sombre', () => {
    for (const r of tutorialLevel.rooms) {
      expect(r.mechanisms.some((m) => (m.minPlayers ?? 1) <= 1), r.id).toBe(true);
    }
    const dark = tutorialLevel.rooms.find((r) => r.dark)!;
    const lights = [
      ...dark.mechanisms.filter((m) => m.type === 'brazier' && m.lit).map((m) => (m as { tile: [number, number] }).tile),
      ...(dark.decor ?? []).filter((d) => d.type === 'torch').map((d) => d.tile),
    ];
    for (const sp of dark.playerSpawns) expect(lights.some((l) => Math.hypot(l[0] - sp[0], l[1] - sp[1]) <= LIGHT_FULL_TILES)).toBe(true);
  });

  it('couvre les 4 slots d objectifs : 0 et 2 pour le joueur, 1 et 3 pour le partenaire (2 joueurs)', () => {
    const sim = createSimulation({ levelId: tutorialLevel.id, players: [{ id: 0, characterId: 'david', difficulty: 1 }, { id: 1, characterId: 'sandrine', difficulty: 1 }], seed: TUTORIAL_SEED }, tutorialLevel);
    const owners = Object.fromEntries(sim.state.objectives.map((o) => [o.id, o.ownerId]));
    expect(owners).toEqual({ o_kills: 0, o_lever: 1, o_key: 0, o_zone: 1 });
  });

  it('les cibles du partenaire sont alignées sur la rangée 6 : sorties et plaques', () => {
    for (const r of tutorialLevel.rooms) {
      expect(r.exit.rect.y).toBeLessThanOrEqual(TUTORIAL_LANE_ROW);
      expect(r.exit.rect.y + r.exit.rect.h - 1).toBeGreaterThanOrEqual(TUTORIAL_LANE_ROW);
    }
  });

  it('démarrer à une salle k valide les salles précédentes et leurs objectifs', () => {
    const sim = createSimulation({ levelId: tutorialLevel.id, players: [{ id: 0, characterId: 'david', difficulty: 1 }, { id: 1, characterId: 'sandrine', difficulty: 1 }], seed: TUTORIAL_SEED, startRoomIndex: 3 }, tutorialLevel);
    expect(sim.state.roomIndex).toBe(3);
    expect(sim.state.clearedRooms).toEqual(['t_yard', 't_workshop', 't_vault']);
    expect(sim.state.objectives.filter((o) => o.done).map((o) => o.id).sort()).toEqual(['o_key', 'o_kills', 'o_lever']);
  });
});
