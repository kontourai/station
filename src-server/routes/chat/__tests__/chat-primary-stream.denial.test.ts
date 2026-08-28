/**
 * archive#3179: end-to-end proof that a GENUINE tool denial is observable.
 *
 * Every earlier test of this seam (archive#3091/#3113/#3117) constructs the
 * `tool-result` chunk it wants to see. That is legitimate for testing a
 * translation, but it cannot prove the chunk is ever PRODUCED — and it was
 * not: `@voltagent/core`'s `handleToolError` calls
 * `oc.abortController.abort(errorValue)` for a `ToolDeniedError`, which
 * tears the operation down after the hook call that observes it. On
 * `origin/main` the SSE response for a denied tool carried exactly
 * `conversation-started`, `start`, `[DONE]` — no `tool-call`, no
 * `tool-result`, no `finish`, no `error` — and the turn was reported to
 * monitoring as `reason: 'completed'` while emitting three unhandled
 * rejections.
 *
 * These tests therefore drive a REAL `@voltagent/core` `Agent` against a
 * real local SSE chat-completions server, deny the tool through the REAL
 * `beforeToolCall` contract (the exact `ToolCallDenial` shape
 * `pre-tool-policy.ts`'s `deny()` returns), and assert on what the user
 * actually receives: the SSE frames written by the REAL
 * `streamPrimaryAgentChat`, and the completion the route reports.
 *
 * Deliberately NOT asserted: the presence of a `tool-call` frame. The
 * engine yields one onto `fullStream`, but the abort lands during the
 * event-loop turn `writeSSEChunk` yields on, so the frames queued ahead of
 * it are discarded before the writer pulls them. That is a real residual
 * gap (the user sees the denied call's name and outcome, not its
 * arguments); asserting its absence here would pin today's behaviour as
 * intended, and asserting its presence would red for a reason this change
 * does not own.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createTool } from '@voltagent/core';
import { jsonSchema } from 'ai';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { VoltAgentFramework } from '../../../runtime/frameworks/voltagent-adapter.js';
import { captureRuntimeConfigurationLease } from '../../../runtime/plugins/runtime-configuration-lease.js';
import type { IAgent } from '../../../runtime/types.js';
import { GENERIC_TOOL_FAILURE_MESSAGE } from '../../../runtime/types.js';
import { streamPrimaryAgentChat } from '../chat-primary-stream.js';

/**
 * Spelled out rather than imported from `TOOL_DENIED_FINISH_REASON`
 * deliberately: this file's whole claim is that it reddens on `origin/main`,
 * and importing a constant this branch introduces would make it fail there
 * on a missing export — a broken build reading as a caught defect — instead
 * of on the behaviour. It is the wire value the client and the monitoring
 * record both read, so pinning the literal is pinning the contract.
 */
const TOOL_DENIED_FINISH_REASON = 'tool-denied';

const DENIAL_REASON =
  "Tool 'guarded_tool' was blocked by the config-protection policy: writes to config are not allowed.";

type TestServer = { close: () => Promise<void>; url: string };

function readSSEEvents(body: string): Array<Record<string, unknown>> {
  return body
    .split('\n\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice('data: '.length)));
}

/**
 * A real openai-compatible SSE endpoint that answers the first request with a
 * single tool call. Byte-shaped exactly like the archive#3113 tripwire's server, so
 * the only variable here is denial-vs-thrown-error.
 */
async function startToolCallingServer(): Promise<TestServer> {
  let calls = 0;
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) {
      // drain
    }
    if (req.method !== 'POST') {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          object: 'list',
          data: [{ id: 'gpt-4.1', object: 'model' }],
        }),
      );
      return;
    }
    calls += 1;
    res.statusCode = 200;
    res.setHeader('content-type', 'text/event-stream');
    const id = `chatcmpl-${calls}`;
    const created = Math.floor(Date.now() / 1000);
    const write = (
      delta: Record<string, unknown>,
      finishReason: string | null,
    ) =>
      res.write(
        `data: ${JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created,
          model: 'gpt-4.1',
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        })}\n\n`,
      );
    if (calls === 1) {
      write(
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              index: 0,
              id: 'call_1',
              type: 'function',
              function: { name: 'guarded_tool', arguments: '' },
            },
          ],
        },
        null,
      );
      write(
        { tool_calls: [{ index: 0, function: { arguments: '{}' } }] },
        null,
      );
      write({}, 'tool_calls');
    } else {
      write({ role: 'assistant', content: 'gave up' }, null);
      write({}, 'stop');
    }
    res.write('data: [DONE]\n\n');
    res.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve());
    server.once('error', reject);
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () =>
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

