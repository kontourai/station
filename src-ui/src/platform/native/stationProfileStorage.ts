import {
  createAccessEndpoint,
  createDirectHttpAccessMethod,
  defaultStorage,
  httpDevelopmentOrigin,
  type SavedConnection,
  type StationHandshakeIdentity,
  type StorageAdapter,
} from '@kontourai/station-connect';
import {
  emptyStationProfileStore,
  isStationProfileStore,
  type StationProfile,
  type StationProfileCredentialRef,
  type StationProfileRelayRoute,
  type StationProfileStore,
} from '@kontourai/station-contracts';
import { randomCorrelationId } from '@kontourai/station-shared/random-id';
import { invokeTauri } from './tauriInvoke';

const CONNECTIONS_KEY = 'station-connect-connections';
const ACTIVE_KEY = `${CONNECTIONS_KEY}-active`;
const EXPLICIT_SELECTION_KEY = 'station-native-profile-selection-v1';

interface ExplicitSelectionRecord {
  schemaVersion: 1;
  connectionId: string;
}

interface LegacyConnectionSelection {
  id: string;
  url: string;
  environmentId?: string;
}

interface TauriInvoker {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

/**
 * The only durable desktop-pairing mutation. Callers may invoke it only with
 * an identity returned from the schema-validated public handshake; health,
 * endpoint selection, and transient ConnectionStore writes never pass here.
 */
export interface VerifiedStationProfilePairing {
  connectionId: string;
  /** Candidate display name and endpoint, accepted only after the handshake. */
  name: string;
  endpoint: string;
  handshake: StationHandshakeIdentity;
  /** Exact UUID used by this pairing exchange; the server grant binds it. */
  clientInstanceId: string;
  /** Newly exchanged bearer value, if the pairing flow rotated it. */
  credential?: string;
  /** Opaque host-owned native exchange handle; never contains a bearer. */
  credentialHandle?: string;
  /** An explicit keyring-reference rotation, not an inferred environment id. */
  nextCredentialRef?: StationProfileCredentialRef;
}

function normalizedPairingEndpoint(
  value: string,
  developmentHttpOrigin?: string,
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      'A paired saved Station requires a valid http(s) endpoint.',
    );
  }
  const strictLoopbackHttp =
    url.hostname === '[::1]' ||
    url.hostname === '::1' ||
    /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    (url.protocol === 'http:' &&
      !strictLoopbackHttp &&
      developmentHttpOrigin !== url.origin) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'A paired saved Station endpoint must be HTTPS or strict loopback HTTP, with no credentials or path.',
    );
  }
  return url.origin;
}

function credentialBearingEndpointIsSafe(profile: StationProfile): boolean {
  if (!profile.credentialRef) return true;
  try {
    return (
      normalizedPairingEndpoint(
        profile.endpoint,
        profile.developmentHttpOrigin,
      ) === profile.endpoint
    );
  } catch {
    return false;
  }
}

/** Opaque renderer receipt for one already-authorized native profile epoch. */
export interface NativeProfileRequestBinding {
  bindingId: string;
  exactOrigin: string;
}

export interface SaveRelayRouteProfileInput {
  connectionId?: string;
  expectedUpdatedAt?: number;
  name: string;
  endpoint: string;
  relayRoute: StationProfileRelayRoute;
}

function existingRelayRouteProfile(
  profiles: readonly StationProfile[],
  input: SaveRelayRouteProfileInput,
): StationProfile | undefined {
  if (!input.connectionId) return undefined;
  const profile = profiles.find(
    (candidate) =>
      profileConnectionId(candidate) === input.connectionId &&
      candidate.relayRoute !== undefined,
  );
  if (!profile || profile.updatedAt !== input.expectedUpdatedAt)
    throw new Error('This saved relay route changed; reopen it and retry.');
  return profile;
}

function hasUniqueProfileName(
  profiles: readonly StationProfile[],
  name: string,
  existing?: StationProfile,
): boolean {
  return !profiles.some(
    (candidate) =>
      candidate !== existing &&
      candidate.name.toLowerCase() === name.toLowerCase(),
  );
}

function normalizeRelayRouteProfileInput(
  input: SaveRelayRouteProfileInput,
  profiles: readonly StationProfile[],
  existing?: StationProfile,
): Omit<StationProfile, 'schemaVersion' | 'createdAt' | 'updatedAt'> {
  if (
    Object.keys(input.relayRoute).sort().join(',') !==
    'brokerOrigin,enrollmentId,stationId'
  )
    throw new Error(
      'Relay profiles accept only broker origin and Station enrollment identifiers.',
    );
  const endpoint = normalizedPairingEndpoint(input.endpoint.trim());
  const name = input.name.trim() || new URL(endpoint).hostname;
  const brokerOrigin = normalizedPairingEndpoint(
    input.relayRoute.brokerOrigin.trim(),
  );
  if (!hasUniqueProfileName(profiles, name, existing))
    throw new Error('Choose a unique Station name.');
  // Native route-grant custody binds to this stable, secret-free local owner.
  // An older saved route gains one on its next deliberate edit. Never fall
  // back to Math.random for a keyring account namespace.
  if (!existing?.clientInstanceId && !globalThis.crypto?.getRandomValues)
    throw new Error('Secure local identity is unavailable for this route.');
  return {
    name,
    endpoint,
    clientInstanceId: existing?.clientInstanceId ?? randomCorrelationId(),
    relayRoute: {
      brokerOrigin,
      stationId: input.relayRoute.stationId,
      enrollmentId: input.relayRoute.enrollmentId,
    },
    setupSource: 'manual',
    configurationState: 'unconfigured',
  };
}

function relayRouteProfile(
  normalized: Omit<StationProfile, 'schemaVersion' | 'createdAt' | 'updatedAt'>,
  existing?: StationProfile,
): StationProfile {
  const now = Date.now();
  return {
    schemaVersion: 1,
    ...normalized,
    createdAt: existing?.createdAt ?? now,
    updatedAt: existing ? Math.max(now, existing.updatedAt + 1) : now,
  };
}

function parseNativeProfileAuthorizationReceipt(
  value: unknown,
  exactOrigin: string,
): NativeProfileRequestBinding | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const receipt = value as Record<string, unknown>;
  if (
    Object.keys(receipt).length !== 2 ||
    typeof receipt.bindingId !== 'string' ||
    !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(
      receipt.bindingId,
    ) ||
    receipt.exactOrigin !== exactOrigin
  )
    return null;
  return { bindingId: receipt.bindingId, exactOrigin };
}

