import { describe, expect, it } from 'vitest';
import { CHARACTER_IDS } from '../core/characters';
import type { BuildInfo } from '../buildInfo';
import { NET, NET_BC_CHANNEL, type LobbySlot, type LobbyState, type NetClosedInfo, type RtcSignalingErrorCode } from '../net/contracts';
import {
  MAX_GUESTS,
  NET_NAME_STORAGE_KEY,
  RTC_ERROR_CODES,
  activeInvite,
  chipInvites,
  needsCloseConfirm,
  backOutcome,
  canInvite,
  characterAvailability,
  checkPastedCode,
  connectedCount,
  createNetLobbyState,
  createReturnState,
  firstFreeCharacter,
  guestCount,
  hostStartCheck,
  liveInvites,
  loadStoredName,
  lobbyActions,
  logicalToCss,
  messageFromJoinError,
  messageFromNotice,
  noticeForClosure,
  normalizeName,
  participantRows,
  reduceNetLobby,
  roomCodeToChannel,
  sanitizeRoomCode,
  stepCharacter,
  stepDifficulty,
  stepLevelIndex,
  storeName,
  takenCharacters,
  type NetLobbyEvent,
  type NetLobbyState,
} from './netLobbyLogic';

// ───────────────────────────── Aides ─────────────────────────────

function slot(partial: Partial<LobbySlot> & { slot: LobbySlot['slot'] }): LobbySlot {
  return {
    name: `P${partial.slot}`,
    isHost: partial.slot === 0,
    connected: true,
    characterId: CHARACTER_IDS[partial.slot],
    difficulty: 2,
    ready: false,
    ...partial,
  };
}

function lobby(slots: LobbySlot[], extra: Partial<LobbyState> = {}): LobbyState {
  return { seq: 1, slots, levelIndex: 0, levelCount: 9, ...extra };
}

function run(state: NetLobbyState, ...events: NetLobbyEvent[]): NetLobbyState {
  return events.reduce(reduceNetLobby, state);
}

const BUILD_A: BuildInfo = { version: '0.1.0', commit: 'a1b2c3d', date: '2026-11-23' };
const BUILD_B: BuildInfo = { version: '0.1.0', commit: '9f8e7d6', date: '2026-11-20' };

// ───────────────────────────── Validation du collage ─────────────────────────────

describe('checkPastedCode', () => {
  it('refuse un collage vide ou fait de blancs', () => {
    expect(checkPastedCode('')).toEqual({ ok: false, error: 'empty' });
    expect(checkPastedCode(' \n\t  ')).toEqual({ ok: false, error: 'empty' });
  });

  it('ignore les blancs (espaces, sauts de ligne, insécables, largeur nulle) et rend le code compact', () => {
    expect(checkPastedCode(' V1O abcde\nFGH_- ij​12 ')).toEqual({ ok: true, code: 'V1OabcdeFGH_-ij12' });
  });

  it('refuse les caractères hors alphabet base64url', () => {
    expect(checkPastedCode('V1O abc+def')).toEqual({ ok: false, error: 'badChars' });
    expect(checkPastedCode('V1O=abc')).toEqual({ ok: false, error: 'badChars' });
    expect(checkPastedCode('V1O é')).toEqual({ ok: false, error: 'badChars' });
    expect(checkPastedCode('{"sdp":"v=0"}')).toEqual({ ok: false, error: 'badChars' });
  });

  it('refuse un code plus long que NET.CODE_MAX_CHARS (les blancs ne comptent pas)', () => {
    expect(checkPastedCode('a'.repeat(NET.CODE_MAX_CHARS)).ok).toBe(true);
    expect(checkPastedCode('a'.repeat(NET.CODE_MAX_CHARS + 1))).toEqual({ ok: false, error: 'tooLong' });
    expect(checkPastedCode('a '.repeat(NET.CODE_MAX_CHARS)).ok).toBe(true);
  });

  it('une valeur qui n\'est pas une chaîne est traitée comme vide', () => {
    expect(checkPastedCode(undefined as unknown as string)).toEqual({ ok: false, error: 'empty' });
  });
});

// ───────────────────────────── Nom, code de salon ─────────────────────────────

