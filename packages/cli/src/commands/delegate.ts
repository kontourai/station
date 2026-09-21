/**
 * `station delegate` — hand Station a Task (create) and headlessly supervise
 * it (status, events, continue, respond, interrupt), or discover ready
 * targets (targets), entirely from the CLI (#977).
 *
 * Built on the canonical `client/delegations.ts` fetchers (#977 Wave 2), the
 * six new thin HTTP routes those fetchers call (#977 Wave 1), and the
 * already-wired `POST /delegations` / `POST /delegations/options` routes.
 *
 * Verbs:
 *   station delegate --agent=<slug> [--model=<id>]
 *     [--project=<slug> | --project-path=<path>] [--on=<environment>]
 *     [--parent-task=<task-id>] [--json] <prompt|--file|stdin>
 *   station delegate status <task-id> [--on=<environment>] [--json]
 *   station delegate events <task-id> [--after=<cursor>] [--on=<environment>] [--json]
 *   station delegate --session=<conversation-id> <message> [--on=<environment>] [--model=<id>] [--json]
 *   station delegate continue <legacy-id> <message> [--on=<environment>] [--model=<id>] [--json] (deprecated alias)
 *   station delegate respond <task-id> <request-id> <accept|acceptForSession|decline|cancel> [--on=<environment>] [--json]
 *   station delegate interrupt <task-id> [--on=<environment>] [--json]
 *   station delegate wait <task-id> [--on=<environment>] [--timeout=<seconds>]
 *     [--interval=<seconds>] [--json]
 *   station delegate targets [--on=<environment>] [--project=<slug> | --project-path=<path>] [--json]
 *
 * `--on=<environment>` is accepted on every sub-verb (not just create/targets,
 * as the issue's literal sketch showed) because the underlying service
 * functions accept it to address a task living on a non-current SSH
 * environment — omitting it would silently restrict status/events/continue/
 * respond/interrupt to the current environment only, a real functional gap.
 * Deliberate, disclosed scope decision (plan Wave 3, Task: `station delegate`
 * command module).
 *
 * `--after=<cursor>` is the opaque `nextCursor` string a previous `events`
 * page returned (`station-task-events:v1:<n>`), never a raw sequence number —
 * see `client/delegations.ts`'s module docblock.
 *
 * Dispatch: the seven sub-verb names (`status`, `events`, `continue`,
 * `respond`, `interrupt`, `targets`, `wait`) are only treated as an action
 * word when `--agent` is not present. `create` is the only verb
 * that takes a target flag, so a bare `station delegate --agent=<slug>
 * status ...` prompt (whose text happens to start with a reserved word) is
 * unambiguously a create call, not a mis-dispatch to `delegate status`. A
 * `--agent`-less create call whose prompt's first word is
 * exactly one of the seven reserved words is a known, narrow, and disclosed
 * ambiguity (the CLI reads it as the sub-verb) — not solved here.
 *
 * `wait` (#2264) is OBSERVATION ONLY. It polls the same secret-minimized
 * status snapshot `status` reads (`observeDelegatedTask`) until the task
 * reaches an honest outcome or the caller's wait budget expires, and it can
 * never dispatch another turn: there is no code path from `wait` to
 * `delegateTask`, `continueDelegatedTask`, `respondToDelegatedTaskRequest`,
 * or `interruptDelegatedTask`. The caller's wait budget (`--timeout`/
 * `--interval`) is the CLI's own waiting budget and is entirely separate
 * from the delegated engine's execution budget (`DelegatedTaskSnapshot`'s
 * server-forwarded `supervision`): expiring one says nothing about the
 * other. A wait deadline, Ctrl-C, or a polling failure leaves the delegated
 * task untouched and running — see `waitOnDelegatedTask` below.
 */

import { agentId } from '@kontourai/station-contracts/agent-identity';
import {
  type ApprovalDecision,
  type ContinueForegroundMessageInput,
  continueDelegatedTask,
  continueExecutionMessage,
  type DelegatedCapabilityDelivery,
  type DelegatedTaskEventPage,
  type DelegatedTaskFollowUpHandle,
  type DelegatedTaskHandle,
  type DelegatedTaskInterruptResult,
  type DelegatedTaskPendingRequest,
  type DelegatedTaskReason,
  type DelegatedTaskRequestResponseHandle,
  type DelegatedTaskSnapshot,
  type DelegationOptions,
  type DelegationProjectSlugJoin,
  delegateTask,
  discoverDelegationOptions,
  type ForegroundMessageReceipt,
  interruptDelegatedTask,
  observeDelegatedTask,
  observeDelegatedTaskEvents,
  respondToDelegatedTaskRequest,
} from '@kontourai/station-sdk/client';
import { listPendingForThread } from './approvals.js';
import {
  getResolvedApiBase,
  loadTextInput,
  optionalValueFlag,
  type ParsedCoreArgs,
  type ResolvedApiBase,
  requirePositional,
} from './core-api.js';
import { explainRequestFailure } from './errors.js';
import {
  executionEnvironment,
  rejectRetiredExecutionSelectors,
} from './execution-target.js';
import {
  collectModelOptions,
  EXIT_ON_REQUEST_FAIL,
  type OnRequestMode,
  resolveOnRequestMode,
} from './model-options.js';
import { buildApprovalsRespondCommand } from './session-client.js';

const VALID_DECISIONS: ApprovalDecision[] = [
  'accept',
  'acceptForSession',
  'decline',
  'cancel',
];

/**
 * station#979 review r1 LOW fix: mirrors `session-client.ts`'s
 * `shellQuote`/`buildApprovalsRespondCommand` pair — dedupes the three
 * identical `station delegate respond ...` templates that used to be
 * hand-built independently in `formatStatusSummary` and
 * `checkOnRequestFail`, and shell-quotes the ids the same defensive way the
 * chat/runtime notice already does.
 */
