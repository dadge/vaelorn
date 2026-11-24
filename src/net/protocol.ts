/**
 * Couche PROTOCOLE du multijoueur réseau (lot A) : encodage JSON, fragmentation, réassemblage et VALIDATION STRICTE de chaque message entrant.
 * Contrat des messages : `contracts.ts` ; conception : docs/NET.md § 5.
 *
 * Règles de sécurité (§ 5.5) : un pair malveillant ou bogué ne doit jamais faire planter l'autre côté ni lui faire injecter une valeur hors bornes.
 *  - `decode` ne LÈVE JAMAIS : un message invalide rend `{ kind: 'invalid', reason }` (l'appelant le compte, `NET.MAX_MALFORMED`) ;
 *  - longueur bornée AVANT `JSON.parse` ; clés `__proto__` refusées (y compris échappées `_`) ;
 *  - chaque champ est vérifié (type exact, entier dans sa plage, tailles de tableaux bornées) et le message rendu est un objet NEUF
 *    (aucun spread d'un objet reçu) : les champs inconnus sont ignorés ;
 *  - un type de message absent de la liste de la direction (`GUEST_TO_HOST_TYPES` / `HOST_TO_GUEST_TYPES`) est invalide.
 * Exception volontaire : l'enveloppe de compatibilité (`hello`, `reject`) est lue avec indulgence quand `proto` diffère de la version locale
 * (un autre protocole peut avoir une autre forme : on veut un refus « version différente », pas « message invalide »).
 *
 * Fragmentation (§ 5.2) : un message de plus de `NET.FRAGMENT_CHARS` caractères (ou de plus que la taille acceptée par le transport) part en `frag` successifs.
 * Un seul réassemblage est en cours par sens (les fragments d'un message ne sont jamais entrelacés) ; `id` strictement croissant ; plafond mémoire
 * `NET.MAX_MESSAGE_CHARS` ; un réassemblage incomplet depuis plus de `NET.REASSEMBLY_TIMEOUT_MS` est abandonné.
 *
 * Aucune dépendance à Phaser ni au DOM, aucune horloge (l'heure est passée par l'appelant).
 */
import type { BuildInfo } from '../buildInfo';
import { CHARACTER_IDS } from '../core/characters';
import type { CharacterId, Difficulty, GameState, PlayerId, SimEvent } from '../core/types';
import {
  GUEST_TO_HOST_TYPES,
  HOST_TO_GUEST_TYPES,
  NET,
  NET_PROTOCOL_VERSION,
  SIM_EVENTS_NEVER_DROPPED,
  SIM_EVENT_TYPES,
  sanitizeNetName,
  unpackFrame,
  type Compat,
  type LobbySlot,
  type LobbyState,
  type MsgFrag,
  type MsgPing,
  type NetMessage,
  type NetMessageType,
  type NetPlayer,
  type RejectReason,
} from './contracts';

// ───────────────────────────── Types ─────────────────────────────

/** Sens d'un message ENTRANT : `toHost` = reçu par l'hôte (venant d'un invité) ; `toGuest` = reçu par un invité (venant de l'hôte). */
export type Direction = 'toHost' | 'toGuest';

/** Message applicatif (jamais un `frag` : les fragments sont réassemblés par le décodeur). */
export type ProtocolMessage = Exclude<NetMessage, MsgFrag>;

/**
 * Extension FACULTATIVE de `ping` : `r` = dernier aller-retour (ms) mesuré par l'hôte pour CE pair. Le contrat fige `MsgPing` sans ce champ ; un pair qui
 * ne le connaît pas l'ignore (champs inconnus ignorés), donc la version du protocole n'a pas à changer. Sert à `ClientSessionApi.rttMs()`.
 */
export interface MsgPingEx extends MsgPing {
  r?: number;
}

export type DecodeResult =
  | { kind: 'message'; msg: ProtocolMessage }
  /** Fragment valide accepté, message pas encore complet. */
  | { kind: 'partial' }
  | { kind: 'invalid'; reason: string };

