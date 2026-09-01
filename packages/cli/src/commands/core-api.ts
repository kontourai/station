import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AuthenticatedFetchInit } from '@kontourai/station-sdk/client';
import {
  authenticatedFetch,
  DEFAULT_CLIENT_REQUEST_TIMEOUT_MS,
  getClientRequestTimeout,
  setClientCredentialResolver,
  setClientRequestTimeout,
} from '@kontourai/station-sdk/client';
import { readActiveLocalStation } from './active-local-station.js';
import { DEFAULT_SERVER_PORT } from './helpers.js';
import { createLocalSelfHealCredentialResolver } from './local-self-auth.js';
import {
  assertCredentialTransportAllowed,
  getProfileCredentialStore,
} from './profile-credentials.js';
import {
  describeKnownProfiles,
  findProfile,
  resolveDefaultProfile,
  resolveProjectProfile,
} from './profile-store.js';

export interface ParsedCoreArgs {
  flags: Record<string, string | boolean>;
  positionals: string[];
  /**
   * Every value seen for each `--flag=value` occurrence, in argv order —
   * `flags` only keeps the last (a bare `--flag` with no `=value` is never
   * recorded here). Needed for a genuinely repeatable flag like
   * `--model-option key=value` (station#978 AC7, `collectModelOptions`);
   * every other flag ignores this and reads `flags` exactly as before —
   * fully additive, no behavior change for existing callers.
   */
  repeatedFlags: Record<string, string[]>;
}

type JsonEnvelope<T> = {
  success: boolean;
  data?: T;
  error?: unknown;
  message?: string;
  /**
   * Zod's `error.flatten()` as sent by the server's `validate()` middleware
   * (`src-server/routes/schemas/schema-validation.ts`).
   */
  details?: unknown;
};

/**
 * station#2871: the server answers a schema rejection with
 * `{ error: 'Validation failed', details: <zod flatten()> }`, and the CLI used
 * to surface only the summary. "Validation failed" names neither the field nor
 * the rule, so a caller who mistyped an id had to go read the schema to find
 * out what was wrong. The reason the server already computed is the useful
 * half; carry it.
 *
 * Deliberately formatting-only — this never decides whether a request failed,
 * only what the user is told about a failure that already happened.
 */
export function describeValidationDetails(details: unknown): string | null {
  if (!details || typeof details !== 'object') return null;
  const flattened = details as {
    formErrors?: unknown;
    fieldErrors?: unknown;
  };
  const parts: string[] = [];

  const fieldErrors = flattened.fieldErrors;
  if (fieldErrors && typeof fieldErrors === 'object') {
    for (const [field, messages] of Object.entries(
      fieldErrors as Record<string, unknown>,
    )) {
      const reasons = Array.isArray(messages)
        ? messages.filter((m): m is string => typeof m === 'string' && m !== '')
        : [];
      if (reasons.length > 0) parts.push(`${field} ${reasons.join('; ')}`);
    }
  }

  const formErrors = Array.isArray(flattened.formErrors)
    ? flattened.formErrors.filter(
        (m): m is string => typeof m === 'string' && m !== '',
      )
    : [];
  parts.push(...formErrors);

  return parts.length > 0 ? parts.join(', ') : null;
}

/** Format an API diagnostic without losing structured server errors. */
export function describeApiError(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value.length > 0) return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.message === 'string' && record.message) {
      return record.message;
    }
    if (typeof record.code === 'string' && record.code) return record.code;
    try {
      return JSON.stringify(value);
    } catch {}
  }
  return fallback;
}

export function parseCoreArgs(args: string[]): ParsedCoreArgs {
  const flags: Record<string, string | boolean> = {};
  const repeatedFlags: Record<string, string[]> = {};
  const positionals: string[] = [];

  for (const arg of args) {
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }

    const trimmed = arg.slice(2);
    const equalsIndex = trimmed.indexOf('=');
    if (equalsIndex === -1) {
      if (trimmed === 'verbose') {
        // A global diagnostic flag: command-specific allow-lists enumerate
        // flags, so keep it readable but non-enumerable everywhere.
        Object.defineProperty(flags, 'verbose', {
          configurable: true,
          enumerable: false,
          value: true,
        });
      } else {
        flags[trimmed] = true;
      }
      continue;
    }

    const key = trimmed.slice(0, equalsIndex);
    const value = trimmed.slice(equalsIndex + 1);
    flags[key] = value;
    if (!repeatedFlags[key]) {
      repeatedFlags[key] = [];
    }
    repeatedFlags[key].push(value);
  }

  return { flags, positionals, repeatedFlags };
}

