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

/** Owner-controlled project directory identity mapped to a saved Station. */
export type StationProjectProfileSelections = Record<string, string>;

export interface StationProfile {
  schemaVersion: typeof STATION_PROFILE_SCHEMA_VERSION;
  /** Human-selected, client-local identity; unique case-insensitively. */
  name: string;
  /** Normalized HTTP(S) origin; API paths and bearer material are excluded. */
  endpoint: string;
  credentialRef?: StationProfileCredentialRef;
  /** Optional server-owned Environment identity learned during pairing. */
  environmentId?: string;
  localService?: StationProfileLocalService;
  setupSource: StationProfileSetupSource;
  configurationState: StationProfileConfigurationState;
  createdAt: number;
  updatedAt: number;
  /**
   * archive#1818 — set only by
   * `station_local_self_provision` (`src-desktop/src/lib.rs`), minted once
   * on a local Station's first self-provision and persisted verbatim on
   * every write after that. This is the identifier the device-pairing
   * server's supersession keys on (`clientInstanceId`,
   * `src-server/services/ssh/device-pairing-service.ts`) to revoke the
   * grant a repeat self-provision replaces, rather than accumulating a new
   * live credential every time. Never authored by the CLI (`station setup
   * local` has no reason to mint one) and never rotated once set — see the
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Strict structural validation; corrupt or future metadata fails closed. */
export function isStationProfile(value: unknown): value is StationProfile {
  if (!isRecord(value)) return false;
  const allowed = new Set([
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
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return false;
  const credentialRef = value.credentialRef;
  return (
    value.schemaVersion === STATION_PROFILE_SCHEMA_VERSION &&
    typeof value.name === 'string' &&
    value.name.length > 0 &&
    typeof value.endpoint === 'string' &&
    value.endpoint.length > 0 &&
    (credentialRef === undefined ||
      (isRecord(credentialRef) &&
        Object.keys(credentialRef).every(
          (key) => key === 'kind' || key === 'id',
        ) &&
        credentialRef.kind === 'station-bearer' &&
        typeof credentialRef.id === 'string' &&
        credentialRef.id.length > 0)) &&
    (value.environmentId === undefined ||
      typeof value.environmentId === 'string') &&
    (value.localService === undefined ||
      (isRecord(value.localService) &&
        Object.keys(value.localService).every((key) =>
          ['instanceId', 'baseDir', 'serverPort', 'uiPort'].includes(key),
        ) &&
        typeof value.localService.instanceId === 'string' &&
        value.localService.instanceId.length > 0 &&
        typeof value.localService.baseDir === 'string' &&
        value.localService.baseDir.length > 0 &&
        typeof value.localService.serverPort === 'number' &&
        Number.isInteger(value.localService.serverPort) &&
        value.localService.serverPort >= 1 &&
        value.localService.serverPort <= 65_535 &&
        typeof value.localService.uiPort === 'number' &&
        Number.isInteger(value.localService.uiPort) &&
        value.localService.uiPort >= 1 &&
        value.localService.uiPort <= 65_535)) &&
    typeof value.setupSource === 'string' &&
    SETUP_SOURCES.has(value.setupSource as StationProfileSetupSource) &&
    typeof value.configurationState === 'string' &&
    CONFIGURATION_STATES.has(
      value.configurationState as StationProfileConfigurationState,
    ) &&
    typeof value.createdAt === 'number' &&
    Number.isFinite(value.createdAt) &&
    typeof value.updatedAt === 'number' &&
    Number.isFinite(value.updatedAt) &&
    (value.clientInstanceId === undefined ||
      (typeof value.clientInstanceId === 'string' &&
        CLIENT_INSTANCE_ID_PATTERN.test(value.clientInstanceId)))
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
  const hasProfile = (name: string) =>
    profiles.some(
      (profile) => profile.name.toLowerCase() === name.toLowerCase(),
    );
  return (
    (defaultProfile === null || hasProfile(defaultProfile)) &&
    Object.values(projectProfiles).every((profile) => hasProfile(profile))
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
