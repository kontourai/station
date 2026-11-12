/**
 * Connections slice 6: allowance evidence for engine connections, projected
 * at read time from refusals Station already recorded
 * (docs/design/connections-overhaul.md, "Readiness").
 *
 * Only a provider's own refusal of a real turn counts, never a percentage:
 *
 * - Claude Code and Codex: a `runtime.error` whose details are the adapter's
 *   `UsageLimitFailureDetails` (`usageLimit: true`, `scope: 'account'`). The
 *   same details arm the usage-limit recovery intent, and `resetAt` is the
 *   same provider reset that intent waits for.
 * - ACP engines: `provider-plan-quota-exhausted`. Its reset text has no
 *   timezone and is never parsed; only a validated `retryAfterMs` is timing.
 *
 * Each refusal is scoped to the credential account its process epoch
 * recorded, and to the engine connection. No provider is called, nothing is
 * polled, and nothing is written.
 */

import type { EngineAllowanceEvidence } from '@kontourai/station-contracts/engine-accounts';
import { PROVIDER_PLAN_QUOTA_EXHAUSTED_CODE } from '@kontourai/station-contracts/provider-failure';
import { usageCredentialAccountKey } from '../../providers/app-home/app-home-profiles.js';
import { providerQuotaFactsFromDetails } from '../../providers/provider-plan-quota.js';
import type {
  AllowanceEpochFactRow,
  AllowanceRefusalRow,
} from '../orchestration/event-store.js';

/**
 * How far back refusals are read, and the longest a refusal with a known
 * reset is held: the longest window the supported engines report (Claude
 * Code's and Codex's weekly windows).
 */
export const ALLOWANCE_EVIDENCE_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1_000;

/**
 * How long a refusal without a qualified reset is held: the shortest
 * allowance window the supported engines report (Claude Code's and Codex's
 * five-hour windows; the observed ACP plan quota is a five-hour window). The
 * provider may have lifted the limit by then, so holding it longer would
 * claim a state nothing observed.
 */
export const ALLOWANCE_EVIDENCE_UNKNOWN_RESET_MS = 5 * 60 * 60 * 1_000;

/** Bounds on the two reads, so a busy Station cannot make a listing slow. */
export const ALLOWANCE_REFUSAL_READ_LIMIT = 200;
export const ALLOWANCE_ACCEPTED_TURN_READ_LIMIT = 1_000;

export interface AllowanceEvidenceSource {
  listAllowanceRefusals(options: {
    since: string;
    limit: number;
  }): AllowanceRefusalRow[];
  listAllowanceAcceptedTurns(options: {
    since: string;
    providers: readonly string[];
    limit: number;
  }): AllowanceEpochFactRow[];
}

/** What the projection needs to know about one engine connection. */
export interface AllowanceEvidenceConnection {
  id: string;
  /** The adapter provider kind its events carry (`claude`, `codex`, `acp`). */
  provider: string;
  /** Saved credential-profile refs, so an account key can be named. */
  profileRefs: readonly string[];
  /** The account new work uses; absent is the default account. */
  activeProfileRef?: string;
  /** The engine now routes through a saved proxy. */
  proxyRouted: boolean;
}

interface ClassifiedRefusal {
  source: EngineAllowanceEvidence['source'];
  resetAt?: string;
  resetReported?: string;
}

