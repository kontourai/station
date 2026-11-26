import type {
  ConnectionQuotaResult,
  ConnectionQuotaWindow,
} from '@kontourai/station-contracts/connection-quota';
import type {
  ModelOption,
  ModelOptionCapabilities,
} from '@kontourai/station-contracts/tool';
import { redactSecrets } from '@kontourai/station-shared/redaction';
import { errorMessage } from '../../utils/error-message.js';
import { isRecord } from '../../utils/is-record.js';
import type { ProviderAdapterModelCatalog } from '../adapter-shape.js';
import { isMuseReasoningEffort } from './muse-adapter-types.js';
import {
  MuseServeConnection,
  type MuseServeSpawnResult,
  MuseServeTimeoutError,
} from './muse-serve-rpc.js';
import {
  type MuseServeSchemaCheck,
  museServeKnownSchemaVerdict,
} from './muse-serve-schema.js';

/**
 * #2266: catalog and allowance reads through a short-lived `muse serve`
 * host: `initialize` (the schema is judged exactly as a session judges it) → `initialized` → one query → close. `model/list` and
 * `usage/read` are queries, not commands: no `commandId`, no session, nothing
 * durable is written (live against Muse Code 1.4.18: both answer with no
 * `session/start`).
 *
 * The host is always closed and terminated before the read settles, abort
 * included, so a caller that awaits settlement (`abortSettlement: 'await'`)
 * never leaves a host behind.
 */

export interface MuseDiscoveryDeps {
  /** Spawns one sandboxed `muse serve` host (the posture never matters here). */
  spawnHost: () => MuseServeSpawnResult;
  terminateHost: (spawned: MuseServeSpawnResult) => Promise<void>;
  /** Bound on the whole read, handshake included. */
  timeoutMs: number;
  /** Judges the host's schema as a session would; absent: verified only. */
  checkSchema?: MuseServeSchemaCheck;
}

/** A host that answered but whose schema this adapter does not accept. */
class MuseDiscoveryUnverifiedError extends Error {
  constructor(readonly reason: string) {
    super(`The muse serve host reported an unverified MSP schema (${reason}).`);
    this.name = 'MuseDiscoveryUnverifiedError';
  }
}

export async function withMuseDiscoveryHost(
  deps: MuseDiscoveryDeps,
  method: string,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  signal?.throwIfAborted();
  const spawned = deps.spawnHost();
  const connection = new MuseServeConnection(spawned.process, {
    onNotification: () => {},
    onClose: () => {},
  });
  const abort = () => connection.close();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const deadline = Date.now() + deps.timeoutMs;
    const remaining = () => Math.max(1, deadline - Date.now());
    const initialized = await connection.request(
      'initialize',
      {
        clientInfo: { name: 'station', title: 'Station', version: '1' },
        capabilities: { experimentalApi: false },
      },
      { timeoutMs: remaining() },
    );
    const verdict = deps.checkSchema
      ? await deps.checkSchema(initialized)
      : museServeKnownSchemaVerdict(initialized);
    if (verdict.kind === 'refused') {
      throw new MuseDiscoveryUnverifiedError(verdict.reason);
    }
    connection.notify('initialized');
    const result = await connection.request(method, params, {
      timeoutMs: remaining(),
    });
    signal?.throwIfAborted();
    return result;
  } catch (error) {
    // The caller's abort, not the closed connection it caused.
    signal?.throwIfAborted();
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
    connection.close();
    try {
      await deps.terminateHost(spawned);
    } finally {
      spawned.release?.();
    }
  }
}

/** A model id this catalog will hand to `--model` / `session/setModel`. */
const MUSE_CATALOG_MODEL_ID = /^[A-Za-z0-9._:/@-]{1,200}$/;
const MUSE_CATALOG_LABEL_MAX_CHARS = 128;
const MUSE_EFFORT_LABEL_MAX_CHARS = 128;

function boundedLabel(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : undefined;
}

/**
 * One `ModelCatalogEntry` → a Station `ModelOption`. Muse names a model by
 * the id it is selected with, so `originalId` is that id. What Station has
 * a field for is carried; what it has none for (the per-1M-token `cost`
 * strings, `defaultReasoningEffort`, `isDefault`, `outputLimit`) is left
 * out rather than squeezed into another field. An entry whose `variants`
 * is `"unknown"` claims no effort control at all.
 */
