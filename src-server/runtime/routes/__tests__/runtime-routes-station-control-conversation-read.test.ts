/**
 * #3159: `read_conversation` end to end through the PRODUCTION composition —
 * `configureRuntimeRoutes` with the real station-control MCP route serving
 * the real tool registrations, the real authority guard, the real caller and
 * scope derivation over REAL session records (a real `EventStore` +
 * `OrchestrationService`), and the real read route.
 *
 * The engine is a SEPARATE PROCESS speaking HTTP MCP with a URL token, the
 * way Codex reaches Station Control when passthrough is on (a
 * bearer-exposed caller). Its calls cross the process boundary into the MCP
 * route; the tool then calls the read route with that caller's credential.
 *
 * Records (owner: the operator unless noted):
 * - `caller` in project-1: the engine's session. Its turns reference other
 *   conversations, each sent by a recorded actor:
 *   `person-ref` (operator), `agent-ref` (internal: an agent's
 *   `send_message`), `gone` (operator; no such conversation any more),
 *   `device-ref` (a paired phone), `peer-ref` (another Station's
 *   delegation grant);
 * - `same-project` in project-1;
 * - `person-ref`, `agent-ref`, `unreferenced`, `device-ref`, `peer-ref` in
 *   project-2;
 * - `other-owner` in project-1, owned by another person.
 */
import { execFile } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { serve } from '@hono/node-server';
import { readConversation } from '@kontourai/station-sdk/client';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { awaitSessionAttachmentSettled } from '../../../__test-utils__/session-runtime-barriers.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { FileMemoryAdapter } from '../../../adapters/file/memory-adapter.js';
import { FileStorageAdapter } from '../../../domain/file-storage-adapter.js';
import { __resetStationServerSelfAttestationForTests } from '../../../security/station-server-scope.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../../services/identity/principal-resolver.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { OrchestrationService } from '../../../services/orchestration/orchestration-service.js';
import { SESSION_LOCAL_PROJECT_ID_METADATA_KEY } from '../../../services/orchestration/session-project-identity.js';
import { ProjectManifestStore } from '../../../services/projects/project-manifest-store.js';
import { ProjectService } from '../../../services/projects/project-service.js';
import {
  __resetStationControlStdioEntryForTests,
  api,
  controlRequestOptions,
  withStationControlCallerContext,
} from '../../../tools/station-control-shared.js';
import {
  __resetStationControlMcpTokensForTests,
  mintStationControlMcpToken,
  STATION_CONTROL_MCP_PATH,
} from '../../mcp/station-control-mcp-token.js';
import { configureRuntimeRoutes } from '../runtime-routes.js';

vi.mock('../runtime-route-support.js', () => {
  const stub = new Proxy({}, { get: () => () => undefined });
  return {
    configureRuntimeSupportServices: () => ({
      schedulerService: stub,
      notificationService: stub,
      attentionProjection: stub,
      webPushService: stub,
      webPushEnabled: false,
    }),
    createRuntimeSystemRouteDeps: () => stub,
  };
});

/** Answers every unlisted member with an inert, non-thenable proxy. */
function deepStub<T extends object>(overrides: T): T {
  return new Proxy(overrides, {
    get(target, property) {
      if (property in target) return Reflect.get(target, property);
      const proxy: unknown = new Proxy(() => undefined, {
        get: (_target, property) => (property === 'then' ? undefined : proxy),
      });
      return proxy;
    },
  }) as T;
}

const run = promisify(execFile);
const ROOT = resolve(import.meta.dirname, '../../../..');
const A = LOCAL_OPERATOR_PRINCIPAL_ID;
const OTHER = 'human:tailscale-serve:carol';
const NOW = Date.now();
const makeTempDir = trackTempDirs();

const origin = (actor: Record<string, unknown>) => ({
  version: 1,
  actor,
  reported: { version: 1, surface: 'web', build: null },
});
const link = (id: string) =>
  `[${id} title](/activity?session=${encodeURIComponent(id)})`;

/**
 * The engine: a separate Node process speaking JSON-RPC over HTTP to the
 * station-control MCP route with a URL token, as Codex does. It runs every
 * call in `CALLS` and prints each result.
 */
