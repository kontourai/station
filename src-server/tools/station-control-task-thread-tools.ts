import { randomUUID } from 'node:crypto';
import { TASK_REVIEW_LIMITS } from '@kontourai/station-contracts/task-review';
import { z } from 'zod';
import type { StationControlToolRegistry } from './station-control-mcp-server.js';
import { api, jsonToolResult } from './station-control-shared.js';

const root = '/api/orchestration/station-control';
const operationId = z
  .string()
  .optional()
  .describe('Stable operation id for retries; omit for a new operation.');
const threadId = z
  .string()
  .describe('The review thread id returned by task_thread_list.');
const evidence = z
  .object({
    commit: z
      .string()
      .optional()
      .describe(
        'A commit SHA, verified in the Task workspace with git cat-file.',
      ),
    gateRefs: z
      .array(
        z
          .object({
            runId: z.string(),
            gateId: z.string(),
            evaluationId: z.string(),
          })
          .strict(),
      )
      .optional(),
    receiptRefs: z.array(z.string()).optional(),
    captureId: z.string().optional(),
  })
  .strict()
  .optional();

export function registerTaskThreadTools(registry: StationControlToolRegistry) {
  registry.tool(
    'task_thread_list',
    "Read the review threads on this session's bound Task. Only the lead can read or answer them. Unknown freshness stays in Open.",
    {
      state: z.enum(['open', 'outdated', 'resolved']).optional(),
    },
    async (args) =>
      jsonToolResult(
        await api(
          `${root}/task-threads${args.state ? `?state=${encodeURIComponent(args.state)}` : ''}`,
        ),
      ),
  );
  registry.tool(
    'task_thread_reply',
    `Reply to the current delivery on this session's bound Task. Copy deliveryKey from the owner message or task_thread_list; a stale key is refused. A reply to a resolved delivery keeps it resolved. Commit before claiming a commit. Evidence is claimed unless Station verifies it; unresolved gates stay claimed. Body limit: ${TASK_REVIEW_LIMITS.bodyChars} characters. Never changes Task status.`,
    {
      threadId,
      deliveryKey: z
        .string()
        .describe(
          'The exact delivery key from the owner message or task_thread_list.',
        ),
      body: z.string(),
      evidence,
      operationId,
    },
    async (args) =>
      jsonToolResult(
        await api(`${root}/task-thread-reply`, {
          method: 'POST',
          body: JSON.stringify({
            ...args,
            operationId: args.operationId ?? randomUUID(),
          }),
        }),
      ),
  );
  registry.tool(
    'task_thread_resolve',
    "Resolve a review thread on this session's bound Task with a reason. Every event is kept. Never changes Task status. Reopening belongs to the person.",
    {
      threadId,
      reason: z.string(),
      operationId,
    },
    async (args) =>
      jsonToolResult(
        await api(`${root}/task-thread-resolve`, {
          method: 'POST',
          body: JSON.stringify({
            ...args,
            operationId: args.operationId ?? randomUUID(),
          }),
        }),
      ),
  );
}
