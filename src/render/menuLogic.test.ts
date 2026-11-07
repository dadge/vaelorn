import { describe, expect, it } from 'vitest';
import { CHARACTERS, CHARACTER_IDS } from '../core/characters';
import type { CharacterId, Difficulty } from '../core/types';
import { getDictionary } from '../i18n/i18n';
import type { PlayerAssignment } from '../input/InputManager';
import { LEVELS } from '../levels';
import {
  DEFAULT_CHARACTERS,
  advanceLevel,
  allReady,
  applySelection,
  cancelSelection,
  choicesFromSession,
  clampInt,
  confirmSelection,
  createSelectState,
  defaultMenuChoices,
  describeAssignment,
  formatTime,
  hash01,
  hasUniqueCharacters,
  isFinalVictory,
  isTaken,
  mixColor,
  moveCursor,
  nextAfterDialogue,
  objectivesSummary,
  parseChoices,
  parseQuickParams,
  pickDistinctCharacters,
  portraitKindOf,
  reconcileCursors,
  replaySession,
  resultRows,
  resultTotals,
  reviveRating,
  serializeChoices,
  sessionFromChoices,
  setCursor,
  skyBandColors,
  speakerColor,
  speedRating,
  statRatings,
  stepValue,
  takenBy,
  toggleReady,
  withDifficulty,
  withPlayer1Gamepad,
  withPlayerCount,
  withStartLevel,
  wrapIndex,
  type SelectState,
} from './menuLogic';
import { emptyStats, type GameSession } from './session';

function sessionOf(n: number, chars: CharacterId[] = [...DEFAULT_CHARACTERS]): GameSession {
  return sessionFromChoices({ ...defaultMenuChoices(), playerCount: n }, chars, 3);
}

describe('utilitaires numériques', () => {
  it('clampInt borne, tronque et gère les valeurs non finies', () => {
    expect(clampInt(5, 1, 4)).toBe(4);
    expect(clampInt(-3, 1, 4)).toBe(1);
    expect(clampInt(2.9, 1, 4)).toBe(2);
    expect(clampInt(Number.NaN, 1, 4)).toBe(1);
    expect(clampInt(Number.NaN, 1, 4, 3)).toBe(3);
    expect(clampInt(Infinity, 1, 4, 2)).toBe(2);
  });

  it('wrapIndex replie les négatifs et les dépassements', () => {
    expect(wrapIndex(-1, 8)).toBe(7);
    expect(wrapIndex(8, 8)).toBe(0);
    expect(wrapIndex(17, 8)).toBe(1);
    expect(wrapIndex(3, 0)).toBe(0);
  });

  it('stepValue : repli ou saturation', () => {
    expect(stepValue(3, 1, 1, 3, true)).toBe(1);
    expect(stepValue(1, -1, 1, 3, true)).toBe(3);
    expect(stepValue(3, 1, 1, 3, false)).toBe(3);
    expect(stepValue(1, -1, 1, 3, false)).toBe(1);
    expect(stepValue(2, 1, 1, 3, true)).toBe(3);
  });
});