describe('nom et code de salon', () => {
  it('normalizeName assainit et retombe sur le nom par défaut', () => {
    expect(normalizeName('  Ana   Bel <b>', 'Joueur')).toBe('Ana Bel b');
    expect(normalizeName('', 'Joueur')).toBe('Joueur');
    expect(normalizeName('!!!', 'Joueur')).toBe('Joueur');
    expect(Array.from(normalizeName('x'.repeat(40), 'Joueur')).length).toBe(NET.NAME_MAX_CHARS);
  });

  it('loadStoredName / storeName : aller-retour, repli sans stockage, exceptions avalées', () => {
    const data = new Map<string, string>();
    const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
    expect(loadStoredName(storage, 'Joueur')).toBe('Joueur');
    storeName(storage, '  Léa  ', 'Joueur');
    expect(data.get(NET_NAME_STORAGE_KEY)).toBe('Léa');
    expect(loadStoredName(storage, 'Joueur')).toBe('Léa');
    const broken = {
      getItem: (): string | null => {
        throw new Error('bloqué');
      },
      setItem: (): void => {
        throw new Error('bloqué');
      },
    };
    expect(loadStoredName(broken, 'Joueur')).toBe('Joueur');
    expect(() => storeName(broken, 'Léa', 'Joueur')).not.toThrow();
    expect(loadStoredName(null, 'Joueur')).toBe('Joueur');
    expect(() => storeName(undefined, 'Léa', 'Joueur')).not.toThrow();
  });

  it('code de salon BroadcastChannel : vide = canal par défaut, sinon canal dédié assaini', () => {
    expect(roomCodeToChannel('')).toBe(NET_BC_CHANNEL);
    expect(roomCodeToChannel('   ')).toBe(NET_BC_CHANNEL);
    expect(roomCodeToChannel(undefined)).toBe(NET_BC_CHANNEL);
    expect(roomCodeToChannel('Ab 1')).toBe(`${NET_BC_CHANNEL}-ab1`);
    expect(sanitizeRoomCode('a-b_c!d')).toBe('abcd');
    expect(sanitizeRoomCode('x'.repeat(50)).length).toBeLessThanOrEqual(12);
    expect(sanitizeRoomCode(42)).toBe('');
  });
});

// ───────────────────────────── Messages ─────────────────────────────

describe('messages traduisibles', () => {
  const local = { build: BUILD_A, levels: 9 };

  it('refus de version : paramètres host / you = libellés de build', () => {
    const info: NetClosedInfo = { reason: 'rejected', reject: { reason: 'build', hostProto: 1, hostBuild: BUILD_B, hostLevels: 9 } };
    const fr = noticeForClosure(info, local, 'fr');
    expect(fr).toEqual({ code: 'reject.build', params: { host: 'v0.1.0 · 9f8e7d6 · 20/11/2026', you: 'v0.1.0 · a1b2c3d · 23/11/2026' } });
    const en = noticeForClosure(info, local, 'en');
    expect(en?.params).toEqual({ host: 'v0.1.0 · 9f8e7d6 · 2026-11-20', you: 'v0.1.0 · a1b2c3d · 2026-11-23' });
  });

  it('refus de niveaux : nombres de niveaux de chaque côté', () => {
    const info: NetClosedInfo = { reason: 'rejected', reject: { reason: 'levels', hostProto: 1, hostBuild: BUILD_A, hostLevels: 12 } };
    expect(noticeForClosure(info, local, 'fr')).toEqual({ code: 'reject.levels', params: { host: 12, you: 9 } });
  });

  it('autres refus et fermetures : code seul ; départ volontaire : aucun message', () => {
    for (const reason of ['protocol', 'started', 'full', 'malformed'] as const) {
      const info: NetClosedInfo = { reason: 'rejected', reject: { reason, hostProto: 1, hostBuild: BUILD_A, hostLevels: 9 } };
      expect(noticeForClosure(info, local, 'fr')).toEqual({ code: `reject.${reason}` });
    }
    expect(noticeForClosure({ reason: 'hostLost' }, local, 'fr')).toEqual({ code: 'hostLost' });
    expect(noticeForClosure({ reason: 'hostLeft' }, local, 'fr')).toEqual({ code: 'hostLeft' });
    expect(noticeForClosure({ reason: 'userLeft' }, local, 'fr')).toBeNull();
  });

  it('messageFromNotice : clé net.notice.<code>, paramètres copiés', () => {
    expect(messageFromNotice({ code: 'hostLost' })).toEqual({ key: 'net.notice.hostLost', tone: 'error' });
    const params = { host: 'a', you: 'b' };
    const m = messageFromNotice({ code: 'reject.build', params }, 'info');
    expect(m).toEqual({ key: 'net.notice.reject.build', params, tone: 'info' });
    expect(m.params).not.toBe(params);
    // sans ton explicite : « niveau terminé » est une information, tout le reste une erreur
    expect(messageFromNotice({ code: 'levelCompleted' }).tone).toBe('info');
    expect(messageFromNotice({ code: 'hostLeft' }).tone).toBe('error');
    expect(messageFromNotice({ code: 'reject.full' }).tone).toBe('error');
  });

  it('messageFromJoinError : code de signalisation, délai, non pris en charge, générique', () => {
    for (const code of RTC_ERROR_CODES) {
      expect(messageFromJoinError(Object.assign(new Error('x'), { code }))).toEqual({ key: `net.rtc.error.${code}`, tone: 'error' });
    }
    expect(messageFromJoinError(new Error('timeout')).key).toBe('net.lobby.error.noHost');
    expect(messageFromJoinError(new Error('unsupported')).key).toBe('net.rtc.error.unsupported');
    expect(messageFromJoinError(new Error('autre chose')).key).toBe('net.lobby.error.generic');
    expect(messageFromJoinError(Object.assign(new Error('x'), { code: 'inconnu' })).key).toBe('net.lobby.error.generic');
    expect(messageFromJoinError('texte brut').key).toBe('net.lobby.error.generic');
    expect(messageFromJoinError(null).key).toBe('net.lobby.error.generic');
  });
});

