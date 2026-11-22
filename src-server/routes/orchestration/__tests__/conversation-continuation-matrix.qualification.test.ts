import { join } from 'node:path';
import {
  agentId,
  engineConnectionId,
} from '@kontourai/station-contracts/agent-identity';
import { CONVERSATION_FORK_REFUSAL_CODES } from '@kontourai/station-contracts/orchestration';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  continuityBinding,
  continuityRegistry,
  TerminalHandoffAdapter,
} from '../../../__test-utils__/scripted-continuity-adapter.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { FileMemoryAdapter } from '../../../adapters/file/memory-adapter.js';
import {
  createConversationHandoffIntent,
  type ExecutionTargetExecutionDependencies,
  executeForegroundMessage,
} from '../../../services/execution-target/execution-target-execution.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { OrchestrationService } from '../../../services/orchestration/orchestration-service.js';
import { createSessionAgentResolver } from '../../../services/orchestration/session-agent-resolution.js';
import type { Logger } from '../../../utils/logger.js';
import { createConversationRoutes } from '../../chat/conversations.js';

/**
 * Fork ("Fork from here") and handoff ("Continue with another agent") across
 * every engine family this harness can stand up, observed where it counts:
 * the input the receiving adapter is actually given on its first turn.
 *
 * Engine families: `claude` and `codex` carry native-resume continuity; `acp`
 * (the family Antigravity, Kiro and other ACP agents run on), `opencode`,
 * `muse` and `station-agent` (the built-in Station agent's engine) are plain
 * seed-carried engines here. `station-file` is a conversation the built-in
 * agent stored in its own file memory rather than as runtime events.
 */
const OWNER = 'matrix-qualification-owner';
const ENVIRONMENT = 'matrix-qualification-station';
const authority = sessionReadAuthorityFromRequest(OWNER, undefined, undefined);
const NATIVE_RESUME_ENGINES = ['claude', 'codex'] as const;
const ENGINES = [
  ...NATIVE_RESUME_ENGINES,
  'acp',
  'opencode',
  'muse',
  'station-agent',
] as const;
type Engine = (typeof ENGINES)[number];
/**
 * The built-in Station agent: public slug `station`, runtime key `default`,
 * run by the `station-agent` engine, and keeping its own stored record of
 * each conversation besides the runtime turns.
 */
const STATION_AGENT = 'station';
type AgentName = Engine | typeof STATION_AGENT;
const engineOf = (agent: AgentName): Engine =>
  agent === STATION_AGENT ? 'station-agent' : agent;
const FILE_SOURCE = 'station-file';
const FILE_AGENT = agentId('station-file');
const BEFORE = ['PREFIX-ONE-4471', 'PREFIX-TWO-4472'] as const;
const AFTER = 'AFTER-BRANCH-4473';
const logger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: () => logger,
  setLevel: vi.fn(),
  getLevel: () => 'error',
};

