import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { StationProfile } from '@kontourai/station-contracts';
import { PUBLIC_DEVICE_PAIRING_LOCAL_GRANT_PATH } from '@kontourai/station-contracts/environment-security';
import {
  getProfileCredentialStore,
  newLocalGrantCredentialRef,
  type ProfileCredentialStore,
} from './profile-credentials.js';
import {
  findProfile,
  isCredentialRefReferenced,
  upsertProfile,
} from './profile-store.js';

/**
 * Same-machine CLI self-authorization (#1098).
 *
 * `station setup local` installs a service and saves a default Station, but
 * until this module existed the saved binding carried no credential, so the
 * very first `station agents list` after a successful install answered
 * `authentication_required`. The authorization material was already on disk:
 * the server writes a per-boot, owner-only (0600) secret to
 * `<home>/runtime/local-grant.secret`
 * (`src-server/runtime/routes/runtime-routes.ts`, `writeLocalGrantSecretFile`)
 * and exposes `POST /.well-known/station/v1/pairing/local-grant`, which
 * exchanges possession of that exact secret — presented by a DIRECT loopback
 * caller only — for an ordinary durable paired-device credential. The desktop
 * shell has used that exact route since station#1715
 * (`src-desktop/src/lib.rs`, `station_local_self_provision`); this is the
 * CLI-side twin.
 *
 * Threat model, unchanged from the desktop's: possession of the owner-only
 * Station home is local authority already, so this mechanizes an authority
 * the caller has rather than minting a new one. The CLI-side gate this module
 * adds is the mirror of the server's loopback requirement: a profile whose
 * endpoint is not an IP-literal loopback origin is NEVER self-authorized —
 * a forwarded or LAN endpoint would let network position stand in for
 * filesystem possession, which is exactly what the server route refuses.
 */

export type LocalSelfAuthOutcome =
  | { status: 'authorized'; profile: StationProfile; credential: string }
  /** The profile is not the kind this mechanism applies to; not an error. */
  | { status: 'ineligible'; reason: string }
  | { status: 'failed'; reason: string };

export interface LocalSelfAuthDependencies {
  credentialStore?: ProfileCredentialStore;
  fetchImpl?: typeof fetch;
  /** Hostname used for the paired-device name; primarily a test seam. */
  resolveHostname?: () => string;
  timeoutMs?: number;
}

/**
 * IP-literal loopback origins only — deliberately the same list
 * `isCredentialTransportAllowed` accepts for plaintext bearers, and
 * deliberately NOT `localhost`, whose resolution a name service controls.
 */
export function isLoopbackSelfAuthEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return url.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
}

export function localGrantSecretPath(baseDir: string): string {
  return join(baseDir, 'runtime', 'local-grant.secret');
}

/**
 * A saved Station this mechanism can even apply to: an installed local
 * service (which names the home holding the secret file) reached over an
 * IP-literal loopback origin. Says nothing about whether the exchange will
 * succeed — only that attempting it is legitimate.
 */
export function isLocalSelfAuthCandidate(
  profile: Pick<StationProfile, 'endpoint' | 'localService'>,
): profile is Pick<StationProfile, 'endpoint' | 'localService'> & {
  localService: NonNullable<StationProfile['localService']>;
} {
  return (
    profile.localService !== undefined &&
    isLoopbackSelfAuthEndpoint(profile.endpoint)
  );
}

function defaultDeviceName(resolveHostname: () => string): string {
  const base = `${resolveHostname()} CLI`.trim() || 'Station CLI';
  return Array.from(base).slice(0, 64).join('');
}

/**
 * Reads the per-boot local-grant secret, exchanges it for a durable
 * paired-device credential on the server's own local-grant route, and
 * persists the result exactly the way pairing does: immutable keyring entry
 * first, then one profile-metadata commit, with the keyring entry rolled back
 * if the metadata write fails and the displaced ref retired only after the
 * commit is durable.
 *
 * Sends `clientInstanceId` with the desktop's exact semantics
 * (`resolve_local_self_provision_client_instance_id`,
 * `src-desktop/src/lib.rs`): reuse the profile's persisted value when present
 * so the server supersedes — revokes — the grant this profile no longer
 * references instead of accumulating live credentials; mint one otherwise and
 * persist it verbatim alongside the credential.
 */