function shellQuote(value: string): string {
  // POSIX single-quote escaping: close the quote, emit a backslash-escaped
  // quote, reopen — identical to session-client.ts's buildApprovalsRespondCommand
  // so a copy-pasted respond command stays balanced for any id.
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function buildDelegateRespondCommand(
  taskId: string,
  requestId: string,
): string {
  return `station delegate respond ${shellQuote(taskId)} ${shellQuote(
    requestId,
  )} <accept|acceptForSession|decline|cancel>`;
}

const RESERVED_ACTIONS = new Set([
  'status',
  'events',
  'continue',
  'respond',
  'interrupt',
  'targets',
  'wait',
]);

function delegateContinuationCommand(conversationId: string): string {
  return `station delegate --session=${shellQuote(conversationId)} "<message>"`;
}

/**
 * The one shared `--json` helper every delegate verb calls (AC10): emits
 * `{ ok: true, kind: 'delegate.<verb>', data }` under `--json` — a shape the
 * future #621 envelope (`{version, ok, kind, data}`) can wrap without a
 * breaking change — and a short human summary otherwise.
 */
function printDelegateResult(
  kind: string,
  data: unknown,
  jsonMode: boolean,
): void {
  if (jsonMode) {
    console.log(JSON.stringify({ ok: true, kind: `delegate.${kind}`, data }));
    return;
  }
  console.log(formatDelegateSummary(kind, data));
}

function formatDelegateSummary(kind: string, data: unknown): string {
  switch (kind) {
    case 'create':
      return formatCreateSummary(data as DelegatedTaskHandle);
    case 'status':
      return formatStatusSummary(data as DelegatedTaskSnapshot);
    case 'events':
      return formatEventsSummary(data as DelegatedTaskEventPage);
    case 'continue': {
      const handle = data as {
        conversationId: string;
        currentSessionId: string;
        status: string;
      };
      return `Conversation ${handle.conversationId} continued in Session ${handle.currentSessionId} (status: ${handle.status})`;
    }
    case 'respond': {
      const handle = data as DelegatedTaskRequestResponseHandle;
      return `Resolved request ${handle.requestId} on task ${handle.taskId}: ${handle.decision}`;
    }
    case 'interrupt':
      return formatInterruptSummary(data as DelegatedTaskInterruptResult);
    case 'targets':
      return formatTargetsSummary(data as DelegationOptions);
    default:
      return JSON.stringify(data, null, 2);
  }
}

/**
 * Internal target kinds are not user-facing vocabulary: the glossary terms are
 * "Station agent" and "External agent" ("Agent app"/"runtime" are retired).
 * Every human-readable summary must render through this mapper; `--json`
 * deliberately keeps the raw contract values.
 */
function displayTargetKind(kind: string): string {
  switch (kind) {
    case 'agent':
      return 'Agent';
    case 'station-agent':
      return 'Station agent';
    case 'agent-app':
      return 'External agent';
    default:
      return kind;
  }
}

/**
 * station#1463 fix round: the disclosure has to reach the DEFAULT output.
 *
 * `slugJoin` travelled in the handle and was rendered by `--json` only, so
 * `station delegate` printed a bare `Project: station` for an unverified
 * cross-machine join — the settled-binding reading the whole change exists to
 * prevent, on the surface a human actually reads. Same class as station#977
 * (internal enums in default CLI output, invisible because every test passed
 * `--json`); the non-`--json` assertions in `delegate.test.ts` exist so it
 * cannot regress the same way twice.
 *
 * An unrecognised value renders no note rather than a raw enum: a newer
 * Station's join state is not a claim this CLI can describe.
 */
function projectJoinNote(
  slugJoin: DelegationProjectSlugJoin | undefined,
): string {
  switch (slugJoin) {
    case 'unverified-cross-machine':
      return ' (unverified name match)';
    case 'directory-corroborated':
      return ' (unverified name match, directory corroborated)';
    default:
      return '';
  }
}

/**
 * Delivery-honesty disclosure for the delegate surface: when the resolved
 * Agent authored a setting the engine's channels could not carry, the default
 * human output names the dropped setting — never a silent drop, and never a
 * refusal (the task dispatched; the setting did not travel). A delivered (or
 * first-turn pending) prompt gets its one-line positive summary because it is
 * cheap and answers the natural next question.
 */
function capabilityDeliveryLines(
  delivery: DelegatedCapabilityDelivery | undefined,
  provider: string | undefined,
): string[] {
  if (!delivery) return [];
  const engine = provider ?? 'this engine';
  const lines: string[] = [];
  if (delivery.prompt) {
    if (delivery.prompt.status === 'not-delivered') {
      lines.push(
        delivery.prompt.reason === 'engine-unsupported'
          ? `prompt not delivered: engine has no system-prompt channel (${engine})`
          : `prompt not delivered: ${delivery.prompt.reason ?? 'unknown reason'}`,
      );
    } else if (delivery.prompt.channel === 'first-turn') {
      lines.push(
        delivery.prompt.status === 'delivered'
          ? `agent prompt delivered (first-turn instructions, ${engine})`
          : `agent prompt delivers with the first turn (${engine})`,
      );
    } else {
      lines.push(`agent prompt delivered (${engine} system prompt)`);
    }
  }
  for (const drop of delivery.dropped) {
    // systemPrompt drops are covered by the prompt line above.
    if (drop.capability === 'systemPrompt') continue;
    const subject =
      drop.capability === 'toolServers'
        ? `tool server '${drop.id ?? '?'}'`
        : `skill '${drop.id ?? '?'}'`;
    lines.push(`${subject} not delivered: ${droppedReasonText(drop.reason)}`);
  }
  return lines;
}

function droppedReasonText(reason: string): string {
  switch (reason) {
    case 'engine-unsupported':
      return 'engine has no channel for it';
    case 'not-found':
      return 'not found on this Station';
    case 'disabled':
      return 'disabled';
    case 'secret-boundary-env':
      return 'its env crosses the secret boundary';
    default:
      return reason;
  }
}

function formatCreateSummary(handle: DelegatedTaskHandle): string {
  // Older target Stations can still return the pre-lineage create handle.
  // Keep the compatibility alias at this last presentation seam too, so a
  // human never receives an unusable `--session=undefined` hint.
  const conversationId = handle.conversationId || handle.taskId;
  const lines = [
    `Delegated task ${handle.taskId} to ${displayTargetKind(handle.target.kind)} '${handle.target.id}'`,
    `Environment: ${handle.environment.name} (${handle.environment.kind})`,
  ];
  if (handle.project) {
    lines.push(
      `Project: ${handle.project.slug ?? handle.project.path}${projectJoinNote(
        handle.project.slugJoin,
      )}`,
    );
  }
  if (handle.model) lines.push(`Model: ${handle.model}`);
  if (handle.parentTaskId) lines.push(`Parent task: ${handle.parentTaskId}`);
  lines.push(
    ...capabilityDeliveryLines(handle.capabilityDelivery, handle.provider),
  );
  // station#3409: this used to read `dispatched (resumable)`, printed
  // unconditionally at the moment of dispatch. It described a window that
  // closes when the task finishes — which is exactly when a supervisor has
  // read the result and has a follow-up — and nothing here could see that
  // window close. The command is what is true and useful; when it stops
  // working, `station delegate status` now says so.
  lines.push(`Status: ${handle.status}`);
  // #764: dispatch output cannot know the follow-up window is still open —
  // it is closed while the task is running or waiting on a supervisor
  // (running / needs_input / review_pending / blocked) and only reopens once
  // the task has ended (a stopped child is replaced by continuation) or is
  // still queued. Say so instead of implying the command always works;
  // `station delegate status` is the surface that knows.
  lines.push(
    `Continue this conversation (while it still accepts follow-up turns — 'station delegate status ${handle.taskId}' says when it stops): ${delegateContinuationCommand(conversationId)}`,
  );
  return lines.join('\n');
}

/**
 * #2269: renders the serving Station's forwarded supervision facts — the
 * effective absolute budget, remaining time, and idle window for the current
 * turn. Rendered only when the server declared them; an undeclared budget
 * renders nothing (honest unknown, never a client-side invention).
 */
function supervisionLines(
  supervision: DelegatedTaskSnapshot['supervision'],
): string[] {
  if (!supervision) return [];
  const lines = [
    `Turn budget (this turn only, not the whole task): ${formatDurationMs(supervision.totalLimitMs)} total ` +
      `(${formatDurationMs(supervision.remainingMs)} remaining, ` +
      `deadline ${supervision.deadlineAt})`,
    `Idle limit: ${formatDurationMs(supervision.idleLimitMs)} ` +
      `with no verified protocol activity${
        supervision.lastProgressEventAt
          ? ` (watchdog last observed activity at ${supervision.lastProgressEventAt}; ` +
            `no progress observed since — the turn may be working quietly)`
          : ''
      }`,
  ];
  return lines;
}

/** Compact `90s` / `30m` / `2h` rendering for forwarded millisecond budgets. */
function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rest = seconds % 60;
    return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes ? `${hours}h ${restMinutes}m` : `${hours}h`;
}