// ───────────────────────────── Réducteur : choix et invité ─────────────────────────────

describe('réducteur : choix hôte / invité', () => {
  it('démarre sur le choix, sans message', () => {
    const s = createNetLobbyState('webrtc');
    expect(s).toMatchObject({ step: 'choose', join: 'code', invites: [], answerCode: null, message: null, transport: 'webrtc' });
  });

  it('chooseHost ouvre le salon de l\'hôte ; chooseJoin ouvre la connexion de l\'invité (phase selon le transport)', () => {
    expect(run(createNetLobbyState('webrtc'), { type: 'chooseHost' }).step).toBe('host');
    const rtc = run(createNetLobbyState('webrtc'), { type: 'chooseJoin' });
    expect([rtc.step, rtc.join]).toEqual(['join', 'code']);
    const bc = run(createNetLobbyState('broadcast'), { type: 'chooseJoin' });
    expect([bc.step, bc.join]).toEqual(['join', 'connecting']);
  });

  it('les événements hors de leur étape sont ignorés (même référence)', () => {
    const host = run(createNetLobbyState('webrtc'), { type: 'chooseHost' });
    expect(reduceNetLobby(host, { type: 'chooseJoin' })).toBe(host);
    expect(reduceNetLobby(host, { type: 'chooseHost' })).toBe(host);
    expect(reduceNetLobby(host, { type: 'back' })).toBe(host);
    expect(reduceNetLobby(host, { type: 'joinSubmitted' })).toBe(host);
    const choose = createNetLobbyState('webrtc');
    expect(reduceNetLobby(choose, { type: 'inviteStarted' })).toBe(choose);
    expect(reduceNetLobby(choose, { type: 'joined' })).toBe(choose);
  });

  it('parcours WebRTC de l\'invité : code → réponse → connexion → salon', () => {
    let s = run(createNetLobbyState('webrtc'), { type: 'chooseJoin' });
    s = run(s, { type: 'joinSubmitted' });
    expect(s.join).toBe('creating');
    s = run(s, { type: 'answerReady', answerCode: 'V1Aabc' });
    expect([s.join, s.answerCode]).toEqual(['answer', 'V1Aabc']);
    s = run(s, { type: 'joinConnecting' });
    expect(s.join).toBe('connecting');
    s = run(s, { type: 'joined' });
    expect([s.step, s.answerCode, s.message]).toEqual(['guest', null, null]);
  });

  it('une réponse tardive (annulation déjà faite) est ignorée', () => {
    const choose = run(createNetLobbyState('webrtc'), { type: 'chooseJoin' }, { type: 'joinSubmitted' }, { type: 'back' });
    expect(choose.step).toBe('choose');
    expect(reduceNetLobby(choose, { type: 'answerReady', answerCode: 'V1Aabc' })).toBe(choose);
    expect(reduceNetLobby(choose, { type: 'joinFailed', message: { key: 'x', tone: 'error' } })).toBe(choose);
  });

  it('échec puis « réessayer » : retour à la saisie (WebRTC) ou à la recherche (BroadcastChannel)', () => {
    const failed = { key: 'net.notice.reject.full', tone: 'error' as const };
    let s = run(createNetLobbyState('webrtc'), { type: 'chooseJoin' }, { type: 'joinSubmitted' }, { type: 'joinFailed', message: failed });
    expect([s.join, s.message]).toEqual(['failed', failed]);
    s = run(s, { type: 'retry' });
    expect([s.join, s.message]).toEqual(['code', null]);
    let b = run(createNetLobbyState('broadcast'), { type: 'chooseJoin' }, { type: 'joinFailed', message: failed });
    expect(b.join).toBe('failed');
    b = run(b, { type: 'retry' });
    expect(b.join).toBe('connecting');
    expect(reduceNetLobby(b, { type: 'retry' })).toBe(b);
  });

  it('« retour » depuis la connexion revient au choix, avec un message éventuel ; le salon se quitte vers le menu', () => {
    const msg = { key: 'net.lobby.copy.done', tone: 'info' as const };
    const s = run(createNetLobbyState('webrtc'), { type: 'chooseJoin' }, { type: 'back', message: msg });
    expect([s.step, s.message]).toEqual(['choose', msg]);
    expect(backOutcome(createNetLobbyState('webrtc'))).toBe('menu');
    expect(backOutcome(run(createNetLobbyState('webrtc'), { type: 'chooseJoin' }))).toBe('choose');
    expect(backOutcome(run(createNetLobbyState('webrtc'), { type: 'chooseHost' }))).toBe('menu');
    expect(backOutcome(createReturnState('webrtc', 'client'))).toBe('menu');
  });

  it('retour de partie : salon du rôle, message de fin en information', () => {
    const host = createReturnState('webrtc', 'host', { code: 'levelCompleted' });
    expect([host.step, host.message]).toEqual(['host', { key: 'net.notice.levelCompleted', tone: 'info' }]);
    const guest = createReturnState('broadcast', 'client');
    expect([guest.step, guest.message]).toEqual(['guest', null]);
  });

  it('le message se pose et s\'efface', () => {
    const m = { key: 'net.lobby.copy.manual', tone: 'info' as const };
    let s = run(createNetLobbyState('webrtc'), { type: 'message', message: m });
    expect(s.message).toBe(m);
    expect(reduceNetLobby(s, { type: 'message', message: m })).toBe(s);
    s = run(s, { type: 'message', message: null });
    expect(s.message).toBeNull();
  });
});

