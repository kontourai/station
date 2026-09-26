import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { ApprovedStationConnectionTrust } from '@kontourai/station-contracts/connection-proof';
import {
  acquireStationHomeMaintenanceLease,
  StationHomeActiveError,
} from '@kontourai/station-shared/station-home-lifecycle';
import { ensureStationHomeSchemaSync } from '@kontourai/station-shared/station-home-schema';
import { calculateJwkThumbprint } from 'jose';
import { ConnectionSigningKeyStore } from '../src-server/services/ssh/connection-signing-key-store.js';
import { EnvironmentSecurityService } from '../src-server/services/ssh/environment-security-service.js';
import { invokedDirectly } from './lib/module-entry.mjs';

const SCHEMA = 'station.self-hosted-connector-identity/v1';
const USAGE = 'Usage: npm run connector:identity -- /absolute/station-home';

/**
 * Offline identity prerequisite for the normal self-hosted connector
 * entrypoint. Refuses an active home BEFORE writes (maintenance lease, no
 * force/stash/reset), then initializes environment identity and the
 * connection-signing key under exclusive ownership. Idempotent: repeated
 * runs converge on the existing key. Corruption refuses.
 *
 * Output is the public descriptor plus the expected key thumbprint only:
 * never the environment record, private key, or operator credential.
 */
export async function initializeConnectorIdentity(homeDir: string): Promise<{
  trust: ApprovedStationConnectionTrust;
  keyId: string;
}> {
  if (!homeDir || !isAbsolute(homeDir) || homeDir.includes('\0'))
    throw new Error('connector_identity_path_not_absolute');
  if (process.platform === 'win32')
    throw new Error('connector_identity_custody_unsupported_on_windows');
  // Reject a symlinked home alias before the lease so an alias cannot
  // bypass active-home protection; canonicalize only for the lease/schema
  // path after the alias check.
  let canonical: string;
  try {
    if (lstatSync(homeDir).isSymbolicLink())
      throw new Error('connector_identity_home_symlink');
    canonical = realpathSync(homeDir);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith('connector_identity_')
    )
      throw error;
    // Only missing homes may be initialized; other custody failures refuse.
    if (
      !error ||
      typeof error !== 'object' ||
      !('code' in error) ||
      error.code !== 'ENOENT'
    )
      throw new Error('connector_identity_home_unavailable');
    canonical = homeDir;
  }
  const lease = (() => {
    try {
      return acquireStationHomeMaintenanceLease(canonical);
    } catch (error) {
      if (error instanceof StationHomeActiveError)
        throw new Error('connector_identity_home_active');
      throw error;
    }
  })();
  try {
    ensureStationHomeSchemaSync(canonical);
    const environment = new EnvironmentSecurityService({ homeDir: canonical });
    await environment.initialize();
    const store = new ConnectionSigningKeyStore(canonical);
    const trust = await store.initialize();
    return { trust, keyId: await calculateJwkThumbprint(trust.signingKey) };
  } finally {
    lease.release();
  }
}

if (invokedDirectly(import.meta.url)) {
  if (process.argv.length === 3 && process.argv[2] === '--help') {
    console.log(USAGE);
  } else {
    const homeDir = process.argv[2];
    if (process.argv.length !== 3 || !homeDir) {
      console.error(
        JSON.stringify({
          schema: SCHEMA,
          status: 'refused',
          reason: 'invalid_arguments',
        }),
      );
      console.error(USAGE);
      process.exitCode = 1;
    } else {
      await initializeConnectorIdentity(homeDir).then(
        ({ trust, keyId }) => {
          console.log(
            JSON.stringify({ schema: SCHEMA, status: 'present', trust, keyId }),
          );
        },
        (error: unknown) => {
          const code =
            error && typeof error === 'object' && 'code' in error
              ? error.code
              : undefined;
          const message =
            typeof code === 'string'
              ? code
              : error instanceof Error
                ? error.message
                : '';
          const known = [
            'connector_identity_path_not_absolute',
            'connector_identity_custody_unsupported_on_windows',
            'connector_identity_home_symlink',
            'connector_identity_home_active',
            'invalid_arguments',
            'key_store_missing',
            'key_store_invalid',
            'key_generation_conflict',
          ];
          const reason =
            known.find((value) => value === message) ??
            'connector_identity_unavailable';
          // Filesystem and parser exceptions may contain private paths or
          // input. Report only closed reason codes.
          console.error(
            JSON.stringify({ schema: SCHEMA, status: 'refused', reason }),
          );
          process.exitCode = 1;
        },
      );
    }
  }
}
