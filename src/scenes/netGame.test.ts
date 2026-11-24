import { describe, expect, it } from 'vitest';
import { LEVELS } from '../levels';
import { createSimulation } from '../core/simulation';
import type { ActionFrame, PlayerId } from '../core/types';
import { NET, peerMask } from '../net/contracts';
import {
  NET_EMPTY_FRAME,
  SnapshotGate,
  composeHostInputs,
  levelEndAction,
  localNetFrame,
  lostPeers,
  playerDisplayName,
  stallStatus,
  teamStripEntries,
} from './netGame';

function frame(over: Partial<ActionFrame> = {}): ActionFrame {
  return { moveX: 0, moveY: 0, attack: false, interact: false, revive: false, ...over };
}

describe('composeHostInputs : entrées d\'un pas de l\'hôte', () => {
  it('l\'hôte est le joueur 0, les invités gardent leur identifiant de jeu', () => {
    const a = frame({ moveX: 1 });
    const b = frame({ attack: true });
    const mine = frame({ moveY: -1 });
    const out = composeHostInputs({ 1: a, 2: b }, mine);
    expect(out[0]).toBe(mine);
    expect(out[1]).toBe(a);
    expect(out[2]).toBe(b);
    expect(out[3]).toBeUndefined();
  });

  it('une entrée distante portant la clé 0 est ignorée : un invité ne pilote jamais l\'hôte', () => {
    const hostile = frame({ moveX: 1, attack: true });
    const out = composeHostInputs({ 0: hostile }, undefined);
    expect(out[0]).toBe(NET_EMPTY_FRAME);
    const mine = frame({ moveX: -1 });
    expect(composeHostInputs({ 0: hostile }, mine)[0]).toBe(mine);
  });

  it('sans frame locale (menu de pause), le joueur 0 reçoit une frame vide', () => {
    const out = composeHostInputs({}, undefined);
    expect(out[0]).toEqual({ moveX: 0, moveY: 0, attack: false, interact: false, revive: false, special: false, call: false, heart: false });
  });

  it('ne modifie pas l\'argument', () => {
    const remote = { 1: frame() };
    composeHostInputs(remote, frame());
    expect(Object.keys(remote)).toEqual(['1']);
  });

  it('localNetFrame : vide pendant la pause, sinon l\'entrée 0', () => {
    const f = frame({ attack: true });
    expect(localNetFrame(true, { 0: f })).toBeUndefined();
    expect(localNetFrame(false, { 0: f })).toBe(f);
    expect(localNetFrame(false, {})).toBeUndefined();
  });

  it('la frame vide est figée', () => {
    expect(Object.isFrozen(NET_EMPTY_FRAME)).toBe(true);
  });
});

describe('SnapshotGate : un instantané n\'est appliqué (état ET événements) qu\'une fois, dans l\'ordre', () => {
  it('accepte une suite croissante', () => {
    const g = new SnapshotGate();
    expect(g.accept({ n: 1, tick: 3 })).toBe(true);
    expect(g.accept({ n: 2, tick: 6 })).toBe(true);
    expect(g.accept({ n: 3, tick: 9 })).toBe(true);
    expect(g.last).toBe(3);
  });

  it('refuse un doublon (même n, même numéro de pas) : ses événements ne sont pas rejoués', () => {
    const g = new SnapshotGate();
    expect(g.accept({ n: 5, tick: 15 })).toBe(true);
    expect(g.accept({ n: 5, tick: 15 })).toBe(false);
    expect(g.accept({ n: 4, tick: 12 })).toBe(false);
  });

  it('refuse un numéro de pas qui recule même avec un n plus grand', () => {
    const g = new SnapshotGate();
    expect(g.accept({ n: 5, tick: 15 })).toBe(true);
    expect(g.accept({ n: 6, tick: 12 })).toBe(false);
    expect(g.accept({ n: 6, tick: 18 })).toBe(true);
  });

  it('accepte un saut de n (instantanés non envoyés pour cause de saturation)', () => {
    const g = new SnapshotGate();
    expect(g.accept({ n: 1, tick: 3 })).toBe(true);
    expect(g.accept({ n: 9, tick: 27 })).toBe(true);
  });

  it('refuse les valeurs non finies ; reset repart de zéro', () => {
    const g = new SnapshotGate();
    expect(g.accept({ n: Number.NaN, tick: 3 })).toBe(false);
    expect(g.accept({ n: 1, tick: Number.POSITIVE_INFINITY })).toBe(false);
    expect(g.accept({ n: 0, tick: 0 })).toBe(true);
    g.reset();
    expect(g.last).toBe(-1);
    expect(g.accept({ n: 0, tick: 0 })).toBe(true);
  });
});

