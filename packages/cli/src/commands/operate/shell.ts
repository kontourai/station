/**
 * `station operate`'s imperative shell (#168 Wave 2, Task 2A). This is the
 * only file in `operate/` allowed to touch a TTY, `readline`, `setInterval`,
 * or `fetch` — everything else (`types.ts`/`state.ts`/`derive.ts`/
 * `keys.ts`/`render.ts`, Wave 1) is the pure, TTY-free core this shell
 * drives via `reduce(state, action)`/`render(state)`.
 *
 * Responsibilities (plan's Task 2A file list):
 * 1. Open the one global `/api/orchestration/events` connection through one
 *    `AbortController`, consumed via the extended `consumeSseFrames`
 *    (`{threadId: undefined, onSnapshot, onFrame, signal}` — Wave 1B).
 * 2. Seed the initially-focused session's history (`getOrchestrationSession`)
 *    and Flow-run snapshot (`getSessionFlowRun`), dispatched through
 *    `reduce()`. When no initial focus is supplied, this shell (not
 *    `index.ts`, which only parses `--session` at CLI-arg time and has no
 *    board yet) focuses the first board row once the `orchestration:snapshot`
 *    frame arrives — see `maybeAutoFocusFirstRow` below.
 * 3. `readline.emitKeypressEvents` + `setRawMode(true)`, translating Node's
 *    key object into `KeyInfo` and dispatching `{type:'keypress', key}`.
 * 4. After every dispatch, reading `state.pendingIntent` and performing the
 *    matching side effect (`respondToRequest`, re-seeding fetches, quit),
 *    then dispatching `clear-intent`.
 * 5. A 1s `tick` action for approval-age display.
 * 6. `repaint(lines)` via `\x1b[H` (cursor-home) + `\x1b[0J` (clear-to-end).
 * 7. Teardown on every exit path (quit intent, `q`/`Ctrl+C` keypress —
 *    raw mode intercepts `Ctrl+C` before it can raise a normal `SIGINT`, so
 *    it is handled as a keypress, not assumed to fall through —,
 *    `SIGINT`/`SIGTERM`, and an unrecoverable stream error): abort the one
 *    `AbortController`, clear the tick timer, remove the keypress listener,
 *    restore raw mode + cursor visibility, and stop listening for
 *    `SIGINT`/`SIGTERM` — always via `finishOk`/`finishErr`, which both
 *    route through the single `teardown()` function below (#165's
 *    "abort() on every exit path" discipline, generalized here to the
 *    fuller quit/signal/error surface `station operate` adds).
 *
 * Non-fatal per-intent failures (a `respondToRequest` call failing, or a
 * seed fetch failing for a reason other than "not found"/"not Flow-bound")
 * are surfaced as a `Warning:` line on stderr — the same idiom
 * `approvals.ts`'s `watchApprovals` already uses for its own non-fatal seed
 * failure — rather than crashing the whole screen or misusing the pure
 * `OperateState`'s `connectionStatus`/`connectionError` fields (which are
 * specifically about the one SSE connection, not per-intent I/O).
 *
 * Testability: `stdin`/`stdout` are injectable (`RunOperateShellOptions`)
 * so `operate-shell.test.ts` can drive this shell against a `node:stream`
 * `PassThrough` fed raw keypress bytes and a real `node:http` mock server
 * (the real global `fetch` reaches that server directly — no fetch mock
 * needed), with no PTY required — `readline
 * .emitKeypressEvents()` accepts any `NodeJS.ReadableStream`, not only a
 * TTY (confirmed in the plan's TUI-decision section).
 *
 * Dispatch safety net (#168 iteration-2 review finding L2 fix): the two
 * synchronous entry points that call `dispatch()` off of an external event
 * — `onKeypress` (a `readline` `'keypress'` listener) and the 1s `tick`
 * interval callback — go through `safeDispatch()` below, which wraps the
 * call in try/catch and funnels any thrown error to `finishErr()`. Without
 * this, a throwing `reduce()` (e.g. a future reducer bug) would propagate
 * out of a `readline`/timer callback uncaught, bypassing `teardown()`
 * entirely and leaving the terminal in raw mode with the cursor hidden.
 * `dispatch()`'s other callers (the async SSE/seed-fetch paths) already run
 * inside their own try/catch blocks that route to `finishErr`/`writeWarning`.
 */
