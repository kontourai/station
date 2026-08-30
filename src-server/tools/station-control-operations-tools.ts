import { agentId } from '@kontourai/station-contracts/agent-identity';
import { environmentId as toEnvironmentId } from '@kontourai/station-contracts/execution-target';
import {
  parseIndependentReviewRequest,
  REVIEW_EVIDENCE_OPERATOR_SURFACE,
} from '@kontourai/station-contracts/review-evidence';
import { SCHEDULER_OPERATOR_SURFACE } from '@kontourai/station-contracts/scheduler';
import {
  createJob,
  deleteJob,
  disableJob,
  enableJob,
  fetchAchievements,
  fetchUsage,
  getJobLogs,
  getProject,
  getReviewReceipt,
  getReviewRequestStatus,
  getSchedulerStats,
  getSchedulerStatus,
  listJobs,
  listProjectLayouts,
  listProjects,
  listReviewReceipts,
  listSchedulerProviders,
  migratePreIndexKnowledge,
  previewSchedule,
  rebuildKnowledgeIndex,
  runIndependentReview,
  runJob,
  searchKnowledgeIndex,
  updateJob,
} from '@kontourai/station-sdk/client';
import {
  fromJsonSchema,
  type JsonSchemaType,
} from '@modelcontextprotocol/server';
import { z } from 'zod';
import type * as z3 from 'zod/v3';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { PATH_SEGMENT_PATTERN } from '../knowledge-index/path-safety.js';
import { sshEnvironmentCreateSchema } from '../routes/schemas/schema-definitions/system.js';
import { MAX_SERVER_LOG_QUERY_LIMIT } from '../services/infra/server-log-reader.js';
import { serverLogsRead } from '../telemetry/metrics.js';
import { LOG_LEVEL_ORDER } from '../utils/logger.js';
import {
  continueDelegatedTask,
  delegateTask,
  discoverDelegationEnvironments,
  discoverDelegationOptions,
  executeExecutionTargetMessage,
  interruptDelegatedTask,
  listDelegatedTasks,
  observeDelegatedTask,
  observeDelegatedTaskEvents,
  respondToDelegatedTaskRequest,
} from './station-control-delegation.js';
import type { StationControlToolRegistry } from './station-control-mcp-server.js';

export const MONITORING_ENGINE_FILTER_VALUES = [
  'station',
  'claude',
  'codex',
] as const;

import {
  api,
  controlRequestOptions,
  jsonToolResult,
  navigateTo,
  resolveControlApiBase,
  toToolEnvelope as toOperationsEnvelope,
} from './station-control-shared.js';

/**
 * Scheduler operator tools and `list_projects`/`get_project`/
 * `list_project_layouts`/`get_usage`/`get_achievements` run through
 * `@kontourai/station-sdk/client`'s canonical fetchers instead of this
 * file's own inline `api()` calls, mirroring Wave 2B's approach in
 * `station-control-agent-tools.ts`/`station-control-catalog-tools.ts`.
 * `apiBase` is resolved once at module load (station-control is a
 * long-lived MCP server process — see the matching note in
 * `station-control-agent-tools.ts` and archive#167 plan Risk 3).
 *
 * `system_status`, `list_models`, `navigate_to`, `send_message`,
 * `get_config`, `update_config` are untouched — none are in the archive#167
 * audit's triplication table (config is excluded per `archive#175`; `navigate_to`/
 * `send_message` are station-control-only).
 *
 * `s201-knowledge-retrieval` Wave 4: `reindex_knowledge`/`migrate_knowledge`
 * added here (not a new `station-control-knowledge-tools.ts`) because this
 * file is already the home for explicit, user-triggered admin/operations
 * verbs of exactly this shape (`add_job`/`run_job` are the closest sibling:
 * an explicit action against server-side state, not agent/catalog/platform
 * scoped) — following the existing per-domain split rather than forking a
 * one-tool-pair file. Both call the Wave 3/4 DRY layer
 * (`@kontourai/station-sdk/client`'s `rebuildKnowledgeIndex`/
 * `migratePreIndexKnowledge`, which wrap `POST /api/knowledge/index/rebuild`/
 * `POST /api/knowledge/migrate`) rather than re-implementing the HTTP call
 * inline, per this module family's DRY-layer contract.
 */
// archive#1195: resolved fresh on every call (see station-control-shared.ts's
// `api()` doc comment) -- a module-load-time freeze here would be wrong once
// these same tool registrations are reachable from Station's own long-lived
// process (station-control-mcp-route.ts), not only a freshly-spawned stdio
// child whose env was already correct before the module ever loaded.
function controlApiBase(): string {
  return resolveControlApiBase();
}

