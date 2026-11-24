/**
 * Tests de la lecture de QR codes du salon réseau (logique pure de `netLobbyLogic.ts`) : états « scan en cours / erreur / contenu ignoré », tri d'un texte lu,
 * et mise en page des panneaux QR (paysage 1280 × 720, téléphones paysage, portrait) : rien ne sort de l'écran, rien ne se chevauche, aucun bouton du salon ne passe
 * devant la manette virtuelle tactile, le QR code est grand.
 */
import { describe, expect, it } from 'vitest';
import { GAME_HEIGHT, GAME_WIDTH } from '../core/constants';
import { codeChecksum } from '../net/rtcCodec';
import {
  activeInvite,
  classifyScannedText,
  createNetLobbyState,
  cssToLogical,
  DEFAULT_VIEW_METRICS,
  guestAnswerLayout,
  guestCodeLayout,
  hostInviteLayout,
  isActivationKey,
  logicalToCss,
  metricsSignature,
  messageFromScanError,
  portraitMessageRect,
  reduceNetLobby,
  rectsOverlap,
  scanButtonState,
  scanCoveredByRotatePrompt,
  scanIgnoreFromError,
  scanIgnoredKey,
  scanTargetAvailable,
  scanZoneLayout,
  touchPadZones,
  viewMetrics,
  type LogicalRect,
  type NetLobbyEvent,
  type NetLobbyState,
  type ScanErrorKind,
  type ScanIgnore,
  type ViewMetrics,
} from './netLobbyLogic';

function run(state: NetLobbyState, ...events: NetLobbyEvent[]): NetLobbyState {
  return events.reduce(reduceNetLobby, state);
}

/** Hôte WebRTC avec une invitation prête (code bidon), prêt à lire la réponse. */
function hostWithReadyInvite(): NetLobbyState {
  return run(createNetLobbyState('webrtc'), { type: 'chooseHost' }, { type: 'inviteStarted' }, { type: 'inviteReady', id: 1, code: 'V1Oabcde' });
}

/** Invité WebRTC à la saisie du code d'invitation. */
function guestAtCode(): NetLobbyState {
  return run(createNetLobbyState('webrtc'), { type: 'chooseJoin' });
}

/** Code valide de forme (la somme de contrôle n'est vérifiée que par `decodeSignalCode`, hors de ce module). */
function shapedCode(kind: 'O' | 'A', version = 1): string {
  const body = `V${version}${kind}abcDEF_-0123`;
  return body + codeChecksum(body);
}

// ───────────────────────────── États de la lecture ─────────────────────────────

