import type {
  InputRequestContent,
  InputRequestForm,
} from '@kontourai/station-contracts/input-request';
import { INPUT_REQUEST_SCHEMA } from '@kontourai/station-contracts/input-request';
import type { PlanEntry } from '@kontourai/station-contracts/runtime-events';
import {
  INPUT_REQUEST_MAX_MESSAGE_CHARS,
  ownArray,
  ownRecord,
  readInputRequestForm,
} from '@kontourai/station-shared/input-request';
import { cursorAnswers, cursorInputRequest } from './harness-questions.js';

/**
 * Cursor's agent→client extensions, read and answered exactly as
 * cursor.com/docs/cli/acp documents them (fetched 2026-10-21). Cursor sends
 * the blocking requests without declaring them at `initialize` (checked
 * against `cursor-agent` 2026.05.01), so they are bound by exact method name
 * in `acp-inbound-extension-policy.ts`. Any engine may send them, so every
 * label names the connection that did, never Cursor.
 *
 * Both blocking responses nest their result under `outcome`; Cursor reads
 * `result.outcome.outcome`, and a flat `{ outcome: 'accepted' }` reads to it
 * as a cancellation.
 */

/**
 * Bound on one inbound Cursor payload, as serialized JSON. Larger payloads
 * are refused with the documented refusal outcome rather than shown cut.
 */
export const CURSOR_PAYLOAD_MAX_JSON_CHARS = 256 * 1024;
/** Bound on the todo entries one plan (phases included) or update may carry. */
const CURSOR_TODOS_MAX = 200;
const TODO_CONTENT_MAX_CHARS = 2000;
const TODO_ID_MAX_CHARS = 256;
const PLAN_NAME_MAX_CHARS = 200;
const PLAN_OVERVIEW_MAX_CHARS = 4000;
const TOOL_CALL_ID_MAX_CHARS = 256;

type CursorTodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';
const TODO_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'in_progress',
  'completed',
  'cancelled',
]);

export interface CursorTodo {
  id: string;
  content: string;
  status: CursorTodoStatus;
}

export type CursorRequestDecision = 'accept' | 'decline' | 'cancel';

function withinPayloadBound(params: unknown): boolean {
  try {
    return (
      (JSON.stringify(params)?.length ?? 0) <= CURSOR_PAYLOAD_MAX_JSON_CHARS
    );
  } catch {
    return false;
  }
}

function boundedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max;
}

function optionalBoundedText(value: unknown, max: number): boolean {
  return value === undefined || boundedText(value, max);
}

function readToolCallId(params: Record<string, unknown>): string | null {
  const id = params.toolCallId;
  return boundedText(id, TOOL_CALL_ID_MAX_CHARS) && id.trim() ? id : null;
}

/** Cursor's todo list, or null when any entry is malformed or over bounds. */
function readTodos(value: unknown): CursorTodo[] | null {
  const list = ownArray(value);
  if (!list || list.length > CURSOR_TODOS_MAX) return null;
  const todos: CursorTodo[] = [];
  for (const entry of list) {
    const todo = ownRecord(entry);
    if (
      !todo ||
      !boundedText(todo.id, TODO_ID_MAX_CHARS) ||
      !todo.id ||
      !boundedText(todo.content, TODO_CONTENT_MAX_CHARS) ||
      typeof todo.status !== 'string' ||
      !TODO_STATUSES.has(todo.status)
    )
      return null;
    todos.push({
      id: todo.id,
      content: todo.content,
      status: todo.status as CursorTodoStatus,
    });
  }
  return todos;
}

/**
 * Station's plan surface has no cancelled state, so a cancelled todo is
 * left off the plan rather than shown as pending or done.
 */
export function cursorTodosToPlanEntries(todos: CursorTodo[]): PlanEntry[] {
  return todos.flatMap((todo) =>
    todo.status === 'cancelled'
      ? []
      : [{ content: todo.content, status: todo.status }],
  );
}

// --- cursor/ask_question -------------------------------------------------

interface CursorQuestion {
  toolCallId: string;
  form: InputRequestForm;
}

