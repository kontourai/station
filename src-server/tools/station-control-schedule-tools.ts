/**
 * Scheduling an agent can do whatever engine it runs on:
 *
 * - `schedule_wake_up` / `list_wake_ups` / `cancel_wake_up`: one follow-up
 *   turn into this agent's OWN chat later, with the chat's existing
 *   permissions. The person sees it in the chat and can cancel it.
 * - `propose_job`: ask the person to create a scheduled job. The person sees
 *   an approval card in the chat; nothing is created until they approve.
 *
 * Authority never comes from arguments: the REST side
 * (`routes/orchestration/agent-schedule.ts`) reads the chat from the verified
 * caller. Loaded by the stdio station-control child too, so it imports
 * nothing from Station's services: it speaks REST (`api`).
 */
import {
  AGENT_WAKE_UP_MAX_HORIZON_MS,
  AGENT_WAKE_UP_MAX_PENDING_PER_CONVERSATION,
  AGENT_WAKE_UP_NOTE_MAX_CHARS,
} from '@kontourai/station-contracts/agent-schedule';
import { z } from 'zod';
import type { StationControlToolRegistry } from './station-control-mcp-server.js';
import { api, jsonToolResult } from './station-control-shared.js';

const WAKE_UPS_PATH = '/api/orchestration/station-control/wake-ups';
const JOB_PROPOSALS_PATH = '/api/orchestration/station-control/job-proposals';

const MAX_HOURS = AGENT_WAKE_UP_MAX_HORIZON_MS / 3_600_000;

const scheduleSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('cron'),
    expr: z.string().min(1),
    timezone: z.string().min(1).optional(),
  }),
  z.object({ kind: z.literal('every'), everyMs: z.number().int().positive() }),
  z.object({
    kind: z.literal('at'),
    timeMs: z.number().finite(),
    deleteAfterRun: z.boolean().optional(),
  }),
]);

export function registerScheduleTools(registry: StationControlToolRegistry) {
  registry.tool(
    'schedule_wake_up',
    `Check back in this chat later: Station sends you one follow-up turn after \`minutes\`, carrying your \`note\`. It runs with this chat's current permissions. Only this chat; at most ${MAX_HOURS} hours ahead, ${AGENT_WAKE_UP_MAX_PENDING_PER_CONVERSATION} waiting at once, a note of ${AGENT_WAKE_UP_NOTE_MAX_CHARS} characters. If a turn is running then, it waits for it to end. The person sees it in the chat and can cancel it.`,
    {
      minutes: z.number().describe('How many minutes from now (at least 1).'),
      note: z
        .string()
        .min(1)
        .describe('What to check when you wake; sent back to you verbatim.'),
    },
    async ({ minutes, note }) =>
      jsonToolResult(
        await api(WAKE_UPS_PATH, {
          method: 'POST',
          body: JSON.stringify({ delayMs: minutes * 60_000, note }),
        }),
      ),
  );

  registry.tool(
    'list_wake_ups',
    "List this chat's check-backs that are still waiting.",
    {},
    async () => jsonToolResult(await api(WAKE_UPS_PATH)),
  );

  registry.tool(
    'cancel_wake_up',
    'Cancel one of this chat’s waiting check-backs by its id.',
    { id: z.string().min(1).describe('The id schedule_wake_up returned.') },
    async ({ id }) =>
      jsonToolResult(
        await api(`${WAKE_UPS_PATH}/${encodeURIComponent(id)}`, {
          method: 'DELETE',
        }),
      ),
  );

  registry.tool(
    'propose_job',
    'Ask the person to create a scheduled job. They see an approval card in this chat with the name, schedule, prompt and agent; approving creates it as theirs, declining records that. Use it when you cannot create a job yourself, or for work that should outlive this chat. Returns the proposal id and `open`.',
    {
      name: z
        .string()
        .describe(
          'Lowercase letters, digits and hyphens, e.g. "nightly-digest".',
        ),
      schedule: scheduleSchema.describe(
        'cron (with an IANA timezone), every (interval in ms), or at (epoch ms, once).',
      ),
      prompt: z.string().min(1).describe('What the job runs each time.'),
      agent: z.string().min(1).optional().describe('Agent slug to run it.'),
      rationale: z
        .string()
        .min(1)
        .max(2000)
        .optional()
        .describe('One line on why, shown to the person.'),
    },
    async (args) =>
      jsonToolResult(
        await api(JOB_PROPOSALS_PATH, {
          method: 'POST',
          body: JSON.stringify(args),
        }),
      ),
  );
}