function formatStatusSummary(snapshot: DelegatedTaskSnapshot): string {
  const lines = [
    `Task ${snapshot.taskId}: ${snapshot.status}${
      snapshot.resumable ? '' : ' (no longer accepts follow-up turns)'
    }`,
    `Target: ${displayTargetKind(snapshot.target.kind)} '${snapshot.target.id}'`,
    `Environment: ${snapshot.environment.name} (${snapshot.environment.kind})`,
  ];
  if (snapshot.provider) lines.push(`Provider: ${snapshot.provider}`);
  if (snapshot.model) lines.push(`Model: ${snapshot.model}`);
  lines.push(
    ...capabilityDeliveryLines(snapshot.capabilityDelivery, snapshot.provider),
  );
  if (snapshot.lastEvent) {
    lines.push(
      `Last event: ${snapshot.lastEvent.method}${
        snapshot.lastEvent.createdAt
          ? ` at ${snapshot.lastEvent.createdAt}`
          : ''
      }`,
    );
  }
  lines.push(...supervisionLines(snapshot.supervision));
  if (snapshot.reason) {
    lines.push(
      `Reason: ${snapshot.reason.code}${
        snapshot.reason.detail ? ` — ${snapshot.reason.detail}` : ''
      }`,
    );
  }
  if (snapshot.transitionReason) {
    lines.push(`Transition: ${snapshot.transitionReason}`);
  }
  if (snapshot.pendingRequest) {
    lines.push(
      `Pending request: ${snapshot.pendingRequest.id}${
        snapshot.pendingRequest.title
          ? ` — ${snapshot.pendingRequest.title}`
          : ''
      }`,
    );
    // station#979: the ready-to-run command to answer it, mirroring
    // chat/runtime's `station approvals respond` notice
    // (session-client.ts's `printPendingRequestNotice`) — the decision
    // itself is left as a placeholder since only the operator knows which
    // of the four is correct.
    lines.push(
      `Respond: ${buildDelegateRespondCommand(snapshot.taskId, snapshot.pendingRequest.id)}`,
    );
  }
  lines.push(`Can interrupt: ${snapshot.canInterrupt}`);
  // station#3409: say what is still possible, not only what is not. The
  // continue window has closed for good here, so the next honest step is a
  // new task that keeps this one as its parent.
  lines.push(
    snapshot.resumable
      ? `Continue this conversation: ${delegateContinuationCommand(snapshot.conversationId)}`
      : `Carry forward: station delegate create --parent-task=${snapshot.taskId} "<follow-up>"`,
  );
  return lines.join('\n');
}

function formatEventsSummary(page: DelegatedTaskEventPage): string {
  const lines = [
    `Task ${page.taskId} (${page.status}) — ${page.events.length} event(s)`,
  ];
  for (const event of page.events) {
    const detail = event.text ?? event.status ?? event.toolName ?? '';
    // The event method is the informative identifier; the internal `kind`
    // bucket (e.g. 'runtime') is retired user-facing vocabulary and stays
    // `--json`-only.
    lines.push(
      `  [${event.sequence}] ${event.method}${detail ? `: ${detail}` : ''}`,
    );
  }
  lines.push(`Next cursor: ${page.nextCursor} (hasMore: ${page.hasMore})`);
  return lines.join('\n');
}

function formatInterruptSummary(result: DelegatedTaskInterruptResult): string {
  return `Interrupt requested for task ${result.taskId} (status: ${result.status})`;
}

function formatTargetsSummary(options: DelegationOptions): string {
  const lines = [
    `Targets on ${options.environment.name} (${options.environment.kind})`,
  ];
  for (const target of options.targets) {
    const mark = target.ready ? '✓' : '✗';
    const reason =
      !target.ready && target.unavailableReason
        ? ` (${target.unavailableReason})`
        : '';
    lines.push(
      `  ${mark} ${displayTargetKind(target.kind)} ${target.id} — ${target.name}${reason}`,
    );
  }
  return lines.join('\n');
}

