import {
  type AgentConnectionView,
  type ConnectionCheckEvidence,
  type ConnectionConfig,
  type ConnectionEvidenceLevel,
  type ConnectionReadinessEvidence,
  type ConnectionSmokeEvidence,
  connectionCheckGatesReadiness,
  connectionCheckOutranksSmoke,
} from '@kontourai/station-contracts/tool';
import { hasRequiredMissing } from './connection-service-helpers.js';
import type { StoredConnectionSmokeResult } from './connection-smoke-evidence-store.js';

const CATALOG_FRESH_MS = 5 * 60 * 1000;

function isAgentConnection(
  connection: ConnectionConfig,
): connection is AgentConnectionView {
  return connection.kind === 'agent';
}

function baseLevel(connection: ConnectionConfig): ConnectionEvidenceLevel {
  if (!connection.enabled || hasRequiredMissing(connection.prerequisites)) {
    return 'discovered';
  }
  if (isAgentConnection(connection)) {
    if (
      connection.runtimeCatalog?.source === 'live' ||
      connection.capabilityInventory?.freshness === 'live'
    ) {
      return 'catalog-ready';
    }
  } else if (
    Array.isArray(connection.config.modelOptions) &&
    connection.config.modelOptions.length > 0
  ) {
    return 'catalog-ready';
  }
  return 'prerequisite-ready';
}

function baseCopy(
  level: ConnectionEvidenceLevel,
): Pick<ConnectionReadinessEvidence, 'summary' | 'action'> {
  switch (level) {
    case 'smoke-passed':
      return { summary: 'A bounded chat smoke completed successfully.' };
    case 'catalog-ready':
      return {
        summary: 'A live model or capability catalog is available.',
        action: 'Run an explicit smoke to prove a complete chat turn.',
      };
    case 'prerequisite-ready':
      return {
        summary: 'Required prerequisites are currently satisfied.',
        action: 'Run an explicit smoke to prove this client can complete chat.',
      };
    case 'discovered':
      return {
        summary:
          'Station discovered this client, but has not proved chat readiness.',
        action: 'Complete its required setup, then run an explicit smoke.',
      };
  }
}

function smokeEvidence(
  result: StoredConnectionSmokeResult | null,
  now: Date,
): ConnectionSmokeEvidence {
  if (!result) {
    return {
      status: 'not-tested',
      freshness: 'unknown',
      action: 'Run the explicit one-turn dogfood smoke when you are ready.',
      turnLimit: 1,
    };
  }
  return {
    status: result.status,
    freshness:
      Date.parse(result.freshUntil) > now.getTime() ? 'fresh' : 'stale',
    testedAt: result.testedAt,
    freshUntil: result.freshUntil,
    provider: result.provider,
    ...(result.model ? { model: result.model } : {}),
    durationMs: result.durationMs,
    ...(result.reasonCode ? { reasonCode: result.reasonCode } : {}),
    ...(result.reason ? { reason: result.reason } : {}),
    ...(result.action ? { action: result.action } : {}),
    turnLimit: 1,
  };
}

/**
 * RT-06: a model connection's `status` is `statusFromPrerequisites`, and its
 * only required prerequisite is "a non-empty string is saved in the key box".
 * A knowingly invalid key therefore read `ready` — and the explicit Test
 * Connection that refuted it was discarded by every consumer. A recorded
 * check is the observation that outranks the prerequisite guess: a failed one
 * cannot leave the connection at a level that reads as usable, and a passed
 * one is a live provider response, which is exactly what `catalog-ready`
 * means.
 */
function checkAdjustedLevel(
  level: ConnectionEvidenceLevel,
  check: ConnectionCheckEvidence,
): ConnectionEvidenceLevel {
  if (connectionCheckGatesReadiness(check)) return 'discovered';
  if (check.status === 'passed' && level === 'prerequisite-ready') {
    return 'catalog-ready';
  }
  // Delta review H1: reachable, no usable catalogue. Configured selectors can
  // still push `baseLevel` to `catalog-ready` — those are the operator's own
  // text, not a provider response, so the level must come back down. It is
  // not `discovered` either: the endpoint answered.
  //
  // Delta2 review M1: an unreachable observation still inside its grace
  // window sits here too. Nothing is proven right now, so it cannot hold a
  // catalogue-backed level, but it is not a refusal and does not read as one.
  if (
    (check.status === 'catalog-unavailable' ||
      check.status === 'unreachable') &&
    level === 'catalog-ready'
  ) {
    return 'prerequisite-ready';
  }
  return level;
}

export function deriveConnectionReadinessEvidence(
  connection: ConnectionConfig,
  result: StoredConnectionSmokeResult | null,
  now = new Date(),
  check: ConnectionCheckEvidence | null = null,
): ConnectionReadinessEvidence {
  const smoke = smokeEvidence(result, now);
  const base = baseLevel(connection);
  // Delta2 review H3: a fresh passed smoke outranks a check receipt — it is a
  // complete chat turn, the strongest evidence there is — but only a receipt
  // OLDER than it. A smoke stays fresh for 24 hours, so unconditional
  // precedence let a 09:00 smoke keep rendering Ready through a genuine 401
  // observed at 10:00 while system status was already gating the connection.
  const checkOutranksSmoke = connectionCheckOutranksSmoke(check, smoke);
  const smokePasses = smoke.status === 'passed' && smoke.freshness === 'fresh';
  const level =
    smokePasses && !checkOutranksSmoke
      ? 'smoke-passed'
      : check
        ? checkAdjustedLevel(base, check)
        : base;
  // The receipt only speaks for the connection when the level came from it.
  // A smoke that outranks an older refusal must not be captioned with that
  // refusal's text, or the card would read "Ready" over "the provider refused
  // these settings".
  const spokenCheck = level === 'smoke-passed' ? null : check;
  const copy =
    smoke.status === 'failed' && smoke.freshness === 'fresh'
      ? {
          summary: smoke.reason ?? 'The latest bounded chat smoke failed.',
          action:
            smoke.action ??
            'Open this connection, resolve the reported failure, and smoke it again.',
        }
      : spokenCheck?.status === 'failed'
        ? {
            summary:
              spokenCheck.reason ??
              'The last connection test was refused by the provider.',
            action: 'Correct this connection’s settings, then test it again.',
          }
        : spokenCheck?.status === 'unreachable'
          ? {
              summary:
                spokenCheck.reason ?? 'Station could not reach this provider.',
              action: spokenCheck.retrying
                ? 'Station is still retrying. Test the connection if it does not recover.'
                : 'Check the endpoint address and that the provider is running, then test it again.',
            }
          : spokenCheck?.status === 'catalog-unavailable'
            ? {
                summary:
                  spokenCheck.reason ??
                  'The provider answered but offers no model catalog.',
                action:
                  'Run Test Connection, or start a chat, to prove this connection can run work.',
              }
            : baseCopy(level);
  const catalogFetchedAt = isAgentConnection(connection)
    ? connection.runtimeCatalog?.fetchedAt
    : null;
  const catalogFreshUntil = catalogFetchedAt
    ? new Date(Date.parse(catalogFetchedAt) + CATALOG_FRESH_MS).toISOString()
    : undefined;
  return {
    evidenceVersion: 1,
    level,
    observedAt: now.toISOString(),
    freshness:
      level === 'smoke-passed'
        ? smoke.freshness
        : level === 'catalog-ready' && catalogFreshUntil
          ? Date.parse(catalogFreshUntil) > now.getTime()
            ? 'fresh'
            : 'stale'
          : 'fresh',
    ...copy,
    smoke,
    ...(check ? { check } : {}),
  };
}
