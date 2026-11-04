/**
 * #4519: the startup half of the managed `limits.clients` limit. Without
 * `remote`, nothing off this machine may reach the server, so before
 * anything listens the entrypoint:
 *
 * - binds loopback: an unset `STATION_HOST` becomes `127.0.0.1`, and a
 *   non-loopback one refuses startup;
 * - refuses a configured relay connector, which would let remote clients in
 *   over an outbound connection;
 * - refuses while Tailscale Serve forwards one of this server's ports, or
 *   while Tailscale cannot say whether it does.
 *
 * Each refusal is one line that starts with the managed-policy marker, so the
 * desktop sidecar stops retrying (a restart cannot fix it) and the CLI prints
 * it. The credential half (paired devices, offers, tokens) lives in
 * `DevicePairingService`'s `localClientsOnly`.
 */
import { isIP } from 'node:net';
import {
  MANAGED_POLICY_INVALID_MARKER,
  managedPolicyAllowsRemoteClients,
} from '@kontourai/station-contracts/managed-policy';
import type { LoadedManagedPolicy } from '@kontourai/station-shared/managed-policy';
import {
  createTailscaleCommand,
  inspectTailscaleServeExposure,
  type TailscaleCommand,
} from '../services/tailscale/serve-exposure.js';

/**
 * Test-only: an absolute path to the executable the Serve check runs in
 * place of Tailscale's. Honored only for a policy loaded from
 * `STATION_MANAGED_POLICY_TEST_FILE`, which itself works only on a machine
 * with no installed policy, so it cannot weaken an administrator's check.
 */
export const MANAGED_POLICY_TEST_TAILSCALE_CLI_ENV =
  'STATION_MANAGED_POLICY_TEST_TAILSCALE_CLI';

/** The Tailscale command the startup check uses for `policy`. */
export function managedTailscaleCommand(
  policy: LoadedManagedPolicy | null,
  env: NodeJS.ProcessEnv = process.env,
): TailscaleCommand | undefined {
  const override = env[MANAGED_POLICY_TEST_TAILSCALE_CLI_ENV];
  if (policy?.source.kind !== 'test-override' || !override) return undefined;
  return createTailscaleCommand(process.platform, undefined, [override]);
}

/** The host Station binds when the limit applies and none is configured. */
export const MANAGED_LOOPBACK_HOST = '127.0.0.1';

/** `localhost`, `127.0.0.0/8` or `::1` (bracketed or not). */
export function isLoopbackListenHost(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (bare === 'localhost') return true;
  if (isIP(bare) === 4) return bare.split('.')[0] === '127';
  if (isIP(bare) === 6)
    return bare === '::1' || /^(0{0,4}:){7}0{0,3}1$/.test(bare);
  return false;
}

export class ManagedNetworkExposureError extends Error {
  readonly code = MANAGED_POLICY_INVALID_MARKER;

  constructor(policy: LoadedManagedPolicy, problem: string, remedy: string) {
    super(
      `${MANAGED_POLICY_INVALID_MARKER}: The managed policy at ${policy.source.location} allows no remote clients, so Station accepts connections only from this computer, but ${problem}. ${remedy}`,
    );
    this.name = 'ManagedNetworkExposureError';
  }
}

/** True when a policy is loaded and its `limits.clients` leaves out `remote`. */
export function localClientsOnly(policy: LoadedManagedPolicy | null): boolean {
  return policy !== null && !managedPolicyAllowsRemoteClients(policy.summary);
}

/**
 * The host to bind. Without the limit, the configured host (or `undefined`,
 * which the listeners read as every interface). Under it, a loopback host;
 * a non-loopback configured host throws.
 */
export function resolveManagedListenHost(
  policy: LoadedManagedPolicy | null,
  configuredHost: string | undefined,
): string | undefined {
  if (!localClientsOnly(policy) || !policy) return configuredHost;
  if (configuredHost === undefined) return MANAGED_LOOPBACK_HOST;
  if (isLoopbackListenHost(configuredHost)) return configuredHost;
  throw new ManagedNetworkExposureError(
    policy,
    `STATION_HOST is ${JSON.stringify(configuredHost.slice(0, 100))}`,
    `Unset STATION_HOST or set it to ${MANAGED_LOOPBACK_HOST}, then start Station again.`,
  );
}

/**
 * A later supervised generation serves on the sockets its supervisor holds,
 * bound by an earlier generation, possibly before the policy was installed.
 * Under the limit each must be loopback; one whose address cannot be read is
 * refused too.
 */
export function assertManagedAdoptedListenersLoopback(
  policy: LoadedManagedPolicy | null,
  addresses: readonly (string | null)[],
): void {
  if (!policy || !localClientsOnly(policy)) return;
  const exposed = addresses.find(
    (address) => address === null || !isLoopbackListenHost(address),
  );
  if (exposed === undefined) return;
  throw new ManagedNetworkExposureError(
    policy,
    `the process supervisor holds a listener bound to ${exposed ?? 'an unreadable address'}`,
    'Quit Station completely and start it again.',
  );
}

/** A relay connector configuration is an opt-in to remote clients. */
export function assertNoManagedRelayConnector(
  policy: LoadedManagedPolicy | null,
  connectorConfigured: boolean,
): void {
  if (!policy || !localClientsOnly(policy) || !connectorConfigured) return;
  throw new ManagedNetworkExposureError(
    policy,
    'STATION_BROKER_CONFIG_FILE configures a relay connector',
    'Unset STATION_BROKER_CONFIG_FILE, then start Station again.',
  );
}

/**
 * Refuses while Tailscale Serve forwards one of `ports`, or while Tailscale
 * is installed but cannot say. Refusing rather than turning routes off is
 * the decision record's choice: Station does not edit another program's
 * configuration, and an administrator sees exactly what was found.
 */
export async function assertNoManagedTailscaleServeExposure(
  policy: LoadedManagedPolicy | null,
  ports: readonly number[],
  command?: TailscaleCommand,
): Promise<void> {
  if (!policy || !localClientsOnly(policy)) return;
  const exposure = await inspectTailscaleServeExposure(ports, command);
  if (exposure.state === 'clear') return;
  if (exposure.state === 'mapped')
    throw new ManagedNetworkExposureError(
      policy,
      `Tailscale Serve forwards port ${exposure.ports.join(', ')} to it`,
      'Turn those routes off (`tailscale serve status` lists them; `tailscale serve reset` turns off every Serve route on this computer), then start Station again.',
    );
  throw new ManagedNetworkExposureError(
    policy,
    `Station cannot tell whether Tailscale Serve forwards to it: ${exposure.detail}`,
    'Start Tailscale and sign in, stop it, or uninstall it, then start Station again.',
  );
}