function validIso(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

/** The refusal's source and reset, or undefined when it is not one we read. */
function classifyRefusal(
  row: AllowanceRefusalRow,
): ClassifiedRefusal | undefined {
  if (row.code === PROVIDER_PLAN_QUOTA_EXHAUSTED_CODE) {
    const facts = providerQuotaFactsFromDetails(row.details);
    const observed = Date.parse(row.observedAt);
    const resetAt =
      facts?.retryAfterMs !== undefined && Number.isFinite(observed)
        ? new Date(observed + facts.retryAfterMs).toISOString()
        : undefined;
    return {
      source: 'plan-quota',
      ...(resetAt ? { resetAt } : {}),
      ...(facts ? { resetReported: facts.resetReported } : {}),
    };
  }
  // A model connection's 429 (Station's own engine) or an unscoped engine
  // error is not an account's allowance verdict.
  if (row.details?.usageLimit === true && row.details.scope === 'account') {
    const resetAt = validIso(row.details.resetAt);
    return { source: 'usage-limit', ...(resetAt ? { resetAt } : {}) };
  }
  return undefined;
}

function expiresAt(observedAt: string, resetAt: string | undefined): number {
  const observed = Date.parse(observedAt);
  if (resetAt === undefined)
    return observed + ALLOWANCE_EVIDENCE_UNKNOWN_RESET_MS;
  return Math.min(
    Date.parse(resetAt),
    observed + ALLOWANCE_EVIDENCE_LOOKBACK_MS,
  );
}

/** The connection a recorded event belongs to. */
function eventConnectionId(row: AllowanceEpochFactRow): string | undefined {
  if (row.connectionId) return row.connectionId;
  // Claude Code and Codex record `connectionId` only when dispatch passes
  // it; their built-in connection's id is the provider kind (the same
  // fallback their usage pages use). ACP always records it.
  return row.provider === 'acp' ? undefined : row.provider;
}

/**
 * The account key the adapter recorded, as the comparable account: `null`
 * for the default account, a ref for a saved profile, undefined when it
 * cannot be named (a lookup that fell back to global config, or a profile
 * since removed).
 */
function eventAccount(
  row: AllowanceEpochFactRow,
  connection: AllowanceEvidenceConnection,
): string | null | undefined {
  // ACP adapters run one account per connection and record no key.
  if (row.provider === 'acp')
    return row.accountKey === undefined ? null : undefined;
  if (row.accountKey === undefined) return undefined;
  if (row.accountKey === usageCredentialAccountKey(row.provider, null))
    return null;
  return connection.profileRefs.find(
    (ref) => usageCredentialAccountKey(row.provider, ref) === row.accountKey,
  );
}

function belongsTo(
  row: AllowanceEpochFactRow,
  connection: AllowanceEvidenceConnection,
): boolean {
  return (
    row.provider === connection.provider &&
    eventConnectionId(row) === connection.id &&
    // A proxy-routed run does not spend the account, so neither its refusal
    // nor its success says anything about the account's allowance.
    !row.proxyRouted
  );
}

/**
 * Fresh, unsuperseded refusals per connection, newest per account, the
 * current account first. Pure: `now` and the recorded rows are its inputs.
 */
export function projectEngineAllowanceEvidence(input: {
  connections: readonly AllowanceEvidenceConnection[];
  refusals: readonly AllowanceRefusalRow[];
  acceptedTurns: readonly AllowanceEpochFactRow[];
  now: number;
}): Map<string, EngineAllowanceEvidence[]> {
  const result = new Map<string, EngineAllowanceEvidence[]>();
  for (const connection of input.connections) {
    const accepted = input.acceptedTurns.filter((row) =>
      belongsTo(row, connection),
    );
    const byAccount = new Map<string | null, EngineAllowanceEvidence>();
    for (const row of input.refusals) {
      if (!belongsTo(row, connection)) continue;
      const account = eventAccount(row, connection);
      if (account === undefined || byAccount.has(account)) continue;
      const refusal = classifyRefusal(row);
      if (!refusal) continue;
      const expires = expiresAt(row.observedAt, refusal.resetAt);
      if (!Number.isFinite(expires) || expires <= input.now) continue;
      const superseded = accepted.some(
        (turn) =>
          turn.globalSequence > row.globalSequence &&
          eventAccount(turn, connection) === account,
      );
      if (superseded) continue;
      const current = (connection.activeProfileRef ?? null) === account;
      byAccount.set(account, {
        source: refusal.source,
        account:
          account === null
            ? { kind: 'default' }
            : { kind: 'profile', ref: account },
        applies: connection.proxyRouted
          ? 'proxy-route'
          : current
            ? 'current-account'
            : 'other-account',
        observedAt: row.observedAt,
        ...(refusal.resetAt ? { resetAt: refusal.resetAt } : {}),
        ...(refusal.resetReported
          ? { resetReported: refusal.resetReported }
          : {}),
        expiresAt: new Date(expires).toISOString(),
      });
    }
    if (byAccount.size === 0) continue;
    result.set(
      connection.id,
      [...byAccount.values()].sort(
        (left, right) =>
          Number(right.applies === 'current-account') -
            Number(left.applies === 'current-account') ||
          Date.parse(right.observedAt) - Date.parse(left.observedAt),
      ),
    );
  }
  return result;
}

/**
 * Reads the recorded refusals and accepted turns once for every listed
 * connection. Refusals are rows Station already wrote; this never asks a
 * provider. Accepted turns are read only when a refusal could be superseded.
 */
export function readEngineAllowanceEvidence(
  source: AllowanceEvidenceSource,
  connections: readonly AllowanceEvidenceConnection[],
  now: number,
): Map<string, EngineAllowanceEvidence[]> {
  if (connections.length === 0) return new Map();
  const refusals = source.listAllowanceRefusals({
    since: new Date(now - ALLOWANCE_EVIDENCE_LOOKBACK_MS).toISOString(),
    limit: ALLOWANCE_REFUSAL_READ_LIMIT,
  });
  if (refusals.length === 0) return new Map();
  // The source returns refusals newest first.
  const oldest = refusals[refusals.length - 1]!.observedAt;
  const providers = [...new Set(refusals.map((row) => row.provider))];
  const acceptedTurns = source.listAllowanceAcceptedTurns({
    since: oldest,
    providers,
    limit: ALLOWANCE_ACCEPTED_TURN_READ_LIMIT,
  });
  return projectEngineAllowanceEvidence({
    connections,
    refusals,
    acceptedTurns,
    now,
  });
}