describe('réducteur : lecture de QR codes', () => {
  it('l\'état initial n\'a aucune lecture et aucun scan désactivé', () => {
    const s = createNetLobbyState('webrtc');
    expect(s.scan).toBeNull();
    expect(s.scanDisabled).toBeNull();
  });

  it('l\'invité ouvre la lecture de l\'invitation à la saisie du code ; une seule lecture à la fois', () => {
    let s = run(guestAtCode(), { type: 'scanOpen', target: 'invite' });
    expect(s.scan).toEqual({ target: 'invite', phase: 'starting', ignored: null });
    const again = reduceNetLobby(s, { type: 'scanOpen', target: 'invite' });
    expect(again).toBe(s);
    s = reduceNetLobby(s, { type: 'scanActive' });
    expect(s.scan?.phase).toBe('active');
    expect(reduceNetLobby(s, { type: 'scanActive' })).toBe(s);
  });

  it('la lecture n\'existe qu\'à sa place : pas de réponse à lire sans invitation prête, pas d\'invitation à lire hors saisie, pas en BroadcastChannel', () => {
    expect(reduceNetLobby(createNetLobbyState('webrtc'), { type: 'scanOpen', target: 'invite' }).scan).toBeNull(); // écran de choix
    expect(reduceNetLobby(guestAtCode(), { type: 'scanOpen', target: 'answer' }).scan).toBeNull();
    const creating = run(createNetLobbyState('webrtc'), { type: 'chooseHost' }, { type: 'inviteStarted' });
    expect(reduceNetLobby(creating, { type: 'scanOpen', target: 'answer' }).scan).toBeNull(); // invitation pas encore prête
    expect(reduceNetLobby(hostWithReadyInvite(), { type: 'scanOpen', target: 'invite' }).scan).toBeNull();
    const bc = run(createNetLobbyState('broadcast'), { type: 'chooseJoin' });
    expect(reduceNetLobby(bc, { type: 'scanOpen', target: 'invite' }).scan).toBeNull();
    expect(scanTargetAvailable(hostWithReadyInvite(), 'answer')).toBe(true);
    expect(scanTargetAvailable(guestAtCode(), 'invite')).toBe(true);
  });

  it('l\'hôte lit la réponse d\'une invitation prête', () => {
    const s = run(hostWithReadyInvite(), { type: 'scanOpen', target: 'answer' });
    expect(s.scan?.target).toBe('answer');
  });

  it('un contenu ignoré est noté dans la lecture sans la fermer, ni consommer l\'invitation ; il s\'efface', () => {
    let s = run(hostWithReadyInvite(), { type: 'scanOpen', target: 'answer' }, { type: 'scanActive' }, { type: 'scanIgnored', reason: 'wrongKind' });
    expect(s.scan?.ignored).toBe('wrongKind');
    expect(activeInvite(s)?.status).toBe('ready');
    expect(reduceNetLobby(s, { type: 'scanIgnored', reason: 'wrongKind' })).toBe(s);
    s = reduceNetLobby(s, { type: 'scanIgnoredClear' });
    expect(s.scan?.ignored).toBeNull();
    expect(reduceNetLobby(s, { type: 'scanIgnoredClear' })).toBe(s);
    expect(reduceNetLobby(createNetLobbyState('webrtc'), { type: 'scanIgnored', reason: 'notCode' }).scan).toBeNull(); // pas de lecture : sans effet
  });

  it('fermeture : annulation, puis événements hors lecture sans effet', () => {
    const open = run(guestAtCode(), { type: 'scanOpen', target: 'invite' });
    expect(reduceNetLobby(open, { type: 'scanClosed' }).scan).toBeNull();
    const none = guestAtCode();
    expect(reduceNetLobby(none, { type: 'scanClosed' })).toBe(none);
    expect(reduceNetLobby(none, { type: 'scanActive' })).toBe(none);
  });

  it('la lecture se ferme d\'office quand sa cible disparaît (code soumis, invitation acceptée / annulée, retour)', () => {
    const guest = run(guestAtCode(), { type: 'scanOpen', target: 'invite' });
    expect(reduceNetLobby(guest, { type: 'joinSubmitted' }).scan).toBeNull();
    expect(reduceNetLobby(guest, { type: 'back' }).scan).toBeNull();
    const host = run(hostWithReadyInvite(), { type: 'scanOpen', target: 'answer' });
    expect(reduceNetLobby(host, { type: 'inviteAccepting', id: 1 }).scan).toBeNull();
    expect(reduceNetLobby(host, { type: 'inviteDismissed', id: 1 }).scan).toBeNull();
    expect(reduceNetLobby(host, { type: 'inviteFailed', id: 1, error: 'failed' }).scan).toBeNull();
  });

  it('erreur de caméra : message traduit et retour au copier-coller ; les causes définitives désactivent le bouton, pas un refus ou un échec', () => {
    const open = run(guestAtCode(), { type: 'scanOpen', target: 'invite' });
    const denied = reduceNetLobby(open, { type: 'scanFailed', error: 'denied' });
    expect(denied.scan).toBeNull();
    expect(denied.message).toEqual(messageFromScanError('denied'));
    expect(denied.message).toEqual({ key: 'net.scan.error.denied', tone: 'error' });
    expect(denied.scanDisabled).toBeNull();
    for (const error of ['noCamera', 'unsupported', 'insecure'] as const) {
      const s = reduceNetLobby(open, { type: 'scanFailed', error });
      expect(s.scanDisabled).toBe(error);
    }
    expect(reduceNetLobby(open, { type: 'scanFailed', error: 'failed' }).scanDisabled).toBeNull();
    expect(reduceNetLobby(guestAtCode(), { type: 'scanFailed', error: 'noCamera' }).scanDisabled).toBeNull(); // pas de lecture : sans effet
  });

  it('le scan désactivé survit au retour au choix', () => {
    const failed = run(guestAtCode(), { type: 'scanOpen', target: 'invite' }, { type: 'scanFailed', error: 'noCamera' });
    expect(reduceNetLobby(failed, { type: 'back' }).scanDisabled).toBe('noCamera');
  });

  it('ouvrir une lecture efface le message précédent', () => {
    const s = run(guestAtCode(), { type: 'message', message: { key: 'net.lobby.code.empty', tone: 'error' } }, { type: 'scanOpen', target: 'invite' });
    expect(s.message).toBeNull();
  });
});

