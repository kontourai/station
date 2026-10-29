/**
 * `task_summary_update` and `task_record` (#4003): an agent writes the Task
 * memory of the Task its own Session is working on. The summary is one
 * bounded runbook the agent rewrites; records are keyed decisions, questions
 * and dead ends.
 *
 * Authority never comes from arguments: the REST side
 * (`routes/orchestration/task-memory.ts`) derives the Session from the
 * verified caller and the Task from that Session's room execution binding.
 * Neither tool can name a Task or change Task status.
 *
 * Loaded by the stdio station-control child too, so it imports nothing from
 * Station's services: it speaks REST (`api`).
 */
import {
  TASK_MEMORY_LIMITS,
  TASK_RECORD_ACTIONS,
  TASK_RECORD_IMPORTANCES,
  TASK_RECORD_KINDS,
} from '@kontourai/station-contracts/task-memory';
import { z } from 'zod';
import type { StationControlToolRegistry } from './station-control-mcp-server.js';
import { api, jsonToolResult } from './station-control-shared.js';

const SUMMARY_API_PATH = '/api/orchestration/station-control/task-summary';
const RECORD_API_PATH = '/api/orchestration/station-control/task-record';
const { liveRecords } = TASK_MEMORY_LIMITS;

const SUMMARY_DESCRIPTION = `Rewrite the summary of the Task this session is working on: one runbook of what is true now, what works, what is next and what is risky. It replaces the whole summary; it is never appended to, and every earlier revision is kept. Update it at milestones and before you stop. \`baseRevision\` is the revision you read (in your Task brief or from \`get_task_brief\`; 0 when the Task has no summary). If someone changed it since, nothing is written and the error carries the current text and revision: merge your changes into that text and write again with its revision. Text over ${TASK_MEMORY_LIMITS.summaryChars} characters is refused, never cut: prune it to what is true now. Never changes the Task's status.`;

const RECORD_DESCRIPTION = `Record a decision, an open question or a dead end in the memory of the Task this session is working on, under a short key (a lowercase slug such as "storage-engine"). \`action\` "set" (the default) creates the record or supersedes the one with the same kind and key; "answer" answers an open question (\`text\` is the answer); "retire" withdraws a record that no longer holds (\`reason\` required). Every version is kept. \`importance\` "standing" (the default) shows the record in every Task brief; "on_topic" only counts it there, for a record that matters to one narrow part of the Task. An open question asks a person: it puts the Task in "Needs you" until answered. At most ${liveRecords.decision} active decisions, ${liveRecords.question} open questions and ${liveRecords.dead_end} active dead ends: past that a new key is refused, so supersede or retire one. Text is at most ${TASK_MEMORY_LIMITS.recordTextChars} characters. Never changes the Task's status.`;

const summaryShape = {
  text: z
    .string()
    .describe(
      `The whole new summary, at most ${TASK_MEMORY_LIMITS.summaryChars} characters.`,
    ),
  baseRevision: z
    .number()
    .int()
    .min(0)
    .describe('The revision you read; 0 when the Task has no summary yet.'),
};

const recordShape = {
  kind: z
    .enum(TASK_RECORD_KINDS)
    .describe('"decision", "question" or "dead_end".'),
  key: z
    .string()
    .describe(
      `A lowercase slug (letters, digits, single hyphens), at most ${TASK_MEMORY_LIMITS.recordKeyChars} characters.`,
    ),
  action: z
    .enum(TASK_RECORD_ACTIONS)
    .optional()
    .describe('"set" (default), "answer" (questions only) or "retire".'),
  text: z
    .string()
    .optional()
    .describe(
      `For set: the record. For answer: the answer. At most ${TASK_MEMORY_LIMITS.recordTextChars} characters.`,
    ),
  importance: z
    .enum(TASK_RECORD_IMPORTANCES)
    .optional()
    .describe(
      'For set only: "standing" (shown in every brief; default) or "on_topic" (counted only).',
    ),
  reason: z
    .string()
    .optional()
    .describe(
      `For retire only: why it no longer holds, at most ${TASK_MEMORY_LIMITS.recordReasonChars} characters.`,
    ),
};

export function registerTaskMemoryTools(registry: StationControlToolRegistry) {
  // `api` forwards each call's caller credential; the routes re-verify it.
  registry.tool(
    'task_summary_update',
    SUMMARY_DESCRIPTION,
    summaryShape,
    async (args) =>
      jsonToolResult(
        await api(SUMMARY_API_PATH, {
          method: 'POST',
          body: JSON.stringify({
            text: args.text,
            baseRevision: args.baseRevision,
          }),
        }),
      ),
  );
  registry.tool('task_record', RECORD_DESCRIPTION, recordShape, async (args) =>
    jsonToolResult(
      await api(RECORD_API_PATH, {
        method: 'POST',
        body: JSON.stringify(args),
      }),
    ),
  );
}