export interface MessageDecoder {
  /** Décode un texte reçu (jamais d'exception). `nowMs` sert aux expirations de réassemblage. */
  decode(text: string, nowMs: number): DecodeResult;
  /** Abandonne un réassemblage trop ancien ; true si un réassemblage a été abandonné. */
  expire(nowMs: number): boolean;
  /** Oublie tout réassemblage en cours (l'identifiant de fragment le plus récent est conservé). */
  reset(): void;
  /** Caractères actuellement retenus par un réassemblage (0 si aucun). */
  readonly pendingChars: number;
  /** Nombre de réassemblages abandonnés (expiration, désordre, entrelacement). */
  readonly abandoned: number;
}

export interface MessageEncoder {
  /** Message → textes à envoyer, dans l'ordre (1 texte, ou plusieurs `frag`). @throws RangeError si le JSON dépasse `NET.MAX_MESSAGE_CHARS`. */
  encode(msg: ProtocolMessage): string[];
  /** Même chose à partir d'un JSON déjà sérialisé (l'hôte sérialise l'état UNE fois par instantané). */
  encodeJson(json: string): string[];
}

// ───────────────────────────── Petits outils de validation ─────────────────────────────

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Lecture d'un champ PROPRE de l'objet (jamais un membre hérité de `Object.prototype`). */
function field(o: Obj, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(o, key) ? o[key] : undefined;
}

function isInt(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
}

const UINT32_MAX = 0xffffffff;
const COUNTER_MAX = 0x7fffffff;

function isUint32(v: unknown): v is number {
  return isInt(v, 0, UINT32_MAX);
}

function parseCharacter(v: unknown): CharacterId | null {
  return typeof v === 'string' && (CHARACTER_IDS as readonly string[]).includes(v) ? (v as CharacterId) : null;
}

function parseDifficulty(v: unknown): Difficulty | null {
  return v === 1 || v === 2 || v === 3 ? v : null;
}

function parsePlayerId(v: unknown): PlayerId | null {
  return isInt(v, 0, NET.MAX_PLAYERS - 1) ? (v as PlayerId) : null;
}

const REJECT_REASONS: readonly RejectReason[] = ['protocol', 'build', 'levels', 'started', 'full', 'malformed'];
const END_REASONS = ['levelCompleted', 'hostQuit', 'aborted'] as const;
const SIM_EVENT_SET: ReadonlySet<string> = new Set<string>(SIM_EVENT_TYPES);
const NEVER_DROPPED_SET: ReadonlySet<string> = new Set<string>(SIM_EVENTS_NEVER_DROPPED);

/** Nom de remplacement d'un emplacement dont le nom est vide ou illisible (neutre, indépendant de la langue). */
export function defaultPlayerName(slot: number): string {
  return `P${slot + 1}`;
}

function parseBuild(v: unknown): BuildInfo | null {
  if (!isObj(v)) return null;
  const version = field(v, 'version');
  const commit = field(v, 'commit');
  const date = field(v, 'date');
  if (typeof version !== 'string' || !/^[0-9A-Za-z.+_-]{1,32}$/.test(version)) return null;
  if (commit !== null && (typeof commit !== 'string' || !/^[0-9A-Za-z]{1,40}$/.test(commit))) return null;
  if (date !== null && (typeof date !== 'string' || !/^[0-9A-Za-z-]{1,16}$/.test(date))) return null;
  return { version, commit, date };
}

const PLACEHOLDER_BUILD: BuildInfo = { version: '?', commit: null, date: null };

/** Enveloppe de compatibilité. `lenient` : accepte des champs manquants / invalides (autre protocole) en les remplaçant par des valeurs neutres. */
function parseCompat(o: Obj, lenient: boolean): Compat | null {
  const proto = field(o, 'proto');
  if (!isInt(proto, 0, 65535)) return null;
  const build = parseBuild(field(o, 'build'));
  const levels = field(o, 'levels');
  const levelsOk = isInt(levels, 0, 10000);
  if (proto === NET_PROTOCOL_VERSION || !lenient) {
    if (!build || !levelsOk) return null;
    return { proto, build, levels: levels as number };
  }
  return { proto, build: build ?? PLACEHOLDER_BUILD, levels: levelsOk ? (levels as number) : -1 };
}

