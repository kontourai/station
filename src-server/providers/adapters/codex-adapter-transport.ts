import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { createInterface } from 'node:readline';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { ensureEngineSpawnTmpDir } from '../../services/infra/engine-spawn-tmpdir.js';
import { childProcessEnvironment } from '../../utils/child-process-environment.js';
import { findCliBinary } from '../auth/cli-auth.js';
import { AsyncEventQueue } from '../sessions/async-event-queue.js';
import {
  routeCodexChildNotification,
  settleOpenCodexChildren,
} from './codex-adapter-child-work.js';
import {
  deriveApprovalToolName,
  extractThreadId,
  hasId,
  hasMethod,
  mapApprovalResolutionStatus,
  mapServerRequestToEvent,
  resolveSessionGrantAutoApproval,
} from './codex-adapter-events.js';
import {
  handleCodexNotification,
  settleUnresolvedCodexToolCalls,
} from './codex-adapter-notifications.js';
import type {
  CodexProcessLike,
  CodexSessionRecord,
} from './codex-adapter-types.js';
import { terminateCodexProcess } from './codex-process-termination.js';

type JsonRpcRequest = {
  id?: string | number;
  method: string;
  params?: unknown;
};

type JsonRpcResponse = {
  id: string | number;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
  };
};

// The app-server process, rather than notification params, is authoritative
// for account-scoped routing. A payload-supplied thread id can name another
// connection and must never redirect an account observation there.
const ACCOUNT_SCOPED_NOTIFICATION_METHODS = new Set([
  'account/rateLimits/updated',
]);

export function createCodexProcess(
  processFactory?: () => CodexProcessLike,
  extraEnv?: Record<string, string>,
  extraArgs?: string[],
): CodexProcessLike {
  // archive#896 wave 2 / archive#1195: `extraEnv`/`extraArgs` only reach the real
  // spawn path — test-double factories are unaffected (they don't take
  // these arguments at all).
  return processFactory
    ? processFactory()
    : spawnCodexProcess(extraEnv, extraArgs);
}

export function createCodexSessionRecord(options: {
  externalThreadId: string;
  process: CodexProcessLike;
  provider: 'codex';
  threadId: string;
  model: string;
  resumeCursor?: unknown;
  nowIso: () => string;
}): CodexSessionRecord {
  const {
    externalThreadId,
    process,
    provider,
    threadId,
    model,
    resumeCursor,
    nowIso,
  } = options;
  return {
    externalThreadId,
    codexThreadId: '',
    process,
    session: {
      provider,
      threadId,
      status: 'connecting',
      model,
      resumeCursor,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    },
    rpcRequestCounter: 0,
    pendingRpcRequests: new Map(),
    pendingApprovals: new Map(),
    approvedTools: new Set(),
    lastSessionState: 'idle',
    turnOutput: new Map(),
    toolNames: new Map(),
    openToolCalls: new Map(),
    stopped: false,
  };
}

/**
 * The most notifications that ever wait behind a pending host image read.
 * Reaching it settles that read synchronously (as if its deadline passed) and
 * drains the queue in order. The read's own deadline normally drains it long
 * before this.
 *
 * It MUST stay well below `ASYNC_EVENT_QUEUE_DEFAULT_CAPACITY` (4,096), the
 * capacity of the event queue this transport publishes into. A drain pushes
 * every queued notification's events in ONE synchronous run, before the
 * consumer can take any; a drain larger than that queue's free space
 * overflows it, which clears its buffer and rejects the iterator ("Async
 * event queue capacity exceeded."). 1,024 leaves room for the events the
 * consumer has not taken yet plus the rest of the stdout chunk being
 * handled — and a single chunk of JSON-RPC lines holds only a few hundred
 * lines, so the cap is reached across chunks, not within one.
 */
export const MAX_QUEUED_NOTIFICATIONS = 1_024;

export class CodexAdapterTransport {
  private readonly events = new AsyncEventQueue<CanonicalRuntimeEvent>();
  private readonly sessions = new Map<string, CodexSessionRecord>();
  /**
   * #2458 fix round (P1a): codex thread id → record, PER EMITTING PROCESS.
   * Each session runs its own app-server, and a thread id is only meaningful
   * on the process streaming it: two sessions may resume the same codex
   * thread, and a process may stream, as its own child, a thread id another
   * session owns. A single global map let the later registration capture the
   * earlier session's events (and, with a process guard on top, drop them).
   */
  private readonly threadLookup = new Map<
    CodexProcessLike,
    Map<string, CodexSessionRecord>
  >();

  constructor(
    private readonly now: () => Date,
    private readonly terminateProcess: (
      process: CodexProcessLike,
    ) => Promise<void> = terminateCodexProcess,
    private readonly onQuotaUpdate?: (
      record: CodexSessionRecord,
      payload: unknown,
    ) => void,
    private readonly onNotificationError?: (method: string) => void,
  ) {}

  streamEvents(options?: {
    signal?: AbortSignal;
  }): AsyncIterable<CanonicalRuntimeEvent> {
    return this.events.iterable(options);
  }