describe('choix du menu → session', () => {
  it('pickDistinctCharacters : tous distincts, préférés conservés, famille d\'abord', () => {
    expect(pickDistinctCharacters(4)).toEqual(['david', 'sandrine', 'romain', 'valentine']);
    expect(pickDistinctCharacters(2, ['sandrine'])).toEqual(['sandrine', 'david']);
    // doublon : le second est remplacé
    const dup = pickDistinctCharacters(3, ['mira', 'mira', 'grok']);
    expect(new Set(dup).size).toBe(3);
    expect(dup[0]).toBe('mira');
    expect(dup[2]).toBe('grok');
    // valeur invalide ignorée
    const bad = pickDistinctCharacters(2, ['nope' as CharacterId, 'brokk']);
    expect(bad[1]).toBe('brokk');
    expect(CHARACTER_IDS).toContain(bad[0]);
    // bornes
    expect(pickDistinctCharacters(0)).toHaveLength(1);
    expect(pickDistinctCharacters(9)).toHaveLength(4);
  });

  it('withPlayerCount borne 1..4 et conserve les difficultés', () => {
    let c = defaultMenuChoices();
    c = withDifficulty(c, 3, 1); // J4 : normal → difficile
    c = withPlayerCount(c, 2);
    expect(c.playerCount).toBe(2);
    expect(c.difficulties[3]).toBe(3);
    expect(withPlayerCount(c, 9).playerCount).toBe(4);
    expect(withPlayerCount(c, 0).playerCount).toBe(1);
    expect(withPlayerCount(c, Number.NaN).playerCount).toBe(1);
  });

  it('withDifficulty cycle 1→2→3→1, par joueur, sans muter', () => {
    const c0 = defaultMenuChoices();
    const c1 = withDifficulty(c0, 0, 1);
    expect(c1.difficulties).toEqual([3, 2, 2, 2]);
    expect(c0.difficulties).toEqual([2, 2, 2, 2]);
    expect(withDifficulty(c1, 0, 1).difficulties[0]).toBe(1);
    expect(withDifficulty(c0, 1, -1).difficulties).toEqual([2, 1, 2, 2]);
    expect(withDifficulty(c0, 7, 1)).toBe(c0);
    expect(withDifficulty(c0, -1, 1)).toBe(c0);
  });

  it('withStartLevel replie dans [0, levelCount)', () => {
    const c = defaultMenuChoices();
    expect(withStartLevel(c, -1, 3).startLevel).toBe(2);
    expect(withStartLevel({ ...c, startLevel: 2 }, 1, 3).startLevel).toBe(0);
    expect(withStartLevel(c, 1, 3).startLevel).toBe(1);
    expect(withStartLevel(c, 1, 1).startLevel).toBe(0);
  });

  it('sessionFromChoices : joueurs 0..n-1, personnages uniques, difficultés par joueur, stats à zéro', () => {
    let c = withPlayerCount(defaultMenuChoices(), 3);
    c = withDifficulty(withDifficulty(c, 0, -1), 2, 1); // J1 facile (1), J3 difficile (3)
    c = withStartLevel(c, 1, 3);
    const s = sessionFromChoices(c, ['romain'], 3);
    expect(s.playerCount).toBe(3);
    expect(s.players.map((p) => p.id)).toEqual([0, 1, 2]);
    expect(s.players.map((p) => p.difficulty)).toEqual([1, 2, 3]);
    expect(s.players[0].characterId).toBe('romain');
    expect(new Set(s.players.map((p) => p.characterId)).size).toBe(3);
    expect(s.levelIndex).toBe(1);
    expect(s.stats).toEqual(emptyStats(3));
    expect(s.startRoomIndex).toBeUndefined();
    // JSON pur
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });

  it('sessionFromChoices borne le niveau de départ', () => {
    expect(sessionFromChoices({ ...defaultMenuChoices(), startLevel: 99 }, [], 3).levelIndex).toBe(2);
    expect(sessionFromChoices({ ...defaultMenuChoices(), startLevel: -4 }, [], 3).levelIndex).toBe(0);
  });

  it('choicesFromSession restaure joueurs, difficultés et niveau', () => {
    const s = sessionFromChoices(withDifficulty(withPlayerCount(defaultMenuChoices(), 2), 1, 1), ['mira', 'grok'], 3);
    s.levelIndex = 2;
    const c = choicesFromSession(s);
    expect(c.playerCount).toBe(2);
    expect(c.difficulties[1]).toBe(3);
    expect(c.startLevel).toBe(2);
    expect(choicesFromSession(undefined)).toEqual(defaultMenuChoices());
  });

  it('serializeChoices / parseChoices : aller-retour, et valeurs corrompues repliées', () => {
    let c = withPlayerCount(defaultMenuChoices(), 4);
    c = withPlayer1Gamepad(withStartLevel(withDifficulty(c, 2, -1), 1, 3), true);
    expect(parseChoices(serializeChoices(c), 3)).toEqual(c);
    expect(parseChoices(null)).toBeNull();
    expect(parseChoices('')).toBeNull();
    expect(parseChoices('{pas du json')).toBeNull();
    expect(parseChoices('42')).toBeNull();
    expect(parseChoices('null')).toBeNull();
    const wild = parseChoices('{"playerCount":99,"difficulties":[9,"x",1],"startLevel":-5,"player1Gamepad":"yes"}', 3);
    expect(wild).toEqual({ playerCount: 4, difficulties: [2, 2, 1, 2], startLevel: 0, player1Gamepad: false });
    const diffs: Difficulty[] = wild?.difficulties ?? [];
    expect(diffs.every((d) => d === 1 || d === 2 || d === 3)).toBe(true);
  });
});