function parseLobby(v: unknown): LobbyState | null {
  if (!isObj(v)) return null;
  const seq = field(v, 'seq');
  const levelCount = field(v, 'levelCount');
  const levelIndex = field(v, 'levelIndex');
  const rawSlots = field(v, 'slots');
  if (!isInt(seq, 0, UINT32_MAX) || !isInt(levelCount, 1, 1000) || !isInt(levelIndex, 0, 999) || levelIndex >= levelCount) return null;
  if (!Array.isArray(rawSlots) || rawSlots.length < 1 || rawSlots.length > NET.MAX_PLAYERS) return null;
  const slots: LobbySlot[] = [];
  const seen = new Set<number>();
  for (const raw of rawSlots) {
    if (!isObj(raw)) return null;
    const slot = parsePlayerId(field(raw, 'slot'));
    const characterId = parseCharacter(field(raw, 'characterId'));
    const difficulty = parseDifficulty(field(raw, 'difficulty'));
    const isHost = field(raw, 'isHost');
    const connected = field(raw, 'connected');
    const ready = field(raw, 'ready');
    if (slot === null || characterId === null || difficulty === null) return null;
    if (typeof isHost !== 'boolean' || typeof connected !== 'boolean' || typeof ready !== 'boolean') return null;
    if (seen.has(slot)) return null;
    seen.add(slot);
    const entry: LobbySlot = {
      slot,
      name: sanitizeNetName(field(raw, 'name'), defaultPlayerName(slot)),
      isHost,
      connected,
      characterId,
      difficulty,
      ready,
    };
    const ping = field(raw, 'pingMs');
    if (typeof ping === 'number' && Number.isFinite(ping) && ping >= 0 && ping <= 60000) entry.pingMs = ping;
    slots.push(entry);
  }
  slots.sort((a, b) => a.slot - b.slot);
  return { seq, slots, levelIndex, levelCount };
}

function parsePlayers(v: unknown): NetPlayer[] | null {
  if (!Array.isArray(v) || v.length < 1 || v.length > NET.MAX_PLAYERS) return null;
  const out: NetPlayer[] = [];
  const chars = new Set<string>();
  for (let i = 0; i < v.length; i++) {
    const raw: unknown = v[i];
    if (!isObj(raw)) return null;
    const characterId = parseCharacter(field(raw, 'characterId'));
    const difficulty = parseDifficulty(field(raw, 'difficulty'));
    // ids CONTIGUS 0..n-1 dans l'ordre (c'est ce que `createSimulation` suppose)
    if (field(raw, 'id') !== i || characterId === null || difficulty === null) return null;
    if (chars.has(characterId)) return null;
    chars.add(characterId);
    out.push({ id: i as PlayerId, characterId, difficulty, name: sanitizeNetName(field(raw, 'name'), defaultPlayerName(i)) });
  }
  return out;
}

// ───────────────────────────── Validation par type ─────────────────────────────