  registerSession(record: CodexSessionRecord): void {
    if (this.sessions.has(record.externalThreadId)) {
      throw new Error(
        `Codex session already exists: ${record.externalThreadId}`,
      );
    }
    this.sessions.set(record.externalThreadId, record);
  }

  unregisterSession(record: CodexSessionRecord): void {
    this.sessions.delete(record.externalThreadId);
    const threads = this.threadLookup.get(record.process);
    if (threads) {
      for (const [threadId, owner] of threads) {
        if (owner === record) threads.delete(threadId);
      }
      if (threads.size === 0) this.threadLookup.delete(record.process);
    }
  }

  setCodexThreadId(record: CodexSessionRecord, codexThreadId: string): void {
    record.codexThreadId = codexThreadId;
    let threads = this.threadLookup.get(record.process);
    if (!threads) {
      threads = new Map();
      this.threadLookup.set(record.process, threads);
    }
    threads.set(codexThreadId, record);
  }

  handleProcess(record: CodexSessionRecord): void {
    record.process.stdout.on('data', (chunk: Buffer | string) => {
      const limit = record.stdoutIngressLimit;
      if (!limit || limit.exceeded) return;
      limit.observedBytes += Buffer.byteLength(chunk);
      if (limit.observedBytes <= limit.maxBytes) return;
      limit.exceeded = true;
      record.stopped = true;
      this.rejectPendingRpcRequests(
        record,
        () =>
          new Error('Codex bounded stdout ingress exceeded its byte limit.'),
      );
      record.process.stdout.pause();
      void this.terminateRecord(record).catch(() => {});
    });
    const stdout = createInterface({ input: record.process.stdout });
    stdout.on('line', (line) => this.handleStdoutLine(record, line));

    const stderr = createInterface({ input: record.process.stderr });
    stderr.on('line', (line) => {
      if (!line.trim()) return;
      this.publish({
        eventId: crypto.randomUUID(),
        provider: 'codex',
        threadId: record.externalThreadId,
        createdAt: this.now().toISOString(),
        method: 'runtime.warning',
        severity: 'warning',
        message: 'Codex app-server emitted stderr output.',
        code: 'codex-stderr',
      });
    });

    record.process.on('exit', (code) => {
      // An intentional stop (stopSession/stopAll) already settled pending
      // requests and published session.exited — skip re-running that here
      // so a synchronous `exit` from kill() (as the test doubles emit)
      // doesn't produce a duplicate session.exited.
      if (record.stopped) return;
      const nowIso = this.now().toISOString();
      const interruptedTurnId = this.rejectPendingRpcRequests(
        record,
        () =>
          new Error(
            `Codex app-server exited before responding (code: ${code ?? 'unknown'})`,
          ),
      );
      // archive#3451 fix round D2: only skip synthesis when the interrupt
      // that was in flight targeted the CURRENT active turn — an abandoned
      // interrupt for an earlier turn must not disarm this turn's synthesis.
      void this.finalizeUnexpectedExit(
        record,
        code,
        nowIso,
        interruptedTurnId !== undefined &&
          interruptedTurnId === record.activeTurnId,
      );
    });
    // archive#3451 fix round D3: a third teardown door for spawn/kill
    // failures on the ChildProcess itself. It does NOT see stdin write
    // failures (#774 corrected D3's claim that it did): that EPIPE emits on
    // the stdin stream, handled by the dedicated door below.
    record.process.on('error', (error) => {
      if (record.stopped) return;
      record.stopped = true;
      const nowIso = this.now().toISOString();
      const interruptedTurnId = this.rejectPendingRpcRequests(
        record,
        () => new Error(`Codex app-server failed to start: ${error.message}`),
      );
      this.settleUnresolvedToolCalls(record, nowIso);
      this.publishOrphanedTurnFailure(
        record,
        nowIso,
        `Codex app-server process error before the turn finished: ${error.message}`,
        {
          skipSynthesis:
            interruptedTurnId !== undefined &&
            interruptedTurnId === record.activeTurnId,
        },
      );
      this.unregisterSession(record);
      this.publish({
        eventId: crypto.randomUUID(),
        provider: 'codex',
        threadId: record.externalThreadId,
        createdAt: nowIso,
        method: 'session.exited',
        sessionId: record.externalThreadId,
        reason: 'process-error',
      });
    });
    // #774: a stdin WRITE landing after the reader is gone emits 'error'
    // (EPIPE) on the stdin stream — NOT on the ChildProcess, whose 'error'
    // only covers spawn/kill failures. Unhandled, that error took down the
    // whole server. Same teardown door and shape as the ChildProcess
    // 'error' handler above. Idempotent against a simultaneous process
    // 'exit': whichever fires first wins (`record.stopped` for the
    // stdin-order, the session-registry check inside
    // `finalizeUnexpectedExit` and `publishOrphanedTurnFailure`'s
    // terminalPublishedForTurnId guard for the exit-order).
    record.process.stdin.on('error', (error) => {
      // Exit-first double fire: `finalizeUnexpectedExit` already unregistered
      // the session — nothing is in flight anymore, and re-running this door
      // would duplicate `session.exited`. (For the stdin-first order the
      // same idempotence runs through `record.stopped`, set here and read by
      // the process 'exit' handler.)
      if (
        record.stopped ||
        this.sessions.get(record.externalThreadId) !== record
      ) {
        return;
      }
      record.stopped = true;
      const nowIso = this.now().toISOString();
      const interruptedTurnId = this.rejectPendingRpcRequests(
        record,
        () =>
          new Error(`Codex app-server stdin write failed: ${error.message}`),
      );
      this.settleUnresolvedToolCalls(record, nowIso);
      this.publishOrphanedTurnFailure(
        record,
        nowIso,
        `Codex app-server stdin write failed before the turn finished: ${error.message}`,
        {
          skipSynthesis:
            interruptedTurnId !== undefined &&
            interruptedTurnId === record.activeTurnId,
        },
      );
      this.unregisterSession(record);
      record.session = {
        ...record.session,
        status: 'closed',
        updatedAt: nowIso,
      };
      // The reader being gone does not guarantee the process is dead
      // (a wedged child can simply stop reading); reap it like the other
      // unexpected-exit doors do — and like them, an unconfirmed reap
      // warns instead of vanishing.
      void this.terminateRecord(record).catch(() => {
        this.publish({
          eventId: crypto.randomUUID(),
          provider: 'codex',
          threadId: record.externalThreadId,
          createdAt: nowIso,
          method: 'runtime.warning',
          severity: 'warning',
          message:
            'Codex process tree cleanup was not confirmed after a stdin write failure.',
          code: 'codex-process-cleanup-unconfirmed',
        });
      });
      this.publish({
        eventId: crypto.randomUUID(),
        provider: 'codex',
        threadId: record.externalThreadId,
        createdAt: nowIso,
        method: 'session.exited',
        sessionId: record.externalThreadId,
        reason: 'process-error',
      });
    });
  }