describe('fork and handoff deliver the transcript seed across engine families', () => {
  const makeTempDir = trackTempDirs();
  const runtimes: { service: OrchestrationService; store: EventStore }[] = [];
  afterEach(async () => {
    for (const runtime of runtimes.splice(0)) {
      await runtime.service.shutdown();
      runtime.store.close();
    }
  });

  function harness() {
    const root = makeTempDir('station-continuation-matrix-');
    const store = new EventStore(join(root, 'events.sqlite'));
    const ownership = {
      assertMutable: (id: string) => store.assertNativeSessionMutable(id),
      claim: (key: string, id: string, rebind?: boolean) =>
        store.claimNativeSessionIdentity(key, id, rebind),
      retired: (id: string) => store.recordNativeSessionRetired(id),
    };
    const adapters = new Map<string, TerminalHandoffAdapter>(
      ENGINES.map((engine) => [
        engine,
        new TerminalHandoffAdapter(
          engine,
          (NATIVE_RESUME_ENGINES as readonly string[]).includes(engine),
          ownership,
        ),
      ]),
    );
    const service = new OrchestrationService({
      eventStore: store,
      eventBus: new EventBus(),
      adapterRegistry: continuityRegistry([...adapters.values()]),
      logger,
      resolveSessionAgent: createSessionAgentResolver({
        loadAgentSpec: async (slug) => ({
          name: slug,
          prompt: `Instructions for ${slug}`,
          skills: [],
          tools: { mcpServers: [] },
        }),
        resolveToolServer: async () => null,
        resolveSkillDir: async () => null,
      }),
    });
    runtimes.push({ service, store });
    const memory = new Map<string, FileMemoryAdapter>(
      [...ENGINES, FILE_SOURCE, 'default'].map((agent) => [
        agent,
        new FileMemoryAdapter({ projectHomeDir: root }),
      ]),
    );
    const routes = createConversationRoutes(
      memory,
      logger,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      service,
      () => OWNER,
      undefined,
      () => authority,
      service,
      () => true,
    );
    const known = (id: string): id is Engine =>
      (ENGINES as readonly string[]).includes(id);
    const connectionEngine = (id: string) =>
      ENGINES.find((engine) => engineConnectionId(engine) === id);
    const deps: ExecutionTargetExecutionDependencies = {
      resolveEnvironmentAccess: async () => ({
        kind: 'current',
        apiBase: 'http://matrix-qualification.station',
        environmentId: ENVIRONMENT,
        environmentName: 'Matrix qualification',
      }),
      getAgent: async (_access, id) => {
        if (id !== STATION_AGENT && !known(id))
          throw new Error(`Unexpected execution Agent ${id}.`);
        return {
          slug: id,
          available: true,
          executionDefault: true,
          execution: { agentConnectionId: engineConnectionId(engineOf(id)) },
        };
      },
      getConnection: async (_access, id) => {
        const engine = connectionEngine(id);
        if (!engine) throw new Error(`Unexpected connection ${id}.`);
        return {
          id: engineConnectionId(engine),
          name: engine,
          type: `${engine}-runtime`,
          kind: 'agent',
          enabled: true,
          status: 'ready',
          capabilities: ['agent-runtime'],
          prerequisites: [],
          config: { provider: engine },
        };
      },
      getProject: async () => {
        throw new Error('This fixture has no Project.');
      },
      getProviderAdapter: (id) => service.getProviderAdapter(id),
      readSessionBinding: async (_access, id) => continuityBinding(store, id),
      readInitialConversationContext: async (_access, input) =>
        service.prepareInitialConversationForkContext(input, authority),
      resolveConversationSession: async (_access, id, requested) =>
        service.resolveConversationContinuation(id, authority, requested),
      prepareConversationHandoff: async (_access, input) =>
        service.prepareConversationHandoff(input.conversationId, authority, {
          agentId: input.agentId,
          environmentId: ENVIRONMENT,
          provider: input.provider,
          connectionId: input.connectionId,
          idempotencyKey: input.idempotencyKey,
          messageDigest: input.messageDigest,
        }),
      readConversationHandoffEffect: async (_access, input) =>
        service.readConversationHandoffStatus(
          input.conversationId,
          input.idempotencyKey,
          authority,
          input.inputDigest,
        ),
      retireHandoffPredecessor: async (_access, id) =>
        service.retireHandoffPredecessor(id, authority),
      retireNativeReturnSource: async (_access, id) =>
        service.retireNativeReturnSource(id, authority),
      startSession: async (_access, input) => {
        const conversation = input.metadata?.conversationId;
        const environment = input.metadata?.environmentId;
        if (typeof conversation !== 'string' || typeof environment !== 'string')
          throw new Error('Foreground start omitted its identity.');
        const started = await service.startSessionInternal(
          { type: 'start-session', input },
          { userId: OWNER },
          {
            conversationIdentity: {
              conversationId: conversation,
              environmentId: environment,
            },
          },
        );
        if (started.status !== 'accepted') throw new Error(started.message);
        await vi.waitFor(() =>
          expect(continuityBinding(store, conversation)).not.toBeNull(),
        );
        return {
          commandId: started.receipt.commandId,
          sessionId: started.session.threadId,
        };
      },
      sendTurn: async (_access, input, context) => {
        const receipt = await service.dispatchWithReceipt(
          { type: 'sendTurn', input },
          { userId: OWNER },
          { submissionDigest: context?.submissionDigest },
        );
        if (!receipt.result || !('turnId' in receipt.result))
          throw new Error('No provider turn identity.');
        return { turnId: receipt.result.turnId };
      },
    };
    const idle = (conversationId: string) =>
      vi.waitFor(async () =>
        expect(
          (
            await service.readCurrentConversationSession(
              conversationId,
              authority,
            )
          )?.session.hasActiveTurn,
        ).toBe(false),
      );
    /** One completed turn on `engine`; resolves with the turn it answered. */
    const turn = async (
      agent: AgentName,
      conversationId: string,
      message: string,
      handoffKey?: string,
    ) => {
      const engine = engineOf(agent);
      const adapter = adapters.get(engine)!;
      const before = adapter.turns.length;
      await executeForegroundMessage(
        {
          target: { environment: { kind: 'current' }, agent: agentId(agent) },
          conversationId,
          message,
          userId: OWNER,
          ...(handoffKey
            ? { handoffIntent: createConversationHandoffIntent(handoffKey) }
            : {}),
        },
        deps,
      );
      await vi.waitFor(() => expect(adapter.turns.length).toBe(before + 1));
      await idle(conversationId);
      const sent = adapter.turns[before]!;
      return {
        sent,
        turnId: `${engine}-handoff-turn-${before + 1}`,
      };
    };
    const fork = (
      source: string,
      conversationId: string,
      target: AgentName,
      branchPointTurnId: string,
    ) =>
      routes.request(
        `/${source}/conversations/${encodeURIComponent(conversationId)}/fork`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            targetAgent: target,
            branchPointTurnId,
            idempotencyKey: `fork-to-${target}`,
          }),
        },
      );
    const forkedId = async (response: Response) => {
      expect(response.status, await response.clone().text()).toBe(200);
      const body = (await response.json()) as {
        data?: { conversationId?: unknown };
      };
      if (typeof body.data?.conversationId !== 'string')
        throw new Error('Fork did not return a Conversation identity.');
      return body.data.conversationId;
    };
    return { store, service, adapters, memory, turn, fork, forkedId };
  }

  type Harness = ReturnType<typeof harness>;

  /**
   * Three answered turns on the source; the fork branches at the second, so
   * the third is the later divergence a fork must not carry.
   */
  async function sourceConversation(
    h: Harness,
    source: Engine | 'station-file',
  ) {
    if (source === FILE_SOURCE) {
      const files = h.memory.get(FILE_AGENT)!;
      const id = 'matrix-file-source';
      await files.createConversation({
        id,
        resourceId: FILE_AGENT,
        userId: OWNER,
        title: 'Stored conversation',
        metadata: {},
      });
      await files.addMessages(
        [...BEFORE, AFTER].flatMap((text, index) => [
          {
            id: `file-user-${index}`,
            role: 'user' as const,
            parts: [{ type: 'text' as const, text }],
          },
          {
            id: `file-answer-${index}`,
            role: 'assistant' as const,
            parts: [{ type: 'text' as const, text: `Answer ${index}.` }],
            metadata: { turnId: `file-turn-${index}`, answerEligible: true },
          },
        ]),
        OWNER,
        id,
      );
      return { id, branchPointTurnId: 'file-turn-1' };
    }
    const id = `matrix-source-${source}`;
    await h.turn(source, id, BEFORE[0]);
    const branch = await h.turn(source, id, BEFORE[1]);
    await h.turn(source, id, AFTER);
    return { id, branchPointTurnId: branch.turnId };
  }

  // `station-agent` engines take history from Station memory, not a text
  // seed (`contextCarriage.history: 'station-memory'`); the fork test below
  // reads that memory, and a handoff into one is outside this harness.
  const SEED_TARGETS = ENGINES.filter((engine) => engine !== 'station-agent');
  const FORK_SOURCES = [FILE_SOURCE, ...ENGINES] as const;

  test.each(FORK_SOURCES)(
    'a fork from %s delivers the branch-point prefix, never the later divergence, to every engine',
    async (source) => {
      const h = harness();
      const { id, branchPointTurnId } = await sourceConversation(h, source);
      for (const target of SEED_TARGETS) {
        const forkId = await h.forkedId(
          await h.fork(source, id, target, branchPointTurnId),
        );
        const { sent } = await h.turn(
          target,
          forkId,
          `First fork turn on ${target}.`,
        );
        expect(sent.threadId, `${source}->${target}`).toBe(forkId);
        for (const text of BEFORE)
          expect(sent.ambientContext, `${source}->${target}`).toContain(text);
        expect(sent.ambientContext, `${source}->${target}`).not.toContain(
          AFTER,
        );
      }
    },
  );

  const HANDOFF_PAIRS = ENGINES.flatMap((source) =>
    SEED_TARGETS.filter((target) => target !== source).map(
      (target) => [source, target] as const,
    ),
  );

  test.each(HANDOFF_PAIRS)(
    'a handoff from %s to %s delivers the carried history on its first turn',
    async (source, target) => {
      const h = harness();
      const id = `matrix-handoff-${source}-${target}`;
      for (const text of BEFORE) await h.turn(source, id, text);
      const { sent } = await h.turn(
        target,
        id,
        `First turn on ${target}.`,
        `handoff-to-${target}`,
      );
      expect(sent.threadId).not.toBe(id);
      expect(h.store.conversationSessions(id).at(-1)?.sessionId).toBe(
        sent.threadId,
      );
      for (const text of BEFORE) expect(sent.ambientContext).toContain(text);
    },
  );

  test.each(FORK_SOURCES)(
    'a fork from %s to the Station agent saves the branch-point prefix as the memory it reads',
    async (source) => {
      const h = harness();
      const { id, branchPointTurnId } = await sourceConversation(h, source);
      const forkId = await h.forkedId(
        await h.fork(source, id, 'station-agent', branchPointTurnId),
      );
      const remembered = JSON.stringify(
        await h.memory
          .get(agentId('station-agent'))!
          .getMessages(OWNER, forkId),
      );
      for (const text of BEFORE) expect(remembered).toContain(text);
      expect(remembered).not.toContain(AFTER);
    },
  );

  test('a fork, continued with another engine, carries its copied history into that handoff', async () => {
    const h = harness();
    const { id, branchPointTurnId } = await sourceConversation(h, 'codex');
    const forkId = await h.forkedId(
      await h.fork('codex', id, 'acp', branchPointTurnId),
    );
    await h.turn('acp', forkId, 'First fork turn.');
    const { sent } = await h.turn(
      'opencode',
      forkId,
      'Continue elsewhere.',
      'fork-then-handoff',
    );
    for (const text of BEFORE) expect(sent.ambientContext).toContain(text);
    expect(sent.ambientContext).not.toContain(AFTER);
  });

  test('a fork of a fork that has run carries both generations of history', async () => {
    const h = harness();
    const { id, branchPointTurnId } = await sourceConversation(h, 'claude');
    const childId = await h.forkedId(
      await h.fork('claude', id, 'codex', branchPointTurnId),
    );
    const child = await h.turn('codex', childId, 'CHILD-TURN-4474');
    const grandchildId = await h.forkedId(
      await h.fork('codex', childId, 'muse', child.turnId),
    );
    const { sent } = await h.turn('muse', grandchildId, 'Grandchild turn.');
    for (const text of [...BEFORE, 'CHILD-TURN-4474'])
      expect(sent.ambientContext).toContain(text);
    expect(sent.ambientContext).not.toContain(AFTER);
  });

  /**
   * The reported conversation: about 40 tool-heavy, streamed Codex turns.
   * Each turn writes 66 events, so the conversation reader's own pages (at
   * most 150 events or about 56 KB each) number well over 16.
   */
  async function longToolHeavyConversation(
    h: Harness,
    shape: TerminalHandoffAdapter['turnShape'],
  ) {
    const codex = h.adapters.get('codex')!;
    codex.turnShape = shape;
    const id = 'matrix-long-codex';
    let branch = '';
    for (let index = 0; index < 40; index++) {
      const answered = await h.turn(
        'codex',
        id,
        index === 0
          ? 'EARLY-TURN-4475'
          : index === 38
            ? 'BRANCH-TURN-4476'
            : index === 39
              ? AFTER
              : `Turn ${index}.`,
      );
      if (index === 38) branch = answered.turnId;
    }
    codex.turnShape = { toolCalls: 0, toolOutputBytes: 0, deltas: 0 };
    return { id, branch };
  }

  test('a long, tool-heavy conversation forks at a late turn and the target receives that turn', async () => {
    const h = harness();
    const { id, branch } = await longToolHeavyConversation(h, {
      toolCalls: 30,
      toolOutputBytes: 600,
      deltas: 4,
    });
    // The pages the conversation reader itself serves for this history, as
    // the earlier all-or-nothing fork read paged them: more than its 16-page
    // ceiling, while under its event and byte ceilings.
    let pages = 0;
    let events = 0;
    let cursor: string | undefined;
    do {
      const window = await h.service.readConversationEventWindow(id, {
        turnLimit: 200,
        authority,
        ...(cursor ? { cursor } : {}),
      });
      if (!window) throw new Error('The source history is unreadable.');
      pages += 1;
      events += window.events?.length ?? 0;
      cursor = window.hasMore ? window.nextCursor : undefined;
    } while (cursor);
    expect(pages).toBeGreaterThan(16);
    expect(events).toBeLessThan(3_200);
    const response = await h.fork('codex', id, 'claude', branch);
    const forkId = await h.forkedId(response);
    const { sent } = await h.turn('claude', forkId, 'First fork turn.');
    expect(sent.ambientContext).toContain('BRANCH-TURN-4476');
    expect(sent.ambientContext).not.toContain(AFTER);
  });

  test('a fork whose copied tool output outgrows the saved-context bound keeps its text', async () => {
    const h = harness();
    // About 3 MB of tool output before the branch point: more than the
    // saved fork context holds whole, far less once only text is kept.
    const { id, branch } = await longToolHeavyConversation(h, {
      toolCalls: 8,
      toolOutputBytes: 10_000,
      deltas: 2,
    });
    const forkId = await h.forkedId(
      await h.fork('codex', id, 'claude', branch),
    );
    const { sent } = await h.turn('claude', forkId, 'First fork turn.');
    expect(sent.ambientContext).toContain('BRANCH-TURN-4476');
    expect(sent.ambientContext).not.toContain(AFTER);
  });

  test.each([STATION_AGENT, 'codex'] as const)(
    'a Station agent chat with its own stored record forks at a runtime turn (to %s)',
    async (target) => {
      const h = harness();
      const id = 'station:1795307294528';
      await h.turn(STATION_AGENT, id, BEFORE[0]);
      const branch = await h.turn(STATION_AGENT, id, BEFORE[1]);
      await h.turn(STATION_AGENT, id, AFTER);
      // The Station agent also stores the conversation under its runtime key,
      // as its own chat writes it: the same text, without the runtime turn
      // identities a branch point names.
      const stored = h.memory.get('default')!;
      await stored.createConversation({
        id,
        resourceId: 'default',
        userId: OWNER,
        title: 'Station agent chat',
        metadata: {},
      });
      await stored.addMessages(
        [...BEFORE, AFTER].flatMap((text, index) => [
          {
            id: `stored-user-${index}`,
            role: 'user' as const,
            parts: [{ type: 'text' as const, text }],
          },
          {
            id: `stored-answer-${index}`,
            role: 'assistant' as const,
            parts: [{ type: 'text' as const, text: `Answer ${index}.` }],
          },
        ]),
        OWNER,
        id,
      );
      const forkId = await h.forkedId(
        await h.fork(STATION_AGENT, id, target, branch.turnId),
      );
      if (target === STATION_AGENT) {
        // Its engine reads Station memory, not a text seed.
        const remembered = JSON.stringify(
          await stored.getMessages(OWNER, forkId),
        );
        for (const text of BEFORE) expect(remembered).toContain(text);
        expect(remembered).not.toContain(AFTER);
        return;
      }
      const { sent } = await h.turn(target, forkId, 'First fork turn.');
      for (const text of BEFORE) expect(sent.ambientContext).toContain(text);
      expect(sent.ambientContext).not.toContain(AFTER);
    },
  );

  test('every fork refusal names a stable code a client can act on', async () => {
    const h = harness();
    const { id } = await sourceConversation(h, 'codex');
    const refusal = async (response: Response) => ({
      status: response.status,
      body: (await response.json()) as { code?: unknown; error?: unknown },
    });
    const incomplete = await refusal(
      await h.fork('codex', id, 'claude', 'no-such-turn'),
    );
    expect(incomplete).toMatchObject({
      status: 409,
      body: { code: CONVERSATION_FORK_REFUSAL_CODES.turnIncomplete },
    });
    const wrongAgent = await refusal(
      await h.fork('claude', id, 'claude', 'codex-handoff-turn-2'),
    );
    expect(wrongAgent).toMatchObject({
      status: 409,
      body: { code: CONVERSATION_FORK_REFUSAL_CODES.sourceAgentMismatch },
    });
    const missing = await refusal(
      await h.fork('codex', 'matrix-absent', 'claude', 'codex-handoff-turn-2'),
    );
    expect(missing).toMatchObject({
      status: 404,
      body: { code: CONVERSATION_FORK_REFUSAL_CODES.sourceNotFound },
    });
    const first = await h.fork('codex', id, 'claude', 'codex-handoff-turn-2');
    expect(first.status).toBe(200);
    const reused = await refusal(
      await h.fork('codex', id, 'claude', 'codex-handoff-turn-1'),
    );
    expect(reused).toMatchObject({
      status: 409,
      body: { code: CONVERSATION_FORK_REFUSAL_CODES.idempotencyConflict },
    });
    for (const { body } of [incomplete, wrongAgent, missing, reused])
      expect(typeof body.error === 'string' && body.error.length > 0).toBe(
        true,
      );
  });
});
