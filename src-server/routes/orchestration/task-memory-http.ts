/**
 * Task memory over HTTP (#4003): the request shapes and the outcome wording
 * both the station-control routes (`task-memory.ts`) and the person's Task
 * workspace routes (`project-task-rooms.ts`) answer with, so an agent and a
 * person meet the same refusals.
 */
import {
  TASK_RECORD_ACTIONS,
  TASK_RECORD_IMPORTANCES,
  TASK_RECORD_KINDS,
  type TaskMemoryRefusal,
  taskMemoryRefusalMessage,
} from '@kontourai/station-contracts/task-memory';
import { z } from 'zod/v3';
import type {
  TaskMemoryAccessRefusal,
  TaskRecordWriteOutcome,
  TaskSummaryUpdateOutcome,
} from '../../services/orchestration/task-memory-store.js';

/** Room for the longest summary with every character JSON-escaped. */
export const TASK_MEMORY_MAX_BODY_BYTES = 64 * 1024;
// Lengths, keys and per-action fields are the contract's refusals
// (`checkTaskRecordWrite`), so a bad value gets its explicit sentence; these
// schemas only shape what the routes will parse.
export const taskSummaryUpdateSchema = z
  .object({
    text: z.string(),
    baseRevision: z.number(),
  })
  .strict();

export const taskRecordWriteSchema = z
  .object({
    kind: z.enum(TASK_RECORD_KINDS),
    key: z.string().max(1024),
    action: z.enum(TASK_RECORD_ACTIONS).optional(),
    text: z.string().optional(),
    importance: z.enum(TASK_RECORD_IMPORTANCES).optional(),
    reason: z.string().optional(),
  })
  .strict();

const REFUSAL_CODES: Record<TaskMemoryRefusal['kind'], string> = {
  'summary-empty': 'task_summary_empty',
  'summary-too-long': 'task_summary_too_long',
  'base-revision-invalid': 'task_summary_base_revision_invalid',
  'kind-invalid': 'task_record_invalid',
  'action-invalid': 'task_record_invalid',
  'importance-invalid': 'task_record_invalid',
  'key-invalid': 'task_record_key_invalid',
  'text-required': 'task_record_invalid',
  'text-too-long': 'task_record_text_too_long',
  'reason-required': 'task_record_invalid',
  'reason-too-long': 'task_record_text_too_long',
  'field-not-allowed': 'task_record_invalid',
  'answer-not-a-question': 'task_record_invalid',
  'record-missing': 'task_record_missing',
  'question-not-open': 'task_record_state_conflict',
  'record-retired': 'task_record_state_conflict',
  'live-cap': 'task_record_cap_reached',
};

/** The refusals that are about the record's current state, not the request. */
const CONFLICTS = new Set<TaskMemoryRefusal['kind']>([
  'record-missing',
  'question-not-open',
  'record-retired',
  'live-cap',
]);

export interface TaskMemoryResponse {
  readonly status: 200 | 400 | 404 | 409 | 503;
  readonly body: Record<string, unknown>;
}

function refused(refusal: TaskMemoryRefusal): TaskMemoryResponse {
  return {
    status: CONFLICTS.has(refusal.kind) ? 409 : 400,
    body: {
      success: false,
      code: REFUSAL_CODES[refusal.kind],
      error: taskMemoryRefusalMessage(refusal),
    },
  };
}

export function accessRefused(
  kind: TaskMemoryAccessRefusal['kind'],
): TaskMemoryResponse {
  if (kind === 'unavailable')
    return {
      status: 503,
      body: {
        success: false,
        code: 'task_memory_unavailable',
        error:
          'Task memory is unavailable right now. Nothing was written; try again.',
      },
    };
  if (kind === 'not-found')
    return { status: 404, body: { success: false, error: 'Task not found' } };
  return {
    status: 409,
    body: {
      success: false,
      code: 'no_task_binding',
      error:
        'This session is not working on a Task, so there is no Task memory to write.',
    },
  };
}

export function taskSummaryResponse(
  outcome: TaskSummaryUpdateOutcome,
): TaskMemoryResponse {
  switch (outcome.kind) {
    case 'updated':
      return {
        status: 200,
        body: {
          success: true,
          status: outcome.unchanged ? 'unchanged' : 'updated',
          taskId: outcome.taskId,
          summary: outcome.summary,
        },
      };
    case 'stale-base': {
      const current = outcome.current;
      return {
        status: 409,
        body: {
          success: false,
          code: 'task_summary_stale_base',
          error: current
            ? `The summary changed: it is at revision ${current.revision}, not the revision you based this on. Nothing was written. Merge your changes into the current text below and write it again with baseRevision ${current.revision}.`
            : 'The Task has no summary yet. Nothing was written. Write it with baseRevision 0.',
          current: current ?? null,
        },
      };
    }
    case 'refused':
      return refused(outcome.refusal);
    default:
      return accessRefused(outcome.kind);
  }
}

export function taskRecordResponse(
  outcome: TaskRecordWriteOutcome,
): TaskMemoryResponse {
  switch (outcome.kind) {
    case 'recorded':
      return {
        status: 200,
        body: {
          success: true,
          status: 'recorded',
          taskId: outcome.taskId,
          record: outcome.record,
        },
      };
    case 'refused':
      return refused(outcome.refusal);
    default:
      return accessRefused(outcome.kind);
  }
}