/**
 * Strips trailing slashes and a trailing `/api` path segment from an
 * `--api-base` value. Every resource path constant in
 * `core.ts`/`surfaces.ts` already includes a leading `/api` segment, so
 * `requestJson()` builds `${apiBase}${path}` — an `/api`-suffixed base
 * (e.g. copied from a browser Network-tab request URL) would otherwise
 * double up into `/api/api/...` and 404.
 *
 * Constraint: this makes a server genuinely mounted at a base path whose
 * final segment is literally `api` indistinguishable from the
 * doubled-prefix mistake this normalizes — that segment is stripped
 * either way. Accepted per the documented convention (`--api-base` is the
 * bare origin; the CLI owns the `/api` segment on every path constant).
 */
function normalizeApiBase(value: string): string {
  const withoutTrailingSlashes = value.replace(/\/+$/, '');
  const withoutApiSuffix = withoutTrailingSlashes.replace(/\/api$/, '');
  return withoutApiSuffix.replace(/\/+$/, '') || withoutTrailingSlashes;
}

/** Where a resolved API base came from — used for legible errors and tests. */
export type ApiBaseSource =
  | 'api-base-flag'
  | 'station-flag'
  | 'station-env'
  | 'project-station'
  | 'default-station'
  | 'active-local'
  | 'loopback';

export interface ResolvedApiBase {
  apiBase: string;
  source: ApiBaseSource;
  /** Set when the base came from a named saved Station. */
  station?: string;
}

/**
 * Resolves the Station a command talks to, in precedence order:
 *
 *   1. `--api-base=<origin>` — explicit direct bootstrap/diagnostic target
 *   2. `--station=<name>`
 *   3. `STATION_TARGET=<name>`
 *   4. an explicit owner-safe project-local Station selection
 *   5. the selected default Station
 *   6. the active local desktop Station, when its owner-safe record is live
 *   7. `http://127.0.0.1:${STATION_PORT||3141}`
 *
 * An explicit saved Station that is unknown is an error; it never falls
 * through to a local Station. Saved Stations replace the old host aliases.
 */
export function resolveApiBaseDetailed(
  parsed: ParsedCoreArgs,
): ResolvedApiBase {
  const resolved = computeApiBaseDetailed(parsed);
  rememberResolvedApiBase(resolved);
  if (parsed.flags.verbose === true) printResolvedTarget(resolved);
  return resolved;
}

function computeApiBaseDetailed(parsed: ParsedCoreArgs): ResolvedApiBase {
  const explicit = parsed.flags['api-base'];
  if (explicit !== undefined && parsed.flags.station !== undefined) {
    throw new Error(
      '--api-base and --station select different target modes; pass exactly one.',
    );
  }
  if (typeof explicit === 'string' && explicit.length > 0) {
    try {
      const normalized = normalizeApiBase(explicit);
      const url = new URL(normalized);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('unsupported protocol');
      }
      return { apiBase: normalized, source: 'api-base-flag' };
    } catch {
      throw new Error(
        '--api-base requires a full http(s) URL. Use --station=<name> for a Station saved on this device.',
      );
    }
  }

  const stationFlag = parsed.flags.station;
  if (stationFlag === true || stationFlag === '') {
    throw new Error(
      '--station requires a Station name, e.g. --station=kontour.',
    );
  }
  if (typeof stationFlag === 'string') {
    const station = findProfile(stationFlag);
    if (!station) {
      throw new Error(
        `No Station named "${stationFlag}". ${describeKnownProfiles()}`,
      );
    }
    return {
      apiBase: station.endpoint,
      source: 'station-flag',
      station: station.name,
    };
  }

  const environmentTarget = process.env.STATION_TARGET;
  if (environmentTarget) {
    const station = findProfile(environmentTarget);
    if (!station) {
      throw new Error(
        `STATION_TARGET names no Station "${environmentTarget}". ${describeKnownProfiles()}`,
      );
    }
    return {
      apiBase: station.endpoint,
      source: 'station-env',
      station: station.name,
    };
  }

  const projectStation = resolveProjectProfile();
  if (projectStation) {
    return {
      apiBase: projectStation.endpoint,
      source: 'project-station',
      station: projectStation.name,
    };
  }

  const defaultStation = resolveDefaultProfile();
  if (defaultStation) {
    return {
      apiBase: defaultStation.endpoint,
      source: 'default-station',
      station: defaultStation.name,
    };
  }

  const activeLocal = readActiveLocalStation();
  if (activeLocal) {
    return { apiBase: activeLocal, source: 'active-local' };
  }

  const port = process.env.STATION_PORT || String(DEFAULT_SERVER_PORT);
  return { apiBase: `http://127.0.0.1:${port}`, source: 'loopback' };
}