describe('stallStatus : état de la liaison affiché par l\'invité', () => {
  it('« en attente » tant qu\'aucun instantané n\'est arrivé', () => {
    expect(stallStatus(5000, null)).toBe('waiting');
  });
  it('« instable » après STALL_WARN_MS sans instantané, « ok » avant', () => {
    expect(stallStatus(1000, 1000)).toBe('ok');
    expect(stallStatus(1000 + NET.STALL_WARN_MS, 1000)).toBe('ok');
    expect(stallStatus(1001 + NET.STALL_WARN_MS, 1000)).toBe('lag');
    expect(stallStatus(10_000, 1000)).toBe('lag');
  });
});

describe('lostPeers : joueurs dont on annonce la perte', () => {
  it('rien au premier masque', () => {
    expect(lostPeers(null, peerMask([0, 1, 2]), 3, 1)).toEqual([]);
  });
  it('un joueur qui passe de connecté à perdu', () => {
    expect(lostPeers(peerMask([0, 1, 2]), peerMask([0, 2]), 3, 2)).toEqual([1]);
  });
  it('jamais le joueur local, jamais un joueur déjà perdu ou hors partie', () => {
    expect(lostPeers(peerMask([0, 1, 2]), peerMask([0, 1]), 3, 2)).toEqual([]);
    expect(lostPeers(peerMask([0, 1]), peerMask([0]), 3, 0)).toEqual([1]);
    expect(lostPeers(peerMask([0]), peerMask([]), 2, 1)).toEqual([0]);
    expect(lostPeers(peerMask([0, 3]), peerMask([0]), 2, 1)).toEqual([]); // 3 n'existe pas à 2 joueurs
  });
  it('plusieurs pertes d\'un coup, dans l\'ordre', () => {
    expect(lostPeers(peerMask([0, 1, 2, 3]), peerMask([0]), 4, 0)).toEqual([1, 2, 3]);
  });
  it('un joueur qui revient n\'est pas « perdu »', () => {
    expect(lostPeers(peerMask([0]), peerMask([0, 1]), 2, 0)).toEqual([]);
  });
});

describe('levelEndAction', () => {
  it('rien tant que le niveau n\'est pas terminé', () => {
    expect(levelEndAction('host', false, 99999, 3200)).toBe('none');
    expect(levelEndAction('client', false, 99999, 3200)).toBe('none');
  });
  it('l\'hôte met fin à la partie après la célébration', () => {
    expect(levelEndAction('host', true, 3199, 3200)).toBe('none');
    expect(levelEndAction('host', true, 3200, 3200)).toBe('endGame');
  });
  it('l\'invité attend le message de l\'hôte', () => {
    expect(levelEndAction('client', true, 0, 3200)).toBe('await');
    expect(levelEndAction('client', true, 99999, 3200)).toBe('await');
  });
});

describe('bandeau d\'équipe', () => {
  it('liste les AUTRES joueurs avec leur nom, PV et état', () => {
    const level = LEVELS[0];
    const sim = createSimulation(
      {
        levelId: level.id,
        players: [
          { id: 0, characterId: 'david', difficulty: 2 },
          { id: 1, characterId: 'aelith', difficulty: 2 },
          { id: 2, characterId: 'brokk', difficulty: 2 },
        ],
        seed: 1,
      },
      level,
    );
    sim.state.players[1].hp = 12.2;
    sim.state.players[2].status = 'down';
    const names = ['Hôte', 'Léa', ''];
    const entries = teamStripEntries(sim.state, 0, names, peerMask([0, 1]));
    expect(entries.map((e) => e.id)).toEqual([1, 2]);
    expect(entries[0]).toMatchObject({ name: 'Léa', hp: 13, down: false, lost: false });
    expect(entries[1]).toMatchObject({ name: 'J3', down: true, lost: true }); // nom vide : repli ; 2 absent du masque
    const asGuest = teamStripEntries(sim.state, 2, names, null);
    expect(asGuest.map((e) => e.id)).toEqual([0, 1]);
    expect(asGuest.every((e) => e.lost === false)).toBe(true);
  });

  it('playerDisplayName : repli « J<n> »', () => {
    expect(playerDisplayName(['A', 'B'], 1)).toBe('B');
    expect(playerDisplayName(['A'], 3 as PlayerId)).toBe('J4');
    expect(playerDisplayName([''], 0)).toBe('J1');
  });
});
