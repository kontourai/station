/**
 * `station operate`'s pure reducer core (#168 Wave 1, Task 1A) —
 * `initialState()` + `reduce(state, action): state`. TTY-free: no
 * `readline`/`node:tty`/`node:http`/`fetch` imports here. Keypress handling
 * lives in this file's `keypress` branch: `reduce(state, {type:'keypress',
 * key})` computes the resulting `OperateIntent | null` purely from `state`
 * (current focus, current approval selection, current approvals list) and
 * stores it as `state.pendingIntent` — it does not perform any I/O. The
 * shell (Wave 2, `shell.ts`) reads `pendingIntent` after each `reduce()`
 * call, performs the side effect if present, then dispatches
 * `{type:'clear-intent'}`.
 *
 * Design note (not spelled out verbatim in the plan, recorded here for
 * Wave 2): keypresses that are purely local state changes (`move-selection`,
 * `move-focus`'s session-focus cycling) are applied directly to the
 * returned state *in the same `keypress` dispatch*, in addition to setting
 * `pendingIntent` — cycling focus or moving a selection cursor is not I/O.
 * The intent still fires for these so the shell knows a newly-focused
 * session may need its history/gate-run seeded (`move-focus`) — the shell
 * reads the *already-updated* `state.focusedThreadId` to know which thread,
 * rather than the intent payload needing to carry it. Intents that require
 * a real side effect (`respond-approval`, `refresh-focus`, `quit`) never
 * mutate state themselves; the shell performs the effect and feeds the
 * result back in via `event`/`flow-run-snapshot`/process-exit.
 *
 * Single focus-mutation path (#168 iteration-2 review finding M2 fix): the
 * `'focus-change'` action (external focus — e.g. `--session` seeding or the
 * shell's auto-focus-first-row) and the `cycle-focus-*` keypress handling
 * below (Tab/Shift+Tab) both need to "make a thread the focused session,
 * creating its session entry if this is the first time it's seen, and reset
 * its approval selection to 0" — previously duplicated inline in both
 * places. Both now call the one `focusThread()` helper below.
 */
import {
  applyEventToBoardRow,
  deriveBoardRowsFromSnapshot,
  deriveGateStateForSession,
  derivePendingApprovalsForSession,
  nextFocusedThreadId,
} from './derive.js';
import { classifyKey } from './keys.js';
import type {
  ApprovalDecision,
  OperateAction,
  OperateIntent,
  OperateSessionState,
  OperateState,
} from './types.js';

/** Per-session raw-event buffer cap (plan's Task 1A: "cap: 500 events/session, oldest-evicted"). */
export const MAX_EVENTS_PER_SESSION = 500;

export function initialState(options: {
  focusedThreadId?: string;
}): OperateState {
  return {
    connectionStatus: 'connecting',
    focusedThreadId: options.focusedThreadId,
    board: [],
    sessions: options.focusedThreadId
      ? {
          [options.focusedThreadId]: createSessionState(
            options.focusedThreadId,
          ),
        }
      : {},
    pendingIntent: null,
    now: Date.now(),
  };
}

function createSessionState(threadId: string): OperateSessionState {
  return {
    threadId,
    events: [],
    approvals: [],
    selectedApprovalIndex: 0,
    gateState: { bound: false },
    gateSnapshot: undefined,
    builderRun: undefined,
  };
}

function recomputeDerived(
  session: OperateSessionState,
): Pick<
  OperateSessionState,
  'approvals' | 'gateState' | 'selectedApprovalIndex'
> {
  const approvals = derivePendingApprovalsForSession(session.events);
  const gateState = deriveGateStateForSession(
    session.events,
    session.gateSnapshot,
  );
  const selectedApprovalIndex =
    approvals.length === 0
      ? 0
      : Math.min(session.selectedApprovalIndex, approvals.length - 1);
  return { approvals, gateState, selectedApprovalIndex };
}

/**
 * The single create-or-reuse-session + reset-selectedApprovalIndex-to-0 +
 * set-focusedThreadId path (#168 iteration-2 review finding M2 fix), shared
 * by the `'focus-change'` reducer branch above and the `cycle-focus-*`
 * keypress handling in `applyKeypress` below. Does not set `pendingIntent`
 * — callers that need one (the keypress path does, to tell the shell a
 * newly-focused session may need seeding) set it themselves on the result.
 */
function focusThread(state: OperateState, threadId: string): OperateState {
  const existingSession =
    state.sessions[threadId] ?? createSessionState(threadId);
  return {
    ...state,
    focusedThreadId: threadId,
    sessions: {
      ...state.sessions,
      [threadId]: { ...existingSession, selectedApprovalIndex: 0 },
    },
  };
}

const DECISION_BY_BINDING: Record<string, ApprovalDecision> = {
  accept: 'accept',
  'accept-for-session': 'acceptForSession',
  decline: 'decline',
  cancel: 'cancel',
};

