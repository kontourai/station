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
}
export type EngineAccountUsage =
  | {
      status: 'ok';
      fetchedAt: string;
      planLabel?: string;
      windows: EngineAccountUsageWindow[];
      exhausted: boolean;
    }
  | { status: 'unknown'; fetchedAt: string; reason: string };
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