function collisionSafeProfileName(
  preferred: string,
  endpoint: string,
  profiles: StationProfile[],
): string {
  const hostname = new URL(endpoint).hostname;
  const normalized = (preferred.trim() || hostname)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
    .slice(0, 64);
  const base = normalized || 'station';
  const names = new Set(profiles.map((profile) => profile.name.toLowerCase()));
  if (!names.has(base)) return base;
  for (let suffix = 2; suffix < Number.MAX_SAFE_INTEGER; suffix += 1) {
    const candidate = `${base.slice(
      0,
      64 - String(suffix).length - 1,
    )}-${suffix}`;
    if (!names.has(candidate)) return candidate;
  }
  throw new Error('Could not allocate a unique Station name.');
}

/**
 * Async repository boundary for the two stores that cannot share a database
 * transaction: secret-free saved Station metadata and the OS keyring. It uses a
 * compensating rollback so a failed reference migration is loud rather than
 * silently leaving metadata pointed at the wrong bearer credential.
 */
export interface NativeStationProfileRepository {
  commitVerifiedPairing(
    pairing: VerifiedStationProfilePairing,
  ): Promise<string>;
  makeDefault(connectionId: string): Promise<StationProfile>;
  updateProfile(
    input: import('@kontourai/station-connect').SavedStationEdit,
  ): Promise<void>;
  removeProfile(
    input: import('@kontourai/station-connect').SavedStationRemoval,
  ): Promise<void>;
  getRelayRouteProfiles(): readonly StationProfile[];
  subscribeRelayRouteProfiles(listener: () => void): () => void;
  saveRelayRouteProfile(input: SaveRelayRouteProfileInput): Promise<string>;
  removeRelayRouteProfile(
    connectionId: string,
    expectedUpdatedAt: number,
  ): Promise<void>;
  /**
   * Makes a saved Station the native credential projection for this UI
   * client only. `explicit` records deliberate per-client intent without
   * writing `defaultProfile`; automatic bundled/default authorization leaves
   * it false.
   */
  authorizeActiveConnection(
    connectionId: string,
    explicit?: boolean,
  ): Promise<boolean>;
  /**
   * Selects the bundled channel's saved profile for this process without
   * changing the CLI default. An intentional process-local choice wins.
   */
  selectProfileForProcess(profileName: string): string | undefined;
  /** Re-authorizes the CLI-owned default; optionally forgets client-local selection. */
  authorizeDefaultProfile(
    forgetRememberedSelection?: boolean,
  ): Promise<boolean>;
  /** Re-authorizes this client's saved choice, falling back to the shared default. */
  authorizeRememberedProfile(): Promise<boolean>;
  /**
   * Whether the hydrated store holds any saved Station. Lets boot paths
   * that only make sense with a Station to watch (notification priming)
   * stay silent on a fresh device instead of prompting for a permission
   * nothing can yet use.
   */
  hasSavedProfiles(): boolean;
  /** Returns a receipt only for the already-authorized exact connection/base. */
  captureNativeRequestBinding(
    connectionId: string,
    exactOrigin: string,
  ): NativeProfileRequestBinding | null;
  /**
   * Same-user local self-authorization (archive#1715, revised archive#1818):
   * the process-selected Station's name, IF it is a local-service install
   * — otherwise `undefined`. Every other profile shape (remote, no selection
   * selected) returns `undefined` so the caller falls straight through to
   * today's pairing-ceremony UI with no special-casing.
   *
   * archive#1818: this DELIBERATELY no longer pre-filters on
   * `credentialRef`/`configurationState`. It used to return `undefined` for
   * any profile already carrying `credentialRef` + `configured`, on the
   * theory that those two fields mean "already durably provisioned" — but
   * that is exactly the label-vs-derivation defect this issue is about: a
   * nightly bundle swap re-signs the app, the macOS keychain ACL bound to
   * the previous signature then refuses every read of the credential this
   * build's `station_local_self_provision` needs, and those two RECORDED
   * fields keep reading as healthy forever. The webview cannot read the
   * keychain itself (by design — the bearer never crosses IPC), so it has
   * no way to observe usability from here; only the Rust command can, via
   * `profile_already_locally_provisioned` /
   * `read_credential_for_eligibility` (`src-desktop/src/lib.rs`). This
   * function now returns eligibility on shape alone and lets the command
   * decide the rest — the cost is one keychain read every boot for an
   * already-healthy profile, which correctly refuses fast
   * ("the selected Station is already configured") and is a no-op from
   * the caller's point of view (`attemptLocalSelfProvision` catches that
   * refusal and returns `false`).
   */
  pendingLocalSelfProvisionProfileName(): string | undefined;
}

const TAURI_INVOKER: TauriInvoker = {
  invoke: invokeTauri,
};

function profileConnectionId(profile: StationProfile): string {
  return `station-profile:${profile.name.toLowerCase()}`;
}

/**
 * Adapts the shared Station-profile contract to the older SavedConnection
 * view. The profile remains authoritative: this conversion never serializes a
 * credential, and ordinary connection selection is deliberately ephemeral.
 */
export function savedConnectionFromStationProfile(
  profile: StationProfile,
): SavedConnection {
  if (profile.relayRoute)
    throw new Error(
      'Relay route profiles require the broker transport and cannot use direct HTTP.',
    );
  const endpoint = createAccessEndpoint(profile.endpoint);
  const accessMethod = createDirectHttpAccessMethod(endpoint);
  const credentialRefId =
    profile.credentialRef?.id ?? profileConnectionId(profile);
  return {
    profileVersion: 4,
    id: profileConnectionId(profile),
    name: profile.name,
    url: endpoint.url,
    endpoints: [endpoint],
    selectedEndpointId: endpoint.id,
    accessMethods: [accessMethod],
    selectedAccessMethodId: accessMethod.id,
    environmentId: profile.environmentId ?? null,
    authProtocolVersion: profile.credentialRef ? 1 : null,
    credentialRef: {
      credentialVersion: 1,
      kind: profile.environmentId ? 'environment' : 'connection',
      id: credentialRefId,
    },
    capabilities: null,
    credentialState: profile.credentialRef
      ? profile.configurationState === 'requires-auth'
        ? 'required'
        : 'saved'
      : 'not-required',
    ...(profile.credentialRef ? { hostOwnedCredential: true as const } : {}),
    ...(profile.setupSource === 'local' && profile.localService?.instanceId
      ? { ownerId: profile.localService.instanceId }
      : {}),
  };
}