// ───────────────────────────── Réducteur : invitations de l'hôte ─────────────────────────────

describe('réducteur : invitations de l\'hôte', () => {
  const host = (): NetLobbyState => run(createNetLobbyState('webrtc'), { type: 'chooseHost' });

  it('cycle complet d\'une invitation : creating → ready → accepting → connected', () => {
    let s = run(host(), { type: 'inviteStarted' });
    expect(s.invites).toEqual([{ id: 1, status: 'creating', code: null, errorCode: null }]);
    expect(activeInvite(s)?.id).toBe(1);
    s = run(s, { type: 'inviteReady', id: 1, code: 'V1Oxyz' });
    expect(s.invites[0]).toMatchObject({ status: 'ready', code: 'V1Oxyz' });
    s = run(s, { type: 'inviteAccepting', id: 1 });
    expect(s.invites[0].status).toBe('accepting');
    expect(liveInvites(s)).toHaveLength(1);
    s = run(s, { type: 'inviteConnected', id: 1 });
    expect(s.invites[0].status).toBe('connected');
    expect(liveInvites(s)).toHaveLength(0);
    expect(activeInvite(s)).toBeNull();
  });

  it('les identifiants d\'invitation croissent ; une invitation par invité', () => {
    let s = run(host(), { type: 'inviteStarted' }, { type: 'inviteReady', id: 1, code: 'a' }, { type: 'inviteAccepting', id: 1 }, { type: 'inviteConnected', id: 1 });
    s = run(s, { type: 'inviteStarted' });
    expect(s.invites.map((i) => i.id)).toEqual([1, 2]);
    expect(activeInvite(s)?.id).toBe(2);
  });

  it('une transition invalide est ignorée (réponse tardive, id inconnu)', () => {
    const s = run(host(), { type: 'inviteStarted' });
    expect(reduceNetLobby(s, { type: 'inviteAccepting', id: 1 })).toBe(s); // pas encore prête
    expect(reduceNetLobby(s, { type: 'inviteReady', id: 99, code: 'x' })).toBe(s);
    expect(reduceNetLobby(s, { type: 'inviteConnected', id: 1 })).toBe(s);
    const ready = run(s, { type: 'inviteReady', id: 1, code: 'x' });
    expect(reduceNetLobby(ready, { type: 'inviteReady', id: 1, code: 'y' })).toBe(ready); // déjà prête
  });

  it('un échec garde l\'invitation visible avec son erreur et pose le message ; elle ne compte plus comme en cours', () => {
    const s = run(host(), { type: 'inviteStarted' }, { type: 'inviteReady', id: 1, code: 'x' }, { type: 'inviteAccepting', id: 1 }, { type: 'inviteFailed', id: 1, error: 'failed' });
    expect(s.invites[0]).toMatchObject({ status: 'failed', errorCode: 'failed' });
    expect(s.message).toEqual({ key: 'net.rtc.error.failed', tone: 'error' });
    expect(activeInvite(s)?.id).toBe(1);
    expect(liveInvites(s)).toHaveLength(0);
    expect(reduceNetLobby(s, { type: 'inviteFailed', id: 1, error: 'iceTimeout' })).toBe(s);
  });

  it('code de réponse illisible (inviteRetry) : l\'invitation redevient « ready », son code est conservé, le message explique l\'erreur', () => {
    const acc = run(host(), { type: 'inviteStarted' }, { type: 'inviteReady', id: 1, code: 'V1Oxyz' }, { type: 'inviteAccepting', id: 1 });
    const s = run(acc, { type: 'inviteRetry', id: 1, error: 'badCode' });
    expect(s.invites[0]).toMatchObject({ status: 'ready', code: 'V1Oxyz' });
    expect(s.message).toEqual({ key: 'net.rtc.error.badCode', tone: 'error' });
    expect(liveInvites(s)).toHaveLength(1);
    expect(activeInvite(s)?.status).toBe('ready');
    // on peut recoller (accepting de nouveau)
    expect(run(s, { type: 'inviteAccepting', id: 1 }).invites[0].status).toBe('accepting');
    // hors de sa place : ignoré
    expect(reduceNetLobby(s, { type: 'inviteRetry', id: 1, error: 'badCode' })).toBe(s);
    expect(reduceNetLobby(acc, { type: 'inviteRetry', id: 99, error: 'badCode' })).toBe(acc);
  });

  it('pastilles : ni invitation connectée (périmée) ni plus de 3 ; une nouvelle invitation écarte les échecs', () => {
    let s = run(host(), { type: 'inviteStarted' }, { type: 'inviteReady', id: 1, code: 'a' }, { type: 'inviteAccepting', id: 1 }, { type: 'inviteConnected', id: 1 });
    expect(chipInvites(s)).toEqual([]);
    s = run(s, { type: 'inviteStarted' }, { type: 'inviteFailed', id: 2, error: 'failed' });
    expect(chipInvites(s).map((i) => i.id)).toEqual([2]);
    s = run(s, { type: 'inviteStarted' });
    expect(s.invites.map((i) => i.id)).toEqual([1, 3]);
    expect(chipInvites(s).map((i) => i.id)).toEqual([3]);
    const many = { ...s, invites: [1, 2, 3, 4, 5].map((id) => ({ id, status: 'ready' as const, code: 'x', errorCode: null })) };
    expect(chipInvites(many).map((i) => i.id)).toEqual([3, 4, 5]);
  });

  it('needsCloseConfirm : seulement l\'hôte avec au moins un invité connecté', () => {
    const withGuest = lobby([slot({ slot: 0, isHost: true }), slot({ slot: 1 })]);
    const alone = lobby([slot({ slot: 0, isHost: true })]);
    expect(needsCloseConfirm(host(), withGuest)).toBe(true);
    expect(needsCloseConfirm(host(), alone)).toBe(false);
    expect(needsCloseConfirm(host(), null)).toBe(false);
    expect(needsCloseConfirm(createNetLobbyState('webrtc'), withGuest)).toBe(false);
  });

  it('écarter une invitation la retire ; une invitation connectée ne s\'écarte pas', () => {
    let s = run(host(), { type: 'inviteStarted' }, { type: 'inviteReady', id: 1, code: 'x' }, { type: 'inviteDismissed', id: 1 });
    expect(s.invites).toEqual([]);
    s = run(s, { type: 'inviteStarted' }, { type: 'inviteReady', id: 2, code: 'x' }, { type: 'inviteAccepting', id: 2 }, { type: 'inviteConnected', id: 2 });
    expect(reduceNetLobby(s, { type: 'inviteDismissed', id: 2 })).toBe(s);
    expect(reduceNetLobby(s, { type: 'inviteDismissed', id: 99 })).toBe(s);
  });

  it('canInvite : WebRTC seulement, une invitation à la fois, jamais au-delà de 3 invités', () => {
    const empty = lobby([slot({ slot: 0 })]);
    const s0 = host();
    expect(canInvite(s0, empty)).toBe(true);
    expect(canInvite(s0, null)).toBe(true);
    const busy = run(s0, { type: 'inviteStarted' });
    expect(canInvite(busy, empty)).toBe(false);
    const done = run(busy, { type: 'inviteFailed', id: 1, error: 'failed' });
    expect(canInvite(done, empty)).toBe(true); // une invitation échouée se remplace
    const full = lobby([slot({ slot: 0 }), slot({ slot: 1 }), slot({ slot: 2 }), slot({ slot: 3 })]);
    expect(guestCount(full)).toBe(MAX_GUESTS);
    expect(canInvite(s0, full)).toBe(false);
    const two = lobby([slot({ slot: 0 }), slot({ slot: 1 }), slot({ slot: 2 })]);
    expect(canInvite(s0, two)).toBe(true);
    expect(canInvite(run(createNetLobbyState('broadcast'), { type: 'chooseHost' }), empty)).toBe(false);
    expect(canInvite(createNetLobbyState('webrtc'), empty)).toBe(false);
  });
});

