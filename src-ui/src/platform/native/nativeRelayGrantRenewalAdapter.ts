import {
  type NativeRelayGrantRenewalAdapter,
  type NativeRelayGrantRenewalStatus,
  type NativeRelayRouteSelection,
} from './nativeRelayGrantRenewalSupervisor';
import { invokeTauri } from './tauriInvoke';

/** Matches the broker's fixed MAX_GRANT_AGE_MS renewal window (24 hours). */
export const NATIVE_RELAY_GRANT_RENEWAL_WINDOW_MS = 24 * 60 * 60 * 1_000;

type RecordValue = Record<string, unknown>;
type Invoke = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;

function record(value: unknown, label: string): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid native relay grant ${label}.`);
  }
  return value as RecordValue;
}

function exactKeys(
  value: RecordValue,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new Error(`Invalid native relay grant ${label} fields.`);
  }
}

function stringField(value: unknown, label: string, maxLength = 2_048): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength
  ) {
    throw new Error(`Invalid native relay grant ${label}.`);
  }
  return value;
}

function integerField(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(`Invalid native relay grant ${label}.`);
  }
  return value as number;
}

function booleanField(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`Invalid native relay grant ${label}.`);
  }
  return value;
}

function arrayField(value: unknown, label: string, limit: number): unknown[] {
  if (!Array.isArray(value) || value.length > limit) {
    throw new Error(`Invalid native relay grant ${label}.`);
  }
  return value;
}

function normalizedOrigin(value: unknown, label: string): string {
  const origin = stringField(value, label);
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error(`Invalid native relay grant ${label}.`);
  }
  const loopbackHttp =
    url.protocol === 'http:' &&
    (url.hostname === 'localhost' ||
      url.hostname === '[::1]' ||
      url.hostname === '::1' ||
      /^127(?:\.\d{1,3}){3}$/u.test(url.hostname));
  if (
    (url.protocol !== 'https:' && !loopbackHttp) ||
    url.origin !== origin ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error(`Invalid native relay grant ${label}.`);
  }
  return origin;
}

interface GrantRoute {
  brokerOrigin: string;
  stationId: string;
  enrollmentId: string;
  routingGeneration: number;
  grantId: string;
}

function parseRoute(value: unknown, label: string): GrantRoute {
  const dto = record(value, `${label} route`);
  exactKeys(
    dto,
    [
      'brokerOrigin',
      'stationId',
      'enrollmentId',
      'routingGeneration',
      'grantId',
    ],
    `${label} route`,
  );
  return {
    brokerOrigin: normalizedOrigin(dto.brokerOrigin, `${label}.brokerOrigin`),
    stationId: stringField(dto.stationId, `${label}.stationId`, 128),
    enrollmentId: stringField(dto.enrollmentId, `${label}.enrollmentId`, 128),
    routingGeneration: integerField(
      dto.routingGeneration,
      `${label}.routingGeneration`,
      1,
    ),
    grantId: stringField(dto.grantId, `${label}.grantId`, 512),
  };
}

function routeMatchesSelection(
  route: GrantRoute,
  selection: NativeRelayRouteSelection,
): boolean {
  return (
    route.brokerOrigin === selection.brokerOrigin &&
    route.stationId === selection.stationId &&
    route.enrollmentId === selection.enrollmentId
  );
}

interface GrantMetadata {
  route: GrantRoute;
  expiresAt: number;
}

function parseMetadata(
  value: unknown,
  selection: NativeRelayRouteSelection,
  label: string,
): GrantMetadata {
  const dto = record(value, label);
  exactKeys(
    dto,
    ['route', 'stationSigningKeyId', 'stationSigningGeneration', 'expiresAt'],
    label,
  );
  const route = parseRoute(dto.route, label);
  if (!routeMatchesSelection(route, selection)) {
    throw new Error(
      `Native relay grant ${label} does not match the saved route.`,
    );
  }
  stringField(dto.stationSigningKeyId, `${label}.stationSigningKeyId`, 512);
  integerField(
    dto.stationSigningGeneration,
    `${label}.stationSigningGeneration`,
    1,
  );
  const expiresAt = integerField(dto.expiresAt, `${label}.expiresAt`, 1);
  return { route, expiresAt };
}

function parseCleanup(
  value: unknown,
  selection: NativeRelayRouteSelection,
): boolean {
  const dto = record(value, 'cleanup status');
  exactKeys(
    dto,
    [
      'cleanupId',
      'route',
      'stagedAt',
      'recordPresent',
      'brokerRetired',
      'localCleanupRequired',
      'localCleanupComplete',
    ],
    'cleanup status',
  );
  stringField(dto.cleanupId, 'cleanup.cleanupId', 512);
  const route = parseRoute(dto.route, 'cleanup');
  if (!routeMatchesSelection(route, selection)) {
    throw new Error(
      'Native relay cleanup status does not match the saved route.',
    );
  }
  integerField(dto.stagedAt, 'cleanup.stagedAt', 1);
  const recordPresent = booleanField(
    dto.recordPresent,
    'cleanup.recordPresent',
  );
  const brokerRetired = booleanField(
    dto.brokerRetired,
    'cleanup.brokerRetired',
  );
  const localCleanupRequired = booleanField(
    dto.localCleanupRequired,
    'cleanup.localCleanupRequired',
  );
  const localCleanupComplete = booleanField(
    dto.localCleanupComplete,
    'cleanup.localCleanupComplete',
  );
  return (
    recordPresent ||
    !brokerRetired ||
    (localCleanupRequired && !localCleanupComplete)
  );
}

function parseStatus(
  value: unknown,
  selection: NativeRelayRouteSelection,
): NativeRelayGrantRenewalStatus {
  const dto = record(value, 'status');
  exactKeys(
    dto,
    [
      'profileName',
      'profileRevision',
      'stationId',
      'enrollmentId',
      'grants',
      'cleanups',
    ],
    'status',
  );
  const profileName = stringField(dto.profileName, 'profileName', 256);
  const profileRevision = integerField(
    dto.profileRevision,
    'profileRevision',
    1,
  );
  const stationId = stringField(dto.stationId, 'stationId', 128);
  const enrollmentId = stringField(dto.enrollmentId, 'enrollmentId', 128);
  if (
    profileName !== selection.profileName ||
    stationId !== selection.stationId ||
    enrollmentId !== selection.enrollmentId
  ) {
    throw new Error(
      'Native relay grant status does not match the selected profile.',
    );
  }

  const cleanups = arrayField(dto.cleanups, 'cleanup list', 64);
  if (cleanups.some((cleanup) => parseCleanup(cleanup, selection))) {
    throw new Error('Native relay grant route has cleanup pending.');
  }

  const grantItems = arrayField(dto.grants, 'grant list', 32);
  const grants = grantItems.map((item) => {
    const entry = record(item, 'status item');
    exactKeys(entry, ['metadata', 'expired'], 'status item');
    // An expired grant may still be renewable through the host's bounded
    // receipt-grace path; the renewal command is the final authority.
    booleanField(entry.expired, 'expired');
    return parseMetadata(entry.metadata, selection, 'metadata');
  });
  if (grants.length > 1) {
    throw new Error('Native relay grant status is ambiguous.');
  }
  const grant = grants[0];
  return {
    profileName,
    brokerOrigin: selection.brokerOrigin,
    stationId,
    enrollmentId,
    profileRevision,
    grant: grant
      ? {
          expiresAt: grant.expiresAt,
          lifetimeMs: NATIVE_RELAY_GRANT_RENEWAL_WINDOW_MS,
        }
      : null,
  };
}

export function createNativeRelayGrantRenewalAdapter(
  invoke: Invoke = invokeTauri,
): NativeRelayGrantRenewalAdapter {
  return {
    status: async (selection) =>
      parseStatus(
        await invoke<unknown>('station_native_relay_grant_status', {
          profileName: selection.profileName,
        }),
        selection,
      ),
    renew: async ({ selection, expectedProfileRevision }) => {
      const profileName = stringField(
        selection.profileName,
        'profileName',
        256,
      );
      const expectedRevision = integerField(
        expectedProfileRevision,
        'expectedProfileRevision',
        1,
      );
      const metadata = parseMetadata(
        await invoke<unknown>('station_native_relay_grant_renew', {
          profileName,
          expectedProfileRevision: expectedRevision,
        }),
        selection,
        'renewal metadata',
      );
      if (metadata.expiresAt <= Date.now()) {
        throw new Error(
          'Native relay grant renewal returned an expired grant.',
        );
      }
      return {
        expiresAt: metadata.expiresAt,
        lifetimeMs: NATIVE_RELAY_GRANT_RENEWAL_WINDOW_MS,
      };
    },
  };
}

export const nativeRelayGrantRenewalAdapter =
  createNativeRelayGrantRenewalAdapter();
