import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { openPrivateSqlite } from '../../utils/private-sqlite.js';
import type { ProjectMembershipService } from '../projects/project-membership-service.js';
import {
  createDeploymentAuthenticationHost,
  type LoadedDeploymentAuthentication,
  readAuthenticationBrowserOrigins,
} from './deployment-authentication-loader.js';
import { DeploymentAuthenticationService } from './deployment-authentication-service.js';
import {
  createLocalAccountProvider,
  type LocalAccountProvider,
} from './local-account-provider.js';

export interface LocalAccountConfiguration {
  publicOrigin: string;
  allowedBrowserOrigins?: readonly string[];
}
export interface LoadedLocalAccounts extends LoadedDeploymentAuthentication {
  administration: LocalAccountProvider['administration'];
  issueRecovery: LocalAccountProvider['issueRecovery'];
}
export function readLocalAccountConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
): LocalAccountConfiguration | undefined {
  const enabled = environment.STATION_LOCAL_ACCOUNTS;
  if (enabled !== undefined && enabled !== '0' && enabled !== '1')
    throw new Error('STATION_LOCAL_ACCOUNTS must be 0 or 1.');
  if (enabled !== '1') return undefined;
  if (environment.STATION_AUTHENTICATION_MODULE)
    throw new Error(
      'Choose local accounts or an authentication module, not both.',
    );
  const publicOrigin = environment.STATION_AUTHENTICATION_ORIGIN;
  if (!publicOrigin)
    throw new Error('Local accounts require a public authentication origin.');
  const allowedBrowserOrigins = readAuthenticationBrowserOrigins(environment);
  return {
    publicOrigin,
    ...(allowedBrowserOrigins ? { allowedBrowserOrigins } : {}),
  };
}

function readOrCreateSecret(stateDirectory: string, stationId: string): string {
  const hasAccounts = existsSync(join(stateDirectory, 'local-accounts.sqlite'));
  const database = openPrivateSqlite(
    join(stateDirectory, 'local-account-authority.sqlite'),
    'Local account authority',
  );
  try {
    database.exec('BEGIN IMMEDIATE');
    database.exec(
      'CREATE TABLE IF NOT EXISTS local_account_authority (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL, station_id TEXT NOT NULL, secret TEXT NOT NULL) STRICT',
    );
    let row = database
      .prepare(
        'SELECT version, station_id, secret FROM local_account_authority WHERE id = 1',
      )
      .get();
    if (!row) {
      if (hasAccounts)
        throw new Error(
          'Local account authority is missing for an existing account store.',
        );
      const secret = randomBytes(32).toString('hex');
      database
        .prepare(
          'INSERT INTO local_account_authority(id, version, station_id, secret) VALUES (1, 1, ?, ?)',
        )
        .run(stationId, secret);
      row = { version: 1, station_id: stationId, secret };
    }
    if (
      row.version !== 1 ||
      row.station_id !== stationId ||
      typeof row.secret !== 'string' ||
      !/^[a-f0-9]{64}$/.test(row.secret)
    )
      throw new Error(
        'Local account authority is incompatible with this Station.',
      );
    database.exec('COMMIT');
    return row.secret;
  } finally {
    database.close();
  }
}

/** Production composition: local passwords use the same provider contract and real Project invitation owner. */
export async function loadLocalAccounts(
  configuration: LocalAccountConfiguration,
  host: { stationId: string; homeDirectory: string },
  membership: Pick<ProjectMembershipService, 'mayRegister'>,
): Promise<LoadedLocalAccounts> {
  const input = structuredClone(configuration);
  const providerHost = await createDeploymentAuthenticationHost(
    input.publicOrigin,
    host,
    input.allowedBrowserOrigins,
  );
  let provider: LocalAccountProvider | undefined;
  try {
    provider = await createLocalAccountProvider(
      providerHost,
      readOrCreateSecret(providerHost.stateDirectory, host.stationId),
      {
        mayRegister: (value) => membership.mayRegister(value),
        deliver: async () => {
          throw new Error(
            'This Station uses local username accounts without email delivery.',
          );
        },
      },
      'username-password',
    );
    return {
      service: new DeploymentAuthenticationService(provider),
      publicOrigin: providerHost.publicOrigin,
      allowedBrowserOrigins: providerHost.allowedBrowserOrigins,
      administration: provider.administration,
      issueRecovery: provider.issueRecovery.bind(provider),
    };
  } catch (error) {
    await provider?.close?.();
    throw error;
  }
}