// ───────────────────────────── Salon : personnages, lancement, lignes ─────────────────────────────

describe('personnages selon l\'état du salon', () => {
  const l = lobby([
    slot({ slot: 0, characterId: 'david', ready: true }),
    slot({ slot: 1, characterId: 'sandrine', ready: false }),
    slot({ slot: 2, characterId: 'romain', ready: true, connected: false }),
  ]);

  it('seuls les personnages des autres participants CONNECTÉS et PRÊTS sont pris', () => {
    expect([...takenCharacters(l, 1)]).toEqual(['david']);
    expect([...takenCharacters(l, 0)]).toEqual([]);
    expect([...takenCharacters(l, null)]).toEqual(['david']);
  });

  it('disponibilité : free / mine / taken', () => {
    const a = characterAvailability(l, 1);
    expect(a.david).toBe('taken');
    expect(a.sandrine).toBe('mine');
    expect(a.romain).toBe('free'); // son propriétaire est déconnecté
    expect(a.valentine).toBe('free');
    expect(Object.keys(a)).toEqual([...CHARACTER_IDS]);
  });

  it('premier personnage libre en sautant les pris', () => {
    expect(firstFreeCharacter(l, 1)).toBe('sandrine');
    expect(firstFreeCharacter(l, 0)).toBe('david');
    const all = lobby(CHARACTER_IDS.slice(0, 4).map((id, i) => slot({ slot: i as 0 | 1 | 2 | 3, characterId: id, ready: true })));
    expect(firstFreeCharacter(all, 0)).toBe('david'); // le sien reste libre pour lui
    expect(firstFreeCharacter(all, null)).toBe('aelith');
  });

  it('stepCharacter : saute les pris, boucle dans les deux sens, reste en place s\'il n\'y a rien d\'autre', () => {
    expect(stepCharacter(l, 1, 'sandrine', 1)).toBe('romain');
    expect(stepCharacter(l, 1, 'sandrine', -1)).toBe('mira'); // david est pris : on saute et on boucle
    expect(stepCharacter(l, 1, 'mira', 1)).toBe('sandrine'); // david pris
    // tout est pris par les autres (situation impossible à 4 participants et 8 personnages, mais la fonction doit rester sûre)
    const crowded = lobby([
      slot({ slot: 0, characterId: 'david', ready: false }),
      ...CHARACTER_IDS.slice(1).map((id, i) => slot({ slot: ((i % 3) + 1) as 1 | 2 | 3, characterId: id, ready: true })),
    ]);
    expect(stepCharacter(crowded, 0, 'david', 1)).toBe('david');
  });

  it('stepDifficulty et stepLevelIndex bouclent', () => {
    expect(stepDifficulty(1, 1)).toBe(2);
    expect(stepDifficulty(3, 1)).toBe(1);
    expect(stepDifficulty(1, -1)).toBe(3);
    expect(stepDifficulty(2, -1)).toBe(1);
    expect(stepLevelIndex(0, -1, 9)).toBe(8);
    expect(stepLevelIndex(8, 1, 9)).toBe(0);
    expect(stepLevelIndex(3, 1, 9)).toBe(4);
    expect(stepLevelIndex(3, 1, 0)).toBe(0);
  });
});