  handleStdoutLine(record: CodexSessionRecord, line: string): void {
    if (record.stdoutIngressLimit?.exceeded) return;
    const trimmed = line.trim();
    if (!trimmed) return;

    let message: unknown;
    try {
      message = JSON.parse(trimmed);
    } catch {
      this.publish({
        eventId: crypto.randomUUID(),
        provider: 'codex',
        threadId: record.externalThreadId,
        createdAt: this.now().toISOString(),
        method: 'runtime.warning',
        severity: 'warning',
        message: 'Failed to parse Codex JSON-RPC payload.',
        code: 'codex-json-parse',
      });
      return;
    }

    if (hasMethod(message) && hasId(message)) {
      this.handleServerRequest(
        record,
        message as JsonRpcRequest & { id: string | number },
      );
      return;
    }

    if (hasMethod(message)) {
      this.handleNotification(
        record,
        message as { method: string; params?: unknown },
      );
      return;
    }

    if (hasId(message)) {
      this.handleResponse(record, message as JsonRpcResponse);
    }
  }

  sendNotification(
    record: CodexSessionRecord,
    method: string,
    params?: unknown,
  ): void {
    const payload =
      params === undefined
        ? { jsonrpc: '2.0', method }
        : { jsonrpc: '2.0', method, params };
    record.process.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  sendResponse(
    record: CodexSessionRecord,
    requestId: string,
    result: unknown,
  ): void {
    record.process.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: requestId, result })}\n`,
    );
  }

  sendErrorResponse(
    record: CodexSessionRecord,
    requestId: string,
    message: string,
  ): void {
    record.process.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: requestId,
        error: { code: -32601, message },
      })}\n`,
    );
  }

  async sendRequest<T = unknown>(
    record: CodexSessionRecord,
    method: string,
    params?: unknown,
    /**
     * archive#3451 fix round D2: tracking-only, never serialized onto the
     * wire — the turn a `turn/interrupt` request targets, so a forced
     * teardown's in-flight check can compare against `record.activeTurnId`
     * instead of assuming any pending interrupt belongs to the CURRENT turn.
     */
    options?: { turnId?: string },
  ): Promise<T> {
    const id = String(++record.rpcRequestCounter);
    const payload =
      params === undefined
        ? { jsonrpc: '2.0', id, method }
        : { jsonrpc: '2.0', id, method, params };
    const response = new Promise<T>((resolve, reject) => {
      record.pendingRpcRequests.set(id, {
        resolve,
        reject,
        method,
        turnId: options?.turnId,
      });
    });
    record.process.stdin.write(`${JSON.stringify(payload)}\n`);
    return response;
  }

  requireSession(threadId: string): CodexSessionRecord {
    const record = this.sessions.get(threadId);
    if (!record) {
      throw new Error(`Codex session not found for thread: ${threadId}`);
    }
    return record;
  }

  publish(event: CanonicalRuntimeEvent): void {
    this.events.push(event);
  }

  listSessions(): CodexSessionRecord[] {
    return [...this.sessions.values()];
  }

  hasSession(threadId: string): boolean {
    return this.sessions.has(threadId);
  }

  setStdoutIngressLimit(record: CodexSessionRecord, maxBytes: number): void {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new RangeError('Codex stdout ingress limit must be positive.');
    }
    record.stdoutIngressLimit = {
      maxBytes,
      observedBytes: 0,
      exceeded: false,
    };
  }

  clearStdoutIngressLimit(record: CodexSessionRecord): void {
    if (!record.stdoutIngressLimit?.exceeded) {
      delete record.stdoutIngressLimit;
    }
  }

  getSession(threadId: string): CodexSessionRecord | undefined {
    return this.sessions.get(threadId);
  }

  async stopSession(threadId: string, nowIso: () => string): Promise<void> {
    const record = this.sessions.get(threadId);
    if (!record) {
      return;
    }
    record.stopped = true;

    // Settle outstanding inbound approval requests before teardown so the
    // request event contract holds: every request.opened gets a matching
    // request.resolved even when the session stops mid-approval (mirrors
    // claude-adapter/acp-adapter, archive#164/#148). We do not attempt to write an
    // RPC response back to the Codex process here since it is being killed
    // immediately after.
    for (const requestId of record.pendingApprovals.keys()) {
      this.publish({
        eventId: crypto.randomUUID(),
        provider: 'codex',
        threadId,
        createdAt: nowIso(),
        requestId,
        method: 'request.resolved',
        status: mapApprovalResolutionStatus('cancel'),
      });
    }
    record.pendingApprovals.clear();

    // Reject outstanding outgoing JSON-RPC calls so awaiters (sendTurn,
    // interruptTurn, thread/start, etc.) never hang on a stopped session.
    // archive#3473 fix round (closes the reopened double-terminal): capture
    // whether a `turn/interrupt` was among them BEFORE force-rejecting — see
    // `rejectPendingRpcRequests`'s doc. archive#3451 fix round D2: compare
    // its target turnId against the CURRENT active turn immediately — an
    // abandoned interrupt for an earlier, already-superseded turn must not
    // disarm THIS turn's synthesis.
    const interruptedTurnId = this.rejectPendingRpcRequests(
      record,
      () => new Error('Codex session stopped'),
    );
    const interruptWasInFlightForActiveTurn =
      interruptedTurnId !== undefined &&
      interruptedTurnId === record.activeTurnId;

    try {
      await this.terminateRecord(record);
    } catch (error) {
      record.stopped = false;
      throw error;
    }
    this.unregisterSession(record);
    record.session = {
      ...record.session,
      status: 'closed',
      updatedAt: nowIso(),
    };
    // archive#3473 path 2: a `stopSession` reached without a prior
    // `interruptTurn` (e.g. a hard session close, not the cooperative-stop
    // Stop button — see `interruptTurn`'s own comment) can still be tearing
    // down mid-turn. Publish the turn's terminal fact before the session's —
    // unless an interrupt was in flight for this exact turn (see
    // `publishOrphanedTurnFailure`'s `skipSynthesis` doc): that RPC's caller
    // owns the turn's terminal fate and, for the one caller that also calls
    // `stopSession` (the cooperative-stop deadline), already published it.
    this.settleUnresolvedToolCalls(record, nowIso());
    this.publishOrphanedTurnFailure(
      record,
      nowIso(),
      'Codex session was stopped before the turn finished.',
      { skipSynthesis: interruptWasInFlightForActiveTurn },
    );
    this.publish({
      eventId: crypto.randomUUID(),
      provider: 'codex',
      threadId,
      createdAt: nowIso(),
      method: 'session.exited',
      sessionId: threadId,
      reason: 'stopped',
    });
  }

  async stopAll(nowIso: () => string): Promise<void> {
    try {
      await Promise.all(
        [...this.sessions.keys()].map((threadId) =>
          this.stopSession(threadId, nowIso),
        ),
      );
    } finally {
      this.events.close();
    }
  }

  private handleResponse(
    record: CodexSessionRecord,
    response: JsonRpcResponse,
  ): void {
    const requestId = String(response.id);
    const pending = record.pendingRpcRequests.get(requestId);
    if (!pending) return;
    record.pendingRpcRequests.delete(requestId);
    if (response.error) {
      pending.reject(
        new Error(
          response.error.message ??
            `Codex JSON-RPC error (${response.error.code ?? 'unknown'})`,
        ),
      );
      return;
    }
    pending.resolve(response.result);
  }

  private handleServerRequest(
    record: CodexSessionRecord,
    request: JsonRpcRequest & { id: string | number },
  ): void {
    const requestId = String(request.id);
    const canonicalRequestId = crypto.randomUUID();
    const event = mapServerRequestToEvent(
      record.externalThreadId,
      canonicalRequestId,
      request.method,
      request.params,
      this.now().toISOString(),
    );
    if (!event) {
      this.sendErrorResponse(
        record,
        requestId,
        `Unsupported server request: ${request.method}`,
      );
      return;
    }

    const payload = (request.params ?? {}) as Record<string, unknown>;
    const toolName = deriveApprovalToolName(request.method, payload);
    // Tool-level session grant: "Allow for this session" covers every later
    // call of the tool, not just the one call the engine asked about (the
    // command/file-change/elicitation wire responses carry no session
    // scope). Granted tools never re-prompt; denies are never cached. A
    // data-collecting elicitation has no truthful auto-acceptance, so it
    // always re-prompts even under a grant.
    const grantedAutoApproval =
      toolName && record.approvedTools.has(toolName)
        ? resolveSessionGrantAutoApproval(request.method, payload)
        : null;
    if (grantedAutoApproval !== null) {
      this.sendResponse(record, requestId, grantedAutoApproval);
      return;
    }

    record.pendingApprovals.set(canonicalRequestId, {
      rpcRequestId: requestId,
      method: request.method,
      title: event.title,
      threadId: record.externalThreadId,
      payload,
      ...(toolName ? { toolName } : {}),
    });
    this.publish(event);
  }

  private handleNotification(
    emittingRecord: CodexSessionRecord,
    notification: {
      method: string;
      params?: unknown;
    },
  ): void {
    // Account-scoped notifications have no thread routing in their payload;
    // they are attributed to the process that emitted them. Once that process
    // is retired, any buffered stdout is stale and has no claim on a shared
    // account cache (including a same-profile replacement).
    if (
      ACCOUNT_SCOPED_NOTIFICATION_METHODS.has(notification.method) &&
      emittingRecord.stopped
    ) {
      return;
    }
    const threadId = extractThreadId(notification.params);
    // #2458: resolved only among the threads of the process that EMITTED
    // the line (see `threadLookup`). A miss is a thread this process streams
    // but no session registered on it: a subagent's stream.
    const ownHit = threadId
      ? this.threadLookup.get(emittingRecord.process)?.get(threadId)
      : undefined;
    const record = ACCOUNT_SCOPED_NOTIFICATION_METHODS.has(notification.method)
      ? emittingRecord
      : threadId
        ? ownHit
        : emittingRecord;

    if (!record && threadId) {
      // #2458: a thread this transport does not own is a Codex subagent's
      // stream on the emitting process's stdio. It goes to the child-work
      // mapper and NEVER to `handleCodexNotification`: a child's
      // `turn/completed` would close the parent's turn and its token usage
      // would be counted as the parent's.
      try {
        routeCodexChildNotification(
          {
            record: emittingRecord,
            nowIso: () => this.now().toISOString(),
            publish: (event) => this.publish(event),
          },
          threadId,
          notification,
        );
      } catch {
        this.onNotificationError?.(notification.method);
      }
      return;
    }

    const deliver = () => {
      try {
        return handleCodexNotification({
          record,
          notification,
          nowIso: () => this.now().toISOString(),
          publish: (event) => this.publish(event),
          onQuotaUpdate: this.onQuotaUpdate,
        });
      } catch {
        // Readline notification delivery is a transport boundary: malformed
        // provider data must never escape and disrupt subsequent messages.
        this.onNotificationError?.(notification.method);
        return undefined;
      }
    };
    // Handling is synchronous except for an image read from the host. While
    // one is pending, this session's later NOTIFICATIONS wait in an explicit
    // queue, so their publish order stays the engine's order (a tool's
    // terminal never lands after the turn that contains it). The common path
    // never waits.
    //
    // Bounded three ways:
    // - time: the read itself has a deadline (`HOST_IMAGE_READ_DEADLINE_MS`)
    //   after which it settles as an omission marker, and the queue drains;
    // - size: the queue never holds more than `MAX_QUEUED_NOTIFICATIONS`. At
    //   the cap the pending read's terminal is published NOW, synchronously,
    //   with the deadline's outcome (the "could not be read in time" note),
    //   and the queue drains in order in the same call — so the bound holds
    //   even when one stdout callback delivers thousands of lines before any
    //   microtask can run, and order is never broken (a turn's terminal
    //   passing its own image tool would close the tool card as stopped in
    //   `background-tasks-store.ts` and drop the real result);
    // - lifetime: queued work for a session that has since stopped or been
    //   unregistered is discarded, never run against a closed record.
    //
    // Ordering contract for what does NOT go through this queue: server
    // REQUESTS (approval prompts, `handleServerRequest`) and RPC responses
    // are handled as they arrive. A request.opened can therefore be published
    // before the terminal of an image tool whose read is still pending. That
    // is safe because approvals bind to their call by request/call id, never
    // by position, and the approval must not wait on an unrelated file read.
    if (!record) {
      deliver();
      return;
    }
    // Read fresh each time: settling below clears it through a method call.
    const readPending = () => record.pendingHostImageRead !== undefined;
    if (readPending()) {
      const run = () =>
        record.stopped || this.sessions.get(record.externalThreadId) !== record
          ? undefined
          : deliver();
      // Each pass settles one pending read and delivers at least one queued
      // notification, so this loop ends; afterwards the queue has room or
      // nothing is pending any more.
      while (
        readPending() &&
        (record.queuedNotifications?.length ?? 0) >= MAX_QUEUED_NOTIFICATIONS
      ) {
        this.settlePendingHostImageReadNow(record);
      }
      if (readPending()) {
        record.queuedNotifications ??= [];
        record.queuedNotifications.push(run);
        return;
      }
    }
    this.awaitHostImageRead(record, deliver(), notification.method);
  }

  /** Hold this session's later notifications until `pending` settles. */
  private awaitHostImageRead(
    record: CodexSessionRecord,
    pending: Promise<void> | undefined,
    method: string,
  ): void {
    if (!pending) return;
    record.pendingHostImageRead = pending;
    void pending
      .catch(() => {
        this.onNotificationError?.(method);
      })
      .then(() => {
        // Settled early (queue bound) and already drained past it.
        if (record.pendingHostImageRead !== pending) return;
        record.pendingHostImageRead = undefined;
        this.drainQueuedNotifications(record);
      });
  }

  /**
   * Deliver queued notifications in order until one starts another host read
   * (which then holds the rest) or the queue is empty.
   */
  private drainQueuedNotifications(record: CodexSessionRecord): void {
    const queue = record.queuedNotifications;
    if (!queue) return;
    let next = 0;
    while (next < queue.length && !record.pendingHostImageRead) {
      const run = queue[next];
      next += 1;
      this.awaitHostImageRead(record, run?.(), 'queued');
    }
    queue.splice(0, next);
    if (queue.length === 0 && record.queuedNotifications === queue) {
      record.queuedNotifications = undefined;
    }
  }

  /**
   * Publish the pending host read's terminal now (its deadline outcome), stop
   * waiting for it, and drain the queue behind it in order.
   */
  private settlePendingHostImageReadNow(record: CodexSessionRecord): void {
    const settleNow = record.settleHostImageReadNow;
    record.settleHostImageReadNow = undefined;
    record.pendingHostImageRead = undefined;
    try {
      settleNow?.();
    } catch {
      this.onNotificationError?.('item/completed');
    }
    this.drainQueuedNotifications(record);
  }

  private terminateRecord(record: CodexSessionRecord): Promise<void> {
    if (record.terminationPromise) return record.terminationPromise;
    const operation = this.terminateProcess(record.process).finally(() => {
      if (record.terminationPromise === operation) {
        record.terminationPromise = undefined;
      }
    });
    record.terminationPromise = operation;
    return operation;
  }

  private async finalizeUnexpectedExit(
    record: CodexSessionRecord,
    code: number | null,
    nowIso: string,
    interruptWasInFlight: boolean,
  ): Promise<void> {
    try {
      await this.terminateRecord(record);
    } catch {
      this.publish({
        eventId: crypto.randomUUID(),
        provider: 'codex',
        threadId: record.externalThreadId,
        createdAt: nowIso,
        method: 'runtime.warning',
        severity: 'warning',
        message:
          'Codex process tree cleanup was not confirmed after the app-server exited.',
        code: 'codex-process-cleanup-unconfirmed',
      });
      // station#1569 (L1): still settle. This handler runs ON the
      // app-server's exit, so its stdio is gone and no notification can ever
      // arrive for a call still open — whatever happened to the rest of its
      // process tree. What went unconfirmed is the REAP, which says nothing
      // about whether a result is still coming: it is not. Returning here
      // without settling left those rows running forever and made the
      // contract's "settled at session end" claim false for this path.
      //
      // Same guard as the ordinary path below, for the same reason: a
      // deliberate stop has `stopSession`'s own settle. station#1586 (item 3)
      // dropped the supersession half of it at both doors — a record the
      // thread no longer owns still publishes TURN-keyed terminals safely
      // (PR #1560/#1570); only the thread-keyed facts stay withheld. See the
      // ordinary path's comment for why that half is defensive rather than a
      // fix for an observed leak.
      if (!record.stopped) {
        this.settleUnresolvedToolCalls(record, nowIso);
      }
      return;
    }
    if (
      record.stopped ||
      this.sessions.get(record.externalThreadId) !== record
    ) {
      // `stopSession` owns the settle for a stop already in flight, so a
      // stopped record publishes nothing here.
      //
      // station#1586 (item 3): a record this thread no longer owns settles
      // its own open calls. Those calls are this record's, its process is
      // gone, and every tool terminal carries the turnId that ISSUED the call
      // (PR #1560) — read from the entry itself, never from whatever turn is
      // active now — while both folds attribute by turn (PR #1570), so a row
      // lands on the stopped session's own turn rather than on any
      // successor's.
      //
      // DEFENSIVE, stated precisely (station#1586 fix round, M3): no
      // production path reaches this branch with an OPEN call today. A
      // restart cannot install a successor mid-drain — `registerSession`
      // throws while the old record is still registered, and it is only
      // unregistered after this method's `await terminateRecord` — and every
      // other unregister site (`stopSession`, the process `error` door, the
      // stdin EPIPE door) sets `stopped` first, so it takes the arm above.
      // Nor is there a second door that could arrive after the ordinary
      // path below: only the `exit` handler reaches this method, the stdin
      // EPIPE door returns before it, and the process `error` door publishes
      // its own terminals. So the settle is not a fix for an observed leak
      // — as things stand nothing reaches it at all; it is here so that this
      // branch cannot become the one door that abandons rows if the
      // registration lifecycle changes — which is exactly how the Claude
      // adapter's own restart window (station#1569 item 6, an observed path
      // there because its `stopSession` removes the record BEFORE awaiting
      // the drain) came to need it.
      //
      // What stays withheld is what is genuinely thread-keyed rather than
      // turn-keyed: `session.exited` below (a client reads it as "this
      // thread's session ended" and closes the thread's still-running cards,
      // which now belong to the live session) and the orphaned-turn
      // `runtime.error` (`publishOrphanedTurnFailure` dedupes on
      // `record.terminalPublishedForTurnId` — the superseded record's own
      // bookkeeping — and the turn it would close is not the one in flight).
      if (!record.stopped) {
        this.settleUnresolvedToolCalls(record, nowIso);
      }
      return;
    }
    this.unregisterSession(record);
    record.session = {
      ...record.session,
      status: 'closed',
      updatedAt: nowIso,
    };
    // archive#3473 path 1: the app-server process died with no `turn/completed`
    // notification ever arriving for the turn it was mid-way through. Publish
    // the turn's terminal fact before the session's, so nothing turnId-keyed
    // (the completion-notification listener, `hasActiveTurn`, the stall
    // watchdog) is left waiting on a turn that is already over.
    this.settleUnresolvedToolCalls(record, nowIso);
    this.publishOrphanedTurnFailure(
      record,
      nowIso,
      `Codex app-server exited before the turn finished (code: ${
        code ?? 'unknown'
      }).`,
      { skipSynthesis: interruptWasInFlight },
    );
    this.publish({
      eventId: crypto.randomUUID(),
      provider: 'codex',
      threadId: record.externalThreadId,
      createdAt: nowIso,
      method: 'session.exited',
      sessionId: record.externalThreadId,
      exitCode: code ?? undefined,
      reason: code === 0 ? 'completed' : 'process-exit',
    });
  }

  /**
   * station#1569 (item 4): every tool item still open when the session ends
   * gets its honest terminal, on the turn that issued it.
   *
   * Placed immediately before `publishOrphanedTurnFailure` at all four
   * session-end doors for the reason that method's own comment gives —
   * before `session.exited`, which closes a still-running card client-side
   * (`background-tasks-store.ts`). Innermost terminal first: the tool rows,
   * then the orphaned turn, then the session.
   *
   * Unconditional, unlike the turn synthesis beside it: an open tool call is
   * a fact in `record.openToolCalls`, not an inference from `activeTurnId`,
   * and no other path publishes a terminal for it. The helper is idempotent
   * (it clears the map first), so a session that reaches two doors — a stdin
   * EPIPE followed by the process `exit`, say — settles each call once.
   */
  private settleUnresolvedToolCalls(
    record: CodexSessionRecord,
    nowIso: string,
  ): void {
    settleUnresolvedCodexToolCalls({
      record,
      nowIso,
      publish: (event) => this.publish(event),
    });
    // #2458: a subagent still running when its session ends can never
    // report again, so it settles `unresolved` — same doors, same moment.
    settleOpenCodexChildren({
      record,
      nowIso: () => nowIso,
      publish: (event) => this.publish(event),
    });
  }

  /**
   * archive#3473: synthesizes the turn-scoped terminal event neither
   * `stopSession` nor `finalizeUnexpectedExit` previously published when the
   * session ends with `record.activeTurnId` still set — an in-flight turn
   * that no `turn/completed` notification ever closed. Publishing
   * `runtime.error` — never `turn.aborted` — lands on the SAME arm archive#3442
   * already covers and tests, with no new dedupe key. Leaves `retriable`
   * unset: this is neither codex's own definitive turn failure nor its
   * `willRetry` signal, it is Station observing the session end with the
   * turn unresolved. Always call BEFORE publishing `session.exited`.
   *
   * archive#3473 fix round (H3): the double-terminal guard is
   * `record.terminalPublishedForTurnId`, an EXPLICIT fact — not, as before,
   * inferred from `record.activeTurnId` being cleared. `interruptTurn` no
   * longer clears `activeTurnId` on dispatch (only on a confirmed publish),
   * because doing so left two other callers (the recovery interrupt hook,
   * the accept-then-abort race cleanup) with NO fallback when their RPC
   * rejects — their comments say a LATER canonical terminal owns closing the
   * turn, and this synthesis is that later terminal. `activeTurnId` alone
   * can therefore no longer answer "was a terminal already published."
   *
   * `skipSynthesis` closes the race THIS guard reopened for the one caller
   * that DOES have an unconditional fallback: `runCooperativeStop`'s
   * deadline branch always publishes its own `turn.aborted` before calling
   * `stopSession`, so if `stopSession`/`finalizeUnexpectedExit` had to force-
   * reject a `turn/interrupt` RPC that was in flight FOR THE CURRENT
   * `activeTurnId` (see `rejectPendingRpcRequests` — archive#3451 fix round
   * D2 turn-scopes this comparison so an abandoned interrupt for an EARLIER,
   * already-superseded turn cannot disarm a LATER turn's synthesis), some
   * caller already owns — or, for the cooperative-stop path specifically,
   * already published — that turn's terminal, and synthesizing here would
   * double it.
   *
   * Disclosed residual (narrowed by D2, not eliminated): the signal only
   * answers "is a turn/interrupt for THIS turn currently pending," not "does
   * its caller have a guaranteed fallback." An unanswered `turn/interrupt`
   * still disarms synthesis for the turn it targets regardless of which
   * caller dispatched it — `runCooperativeStop`'s deadline always supplies
   * one anyway, but the recovery interrupt hook and the accept-then-abort
   * cleanup do not, and if the process happens to die while THEIR interrupt
   * attempt for THIS turn is still outstanding, this guard suppresses the
   * one synthesis they were relying on.
   */
  private publishOrphanedTurnFailure(
    record: CodexSessionRecord,
    nowIso: string,
    message: string,
    options: { skipSynthesis: boolean },
  ): void {
    if (
      !record.activeTurnId ||
      record.terminalPublishedForTurnId === record.activeTurnId ||
      options.skipSynthesis
    ) {
      return;
    }
    const turnId = record.activeTurnId;
    record.activeTurnId = undefined;
    record.terminalPublishedForTurnId = turnId;
    this.publish({
      eventId: crypto.randomUUID(),
      provider: 'codex',
      threadId: record.externalThreadId,
      createdAt: nowIso,
      method: 'runtime.error',
      severity: 'error',
      turnId,
      message,
      code: 'codex-turn-orphaned',
    });
  }

  /**
   * Force-rejects every outstanding outgoing JSON-RPC call so awaiters
   * (sendTurn, interruptTurn, thread/start, etc.) never hang on a
   * stopped/dead session. Returns the turnId a `turn/interrupt` request among
   * them targeted, if any — inspected synchronously, before anything is
   * cleared, since that is the one moment this fact is observable at all.
   *
   * archive#3451 fix round D2: returns the TARGET turnId, not a bare
   * boolean. `pendingRpcRequests` has no timeout eviction — an abandoned
   * interrupt (the accept-then-abort race cleanup gives up after ~5s but
   * never cancels the RPC) can still be pending when a LATER, unrelated
   * turn's teardown reaches this same rejection. A boolean here would have
   * skipped that later turn's synthesis for an interrupt that targeted a
   * different one; the caller now compares this against the CURRENT
   * `record.activeTurnId` before deciding to skip.
   */
  private rejectPendingRpcRequests(
    record: CodexSessionRecord,
    makeError: () => Error,
  ): string | undefined {
    let interruptedTurnId: string | undefined;
    for (const pending of record.pendingRpcRequests.values()) {
      if (pending.method === 'turn/interrupt') {
        interruptedTurnId = pending.turnId;
      }
      pending.reject(makeError());
    }
    record.pendingRpcRequests.clear();
    return interruptedTurnId;
  }
}

