import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { encodeNativeRelayLink } from '@kontourai/station-connect/native-relay-link';
import type { SelfHostedBrokerNativeRouteInvitationV2 } from '@kontourai/station-contracts/self-hosted-broker';
import { loadSelfHostedBrokerConnectorConfig } from '../src-server/runtime/bootstrap/self-hosted-connector-config.js';
import { NativeSurfaceRegistry } from '../src-server/services/connections/native-surface-registry.js';
import { invokedDirectly } from './lib/module-entry.mjs';

function requireNewPrivateOutput(path: string): void {
  const parent = lstatSync(dirname(path));
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    parent.uid !== process.getuid?.() ||
    (parent.mode & 0o077) !== 0
  )
    throw new Error('native_invitation_output_not_private');
  try {
    lstatSync(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return;
    throw error;
  }
  throw new Error('native_invitation_output_exists');
}

function publishApprovedInvitationLink(
  homeDir: string,
  applicationOrigin: string,
  invitation: SelfHostedBrokerNativeRouteInvitationV2,
  outputPath: string,
  devScheme?: string,
): void {
  let registry: NativeSurfaceRegistry | undefined;
  try {
    // Never create an approval store or approve a surface as a publishing side effect.
    lstatSync(join(homeDir, 'security', 'native-surfaces.sqlite'));
    registry = new NativeSurfaceRegistry(homeDir, invitation.scope.stationId);
    const approved = registry
      .approvedSurfaces()
      .find(
        (entry) =>
          entry.scope.stationId === invitation.scope.stationId &&
          entry.scope.enrollmentId === invitation.scope.enrollmentId &&
          entry.scope.routingGeneration ===
            invitation.scope.routingGeneration &&
          entry.surface.kind === invitation.surface.kind &&
          entry.surface.appIdentifier === invitation.surface.appIdentifier &&
          entry.surface.channel === invitation.surface.channel &&
          entry.surface.clientInstanceId ===
            invitation.surface.clientInstanceId &&
          entry.surface.keyThumbprint === invitation.surface.keyThumbprint,
      );
    if (!approved?.isCurrent())
      throw new Error('native_invitation_surface_approval_required');
    if (invitation.surface.channel !== 'dev' && devScheme)
      throw new Error('native_invitation_dev_scheme_refused');
    const link = encodeNativeRelayLink(
      {
        version: 'station-native-relay-link/v1',
        kind: 'bound-invitation',
        applicationOrigin: applicationOrigin,
        invitation,
      },
      {
        channel: invitation.surface.channel,
        ...(devScheme ? { devScheme } : {}),
      },
    );
    if (!approved.isCurrent())
      throw new Error('native_invitation_surface_approval_changed');
    writeFileSync(outputPath, `${link}\n`, { flag: 'wx', mode: 0o600 });
  } catch {
    throw new Error('native_invitation_link_refused_after_json_written');
  } finally {
    registry?.close();
  }
}

/** Operator terminal only: public prepare file in, private invitation and optional bound link out. */
export async function writeNativeRelayInvitation(
  args: string[],
): Promise<void> {
  let invitationTtlMs: number | null | undefined;
  const expiryIndex = args.indexOf('--expires-in');
  if (expiryIndex !== -1) {
    const durations: Record<string, number | null> = {
      '5m': 5 * 60_000,
      '15m': 15 * 60_000,
      '1h': 60 * 60_000,
      '24h': 24 * 60 * 60_000,
      never: null,
    };
    const choice = args[expiryIndex + 1];
    if (!choice || !Object.hasOwn(durations, choice))
      throw new Error('native_invitation_usage');
    invitationTtlMs = durations[choice];
    args = [...args.slice(0, expiryIndex), ...args.slice(expiryIndex + 2)];
  }
  if (
    ![4, 6, 8].includes(args.length) ||
    args.slice(0, 4).some((path) => !isAbsolute(path)) ||
    (args.length > 4 &&
      (args[4] !== '--link-output' || !isAbsolute(args[5]!))) ||
    (args.length > 6 && (args[6] !== '--dev-scheme' || !args[7]))
  )
    throw new Error('native_invitation_usage');
  const [homeDir, configPath, preparePath, outputPath] = args;
  const linkOutputPath = args[5];
  const devScheme = args[7];
  requireNewPrivateOutput(outputPath!);
  if (linkOutputPath) {
    if (linkOutputPath === outputPath)
      throw new Error('native_invitation_output_collision');
    requireNewPrivateOutput(linkOutputPath);
  }
  const factory = loadSelfHostedBrokerConnectorConfig({
    homeDir,
    env: { STATION_BROKER_CONFIG_FILE: configPath },
  });
  if (!factory) throw new Error('native_invitation_connector_unconfigured');
  const fd = openSync(
    preparePath!,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  let prepare: unknown;
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > 16 * 1024)
      throw new Error('native_invitation_prepare_invalid');
    const bytes = Buffer.alloc(16 * 1024 + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = readSync(fd, bytes, count, bytes.length - count, null);
      if (!read) break;
      count += read;
    }
    if (count > 16 * 1024) throw new Error('native_invitation_prepare_invalid');
    prepare = JSON.parse(bytes.subarray(0, count).toString('utf8'));
  } finally {
    closeSync(fd);
  }
  const invitation = await factory.issueNativeInvitation(
    prepare,
    AbortSignal.timeout(30_000),
    invitationTtlMs,
  );
  writeFileSync(outputPath!, `${JSON.stringify(invitation)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  if (linkOutputPath)
    publishApprovedInvitationLink(
      homeDir!,
      factory.applicationOrigin,
      invitation,
      linkOutputPath,
      devScheme,
    );
}

if (invokedDirectly(import.meta.url)) {
  writeNativeRelayInvitation(process.argv.slice(2)).then(
    () => {
      process.stdout.write('STATION_NATIVE_INVITATION_WRITTEN\n');
    },
    (error: unknown) => {
      // Errors may originate from credential-bearing responses; never print them.
      process.stderr.write(
        error instanceof Error &&
          error.message === 'native_invitation_link_refused_after_json_written'
          ? 'Invitation JSON was written privately; the requested link was refused. Verify the current approved surface and receiver scheme before using new output paths.\n'
          : 'Native invitation refused. Expected absolute home, connector config, prepare JSON, and new private output paths; optional --expires-in 5m|15m|1h|24h|never, --link-output and explicit dev --dev-scheme.\n',
      );
      process.exitCode = 1;
    },
  );
}
