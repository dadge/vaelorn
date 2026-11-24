import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClientSessionApi, HostSessionApi } from './contracts';
import { clearNetRuntime, createClientRuntime, createHostRuntime, getClientSession, getHostSession, getNetRuntime, setNetRuntime } from './netRuntime';

function fakeHost(close: () => void = vi.fn()): HostSessionApi {
  return { role: 'host', close } as unknown as HostSessionApi;
}
function fakeClient(leave: () => void = vi.fn()): ClientSessionApi {
  return { role: 'client', leave } as unknown as ClientSessionApi;
}

afterEach(() => clearNetRuntime());

describe('netRuntime', () => {
  it('vide au départ', () => {
    expect(getNetRuntime()).toBeNull();
    expect(getHostSession()).toBeNull();
    expect(getClientSession()).toBeNull();
  });

  it('range et expose une session hôte', () => {
    const host = fakeHost();
    setNetRuntime(createHostRuntime(host));
    expect(getNetRuntime()?.role).toBe('host');
    expect(getHostSession()).toBe(host);
    expect(getClientSession()).toBeNull();
  });

  it('range et expose une session invité', () => {
    const client = fakeClient();
    setNetRuntime(createClientRuntime(client));
    expect(getNetRuntime()?.role).toBe('client');
    expect(getClientSession()).toBe(client);
    expect(getHostSession()).toBeNull();
  });

  it('clear libère une fois (idempotent) et appelle le nettoyage annexe', () => {
    const close = vi.fn();
    const extra = vi.fn();
    setNetRuntime(createHostRuntime(fakeHost(close), extra));
    clearNetRuntime();
    clearNetRuntime();
    expect(close).toHaveBeenCalledTimes(1);
    expect(extra).toHaveBeenCalledTimes(1);
    expect(getNetRuntime()).toBeNull();
  });

  it('remplacer la session libère l\'ancienne ; remettre la même ne la libère pas', () => {
    const closeA = vi.fn();
    const a = createHostRuntime(fakeHost(closeA));
    setNetRuntime(a);
    setNetRuntime(a);
    expect(closeA).not.toHaveBeenCalled();
    const leaveB = vi.fn();
    setNetRuntime(createClientRuntime(fakeClient(leaveB)));
    expect(closeA).toHaveBeenCalledTimes(1);
    expect(getHostSession()).toBeNull();
    clearNetRuntime();
    expect(leaveB).toHaveBeenCalledTimes(1);
  });

  it('le nettoyage annexe s\'exécute même si close() lève', () => {
    const extra = vi.fn();
    const rt = createHostRuntime(
      fakeHost(() => {
        throw new Error('boom');
      }),
      extra,
    );
    expect(() => rt.dispose()).toThrow('boom');
    expect(extra).toHaveBeenCalledTimes(1);
  });
});