/**
 * The exit-code classifier AC9 requires, scoped to `delegate.ts`'s own
 * try/catch around each verb's request — never the global `cli.ts` catch or
 * any other command's exit behavior. Transport failure (server unreachable
 * or timed out) exits 2; a received-but-unsuccessful response (the 503
 * deps-unavailable case, a 400 business rejection) exits 3. A usage error
 * (missing/invalid argument) is thrown before any request is attempted by
 * every action below, so it is never routed through this function and keeps
 * the CLI's ordinary exit-1 behavior via the top-level catch in `cli.ts`.
 */
function handleDelegateFailure(
  error: unknown,
  resolvedApiBase: ResolvedApiBase | undefined,
): never {
  const message = error instanceof Error ? error.message : String(error);
  const transportMessage = explainRequestFailure(error, resolvedApiBase);
  console.error('Error:', transportMessage ?? message);
  process.exit(transportMessage ? 2 : 3);
}

/**
 * station#979: `--on-request=fail`'s post-dispatch check for `create`/
 * `continue`. Unlike `station chat`, a delegated task's dispatch/continue
 * call is fire-and-forget (the server returns a `status: 'dispatched'`
 * handle immediately, before the target's turn necessarily even starts) —
 * there is no live event stream open at this call site to react to
 * mid-turn. This makes exactly ONE follow-up `observeDelegatedTask` call
 * right after dispatch: if that snapshot already shows a `pendingRequest`,
 * it prints the pending request (with the exact respond command) and exits
 * `EXIT_ON_REQUEST_FAIL` instead of the normal success output; otherwise it
 * does nothing and the caller prints success as usual. `--on-request=wait`
 * (default) skips this check entirely — today's behavior, unchanged.
 * Returns `true` when it fully handled the response (caller must not also
 * print the ordinary success output).
 */
async function checkOnRequestFail({
  apiBase,
  taskId,
  environmentId,
  onRequest,
  jsonMode,
  kind,
}: {
  apiBase: string;
  taskId: string;
  environmentId: string | undefined;
  onRequest: OnRequestMode;
  jsonMode: boolean;
  kind: string;
}): Promise<boolean> {
  if (onRequest !== 'fail') {
    return false;
  }
  const snapshot = await observeDelegatedTask(
    apiBase,
    taskId,
    environmentId ? { environmentId } : undefined,
  );
  if (!snapshot.pendingRequest) {
    return false;
  }
  const respondCommand = buildDelegateRespondCommand(
    taskId,
    snapshot.pendingRequest.id,
  );
  if (jsonMode) {
    console.log(
      JSON.stringify({
        ok: true,
        kind: `delegate.${kind}`,
        data: {
          taskId,
          pendingRequest: {
            requestId: snapshot.pendingRequest.id,
            requestType: snapshot.pendingRequest.type,
            title: snapshot.pendingRequest.title,
            respondCommand,
          },
        },
      }),
    );
  } else {
    console.log(
      `Task ${taskId} has a pending request: ${snapshot.pendingRequest.id}${
        snapshot.pendingRequest.title
          ? ` — ${snapshot.pendingRequest.title}`
          : ''
      }\nRespond: ${respondCommand}`,
    );
  }
  process.exit(EXIT_ON_REQUEST_FAIL);
  return true;
}

async function runDelegateCreate(
  apiBase: string,
  parsed: ParsedCoreArgs,
  jsonMode: boolean,
): Promise<void> {
  const agent = optionalValueFlag(parsed, 'agent');
  if (!agent) {
    throw new Error('An Agent selector is required.');
  }
  const model = optionalValueFlag(parsed, 'model');
  const projectSlug = optionalValueFlag(parsed, 'project');
  const projectPath = optionalValueFlag(parsed, 'project-path');
  if (projectSlug && projectPath) {
    throw new Error('Use --project or --project-path, not both.');
  }
  const environment = executionEnvironment(parsed);
  const selectedEnvironmentId =
    environment.kind === 'saved' ? environment.id : undefined;
  const parentTaskId = optionalValueFlag(parsed, 'parent-task');
  const prompt = await loadTextInput(parsed, 0);
  // station#978 AC1/AC2/AC5/AC7: usage errors here (invalid --approval-mode,
  // malformed --model-option, ...) throw before any request, same as every
  // other flag check above.
  const { modelOptions, cwd } = collectModelOptions(parsed);
  if (cwd && (projectSlug || projectPath)) {
    throw new Error('Use --project/--project-path or --cwd, not both.');
  }
  // station#979: usage error before any request, same as every other flag
  // check above.
  const onRequest = resolveOnRequestMode(parsed);

  let data: DelegatedTaskHandle;
  try {
    data = await delegateTask(apiBase, {
      prompt,
      target: {
        environment,
        agent: agentId(agent),
        ...(model || modelOptions
          ? {
              model: {
                ...(model ? { override: model } : {}),
                ...(modelOptions ? { options: modelOptions } : {}),
              },
            }
          : {}),
        ...(projectSlug
          ? { workspace: { kind: 'project' as const, projectSlug } }
          : projectPath
            ? { workspace: { kind: 'directory' as const, cwd: projectPath } }
            : cwd
              ? { workspace: { kind: 'directory' as const, cwd } }
              : {}),
      },
      ...(parentTaskId ? { parentTaskId } : {}),
    });
  } catch (error) {
    // `return` here (not just a bare call) guards the on-request-fail
    // probe below from ever running with an unassigned `data` — relying on
    // `process.exit`'s real-world termination alone is fragile whenever a
    // caller (e.g. a test) mocks `process.exit` as a no-op.
    return handleDelegateFailure(error, getResolvedApiBase());
  }

  // station#979 review r1 HIGH fix: the dispatch above already succeeded
  // (the task IS created — `data.taskId` is real) — the `--on-request=fail`
  // follow-up probe below is a best-effort convenience check, not part of
  // the dispatch itself, and must never downgrade a genuine success into a
  // reported failure. A transient 5xx/reset/eventual-consistency 404 on
  // THIS status GET is caught and warned about, falling through to the
  // ordinary success output (taskId always visible) rather than exiting
  // 2/3 and silently orphaning the just-created task.
  try {
    const handledByOnRequestFail = await checkOnRequestFail({
      apiBase,
      taskId: data.taskId,
      environmentId: selectedEnvironmentId,
      onRequest,
      jsonMode,
      kind: 'create',
    });
    if (handledByOnRequestFail) {
      return;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `Warning: could not check for a pending request on task ${data.taskId} (${message}) — the task was dispatched successfully regardless.\n`,
    );
  }
  printDelegateResult('create', data, jsonMode);
}

