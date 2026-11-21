/**
 * Campagne complète : les 9 niveaux, dans l'ordre, une seule salle finale par niveau, conclusion du jeu au niveau 9
 * (les outros des niveaux 6, 7 et 8 ouvrent la suite et ne concluent pas), épilogue `story.end.*` présent en fr et en,
 * et bornes de progression (`isFinalVictory`, `nextAfterDialogue`) dérivées de `LEVELS.length`.
 */
import { describe, expect, it } from 'vitest';
import { getDictionary } from '../i18n/i18n';
import { isFinalVictory, nextAfterDialogue } from '../render/menuLogic';
import type { GameSession } from '../render/session';
import { LEVELS, getLevel, getLevelByIndex } from './index';

const fr = getDictionary('fr');
const en = getDictionary('en');

const outroText = (id: string, dict: Record<string, string>): string => {
  const level = getLevel(id);
  expect(level, id).toBeTruthy();
  return (level?.outro ?? []).map((l) => dict[l.textKey] ?? '').join(' ');
};

/** Marqueurs de la CONCLUSION de la saga (outro du niveau 9 seulement). */
const CONCLUSION_FR = /ne craindra plus ni l'ombre|dessert|aube se lève enfin/;
const CONCLUSION_EN = /fear neither shadow|dessert|dawn finally rises/i;

describe('campagne : 9 niveaux dans l\'ordre', () => {
  it('LEVELS contient level1 à level9, dans cet ordre, sans doublon', () => {
    expect(LEVELS.map((l) => l.id)).toEqual(['level1', 'level2', 'level3', 'level4', 'level5', 'level6', 'level7', 'level8', 'level9']);
    expect(new Set(LEVELS.map((l) => l.id)).size).toBe(9);
  });

  it('getLevel / getLevelByIndex retrouvent les niveaux 7, 8 et 9', () => {
    for (const [i, id] of [[6, 'level7'], [7, 'level8'], [8, 'level9']] as const) {
      expect(getLevel(id)).toBe(LEVELS[i]);
      expect(getLevelByIndex(i)?.id).toBe(id);
    }
    expect(getLevelByIndex(9)).toBeUndefined();
  });

  it('chaque niveau a UNE seule salle finale (la dernière, scellée pour les niveaux 7 à 9)', () => {
    for (const level of LEVELS) {
      const finals = level.rooms.filter((r) => r.exit.final === true);
      expect(finals, level.id).toHaveLength(1);
      expect(level.rooms[level.rooms.length - 1], level.id).toBe(finals[0]);
    }
    for (const id of ['level7', 'level8', 'level9']) {
      const last = getLevel(id)?.rooms.at(-1);
      expect(last?.exit.sealed, id).toBe(true);
    }
  });

  it('les trois niveaux ajoutés ont un thème propre, distinct de tous les autres niveaux', () => {
    expect(['level7', 'level8', 'level9'].map((id) => getLevel(id)?.theme)).toEqual(['tide', 'dawn', 'brass']);
    expect(new Set(LEVELS.map((l) => l.theme)).size).toBe(9);
  });
});

