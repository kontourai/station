import { REVIEW_EVIDENCE_OPERATOR_SURFACE } from '@kontourai/station-contracts/review-evidence';
import { SCHEDULER_OPERATOR_SURFACE } from '@kontourai/station-contracts/scheduler';
import { McpServer } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * #167 Wave 3: characterization tests for `station-control-operations-tools.ts`'s
 * audited operations (`list_jobs`, `add_job`, `run_job`, `list_projects`,
 * `get_project`, `list_project_layouts`, `get_usage`, `get_achievements`),
 * written *before* the migration to `@kontourai/station-sdk/client` and run
 * green against the pre-refactor `api()`-based implementation first (per the
 * plan's test-first sequencing), then re-run unmodified after the migration.
 *
 * Follows the same "mock the HTTP boundary" style as the CLI's
 * `core.test.ts`/`core-http.test.ts` (`vi.stubGlobal('fetch', ...)`), since
 * this file has no MCP transport to stand up — a real `McpServer` instance
 * is used (mirroring `station-control-classification.test.ts`'s pattern) so
 * the tool registration path is exercised for real; each tool's `.handler`
 * is invoked directly, bypassing the MCP SDK's own zod-validation dispatch
 * (irrelevant to this file's job of pinning the fetch-and-forward business
 * logic, not JSON-schema validation).
 */

process.env.STATION_API_BASE = 'http://control-ops-test.local';
delete process.env.STATION_PORT;

const API_BASE = 'http://control-ops-test.local';

const reviewRequest = {
  requestId: 'request-1',
  mode: 'initial',
  target: {
    kind: 'git-range',
    projectSlug: 'station',
    baseRevision: 'origin/main',
    headRevision: 'HEAD',
  },
  implementerAgentSlug: 'terra',
  reviewers: [
    {
      reviewerId: 'reviewer-1',
      executorAgentSlug: 'station',
      lens: { id: 'architecture', instructions: 'Review exact seams.' },
    },
  ],
} as const;

const reviewReceipt = {
  schemaVersion: 1,
  receiptId: 'a'.repeat(64),
  requestId: 'request-1',
  mode: 'initial',
  target: {
    ...reviewRequest.target,
    repositoryId: 'github.com/kontourai/station',
    baseSha: '1'.repeat(40),
    headSha: '2'.repeat(40),
    diffSha256: '3'.repeat(64),
  },
  requestedBy: { actorId: 'operator' },
  implementer: { actorId: 'agent:terra' },
  startedAt: '2026-08-16T00:00:00.000Z',
  completedAt: '2026-08-16T00:01:00.000Z',
  executions: [
    {
      reviewerId: 'reviewer-1',
      executorAgentSlug: 'station',
      actor: { actorId: 'agent:sol' },
      lens: reviewRequest.reviewers[0].lens,
      status: 'completed',
      startedAt: '2026-08-16T00:00:00.000Z',
      completedAt: '2026-08-16T00:01:00.000Z',
      findings: [],
      deltaAssessments: [],
    },
  ],
  findings: [],
  deltaAssessments: [],
  interpretation: {
    kind: 'review-findings',
    decision: 'input-only',
    gateVerdict: null,
  },
} as const;

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

type ToolResult = { content: Array<{ type: 'text'; text: string }> };
type ToolHandler = (...args: any[]) => Promise<ToolResult>;

async function registerTools(): Promise<Record<string, ToolHandler>> {
  const { registerOperationsTools } = await import(
    '../station-control-operations-tools.js'
  );
  const { StationControlToolRegistry } = await import(
    '../station-control-mcp-server.js'
  );
  const server = new McpServer({
    name: 'operations-tools-characterization',
    version: '0.0.0',
  });
  registerOperationsTools(new StationControlToolRegistry(server));
  const registry = (
    server as unknown as {
      _registeredTools: Record<string, { handler: ToolHandler }>;
    }
  )._registeredTools;
  const handlers: Record<string, ToolHandler> = {};
  for (const [name, tool] of Object.entries(registry)) {
    handlers[name] = tool.handler;
  }
  return handlers;
}

describe('station-control operations tools (characterization)', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  test('registers every canonical scheduler operator operation', async () => {
    const tools = await registerTools();
    expect(Object.keys(tools)).toEqual(
      expect.arrayContaining(
        Object.values(SCHEDULER_OPERATOR_SURFACE).map(({ mcp }) => mcp),
      ),
    );
  });

  test('registers every canonical independent-review operator operation', async () => {
    const tools = await registerTools();
    expect(Object.keys(tools)).toEqual(
      expect.arrayContaining(
        Object.values(REVIEW_EVIDENCE_OPERATOR_SURFACE).map(({ mcp }) => mcp),
      ),
    );
  });

  test('routes every independent-review operation through the shared strict client', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(
          {
            success: true,
            data: {
              requestId: reviewRequest.requestId,
              projectSlug: 'station',
              state: 'completed',
              startedAt: reviewReceipt.startedAt,
              updatedAt: reviewReceipt.completedAt,
              result: {
                receipt: reviewReceipt,
                attachment: { status: 'not-requested' },
                cleanup: { status: 'completed' },
              },
            },
          },
          201,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            requestId: reviewRequest.requestId,
            projectSlug: 'station',
            state: 'completed',
            startedAt: reviewReceipt.startedAt,
            updatedAt: reviewReceipt.completedAt,
            result: {
              receipt: reviewReceipt,
              attachment: { status: 'not-requested' },
              cleanup: { status: 'completed' },
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: [reviewReceipt] }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: reviewReceipt }),
      );
    const tools = await registerTools();

    await tools.run_independent_review({ request: reviewRequest });
    await tools.get_review_request({
      projectSlug: 'station',
      requestId: reviewRequest.requestId,
    });
    await tools.list_review_receipts({ projectSlug: 'station' });
    await tools.get_review_receipt({
      projectSlug: 'station',
      receiptId: reviewReceipt.receiptId,
    });

    expect(fetchMock.mock.calls).toEqual([
      [
        `${API_BASE}/api/projects/station/reviews`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify(reviewRequest),
        }),
      ],
      [
        `${API_BASE}/api/projects/station/reviews/requests/${reviewRequest.requestId}`,
        expect.objectContaining({ method: 'GET' }),
      ],
      [
        `${API_BASE}/api/projects/station/reviews`,
        expect.objectContaining({ method: 'GET' }),
      ],
      [
        `${API_BASE}/api/projects/station/reviews/${reviewReceipt.receiptId}`,
        expect.objectContaining({ method: 'GET' }),
      ],
    ]);
  });

  test.each([
    ['list_scheduler_providers', {}, '/scheduler/providers', 'GET'],
    ['get_scheduler_stats', {}, '/scheduler/stats', 'GET'],
    ['get_scheduler_status', {}, '/scheduler/status', 'GET'],
    [
      'preview_schedule',
      { cron: '0 9 * * *', count: 3 },
      '/scheduler/jobs/preview-schedule?cron=0+9+*+*+*&count=3',
      'GET',
    ],
    [
      'get_job_logs',
      { name: 'daily', count: 4, providerId: 'built-in' },
      '/scheduler/jobs/daily/logs?count=4&providerId=built-in',
      'GET',
    ],
    [
      'update_job',
      { name: 'daily', prompt: 'Updated' },
      '/scheduler/jobs/daily',
      'PUT',
    ],
    ['enable_job', { name: 'daily' }, '/scheduler/jobs/daily/enable', 'PUT'],
    ['disable_job', { name: 'daily' }, '/scheduler/jobs/daily/disable', 'PUT'],
    ['delete_job', { name: 'daily' }, '/scheduler/jobs/daily', 'DELETE'],
  ])(
    'routes %s through the shared scheduler client',
    async (tool, input, path, method) => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ success: true, data: {} }),
      );
      const tools = await registerTools();
      await tools[tool]!(input);
      expect(fetchMock.mock.calls[0]?.[0]).toBe(`${API_BASE}${path}`);
      expect(fetchMock.mock.calls[0]?.[1]).toEqual(
        expect.objectContaining({ method }),
      );
    },
  );

  test('list_jobs forwards the raw scheduler envelope on success', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: [{ name: 'nightly', cron: '0 0 * * *' }],
      }),
    );
    const tools = await registerTools();

    const result = await tools.list_jobs();

    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            { success: true, data: [{ name: 'nightly', cron: '0 0 * * *' }] },
            null,
            2,
          ),
        },
      ],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(`${API_BASE}/scheduler/jobs`);
  });

  test('list_jobs forwards the error envelope on a scheduler failure', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: false, error: 'scheduler unavailable' }, 500),
    );
    const tools = await registerTools();

    const result = await tools.list_jobs();

    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            { success: false, error: 'scheduler unavailable' },
            null,
            2,
          ),
        },
      ],
    });
  });

  test('add_job posts the job payload and forwards the created-job envelope', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: true, data: { output: 'created' } }, 201),
    );
    const tools = await registerTools();

    const result = await tools.add_job({
      name: 'nightly-report',
      cron: '0 6 * * *',
      prompt: 'Summarize overnight activity',
    });

    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            { success: true, data: { output: 'created' } },
            null,
            2,
          ),
        },
      ],
    });
    expect(fetchMock.mock.calls[0][0]).toBe(`${API_BASE}/scheduler/jobs`);
    expect(fetchMock.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          name: 'nightly-report',
          cron: '0 6 * * *',
          prompt: 'Summarize overnight activity',
        }),
      }),
    );
  });

  test('add_job preserves a provider-neutral one-shot schedule', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: true, data: { output: 'created' } }),
    );
    const tools = await registerTools();
    await tools.add_job({
      name: 'wake-me',
      schedule: { kind: 'at', timeMs: 1_800_000_000_000 },
      prompt: 'Resume the monitor',
    });
    expect(
      JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)),
    ).toMatchObject({
      name: 'wake-me',
      schedule: { kind: 'at', timeMs: 1_800_000_000_000 },
    });
  });

  test('add_job forwards the error envelope when job creation fails', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: false, error: 'invalid cron expression' }, 500),
    );
    const tools = await registerTools();

    const result = await tools.add_job({
      name: 'bad-job',
      cron: 'not-a-cron',
      prompt: 'noop',
    });

    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            { success: false, error: 'invalid cron expression' },
            null,
            2,
          ),
        },
      ],
    });
  });

  test('run_job posts to the run endpoint and forwards the output envelope', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: true, data: { output: 'ran ok' } }),
    );
    const tools = await registerTools();

    const result = await tools.run_job({ name: 'nightly-report' });

    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            { success: true, data: { output: 'ran ok' } },
            null,
            2,
          ),
        },
      ],
    });
    expect(fetchMock.mock.calls[0][0]).toBe(
      `${API_BASE}/scheduler/jobs/nightly-report/run`,
    );
    expect(fetchMock.mock.calls[0][1]).toEqual(
      expect.objectContaining({ method: 'POST' }),
    );
  });

  test('run_job preserves a possible-effect scheduler outcome as non-retryable', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          success: false,
          code: 'scheduler_run_indeterminate',
          outcome: 'indeterminate',
          error: 'Scheduler stopped after provider invocation was authorized',
          data: {
            output: 'Scheduler stopped',
            receipt: {
              outcome: 'indeterminate',
              message: 'Scheduler stopped',
              runId: 'schedule:built-in:nightly-report:run-1',
            },
          },
        },
        409,
      ),
    );
    const tools = await registerTools();

    const result = await tools.run_job({ name: 'nightly-report' });

    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              success: false,
              error:
                'Scheduler stopped after provider invocation was authorized',
              code: 'scheduler_run_indeterminate',
              outcome: 'indeterminate',
              retryable: false,
              data: {
                outcome: 'indeterminate',
                message: 'Scheduler stopped',
                runId: 'schedule:built-in:nightly-report:run-1',
              },
            },
            null,
            2,
          ),
        },
      ],
    });
  });

  test('run_job preserves the exact receipt for a definite failed run', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          success: false,
          error:
            'Scheduler job failed. Inspect the associated run for details.',
          data: {
            output: 'Scheduler job failed.',
            receipt: {
              outcome: 'failed',
              message: 'Scheduler job failed.',
              runId: 'schedule:built-in:nightly-report:failed-1',
            },
          },
        },
        422,
      ),
    );
    const tools = await registerTools();

    const result = await tools.run_job({ name: 'nightly-report' });

    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              success: false,
              error:
                'Scheduler job failed. Inspect the associated run for details.',
              code: 'scheduler_run_failed',
              outcome: 'failed',
              data: {
                outcome: 'failed',
                message: 'Scheduler job failed.',
                runId: 'schedule:built-in:nightly-report:failed-1',
              },
            },
            null,
            2,
          ),
        },
      ],
    });
  });

  test('run_job preserves missing receipt identity as non-retryable without inventing observation data', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          success: false,
          code: 'scheduler_run_indeterminate',
          outcome: 'indeterminate',
          error: 'Scheduler stopped after provider invocation was authorized',
          data: {
            output: 'Scheduler stopped',
            receipt: {
              outcome: 'indeterminate',
              message: 'Scheduler stopped',
              runId: '',
            },
          },
        },
        409,
      ),
    );
    const tools = await registerTools();

    const result = await tools.run_job({ name: 'nightly-report' });

    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              success: false,
              error:
                'Scheduler stopped after provider invocation was authorized',
              code: 'scheduler_run_indeterminate',
              outcome: 'indeterminate',
              retryable: false,
            },
            null,
            2,
          ),
        },
      ],
    });
  });

  test('list_projects forwards the raw project list envelope', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: true, data: [{ slug: 'demo', name: 'Demo' }] }),
    );
    const tools = await registerTools();

    const result = await tools.list_projects();

    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            { success: true, data: [{ slug: 'demo', name: 'Demo' }] },
            null,
            2,
          ),
        },
      ],
    });
    expect(fetchMock.mock.calls[0][0]).toBe(`${API_BASE}/api/projects`);
  });

  test('list_delegation_targets exposes the sanitized capability catalog used by the UI', async () => {
    const sensitiveMarker = ['private', 'delegation', 'credential'].join('-');
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === `${API_BASE}/.well-known/station/v1`) {
        return jsonResponse({ environmentId: 'environment-current' });
      }
      if (url === `${API_BASE}/api/projects/station`) {
        return jsonResponse({
          success: true,
          data: { slug: 'station', workingDirectory: '/work/station' },
        });
      }
      if (url === `${API_BASE}/api/connections/agents`) {
        return jsonResponse({
          success: true,
          data: [
            {
              id: 'codex',
              kind: 'agent',
              type: 'codex',
              name: 'Codex',
              enabled: true,
              status: 'ready',
              capabilities: [
                'agent-runtime',
                'resume',
                'interrupt',
                'approvals',
              ],
              config: {
                defaultModel: 'gpt-5.6-sol',
                apiKey: sensitiveMarker,
              },
              prerequisites: [],
              runtimeCatalog: {
                models: [
                  {
                    id: 'gpt-5.6-sol',
                    name: 'GPT-5.6 Sol',
                    originalId: 'gpt-5.6-sol',
                    credential: sensitiveMarker,
                  },
                ],
              },
            },
          ],
        });
      }
      if (url === `${API_BASE}/api/agents`) {
        return jsonResponse({
          success: true,
          data: [
            {
              slug: 'codex',
              name: 'Codex',
              available: true,
              execution: { agentConnectionId: 'codex' },
            },
          ],
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const tools = await registerTools();

    const result = await tools.list_delegation_targets({
      projectSlug: 'station',
    });
    const catalog = JSON.parse(result.content[0].text);

    expect(catalog).toMatchObject({
      environment: {
        id: 'environment-current',
        name: 'Current environment',
        kind: 'current',
      },
      project: { slug: 'station' },
      targets: [
        {
          id: 'codex',
          kind: 'agent',
          ready: true,
          defaultModel: 'gpt-5.6-sol',
          capabilities: {
            resume: true,
            interrupt: true,
            approvals: true,
            modelSelection: true,
          },
        },
      ],
    });
    expect(JSON.stringify(catalog)).not.toContain(sensitiveMarker);
  });

  test('list_delegation_environments exposes safe environment choices', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === `${API_BASE}/.well-known/station/v1`) {
        return jsonResponse({ environmentId: 'environment-current' });
      }
      if (url === `${API_BASE}/api/environments/ssh`) {
        return jsonResponse({ success: true, data: [] });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const tools = await registerTools();

    const result = await tools.list_delegation_environments();

    expect(JSON.parse(result.content[0].text)).toEqual({
      environments: [
        {
          id: 'environment-current',
          name: 'Current environment',
          kind: 'current',
          ready: true,
          connected: true,
        },
      ],
    });
  });

  test('list_delegated_tasks exposes the bounded coordinator inventory', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === `${API_BASE}/.well-known/station/v1`) {
        return jsonResponse({ environmentId: 'environment-current' });
      }
      if (url === `${API_BASE}/api/orchestration/sessions/read-model`) {
        return jsonResponse({ success: true, data: [] });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const tools = await registerTools();

    const result = await tools.list_delegated_tasks({
      limit: 25,
      _userId: 'user-1',
    });

    expect(JSON.parse(result.content[0].text)).toEqual({
      environment: {
        id: 'environment-current',
        name: 'Current environment',
        kind: 'current',
      },
      tasks: [],
      truncated: false,
    });
  });

  test('list_delegation_targets keeps selected-Station failures generic', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === `${API_BASE}/.well-known/station/v1`) {
        return jsonResponse({ environmentId: 'environment-current' });
      }
      if (url === `${API_BASE}/api/connections/agents`) {
        return jsonResponse(
          { success: false, error: '/private/remote/config failed' },
          500,
        );
      }
      if (url === `${API_BASE}/api/agents`) {
        return jsonResponse({ success: true, data: [] });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const tools = await registerTools();

    await expect(tools.list_delegation_targets({})).rejects.toThrow(
      'Engine connections are unavailable on the selected Station',
    );
  });

  test('get_project forwards the single-project envelope', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: true, data: { slug: 'demo', name: 'Demo' } }),
    );
    const tools = await registerTools();

    const result = await tools.get_project({ slug: 'demo' });

    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            { success: true, data: { slug: 'demo', name: 'Demo' } },
            null,
            2,
          ),
        },
      ],
    });
    expect(fetchMock.mock.calls[0][0]).toBe(`${API_BASE}/api/projects/demo`);
  });

  test('get_project forwards the not-found envelope', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: false, error: 'Project not found' }, 404),
    );
    const tools = await registerTools();

    const result = await tools.get_project({ slug: 'missing' });

    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            { success: false, error: 'Project not found' },
            null,
            2,
          ),
        },
      ],
    });
  });

  test('list_project_layouts forwards the raw layouts envelope', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: [{ slug: 'coding', name: 'Coding' }],
      }),
    );
    const tools = await registerTools();

    const result = await tools.list_project_layouts({ slug: 'demo' });

    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            { success: true, data: [{ slug: 'coding', name: 'Coding' }] },
            null,
            2,
          ),
        },
      ],
    });
    expect(fetchMock.mock.calls[0][0]).toBe(
      `${API_BASE}/api/projects/demo/layouts`,
    );
  });

  test('get_usage forwards the raw usage envelope with a date-range query', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: true, data: { messages: 12, cost: 0.42 } }),
    );
    const tools = await registerTools();

    const result = await tools.get_usage({
      from: '2026-06-01',
      to: '2026-06-30',
    });

    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            { success: true, data: { messages: 12, cost: 0.42 } },
            null,
            2,
          ),
        },
      ],
    });
    expect(fetchMock.mock.calls[0][0]).toBe(
      `${API_BASE}/api/analytics/usage?from=2026-06-01&to=2026-06-30`,
    );
  });

  test('get_usage forwards the raw usage envelope with no date range', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: true, data: { messages: 0, cost: 0 } }),
    );
    const tools = await registerTools();

    const result = await tools.get_usage({});

    expect(fetchMock.mock.calls[0][0]).toBe(`${API_BASE}/api/analytics/usage`);
    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            { success: true, data: { messages: 0, cost: 0 } },
            null,
            2,
          ),
        },
      ],
    });
  });

  test('get_usage forwards whatever envelope comes back, even on a failure status', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: false, error: 'analytics unavailable' }, 500),
    );
    const tools = await registerTools();

    const result = await tools.get_usage({});

    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            { success: false, error: 'analytics unavailable' },
            null,
            2,
          ),
        },
      ],
    });
  });

  test('get_achievements forwards the raw achievements envelope', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: true, data: [{ id: 'first-run' }] }),
    );
    const tools = await registerTools();

    const result = await tools.get_achievements();

    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            { success: true, data: [{ id: 'first-run' }] },
            null,
            2,
          ),
        },
      ],
    });
    expect(fetchMock.mock.calls[0][0]).toBe(
      `${API_BASE}/api/analytics/achievements`,
    );
  });

  test('reindex_knowledge posts the rootId and forwards the rebuild envelope', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: { roots: [{ rootId: 'personal', records: 3, chunks: 12 }] },
      }),
    );
    const tools = await registerTools();

    const result = await tools.reindex_knowledge({ rootId: 'personal' });

    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              success: true,
              data: { roots: [{ rootId: 'personal', records: 3, chunks: 12 }] },
            },
            null,
            2,
          ),
        },
      ],
    });
    expect(fetchMock.mock.calls[0][0]).toBe(
      `${API_BASE}/api/knowledge/index/rebuild`,
    );
    expect(fetchMock.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ rootId: 'personal' }),
      }),
    );
  });

  test('reindex_knowledge omits rootId to rebuild all roots and forwards the envelope', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: {
          roots: [
            { rootId: 'personal', records: 3, chunks: 12 },
            { rootId: 'project-station', records: 5, chunks: 20 },
          ],
        },
      }),
    );
    const tools = await registerTools();

    const result = await tools.reindex_knowledge({});

    expect(fetchMock.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ rootId: undefined }),
      }),
    );
    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              success: true,
              data: {
                roots: [
                  { rootId: 'personal', records: 3, chunks: 12 },
                  { rootId: 'project-station', records: 5, chunks: 20 },
                ],
              },
            },
            null,
            2,
          ),
        },
      ],
    });
  });

  test('reindex_knowledge forwards the error envelope on failure', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: false, error: 'no embedder configured' }, 400),
    );
    const tools = await registerTools();

    const result = await tools.reindex_knowledge({});

    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            { success: false, error: 'no embedder configured' },
            null,
            2,
          ),
        },
      ],
    });
  });

  test('search_knowledge posts query, rootIds, and topK and forwards the results envelope', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: [
          {
            recordId: 'rec-1',
            rootId: 'personal',
            score: 0.91,
            title: 'Standup notes',
            excerpt: 'Discussed the release plan.',
            category: 'meeting',
          },
        ],
      }),
    );
    const tools = await registerTools();

    const result = await tools.search_knowledge({
      query: 'release plan',
      rootIds: ['personal'],
      topK: 5,
    });

    expect(fetchMock.mock.calls[0][0]).toBe(
      `${API_BASE}/api/knowledge/index/search`,
    );
    expect(fetchMock.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          query: 'release plan',
          rootIds: ['personal'],
          topK: 5,
        }),
      }),
    );
    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              success: true,
              data: [
                {
                  recordId: 'rec-1',
                  rootId: 'personal',
                  score: 0.91,
                  title: 'Standup notes',
                  excerpt: 'Discussed the release plan.',
                  category: 'meeting',
                },
              ],
            },
            null,
            2,
          ),
        },
      ],
    });
  });

  test('search_knowledge omits rootIds/topK to search all roots', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, data: [] }));
    const tools = await registerTools();

    await tools.search_knowledge({ query: 'anything' });

    expect(fetchMock.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ query: 'anything' }),
      }),
    );
  });

  test('search_knowledge forwards the NO_EMBEDDER error envelope on failure', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: false, error: 'no embedder configured' }, 400),
    );
    const tools = await registerTools();

    const result = await tools.search_knowledge({ query: 'anything' });

    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            { success: false, error: 'no embedder configured' },
            null,
            2,
          ),
        },
      ],
    });
  });

  test('migrate_knowledge posts the projectSlug and forwards the migration envelope', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: {
          documentsMigrated: 4,
          chunksIndexed: 16,
          namespacesProcessed: ['demo'],
        },
      }),
    );
    const tools = await registerTools();

    const result = await tools.migrate_knowledge({ projectSlug: 'demo' });

    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              success: true,
              data: {
                documentsMigrated: 4,
                chunksIndexed: 16,
                namespacesProcessed: ['demo'],
              },
            },
            null,
            2,
          ),
        },
      ],
    });
    expect(fetchMock.mock.calls[0][0]).toBe(
      `${API_BASE}/api/knowledge/migrate`,
    );
    expect(fetchMock.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ projectSlug: 'demo' }),
      }),
    );
  });

  test('migrate_knowledge omits projectSlug to migrate every legacy namespace found', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: {
          documentsMigrated: 0,
          chunksIndexed: 0,
          namespacesProcessed: [],
        },
      }),
    );
    const tools = await registerTools();

    const result = await tools.migrate_knowledge({});

    expect(fetchMock.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ projectSlug: undefined }),
      }),
    );
    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              success: true,
              data: {
                documentsMigrated: 0,
                chunksIndexed: 0,
                namespacesProcessed: [],
              },
            },
            null,
            2,
          ),
        },
      ],
    });
  });

  test('migrate_knowledge forwards the error envelope on failure', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: false, error: 'legacy read failed' }, 500),
    );
    const tools = await registerTools();

    const result = await tools.migrate_knowledge({});

    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            { success: false, error: 'legacy read failed' },
            null,
            2,
          ),
        },
      ],
    });
  });

  // station#1136: environment MANAGEMENT verbs. These characterize the
  // straightforward request-forwarding shape at the HTTP boundary, the same
  // way every other tool in this file is pinned; the deeper round-trip
  // (AC1), non-blocking-connect (AC2), and no-duplicated-logic (AC3)
  // guarantees are proven against a real `SshEnvironmentService` in
  // `station-control-ssh-environment-tools.test.ts`.

  test('create_ssh_environment posts the profile input and forwards the created envelope', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          success: true,
          data: {
            profile: {
              id: 'ssh-1',
              name: 'Brian media',
              hostAlias: 'brian-media',
            },
            state: { phase: 'idle' },
          },
        },
        201,
      ),
    );
    const tools = await registerTools();

    const result = await tools.create_ssh_environment({
      hostAlias: 'brian-media',
      remoteProjectPath: '~/dev/station',
    });

    expect(fetchMock.mock.calls[0][0]).toBe(`${API_BASE}/api/environments/ssh`);
    expect(fetchMock.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          hostAlias: 'brian-media',
          remoteProjectPath: '~/dev/station',
        }),
      }),
    );
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      success: true,
      data: { profile: { id: 'ssh-1' } },
    });
  });

  test('create_ssh_environment forwards the validation-error envelope on an invalid hostAlias', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { success: false, error: 'Validation failed', details: {} },
        400,
      ),
    );
    const tools = await registerTools();

    const result = await tools.create_ssh_environment({
      hostAlias: '-oProxyCommand=bad',
      remoteProjectPath: '/srv/station',
    });

    expect(JSON.parse(result.content[0].text)).toMatchObject({
      success: false,
      error: 'Validation failed',
    });
  });

  test('get_ssh_environment forwards the full profile-and-state envelope', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: {
          profile: { id: 'ssh-1', verifiedProjectPath: '/home/brian/station' },
          state: { phase: 'connected', localUrl: 'http://127.0.0.1:45123' },
        },
      }),
    );
    const tools = await registerTools();

    const result = await tools.get_ssh_environment({ id: 'ssh-1' });

    expect(fetchMock.mock.calls[0][0]).toBe(
      `${API_BASE}/api/environments/ssh/ssh-1`,
    );
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      success: true,
      data: { state: { phase: 'connected' } },
    });
  });

  test('get_ssh_environment forwards the not-found envelope', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: false, error: 'SSH environment not found' }, 404),
    );
    const tools = await registerTools();

    const result = await tools.get_ssh_environment({ id: 'missing' });

    expect(JSON.parse(result.content[0].text)).toEqual({
      success: false,
      error: 'SSH environment not found',
    });
  });

  test('connect_ssh_environment forwards a fast-resolving connect and marks polling false', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: {
          profile: { id: 'ssh-1' },
          state: { phase: 'connected', localUrl: 'http://127.0.0.1:45123' },
        },
      }),
    );
    const tools = await registerTools();

    const result = await tools.connect_ssh_environment({ id: 'ssh-1' });

    expect(fetchMock.mock.calls[0][0]).toBe(
      `${API_BASE}/api/environments/ssh/ssh-1/connect`,
    );
    expect(fetchMock.mock.calls[0][1]).toEqual(
      expect.objectContaining({ method: 'POST' }),
    );
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      success: true,
      polling: false,
      data: { state: { phase: 'connected' } },
    });
  });

  test('connect_ssh_environment forwards the error envelope when the connect call fails outright', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: false, error: 'worker-incompatible' }, 400),
    );
    const tools = await registerTools();

    const result = await tools.connect_ssh_environment({ id: 'ssh-1' });

    expect(JSON.parse(result.content[0].text)).toMatchObject({
      success: false,
      polling: false,
      error: 'worker-incompatible',
    });
  });

  test('disconnect_ssh_environment posts to the disconnect endpoint and forwards the envelope', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: {
          profile: { id: 'ssh-1' },
          state: { phase: 'disconnected', reason: 'stopped' },
        },
      }),
    );
    const tools = await registerTools();

    const result = await tools.disconnect_ssh_environment({ id: 'ssh-1' });

    expect(fetchMock.mock.calls[0][0]).toBe(
      `${API_BASE}/api/environments/ssh/ssh-1/disconnect`,
    );
    expect(fetchMock.mock.calls[0][1]).toEqual(
      expect.objectContaining({ method: 'POST' }),
    );
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      success: true,
      data: { state: { phase: 'disconnected' } },
    });
  });

  test('remove_ssh_environment issues a DELETE and forwards the envelope', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true }));
    const tools = await registerTools();

    const result = await tools.remove_ssh_environment({ id: 'ssh-1' });

    expect(fetchMock.mock.calls[0][0]).toBe(
      `${API_BASE}/api/environments/ssh/ssh-1`,
    );
    expect(fetchMock.mock.calls[0][1]).toEqual(
      expect.objectContaining({ method: 'DELETE' }),
    );
    expect(JSON.parse(result.content[0].text)).toEqual({ success: true });
  });

  test('remove_ssh_environment forwards the not-found envelope', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: false, error: 'SSH environment not found' }, 404),
    );
    const tools = await registerTools();

    const result = await tools.remove_ssh_environment({ id: 'missing' });

    expect(JSON.parse(result.content[0].text)).toEqual({
      success: false,
      error: 'SSH environment not found',
    });
  });

  test('read_logs calls GET /api/diagnostics/logs with no query string when no filters are given', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        entries: [],
        truncated: false,
        scannedFiles: 0,
        oldestScannedDay: null,
        skippedMalformedLines: 0,
      }),
    );
    const tools = await registerTools();

    const result = await tools.read_logs({});

    expect(fetchMock.mock.calls[0][0]).toBe(`${API_BASE}/api/diagnostics/logs`);
    expect(JSON.parse(result.content[0].text)).toEqual({
      entries: [],
      truncated: false,
      scannedFiles: 0,
      oldestScannedDay: null,
      skippedMalformedLines: 0,
    });
  });

  test('read_logs forwards level/since/until/q/limit as a query string', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        entries: [{ level: 'warn', timestamp: 'x', msg: 'disk usage high' }],
        truncated: false,
        scannedFiles: 1,
        oldestScannedDay: '2026-08-01',
        skippedMalformedLines: 0,
      }),
    );
    const tools = await registerTools();

    await tools.read_logs({
      level: 'warn',
      since: '2026-08-01T00:00:00.000Z',
      until: '2026-08-01T23:59:59.000Z',
      q: 'disk',
      limit: 10,
    });

    const requestedUrl = new URL(String(fetchMock.mock.calls[0][0]));
    expect(requestedUrl.pathname).toBe('/api/diagnostics/logs');
    expect(requestedUrl.searchParams.get('level')).toBe('warn');
    expect(requestedUrl.searchParams.get('since')).toBe(
      '2026-08-01T00:00:00.000Z',
    );
    expect(requestedUrl.searchParams.get('until')).toBe(
      '2026-08-01T23:59:59.000Z',
    );
    expect(requestedUrl.searchParams.get('q')).toBe('disk');
    expect(requestedUrl.searchParams.get('limit')).toBe('10');
  });

  test('read_logs forwards a route-reported validation error unchanged (e.g. bad level)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          error:
            'Invalid level "verbose"; accepted values: trace, debug, info, warn, error, fatal',
        },
        400,
      ),
    );
    const tools = await registerTools();

    // The tool's own zod schema constrains `level` to the known vocabulary,
    // so this exercises the pass-through path for a value that slipped past
    // schema validation in a raw handler invocation (bypassing the MCP
    // SDK's own zod dispatch, per this file's docblock).
    const result = await (tools.read_logs as any)({ level: 'verbose' });

    expect(JSON.parse(result.content[0].text)).toEqual({
      error:
        'Invalid level "verbose"; accepted values: trace, debug, info, warn, error, fatal',
    });
  });
});
