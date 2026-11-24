import { describe, expect, it } from 'vitest';
import type { BuildInfo } from '../buildInfo';
import {
  FRAME_BIT,
  FRAME_BITS_ALL,
  GUEST_TO_HOST_TYPES,
  HOST_TO_GUEST_TYPES,
  NET,
  NET_PROTOCOL_VERSION,
  SIM_EVENT_TYPES,
  buildsCompatible,
  compatibilityCheck,
  noticeForClose,
  noticeForEnd,
  noticeKey,
  packFrame,
  parseNetTransportParam,
  peerConnected,
  peerMask,
  quantizeAxis,
  sanitizeNetName,
  snapshotDue,
  sessionFromNetStart,
  unpackFrame,
  type Compat,
  type NetStartInfo,
} from './contracts';
import { emptyFrame } from '../input/mapping';

const build: BuildInfo = { version: '0.1.0', commit: 'abc1234', date: '2026-11-23' };
const local: Compat = { proto: NET_PROTOCOL_VERSION, build, levels: 9 };

describe('constantes', () => {
  it('20 Hz : un instantané tous les 3 pas', () => {
    expect(NET.SNAPSHOT_EVERY_TICKS).toBe(3);
    expect(NET.SNAPSHOT_INTERVAL_MS).toBeCloseTo((3 * 1000) / 60, 0);
    expect(snapshotDue(3)).toBe(true);
    expect(snapshotDue(4)).toBe(false);
    expect(snapshotDue(0)).toBe(false);
    expect(snapshotDue(Number.NaN)).toBe(false);
  });

  it('la fragmentation tient sous la limite brute et le plafond de fragments couvre le pire instantané mesuré', () => {
    expect(NET.FRAGMENT_CHARS).toBeLessThan(16384);
    expect(NET.FRAGMENT_CHARS * NET.MAX_FRAGMENTS).toBeGreaterThanOrEqual(NET.MAX_MESSAGE_CHARS);
    // pire cas mesuré : ~33,7 Ko d'état + ~3,2 Ko d'événements (docs/NET.md § Mesures) : marge x4
    expect(NET.MAX_MESSAGE_CHARS).toBeGreaterThan(4 * 37000);
  });

  it('listes de types : pas de doublon, pas de type partagé hors `leave` / `frag`', () => {
    expect(new Set(SIM_EVENT_TYPES).size).toBe(SIM_EVENT_TYPES.length);
    const shared = GUEST_TO_HOST_TYPES.filter((t) => (HOST_TO_GUEST_TYPES as readonly string[]).includes(t));
    expect([...shared].sort()).toEqual(['frag', 'leave']);
  });
});

describe('compatibilité à la connexion', () => {
  it('builds : identiques seulement', () => {
    expect(buildsCompatible(build, { ...build })).toBe(true);
    expect(buildsCompatible(build, { ...build, commit: 'def5678' })).toBe(false);
    expect(buildsCompatible(build, { ...build, version: '0.2.0' })).toBe(false);
    expect(buildsCompatible(build, { ...build, date: null })).toBe(false);
    expect(buildsCompatible({ version: '0.0.0', commit: null, date: null }, { version: '0.0.0', commit: null, date: null })).toBe(true);
  });

  it('ordre des refus : protocole, build, niveaux', () => {
    expect(compatibilityCheck(local, local)).toBeNull();
    expect(compatibilityCheck({ ...local, proto: 2, levels: 3 }, local)).toBe('protocol');
    expect(compatibilityCheck({ ...local, build: { ...build, commit: 'x' }, levels: 3 }, local)).toBe('build');
    expect(compatibilityCheck({ ...local, levels: 3 }, local)).toBe('levels');
  });
});

describe('messages utilisateur', () => {
  it('clé i18n, fin de partie et fermeture', () => {
    expect(noticeKey('hostLost')).toBe('net.notice.hostLost');
    expect(noticeKey('reject.build')).toBe('net.notice.reject.build');
    expect(noticeForEnd('levelCompleted')).toEqual({ code: 'levelCompleted' });
    expect(noticeForClose({ reason: 'userLeft' })).toBeNull();
    expect(noticeForClose({ reason: 'hostLost' })).toEqual({ code: 'hostLost' });
    expect(noticeForClose({ reason: 'rejected', reject: { reason: 'build', hostProto: 1, hostBuild: build, hostLevels: 9 } })).toEqual({ code: 'reject.build' });
    expect(noticeForClose({ reason: 'rejected' })).toEqual({ code: 'reject.malformed' });
  });
});

