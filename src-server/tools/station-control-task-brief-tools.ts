/**
 * `get_task_brief` (epic #4003): a Session dispatched for a Task re-reads the
 * Task's current memory, the same brief it received with its first turn,
 * built now, or a full listing of what that brief only counts.
 *
 * Authority never comes from arguments: `include` only picks what to read.
 * The REST side
 * (`routes/orchestration/task-brief.ts`) derives the session from the
 * verified caller and the Task from that session's own Task binding.
 *
 * Loaded by the stdio station-control child too, so it imports nothing from
 * Station's services: it speaks REST (`api`).
 */
import { z } from 'zod';
import type { StationControlToolRegistry } from './station-control-mcp-server.js';
import { api, jsonToolResult } from './station-control-shared.js';

const TASK_BRIEF_API_PATH = '/api/orchestration/station-control/task-brief';

const GET_TASK_BRIEF_DESCRIPTION =
  "Read the current brief for the Task this session was dispatched for: the Task and its linked tracker item, the Task summary (with its revision, for `task_summary_update`), standing decisions, open questions, recent dead ends, a line per Session of the Task from its recorded activity with its active claims, and what was left out. Call it to catch up on what other Sessions decided or found since you started. It re-reads the linked tracker item (state, labels and comments newer than the Task's last recorded read); a failed read is one line, never an error. `include` lists instead what the brief only counts: `all_records` (every decision, question and dead end, on-topic, answered and retired ones included) or `summary_history` (earlier summary revisions). Fails with `no_task_binding` when this session was not dispatched for a Task.";

const getTaskBriefShape = {
  include: z
    .enum(['all_records', 'summary_history'])
    .optional()
    .describe(
      'Omit for the brief. "all_records" or "summary_history" lists that instead.',
    ),
};

export function registerTaskBriefTools(registry: StationControlToolRegistry) {
  registry.tool(
    'get_task_brief',
    GET_TASK_BRIEF_DESCRIPTION,
    getTaskBriefShape,
    async (args) => {
      // `api` forwards this call's caller credential; the route re-verifies it.
      const body = (await api(
        args.include
          ? `${TASK_BRIEF_API_PATH}?include=${encodeURIComponent(args.include)}`
          : TASK_BRIEF_API_PATH,
      )) as {
        success?: boolean;
        data?: { text?: unknown };
      };
      // The brief and its listings are markdown meant to be read as written,
      // not as an escaped JSON string. Anything else (a refusal) stays a JSON
      // result.
      if (body?.success === true && typeof body.data?.text === 'string')
        return { content: [{ type: 'text' as const, text: body.data.text }] };
      return jsonToolResult(body);
    },
  );
}