describe('sélection de personnages (unicité)', () => {
  it('état initial : curseurs distincts, personne prêt', () => {
    const st = createSelectState(sessionOf(3));
    expect(st.cursors).toEqual(['david', 'sandrine', 'romain']);
    expect(st.ready).toEqual([false, false, false]);
    expect(allReady(st)).toBe(false);
    expect(hasUniqueCharacters(st)).toBe(true);
  });

  it('un personnage verrouillé est refusé aux autres (message via takenBy)', () => {
    let st = createSelectState(sessionOf(2));
    const c1 = confirmSelection(st, 0);
    expect(c1.result).toBe('ready');
    if (c1.result !== 'ready') return;
    st = c1.state;
    expect(takenBy(st, 'david')).toBe(0);
    expect(takenBy(st, 'david', 0)).toBe(-1);
    expect(isTaken(st, 'david', 1)).toBe(true);
    // J2 force son curseur sur david (souris) : refusé
    const forced = setCursor(st, 1, 'david');
    expect(forced.ok).toBe(false);
    expect(forced.takenBy).toBe(0);
    // confirmer avec un curseur sur un personnage pris : refusé
    const hacked: SelectState = { cursors: ['david', 'david'], ready: [true, false] };
    const refused = confirmSelection(hacked, 1);
    expect(refused.result).toBe('taken');
    if (refused.result === 'taken') expect(refused.takenBy).toBe(0);
  });

  it('moveCursor saute les personnages pris et boucle', () => {
    const st: SelectState = { cursors: ['sandrine', 'david'], ready: [false, true] };
    // J1 est sur sandrine ; reculer ne doit pas tomber sur david (pris)
    const back = moveCursor(st, 0, -1);
    expect(back.cursors[0]).toBe('mira'); // david sauté, wrap vers la fin
    const fwd = moveCursor(st, 0, 1);
    expect(fwd.cursors[0]).toBe('romain');
    // un joueur prêt ne bouge plus
    expect(moveCursor(st, 1, 1)).toBe(st);
    // hors plage
    expect(moveCursor(st, 5, 1)).toBe(st);
    // 8 pas = tour complet moins le personnage pris
    let cur = createSelectState(sessionOf(1));
    const seen = new Set<string>();
    for (let i = 0; i < 8; i++) {
      cur = moveCursor(cur, 0, 1);
      seen.add(cur.cursors[0]);
    }
    expect(seen.size).toBe(8);
  });

  it('confirmer déplace les curseurs des autres joueurs en conflit', () => {
    const st: SelectState = { cursors: ['david', 'david', 'romain'], ready: [false, false, false] };
    const r = confirmSelection(st, 0);
    expect(r.result).toBe('ready');
    if (r.result !== 'ready') return;
    expect(r.bumped).toEqual([1]);
    expect(r.state.cursors[1]).not.toBe('david');
    expect(r.state.cursors[2]).toBe('romain');
    expect(r.state.ready).toEqual([true, false, false]);
    expect(hasUniqueCharacters(r.state)).toBe(true);
    // reconcileCursors est idempotent
    expect(reconcileCursors(r.state).bumped).toEqual([]);
  });

  it('confirmer deux fois = déjà prêt', () => {
    const st = createSelectState(sessionOf(1));
    const r1 = confirmSelection(st, 0);
    if (r1.result !== 'ready') throw new Error('attendu ready');
    expect(confirmSelection(r1.state, 0).result).toBe('already');
  });

  it('annuler : prêt → libre ; non prêt → menu seulement si personne n\'est prêt', () => {
    const st: SelectState = { cursors: ['david', 'sandrine'], ready: [true, false] };
    expect(cancelSelection(st, 0).result).toBe('unready');
    expect(cancelSelection(st, 0).state.ready).toEqual([false, false]);
    expect(cancelSelection(st, 1).result).toBe('none'); // J1 est prêt : J2 ne fait pas quitter tout le monde
    expect(cancelSelection({ cursors: st.cursors, ready: [false, false] }, 1).result).toBe('menu');
    expect(cancelSelection(st, 9).result).toBe('none');
  });

  it('toggleReady bascule', () => {
    let st = createSelectState(sessionOf(1));
    const a = toggleReady(st, 0);
    expect(a.result).toBe('ready');
    st = a.state;
    expect(allReady(st)).toBe(true);
    const b = toggleReady(st, 0);
    expect(b.result).toBe('unready');
    expect(allReady(b.state)).toBe(false);
  });

  it('partie à 4 : tous prêts avec des personnages tous distincts, appliqués à la session', () => {
    const session = sessionOf(4);
    let st = createSelectState(session);
    // J1..J4 veulent tous brokk : seul le premier l'obtient, les autres sont déplacés
    st = { cursors: ['brokk', 'brokk', 'brokk', 'brokk'], ready: [false, false, false, false] };
    for (let p = 0; p < 4; p++) {
      const r = confirmSelection(st, p);
      if (r.result === 'ready') st = r.state;
      else if (r.result === 'taken') {
        st = moveCursor(st, p, 1);
        const again = confirmSelection(st, p);
        if (again.result === 'ready') st = again.state;
      }
    }
    expect(allReady(st)).toBe(true);
    expect(hasUniqueCharacters(st)).toBe(true);
    const applied = applySelection(session, st);
    expect(applied.players.map((p) => p.characterId)).toEqual(st.cursors);
    expect(applied.players.map((p) => p.difficulty)).toEqual(session.players.map((p) => p.difficulty));
    expect(session.players[0].characterId).toBe('david'); // session d'origine non mutée
    expect(new Set(applied.players.map((p) => p.characterId)).size).toBe(4);
  });

  it('état vide : jamais « tous prêts »', () => {
    expect(allReady({ cursors: [], ready: [] })).toBe(false);
  });
});