async function runDelegateStatus(
  apiBase: string,
  parsed: ParsedCoreArgs,
  jsonMode: boolean,
): Promise<void> {
  const taskId = requirePositional(parsed, 1, 'task id');
  const environment = executionEnvironment(parsed);
  const environmentId =
    environment.kind === 'saved' ? environment.id : undefined;
  try {
    const data = await observeDelegatedTask(
      apiBase,
      taskId,
      environmentId ? { environmentId } : undefined,
    );
    printDelegateResult('status', data, jsonMode);
  } catch (error) {
    handleDelegateFailure(error, getResolvedApiBase());
  }
}

async function runDelegateEvents(
  apiBase: string,
  parsed: ParsedCoreArgs,
  jsonMode: boolean,
): Promise<void> {
  const taskId = requirePositional(parsed, 1, 'task id');
  const environment = executionEnvironment(parsed);
  const environmentId =
    environment.kind === 'saved' ? environment.id : undefined;
  const after = optionalValueFlag(parsed, 'after');
  try {
    const data = await observeDelegatedTaskEvents(apiBase, taskId, {
      ...(environmentId ? { environmentId } : {}),
      ...(after ? { cursor: after } : {}),
    });
    printDelegateResult('events', data, jsonMode);
  } catch (error) {
    handleDelegateFailure(error, getResolvedApiBase());
  }
}

async function runDelegateContinuation(
  apiBase: string,
  parsed: ParsedCoreArgs,
  jsonMode: boolean,
  options: {
    conversationId: string;
    messageIndex: number;
    deprecatedAlias?: boolean;
  },
): Promise<void> {
  const message = await loadTextInput(parsed, options.messageIndex);
  const environment = executionEnvironment(parsed);
  const environmentId =
    environment.kind === 'saved' ? environment.id : undefined;
  const model = optionalValueFlag(parsed, 'model');
  // station#978 AC3/AC6: no --cwd here — a follow-up turn resumes the
  // task's already-bound session, whose cwd was fixed at create time.
  // Rejected explicitly (not silently dropped) rather than accepted and
  // ignored.
  const { modelOptions, cwd } = collectModelOptions(parsed);
  if (
    cwd ||
    optionalValueFlag(parsed, 'project') ||
    optionalValueFlag(parsed, 'project-path')
  ) {
    throw new Error(
      'Workspace flags have no effect when continuing a conversation: its workspace is fixed when the conversation is created.',
    );
  }
  // station#979: usage error before any request, same as every other flag
  // check above.
  const onRequest = resolveOnRequestMode(parsed);
  if (!options.deprecatedAlias) {
    return runConversationContinuation(
      apiBase,
      options.conversationId,
      {
        environment,
        message,
        ...(model || modelOptions
          ? {
              model: {
                ...(model ? { override: model } : {}),
                ...(modelOptions ? { options: modelOptions } : {}),
              },
            }
          : {}),
      },
      onRequest,
      jsonMode,
    );
  }
  if (options.deprecatedAlias) {
    process.stderr.write(
      "Deprecated: 'station delegate continue <id> <message>' remains available for one release; use 'station delegate --session=<conversation-id> <message>'.\n",
    );
  }
  let data: DelegatedTaskFollowUpHandle;
  try {
    data = await continueDelegatedTask(apiBase, options.conversationId, {
      message,
      ...(environmentId ? { environmentId } : {}),
      ...(model ? { model } : {}),
      ...(modelOptions ? { modelOptions } : {}),
    });
  } catch (error) {
    // Same guard as `runDelegateCreate` above.
    return handleDelegateFailure(error, getResolvedApiBase());
  }

  // station#979 review r1 HIGH fix: same best-effort probe as create above —
  // see its comment for why this must not downgrade an already-succeeded
  // continue into a reported failure.
  try {
    const handledByOnRequestFail = await checkOnRequestFail({
      apiBase,
      taskId: data.conversationId,
      environmentId,
      onRequest,
      jsonMode,
      kind: 'continue',
    });
    if (handledByOnRequestFail) {
      return;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `Warning: could not check for a pending request on conversation ${data.conversationId} (${message}) — the conversation was continued successfully regardless.\n`,
    );
  }
  printDelegateResult('continue', data, jsonMode);
}

/** The selector names a Conversation; only the legacy alias requires a Task. */
async function runConversationContinuation(
  apiBase: string,
  conversationId: string,
  input: ContinueForegroundMessageInput,
  onRequest: OnRequestMode,
  jsonMode: boolean,
): Promise<void> {
  let receipt: ForegroundMessageReceipt;
  try {
    receipt = await continueExecutionMessage(apiBase, conversationId, input);
  } catch (error) {
    return handleDelegateFailure(error, getResolvedApiBase());
  }
  const data = {
    ...receipt,
    currentSessionId: receipt.sessionId,
    status: 'dispatched' as const,
  };
  // This is a best-effort snapshot after acceptance, like delegated create.
  // Observation failure must not cause a second provider invocation.
  if (onRequest === 'fail') {
    try {
      let pending:
        | {
            requestId: string;
            requestType: string;
            title: string;
            respondCommand: string;
          }
        | undefined;
      if (input.environment?.kind === 'saved') {
        // Existing remote Task supervision remains available. A remote
        // non-Task Conversation may refuse this probe; report that gap below
        // without inventing a Task or reading a same-named local Session.
        const observed = await observeDelegatedTask(
          apiBase,
          receipt.conversationId,
          { environmentId: input.environment.id },
        );
        if (observed.pendingRequest)
          pending = {
            requestId: observed.pendingRequest.id,
            requestType: observed.pendingRequest.type ?? 'unknown',
            title: observed.pendingRequest.title ?? '',
            respondCommand: `${buildDelegateRespondCommand(observed.taskId, observed.pendingRequest.id)} --on=${shellQuote(input.environment.id)}`,
          };
      } else {
        const observed = (
          await listPendingForThread(apiBase, receipt.sessionId)
        )[0];
        if (observed)
          pending = {
            requestId: observed.requestId,
            requestType: observed.requestType,
            title: observed.title,
            respondCommand: buildApprovalsRespondCommand(
              receipt.sessionId,
              observed.requestId,
            ),
          };
      }
      if (pending) {
        if (jsonMode)
          printDelegateResult(
            'continue',
            { ...data, pendingRequest: pending },
            true,
          );
        else
          console.log(
            `Conversation ${receipt.conversationId} has a pending request in Session ${receipt.sessionId}: ${pending.requestId}\nRespond: ${pending.respondCommand}`,
          );
        process.exit(EXIT_ON_REQUEST_FAIL);
        return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `Warning: could not check for a pending request on conversation ${receipt.conversationId} (${message}) — the conversation was continued successfully regardless.\n`,
      );
    }
  }
  printDelegateResult('continue', data, jsonMode);
}

