export type EngineAccountAuthState =
  | 'authenticated'
  | 'unauthenticated'
  | 'unknown';
export interface EngineAccount {
  ref: string | null;
  label: string;
  authState: EngineAccountAuthState;
  login: 'device-code' | 'browser-code' | 'unavailable';
}
export interface EngineAccounts {
  engine: 'claude' | 'codex';
  accounts: EngineAccount[];
  activeProfileRef: string | null;
}
export interface EngineAccountUsageWindow {
  id: string;
  label: string;
  usedPercent: number;
  resetsAt?: string;
  durationSeconds?: number;
  resetAfterSeconds?: number;
  meteredFeature?: string;
  allowed?: boolean;
  limitReached?: boolean;
  model?: string;
}
export interface EngineAccountProviderMoney {
  amountMinor: number;
  currency: string;
  exponent: number;
}
/** Safe projection of a live provider response; never credential material. */
export interface EngineAccountUsageMetadata {
  identity?: { email?: string; accountId?: string; userId?: string };
  credits?: {
    available?: boolean;
    unlimited?: boolean;
    balance?: number;
    overageLimitReached?: boolean;
    approximateLocalMessages?: number[];
    approximateCloudMessages?: number[];
  };
  extraUsage?: {
    enabled?: boolean;
    used?: number;
    monthlyLimit?: number;
    usedPercent?: number;
    limitReached?: boolean;
    userDisabled?: boolean;
    everEnabled?: boolean;
    currency?: string;
    decimalPlaces?: number;
    disabledReason?: string;
  };
  spending?: {
    used?: EngineAccountProviderMoney;
    limit?: EngineAccountProviderMoney;
    balance?: EngineAccountProviderMoney;
    cap?: EngineAccountProviderMoney;
    usedPercent?: number;
    severity?: string;
    enabled?: boolean;
    disabledReason?: string;
    disclaimer?: string;
    canPurchaseCredits?: boolean;
    canToggle?: boolean;
  };
  limitDetails?: Array<{
    kind?: string;
    group?: string;
    usedPercent?: number;
    severity?: string;
    resetsAt?: string;
    active?: boolean;
    model?: string;
    modelId?: string;
    surface?: string;
  }>;
  weeklyBreakdown?: {
    asOf?: string;
    windowStartedAt?: string;
    rows: Array<{ key: string; label: string; usedPercent?: number }>;
  };
  memberDashboardAvailable?: boolean;
  resetCredits?: { available?: number; applicable?: number };
  models?: Array<{
    id: string;
    available?: boolean;
    availableAt?: string;
    creditsWouldEnable?: boolean;
  }>;
  /** Shape audit only: no unrecognized response values leave the server. */
  capture: {
    source: 'claude-oauth-usage' | 'codex-wham-usage';
    credentialStorage?: 'secure-store' | 'file';
    unhandledFields: string[];
    excludedFields: string[];
    truncated: boolean;
  };
}
export interface EngineAccountUsageHistory {
  status: 'ok' | 'unavailable';
  retentionDays: number;
  observations: Array<{
    fetchedAt: string;
    status: 'ok' | 'unknown';
    windows: Array<{
      id: string;
      label: string;
      usedPercent: number;
      resetsAt?: string;
      durationSeconds?: number;
    }>;
  }>;
}
export type EngineAccountUsage =
  | {
      status: 'ok';
      fetchedAt: string;
      planLabel?: string;
      windows: EngineAccountUsageWindow[];
      exhausted: boolean;
      metadata?: EngineAccountUsageMetadata;
      history?: EngineAccountUsageHistory;
    }
  | {
      status: 'unknown';
      fetchedAt: string;
      planLabel?: string;
      reason: string;
      metadata?: EngineAccountUsageMetadata;
      history?: EngineAccountUsageHistory;
    };
export interface EngineAccountLogin {
  engine: 'claude' | 'codex';
  mechanism: 'browser-code' | 'device-code';
  phase:
    | 'starting'
    | 'awaiting-approval'
    | 'awaiting-code'
    | 'verifying'
    | 'completed'
    | 'failed'
    | 'cancelled';
  startedAt: string;
  expiresAt: string;
  verificationUri?: string;
  userCode?: string;
  reason?: string;
}

/**
 * A provider-reported quota refusal from a real turn, recorded on the
 * engine connection view (docs/design/connections-overhaul.md, Readiness).
 * Station never derives it from allowance percentages: only the provider's
 * own refusal of a turn counts, and only for the account that served it.
 *
 * - `usage-limit`: Claude Code or Codex stopped a turn on the account's
 *   usage limit (`UsageLimitFailureDetails`).
 * - `plan-quota`: an ACP engine's provider refused a turn on its plan quota
 *   (`provider-plan-quota-exhausted`).
 */
export interface EngineAllowanceEvidence {
  source: 'usage-limit' | 'plan-quota';
  /** The credential account the refused turn ran on. */
  account: { kind: 'default' } | { kind: 'profile'; ref: string };
  /**
   * Whether that account is the one this engine uses now:
   * `other-account` when an agent pin or credential recovery ran the turn on
   * another account, `proxy-route` when the engine now routes through a saved
   * proxy, which does not spend the account.
   */
  applies: 'current-account' | 'other-account' | 'proxy-route';
  /** When Station recorded the refusal. */
  observedAt: string;
  /** The provider's reset time (ISO 8601), when it reported a qualified one. */
  resetAt?: string;
  /**
   * `plan-quota` only: the provider's reset text, which has no timezone.
   * Display only; never parsed.
   */
  resetReported?: string;
  /**
   * When this evidence stops counting: the reset when known, otherwise a
   * bounded window after `observedAt`. After it, the evidence is absent.
   */
  expiresAt: string;
}

/**
 * The refusal that describes the engine's current account at `now`, if any.
 * A cached read can outlive the reset, so readers re-check `expiresAt`.
 */
export function currentAccountAllowanceRefusal(
  evidence: readonly EngineAllowanceEvidence[] | undefined,
  now: number = Date.now(),
): EngineAllowanceEvidence | undefined {
  return evidence?.find(
    (item) =>
      item.applies === 'current-account' && Date.parse(item.expiresAt) > now,
  );
}