/** `cursor/ask_question` params, or null when Station cannot show them. */
export function readCursorAskQuestion(
  params: unknown,
  requester: string,
): CursorQuestion | null {
  const raw = ownRecord(params);
  if (!raw || !withinPayloadBound(params)) return null;
  const toolCallId = readToolCallId(raw);
  const form = cursorInputRequest(raw, requester);
  return toolCallId && form ? { toolCallId, form } : null;
}

export function cursorQuestionSkipped(reason: string): Record<string, unknown> {
  return { outcome: { outcome: 'skipped', reason } };
}

/** The documented response for a person's answer to `cursor/ask_question`. */
export function cursorQuestionResponse(
  decision: CursorRequestDecision,
  form: InputRequestForm,
  params: unknown,
  content: InputRequestContent | undefined,
): Record<string, unknown> {
  if (decision === 'accept' && content)
    return {
      outcome: {
        outcome: 'answered',
        answers: cursorAnswers(form, params, content),
      },
    };
  if (decision === 'decline')
    return cursorQuestionSkipped('The person declined to answer.');
  return { outcome: { outcome: 'cancelled' } };
}

// --- cursor/create_plan --------------------------------------------------

interface CursorPlan {
  toolCallId: string;
  name?: string;
  /** Top-level todos, then each phase's todos labelled with its phase. */
  todos: CursorTodo[];
  form: InputRequestForm;
}

/** The plan review's one field, and its two answers. */
const PLAN_REVIEW_FIELD = 'review';
const PLAN_APPROVE = 'approve';
const PLAN_REJECT = 'reject';

/**
 * The plan's todos with each phase's todos flattened in, named by phase. A
 * phase todo that repeats a top-level id replaces that entry, so one todo is
 * never listed twice. Null past {@link CURSOR_TODOS_MAX} or when malformed.
 */
function readPlanTodos(raw: Record<string, unknown>): CursorTodo[] | null {
  const todos = readTodos(raw.todos);
  if (!todos) return null;
  if (raw.phases === undefined) return todos;
  const phases = ownArray(raw.phases);
  if (!phases || phases.length > CURSOR_TODOS_MAX) return null;
  const merged = [...todos];
  for (const entry of phases) {
    const phase = ownRecord(entry);
    const phaseTodos = readTodos(phase?.todos);
    if (
      !phase ||
      !phaseTodos ||
      !boundedText(phase.name, PLAN_NAME_MAX_CHARS) ||
      !phase.name.trim()
    )
      return null;
    for (const todo of phaseTodos) {
      const labelled = { ...todo, content: `${phase.name}: ${todo.content}` };
      const index = merged.findIndex((other) => other.id === todo.id);
      if (index >= 0) merged[index] = labelled;
      else merged.push(labelled);
    }
  }
  return merged.length > CURSOR_TODOS_MAX ? null : merged;
}

const TODO_STATUS_TEXT: Record<CursorTodoStatus, string> = {
  pending: 'to do',
  in_progress: 'in progress',
  completed: 'done',
  cancelled: 'cancelled',
};

/**
 * The plan review's message, fitted to one form message
 * ({@link INPUT_REQUEST_MAX_MESSAGE_CHARS}) so a person present always gets
 * to decide: the whole plan when it fits; otherwise the todo list becomes a
 * count (an approved plan's todos still reach the plan surface); as a last
 * resort the plan text is cut, with a note saying how much was left out.
 */
function planReviewMessage(
  heading: Array<string | undefined>,
  plan: string,
  todos: CursorTodo[],
): string {
  const join = (sections: Array<string | undefined>) =>
    sections.filter((section) => section !== undefined).join('\n\n');
  const todoList =
    todos.length > 0
      ? `Todos:\n${todos
          .map((todo) => `- ${todo.content} (${TODO_STATUS_TEXT[todo.status]})`)
          .join('\n')}`
      : undefined;
  const whole = join([...heading, plan, todoList]);
  if (whole.length <= INPUT_REQUEST_MAX_MESSAGE_CHARS) return whole;
  const todoCount =
    todos.length > 0
      ? `${todos.length} todos, shown on the plan once approved.`
      : undefined;
  const withoutTodos = join([...heading, plan, todoCount]);
  if (withoutTodos.length <= INPUT_REQUEST_MAX_MESSAGE_CHARS)
    return withoutTodos;
  // Measured with a worst-case note, so the cut message always fits.
  const note = (left: number) =>
    `[Plan truncated for display: ${left} more characters.]`;
  const room =
    INPUT_REQUEST_MAX_MESSAGE_CHARS -
    join([...heading, '', note(plan.length), todoCount]).length;
  let shown = plan.slice(0, Math.max(0, room));
  // Never end on half of a surrogate pair.
  if (/[\uD800-\uDBFF]$/.test(shown)) shown = shown.slice(0, -1);
  return join([...heading, shown, note(plan.length - shown.length), todoCount]);
}