/** archive#896 wave 2: layered subprocess env for a codex session pointed at an
 * app-home profile. Always a copy: boot-internal secrets are scrubbed. */
export function codexSpawnEnv(
  extraEnv?: Record<string, string>,
): NodeJS.ProcessEnv {
  return childProcessEnvironment(extraEnv);
}

function spawnCodexProcess(
  extraEnv?: Record<string, string>,
  extraArgs?: string[],
): ChildProcessWithoutNullStreams {
  const binary = findCliBinary('codex') ?? 'codex';
  // archive#1195: `extraArgs` carries `-c mcp_servers.<id>....` session-layer
  // config overrides (codex-mcp-passthrough.ts) — appended AFTER
  // `app-server` on the spawn argv itself, never written to any config
  // file and never touching the user's real `~/.codex/config.toml` (see
  // that module's header comment for why this is the wire-safe channel).
  //
  // archive#1908: `TMPDIR` is merged into the spawn env HERE, at the one
  // real spawn call site, rather than inside `codexSpawnEnv` itself — every
  // real Codex `app-server` child still gets a Station-owned tmp dir
  // Station reaps on a schedule (see `reapEngineSpawnTmpDir`). Boot-internal
  // secrets are scrubbed by `codexSpawnEnv`.
  //
  // station#2072: `extraEnv` now carries per-connection env overrides, so
  // TMPDIR is merged LAST — matching the claude seam's documented "TMPDIR
  // is final" invariant. The sanitizer refuses a configured TMPDIR
  // outright; this ordering is the backstop that keeps Station's engine
  // spawn tmp dir authoritative even if one arrives anyway.
  return spawn(binary, ['app-server', ...(extraArgs ?? [])], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: codexSpawnEnv({ ...extraEnv, TMPDIR: ensureEngineSpawnTmpDir() }),
    windowsHide: true,
    detached: true,
  });
}