/** Valide un objet JSON déjà décodé comme message de la direction donnée. Rend le message NEUF, ou la raison du refus. */
export function validateMessage(direction: Direction, raw: unknown): { ok: true; msg: ProtocolMessage } | { ok: false; reason: string } {
  const bad = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });
  if (!isObj(raw)) return bad('notObject');
  const t = field(raw, 't');
  if (typeof t !== 'string') return bad('noType');
  const allowed: readonly NetMessageType[] = direction === 'toHost' ? GUEST_TO_HOST_TYPES : HOST_TO_GUEST_TYPES;
  if (!allowed.includes(t as NetMessageType)) return bad(`type:${t.slice(0, 16)}`);

  switch (t) {
    case 'hello': {
      const compat = parseCompat(raw, true);
      if (!compat) return bad('hello');
      const name = field(raw, 'name');
      if (typeof name !== 'string' || name.length > 256) {
        if (compat.proto === NET_PROTOCOL_VERSION) return bad('hello.name');
      }
      return { ok: true, msg: { t: 'hello', ...compat, name: sanitizeNetName(name, '') } };
    }
    case 'welcome': {
      const compat = parseCompat(raw, false);
      const slot = parsePlayerId(field(raw, 'slot'));
      const lobby = parseLobby(field(raw, 'lobby'));
      if (!compat || slot === null || !lobby) return bad('welcome');
      return { ok: true, msg: { t: 'welcome', ...compat, slot, lobby } };
    }
    case 'reject': {
      const compat = parseCompat(raw, true);
      const reason = field(raw, 'reason');
      if (!compat || typeof reason !== 'string' || !(REJECT_REASONS as readonly string[]).includes(reason)) return bad('reject');
      return { ok: true, msg: { t: 'reject', ...compat, reason: reason as RejectReason } };
    }
    case 'lobby': {
      const lobby = parseLobby(field(raw, 'lobby'));
      const you = parsePlayerId(field(raw, 'you'));
      if (!lobby || you === null) return bad('lobby');
      return { ok: true, msg: { t: 'lobby', lobby, you } };
    }
    case 'choice': {
      const characterId = parseCharacter(field(raw, 'characterId'));
      const difficulty = parseDifficulty(field(raw, 'difficulty'));
      const ready = field(raw, 'ready');
      if (characterId === null || difficulty === null || typeof ready !== 'boolean') return bad('choice');
      return { ok: true, msg: { t: 'choice', characterId, difficulty, ready } };
    }
    case 'start': {
      const gid = field(raw, 'gid');
      const you = parsePlayerId(field(raw, 'you'));
      const levelIndex = field(raw, 'levelIndex');
      const seed = field(raw, 'seed');
      const players = parsePlayers(field(raw, 'players'));
      if (!isUint32(gid) || you === null || !isInt(levelIndex, 0, 999) || !isInt(seed, -UINT32_MAX, UINT32_MAX) || !players) return bad('start');
      if (you >= players.length) return bad('start.you');
      return { ok: true, msg: { t: 'start', gid, you, levelIndex, seed, players } };
    }
    case 'input': {
      const gid = field(raw, 'gid');
      const seq = field(raw, 'seq');
      const x = field(raw, 'x');
      const y = field(raw, 'y');
      const b = field(raw, 'b');
      if (!isUint32(gid) || !isInt(seq, 0, COUNTER_MAX) || unpackFrame(x, y, b) === null) return bad('input');
      return { ok: true, msg: { t: 'input', gid, seq, x: x as number, y: y as number, b: b as number } };
    }
    case 'snap': {
      const gid = field(raw, 'gid');
      const n = field(raw, 'n');
      const tick = field(raw, 'tick');
      const pc = field(raw, 'pc');
      const st = field(raw, 'st');
      const ev = field(raw, 'ev');
      if (!isUint32(gid) || !isInt(n, 0, COUNTER_MAX) || !isInt(tick, 0, COUNTER_MAX) || !isInt(pc, 0, (1 << NET.MAX_PLAYERS) - 1)) return bad('snap');
      // enveloppe de l'état seulement : la forme complète est validée par `GameSimulation.applyMirrorState`
      if (!isObj(st) || field(st, 'version') !== 1) return bad('snap.st');
      const levelId = field(st, 'levelId');
      if (typeof levelId !== 'string' || levelId.length === 0 || levelId.length > 64) return bad('snap.levelId');
      if (!Array.isArray(ev) || ev.length > NET.MAX_PENDING_EVENTS) return bad('snap.ev');
      const events: SimEvent[] = [];
      for (const e of ev as unknown[]) {
        if (!isObj(e)) continue;
        const type = field(e, 'type');
        if (typeof type === 'string' && SIM_EVENT_SET.has(type)) events.push(e as unknown as SimEvent);
      }
      return { ok: true, msg: { t: 'snap', gid, n, tick, pc, st: st as unknown as GameState, ev: events } };
    }
    case 'end': {
      const gid = field(raw, 'gid');
      const reason = field(raw, 'reason');
      if (!isUint32(gid) || typeof reason !== 'string' || !(END_REASONS as readonly string[]).includes(reason)) return bad('end');
      return { ok: true, msg: { t: 'end', gid, reason: reason as (typeof END_REASONS)[number] } };
    }
    case 'leave':
      return { ok: true, msg: { t: 'leave' } };
    case 'ping': {
      const n = field(raw, 'n');
      const ts = field(raw, 'ts');
      if (!isInt(n, 0, COUNTER_MAX) || typeof ts !== 'number' || !Number.isFinite(ts)) return bad('ping');
      const msg: MsgPingEx = { t: 'ping', n, ts };
      const r = field(raw, 'r');
      if (typeof r === 'number' && Number.isFinite(r) && r >= 0 && r <= 60000) msg.r = r;
      return { ok: true, msg };
    }
    case 'pong': {
      const n = field(raw, 'n');
      const ts = field(raw, 'ts');
      if (!isInt(n, 0, COUNTER_MAX) || typeof ts !== 'number' || !Number.isFinite(ts)) return bad('pong');
      return { ok: true, msg: { t: 'pong', n, ts } };
    }
    default:
      // `frag` est traité par le décodeur, avant d'arriver ici
      return bad(`type:${t}`);
  }
}

