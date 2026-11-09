/**
 * Couverture : TOUTES les salles des 6 niveaux, pour 1, 2, 3 et 4 joueurs, en français ET en anglais.
 * Chaque salle doit annoncer un objectif de salle lisible (au moins une ligne non vide), sans clé i18n brute, sans
 * placeholder oublié, sans plantage (jetons d'exigence inconnus compris), et le bloc des objectifs personnels ne doit
 * jamais produire d'en-tête orphelin « x/y ».
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { CHARACTERS } from '../core/characters';
import { createSimulation, type GameSimulation } from '../core/simulation';
import type { LevelDef, PlayerId, PlayerSetup, RoomDef } from '../core/types';
import { LEVELS } from '../levels';
import { getDictionary, hasKey, resetI18nStateForTests, setLanguage, type Language } from '../i18n/i18n';
import {
  MAX_GOAL_LINES,
  MECHANISM_FALLBACK_KEYS,
  describePersonalObjectives,
  describeRoomGoals,
  goalLineText,
  objectiveLineText,
  teamObjectiveText,
  type GoalLine,
} from './roomGoals';

const LANGS: readonly Language[] = ['fr', 'en'];
const COUNTS = [1, 2, 3, 4] as const;

const setups = (n: number): PlayerSetup[] =>
  (['david', 'sandrine', 'romain', 'valentine'] as const).slice(0, n).map((characterId, i) => ({ id: i as PlayerId, characterId, difficulty: 2 }));

function simAt(level: LevelDef, roomIndex: number, players: number): GameSimulation {
  return createSimulation({ levelId: level.id, players: setups(players), seed: 3, startRoomIndex: roomIndex }, level);
}

/** Une clé i18n brute (`goal.open`, `mech.level1.pA`…) ou un `{placeholder}` oublié a fui dans le texte affiché. */
const RAW_KEY = /\b(?:goal|mech|hud|objective|room|level|enemy|character|speaker|hint|game)\.[A-Za-z0-9_-]+/;
function expectReadable(text: string, where: string): void {
  expect(text.trim().length, `${where} : texte vide`).toBeGreaterThan(0);
  expect(text, `${where} : clé brute affichée`).not.toMatch(RAW_KEY);
  expect(text, `${where} : placeholder non résolu`).not.toMatch(/\{\w+\}/);
}

function expectGoals(lines: readonly GoalLine[], where: string): void {
  expect(lines.length, `${where} : aucune ligne d'objectif de salle`).toBeGreaterThanOrEqual(1);
  expect(lines.length, `${where} : trop de lignes`).toBeLessThanOrEqual(MAX_GOAL_LINES);
  for (const l of lines) {
    expectReadable(l.label, `${where} label`);
    expectReadable(goalLineText(l), `${where} texte`);
    expect(l.detail, `${where} détail`).not.toMatch(RAW_KEY);
  }
}

beforeAll(() => resetI18nStateForTests());
afterEach(() => setLanguage('en'));