export function resolveApiBase(parsed: ParsedCoreArgs): string {
  return resolveApiBaseDetailed(parsed).apiBase;
}

/**
 * The base URL (and provenance) the current invocation actually resolved.
 *
 * A CLI process talks to exactly one Station, but the resolution happens deep
 * inside a command while the failure is reported at the top-level catch. This
 * records the answer so the error formatter can name the URL and where it came
 * from instead of printing a bare `fetch failed`.
 */
let lastResolvedApiBase: ResolvedApiBase | undefined;

export function rememberResolvedApiBase(resolved: ResolvedApiBase): void {
  lastResolvedApiBase = resolved;
}

export function getResolvedApiBase(): ResolvedApiBase | undefined {
  return lastResolvedApiBase;
}

/** Deliberate, secret-free target disclosure for mutations and scripts. */
export function printResolvedTarget(
  resolved: ResolvedApiBase = getResolvedApiBase()!,
): void {
  console.error(
    `Target: station=${resolved.station ?? 'direct'} endpoint=${resolved.apiBase} source=${resolved.source}`,
  );
}

/**
 * Puts a deadline on every Station request this process makes.
 *
 * Without one, a Station that accepts the TCP connection but never answers
 * leaves the CLI printing nothing, forever — the worst possible failure mode
 * for a command in a script. `STATION_REQUEST_TIMEOUT_MS` overrides the
 * default; `0` disables the deadline entirely for deliberately long work.
 *
 * Deliberately NOT covered (their bodies are open-ended by design, and a
 * deadline would kill healthy work): the orchestration/chat SSE streams and
 * the monitoring event stream (they pass their own `AbortSignal`, which opts
 * them out), `knowledge reindex`/`migrate` and `flow attach-command` (opted
 * out explicitly at their call sites), and the lifecycle readiness probes in
 * `lifecycle.ts`, which already enforce their own deadlines.
 */
export function configureRequestTimeout(): void {
  const raw = process.env.STATION_REQUEST_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === '') {
    setClientRequestTimeout(DEFAULT_CLIENT_REQUEST_TIMEOUT_MS);
    return;
  }
  const parsedMs = Number(raw);
  if (!Number.isFinite(parsedMs) || parsedMs < 0) {
    throw new Error(
      `STATION_REQUEST_TIMEOUT_MS must be a non-negative number of milliseconds (got "${raw}"). Use 0 to disable the request deadline.`,
    );
  }
  setClientRequestTimeout(parsedMs);
}

/**
 * Adds the configured deadline to a raw `fetch` init. Used by the handful of
 * CLI call sites that talk to Station (or a plugin registry) through the
 * global `fetch` rather than the SDK client. Streaming call sites pass their
 * own `signal` and are left alone.
 */
export function withRequestTimeout(init: RequestInit = {}): RequestInit {
  const timeoutMs = getClientRequestTimeout();
  if (timeoutMs === undefined || init.signal) return init;
  return { ...init, signal: AbortSignal.timeout(timeoutMs) };
}