describe('scanButtonState', () => {
  it('disponible seulement si la caméra est prise en charge et pas désactivée', () => {
    const s = guestAtCode();
    expect(scanButtonState(s, 'ok')).toEqual({ available: true, reason: null });
    for (const support of ['unsupported', 'insecure', 'noCamera', 'denied', 'failed'] as const) {
      expect(scanButtonState(s, support)).toEqual({ available: false, reason: support });
    }
    const off = run(s, { type: 'scanOpen', target: 'invite' }, { type: 'scanFailed', error: 'insecure' });
    expect(scanButtonState(off, 'ok')).toEqual({ available: false, reason: 'insecure' });
  });
});

// ───────────────────────────── Tri du texte lu ─────────────────────────────

describe('classifyScannedText', () => {
  it('accepte un code de la bonne version et du bon genre (blancs ignorés)', () => {
    const invite = shapedCode('O');
    expect(classifyScannedText(invite, 'invite')).toEqual({ ok: true, code: invite });
    expect(classifyScannedText(` ${invite.slice(0, 5)} ${invite.slice(5)}\n`, 'invite')).toEqual({ ok: true, code: invite });
    const answer = shapedCode('A');
    expect(classifyScannedText(answer, 'answer')).toEqual({ ok: true, code: answer });
  });

  it('un code du mauvais genre est « wrongKind » (réponse scannée à la place d\'une invitation et inversement)', () => {
    expect(classifyScannedText(shapedCode('A'), 'invite')).toEqual({ ok: false, reason: 'wrongKind' });
    expect(classifyScannedText(shapedCode('O'), 'answer')).toEqual({ ok: false, reason: 'wrongKind' });
  });

  it('une autre version du format est « wrongVersion »', () => {
    expect(classifyScannedText(shapedCode('O', 2), 'invite')).toEqual({ ok: false, reason: 'wrongVersion' });
    expect(classifyScannedText(shapedCode('A', 7), 'answer')).toEqual({ ok: false, reason: 'wrongVersion' });
  });

  it('tout autre contenu est « notCode » : adresse web, texte libre, vide, caractères hors alphabet, trop long, sans préfixe', () => {
    const others = ['https://example.com/x?y=1', 'bonjour tout le monde', '', '   ', '{"sdp":"v=0"}', 'V1O+/==', 'abcdefghij', `V1O${'a'.repeat(5000)}`, 'V1X' + 'a'.repeat(20)];
    for (const text of others) expect(classifyScannedText(text, 'invite')).toEqual({ ok: false, reason: 'notCode' });
    expect(classifyScannedText(undefined as unknown as string, 'invite')).toEqual({ ok: false, reason: 'notCode' });
  });

  it('scanIgnoreFromError : autre version, sinon illisible', () => {
    expect(scanIgnoreFromError(Object.assign(new Error('x'), { code: 'wrongVersion' }))).toBe('wrongVersion');
    expect(scanIgnoreFromError(Object.assign(new Error('x'), { code: 'badCode' }))).toBe('badCode');
    expect(scanIgnoreFromError(new Error('autre'))).toBe('badCode');
    expect(scanIgnoreFromError(null)).toBe('badCode');
  });

  it('clés de message des contenus ignorés', () => {
    const reasons: ScanIgnore[] = ['notCode', 'badCode', 'wrongVersion', 'otherInvite'];
    for (const r of reasons) expect(scanIgnoredKey(r, 'invite')).toBe(`net.scan.ignored.${r}`);
    expect(scanIgnoredKey('wrongKind', 'invite')).toBe('net.scan.ignored.wrongKind.invite');
    expect(scanIgnoredKey('wrongKind', 'answer')).toBe('net.scan.ignored.wrongKind.answer');
    const kinds: ScanErrorKind[] = ['unsupported', 'insecure', 'denied', 'noCamera', 'failed'];
    for (const k of kinds) expect(messageFromScanError(k).key).toBe(`net.scan.error.${k}`);
  });
});

// ───────────────────────────── Mise en page ─────────────────────────────