describe('couverture des objectifs de salle : 6 niveaux × toutes les salles × 1-4 joueurs × fr/en', () => {
  it('les 6 niveaux sont couverts', () => {
    expect(LEVELS).toHaveLength(6);
    expect(LEVELS.reduce((n, l) => n + l.rooms.length, 0)).toBeGreaterThanOrEqual(30);
  });

  for (const level of LEVELS) {
    it(`${level.id} : chaque salle annonce un objectif lisible (état initial, tout accompli, sortie ouverte)`, () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        for (const lang of LANGS) {
          setLanguage(lang);
          for (const n of COUNTS) {
            level.rooms.forEach((room, i) => {
              const where = `${level.id}/${room.id}/${n}j/${lang}`;
              const sim = simAt(level, i, n);
              const st = sim.state;

              // 1. état initial : ce qu'il faut faire
              const first = describeRoomGoals(st, level, room);
              expectGoals(first, `${where} initial`);

              // 2. joueurs à terre, vagues en attente, objectifs accomplis : toujours lisible
              for (const o of st.objectives) o.done = true;
              st.players[0].status = 'down';
              expectGoals(describeRoomGoals(st, level, room), `${where} objectifs faits`);
              st.players[0].status = 'alive';

              // 3. tout satisfait : « Sortie ouverte »
              for (const e of st.room.enemies) e.dead = true;
              for (let k = 0; k < room.enemies.length; k++) if (!st.room.spawnedSpawnIdx.includes(k)) st.room.spawnedSpawnIdx.push(k);
              for (const m of st.room.mechanisms) m.active = true;
              const open = describeRoomGoals(st, level, room);
              expectGoals(open, `${where} ouvert`);
              expect(open.map((l) => l.kind), `${where} : sortie ouverte attendue`).toEqual(['exit']);
              expect(open[0].highlight).toBe(room.exit.requires.length > 0);
            });
          }
        }
        // aucune clé manquante signalée par t()
        const missing = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('[i18n]'));
        expect(missing, 'clés i18n manquantes').toEqual([]);
      } finally {
        warn.mockRestore();
      }
    });

    it(`${level.id} : objectifs personnels et panneau d'équipe lisibles, jamais d'en-tête orphelin`, () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        for (const lang of LANGS) {
          setLanguage(lang);
          for (const n of COUNTS) {
            level.rooms.forEach((room, i) => {
              const st = simAt(level, i, n).state;
              for (let pid = 0; pid < n; pid++) {
                const where = `${level.id}/${room.id}/${n}j/J${pid + 1}/${lang}`;
                const pv = describePersonalObjectives(st, level, pid as PlayerId, room);
                if (pv.lines.length === 0) expect(pv.header, `${where} : en-tête sans ligne`).toBe('');
                else {
                  expectReadable(pv.header, `${where} en-tête`);
                  expect(pv.header, `${where} : fraction orpheline`).not.toMatch(/^\d+\s*\/\s*\d+$/);
                  expect(pv.header, `${where} : fraction sans mot`).not.toMatch(/^[^\d]*\d+\/\d+\s*$/);
                }
                for (const l of pv.lines) expectReadable(objectiveLineText(l), `${where} ligne ${l.id}`);
                const team = teamObjectiveText(st, level, pid as PlayerId, room);
                if (team !== '') expectReadable(team, `${where} équipe`);
                expect(team, `${where} : fraction orpheline dans le panneau d'équipe`).not.toMatch(/^\d+\/\d+/);
              }
            });
          }
        }
        const missing = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('[i18n]'));
        expect(missing, 'clés i18n manquantes').toEqual([]);
      } finally {
        warn.mockRestore();
      }
    });
  }
});

describe('couverture i18n des libellés de mécanismes et d\'objectifs référencés par les sorties', () => {
  it('chaque mécanisme / objectif exigé par une sortie a un libellé (labelKey ou repli par type) en fr ET en', () => {
    const problems: string[] = [];
    for (const level of LEVELS) {
      const objIds = new Set(level.objectives.map((o) => o.id));
      for (const room of level.rooms) {
        for (const req of room.exit.requires) {
          if (req === 'clear') continue;
          if (req.startsWith('obj:')) {
            if (!objIds.has(req.slice(4))) problems.push(`${level.id}/${room.id} : objectif inconnu ${req}`);
            continue;
          }
          if (req.startsWith('zone:') || req.startsWith('enter:')) continue;
          const def = room.mechanisms.find((m) => m.id === req);
          if (!def) {
            problems.push(`${level.id}/${room.id} : mécanisme inconnu ${req}`);
            continue;
          }
          const key = def.labelKey ?? MECHANISM_FALLBACK_KEYS[def.type];
          for (const lang of LANGS) if (!hasKey(key, lang)) problems.push(`${level.id}/${room.id} : ${req} → clé ${key} absente (${lang})`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('toutes les clés goal.* et les nouvelles clés hud.objective.* existent en fr et en, avec les mêmes placeholders', () => {
    const fr = getDictionary('fr');
    const en = getDictionary('en');
    const keys = Object.keys(fr).filter((k) => k.startsWith('goal.') || /^hud\.objective\./.test(k));
    expect(keys.length).toBeGreaterThan(20);
    const ph = (v: string): string[] => Array.from(new Set(Array.from(v.matchAll(/\{(\w+)\}/g), (m) => m[1]))).sort();
    for (const k of keys) {
      expect(en[k], `en ${k}`).toBeTruthy();
      expect(ph(en[k]), `placeholders ${k}`).toEqual(ph(fr[k]));
    }
    for (const id of Object.keys(CHARACTERS)) expect(hasKey(CHARACTERS[id as keyof typeof CHARACTERS].nameKey, 'fr')).toBe(true);
  });

  it('un jeton inconnu dans une vraie salle ne plante pas', () => {
    const level = LEVELS[0];
    const base: RoomDef = level.rooms[0];
    const room: RoomDef = { ...base, exit: { ...base.exit, requires: ['???', 'obj:', 'zone:', 'enter:', 'clear', 'nope'] } };
    const sim = simAt(level, 0, 4);
    const lines = describeRoomGoals(sim.state, level, room);
    expectGoals(lines, 'jetons inconnus');
  });
});
