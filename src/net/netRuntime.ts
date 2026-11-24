/**
 * Objets VIVANTS du réseau (sessions, transports) : un petit singleton de module, hors de `GameSession` (qui reste du JSON pur, sans objet Phaser ni objet vivant).
 *
 * Cycle de vie : la scène de salon (`NetLobbyScene`) crée la session (hôte ou invité), la range ici (`setNetRuntime`) et la passe aux scènes suivantes
 * par ce seul canal ; `GameScene` la LIT (`getHostSession` / `getClientSession`) sans la posséder. La session est libérée (`clearNetRuntime`) quand on
 * quitte le multijoueur (retour au menu, hôte perdu, refus) — PAS à la fin d'une partie (la liaison survit pour rejouer depuis le salon).
 */
import type { ClientSessionApi, HostSessionApi, NetRole } from './contracts';

export interface NetRuntime {
  readonly role: NetRole;
  /** Session hôte (rôle `host`), sinon null. */
  readonly host: HostSessionApi | null;
  /** Session invité (rôle `client`), sinon null. */
  readonly client: ClientSessionApi | null;
  /** Libère la session et tout ce qui lui est attaché (transports, signalisation en attente…). Idempotent. */
  dispose(): void;
}

let current: NetRuntime | null = null;

/** Enveloppe une session hôte ; `extraDispose` (facultatif) libère ce qui l'accompagne (hôte BroadcastChannel, invitations WebRTC en attente…). */
export function createHostRuntime(host: HostSessionApi, extraDispose?: () => void): NetRuntime {
  let disposed = false;
  return {
    role: 'host',
    host,
    client: null,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      try {
        host.close();
      } finally {
        extraDispose?.();
      }
    },
  };
}

/** Enveloppe une session invité. */
export function createClientRuntime(client: ClientSessionApi, extraDispose?: () => void): NetRuntime {
  let disposed = false;
  return {
    role: 'client',
    host: null,
    client,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      try {
        client.leave();
      } finally {
        extraDispose?.();
      }
    },
  };
}

/** Session réseau courante, ou null (partie locale, ou rien d'ouvert). */
export function getNetRuntime(): NetRuntime | null {
  return current;
}

/** Remplace la session courante (l'ancienne est libérée si c'est un autre objet). */
export function setNetRuntime(rt: NetRuntime): void {
  if (current && current !== rt) current.dispose();
  current = rt;
}

/** Libère et oublie la session courante (idempotent). */
export function clearNetRuntime(): void {
  const rt = current;
  current = null;
  rt?.dispose();
}

/** Session hôte courante, ou null si aucune ou si l'appareil est invité. */
export function getHostSession(): HostSessionApi | null {
  return current?.host ?? null;
}

/** Session invité courante, ou null si aucune ou si l'appareil est hôte. */
export function getClientSession(): ClientSessionApi | null {
  return current?.client ?? null;
}