// ───────────────────────────── Événements en attente ─────────────────────────────

/**
 * Ajoute `incoming` à la file `queue` (modifiée sur place) et la borne à `max` : on jette les plus ANCIENS événements, sauf ceux de
 * `SIM_EVENTS_NEVER_DROPPED` (ils pilotent l'interface). Garde-fou : au-delà de `2 × max`, même ceux-là sont jetés (les plus anciens d'abord).
 */
export function appendEvents(queue: SimEvent[], incoming: readonly SimEvent[], max: number = NET.MAX_PENDING_EVENTS): void {
  for (const e of incoming) queue.push(e);
  if (queue.length <= max) return;
  let toDrop = queue.length - max;
  const keep: SimEvent[] = [];
  for (const e of queue) {
    if (toDrop > 0 && !NEVER_DROPPED_SET.has(e.type)) {
      toDrop--;
      continue;
    }
    keep.push(e);
  }
  const hard = max * 2;
  const start = keep.length > hard ? keep.length - hard : 0;
  queue.length = 0;
  for (let i = start; i < keep.length; i++) queue.push(keep[i]);
}

// ───────────────────────────── Encodage / fragmentation ─────────────────────────────

/** Marge accordée à l'enveloppe `{"t":"frag","id":…,"i":…,"n":…,"d":"…"}` (hors échappement des guillemets, traité à part). */
const FRAG_OVERHEAD = 80;

export function createEncoder(maxChars: number = NET.FRAGMENT_CHARS + 2048): MessageEncoder {
  let nextId = 0;

  function fragment(json: string): string[] {
    const id = nextId++;
    // 1) découpe : chaque `frag` sérialisé doit tenir dans `maxChars` (l'échappement des guillemets / contrôles de la tranche gonfle le texte)
    const slices: string[] = [];
    let pos = 0;
    const want = Math.max(1, Math.min(NET.FRAGMENT_CHARS, maxChars - FRAG_OVERHEAD));
    while (pos < json.length) {
      let take = Math.min(want, json.length - pos);
      for (;;) {
        const text = JSON.stringify({ t: 'frag', id, i: slices.length, n: NET.MAX_FRAGMENTS, d: json.slice(pos, pos + take) });
        if (text.length <= maxChars || take <= 1) break;
        take = Math.max(1, Math.floor((take * maxChars) / text.length) - 1);
      }
      slices.push(json.slice(pos, pos + take));
      pos += take;
      if (slices.length > NET.MAX_FRAGMENTS) throw new RangeError('messageTooLarge');
    }
    // 2) émission avec le vrai nombre de fragments (≤ 2 chiffres, donc même longueur que le substitut ci-dessus)
    const n = slices.length;
    return slices.map((d, i) => JSON.stringify({ t: 'frag', id, i, n, d }));
  }

  function encodeJson(json: string): string[] {
    if (json.length > NET.MAX_MESSAGE_CHARS) throw new RangeError('messageTooLarge');
    if (json.length <= Math.min(NET.FRAGMENT_CHARS, maxChars)) return [json];
    return fragment(json);
  }

  return {
    encode: (msg) => encodeJson(JSON.stringify(msg)),
    encodeJson,
  };
}

// ───────────────────────────── Décodage / réassemblage ─────────────────────────────

/** Sentinelle lancée par le `reviver` de `parseText` quand une CLÉ `__proto__` est rencontrée. */
class ForbiddenKey extends Error {}

/**
 * Texte brut → objet ; refuse les CLÉS `__proto__` (y compris échappées par `_`) mais accepte ce motif dans une VALEUR (un nom de joueur « __proto__ »
 * est un nom valide). Chemin rapide : sans le motif ni échappement dans le texte, un `JSON.parse` simple (les instantanés d'état sont gros et fréquents) ;
 * sinon `JSON.parse` avec un `reviver` qui ne rejette que les clés (JSON.parse décode les échappements avant d'appeler le `reviver`).
 * Les validateurs construisent de toute façon des objets neufs.
 */
