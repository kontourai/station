/**
 * Station's host-side `HostIntentBinding[]` (roadmap archive#585, part of epic
 * archive#580, S5) — the missing middle step between "a Console board/task view
 * emitted an intent" and "a Station server-side action ran." Every
 * `execute` below is the REAL Station handler
 * (`TaskGraphService`/`OrchestrationService` methods) — this module never
 * synthesizes, wraps, or simulates a handler. Its public
 * `product`/`command`/`sideEffect`/`confirmation` values derive from
 * `STATION_HOST_COMMAND_CATALOG`, which is deliberately in-process: Station
 * does not currently ship the executable a router descriptor would promise.
 *
 * S6 mounts the actual Console board component
 * (`src-ui/src/views/ConsoleBoardView.tsx`) and wires its `onIntent`
 * through resolution built from these bindings (in-process fast path — no
 * subprocess, no network to another product — per epic Decision 5/"Two
 * Console planes"; the browser still reaches this server-side resolution
 * through Station's own ordinary internal REST API, see
 * `src-server/routes/orchestration/operating-state.ts`). Consent: side-effecting
 * commands here carry `confirmation: 'user-request'`;
 * `resolveIntentBinding` NEVER calls `execute` itself — deciding whether a
 * particular invocation may proceed is the caller's job. Station's own
 * native policy classes (`src-server/services/agent-policy-service.ts`,
 * `AgentPolicyService` — the S3 L3-grade platform-mutation gate) are the
 * intended consent layer when Station is the host; this module surfaces
 * the metadata those policies (or S6's confirmation UI) act on, it does not
 * rebuild or bypass them.
 *
 * Subject-ref trust (review finding, 2026-07-22): a resolved binding's
 * `execute` only ever consumes a `subjectRefs[0]` whose `product`/`kind`
 * match the command's expected subject type — `{product:'station',
 * kind:'task'}` for the task-* commands, `{product:'station',
 * kind:'session'}` for `session resume`. A correctly-BOUND intent (the
 * `(product, command)` authority matched) can still carry an
 * attacker-or-bug-shaped `subjectRefs[0]` (e.g. a foreign-product ref, or
 * one merely missing `kind`) whose `id` happens to collide with a real
 * Station task/session id; without this check that id would be used
 * regardless of what kind of thing it actually names. `validatedSubjectId`
 * is the single choke point for that check — every execute below reads the
 * subject id through it, never through `subjectRefs[0].id` directly.
 */

import type {
  BindableIntent,
  HostIntentBinding,
} from '@kontourai/console-core';
import type {
  TaskDispatchInput,
  TaskStatus,
} from '@kontourai/station-contracts';
import type { SessionReadAuthority } from '@kontourai/station-contracts/tenancy';
import { isHostedSessionReadAuthority } from '@kontourai/station-contracts/tenancy';
import type { OrchestrationService } from '../services/orchestration/orchestration-service.js';
import type { TaskDispatcher } from '../services/projects/task-dispatcher.js';
import type { TaskGraphService } from '../services/projects/task-graph-service.js';
import {
  STATION_HOST_COMMAND_CATALOG,
  STATION_HOST_COMMAND_PRODUCT,
  type StationHostCommand,
} from './station-descriptor.js';

/** A subject ref a Station-emitted board/task intent carries. Structurally a
 * superset of console-core's `ConsoleRef` — `provider`/`resumeCursor` are
 * Station-local extensions accepted on the wire for `session.resume` but
 * NEVER trusted (see the header comment and `sessionResumeExecute` below:
 * the actual provider/cursor used always comes from the Station-owned
 * session record, looked up by the validated session id). */
export interface StationIntentSubjectRef {
  product?: string;
  kind?: string;
  id?: string;
  label?: string;
  name?: string;
  provider?: string;
  resumeCursor?: unknown;
}

export interface StationIntent extends BindableIntent {
  subjectRefs?: StationIntentSubjectRef[];
}

/**
 * The single choke point for reading a subject id off an intent. Returns
 * the id ONLY when `subjectRefs[0]` names the expected `(product, kind)`
 * pair for the command being executed — a foreign-product ref, a
 * differently-kinded ref, or a missing ref all return `undefined`
 * (no-op), even if `id` happens to be present and even if it happens to
 * collide with a real Station record id.
 */
function validatedSubjectId(
  intent: StationIntent,
  expected: { product: 'station'; kind: 'task' | 'session' },
): string | undefined {
  const ref = intent.subjectRefs?.[0];
  if (!ref) return undefined;
  if (ref.product !== expected.product || ref.kind !== expected.kind) {
    return undefined;
  }
  return ref.id;
}

export interface StationIntentBindingDeps {
  taskGraphService: Pick<TaskGraphService, 'readTaskView' | 'updateTaskStatus'>;
  taskDispatcher: TaskDispatcher;
  orchestrationService: Pick<OrchestrationService, 'dispatch' | 'readSession'>;
  /**
   * Resolved while the intent is executing, never while bindings are built.
   * Board intents are externally shaped; in hosted mode an absent trusted
   * request authority is an inert intent rather than a process-wide read.
   */
  getSessionReadAuthority?: () => SessionReadAuthority | undefined;
  /**
   * Lets runtime composition explicitly identify hosted execution while it
   * wires request context into board dispatch. A hosted authority remains the
   * default signal, and a missing hosted authority is inert.
   */
  isHostedExecution?: () => boolean;
}

