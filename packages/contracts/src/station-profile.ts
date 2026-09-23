/**
 * Client-side routing configuration for one Station API endpoint.
 *
 * Profiles deliberately describe where a Station is reached, not where an
 * Agent executes (an Environment) or how that Agent is executed (an engine
 * connection).  This record is safe to serialize: bearer material belongs in
 * the platform credential store and is addressed only by `credentialRef`.
 */
export const STATION_PROFILE_SCHEMA_VERSION = 1 as const;

export type StationProfileSetupSource =
  | 'local'
  | 'existing'
  | 'hosted'
  | 'paired'
  | 'manual';

export type StationProfileConfigurationState =
  | 'configured'
  | 'requires-auth'
  | 'unconfigured';

/** Opaque locator for a credential held by the operating-system keyring. */
export interface StationProfileCredentialRef {
  kind: 'station-bearer';
  id: string;
}

/** Exact local user-service identity recorded only after service installation succeeds. */
export interface StationProfileLocalService {
  instanceId: string;
  baseDir: string;
  serverPort: number;
  uiPort: number;
}

/**
 * Secret-free description of a broker route. The Station signing key is
 * approved and retained separately in the device connection-trust store;
 * broker discovery must never populate or replace that trust record.
 */
export interface StationProfileRelayRoute {
  brokerOrigin: string;
  stationId: string;
  enrollmentId: string;
}

/** Owner-controlled project directory identity mapped to a saved Station. */
export type StationProjectProfileSelections = Record<string, string>;

export interface StationProfile {
  schemaVersion: typeof STATION_PROFILE_SCHEMA_VERSION;
  /** Human-selected, client-local identity; unique case-insensitively. */
  name: string;
  /** Normalized HTTP(S) origin; API paths and bearer material are excluded. */
  endpoint: string;
  /** Device-approved development exception, bound to this exact HTTP origin. */
  developmentHttpOrigin?: string;
  credentialRef?: StationProfileCredentialRef;
  /** Optional server-owned Environment identity learned during pairing. */
  environmentId?: string;
  localService?: StationProfileLocalService;
  /** Saved routing intent only. It does not imply trust, connection, or login. */
  relayRoute?: StationProfileRelayRoute;
  setupSource: StationProfileSetupSource;
  configurationState: StationProfileConfigurationState;
  createdAt: number;
  updatedAt: number;
  /**
   * archive#1818 — set by the local self-provision surfaces only:
   * `station_local_self_provision` (`src-desktop/src/lib.rs`) and, since
   * #1098, the CLI's same-machine self-authorization
   * (`packages/cli/src/commands/local-self-auth.ts`). Both share one
   * semantic: minted once on a local Station's first self-provision, reused
   * when already present, and persisted verbatim on every write after that.
   * This is the identifier the device-pairing server's supersession keys on
   * (`clientInstanceId`,
   * `src-server/services/ssh/device-pairing-service.ts`) to revoke the
   * grant a repeat self-provision replaces, rather than accumulating a new
   * live credential every time. Never rotated once set — see the
   * Rust-side doc comment on `resolve_local_self_provision_client_instance_id`
   * for why a value that must be matched byte-for-byte by the server is
   * persisted rather than derived.
   */
  clientInstanceId?: string;
}

/** Versioned, secret-free user client configuration shared by CLI and native Desktop. */
export interface StationProfileStore {
  schemaVersion: typeof STATION_PROFILE_SCHEMA_VERSION;
  /** Monotonic compare-and-swap token for shared CLI/native mutations. */
  revision: number;
  defaultProfile: string | null;
  profiles: StationProfile[];
  /** Canonical absolute project directory -> saved Station name. */
  projectProfiles: StationProjectProfileSelections;
}

const SETUP_SOURCES = new Set<StationProfileSetupSource>([
  'local',
  'existing',
  'hosted',
  'paired',
  'manual',
]);
const CONFIGURATION_STATES = new Set<StationProfileConfigurationState>([
  'configured',
  'requires-auth',
  'unconfigured',
]);
/**
 * Mirrors the server's own `CLIENT_INSTANCE_ID_PATTERN`
 * (`src-server/services/ssh/device-pairing-service.ts`) byte-for-byte — this
 * value is meaningless unless it can reach that exact route unchanged.
 */
const CLIENT_INSTANCE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATION_PROFILE_FIELDS = new Set([
  'schemaVersion',
  'name',
  'endpoint',
  'credentialRef',
  'environmentId',
  'localService',
  'setupSource',
  'configurationState',
  'createdAt',
  'updatedAt',
  'clientInstanceId',
  'developmentHttpOrigin',
  'relayRoute',
]);
const RELAY_ROUTE_FIELDS = new Set([
  'brokerOrigin',
  'stationId',
  'enrollmentId',
]);
const LOCAL_SERVICE_FIELDS = new Set([
  'instanceId',
  'baseDir',
  'serverPort',
  'uiPort',
]);
const CREDENTIAL_REF_FIELDS = new Set(['kind', 'id']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isSafeStationOrigin(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048)
    return false;
  try {
    const url = new URL(value);
    const strictLoopbackHttp =
      url.protocol === 'http:' &&
      (url.hostname === '[::1]' ||
        url.hostname === '::1' ||
        /^127(?:\.\d{1,3}){3}$/.test(url.hostname));
    return (
      (url.protocol === 'https:' || strictLoopbackHttp) &&
      url.origin === value &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

function isSafeRelayIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  );
}

function hasOnlyFields(
  value: Record<string, unknown>,
  allowedFields: ReadonlySet<string>,
): boolean {
  return Object.keys(value).every((key) => allowedFields.has(key));
}

function isValidCredentialRef(value: unknown): boolean {
  return (
    value === undefined ||
    (isRecord(value) &&
      hasOnlyFields(value, CREDENTIAL_REF_FIELDS) &&
      value.kind === 'station-bearer' &&
      typeof value.id === 'string' &&
      value.id.length > 0)
  );
}

function isNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0;
}