describe('barres de statistiques', () => {
  it('speedRating / reviveRating dans 1..10 et ordonnés', () => {
    for (const c of Object.values(CHARACTERS)) {
      const r = statRatings(c);
      for (const v of [r.strength, r.resistance, r.speed, r.revive]) {
        expect(v).toBeGreaterThanOrEqual(1);
        expect(v).toBeLessThanOrEqual(10);
        expect(Number.isInteger(v)).toBe(true);
      }
    }
    expect(speedRating(CHARACTERS.romain.speed)).toBeGreaterThan(speedRating(CHARACTERS.grok.speed));
    expect(reviveRating(CHARACTERS.valentine.reviveTimeMult)).toBeGreaterThan(reviveRating(CHARACTERS.david.reviveTimeMult));
    expect(reviveRating(0)).toBe(1);
    expect(speedRating(Number.NaN)).toBe(1);
  });
});

describe('entrées attribuées', () => {
  const a = (over: Partial<PlayerAssignment>): PlayerAssignment => ({ playerId: 1, label: 'gamepad', connected: false, assigned: true, ...over });

  it('clavier, manette détectée, manette absente, solo', () => {
    expect(describeAssignment(a({ playerId: 0, label: 'keyboard', connected: true }))).toEqual({ labelKey: 'select.input.keyboard', connected: true });
    const ok = describeAssignment(a({ connected: true, gamepadIndex: 0 }));
    expect(ok.labelKey).toBe('select.input.gamepad');
    expect(ok.labelParams).toEqual({ n: 1 });
    expect(ok.warnKey).toBeUndefined();
    const missing = describeAssignment(a({ playerId: 2 }));
    expect(missing.connected).toBe(false);
    expect(missing.labelParams).toEqual({ n: 2 }); // J3 ← manette 2 (J2 ← manette 1)
    expect(missing.warnKey).toBe('select.input.gamepadMissing');
    expect(missing.hintKey).toBe('select.input.connectHint');
    expect(describeAssignment(a({ playerId: 0 }), true).labelParams).toEqual({ n: 1 }); // J1 manette : manette 1
    expect(describeAssignment(a({ playerId: 1 }), true).labelParams).toEqual({ n: 2 });
    expect(describeAssignment(a({ playerId: 0, label: 'keyboard', connected: true, anyDevice: true })).labelKey).toBe('select.input.anyDevice');
  });

  it('toutes les clés retournées existent en FR et en EN', () => {
    const keys = ['select.input.keyboard', 'select.input.gamepad', 'select.input.gamepadMissing', 'select.input.connectHint', 'select.input.anyDevice'];
    for (const lang of ['fr', 'en'] as const) {
      const dict = getDictionary(lang);
      for (const k of keys) expect(dict[k], `${lang}:${k}`).toBeTruthy();
    }
  });
});