describe('lancement et lignes du salon', () => {
  it('hostStartCheck : 2 participants connectés au moins, tous les invités prêts (l\'hôte se met prêt au clic)', () => {
    expect(hostStartCheck(lobby([slot({ slot: 0 })]))).toEqual({ ok: false, reason: 'needTwo' });
    expect(hostStartCheck(lobby([slot({ slot: 0 }), slot({ slot: 1, connected: false, ready: true })]))).toEqual({ ok: false, reason: 'needTwo' });
    expect(hostStartCheck(lobby([slot({ slot: 0 }), slot({ slot: 1, ready: false })]))).toEqual({ ok: false, reason: 'notReady' });
    expect(hostStartCheck(lobby([slot({ slot: 0, ready: false }), slot({ slot: 1, ready: true })]))).toEqual({ ok: true });
    expect(hostStartCheck(lobby([slot({ slot: 0 }), slot({ slot: 1, ready: true }), slot({ slot: 2, ready: false })]))).toEqual({ ok: false, reason: 'notReady' });
    // un invité perdu ne bloque pas
    expect(hostStartCheck(lobby([slot({ slot: 0 }), slot({ slot: 1, ready: true }), slot({ slot: 2, ready: false, connected: false })]))).toEqual({ ok: true });
    expect(connectedCount(lobby([slot({ slot: 0 }), slot({ slot: 1, connected: false })]))).toBe(1);
  });

  it('participantRows : tri par emplacement, statut, ping arrondi, appareil local', () => {
    const rows = participantRows(
      lobby([
        slot({ slot: 2, ready: true, pingMs: 41.6 }),
        slot({ slot: 0, pingMs: 0 }),
        slot({ slot: 1, connected: false, pingMs: 12 }),
        slot({ slot: 3, ready: false }),
      ]),
      2,
    );
    expect(rows.map((r) => r.slot)).toEqual([0, 1, 2, 3]);
    expect(rows.map((r) => r.status)).toEqual(['host', 'lost', 'ready', 'choosing']);
    expect(rows.map((r) => r.pingMs)).toEqual([null, 12, 42, null]);
    expect(rows.map((r) => r.isLocal)).toEqual([false, false, true, false]);
    expect(rows[0].characterNameKey).toBe('character.david.name');
  });
});