async function runDelegateRespond(
  apiBase: string,
  parsed: ParsedCoreArgs,
  jsonMode: boolean,
): Promise<void> {
  const taskId = requirePositional(parsed, 1, 'task id');
  const requestId = requirePositional(parsed, 2, 'request id');
  const decision = requirePositional(parsed, 3, 'decision');
  if (!VALID_DECISIONS.includes(decision as ApprovalDecision)) {
    throw new Error(
      `Unknown decision: ${decision}. Use one of: ${VALID_DECISIONS.join(', ')}.`,
    );
  }
  const environment = executionEnvironment(parsed);
  const environmentId =
    environment.kind === 'saved' ? environment.id : undefined;
  try {
    const data = await respondToDelegatedTaskRequest(apiBase, taskId, {
      requestId,
      decision: decision as ApprovalDecision,
      ...(environmentId ? { environmentId } : {}),
    });
    printDelegateResult('respond', data, jsonMode);
  } catch (error) {
    handleDelegateFailure(error, getResolvedApiBase());
  }
}

async function runDelegateInterrupt(
  apiBase: string,
  parsed: ParsedCoreArgs,
  jsonMode: boolean,
): Promise<void> {
  const taskId = requirePositional(parsed, 1, 'task id');
  const environment = executionEnvironment(parsed);
  const environmentId =
    environment.kind === 'saved' ? environment.id : undefined;
  try {
    const data = await interruptDelegatedTask(
      apiBase,
      taskId,
      environmentId ? { environmentId } : undefined,
    );
    printDelegateResult('interrupt', data, jsonMode);
  } catch (error) {
    handleDelegateFailure(error, getResolvedApiBase());
  }
}

async function runDelegateTargets(
  apiBase: string,
  parsed: ParsedCoreArgs,
  jsonMode: boolean,
): Promise<void> {
  const environment = executionEnvironment(parsed);
  const environmentId =
    environment.kind === 'saved' ? environment.id : undefined;
  const projectSlug = optionalValueFlag(parsed, 'project');
  const projectPath = optionalValueFlag(parsed, 'project-path');
  if (projectSlug && projectPath) {
    throw new Error('Use --project or --project-path, not both.');
  }
  try {
    const data = await discoverDelegationOptions(apiBase, {
      ...(environmentId ? { environmentId } : {}),
      ...(projectSlug ? { projectSlug } : {}),
      ...(projectPath ? { projectPath } : {}),
    });
    printDelegateResult('targets', data, jsonMode);
  } catch (error) {
    handleDelegateFailure(error, getResolvedApiBase());
  }
}

/**
 * #2264 — `station delegate wait <task-id>`: bounded, observation-only
 * completion waiting.
 *
 * Honesty contract (the reason this command exists):
 *
 * - TERMINAL provider outcomes come from the server's own status field.
 *   `completed` → exit 0; `failed`/`canceled` → exit 3.
 * - NEEDS USER ACTION (`pendingRequest` present, or status `needs_input`/
 *   `review_pending`/`blocked`) → exit 4 — the same exit `--on-request=fail`
 *   uses for "a request is pending, the task is alive and waiting on you".
 * - The caller's WAIT BUDGET expiring while the task is still active →
 *   exit 5. This is NOT task completion or failure: the delegated task keeps
 *   running and the output says so.
 * - The server reporting `unknown` (or a future status value this CLI cannot
 *   classify) → exit 6. Observation ambiguity is never laundered into
 *   completion or failure.
 * - OBSERVATION LOSS (a status read failed — transport error, HTTP failure,
 *   or a read bounded out by the remaining wait budget) → exit 2, the same
 *   transport-failure exit every other delegate verb uses. The last good
 *   observation is reported and explicitly NOT classified as a task failure.
 * - Ctrl-C → exit 130. The delegated task is unaffected; the message says so.
 *
 * The engine's execution budget (`supervision`, #2269) is server state this
 * command only displays — waiting longer than it, or shorter than it, never
 * dispatches, interrupts, or extends anything. There is deliberately no
 * progress-based kill policy and no heartbeat-driven wait extension: the
 * budget the operator passed is the budget that applies.
 */

const WAIT_DEFAULT_TIMEOUT_SECONDS = 3600;
const WAIT_MAX_TIMEOUT_SECONDS = 86400;
const WAIT_DEFAULT_INTERVAL_SECONDS = 5;
const WAIT_MAX_INTERVAL_SECONDS = 3600;

export type DelegateWaitOutcome =
  | 'completed'
  | 'failed'
  | 'needs-action'
  | 'wait-timeout'
  | 'observation-lost'
  | 'unknown'
  | 'interrupted';

/** Documented `delegate wait` exit codes (delegate-scoped, like AC9's). */
const WAIT_EXIT_CODES: Record<DelegateWaitOutcome, number> = {
  completed: 0,
  'observation-lost': 2,
  failed: 3,
  'needs-action': 4,
  'wait-timeout': 5,
  unknown: 6,
  interrupted: 130,
};

export interface DelegateWaitResult {
  outcome: DelegateWaitOutcome;
  exitCode: number;
  taskId: string;
  /** Observed identifiers — the actual conversation/child Session at the last observation. */
  conversationId?: string;
  currentSessionId?: string;
  /** The canonical status as last observed, when any observation succeeded. */
  status?: DelegatedTaskSnapshot['status'];
  pendingRequest?: DelegatedTaskPendingRequest;
  reason?: DelegatedTaskReason;
  transitionReason?: string;
  /** The current child Session changed under us (a continuation replaced it); the wait continued. */
  sessionChanged: boolean;
  previousSessionId?: string;
  pollCount: number;
  elapsedMs: number;
  timeoutMs: number;
  intervalMs: number;
  /** Set for `observation-lost`: why the last read failed (never a task verdict). */
  lastError?: string;
  /** The last successful status snapshot, when one exists, for human rendering. */
  lastSnapshot?: DelegatedTaskSnapshot;
}

