/**
 * #4519: the startup gates for `limits.clients`. Each refusal is one line
 * that starts with the managed-policy marker the desktop sidecar and the CLI
 * key on; without the limit every gate passes through.
 */
import type { ManagedPolicySummary } from '@kontourai/station-contracts/managed-policy';
import type { LoadedManagedPolicy } from '@kontourai/station-shared/managed-policy';
import { describe, expect, test } from 'vitest';
import {
  assertManagedAdoptedListenersLoopback,
  assertNoManagedRelayConnector,
  assertNoManagedTailscaleServeExposure,
  isLoopbackListenHost,
  resolveManagedListenHost,
} from '../managed-network-exposure.js';

function policy(limits: ManagedPolicySummary['limits']): LoadedManagedPolicy {
  return {
    source: { kind: 'test-override', location: '/tmp/policy.json' },
    digest: `sha256:${'a'.repeat(64)}`,
    document: { schemaVersion: 1, organization: 'Acme', limits },
    summary: {
      organization: 'Acme',
      supportUrl: null,
      lockedSettings: [],
      limits,
    },
  } as LoadedManagedPolicy;
}

const local = policy({ clients: ['desktop', 'local-browser'] });
const remote = policy({ clients: ['desktop', 'local-browser', 'remote'] });
const MARKER =
  /^STATION_MANAGED_POLICY_INVALID: The managed policy at \/tmp\/policy\.json allows no remote clients/;

describe('resolveManagedListenHost', () => {
  test('binds loopback under the limit and refuses any other host', () => {
    expect(resolveManagedListenHost(local, undefined)).toBe('127.0.0.1');
    for (const host of ['127.0.0.1', '127.8.0.1', 'localhost', '::1', '[::1]'])
      expect(resolveManagedListenHost(local, host)).toBe(host);
    for (const host of ['0.0.0.0', '::', '192.168.1.20', 'station.local']) {
      expect(() => resolveManagedListenHost(local, host)).toThrow(MARKER);
      expect(() => resolveManagedListenHost(local, host)).toThrow(
        `STATION_HOST is "${host}"`,
      );
    }
  });

  test('changes nothing without a policy, without the limit, or with remote listed', () => {
    for (const loaded of [null, policy({}), remote]) {
      expect(resolveManagedListenHost(loaded, undefined)).toBeUndefined();
      expect(resolveManagedListenHost(loaded, '0.0.0.0')).toBe('0.0.0.0');
    }
  });

  test('loopback is 127.0.0.0/8, ::1 and localhost only', () => {
    expect(isLoopbackListenHost('0:0:0:0:0:0:0:1')).toBe(true);
    expect(isLoopbackListenHost('::ffff:127.0.0.1')).toBe(false);
    expect(isLoopbackListenHost('128.0.0.1')).toBe(false);
  });
});

describe('the other startup gates', () => {
  test('a relay connector and a non-loopback supervisor-held socket refuse under the limit only', () => {
    expect(() => assertNoManagedRelayConnector(local, true)).toThrow(MARKER);
    expect(() => assertNoManagedRelayConnector(local, false)).not.toThrow();
    expect(() => assertNoManagedRelayConnector(remote, true)).not.toThrow();
    expect(() =>
      assertManagedAdoptedListenersLoopback(local, ['127.0.0.1', '::']),
    ).toThrow('a listener bound to ::');
    expect(() => assertManagedAdoptedListenersLoopback(local, [null])).toThrow(
      'an unreadable address',
    );
    expect(() =>
      assertManagedAdoptedListenersLoopback(local, ['127.0.0.1']),
    ).not.toThrow();
    expect(() =>
      assertManagedAdoptedListenersLoopback(null, ['0.0.0.0']),
    ).not.toThrow();
  });

  test('Tailscale Serve: a route to a port refuses naming the fix, an unreadable state refuses, and no limit never asks', async () => {
    const asked: string[] = [];
    const serving = async (args: readonly string[]) => {
      asked.push(args.join(' '));
      return args[0] === 'serve'
        ? {
            exitCode: 0,
            stderr: '',
            stdout: JSON.stringify({
              Web: {
                'n.example.ts.net:443': {
                  Handlers: { '/': { Proxy: 'http://127.0.0.1:43144' } },
                },
              },
            }),
          }
        : { exitCode: 0, stderr: '', stdout: '{"BackendState":"Running"}' };
    };
    await expect(
      assertNoManagedTailscaleServeExposure(local, [43141, 43144], serving),
    ).rejects.toThrow(/forwards port 43144 to it.*tailscale serve reset/);
    await expect(
      assertNoManagedTailscaleServeExposure(local, [43141], async () => ({
        exitCode: null,
        stdout: '',
        stderr: '',
      })),
    ).rejects.toThrow(MARKER);
    asked.length = 0;
    await assertNoManagedTailscaleServeExposure(remote, [43144], serving);
    await assertNoManagedTailscaleServeExposure(null, [43144], serving);
    expect(asked).toEqual([]);
  });
});