import * as readline from 'node:readline';
import {
  fetchFleetRoutingReceipts,
  getOrchestrationSession,
  getSessionBuilderRun,
  getSessionFlowRun,
  respondToRequest,
  type SessionBuilderRunView,
  type SessionFlowRunView,
} from '@kontourai/station-sdk/client';
import { consumeSseFrames } from '../session-client.js';
import { render } from './render.js';
import { initialState, reduce } from './state.js';
import type {
  FlowRunSnapshotInput,
  OperateAction,
  OperateBuilderRun,
  OperateIntent,
  OperateState,
} from './types.js';

/** Minimal readable-stream shape this shell needs from `stdin` — satisfied
 * by both `process.stdin` (a real TTY) and a `node:stream` `PassThrough`
 * (tests) — see the module docblock's "Testability" note. */
export type OperateStdin = NodeJS.ReadableStream & {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => void;
};

/** Minimal writable-stream shape this shell needs from `stdout`. */
export type OperateStdout = {
  write: (chunk: string) => unknown;
};

export interface RunOperateShellOptions {
  apiBase: string;
  /** Initial focused session (`--session=<id>`), or `undefined` to fall
   * back to auto-focusing the first board row once the snapshot arrives. */
  focusedThreadId?: string;
  /** Test-only override; defaults to `process.stdin`. */
  stdin?: OperateStdin;
  /** Test-only override; defaults to `process.stdout`. */
  stdout?: OperateStdout;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function writeWarning(message: string): void {
  process.stderr.write(`Warning: ${message}\n`);
}

/**
 * Maps the SDK's `getSessionFlowRun` result down to the slim
 * `FlowRunSnapshotInput` `deriveGateStateForSession` (Wave 1) merges in —
 * `run.state`'s `current_step`/`status` fields (`@kontourai/flow`'s
 * `FlowRunState`, snake_case on the wire) become this module's camelCase
 * `currentStep`/`status`. `null` (not Flow-bound, the route's 404 already
 * converted by `getSessionFlowRun`) passes through unchanged — the honest
 * not-bound placeholder `render.ts` shows.
 */
function toFlowRunSnapshotInput(
  view: SessionFlowRunView | null,
): FlowRunSnapshotInput | null {
  if (!view) {
    return null;
  }
  const runState = (view.run?.state ?? {}) as {
    current_step?: unknown;
    status?: unknown;
  };
  return {
    runId: view.runId,
    definitionId: view.definitionId,
    currentStep:
      typeof runState.current_step === 'string'
        ? runState.current_step
        : undefined,
    status: typeof runState.status === 'string' ? runState.status : undefined,
    openGates: Array.isArray(view.run?.openGates) ? view.run.openGates : [],
    // Freshness passes through as sent. `lastEvaluatedAt` is only carried
    // when the server actually sent the field: `null` means "never
    // evaluated", which must stay distinguishable from "this server does not
    // report freshness" (station#189 S1).
    ...('lastEvaluatedAt' in view
      ? { lastEvaluatedAt: view.lastEvaluatedAt ?? null }
      : {}),
    ...(view.blockedReason ? { blockedReason: view.blockedReason } : {}),
    ...(typeof view.gateOutcomeCount === 'number'
      ? { gateOutcomeCount: view.gateOutcomeCount }
      : {}),
    ...(typeof view.evidenceCount === 'number'
      ? { evidenceCount: view.evidenceCount }
      : {}),
  };
}

/**
 * Flattens the server's `SessionBuilderRunView` into the pane's row shape
 * (station#189 S4). `flow_run`'s snake_case projection fields become the
 * pane's camelCase ones, and the identity fields pass through untouched:
 * `identityStatus`/`matchKind` are the whole point of the row, so this
 * mapper must never default, infer, or fill them in.
 */
function toOperateBuilderRun(
  view: SessionBuilderRunView | null,
): OperateBuilderRun | null {
  if (!view) return null;
  return {
    identityStatus: view.identityStatus,
    matchKind: view.matchKind,
    ...(view.reason ? { reason: view.reason } : {}),
    ...(view.taskSlug ? { taskSlug: view.taskSlug } : {}),
    ...(view.taskSidecarUnreadable ? { taskSidecarUnreadable: true } : {}),
    ...(view.runRef ? { runRef: view.runRef } : {}),
    ...(view.sidecarUpdatedAt
      ? { sidecarUpdatedAt: view.sidecarUpdatedAt }
      : {}),
    ...(view.flowRun
      ? {
          definitionId: view.flowRun.definition_id,
          currentStep: view.flowRun.current_step,
          status: view.flowRun.status,
          openGateIds: view.flowRun.open_gate_ids,
        }
      : {}),
  };
}

export async function runOperateShell(
  options: RunOperateShellOptions,
): Promise<void> {
  const stdin = options.stdin ?? (process.stdin as OperateStdin);
  const stdout: OperateStdout = options.stdout ?? process.stdout;

  let state: OperateState = initialState({
    focusedThreadId: options.focusedThreadId,
  });
  const abortController = new AbortController();

  return new Promise<void>((resolvePromise, rejectPromise) => {
    let torndown = false;
    let settled = false;
    let tickTimer: ReturnType<typeof setInterval> | undefined;

    function repaint(): void {
      stdout.write(`\x1b[H\x1b[0J${render(state).join('\n')}\n`);
    }

    function teardown(): void {
      if (torndown) {
        return;
      }
      torndown = true;
      // Every exit path funnels through this one function, so `abort()` is
      // guaranteed to fire exactly once regardless of which path triggered
      // it (AC-lifecycle) — `AbortController.abort()` is itself idempotent,
      // so calling it here unconditionally is safe even if the connection
      // already failed on its own.
      abortController.abort();
      if (tickTimer) {
        clearInterval(tickTimer);
      }
      stdin.removeListener('keypress', onKeypress);
      if (typeof stdin.setRawMode === 'function' && stdin.isTTY) {
        stdin.setRawMode(false);
      }
      stdin.pause();
      // Restore cursor visibility (`render()`/this shell never hides it
      // explicitly, but a prior `operate` run or an unrelated program could
      // have left it hidden — always restoring on exit is the safe default
      // TUIs use) and leave the terminal in a normal state.
      stdout.write('\x1b[?25h');
      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigterm);
    }

    function finishOk(): void {
      if (settled) {
        return;
      }
      settled = true;
      teardown();
      resolvePromise();
    }

    function finishErr(error: unknown): void {
      if (settled) {
        return;
      }
      settled = true;
      teardown();
      rejectPromise(error);
    }

    function applyAction(action: OperateAction): void {
      state = reduce(state, action);
    }

    function maybeAutoFocusFirstRow(): void {
      if (!state.focusedThreadId && state.board.length > 0) {
        const threadId = state.board[0].threadId;
        applyAction({ type: 'focus-change', threadId });
        void seedFocus(threadId);
      }
    }

    function dispatch(action: OperateAction): void {
      if (torndown) {
        return;
      }
      applyAction(action);
      maybeAutoFocusFirstRow();
      const intent = state.pendingIntent;
      if (intent) {
        applyAction({ type: 'clear-intent' });
      }
      repaint();
      if (intent) {
        void handleIntent(intent);
      }
    }

    /**
     * `dispatch()` wrapped in try/catch, funneling any thrown error (most
     * plausibly from `reduce()`) to `finishErr()` so `teardown()` still runs
     * — see the module docblock's "Dispatch safety net" note (#168
     * iteration-2 review finding L2 fix). Used by the two synchronous,
     * externally-triggered dispatch entry points: `onKeypress` and the tick
     * interval callback.
     */
    function safeDispatch(action: OperateAction): void {
      try {
        dispatch(action);
      } catch (error) {
        finishErr(error);
      }
    }

    /**
     * Pulls this Station's fleet routing receipts (station#1398 slice 4).
     *
     * A failed read is dispatched as `{ page: null, error }` rather than
     * skipped: the pane must be able to say "this could not be read" instead
     * of rendering an empty receipt list, which would read as "nothing has
     * been fleet-routed". It is pulled alongside the focused session's other
     * state, and its failure never disturbs the panes above it.
     */
    async function pullFleetRouting(): Promise<void> {
      let action: OperateAction;
      try {
        action = {
          type: 'fleet-routing-snapshot',
          fleetRouting: {
            page: await fetchFleetRoutingReceipts(options.apiBase),
          },
        };
      } catch (error) {
        action = {
          type: 'fleet-routing-snapshot',
          fleetRouting: { page: null, error: describeError(error) },
        };
      }
      try {
        applyAction(action);
      } catch (error) {
        finishErr(error);
      }
    }

    async function seedFocus(threadId: string): Promise<void> {
      let seededEvents: Array<Record<string, unknown>> = [];
      try {
        const detail = await getOrchestrationSession<{
          session: unknown;
          events: Array<Record<string, unknown>>;
        }>(options.apiBase, threadId);
        seededEvents = detail.events ?? [];
      } catch (error) {
        // A thread that hasn't started yet (or was never persisted) 404s
        // with the server's own 'Session not found' text — that specific
        // case relies on the live stream alone, matching `approvals.ts`'s
        // `watchApprovals` precedent; anything else is a real problem the
        // operator should see.
        if (
          !(error instanceof Error) ||
          error.message !== 'Session not found'
        ) {
          writeWarning(
            `could not seed history for session ${threadId}: ${describeError(error)}`,
          );
        }
      }

      // Replay outside the fetch's try/catch (#187 follow-up 2): a
      // `reduce()` throw during history replay is a reducer bug, not an I/O
      // failure — it must route through `finishErr()`'s teardown exactly
      // like `safeDispatch()`'s dispatch safety net (#168 iteration-2 L2),
      // not degrade into a misleading "could not seed history" warning that
      // leaves the shell running on a half-replayed state.
      try {
        for (const event of seededEvents) {
          applyAction({ type: 'event', event });
        }
      } catch (error) {
        finishErr(error);
        return;
      }

      let snapshot: FlowRunSnapshotInput | null | undefined;
      try {
        const view = await getSessionFlowRun<SessionFlowRunView>(
          options.apiBase,
          threadId,
        );
        snapshot = toFlowRunSnapshotInput(view);
      } catch (error) {
        // A genuine fetch failure here is not the same thing as "not
        // Flow-bound" (already normalized to `null` inside
        // `getSessionFlowRun` for the route's 404) — leave the previous
        // `gateState`/`gateSnapshot` alone rather than falsely claiming
        // not-bound, and surface the failure instead.
        writeWarning(
          `could not pull Flow run status for session ${threadId}: ${describeError(error)}`,
        );
      }

      // Same reduce-throw/I/O-error separation as the replay loop above:
      // `snapshot === undefined` means the fetch failed (warned already);
      // otherwise apply it, and treat a throwing `reduce()` as fatal.
      if (snapshot !== undefined) {
        try {
          applyAction({ type: 'flow-run-snapshot', threadId, snapshot });
        } catch (error) {
          finishErr(error);
          return;
        }
      }

      // The Builder run is pulled separately from the Flow run above and
      // fails separately (station#189 S4): one lifecycle being unreadable
      // must not blank out the other's row, and a failed pull must not
      // render as "no Builder run".
      let builderRun: OperateBuilderRun | null | undefined;
      try {
        builderRun = toOperateBuilderRun(
          await getSessionBuilderRun<SessionBuilderRunView>(
            options.apiBase,
            threadId,
          ),
        );
      } catch (error) {
        writeWarning(
          `could not pull Builder run status for session ${threadId}: ${describeError(error)}`,
        );
      }
      if (builderRun !== undefined) {
        try {
          applyAction({ type: 'builder-run-snapshot', threadId, builderRun });
        } catch (error) {
          finishErr(error);
          return;
        }
      }

      await pullFleetRouting();

      if (!torndown) {
        repaint();
      }
    }

    async function handleIntent(intent: OperateIntent): Promise<void> {
      switch (intent.type) {
        case 'respond-approval':
          try {
            await respondToRequest(options.apiBase, {
              threadId: intent.threadId,
              requestId: intent.requestId,
              decision: intent.decision,
            });
          } catch (error) {
            writeWarning(
              `could not resolve approval ${intent.requestId} (${intent.decision}): ${describeError(error)}`,
            );
          }
          return;
        case 'refresh-focus':
          await seedFocus(intent.threadId);
          return;
        case 'move-focus':
          // `state.ts`'s keypress reducer branch already updated
          // `state.focusedThreadId` in the same dispatch that produced this
          // intent (see `state.ts`'s module docblock) — read it fresh here
          // rather than threading a threadId through the intent payload.
          if (state.focusedThreadId) {
            await seedFocus(state.focusedThreadId);
          }
          return;
        case 'move-selection':
          // Pure local state change — `state.ts` already applied it;
          // nothing for the shell to do.
          return;
        case 'quit':
          finishOk();
          return;
        default:
          return;
      }
    }

    function onKeypress(
      str: string | undefined,
      key: readline.Key | undefined,
    ): void {
      safeDispatch({
        type: 'keypress',
        key: {
          name: key?.name,
          ctrl: Boolean(key?.ctrl),
          shift: Boolean(key?.shift),
          sequence: key?.sequence ?? str ?? '',
        },
      });
    }

    function onSigint(): void {
      finishOk();
    }

    function onSigterm(): void {
      finishOk();
    }

    // --- startup ---
    repaint();

    readline.emitKeypressEvents(stdin);
    if (typeof stdin.setRawMode === 'function' && stdin.isTTY) {
      stdin.setRawMode(true);
    }
    stdin.on('keypress', onKeypress);
    stdin.resume();

    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);

    tickTimer = setInterval(() => {
      safeDispatch({ type: 'tick', now: Date.now() });
    }, 1000);
    // Don't let the age-display tick alone keep the process alive beyond
    // its natural lifetime in environments that support `unref()` (Node's
    // real timers do; a test's fake/mock timer may not).
    (tickTimer as { unref?: () => void }).unref?.();

    if (options.focusedThreadId) {
      void seedFocus(options.focusedThreadId);
    }

    void (async () => {
      try {
        const response = await fetch(
          `${options.apiBase}/api/orchestration/events`,
          { signal: abortController.signal },
        );
        if (!response.ok) {
          throw new Error(
            `Orchestration event stream failed with HTTP ${response.status}`,
          );
        }
        dispatch({ type: 'connection-status', status: 'connected' });

        await consumeSseFrames({
          response,
          signal: abortController.signal,
          onSnapshot: (sessions) => dispatch({ type: 'snapshot', sessions }),
          onFrame: (event) => {
            dispatch({ type: 'event', event });
            return undefined;
          },
        });

        // The real `/api/orchestration/events` route never ends its own
        // response (`src-server/routes/orchestration/orchestration.ts:319-362`) — only a
        // client-initiated abort stops it. If `consumeSseFrames` returns
        // without our own `abortController` having fired, the connection
        // was lost some other way; that's an unrecoverable stream
        // condition, not a clean exit.
        if (abortController.signal.aborted) {
          return;
        }
        finishErr(new Error('Orchestration event stream ended unexpectedly'));
      } catch (error) {
        if (abortController.signal.aborted) {
          // An intentional teardown (quit/signal) already called
          // `abort()`, which is what produced this rejection — not a real
          // error to surface.
          return;
        }
        dispatch({
          type: 'connection-status',
          status: 'error',
          error: describeError(error),
        });
        finishErr(error);
      }
    })();
  });
}