const TASK_SUBJECT = { product: 'station', kind: 'task' } as const;
const SESSION_SUBJECT = { product: 'station', kind: 'session' } as const;

function hostedExecution(deps: StationIntentBindingDeps): boolean {
  const authority = deps.getSessionReadAuthority?.();
  return (
    deps.isHostedExecution?.() === true ||
    (authority ? isHostedSessionReadAuthority(authority) : false)
  );
}

function taskStatusExecute(deps: StationIntentBindingDeps) {
  return (intent: StationIntent): void => {
    if (hostedExecution(deps)) return;
    const taskId = validatedSubjectId(intent, TASK_SUBJECT);
    if (!taskId) return;
    // Read-local, `confirmation: 'never'` — a command advertised as safe
    // to auto-execute must be genuinely side-effect-free, so this reads
    // through `readTaskView` (the non-persisting counterpart to
    // `TaskGraphService.readTask`), never `readTask` itself, which would
    // silently write a legacy-status migration back to disk on a plain
    // read. Synchronous; there is nothing to await.
    deps.taskGraphService.readTaskView(taskId);
  };
}

function taskDispatchExecute(deps: StationIntentBindingDeps) {
  return async (intent: StationIntent): Promise<void> => {
    if (hostedExecution(deps)) return;
    const taskId = validatedSubjectId(intent, TASK_SUBJECT);
    if (!taskId) return;
    const input: TaskDispatchInput = { sourceSurface: 'console-board' };
    const outcome = await deps.taskDispatcher.dispatch(taskId, input);
    if (outcome.kind !== 'dispatched') throw new Error(outcome.reason);
  };
}

function taskUpdateStatusExecute(
  deps: StationIntentBindingDeps,
  status: TaskStatus,
) {
  return async (intent: StationIntent): Promise<void> => {
    if (hostedExecution(deps)) return;
    const taskId = validatedSubjectId(intent, TASK_SUBJECT);
    if (!taskId) return;
    await deps.taskGraphService.updateTaskStatus(taskId, status);
  };
}

/**
 * Resume/continue a Station orchestration session. The intent's subject id
 * is validated (see `validatedSubjectId`), but its `provider`/`resumeCursor`
 * fields are NEVER trusted — a bound `session resume` intent is still an
 * externally-shaped payload, and accepting an intent-supplied provider
 * would let a caller redirect a resume onto a different (possibly
 * external/billable) provider than the one the Station-owned session
 * record actually names. Instead, this looks up the session record via
 * `orchestrationService.readSession(threadId, authority)` and uses ONLY that
 * record's `provider`/`resumeCursor`. No trusted runtime authority or no
 * record for the validated id -> no-op (there is no readable Station-owned
 * session to resume).
 */
function sessionResumeExecute(deps: StationIntentBindingDeps) {
  return async (intent: StationIntent): Promise<void> => {
    const threadId = validatedSubjectId(intent, SESSION_SUBJECT);
    if (!threadId) return;

    const authority = deps.getSessionReadAuthority?.();
    if (!authority) return;
    if (
      isHostedSessionReadAuthority(authority) &&
      !authority.tenantExecutionContext
    ) {
      return;
    }
    const detail = await deps.orchestrationService.readSession(
      threadId,
      authority,
    );
    if (!detail) return;

    await deps.orchestrationService.dispatch(
      {
        type: 'startSession',
        input: {
          threadId,
          provider: detail.session.provider,
          resumeCursor: detail.session.resumeCursor,
        },
      },
      {
        userId: authority.userId,
        tenantExecutionContext: authority.tenantExecutionContext,
      },
    );
  };
}

/** Real executor factories, keyed by the canonical host-command catalog. */
const EXECUTOR_FACTORIES: Record<
  StationHostCommand['id'],
  (
    deps: StationIntentBindingDeps,
  ) => (intent: StationIntent) => void | Promise<void>
> = {
  taskStatus: taskStatusExecute,
  taskDispatch: taskDispatchExecute,
  taskBlock: (deps) => taskUpdateStatusExecute(deps, 'blocked'),
  taskUnblock: (deps) => taskUpdateStatusExecute(deps, 'ready'),
  sessionResume: sessionResumeExecute,
};

/**
 * Build Station's `HostIntentBinding<StationIntent>[]` from its in-process
 * catalog and the existing product-owned executor factories. Console's real
 * `resolveIntentBinding` explicitly permits these host-declared bindings;
 * unlike a router descriptor, they make no executable/package-bin/argv
 * claim. The catalog is the single source for each public authority's command
 * path, side effect, and confirmation policy.
 */
export function createStationHostIntentBindings(
  deps: StationIntentBindingDeps,
): HostIntentBinding<StationIntent>[] {
  return STATION_HOST_COMMAND_CATALOG.map((command) => ({
    product: STATION_HOST_COMMAND_PRODUCT,
    command: command.path.join(' '),
    sideEffect: command.sideEffect,
    confirmation: command.confirmation,
    execute: EXECUTOR_FACTORIES[command.id](deps),
  }));
}
