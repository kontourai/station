/**
 * A real service over a temporary home: the real engine vault, the real
 * connection and task stores, a preview switch and a managed policy the test
 * flips, and vendor fakes in place of the network.
 */
import { join } from 'node:path';
import type { ManagedPolicySummary } from '@kontourai/station-contracts/managed-policy';
import type { ManagedPolicyEngineLimits } from '@kontourai/station-contracts/managed-policy-engines';
import {
  type RemoteTaskVendorId,
  remoteTaskAcknowledgementStatement,
} from '@kontourai/station-contracts/remote-task-engine';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { createLogger } from '../../../utils/logger.js';
import { EngineHostAuthVault } from '../../engine-host-auth/vault.js';
import { RemoteTaskCredentials } from '../credentials.js';
import { RemoteTaskEngineService } from '../service.js';

const makeTempDir = trackTempDirs();

export const POLICY_SUMMARY = {
  organization: 'Example Corp',
  supportUrl: 'https://help.example.com/station',
} as unknown as ManagedPolicySummary;

/** `home`: reuse another harness's home, as a restarted Station would. */
export function harness(fetchImpl: typeof fetch, home?: string) {
  home ??= makeTempDir('remote-task-engines-');
  const vault = new EngineHostAuthVault(join(home, 'vault-home'));
  const switches = {
    preview: true,
    /** null: no managed policy installed. */
    policy: null as { engines?: ManagedPolicyEngineLimits } | null,
  };
  const service = new RemoteTaskEngineService({
    homeDir: home,
    credentials: new RemoteTaskCredentials(() => vault),
    preview: {
      select: (branches) =>
        switches.preview ? branches.enabled() : branches.disabled(),
    },
    managedPolicy: () =>
      switches.policy
        ? {
            document: { limits: { engines: switches.policy.engines } },
            summary: POLICY_SUMMARY,
          }
        : null,
    fetch: fetchImpl,
    logger: createLogger({ name: 'remote-task-test' }),
  });

  /** A connection ready to send: acknowledged and holding `token`. */
  async function readyConnection(
    vendor: RemoteTaskVendorId,
    token: string,
    settings: Record<string, string> = {},
  ) {
    const view = await service.createConnection({ vendor, settings });
    await service.acknowledge(
      view.id,
      remoteTaskAcknowledgementStatement(vendor),
    );
    await service.setCredential(view.id, token);
    return view.id;
  }

  return { home, vault, switches, service, readyConnection };
}