/** A real Agent holding one real tool the real model asks it to call. */
async function createToolCallingAgent(options: {
  serverUrl: string;
  /**
   * `@voltagent/core` invokes a tool as `execute(args, executionOptions)`
   * where `executionOptions` spreads the whole OperationContext — including
   * the `context` Map the wrapper's copy built. The gap-3 real-path test
   * below reads it; every other caller ignores both parameters.
   */
  execute?: (args?: unknown, executionOptions?: unknown) => Promise<unknown>;
  hooks?: any;
}): Promise<IAgent> {
  const framework = new VoltAgentFramework();
  const model = await framework.createModel(
    {
      execution: { modelConnectionId: 'compat-main', modelId: 'gpt-4.1' },
    } as never,
    {
      appConfig: { defaultModel: 'gpt-4.1' },
      projectHomeDir: '/tmp/project',
      listProviderConnections: () => [
        {
          id: 'compat-main',
          type: 'openai-compat',
          enabled: true,
          capabilities: ['llm'],
          name: 'Compat',
          config: {
            baseUrl: options.serverUrl,
            apiKey: 'test-key',
            defaultModel: 'gpt-4.1',
          },
        },
      ],
    } as never,
  );
  return await framework.createTempAgent({
    name: 'guarded',
    instructions: 'Help',
    model,
    tools: [
      createTool({
        name: 'guarded_tool',
        description: 'Guarded by the hook under test',
        parameters: jsonSchema({
          type: 'object',
          properties: {},
          additionalProperties: false,
        }) as never,
        execute: options.execute ?? (async () => 'SHOULD NOT RUN'),
      }),
    ] as never,
    ...(options.hooks ? { hooks: options.hooks } : {}),
  });
}

/** A real Agent whose one tool is denied by the real hook contract. */
async function createDeniedToolAgent(options: {
  serverUrl: string;
  /** Mirrors `pre-tool-policy.ts`'s `deny()` vs. a human declining (archive#3091). */
  policyDenied: boolean;
  /**
   * archive#3210: the authorship marker `denial-message.ts`'s
   * `stationDenial()` stamps. Both real writers set it — `deny()` alongside
   * `policyDenied`, and `agent-hooks.ts`'s human decline without — so the
   * default here matches the bytes production produces. It is set to `false`
   * only by the test that deliberately drives a hand-built denial from some
   * other hook implementation.
   */
  stationComposedReason?: boolean;
}): Promise<IAgent> {
  const composed = options.stationComposedReason !== false;
  return await createToolCallingAgent({
    serverUrl: options.serverUrl,
    hooks: {
      beforeToolCall: async () => ({
        allowed: false as const,
        reason: DENIAL_REASON,
        ...(options.policyDenied ? { policyDenied: true as const } : {}),
        ...(composed ? { stationComposedReason: true as const } : {}),
      }),
    },
  });
}