/** Rectangle du canvas (Scale.FIT centré, 16:9) dans une fenêtre `vw × vh`. */
function fit(vw: number, vh: number): ViewMetrics {
  const w = Math.min(vw, (vh * GAME_WIDTH) / GAME_HEIGHT);
  const h = (w * GAME_HEIGHT) / GAME_WIDTH;
  return viewMetrics({ left: (vw - w) / 2, top: (vh - h) / 2, width: w, height: h }, { width: vw, height: vh });
}

const LANDSCAPE: Array<[string, ViewMetrics]> = [
  ['ordinateur 1280 × 720', fit(1280, 720)],
  ['ordinateur 1920 × 1080', fit(1920, 1080)],
  ['téléphone 667 × 375', fit(667, 375)],
  ['téléphone 812 × 375', fit(812, 375)],
  ['téléphone 740 × 360', fit(740, 360)],
  ['téléphone 640 × 360', fit(640, 360)],
  ['petit téléphone 568 × 320', fit(568, 320)],
  ['tablette 1024 × 768', fit(1024, 768)],
];
const PORTRAIT: Array<[string, ViewMetrics]> = [
  ['téléphone 375 × 812', fit(375, 812)],
  ['téléphone 360 × 640', fit(360, 640)],
  ['fenêtre 800 × 1000', fit(800, 1000)],
];

/** Rectangle réellement occupé par un élément DOM (hauteur tactile minimale, largeur minimale pour un bouton), en pixels logiques. */
function grown(rect: LogicalRect, m: ViewMetrics, button: boolean): LogicalRect {
  const c = logicalToCss(rect, m.box, GAME_WIDTH, { minW: button ? 44 : undefined, minH: 44 });
  return cssToLogical(c.left, c.top, c.width, c.height, m);
}

/** Rectangle en pixels CSS dans la fenêtre. */
function css(rect: LogicalRect, m: ViewMetrics): { left: number; top: number; right: number; bottom: number } {
  const c = logicalToCss(rect, m.box, GAME_WIDTH);
  return { left: c.left, top: c.top, right: c.left + c.width, bottom: c.top + c.height };
}

function insideViewport(rect: LogicalRect, m: ViewMetrics): boolean {
  const c = css(rect, m);
  return c.left >= -0.5 && c.top >= -0.5 && c.right <= m.viewport.width + 0.5 && c.bottom <= m.viewport.height + 0.5;
}

interface Item {
  name: string;
  rect: LogicalRect;
  kind: 'button' | 'field' | 'qr' | 'label' | 'row';
}

function noOverlap(items: Item[], m: ViewMetrics): void {
  const placed = items.map((i) => ({ ...i, box: i.kind === 'button' ? grown(i.rect, m, true) : i.kind === 'field' ? grown(i.rect, m, false) : i.rect }));
  for (let a = 0; a < placed.length; a++) {
    for (let b = a + 1; b < placed.length; b++) {
      const overlap = rectsOverlap(placed[a].box, placed[b].box);
      expect(overlap, `${placed[a].name} / ${placed[b].name}`).toBe(false);
    }
  }
}

/** Les boutons ne passent ni devant le stick ni devant un bouton de la manette ; les champs ne passent pas devant ses boutons. */
function clearOfPad(items: Item[], m: ViewMetrics): void {
  const pad = touchPadZones(m);
  for (const i of items) {
    if (i.kind !== 'button' && i.kind !== 'field') continue;
    const box = grown(i.rect, m, i.kind === 'button');
    for (const z of pad.buttons) expect(rectsOverlap(box, z), `${i.name} / bouton de la manette`).toBe(false);
    if (i.kind === 'button') expect(rectsOverlap(box, pad.stick), `${i.name} / stick`).toBe(false);
  }
}