export function reduce(
  state: OperateState,
  action: OperateAction,
): OperateState {
  switch (action.type) {
    case 'snapshot': {
      return {
        ...state,
        board: deriveBoardRowsFromSnapshot(action.sessions),
      };
    }

    case 'event': {
      const threadId =
        typeof action.event.threadId === 'string'
          ? action.event.threadId
          : undefined;
      if (!threadId) {
        return state;
      }

      const existingRow = state.board.find((row) => row.threadId === threadId);
      const patchedRow = applyEventToBoardRow(
        // A row invented from a live event for a thread no snapshot has
        // described yet: nothing has observed its answerability, and `null`
        // says so rather than guessing (station#1782). The next snapshot
        // replaces this row wholesale with the decorated one.
        existingRow ?? { threadId, answerability: null },
        action.event,
      );
      const board = existingRow
        ? state.board.map((row) =>
            row.threadId === threadId ? patchedRow : row,
          )
        : [...state.board, patchedRow];

      const existingSession =
        state.sessions[threadId] ?? createSessionState(threadId);
      const events = [...existingSession.events, action.event];
      if (events.length > MAX_EVENTS_PER_SESSION) {
        events.splice(0, events.length - MAX_EVENTS_PER_SESSION);
      }
      const nextSession: OperateSessionState = { ...existingSession, events };
      const derived = recomputeDerived(nextSession);

      return {
        ...state,
        board,
        sessions: {
          ...state.sessions,
          [threadId]: { ...nextSession, ...derived },
        },
      };
    }

    case 'focus-change': {
      return focusThread(state, action.threadId);
    }

    case 'flow-run-snapshot': {
      const existingSession =
        state.sessions[action.threadId] ?? createSessionState(action.threadId);
      const nextSession: OperateSessionState = {
        ...existingSession,
        gateSnapshot: action.snapshot,
      };
      const gateState = deriveGateStateForSession(
        nextSession.events,
        nextSession.gateSnapshot,
      );
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [action.threadId]: { ...nextSession, gateState },
        },
      };
    }

    // station#189 S4. Stored, never folded into `gateState`: the Builder run
    // is a different run with its own lifecycle, and merging the two is the
    // misreading this ticket exists to remove.
    case 'builder-run-snapshot': {
      const existingSession =
        state.sessions[action.threadId] ?? createSessionState(action.threadId);
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [action.threadId]: {
            ...existingSession,
            builderRun: action.builderRun,
          },
        },
      };
    }

    case 'fleet-routing-snapshot': {
      return { ...state, fleetRouting: action.fleetRouting };
    }

    case 'connection-status': {
      return {
        ...state,
        connectionStatus: action.status,
        connectionError: action.error,
      };
    }

    case 'tick': {
      return { ...state, now: action.now };
    }

    case 'clear-intent': {
      return { ...state, pendingIntent: null };
    }

    case 'keypress': {
      return applyKeypress(state, action.key);
    }

    default:
      return state;
  }
}

function applyKeypress(
  state: OperateState,
  key: Parameters<typeof classifyKey>[0],
): OperateState {
  const binding = classifyKey(key);
  if (!binding) {
    return { ...state, pendingIntent: null };
  }

  if (binding === 'quit') {
    return { ...state, pendingIntent: { type: 'quit' } };
  }

  if (binding === 'cycle-focus-next' || binding === 'cycle-focus-prev') {
    const direction = binding === 'cycle-focus-next' ? 'next' : 'prev';
    const nextThreadId = nextFocusedThreadId(
      state.board,
      state.focusedThreadId,
      direction,
    );
    if (!nextThreadId || nextThreadId === state.focusedThreadId) {
      return { ...state, pendingIntent: null };
    }
    const intent: OperateIntent = { type: 'move-focus', direction };
    return { ...focusThread(state, nextThreadId), pendingIntent: intent };
  }

  const focusedThreadId = state.focusedThreadId;
  const focusedSession = focusedThreadId
    ? state.sessions[focusedThreadId]
    : undefined;

  if (binding === 'move-selection-up' || binding === 'move-selection-down') {
    if (
      !focusedThreadId ||
      !focusedSession ||
      focusedSession.approvals.length === 0
    ) {
      return { ...state, pendingIntent: null };
    }
    const delta = binding === 'move-selection-up' ? -1 : 1;
    const count = focusedSession.approvals.length;
    const nextIndex =
      (focusedSession.selectedApprovalIndex + delta + count) % count;
    const direction = binding === 'move-selection-up' ? 'up' : 'down';
    const intent: OperateIntent = { type: 'move-selection', direction };
    return {
      ...state,
      sessions: {
        ...state.sessions,
        [focusedThreadId]: {
          ...focusedSession,
          selectedApprovalIndex: nextIndex,
        },
      },
      pendingIntent: intent,
    };
  }

  if (binding === 'refresh') {
    if (!focusedThreadId) {
      return { ...state, pendingIntent: null };
    }
    return {
      ...state,
      pendingIntent: { type: 'refresh-focus', threadId: focusedThreadId },
    };
  }

  const decision = DECISION_BY_BINDING[binding];
  if (decision) {
    if (
      !focusedThreadId ||
      !focusedSession ||
      focusedSession.approvals.length === 0
    ) {
      return { ...state, pendingIntent: null };
    }
    const selected =
      focusedSession.approvals[focusedSession.selectedApprovalIndex];
    if (!selected) {
      return { ...state, pendingIntent: null };
    }
    return {
      ...state,
      pendingIntent: {
        type: 'respond-approval',
        threadId: focusedThreadId,
        requestId: selected.requestId,
        decision,
      },
    };
  }

  return { ...state, pendingIntent: null };
}