function parseText(text: string): { ok: true; value: unknown } | { ok: false; reason: string } {
  const suspect = /__proto__|\\u005f/i.test(text);
  try {
    if (!suspect) return { ok: true, value: JSON.parse(text) as unknown };
    const value = JSON.parse(text, (key: string, v: unknown): unknown => {
      if (key === '__proto__') throw new ForbiddenKey();
      return v;
    }) as unknown;
    return { ok: true, value };
  } catch (e) {
    return { ok: false, reason: e instanceof ForbiddenKey ? 'forbiddenKey' : 'badJson' };
  }
}

interface Assembly {
  id: number;
  n: number;
  next: number;
  parts: string[];
  chars: number;
  startedAtMs: number;
}

export function createDecoder(direction: Direction): MessageDecoder {
  let asm: Assembly | null = null;
  let lastFragId = -1;
  let abandoned = 0;

  function abort(): void {
    if (asm) abandoned++;
    asm = null;
  }

  function finish(text: string): DecodeResult {
    const parsed = parseText(text);
    if (!parsed.ok) return { kind: 'invalid', reason: parsed.reason };
    const r = validateMessage(direction, parsed.value);
    return r.ok ? { kind: 'message', msg: r.msg } : { kind: 'invalid', reason: r.reason };
  }

  function acceptFragment(o: Obj, nowMs: number): DecodeResult {
    const id = field(o, 'id');
    const i = field(o, 'i');
    const n = field(o, 'n');
    const d = field(o, 'd');
    if (!isInt(id, 0, COUNTER_MAX) || !isInt(n, 2, NET.MAX_FRAGMENTS) || !isInt(i, 0, NET.MAX_FRAGMENTS - 1) || i >= n) return { kind: 'invalid', reason: 'frag' };
    if (typeof d !== 'string' || d.length === 0 || d.length > NET.FRAGMENT_CHARS) return { kind: 'invalid', reason: 'frag.d' };

    if (asm && id !== asm.id) abort(); // un nouveau message commence : l'ancien est perdu
    if (!asm) {
      if (i !== 0) return { kind: 'invalid', reason: 'frag.order' };
      if (id <= lastFragId) return { kind: 'invalid', reason: 'frag.id' };
      asm = { id, n, next: 0, parts: [], chars: 0, startedAtMs: nowMs };
      lastFragId = id;
    } else if (n !== asm.n || i !== asm.next) {
      abort(); // fragment manquant, dupliqué ou hors séquence
      return { kind: 'invalid', reason: 'frag.order' };
    }
    asm.parts.push(d);
    asm.chars += d.length;
    asm.next++;
    if (asm.chars > NET.MAX_MESSAGE_CHARS) {
      abort();
      return { kind: 'invalid', reason: 'tooLarge' };
    }
    if (asm.next < asm.n) return { kind: 'partial' };
    const text = asm.parts.join('');
    asm = null;
    return finish(text);
  }

  return {
    decode(text: string, nowMs: number): DecodeResult {
      if (typeof text !== 'string') return { kind: 'invalid', reason: 'notString' };
      if (text.length > NET.MAX_MESSAGE_CHARS) return { kind: 'invalid', reason: 'tooLarge' };
      if (asm && nowMs - asm.startedAtMs > NET.REASSEMBLY_TIMEOUT_MS) abort();
      const parsed = parseText(text);
      if (!parsed.ok) return { kind: 'invalid', reason: parsed.reason };
      const v = parsed.value;
      if (isObj(v) && field(v, 't') === 'frag') return acceptFragment(v, nowMs);
      // un message ordinaire en plein réassemblage viole la règle « jamais entrelacés » : l'ancien est abandonné, celui-ci est traité
      if (asm) abort();
      const r = validateMessage(direction, v);
      return r.ok ? { kind: 'message', msg: r.msg } : { kind: 'invalid', reason: r.reason };
    },
    expire(nowMs: number): boolean {
      if (asm && nowMs - asm.startedAtMs > NET.REASSEMBLY_TIMEOUT_MS) {
        abort();
        return true;
      }
      return false;
    },
    reset(): void {
      asm = null;
    },
    get pendingChars(): number {
      return asm ? asm.chars : 0;
    },
    get abandoned(): number {
      return abandoned;
    },
  };
}