describe('mesures de l\'écran', () => {
  it('échelle, orientation et hauteur tactile logique', () => {
    expect(DEFAULT_VIEW_METRICS.scale).toBe(1);
    expect(DEFAULT_VIEW_METRICS.portrait).toBe(false);
    expect(DEFAULT_VIEW_METRICS.touchH).toBe(44);
    const phone = fit(667, 375);
    expect(phone.scale).toBeCloseTo(0.521, 2);
    expect(phone.touchH).toBeGreaterThanOrEqual(84);
    expect(phone.touchH).toBeLessThanOrEqual(86);
    expect(fit(375, 812).portrait).toBe(true);
    expect(fit(800, 800).portrait).toBe(false);
  });

  it('valeurs invalides : repli sur l\'écran de référence', () => {
    const m = viewMetrics({ left: 0, top: 0, width: 0, height: 0 }, { width: 0, height: 0 });
    expect(m.scale).toBe(1);
    expect(m.portrait).toBe(false);
  });

  it('la signature change avec l\'orientation, la taille de la fenêtre et du canvas, pas à l\'identique', () => {
    expect(metricsSignature(fit(667, 375))).toBe(metricsSignature(fit(667, 375)));
    expect(metricsSignature(fit(667, 375))).not.toBe(metricsSignature(fit(812, 375)));
    expect(metricsSignature(fit(375, 667))).not.toBe(metricsSignature(fit(667, 375)));
  });

  it('cssToLogical est l\'inverse de logicalToCss', () => {
    const m = fit(812, 375);
    const r: LogicalRect = { x: 100, y: 200, w: 300, h: 80 };
    const c = logicalToCss(r, m.box, GAME_WIDTH);
    const back = cssToLogical(c.left, c.top, c.width, c.height, m);
    expect(back.x).toBeCloseTo(r.x, 6);
    expect(back.y).toBeCloseTo(r.y, 6);
    expect(back.w).toBeCloseTo(r.w, 6);
    expect(back.h).toBeCloseTo(r.h, 6);
  });
});

describe('manette virtuelle : zones occupées', () => {
  it('sur 667 × 375 : stick en bas à gauche, losange en bas à droite, pause en haut au centre', () => {
    const m = fit(667, 375);
    const pad = touchPadZones(m);
    expect(pad.stick.x).toBeLessThan(60);
    expect(pad.stick.y).toBeGreaterThan(400);
    expect(pad.buttons).toHaveLength(5);
    const xs = pad.buttons.slice(0, 4).map((z) => z.x + z.w / 2);
    expect(Math.min(...xs)).toBeGreaterThan(900);
    const pause = pad.buttons[4];
    expect(pause.x + pause.w / 2).toBeCloseTo(GAME_WIDTH / 2, 0);
    expect(pause.y).toBeLessThan(30);
  });
});

describe('mise en page paysage : panneau d\'invitation de l\'hôte', () => {
  for (const [name, m] of LANDSCAPE) {
    it(`${name} : dans l'écran, sans chevauchement, loin de la manette, grand QR code`, () => {
      const L = hostInviteLayout(m);
      expect(L.sheet).toBe(false);
      const items: Item[] = [
        { name: 'qr', rect: L.qr, kind: 'qr' },
        { name: 'header', rect: L.header, kind: 'label' },
        { name: 'scan', rect: L.scan, kind: 'button' },
        { name: 'cancel', rect: L.cancel, kind: 'button' },
        { name: 'code', rect: L.code, kind: 'field' },
        { name: 'copy', rect: L.copy, kind: 'button' },
        { name: 'answer', rect: L.answer, kind: 'field' },
        { name: 'paste', rect: L.paste, kind: 'button' },
        { name: 'validate', rect: L.validate, kind: 'button' },
      ];
      for (const i of items) expect(insideViewport(i.kind === 'button' ? grown(i.rect, m, true) : i.rect, m), i.name).toBe(true);
      noOverlap(items, m);
      clearOfPad(items.filter((i) => i.kind !== 'qr' && i.kind !== 'label'), m);
      // le QR code occupe plus de la moitié de la hauteur du canvas (donc de l'écran sur un téléphone)
      expect(Math.min(L.qr.w, L.qr.h) * m.scale).toBeGreaterThanOrEqual(m.box.height * 0.55);
      // il est dans la colonne gauche, les rangées Phaser « Niveau / Personnage / Difficulté » (jusqu'à y = 254) restent libres à droite
      expect(L.scan.y).toBeGreaterThanOrEqual(254);
      expect(L.qr.x + L.qr.w).toBeLessThanOrEqual(640);
      // les lignes « Lancer » / « Fermer le salon » (x 660..980, y 520..620) restent libres
      for (const r of [L.scan, L.cancel, L.answer, L.paste, L.validate]) {
        expect(rectsOverlap(grown(r, m, true), { x: 660, y: 498, w: 320, h: 130 }), 'lignes du bas').toBe(false);
      }
    });
  }
});