// ───────────────────────────── Actions disponibles ─────────────────────────────

describe('lobbyActions', () => {
  const ids = (s: NetLobbyState, ctx: Parameters<typeof lobbyActions>[1]): string[] => lobbyActions(s, ctx).map((a) => a.id);
  const ctx = (l: LobbyState | null, localSlot: number | null = 0, rtcSupported = true): Parameters<typeof lobbyActions>[1] => ({ lobby: l, localSlot, rtcSupported });

  it('choix : héberger, rejoindre, retour ; sans WebRTC, héberger et rejoindre sont bloqués avec le bon message (pas en BroadcastChannel)', () => {
    const rtc = createNetLobbyState('webrtc');
    expect(ids(rtc, ctx(null))).toEqual(['host', 'join', 'back']);
    expect(lobbyActions(rtc, ctx(null)).every((a) => a.enabled)).toBe(true);
    const off = lobbyActions(rtc, ctx(null, 0, false));
    expect(off.map((a) => a.enabled)).toEqual([false, false, true]);
    expect(off[0].blocked).toEqual({ key: 'net.rtc.error.unsupported', tone: 'error' });
    const bc = lobbyActions(createNetLobbyState('broadcast'), ctx(null, 0, false));
    expect(bc.every((a) => a.enabled)).toBe(true);
  });

  it('hôte : « Lancer » suit hostStartCheck avec la raison ; « Inviter » seulement en WebRTC', () => {
    const rtc = run(createNetLobbyState('webrtc'), { type: 'chooseHost' });
    const alone = lobby([slot({ slot: 0 })]);
    expect(ids(rtc, ctx(alone))).toEqual(['level', 'character', 'difficulty', 'invite', 'start', 'back']);
    const start = lobbyActions(rtc, ctx(alone)).find((a) => a.id === 'start');
    expect(start).toMatchObject({ enabled: false, blocked: { key: 'net.lobby.start.needTwo' } });
    const notReady = lobby([slot({ slot: 0 }), slot({ slot: 1 })]);
    expect(lobbyActions(rtc, ctx(notReady)).find((a) => a.id === 'start')?.blocked?.key).toBe('net.lobby.start.notReady');
    const ok = lobby([slot({ slot: 0 }), slot({ slot: 1, ready: true })]);
    expect(lobbyActions(rtc, ctx(ok)).find((a) => a.id === 'start')).toMatchObject({ enabled: true });
    const bc = run(createNetLobbyState('broadcast'), { type: 'chooseHost' });
    expect(ids(bc, ctx(ok))).toEqual(['level', 'character', 'difficulty', 'start', 'back']);
    expect(lobbyActions(rtc, ctx(null)).find((a) => a.id === 'start')?.enabled).toBe(false);
  });

  it('hôte : « Inviter » signale un salon complet', () => {
    const rtc = run(createNetLobbyState('webrtc'), { type: 'chooseHost' });
    const full = lobby([slot({ slot: 0 }), slot({ slot: 1 }), slot({ slot: 2 }), slot({ slot: 3 })]);
    expect(lobbyActions(rtc, ctx(full)).find((a) => a.id === 'invite')).toMatchObject({ enabled: false, blocked: { key: 'net.lobby.invite.full' } });
    const busy = run(rtc, { type: 'inviteStarted' });
    expect(lobbyActions(busy, ctx(lobby([slot({ slot: 0 })]))).find((a) => a.id === 'invite')).toMatchObject({ enabled: false, blocked: undefined });
  });

  it('connexion de l\'invité : saisie du code, réessayer, retour', () => {
    const code = run(createNetLobbyState('webrtc'), { type: 'chooseJoin' });
    expect(ids(code, ctx(null))).toEqual(['submitCode', 'back']);
    const creating = run(code, { type: 'joinSubmitted' });
    expect(ids(creating, ctx(null))).toEqual(['back']);
    const failed = run(creating, { type: 'joinFailed', message: { key: 'x', tone: 'error' } });
    expect(ids(failed, ctx(null))).toEqual(['retry', 'back']);
    const bc = run(createNetLobbyState('broadcast'), { type: 'chooseJoin' });
    expect(ids(bc, ctx(null))).toEqual(['back']);
  });

  it('invité : prêt verrouille personnage et difficulté ; sans emplacement, rien n\'est activable', () => {
    const guest = createReturnState('webrtc', 'client');
    const free = lobby([slot({ slot: 0, ready: true }), slot({ slot: 1, ready: false })]);
    const a = lobbyActions(guest, ctx(free, 1));
    expect(a.map((x) => [x.id, x.enabled])).toEqual([
      ['character', true],
      ['difficulty', true],
      ['ready', true],
      ['back', true],
    ]);
    const locked = lobby([slot({ slot: 0, ready: true }), slot({ slot: 1, ready: true })]);
    expect(lobbyActions(guest, ctx(locked, 1)).map((x) => [x.id, x.enabled])).toEqual([
      ['character', false],
      ['difficulty', false],
      ['ready', true],
      ['back', true],
    ]);
    expect(lobbyActions(guest, ctx(null, null)).map((x) => [x.id, x.enabled])).toEqual([
      ['character', false],
      ['difficulty', false],
      ['ready', false],
      ['back', true],
    ]);
  });
});