describe('campagne : récit et conclusion', () => {
  it('story.end.* existe en fr et en', () => {
    for (const k of ['story.end.title', 'story.end.congrats', 'story.end.line.1', 'story.end.line.2', 'story.end.line.3', 'story.end.line.4', 'story.end.thanks', 'story.end.tbc']) {
      expect(fr[k], `fr ${k}`).toBeTruthy();
      expect(en[k], `en ${k}`).toBeTruthy();
    }
  });

  it("l'épilogue est cohérent avec le dénouement au sommet du clocher : aucune trace de l'ancienne fin dans les profondeurs de l'abîme (fr et en)", () => {
    const lines = [1, 2, 3, 4];
    expect(fr['story.end.line.1']).toMatch(/clocher/);
    expect(en['story.end.line.1']).toMatch(/belfry/);
    expect(fr['story.end.line.2']).toMatch(/clocher/);
    expect(en['story.end.line.2']).toMatch(/belfry/);
    for (const i of lines) {
      expect(fr[`story.end.line.${i}`], `fr ligne ${i}`).not.toMatch(/profondeurs|ponts d'étoiles|abîme/);
      expect(en[`story.end.line.${i}`], `en ligne ${i}`).not.toMatch(/depths|bridges of stars|abyss/i);
    }
  });

  it("l'outro du niveau 9 contient la conclusion (fr et en)", () => {
    expect(outroText('level9', fr)).toMatch(CONCLUSION_FR);
    expect(outroText('level9', en)).toMatch(CONCLUSION_EN);
  });

  it("les outros des niveaux 6, 7 et 8 ne concluent pas la saga (fr et en)", () => {
    for (const id of ['level6', 'level7', 'level8']) {
      expect(outroText(id, fr), `${id} fr`).not.toMatch(CONCLUSION_FR);
      expect(outroText(id, en), `${id} en`).not.toMatch(CONCLUSION_EN);
    }
  });

  it("continuité : les outros 6 et 7 annoncent la suite (cloche, reflet, lueur)", () => {
    expect(outroText('level6', fr)).toMatch(/cloche|fragment manque/);
    expect(outroText('level7', fr)).toMatch(/reflet|lueur/);
  });
});

describe('campagne : progression dérivée de LEVELS.length', () => {
  const session = (levelIndex: number): GameSession => ({ levelIndex }) as unknown as GameSession;

  it("la victoire n'est finale qu'au niveau 9 (indice 8)", () => {
    for (let i = 0; i < LEVELS.length; i++) {
      expect(isFinalVictory(session(i), 'victory', LEVELS.length), `niveau ${i + 1}`).toBe(i === LEVELS.length - 1);
    }
  });

  it("l'outro d'un niveau mène à l'intro du suivant (6 → 7, 7 → 8, 8 → 9), celui du niveau 9 au résultat", () => {
    for (const i of [5, 6, 7]) {
      const r = nextAfterDialogue(session(i), 'outro', LEVELS.length);
      expect(r.to, `niveau ${i + 1}`).toBe('dialogue');
      if (r.to === 'dialogue') expect(r.session.levelIndex).toBe(i + 1);
    }
    const end = nextAfterDialogue(session(8), 'outro', LEVELS.length);
    expect(end.to).toBe('result');
    if (end.to === 'result') expect(end.session.levelIndex).toBe(8);
  });
});

describe("campagne : courbe d'ennemis des niveaux 4 à 9", () => {
  const total = (id: string, n: number): number => (getLevel(id)?.rooms ?? []).reduce((sum, r) => sum + r.enemies.filter((e) => (e.minPlayers ?? 1) <= n).length, 0);

  it.each(['level4', 'level5', 'level6', 'level7', 'level8', 'level9'])("%s : le nombre d'ennemis croît strictement de 1 à 4 joueurs, et le duo compte au moins 15 % de plus que le solo", (id) => {
    for (let n = 1; n < 4; n++) expect(total(id, n + 1), `${id} ${n + 1} joueurs`).toBeGreaterThan(total(id, n));
    expect(total(id, 2), `${id} : duo vs solo`).toBeGreaterThanOrEqual(Math.ceil(total(id, 1) * 1.15));
  });

  it('niveaux 7 et 9 : aucune salle ordinaire ne reste identique entre solo et duo (hors demi-boss / boss seuls)', () => {
    for (const id of ['level7', 'level9']) {
      const lv = getLevel(id);
      let flat = 0;
      for (const r of lv?.rooms ?? []) {
        const c1 = r.enemies.filter((e) => (e.minPlayers ?? 1) <= 1).length;
        const c2 = r.enemies.filter((e) => (e.minPlayers ?? 1) <= 2).length;
        if (c2 === c1) flat++;
      }
      expect(flat, `${id} : salles plates entre 1 et 2 joueurs`).toBe(0);
    }
  });
});