const schedulerScheduleSchema = z.discriminatedUnion('kind', [
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

const schedulerJobUpdateSchema = {
  cron: z.string().min(1).optional(),
  schedule: schedulerScheduleSchema.optional(),
  prompt: z.string().min(1).optional(),
  agent: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  notifyStart: z.boolean().optional(),
  trustAllTools: z.boolean().optional(),
  retryCount: z.number().int().min(0).max(10).optional(),
  retryDelaySecs: z.number().int().min(0).max(3600).optional(),
};

const delegationContextSchema = z.object({
  mode: z.literal('isolated-child'),
  depth: z.number().int().nonnegative(),
  maxDepth: z.number().int().positive(),
  parentAgentSlug: z.string().transform(agentId),
  parentConversationId: z.string().optional(),
  rootAgentSlug: z.string().transform(agentId),
  rootConversationId: z.string().optional(),
  allowedTools: z.array(z.string()).optional(),
  blockedTools: z.array(z.string()).optional(),
  denyApprovals: z.boolean().optional(),
});

const sshEnvironmentMcpSchema = fromJsonSchema<
  z3.infer<typeof sshEnvironmentCreateSchema>
>(zodToJsonSchema(sshEnvironmentCreateSchema) as JsonSchemaType);

/**
 * archive#1136: environment MANAGEMENT verbs (create/get/connect/
 * disconnect/remove), reusing the exact HTTP surface and
 * `SshEnvironmentService` the Connections hub UI drives
 * (`routes/operations/ssh-environments.ts`) — no parallel persistence or
 * connect logic lives here. `list_delegation_environments`/
 * `list_delegation_targets` stay read-only, secret-free summaries; these
 * are the write verbs the issue's Gap section asks for, so an agent that
 * discovers it needs a machine no longer has to stop and ask a human to
 * click through Connections.
 *
 * Identifier note: the `id` these five tools take is
 * `SshEnvironmentProfile.id` (assigned at `create_ssh_environment` time,
 * before any connection attempt) — deliberately NOT named `environmentId`
 * like every other tool in this file, because `environmentId` already means
 * something different here: the *verified* remote Station identity that
 * `list_delegation_environments`/`delegate_task`/`get_task`/etc. use, which
 * `SshEnvironmentProfile.environmentId` only receives after a successful
 * `connect_ssh_environment` verifies the remote worker (see
 * `ssh-environment-service.ts#connect`). Reusing `environmentId` for the
 * pre-verification profile id would silently collide two different
 * concepts under one name across this same tool surface.
 *
 * Authorization posture (archive#1136 AC4 — answered explicitly, not left
 * silent): every `station-control-*-tools.ts` call, including every
 * existing *mutating* tool already in this file (`add_job`, `update_config`,
 * `delegate_task`'s downstream chat POST, `respond_to_task_request`, ...),
 * reaches Station's HTTP API as a trusted LOOPBACK caller carrying the
 * per-boot `x-station-internal-token` (`api()` / `controlRequestOptions()`
 * in `station-control-shared.ts`). `runtime-http.ts`'s
 * `configureRuntimeSecurity` classifies that token+loopback combination as
 * `'loopback'` via `classifyAttestedProxyCaller` and calls `next()`
 * *before* `requiredPairingScope`/`resolveGrantedScope` ever run — so the
 * per-device `orchestration:read` / `orchestration:operate` tiering in
 * `pairing-route-scopes.ts` (which raises `/api/environments/ssh`'s
 * mutating methods — `POST /`, `POST /:id/connect`, `POST /:id/disconnect`,
 * `DELETE /:id` — to `orchestration:operate`) never runs for
 * station-control at all, for reads or writes. That is not a bypass
 * introduced by this change: it is the pre-existing, uniform trust boundary
 * for the entire station-control MCP surface. station-control only runs as
 * a subprocess of (or spawned by) the same Station instance it talks to
 * over 127.0.0.1, holding a token no remote caller ever observes or can
 * present. "Authorization parity with the HTTP routes" for this surface
 * therefore precisely means: station-control already acts as a
 * fully-privileged local operator for every mutating route in the product,
 * not as any one paired device's granted scope — these five new tools sit
 * exactly where `add_job` and `update_config` already sit: no new tier, no
 * new bypass, no scope-laundering path that didn't already exist.
 */
const SSH_CONNECT_POLL_TIMEOUT_MS_DEFAULT = 4_000;

function sshConnectPollTimeoutMs(): number {
  const raw = process.env.STATION_SSH_CONNECT_POLL_TIMEOUT_MS;
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : SSH_CONNECT_POLL_TIMEOUT_MS_DEFAULT;
}

/**
 * archive#1136 AC2 (the interesting constraint): `POST /:id/connect` awaits
 * `SshEnvironmentService#connect` to full completion — success, error, or
 * OpenSSH's own ~120s master-connection timeout
 * (`openssh-environment-adapter.ts`'s `waitForMaster`) — before the HTTP
 * response is ever sent. A real host-key confirmation or passphrase prompt
 * can sit unresolved for all of that window with no human near Station's
 * terminal. But `OpenSshTunnel` records the `prompt`/`host-key` phase into
 * `SshEnvironmentService`'s in-memory state *synchronously*, over the same
 * `onStateChange` callback, the instant OpenSSH emits the diagnostic on
 * stderr (`captureDiagnostic`) — long before `connect()`'s own promise
 * settles. So this races the connect POST against a short client-side
 * abort: if the race times out, the connect keeps running server-side
 * unaffected (`SshEnvironmentService#connect` reuses the same in-flight
 * `connectPromise` for a later call on this `id` rather than starting a
 * second one — a caller can safely call `connect_ssh_environment` again to
 * keep polling), and this tool reads back whatever state has already landed
 * via a plain `GET /:id` instead of waiting further. This never supplies a
 * credential or answers the prompt — there is no mechanism here to do
 * either: OpenSSH owns authentication with `stdio: ['inherit', ...]`, so the
 * only way a `prompt`/`host-key` state resolves is a human at Station's own
 * terminal (or a configured `SSH_ASKPASS`).
 */
async function connectSshEnvironmentWithPolling(id: string): Promise<unknown> {
  const connectPath = `/api/environments/ssh/${encodeURIComponent(id)}/connect`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), sshConnectPollTimeoutMs());
  try {
    const result = await api(connectPath, {
      method: 'POST',
      signal: controller.signal,
    });
    return { ...result, polling: false };
  } catch (error) {
    if (!(error instanceof Error) || error.name !== 'AbortError') throw error;
    const polled = await api(`/api/environments/ssh/${encodeURIComponent(id)}`);
    return { ...polled, polling: true };
  } finally {
    clearTimeout(timer);
  }
}