export interface DelegateWaitDeps {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * The single observation seam. Defaults to `observeDelegatedTask` bounded
   * by the caller-supplied budget (`timeoutMs: remaining`), so a hung read
   * can never run past the wait deadline. Tests inject a fake here — which
   * also proves the wait loop touches nothing else on the delegation API.
   */
  observe?: (budgetMs: number) => Promise<DelegatedTaskSnapshot>;
  /** Cooperative abort (Ctrl-C): checked before each poll and during sleeps. */
  signal?: AbortSignal;
  onPoll?: (snapshot: DelegatedTaskSnapshot, elapsedMs: number) => void;
}

/**
 * One honest classification of a status snapshot. Unknown/unrecognized
 * statuses (including a future server value this CLI has never heard of)
 * return `unknown` rather than being folded into success or failure.
 */
function classifySnapshot(
  snapshot: DelegatedTaskSnapshot,
): DelegateWaitOutcome | 'active' {
  switch (snapshot.status) {
    case 'completed':
      return 'completed';
    case 'failed':
    case 'canceled':
      return 'failed';
    case 'unknown':
      return 'unknown';
    default:
      break;
  }
  if (snapshot.pendingRequest) return 'needs-action';
  if (
    snapshot.status === 'needs_input' ||
    snapshot.status === 'review_pending' ||
    snapshot.status === 'blocked'
  ) {
    return 'needs-action';
  }
  if (snapshot.status === 'queued' || snapshot.status === 'running') {
    return 'active';
  }
  // A status value this CLI version does not know is honest unknown, not a guess.
  return 'unknown';
}

export async function waitOnDelegatedTask(input: {
  apiBase: string;
  taskId: string;
  environmentId?: string;
  timeoutMs: number;
  intervalMs: number;
  deps?: DelegateWaitDeps;
}): Promise<DelegateWaitResult> {
  const deps = input.deps ?? {};
  const now = deps.now ?? Date.now;
  const signal = deps.signal;
  const observe =
    deps.observe ??
    ((budgetMs: number) =>
      observeDelegatedTask(
        input.apiBase,
        input.taskId,
        input.environmentId
          ? { environmentId: input.environmentId }
          : undefined,
        // Bound each HTTP observation by the remaining wait budget so a hung
        // read cannot silently outwait the deadline (explicit timeoutMs wins
        // over the host default — see sdk/client/http.ts).
        { timeoutMs: budgetMs },
      ));
  const sleep =
    deps.sleep ??
    ((ms: number) => {
      if (signal?.aborted) return Promise.resolve();
      return new Promise<void>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const cleanup = () => {
          if (timer) clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
        };
        const onAbort = () => {
          cleanup();
          resolve();
        };
        timer = setTimeout(() => {
          cleanup();
          resolve();
        }, ms);
        signal?.addEventListener('abort', onAbort);
      });
    });

  const start = now();
  const deadline = start + input.timeoutMs;
  const base: Omit<DelegateWaitResult, 'outcome' | 'exitCode'> = {
    taskId: input.taskId,
    sessionChanged: false,
    previousSessionId: undefined,
    pollCount: 0,
    elapsedMs: 0,
    timeoutMs: input.timeoutMs,
    intervalMs: input.intervalMs,
  };
  let lastSnapshot: DelegatedTaskSnapshot | undefined;
  let lastError: string | undefined;

  const finish = (
    outcome: DelegateWaitOutcome,
    extra?: Partial<DelegateWaitResult>,
  ): DelegateWaitResult => ({
    ...base,
    outcome,
    exitCode: WAIT_EXIT_CODES[outcome],
    ...(lastSnapshot
      ? {
          conversationId: lastSnapshot.conversationId,
          currentSessionId: lastSnapshot.currentSessionId,
          status: lastSnapshot.status,
          pendingRequest: lastSnapshot.pendingRequest,
          reason: lastSnapshot.reason,
          transitionReason: lastSnapshot.transitionReason,
          lastSnapshot,
        }
      : {}),
    elapsedMs: now() - start,
    lastError,
    ...extra,
  });

  while (true) {
    if (signal?.aborted) return finish('interrupted');
    const remaining = deadline - now();
    if (remaining <= 0) {
      // Last successful observation was active (or there was none): the wait
      // budget expired. If the very first read already failed, that is an
      // observation loss, not a running task we outlasted.
      return lastSnapshot ? finish('wait-timeout') : finish('observation-lost');
    }
    try {
      const snapshot = await observe(remaining);
      const previous = lastSnapshot;
      lastSnapshot = snapshot;
      base.pollCount += 1;
      if (previous && previous.currentSessionId !== snapshot.currentSessionId) {
        // A continuation replaced the child Session. Observation only: keep
        // waiting, and report the actual observed identifiers at the end.
        base.sessionChanged = true;
        base.previousSessionId = previous.currentSessionId;
      }
      deps.onPoll?.(snapshot, now() - start);
      const classified = classifySnapshot(snapshot);
      if (classified !== 'active') return finish(classified);
    } catch (error) {
      // A polling failure is an observation loss, never a task failure — and
      // never a reason to redispatch anything. Report and stop.
      lastError = error instanceof Error ? error.message : String(error);
      return finish('observation-lost');
    }
    const sleepMs = Math.min(input.intervalMs, deadline - now());
    if (sleepMs > 0) await sleep(sleepMs);
  }
}

/**
 * Strict positive whole seconds, mirroring `environment access request`'s
 * `--timeout` convention. `/^\d+$/` deliberately rejects `1.5`, `1e3`,
 * `-1`, `NaN`, `Infinity`, and empty strings — malformed, nonfinite, and
 * out-of-range values are usage errors before any request.
 */