function buildCtx(options: {
  memoryAdapter: Record<string, unknown>;
  monitoringEmitter: Record<string, unknown>;
}) {
  return {
    agentSpecs: new Map(),
    toolNameMapping: new Map(),
    approvalRegistry: {},
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    agentHooksMap: new Map(),
    memoryAdapters: new Map([['guarded', options.memoryAdapter]]),
    feedbackService: { getRatings: () => [] },
    agentStatus: new Map(),
    agentStats: new Map(),
    agentTools: new Map(),
    monitoringEvents: undefined,
    monitoringEmitter: options.monitoringEmitter,
    modelCatalog: undefined,
    // `finalizeChatRequest` pushes a completion record here at the very end
    // of the turn. Omitting it makes the route's `finally` throw into
    // hono's stream helper, which swallows it — the assertions below would
    // still pass while half of the real finalize path never ran.
    metricsLog: [] as unknown[],
    providerService: {
      listProviderConnections: () => [],
      getLaunchabilityRevision: () => 0,
    },
    getAgentConfigurationRevision: () => 0,
    configLoader: { getLaunchabilityRevision: () => 0 },
    commitAgentConfigurationRead: async (
      _expectedRevision: number,
      operation: () => Promise<unknown>,
    ) => operation(),
  } as any;
}

function buildMemoryAdapter() {
  const conversations = new Map<string, { id: string; title?: string }>();
  return {
    getConversation: vi.fn(async (id: string) => conversations.get(id) ?? null),
    createConversation: vi.fn(async (payload: { id: string }) => {
      conversations.set(payload.id, {
        id: payload.id,
        title: 'New Conversation',
      });
    }),
    updateConversation: vi.fn(async () => {}),
    addMessage: vi.fn(async () => {}),
    getMessages: vi.fn(async () => []),
    getConversations: vi.fn(async () => []),
  };
}

function buildMonitoringEmitter() {
  const completions: Array<Record<string, unknown>> = [];
  const toolResults: Array<Record<string, unknown>> = [];
  return {
    completions,
    toolResults,
    emitter: {
      emitAgentStart: vi.fn(),
      emitAgentComplete: vi.fn((payload: Record<string, unknown>) => {
        completions.push(payload);
      }),
      emitToolCall: vi.fn(),
      emitToolResult: vi.fn((payload: Record<string, unknown>) => {
        toolResults.push(payload);
      }),
      emitReasoning: vi.fn(),
    },
  };
}

function buildApp(
  ctx: any,
  agent: IAgent,
  restOptions: Record<string, unknown> = {},
) {
  const app = new Hono();
  app.post('/chat', (c) =>
    streamPrimaryAgentChat({
      c,
      ctx,
      slug: 'guarded',
      plugin: '',
      input: 'use the guarded tool',
      restOptions,
      injectContext: null,
      ragContext: null,
      agent,
      configurationLease: captureRuntimeConfigurationLease(ctx)!,
    }),
  );
  return app;
}