describe('entrées sur le fil', () => {
  it('quantification des axes', () => {
    expect(quantizeAxis(0)).toBe(0);
    expect(quantizeAxis(1)).toBe(100);
    expect(quantizeAxis(-1)).toBe(-100);
    expect(quantizeAxis(0.7071)).toBe(71);
    expect(quantizeAxis(5)).toBe(100);
    expect(quantizeAxis(Number.NaN)).toBe(0);
    expect(quantizeAxis(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('aller-retour pack / unpack', () => {
    const f = { moveX: 1, moveY: -0.5, attack: true, interact: false, revive: true, special: true, call: false, heart: true };
    const p = packFrame(f);
    expect(p).toEqual({ x: 100, y: -50, b: FRAME_BIT.attack | FRAME_BIT.revive | FRAME_BIT.special | FRAME_BIT.heart });
    expect(unpackFrame(p.x, p.y, p.b)).toEqual(f);
    expect(unpackFrame(0, 0, 0)).toEqual({ ...emptyFrame() });
  });

  it('frame sans champs optionnels : booléens explicites', () => {
    const p = packFrame({ moveX: 0, moveY: 0, attack: true, interact: false, revive: false });
    expect(p.b).toBe(FRAME_BIT.attack);
    const u = unpackFrame(p.x, p.y, p.b);
    expect(u?.special).toBe(false);
    expect(u?.call).toBe(false);
    expect(u?.heart).toBe(false);
  });

  it('rejette tout ce qui n\'est pas un entier dans sa plage', () => {
    expect(unpackFrame(101, 0, 0)).toBeNull();
    expect(unpackFrame(0, -101, 0)).toBeNull();
    expect(unpackFrame(0, 0, FRAME_BITS_ALL + 1)).toBeNull();
    expect(unpackFrame(0, 0, -1)).toBeNull();
    expect(unpackFrame(0.5, 0, 0)).toBeNull();
    expect(unpackFrame(Number.NaN, 0, 0)).toBeNull();
    expect(unpackFrame('1', 0, 0)).toBeNull();
    expect(unpackFrame(null, 0, 0)).toBeNull();
    expect(unpackFrame(0, 0, undefined)).toBeNull();
  });
});

describe('masque des joueurs connectés', () => {
  it('construit et lit le masque', () => {
    expect(peerMask([0, 2])).toBe(5);
    expect(peerMask([])).toBe(0);
    expect(peerMask([0, 9, -1, 1.5])).toBe(1);
    expect(peerConnected(5, 0)).toBe(true);
    expect(peerConnected(5, 1)).toBe(false);
    expect(peerConnected(5, 2)).toBe(true);
    expect(peerConnected(5, 4)).toBe(false);
    expect(peerConnected(5, -1)).toBe(false);
  });
});

describe('nom d\'affichage', () => {
  it('assainit', () => {
    expect(sanitizeNetName('  Léa  ', 'Joueur')).toBe('Léa');
    expect(sanitizeNetName('<b>Zoé</b>', 'Joueur')).toBe('bZoéb');
    expect(sanitizeNetName('a\u0000b‮c', 'Joueur')).toBe('abc');
    expect(sanitizeNetName('Jean   Paul', 'Joueur')).toBe('Jean Paul');
    expect(sanitizeNetName('', 'Joueur')).toBe('Joueur');
    expect(sanitizeNetName('!!!', 'Joueur')).toBe('Joueur');
    expect(sanitizeNetName(42, 'Joueur')).toBe('Joueur');
    expect(sanitizeNetName(undefined, 'Joueur')).toBe('Joueur');
  });

  it('tronque à NAME_MAX_CHARS points de code', () => {
    const out = sanitizeNetName('x'.repeat(100), 'Joueur');
    expect(Array.from(out).length).toBe(NET.NAME_MAX_CHARS);
  });
});

describe('paramètre ?net=', () => {
  it('bc → BroadcastChannel, sinon WebRTC', () => {
    expect(parseNetTransportParam('?net=bc')).toBe('broadcast');
    expect(parseNetTransportParam('?quick=1&net=bc')).toBe('broadcast');
    expect(parseNetTransportParam('?net=rtc')).toBe('webrtc');
    expect(parseNetTransportParam('')).toBe('webrtc');
    expect(parseNetTransportParam('?net=BC')).toBe('webrtc');
  });
});

describe('session réseau', () => {
  it('sessionFromNetStart : ids contigus, noms conservés, aucune reprise', () => {
    const info: NetStartInfo = {
      gameId: 42,
      localPlayerId: 1,
      levelIndex: 3,
      seed: 777,
      players: [
        { id: 0, characterId: 'david', difficulty: 2, name: 'Hôte' },
        { id: 1, characterId: 'sandrine', difficulty: 1, name: 'Invitée' },
      ],
    };
    const s = sessionFromNetStart(info, 'client', 'webrtc');
    expect(s.playerCount).toBe(2);
    expect(s.levelIndex).toBe(3);
    expect(s.players).toEqual([
      { id: 0, characterId: 'david', difficulty: 2 },
      { id: 1, characterId: 'sandrine', difficulty: 1 },
    ]);
    expect(s.net).toEqual({ role: 'client', gameId: 42, localPlayerId: 1, transport: 'webrtc', seed: 777, names: ['Hôte', 'Invitée'] });
    expect(s.stats.kills).toEqual([0, 0]);
    expect(s.startRoomIndex).toBeUndefined();
    expect(s.startGear).toBeUndefined();
    expect(s.completedLevelIds).toBeUndefined();
    expect(JSON.parse(JSON.stringify(s))).toEqual(s); // JSON pur
  });
});