/**
 * Read-through, native-only connection metadata adapter. It intentionally
 * does not make a transient connection choice the CLI default: callers must
 * use `makeDefault` for that explicit cross-client mutation.
 */
export class NativeStationProfileStorage
  implements StorageAdapter, NativeStationProfileRepository
{
  private values = new Map<string, string>();
  private profileStore: StationProfileStore = emptyStationProfileStore();
  private relayRouteProfileSnapshot: readonly StationProfile[] = [];
  private relayRouteProfileListeners = new Set<() => void>();
  /**
   * The shared default initially projects into `ACTIVE_KEY` for the legacy
   * connection-store view, but it is not an explicit choice made by this
   * client. Keep that provenance out of the shared profile document: a
   * packaged channel must be able to replace the inherited default with its
   * own local Station, while a real in-process choice remains authoritative.
   */
  private explicitProcessSelection: string | undefined;
  private selectionProvenanceHydrated = false;
  private activeRequestBinding:
    | (NativeProfileRequestBinding & {
        connectionId: string;
        credentialRef: StationProfileCredentialRef;
        environmentId?: string;
      })
    | undefined;

  constructor(
    private readonly bridge: TauriInvoker = TAURI_INVOKER,
    private readonly clientSelectionStorage: StorageAdapter = defaultStorage,
    private readonly persistsClientSelection = false,
  ) {}

  async hydrate(): Promise<void> {
    await this.refresh();
  }

  /**
   * Re-read the CLI-owned profile document without touching the credential
   * vault. Desktop uses this as a bounded observer for profile add/remove/use
   * commands performed while the shell is already open.
   *
   * Invalid or unreadable metadata deliberately leaves the last known-good
   * projection in place: callers can keep using a safe snapshot, but must not
   * treat a failed read as an empty profile list.
   */
  async refresh(): Promise<boolean> {
    const next = await this.readProfileStore();
    if (JSON.stringify(next) === JSON.stringify(this.profileStore)) {
      return false;
    }
    this.replaceProfileStore(next);
    return true;
  }

  private replaceProfileStore(store: StationProfileStore): void {
    // A metadata-only refresh (for example `updatedAt` on another profile)
    // must not strand the current native request epoch. Preserve it only if
    // the exact selected connection still has the same configured authority.
    const retained = this.activeRequestBinding;
    const retainedProfile = retained
      ? store.profiles.find(
          (profile) => profileConnectionId(profile) === retained.connectionId,
        )
      : undefined;
    const preservesBinding = Boolean(
      retainedProfile &&
        retainedProfile.configurationState === 'configured' &&
        retainedProfile.credentialRef?.kind === retained?.credentialRef.kind &&
        retainedProfile.credentialRef?.id === retained?.credentialRef.id &&
        retainedProfile.environmentId === retained?.environmentId &&
        normalizedPairingEndpoint(
          retainedProfile.endpoint,
          retainedProfile.developmentHttpOrigin,
        ) === retained?.exactOrigin,
    );
    if (!preservesBinding) this.activeRequestBinding = undefined;
    this.profileStore = store;
    this.hydrateClientSelectionProvenance();
    const directProfiles = store.profiles.filter(
      (profile) => profile.relayRoute === undefined,
    );
    const connections = directProfiles.map(savedConnectionFromStationProfile);
    this.values.set(CONNECTIONS_KEY, JSON.stringify(connections));
    this.relayRouteProfileSnapshot = Object.freeze(
      store.profiles
        .filter((profile) => profile.relayRoute !== undefined)
        .map((profile) =>
          Object.freeze({
            ...profile,
            relayRoute: Object.freeze({ ...profile.relayRoute! }),
          }),
        ),
    );
    const selectedConnectionId = this.values.get(ACTIVE_KEY);
    const selectedStillExists = selectedConnectionId
      ? directProfiles.some(
          (profile) => profileConnectionId(profile) === selectedConnectionId,
        )
      : false;
    const explicitStillExists = this.explicitProcessSelection
      ? directProfiles.some(
          (profile) =>
            profileConnectionId(profile) === this.explicitProcessSelection,
        )
      : false;
    if (this.explicitProcessSelection && !explicitStillExists) {
      this.explicitProcessSelection = undefined;
      this.clientSelectionStorage.remove(EXPLICIT_SELECTION_KEY);
    }
    const defaultProfile = store.defaultProfile
      ? store.profiles.find(
          (profile) =>
            profile.relayRoute === undefined &&
            profile.name.toLowerCase() === store.defaultProfile!.toLowerCase(),
        )
      : undefined;
    if (this.explicitProcessSelection && explicitStillExists) {
      this.values.set(ACTIVE_KEY, this.explicitProcessSelection);
    } else if (selectedStillExists) {
      this.values.set(ACTIVE_KEY, selectedConnectionId!);
    } else if (defaultProfile) {
      this.values.set(ACTIVE_KEY, profileConnectionId(defaultProfile));
    } else {
      this.values.delete(ACTIVE_KEY);
    }
    for (const listener of this.relayRouteProfileListeners) listener();
  }

  /**
   * Recover only selection intent that an installed client can prove it owns.
   *
   * Older builds persisted the generic ConnectionStore active pointer without
   * recording why it was active. A pointer to the shared default or any local
   * profile is therefore inherited state, not proof that this client chose
   * it; packaged bootstrap must replace it with the exact home owner returned
   * by the native grant. A non-default foreign profile is the one legacy shape
   * that can represent deliberate client-local intent, so migrate it once to
   * the versioned marker. New builds write that marker only through the
   * explicit native-selection seam below.
   *
   * This store contains metadata only. Migration never invokes the keyring,
   * changes profiles.json, or reads/writes a pairing credential.
   */
  private hydrateClientSelectionProvenance(): void {
    if (this.selectionProvenanceHydrated || !this.persistsClientSelection)
      return;
    this.selectionProvenanceHydrated = true;

    const persistedRaw = this.clientSelectionStorage.get(
      EXPLICIT_SELECTION_KEY,
    );
    const persisted = this.parseExplicitSelectionRecord(persistedRaw);
    if (persistedRaw !== null) {
      const profile = persisted
        ? this.profileStore.profiles.find(
            (candidate) =>
              candidate.relayRoute === undefined &&
              profileConnectionId(candidate) === persisted.connectionId,
          )
        : undefined;
      if (profile && profile.setupSource !== 'local') {
        this.explicitProcessSelection = persisted!.connectionId;
      } else {
        this.clientSelectionStorage.remove(EXPLICIT_SELECTION_KEY);
      }
    } else {
      const legacyProfile = this.resolveLegacyForeignSelection();
      const inheritedDefault = Boolean(
        legacyProfile &&
          this.profileStore.defaultProfile &&
          legacyProfile.relayRoute === undefined &&
          legacyProfile.name.toLowerCase() ===
            this.profileStore.defaultProfile.toLowerCase(),
      );
      if (
        legacyProfile &&
        legacyProfile.setupSource !== 'local' &&
        !inheritedDefault
      ) {
        const connectionId = profileConnectionId(legacyProfile);
        this.explicitProcessSelection = connectionId;
        this.persistExplicitSelection(connectionId);
      }
    }

    // The native adapter owns the live ConnectionStore projection now. Leave
    // no ambiguous legacy pointer or stale renderer-side connection record
    // for a later upgrade to reinterpret. Any foreign choice retained above
    // is represented exclusively by the versioned native-profile marker.
    this.clientSelectionStorage.remove(ACTIVE_KEY);
    this.clientSelectionStorage.remove(CONNECTIONS_KEY);
  }

  private resolveLegacyForeignSelection(): StationProfile | undefined {
    const activeId = this.clientSelectionStorage.get(ACTIVE_KEY);
    const rawConnections = this.clientSelectionStorage.get(CONNECTIONS_KEY);
    if (!activeId || !rawConnections || rawConnections.length > 1_000_000)
      return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawConnections);
    } catch {
      return undefined;
    }
    if (!Array.isArray(parsed) || parsed.length > 1_000) return undefined;
    const selected = parsed.find(
      (candidate): candidate is Record<string, unknown> =>
        Boolean(
          candidate &&
            typeof candidate === 'object' &&
            !Array.isArray(candidate) &&
            (candidate as Record<string, unknown>).id === activeId,
        ),
    );
    if (!selected || typeof selected.url !== 'string') return undefined;
    const legacy: LegacyConnectionSelection = {
      id: activeId,
      url: selected.url,
      ...(typeof selected.environmentId === 'string' &&
      selected.environmentId.length > 0 &&
      selected.environmentId.length <= 256
        ? { environmentId: selected.environmentId }
        : {}),
    };
    if (legacy.environmentId) {
      const matches = this.profileStore.profiles.filter(
        (profile) =>
          profile.relayRoute === undefined &&
          profile.environmentId === legacy.environmentId,
      );
      return matches.length === 1 ? matches[0] : undefined;
    }
    let exactOrigin: string;
    try {
      exactOrigin = normalizedPairingEndpoint(legacy.url);
    } catch {
      return undefined;
    }
    const matches = this.profileStore.profiles.filter((profile) => {
      if (profile.relayRoute) return false;
      try {
        return (
          normalizedPairingEndpoint(
            profile.endpoint,
            profile.developmentHttpOrigin,
          ) === exactOrigin
        );
      } catch {
        return false;
      }
    });
    return matches.length === 1 ? matches[0] : undefined;
  }

  private parseExplicitSelectionRecord(
    raw: string | null,
  ): ExplicitSelectionRecord | undefined {
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        return undefined;
      const record = parsed as Record<string, unknown>;
      if (
        Object.keys(record).sort().join(',') !== 'connectionId,schemaVersion' ||
        record.schemaVersion !== 1 ||
        typeof record.connectionId !== 'string' ||
        record.connectionId.length > 256 ||
        !record.connectionId.startsWith('station-profile:') ||
        record.connectionId.length === 'station-profile:'.length ||
        Array.from(record.connectionId).some((character) => {
          const codePoint = character.codePointAt(0) ?? 0;
          return codePoint <= 31 || codePoint === 127;
        })
      )
        return undefined;
      return { schemaVersion: 1, connectionId: record.connectionId };
    } catch {
      return undefined;
    }
  }

  private persistExplicitSelection(connectionId: string): void {
    if (!this.persistsClientSelection) return;
    this.clientSelectionStorage.set(
      EXPLICIT_SELECTION_KEY,
      JSON.stringify({ schemaVersion: 1, connectionId }),
    );
  }

  private clearExplicitProcessSelection(): void {
    this.explicitProcessSelection = undefined;
    if (this.persistsClientSelection)
      this.clientSelectionStorage.remove(EXPLICIT_SELECTION_KEY);
  }

  private sharesExactPackagedLoopbackEndpoint(
    first: StationProfile,
    second: StationProfile,
  ): boolean {
    try {
      const secondEndpoint = normalizedPairingEndpoint(
        second.endpoint,
        second.developmentHttpOrigin,
      );
      const secondUrl = new URL(secondEndpoint);
      const host = secondUrl.hostname;
      const strictLoopbackHttp =
        secondUrl.protocol === 'http:' &&
        (host === '[::1]' ||
          host === '::1' ||
          /^127(?:\.\d{1,3}){3}$/.test(host));
      return (
        strictLoopbackHttp &&
        normalizedPairingEndpoint(
          first.endpoint,
          first.developmentHttpOrigin,
        ) === secondEndpoint
      );
    } catch {
      return false;
    }
  }

  selectProfileForProcess(profileName: string): string | undefined {
    const profile = this.profileStore.profiles.find(
      (candidate) => candidate.name.toLowerCase() === profileName.toLowerCase(),
    );
    if (!profile || profile.relayRoute) return undefined;
    if (this.explicitProcessSelection) {
      const explicit = this.profileStore.profiles.find(
        (candidate) =>
          profileConnectionId(candidate) === this.explicitProcessSelection,
      );
      if (
        explicit &&
        !this.sharesExactPackagedLoopbackEndpoint(explicit, profile)
      )
        return this.explicitProcessSelection;

      // `station_ensure_bundled_local_profile` supplied `profileName` from
      // the native owner resolver. A legacy renderer selection at its exact
      // origin is inherited local state even when its old random id had no
      // localService marker (or claimed to be paired). Keeping it would make
      // a packaged channel ask its owner to pair with itself. Collapse it to
      // the native channel profile without changing the shared CLI default.
      // The same cleanup handles a marker whose native target was deleted.
      this.clearExplicitProcessSelection();
    }
    const resolved = profileConnectionId(profile);
    this.values.set(ACTIVE_KEY, resolved);
    return resolved;
  }

  get(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  set(key: string, value: string): void {
    // `ConnectionStore` records a temporary selected connection through this
    // key. Retaining it only in memory is intentional: navigation and a
    // one-off selection never rewrite the shared CLI default.
    this.values.set(key, value);
  }

  remove(key: string): void {
    this.values.delete(key);
  }

  async updateProfile(
    input: import('@kontourai/station-connect').SavedStationEdit,
  ): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await this.readProfileStore();
      const profile = current.profiles.find(
        (candidate) => profileConnectionId(candidate) === input.connectionId,
      );
      if (!profile || profile.localService || profile.relayRoute)
        throw new Error('This Station cannot be edited here.');
      if (
        profile.name !== input.expected.name ||
        profile.endpoint !== input.expected.url
      )
        throw new Error(
          'This Station changed while you were editing. Reopen it and try again.',
        );
      const name = input.name.trim();
      const endpoint = normalizedPairingEndpoint(
        input.url.trim(),
        profile.developmentHttpOrigin,
      );
      if (
        !name ||
        current.profiles.some(
          (candidate) =>
            candidate !== profile &&
            candidate.name.toLowerCase() === name.toLowerCase(),
        )
      )
        throw new Error('Choose a unique Station name.');
      const addressChanged = endpoint !== profile.endpoint;
      const updated: StationProfile = {
        ...profile,
        name,
        endpoint,
        updatedAt: Date.now(),
      };
      if (addressChanged) {
        // A credential is bound to its old exact origin. Editing metadata must
        // never send it to the newly typed address, even if it claims the same id.
        delete updated.credentialRef;
        delete updated.environmentId;
        if (updated.developmentHttpOrigin !== endpoint)
          delete updated.developmentHttpOrigin;
        updated.setupSource = 'manual';
        updated.configurationState = 'unconfigured';
      }
      const renamed = (value: string) =>
        value.toLowerCase() === profile.name.toLowerCase() ? name : value;
      const next: StationProfileStore = {
        ...current,
        revision: current.revision + 1,
        profiles: current.profiles.map((candidate) =>
          candidate === profile ? updated : candidate,
        ),
        defaultProfile: current.defaultProfile
          ? renamed(current.defaultProfile)
          : null,
        projectProfiles: Object.fromEntries(
          Object.entries(current.projectProfiles).map(([project, value]) => [
            project,
            renamed(value),
          ]),
        ),
      };
      if (!isStationProfileStore(next))
        throw new Error('The Station name or address is invalid.');
      const restoreBinding =
        !addressChanged &&
        this.activeRequestBinding?.connectionId === input.connectionId;
      let committed = false;
      try {
        await this.writeProfileStore(next, current.revision);
        committed = true;
        const nextId = profileConnectionId(updated);
        if (this.values.get(ACTIVE_KEY) === input.connectionId)
          this.values.set(ACTIVE_KEY, nextId);
        if (this.explicitProcessSelection === input.connectionId) {
          this.explicitProcessSelection = nextId;
          this.persistExplicitSelection(nextId);
        }
        this.replaceProfileStore(next);
        if (
          restoreBinding &&
          nextId !== input.connectionId &&
          this.values.get(ACTIVE_KEY) === nextId
        )
          await this.authorizeActiveConnection(nextId);
        return;
      } catch (error) {
        if (committed)
          throw new Error(
            `Station saved, but its connection could not be restored: ${String(error)}`,
          );
        if (!this.isRevisionConflict(error) || attempt === 2) throw error;
      }
    }
  }

  /**
   * Forgets a direct saved Station on this device: its profile, its project
   * mappings, the CLI default if it named it, and its credential unless
   * another profile still uses that credential.
   *
   * The active Station's credential is deleted first, through the active
   * path: the host resolves that path from the profile, so it must still be
   * in the store, and the same call clears the host's active binding. If the
   * store write then fails, the Station stays listed without a credential,
   * and forgetting it again finishes the job. Any other Station is written
   * out first and its credential deleted after, once the host can see nothing
   * references it. Forgetting the active Station falls back to the default,
   * which is authorized here so the app is not left with no active Station.
   */
  async removeProfile(
    input: import('@kontourai/station-connect').SavedStationRemoval,
  ): Promise<void> {
    const matches = (profile: StationProfile) =>
      profileConnectionId(profile) === input.connectionId;
    const initial = await this.readProfileStore();
    const target = initial.profiles.find(matches);
    if (!target || target.localService || target.relayRoute)
      throw new Error('This Station cannot be forgotten here.');
    const reference = target.credentialRef;
    const sharesCredential = (profiles: readonly StationProfile[]) =>
      reference !== undefined &&
      profiles.some(
        (profile) =>
          !matches(profile) &&
          profile.credentialRef?.kind === reference.kind &&
          profile.credentialRef?.id === reference.id,
      );
    const wasActive =
      this.activeRequestBinding?.connectionId === input.connectionId;
    if (wasActive && reference && !sharesCredential(initial.profiles)) {
      await this.bridge.invoke('credential_vault_delete');
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await this.readProfileStore();
      const profile = current.profiles.find(matches);
      if (
        !profile ||
        profile.name !== input.expected.name ||
        profile.endpoint !== input.expected.url
      )
        throw new Error(
          'This Station changed while you were confirming. Reopen it and try again.',
        );
      const named = (value: string) =>
        value.toLowerCase() === profile.name.toLowerCase();
      const profiles = current.profiles.filter(
        (candidate) => candidate !== profile,
      );
      const next: StationProfileStore = {
        ...current,
        revision: current.revision + 1,
        profiles,
        defaultProfile:
          current.defaultProfile && !named(current.defaultProfile)
            ? current.defaultProfile
            : null,
        projectProfiles: Object.fromEntries(
          Object.entries(current.projectProfiles).filter(
            ([, value]) => !named(value),
          ),
        ),
      };
      if (!isStationProfileStore(next))
        throw new Error('The saved Stations are invalid.');
      try {
        await this.writeProfileStore(next, current.revision);
      } catch (error) {
        if (!this.isRevisionConflict(error) || attempt === 2) throw error;
        continue;
      }
      this.replaceProfileStore(next);
      const fallback = this.values.get(ACTIVE_KEY);
      if (wasActive && fallback) {
        try {
          await this.authorizeActiveConnection(fallback);
        } catch (error) {
          throw new Error(
            `Station forgotten, but switching to the next Station failed: ${String(error)}`,
          );
        }
      }
      if (reference && !wasActive && !sharesCredential(profiles)) {
        try {
          await this.deleteUnreferencedCredential(reference);
        } catch (error) {
          throw new Error(
            `Station forgotten, but its saved credential could not be deleted: ${String(error)}`,
          );
        }
      }
      return;
    }
    throw new Error('saved Stations changed concurrently; retry.');
  }

  getRelayRouteProfiles(): readonly StationProfile[] {
    return this.relayRouteProfileSnapshot;
  }

  subscribeRelayRouteProfiles(listener: () => void): () => void {
    this.relayRouteProfileListeners.add(listener);
    return () => this.relayRouteProfileListeners.delete(listener);
  }

  /** Saves routing intent only; this never adds a direct HTTP connection. */
  async saveRelayRouteProfile(
    input: SaveRelayRouteProfileInput,
  ): Promise<string> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await this.readProfileStore();
      const existing = existingRelayRouteProfile(current.profiles, input);
      const normalized = normalizeRelayRouteProfileInput(
        input,
        current.profiles,
        existing,
      );
      const profile = relayRouteProfile(normalized, existing);

      const profiles = existing
        ? current.profiles.map((candidate) =>
            candidate === existing ? profile : candidate,
          )
        : [...current.profiles, profile];
      const next: StationProfileStore = {
        ...current,
        revision: current.revision + 1,
        profiles,
      };
      if (!isStationProfileStore(next))
        throw new Error('The Station relay route is invalid.');
      try {
        await this.writeProfileStore(next, current.revision);
        this.replaceProfileStore(next);
        return profileConnectionId(profile);
      } catch (error) {
        if (!this.isRevisionConflict(error) || attempt === 2) throw error;
      }
    }
    throw new Error('saved Station routes changed concurrently; retry.');
  }

  async removeRelayRouteProfile(
    connectionId: string,
    expectedUpdatedAt: number,
  ): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await this.readProfileStore();
      const profile = current.profiles.find(
        (candidate) =>
          profileConnectionId(candidate) === connectionId &&
          candidate.relayRoute !== undefined,
      );
      if (!profile || profile.updatedAt !== expectedUpdatedAt)
        throw new Error('This saved relay route changed; reopen it and retry.');
      const next: StationProfileStore = {
        ...current,
        revision: current.revision + 1,
        profiles: current.profiles.filter((candidate) => candidate !== profile),
      };
      if (!isStationProfileStore(next))
        throw new Error('The saved Station routes are invalid.');
      try {
        await this.writeProfileStore(next, current.revision);
        this.replaceProfileStore(next);
        return;
      } catch (error) {
        if (!this.isRevisionConflict(error) || attempt === 2) throw error;
      }
    }
    throw new Error('saved Station routes changed concurrently; retry.');
  }

  async makeDefault(connectionId: string): Promise<StationProfile> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await this.readProfileStore();
      const profile = current.profiles.find(
        (candidate) => profileConnectionId(candidate) === connectionId,
      );
      if (!profile || profile.relayRoute) {
        throw new Error(
          'Only a direct shared saved Station can become the CLI default.',
        );
      }
      const next: StationProfileStore = {
        ...current,
        revision: current.revision + 1,
        defaultProfile: profile.name,
      };
      try {
        await this.writeProfileStore(next, current.revision);
        this.replaceProfileStore(next);
        return profile;
      } catch (error) {
        if (!this.isRevisionConflict(error) || attempt === 2) throw error;
      }
    }
    throw new Error('saved Station default changed concurrently; retry.');
  }

  /**
   * The native host, not the webview, binds a selected saved Station to the
   * active keyring credential. The selected id remains client-local;
   * `makeDefault` is the sole CLI default mutation.
   */
  async authorizeActiveConnection(
    connectionId: string,
    explicit = false,
  ): Promise<boolean> {
    const profile = this.profileStore.profiles.find(
      (candidate) => profileConnectionId(candidate) === connectionId,
    );
    if (!profile || profile.relayRoute) return false;

    const previousActive = this.values.get(ACTIVE_KEY);
    // ConnectionStore republishes ACTIVE_KEY during ordinary metadata writes,
    // so only this explicit authorization call may establish client intent.
    // Record it before the keyring call: an intentional selection remains the
    // process target even when its credential is unavailable.
    if (explicit) this.explicitProcessSelection = connectionId;
    if (explicit && profile.setupSource !== 'local')
      this.persistExplicitSelection(connectionId);
    else if (explicit && this.persistsClientSelection)
      this.clientSelectionStorage.remove(EXPLICIT_SELECTION_KEY);
    this.values.set(ACTIVE_KEY, connectionId);
    if (!profile.credentialRef) return false;
    try {
      const exactOrigin = normalizedPairingEndpoint(
        profile.endpoint,
        profile.developmentHttpOrigin,
      );
      const result = await this.bridge.invoke<unknown>(
        'station_profile_authorize_active',
        { profileName: profile.name },
      );
      const binding = parseNativeProfileAuthorizationReceipt(
        result,
        exactOrigin,
      );
      if (!binding)
        throw new Error(
          'native Station authorization did not return a binding',
        );
      this.activeRequestBinding = {
        connectionId,
        credentialRef: profile.credentialRef,
        ...(profile.environmentId
          ? { environmentId: profile.environmentId }
          : {}),
        ...binding,
      };
      return true;
    } catch (error) {
      if (previousActive === undefined) this.values.delete(ACTIVE_KEY);
      else this.values.set(ACTIVE_KEY, previousActive);
      throw error;
    }
  }

  async authorizeDefaultProfile(
    forgetRememberedSelection = false,
  ): Promise<boolean> {
    if (forgetRememberedSelection) this.clearExplicitProcessSelection();
    const defaultProfile = this.profileStore.defaultProfile;
    if (!defaultProfile) return false;
    const profile = this.profileStore.profiles.find(
      (candidate) =>
        candidate.relayRoute === undefined &&
        candidate.name.toLowerCase() === defaultProfile.toLowerCase(),
    );
    return profile
      ? this.authorizeActiveConnection(profileConnectionId(profile))
      : false;
  }

  async authorizeRememberedProfile(): Promise<boolean> {
    return this.explicitProcessSelection
      ? this.authorizeActiveConnection(this.explicitProcessSelection)
      : this.authorizeDefaultProfile();
  }

  hasSavedProfiles(): boolean {
    return this.profileStore.profiles.some(
      (profile) => profile.relayRoute === undefined,
    );
  }

  captureNativeRequestBinding(
    connectionId: string,
    exactOrigin: string,
  ): NativeProfileRequestBinding | null {
    const binding = this.activeRequestBinding;
    return binding &&
      binding.connectionId === connectionId &&
      binding.exactOrigin === exactOrigin
      ? { bindingId: binding.bindingId, exactOrigin: binding.exactOrigin }
      : null;
  }

  pendingLocalSelfProvisionProfileName(): string | undefined {
    const selectedConnectionId = this.values.get(ACTIVE_KEY);
    if (!selectedConnectionId) return undefined;
    const profile = this.profileStore.profiles.find(
      (candidate) => profileConnectionId(candidate) === selectedConnectionId,
    );
    // archive#1715 live-boot fix: `station setup local` (packages/cli/src/
    // commands/setup-command.ts) writes a fresh local-service profile with
    // `configurationState: 'configured'` and NO `credentialRef` at all — the
    // CLI itself never needed one, so "configured" here has always meant
    // "fully set up as far as the CLI cares", not "has a working native
    // credential". The original check (`configurationState === 'configured'`
    // means "skip it") therefore refused every real installation outright:
    // live verification against an actual `~/.station/config/profiles.json`
    // showed the wiring never even invoked the native command.
    //
    // archive#1818: this function used to ALSO
    // skip any profile already carrying `credentialRef` + `configured`,
    // re-encoding the exact defect this fix exists to close — a stranded
    // profile after a bundle-swap keychain ACL mismatch looks EXACTLY like
    // that shape (both fields recorded, credential unreadable), so that
    // short-circuit silently prevented `station_local_self_provision` from
    // ever running in precisely the incident scenario archive#1818 reports.
    // This process (the webview) cannot read the OS keychain to check
    // usability itself; only the Rust command can
    // (`profile_already_locally_provisioned` in `src-desktop/src/lib.rs`).
    // The only shape check left here is "is this a local-service install at
    // all" — everything about whether it still needs provisioning is now
    // the Rust command's decision, made fresh on every boot.
    // `localService` describes a service attachment, not ownership. Only the
    // channel-authored local profile may spend the owner-only local-grant
    // secret to replace a credential. A paired profile can legitimately
    // share this origin and must remain untouched.
    if (!profile?.localService || profile.setupSource !== 'local') {
      return undefined;
    }
    return profile.name;
  }

  /**
   * Persist a verified identity, and only a verified identity. A profile's
   * credential reference is stable across environment discovery by default;
   * callers that intentionally rotate it get a compensated keyring migration.
   */
  async commitVerifiedPairing(
    pairing: VerifiedStationProfilePairing,
  ): Promise<string> {
    if (
      !pairing.handshake.environmentId ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        pairing.clientInstanceId,
      ) ||
      pairing.handshake.authentication.scheme !== 'bearer' ||
      !Number.isInteger(pairing.handshake.authentication.protocolVersion)
    ) {
      throw new Error(
        'Refusing to persist an unverified Station pairing identity.',
      );
    }
    const developmentHttpOrigin = httpDevelopmentOrigin(pairing.endpoint);
    const endpoint = normalizedPairingEndpoint(
      pairing.endpoint,
      developmentHttpOrigin,
    );
    for (let attempt = 0; attempt < 3; attempt += 1) {
      // Never mutate from the bootstrap snapshot: a CLI can add or select a
      // profile while Desktop is open. Re-read within every explicit mutation,
      // then let the native CAS make a stale attempt fail rather than clobber.
      const current = await this.readProfileStore();
      const matchingProfiles = current.profiles.filter(
        (profile) =>
          profile.relayRoute === undefined &&
          (profileConnectionId(profile) === pairing.connectionId ||
            profile.environmentId === pairing.handshake.environmentId ||
            profile.endpoint === endpoint),
      );
      const previous =
        current.profiles.find(
          (profile) =>
            profile.relayRoute === undefined &&
            profileConnectionId(profile) === pairing.connectionId,
        ) ?? (matchingProfiles.length === 1 ? matchingProfiles[0] : undefined);
      const profileIndex = previous ? current.profiles.indexOf(previous) : -1;
      const now = Date.now();
      const previousRef = previous?.credentialRef;
      if (pairing.credential !== undefined) {
        throw new Error(
          'Native pairing refuses renderer-visible bearer credentials.',
        );
      }
      if (!pairing.credentialHandle || !pairing.nextCredentialRef) {
        throw new Error(
          'Native pairing requires one host-owned handle and target credential reference.',
        );
      }
      // Rust allocates and binds the target reference to the exchange handle.
      // Rotating on every pairing ensures an old bearer is never exposed under
      // a newly approved origin while metadata and keyring state converge.
      const nextRef = pairing.nextCredentialRef;
      if (
        current.profiles.some(
          (profile) =>
            profile !== previous &&
            profile.credentialRef?.kind === nextRef.kind &&
            profile.credentialRef.id === nextRef.id,
        )
      ) {
        throw new Error(
          'Refusing a credential reference already owned by another saved Station.',
        );
      }

      const updatedProfile: StationProfile = {
        ...(previous ?? {
          schemaVersion: 1,
          name: collisionSafeProfileName(
            pairing.name,
            endpoint,
            current.profiles,
          ),
          createdAt: now,
        }),
        endpoint,
        developmentHttpOrigin,
        credentialRef: nextRef,
        environmentId: pairing.handshake.environmentId,
        clientInstanceId: pairing.clientInstanceId,
        setupSource: 'paired',
        configurationState: 'requires-auth',
        updatedAt: now,
      };
      const pendingStore: StationProfileStore = {
        ...current,
        revision: current.revision + 1,
        profiles:
          profileIndex >= 0
            ? current.profiles.map((profile, index) =>
                index === profileIndex ? updatedProfile : profile,
              )
            : [...current.profiles, updatedProfile],
      };

      try {
        await this.writeProfileStore(
          pendingStore,
          current.revision,
          pairing.credentialHandle,
        );
      } catch (error) {
        if (this.isRevisionConflict(error) && attempt < 2) continue;
        throw new Error(
          `Station pairing metadata was not saved: ${String(error)}`,
        );
      }

      try {
        await this.writeCredential(pairing.credentialHandle);
      } catch (error) {
        this.replaceProfileStore(pendingStore);
        throw new Error(
          `Station pairing metadata is awaiting credential authorization: ${String(
            error,
          )}`,
        );
      }

      let nextStore: StationProfileStore | undefined;
      let lastLiveStore = pendingStore;
      for (
        let configuredAttempt = 0;
        configuredAttempt < 3;
        configuredAttempt += 1
      ) {
        const live = await this.readProfileStore();
        lastLiveStore = live;
        const targets = live.profiles.filter(
          (profile) =>
            profile.name.toLowerCase() === updatedProfile.name.toLowerCase() &&
            profile.endpoint === endpoint &&
            profile.environmentId === pairing.handshake.environmentId &&
            profile.clientInstanceId === pairing.clientInstanceId &&
            profile.configurationState === 'requires-auth' &&
            profile.credentialRef?.kind === nextRef.kind &&
            profile.credentialRef.id === nextRef.id,
        );
        if (targets.length !== 1) {
          this.replaceProfileStore(live);
          throw new Error(
            'Station pairing credential was saved, but its live requires-auth profile no longer matches the host-bound pairing identity.',
          );
        }
        const liveTarget = targets[0];
        const hasExplicitDefault =
          live.defaultProfile !== null &&
          live.profiles.some(
            (profile) =>
              profile.name.toLowerCase() === live.defaultProfile!.toLowerCase(),
          );
        const candidate: StationProfileStore = {
          ...live,
          revision: live.revision + 1,
          // Pairing completion is the first point where both metadata and the
          // host-owned credential are durable. Select the first saved Station
          // in this same CAS only when no explicit valid default exists in the
          // latest live store; a concurrent explicit choice always wins.
          defaultProfile: hasExplicitDefault
            ? live.defaultProfile
            : liveTarget.name,
          profiles: live.profiles.map((profile) =>
            profile === liveTarget
              ? { ...liveTarget, configurationState: 'configured' }
              : profile,
          ),
        };
        try {
          await this.writeProfileStore(
            candidate,
            live.revision,
            pairing.credentialHandle,
          );
          nextStore = candidate;
          break;
        } catch (error) {
          if (this.isRevisionConflict(error) && configuredAttempt < 2) continue;
          this.replaceProfileStore(live);
          throw new Error(
            `Station pairing credential was saved, but metadata remains awaiting authorization: ${String(
              error,
            )}`,
          );
        }
      }
      if (!nextStore) {
        this.replaceProfileStore(lastLiveStore);
        throw new Error(
          'Your pairing was saved, but this device couldn’t finish updating its settings. Try again.',
        );
      }

      if (
        previousRef &&
        !nextStore.profiles.some(
          (profile) =>
            profile.credentialRef?.kind === previousRef.kind &&
            profile.credentialRef.id === previousRef.id,
        )
      ) {
        try {
          await this.deleteUnreferencedCredential(previousRef);
        } catch (error) {
          throw new Error(
            `Station pairing saved, but its unreferenced prior credential could not be removed: ${String(
              error,
            )}`,
          );
        }
      }

      this.replaceProfileStore(nextStore);
      const connectionId = profileConnectionId(updatedProfile);
      const exactOrigin = normalizedPairingEndpoint(
        updatedProfile.endpoint,
        updatedProfile.developmentHttpOrigin,
      );
      const result = await this.bridge.invoke<unknown>(
        'station_profile_authorize_active',
        { profileName: updatedProfile.name },
      );
      const binding = parseNativeProfileAuthorizationReceipt(
        result,
        exactOrigin,
      );
      if (!binding)
        throw new Error(
          'native Station authorization did not return a binding',
        );
      if (!updatedProfile.credentialRef)
        throw new Error('paired Station has no native credential reference');
      this.activeRequestBinding = {
        connectionId,
        credentialRef: updatedProfile.credentialRef,
        ...(updatedProfile.environmentId
          ? { environmentId: updatedProfile.environmentId }
          : {}),
        ...binding,
      };
      // Desktop's temporary ConnectionStore entry is deliberately replaced by
      // the shared saved Station projection above. Return its real service identity
      // so the caller cannot continue reconciling or selecting the discarded
      // temporary connection.
      return connectionId;
    }
    throw new Error('saved Station changed concurrently; retry pairing.');
  }

  private async readProfileStore(): Promise<StationProfileStore> {
    const raw = await this.bridge.invoke<unknown>('station_profile_store_read');
    const parsed = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
    if (
      !isStationProfileStore(parsed) ||
      parsed.profiles.some(
        (profile) => !credentialBearingEndpointIsSafe(profile),
      )
    ) {
      throw new Error(
        'saved Station metadata is corrupt, unsupported, or exposes credentials over non-loopback HTTP; refusing the local browser read path.',
      );
    }
    return parsed;
  }

  private async writeProfileStore(
    store: StationProfileStore,
    expectedRevision: number,
    pairingHandle?: string,
  ): Promise<void> {
    await this.bridge.invoke('station_profile_store_write', {
      contents: `${JSON.stringify(store, null, 2)}\n`,
      expectedRevision,
      ...(pairingHandle ? { pairingHandle } : {}),
    });
  }

  private isRevisionConflict(error: unknown): boolean {
    return String(error).toLowerCase().includes('revision conflict');
  }

  private async writeCredential(credentialHandle: string): Promise<void> {
    await this.bridge.invoke('credential_vault_commit_pairing', {
      handle: credentialHandle,
    });
  }

  private async deleteUnreferencedCredential(
    reference: StationProfileCredentialRef,
  ): Promise<void> {
    await this.bridge.invoke('credential_vault_delete_unreferenced', {
      reference,
    });
  }

  credentialEntries(): Array<{
    key: string;
    profileName: string;
    reference: NonNullable<StationProfile['credentialRef']>;
  }> {
    const activeConnectionId = this.values.get(ACTIVE_KEY);
    const profile = activeConnectionId
      ? this.profileStore.profiles.find(
          (candidate) => profileConnectionId(candidate) === activeConnectionId,
        )
      : undefined;
    if (!profile?.credentialRef) return [];
    return [
      {
        key: `${profile.environmentId ? 'environment' : 'connection'}:${
          profile.credentialRef.id
        }`,
        profileName: profile.name,
        reference: profile.credentialRef,
      },
    ];
  }
}

let nativeProfileStorage: NativeStationProfileStorage | null = null;

export function nativeStationProfileStorage(
  persistsClientSelection = false,
): NativeStationProfileStorage {
  if (!nativeProfileStorage)
    nativeProfileStorage = new NativeStationProfileStorage(
      TAURI_INVOKER,
      defaultStorage,
      persistsClientSelection,
    );
  return nativeProfileStorage;
}