function parseWaitSeconds(
  parsed: ParsedCoreArgs,
  name: 'timeout' | 'interval',
  fallback: number,
  max: number,
): number {
  const raw = optionalValueFlag(parsed, name);
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error(
      `--${name} must be a positive whole number of seconds (1–${max}).`,
    );
  }
  const value = Number(raw);
  if (value < 1 || value > max) {
    throw new Error(`--${name} must be between 1 and ${max} seconds.`);
  }
  return value;
}

function formatWaitOutcomeLine(result: DelegateWaitResult): string {
  const ids = lastObservedIds(result);
  switch (result.outcome) {
    case 'completed':
      return `Task ${result.taskId} completed after ${formatDurationMs(result.elapsedMs)}${ids}.`;
    case 'failed':
      return `Task ${result.taskId} reached a terminal failure (status: ${result.status})${ids}.`;
    case 'needs-action':
      return `Task ${result.taskId} needs your action before it can continue${ids}.`;
    case 'wait-timeout':
      return `Wait deadline reached after ${formatDurationMs(result.timeoutMs)}; task ${result.taskId} is still active (status: ${result.status})${ids}. The task keeps running — waiting is observation only and never stops it.`;
    case 'observation-lost':
      return `Observation lost while waiting on task ${result.taskId}: ${result.lastError}${result.status ? ` Last observed status: ${result.status}${ids}.` : ' No status was ever observed.'} An observation failure is not a task failure.`;
    case 'unknown':
      return `Task ${result.taskId} reported status '${result.status ?? 'unknown'}', which this CLI cannot classify${ids}.`;
    case 'interrupted':
      return `Interrupted while waiting on task ${result.taskId}${result.status ? ` (last observed status: ${result.status})` : ''}. The delegated task is unaffected and keeps running.`;
  }
}

function lastObservedIds(result: DelegateWaitResult): string {
  if (!result.conversationId) return '';
  return ` — conversation ${result.conversationId}, current Session ${result.currentSessionId}`;
}

async function runDelegateWait(
  apiBase: string,
  parsed: ParsedCoreArgs,
  jsonMode: boolean,
): Promise<void> {
  const taskId = requirePositional(parsed, 1, 'task id');
  const environment = executionEnvironment(parsed);
  const environmentId =
    environment.kind === 'saved' ? environment.id : undefined;
  const timeoutSeconds = parseWaitSeconds(
    parsed,
    'timeout',
    WAIT_DEFAULT_TIMEOUT_SECONDS,
    WAIT_MAX_TIMEOUT_SECONDS,
  );
  const intervalSeconds = parseWaitSeconds(
    parsed,
    'interval',
    WAIT_DEFAULT_INTERVAL_SECONDS,
    WAIT_MAX_INTERVAL_SECONDS,
  );

  // Ctrl-C is a cooperative observation abort, never a task interrupt: the
  // handler only flips an AbortSignal the wait loop checks.
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.on('SIGINT', onSigint);
  let result: DelegateWaitResult;
  try {
    result = await waitOnDelegatedTask({
      apiBase,
      taskId,
      environmentId,
      timeoutMs: timeoutSeconds * 1000,
      intervalMs: intervalSeconds * 1000,
      deps: {
        signal: controller.signal,
        onPoll: jsonMode
          ? undefined
          : (snapshot, elapsedMs) => {
              // Progress goes to stderr: stdout stays clean for the final
              // summary (and stays empty of chatter entirely under --json).
              process.stderr.write(
                `Task ${taskId}: ${snapshot.status} (elapsed ${formatDurationMs(elapsedMs)}, Session ${snapshot.currentSessionId})\n`,
              );
            },
      },
    });
  } finally {
    process.removeListener('SIGINT', onSigint);
  }

  if (jsonMode) {
    // One clean structured envelope on stdout; no human progress text was
    // mixed in. `ok` is true only when the task genuinely completed — every
    // other outcome is readable from `data.outcome` + the exit code.
    console.log(
      JSON.stringify({
        ok: result.outcome === 'completed',
        kind: 'delegate.wait',
        data: result,
      }),
    );
  } else {
    console.log(formatWaitOutcomeLine(result));
    // The final human rendering reuses `status`'s safe projection (the same
    // secret-minimized summary, budget/reason lines included) — never raw
    // provider logs.
    if (result.lastSnapshot) {
      console.log(formatStatusSummary(result.lastSnapshot));
    }
  }
  process.exit(result.exitCode);
}

export async function runDelegateCommand(
  apiBase: string,
  parsed: ParsedCoreArgs,
): Promise<void> {
  rejectRetiredExecutionSelectors(parsed);
  const jsonMode = parsed.flags.json === true;
  // Only dispatch to a reserved sub-verb when the create-only target flag
  // is present — see the module docblock's "Dispatch" note.
  const hasCreateTarget = Boolean(optionalValueFlag(parsed, 'agent'));
  const conversationId = optionalValueFlag(parsed, 'session');
  if (conversationId) {
    if (hasCreateTarget) {
      throw new Error(
        'Use --agent to start a new delegation or --session to continue a conversation, not both.',
      );
    }
    if (parsed.positionals[0] && RESERVED_ACTIONS.has(parsed.positionals[0])) {
      throw new Error(
        '--session continues a conversation with a message; status, events, respond, and interrupt operate on the current Session/task by their positional id.',
      );
    }
    return runDelegateContinuation(apiBase, parsed, jsonMode, {
      conversationId,
      messageIndex: 0,
    });
  }
  const candidate = parsed.positionals[0];
  const action =
    !hasCreateTarget && candidate && RESERVED_ACTIONS.has(candidate)
      ? candidate
      : undefined;

  switch (action) {
    case 'status':
      return runDelegateStatus(apiBase, parsed, jsonMode);
    case 'events':
      return runDelegateEvents(apiBase, parsed, jsonMode);
    case 'continue':
      return runDelegateContinuation(apiBase, parsed, jsonMode, {
        conversationId: requirePositional(
          parsed,
          1,
          'legacy task or session id',
        ),
        messageIndex: 2,
        deprecatedAlias: true,
      });
    case 'respond':
      return runDelegateRespond(apiBase, parsed, jsonMode);
    case 'interrupt':
      return runDelegateInterrupt(apiBase, parsed, jsonMode);
    case 'targets':
      return runDelegateTargets(apiBase, parsed, jsonMode);
    case 'wait':
      return runDelegateWait(apiBase, parsed, jsonMode);
    default:
      return runDelegateCreate(apiBase, parsed, jsonMode);
  }
}