function museCatalogModelOption(entry: unknown): ModelOption | null {
  if (!isRecord(entry)) return null;
  const id = typeof entry.modelId === 'string' ? entry.modelId : '';
  if (!MUSE_CATALOG_MODEL_ID.test(id)) return null;
  const name =
    boundedLabel(entry.displayLabel, MUSE_CATALOG_LABEL_MAX_CHARS) ?? id;
  const capabilities: ModelOptionCapabilities = {};
  const tiers = Array.isArray(entry.variants)
    ? entry.variants.filter(isMuseReasoningEffort)
    : Array.isArray(entry.reasoningEffortVariants)
      ? entry.reasoningEffortVariants
          .map((variant) => (isRecord(variant) ? variant.tier : undefined))
          .filter(isMuseReasoningEffort)
      : [];
  if (tiers.length > 0) {
    capabilities.supportsEffort = true;
    capabilities.supportedEffortLevels = [...new Set(tiers)];
    const labels: Record<string, string> = {};
    if (Array.isArray(entry.reasoningEffortVariants)) {
      for (const variant of entry.reasoningEffortVariants) {
        if (!isRecord(variant) || !isMuseReasoningEffort(variant.tier))
          continue;
        const label = boundedLabel(
          variant.description,
          MUSE_EFFORT_LABEL_MAX_CHARS,
        );
        if (label) labels[variant.tier] = label;
      }
    }
    if (Object.keys(labels).length > 0) capabilities.effortLabels = labels;
  }
  if (
    typeof entry.contextLimit === 'number' &&
    Number.isSafeInteger(entry.contextLimit) &&
    entry.contextLimit > 0
  ) {
    capabilities.contextWindow = entry.contextLimit;
  }
  return {
    id,
    name,
    originalId: id,
    ...(Object.keys(capabilities).length > 0 ? { capabilities } : {}),
  };
}

/**
 * A `model/list` result → the adapter catalog, bounded by `maxEntries`. An
 * empty `models` is a real answer (MSP: "`models` MAY be empty"), returned as
 * an empty live catalog: muse was asked and listed nothing. It says nothing
 * about whether a model can be selected; that is `modelLaunch`'s claim.
 */
export function museModelCatalog(
  result: unknown,
  maxEntries: number,
): ProviderAdapterModelCatalog {
  if (!isRecord(result) || !Array.isArray(result.models)) {
    throw new Error('Muse answered model/list without a models list.');
  }
  const models: ModelOption[] = [];
  let truncated = false;
  for (const entry of result.models) {
    const option = museCatalogModelOption(entry);
    if (!option || models.some((model) => model.id === option.id)) continue;
    if (models.length >= maxEntries) {
      truncated = true;
      break;
    }
    models.push(option);
  }
  return { models, ...(truncated ? { truncated: true } : {}) };
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function epochMsIso(value: unknown): string | undefined {
  const ms = finiteNonNegative(value);
  if (ms === undefined) return undefined;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * A `usage/read` result → a quota snapshot. MSP omits `usage` when the host
 * has observed nothing ("truthful absence"), which is `not-reported`, never a
 * window at 0%. Muse names the reset as epoch milliseconds, so it is
 * normalized to `resetDeadlineAt`. The weekly block has no duration on the
 * wire and gets none here.
 */
export function museQuotaResult(
  result: unknown,
  connectionId: string,
  /** `profile` when the read ran under a credential profile's config. */
  accountScope: 'profile' | 'global' = 'global',
): ConnectionQuotaResult {
  const usage = isRecord(result) ? result.usage : undefined;
  if (usage === undefined) {
    return {
      kind: 'unavailable',
      reason: 'not-reported',
      detail: 'Muse has observed no subscription usage yet.',
    };
  }
  const observedAt = isRecord(usage) ? epochMsIso(usage.observedAtMs) : null;
  if (!isRecord(usage) || !observedAt) {
    return {
      kind: 'unavailable',
      reason: 'provider-error',
      detail: 'Muse reported subscription usage Station could not read.',
    };
  }
  const windows: ConnectionQuotaWindow[] = [];
  const block = (
    id: string,
    label: string,
    value: unknown,
    withDuration: boolean,
  ) => {
    if (!isRecord(value)) return;
    const usedPercent = finiteNonNegative(value.usedPercent);
    if (usedPercent === undefined) return;
    const duration = withDuration
      ? finiteNonNegative(value.windowDurationMins)
      : undefined;
    const resetDeadlineAt = epochMsIso(value.resetsAtMs);
    windows.push({
      id,
      label,
      usedPercent,
      observedAt,
      ...(duration !== undefined && duration > 0
        ? { windowDurationMins: duration }
        : {}),
      ...(resetDeadlineAt ? { resetDeadlineAt } : {}),
    });
  };
  block('window', 'Current window', usage.window, true);
  block('weekly', 'Weekly', usage.weekly, false);
  const tier =
    typeof usage.tier === 'string' && usage.tier.trim()
      ? usage.tier.trim().slice(0, 128)
      : undefined;
  if (windows.length === 0 && !tier) {
    return {
      kind: 'unavailable',
      reason: 'provider-error',
      detail: 'Muse reported subscription usage Station could not read.',
    };
  }
  return {
    kind: 'snapshot',
    snapshot: {
      connectionId,
      provider: 'muse',
      observedAt,
      baselineAt: observedAt,
      source: 'provider-reported',
      accountScope,
      ...(tier ? { plan: { value: { type: tier }, observedAt } } : {}),
      windows,
    },
  };
}

/** Classifies a failed discovery read for a quota result. */
export function museQuotaFailure(error: unknown): ConnectionQuotaResult {
  return {
    kind: 'unavailable',
    reason:
      error instanceof MuseServeTimeoutError ? 'timeout' : 'provider-error',
    detail: redactSecrets(errorMessage(error)).slice(0, 200),
  };
}