describe('station#3179: a live tool denial through a REAL Agent', () => {
  const servers: TestServer[] = [];
  afterEach(async () => {
    while (servers.length) await servers.pop()?.close();
  });

  test('a policy denial reaches the user as a denied tool-result and a turn that is not a completed success', async () => {
    const server = await startToolCallingServer();
    servers.push(server);
    const agent = await createDeniedToolAgent({
      serverUrl: server.url,
      policyDenied: true,
    });

    const monitoring = buildMonitoringEmitter();
    const ctx = buildCtx({
      memoryAdapter: buildMemoryAdapter(),
      monitoringEmitter: monitoring.emitter,
    });
    const app = buildApp(ctx, agent);

    const response = await app.request('/chat', { method: 'POST' });
    const events = readSSEEvents(await response.text());

    // AC1: the denial reaches the user as a resolved, failed tool call
    // carrying the REAL Station-authored reason and the policy-denied marker
    // the UI's badge derives from — not a call that never resolves.
    const toolResult = events.find((e) => e.type === 'tool-result');
    expect(toolResult).toBeDefined();
    expect(toolResult).toMatchObject({
      toolCallId: 'call_1',
      toolName: 'guarded_tool',
      error: DENIAL_REASON,
      policyDenied: true,
    });
    // Nothing is invented: Station never received a tool output.
    expect(toolResult?.output).toBeUndefined();

    // …and it is NOT surfaced as the generic turn failure the issue warned
    // would be the same class of lie one level up.
    expect(events.find((e) => e.type === 'error')).toBeUndefined();

    // AC3: the turn is no longer reported as a completed success — on the
    // wire and in the monitoring record, which must agree with each other.
    expect(events.find((e) => e.type === 'finish')).toMatchObject({
      finishReason: TOOL_DENIED_FINISH_REASON,
    });
    expect(monitoring.completions).toHaveLength(1);
    expect(monitoring.completions[0]?.reason).toBe(TOOL_DENIED_FINISH_REASON);

    expect(monitoring.toolResults).toHaveLength(1);
    expect(monitoring.toolResults[0]).toMatchObject({
      toolCallId: 'call_1',
      toolName: 'guarded_tool',
      outcome: 'error',
    });
  }, 30_000);

  // archive#3210 (the inversion): before this change, the ONLY two denials
  // Station redacted to `Tool call failed.` were the two whose text Station
  // itself wrote — the human decline and the no-approval-channel template —
  // because they carry no `policyDenied` marker. A user who clicked Deny was
  // told nothing about their own decision. Authorship, not provenance, now
  // decides what the user reads.
  test('a human-declined approval reaches the user in its own words, without the policy-denied badge', async () => {
    const server = await startToolCallingServer();
    servers.push(server);
    const agent = await createDeniedToolAgent({
      serverUrl: server.url,
      policyDenied: false,
    });

    const monitoring = buildMonitoringEmitter();
    const ctx = buildCtx({
      memoryAdapter: buildMemoryAdapter(),
      monitoringEmitter: monitoring.emitter,
    });
    const app = buildApp(ctx, agent);

    const response = await app.request('/chat', { method: 'POST' });
    const events = readSSEEvents(await response.text());

    const toolResult = events.find((e) => e.type === 'tool-result');
    expect(toolResult).toBeDefined();
    expect(toolResult).toMatchObject({
      toolCallId: 'call_1',
      toolName: 'guarded_tool',
      error: DENIAL_REASON,
    });
    // …and archive#3091's badge contract is untouched: absent means "we
    // don't know why", and a human declining is NOT a policy denial.
    expect(toolResult?.policyDenied).toBeUndefined();
    expect(monitoring.completions[0]?.reason).toBe(TOOL_DENIED_FINISH_REASON);
  }, 30_000);

  // The other half of the same rule, and the reason it is fail-closed: a
  // denial that did NOT come through Station's composer is redacted even
  // when it claims the policy-denied provenance the badge derives from.
  // Nothing in production produces this shape today; the guard exists so
  // that a future hook implementation cannot mint renderable prose by
  // setting one flag.
  test('a denial Station did not compose is redacted even when it is policy-denied', async () => {
    const server = await startToolCallingServer();
    servers.push(server);
    const agent = await createDeniedToolAgent({
      serverUrl: server.url,
      policyDenied: true,
      stationComposedReason: false,
    });

    const monitoring = buildMonitoringEmitter();
    const ctx = buildCtx({
      memoryAdapter: buildMemoryAdapter(),
      monitoringEmitter: monitoring.emitter,
    });
    const app = buildApp(ctx, agent);

    const response = await app.request('/chat', { method: 'POST' });
    const events = readSSEEvents(await response.text());

    const toolResult = events.find((e) => e.type === 'tool-result');
    expect(toolResult).toMatchObject({
      toolCallId: 'call_1',
      error: GENERIC_TOOL_FAILURE_MESSAGE,
      // The badge still derives from `policyDenied`, unchanged (archive#3091).
      policyDenied: true,
    });
    expect(String(toolResult?.error)).not.toContain(DENIAL_REASON);
    expect(monitoring.completions[0]?.reason).toBe(TOOL_DENIED_FINISH_REASON);
  }, 30_000);

  test('an ordinary tool failure is NOT dressed up as a denial', async () => {
    const server = await startToolCallingServer();
    servers.push(server);
    const agent = await createToolCallingAgent({
      serverUrl: server.url,
      execute: async () => {
        throw new Error('remote-mcp-server-canary-token-xyz');
      },
    });

    const monitoring = buildMonitoringEmitter();
    const ctx = buildCtx({
      memoryAdapter: buildMemoryAdapter(),
      monitoringEmitter: monitoring.emitter,
    });
    const app = buildApp(ctx, agent);

    const response = await app.request('/chat', { method: 'POST' });
    const events = readSSEEvents(await response.text());

    // The engine resolves this one itself (archive#3113's tripwire proves the
    // shape), so exactly ONE result must reach the user — the derived
    // emission must not add a second — and the turn must not borrow the
    // denial vocabulary.
    //
    // Scope of THIS test, stated precisely because an independent review
    // (archive#3179) measured it: it has power over double-emission and over
    // the denial vocabulary, NOT over the `instanceof ToolDeniedError`
    // narrowing. Widening that narrowing to `instanceof Error` leaves this
    // test green, because `appendObservedToolDenials`' `resolvedToolCallIds`
    // guard drops the spurious second result — the engine resolved this call.
    // The narrowing is covered by the first test in this file, where the
    // engine resolves nothing and the derived chunk is the only one there is.
    const toolResults = events.filter((e) => e.type === 'tool-result');
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]).toMatchObject({
      toolCallId: 'call_1',
      error: GENERIC_TOOL_FAILURE_MESSAGE,
    });
    expect(toolResults[0]?.policyDenied).toBeUndefined();
    expect(
      events.filter(
        (e) =>
          e.type === 'finish' && e.finishReason === TOOL_DENIED_FINISH_REASON,
      ),
    ).toHaveLength(0);
    expect(monitoring.completions[0]?.reason).not.toBe(
      TOOL_DENIED_FINISH_REASON,
    );
  }, 30_000);

  test('the denial path emits no unhandled promise rejection', async () => {
    const server = await startToolCallingServer();
    servers.push(server);
    const agent = await createDeniedToolAgent({
      serverUrl: server.url,
      policyDenied: true,
    });

    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const ctx = buildCtx({
        memoryAdapter: buildMemoryAdapter(),
        monitoringEmitter: buildMonitoringEmitter().emitter,
      });
      const app = buildApp(ctx, agent);
      const response = await app.request('/chat', { method: 'POST' });
      await response.text();
      // `unhandledRejection` fires on a later macrotask than the one that
      // settles the promise, so drain the loop before asserting absence.
      for (let i = 0; i < 8; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }

    // On `origin/main` this reported three copies of the denial reason:
    // `text`, `usage`, and `finishReason` all reject, and the old
    // `suppressAbortError` re-rejected each into a promise nobody holds.
    expect(
      rejections.map((reason) =>
        reason instanceof Error ? reason.message : String(reason),
      ),
    ).toEqual([]);
  }, 30_000);
});