describe('dialogues et enchaînement des niveaux', () => {
  it('intro → game (session inchangée)', () => {
    const s = sessionOf(2);
    const n = nextAfterDialogue(s, 'intro', 3);
    expect(n).toEqual({ to: 'game', session: s });
  });

  it('outro → intro du niveau suivant (levelIndex + 1, stats conservées, startRoomIndex retiré)', () => {
    const s = sessionOf(2);
    s.stats.timeMs = 1234;
    s.startRoomIndex = 4;
    const n = nextAfterDialogue(s, 'outro', 3);
    expect(n.to).toBe('dialogue');
    if (n.to !== 'dialogue') return;
    expect(n.stage).toBe('intro');
    expect(n.session.levelIndex).toBe(1);
    expect(n.session.stats.timeMs).toBe(1234);
    expect('startRoomIndex' in n.session).toBe(false);
    expect(s.levelIndex).toBe(0); // non muté
    expect(s.startRoomIndex).toBe(4);
  });

  it('outro du dernier niveau → résultat (victoire), levelIndex inchangé', () => {
    const s = sessionOf(1);
    s.levelIndex = 2;
    const n = nextAfterDialogue(s, 'outro', 3);
    expect(n).toEqual({ to: 'result', session: s, outcome: 'victory' });
    expect(advanceLevel(s).levelIndex).toBe(3);
  });

  it('parcours complet de tous les niveaux (LEVELS.length) puis victoire', () => {
    let s = sessionOf(1);
    const trail: string[] = [];
    for (let guard = 0; guard < 20; guard++) {
      const intro = nextAfterDialogue(s, 'intro', LEVELS.length);
      trail.push(`intro${s.levelIndex + 1}>${intro.to}`);
      const outro = nextAfterDialogue(s, 'outro', LEVELS.length);
      if (outro.to === 'result') {
        trail.push('result');
        break;
      }
      if (outro.to === 'dialogue') s = outro.session;
    }
    expect(trail).toEqual([...LEVELS.map((_, i) => `intro${i + 1}>game`), 'result']);
  });

  it('portraitKindOf / speakerColor : orateurs connus et repli narrateur', () => {
    expect(portraitKindOf('aldric')).toBe('aldric');
    expect(portraitKindOf('lyssa')).toBe('lyssa');
    expect(portraitKindOf('morvane')).toBe('morvane');
    expect(portraitKindOf('gorgrim')).toBe('gorgrim');
    expect(portraitKindOf('heroes')).toBe('heroes');
    expect(portraitKindOf('narrator')).toBe('narrator');
    expect(portraitKindOf('inconnu')).toBe('narrator');
    expect(speakerColor('aldric')).not.toBe(speakerColor('morvane'));
    expect(speakerColor('???')).toBe(speakerColor('narrator'));
  });

  it('chaque orateur et chaque réplique des niveaux ont une clé i18n (FR + EN)', () => {
    for (const lang of ['fr', 'en'] as const) {
      const dict = getDictionary(lang);
      for (const level of LEVELS) {
        for (const line of [...level.intro, ...level.outro]) {
          expect(dict[`speaker.${line.speaker}`], `${lang} speaker.${line.speaker} (${level.id})`).toBeTruthy();
          expect(dict[line.textKey], `${lang} ${line.textKey}`).toBeTruthy();
        }
        expect(dict[level.nameKey], `${lang} ${level.nameKey}`).toBeTruthy();
      }
    }
  });

  it('clés dynamiques des scènes : difficultés, langues, fin de l\'histoire, textes de résultat', () => {
    const keys = [
      ...[1, 2, 3].flatMap((d) => [`menu.difficulty.${d}`, `menu.difficulty.${d}.desc`]),
      'menu.language.fr',
      'menu.language.en',
      'story.end.title',
      'story.end.line.1',
      'story.end.line.2',
      'story.end.line.3',
      'story.end.line.4',
      'story.end.congrats',
      'story.end.tbc',
      'story.end.thanks',
      'menu.startLevel',
      'dialogue.skipHint',
      'select.hint.menu',
      'select.input.line',
      'boot.error',
    ];
    for (const lang of ['fr', 'en'] as const) {
      const dict = getDictionary(lang);
      for (const k of keys) expect(dict[k], `${lang}:${k}`).toBeTruthy();
    }
  });
});