const ENGINE = `
const url = process.env.MCP_URL;
let id = 0;
async function rpc(method, params) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
  });
  const text = await response.text();
  const line = (response.headers.get('content-type') || '').includes('application/json')
    ? text : (text.split('\\n').find((l) => l.startsWith('data: ')) || '').slice(6);
  return JSON.parse(line);
}
await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'engine', version: '1' } });
const out = [];
for (const args of JSON.parse(process.env.CALLS)) {
  const answer = await rpc('tools/call', { name: 'read_conversation', arguments: args });
  const text = answer.result?.content?.[0]?.text;
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  out.push({ isError: answer.result?.isError === true, error: answer.error, body });
}
console.log(JSON.stringify(out));
`;

describe('read_conversation through the real MCP route, from a separate engine process', () => {
  const closers: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    __resetStationControlMcpTokensForTests();
    __resetStationControlStdioEntryForTests();
    delete process.env.STATION_API_BASE;
    for (const close of closers.splice(0)) await close();
  });

  async function setup(withProviderHistory = false) {
    __resetStationServerSelfAttestationForTests();
    const home = makeTempDir('station-control-conversation-read-');
    const storage = new FileStorageAdapter(home);
    const projects = new ProjectService(
      storage,
      new ProjectManifestStore(home, storage),
    );
    const p1 = await projects.createProject({ name: 'One', slug: 'project-1' });
    const p2 = await projects.createProject({ name: 'Two', slug: 'project-2' });

    const store = new EventStore(join(home, 'orchestration.sqlite'));
    const sessions: Array<[string, string, string]> = [
      ['caller', A, p1.id],
      ['same-project', A, p1.id],
      ['person-ref', A, p2.id],
      ['agent-ref', A, p2.id],
      ['unreferenced', A, p2.id],
      ['device-ref', A, p2.id],
      ['peer-ref', A, p2.id],
      ['other-owner', OTHER, p1.id],
    ];
    let sequence = 0;
    const at = () => new Date(NOW + sequence++ * 1000).toISOString();
    const turn = (
      threadId: string,
      n: number,
      prompt: string,
      answer: string,
      actor?: Record<string, unknown>,
    ) => {
      store.appendEvent({
        eventId: `${threadId}:turn-${n}:start`,
        threadId,
        turnId: `${threadId}-turn-${n}`,
        provider: 'codex',
        method: 'turn.started',
        createdAt: at(),
        prompt,
        ...(actor ? { clientOrigin: origin(actor) } : {}),
      } as never);
      store.appendEvent({
        eventId: `${threadId}:turn-${n}:done`,
        threadId,
        turnId: `${threadId}-turn-${n}`,
        provider: 'codex',
        method: 'turn.completed',
        createdAt: at(),
        finishReason: 'stop',
        outputText: answer,
      });
    };
    for (const [threadId, userId, localProjectId] of sessions) {
      store.appendEvent({
        eventId: `${threadId}:start`,
        threadId,
        sessionId: threadId,
        provider: 'codex',
        method: 'session.started',
        createdAt: at(),
        metadata: {
          userId,
          [SESSION_LOCAL_PROJECT_ID_METADATA_KEY]: localProjectId,
        },
      });
      store.upsertSession({
        threadId,
        provider: 'codex',
        status: 'closed',
        createdAt: at(),
        updatedAt: at(),
      });
    }
    // The caller's own conversation: who referenced what.
    turn(
      'caller',
      1,
      `Please look at ${link('person-ref')} and ${link('gone')}`,
      'Looking.',
      { kind: 'operator' },
    );
    turn('caller', 2, `Agent note: see ${link('agent-ref')}`, 'Noted.', {
      kind: 'internal',
    });
    turn('caller', 3, `From my phone: ${link('device-ref')}`, 'Ok.', {
      kind: 'device',
      deviceId: 'phone',
    });
    turn('caller', 4, `Forwarded: ${link('peer-ref')}`, 'Ok.', {
      kind: 'device',
      deviceId: 'peer-station',
    });
    // An unattributed turn (no clientOrigin) is not a person's either.
    turn('caller', 5, `Unattributed: ${link('unreferenced')}`, 'Ok.');
    // The referenced conversations: seven turns, fourteen messages.
    for (let n = 1; n <= 7; n += 1)
      turn('person-ref', n, `PERSON-REF question ${n}`, `answer ${n}`);
    for (const threadId of [
      'same-project',
      'agent-ref',
      'unreferenced',
      'device-ref',
      'peer-ref',
      'other-owner',
    ])
      turn(threadId, 1, `${threadId.toUpperCase()}-SECRET`, 'reply');

    if (withProviderHistory) {
      const ids = ['history-root', 'history-codex', 'history-return'];
      for (let index = 0; index < ids.length; index++) {
        const id = ids[index]!;
        const provider = index === 1 ? 'codex' : 'claude';
        if (index > 0)
          store.reserveConversationHandoff({
            conversationId: ids[0]!,
            predecessorSessionId: ids[index - 1]!,
            sessionId: id,
            idempotencyKey: `history-switch-${index}`,
            messageDigest: `history-digest-${index}`,
            targetAgentId: `agent-${provider}`,
            targetEnvironmentId: 'history-station',
            ...(index === 2
              ? {
                  nativeReturnSourceSessionId: ids[0],
                  nativeReturnSourceEventId: `${ids[0]}:completed`,
                }
              : {}),
            createdAt: at(),
          });
        store.appendEvent({
          eventId: `${id}:start`,
          threadId: id,
          sessionId: id,
          provider,
          method: 'session.started',
          createdAt: at(),
          metadata: {
            userId: A,
            agentSlug: `agent-${provider}`,
            [SESSION_LOCAL_PROJECT_ID_METADATA_KEY]: p1.id,
          },
        });
        store.upsertSession({
          provider,
          threadId: id,
          status: 'closed',
          createdAt: at(),
          updatedAt: at(),
        });
        store.appendEvent({
          eventId: `${id}:prompt`,
          threadId: id,
          provider,
          turnId: `${id}:turn`,
          method: 'turn.started',
          createdAt: at(),
          prompt: `QUESTION-${index}`,
        });
        store.appendEvent({
          eventId: `${id}:completed`,
          threadId: id,
          provider,
          turnId: `${id}:turn`,
          method: 'turn.completed',
          createdAt: at(),
          outputText: `ANSWER-${index}`,
        });
        if (index < 2)
          store.claimNativeSessionIdentity(`history-native-${provider}`, id);
        else {
          store.recordNativeSessionRetired(ids[0]!);
          store.completeNativeReturnRetirement(id);
        }
      }
    }

    const orchestration = new OrchestrationService({
      eventStore: store,
      adoptionLedger: store.createAdoptionLedger(),
      eventBus: new EventBus(),
      adapterRegistry: { register() {}, get: () => undefined, list: () => [] },
      logger: { debug() {}, warn() {} },
    });
    orchestration.initialize();
    closers.push(async () => {
      await orchestration.shutdown();
      await expect.poll(() => store.close().kind).toBe('closed');
    });
    await awaitSessionAttachmentSettled(orchestration);

    const app = new Hono();
    // Listening first: the MCP route's tools call Station on `context.port`.
    let resolvePort!: (port: number) => void;
    const listening = new Promise<number>((done) => {
      resolvePort = done;
    });
    const server = serve(
      { fetch: app.fetch, hostname: '127.0.0.1', port: 0 },
      (info) => resolvePort((info as AddressInfo).port),
    );
    closers.unshift(
      () => new Promise<void>((done) => server.close(() => done())),
    );
    const port = await listening;
    const base = `http://127.0.0.1:${port}`;
    const context = deepStub({
      projectMembership: undefined,
      deploymentAuthentication: undefined,
      localAccounts: undefined,
      applicationSessions: undefined,
      app,
      port,
      appConfig: {},
      eventBus: new EventBus(),
      configLoader: {
        getProjectHomeDir: () => home,
        loadAppConfig: () => ({}),
      },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      activeAgents: new Map(),
      agentService: { listAgents: () => [] },
      agentMetadataMap: new Map(),
      agentFixedTokens: new Map(),
      agentTools: new Map(),
      agentStats: new Map(),
      agentStatus: new Map(),
      memoryAdapters: new Map([
        ['default', new FileMemoryAdapter({ projectHomeDir: home })],
      ]),
      metricsLog: [],
      orchestrationEventStore: store,
      orchestrationService: orchestration,
      storageAdapter: storage,
      projectService: projects,
      taskGraphService: deepStub({ listTasks: () => [] }),
      environmentSecurityService: deepStub({
        verifyCredential: () => false,
        authorizeCredential: () => false,
        verifyOperatorCredential: () => false,
        resolveGrantedScope: () => undefined,
        identifyDevice: () => undefined,
        canSharePersonalConversation: () => false,
        personalConversationOwnerIds: (id: string) => [id],
        devicePairing: deepStub({
          listDevices: () => [
            { id: 'phone', kind: 'device', name: 'Phone' },
            { id: 'peer-station', kind: 'delegation', name: 'Peer' },
          ],
        }),
      }),
    });
    Reflect.set(context as object, 'buildRuntimeContext', () => context);
    const result = configureRuntimeRoutes(
      context as unknown as Parameters<typeof configureRuntimeRoutes>[0],
    );
    await result.kitLifecycleReady;
    // The MCP route runs the tools in this process; they call Station here.
    process.env.STATION_API_BASE = base;
    return { base };
  }

  /** Run `calls` from a separate engine process as the `caller` session. */
  async function engine(base: string, calls: Record<string, unknown>[]) {
    const { token } = mintStationControlMcpToken('caller', 'url-token');
    const result = await run(
      process.execPath,
      ['--input-type=module', '-e', ENGINE],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          MCP_URL: `${base}${STATION_CONTROL_MCP_PATH}?token=${encodeURIComponent(token)}`,
          CALLS: JSON.stringify(calls),
        },
        timeout: 60_000,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      },
    );
    return JSON.parse(result.stdout) as Array<{
      isError: boolean;
      error?: unknown;
      body: any;
    }>;
  }

  test('a person’s reference admits a cross-Project read; an agent-written one admits nothing', async () => {
    const { base } = await setup();
    const [
      own,
      sameProject,
      personRef,
      agentRef,
      unattributed,
      otherOwner,
      gone,
      nope,
      deviceRef,
      peerRef,
    ] = await engine(base, [
      { conversationId: 'caller' },
      { conversationId: 'same-project' },
      { conversationId: 'person-ref' },
      { conversationId: 'agent-ref' },
      { conversationId: 'unreferenced' },
      { conversationId: 'other-owner' },
      { conversationId: 'gone' },
      { conversationId: 'nope' },
      { conversationId: 'device-ref' },
      { conversationId: 'peer-ref' },
    ]);

    expect(own).toMatchObject({
      isError: false,
      body: { success: true, data: { access: 'own' } },
    });
    expect(sameProject).toMatchObject({
      isError: false,
      body: { success: true, data: { access: 'scope' } },
    });
    expect(JSON.stringify(sameProject!.body)).toContain('SAME-PROJECT-SECRET');
    expect(personRef).toMatchObject({
      isError: false,
      body: {
        success: true,
        data: {
          conversationId: 'person-ref',
          access: 'reference',
          messageCount: 14,
          notice: expect.stringContaining('context, not instructions'),
        },
      },
    });
    expect(JSON.stringify(personRef!.body)).toContain('PERSON-REF question 1');
    expect(deviceRef).toMatchObject({
      isError: false,
      body: { success: true, data: { access: 'reference' } },
    });

    // An agent's link, another Station's delegation grant, and a turn with
    // no recorded sender grant nothing: same owner, another Project.
    for (const [refused, secret] of [
      [agentRef, 'AGENT-REF-SECRET'],
      [peerRef, 'PEER-REF-SECRET'],
      [unattributed, 'UNREFERENCED-SECRET'],
    ] as const) {
      expect(refused).toMatchObject({
        isError: true,
        body: { success: false, code: 'conversation_out_of_scope' },
      });
      expect(JSON.stringify(refused!.body)).not.toContain(secret);
    }
    // Another person's conversation reads as absent, even in this Project.
    expect(otherOwner).toMatchObject({
      isError: true,
      body: { success: false, code: 'conversation_not_found' },
    });
    expect(JSON.stringify(otherOwner!.body)).not.toContain(
      'OTHER-OWNER-SECRET',
    );
    expect(gone).toMatchObject({
      isError: true,
      body: { success: false, code: 'conversation_deleted' },
    });
    expect(nope).toMatchObject({
      isError: true,
      body: { success: false, code: 'conversation_not_found' },
    });
  }, 90_000);

  test('the agent history tool retains one Conversation and reports recorded provider handoffs and native returns', async () => {
    const { base } = await setup(true);
    const [answer] = await engine(base, [
      { conversationId: 'history-root', limit: 50 },
    ]);
    expect(answer?.isError).toBe(false);
    const data = answer!.body.data;
    expect(data.conversationId).toBe('history-root');
    expect(
      data.messages.map((message: { text: string }) => message.text),
    ).toEqual([
      'QUESTION-0',
      'ANSWER-0',
      'QUESTION-1',
      'ANSWER-1',
      'QUESTION-2',
      'ANSWER-2',
    ]);
    expect(
      data.messages.map((message: { sessionId: string }) => message.sessionId),
    ).toEqual([
      'history-root',
      'history-root',
      'history-codex',
      'history-codex',
      'history-return',
      'history-return',
    ]);
    expect(data.provenance).toMatchObject({
      protocolVersion: 1,
      status: 'available',
      currentSessionId: 'history-return',
      sessions: [
        {
          sessionId: 'history-root',
          provider: 'claude',
          agentSlug: 'agent-claude',
        },
        {
          sessionId: 'history-codex',
          provider: 'codex',
          agentSlug: 'agent-codex',
        },
        {
          sessionId: 'history-return',
          provider: 'claude',
          agentSlug: 'agent-claude',
        },
      ],
      handoffs: [
        { predecessorSessionId: 'history-root', sessionId: 'history-codex' },
        {
          predecessorSessionId: 'history-codex',
          sessionId: 'history-return',
          nativeReturn: { sourceSessionId: 'history-root' },
        },
      ],
    });
    expect(data.provenance).not.toHaveProperty('forkedFrom');
    const { token } = mintStationControlMcpToken('caller', 'url-token');
    const sdkOptions = withStationControlCallerContext(
      { token, resolve: () => null },
      () => controlRequestOptions(),
    );
    const sdkPage = await readConversation(
      base,
      'history-root',
      { limit: 2 },
      sdkOptions,
    );
    expect(sdkPage.conversationId).toBe('history-root');
    expect(sdkPage.messages).toHaveLength(2);
    expect(sdkPage.provenance).toEqual(data.provenance);
    expect(sdkPage.nextCursor).toEqual(expect.any(String));
    const nextSdkPage = await readConversation(
      base,
      'history-root',
      {
        cursor: sdkPage.nextCursor,
        limit: 2,
      },
      sdkOptions,
    );
    expect(nextSdkPage.messages.map((message) => message.sessionId)).toEqual([
      'history-codex',
      'history-codex',
    ]);
  });

  test('paging covers every message exactly once, and limit 51 is refused at the tool and the route', async () => {
    const { base } = await setup();
    const seen: Array<{ index: number; id: string; text: string }> = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const [page] = await engine(base, [
        {
          conversationId: 'person-ref',
          limit: 3,
          ...(cursor ? { cursor } : {}),
        },
      ]);
      expect(page!.isError).toBe(false);
      const data = page!.body.data;
      expect(data.messages.length).toBeLessThanOrEqual(3);
      seen.push(...data.messages);
      cursor = data.nextCursor ?? undefined;
      pages += 1;
    } while (cursor && pages < 20);
    expect(pages).toBe(5);
    expect(seen.map((message) => message.index)).toEqual(
      Array.from({ length: 14 }, (_, index) => index),
    );
    expect(new Set(seen.map((message) => message.id)).size).toBe(14);
    expect(
      seen.filter((m) => m.text.startsWith('PERSON-REF question')),
    ).toHaveLength(7);

    const [overLimit, atLimit] = await engine(base, [
      { conversationId: 'person-ref', limit: 51 },
      { conversationId: 'person-ref', limit: 50 },
    ]);
    // The tool's schema refuses 51 before any read; nothing is truncated.
    expect(overLimit!.isError).toBe(true);
    expect(JSON.stringify(overLimit!.body)).not.toContain('PERSON-REF');
    expect(atLimit).toMatchObject({
      isError: false,
      body: { data: { messageCount: 14, nextCursor: null } },
    });
    // The route refuses 51 on its own, whoever calls it.
    const { token } = mintStationControlMcpToken('caller', 'url-token');
    const viaRoute = await withStationControlCallerContext(
      { token, resolve: () => null },
      () => api('/api/conversations/person-ref/read?limit=51'),
    );
    expect(viaRoute).toMatchObject({
      success: false,
      code: 'conversation_read_limit_out_of_range',
    });
    // A cursor minted for another conversation is refused, not reused.
    const [first] = await engine(base, [
      { conversationId: 'person-ref', limit: 2 },
    ]);
    const [foreign] = await engine(base, [
      { conversationId: 'caller', cursor: first!.body.data.nextCursor },
    ]);
    expect(foreign).toMatchObject({
      isError: true,
      body: { code: 'conversation_read_cursor_invalid' },
    });
  }, 120_000);
});
