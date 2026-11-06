/**
 * #4519 round 1, finding 2: the production wiring. Without the test-only
 * command (any policy not loaded from the test override), the startup check
 * and listener admission ask the trusted Tailscale authority, never a
 * `tailscale` found on PATH. The Serve module is replaced so this does not
 * depend on what this machine has installed; the authority itself is
 * covered by tailscale-authority.test.ts.
 */
import type { ManagedPolicySummary } from '@kontourai/station-contracts/managed-policy';
import type { LoadedManagedPolicy } from '@kontourai/station-shared/managed-policy';
import { beforeEach, expect, test, vi } from 'vitest';

const calls = vi.hoisted(() => ({ trusted: 0, command: 0 }));
vi.mock('../../services/tailscale/serve-exposure.js', async (original) => ({
  ...(await original<
    typeof import('../../services/tailscale/serve-exposure.js')
  >()),
  inspectTrustedTailscaleServeExposure: async () => {
    calls.trusted += 1;
    return { state: 'clear', reason: 'not-installed' };
  },
  inspectTailscaleServeExposure: async () => {
    calls.command += 1;
    return { state: 'clear', reason: 'not-installed' };
  },
}));

import {
  assertNoManagedTailscaleServeExposure,
  createManagedListenerAdmission,
  managedTailscaleCommand,
} from '../managed-network-exposure.js';

function policy(kind: 'file' | 'test-override'): LoadedManagedPolicy {
  const limits: ManagedPolicySummary['limits'] = {
    clients: ['desktop', 'local-browser'],
  };
  return {
    source: { kind, location: '/etc/station/policy.json' },
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

beforeEach(() => {
  calls.trusted = 0;
  calls.command = 0;
});

test('an installed policy asks the trusted authority, even with the test CLI variable set', async () => {
  const installed = policy('file');
  const command = managedTailscaleCommand(installed, {
    STATION_MANAGED_POLICY_TEST_TAILSCALE_CLI: '/tmp/fake-tailscale',
  });
  expect(command).toBeUndefined();
  await assertNoManagedTailscaleServeExposure(installed, [43141], command);
  await createManagedListenerAdmission(installed, command).admit({
    name: 'test',
    host: '127.0.0.1',
    port: 43142,
  });
  expect(calls).toEqual({ trusted: 2, command: 0 });
});

test('only a test-override policy uses the test CLI', async () => {
  const override = policy('test-override');
  const command = managedTailscaleCommand(override, {
    STATION_MANAGED_POLICY_TEST_TAILSCALE_CLI: '/tmp/fake-tailscale',
  });
  expect(command).toBeDefined();
  await assertNoManagedTailscaleServeExposure(override, [43141], command);
  expect(calls).toEqual({ trusted: 0, command: 1 });
});