export async function selfAuthorizeLocalProfile(
  profile: StationProfile,
  dependencies: LocalSelfAuthDependencies = {},
): Promise<LocalSelfAuthOutcome> {
  if (!profile.localService) {
    return {
      status: 'ineligible',
      reason: 'this saved Station has no installed local service',
    };
  }
  if (!isLoopbackSelfAuthEndpoint(profile.endpoint)) {
    return {
      status: 'ineligible',
      reason: `self-authorization requires an IP-literal loopback endpoint (this Station targets ${profile.endpoint})`,
    };
  }
  const secretPath = localGrantSecretPath(profile.localService.baseDir);
  let secret: string;
  try {
    secret = readFileSync(secretPath, 'utf8');
  } catch {
    return {
      status: 'failed',
      reason: `the service's local-grant secret is not readable (${secretPath}); is the service running?`,
    };
  }
  if (secret.length === 0) {
    return {
      status: 'failed',
      reason: `the service's local-grant secret is empty (${secretPath})`,
    };
  }

  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const resolveHostname = dependencies.resolveHostname ?? hostname;
  const clientInstanceId = profile.clientInstanceId ?? randomUUID();
  const origin = new URL(profile.endpoint).origin;
  let response: Response;
  try {
    response = await fetchImpl(
      `${origin}${PUBLIC_DEVICE_PAIRING_LOCAL_GRANT_PATH}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          secret,
          deviceName: defaultDeviceName(resolveHostname),
          clientInstanceId,
        }),
        signal: AbortSignal.timeout(dependencies.timeoutMs ?? 10_000),
      },
    );
  } catch {
    return {
      status: 'failed',
      reason: `could not reach ${origin} to authorize this CLI`,
    };
  }
  if (!response.ok) {
    const code = await response
      .json()
      .then((body) => {
        const error = (body as { error?: unknown } | null)?.error;
        return typeof error === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(error)
          ? error
          : `HTTP ${response.status}`;
      })
      .catch(() => `HTTP ${response.status}`);
    return {
      status: 'failed',
      reason: `the Station refused the local-grant exchange (${code})`,
    };
  }
  let exchange: { environmentId?: unknown; credential?: unknown };
  try {
    exchange = (await response.json()) as typeof exchange;
  } catch {
    return {
      status: 'failed',
      reason:
        'the Station answered the local-grant exchange with a non-JSON body',
    };
  }
  // Mirrors the desktop's exchange-response bounds byte-for-byte
  // (`src-desktop/src/lib.rs`, the `NativePairingExchangeResponse` checks).
  if (
    typeof exchange.environmentId !== 'string' ||
    exchange.environmentId.length === 0 ||
    exchange.environmentId.length > 512 ||
    typeof exchange.credential !== 'string' ||
    exchange.credential.length === 0 ||
    exchange.credential.length > 16 * 1024
  ) {
    return {
      status: 'failed',
      reason:
        'the Station answered the local-grant exchange with an invalid credential payload',
    };
  }

  // The exchange succeeded against the profile we were handed; refuse to
  // attach its credential to a binding that changed underneath us.
  const current = findProfile(profile.name);
  if (!current || current.endpoint !== profile.endpoint) {
    return {
      status: 'failed',
      reason: `saved Station "${profile.name}" changed while authorizing; its newer binding was preserved`,
    };
  }

  const credentialStore =
    dependencies.credentialStore ?? getProfileCredentialStore();
  const credentialRef = newLocalGrantCredentialRef();
  try {
    credentialStore.set(credentialRef, exchange.credential);
  } catch (error) {
    return {
      status: 'failed',
      reason: `could not store the credential in the OS credential store: ${(error as Error).message}`,
    };
  }
  let updated: StationProfile;
  try {
    updated = upsertProfile({
      name: current.name,
      endpoint: current.endpoint,
      credentialRef,
      environmentId: exchange.environmentId,
      clientInstanceId,
      setupSource: current.setupSource,
      configurationState: 'configured',
      force: true,
    }).profile;
  } catch (error) {
    try {
      credentialStore.delete(credentialRef);
    } catch (rollbackError) {
      return {
        status: 'failed',
        reason: `saved Station metadata write failed (${(error as Error).message}); credential rollback also failed (${(rollbackError as Error).message})`,
      };
    }
    return {
      status: 'failed',
      reason: `saved Station metadata write failed; the credential was rolled back: ${(error as Error).message}`,
    };
  }
  const previousRef = current.credentialRef;
  try {
    if (
      previousRef &&
      previousRef.id !== credentialRef.id &&
      !isCredentialRefReferenced(previousRef)
    ) {
      credentialStore.delete(previousRef);
    }
  } catch {
    // The metadata commit is durable and the new keyring ref is live; a
    // failed retirement only retains the old opaque ref, exactly as pairing
    // treats this case.
  }
  return {
    status: 'authorized',
    profile: updated,
    credential: exchange.credential,
  };
}

/**
 * The self-heal half of #1098: a machine holding an installed local service
 * and a credential-less saved Station (the exact state every pre-fix
 * `station setup local` left behind) heals on its next CLI command instead
 * of demanding a reinstall. `configureApiCredential` installs this resolver
 * only when no credential is in hand; the SDK awaits it before attaching
 * auth to the first request, so a successful heal authorizes that very
 * request. One attempt per process — a refused exchange leaves the request
 * unauthenticated, which fails exactly as it did before this existed.
 */
export function createLocalSelfHealCredentialResolver(
  stationName: string,
  origin: string,
  dependencies: LocalSelfAuthDependencies = {},
):
  | (() => Promise<{ credential: string; origin: string } | undefined>)
  | undefined {
  const profile = findProfile(stationName);
  if (!profile || new URL(profile.endpoint).origin !== origin) return undefined;
  if (!isLocalSelfAuthCandidate(profile)) return undefined;
  if (!existsSync(localGrantSecretPath(profile.localService.baseDir))) {
    return undefined;
  }
  let attempt:
    | Promise<{ credential: string; origin: string } | undefined>
    | undefined;
  return () => {
    attempt ??= selfAuthorizeLocalProfile(profile, dependencies).then(
      (outcome) =>
        outcome.status === 'authorized'
          ? { credential: outcome.credential, origin }
          : undefined,
      () => undefined,
    );
    return attempt;
  };
}
