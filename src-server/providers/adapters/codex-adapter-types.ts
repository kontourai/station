import type { ProviderSession } from '../adapter-shape.js';

export interface CodexProcessLike {
  readonly pid?: number;
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: 'exit', listener: (code: number | null) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  once(event: 'exit', listener: (code: number | null) => void): this;
  removeListener(event: 'exit', listener: (code: number | null) => void): this;
}

export interface PendingRpcRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  /**
   * station#3473 fix round: recorded so a forced teardown (`stopSession`, the
   * process `exit` handler) can tell whether a `turn/interrupt` request was
   * in flight for the turn it is about to force-reject, WITHOUT racing
   * `interruptTurn`'s own bookkeeping — inspecting what is synchronously
   * still pending in the map is the one signal available at the exact
   * moment of rejection.
   */
  method: string;
  /**
   * station#3451 fix round D2: the turn a `turn/interrupt` request targets.
   * Without this, `rejectPendingRpcRequests`'s in-flight signal carried no
   * turn identity — `pendingRpcRequests` has no timeout eviction (entries
   * leave only via a matching response or a force-reject), so an
   * `interruptTurn` call the caller abandoned (the accept-then-abort race
   * cleanup gives up after ~5s but never cancels the RPC) could still be
   * pending when a LATER, unrelated turn's process death forces a
   * rejection — skipping that later turn's synthesis for an interrupt that
   * targeted a different one. Only set for `turn/interrupt`; every other
   * RPC method leaves it `undefined`.
   */
  turnId?: string;
}

export interface PendingApprovalRequest {
  rpcRequestId: string;
  method: string;
  title: string;
  threadId: string;
  payload: Record<string, unknown>;
}

export interface CodexSessionRecord {
  externalThreadId: string;
  codexThreadId: string;
  process: CodexProcessLike;
  session: ProviderSession;
  rpcRequestCounter: number;
  pendingRpcRequests: Map<string, PendingRpcRequest>;
  pendingApprovals: Map<string, PendingApprovalRequest>;
  activeTurnId?: string;
  activeTurnStartedAt?: number;
  /**
   * station#3473 fix round: the turn id whose terminal (a real
   * `turn.completed`/`turn/completed{status:'failed'}`/`turn/interrupt`
   * success, or a synthesized orphaned-turn `runtime.error`) has already been
   * published. `publishOrphanedTurnFailure` reads this instead of inferring
   * "no terminal yet" from `activeTurnId` alone — `activeTurnId` answers a
   * DIFFERENT question (is codex still tracking this turn) that stopped
   * being equivalent to "has a terminal been published" the moment
   * `interruptTurn` needed to leave `activeTurnId` untouched on a failed
   * RPC (see `interruptTurn`'s own comment). Reset to `undefined` whenever a
   * new turn starts.
   */
  terminalPublishedForTurnId?: string;
  lastSessionState: 'idle' | 'running' | 'errored';
  turnOutput: Map<string, string>;
  toolNames: Map<string, string>;
  toolStarted: Set<string>;
  /**
   * Private quota-cache routing identity, resolved when this app-server
   * process starts. It must never be copied into runtime events.
   */
  quotaConnectionId?: string;
  quotaAccountScope?: 'profile' | 'global';
  quotaCacheKey?: string;
  /**
   * Set by `CodexAdapterTransport.stopSession` before killing the process so
   * the process `exit` handler can tell an intentional stop apart from a
   * crash/natural exit and skip re-running the settle-and-publish logic
   * (avoids a duplicate `session.exited`, since `kill()` may synchronously
   * emit `exit` in some process implementations, including the test
   * doubles).
   */
  stopped: boolean;
  terminationPromise?: Promise<void>;
}
