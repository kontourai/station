import type { SystemBuildProvenance } from './system-route-types.js';

const FULL_GIT_SHA = /^[0-9a-f]{40,64}$/i;
const UNKNOWN_PROVENANCE_SENTINEL = 'unknown';

/**
 * Immutable build identity captured during process bootstrap. `ageSeconds` is
 * deliberately excluded: it is elapsed time, not process identity.
 */
export type BuildProvenanceSnapshot = Readonly<
  Omit<SystemBuildProvenance, 'ageSeconds'>
>;

function presentValue(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value || value === UNKNOWN_PROVENANCE_SENTINEL) return undefined;
  return value;
}

/**
 * The server's esbuild-baked identity fallback (archive#1985), read off the
 * banner global `esbuild.config.mjs` sets on every bundled server entry.
 */
function readBakedServerBuildIdentity():
  | { sha?: string; builtAt?: string; channel?: string; dirty?: boolean }
  | undefined {
  const baked = (globalThis as { __STATION_SERVER_BUILD__?: unknown })
    .__STATION_SERVER_BUILD__;
  if (typeof baked !== 'object' || baked === null) return undefined;
  return baked as {
    sha?: string;
    builtAt?: string;
    channel?: string;
    dirty?: boolean;
  };
}

/**
 * Reads whatever build provenance the process was given, field by field.
 *
 * Deliberately partial (archive#1085): a missing or invalid field never hides
 * another usable field. The baked bundle stamp wins over supervisor metadata:
 * a supervisor may be running from a newer checkout while still serving older
 * dist-server bytes. An env-only SHA is therefore labelled checkout-derived.
 */
function validGitSha(value: string | undefined): string | undefined {
  return value && FULL_GIT_SHA.test(value) ? value : undefined;
}

function validDateInput(value: string | undefined): string | undefined {
  return value !== undefined && Number.isFinite(Date.parse(value))
    ? value
    : undefined;
}

export function readBuildProvenance(
  env: NodeJS.ProcessEnv = process.env,
  nowMs = Date.now(),
  baked = readBakedServerBuildIdentity(),
): SystemBuildProvenance | undefined {
  const provenance: SystemBuildProvenance = {};

  // Validate each candidate BEFORE choosing: a malformed baked value must
  // not suppress a valid checkout fallback (field-level doctrine — an
  // invalid value never hides another usable one).
  const bakedSha = validGitSha(presentValue(baked?.sha));
  const checkoutSha = validGitSha(presentValue(env.STATION_BUILD_SHA));
  const shaInput = bakedSha ?? checkoutSha;
  if (shaInput) {
    provenance.fullSha = shaInput;
    provenance.shortSha = shaInput.slice(0, 7);
    provenance.shaSource = shaInput === bakedSha ? 'build-stamp' : 'checkout';
  }

  const branch = presentValue(env.STATION_BUILD_BRANCH);
  if (branch) provenance.branch = branch;

  const builtAtInput =
    validDateInput(presentValue(baked?.builtAt)) ??
    validDateInput(presentValue(env.STATION_BUILD_BUILT_AT));
  const builtAtMs =
    builtAtInput === undefined ? Number.NaN : Date.parse(builtAtInput);
  if (Number.isFinite(builtAtMs)) {
    provenance.builtAt = new Date(builtAtMs).toISOString();
    provenance.ageSeconds = Math.max(
      0,
      Math.floor((nowMs - builtAtMs) / 1_000),
    );
  }

  const instanceId = presentValue(env.STATION_INSTANCE_ID);
  if (instanceId) provenance.instanceId = instanceId;

  const bootId = presentValue(env.STATION_BOOT_ID);
  if (bootId) provenance.bootId = bootId;

  const channel =
    presentValue(baked?.channel) ??
    presentValue(env.STATION_CHANNEL) ??
    (provenance.shaSource === 'checkout' ? 'source-checkout' : undefined);
  if (channel) provenance.channel = channel;

  if (typeof baked?.dirty === 'boolean') provenance.dirty = baked.dirty;

  return Object.keys(provenance).length > 0 ? provenance : undefined;
}

/** Capture the process build identity once, before mutable runtime state can
 * diverge. The returned object is frozen so consumers cannot rewrite it. */
export function captureBuildProvenance(
  env: NodeJS.ProcessEnv = process.env,
  nowMs = Date.now(),
  baked = readBakedServerBuildIdentity(),
): BuildProvenanceSnapshot | undefined {
  const provenance = readBuildProvenance(env, nowMs, baked);
  if (!provenance) return undefined;
  const { ageSeconds: _ageSeconds, ...identity } = provenance;
  return Object.freeze(identity);
}

/** Reads a bootstrap snapshot while deriving elapsed age at read time. */
export function readBuildProvenanceSnapshot(
  snapshot: BuildProvenanceSnapshot | undefined,
  nowMs = Date.now(),
): SystemBuildProvenance | undefined {
  if (!snapshot) return undefined;
  const build: SystemBuildProvenance = { ...snapshot };
  if (build.builtAt) {
    const builtAtMs = Date.parse(build.builtAt);
    if (Number.isFinite(builtAtMs)) {
      build.ageSeconds = Math.max(0, Math.floor((nowMs - builtAtMs) / 1_000));
    }
  }
  return build;
}
