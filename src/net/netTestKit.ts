/**
 * Aides de TEST du réseau (réservé aux tests : ce module n'est importé par aucun code du jeu).
 * Horloge factice, hôte + invités reliés par des paires Loopback, « pompe » qui fait circuler les messages et avancer les horloges des sessions.
 */
import type { BuildInfo } from '../buildInfo';
import type { CharacterId } from '../core/types';
import { createClientSession, type ClientSession } from './clientSession';
import { NET, type ClientSessionOptions, type HostSessionOptions } from './contracts';
import { createHostSession, type HostSession } from './hostSession';
import { createLoopbackPair, type LoopbackFaultOptions, type LoopbackPairEx } from './transportLoopback';

export const TEST_BUILD: BuildInfo = { version: '0.1.0', commit: 'abc1234', date: '2026-11-23' };
export const TEST_LEVEL_COUNT = 9;

export interface FakeClock {
  now(): number;
  /** Avance de `ms` et rend la nouvelle heure. */
  advance(ms: number): number;
  set(ms: number): void;
}

export function createFakeClock(start = 0): FakeClock {
  let t = start;
  return {
    now: () => t,
    advance(ms: number): number {
      t += ms;
      return t;
    },
    set(ms: number): void {
      t = ms;
    },
  };
}

export interface TestGuest {
  client: ClientSession;
  pair: LoopbackPairEx;
}

export interface TestRig {
  clock: FakeClock;
  host: HostSession;
  guests: TestGuest[];
}

export function createTestHost(overrides: Partial<HostSessionOptions> = {}): HostSession {
  return createHostSession({ hostName: 'Hôte', build: TEST_BUILD, levelCount: TEST_LEVEL_COUNT, transportKind: 'loopback', ...overrides });
}

/** Relie un nouvel invité à `host` par une paire Loopback (côté `a` = hôte, côté `b` = invité). Rien n'est livré avant `pump`. */
export function connectGuest(host: HostSession, opts: Partial<ClientSessionOptions> & { loopback?: LoopbackFaultOptions } = {}): TestGuest {
  const { loopback, ...clientOpts } = opts;
  const pair = createLoopbackPair(loopback);
  host.addGuest(pair.a);
  const client = createClientSession(pair.b, { name: 'Invité', build: TEST_BUILD, levelCount: TEST_LEVEL_COUNT, ...clientOpts });
  return { client, pair };
}

/** Hôte + `guestCount` invités connectés (non encore livrés : appeler `pump`). */
export function createRig(guestCount: number, hostOverrides: Partial<HostSessionOptions> = {}, clock: FakeClock = createFakeClock()): TestRig {
  const host = createTestHost(hostOverrides);
  const rig: TestRig = { clock, host, guests: [] };
  for (let i = 0; i < guestCount; i++) rig.guests.push(connectGuest(host, { name: `G${i + 1}` }));
  return rig;
}

/** Met à jour les sessions à l'heure courante et livre les messages en file, jusqu'à ce que plus rien ne circule (au plus `rounds` tours). */
export function pump(rig: TestRig, rounds = 16): void {
  for (let r = 0; r < rounds; r++) {
    const now = rig.clock.now();
    rig.host.update(now);
    for (const g of rig.guests) g.client.update(now);
    let delivered = 0;
    for (const g of rig.guests) delivered += g.pair.flush();
    // (avec un retard simulé, un tour peut ne rien livrer alors que des messages restent en file)
    if (delivered === 0 && rig.guests.every((g) => g.pair.pending() === 0)) break;
  }
}

/** Avance l'horloge de `ms` (en une fois) puis pompe. */
export function advance(rig: TestRig, ms: number): void {
  rig.clock.advance(ms);
  pump(rig);
}

/** Tous les participants choisissent un personnage DIFFÉRENT et se déclarent prêts. */
export function readyAll(rig: TestRig, characters: readonly CharacterId[] = ['david', 'sandrine', 'romain', 'valentine']): void {
  rig.host.setLocalChoice({ characterId: characters[0], ready: true });
  rig.guests.forEach((g, i) => g.client.sendChoice({ characterId: characters[i + 1], difficulty: 2, ready: true }));
  pump(rig);
}

/** Hôte + invités au salon, tous prêts, partie démarrée : retourne le rig et les informations de lancement. */
export function startedRig(guestCount: number, seed = 12345): { rig: TestRig; info: NonNullable<ReturnType<HostSession['startGame']>> } {
  const rig = createRig(guestCount);
  pump(rig);
  readyAll(rig);
  const info = rig.host.startGame(seed);
  if (!info) throw new Error('startGame a refusé de démarrer');
  pump(rig);
  return { rig, info };
}

/** Durée (ms) simulée d'un pas : un pas de 60 Hz. */
export const STEP_MS = 1000 / 60;

/** Pour les tests de silence : un temps au-delà du délai de perte. */
export const AFTER_TIMEOUT_MS = NET.PEER_TIMEOUT_MS + 100;
