import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  type MockInstance,
  test,
  vi,
} from 'vitest';
import { describeApiError } from '../commands/core-api.js';
import {
  resetProfileCredentialStoreForTests,
  setProfileCredentialStore,
} from '../commands/profile-credentials.js';
import { upsertProfile } from '../commands/profile-store.js';
import { consumeSseFrames } from '../commands/session-client.js';
import { readBody } from './helpers/http-test-helpers.js';

type AgentRecord = {
  slug: string;
  name: string;
  prompt?: string;
  execution?: { agentConnectionId?: string };
  /**
   * station#977: the enriched `/api/agents` payload's engine identity for a
   * persisted agent bound to a runtime connection ('station' for Station's
   * own engine, otherwise the engine's canonical id, e.g. 'claude-code' /
   * 'codex' / 'acp') — see `enriched-agents.ts`'s `buildAgentPayload`.
   */
  engineId?: string;
};
type ProjectRecord = { slug: string; name: string; workingDirectory?: string };
type SkillRecord = { name: string; body: string };
type ConversationRecord = {
  id: string;
  resourceId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};
type ConnectionRecord = {
  id: string;
  kind: string;
  type: string;
  name: string;
  enabled: boolean;
  capabilities: string[];
  config: Record<string, unknown>;
  status: string;
  prerequisites: unknown[];
};

const defaultConnections = (): ConnectionRecord[] => [
  {
    id: 'claude',
    kind: 'agent',
    type: 'claude',
    name: 'Claude Code',
    enabled: true,
    capabilities: ['agent-runtime', 'resume'],
    config: { provider: 'claude', engineId: 'claude-code' },
    status: 'ready',
    prerequisites: [],
  },
  {
    id: 'codex',
    kind: 'agent',
    type: 'codex',
    name: 'Codex',
    enabled: true,
    capabilities: ['agent-runtime', 'resume'],
    config: { provider: 'codex', engineId: 'codex' },
    status: 'ready',
    prerequisites: [],
  },
  {
    id: 'kiro',
    kind: 'agent',
    type: 'acp',
    name: 'Kiro',
    enabled: true,
    capabilities: ['agent-runtime', 'acp', 'resume'],
    config: { engineId: 'kiro' },
    status: 'ready',
    prerequisites: [],
  },
  {
    id: 'custom-box',
    kind: 'agent',
    type: 'custom',
    name: 'Custom runtime',
    enabled: true,
    capabilities: ['agent-runtime'],
    config: { provider: 'custom-provider', engineId: 'custom' },
    status: 'ready',
    prerequisites: [],
  },
];

const defaultAgents = (): AgentRecord[] => [
  { slug: 'station', name: 'Station', prompt: 'Be helpful.' },
  { slug: 'custom-agent', name: 'Custom agent', prompt: 'Be helpful.' },
  {
    slug: 'claude',
    name: 'Claude Code',
    execution: { agentConnectionId: 'claude' },
    engineId: 'claude-code',
  },
  {
    slug: 'codex',
    name: 'Codex',
    execution: { agentConnectionId: 'codex' },
    engineId: 'codex',
  },
  {
    slug: 'kiro',
    name: 'Kiro',
    execution: { agentConnectionId: 'kiro' },
    engineId: 'kiro',
  },
  {
    slug: 'custom-box',
    name: 'Custom runtime',
    execution: { agentConnectionId: 'custom-box' },
    engineId: 'custom',
  },
];