export function configureApiCredential(
  parsed: ParsedCoreArgs,
  apiBase: string,
): boolean {
  const explicit = parsed.flags.credential;
  if (explicit === true || explicit === '') {
    throw new Error('--credential requires a non-empty value.');
  }
  const origin = new URL(apiBase).origin;
  const resolved = getResolvedApiBase();
  const stationCredential = resolved?.station
    ? findProfile(resolved.station)?.credentialRef
    : undefined;
  // Explicit credential injection stays useful for bootstrap/pairing. Saved
  // saved-Station credentials are resolved only through the platform credential
  // store; no file-backed fallback exists.
  const credential =
    typeof explicit === 'string'
      ? explicit
      : process.env.STATION_API_CREDENTIAL ||
        (stationCredential
          ? getProfileCredentialStore().get(stationCredential)
          : undefined);
  if (!credential) {
    // #1098 self-heal: a saved Station with an installed loopback local
    // service but no materialized credential (the state every pre-fix
    // `station setup local` left behind, and the state after a lost keyring
    // entry) can prove home possession via the per-boot local-grant secret.
    // Install a one-shot resolver that performs that exchange before the
    // first authenticated request; if it cannot, the request proceeds
    // unauthenticated and fails exactly as it always did.
    const selfHeal = resolved?.station
      ? createLocalSelfHealCredentialResolver(resolved.station, origin)
      : undefined;
    if (selfHeal) {
      assertCredentialTransportAllowed(origin);
      setClientCredentialResolver(selfHeal);
      return true;
    }
    setClientCredentialResolver(undefined);
    return false;
  }

  assertCredentialTransportAllowed(origin);
  setClientCredentialResolver(() => ({ credential, origin }));
  return true;
}

export function printJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

/**
 * Prints the result of a `@kontourai/station-sdk/client` fetcher call.
 * Hoisted here (#167 iteration-2, M2) from byte-identical local copies in
 * `core.ts` and `surfaces.ts`.
 *
 * Every canonical client fetcher (#167) unwraps a `{success,data}` envelope
 * to just `data` and throws on `!success` — but several bare-success routes
 * (e.g. `DELETE /agents/:slug`, `DELETE /api/projects/:slug`,
 * `DELETE /api/skills/:name`, `DELETE /integrations/:id`) respond with
 * `{success:true}` and no `data` field, so the unwrapped result is
 * `undefined`. The CLI's original `requestJson` handled this by falling
 * back to `{success:true, message}` before printing; this helper preserves
 * that exact printed-output contract for the migrated call sites (AC4:
 * refactor-only, no observable CLI output change).
 */
export function printFetched(data: unknown): void {
  printJson(data === undefined ? { success: true } : data);
}

/**
 * Prints `data` as compact single-line JSON when `jsonMode` is set, else
 * pretty-printed via `printJson`. Hoisted (#165 iteration-2 code-review LOW
 * fix) from byte-identical local two-branch copies in `approvals.ts`'s
 * `printApprovals` and `runApprovalsRespond`.
 */
export function printJsonMode(data: unknown, jsonMode: boolean): void {
  if (jsonMode) {
    console.log(JSON.stringify(data));
    return;
  }
  printJson(data);
}

export async function requestJson<T>(
  apiBase: string,
  path: string,
  init?: AuthenticatedFetchInit,
): Promise<T | { success: true; message?: string }> {
  const response = await authenticatedFetch(`${apiBase}${path}`, {
    method: init?.method || 'GET',
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers || {}),
    },
  });

  let payload: JsonEnvelope<T> | null = null;
  try {
    payload = (await response.json()) as JsonEnvelope<T>;
  } catch {
    if (!response.ok) {
      throw new Error(`Request failed with HTTP ${response.status}`);
    }
    throw new Error('Expected JSON response');
  }

  if (!response.ok || !payload.success) {
    const summary = describeApiError(
      payload.error ?? payload.message,
      `Request failed with HTTP ${response.status}`,
    );
    const fields = describeValidationDetails(payload.details);
    throw new Error(fields ? `${summary}: ${fields}` : summary);
  }

  if (payload.data !== undefined) {
    return payload.data;
  }

  return { success: true, message: payload.message };
}