describe('mise en page paysage : saisie et réponse de l\'invité', () => {
  for (const [name, m] of LANDSCAPE) {
    it(`${name} : saisie du code d'invitation`, () => {
      const L = guestCodeLayout(m);
      expect(L.sheet).toBe(false);
      const items: Item[] = [
        { name: 'scan', rect: L.scan, kind: 'button' },
        { name: 'label', rect: L.label, kind: 'label' },
        { name: 'field', rect: L.field, kind: 'field' },
        { name: 'paste', rect: L.paste, kind: 'button' },
        { name: 'validate', rect: L.validate, kind: 'button' },
        // ligne « Retour » dessinée en bas (Phaser)
        { name: 'back', rect: { x: 390, y: 520, w: 500, h: 46 }, kind: 'row' },
      ];
      for (const i of items) expect(insideViewport(i.kind === 'button' ? grown(i.rect, m, true) : i.kind === 'field' ? grown(i.rect, m, false) : i.rect, m), i.name).toBe(true);
      noOverlap(items, m);
      clearOfPad(items, m);
    });

    it(`${name} : QR code de la réponse`, () => {
      const L = guestAnswerLayout(m);
      expect(L.sheet).toBe(false);
      const items: Item[] = [
        { name: 'qr', rect: L.qr, kind: 'qr' },
        { name: 'caption', rect: L.caption, kind: 'label' },
        { name: 'hint', rect: L.hint, kind: 'label' },
        { name: 'label', rect: L.label, kind: 'label' },
        { name: 'code', rect: L.code, kind: 'field' },
        { name: 'copy', rect: L.copy, kind: 'button' },
        { name: 'back', rect: L.back, kind: 'row' },
      ];
      for (const i of items) expect(insideViewport(i.kind === 'button' ? grown(i.rect, m, true) : i.kind === 'field' ? grown(i.rect, m, false) : i.rect, m), i.name).toBe(true);
      noOverlap(items, m);
      clearOfPad(items.filter((i) => i.kind !== 'qr' && i.kind !== 'label' && i.name !== 'back'), m);
      // la ligne « Retour » s'arrête avant le losange de la manette
      expect(rectsOverlap(L.back, touchPadZones(m).buttons[1])).toBe(false);
      expect(Math.min(L.qr.w, L.qr.h) * m.scale).toBeGreaterThanOrEqual(m.viewport.height * 0.55);
    });
  }
});

describe('zone caméra', () => {
  for (const [name, m] of [...LANDSCAPE, ...PORTRAIT]) {
    it(`${name} : dans l'écran`, () => {
      const { sheet, zone } = scanZoneLayout(m);
      expect(sheet).toBe(m.portrait);
      expect(insideViewport(zone, m)).toBe(true);
      // assez grande pour viser un QR code
      expect(Math.min(zone.w, zone.h) * m.scale).toBeGreaterThanOrEqual(Math.min(m.viewport.height, m.viewport.width) * 0.5);
    });
  }

  it('en paysage la caméra prend la place du QR code de l\'hôte (colonne gauche) et ne touche pas la colonne droite', () => {
    const m = fit(667, 375);
    const { zone } = scanZoneLayout(m);
    expect(zone.x + zone.w).toBeLessThanOrEqual(640);
    const L = hostInviteLayout(m);
    expect(rectsOverlap(zone, L.scan)).toBe(false);
    expect(rectsOverlap(zone, L.answer)).toBe(false);
  });
});