/**
 * archive#3211's headline gap: no test ran two turns at once.
 *
 * It matters because `createVoltAgentLifecycleHooks` builds hooks PER-AGENT,
 * shared by every concurrent turn, while archive#3179's denial sink is
 * per-CALL — reachable from the hook only through that call's own operation
 * context. Cross-attribution would be severe: a denial raised in one user's
 * conversation surfacing in another's transcript, or an allowed turn
 * inheriting a `finishReason: 'tool-denied'` it never earned.
 *
 * The review that found the gap wrote exactly this probe, confirmed isolation
 * holds, and then removed it with the review. It is landed here as a real
 * test. It also closes gap 4 independently: the two turns use `call_A1` and
 * `call_B1`, so a derived chunk that hardcoded `'call_1'` — which passed the
 * entire suite — cannot pass this.
 */
describe('station#3211: two concurrent turns on ONE Agent', () => {
  const servers: TestServer[] = [];
  afterEach(async () => {
    while (servers.length) await servers.pop()?.close();
  });

  /**
   * Answers each turn with a tool call whose id names the lane the request
   * belongs to, so the two turns are distinguishable by id — and neither id
   * is the `call_1` every other fixture in the tree uses.
   */
  async function startLaneAwareServer(): Promise<TestServer> {
    const server = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += String(chunk);
      if (req.method !== 'POST') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            object: 'list',
            data: [{ id: 'gpt-4.1', object: 'model' }],
          }),
        );
        return;
      }
      const lane = body.includes('lane-A') ? 'A' : 'B';
      // A turn that already carries a tool result is the follow-up call.
      const isFollowUp = body.includes('"tool"');
      res.statusCode = 200;
      res.setHeader('content-type', 'text/event-stream');
      const write = (
        delta: Record<string, unknown>,
        finishReason: string | null,
      ) =>
        res.write(
          `data: ${JSON.stringify({
            id: `chatcmpl-${lane}`,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: 'gpt-4.1',
            choices: [{ index: 0, delta, finish_reason: finishReason }],
          })}\n\n`,
        );
      if (isFollowUp) {
        write({ role: 'assistant', content: `done-${lane}` }, null);
        write({}, 'stop');
      } else {
        write(
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                index: 0,
                id: `call_${lane}1`,
                type: 'function',
                function: { name: 'guarded_tool', arguments: '' },
              },
            ],
          },
          null,
        );
        write(
          { tool_calls: [{ index: 0, function: { arguments: '{}' } }] },
          null,
        );
        write({}, 'tool_calls');
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
    await new Promise<void>((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => resolve());
      server.once('error', reject);
    });
    const address = server.address() as AddressInfo;
    return {
      url: `http://127.0.0.1:${address.port}`,
      close: async () =>
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    };
  }

  test('a denial in one conversation never reaches the other, and identity is per-call', async () => {
    const server = await startLaneAwareServer();
    servers.push(server);

    const seen: string[] = [];
    const agent = await createToolCallingAgent({
      serverUrl: server.url,
      // The ALLOWED turn's tool sleeps, so its window certainly overlaps the
      // denied turn's — the hooks are shared, and this is when a shared sink
      // or a shared "last denial" slot would cross the wires.
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 600));
        return 'allowed-result';
      },
      hooks: {
        beforeToolCall: async (
          _tool: unknown,
          invocation: { conversationId?: string },
        ) => {
          seen.push(String(invocation.conversationId));
          if (invocation.conversationId !== 'conv-A') return true;
          return {
            allowed: false as const,
            reason: DENIAL_REASON,
            policyDenied: true as const,
            stationComposedReason: true as const,
          };
        },
      },
    });

    async function runTurn(lane: 'A' | 'B') {
      const result = await agent.streamText(
        `use the guarded tool lane-${lane}`,
        {
          conversationId: `conv-${lane}`,
          userId: `user-${lane}`,
        },
      );
      // A denied turn's engine promises reject (the operation is aborted);
      // the route suppresses that, and a direct caller must too or the
      // rejection is unhandled.
      void result.text?.catch(() => undefined);
      void result.usage?.catch(() => undefined);
      void result.finishReason?.catch(() => undefined);
      const chunks: Array<Record<string, unknown>> = [];
      for await (const chunk of result.fullStream) {
        chunks.push(chunk as Record<string, unknown>);
      }
      return chunks;
    }

    const [a, b] = await Promise.all([runTurn('A'), runTurn('B')]);

    // Both turns really did run through the shared hook.
    expect(new Set(seen)).toEqual(new Set(['conv-A', 'conv-B']));

    // The denied turn: its own call id, its own reason, its own finish.
    const aResults = a.filter((c) => c.type === 'tool-result');
    expect(aResults).toHaveLength(1);
    expect(aResults[0]).toMatchObject({
      toolCallId: 'call_A1',
      error: DENIAL_REASON,
      policyDenied: true,
    });
    expect(
      a.filter(
        (c) =>
          c.type === 'finish' && c.finishReason === TOOL_DENIED_FINISH_REASON,
      ),
    ).toHaveLength(1);

    // The allowed turn: nothing from the other lane leaked into it.
    const bResults = b.filter((c) => c.type === 'tool-result');
    expect(bResults.map((c) => c.toolCallId)).toEqual(['call_B1']);
    expect(bResults[0]?.error).toBeUndefined();
    expect(bResults[0]?.policyDenied).toBeUndefined();
    expect(JSON.stringify(b)).not.toContain('call_A1');
    expect(JSON.stringify(b)).not.toContain(DENIAL_REASON);
    expect(
      b.filter(
        (c) =>
          c.type === 'finish' && c.finishReason === TOOL_DENIED_FINISH_REASON,
      ),
    ).toHaveLength(0);
    // …and it actually completed as its own turn.
    expect(
      b.some((c) => c.type === 'finish' && c.finishReason !== undefined),
    ).toBe(true);
  }, 30_000);
});

