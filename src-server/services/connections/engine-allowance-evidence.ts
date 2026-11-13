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
 *   same provider reset that intent waits for. Codex reports a per-minute
 *   rate limit (`rateLimitExceeded`) through the same details; only its
 *   `usageLimitExceeded` is allowance exhaustion, so only that counts.
 * - ACP engines: `provider-plan-quota-exhausted`. Its reset text has no
 *   timezone and is never parsed; only a validated `retryAfterMs` is timing.
 *
 * Each refusal is scoped to the credential account its process epoch
 * recorded, and to the engine connection. A later accepted turn on the same
 * account, on any connection, supersedes it. No provider is called, nothing
 * is polled, and nothing is written.
 */

import type { EngineAllowanceEvidence } from '@kontourai/station-contracts/engine-accounts';
import { PROVIDER_PLAN_QUOTA_EXHAUSTED_CODE } from '@kontourai/station-contracts/provider-failure';
import { usageCredentialAccountKey } from '../../providers/app-home/app-home-profiles.js';
import { providerQuotaFactsFromDetails } from '../../providers/provider-plan-quota.js';
import type {
  AllowanceEpochFactRow,
  AllowanceRefusalRow,
  AllowanceRefusalSupersession,
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

/**
 * Bound on the refusal read, so a busy Station cannot make a listing slow.
 * It also bounds the supersession checks: at most one per refusal read.
 */
export const ALLOWANCE_REFUSAL_READ_LIMIT = 200;

/** The account a refusal ran on, as the supersession check matches it. */
export type AllowanceRefusalAccount =
  | { accountKey: string }
  | { connectionId: string };

export interface AllowanceEvidenceSource {
  listAllowanceRefusals(options: {
    since: string;
    limit: number;
  }): AllowanceRefusalRow[];
  /** Bounded; see `EventStore.allowanceRefusalSupersession`. */
  allowanceRefusalSupersession(refusal: {
    provider: string;
    observedAt: string;
    globalSequence: number;
    account: AllowanceRefusalAccount;
  }): AllowanceRefusalSupersession;
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
    // The adapter classifies Codex's per-minute `rateLimitExceeded` as a
    // usage limit too, for recovery's wait; it is not the allowance running
    // out, so only `usageLimitExceeded` counts here. An event that does not
    // say which is not counted.
    if (
      row.provider === 'codex' &&
      codexErrorInfo(row) !== 'usageLimitExceeded'
    )
      return undefined;
    const resetAt = validIso(row.details.resetAt);
    return { source: 'usage-limit', ...(resetAt ? { resetAt } : {}) };
  }
  return undefined;
}

/** The `codexErrorInfo` a Codex refusal recorded, as `code` or in details. */
function codexErrorInfo(row: AllowanceRefusalRow): string | undefined {
  const recorded = row.details?.codexErrorInfo;
  if (typeof recorded === 'string') return recorded;
  return row.code;
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
 * The account a supersession check matches: the recorded credential account
 * key, which names the same account on any connection of the provider. An
 * ACP adapter records no key and runs one account per connection.
 */
export function refusalAccount(
  row: AllowanceRefusalRow,
): AllowanceRefusalAccount | undefined {
  if (row.provider === 'acp')
    return row.connectionId ? { connectionId: row.connectionId } : undefined;
  return row.accountKey ? { accountKey: row.accountKey } : undefined;
}

/**
 * Fresh, unsuperseded refusals per connection, newest per account, the
 * current account first. `superseded` is asked only of the newest fresh
 * refusal per account: an older one is superseded by any turn that
 * supersedes the newer. Pure apart from what `superseded` reads.
 */
export function projectEngineAllowanceEvidence(input: {
  connections: readonly AllowanceEvidenceConnection[];
  refusals: readonly AllowanceRefusalRow[];
  superseded: (refusal: AllowanceRefusalRow) => boolean;
  now: number;
}): Map<string, EngineAllowanceEvidence[]> {
  const result = new Map<string, EngineAllowanceEvidence[]>();
  for (const connection of input.connections) {
    const byAccount = new Map<string | null, EngineAllowanceEvidence>();
    const settled = new Set<string | null>();
    for (const row of input.refusals) {
      if (!belongsTo(row, connection)) continue;
      const account = eventAccount(row, connection);
      if (account === undefined || settled.has(account)) continue;
      const refusal = classifyRefusal(row);
      if (!refusal) continue;
      const expires = expiresAt(row.observedAt, refusal.resetAt);
      if (!Number.isFinite(expires) || expires <= input.now) continue;
      settled.add(account);
      if (input.superseded(row)) continue;
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
 * Reads the recorded refusals once for every listed connection, then asks
 * the source, per candidate refusal, whether a later turn on its account
 * was accepted. Every read is of rows Station already wrote; this never
 * asks a provider.
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
  return projectEngineAllowanceEvidence({
    connections,
    refusals,
    superseded: (row) => {
      const account = refusalAccount(row);
      // `eventAccount` already refused an unnamed account; nothing to match.
      if (!account) return false;
      // A capped scan proved nothing either way; fail toward no evidence,
      // never toward a "Usage limit reached" nothing current supports.
      return (
        source.allowanceRefusalSupersession({
          provider: row.provider,
          observedAt: row.observedAt,
          globalSequence: row.globalSequence,
          account,
        }) !== 'none'
      );
    },
    now,
  });
}

/**
 * The evidence a viewer may read. Every viewer of the engine list sees that
 * the provider refused a turn, on which kind of account (`applies`), and
 * when it resets. Only a viewer who may manage access learns which account:
 * a saved account's ref names credential management state.
 */
export function allowanceEvidenceForViewer(
  evidence: readonly EngineAllowanceEvidence[],
  mayReadAccounts: boolean,
): EngineAllowanceEvidence[] {
  if (mayReadAccounts) return [...evidence];
  return evidence.map(({ account: _withheld, ...rest }) => rest);
}
