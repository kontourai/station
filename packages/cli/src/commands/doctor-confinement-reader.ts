/**
 * #4774: asks the selected Station for its confinement preflight. The
 * Station is selected the way every client command selects one
 * (`resolveApiBaseDetailed`), and the read needs a credential this CLI
 * already holds, as `station triage` does: doctor reports, so it never
 * pairs or self-authorizes on its own. Every way the answer is not obtained
 * comes back as `checked: false` with the reason, never as an exception.
 */
import { parseConfinementPreflight } from '@kontourai/station-contracts/execution-confinement';
import { authenticatedFetch } from '@kontourai/station-sdk/client';
import {
  configureApiCredential,
  type ParsedCoreArgs,
  parseCoreArgs,
  type ResolvedApiBase,
  resolveApiBaseDetailed,
} from './core-api.js';
import {
  type DoctorConfinement,
  type DoctorConfinementTarget,
  describeConfinementTarget,
  doctorConfinementText,
  sanitizeConfinementPreflight,
} from './doctor-confinement.js';
import { getProfileCredentialStore } from './profile-credentials.js';
import { findProfile } from './profile-store.js';

export const CONFINEMENT_PREFLIGHT_PATH =
  '/api/diagnostics/confinement-preflight';

/** The first answer may wait on the Seatbelt probe the server runs once. */
const CONFINEMENT_PREFLIGHT_TIMEOUT_MS = 15_000;

export interface ConfinementPreflightReaderDeps {
  resolveTarget: (parsed: ParsedCoreArgs) => ResolvedApiBase;
  /** Whether this CLI already holds a credential for the target. */
  hasCredential: (parsed: ParsedCoreArgs, resolved: ResolvedApiBase) => boolean;
  configureCredential: (parsed: ParsedCoreArgs, apiBase: string) => boolean;
  fetchPreflight: (url: string, signal: AbortSignal) => Promise<Response>;
}

function heldCredential(
  parsed: ParsedCoreArgs,
  resolved: ResolvedApiBase,
): boolean {
  if (typeof parsed.flags.credential === 'string') return true;
  if (process.env.STATION_API_CREDENTIAL) return true;
  const ref = resolved.station
    ? findProfile(resolved.station)?.credentialRef
    : undefined;
  return ref ? getProfileCredentialStore().status(ref) === 'available' : false;
}

const DEFAULT_DEPS: ConfinementPreflightReaderDeps = {
  resolveTarget: resolveApiBaseDetailed,
  hasCredential: heldCredential,
  configureCredential: configureApiCredential,
  fetchPreflight: (url, signal) =>
    authenticatedFetch(url, { method: 'GET', signal }),
};

function unreachable(error: unknown): string {
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  const code =
    typeof cause?.code === 'string'
      ? cause.code
      : error instanceof Error && error.name === 'TimeoutError'
        ? `no answer within ${CONFINEMENT_PREFLIGHT_TIMEOUT_MS / 1000}s`
        : error instanceof Error
          ? error.message
          : 'unknown error';
  return `no Station server answered (${code}). Start it, or select one with --station=<name>.`;
}

export async function readStationConfinementPreflight(
  args: readonly string[],
  deps: Partial<ConfinementPreflightReaderDeps> = {},
): Promise<DoctorConfinement> {
  const { resolveTarget, hasCredential, configureCredential, fetchPreflight } =
    { ...DEFAULT_DEPS, ...deps };
  const parsed = parseCoreArgs([...args]);
  let resolved: ResolvedApiBase;
  try {
    resolved = resolveTarget(parsed);
  } catch (error) {
    return {
      checked: false,
      reason: `no Station could be selected: ${doctorConfinementText(error instanceof Error ? error.message : String(error))}`,
    };
  }
  const target: DoctorConfinementTarget = {
    station: resolved.station ?? null,
    source: resolved.source,
  };
  const named = describeConfinementTarget(target);
  const notChecked = (reason: string): DoctorConfinement => ({
    checked: false,
    target,
    reason: doctorConfinementText(reason),
  });
  let configured: boolean;
  try {
    configured =
      hasCredential(parsed, resolved) &&
      configureCredential(parsed, resolved.apiBase);
  } catch (error) {
    // An empty `--credential`, or a credential the transport check refuses
    // to send to this origin: the read never starts.
    return notChecked(
      `the credential for ${named} cannot be used: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!configured)
    return notChecked(
      `this CLI holds no credential for ${named}. Pair it, or pass --credential, to let doctor read its confinement preflight.`,
    );
  let response: Response;
  try {
    response = await fetchPreflight(
      `${resolved.apiBase}${CONFINEMENT_PREFLIGHT_PATH}`,
      AbortSignal.timeout(CONFINEMENT_PREFLIGHT_TIMEOUT_MS),
    );
  } catch (error) {
    return notChecked(`${named}: ${unreachable(error)}`);
  }
  if (response.status === 404)
    return notChecked(
      `${named} does not report a confinement preflight (HTTP 404); update it to a version that does.`,
    );
  if (response.status === 401 || response.status === 403)
    return notChecked(
      `${named} refused this CLI's credential (HTTP ${response.status}).`,
    );
  if (!response.ok)
    return notChecked(`${named} could not answer (HTTP ${response.status}).`);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return notChecked(`${named} answered with something other than JSON.`);
  }
  const preflight = parseConfinementPreflight(body);
  if (!preflight)
    return notChecked(
      `${named} answered with something other than a confinement preflight.`,
    );
  return {
    checked: true,
    target,
    preflight: sanitizeConfinementPreflight(preflight),
  };
}