export function registerOperationsTools(server: StationControlToolRegistry) {
  server.tool(
    REVIEW_EVIDENCE_OPERATOR_SURFACE.run.mcp,
    'Run independent read-only reviewers over one exact Git range; findings are evidence input, never a verdict',
    {
      request: z
        .record(z.string(), z.unknown())
        .describe('Canonical IndependentReviewRequest object'),
    },
    async ({ request }) => {
      const parsed = parseIndependentReviewRequest(request);
      return jsonToolResult(
        await toOperationsEnvelope(
          runIndependentReview(
            controlApiBase(),
            parsed,
            controlRequestOptions(),
          ),
        ),
      );
    },
  );

  server.tool(
    REVIEW_EVIDENCE_OPERATOR_SURFACE.status.mcp,
    'Read one idempotent independent-review request status',
    {
      projectSlug: z.string().min(1),
      requestId: z.string().min(1),
    },
    async ({ projectSlug, requestId }) =>
      jsonToolResult(
        await toOperationsEnvelope(
          getReviewRequestStatus(
            controlApiBase(),
            projectSlug,
            requestId,
            controlRequestOptions(),
          ),
        ),
      ),
  );

  server.tool(
    REVIEW_EVIDENCE_OPERATOR_SURFACE.list.mcp,
    'List durable independent-review receipts for a Project',
    { projectSlug: z.string().min(1) },
    async ({ projectSlug }) =>
      jsonToolResult(
        await toOperationsEnvelope(
          listReviewReceipts(
            controlApiBase(),
            projectSlug,
            controlRequestOptions(),
          ),
        ),
      ),
  );

  server.tool(
    REVIEW_EVIDENCE_OPERATOR_SURFACE.read.mcp,
    'Read one attributable independent-review receipt',
    {
      projectSlug: z.string().min(1),
      receiptId: z.string().regex(/^[0-9a-f]{64}$/),
    },
    async ({ projectSlug, receiptId }) =>
      jsonToolResult(
        await toOperationsEnvelope(
          getReviewReceipt(
            controlApiBase(),
            projectSlug,
            receiptId,
            controlRequestOptions(),
          ),
        ),
      ),
  );

  server.tool(
    SCHEDULER_OPERATOR_SURFACE.list.mcp,
    'List scheduled jobs',
    {},
    async () =>
      jsonToolResult(
        await toOperationsEnvelope(
          listJobs(controlApiBase(), controlRequestOptions()),
        ),
      ),
  );

  server.tool(
    SCHEDULER_OPERATOR_SURFACE.create.mcp,
    'Create a cron, interval, or one-shot agent wake-up',
    {
      name: z.string(),
      cron: z.string().optional().describe('Cron expression'),
      schedule: schedulerScheduleSchema
        .optional()
        .describe('Cron, fixed interval, or one-shot schedule'),
      prompt: z.string().describe('Prompt to run'),
      agent: z.string().optional().describe('Agent slug (default: default)'),
      provider: z.string().optional(),
      notifyStart: z.boolean().optional(),
      trustAllTools: z.boolean().optional(),
      retryCount: z.number().int().min(0).max(10).optional(),
      retryDelaySecs: z.number().int().min(0).max(3600).optional(),
    },
    async (params) => {
      if (params.cron !== undefined && params.schedule !== undefined) {
        throw new Error('Use either cron or schedule, not both');
      }
      return jsonToolResult(
        await toOperationsEnvelope(
          createJob(controlApiBase(), params, controlRequestOptions()),
        ),
      );
    },
  );

  server.tool(
    SCHEDULER_OPERATOR_SURFACE.providers.mcp,
    'List scheduler providers',
    {},
    async () =>
      jsonToolResult(
        await toOperationsEnvelope(
          listSchedulerProviders(controlApiBase(), controlRequestOptions()),
        ),
      ),
  );

  server.tool(
    SCHEDULER_OPERATOR_SURFACE.stats.mcp,
    'Read scheduler statistics',
    {},
    async () =>
      jsonToolResult(
        await toOperationsEnvelope(
          getSchedulerStats(controlApiBase(), controlRequestOptions()),
        ),
      ),
  );

  server.tool(
    SCHEDULER_OPERATOR_SURFACE.status.mcp,
    'Read scheduler health',
    {},
    async () =>
      jsonToolResult(
        await toOperationsEnvelope(
          getSchedulerStatus(controlApiBase(), controlRequestOptions()),
        ),
      ),
  );

  server.tool(
    SCHEDULER_OPERATOR_SURFACE.preview.mcp,
    'Preview upcoming cron occurrences',
    {
      cron: z.string().min(1),
      count: z.number().int().min(1).max(100).optional(),
    },
    async ({ cron, count }) =>
      jsonToolResult(
        await toOperationsEnvelope(
          previewSchedule(
            controlApiBase(),
            cron,
            count,
            controlRequestOptions(),
          ),
        ),
      ),
  );

  server.tool(
    SCHEDULER_OPERATOR_SURFACE.logs.mcp,
    'Read durable receipts for a scheduled job',
    {
      name: z.string().min(1),
      count: z.number().int().min(1).max(1000).optional(),
      providerId: z.string().min(1).optional(),
    },
    async ({ name, count, providerId }) =>
      jsonToolResult(
        await toOperationsEnvelope(
          getJobLogs(
            controlApiBase(),
            name,
            { count, providerId },
            controlRequestOptions(),
          ),
        ),
      ),
  );

  server.tool(
    SCHEDULER_OPERATOR_SURFACE.update.mcp,
    'Update a scheduled job',
    { name: z.string().min(1), ...schedulerJobUpdateSchema },
    async ({ name, ...update }) => {
      if (update.cron !== undefined && update.schedule !== undefined) {
        throw new Error('Use either cron or schedule, not both');
      }
      return jsonToolResult(
        await toOperationsEnvelope(
          updateJob(controlApiBase(), name, update, controlRequestOptions()),
        ),
      );
    },
  );

  server.tool(
    SCHEDULER_OPERATOR_SURFACE.run.mcp,
    'Run a job immediately',
    { name: z.string() },
    async ({ name }) =>
      jsonToolResult(
        await toOperationsEnvelope(
          runJob(controlApiBase(), name, controlRequestOptions()),
        ),
      ),
  );

  server.tool(
    SCHEDULER_OPERATOR_SURFACE.enable.mcp,
    'Enable a scheduled job',
    { name: z.string().min(1) },
    async ({ name }) =>
      jsonToolResult(
        await toOperationsEnvelope(
          enableJob(controlApiBase(), name, controlRequestOptions()),
        ),
      ),
  );

  server.tool(
    SCHEDULER_OPERATOR_SURFACE.disable.mcp,
    'Pause a scheduled job',
    { name: z.string().min(1) },
    async ({ name }) =>
      jsonToolResult(
        await toOperationsEnvelope(
          disableJob(controlApiBase(), name, controlRequestOptions()),
        ),
      ),
  );

  server.tool(
    SCHEDULER_OPERATOR_SURFACE.delete.mcp,
    'Delete a scheduled job',
    { name: z.string().min(1) },
    async ({ name }) =>
      jsonToolResult(
        await toOperationsEnvelope(
          deleteJob(controlApiBase(), name, controlRequestOptions()),
        ),
      ),
  );

  server.tool('system_status', 'Get system health and status', {}, async () =>
    jsonToolResult(await api('/api/system/status')),
  );

  server.tool('list_models', 'List available LLM models', {}, async () =>
    jsonToolResult(await api('/api/models')),
  );

  server.tool(
    'read_logs',
    "Read Station's own server logs to debug runtime behavior; filter by minimum level/time/substring. Returns the most recent matches (tail semantics). The local operator (this tool's process-local hop, the operator credential, a same-origin UI-bootstrap / local-grant session) receives unredacted lines; pairing credentials receive the same redacted bytes as before, including over loopback.",
    {
      level: z
        .enum(LOG_LEVEL_ORDER as [string, ...string[]])
        .optional()
        .describe(
          'Minimum severity floor: trace < debug < info < warn < error < fatal',
        ),
      since: z
        .string()
        .optional()
        .describe('ISO 8601 lower time bound (inclusive)'),
      until: z
        .string()
        .optional()
        .describe('ISO 8601 upper time bound (inclusive)'),
      q: z.string().optional().describe('Case-insensitive substring filter'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_SERVER_LOG_QUERY_LIMIT)
        .optional()
        .describe('Max entries to return (default 200, hard cap 1000)'),
    },
    async ({ level, since, until, q, limit }) => {
      const params = new URLSearchParams();
      if (level) params.set('level', level);
      if (since) params.set('since', since);
      if (until) params.set('until', until);
      if (q) params.set('q', q);
      if (limit !== undefined) params.set('limit', String(limit));
      const query = params.toString();
      serverLogsRead.add(1, { surface: 'tool' });
      return jsonToolResult(
        await api(`/api/diagnostics/logs${query ? `?${query}` : ''}`),
      );
    },
  );

  server.tool(
    'read_monitoring_events',
    "Read Station's monitoring events — agent turns and tool calls — to answer questions about its own usage: which tools ran, for which agent or engine, with what outcome and duration. This is a DIFFERENT store from read_logs (which reads server logs and cannot see these). Returns the most recent matches, already redacted before leaving the server.",
    {
      days: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('Look back this many days (default 14)'),
      agent: z.string().optional().describe('Exact agent slug'),
      tool: z.string().optional().describe('Exact tool name'),
      engine: z
        .string()
        .optional()
        .describe(
          `Engine that ran it: ${MONITORING_ENGINE_FILTER_VALUES.map((id) => `'${id}'`).join(', ')}. Absent on events written before engine attribution shipped, so this filter excludes them rather than guessing.`,
        ),
      conversation: z.string().optional().describe('Exact conversation id'),
      tools: z
        .boolean()
        .optional()
        .describe('Only tool call/result events, dropping agent turns'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(5000)
        .optional()
        .describe('Max events to return (default 500, hard cap 5000)'),
    },
    async ({ days, agent, tool, engine, conversation, tools, limit }) => {
      const params = new URLSearchParams();
      if (days !== undefined) params.set('days', String(days));
      if (agent) params.set('agent', agent);
      if (tool) params.set('tool', tool);
      if (engine) params.set('engine', engine);
      if (conversation) params.set('conversation', conversation);
      if (tools) params.set('tools', 'true');
      // The default lives HERE, with the consumer that needs it. The schema
      // above advertises 500, and an agent calling this with no limit pulled
      // the whole retained corpus into its context window. Putting the same
      // default in the shared route instead silently truncated the Monitoring
      // view and `station monitoring events`, neither of which asks for a
      // bound or reads `truncated`.
      params.set('limit', String(limit ?? 500));
      // /monitoring/events, NOT a second reader under /api/insights: this
      // handler already applies the per-user filter and the tenant predicate
      // that these rows require (archive#3076). A parallel export would have
      // to re-derive both authorization layers.
      params.set(
        'start',
        new Date(Date.now() - (days ?? 14) * 86_400_000).toISOString(),
      );
      params.delete('days');
      return jsonToolResult(
        await api(`/monitoring/events?${params.toString()}`),
      );
    },
  );

  server.tool(
    'navigate_to',
    // archive#3567 second fix round FIX 4: qualified rather than left
    // unconditional — in a hosted multi-tenant deployment this command is
    // always refused (no destination identity to route it to one tenant).
    // Check the returned result: {success: false} means it did not navigate.
    'Navigate the Station UI to a specific path (personal-mode deployments only; refused in hosted multi-tenant mode — check the returned result)',
    {
      path: z
        .string()
        .describe(
          'Internal path, e.g. /projects/my-project/layouts/coding or /agents/my-agent',
        ),
    },
    async ({ path }) => jsonToolResult(await navigateTo(path)),
  );

  server.tool('list_projects', 'List all projects', {}, async () =>
    jsonToolResult(
      await toOperationsEnvelope(
        listProjects(controlApiBase(), controlRequestOptions()),
      ),
    ),
  );

  server.tool(
    'get_project',
    'Get project details',
    { slug: z.string() },
    async ({ slug }) =>
      jsonToolResult(
        await toOperationsEnvelope(
          getProject(controlApiBase(), slug, controlRequestOptions()),
        ),
      ),
  );

  server.tool(
    'list_project_layouts',
    'List layouts for a project',
    { slug: z.string() },
    async ({ slug }) =>
      jsonToolResult(
        await toOperationsEnvelope(
          listProjectLayouts(controlApiBase(), slug, controlRequestOptions()),
        ),
      ),
  );

  server.tool(
    'send_message',
    'Send a message to an Agent through the canonical Environment + Agent execution target (non-blocking, returns conversation and resolution receipt)',
    {
      agent: z
        .string()
        .min(1)
        .describe('Agent ID resolved by the selected Station'),
      environmentId: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Verified Station environment ID; omit for the current Station',
        ),
      projectSlug: z.string().min(1).optional(),
      projectPath: z.string().min(1).optional(),
      model: z.string().min(1).optional().describe('Optional model override'),
      message: z.string().describe('Message content'),
      conversationId: z
        .string()
        .optional()
        .describe('Existing conversation ID to continue, or omit for new'),
      navigate: z
        .boolean()
        .optional()
        .describe('Navigate the UI to show this conversation'),
      _delegation: delegationContextSchema.optional(),
      _userId: z.string().optional(),
    },
    async ({
      agent,
      environmentId,
      projectSlug,
      projectPath,
      model,
      message,
      conversationId,
      navigate: shouldNavigate,
      _delegation,
      _userId,
    }) => {
      const target = {
        environment: environmentId
          ? ({ kind: 'saved', id: toEnvironmentId(environmentId) } as const)
          : ({ kind: 'current' } as const),
        agent: agentId(agent),
        ...(model ? { model: { override: model } } : {}),
        ...(projectSlug
          ? {
              workspace: {
                kind: 'project' as const,
                projectSlug,
                ...(projectPath ? { cwd: projectPath } : {}),
              },
            }
          : projectPath
            ? { workspace: { kind: 'directory' as const, cwd: projectPath } }
            : {}),
      };
      const result = await executeExecutionTargetMessage({
        target,
        message,
        ...(conversationId ? { conversationId } : {}),
        ...(_delegation ? { delegation: _delegation } : {}),
        ...(_userId ? { userId: _userId } : {}),
      });
      // archive#3567 fix round FIX 1: `navigateTo`'s own result — `{success:
      // true}` or `{success: false, error}` — was previously discarded, so a
      // hosted deployment (where `/events` denies UI_NAVIGATE by design,
      // since the payload carries no destination identity to route it to
      // one tenant) reported success for a navigation that never reached
      // any client. Surface the real outcome instead of assuming it.
      const navigation = shouldNavigate
        ? await navigateTo(`/agents/${encodeURIComponent(agent)}`)
        : undefined;
      return jsonToolResult(
        navigation === undefined ? result : { ...result, navigation },
      );
    },
  );

  server.tool(
    'list_delegation_environments',
    'List the current Station and saved SSH Stations available for delegation without connecting them or exposing credentials, paths, hosts, usernames, or tunnel details',
    {},
    async () => jsonToolResult(await discoverDelegationEnvironments()),
  );

  server.tool(
    'list_delegation_targets',
    'List secret-free Agents that can accept delegated work, including readiness, models, and control capabilities. Selecting a saved SSH environment may reconnect its verified Station binding.',
    {
      environmentId: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Verified Station environment ID; omit to inspect the current environment',
        ),
      projectSlug: z
        .string()
        .min(1)
        .optional()
        .describe('Project slug on the selected Station environment'),
      projectPath: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Verified project path; inferred for a saved SSH environment when omitted',
        ),
    },
    async (input) => jsonToolResult(await discoverDelegationOptions(input)),
  );

  server.toolWithSchema(
    'create_ssh_environment',
    "Register a new SSH-managed Station environment for later delegation — stores an OpenSSH-alias-backed profile via SshEnvironmentService without connecting it or exchanging any credentials. Returns the profile's `id`, which is NOT the verified `environmentId` used by list_delegation_environments/delegate_task (that is only assigned once connect_ssh_environment successfully verifies the remote Station). `hostAlias` is an OpenSSH alias, hostname, or IP; registering it stores a profile and nothing more. It does NOT make the host reachable: connect_ssh_environment verifies the presented host key against the operator's own ~/.ssh/known_hosts and fails closed on a host they have never confirmed, so a profile for an arbitrary host cannot become an outbound session without the operator having recorded that host key themselves. Mirrors POST /api/environments/ssh.",
    // archive#1136 constraint 4: reused as-is (not re-declared) so adding
    // archive#1133's `launchMode` field there becomes a one-line change here too —
    // no second shape to keep in sync. Do not add `launchMode` ahead of
    // that landing; this slice must not depend on a sibling in-flight
    // worktree.
    sshEnvironmentMcpSchema,
    async (input) =>
      jsonToolResult(
        await api('/api/environments/ssh', {
          method: 'POST',
          body: JSON.stringify(input),
        }),
      ),
  );

  server.tool(
    'get_ssh_environment',
    "Get the full profile and live connection state for one saved SSH environment (richer than list_delegation_environments' secret-free summary): host alias, remote project path, verified project path once connected, and the current SshEnvironmentState phase (idle/starting/prompt/host-key/agent/verifying/connected/error/disconnected). Mirrors GET /api/environments/ssh/:id.",
    {
      id: z
        .string()
        .min(1)
        .describe(
          "SshEnvironmentProfile.id, from create_ssh_environment's response or the Connections hub",
        ),
    },
    async ({ id }) =>
      jsonToolResult(
        await api(`/api/environments/ssh/${encodeURIComponent(id)}`),
      ),
  );

  server.tool(
    'connect_ssh_environment',
    "Start (or resume) connecting a saved SSH environment. Non-blocking: if the connection reaches an interactive host-key confirmation or passphrase/security-key prompt, this returns that state promptly (`polling: true`) rather than waiting out OpenSSH's own multi-minute timeout — call connect_ssh_environment or get_ssh_environment again to keep polling, or hand off to a human at Station's own terminal. Never auto-accepts a host key or supplies a credential; there is no mechanism here to do either. Mirrors POST /api/environments/ssh/:id/connect.",
    { id: z.string().min(1).describe('SshEnvironmentProfile.id') },
    async ({ id }) =>
      jsonToolResult(await connectSshEnvironmentWithPolling(id)),
  );

  server.tool(
    'disconnect_ssh_environment',
    "Stop a connected SSH environment's tunnel. Mirrors POST /api/environments/ssh/:id/disconnect exactly (SshEnvironmentService#disconnect) — the HTTP path performs no active-session drain check before stopping, and this tool intentionally does not add one so both surfaces stay identical.",
    { id: z.string().min(1).describe('SshEnvironmentProfile.id') },
    async ({ id }) =>
      jsonToolResult(
        await api(
          `/api/environments/ssh/${encodeURIComponent(id)}/disconnect`,
          { method: 'POST' },
        ),
      ),
  );

  server.tool(
    'remove_ssh_environment',
    'Permanently remove a saved SSH environment profile, stopping its tunnel first if connected. Mirrors DELETE /api/environments/ssh/:id exactly (SshEnvironmentService#remove) — the HTTP path performs no active-session drain check before removing, and this tool intentionally does not add one so both surfaces stay identical.',
    { id: z.string().min(1).describe('SshEnvironmentProfile.id') },
    async ({ id }) =>
      jsonToolResult(
        await api(`/api/environments/ssh/${encodeURIComponent(id)}`, {
          method: 'DELETE',
        }),
      ),
  );

  server.tool(
    'list_delegated_tasks',
    'Recover a bounded, secret-free inventory of delegated task handles for the authenticated Station user. Selecting a saved SSH environment may reconnect its verified Station binding.',
    {
      environmentId: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Original Station environment ID; omit to inspect the current environment',
        ),
      limit: z.number().int().min(1).max(100).optional().default(50),
      _userId: z.string().optional(),
    },
    async ({ _userId, ...input }) =>
      jsonToolResult(await listDelegatedTasks({ ...input, userId: _userId })),
  );

  server.tool(
    'delegate_task',
    'Delegate a resumable task to an Agent in the current or a verified SSH environment',
    {
      prompt: z.string().min(1).describe('Work to delegate'),
      environmentId: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Verified Station environment ID; omit to use the current environment',
        ),
      projectSlug: z
        .string()
        .min(1)
        .optional()
        .describe('Project slug on the selected Station environment'),
      projectPath: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Verified project path; inferred for a saved SSH environment when omitted',
        ),
      agent: z
        .string()
        .min(1)
        .describe('Agent ID resolved by the selected Station'),
      model: z.string().min(1).optional().describe('Optional model override'),
      sessionId: z
        .string()
        .min(1)
        .optional()
        .describe('Existing task session to resume; omit to create one'),
      parentTaskId: z
        .string()
        .min(1)
        .optional()
        .describe('Parent task for worker or subagent topology'),
      navigate: z.boolean().optional(),
      _delegation: delegationContextSchema.optional(),
      _userId: z.string().optional(),
    },
    async ({ _delegation, _userId, ...input }) => {
      const target = {
        environment: input.environmentId
          ? ({
              kind: 'saved',
              id: toEnvironmentId(input.environmentId),
            } as const)
          : ({ kind: 'current' } as const),
        agent: agentId(input.agent),
        ...(input.model ? { model: { override: input.model } } : {}),
        ...(input.projectSlug
          ? {
              workspace: {
                kind: 'project' as const,
                projectSlug: input.projectSlug,
                ...(input.projectPath ? { cwd: input.projectPath } : {}),
              },
            }
          : input.projectPath
            ? {
                workspace: {
                  kind: 'directory' as const,
                  cwd: input.projectPath,
                },
              }
            : {}),
      };
      const task = await delegateTask({
        prompt: input.prompt,
        target,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
        delegation: _delegation,
        userId: _userId,
      });
      // archive#3567 fix round FIX 1: see the matching comment on
      // `send_message` above — report `navigateTo`'s real outcome instead of
      // assuming delivery.
      const navigation = input.navigate
        ? await navigateTo(`/agents/${encodeURIComponent(task.target.id)}`)
        : undefined;
      return jsonToolResult(
        navigation === undefined ? task : { ...task, navigation },
      );
    },
  );

  server.tool(
    'get_task',
    'Read normalized status for a delegated task and recover state after reconnect',
    {
      taskId: z.string().min(1).describe('Delegated task ID'),
      environmentId: z
        .string()
        .min(1)
        .optional()
        .describe('Original Station environment ID; omit for current'),
      _userId: z.string().optional(),
    },
    async ({ _userId, ...input }) =>
      jsonToolResult(await observeDelegatedTask({ ...input, userId: _userId })),
  );

  server.tool(
    'get_task_events',
    'Read the next bounded page of safe task activity; pass nextCursor to resume without replaying history',
    {
      taskId: z.string().min(1).describe('Delegated task ID'),
      environmentId: z
        .string()
        .min(1)
        .optional()
        .describe('Original Station environment ID; omit for current'),
      cursor: z
        .string()
        .min(1)
        .optional()
        .describe('Opaque nextCursor returned by the previous page'),
      limit: z.number().int().min(1).max(100).optional().default(50),
      _userId: z.string().optional(),
    },
    async ({ _userId, ...input }) =>
      jsonToolResult(
        await observeDelegatedTaskEvents({ ...input, userId: _userId }),
      ),
  );

  server.tool(
    'continue_task',
    'Send a follow-up to an existing delegated task using its persisted environment, target, and project binding',
    {
      taskId: z.string().min(1).describe('Delegated task ID'),
      message: z.string().trim().min(1).describe('Follow-up instruction'),
      environmentId: z
        .string()
        .min(1)
        .optional()
        .describe('Original Station environment ID; omit for current'),
      model: z.string().min(1).optional().describe('Optional model override'),
      _userId: z.string().optional(),
    },
    async ({ _userId, ...input }) =>
      jsonToolResult(
        await continueDelegatedTask({ ...input, userId: _userId }),
      ),
  );

  server.tool(
    'respond_to_task_request',
    'Approve, decline, or cancel an open request from a delegated worker using its persisted task binding',
    {
      taskId: z.string().min(1).describe('Delegated task ID'),
      requestId: z.string().min(1).describe('Open request ID'),
      decision: z.enum(['accept', 'acceptForSession', 'decline', 'cancel']),
      environmentId: z
        .string()
        .min(1)
        .optional()
        .describe('Original Station environment ID; omit for current'),
      _userId: z.string().optional(),
    },
    async ({ _userId, ...input }) =>
      jsonToolResult(
        await respondToDelegatedTaskRequest({ ...input, userId: _userId }),
      ),
  );

  server.tool(
    'interrupt_task',
    'Stop the active turn for a delegated task while keeping it resumable',
    {
      taskId: z.string().min(1).describe('Delegated task ID'),
      environmentId: z
        .string()
        .min(1)
        .optional()
        .describe('Original Station environment ID; omit for current'),
      turnId: z.string().min(1).optional(),
      _userId: z.string().optional(),
    },
    async ({ _userId, ...input }) =>
      jsonToolResult(
        await interruptDelegatedTask({ ...input, userId: _userId }),
      ),
  );

  server.tool(
    'get_config',
    'Get app configuration (default model, theme, features, etc.)',
    {},
    async () => jsonToolResult(await api('/config/app')),
  );

  server.tool(
    'update_config',
    'Update app configuration',
    {
      updates: z
        .record(z.string(), z.any())
        .describe(
          'Key-value pairs to update (e.g. { defaultModel: "claude-sonnet-4-20250514" })',
        ),
    },
    async ({ updates }) =>
      jsonToolResult(
        await api('/config/app', {
          method: 'PUT',
          body: JSON.stringify(updates),
        }),
      ),
  );

  server.tool(
    'get_usage',
    'Get usage analytics (messages, cost, tokens by date)',
    {
      from: z
        .string()
        .optional()
        .describe('Start date (YYYY-MM-DD), defaults to 14 days ago'),
      to: z
        .string()
        .optional()
        .describe('End date (YYYY-MM-DD), defaults to today'),
    },
    async ({ from, to }) =>
      jsonToolResult(
        await fetchUsage(controlApiBase(), from, to, controlRequestOptions()),
      ),
  );

  server.tool(
    'get_achievements',
    'Get usage achievements and milestones',
    {},
    async () =>
      jsonToolResult(
        await fetchAchievements(controlApiBase(), controlRequestOptions()),
      ),
  );

  server.tool(
    'reindex_knowledge',
    'Rebuild the semantic-search knowledge index for one root (or every registered root, if omitted) from the underlying knowledge store — safe to re-run, derived data only',
    {
      rootId: z
        .string()
        .optional()
        .describe(
          'Knowledge store root id to rebuild; omit to rebuild all registered roots',
        ),
    },
    async ({ rootId }) =>
      jsonToolResult(
        await toOperationsEnvelope(
          rebuildKnowledgeIndex(
            controlApiBase(),
            { rootId },
            controlRequestOptions(),
          ),
        ),
      ),
  );

  server.tool(
    'search_knowledge',
    'Semantic search over the knowledge index, optionally scoped to specific store roots — results are re-resolved records (title/excerpt/category), never raw index hits; fails with the NO_EMBEDDER error when no embedding connection is configured',
    {
      query: z.string().min(1).describe('Natural-language search query'),
      rootIds: z
        .array(z.string())
        .optional()
        .describe(
          'Knowledge store root ids to scope the search; omit to search all registered roots',
        ),
      topK: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Maximum number of results (server default when omitted)'),
    },
    async ({ query, rootIds, topK }) =>
      jsonToolResult(
        await toOperationsEnvelope(
          searchKnowledgeIndex(
            controlApiBase(),
            { query, rootIds, topK },
            controlRequestOptions(),
          ),
        ),
      ),
  );

  server.tool(
    'migrate_knowledge',
    'Non-destructively migrate pre-index vectordb/project-knowledge data into a Knowledge store root plus the semantic-search index (or every pre-index namespace, if omitted) — never mutates or deletes the original pre-index files',
    {
      projectSlug: z
        .string()
        .regex(
          PATH_SEGMENT_PATTERN,
          "projectSlug must be a single safe path segment (letters, numbers, dot, underscore, hyphen — no '..' and no path separators)",
        )
        .optional()
        .describe(
          'Project slug to migrate; omit to migrate every pre-index namespace found',
        ),
    },
    async ({ projectSlug }) =>
      jsonToolResult(
        await toOperationsEnvelope(
          migratePreIndexKnowledge(
            controlApiBase(),
            { projectSlug },
            controlRequestOptions(),
          ),
        ),
      ),
  );
}
