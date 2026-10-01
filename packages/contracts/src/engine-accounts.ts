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
  };
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
    unhandledFields: string[];
    excludedFields: string[];
    truncated: boolean;
  };
}
export type EngineAccountUsage =
  | {
      status: 'ok';
      fetchedAt: string;
      planLabel?: string;
      windows: EngineAccountUsageWindow[];
      exhausted: boolean;
      metadata?: EngineAccountUsageMetadata;
    }
  | {
      status: 'unknown';
      fetchedAt: string;
      planLabel?: string;
      reason: string;
      metadata?: EngineAccountUsageMetadata;
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