function isValidStationPort(value: unknown): boolean {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 65_535
  );
}

function isValidLocalService(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value) || !hasOnlyFields(value, LOCAL_SERVICE_FIELDS))
    return false;
  return (
    isNonEmptyString(value.instanceId) &&
    isNonEmptyString(value.baseDir) &&
    isValidStationPort(value.serverPort) &&
    isValidStationPort(value.uiPort)
  );
}

function isValidRelayRoute(value: unknown): boolean {
  if (value === undefined) return true;
  return (
    isRecord(value) &&
    hasOnlyFields(value, RELAY_ROUTE_FIELDS) &&
    isSafeStationOrigin(value.brokerOrigin) &&
    isSafeRelayIdentifier(value.stationId) &&
    isSafeRelayIdentifier(value.enrollmentId)
  );
}

function isValidRelayProfileState(value: Record<string, unknown>): boolean {
  if (value.relayRoute === undefined) return true;
  return (
    value.credentialRef === undefined &&
    value.setupSource === 'manual' &&
    value.configurationState === 'unconfigured' &&
    isSafeStationOrigin(value.endpoint)
  );
}

function isValidProfileCore(value: Record<string, unknown>): boolean {
  return (
    value.schemaVersion === STATION_PROFILE_SCHEMA_VERSION &&
    typeof value.name === 'string' &&
    value.name.length > 0 &&
    typeof value.endpoint === 'string' &&
    value.endpoint.length > 0
  );
}

function isValidDevelopmentOrigin(value: Record<string, unknown>): boolean {
  return (
    value.developmentHttpOrigin === undefined ||
    (typeof value.developmentHttpOrigin === 'string' &&
      value.developmentHttpOrigin === value.endpoint &&
      value.developmentHttpOrigin.startsWith('http://'))
  );
}

function isValidProfileSetup(value: Record<string, unknown>): boolean {
  return (
    typeof value.setupSource === 'string' &&
    SETUP_SOURCES.has(value.setupSource as StationProfileSetupSource) &&
    typeof value.configurationState === 'string' &&
    CONFIGURATION_STATES.has(
      value.configurationState as StationProfileConfigurationState,
    )
  );
}

function isValidProfileTimestamps(value: Record<string, unknown>): boolean {
  return (
    typeof value.createdAt === 'number' &&
    Number.isFinite(value.createdAt) &&
    typeof value.updatedAt === 'number' &&
    Number.isFinite(value.updatedAt)
  );
}

function isValidClientInstanceId(value: Record<string, unknown>): boolean {
  return (
    value.clientInstanceId === undefined ||
    (typeof value.clientInstanceId === 'string' &&
      CLIENT_INSTANCE_ID_PATTERN.test(value.clientInstanceId))
  );
}

/** Strict structural validation; corrupt or future metadata fails closed. */
export function isStationProfile(value: unknown): value is StationProfile {
  if (!isRecord(value) || !hasOnlyFields(value, STATION_PROFILE_FIELDS))
    return false;
  return (
    isValidProfileCore(value) &&
    isValidDevelopmentOrigin(value) &&
    isValidCredentialRef(value.credentialRef) &&
    (value.environmentId === undefined ||
      typeof value.environmentId === 'string') &&
    isValidLocalService(value.localService) &&
    isValidRelayRoute(value.relayRoute) &&
    isValidRelayProfileState(value) &&
    isValidProfileSetup(value) &&
    isValidProfileTimestamps(value) &&
    isValidClientInstanceId(value)
  );
}

export function isStationProfileStore(
  value: unknown,
): value is StationProfileStore {
  if (
    !isRecord(value) ||
    value.schemaVersion !== STATION_PROFILE_SCHEMA_VERSION
  ) {
    return false;
  }
  const defaultProfile = value.defaultProfile;
  if (
    typeof value.revision !== 'number' ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0
  ) {
    return false;
  }
  if (defaultProfile !== null && typeof defaultProfile !== 'string') {
    return false;
  }
  if (
    !isRecord(value.projectProfiles) ||
    Object.entries(value.projectProfiles).some(
      ([project, profile]) =>
        project.length === 0 ||
        typeof profile !== 'string' ||
        profile.length === 0,
    )
  ) {
    return false;
  }
  if (
    !Array.isArray(value.profiles) ||
    !value.profiles.every(isStationProfile)
  ) {
    return false;
  }
  const profiles = value.profiles as StationProfile[];
  const projectProfiles = value.projectProfiles as Record<string, string>;
  const names = new Set<string>();
  for (const profile of profiles) {
    const key = profile.name.toLowerCase();
    if (names.has(key)) return false;
    names.add(key);
  }
  const isSelectableProfile = (name: string) =>
    profiles.some(
      (profile) =>
        profile.name.toLowerCase() === name.toLowerCase() &&
        profile.relayRoute === undefined,
    );
  return (
    (defaultProfile === null || isSelectableProfile(defaultProfile)) &&
    Object.values(projectProfiles).every((profile) =>
      isSelectableProfile(profile),
    )
  );
}

export function emptyStationProfileStore(): StationProfileStore {
  return {
    schemaVersion: STATION_PROFILE_SCHEMA_VERSION,
    revision: 0,
    defaultProfile: null,
    profiles: [],
    projectProfiles: {},
  };
}
