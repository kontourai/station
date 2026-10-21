/**
 * `get_task_brief` (epic #4003): a Session dispatched for a Task re-reads the
 * Task's current shared memory, the same brief it received with its first
 * turn, built now.
 *
 * Authority never comes from arguments; the tool takes none. The REST side
 * (`routes/orchestration/task-brief.ts`) derives the session from the
 * verified caller and the Task from that session's own Task binding.
 *
 * Loaded by the stdio station-control child too, so it imports nothing from
 * Station's services: it speaks REST (`api`).
 */
import type { StationControlToolRegistry } from './station-control-mcp-server.js';
import { api, jsonToolResult } from './station-control-shared.js';

const TASK_BRIEF_API_PATH = '/api/orchestration/station-control/task-brief';

const GET_TASK_BRIEF_DESCRIPTION =
  "Read the current brief for the Task this session was dispatched for: the Task's title and id, its linked tracker item, the other Sessions working on it and their status, and the Task memory (Decisions, Done, In progress, Open questions), newest first and cut to fit, saying how much was left out. Call it when you need to catch up on what other Sessions decided or finished since you started. It re-reads the linked tracker item (state, labels and comments newer than the Task's last recorded read); a failed read is one line, never an error. Takes no arguments. Fails with `no_task_binding` when this session was not dispatched for a Task.";

export function registerTaskBriefTools(registry: StationControlToolRegistry) {
  registry.tool('get_task_brief', GET_TASK_BRIEF_DESCRIPTION, {}, async () => {
    // `api` forwards this call's caller credential; the route re-verifies it.
    const body = (await api(TASK_BRIEF_API_PATH)) as {
      success?: boolean;
      data?: { text?: unknown };
    };
    // The brief is markdown meant to be read as written, not as an escaped
    // JSON string. Anything else (a refusal) stays a JSON result.
    if (body?.success === true && typeof body.data?.text === 'string')
      return { content: [{ type: 'text' as const, text: body.data.text }] };
    return jsonToolResult(body);
  });
}
