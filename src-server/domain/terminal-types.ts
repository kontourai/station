type TerminalSessionStatus = 'starting' | 'running' | 'exited';

export interface TerminalSessionState {
  sessionId: string;
  projectSlug: string;
  terminalId: string;
  cwd: string;
  status: TerminalSessionStatus;
  pid: number | null;
  history: string;
  exitCode: number | null;
  cols: number;
  rows: number;
  hasRunningSubprocess: boolean;
}

export type TerminalEvent =
  | { type: 'data'; sessionId: string; data: string }
  | { type: 'started'; sessionId: string; pid: number }
  | {
      type: 'exited';
      sessionId: string;
      exitCode: number;
      signal: number | null;
    }
  | { type: 'activity'; sessionId: string; hasRunningSubprocess: boolean };

export interface TerminalSessionSnapshot {
  sessionId: string;
  status: TerminalSessionStatus;
  pid: number | null;
  history: string;
  cols: number;
  rows: number;
}

export interface TerminalOpenInput {
  projectSlug: string;
  terminalId: string;
  cwd: string;
  cols: number;
  rows: number;
  env?: Record<string, string>;
  shell?: string;
  shellArgs?: string[];
  /**
   * Join a running session only. A session the server started (an engine's
   * sign-in) must never be replaced by a fresh shell under the same id once
   * it has ended.
   */
  attachOnly?: boolean;
}
