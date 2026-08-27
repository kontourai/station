/**
 * `station config get`/`station config set` — Station's own application
 * config (`config/app.json`).
 *
 * Station#175 (docs/design/settings-architecture.md §6, slice 6): before
 * this, `config set` always wrote `config/app.json` directly, bypassing a
 * running Station's `PUT /config/app` sanitize/validate/reload/event-emit
 * path entirely — a live Station would silently diverge from what was just
 * written to disk until its next restart. Now `config set` writes through
 * the live route by default (same as every other mutating CLI command:
 * `resolveApiBaseDetailed`/`configureApiCredential` per
 * `packages/cli/src/commands/core-api.ts`), getting the server's typed
 * violations and `ignoredKeys` warning for free. `--offline` opts back into
 * the direct file write for when no Station is running.
 *
 * Exactly what the offline path shares with the live route, and what it
 * does not (review round 1 MEDIUM 2(b) — stated precisely rather than as a
 * blanket "same validation" claim):
 *
 *   - SHARED: the registry sanitizer (`sanitizeAppConfigUpdate`, lifted to
 *     `@kontourai/station-contracts/settings-registry` in this slice
 *     precisely so both paths run the same function) — a typed violation is
 *     rejected and a runtime-derived/unknown key is dropped offline exactly
 *     as it is live. Also shared: the null-vs-undefined merge semantics
 *     (`mergeConfigUpdate` here mirrors `src-server/domain/
 *     config-loader-app.ts`'s `mergeAppConfigUpdate` — a registry-nullable
 *     key's explicit `null` is PERSISTED, not deleted; see
 *     `NULLABLE_APP_CONFIG_KEYS`). Also shared: atomic (temp-file +
 *     rename) persistence (`writeConfigFileAtomically`, mirroring
 *     `saveAppConfigFile`'s essentials).
 *   - NOT SHARED: the AJV structural pass `saveAppConfigFile` runs against
 *     `schemas/app.schema.json` for `composite`-kind fields (e.g.
 *     `approvalGuardian`) — an offline write accepts any shape the
 *     sanitizer lets through (composite values are opaque to it by design)
 *     and only actually gets validated the next time Station boots and
 *     loads the file; the command names this in its confirmation line for
 *     exactly that field shape rather than silently claiming full parity.
 *     Also not shared: `saveAppConfigFile`'s cross-process file-mutation
 *     lock — a CLI invocation is a one-shot writer, not a long-lived server
 *     serializing concurrent mutators, so there is nothing else within this
 *     process to lock against; a concurrently RUNNING Station is the
 *     pre-existing, accepted, documented reason `--offline` exists to be
 *     used with caution. And, as always: the live reload/event-bus side
 *     effects a running Station applies are simply not something an
 *     offline write can do.
 *
 * `config get` has no divergence risk (reading is not writing), so it
 * quietly falls back to the file when no Station is reachable rather than
 * erroring — the pre-existing read-only behavior, now just tried through
 * the live route first so a reachable Station's provenance is available.
 */

import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { AppConfig } from '@kontourai/station-contracts/config';
import {
  APP_SETTINGS_REGISTRY,
  NULLABLE_APP_CONFIG_KEYS,
  type SettingProvenanceEntry,
  sanitizeAppConfigUpdate,
} from '@kontourai/station-contracts/settings-registry';
import { updateAppLogLevel } from '@kontourai/station-sdk/app-config';
import { authenticatedFetch } from '@kontourai/station-sdk/client';
import { ensureStationHomeSchemaSync } from '@kontourai/station-shared/station-home-schema';
import {
  configureApiCredential,
  type ParsedCoreArgs,
  resolveApiBaseDetailed,
} from './core-api.js';
import {
  explainRequestFailure,
  isIndeterminateWriteFailure,
} from './errors.js';
import { PROJECT_HOME } from './helpers.js';

const CONFIG_PATH = join(PROJECT_HOME, 'config', 'app.json');

type IgnoredKey = { key: string; reason: 'unknown' | 'runtime-derived' };

const NO_FLAGS: ParsedCoreArgs = {
  flags: {},
  positionals: [],
  repeatedFlags: {},
};

function loadConfigFile(): Record<string, unknown> {
  ensureStationHomeSchemaSync(PROJECT_HOME);
  if (!existsSync(CONFIG_PATH)) return {};
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
}