/**
 * Bounded condition wait. Polls a synchronous predicate on a 10 ms cadence
 * with a generous ceiling, so nothing here assumes a quiet host — and a
 * condition that never comes fails LOUDLY with its own name rather than
 * letting the test proceed to assert on a state it never reached.
 */
async function waitFor(condition: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 1000; i += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

/**
 * archive#3211 guard 5: `recordAuxiliaryRejection`'s abort short-circuit
 * (`if (abortController.signal.aborted) return;` in chat-primary-stream.ts).
 *
 * The issue's fault-injection matrix showed deleting that line left the
 * whole suite GREEN — the guard's rejection branch had never executed. These
 * two tests give it both directions: a denial with no client abort must be
 * recorded exactly once WITH the turn's identity (the accept branch, which
 * is the entire point of archive#3179's rewrite — the old body put the rejection
 * back into the void), and a rejection arriving after STATION's own abort
 * must not be recorded at all (the rejection branch — a client that hung up
 * is not an anomaly worth a warn per turn).
 */
describe("station#3211 guard 5: recordAuxiliaryRejection's abort short-circuit", () => {
  const servers: TestServer[] = [];
  afterEach(async () => {
    while (servers.length) await servers.pop()?.close();
  });

  const AUX_WARN = 'Agent result promise rejected outside the stream';

  function auxWarnCalls(ctx: any): unknown[][] {
    return (ctx.logger.warn as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call: unknown[]) => call[0] === AUX_WARN,
    );
  }

  test('accept branch: a denial with no client abort records the auxiliary rejection ONCE, with the turn identity', async () => {
    const server = await startToolCallingServer();
    servers.push(server);
    const agent = await createDeniedToolAgent({
      serverUrl: server.url,
      policyDenied: true,
    });

    const ctx = buildCtx({
      memoryAdapter: buildMemoryAdapter(),
      monitoringEmitter: buildMonitoringEmitter().emitter,
    });
    const app = buildApp(ctx, agent);

    const response = await app.request('/chat', { method: 'POST' });
    await response.text();
    // The three engine promises reject together on the denial; their
    // `.catch` callbacks run on later microtasks — drain before asserting.
    for (let i = 0; i < 8; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    // Exactly once — `text`, `usage` and `finishReason` all reject on the
    // same underlying denial, and the `auxiliaryRejectionRecorded` dedup is
    // what keeps that from being three warns…
    const calls = auxWarnCalls(ctx);
    expect(calls).toHaveLength(1);
    // …and the record carries the turn's identity, which is what the old
    // unattributable crash-handler log could never do.
    expect(calls[0]?.[1]).toMatchObject({
      agentId: 'guarded',
      conversationId: expect.stringContaining(''),
    });
  }, 30_000);

  test('rejection branch: a rejection after the client aborted is NOT recorded — the abort short-circuit holds', async () => {
    const server = await startToolCallingServer();
    servers.push(server);

    // The denial is GATED: it fires only after the test has aborted the
    // client request, so the engine's promise rejections deterministically
    // arrive with `abortController.signal.aborted === true` — no sleeps, no
    // host-speed assumptions.
    let releaseDenial: () => void = () => {};
    const denialGate = new Promise<void>((resolve) => {
      releaseDenial = resolve;
    });
    let reachedGate: () => void = () => {};
    const gateReached = new Promise<void>((resolve) => {
      reachedGate = resolve;
    });

    const agent = await createToolCallingAgent({
      serverUrl: server.url,
      hooks: {
        beforeToolCall: async () => {
          reachedGate();
          await denialGate;
          return {
            allowed: false as const,
            reason: DENIAL_REASON,
            policyDenied: true as const,
            stationComposedReason: true as const,
          };
        },
      },
    });

    const monitoring = buildMonitoringEmitter();
    const ctx = buildCtx({
      memoryAdapter: buildMemoryAdapter(),
      monitoringEmitter: monitoring.emitter,
    });
    const app = buildApp(ctx, agent);

    const clientAbort = new AbortController();
    const response = await app.request('/chat', {
      method: 'POST',
      signal: clientAbort.signal,
    });
    const bodyText = response.text().catch(() => '');

    // The engine is now paused inside the REAL beforeToolCall contract.
    await gateReached;

    // The client hangs up FIRST…
    clientAbort.abort();
    // …and we wait until the route's own disconnect listener has observed
    // it — that listener is what flips the exact `abortController.signal`
    // the guard under test reads.
    await waitFor(
      () =>
        (ctx.logger.debug as any).mock.calls.some(
          (call: unknown[]) =>
            call[0] === 'Client disconnected, aborting operation',
        ),
      "the route's client-disconnect abort",
    );

    // Only THEN does the denial land, rejecting text/usage/finishReason.
    releaseDenial();

    // The turn's `finally` has run once a completion is recorded; by then
    // the rejections have settled. Drain a few more macrotasks for the
    // `.catch` callbacks themselves.
    await waitFor(
      () => ctx.metricsLog.length > 0 || monitoring.completions.length > 0,
      "the turn's finalize record",
    );
    for (let i = 0; i < 8; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await bodyText;

    // The short-circuit: a rejection after Station's own abort is expected
    // teardown, not an anomaly. Deleting
    // `if (abortController.signal.aborted) return;` makes this non-empty.
    expect(auxWarnCalls(ctx)).toEqual([]);
  }, 30_000);
});

/**
 * archive#3211 gap 3, through the REAL enforcement path this time.
 *
 * The unit tests beside `contextWithToolDenialObservations` prove the copy
 * loop in isolation; the archive#1201-class lesson is that a function proven in
 * isolation says nothing about whether the live path actually routes through
 * it. This drives the issue's own wire claim end to end: `restOptions` IS
 * the chat schema's `.passthrough()`'d client `options` bag, the route
 * builds `operationContext = { ...restOptions, elicitation }`, the wrapper
 * copies `options.context` into the Map it hands `@voltagent/core`, and the
 * engine spreads that operation context into every tool's
 * `execute(args, executionOptions)`. A client-supplied `options.context`
 * entry must therefore be readable by a real tool executing under a real
 * model round trip — dropping the copy loop silently discards it.
 */
describe('station#3211 gap 3: client-supplied options.context, real path', () => {
  const servers: TestServer[] = [];
  afterEach(async () => {
    while (servers.length) await servers.pop()?.close();
  });

  test('an options.context entry on the wire survives into the operation context a real tool executes under', async () => {
    const server = await startToolCallingServer();
    servers.push(server);

    const agent = await createToolCallingAgent({
      serverUrl: server.url,
      execute: async (_args, executionOptions) => {
        const operationContext = (executionOptions ?? {}) as {
          context?: Map<string | symbol, unknown>;
        };
        return {
          echoedClientContext:
            operationContext.context?.get('clientRequestTag') ?? null,
        };
      },
    });

    const ctx = buildCtx({
      memoryAdapter: buildMemoryAdapter(),
      monitoringEmitter: buildMonitoringEmitter().emitter,
    });
    const app = buildApp(ctx, agent, {
      context: { clientRequestTag: 'client-ctx-tag-3211' },
    });

    const response = await app.request('/chat', { method: 'POST' });
    const events = readSSEEvents(await response.text());

    const toolResult = events.find((e) => e.type === 'tool-result');
    expect(toolResult).toBeDefined();
    // The tool really executed under an operation context carrying the
    // client's entry — `null` here means the copy loop dropped it.
    expect(toolResult?.output).toMatchObject({
      echoedClientContext: 'client-ctx-tag-3211',
    });
  }, 30_000);
});