describe('résultats', () => {
  it('formatTime : mm:ss, h:mm:ss, valeurs invalides', () => {
    expect(formatTime(0)).toBe('00:00');
    expect(formatTime(5000)).toBe('00:05');
    expect(formatTime(65_900)).toBe('01:05');
    expect(formatTime(3_600_000 + 61_000)).toBe('1:01:01');
    expect(formatTime(-5)).toBe('00:00');
    expect(formatTime(Number.NaN)).toBe('00:00');
    expect(formatTime(Infinity)).toBe('00:00');
  });

  it('resultRows : une ligne par joueur, valeurs manquantes/invalides → 0, totaux', () => {
    const s = sessionOf(3, ['david', 'sandrine', 'romain']);
    s.stats = { timeMs: 10, downs: [2, Number.NaN], kills: [5, 7, 1, 99] };
    const rows = resultRows(s);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({ playerId: 0, characterId: 'david', downs: 2, kills: 5 });
    expect(rows[1].downs).toBe(0);
    expect(rows[2]).toEqual({ playerId: 2, characterId: 'romain', downs: 0, kills: 1 });
    expect(resultTotals(rows)).toEqual({ downs: 2, kills: 13 });
    expect(resultTotals([])).toEqual({ downs: 0, kills: 0 });
  });

  it('objectivesSummary : victoire = tout, défaite = niveaux précédents', () => {
    const counts = [4, 5, 6];
    expect(objectivesSummary({ levelIndex: 2 }, 'victory', counts)).toEqual({ done: 15, total: 15 });
    expect(objectivesSummary({ levelIndex: 2 }, 'defeat', counts)).toEqual({ done: 9, total: 15 });
    expect(objectivesSummary({ levelIndex: 0 }, 'defeat', counts)).toEqual({ done: 0, total: 15 });
  });

  it('isFinalVictory : seulement une victoire au dernier niveau', () => {
    expect(isFinalVictory({ levelIndex: 2 }, 'victory', 3)).toBe(true);
    expect(isFinalVictory({ levelIndex: 1 }, 'victory', 3)).toBe(false);
    expect(isFinalVictory({ levelIndex: 2 }, 'defeat', 3)).toBe(false);
  });

  it('replaySession : stats à zéro ; victoire → niveau 1 ; défaite → niveau courant', () => {
    const s = sessionOf(2);
    s.levelIndex = 2;
    s.stats = { timeMs: 99, downs: [1, 2], kills: [3, 4] };
    s.startRoomIndex = 3;
    const win = replaySession(s, 'victory');
    expect(win.levelIndex).toBe(0);
    expect(win.stats).toEqual(emptyStats(2));
    expect('startRoomIndex' in win).toBe(false);
    expect(win.players).toEqual(s.players);
    expect(win.players[0]).not.toBe(s.players[0]); // copie
    const lose = replaySession(s, 'defeat');
    expect(lose.levelIndex).toBe(2);
    expect(s.stats.timeMs).toBe(99); // original non muté
  });
});