describe('CLI core commands over HTTP', () => {
  let server: ReturnType<typeof createServer>;
  let apiBase = '';
  let stdoutWrite: MockInstance;
  let _consoleLog: MockInstance;
  const orchestrationCommands: Array<Record<string, unknown>> = [];
  const authorizationHeaders: Array<string | undefined> = [];
  // Populated per-`beforeEach` below. Lets a test assert the *client*
  // actually tore down its SSE connection (rather than the mock server
  // ending the response itself) — see the scripted `/api/orchestration/
  // events` branch's comment for why this matters (#165 iteration-2
  // code-review HIGH fix).
  let waitForWatchStreamClose: (threadId: string) => Promise<void>;
  // The plain (non-`--watch`, non-`threadId`-scoped) `/api/orchestration/
  // events` fetch carries no `threadId` query param
  // (the real route multiplexes every thread; the client filters
  // client-side), and is content-agnostic until the mock server actually
  // knows which thread's turn to simulate completing. Rather than guessing
  // that timing with a fixed `setTimeout` (racy — the canonical execution
  // request can itself take longer than a short fixed delay
  // depending on machine load, as a hang while developing this mock
  // discovered), the handler below stores the still-open response and the
  // canonical chat handler writes the synthetic
  // `content.text-delta`/`turn.completed` events directly from the request
  // that determines the thread id — deterministic
  // regardless of a fresh, never-loaded thread id (#184) or the pre-seeded
  // `'runtime-thread'`.
  let pendingChatEventsResponse: import('node:http').ServerResponse | null =
    null;
  // Resolves when the client tears down the plain (non-scripted) chat event
  // stream. Lets a test prove chat's `finally` aborts its SSE reader
  // on every exit path — including a canonical endpoint rejection — instead of leaking
  // the open socket and hanging the CLI forever (#chat).
  let chatEventsClosed: Promise<void>;
  let resolveChatEventsClosed: () => void = () => undefined;
  const structuredErrorPaths = new Set<string>();

  const state: {
    agents: AgentRecord[];
    projects: ProjectRecord[];
    skills: SkillRecord[];
    conversations: ConversationRecord[];
    conversationMessages: Record<string, Array<Record<string, unknown>>>;
    connections: ConnectionRecord[];
    runtimeSessions: Array<Record<string, unknown>>;
    runtimeSessionEvents: Record<string, Array<Record<string, unknown>>>;
    runtimeSessionRecoveries: Record<string, Record<string, unknown>>;
    sseEventsByThread: Record<string, Array<Record<string, unknown>>>;
    /**
     * station#1782 AC5 rejection path: thread ids whose session-detail
     * response omits the `session` member entirely, standing in for a peer
     * that returns events without a summary. The join then has nothing to
     * read, which must render an explicit `answerability unknown` marker
     * rather than fold to "answerable".
     */
    detailOmitsSession: Set<string>;
  } = {
    agents: defaultAgents(),
    projects: [],
    skills: [],
    conversations: [
      {
        id: 'conv-http-test',
        resourceId: 'station',
        title: 'hello http world',
        createdAt: '2026-04-18T00:00:00.000Z',
        updatedAt: '2026-04-18T00:00:01.000Z',
      },
    ],
    conversationMessages: {
      'conv-http-test': [
        { role: 'user', content: 'hello http world' },
        { role: 'assistant', content: 'Echo: hello http world' },
      ],
    },
    connections: defaultConnections(),
    runtimeSessions: [
      {
        provider: 'codex',
        threadId: 'runtime-thread',
        status: 'running',
        isLoaded: true,
        isPersisted: true,
        eventCount: 2,
        createdAt: '2026-04-18T00:00:00.000Z',
        updatedAt: '2026-04-18T00:00:01.000Z',
        lastEventMethod: 'turn.completed',
      },
    ],
    runtimeSessionEvents: {},
    runtimeSessionRecoveries: {},
    sseEventsByThread: {},
    detailOmitsSession: new Set<string>(),
  };

  beforeEach(async () => {
    stdoutWrite = vi.spyOn(process.stdout, 'write');
    stdoutWrite.mockImplementation(() => true);
    _consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    pendingChatEventsResponse = null;
    chatEventsClosed = new Promise<void>((resolve) => {
      resolveChatEventsClosed = resolve;
    });

    const watchStreamCloseResolvers = new Map<string, () => void>();
    const closedWatchThreads = new Set<string>();
    waitForWatchStreamClose = (threadId: string) =>
      closedWatchThreads.has(threadId)
        ? Promise.resolve()
        : new Promise<void>((resolvePromise) => {
            watchStreamCloseResolvers.set(threadId, resolvePromise);
          });

    server = createServer(async (req, res) => {
      const method = req.method || 'GET';
      authorizationHeaders.push(req.headers.authorization);
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const body =
        method === 'POST' || method === 'PUT' || method === 'PATCH'
          ? await readBody(req)
          : undefined;

      const sendJson = (status: number, payload: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      if (structuredErrorPaths.has(url.pathname)) {
        sendJson(401, {
          success: false,
          error: { code: 'authentication_required' },
        });
        return;
      }

      if (method === 'GET' && url.pathname === '/api/agents') {
        sendJson(200, { success: true, data: state.agents });
        return;
      }

      // station#977 review fix: the CLI's managed-agent-external-engine
      // classification (`resolveManagedAgentExternalEngineTarget`,
      // session-client.ts) hits this cheap, reload-free endpoint instead of
      // the full `GET /api/agents` listing — see `enriched-agents.ts`'s
      // `/:slug/binding` route docblock for why (avoiding a full
      // `reloadAgents()` on every `station chat <slug>`).
      const agentBindingMatch = url.pathname.match(
        /^\/api\/agents\/([^/]+)\/binding$/,
      );
      if (method === 'GET' && agentBindingMatch) {
        const slug = decodeURIComponent(agentBindingMatch[1]);
        const agent = state.agents.find((entry) => entry.slug === slug);
        if (!agent) {
          sendJson(404, { success: false, error: 'Agent not found' });
          return;
        }
        sendJson(200, {
          success: true,
          data: {
            ...(agent.execution?.agentConnectionId
              ? { agentConnectionId: agent.execution.agentConnectionId }
              : {}),
            ...(agent.engineId ? { engineId: agent.engineId } : {}),
          },
        });
        return;
      }

      const agentGetMatch = url.pathname.match(/^\/api\/agents\/([^/]+)$/);
      if (method === 'GET' && agentGetMatch) {
        const slug = decodeURIComponent(agentGetMatch[1]);
        if (slug === 'boom-agent') {
          sendJson(500, { success: false, error: 'Synthetic agents failure' });
          return;
        }
        const agent = state.agents.find((entry) => entry.slug === slug);
        if (!agent) {
          sendJson(404, { success: false, error: 'Agent not found' });
          return;
        }
        sendJson(200, { success: true, data: agent });
        return;
      }

      if (method === 'POST' && url.pathname === '/agents') {
        const nextAgent = {
          slug: body.slug || `agent-${state.agents.length + 1}`,
          name: body.name,
          prompt: body.prompt,
        };
        state.agents.push(nextAgent);
        sendJson(201, { success: true, data: nextAgent });
        return;
      }

      if (method === 'GET' && url.pathname === '/api/projects') {
        sendJson(200, { success: true, data: state.projects });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/projects') {
        const nextProject = {
          slug: body.slug || `project-${state.projects.length + 1}`,
          name: body.name,
        };
        state.projects.push(nextProject);
        sendJson(201, { success: true, data: nextProject });
        return;
      }

      const projectGetMatch = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
      if (method === 'GET' && projectGetMatch) {
        const slug = decodeURIComponent(projectGetMatch[1]);
        const project = state.projects.find((entry) => entry.slug === slug);
        if (!project) {
          sendJson(404, { success: false, error: 'Project not found' });
          return;
        }
        sendJson(200, { success: true, data: project });
        return;
      }

      if (method === 'GET' && url.pathname === '/api/skills') {
        sendJson(200, { success: true, data: state.skills });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/skills/local') {
        state.skills.push({ name: body.name, body: body.body });
        sendJson(201, {
          success: true,
          data: { success: true, message: 'Created' },
        });
        return;
      }

      // station#977 guard test: generalized from the original literal
      // '/api/agents/station/chat' match so a Station-engine-bound agent
      // OTHER than 'station' can also be asserted as still landing on this
      // (Station-engine) `/chat` path rather than orchestration — the body
      // below never reads the slug, so this is a pure widening, not a
      // behavior change for any existing 'station'-only test.
      const managedChatMatch = url.pathname.match(
        /^\/api\/agents\/([^/]+)\/chat$/,
      );
      if (method === 'POST' && managedChatMatch) {
        if (body.input === 'trigger stream error') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write(
            `data: ${JSON.stringify({
              type: 'error',
              error: { message: 'Synthetic stream failure' },
            })}\n\n`,
          );
          res.end('data: [DONE]\n\n');
          return;
        }
        // station#979 AC6: the managed (Station-agent) tool-approval-request
        // SSE chunk — a real approvalId/toolName shape distinct from the
        // canonical `request.opened` runtime event (see
        // `printManagedPendingRequestNotice`'s docblock in session-client.ts).
        if (body.input === 'trigger tool approval') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write(
            `data: ${JSON.stringify({
              type: 'tool-approval-request',
              approvalId: 'approval-1',
              toolName: 'bash',
              server: 'local',
              tool: 'bash',
              toolDescription: 'Run rm -rf tmp/?',
            })}\n\n`,
          );
          res.write(
            `data: ${JSON.stringify({
              type: 'finish',
              finishReason: 'stop',
            })}\n\n`,
          );
          res.end('data: [DONE]\n\n');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(
          `data: ${JSON.stringify({
            type: 'conversation-started',
            conversationId: 'conv-http-test',
          })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({ type: 'text-delta', text: 'Echo: ' })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({
            type: 'text-delta',
            text: body.input,
          })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({
            type: 'finish',
            finishReason: 'stop',
          })}\n\n`,
        );
        res.end('data: [DONE]\n\n');
        return;
      }

      const conversationsMatch = url.pathname.match(
        /^\/agents\/([^/]+)\/conversations$/,
      );
      if (method === 'GET' && conversationsMatch) {
        const slug = decodeURIComponent(conversationsMatch[1]);
        sendJson(200, {
          success: true,
          data: state.conversations.filter(
            (conversation) => conversation.resourceId === slug,
          ),
        });
        return;
      }

      const messagesMatch = url.pathname.match(
        /^\/agents\/([^/]+)\/conversations\/([^/]+)\/messages$/,
      );
      if (method === 'GET' && messagesMatch) {
        const conversationId = decodeURIComponent(messagesMatch[2]);
        sendJson(200, {
          success: true,
          data: state.conversationMessages[conversationId] || [],
        });
        return;
      }

      if (method === 'GET' && url.pathname === '/api/orchestration/events') {
        const watchedThreadId = url.searchParams.get('threadId');
        const scripted = watchedThreadId
          ? state.sseEventsByThread[watchedThreadId]
          : undefined;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        // #168 regression coverage: the real route always opens with an
        // `orchestration:snapshot` frame (`{sessions}`, no `method` field
        // — `src-server/routes/orchestration/orchestration.ts:305-309`) before any
        // per-thread events. Emitting it here unconditionally, for every
        // `/api/orchestration/events` connection this mock serves,
        // verifies pre-#168 callers (`sendMessage`'s single-thread stream
        // below, `approvals.ts`'s `--watch`) are byte-for-byte unaffected
        // by the `consumeSseFrames` extension: neither passes `onSnapshot`,
        // so this frame must be silently skipped exactly as it always was
        // (previously dropped by the `threadId` filter since the snapshot
        // frame carries no `threadId`; now dropped by the new snapshot
        // classification instead) — every existing assertion in this file
        // that exercises `/api/orchestration/events` (the full suite below)
        // is this regression's evidence.
        res.write(
          `data: ${JSON.stringify({ sessions: state.runtimeSessions })}\n\n`,
        );
        if (scripted) {
          // Approvals `--watch` tests: stream a fixed, ordered script of
          // canonical runtime events (nested under `{event}`, matching the
          // real `/api/orchestration/events` payload shape) for the
          // requested thread, then — matching the real route's actual
          // behavior (`src-server/routes/orchestration/orchestration.ts:319-362`, which
          // never ends its own response and only stops via
          // `stream.onAbort()`) — KEEP THE CONNECTION OPEN. No `res.end()`
          // here; the response only ends when the client disconnects
          // (`req.on('close')` below), same as the non-scripted branch a
          // few lines down. This is what makes the `--watch` auto-exit test
          // prove the *client* calls `AbortController.abort()`/
          // `reader.cancel()` after `session.exited` instead of merely
          // reacting to the server ending the stream on its own (#165
          // iteration-2 code-review HIGH fix — the mock previously called
          // `res.end()` immediately, which masked a missing client-side
          // abort).
          for (const scriptedEvent of scripted) {
            res.write(`data: ${JSON.stringify({ event: scriptedEvent })}\n\n`);
          }
          req.on('close', () => {
            if (watchedThreadId) {
              closedWatchThreads.add(watchedThreadId);
              watchStreamCloseResolvers.get(watchedThreadId)?.();
            }
            res.end();
          });
          return;
        }
        // `res.writeHead()` alone does not flush the response to the
        // socket — Node defers sending headers until the first `write()`/
        // `end()` call. Without an immediate write here, the client's
        // `fetch('/api/orchestration/events')` would never resolve (it
        // needs the response to actually arrive), which would deadlock
        // against the canonical execution request that only fires *after*
        // that fetch resolves. A blank SSE comment line (`:\n\n`, the standard
        // SSE keep-alive/no-op frame — ignored by `extractSseData`, which
        // only looks for `data: ` lines) forces the flush immediately, and
        // the real scripted events are written later, off the canonical
        // request (#184 — discovered via a hang while developing this
        // mock).
        res.write(':\n\n');
        pendingChatEventsResponse = res;
        req.on('close', () => {
          if (pendingChatEventsResponse === res) {
            pendingChatEventsResponse = null;
          }
          resolveChatEventsClosed();
          res.end();
        });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/orchestration/commands') {
        orchestrationCommands.push(body);
        if (
          body.type === 'interruptTurn' &&
          typeof body.threadId === 'string'
        ) {
          state.runtimeSessions = state.runtimeSessions.map((session) =>
            session.threadId === body.threadId
              ? {
                  ...session,
                  status: 'interrupted',
                  lastEventMethod: 'turn.aborted',
                }
              : session,
          );
        }
        if (body.type === 'respondToRequest') {
          sendJson(200, {
            success: true,
            data: { ok: true },
            receipt: {
              commandId: `receipt-${body.requestId}`,
              type: body.type,
              threadId: body.threadId,
            },
          });
          return;
        }
        sendJson(200, { success: true, data: { ok: true } });
        return;
      }

      const continueChatMatch = url.pathname.match(
        /^\/api\/orchestration\/chat\/([^/]+)\/continue$/,
      );
      if (
        method === 'POST' &&
        (url.pathname === '/api/orchestration/chat' || continueChatMatch)
      ) {
        const chatThreadId = continueChatMatch
          ? decodeURIComponent(continueChatMatch[1])
          : body.conversationId;
        const continuedAgent = chatThreadId.startsWith('managed-')
          ? 'station'
          : chatThreadId === 'kiro-thread'
            ? 'kiro'
            : chatThreadId === 'dogfood-thread'
              ? 'custom-box'
              : 'codex';
        orchestrationCommands.push({
          type: continueChatMatch ? 'continueTarget' : 'executeTarget',
          input: body,
        });
        const chatInputText = body.message;
        const target = (
          continueChatMatch
            ? { agent: continuedAgent, environment: body.environment }
            : body.target
        ) as {
          agent?: string;
          environment?: { kind?: string; id?: string };
          model?: { override?: string; options?: Record<string, unknown> };
          workspace?: { kind?: string; cwd?: string };
        };
        if (target.model?.override === 'trigger-start-400') {
          sendJson(400, {
            success: false,
            error: 'Ollama adapter requires a launchable model selector.',
          });
          return;
        }
        if (target.model?.override === 'trigger-acp-model-override') {
          sendJson(400, {
            success: false,
            error: 'model-override-unsupported: override-unsupported',
          });
          return;
        }
        if (target.model?.options?.systemPrompt) {
          sendJson(400, {
            success: false,
            error: `Unsupported option 'systemPrompt' for codex target '${chatThreadId}'`,
          });
          return;
        }
        if (
          target.workspace?.kind === 'directory' &&
          target.workspace.cwd === '/never/created/directory'
        ) {
          sendJson(400, {
            success: false,
            error:
              'Requested working directory does not exist: /never/created/directory',
          });
          return;
        }
        if (pendingChatEventsResponse) {
          if (chatInputText === 'trigger stream error') {
            pendingChatEventsResponse.write(
              `data: ${JSON.stringify({
                provider: 'station',
                threadId: chatThreadId,
                createdAt: new Date().toISOString(),
                method: 'runtime.error',
                message: 'Synthetic stream failure',
              })}\n\n`,
            );
          } else if (chatInputText.startsWith('trigger request opened')) {
            pendingChatEventsResponse.write(
              `data: ${JSON.stringify({
                provider: 'codex',
                threadId: chatThreadId,
                createdAt: new Date().toISOString(),
                method: 'request.opened',
                requestId: 'req-open-1',
                requestType: 'approval',
                title: 'Approve the write?',
                sessionState: 'needs_input',
              })}\n\n`,
            );
            if (chatInputText === 'trigger request opened') {
              pendingChatEventsResponse.write(
                `data: ${JSON.stringify({
                  provider: 'codex',
                  threadId: chatThreadId,
                  createdAt: new Date().toISOString(),
                  method: 'turn.completed',
                  turnId: 'turn-1',
                  finishReason: 'stop',
                })}\n\n`,
              );
            }
          } else {
            const deltas =
              target.agent === 'station'
                ? ['Echo: ', chatInputText]
                : ['CODEX_RUNTIME_OK'];
            for (const delta of deltas) {
              pendingChatEventsResponse.write(
                `data: ${JSON.stringify({
                  provider: 'codex',
                  threadId: chatThreadId,
                  createdAt: new Date().toISOString(),
                  method: 'content.text-delta',
                  itemId: 'content-1',
                  delta,
                })}\n\n`,
              );
            }
            pendingChatEventsResponse.write(
              `data: ${JSON.stringify({
                provider: 'codex',
                threadId: chatThreadId,
                createdAt: new Date().toISOString(),
                method: 'turn.completed',
                turnId: 'turn-1',
                finishReason: 'stop',
              })}\n\n`,
            );
          }
        }
        sendJson(200, {
          success: true,
          data: {
            conversationId: chatThreadId,
            sessionId: chatThreadId,
            // A successful foreground receipt must carry the exact terminal
            // correlation. The stream fixture above uses the same provider
            // turn, so this models an accepted dispatch rather than the
            // explicit missing-identity/indeterminate path.
            providerTurnId: 'turn-1',
            target: { kind: 'agent', id: target.agent },
            resolution: {
              schemaVersion: 'station.execution-resolution/v1',
              resolvedAt: new Date().toISOString(),
              environmentId: target.environment?.id ?? 'env-current',
              agentId: target.agent,
              engineConnectionId: target.agent,
              provider: 'codex',
              modelLaunchPlan: { selection: 'engine' },
            },
          },
        });
        return;
      }

      const connectionMatch = url.pathname.match(
        /^\/api\/connections\/([^/]+)$/,
      );
      if (method === 'GET' && connectionMatch) {
        const connectionId = decodeURIComponent(connectionMatch[1]);
        const connection = state.connections.find(
          (candidate) => candidate.id === connectionId,
        );
        if (!connection) {
          sendJson(404, { success: false, error: 'Connection not found' });
          return;
        }
        sendJson(200, { success: true, data: connection });
        return;
      }

      if (
        method === 'GET' &&
        url.pathname === '/api/orchestration/sessions/read-model'
      ) {
        sendJson(200, { success: true, data: state.runtimeSessions });
        return;
      }

      const runtimeSessionMatch = url.pathname.match(
        /^\/api\/orchestration\/sessions\/([^/]+)$/,
      );
      if (method === 'GET' && runtimeSessionMatch) {
        const threadId = decodeURIComponent(runtimeSessionMatch[1]);
        const session = state.runtimeSessions.find(
          (entry) => entry.threadId === threadId,
        );
        if (!session) {
          sendJson(404, { success: false, error: 'Not found' });
          return;
        }
        const events = state.runtimeSessionEvents[threadId] ?? [
          {
            provider: 'codex',
            threadId,
            eventId: 'evt-1',
            createdAt: '2026-04-18T00:00:00.000Z',
            method: 'turn.started',
            turnId: 'turn-1',
          },
          {
            provider: 'codex',
            threadId,
            eventId: 'evt-2',
            createdAt: '2026-04-18T00:00:01.000Z',
            method: 'turn.completed',
            turnId: 'turn-1',
            finishReason: 'stop',
          },
        ];
        if (state.detailOmitsSession.has(threadId)) {
          sendJson(200, { success: true, data: { events } });
          return;
        }
        sendJson(200, {
          success: true,
          data: {
            session,
            events,
            ...(state.runtimeSessionRecoveries[threadId]
              ? { recovery: state.runtimeSessionRecoveries[threadId] }
              : {}),
          },
        });
        return;
      }

      sendJson(404, { success: false, error: 'Unhandled route' });
    });

    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address() as AddressInfo;
    apiBase = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    vi.restoreAllMocks();
    state.agents = defaultAgents();
    state.projects = [];
    state.skills = [];
    state.conversations = [
      {
        id: 'conv-http-test',
        resourceId: 'station',
        title: 'hello http world',
        createdAt: '2026-04-18T00:00:00.000Z',
        updatedAt: '2026-04-18T00:00:01.000Z',
      },
    ];
    state.conversationMessages = {
      'conv-http-test': [
        { role: 'user', content: 'hello http world' },
        { role: 'assistant', content: 'Echo: hello http world' },
      ],
    };
    state.connections = defaultConnections();
    state.runtimeSessions = [
      {
        provider: 'codex',
        threadId: 'runtime-thread',
        status: 'running',
        isLoaded: true,
        isPersisted: true,
        eventCount: 2,
        createdAt: '2026-04-18T00:00:00.000Z',
        updatedAt: '2026-04-18T00:00:01.000Z',
        lastEventMethod: 'turn.completed',
      },
    ];
    state.runtimeSessionEvents = {};
    state.sseEventsByThread = {};
    state.detailOmitsSession = new Set<string>();
    structuredErrorPaths.clear();
    orchestrationCommands.length = 0;
    authorizationHeaders.length = 0;
  });

  test('supports CRUD-style resource commands and chat through the shared CLI surface', async () => {
    const { runCli } = await import('../cli.js');

    await runCli([
      'agents',
      'create',
      `--api-base=${apiBase}`,
      '--data={"name":"Planner","slug":"planner","prompt":"Plan carefully."}',
    ]);
    await runCli([
      'projects',
      'create',
      `--api-base=${apiBase}`,
      '--data={"name":"Launchpad","slug":"launchpad"}',
    ]);
    await runCli([
      'skills',
      'create',
      `--api-base=${apiBase}`,
      '--data={"name":"ship-it","body":"Execute the task."}',
    ]);
    await runCli([
      'chat',
      'station',
      'hello http world',
      `--api-base=${apiBase}`,
    ]);

    expect(state.agents.map((agent) => agent.slug)).toContain('planner');
    expect(state.projects.map((project) => project.slug)).toContain(
      'launchpad',
    );
    expect(state.skills.map((skill) => skill.name)).toContain('ship-it');
    expect(stdoutWrite).toHaveBeenCalledWith('Echo: ');
    expect(stdoutWrite).toHaveBeenCalledWith('hello http world');
  });

  test('representative generic verbs render structured API error codes, never objects', async () => {
    const { runCli } = await import('../cli.js');
    const cases = [
      { args: ['connections', 'list'], path: '/api/connections' },
      { args: ['agents', 'list'], path: '/api/agents' },
      { args: ['projects', 'list'], path: '/api/projects' },
    ];

    for (const testCase of cases) {
      structuredErrorPaths.add(testCase.path);
      let failure: unknown;
      try {
        await runCli([...testCase.args, `--api-base=${apiBase}`]);
      } catch (error) {
        failure = error;
      }
      expect(failure, testCase.args.join(' ')).toBeInstanceOf(Error);
      expect((failure as Error).message, testCase.args.join(' ')).toContain(
        'authentication_required',
      );
      structuredErrorPaths.delete(testCase.path);
    }
  });

  test('surfaces structured stream errors from chat responses', async () => {
    const { runCli } = await import('../cli.js');

    await expect(
      runCli([
        'chat',
        'station',
        'trigger stream error',
        `--api-base=${apiBase}`,
      ]),
    ).rejects.toThrow('Synthetic stream failure');
  });

  test('continues a bound Agent conversation through orchestration streaming', async () => {
    const { runCli } = await import('../cli.js');

    await runCli([
      'chat',
      'codex',
      'say runtime ok',
      '--conversation=runtime-thread',
      `--api-base=${apiBase}`,
    ]);

    expect(orchestrationCommands).toEqual([
      {
        type: 'continueTarget',
        input: {
          message: 'say runtime ok',
          environment: { kind: 'current' },
        },
      },
    ]);
    expect(stdoutWrite).toHaveBeenCalledWith('CODEX_RUNTIME_OK');
  });

  test('sends a custom Agent through the canonical execution target', async () => {
    state.agents.push({
      slug: 'engine-lab',
      name: 'Engine Lab',
      execution: { agentConnectionId: 'codex' },
      engineId: 'codex',
    });
    const { runCli } = await import('../cli.js');

    await runCli([
      'chat',
      'engine-lab',
      'say routed ok',
      '--model=gpt-5.4',
      `--api-base=${apiBase}`,
    ]);

    // Never hit the Station-engine `/chat` lens for this agent.
    expect(orchestrationCommands).toContainEqual({
      type: 'executeTarget',
      input: {
        message: 'say routed ok',
        conversationId: expect.any(String),
        target: {
          environment: { kind: 'current' },
          agent: 'engine-lab',
          workspace: { kind: 'directory', cwd: process.cwd() },
          model: { override: 'gpt-5.4' },
        },
      },
    });
    expect(stdoutWrite).toHaveBeenCalledWith('CODEX_RUNTIME_OK');
  });

  test('sends a Station-engine-bound Agent through the same canonical chat endpoint', async () => {
    state.agents.push({
      slug: 'station-writer',
      name: 'Station Writer',
      execution: { agentConnectionId: 'bedrock-main' },
      engineId: 'station',
    });
    const { runCli } = await import('../cli.js');

    await runCli([
      'chat',
      'station-writer',
      'hello http world',
      `--api-base=${apiBase}`,
    ]);

    expect(orchestrationCommands).toContainEqual(
      expect.objectContaining({
        type: 'executeTarget',
        input: expect.objectContaining({
          target: expect.objectContaining({ agent: 'station-writer' }),
        }),
      }),
    );
  });

  test('routes an ACP-backed Agent without exposing connection metadata', async () => {
    const { runCli } = await import('../cli.js');

    await runCli([
      'chat',
      'kiro',
      'hello from kiro',
      '--session=kiro-thread',
      `--api-base=${apiBase}`,
    ]);

    expect(orchestrationCommands).toEqual([
      {
        type: 'continueTarget',
        input: {
          message: 'hello from kiro',
          environment: { kind: 'current' },
        },
      },
    ]);
  });

  test('canonical chat is orchestration-backed for every Agent kind', async () => {
    const { runCli } = await import('../cli.js');

    await runCli([
      'chat',
      'station',
      'say hi flag off',
      `--api-base=${apiBase}`,
    ]);

    expect(orchestrationCommands).toContainEqual(
      expect.objectContaining({
        type: 'executeTarget',
        input: expect.objectContaining({
          target: expect.objectContaining({ agent: 'station' }),
        }),
      }),
    );
    expect(stdoutWrite).toHaveBeenCalledWith('Echo: ');
    expect(stdoutWrite).toHaveBeenCalledWith('say hi flag off');
  });

  test('a pending request surfaces through the canonical orchestration vocabulary', async () => {
    const { runCli } = await import('../cli.js');
    const stderrWrite = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    await runCli([
      'chat',
      'station',
      'trigger request opened',
      '--session=managed-approval-thread',
      `--api-base=${apiBase}`,
    ]);

    const stderrText = stderrWrite.mock.calls
      .map((call) => String(call[0]))
      .join('');
    // The canonical `request.opened` runtime vocabulary and
    // `station approvals respond` hint, not the managed-only `tool-approval-
    // request` shape — proof the flag-on path is really on the orchestration
    // dispatcher, not the direct-`/chat` elicitation flow.
    expect(stderrText).toContain(
      'Pending approval request: Approve the write? (id: req-open-1) on thread managed-approval-thread',
    );
    expect(stderrText).toContain(
      "station approvals respond 'managed-approval-thread' 'req-open-1' <accept|acceptForSession|decline|cancel>",
    );
  });

  test('sends model options inside the canonical ExecutionTarget (#978 AC1)', async () => {
    const { runCli } = await import('../cli.js');

    await runCli([
      'chat',
      'codex',
      'say runtime ok',
      '--approval-mode=auto',
      '--effort=high',
      '--thinking=true',
      `--api-base=${apiBase}`,
    ]);

    expect(orchestrationCommands[0]).toMatchObject({
      type: 'executeTarget',
      input: {
        conversationId: expect.any(String),
        message: 'say runtime ok',
        target: {
          agent: 'codex',
          workspace: { kind: 'directory', cwd: process.cwd() },
          model: {
            options: { approvalMode: 'auto', effort: 'high', thinking: true },
          },
        },
      },
    });
  });

  test('--cwd becomes a directory workspace without requiring a registered project (#978 AC2)', async () => {
    const { runCli } = await import('../cli.js');

    await runCli([
      'chat',
      'codex',
      'say runtime ok',
      '--cwd=/explicit/no-project-dir',
      `--api-base=${apiBase}`,
    ]);

    expect(orchestrationCommands[0]).toEqual({
      type: 'executeTarget',
      input: {
        conversationId: expect.any(String),
        message: 'say runtime ok',
        target: {
          environment: { kind: 'current' },
          agent: 'codex',
          workspace: { kind: 'directory', cwd: '/explicit/no-project-dir' },
        },
      },
    });
  });

  test('binds a new CLI chat to the invoking shell directory by default', async () => {
    const { runCli } = await import('../cli.js');

    await runCli([
      'chat',
      'codex',
      'use the current workspace',
      `--api-base=${apiBase}`,
    ]);

    expect(orchestrationCommands[0]).toEqual({
      type: 'executeTarget',
      input: {
        conversationId: expect.any(String),
        message: 'use the current workspace',
        target: {
          environment: { kind: 'current' },
          agent: 'codex',
          workspace: { kind: 'directory', cwd: process.cwd() },
        },
      },
    });
  });

  test('rejects --cwd combined with --project as a usage error before any request (review r1 HIGH fix 2)', async () => {
    const { runCli } = await import('../cli.js');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await expect(
      runCli([
        'chat',
        'codex',
        'say runtime ok',
        '--conversation=cwd-and-project-thread',
        '--cwd=/explicit/dir',
        '--project=launchpad',
        `--api-base=${apiBase}`,
      ]),
    ).rejects.toThrow('Use --project or --cwd, not both.');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(orchestrationCommands).toEqual([]);
  });

  test('surfaces the nonexistent-cwd validation error through the CLI (review r1 fix 3)', async () => {
    const { runCli } = await import('../cli.js');

    await expect(
      runCli([
        'chat',
        'codex',
        'say runtime ok',
        '--cwd=/never/created/directory',
        `--api-base=${apiBase}`,
      ]),
    ).rejects.toThrow(
      'Requested working directory does not exist: /never/created/directory',
    );
    await chatEventsClosed;
  }, 5000);

  // station#978 review r1 fix 3, RESTRUCTURED by station#1155: this used to
  // assert a hard zero-network-call usage error for ANY plain agent slug
  // carrying per-invocation engine settings. That contract was wrong for a
  // plain slug bound to an EXTERNAL engine connection (station#977) — that
  // population routes through orchestration, which already accepts these
  // settings, so a real decision requires classifying the agent's binding
  // first (one cheap `GET .../binding` call). This test now pins the
  // classify-then-reject shape for a Station-engine-bound (here: unbound)
  // agent: exactly ONE fetch (the classification lookup) before the usage
  // error, never a second network call. The allow-for-external branch is
  // covered by the "engine-lab"-style tests below.
  test('rejects an invalid --approval-mode value as a usage error before any request (#978 AC5)', async () => {
    const { runCli } = await import('../cli.js');

    await expect(
      runCli([
        'chat',
        'codex',
        'say runtime ok',
        '--conversation=bad-approval-mode-thread',
        '--approval-mode=yolo',
        `--api-base=${apiBase}`,
      ]),
    ).rejects.toThrow(/--approval-mode must be one of/);
    expect(orchestrationCommands).toEqual([]);
  });

  test('continuing a session applies a model change through the bound Agent (#978 AC6)', async () => {
    const { runCli } = await import('../cli.js');

    await runCli([
      'chat',
      'codex',
      'say runtime ok',
      '--conversation=runtime-thread',
      '--approval-mode=never',
      `--api-base=${apiBase}`,
    ]);
    expect(orchestrationCommands).toEqual([
      {
        type: 'continueTarget',
        input: {
          message: 'say runtime ok',
          environment: { kind: 'current' },
          model: { options: { approvalMode: 'never' } },
        },
      },
    ]);
  });

  test('--model-option merges after named flags, which win on collision (#978 AC7)', async () => {
    const { runCli } = await import('../cli.js');

    await runCli([
      'chat',
      'codex',
      'say runtime ok',
      '--effort=high',
      '--model-option=effort=low',
      '--model-option=fastMode=true',
      `--api-base=${apiBase}`,
    ]);

    expect(orchestrationCommands[0]).toEqual({
      type: 'executeTarget',
      input: {
        conversationId: expect.any(String),
        message: 'say runtime ok',
        target: {
          environment: { kind: 'current' },
          agent: 'codex',
          workspace: { kind: 'directory', cwd: process.cwd() },
          model: { options: { fastMode: true, effort: 'high' } },
        },
      },
    });
  });

  test('resumes a persisted runtime session through the canonical --session flag', async () => {
    const { runCli } = await import('../cli.js');
    state.runtimeSessions.push({
      provider: 'codex',
      threadId: 'persisted-codex-thread',
      status: 'stopped',
      isLoaded: false,
      isPersisted: true,
      resumeCursor: { providerThreadId: 'provider-resume-123' },
    });

    await runCli([
      'chat',
      'codex',
      'continue the work',
      '--session=persisted-codex-thread',
      `--api-base=${apiBase}`,
    ]);

    expect(orchestrationCommands[0]).toEqual({
      type: 'continueTarget',
      input: {
        message: 'continue the work',
        environment: { kind: 'current' },
      },
    });
  });

  test('supports session operations through an Agent', async () => {
    const { runCli } = await import('../cli.js');

    await runCli([
      'sessions',
      'read',
      'codex',
      'runtime-thread',
      `--api-base=${apiBase}`,
    ]);

    expect(_consoleLog).toHaveBeenCalledWith(
      expect.stringContaining('"id": "runtime-thread"'),
    );
  });

  test('rejects value-less connection and session flags', async () => {
    const { runCli } = await import('../cli.js');

    await expect(
      runCli(['chat', 'hello', '--connection', `--api-base=${apiBase}`]),
    ).rejects.toThrow('--connection is not an execution selector');
    await expect(
      runCli(['chat', 'codex', 'hello', '--session', `--api-base=${apiBase}`]),
    ).rejects.toThrow('--session requires a non-empty value');
    expect(orchestrationCommands).toEqual([]);
  });

  test('scopes shared ACP-provider sessions to their connection metadata', async () => {
    const { runCli } = await import('../cli.js');
    state.runtimeSessions.push(
      { provider: 'acp', threadId: 'kiro-owned', status: 'stopped' },
      { provider: 'acp', threadId: 'opencode-owned', status: 'stopped' },
    );
    state.runtimeSessionEvents['kiro-owned'] = [
      {
        method: 'session.configured',
        metadata: { agentSlug: 'kiro' },
      },
    ];
    state.runtimeSessionEvents['opencode-owned'] = [
      {
        method: 'session.configured',
        metadata: { agentSlug: 'opencode' },
      },
    ];

    await runCli(['sessions', 'list', 'kiro', `--api-base=${apiBase}`]);

    expect(_consoleLog).toHaveBeenCalledWith(
      expect.stringContaining('"id": "kiro-owned"'),
    );
    expect(_consoleLog).not.toHaveBeenCalledWith(
      expect.stringContaining('opencode-owned'),
    );
  });

  test('prints an exact resumable command for non-JSON runtime chat', async () => {
    const { runCli } = await import('../cli.js');
    const stderrWrite = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    await runCli([
      'chat',
      'custom-box',
      'remember this',
      '--session=dogfood-thread',
      `--api-base=${apiBase}`,
    ]);

    expect(stderrWrite).toHaveBeenCalledWith(
      "Session: dogfood-thread\nResume: station chat 'custom-box' --session='dogfood-thread' <message>\n",
    );
  });

  test.each([
    ['--credential flag', 'flag'],
    ['STATION_API_CREDENTIAL', 'environment'],
  ])(
    'authenticates every runtime request using the %s',
    async (_label, source) => {
      const { runCli } = await import('../cli.js');
      const credential = 'dogfood-secret-that-must-not-be-printed';
      if (source === 'environment') {
        process.env.STATION_API_CREDENTIAL = credential;
      }

      try {
        await runCli([
          'chat',
          'codex',
          'authenticated turn',
          '--session=authenticated-thread',
          ...(source === 'flag' ? [`--credential=${credential}`] : []),
          `--api-base=${apiBase}`,
        ]);
      } finally {
        delete process.env.STATION_API_CREDENTIAL;
      }

      expect(authorizationHeaders.length).toBeGreaterThan(0);
      expect(new Set(authorizationHeaders)).toEqual(
        new Set([`Bearer ${credential}`]),
      );
      expect(JSON.stringify(_consoleLog.mock.calls)).not.toContain(credential);
      expect(JSON.stringify(stdoutWrite.mock.calls)).not.toContain(credential);
    },
  );

  test('attaches a stored host credential to a self-targeted loopback mutation', async () => {
    const { runCli } = await import('../cli.js');
    const previousHome = process.env.STATION_HOME;
    const previousRoot = process.env.STATION_ROOT;
    const profileHome = mkdtempSync(join(tmpdir(), 'station-loopback-auth-'));
    const credential = 'cli-self-target-read-only-credential';
    const credentialRef = { kind: 'station-bearer' as const, id: 'self' };

    process.env.STATION_HOME = profileHome;
    process.env.STATION_ROOT = profileHome;
    setProfileCredentialStore({
      get: (ref) => (ref.id === credentialRef.id ? credential : undefined),
      set: () => {},
      delete: () => {},
      status: () => 'available',
    });
    upsertProfile({
      name: 'self',
      endpoint: apiBase,
      credentialRef,
      makeDefault: true,
    });

    try {
      await runCli([
        'projects',
        'create',
        '--station=self',
        '--data={"name":"Scoped loopback","slug":"scoped-loopback"}',
      ]);
    } finally {
      resetProfileCredentialStoreForTests();
      rmSync(profileHome, { recursive: true, force: true });
      if (previousHome === undefined) delete process.env.STATION_HOME;
      else process.env.STATION_HOME = previousHome;
      if (previousRoot === undefined) delete process.env.STATION_ROOT;
      else process.env.STATION_ROOT = previousRoot;
    }

    // #1198: a saved CLI Station is allowed to target the Station on this host. It
    // still presents the bearer, so the runtime scope gate—not loopback—
    // decides whether this mutation is allowed.
    expect(authorizationHeaders).toContain(`Bearer ${credential}`);
  });

  test('--project becomes a project workspace in the canonical target (#184)', async () => {
    const { runCli } = await import('../cli.js');

    state.projects = [
      ...state.projects,
      {
        slug: 'launchpad',
        name: 'Launchpad',
        workingDirectory: '/repos/launchpad',
      },
    ];

    await runCli([
      'chat',
      'codex',
      'say runtime ok',
      '--project=launchpad',
      `--api-base=${apiBase}`,
    ]);

    expect(orchestrationCommands).toContainEqual({
      type: 'executeTarget',
      input: {
        conversationId: expect.any(String),
        message: 'say runtime ok',
        target: {
          environment: { kind: 'current' },
          agent: 'codex',
          workspace: {
            kind: 'project',
            projectSlug: 'launchpad',
            cwd: process.cwd(),
          },
        },
      },
    });
  });

  test('lists and reads managed sessions through the unified sessions command', async () => {
    const { runCli } = await import('../cli.js');

    await runCli(['sessions', 'list', 'station', `--api-base=${apiBase}`]);
    await runCli([
      'sessions',
      'read',
      'station',
      'conv-http-test',
      `--api-base=${apiBase}`,
    ]);

    expect(_consoleLog).toHaveBeenCalledWith(
      expect.stringContaining('"kind": "managed"'),
    );
    expect(_consoleLog).toHaveBeenCalledWith(
      expect.stringContaining('"id": "conv-http-test"'),
    );
    expect(_consoleLog).toHaveBeenCalledWith(
      expect.stringContaining('"entries"'),
    );
  });

  test('lists, reads, and interrupts runtime sessions through the unified sessions command', async () => {
    const { runCli } = await import('../cli.js');

    await runCli(['sessions', 'list', 'codex', `--api-base=${apiBase}`]);
    await runCli([
      'sessions',
      'read',
      'codex',
      'runtime-thread',
      `--api-base=${apiBase}`,
    ]);
    await runCli([
      'sessions',
      'interrupt',
      'codex',
      'runtime-thread',
      '--turn=turn-1',
      `--api-base=${apiBase}`,
    ]);

    expect(_consoleLog).toHaveBeenCalledWith(
      expect.stringContaining('"kind": "agent"'),
    );
    expect(_consoleLog).toHaveBeenCalledWith(
      expect.stringContaining('"threadId": "runtime-thread"'),
    );
    expect(orchestrationCommands).toContainEqual({
      type: 'interruptTurn',
      threadId: 'runtime-thread',
      turnId: 'turn-1',
    });
  });

  test('returns the API recovery projection unchanged from runtime session read', async () => {
    const { runCli } = await import('../cli.js');
    state.runtimeSessionRecoveries['runtime-thread'] = {
      failureKind: 'rate-limit',
      scope: 'server',
      decision: 'wait-until-reset',
      outcome: 'armed',
      dueAt: '2026-04-18T00:01:00.000Z',
      attempts: 0,
      maxAttempts: 1,
      updatedAt: '2026-04-18T00:00:02.000Z',
    };

    await runCli([
      'sessions',
      'read',
      'codex',
      'runtime-thread',
      `--api-base=${apiBase}`,
    ]);

    expect(_consoleLog).toHaveBeenCalledWith(
      expect.stringContaining('"decision": "wait-until-reset"'),
    );
    expect(_consoleLog).toHaveBeenCalledWith(
      expect.stringContaining('"scope": "server"'),
    );
  });

  test('approvals list resolves a custom Agent through its engine binding', async () => {
    const { runCli } = await import('../cli.js');

    state.agents = [
      ...state.agents,
      {
        slug: 'claude-code',
        name: 'Claude Code',
        execution: { agentConnectionId: 'claude' },
      },
    ];
    state.runtimeSessions = [
      ...state.runtimeSessions,
      {
        provider: 'claude',
        threadId: 'approval-thread-custom',
        status: 'running',
        isLoaded: true,
        isPersisted: true,
        eventCount: 1,
        createdAt: '2026-04-18T00:00:00.000Z',
        updatedAt: '2026-04-18T00:00:01.000Z',
        lastEventMethod: 'request.opened',
      },
    ];
    state.runtimeSessionEvents['approval-thread-custom'] = [
      {
        provider: 'claude',
        threadId: 'approval-thread-custom',
        eventId: 'evt-custom-1',
        createdAt: '2026-04-18T00:00:00.000Z',
        method: 'request.opened',
        requestId: 'req-custom',
        requestType: 'approval',
        title: 'Write to src/main.ts?',
        payload: { toolName: 'edit' },
      },
    ];

    await runCli([
      'approvals',
      'list',
      '--agent=claude-code',
      '--thread=approval-thread-custom',
      `--api-base=${apiBase}`,
    ]);

    expect(_consoleLog).toHaveBeenCalledWith(
      expect.stringContaining('"requestId": "req-custom"'),
    );
  });

  test('approvals list without --thread filters sessions by the Agent binding', async () => {
    const { runCli } = await import('../cli.js');

    state.agents = [
      ...state.agents,
      {
        slug: 'claude-code',
        name: 'Claude Code',
        execution: { agentConnectionId: 'claude' },
      },
    ];
    state.runtimeSessions = [
      ...state.runtimeSessions,
      {
        provider: 'claude',
        threadId: 'claude-thread',
        status: 'running',
        isLoaded: true,
        isPersisted: true,
        eventCount: 1,
        createdAt: '2026-04-18T00:00:00.000Z',
        updatedAt: '2026-04-18T00:00:00.000Z',
        lastEventMethod: 'request.opened',
      },
      {
        provider: 'codex',
        threadId: 'codex-thread',
        status: 'running',
        isLoaded: true,
        isPersisted: true,
        eventCount: 1,
        createdAt: '2026-04-18T00:00:00.000Z',
        updatedAt: '2026-04-18T00:00:00.000Z',
        lastEventMethod: 'request.opened',
      },
    ];
    state.runtimeSessionEvents['claude-thread'] = [
      {
        provider: 'claude',
        threadId: 'claude-thread',
        eventId: 'evt-claude',
        createdAt: '2026-04-18T00:00:00.000Z',
        method: 'request.opened',
        requestId: 'req-claude',
        requestType: 'approval',
        title: 'Approve Claude work',
      },
    ];
    state.runtimeSessionEvents['codex-thread'] = [
      {
        provider: 'codex',
        threadId: 'codex-thread',
        eventId: 'evt-codex',
        createdAt: '2026-04-18T00:00:00.000Z',
        method: 'request.opened',
        requestId: 'req-codex',
        requestType: 'approval',
        title: 'Approve Codex work',
      },
    ];

    await runCli([
      'approvals',
      'list',
      '--agent=claude-code',
      `--api-base=${apiBase}`,
    ]);

    expect(_consoleLog).toHaveBeenCalledWith(
      expect.stringContaining('"requestId": "req-claude"'),
    );
    expect(_consoleLog).not.toHaveBeenCalledWith(
      expect.stringContaining('"requestId": "req-codex"'),
    );
  });

  test('approvals list surfaces a server failure from the agents lookup instead of misreporting it as an unsupported slug', async () => {
    const { runCli } = await import('../cli.js');

    await expect(
      runCli([
        'approvals',
        'list',
        '--agent=boom-agent',
        `--api-base=${apiBase}`,
      ]),
    ).rejects.toThrow(/Synthetic agents failure/);
  });

  test('approvals list keeps the unsupported-slug message for a genuinely unknown agent (404)', async () => {
    const { runCli } = await import('../cli.js');

    await expect(
      runCli([
        'approvals',
        'list',
        '--agent=no-such-agent',
        `--api-base=${apiBase}`,
      ]),
    ).rejects.toThrow(
      /Agent '.+' is not bound to an approvals-capable external engine/,
    );
  });

  test('approvals list resolves a custom Agent bound to an ACP engine', async () => {
    const { runCli } = await import('../cli.js');

    state.agents = [
      ...state.agents,
      {
        slug: 'kiro-notes',
        name: 'Kiro Notes',
        execution: { agentConnectionId: 'kiro' },
      },
    ];
    state.runtimeSessions = [
      ...state.runtimeSessions,
      {
        provider: 'acp',
        threadId: 'kiro-notes-thread',
        status: 'running',
        isLoaded: true,
        isPersisted: true,
        eventCount: 1,
        createdAt: '2026-04-18T00:00:00.000Z',
        updatedAt: '2026-04-18T00:00:00.000Z',
        lastEventMethod: 'request.opened',
      },
    ];
    state.runtimeSessionEvents['kiro-notes-thread'] = [
      {
        method: 'session.configured',
        metadata: { agentSlug: 'kiro' },
      },
      {
        provider: 'acp',
        threadId: 'kiro-notes-thread',
        eventId: 'evt-kiro-notes',
        createdAt: '2026-04-18T00:00:00.000Z',
        method: 'request.opened',
        requestId: 'req-kiro-notes',
        requestType: 'approval',
        title: 'Approve Kiro work',
      },
    ];

    await runCli([
      'approvals',
      'list',
      '--agent=kiro-notes',
      '--thread=kiro-notes-thread',
      `--api-base=${apiBase}`,
    ]);

    expect(_consoleLog).toHaveBeenCalledWith(
      expect.stringContaining('"requestId": "req-kiro-notes"'),
    );
  });

  test('approvals resolve real Agent bindings and provider configuration without fallback maps', async () => {
    const { runCli } = await import('../cli.js');

    state.connections = [
      ...state.connections,
      {
        id: 'bedrock-agent',
        kind: 'agent',
        type: 'bedrock',
        name: 'Bedrock Agent',
        enabled: true,
        capabilities: ['agent-runtime'],
        config: { provider: 'bedrock' },
        status: 'ready',
        prerequisites: [],
      },
    ];
    state.agents.push({
      slug: 'bedrock-agent',
      name: 'Bedrock Agent',
      execution: { agentConnectionId: 'bedrock-agent' },
      engineId: 'bedrock',
    });
    state.runtimeSessions = [
      ...state.runtimeSessions,
      {
        provider: 'acp',
        threadId: 'acp-direct-thread',
        status: 'running',
        isLoaded: true,
        isPersisted: true,
        eventCount: 1,
        createdAt: '2026-04-18T00:00:00.000Z',
        updatedAt: '2026-04-18T00:00:00.000Z',
        lastEventMethod: 'request.opened',
      },
      {
        provider: 'bedrock',
        threadId: 'bedrock-thread',
        status: 'running',
        isLoaded: true,
        isPersisted: true,
        eventCount: 1,
        createdAt: '2026-04-18T00:00:00.000Z',
        updatedAt: '2026-04-18T00:00:00.000Z',
        lastEventMethod: 'request.opened',
      },
    ];
    state.runtimeSessionEvents['acp-direct-thread'] = [
      {
        method: 'session.configured',
        metadata: { agentSlug: 'kiro' },
      },
      {
        provider: 'acp',
        threadId: 'acp-direct-thread',
        eventId: 'evt-acp-direct',
        createdAt: '2026-04-18T00:00:00.000Z',
        method: 'request.opened',
        requestId: 'req-acp-direct',
        requestType: 'approval',
        title: 'Approve direct ACP work',
      },
    ];
    state.runtimeSessionEvents['bedrock-thread'] = [
      {
        provider: 'bedrock',
        threadId: 'bedrock-thread',
        eventId: 'evt-bedrock',
        createdAt: '2026-04-18T00:00:00.000Z',
        method: 'request.opened',
        requestId: 'req-bedrock',
        requestType: 'approval',
        title: 'Approve Bedrock work',
      },
    ];

    await runCli([
      'approvals',
      'list',
      '--agent=kiro',
      '--thread=acp-direct-thread',
      `--api-base=${apiBase}`,
    ]);
    expect(_consoleLog).toHaveBeenCalledWith(
      expect.stringContaining('"requestId": "req-acp-direct"'),
    );
    _consoleLog.mockClear();

    await runCli([
      'approvals',
      'list',
      '--agent=bedrock-agent',
      '--thread=bedrock-thread',
      `--api-base=${apiBase}`,
    ]);
    expect(_consoleLog).toHaveBeenCalledWith(
      expect.stringContaining('"requestId": "req-bedrock"'),
    );
  });

  test('approvals list shows only unresolved requests for a single thread', async () => {
    const { runCli } = await import('../cli.js');

    state.runtimeSessions = [
      ...state.runtimeSessions,
      {
        provider: 'codex',
        threadId: 'approval-thread-1',
        status: 'running',
        isLoaded: true,
        isPersisted: true,
        eventCount: 4,
        createdAt: '2026-04-18T00:00:00.000Z',
        updatedAt: '2026-04-18T00:00:01.000Z',
        lastEventMethod: 'request.opened',
      },
    ];
    state.runtimeSessionEvents['approval-thread-1'] = [
      {
        provider: 'codex',
        threadId: 'approval-thread-1',
        eventId: 'evt-open-1',
        createdAt: '2026-04-18T00:00:00.000Z',
        method: 'request.opened',
        requestId: 'req-open',
        requestType: 'approval',
        title: 'Run rm -rf tmp/?',
        payload: { toolName: 'bash' },
      },
      {
        provider: 'codex',
        threadId: 'approval-thread-1',
        eventId: 'evt-open-2',
        createdAt: '2026-04-18T00:00:00.500Z',
        method: 'request.opened',
        requestId: 'req-resolved',
        requestType: 'approval',
        title: 'Read secrets.env?',
        payload: { toolName: 'read' },
      },
      {
        provider: 'codex',
        threadId: 'approval-thread-1',
        eventId: 'evt-resolved',
        createdAt: '2026-04-18T00:00:01.000Z',
        method: 'request.resolved',
        requestId: 'req-resolved',
        status: 'approved',
      },
    ];

    await runCli([
      'approvals',
      'list',
      '--agent=codex',
      '--thread=approval-thread-1',
      `--api-base=${apiBase}`,
    ]);

    expect(_consoleLog).toHaveBeenCalledWith(
      expect.stringContaining('"requestId": "req-open"'),
    );
    expect(_consoleLog).not.toHaveBeenCalledWith(
      expect.stringContaining('"requestId": "req-resolved"'),
    );
  });

  /**
   * station#1782 — the CLI annotates an unanswerable request from the wire
   * and NEVER filters it.
   *
   * The CLI is a different process over HTTP: two of
   * `projectRequestAnswerability`'s three inputs (thread attachment, adapter
   * registry) exist only in the serving process, so this fact can only be
   * READ here. And filtering on this surface while the popover still shows
   * the row is the exact divergence that produced station#1780.
   */
  function seedStrandedApproval(answerability?: Record<string, unknown>): void {
    state.runtimeSessions = [
      ...state.runtimeSessions,
      {
        provider: 'acme',
        threadId: 'stranded-thread',
        status: 'running',
        isLoaded: true,
        isPersisted: true,
        eventCount: 1,
        createdAt: '2026-04-18T00:00:00.000Z',
        updatedAt: '2026-04-18T00:00:01.000Z',
        lastEventMethod: 'request.opened',
        ...(answerability ? { answerability } : {}),
      },
    ];
    state.runtimeSessionEvents['stranded-thread'] = [
      {
        provider: 'acme',
        threadId: 'stranded-thread',
        eventId: 'evt-stranded',
        createdAt: '2026-04-18T00:00:00.000Z',
        method: 'request.opened',
        requestId: 'req-stranded',
        requestType: 'approval',
        title: 'Run rm -rf tmp/?',
        payload: { toolName: 'bash' },
      },
    ];
  }

  const strandedObservation = {
    answerable: false,
    qualification: 'provider_absent',
    observedBy: 'station-7f3a',
    observedAt: '2026-08-03T12:04:03.000Z',
  };

  function printedApprovals(): string {
    return _consoleLog.mock.calls.map((call) => String(call[0])).join('\n');
  }

  test('approvals list ANNOTATES an unanswerable request and still lists it (AC1/AC2)', async () => {
    const { runCli } = await import('../cli.js');
    seedStrandedApproval(strandedObservation);

    await runCli([
      'approvals',
      'list',
      '--agent=codex',
      '--thread=stranded-thread',
      `--api-base=${apiBase}`,
    ]);

    const output = printedApprovals();
    // AC2 (anti-filter): the row is PRESENT. Absence is the rejection case.
    expect(output).toContain('req-stranded');
    // AC1 (human): qualification, observer and observedAt in the sentence.
    expect(output).toContain("no adapter for provider 'acme'");
    expect(output).toContain('station-7f3a');
    expect(output).toContain('2026-08-03T12:04:03.000Z');
    // AC1 (structured): the wire object verbatim, not a re-derivation.
    expect(output).toContain('"qualification": "provider_absent"');
    expect(output).toContain('"observedBy": "station-7f3a"');
  });

  test('approvals list --json carries the structured answerability object', async () => {
    const { runCli } = await import('../cli.js');
    seedStrandedApproval(strandedObservation);

    await runCli([
      'approvals',
      'list',
      '--agent=codex',
      '--thread=stranded-thread',
      '--json',
      `--api-base=${apiBase}`,
    ]);

    const parsed = JSON.parse(printedApprovals());
    expect(parsed).toHaveLength(1);
    expect(parsed[0].requestId).toBe('req-stranded');
    expect(parsed[0].answerability).toEqual(strandedObservation);
    expect(parsed[0].answerabilityNote).toContain('station-7f3a');
  });

  test('approvals list AC5: a session missing from the response renders the unknown marker', async () => {
    // The rejection path the issue names: remove the session from the
    // response and assert the marker. Folding a join-miss to "answerable"
    // would be a default that decides.
    const { runCli } = await import('../cli.js');
    seedStrandedApproval(strandedObservation);
    state.detailOmitsSession.add('stranded-thread');

    await runCli([
      'approvals',
      'list',
      '--agent=codex',
      '--thread=stranded-thread',
      '--json',
      `--api-base=${apiBase}`,
    ]);

    const parsed = JSON.parse(printedApprovals());
    expect(parsed[0].requestId).toBe('req-stranded');
    // Spelled `null`, never omitted (review M3). An absent field is
    // indistinguishable from "an older CLI did not emit this", so a script
    // would fold the honest gap straight back to "answerable" — the same
    // rule `OperateBoardRow.answerability` states one package over.
    expect(parsed[0]).toHaveProperty('answerability');
    expect(parsed[0].answerability).toBeNull();
    expect(parsed[0].answerabilityNote).toContain('Answerability unknown');
    expect(parsed[0].answerabilityNote).toContain('stranded-thread');
  });

  test('approvals list control: an answerable session gets the object and no note', async () => {
    const { runCli } = await import('../cli.js');
    seedStrandedApproval({ answerable: true });

    await runCli([
      'approvals',
      'list',
      '--agent=codex',
      '--thread=stranded-thread',
      '--json',
      `--api-base=${apiBase}`,
    ]);

    const parsed = JSON.parse(printedApprovals());
    expect(parsed[0].answerability).toEqual({ answerable: true });
    expect(parsed[0].answerabilityNote).toBeUndefined();
  });

  test('approvals list control: a pre-ADR-0012 peer sending no decoration reads answerable', async () => {
    // The contract owns this case deliberately: a reader cannot observe a
    // remote adapter registry, so the ABSENCE of a claim is not a claim.
    // Distinct from the join-miss above, where no session came back at all.
    const { runCli } = await import('../cli.js');
    seedStrandedApproval();

    await runCli([
      'approvals',
      'list',
      '--agent=codex',
      '--thread=stranded-thread',
      '--json',
      `--api-base=${apiBase}`,
    ]);

    const parsed = JSON.parse(printedApprovals());
    expect(parsed[0].answerability).toEqual({ answerable: true });
    expect(parsed[0].answerabilityNote).toBeUndefined();
  });

  test('approvals respond against an unanswerable request is NOT gated client-side (AC4)', async () => {
    // Enforcement stays server-side. The annotation is advance notice, not a
    // veto — a client-side veto against a possibly-stale observation would
    // reintroduce "one surface hides what another offers".
    const { runCli } = await import('../cli.js');
    seedStrandedApproval(strandedObservation);

    await runCli([
      'approvals',
      'respond',
      'stranded-thread',
      'req-stranded',
      'accept',
      `--api-base=${apiBase}`,
    ]);

    expect(
      orchestrationCommands.some(
        (command) =>
          command.type === 'respondToRequest' &&
          command.requestId === 'req-stranded',
      ),
    ).toBe(true);
  });

  test('approvals list aggregates pending requests across every thread for an agent when --thread is omitted', async () => {
    const { runCli } = await import('../cli.js');

    state.runtimeSessions = [
      ...state.runtimeSessions,
      {
        provider: 'codex',
        threadId: 'approval-thread-a',
        status: 'running',
        isLoaded: true,
        isPersisted: true,
        eventCount: 1,
        createdAt: '2026-04-18T00:00:00.000Z',
        updatedAt: '2026-04-18T00:00:00.000Z',
        lastEventMethod: 'request.opened',
      },
      {
        provider: 'codex',
        threadId: 'approval-thread-b',
        status: 'running',
        isLoaded: true,
        isPersisted: true,
        eventCount: 1,
        createdAt: '2026-04-18T00:00:00.000Z',
        updatedAt: '2026-04-18T00:00:00.000Z',
        lastEventMethod: 'request.opened',
      },
    ];
    state.runtimeSessionEvents['approval-thread-a'] = [
      {
        provider: 'codex',
        threadId: 'approval-thread-a',
        eventId: 'evt-a',
        createdAt: '2026-04-18T00:00:00.000Z',
        method: 'request.opened',
        requestId: 'req-a',
        requestType: 'approval',
        title: 'Approve A',
      },
    ];
    state.runtimeSessionEvents['approval-thread-b'] = [
      {
        provider: 'codex',
        threadId: 'approval-thread-b',
        eventId: 'evt-b',
        createdAt: '2026-04-18T00:00:00.000Z',
        method: 'request.opened',
        requestId: 'req-b',
        requestType: 'approval',
        title: 'Approve B',
      },
    ];

    await runCli([
      'approvals',
      'list',
      '--agent=codex',
      `--api-base=${apiBase}`,
    ]);

    expect(_consoleLog).toHaveBeenCalledWith(
      expect.stringContaining('"requestId": "req-a"'),
    );
    expect(_consoleLog).toHaveBeenCalledWith(
      expect.stringContaining('"requestId": "req-b"'),
    );
  });

  test('approvals respond posts the exact respondToRequest body and prints the receipt', async () => {
    const { runCli } = await import('../cli.js');

    await runCli([
      'approvals',
      'respond',
      'approval-thread-1',
      'req-open',
      'accept',
      `--api-base=${apiBase}`,
    ]);

    expect(orchestrationCommands).toContainEqual({
      type: 'respondToRequest',
      threadId: 'approval-thread-1',
      requestId: 'req-open',
      decision: 'accept',
    });
    expect(_consoleLog).toHaveBeenCalledWith(
      expect.stringContaining('"commandId": "receipt-req-open"'),
    );
  });

  test('approvals --json prints compact single-line JSON for list and respond', async () => {
    const { runCli } = await import('../cli.js');

    state.runtimeSessionEvents['approval-thread-1'] = [
      {
        provider: 'codex',
        threadId: 'approval-thread-1',
        eventId: 'evt-open-1',
        createdAt: '2026-04-18T00:00:00.000Z',
        method: 'request.opened',
        requestId: 'req-open',
        requestType: 'approval',
        title: 'Run rm -rf tmp/?',
      },
    ];
    state.runtimeSessions = [
      ...state.runtimeSessions,
      {
        provider: 'codex',
        threadId: 'approval-thread-1',
        status: 'running',
        isLoaded: true,
        isPersisted: true,
        eventCount: 1,
        createdAt: '2026-04-18T00:00:00.000Z',
        updatedAt: '2026-04-18T00:00:00.000Z',
        lastEventMethod: 'request.opened',
      },
    ];

    await runCli([
      'approvals',
      'list',
      '--agent=codex',
      '--thread=approval-thread-1',
      '--json',
      `--api-base=${apiBase}`,
    ]);
    await runCli([
      'approvals',
      'respond',
      'approval-thread-1',
      'req-open',
      'accept',
      '--json',
      `--api-base=${apiBase}`,
    ]);

    const listCall = _consoleLog.mock.calls.find(
      (call) =>
        typeof call[0] === 'string' &&
        call[0].includes('"requestId":"req-open"'),
    )?.[0] as string | undefined;
    expect(listCall).toBeDefined();
    expect(listCall).not.toContain('\n');
    expect(JSON.parse(listCall as string)).toEqual([
      {
        threadId: 'approval-thread-1',
        requestId: 'req-open',
        requestType: 'approval',
        title: 'Run rm -rf tmp/?',
        ageMs: expect.any(Number),
        // station#1782: the joined summary carried no decoration, and
        // `normalizeRequestAnswerability` folds that to `answerable: true` —
        // the reader cannot observe a remote adapter registry, so the
        // absence of a claim is not a claim. No `answerabilityNote`, because
        // the positive arm carries no basis to render.
        answerability: { answerable: true },
      },
    ]);

    expect(_consoleLog).toHaveBeenCalledWith(
      '{"success":true,"threadId":"approval-thread-1","requestId":"req-open","decision":"accept","receipt":{"commandId":"receipt-req-open","type":"respondToRequest","threadId":"approval-thread-1"}}',
    );
  });

  test('approvals list --watch drives request.opened -> request.resolved -> session.exited and exits cleanly', async () => {
    const { runCli } = await import('../cli.js');
    const credential = 'watch-profile-secret';

    state.runtimeSessions = [
      ...state.runtimeSessions,
      {
        provider: 'codex',
        threadId: 'watch-thread',
        status: 'running',
        isLoaded: true,
        isPersisted: true,
        eventCount: 0,
        createdAt: '2026-04-18T00:00:00.000Z',
        updatedAt: '2026-04-18T00:00:00.000Z',
        lastEventMethod: 'session.started',
      },
    ];
    state.runtimeSessionEvents['watch-thread'] = [];
    state.sseEventsByThread['watch-thread'] = [
      {
        provider: 'codex',
        threadId: 'watch-thread',
        eventId: 'evt-watch-open',
        createdAt: '2026-04-18T00:00:00.000Z',
        method: 'request.opened',
        requestId: 'req-watch',
        requestType: 'approval',
        title: 'Approve the watched thing',
      },
      {
        provider: 'codex',
        threadId: 'watch-thread',
        eventId: 'evt-watch-resolved',
        createdAt: '2026-04-18T00:00:00.500Z',
        method: 'request.resolved',
        requestId: 'req-watch',
        status: 'approved',
      },
      {
        provider: 'codex',
        threadId: 'watch-thread',
        eventId: 'evt-watch-exit',
        createdAt: '2026-04-18T00:00:01.000Z',
        method: 'session.exited',
        sessionId: 'watch-thread',
      },
    ];

    await runCli([
      'approvals',
      'list',
      '--agent=codex',
      '--thread=watch-thread',
      '--watch',
      `--api-base=${apiBase}`,
      `--credential=${credential}`,
    ]);

    // Initial print (seeded from the empty thread), the mid-stream reprint
    // after `request.opened`, and the final reprint (now empty again) after
    // `request.resolved` — then the loop exits on `session.exited` without
    // a manual interrupt.
    expect(_consoleLog).toHaveBeenCalledWith(
      expect.stringContaining('"requestId": "req-watch"'),
    );
    const finalPendingCall = _consoleLog.mock.calls.at(-1)?.[0];
    expect(finalPendingCall).toBe('[]');

    // The mock server never ends this response on its own (see the
    // `/api/orchestration/events` scripted branch above) — it only closes
    // when the client disconnects. Asserting the close actually happened
    // proves `watchApprovals` aborts its own fetch on `session.exited`
    // rather than merely returning from the read loop while leaving the
    // socket open (#165 iteration-2 code-review HIGH fix). Bounded so a
    // regression fails fast instead of hanging the suite.
    await waitForWatchStreamClose('watch-thread');
    expect(authorizationHeaders.length).toBeGreaterThan(0);
    expect(new Set(authorizationHeaders)).toEqual(
      new Set([`Bearer ${credential}`]),
    );
    expect(JSON.stringify(_consoleLog.mock.calls)).not.toContain(credential);
    expect(JSON.stringify(stdoutWrite.mock.calls)).not.toContain(credential);
  }, 3000);

  test('#168 consumeSseFrames extension: onSnapshot fires for the snapshot frame and threadId-scoped filtering is unchanged (regression for sendMessage/watchApprovalEvents callers)', async () => {
    function sseResponse(frames: string[]): Response {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const frame of frames) {
            controller.enqueue(encoder.encode(frame));
          }
          controller.close();
        },
      });
      return new Response(stream);
    }

    const snapshotFrame = `data: ${JSON.stringify({
      sessions: [{ threadId: 'thread-a' }],
    })}\n\n`;
    const threadAFrame = `data: ${JSON.stringify({
      threadId: 'thread-a',
      method: 'turn.started',
    })}\n\n`;
    const threadBFrame = `data: ${JSON.stringify({
      threadId: 'thread-b',
      method: 'turn.started',
    })}\n\n`;

    // threadId supplied, no onSnapshot: exact pre-#168 behavior — the
    // snapshot frame (no threadId field) is dropped by the filter, only
    // the matching thread's frame reaches onFrame.
    const scopedFrames: Array<Record<string, unknown>> = [];
    await consumeSseFrames({
      response: sseResponse([snapshotFrame, threadAFrame, threadBFrame]),
      threadId: 'thread-a',
      signal: new AbortController().signal,
      onFrame: (event) => {
        scopedFrames.push(event);
        return undefined;
      },
    });
    expect(scopedFrames).toEqual([
      { threadId: 'thread-a', method: 'turn.started' },
    ]);

    // threadId supplied AND onSnapshot supplied: the snapshot frame reaches
    // onSnapshot instead of onFrame; per-thread filtering is unchanged.
    const snapshots: Array<Array<Record<string, unknown>>> = [];
    const scopedFramesWithSnapshot: Array<Record<string, unknown>> = [];
    await consumeSseFrames({
      response: sseResponse([snapshotFrame, threadAFrame, threadBFrame]),
      threadId: 'thread-a',
      signal: new AbortController().signal,
      onSnapshot: (sessions) => snapshots.push(sessions),
      onFrame: (event) => {
        scopedFramesWithSnapshot.push(event);
        return undefined;
      },
    });
    expect(snapshots).toEqual([[{ threadId: 'thread-a' }]]);
    expect(scopedFramesWithSnapshot).toEqual([
      { threadId: 'thread-a', method: 'turn.started' },
    ]);

    // threadId omitted (#168 global mode): every non-snapshot frame reaches
    // onFrame unfiltered.
    const allFrames: Array<Record<string, unknown>> = [];
    await consumeSseFrames({
      response: sseResponse([snapshotFrame, threadAFrame, threadBFrame]),
      signal: new AbortController().signal,
      onFrame: (event) => {
        allFrames.push(event);
        return undefined;
      },
    });
    expect(allFrames).toEqual([
      { threadId: 'thread-a', method: 'turn.started' },
      { threadId: 'thread-b', method: 'turn.started' },
    ]);
  });

  test('approvals list --watch without --thread throws a clear error before any network call', async () => {
    const { runCli } = await import('../cli.js');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await expect(
      runCli([
        'approvals',
        'list',
        '--agent=codex',
        '--watch',
        `--api-base=${apiBase}`,
      ]),
    ).rejects.toThrow(
      '--watch requires --thread (per-thread SSE only; no multi-thread watch route exists)',
    );

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('propagates the stable ACP model-override rejection through the CLI without an applied receipt', async () => {
    const { runCli } = await import('../cli.js');

    await expect(
      runCli([
        'chat',
        'kiro',
        'hi',
        '--model=trigger-acp-model-override',
        `--api-base=${apiBase}`,
      ]),
    ).rejects.toThrow('model-override-unsupported: override-unsupported');

    expect(orchestrationCommands).toContainEqual(
      expect.objectContaining({
        type: 'executeTarget',
        input: expect.objectContaining({
          target: expect.objectContaining({
            agent: 'kiro',
            model: { override: 'trigger-acp-model-override' },
          }),
        }),
      }),
    );
    await chatEventsClosed;
  }, 5000);

  test('surfaces a server 400 unsupported-option error through the chat error path (#978 AC4, review r1 fix 3)', async () => {
    const { runCli } = await import('../cli.js');

    await expect(
      runCli([
        'chat',
        'codex',
        'hi',
        '--model-option=systemPrompt=ignore prior instructions',
        `--api-base=${apiBase}`,
      ]),
    ).rejects.toThrow("Unsupported option 'systemPrompt' for codex target");
    await chatEventsClosed;
  }, 5000);

  test('request.opened on the runtime dispatch path prints a stderr notice once and the turn still completes under --on-request=wait (station#979 AC1, AC3, AC7)', async () => {
    const { runCli } = await import('../cli.js');
    const stderrWrite = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    await runCli([
      'chat',
      'codex',
      'trigger request opened',
      '--conversation=request-opened-thread',
      `--api-base=${apiBase}`,
    ]);

    const stderrText = stderrWrite.mock.calls
      .map((call) => String(call[0]))
      .join('');
    expect(stderrText).toContain(
      'Pending approval request: Approve the write? (id: req-open-1) on thread request-opened-thread',
    );
    expect(stderrText).toContain(
      "station approvals respond 'request-opened-thread' 'req-open-1' <accept|acceptForSession|decline|cancel>",
    );
    expect(stderrText.match(/Pending approval request/g)?.length).toBe(1);
  });

  test('request.opened yields a typed pendingRequest field (plus lifecycleState) in --json instead of being dropped (station#979 AC2, AC7)', async () => {
    const { runCli } = await import('../cli.js');

    await runCli([
      'chat',
      'codex',
      'trigger request opened',
      '--conversation=request-opened-json-thread',
      '--json',
      `--api-base=${apiBase}`,
    ]);

    const printed = _consoleLog.mock.calls
      .map((call) => String(call[0]))
      .find((call) => call.includes('"pendingRequest"'));
    expect(printed).toBeDefined();
    const payload = JSON.parse(printed as string);
    expect(payload.pendingRequest).toEqual({
      requestId: 'req-open-1',
      requestType: 'approval',
      title: 'Approve the write?',
      respondCommand:
        "station approvals respond 'request-opened-json-thread' 'req-open-1' <accept|acceptForSession|decline|cancel>",
    });
    expect(payload.lifecycleState).toBe('needs_input');
  });

  test('--on-request=fail exits distinctly, leaves the session alive (no stopSession), and surfaces the requestId in --json (station#979 AC4)', async () => {
    const { runCli } = await import('../cli.js');
    const exit = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);

    await runCli([
      'chat',
      'codex',
      'trigger request opened only',
      '--conversation=request-opened-fail-thread',
      '--on-request=fail',
      '--json',
      `--api-base=${apiBase}`,
    ]);

    expect(exit).toHaveBeenCalledWith(4);
    expect(
      orchestrationCommands.some((command) => command.type === 'stopSession'),
    ).toBe(false);

    const printed = _consoleLog.mock.calls
      .map((call) => String(call[0]))
      .find((call) => call.includes('"pendingRequest"'));
    expect(printed).toBeDefined();
    const payload = JSON.parse(printed as string);
    expect(payload.pendingRequest.requestId).toBe('req-open-1');
  });

  test('rejects an invalid --on-request value as a usage error before any request (station#979)', async () => {
    const { runCli } = await import('../cli.js');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await expect(
      runCli([
        'chat',
        'codex',
        'hi',
        '--conversation=bad-on-request-thread',
        '--on-request=explode',
        `--api-base=${apiBase}`,
      ]),
    ).rejects.toThrow(/--on-request must be 'wait' or 'fail'/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('object-shaped error payloads render their code, never [object Object]', () => {
    expect(
      describeApiError({ code: 'authentication_required' }, 'fallback'),
    ).toBe('authentication_required');
    expect(describeApiError({ message: 'boom' }, 'fallback')).toBe('boom');
    expect(describeApiError('plain', 'fallback')).toBe('plain');
    expect(describeApiError(undefined, 'fallback')).toBe('fallback');
    expect(describeApiError({ nested: true }, 'fallback')).toBe(
      '{"nested":true}',
    );
  });
});
