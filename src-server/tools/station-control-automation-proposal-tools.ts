/**
 * #4830: an agent proposes Automation sources and rules; a person confirms.
 *
 * - `propose_automation_source`: ask the person to add a GitHub source that
 *   polls a repository's completed workflow runs.
 * - `propose_automation_rule`: ask the person to add a rule that opens a
 *   Task for an Agent when a matching run arrives.
 * - `list_automation_proposals`: this chat's proposals and what became of
 *   them (a confirmed source's id is what a later rule names).
 *
 * The person sees a card in this chat with Station's plain description and
 * confirms or declines it; nothing is created before they confirm. Authority
 * never comes from arguments: the REST side
 * (`routes/orchestration/automation-proposals.ts`) reads the chat from the
 * verified caller and refuses anything wider than the chat could do itself.
 * Loaded by the stdio station-control child too, so it imports nothing from
 * Station's services: it speaks REST (`api`).
 */
import {
  AUTOMATION_EXECUTION_LIMITS,
  AUTOMATION_PROPOSAL_LIMITS,
} from '@kontourai/station-contracts/automation';
import { z } from 'zod';
import type { StationControlToolRegistry } from './station-control-mcp-server.js';
import { api, jsonToolResult } from './station-control-shared.js';

const PROPOSALS_PATH =
  '/api/orchestration/station-control/automation-proposals';

const grantSchema = z.object({
  projectId: z.string().min(1).describe('The Project id (not its slug).'),
  agentId: z.string().min(1).describe('The Agent slug.'),
  actions: z
    .array(z.literal('dispatch-task'))
    .min(1)
    .describe('Only dispatch-task may be proposed.'),
});

const matcherSchema = z.object({
  type: z
    .literal('github.workflow_run.completed')
    .describe('The only event type today.'),
  where: z
    .record(z.string(), z.union([z.string(), z.array(z.string())]))
    .describe(
      'Exact-match conditions on event fields, e.g. {"workflow.path": ".github/workflows/ci.yml", "run.conclusion": ["failure", "timed_out"]}. Fields: repository, workflow.path, run.id, run.run_attempt, run.event, run.conclusion, run.head_branch, run.head_repository, run.head_sha, run.html_url.',
    ),
});

const rationale = z
  .string()
  .min(1)
  .max(AUTOMATION_PROPOSAL_LIMITS.maxRationaleLength)
  .optional()
  .describe('One line on why, shown to the person.');

export function registerAutomationProposalTools(
  registry: StationControlToolRegistry,
) {
  registry.tool(
    'propose_automation_source',
    `Ask the person to add an Automation source that polls a GitHub repository's completed Actions runs (no stored credential). They see a card in this chat describing what it watches and which agents its rules may start; nothing is created until they confirm, and it starts disabled unless they turn it on. Grants may name only dispatch-task, for Project/Agent pairs this chat could start work for itself. Returns the proposal id; once confirmed, list_automation_proposals shows the created source id. At most ${AUTOMATION_PROPOSAL_LIMITS.maxOpenPerConversation} waiting at once.`,
    {
      kind: z.literal('github-poll'),
      name: z.string().min(1).max(AUTOMATION_EXECUTION_LIMITS.maxNameLength),
      repository: z.string().min(1).describe('owner/repo'),
      pollIntervalMs: z
        .number()
        .int()
        .optional()
        .describe(
          `Between ${AUTOMATION_EXECUTION_LIMITS.minPollIntervalMs} and ${AUTOMATION_EXECUTION_LIMITS.maxPollIntervalMs}; default ${AUTOMATION_EXECUTION_LIMITS.defaultPollIntervalMs}.`,
        ),
      grants: z.array(grantSchema).optional(),
      rationale,
    },
    async (args) =>
      jsonToolResult(
        await api(`${PROPOSALS_PATH}/sources`, {
          method: 'POST',
          body: JSON.stringify(args),
        }),
      ),
  );

  registry.tool(
    'propose_automation_rule',
    'Ask the person to add an Automation rule: when a matching GitHub run arrives on a source, open a Task for an Agent with your instructions. They see a card in this chat describing what it watches, what it opens, which agent it wakes and with what limits; nothing is created until they confirm, and it starts observing (recording, never acting) unless they set it live. Name an existing sourceId, or the sourceProposalId of a source this chat proposed (confirm order: source first). It always asks before tool calls and never has full access; the Project/Agent must be one this chat could start work for itself, and the source must grant it.',
    {
      name: z.string().min(1).max(AUTOMATION_EXECUTION_LIMITS.maxNameLength),
      sourceId: z.string().min(1).optional(),
      sourceProposalId: z.string().min(1).optional(),
      match: matcherSchema,
      episode: z
        .object({
          keyFields: z.array(z.string()),
          closeOn: matcherSchema.optional(),
          maxAttempts: z
            .number()
            .int()
            .min(1)
            .max(AUTOMATION_EXECUTION_LIMITS.maxEpisodeAttempts),
        })
        .optional()
        .describe(
          'Group recurring failures: one Task per episode until closeOn matches.',
        ),
      action: z.object({
        kind: z.literal('dispatch-task'),
        projectId: z.string().min(1),
        agentId: z.string().min(1),
        instructions: z
          .string()
          .min(1)
          .max(AUTOMATION_EXECUTION_LIMITS.maxInstructionsLength),
        budget: z.object({
          maxTurns: z
            .number()
            .int()
            .min(1)
            .max(AUTOMATION_EXECUTION_LIMITS.maxBudget.maxTurns),
          maxTokens: z
            .number()
            .int()
            .min(1)
            .max(AUTOMATION_EXECUTION_LIMITS.maxBudget.maxTokens),
          maxWallRuntimeMs: z
            .number()
            .int()
            .min(1)
            .max(AUTOMATION_EXECUTION_LIMITS.maxBudget.maxWallRuntimeMs),
        }),
      }),
      rateLimit: z.object({
        maxStartsPerHour: z
          .number()
          .int()
          .min(1)
          .max(AUTOMATION_EXECUTION_LIMITS.maxStartsPerHour),
      }),
      rationale,
    },
    async (args) =>
      jsonToolResult(
        await api(`${PROPOSALS_PATH}/rules`, {
          method: 'POST',
          body: JSON.stringify(args),
        }),
      ),
  );

  registry.tool(
    'list_automation_proposals',
    "List this chat's Automation proposals, newest first, with their state (open, confirmed, declined) and, once confirmed, the created source or rule id.",
    {},
    async () => jsonToolResult(await api(PROPOSALS_PATH)),
  );
}
