/**
 * Resolve the one development context for a source-checkout invocation before
 * loading the CLI.  The launcher changes cwd to the checkout, but a caller's
 * cwd is not an identity: two projects can invoke the same Station checkout.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveStationChannel,
  stationChannelPorts,
} from '@kontourai/station-shared/ports';
import { resolveStationRoot } from '@kontourai/station-shared/runtime-path-resolver';
import {
  deriveDevInstanceAndHome,
  resolveDevOffset,
  resolveWorktreePath,
} from '../packages/cli/src/commands/dev-ports.js';

export interface SourceBootstrapContext {
  readonly stationCodeRoot: string;
  readonly stationRoot: string;
  readonly channel: 'development' | 'stable' | 'beta' | 'nightly';
  readonly instanceId: string;
  readonly serverPort: number;
  readonly uiPort: number;
  readonly consentPort: number;
}

function explicitPort(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(
      `Station port must be an integer from 1 to 65535; received ${JSON.stringify(value)}.`,
    );
  }
  return port;
}

/**
 * Mutates only launch facts.  In particular, it never synthesizes
 * `STATION_HOME`: lifecycle home selection must still identify its source as
 * `default`, and an original explicit override remains the only env home.
 */
export function initializeSourceBootstrap({
  env = process.env,
  wrapperUrl,
}: {
  env?: NodeJS.ProcessEnv;
  wrapperUrl: string;
}): SourceBootstrapContext {
  const stationCodeRoot = resolve(dirname(fileURLToPath(wrapperUrl)), '..');
  const stationRoot = resolveStationRoot(env);
  const channel = resolveStationChannel(env.STATION_CHANNEL);
  const channelPorts = stationChannelPorts(channel);

  let instanceId = env.STATION_INSTANCE_ID?.trim() || channel;
  let serverPort = explicitPort(env.STATION_SERVER_PORT ?? env.STATION_PORT);
  let uiPort = explicitPort(env.STATION_UI_PORT);
  const explicitConsentPort = explicitPort(env.STATION_CONSENT_PORT);
  let consentPort = explicitConsentPort;

  if (channel === 'development') {
    // A linked worktree root is preferred, but an ordinary source checkout is
    // still a distinct code root and must never collapse onto base dev ports.
    const worktreePath =
      resolveWorktreePath(stationCodeRoot) ?? stationCodeRoot;
    const { instance } = deriveDevInstanceAndHome({
      cwd: stationCodeRoot,
      worktreePath,
      // Preserve the user's raw seed.  The canonical derived identity belongs
      // in STATION_INSTANCE_ID, not back in STATION_DEV_INSTANCE.
      devInstance: env.STATION_DEV_INSTANCE,
      stationRoot,
    });
    const { offset } = resolveDevOffset({
      worktreePath,
      devInstance: env.STATION_DEV_INSTANCE,
      portOffset: env.STATION_PORT_OFFSET
        ? Number(env.STATION_PORT_OFFSET)
        : undefined,
    });
    instanceId = instance;
    serverPort ??= channelPorts.serverPort + offset;
    uiPort ??= channelPorts.uiPort + offset;
    consentPort ??= serverPort + 3;
  } else {
    serverPort ??= channelPorts.serverPort;
    uiPort ??= channelPorts.uiPort;
    consentPort ??= serverPort + 3;
  }

  env.STATION_ROOT = stationRoot;
  env.STATION_CHANNEL = channel;
  env.STATION_INSTANCE_ID = instanceId;
  // The lifecycle parser reads STATION_SERVER_PORT while request resolution
  // reads STATION_PORT.  Export the one computed API port through both names.
  env.STATION_SERVER_PORT = String(serverPort);
  env.STATION_PORT = String(serverPort);
  env.STATION_UI_PORT = String(uiPort);
  if (explicitConsentPort !== undefined)
    env.STATION_CONSENT_PORT = String(consentPort);
  else delete env.STATION_CONSENT_PORT;
  if (env.STATION_HOME?.trim()) env.STATION_HOME = resolve(env.STATION_HOME);

  return {
    stationCodeRoot,
    stationRoot,
    channel,
    instanceId,
    serverPort,
    uiPort,
    consentPort,
  };
}
