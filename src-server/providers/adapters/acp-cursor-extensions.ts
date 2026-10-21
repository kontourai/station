import type {
  InputRequestContent,
  InputRequestForm,
} from '@kontourai/station-contracts/input-request';
import type { PlanEntry } from '@kontourai/station-contracts/runtime-events';
import { ownArray, ownRecord } from '@kontourai/station-shared/input-request';
import { cursorAnswers, cursorInputRequest } from './harness-questions.js';

/**
 * Cursor's agent→client extensions, read and answered exactly as
 * cursor.com/docs/cli/acp documents them (fetched 2026-10-21). Cursor sends
 * the blocking requests without declaring them at `initialize` (checked
 * against `cursor-agent` 2026.05.01), so they are bound by exact method name
 * in `acp-inbound-extension-policy.ts`.
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
/** Bound on the todo entries one plan or update may carry. */
export const CURSOR_TODOS_MAX = 200;
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

export interface CursorQuestion {
  toolCallId: string;
  form: InputRequestForm;
}

/** `cursor/ask_question` params, or null when Station cannot show them. */
export function readCursorAskQuestion(params: unknown): CursorQuestion | null {
  const raw = ownRecord(params);
  if (!raw || !withinPayloadBound(params)) return null;
  const toolCallId = readToolCallId(raw);
  const form = cursorInputRequest(raw);
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

export interface CursorPlan {
  toolCallId: string;
  name?: string;
  overview?: string;
  plan: string;
  todos: CursorTodo[];
}

/** `cursor/create_plan` params, or null when malformed or over bounds. */
export function readCursorCreatePlan(params: unknown): CursorPlan | null {
  const raw = ownRecord(params);
  if (!raw || !withinPayloadBound(params)) return null;
  const toolCallId = readToolCallId(raw);
  const todos = readTodos(raw.todos);
  if (
    !toolCallId ||
    !todos ||
    typeof raw.plan !== 'string' ||
    !raw.plan.trim() ||
    !optionalBoundedText(raw.name, PLAN_NAME_MAX_CHARS) ||
    !optionalBoundedText(raw.overview, PLAN_OVERVIEW_MAX_CHARS)
  )
    return null;
  return {
    toolCallId,
    ...(typeof raw.name === 'string' && raw.name.trim()
      ? { name: raw.name }
      : {}),
    ...(typeof raw.overview === 'string' && raw.overview.trim()
      ? { overview: raw.overview }
      : {}),
    plan: raw.plan,
    todos,
  };
}

export function cursorPlanRejected(reason: string): Record<string, unknown> {
  return { outcome: { outcome: 'rejected', reason } };
}

/** The documented response for a person's review of `cursor/create_plan`. */
export function cursorPlanResponse(
  decision: CursorRequestDecision,
): Record<string, unknown> {
  if (decision === 'accept') return { outcome: { outcome: 'accepted' } };
  if (decision === 'decline')
    return cursorPlanRejected('The person rejected the plan.');
  return { outcome: { outcome: 'cancelled' } };
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