// ───────────────────────────── Géométrie DOM ─────────────────────────────

describe('logicalToCss', () => {
  it('met à l\'échelle et décale selon le canvas', () => {
    const r = logicalToCss({ x: 100, y: 50, w: 200, h: 40 }, { left: 10, top: 20, width: 640, height: 360 }, 1280);
    expect(r).toEqual({ left: 10 + 50, top: 20 + 25, width: 100, height: 20, scale: 0.5 });
  });

  it('impose une taille tactile minimale en grandissant autour du centre vertical', () => {
    const r = logicalToCss({ x: 0, y: 100, w: 100, h: 40 }, { left: 0, top: 0, width: 640, height: 360 }, 1280, { minW: 60, minH: 44 });
    expect(r.height).toBe(44);
    expect(r.top).toBe(50 - 12); // 100 * 0.5 = 50 ; (44 - 20) / 2 = 12 au-dessus
    expect(r.width).toBe(60);
  });

  it('largeur logique nulle ou canvas vide : échelle 1, pas de NaN', () => {
    const r = logicalToCss({ x: 5, y: 5, w: 10, h: 10 }, { left: 0, top: 0, width: 0, height: 0 }, 0);
    expect(r.scale).toBe(1);
    expect(Number.isFinite(r.width)).toBe(true);
  });
});

// ───────────────────────────── Complément : erreurs de signalisation ─────────────────────────────

describe('erreurs de signalisation', () => {
  it('RTC_ERROR_CODES couvre exactement RtcSignalingErrorCode', () => {
    const all: Record<RtcSignalingErrorCode, true> = { unsupported: true, badCode: true, wrongVersion: true, iceTimeout: true, failed: true, cancelled: true };
    expect([...RTC_ERROR_CODES].sort()).toEqual(Object.keys(all).sort());
  });
});
