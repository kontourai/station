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
 * Dispatch: the six sub-verb names (`status`, `events`, `continue`,
 * `respond`, `interrupt`, `targets`) are only treated as an action word when
 * `--agent` is not present. `create` is the only verb
 * that takes a target flag, so a bare `station delegate --agent=<slug>
 * status ...` prompt (whose text happens to start with a reserved word) is
 * unambiguously a create call, not a mis-dispatch to `delegate status`. A
 * `--agent`-less create call whose prompt's first word is
 * exactly one of the six reserved words is a known, narrow, and disclosed
 * ambiguity (the CLI reads it as the sub-verb) — not solved here.
 */

import { agentId } from '@kontourai/station-contracts/agent-identity';
import {
  type ApprovalDecision,
  continueDelegatedTask,
  type DelegatedTaskEventPage,
  type DelegatedTaskFollowUpHandle,
  type DelegatedTaskHandle,
  type DelegatedTaskInterruptResult,
  type DelegatedTaskRequestResponseHandle,
  type DelegatedTaskSnapshot,
  type DelegationOptions,
  type DelegationProjectSlugJoin,
  delegateTask,
  discoverDelegationOptions,
  interruptDelegatedTask,
  observeDelegatedTask,
  observeDelegatedTaskEvents,
  respondToDelegatedTaskRequest,
} from '@kontourai/station-sdk/client';
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
  // station#3409: this used to read `dispatched (resumable)`, printed
  // unconditionally at the moment of dispatch. It described a window that
  // closes when the task finishes — which is exactly when a supervisor has
  // read the result and has a follow-up — and nothing here could see that
  // window close. The command is what is true and useful; when it stops
  // working, `station delegate status` now says so.
  lines.push(`Status: ${handle.status}`);
  lines.push(
    `Continue this conversation: ${delegateContinuationCommand(conversationId)}`,
  );
  return lines.join('\n');
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
  if (snapshot.lastEvent) {
    lines.push(
      `Last event: ${snapshot.lastEvent.method}${
        snapshot.lastEvent.createdAt
          ? ` at ${snapshot.lastEvent.createdAt}`
          : ''
      }`,
    );
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
  if (cwd) {
    throw new Error(
      '--cwd has no effect when continuing a conversation: its workspace is fixed when the conversation is created.',
    );
  }
  // station#979: usage error before any request, same as every other flag
  // check above.
  const onRequest = resolveOnRequestMode(parsed);
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
    default:
      return runDelegateCreate(apiBase, parsed, jsonMode);
  }
}