/**
 * `cursor/create_plan` params as a plan review: the plan is the form's
 * message ({@link planReviewMessage}), so the person reads what they approve.
 * Null when malformed or over bounds.
 */
export function readCursorCreatePlan(
  params: unknown,
  requester: string,
): CursorPlan | null {
  const raw = ownRecord(params);
  if (!raw || !withinPayloadBound(params)) return null;
  const toolCallId = readToolCallId(raw);
  const todos = readPlanTodos(raw);
  if (
    !toolCallId ||
    !todos ||
    typeof raw.plan !== 'string' ||
    !raw.plan.trim() ||
    !optionalBoundedText(raw.name, PLAN_NAME_MAX_CHARS) ||
    !optionalBoundedText(raw.overview, PLAN_OVERVIEW_MAX_CHARS)
  )
    return null;
  const message = planReviewMessage(
    [
      typeof raw.name === 'string' && raw.name.trim() ? raw.name : undefined,
      typeof raw.overview === 'string' && raw.overview.trim()
        ? raw.overview
        : undefined,
    ],
    raw.plan,
    todos,
  );
  const form = readInputRequestForm({
    schema: INPUT_REQUEST_SCHEMA,
    source: 'harness:cursor',
    requester,
    message,
    body: {
      kind: 'form',
      fields: [
        {
          name: PLAN_REVIEW_FIELD,
          kind: 'choice',
          title: `Approve ${requester}'s plan?`,
          required: true,
          options: [
            {
              value: PLAN_APPROVE,
              label: 'Approve',
              // Station answers the request only (see docs/guides/agents.md).
              description: `Station doesn't resume ${requester} after approval; send a message to continue.`,
            },
            { value: PLAN_REJECT, label: 'Reject' },
          ],
        },
      ],
    },
  });
  if (!form) return null;
  return {
    toolCallId,
    ...(typeof raw.name === 'string' && raw.name.trim()
      ? { name: raw.name }
      : {}),
    todos,
    form,
  };
}

export function cursorPlanRejected(reason: string): Record<string, unknown> {
  return { outcome: { outcome: 'rejected', reason } };
}

/** The documented response for a person's review of `cursor/create_plan`. */
export function cursorPlanResponse(
  decision: CursorRequestDecision,
  content: InputRequestContent | undefined,
): Record<string, unknown> {
  if (decision === 'accept' && content?.[PLAN_REVIEW_FIELD] === PLAN_APPROVE)
    return { outcome: { outcome: 'accepted' } };
  if (decision === 'cancel') return { outcome: { outcome: 'cancelled' } };
  return cursorPlanRejected('The person rejected the plan.');
}

// --- cursor/update_todos -------------------------------------------------

/**
 * The session's todo list after one `cursor/update_todos` notification:
 * `merge: true` updates entries by id and appends new ones, `merge: false`
 * replaces the list. Null when the notification is malformed, over bounds,
 * or would grow the list past {@link CURSOR_TODOS_MAX}.
 */
export function foldCursorTodos(
  previous: readonly CursorTodo[] | undefined,
  params: unknown,
): CursorTodo[] | null {
  const raw = ownRecord(params);
  if (!raw || typeof raw.merge !== 'boolean' || !withinPayloadBound(params))
    return null;
  const todos = readTodos(raw.todos);
  if (!todos) return null;
  if (!raw.merge) return todos;
  const merged = [...(previous ?? [])];
  for (const todo of todos) {
    const index = merged.findIndex((entry) => entry.id === todo.id);
    if (index >= 0) merged[index] = todo;
    else merged.push(todo);
  }
  return merged.length > CURSOR_TODOS_MAX ? null : merged;
}