/**
 * Fetches a route that returns a RAW body (not the {success,data} envelope) —
 * e.g. conversation exports, which emit thread JSON or markdown directly.
 * Error statuses still carry the JSON envelope, so failures surface its
 * `error` message when present.
 */
export async function requestText(
  apiBase: string,
  path: string,
  init?: AuthenticatedFetchInit,
): Promise<{ body: string; contentType: string }> {
  const response = await authenticatedFetch(`${apiBase}${path}`, {
    method: init?.method || 'GET',
    ...init,
  });
  const body = await response.text();
  if (!response.ok) {
    let message = `Request failed with HTTP ${response.status}`;
    try {
      const envelope = JSON.parse(body) as {
        error?: unknown;
        message?: string;
      };
      message = describeApiError(envelope.error ?? envelope.message, message);
    } catch {
      // Non-JSON error body; keep the status message.
    }
    throw new Error(message);
  }
  return { body, contentType: response.headers.get('content-type') ?? '' };
}

export function requirePositional(
  parsed: ParsedCoreArgs,
  index: number,
  name: string,
): string {
  const value = parsed.positionals[index];
  if (!value) {
    throw new Error(`Missing required argument: ${name}`);
  }
  return value;
}

/**
 * Reads an optional `--<name>=<value>` flag, rejecting a bare `--<name>` (no
 * `=value`) or an empty value rather than silently treating it as unset —
 * hoisted here (#977) from a byte-identical private copy in `core.ts` so
 * `delegate.ts` can share the same flag-parsing contract instead of forking
 * a second copy.
 */
export function optionalValueFlag(
  parsed: ParsedCoreArgs,
  name: string,
): string | undefined {
  const value = parsed.flags[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`--${name} requires a non-empty value.`);
  }
  return value;
}

async function readStdin(): Promise<string> {
  return await new Promise<string>((resolvePromise, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolvePromise(data));
    process.stdin.on('error', reject);
  });
}

export async function loadJsonPayload(
  parsed: ParsedCoreArgs,
): Promise<Record<string, unknown>> {
  const inline = parsed.flags.data;
  if (typeof inline === 'string' && inline.length > 0) {
    return JSON.parse(inline) as Record<string, unknown>;
  }

  const file = parsed.flags.file;
  if (typeof file === 'string' && file.length > 0) {
    return JSON.parse(readFileSync(resolve(file), 'utf8')) as Record<
      string,
      unknown
    >;
  }

  if (!process.stdin.isTTY) {
    const stdin = (await readStdin()).trim();
    if (stdin.length > 0) {
      return JSON.parse(stdin) as Record<string, unknown>;
    }
  }

  throw new Error(
    'Provide JSON input with --data=<json>, --file=<path>, or piped stdin.',
  );
}

export async function loadTextInput(
  parsed: ParsedCoreArgs,
  startIndex = 0,
): Promise<string> {
  const inline = parsed.positionals.slice(startIndex).join(' ').trim();
  if (inline.length > 0) {
    return inline;
  }

  const dataFlag = parsed.flags.data;
  if (typeof dataFlag === 'string' && dataFlag.length > 0) {
    return dataFlag;
  }

  const fileFlag = parsed.flags.file;
  if (typeof fileFlag === 'string' && fileFlag.length > 0) {
    return readFileSync(resolve(fileFlag), 'utf8');
  }

  if (!process.stdin.isTTY) {
    const stdin = await readStdin();
    if (stdin.trim().length > 0) {
      return stdin;
    }
  }

  throw new Error(
    'Provide message text as positional args, --data=<text>, --file=<path>, or piped stdin.',
  );
}

export async function streamSse(
  response: Response,
  onEvent: (event: Record<string, unknown>) => void,
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('No response body available for streaming');
  }

  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const segments = buffer.split('\n\n');
      buffer = segments.pop() || '';

      for (const segment of segments) {
        const line = segment
          .split('\n')
          .find((entry) => entry.startsWith('data: '));
        if (!line) {
          continue;
        }

        const payload = line.slice(6);
        if (payload === '[DONE]') {
          return;
        }

        onEvent(JSON.parse(payload) as Record<string, unknown>);
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }
}