describe('mise en page portrait : feuilles', () => {
  for (const [name, m] of PORTRAIT) {
    it(`${name} : invitation de l'hôte`, () => {
      const L = hostInviteLayout(m);
      expect(L.sheet).toBe(true);
      expect(L.back).not.toBeNull();
      const items: Item[] = [
        { name: 'header', rect: L.header, kind: 'label' },
        { name: 'qr', rect: L.qr, kind: 'qr' },
        { name: 'scan', rect: L.scan, kind: 'button' },
        { name: 'cancel', rect: L.cancel, kind: 'button' },
        { name: 'code', rect: L.code, kind: 'field' },
        { name: 'copy', rect: L.copy, kind: 'button' },
        { name: 'answer', rect: L.answer, kind: 'field' },
        { name: 'paste', rect: L.paste, kind: 'button' },
        { name: 'validate', rect: L.validate, kind: 'button' },
        { name: 'back', rect: L.back as LogicalRect, kind: 'button' },
        { name: 'message', rect: portraitMessageRect(m), kind: 'label' },
      ];
      for (const i of items) expect(insideViewport(i.kind === 'button' ? grown(i.rect, m, true) : i.rect, m), i.name).toBe(true);
      noOverlap(items, m);
      // le QR code est presque aussi large que la fenêtre (ou aussi haut que la place le permet)
      expect(Math.min(L.qr.w, L.qr.h) * m.scale).toBeGreaterThanOrEqual(Math.min(m.viewport.width - 24, 280) - 1);
      // tout est lisible au toucher : 44 px CSS au moins
      for (const i of items.filter((x) => x.kind === 'button' || x.kind === 'field')) {
        const c = css(i.rect, m);
        expect(c.bottom - c.top, i.name).toBeGreaterThanOrEqual(44 - 0.5);
        expect(c.right - c.left, i.name).toBeGreaterThanOrEqual(44);
      }
    });

    it(`${name} : saisie du code d'invitation et réponse de l'invité`, () => {
      const G = guestCodeLayout(m);
      expect(G.sheet).toBe(true);
      const code: Item[] = [
        { name: 'scan', rect: G.scan, kind: 'button' },
        { name: 'label', rect: G.label, kind: 'label' },
        { name: 'field', rect: G.field, kind: 'field' },
        { name: 'paste', rect: G.paste, kind: 'button' },
        { name: 'validate', rect: G.validate, kind: 'button' },
        { name: 'back', rect: G.back as LogicalRect, kind: 'button' },
        { name: 'message', rect: portraitMessageRect(m), kind: 'label' },
      ];
      for (const i of code) expect(insideViewport(i.kind === 'button' ? grown(i.rect, m, true) : i.rect, m), `code ${i.name}`).toBe(true);
      noOverlap(code, m);

      const A = guestAnswerLayout(m);
      expect(A.sheet).toBe(true);
      const answer: Item[] = [
        { name: 'caption', rect: A.caption, kind: 'label' },
        { name: 'qr', rect: A.qr, kind: 'qr' },
        { name: 'label', rect: A.label, kind: 'label' },
        { name: 'code', rect: A.code, kind: 'field' },
        { name: 'copy', rect: A.copy, kind: 'button' },
        { name: 'back', rect: A.back, kind: 'button' },
        { name: 'message', rect: portraitMessageRect(m), kind: 'label' },
      ];
      for (const i of answer) expect(insideViewport(i.kind === 'button' ? grown(i.rect, m, true) : i.rect, m), `réponse ${i.name}`).toBe(true);
      noOverlap(answer, m);
      expect(A.qr.w * m.scale).toBeGreaterThanOrEqual(Math.min(m.viewport.width - 24, 250) - 1);
    });
  }
});

describe('invite de rotation : la caméra ne reste pas allumée derrière', () => {
  it("une lecture ouverte est fermée dès que l'invite « Tourne ton téléphone » est affichée ; sans lecture ou sans invite, rien à fermer", () => {
    const scanning = run(hostWithReadyInvite(), { type: 'scanOpen', target: 'answer' }, { type: 'scanActive' });
    expect(scanCoveredByRotatePrompt(scanning, true)).toBe(true);
    expect(scanCoveredByRotatePrompt(scanning, false)).toBe(false);
    expect(scanCoveredByRotatePrompt(hostWithReadyInvite(), true)).toBe(false);
    const starting = run(guestAtCode(), { type: 'scanOpen', target: 'invite' });
    expect(scanCoveredByRotatePrompt(starting, true)).toBe(true); // même pendant l'ouverture de la caméra
  });
});

describe("touches d'activation des boutons DOM", () => {
  it('Entrée et Espace (par `key` ou par `code`) sont gardées pour le bouton ; Échap, flèches, Tab et lettres continuent de remonter', () => {
    for (const ev of [{ key: 'Enter' }, { key: ' ' }, { key: 'Spacebar' }, { code: 'Enter' }, { code: 'NumpadEnter' }, { code: 'Space' }, { key: 'Enter', code: 'Enter' }]) {
      expect(isActivationKey(ev), JSON.stringify(ev)).toBe(true);
    }
    for (const ev of [{ key: 'Escape', code: 'Escape' }, { key: 'ArrowUp', code: 'ArrowUp' }, { key: 'Tab', code: 'Tab' }, { key: 'a', code: 'KeyA' }, { key: 'x' }, {}]) {
      expect(isActivationKey(ev), JSON.stringify(ev)).toBe(false);
    }
  });
});