/**
 * Same-directory temp-file-then-rename (mirrors `saveAppConfigFile`'s
 * essentials in `src-server/domain/config-loader-app.ts`) so a CLI one-shot
 * offline write can't leave `config/app.json` half-written if the process
 * dies mid-write, or torn mid-read by a concurrent reader — `rename(2)` is
 * atomic within a filesystem. Review round 1 MEDIUM 2(a): the plain
 * `writeFileSync(CONFIG_PATH, ...)` this replaced was not atomic. NOT
 * mirrored, deliberately: `saveAppConfigFile`'s cross-process file-mutation
 * lock and expected-source-signature conflict check — a CLI invocation is a
 * single one-shot writer, not a long-lived server serializing concurrent
 * mutators, so there is no concurrent writer within THIS process to lock
 * against (a concurrently running Station is exactly why `--offline`
 * writes bypass its serialization in the first place — that gap is
 * accepted and documented, not something a local lock here would close).
 */
function writeConfigFileAtomically(config: Record<string, unknown>): void {
  const configDir = join(PROJECT_HOME, 'config');
  mkdirSync(configDir, { recursive: true });
  const serialized = JSON.stringify(config, null, 2);
  const tempPath = join(
    configDir,
    `app.json.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(tempPath, serialized, 'utf-8');
    renameSync(tempPath, CONFIG_PATH);
  } finally {
    try {
      unlinkSync(tempPath);
    } catch {
      // Expected on the success path: renameSync already moved it to
      // CONFIG_PATH, so there is nothing left at tempPath to remove.
    }
  }
}

/** Booleans and all-digit strings parse; everything else stays a string. `"null"` is handled by the caller (an explicit clear, not a stored string). */
function parseConfigValue(value: string): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (/^\d+$/.test(value)) return parseInt(value, 10);
  return value;
}

function printIgnoredKeysWarning(ignored: readonly IgnoredKey[]): void {
  if (ignored.length === 0) return;
  const names = ignored
    .map((entry) => `${entry.key} (${entry.reason})`)
    .join(', ');
  console.error(`  ! ignored: ${names}`);
}

function violationsError(
  violations: readonly { key: string; message: string }[],
): Error {
  return new Error(violations.map((violation) => violation.message).join('; '));
}

interface RawEnvelope {
  success?: boolean;
  error?: unknown;
  message?: unknown;
  [key: string]: unknown;
}

/**
 * Parses a `{ success, data?, error?, message? }` envelope, returning the
 * WHOLE payload (not just `.data`) — `PUT /config/app` and `GET /config/app`
 * both carry siblings of `data` (`ignoredKeys`, `provenance`) that
 * `core-api.ts`'s `requestJson` deliberately discards for its many
 * `data`-only callers. Mirrors `requestJson`'s exact
 * `error || message || 'Request failed with HTTP <status>'` fallback chain
 * so the two stay consistent for a reader used to that CLI convention.
 */
async function parseFullEnvelope<T>(response: Response): Promise<T> {
  let payload: RawEnvelope | null = null;
  try {
    payload = (await response.json()) as RawEnvelope;
  } catch {
    if (!response.ok) {
      throw new Error(`Request failed with HTTP ${response.status}`);
    }
    throw new Error('Expected JSON response');
  }

  if (!response.ok || !payload?.success) {
    const error = payload?.error;
    const message = payload?.message;
    throw new Error(
      (typeof error === 'string' && error) ||
        (typeof message === 'string' && message) ||
        `Request failed with HTTP ${response.status}`,
    );
  }

  return payload as unknown as T;
}

interface AppConfigEnvelope {
  data: Record<string, unknown>;
  provenance?: Record<string, SettingProvenanceEntry>;
}

async function fetchLiveAppConfig(apiBase: string): Promise<AppConfigEnvelope> {
  const response = await authenticatedFetch(`${apiBase}/config/app`);
  return parseFullEnvelope<AppConfigEnvelope>(response);
}

interface UpdateAppConfigEnvelope {
  data: Record<string, unknown>;
  ignoredKeys?: IgnoredKey[];
}

async function putLiveAppConfig(
  apiBase: string,
  updates: Record<string, unknown>,
): Promise<UpdateAppConfigEnvelope> {
  const response = await authenticatedFetch(`${apiBase}/config/app`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
  return parseFullEnvelope<UpdateAppConfigEnvelope>(response);
}

/**
 * The sentence appended to a transport failure so `config set`'s two ways
 * forward are always both named — never just "can't reach Station".
 */
const UNREACHABLE_SET_HINT =
  "station config set writes through Station's live config route by " +
  "default so a running Station's own sanitize/validate/reload path " +
  'stays authoritative and never diverges from disk (#175). Retry once ' +
  'Station is reachable, or pass --offline to write config/app.json ' +
  'directly.';

/**
 * The hint for the one failure `UNREACHABLE_SET_HINT` must not be appended to.
 *
 * When the PUT missed its deadline, Station's reachability is not in question
 * and neither way forward that hint names is safe: "retry once Station is
 * reachable" is the blind retry of a write whose outcome is unknown, and
 * `--offline` writes `config/app.json` behind a running Station — which is the
 * disk/server divergence #175's live route exists to prevent, and which
 * becomes real precisely if the PUT did land. Naming the check by verb
 * (`station config get <key>`) rather than by a generic "matching list
 * command" also matters here: `config` has no `list`.
 */
const INDETERMINATE_SET_HINT =
  'Read it back with station config get <key> before doing anything else. ' +
  'Do not pass --offline here: it writes config/app.json directly, which ' +
  'would diverge from a running Station that did apply the write (#175).';

/**
 * Describes a stored (or about-to-be-stored) value for the confirmation
 * line — distinct from the plain `value ?? '(unset)'` this used to be,
 * which is wrong for a registry-nullable key (`NULLABLE_APP_CONFIG_KEYS`):
 * `null ?? '(unset)'` prints `(unset)` even though `null` — not absence —
 * is exactly what was just persisted (review round 1 HIGH 1). `undefined`
 * (the key is genuinely absent, cleared or never set) is the only case
 * that prints `(unset)`.
 */
function describeStoredValue(value: unknown): string {
  if (value === undefined) return '(unset)';
  if (value === null) return 'null';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * Merges one sanitized `{ accepted }` update onto the loaded file config,
 * mirroring `src-server/domain/config-loader-app.ts`'s `mergeAppConfigUpdate`
 * exactly: `undefined` clears a key, and `null` clears it too UNLESS the key
 * is registry-declared nullable (`NULLABLE_APP_CONFIG_KEYS` —
 * `builtinAgentEngineConnectionId` is the one today: absent means
 * "re-derive each boot", `null` means "sticky, explicit Station", and the
 * two are not interchangeable). Review round 1 HIGH 1: the offline path
 * used to delete on `null` unconditionally, which persisted the OPPOSITE of
 * what `station config set builtinAgentEngineConnectionId null --offline`
 * asked for, while the live route (which already runs
 * `mergeAppConfigUpdate`) got it right.
 */
function mergeConfigUpdate(
  config: Record<string, unknown>,
  accepted: Record<string, unknown>,
): void {
  for (const [acceptedKey, acceptedValue] of Object.entries(accepted)) {
    if (acceptedValue === undefined) {
      delete config[acceptedKey];
    } else if (acceptedValue === null) {
      if (NULLABLE_APP_CONFIG_KEYS.has(acceptedKey as keyof AppConfig)) {
        config[acceptedKey] = null;
      } else {
        delete config[acceptedKey];
      }
    } else {
      config[acceptedKey] = acceptedValue;
    }
  }
}

/**
 * `--offline`: writes `config/app.json` directly. See the module docstring
 * for exactly what this shares with the live route and what it does not.
 */
function writeConfigOffline(key: string, rawValue: string): void {
  const config = loadConfigFile();
  const parsedValue = parseConfigValue(rawValue);
  const { accepted, ignored, violations } = sanitizeAppConfigUpdate({
    [key]: parsedValue,
  });
  if (violations.length > 0) {
    throw violationsError(violations);
  }
  printIgnoredKeysWarning(ignored);

  mergeConfigUpdate(config, accepted);
  writeConfigFileAtomically(config);

  const stored = key in accepted ? accepted[key as keyof AppConfig] : undefined;
  const definition = APP_SETTINGS_REGISTRY.find(
    (candidate) => candidate.key === key,
  );
  const structuralNote =
    definition?.descriptor.kind === 'composite'
      ? ' (offline — structural validation of this field runs at next Station boot, not now)'
      : ' (offline)';
  console.log(`  ✓ ${key} = ${describeStoredValue(stored)}${structuralNote}`);
}

export async function configSet(
  key: string,
  value: string,
  parsed: ParsedCoreArgs = NO_FLAGS,
): Promise<void> {
  if (!key || value === undefined) {
    console.error('Usage: station config set <key> <value> [--offline]');
    process.exit(1);
  }

  if (parsed.flags.offline) {
    writeConfigOffline(key, value);
    return;
  }

  const resolved = resolveApiBaseDetailed(parsed);
  configureApiCredential(parsed, resolved.apiBase);
  const parsedValue = parseConfigValue(value);

  let result: UpdateAppConfigEnvelope;
  try {
    result =
      key === 'logLevel'
        ? {
            data: {
              logLevel: (
                await updateAppLogLevel(
                  resolved.apiBase,
                  parsedValue as AppConfig['logLevel'],
                )
              ).value,
            },
          }
        : await putLiveAppConfig(resolved.apiBase, { [key]: parsedValue });
  } catch (error) {
    const transportMessage = explainRequestFailure(error, resolved);
    if (transportMessage) {
      throw new Error(
        `${transportMessage} ${
          isIndeterminateWriteFailure(error)
            ? INDETERMINATE_SET_HINT
            : UNREACHABLE_SET_HINT
        }`,
      );
    }
    // Review round 1 LOW 2: a reachable Station that 404s on this exact
    // route (no envelope, no `violations`) is most likely running a build
    // that predates PUT /config/app — reachable, but not this route, so
    // `explainRequestFailure` (transport-only) correctly says nothing.
    // `--offline` is still the honest way forward here, same as a
    // genuinely unreachable Station, so the same hint applies.
    if (error instanceof Error && /HTTP 404/.test(error.message)) {
      throw new Error(
        `${error.message} — Station at ${resolved.apiBase} may be running a ` +
          `build that predates PUT /config/app. ${UNREACHABLE_SET_HINT}`,
      );
    }
    throw error;
  }

  printIgnoredKeysWarning(result.ignoredKeys ?? []);
  const stored = result.data[key];
  console.log(`  ✓ ${key} = ${describeStoredValue(stored)}`);
}

function printConfigValue(config: Record<string, unknown>, key?: string): void {
  if (!key) {
    console.log(JSON.stringify(config, null, 2));
    return;
  }
  const value = config[key];
  if (value === undefined) {
    console.log('(not set)');
  } else {
    console.log(typeof value === 'string' ? value : JSON.stringify(value));
  }
}

function printConfigFromFile(key?: string): void {
  printConfigValue(loadConfigFile(), key);
}

/**
 * A key's provenance note names the environment as the SOURCE of a value,
 * never as an override of one (station#1557). The note this replaced said
 * "`AWS_REGION` is set and overrides this value" whenever the var existed —
 * which was false: the resolver reads the stored value first, so the note
 * told users their `config set` had not taken effect when it had.
 *
 * `source: 'file'|'default'` prints nothing extra — the unremarkable case.
 */
function describeProvenanceNote(
  key: string,
  provenance: Record<string, SettingProvenanceEntry> | undefined,
): string | undefined {
  const entry = provenance?.[key];
  if (!entry) return undefined;
  if (entry.source === 'env') {
    return entry.envVar
      ? `value comes from ${entry.envVar} (nothing stored)`
      : 'value comes from the environment (nothing stored)';
  }
  return undefined;
}

function printLiveAppConfig(
  key: string | undefined,
  envelope: AppConfigEnvelope,
): void {
  printConfigValue(envelope.data, key);
  const note = key
    ? describeProvenanceNote(key, envelope.provenance)
    : undefined;
  if (note) {
    console.error(`  (${note})`);
  }
}

export async function configGet(
  key?: string,
  parsed: ParsedCoreArgs = NO_FLAGS,
): Promise<void> {
  if (parsed.flags.offline) {
    printConfigFromFile(key);
    return;
  }

  const resolved = resolveApiBaseDetailed(parsed);
  configureApiCredential(parsed, resolved.apiBase);

  try {
    const envelope = await fetchLiveAppConfig(resolved.apiBase);
    printLiveAppConfig(key, envelope);
  } catch (error) {
    if (explainRequestFailure(error, resolved)) {
      // Unlike `config set`, a read has no divergence risk — fall back to
      // the file quietly rather than erroring; provenance just isn't
      // available offline.
      console.error(
        `(Station at ${resolved.apiBase} is not reachable — showing local config/app.json.)`,
      );
      printConfigFromFile(key);
      return;
    }
    throw error;
  }
}
