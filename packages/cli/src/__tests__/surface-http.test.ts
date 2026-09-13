import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEngineConnectionId } from '@kontourai/station-contracts/agent-identity';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  type MockInstance,
  test,
  vi,
} from 'vitest';
import {
  resetProfileCredentialStoreForTests,
  setProfileCredentialStore,
} from '../commands/profile-credentials.js';
import { upsertProfile } from '../commands/profile-store.js';
import { readBody } from './helpers/http-test-helpers.js';

const reviewReceipt = {
  schemaVersion: 1,
  receiptId: 'a'.repeat(64),
  requestId: 'request-1',
  mode: 'initial',
  target: {
    kind: 'git-range',
    projectSlug: 'demo',
    baseRevision: 'origin/main',
    headRevision: 'HEAD',
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
      lens: { id: 'architecture', instructions: 'Review exact seams.' },
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

describe('CLI surface commands over HTTP', () => {
  let server: ReturnType<typeof createServer>;
  let apiBase = '';
  let stdoutWrite: MockInstance;
  let _consoleLog: MockInstance;

  const state = {
    connections: [] as any[],
    tools: [] as any[],
    notifications: [] as any[],
    runs: [
      {
        runId: 'run-1',
        source: 'schedule',
        status: 'completed',
      },
    ] as any[],
    scheduleJobs: [] as any[],
    /** #1536 R8: the query the CLI's `schedule preview` actually sends. */
    previewQueries: [] as string[],
    reviewRequests: [] as any[],
    schedulerRunFails: false,
    monitoringEvents: [{ type: 'event', value: 'historical' }],
    monitoringEventQueries: [] as string[],
    notificationActionCalls: [] as Array<{ id: string; actionId: string }>,
    registry: {
      agents: [{ id: 'registry-agent', displayName: 'Registry Agent' }],
      skills: [{ id: 'registry-skill', displayName: 'Registry Skill' }],
      integrations: [
        { id: 'registry-integration', displayName: 'Registry Integration' },
      ],
      plugins: [{ id: 'registry-plugin', displayName: 'Registry Plugin' }],
    },
    registryInstalls: [] as Array<{ tab: string; id: string }>,
    feedbackRatings: [] as any[],
    acpConnections: [] as any[],
    voiceSessions: [] as any[],
    flowStartBodies: [] as any[],
    flowCommandBodies: [] as any[],
    flowEvaluateBodies: [] as any[],
    knowledgeNamespaces: [
      { id: 'default', name: 'Default', description: 'default namespace' },
    ],
    knowledgeDocs: [{ id: 'doc-1', filename: 'README.md', chunkCount: 1 }],
    credentialRecoveryCalls: [] as Array<{
      method: string;
      path: string;
      body?: unknown;
    }>,
    credentialRecoveryApplyOutcome: undefined as string | undefined,
    authorizationHeaders: [] as Array<{
      path: string;
      authorization: string | undefined;
    }>,
  };

  beforeEach(async () => {
    stdoutWrite = vi.spyOn(process.stdout, 'write');
    stdoutWrite.mockImplementation(() => true);
    _consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});

    server = createServer(async (req, res) => {
      const method = req.method || 'GET';
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      state.authorizationHeaders.push({
        path: url.pathname,
        authorization: req.headers.authorization,
      });
      const body =
        method === 'POST' || method === 'PUT' || method === 'PATCH'
          ? await readBody(req)
          : undefined;

      const sendJson = (status: number, payload: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      if (method === 'GET' && url.pathname === '/api/connections') {
        sendJson(200, { success: true, data: state.connections });
        return;
      }
      if (method === 'GET' && url.pathname === '/api/connections/models') {
        sendJson(200, {
          success: true,
          data: state.connections.filter((entry) => entry.kind === 'model'),
        });
        return;
      }
      if (method === 'GET' && url.pathname === '/api/connections/agents') {
        sendJson(200, {
          success: true,
          data: state.connections.filter((entry) => entry.kind === 'agent'),
        });
        return;
      }
      if (method === 'POST' && url.pathname === '/api/connections') {
        state.connections.push(body);
        sendJson(201, { success: true, data: body });
        return;
      }
      if (
        method === 'POST' &&
        url.pathname.match(/^\/api\/connections\/[^/]+\/test$/)
      ) {
        sendJson(200, {
          success: true,
          data: { healthy: true, status: 'ready' },
        });
        return;
      }
      const credentialRecoveryMatch = url.pathname.match(
        /^\/api\/connections\/agent\/([^/]+)\/credential-recovery(?:\/profiles(?:\/([^/]+)(?:\/(enrollment|import|apply))?)?|\/policy)?$/,
      );
      if (credentialRecoveryMatch) {
        state.credentialRecoveryCalls.push({
          method,
          path: url.pathname,
          ...(body === undefined ? {} : { body }),
        });
        if (credentialRecoveryMatch[3] === 'import') {
          sendJson(200, {
            success: true,
            data: {
              outcome: 'completed',
              copied: ['settings.json'],
              skipped: ['credentials.json'],
              provenanceUpdated: true,
              profileDir: '/must-not-print',
            },
          });
          return;
        }
        if (credentialRecoveryMatch[3] === 'apply') {
          if (
            state.credentialRecoveryApplyOutcome &&
            state.credentialRecoveryApplyOutcome !== 'adopted'
          ) {
            sendJson(409, {
              success: false,
              error:
                'Credential recovery state changed before the requested operation could complete.',
              data: {
                capability: 'restart_resume',
                activeProfileRef: 'primary',
                outcome: state.credentialRecoveryApplyOutcome,
              },
            });
            return;
          }
          sendJson(200, {
            success: true,
            data: {
              capability: 'restart_resume',
              activeProfileRef: credentialRecoveryMatch[2],
              outcome: 'adopted',
            },
          });
          return;
        }
        const projection = {
          profiles: [
            { ref: 'primary', label: 'Primary account' },
            { ref: 'recovery', label: 'Recovery account' },
          ],
          group: {
            profileRefs: ['primary', 'recovery'],
            enrolledProfileRefs: ['recovery'],
          },
          policy: { automatic: false },
          application: {
            capability: 'restart_resume',
            activeProfileRef: 'primary',
            pendingProfileRef: 'recovery',
            outcome: 'staged',
          },
          profileDir: '/must-not-print',
          credentials: 'must-not-print',
        };
        sendJson(200, { success: true, data: projection });
        return;
      }

      if (method === 'GET' && url.pathname === '/integrations') {
        sendJson(200, { success: true, data: state.tools });
        return;
      }
      if (method === 'POST' && url.pathname === '/integrations') {
        state.tools.push(body);
        sendJson(200, { success: true });
        return;
      }
      if (
        method === 'POST' &&
        url.pathname.match(/^\/integrations\/[^/]+\/reconnect$/)
      ) {
        sendJson(200, { success: true });
        return;
      }
      if (
        method === 'DELETE' &&
        url.pathname.match(/^\/integrations\/[^/]+$/)
      ) {
        const id = decodeURIComponent(url.pathname.split('/').pop() || '');
        state.tools = state.tools.filter((entry) => entry.id !== id);
        sendJson(200, { success: true });
        return;
      }

      if (method === 'GET' && url.pathname === '/notifications') {
        sendJson(200, { success: true, data: state.notifications });
        return;
      }
      if (method === 'POST' && url.pathname === '/notifications') {
        const next = { id: `notif-${state.notifications.length + 1}`, ...body };
        state.notifications.push(next);
        sendJson(201, { success: true, data: next });
        return;
      }
      if (
        method === 'POST' &&
        url.pathname.match(/^\/notifications\/[^/]+\/action\/[^/]+$/)
      ) {
        const [, , id, , actionId] = url.pathname.split('/');
        state.notificationActionCalls.push({ id, actionId });
        sendJson(200, { success: true });
        return;
      }
      if (method === 'DELETE' && url.pathname === '/notifications') {
        state.notifications = [];
        sendJson(200, { success: true });
        return;
      }
      if (method === 'GET' && url.pathname === '/notifications/providers') {
        sendJson(200, { success: true, data: [{ id: 'builtin' }] });
        return;
      }

      if (method === 'GET' && url.pathname === '/monitoring/stats') {
        sendJson(200, {
          success: true,
          data: { agents: [], summary: { totalAgents: 0 } },
        });
        return;
      }
      if (method === 'GET' && url.pathname === '/monitoring/metrics') {
        sendJson(200, { success: true, data: { range: 'today', metrics: [] } });
        return;
      }
      if (method === 'GET' && url.pathname === '/monitoring/events') {
        state.monitoringEventQueries.push(url.search);
        // Model the REAL route's branch: it returns historical JSON only when
        // a time bound is present, and streams SSE otherwise. Answering every
        // request with JSON made this harness structurally unable to see a
        // CLI verb falling into the stream and awaiting .json() forever —
        // which is exactly the defect that shipped.
        if (!url.searchParams.has('start') && !url.searchParams.has('end')) {
          // One frame, then END. A stream that stays open would hang the
          // suite; one that closes still discriminates, because a verb which
          // wrongly awaits .json() on this body gets a parse error rather
          // than a result.
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write('data: {"type":"connected"}\n\n');
          res.end();
          return;
        }
        sendJson(200, { success: true, data: state.monitoringEvents });
        return;
      }

      if (method === 'GET' && url.pathname === '/scheduler/jobs') {
        sendJson(200, { success: true, data: state.scheduleJobs });
        return;
      }
      if (method === 'GET' && url.pathname === '/api/runs') {
        sendJson(200, { success: true, data: state.runs });
        return;
      }
      if (method === 'GET' && url.pathname === '/api/runs/run-1') {
        sendJson(200, { success: true, data: state.runs[0] });
        return;
      }
      if (method === 'POST' && url.pathname === '/api/runs/output') {
        sendJson(200, { success: true, data: { content: 'run output' } });
        return;
      }
      if (url.pathname === '/api/projects/demo/reviews') {
        if (method === 'POST') {
          state.reviewRequests.push(body);
          sendJson(201, {
            success: true,
            data: {
              requestId: 'request-1',
              projectSlug: 'demo',
              state: 'completed',
              startedAt: reviewReceipt.startedAt,
              updatedAt: reviewReceipt.completedAt,
              result: {
                receipt: reviewReceipt,
                attachment: { status: 'not-requested' },
                cleanup: { status: 'completed' },
              },
            },
          });
          return;
        }
        if (method === 'GET') {
          sendJson(200, { success: true, data: [reviewReceipt] });
          return;
        }
      }
      if (
        method === 'GET' &&
        url.pathname === `/api/projects/demo/reviews/${reviewReceipt.receiptId}`
      ) {
        sendJson(200, { success: true, data: reviewReceipt });
        return;
      }
      if (method === 'GET' && url.pathname === '/scheduler/providers') {
        sendJson(200, { success: true, data: [{ id: 'builtin' }] });
        return;
      }
      if (method === 'GET' && url.pathname === '/scheduler/stats') {
        sendJson(200, { success: true, data: { summary: { totalJobs: 0 } } });
        return;
      }
      if (method === 'GET' && url.pathname === '/scheduler/status') {
        sendJson(200, { success: true, data: { providers: {} } });
        return;
      }
      if (
        method === 'GET' &&
        url.pathname === '/scheduler/jobs/preview-schedule'
      ) {
        state.previewQueries.push(url.search);
        sendJson(200, { success: true, data: ['2026-04-19T00:00:00Z'] });
        return;
      }
      if (method === 'POST' && url.pathname === '/scheduler/jobs') {
        state.scheduleJobs.push(body);
        sendJson(200, { success: true, data: { output: 'created' } });
        return;
      }
      if (
        method === 'GET' &&
        url.pathname.match(/^\/scheduler\/jobs\/[^/]+\/logs$/)
      ) {
        sendJson(200, { success: true, data: [{ id: 'run-1' }] });
        return;
      }
      if (
        method === 'PUT' &&
        url.pathname.match(/^\/scheduler\/jobs\/[^/]+$/)
      ) {
        sendJson(200, { success: true, data: { output: 'updated' } });
        return;
      }
      if (
        method === 'PUT' &&
        url.pathname.match(/^\/scheduler\/jobs\/[^/]+\/(enable|disable)$/)
      ) {
        sendJson(200, { success: true, data: {} });
        return;
      }
      if (
        method === 'DELETE' &&
        url.pathname.match(/^\/scheduler\/jobs\/[^/]+$/)
      ) {
        sendJson(200, { success: true, data: {} });
        return;
      }
      if (
        method === 'POST' &&
        url.pathname.match(/^\/scheduler\/jobs\/[^/]+\/run$/)
      ) {
        if (state.schedulerRunFails) {
          sendJson(422, {
            success: false,
            error:
              'Scheduler job failed. Inspect the associated run for details.',
            data: {
              output: 'Scheduler job failed.',
              receipt: {
                outcome: 'failed',
                message: 'Scheduler job failed.',
                runId: 'schedule:built-in:daily-report:failed-1',
              },
            },
          });
          return;
        }
        sendJson(200, { success: true, data: { output: 'started' } });
        return;
      }

      if (
        method === 'GET' &&
        url.pathname === '/api/projects/demo/flow/definitions'
      ) {
        sendJson(200, {
          success: true,
          data: {
            initialized: true,
            definitions: [{ id: 'station-delivery', valid: true }],
          },
        });
        return;
      }
      if (method === 'GET' && url.pathname === '/api/projects/demo/flow/runs') {
        sendJson(200, {
          success: true,
          data: [{ run_id: 'run-1', status: 'active' }],
        });
        return;
      }
      if (
        method === 'POST' &&
        url.pathname === '/api/projects/demo/flow/runs'
      ) {
        state.flowStartBodies.push(body);
        sendJson(201, { success: true, data: { runId: body.runId } });
        return;
      }
      if (
        method === 'GET' &&
        url.pathname === '/api/projects/demo/flow/runs/run-1'
      ) {
        sendJson(200, {
          success: true,
          data: { runId: 'run-1', openGates: [{ id: 'implement-gate' }] },
        });
        return;
      }
      if (
        method === 'POST' &&
        url.pathname === '/api/projects/demo/flow/runs/run-1/evidence/command'
      ) {
        state.flowCommandBodies.push(body);
        sendJson(201, {
          success: true,
          data: { entry: { id: 'ev.1' }, exitCode: 0, timedOut: false },
        });
        return;
      }
      if (
        method === 'POST' &&
        url.pathname === '/api/projects/demo/flow/runs/run-1/evaluate'
      ) {
        state.flowEvaluateBodies.push(body);
        sendJson(200, {
          success: true,
          data: { outcomes: [{ gate_id: 'implement-gate', status: 'pass' }] },
        });
        return;
      }
      if (
        method === 'GET' &&
        url.pathname === '/api/projects/demo/flow/runs/run-1/report'
      ) {
        sendJson(200, { success: true, data: { run_id: 'run-1' } });
        return;
      }
      if (method === 'GET' && url.pathname === '/api/knowledge/status') {
        sendJson(200, {
          success: true,
          data: {
            vectorDb: null,
            embedding: null,
            stats: { totalDocuments: 1, totalChunks: 1, projectCount: 1 },
          },
        });
        return;
      }
      if (method === 'POST' && url.pathname === '/api/knowledge/index/search') {
        sendJson(200, {
          success: true,
          data: [
            {
              recordId: 'rec-1',
              rootId: 'root:personal',
              score: 0.9,
              title: 'README',
              excerpt: 'Getting started.',
              category: 'doc',
            },
          ],
        });
        return;
      }
      if (
        method === 'GET' &&
        url.pathname === '/api/projects/demo/knowledge/namespaces'
      ) {
        sendJson(200, { success: true, data: state.knowledgeNamespaces });
        return;
      }
      if (method === 'GET' && url.pathname === '/api/projects/demo/knowledge') {
        sendJson(200, { success: true, data: state.knowledgeDocs });
        return;
      }
      if (method === 'GET' && url.pathname === '/api/auth/status') {
        sendJson(200, {
          authenticated: true,
          method: 'sso',
          user: { alias: 'testuser', name: 'Test User' },
        });
        return;
      }
      if (
        method === 'POST' &&
        (url.pathname === '/api/auth/renew' ||
          url.pathname === '/api/auth/terminal')
      ) {
        sendJson(200, { success: true, message: 'Renewed' });
        return;
      }
      if (method === 'GET' && url.pathname === '/api/users/search') {
        const q = url.searchParams.get('q') || '';
        sendJson(200, [{ alias: q, name: q }]);
        return;
      }
      if (method === 'GET' && url.pathname === '/api/users/testuser') {
        sendJson(200, { alias: 'testuser', name: 'testuser' });
        return;
      }
      if (method === 'GET' && url.pathname === '/api/branding') {
        sendJson(200, {
          success: true,
          data: {
            name: 'Station',
            logo: null,
            theme: { primary: '#000' },
            welcomeMessage: 'Hello!',
          },
        });
        return;
      }
      if (method === 'POST' && url.pathname === '/api/feedback/rate') {
        const next = {
          id: `rating-${state.feedbackRatings.length + 1}`,
          ...body,
        };
        state.feedbackRatings.push(next);
        sendJson(200, { success: true, data: next });
        return;
      }
      if (method === 'DELETE' && url.pathname === '/api/feedback/rate') {
        state.feedbackRatings = state.feedbackRatings.filter(
          (entry) =>
            !(
              entry.conversationId === body.conversationId &&
              entry.messageIndex === body.messageIndex
            ),
        );
        sendJson(200, { success: true, removed: true });
        return;
      }
      if (method === 'GET' && url.pathname === '/api/feedback/ratings') {
        sendJson(200, { success: true, data: state.feedbackRatings });
        return;
      }
      if (method === 'GET' && url.pathname === '/api/feedback/guidelines') {
        sendJson(200, {
          success: true,
          data: { guidelines: '', summary: {} },
        });
        return;
      }
      if (method === 'POST' && url.pathname === '/api/feedback/analyze') {
        sendJson(200, { success: true, data: { analyzed: true } });
        return;
      }
      if (
        method === 'POST' &&
        url.pathname === '/api/feedback/clear-analysis'
      ) {
        sendJson(200, { success: true });
        return;
      }
      if (method === 'GET' && url.pathname === '/api/feedback/status') {
        sendJson(200, {
          success: true,
          data: { totalRatings: state.feedbackRatings.length },
        });
        return;
      }
      if (method === 'POST' && url.pathname === '/api/feedback/test') {
        sendJson(200, { success: true, data: { ok: true } });
        return;
      }
      if (method === 'GET' && url.pathname === '/api/insights/') {
        sendJson(200, {
          success: true,
          data: {
            toolUsage: {},
            hourlyActivity: new Array(24).fill(0),
            agentUsage: {},
            modelUsage: {},
            totalChats: 0,
            totalToolCalls: 0,
            totalErrors: 0,
            days: Number(url.searchParams.get('days') || 14),
          },
        });
        return;
      }
      if (method === 'GET' && url.pathname === '/acp/status') {
        sendJson(200, {
          success: true,
          data: { connected: false, connections: [] },
        });
        return;
      }
      if (
        method === 'GET' &&
        url.pathname === '/api/orchestration/providers/acp/commands'
      ) {
        sendJson(200, {
          success: true,
          data: [
            { name: 'plan', description: 'Plan the task' },
            { name: 'review', description: 'Review a diff' },
          ],
        });
        return;
      }
      if (method === 'GET' && url.pathname === '/acp/connections') {
        sendJson(200, { success: true, data: state.acpConnections });
        return;
      }
      if (method === 'POST' && url.pathname === '/acp/connections') {
        // station#2844: mirrors the real route's `acpConnectionSchema`
        // answer (src-server/routes/schemas/schema-definitions/runtime.ts)
        // for the CLI-tested shapes. The id rule imports the REAL
        // validators so this mock cannot drift from the schema; the schema
        // itself is covered server-side in acp.routes.test.ts.
        const fieldErrors: Record<string, string[]> = {};
        if (typeof body?.id !== 'string') {
          fieldErrors.id = ['Required'];
        } else if (parseEngineConnectionId(body.id) === undefined) {
          fieldErrors.id = [
            'must be a clean engine identity using lowercase letters, digits, and hyphens',
          ];
        }
        if (typeof body?.command !== 'string') {
          fieldErrors.command = ['Required'];
        } else if (body.command.length === 0) {
          fieldErrors.command = ['String must contain at least 1 character(s)'];
        }
        if (Object.keys(fieldErrors).length > 0) {
          sendJson(400, {
            success: false,
            error: 'Validation failed',
            details: { formErrors: [], fieldErrors },
          });
          return;
        }
        state.acpConnections.push(body);
        sendJson(200, { success: true, data: body });
        return;
      }
      if (method === 'PUT' && url.pathname === '/acp/connections/demo-acp') {
        state.acpConnections = state.acpConnections.map((entry) =>
          entry.id === 'demo-acp' ? { ...entry, ...body } : entry,
        );
        sendJson(200, {
          success: true,
          data: state.acpConnections.find((entry) => entry.id === 'demo-acp'),
        });
        return;
      }
      if (
        method === 'POST' &&
        url.pathname === '/acp/connections/demo-acp/reconnect'
      ) {
        sendJson(200, { success: true });
        return;
      }
      if (method === 'DELETE' && url.pathname === '/acp/connections/demo-acp') {
        state.acpConnections = state.acpConnections.filter(
          (entry) => entry.id !== 'demo-acp',
        );
        sendJson(200, { success: true });
        return;
      }
      if (method === 'GET' && url.pathname === '/api/voice/status') {
        sendJson(200, {
          success: true,
          data: { activeSessions: state.voiceSessions.length },
        });
        return;
      }
      if (method === 'GET' && url.pathname === '/api/voice/agent') {
        sendJson(200, {
          success: true,
          data: {
            slug: 'station-voice',
            activeSessions: state.voiceSessions.length,
          },
        });
        return;
      }
      if (method === 'POST' && url.pathname === '/api/voice/sessions') {
        const next = {
          sessionId: `voice-${state.voiceSessions.length + 1}`,
          agentSlug: body?.agentSlug || 'station-voice',
        };
        state.voiceSessions.push(next);
        sendJson(200, { success: true, data: next });
        return;
      }
      if (
        method === 'DELETE' &&
        url.pathname === '/api/voice/sessions/voice-1'
      ) {
        state.voiceSessions = state.voiceSessions.filter(
          (entry) => entry.sessionId !== 'voice-1',
        );
        sendJson(200, { success: true });
        return;
      }
      const registryListMatch = url.pathname.match(
        /^\/api\/registry\/(agents|skills|integrations|plugins)(?:\/installed)?$/,
      );
      if (method === 'GET' && registryListMatch) {
        const tab = registryListMatch[1] as keyof typeof state.registry;
        sendJson(200, { success: true, data: state.registry[tab] });
        return;
      }
      const registryInstallMatch = url.pathname.match(
        /^\/api\/registry\/(agents|skills|integrations|plugins)\/install$/,
      );
      if (method === 'POST' && registryInstallMatch) {
        state.registryInstalls.push({
          tab: registryInstallMatch[1],
          id: body.id,
        });
        sendJson(200, { success: true, data: { success: true } });
        return;
      }
      const registryDeleteMatch = url.pathname.match(
        /^\/api\/registry\/(agents|skills|integrations|plugins)\/([^/]+)$/,
      );
      if (method === 'DELETE' && registryDeleteMatch) {
        sendJson(200, { success: true, data: { success: true } });
        return;
      }

      sendJson(404, { success: false, error: 'Unhandled route' });
    });

    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    apiBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    vi.restoreAllMocks();
    state.connections = [];
    state.tools = [];
    state.notifications = [];
    state.runs = [
      {
        runId: 'run-1',
        source: 'schedule',
        status: 'completed',
      },
    ];
    state.scheduleJobs = [];
    state.previewQueries = [];
    state.reviewRequests = [];
    state.schedulerRunFails = false;
    state.monitoringEvents = [{ type: 'event', value: 'historical' }];
    state.monitoringEventQueries = [];
    state.notificationActionCalls = [];
    state.registryInstalls = [];
    state.feedbackRatings = [];
    state.acpConnections = [];
    state.voiceSessions = [];
    state.flowStartBodies = [];
    state.flowCommandBodies = [];
    state.flowEvaluateBodies = [];
    state.credentialRecoveryCalls = [];
    state.credentialRecoveryApplyOutcome = undefined;
    state.authorizationHeaders = [];
  });

  test('supports connections, tools, notifications, monitoring, schedule, runs, and knowledge surfaces', async () => {
    const { runCli } = await import('../cli.js');

    await runCli([
      'connections',
      'create',
      `--api-base=${apiBase}`,
      '--data={"id":"ollama-local","kind":"model","type":"ollama","name":"Ollama","enabled":true,"capabilities":["llm"],"config":{}}',
    ]);
    await runCli(['connections', 'models', `--api-base=${apiBase}`]);
    await runCli([
      'connections',
      'test',
      'ollama-local',
      `--api-base=${apiBase}`,
    ]);

    await runCli([
      'tools',
      'create',
      `--api-base=${apiBase}`,
      '--data={"id":"filesystem-tools","kind":"mcp","transport":"stdio","command":"npx","args":["-y","demo"],"displayName":"Filesystem Tools","description":"Local helpers"}',
    ]);
    await runCli([
      'tools',
      'reconnect',
      'filesystem-tools',
      `--api-base=${apiBase}`,
    ]);
    await runCli([
      'tools',
      'delete',
      'filesystem-tools',
      `--api-base=${apiBase}`,
    ]);

    await runCli([
      'notifications',
      'create',
      `--api-base=${apiBase}`,
      '--data={"title":"Approval needed","body":"Review this","category":"approval-request"}',
    ]);
    await runCli(['notifications', 'list', `--api-base=${apiBase}`]);
    await runCli([
      'notifications',
      'action',
      'notif-1',
      'accept',
      `--api-base=${apiBase}`,
    ]);
    await runCli(['notifications', 'providers', `--api-base=${apiBase}`]);
    await runCli(['notifications', 'clear', `--api-base=${apiBase}`]);

    await runCli(['monitoring', 'stats', `--api-base=${apiBase}`]);
    await runCli([
      'monitoring',
      'metrics',
      '--range=today',
      `--api-base=${apiBase}`,
    ]);
    await runCli([
      'monitoring',
      'events',
      '--start=2026-01-01',
      '--end=2026-12-31',
      `--api-base=${apiBase}`,
    ]);

    await runCli(['schedule', 'providers', `--api-base=${apiBase}`]);
    await runCli(['schedule', 'stats', `--api-base=${apiBase}`]);
    await runCli(['schedule', 'status', `--api-base=${apiBase}`]);
    await runCli([
      'schedule',
      'create',
      `--api-base=${apiBase}`,
      '--data={"name":"daily-report","prompt":"Generate report"}',
    ]);
    await runCli(['schedule', 'run', 'daily-report', `--api-base=${apiBase}`]);
    await runCli([
      'schedule',
      'update',
      'daily-report',
      `--api-base=${apiBase}`,
      '--data={"prompt":"Updated report"}',
    ]);
    await runCli([
      'schedule',
      'enable',
      'daily-report',
      `--api-base=${apiBase}`,
    ]);
    await runCli([
      'schedule',
      'disable',
      'daily-report',
      `--api-base=${apiBase}`,
    ]);
    await runCli([
      'schedule',
      'logs',
      'daily-report',
      '5',
      `--api-base=${apiBase}`,
    ]);
    await runCli([
      'schedule',
      'preview',
      '0 9 * * *',
      '1',
      `--api-base=${apiBase}`,
    ]);
    // #1536 R8: an operator could not express the zone at all, so a preview of a
    // ZONED job named different instants from the ones it fires at.
    await runCli([
      'schedule',
      'preview',
      '0 8 * * 1-5',
      '3',
      '--timezone=Australia/Brisbane',
      `--api-base=${apiBase}`,
    ]);
    await runCli([
      'schedule',
      'delete',
      'daily-report',
      `--api-base=${apiBase}`,
    ]);
    await runCli(['runs', 'list', `--api-base=${apiBase}`]);
    await runCli(['runs', 'read', 'run-1', `--api-base=${apiBase}`]);
    await runCli([
      'runs',
      'output',
      `--api-base=${apiBase}`,
      '--data={"source":"schedule","providerId":"built-in","runId":"run-1","artifactId":"log-1","kind":"text"}',
    ]);
    await runCli([
      'review',
      'run',
      'demo',
      `--api-base=${apiBase}`,
      '--data={"requestId":"request-1","mode":"initial","target":{"kind":"git-range","projectSlug":"demo","baseRevision":"origin/main","headRevision":"HEAD"},"implementerAgentSlug":"terra","reviewers":[{"reviewerId":"reviewer-1","executorAgentSlug":"station","lens":{"id":"architecture","instructions":"Review exact seams."}}]}',
    ]);
    await runCli(['review', 'list', 'demo', `--api-base=${apiBase}`]);
    await runCli([
      'review',
      'read',
      'demo',
      reviewReceipt.receiptId,
      `--api-base=${apiBase}`,
    ]);

    await runCli(['knowledge', 'status', `--api-base=${apiBase}`]);
    await runCli([
      'knowledge',
      'search',
      'README',
      '--top-k=5',
      `--api-base=${apiBase}`,
    ]);
    await runCli([
      'knowledge',
      'namespaces',
      'list',
      'demo',
      `--api-base=${apiBase}`,
    ]);
    await runCli([
      'knowledge',
      'docs',
      'list',
      'demo',
      `--api-base=${apiBase}`,
    ]);
    await runCli([
      'plugin',
      'registry',
      'agents',
      'list',
      `--api-base=${apiBase}`,
    ]);
    await runCli([
      'plugin',
      'registry',
      'skills',
      'install',
      'registry-skill',
      `--api-base=${apiBase}`,
    ]);
    await runCli(['auth', 'status', `--api-base=${apiBase}`]);
    await runCli(['auth', 'renew', `--api-base=${apiBase}`]);
    await runCli(['auth', 'users', 'search', 'test', `--api-base=${apiBase}`]);
    await runCli(['branding', 'get', `--api-base=${apiBase}`]);
    await runCli([
      'feedback',
      'rate',
      `--api-base=${apiBase}`,
      '--data={"conversationId":"conv-1","messageIndex":0,"messagePreview":"hi","rating":"thumbs_up"}',
    ]);
    await runCli(['feedback', 'ratings', `--api-base=${apiBase}`]);
    await runCli(['feedback', 'guidelines', `--api-base=${apiBase}`]);
    await runCli(['feedback', 'status', `--api-base=${apiBase}`]);
    await runCli(['feedback', 'test', `--api-base=${apiBase}`]);
    await runCli(['insights', 'get', '--days=7', `--api-base=${apiBase}`]);
    await runCli(['acp', 'status', `--api-base=${apiBase}`]);
    await runCli(['acp', 'commands', `--api-base=${apiBase}`]);
    await runCli([
      'acp',
      'command-options',
      '--q=plan',
      `--api-base=${apiBase}`,
    ]);
    await runCli([
      'acp',
      'connections',
      'create',
      `--api-base=${apiBase}`,
      '--data={"id":"demo-acp","command":"kiro-cli","name":"Demo ACP"}',
    ]);
    await runCli([
      'acp',
      'connections',
      'reconnect',
      'demo-acp',
      `--api-base=${apiBase}`,
    ]);
    await runCli(['voice', 'status', `--api-base=${apiBase}`]);
    await runCli([
      'voice',
      'create-session',
      `--api-base=${apiBase}`,
      '--data={"agentSlug":"station-voice"}',
    ]);
    await runCli([
      'voice',
      'delete-session',
      'voice-1',
      `--api-base=${apiBase}`,
    ]);

    expect(state.connections.map((entry) => entry.id)).toContain(
      'ollama-local',
    );
    expect(state.tools).toHaveLength(0);
    expect(state.notifications).toHaveLength(0);
    expect(state.notificationActionCalls).toEqual([
      { id: 'notif-1', actionId: 'accept' },
    ]);
    expect(state.registryInstalls).toEqual([
      { tab: 'skills', id: 'registry-skill' },
    ]);
    expect(state.feedbackRatings).toHaveLength(1);
    expect(state.acpConnections).toHaveLength(1);
    expect(state.voiceSessions).toHaveLength(0);
    expect(state.scheduleJobs).toHaveLength(1);
    // Omitted stays omitted — the server treats an unzoned schedule as UTC and
    // the CLI must not substitute a default of its own.
    expect(state.previewQueries[0]).not.toContain('timezone');
    expect(state.previewQueries[1]).toContain('timezone=Australia%2FBrisbane');
    expect(state.reviewRequests).toEqual([
      expect.objectContaining({
        mode: 'initial',
        target: expect.objectContaining({ projectSlug: 'demo' }),
      }),
    ]);
    // #173: `acp commands` and `acp command-options` now call the real
    // `GET /api/orchestration/providers/acp/commands` route (no more
    // `<agent-slug>` positional / dead `/acp/commands/*` mock). `acp
    // commands` (unfiltered) prints both fixture entries; `acp
    // command-options --q=plan`'s client-side filter should print a call
    // containing only the matching entry.
    const filteredCommandOptionsCall = _consoleLog.mock.calls.find(
      (call) =>
        typeof call[0] === 'string' &&
        call[0].includes('"name": "plan"') &&
        !call[0].includes('"name": "review"'),
    );
    expect(filteredCommandOptionsCall).toBeDefined();
  });

  // station#2844: flag-based engine-connection creation — adding a
  // command-backed engine no longer requires hand-rolled curl against
  // POST /acp/connections.
  test('acp connections create builds the route body from flags and the connection lands in the list', async () => {
    const { runCli } = await import('../cli.js');

    await runCli([
      'acp',
      'connections',
      'create',
      '--id=opencode',
      '--command=opencode',
      '--args=acp',
      '--args=--flagged',
      '--name=OpenCode',
      '--cwd=/tmp/probe',
      `--api-base=${apiBase}`,
    ]);

    // What this establishes is exactly one thing: the flags produce the same
    // body the JSON channel would have carried, so the route receives what
    // the caller meant. It deliberately does NOT claim anything about
    // server-side registration into delegate targets — the harness's list
    // reads back the array its own POST mock pushed, so it could not
    // observe registration even if that broke.
    expect(state.acpConnections).toEqual([
      {
        id: 'opencode',
        command: 'opencode',
        args: ['acp', '--flagged'],
        name: 'OpenCode',
        cwd: '/tmp/probe',
      },
    ]);

    await runCli(['acp', 'connections', 'list', `--api-base=${apiBase}`]);
    const listCall = _consoleLog.mock.calls.find(
      (call) =>
        typeof call[0] === 'string' && call[0].includes('"id": "opencode"'),
    );
    expect(listCall).toBeDefined();
  });

  test('acp connections create names the offending field and rule, not just "Validation failed" (station#2871)', async () => {
    const { runCli } = await import('../cli.js');

    await expect(
      runCli([
        'acp',
        'connections',
        'create',
        '--id=Bad_Id',
        '--command=opencode',
        `--api-base=${apiBase}`,
      ]),
    ).rejects.toThrow(
      /Validation failed: id .*lowercase letters, digits, and hyphens/,
    );
    expect(state.acpConnections).toHaveLength(0);
  });

  test('acp connections create names a missing required field (station#2871)', async () => {
    const { runCli } = await import('../cli.js');

    await expect(
      runCli([
        'acp',
        'connections',
        'create',
        '--id=opencode',
        `--api-base=${apiBase}`,
      ]),
    ).rejects.toThrow(/Validation failed: command Required/);
    expect(state.acpConnections).toHaveLength(0);
  });

  test('acp connections create rejects mixing create flags with a JSON payload instead of guessing precedence', async () => {
    const { runCli } = await import('../cli.js');

    await expect(
      runCli([
        'acp',
        'connections',
        'create',
        '--id=opencode',
        '--command=opencode',
        '--data={"id":"other"}',
        `--api-base=${apiBase}`,
      ]),
    ).rejects.toThrow('not both');
    expect(state.acpConnections).toHaveLength(0);
  });

  // A bare `--args` (no `=value`) parses as boolean `true` and its intended
  // value falls through to positionals. Dropping it silently would create an
  // engine with no argv — `--args acp` is precisely how someone writes it by
  // mistake, and an ACP engine without its `acp` argument never starts.
  test('acp connections create refuses a create flag given without a value rather than dropping it', async () => {
    const { runCli } = await import('../cli.js');

    await expect(
      runCli([
        'acp',
        'connections',
        'create',
        '--id=opencode',
        '--command=opencode',
        '--args',
        'acp',
        `--api-base=${apiBase}`,
      ]),
    ).rejects.toThrow('--args requires a value');
    expect(state.acpConnections).toHaveLength(0);
  });

  // The flag form must not consult stdin. Draining stdin to detect a piped
  // body blocks whenever stdin is open but idle — an unattended script or a
  // CI step would hang forever on a command that needs no input. This pins
  // the documented precedence (flags win, stdin is not read) and doubles as
  // the regression guard: a reintroduced blocking read makes this test time
  // out rather than fail, because `isTTY` is false under vitest exactly as
  // it is for those callers.
  test('acp connections create does not read stdin when create flags are present', async () => {
    const { runCli } = await import('../cli.js');
    const previousIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', {
      value: false,
      configurable: true,
    });

    try {
      await runCli([
        'acp',
        'connections',
        'create',
        '--id=from-flags',
        '--command=from-flags-cli',
        `--api-base=${apiBase}`,
      ]);
      expect(state.acpConnections).toEqual([
        { id: 'from-flags', command: 'from-flags-cli' },
      ]);
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', {
        value: previousIsTTY,
        configurable: true,
      });
    }
  });

  test('reports the exact run ID when a manual scheduler run fails', async () => {
    const { runCli } = await import('../cli.js');
    state.schedulerRunFails = true;

    await expect(
      runCli(['schedule', 'run', 'daily-report', `--api-base=${apiBase}`]),
    ).rejects.toThrow(
      'Scheduler job failed. Inspect the associated run for details. Run ID: schedule:built-in:daily-report:failed-1',
    );
  });

  test('uses a saved Station credential for a connections surface without printing it', async () => {
    const { runCli } = await import('../cli.js');
    const previousHome = process.env.STATION_HOME;
    const previousRoot = process.env.STATION_ROOT;
    const profileHome = mkdtempSync(join(tmpdir(), 'station-surface-auth-'));
    const credential = 'stored-surface-secret';
    const credentialRef = { kind: 'station-bearer' as const, id: 'surface' };

    process.env.STATION_HOME = profileHome;
    process.env.STATION_ROOT = profileHome;
    setProfileCredentialStore({
      get: (ref) => (ref.id === credentialRef.id ? credential : undefined),
      set: () => {},
      delete: () => {},
      status: () => 'available',
    });
    upsertProfile({
      name: 'surface',
      endpoint: apiBase,
      credentialRef,
      makeDefault: true,
    });

    try {
      await runCli(['connections', 'models', '--station=surface']);
      await runCli(['monitoring', 'events', '--station=surface']);
    } finally {
      resetProfileCredentialStoreForTests();
      rmSync(profileHome, { recursive: true, force: true });
      if (previousHome === undefined) delete process.env.STATION_HOME;
      else process.env.STATION_HOME = previousHome;
      if (previousRoot === undefined) delete process.env.STATION_ROOT;
      else process.env.STATION_ROOT = previousRoot;
    }

    expect(state.authorizationHeaders).toEqual([
      {
        path: '/api/connections/models',
        authorization: `Bearer ${credential}`,
      },
      {
        path: '/monitoring/events',
        authorization: `Bearer ${credential}`,
      },
    ]);
    expect(JSON.stringify(_consoleLog.mock.calls)).not.toContain(credential);
    expect(JSON.stringify(stdoutWrite.mock.calls)).not.toContain(credential);
  });

  test('uses an explicit credential for an auth surface without printing it', async () => {
    const { runCli } = await import('../cli.js');
    const credential = 'explicit-surface-secret';

    await runCli([
      'auth',
      'status',
      `--api-base=${apiBase}`,
      `--credential=${credential}`,
    ]);

    expect(state.authorizationHeaders).toEqual([
      {
        path: '/api/auth/status',
        authorization: `Bearer ${credential}`,
      },
    ]);
    expect(JSON.stringify(_consoleLog.mock.calls)).not.toContain(credential);
    expect(JSON.stringify(stdoutWrite.mock.calls)).not.toContain(credential);
  });

  test('supports the flow surface including attach-command', async () => {
    const { runCli } = await import('../cli.js');

    await runCli(['flow', 'definitions', 'demo', `--api-base=${apiBase}`]);
    await runCli(['flow', 'runs', 'demo', `--api-base=${apiBase}`]);
    await runCli([
      'flow',
      'start',
      'demo',
      '--definition=station-delivery',
      '--run-id=run-1',
      `--api-base=${apiBase}`,
    ]);
    await runCli(['flow', 'get', 'demo', 'run-1', `--api-base=${apiBase}`]);
    await runCli([
      'flow',
      'attach-command',
      'demo',
      'run-1',
      '--gate=implement-gate',
      '--command=npm run verify:static',
      '--claim-type=quality.static-checks',
      '--producer=station/verify-static',
      '--label=verify:static',
      '--supersede=ev.0',
      '--timeout-ms=60000',
      `--api-base=${apiBase}`,
    ]);
    await runCli([
      'flow',
      'evaluate',
      'demo',
      'run-1',
      '--gate=implement-gate',
      `--api-base=${apiBase}`,
    ]);
    await runCli(['flow', 'report', 'demo', 'run-1', `--api-base=${apiBase}`]);

    expect(state.flowStartBodies).toEqual([
      { definition: 'station-delivery', runId: 'run-1' },
    ]);
    expect(state.flowCommandBodies).toEqual([
      {
        gate: 'implement-gate',
        command: 'npm run verify:static',
        claimType: 'quality.static-checks',
        producer: 'station/verify-static',
        label: 'verify:static',
        supersede: ['ev.0'],
        timeoutMs: 60000,
      },
    ]);
    expect(state.flowEvaluateBodies).toEqual([{ gate: 'implement-gate' }]);
  });

  test('manages credential recovery profiles through safe, explicit requests', async () => {
    const { runCli } = await import('../cli.js');

    await runCli(['connections', 'recovery', 'codex', `--api-base=${apiBase}`]);
    const recoveryOutput = String(_consoleLog.mock.calls.at(-1)?.[0]);
    expect(recoveryOutput).not.toContain('Primary account');
    expect(recoveryOutput).not.toContain('must-not-print');

    await runCli(['connections', 'profiles', 'codex', `--api-base=${apiBase}`]);
    const profileListOutput = String(_consoleLog.mock.calls.at(-1)?.[0]);
    expect(profileListOutput).toContain('Primary account');
    await runCli([
      'connections',
      'profile-upsert',
      'codex',
      '--data={"ref":"recovery","label":"Recovery account"}',
      `--api-base=${apiBase}`,
    ]);
    await runCli([
      'connections',
      'profile-delete',
      'codex',
      'recovery/unsafe',
      `--api-base=${apiBase}`,
    ]);
    await runCli([
      'connections',
      'profile-enroll',
      'codex',
      'recovery',
      `--api-base=${apiBase}`,
    ]);
    await runCli([
      'connections',
      'profile-unenroll',
      'codex',
      'recovery',
      `--api-base=${apiBase}`,
    ]);
    await runCli([
      'connections',
      'recovery-policy',
      'codex',
      '--automatic=true',
      `--api-base=${apiBase}`,
    ]);
    await runCli([
      'connections',
      'profile-import',
      'codex',
      'recovery',
      '--include-credentials',
      `--api-base=${apiBase}`,
    ]);
    const importOutput = String(_consoleLog.mock.calls.at(-1)?.[0]);
    expect(importOutput).toContain('"copiedCount": 1');
    expect(importOutput).toContain('"skippedCount": 1');
    expect(importOutput).not.toContain('settings.json');
    expect(importOutput).not.toContain('must-not-print');
    await runCli([
      'connections',
      'profile-apply',
      'codex',
      'recovery',
      '--confirm',
      '--timeout-ms=45000',
      `--api-base=${apiBase}`,
    ]);

    expect(state.credentialRecoveryCalls).toEqual([
      {
        method: 'GET',
        path: '/api/connections/agent/codex/credential-recovery',
      },
      {
        method: 'GET',
        path: '/api/connections/agent/codex/credential-recovery',
      },
      {
        method: 'POST',
        path: '/api/connections/agent/codex/credential-recovery/profiles',
        body: { ref: 'recovery', label: 'Recovery account' },
      },
      {
        method: 'DELETE',
        path: '/api/connections/agent/codex/credential-recovery/profiles/recovery%2Funsafe',
      },
      {
        method: 'PUT',
        path: '/api/connections/agent/codex/credential-recovery/profiles/recovery/enrollment',
        body: { enrolled: true },
      },
      {
        method: 'PUT',
        path: '/api/connections/agent/codex/credential-recovery/profiles/recovery/enrollment',
        body: { enrolled: false },
      },
      {
        method: 'PUT',
        path: '/api/connections/agent/codex/credential-recovery/policy',
        body: { automatic: true },
      },
      {
        method: 'POST',
        path: '/api/connections/agent/codex/credential-recovery/profiles/recovery/import',
        body: { includeCredentials: true },
      },
      {
        method: 'POST',
        path: '/api/connections/agent/codex/credential-recovery/profiles/recovery/apply',
        body: { confirmed: true, timeoutMs: 45000 },
      },
    ]);

    const printed = _consoleLog.mock.calls
      .map((call) => String(call[0]))
      .join('\n');
    expect(printed).toContain('Primary account');
    expect(printed).not.toContain('must-not-print');
  });

  test('refuses profile application without an explicit confirmation flag', async () => {
    const { runCli } = await import('../cli.js');

    await expect(
      runCli([
        'connections',
        'profile-apply',
        'codex',
        'recovery',
        `--api-base=${apiBase}`,
      ]),
    ).rejects.toThrow('without --confirm');
    expect(state.credentialRecoveryCalls).toHaveLength(0);
  });

  test('rejects an apply timeout outside the server contract before requesting', async () => {
    const { runCli } = await import('../cli.js');

    await expect(
      runCli([
        'connections',
        'profile-apply',
        'codex',
        'recovery',
        '--confirm',
        '--timeout-ms=4999',
        `--api-base=${apiBase}`,
      ]),
    ).rejects.toThrow('integer from 5000 to 60000');
    expect(state.credentialRecoveryCalls).toHaveLength(0);
  });

  test('reports a rolled-back profile application as a failed command', async () => {
    const { runCli } = await import('../cli.js');
    state.credentialRecoveryApplyOutcome = 'rolled_back';

    await expect(
      runCli([
        'connections',
        'profile-apply',
        'codex',
        'recovery',
        '--confirm',
        `--api-base=${apiBase}`,
      ]),
    ).rejects.toThrow(
      'Credential recovery state changed before the requested operation could complete.',
    );
    expect(state.credentialRecoveryCalls).toHaveLength(1);
  });

  test('flow attach-command requires the core flags', async () => {
    const { runCli } = await import('../cli.js');
    await expect(
      runCli([
        'flow',
        'attach-command',
        'demo',
        'run-1',
        '--command=npm test',
        `--api-base=${apiBase}`,
      ]),
    ).rejects.toThrow('Missing required flag: --gate=<value>');
    expect(state.flowCommandBodies).toHaveLength(0);
  });

  test('insights events always bounds its window, so it cannot hang', async () => {
    const { runCli } = await import('../cli.js');

    // Without start/end the route falls through to its SSE branch and the
    // CLI awaits .json() on a stream that never ends. Nothing pinned this:
    // deleting the default-window block restored the hang with no test red.
    await runCli(['insights', 'events', `--api-base=${apiBase}`]);
    expect(state.monitoringEventQueries).toHaveLength(1);
    expect(state.monitoringEventQueries[0]).toContain('start=');
  });

  test('insights events anchors its default window on --end', async () => {
    const { runCli } = await import('../cli.js');

    // A default start pinned to `now` is AFTER any historical --end, and the
    // route answers start > end with an empty array and exit 0 — a
    // successful-looking report that the past contains nothing.
    await runCli([
      'insights',
      'events',
      '--end=2026-06-01T00:00:00.000Z',
      '--days=7',
      `--api-base=${apiBase}`,
    ]);
    const query = new URLSearchParams(state.monitoringEventQueries[0]);
    const start = Date.parse(String(query.get('start')));
    const end = Date.parse(String(query.get('end')));
    expect(start).toBeLessThan(end);
    expect(end - start).toBe(7 * 86_400_000);
  });

  test('insights events forwards --tools as the boolean the route reads', async () => {
    const { runCli } = await import('../cli.js');

    // `--tools` is a bare flag and buildQuery only forwards strings, so the
    // documented form was silently a no-op — fail-open, returning every
    // event instead of tool events, with no error.
    await runCli(['insights', 'events', '--tools', `--api-base=${apiBase}`]);
    expect(state.monitoringEventQueries[0]).toContain('tools=true');
  });

  test('insights events rejects a --days it cannot use', async () => {
    const { runCli } = await import('../cli.js');

    await expect(
      runCli(['insights', 'events', '--days=0', `--api-base=${apiBase}`]),
    ).rejects.toThrow(/positive integer/);
    expect(state.monitoringEventQueries).toHaveLength(0);
  });

  test('monitoring events with only --limit streams, it does not hang', async () => {
    const { runCli } = await import('../cli.js');

    // The route serves historical JSON only when a time bound is present.
    // Branching the verb on "any query string" meant that adding --limit
    // sent a bound-less request down the JSON path, where requestJson awaits
    // .json() on a stream — the same hang this change fixed for `insights
    // events`, reintroduced by the flag advertising the fix.
    await runCli([
      'monitoring',
      'events',
      '--limit=10',
      `--api-base=${apiBase}`,
    ]);
    expect(state.monitoringEventQueries).toHaveLength(1);
  });

  test('insights events anchors on an epoch-millisecond --end too', async () => {
    const { runCli } = await import('../cli.js');

    // Date.parse('1767225600000') is NaN, so this documented form anchored
    // the default window on `now` instead: start > end, empty array, exit 0.
    const end = Date.parse('2026-06-01T00:00:00.000Z');
    await runCli([
      'insights',
      'events',
      `--end=${end}`,
      '--days=7',
      `--api-base=${apiBase}`,
    ]);
    const query = new URLSearchParams(state.monitoringEventQueries[0]);
    const start = Date.parse(String(query.get('start')));
    expect(start).toBeLessThan(end);
    expect(end - start).toBe(7 * 86_400_000);
  });

  test('monitoring events forwards --limit, so the read can be bounded', async () => {
    const { runCli } = await import('../cli.js');

    // The route's cap is opt-in. A flag the route honours but the verb drops
    // is a flag that does not exist.
    await runCli([
      'monitoring',
      'events',
      '--start=0',
      '--limit=10',
      `--api-base=${apiBase}`,
    ]);
    expect(state.monitoringEventQueries[0]).toContain('limit=10');
  });
});
