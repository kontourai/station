import type { Stats } from 'node:fs';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ENVIRONMENT_SECURITY_SCHEMA_VERSION,
  type EnvironmentSecurityRecord,
} from '@kontourai/station-contracts/environment-security';
import { admitStationRuntimeHome } from './runtime-path-resolver.js';
import {
  readStationHomeSchemaVersion,
  STATION_HOME_SCHEMA_VERSION,
} from './station-home-schema.js';

const PRIVATE_DIRECTORY_MODE = 0o700;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export class EnvironmentSecurityRecordError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'EnvironmentSecurityRecordError';
  }
}

function validateRecord(value: unknown): EnvironmentSecurityRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new EnvironmentSecurityRecordError(
      'Invalid environment security record: expected an object',
    );
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 3 ||
    keys[0] !== 'credential' ||
    keys[1] !== 'environmentId' ||
    keys[2] !== 'schemaVersion'
  ) {
    throw new EnvironmentSecurityRecordError(
      'Invalid environment security record schema',
    );
  }
  if (record.schemaVersion !== ENVIRONMENT_SECURITY_SCHEMA_VERSION) {
    throw new EnvironmentSecurityRecordError(
      'Unsupported environment security record version',
    );
  }
  if (
    typeof record.environmentId !== 'string' ||
    !UUID_PATTERN.test(record.environmentId)
  ) {
    throw new EnvironmentSecurityRecordError(
      'Invalid environment security record environment id',
    );
  }
  if (
    typeof record.credential !== 'string' ||
    !BASE64URL_PATTERN.test(record.credential) ||
    Buffer.from(record.credential, 'base64url').byteLength !== 32
  ) {
    throw new EnvironmentSecurityRecordError(
      'Invalid environment security record credential',
    );
  }
  return {
    schemaVersion: ENVIRONMENT_SECURITY_SCHEMA_VERSION,
    environmentId: record.environmentId,
    credential: record.credential,
  };
}

export function readEnvironmentSecurityRecord(
  recordPath: string,
): EnvironmentSecurityRecord {
  let status: Stats;
  try {
    status = lstatSync(recordPath);
  } catch (error) {
    throw new EnvironmentSecurityRecordError(
      'Environment security record is missing',
      { cause: error },
    );
  }
  if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1) {
    throw new EnvironmentSecurityRecordError(
      'Unsafe environment security record type',
    );
  }
  if (process.platform !== 'win32' && (status.mode & 0o777) !== 0o600) {
    throw new EnvironmentSecurityRecordError(
      'Unsafe environment security record permissions',
    );
  }
  try {
    return validateRecord(JSON.parse(readFileSync(recordPath, 'utf8')));
  } catch (error) {
    if (error instanceof EnvironmentSecurityRecordError) throw error;
    throw new EnvironmentSecurityRecordError(
      'Corrupt environment security record',
      { cause: error },
    );
  }
}
export function assertExistingSecurityDirectory(
  securityDir: string,
  enforcePrivateMode = true,
): Stats {
  let status: Stats;
  try {
    status = lstatSync(securityDir);
  } catch (error) {
    throw new EnvironmentSecurityRecordError(
      'Environment security directory is missing',
      { cause: error },
    );
  }
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new EnvironmentSecurityRecordError(
      'Invalid environment security directory',
    );
  }
  if (
    enforcePrivateMode &&
    process.platform !== 'win32' &&
    (status.mode & 0o777) !== PRIVATE_DIRECTORY_MODE
  ) {
    throw new EnvironmentSecurityRecordError(
      'Unsafe environment security directory permissions',
    );
  }
  return status;
}

/** Same read-only local authority for host services and the packaged CLI. */
export function readExistingEnvironmentSecurityRecord(
  home: string,
): EnvironmentSecurityRecord {
  const homeDir = admitStationRuntimeHome(home);
  const schemaVersion = readStationHomeSchemaVersion(homeDir);
  if (schemaVersion !== STATION_HOME_SCHEMA_VERSION)
    throw new EnvironmentSecurityRecordError(
      `Unsupported Station home schema version ${schemaVersion}; expected ${STATION_HOME_SCHEMA_VERSION}`,
    );
  const securityDir = join(homeDir, 'security');
  assertExistingSecurityDirectory(securityDir);
  return readEnvironmentSecurityRecord(join(securityDir, 'environment.json'));
}
