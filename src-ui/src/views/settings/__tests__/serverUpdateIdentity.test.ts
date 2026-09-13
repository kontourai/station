import type { SystemIdentityResponse } from '@kontourai/station-contracts/system-status';
import { describe, expect, it } from 'vitest';
import type { BundledServerStatus } from '../../../platform/native/types';
import {
  type ConnectedServerCorrelationInput,
  exactEndpointMatch,
  exactLoopbackPortMatch,
  resolveEstablishedServerKind,
} from '../serverUpdateIdentity';

const SHA = '71e0381f78e903cd81fc9d2d21266986103f6f39';
const PORT = 4311;
const LOOPBACK = `http://127.0.0.1:${PORT}`;

function nativeStatus(
  over: Partial<BundledServerStatus> = {},
): BundledServerStatus {
  return {
    phase: 'running',
    attempt: 1,
    maxAttempts: 3,
    apiBase: LOOPBACK,
    port: PORT,
    generation: 3,
    instanceId: 'desktop-sidecar-stable',
    bootId: 'boot-1',
    lastExitCode: null,
    nextRetryInMs: null,
    logPath: null,
    ownership: 'sidecar',
    canRunInBackground: true,
    failClosed: false,
    message: '',
    ...over,
  };
}

function identity(over: Record<string, unknown> = {}): SystemIdentityResponse {
  return {
    instanceId: 'desktop-sidecar-stable',
    bootId: 'boot-1',
    sha: SHA,
    devicePresentation: { deviceClass: 'host', hostName: 'Kontour' },
    ...over,
  };
}

function input(
  over: Partial<ConnectedServerCorrelationInput> = {},
): ConnectedServerCorrelationInput {
  return {
    scopeCurrent: true,
    nativeBindingCurrent: true,
    reachability: 'connected',
    identity: identity(),
    isDesktop: true,
    nativeStatus: nativeStatus(),
    apiBase: LOOPBACK,
    selection: { selectedAccessIsDirectHttp: true },
    ...over,
  };
}

describe('resolveEstablishedServerKind', () => {
  it('treats two empty instance ids as absent evidence, not equality', () => {
    const kind = resolveEstablishedServerKind(
      input({
        identity: identity({ instanceId: '' }),
        selection: { ownerId: '', selectedAccessIsDirectHttp: true },
        nativeStatus: nativeStatus({ instanceId: '' }),
      }),
    );
    expect(kind).toBe('unresolved');
  });

  it.each([
    ['null generation', null],
    ['undefined generation', undefined],
    ['fractional generation', 1.5],
    ['negative generation', -1],
  ])('resolves unresolved for a sidecar claim with %s', (_name, generation) => {
    expect(
      resolveEstablishedServerKind(
        input({
          nativeStatus: nativeStatus({
            generation: generation as number | null | undefined,
          }),
        }),
      ),
    ).toBe('unresolved');
  });

  it('never resolves installed-local-service for an ssh-forward selection', () => {
    const kind = resolveEstablishedServerKind(
      input({
        nativeStatus: nativeStatus({
          ownership: 'service',
          phase: 'stopped',
          instanceId: 'svc-instance-1',
          generation: null,
          bootId: null,
        }),
        selection: {
          ownerId: 'svc-instance-1',
          selectedAccessIsDirectHttp: true,
          sshForward: { transport: 'ssh-forward' },
        },
      }),
    );
    expect(kind).toBe('unresolved');
  });

  it('resolves unresolved, not remote-server, when a complete paired identity omits devicePresentation', () => {
    const kind = resolveEstablishedServerKind(
      input({
        identity: identity({
          instanceId: 'remote-instance',
          bootId: 'remote-boot',
          devicePresentation: undefined,
        }),
        isDesktop: false,
        nativeStatus: null,
      }),
    );
    expect(kind).toBe('unresolved');
  });
});

describe('exactEndpointMatch', () => {
  it.each([
    [
      'userinfo url is rejected',
      'http://user:pass@127.0.0.1:4311/',
      LOOPBACK,
      false,
    ],
    ['query is rejected', 'http://127.0.0.1:4311/?x=1', LOOPBACK, false],
    ['fragment is rejected', 'http://127.0.0.1:4311/#frag', LOOPBACK, false],
    [
      'subpath mismatch is rejected',
      'http://127.0.0.1:4311/sub',
      LOOPBACK,
      false,
    ],
    [
      'implicit default port matches explicit',
      'http://127.0.0.1/',
      'http://127.0.0.1:80/',
      true,
    ],
    ['trailing slash is tolerated', 'http://127.0.0.1:4311', LOOPBACK, true],
    ['http and https are distinct', 'https://127.0.0.1:4311/', LOOPBACK, false],
    [
      'a hostname alias is not equivalence',
      'http://localhost:4311/',
      LOOPBACK,
      false,
    ],
  ])('%s', (_name, candidate, native, expected) => {
    expect(exactEndpointMatch(candidate, native)).toBe(expected);
  });
});

describe('exactLoopbackPortMatch', () => {
  it.each([
    ['ipv6 loopback', 'http://[::1]:4311', 4311, true],
    ['hostname loopback', 'http://localhost:4311', 4311, true],
    ['non-loopback host', 'https://station.example.test:4311', 4311, false],
    ['port mismatch', 'http://127.0.0.1:4312', 4311, false],
    ['absent port', LOOPBACK, null, false],
    ['unbounded port', LOOPBACK, 65_536, false],
  ])('%s', (_name, apiBase, port, expected) => {
    expect(exactLoopbackPortMatch(apiBase, port)).toBe(expected);
  });
});
