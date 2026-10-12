/**
 * #3284: a tool server's form elicitation, end to end through Station.
 *
 * Real pieces, in production order: the fixture MCP server (a child process)
 * → Station's MCP client connection (declared `elicitation` capability) →
 * the Station tool wrapper from `loadAgentTools` → the turn's elicitation
 * bridge (`createElicitationCallback`) → the `/chat` SSE frame → the
 * `StationAgentAdapter` relay → the persisted `request.opened` → the
 * `respondToRequest` command through `OrchestrationService` → back to the
 * server, which reports what it received. Only the `/chat` HTTP hop is a
 * pipe: the injected chunks are written to the adapter's fetch stream as the
 * route would write them.
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  connectMCP,
  type MCPConnection,
  MCPLocalConnectionCustody,
} from '@kontourai/station-shared/mcp';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { StationAgentAdapter } from '../../../providers/adapters/station-agent-adapter.js';
import { ApprovalRegistry } from '../../../services/approvals/approval-registry.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { createMCPToolProvenanceGeneration } from '../../../services/orchestration/mcp-tool-provenance.js';
import { OrchestrationService } from '../../../services/orchestration/orchestration-service.js';
import { createElicitationCallback } from '../../conversation/stream-orchestrator.js';
import { InjectableStream } from '../../streaming/InjectableStream.js';
import { loadAgentTools } from '../mcp-manager.js';

const FIXTURE = fileURLToPath(
  new URL(
    '../../../../packages/shared/src/__tests__/fixtures/mcp-elicitation-server.mjs',
    import.meta.url,
  ),
);
const THREAD = 'elicitation-turn';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

async function eventually<T>(read: () => T | undefined): Promise<T> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('condition never held');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('#3284 MCP elicitation through a Station turn', () => {
  // Registered before the afterEach below, so it removes the directory after
  // the event store and connection are closed, and on failure too.
  const makeTempDir = trackTempDirs();
  let tmp: string;
  let connection: MCPConnection;
  let eventStore: EventStore;
  let service: OrchestrationService;
  let adapter: StationAgentAdapter;
  let askDetails: (options: Record<string, unknown>) => Promise<unknown>;
  let callback: ReturnType<typeof createElicitationCallback>;
  let endStream: () => void;

  beforeEach(async () => {
    tmp = makeTempDir('mcp-elicitation-turn-');
    connection = await connectMCP({
      id: 'fixture',
      kind: 'mcp',
      transport: 'stdio',
      command: process.execPath,
      args: [FIXTURE],
    });
    const spec = {
      name: 'Agent',
      tools: { mcpServers: ['fixture'], available: ['*'] },
    } as any;
    const tools = await loadAgentTools(
      'agent',
      spec,
      {
        loadIntegration: async () => ({
          id: 'fixture',
          kind: 'mcp',
          transport: 'stdio',
          command: process.execPath,
          args: [FIXTURE],
        }),
        getProjectHomeDir: () => tmp,
      } as any,
      new Map([['fixture', connection]]),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      logger,
      0,
      createMCPToolProvenanceGeneration(),
      undefined,
      new MCPLocalConnectionCustody(),
    );
    // The runtime (model-facing) name is normalized; the server's is `ask_details`.
    const tool = tools.find(
      (candidate) => candidate.name === 'fixture_askDetails',
    ) as any;
    if (!tool)
      throw new Error(
        `ask_details was not loaded: ${JSON.stringify(tools.map((t) => t.name))} ${JSON.stringify(logger.error.mock.calls)}`,
      );
    askDetails = (options) => tool.execute({}, options);

    const eventBus = new EventBus();
    const approvalRegistry = new ApprovalRegistry(logger, { eventBus });
    const injectable = new InjectableStream();
    callback = createElicitationCallback(
      spec,
      new Map(),
      approvalRegistry,
      injectable,
      logger,
      () => THREAD,
    );

    // The `/chat` hop: whatever the turn injects is written as an SSE frame.
    let ended!: () => void;
    const turnOver = new Promise<void>((resolve) => {
      ended = resolve;
    });
    endStream = ended;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        // The model is silent while its tool call waits on the person.
        const silentModel: AsyncIterable<never> = {
          [Symbol.asyncIterator]: () => ({
            next: async () => {
              await turnOver;
              return { done: true, value: undefined };
            },
          }),
        };
        for await (const chunk of injectable.wrap(silentModel))
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`),
          );
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    adapter = new StationAgentAdapter({
      apiBase: 'http://127.0.0.1:1',
      hasAgent: () => true,
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(body, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      ),
      approvalRegistry,
      eventBus,
    });
    eventStore = new EventStore(join(tmp, 'orchestration.sqlite'));
    service = new OrchestrationService({
      adapterRegistry: {
        register() {},
        get: (provider) => (provider === 'station-agent' ? adapter : undefined),
        list: () => [adapter],
      },
      eventBus,
      eventStore,
      logger,
    });
    await service.dispatch(
      {
        type: 'startSession',
        input: {
          threadId: THREAD,
          provider: 'station-agent',
          metadata: { agentId: 'agent' },
        },
      },
      { userId: 'owner-user' },
    );
    // The turn whose `/chat` stream is the pipe above. Sent to the adapter
    // directly: turn admission is not under test here, the answer path is.
    await adapter.sendTurn({ threadId: THREAD, input: 'Write it' });
  });

  afterEach(async () => {
    endStream?.();
    await adapter.stopSession(THREAD).catch(() => undefined);
    await connection.close();
    eventStore.close();
  });

  /** Run the tool as the turn would, and wait for its form to open. */
  async function openForm(abort = new AbortController()) {
    const before = new Set(
      eventStore
        .listEvents(THREAD)
        .map((persisted) => persisted.payload.eventId),
    );
    const result = askDetails({
      elicitation: callback,
      abortController: abort,
      conversationId: THREAD,
    });
    const opened = await eventually(() =>
      eventStore
        .listEvents(THREAD)
        .map((persisted) => persisted.payload)
        .find(
          (event) =>
            !before.has(event.eventId) &&
            event.method === 'request.opened' &&
            event.payload?.inputRequest !== undefined,
        ),
    );
    if (opened.method !== 'request.opened') throw new Error('unreachable');
    const command = {
      type: 'respondToRequest' as const,
      threadId: opened.threadId,
      requestId: opened.requestId,
      expectedRequestEventId: opened.eventId,
    };
    return { result, opened, command };
  }

  /** What the fixture server says it received (its tool result text). */
  function received(result: unknown) {
    const text = (result as { content?: Array<{ text?: string }> }).content?.[0]
      ?.text;
    if (typeof text !== 'string')
      throw new Error(`no report in ${JSON.stringify(result)}`);
    return JSON.parse(text);
  }

  test('the form opens for the turn, refuses invalid content, and an accept reaches the server', async () => {
    const { result, opened, command } = await openForm();
    expect(opened).toMatchObject({
      requestType: 'approval',
      title: 'fixture needs your input',
      description: 'Who should the report be addressed to?',
      payload: {
        inputRequest: {
          schema: 'station.input-request/v1',
          source: 'mcp:fixture',
          requester: 'fixture',
          body: {
            kind: 'form',
            fields: expect.arrayContaining([
              expect.objectContaining({ name: 'name', required: true }),
              expect.objectContaining({ name: 'age', kind: 'integer' }),
            ]),
          },
        },
      },
    });

    const accept = { ...command, decision: 'accept' as const };
    await expect(service.dispatch(accept)).rejects.toThrow(
      'Fill in the form before sending it.',
    );
    await expect(
      service.dispatch({ ...accept, content: { age: 36 } }),
    ).rejects.toThrow('Name is required.');
    await expect(
      service.dispatch({
        ...accept,
        content: { name: 'Ada', age: 3.5 },
      }),
    ).rejects.toThrow('Age must be a whole number.');
    await expect(
      service.dispatch({
        ...accept,
        // Over maxLength 40: refused, never cut to 40.
        content: { name: 'A'.repeat(41) },
      }),
    ).rejects.toThrow('Name allows at most 40 characters.');
    await expect(
      service.dispatch({ ...command, decision: 'acceptForSession' }),
    ).rejects.toThrow('Inspect the current request');

    await service.dispatch({
      ...accept,
      content: { name: 'Ada', age: 36, color: 'blue' },
    });
    expect(received(await result)).toEqual({
      action: 'accept',
      content: { name: 'Ada', age: 36, color: 'blue' },
    });
    await expect(
      eventually(() =>
        eventStore
          .listEvents(THREAD)
          .map((persisted) => persisted.payload)
          .find(
            (event) =>
              event.method === 'request.resolved' &&
              event.requestId === opened.requestId,
          ),
      ),
    ).resolves.toMatchObject({ status: 'approved' });
  });

  test('decline and cancel reach the server as themselves', async () => {
    const declined = await openForm();
    await expect(
      service.dispatch({
        ...declined.command,
        decision: 'decline',
        content: { name: 'Ada' },
      }),
    ).rejects.toThrow('cannot carry an answer');
    await service.dispatch({ ...declined.command, decision: 'decline' });
    expect(received(await declined.result)).toEqual({
      action: 'decline',
      content: null,
    });

    const cancelled = await openForm();
    await service.dispatch({ ...cancelled.command, decision: 'cancel' });
    expect(received(await cancelled.result)).toEqual({
      action: 'cancel',
      content: null,
    });
  });

  test('stopping the turn cancels the open form', async () => {
    const abort = new AbortController();
    const { result, opened } = await openForm(abort);
    abort.abort('turn stopped');
    expect(received(await result)).toEqual({ action: 'cancel', content: null });
    await expect(
      service.dispatch({
        type: 'respondToRequest',
        threadId: opened.threadId,
        requestId: opened.requestId,
        expectedRequestEventId: opened.eventId,
        decision: 'accept',
        content: { name: 'Late' },
      }),
    ).rejects.toThrow();
  });

  test('a call with no turn bridge never shows a form or invents an answer', async () => {
    // The connection refuses the elicitation; the server's tool fails, and
    // Station reports that failure — not a decline or cancel nobody chose.
    await expect(askDetails({})).rejects.toThrow('MCP tool call failed');
    expect(
      eventStore
        .listEvents(THREAD)
        .some(
          (persisted) =>
            persisted.payload.method === 'request.opened' &&
            persisted.payload.payload?.inputRequest !== undefined,
        ),
    ).toBe(false);
  });
});