describe('paramètres d\'URL de dev', () => {
  it('sans paramètre : pas de démarrage rapide, 1 joueur David normal niveau 1', () => {
    const q = parseQuickParams('');
    expect(q.quick).toBe(false);
    expect(q.debug).toBe(false);
    expect(q.language).toBeUndefined();
    expect(q.session.playerCount).toBe(1);
    expect(q.session.players).toEqual([{ id: 0, characterId: 'david', difficulty: 2 }]);
    expect(q.session.levelIndex).toBe(0);
    expect(q.session.startRoomIndex).toBeUndefined();
  });

  it('?quick=1&players=2&level=2&chars=david,sandrine&diff=1,2&lang=en&room=3', () => {
    const q = parseQuickParams('?quick=1&players=2&level=2&chars=david,sandrine&diff=1,2&lang=en&room=3', 3);
    expect(q.quick).toBe(true);
    expect(q.debug).toBe(true);
    expect(q.language).toBe('en');
    expect(q.session.playerCount).toBe(2);
    expect(q.session.players).toEqual([
      { id: 0, characterId: 'david', difficulty: 1 },
      { id: 1, characterId: 'sandrine', difficulty: 2 },
    ]);
    expect(q.session.levelIndex).toBe(1);
    expect(q.session.startRoomIndex).toBe(3);
    expect(q.session.stats).toEqual(emptyStats(2));
  });

  it('players par défaut = nombre de chars ; chars invalides/doublons ignorés et complétés', () => {
    const q = parseQuickParams('?quick=1&chars=mira,mira,zzz,grok');
    expect(q.session.playerCount).toBe(2);
    expect(q.session.players.map((p) => p.characterId)).toEqual(['mira', 'grok']);
    const q2 = parseQuickParams('?players=4&chars=mira');
    expect(q2.session.players).toHaveLength(4);
    expect(new Set(q2.session.players.map((p) => p.characterId)).size).toBe(4);
    expect(q2.session.players[0].characterId).toBe('mira');
  });

  it('diff : une valeur pour tous, valeurs invalides → normal', () => {
    expect(parseQuickParams('?players=3&diff=3').session.players.map((p) => p.difficulty)).toEqual([3, 3, 3]);
    expect(parseQuickParams('?players=3&diff=1,x,9').session.players.map((p) => p.difficulty)).toEqual([1, 2, 2]);
    expect(parseQuickParams('?players=2&diff=').session.players.map((p) => p.difficulty)).toEqual([2, 2]);
  });

  it('bornes : players, level, room, lang, booléens', () => {
    expect(parseQuickParams('?players=9').session.playerCount).toBe(4);
    expect(parseQuickParams('?players=0').session.playerCount).toBe(1);
    expect(parseQuickParams('?players=abc').session.playerCount).toBe(1);
    expect(parseQuickParams('?level=99', 3).session.levelIndex).toBe(2);
    expect(parseQuickParams('?level=0', 3).session.levelIndex).toBe(0);
    expect(parseQuickParams('?room=-4').session.startRoomIndex).toBe(0);
    expect(parseQuickParams('?room=2.9').session.startRoomIndex).toBe(2);
    expect(parseQuickParams('?room=abc').session.startRoomIndex).toBeUndefined();
    expect(parseQuickParams('?lang=de').language).toBeUndefined();
    expect(parseQuickParams('?lang=FR').language).toBe('fr');
    expect(parseQuickParams('?quick=true').quick).toBe(true);
    expect(parseQuickParams('?quick').quick).toBe(true);
    expect(parseQuickParams('?quick=0').quick).toBe(false);
    expect(parseQuickParams('?debug=1').debug).toBe(true);
    expect(parseQuickParams('?p1pad=1').player1Gamepad).toBe(true);
  });

  it('la session produite est du JSON pur', () => {
    const q = parseQuickParams('?quick=1&players=3&room=1');
    expect(JSON.parse(JSON.stringify(q.session))).toEqual(q.session);
  });
});

describe('fond en bandes et hachage', () => {
  it('mixColor interpole canal par canal', () => {
    expect(mixColor(0x000000, 0xffffff, 0)).toBe(0x000000);
    expect(mixColor(0x000000, 0xffffff, 1)).toBe(0xffffff);
    expect(mixColor(0x000000, 0xff8000, 0.5)).toBe(0x804000);
    expect(mixColor(0x102030, 0x405060, 5)).toBe(0x405060); // t borné
  });

  it('skyBandColors : extrémités exactes, monotone, une seule bande possible', () => {
    const c = skyBandColors(5, 0x000000, 0xff0000);
    expect(c).toHaveLength(5);
    expect(c[0]).toBe(0x000000);
    expect(c[4]).toBe(0xff0000);
    for (let i = 1; i < c.length; i++) expect(c[i]).toBeGreaterThanOrEqual(c[i - 1]);
    expect(skyBandColors(1, 0x123456, 0xffffff)).toEqual([0x123456]);
    expect(skyBandColors(0, 1, 2)).toHaveLength(1);
  });

  it('hash01 : déterministe et dans [0,1)', () => {
    expect(hash01(3, 4, 5)).toBe(hash01(3, 4, 5));
    expect(hash01(3, 4, 5)).not.toBe(hash01(4, 3, 5));
    for (let i = 0; i < 500; i++) {
      const v = hash01(i, i * 7, 11);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});
