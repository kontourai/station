import {
  AgentSideConnection,
  ClientSideConnection,
  ndJsonStream,
} from '@agentclientprotocol/sdk';
import type { ACPConnectionConfig } from '@kontourai/station-contracts/acp';
import {
  inputRequestFromRequestEvent,
  validateInputRequestContent,
} from '@kontourai/station-shared/input-request';
import { toolRequestSessionGrantFromPayload } from '@kontourai/station-shared/tool-request-preview';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import type { ACPProcess } from '../../services/acp/acp-process.js';
import type { CanonicalRuntimeEvent } from '../adapter-shape.js';
import { AcpAdapter } from '../adapters/acp-adapter.js';
import { CURSOR_PAYLOAD_MAX_JSON_CHARS } from '../adapters/acp-cursor-extensions.js';
import { FakeAcpProcess } from './fake-acp-process.js';

/**
 * Cursor's agent→client extensions (cursor.com/docs/cli/acp, fetched
 * 2026-10-21), driven through the real AcpAdapter: the adapter's own Client
 * (built for a FakeAcpProcess session) serves a real `ClientSideConnection`,
 * and a real `AgentSideConnection` sends the documented request and
 * notification shapes over ndjson. So each test also proves the ACP SDK
 * routes Cursor's non-underscore method names to the adapter.
 */

const makeTempDir = trackTempDirs();

const CONNECTIONS: ACPConnectionConfig[] = [
  {
    id: 'cursor',
    name: 'Cursor',
    command: 'cursor-agent',
    args: ['acp'],
    enabled: true,
  },
];

/** The documented `cursor/ask_question` example, verbatim. */
const ASK_QUESTION = {
  toolCallId: 'call_123',
  title: 'Need input',
  questions: [
    {
      id: 'q1',
      prompt: 'Which mode should I use?',
      options: [
        { id: 'agent', label: 'Agent' },
        { id: 'plan', label: 'Plan' },
      ],
      allowMultiple: false,
    },
  ],
};

/** The documented `cursor/create_plan` example, verbatim. */
const CREATE_PLAN = {
  toolCallId: 'call_124',
  name: 'Refactor tabs layout',
  overview: 'Tighten layout behavior and preserve existing UX.',
  plan: '1. Inspect current tab sizing logic.\n2. Update layout calculations.\n3. Verify editor behavior.',
  todos: [
    {
      id: 'todo-1',
      content: 'Inspect current tab sizing logic',
      status: 'completed',
    },
    {
      id: 'todo-2',
      content: 'Update layout calculations',
      status: 'in_progress',
    },
    { id: 'todo-3', content: 'Verify editor behavior', status: 'pending' },
  ],
  isProject: false,
};

/** The documented `cursor/update_todos` example, verbatim. */
const UPDATE_TODOS = {
  toolCallId: 'call_125',
  todos: [
    { id: '1', content: 'Set up project structure', status: 'completed' },
    { id: '2', content: 'Add authentication', status: 'in_progress' },
    { id: '3', content: 'Write unit tests', status: 'pending' },
  ],
  merge: true,
};

const UNATTENDED_DELEGATION = {
  mode: 'isolated-child',
  depth: 1,
  maxDepth: 2,
  parentAgentSlug: 'parent',
  rootAgentSlug: 'parent',
  denyApprovals: true,
};

async function startCursorSession(options: { unattended?: boolean } = {}) {
  let proc: FakeAcpProcess | undefined;
  const adapter = new AcpAdapter({
    getConnections: async () => CONNECTIONS,
    logger: {
      debug: () => {},
      warn: () => {},
      error: () => {},
      info: () => {},
    },
    managedWorkspaceHomeDir: makeTempDir('station-acp-cursor-ext-test-'),
    processFactory: (opts) => {
      proc = new FakeAcpProcess(opts);
      return proc as unknown as ACPProcess;
    },
  });
  const events: CanonicalRuntimeEvent[] = [];
  const drained = (async () => {
    for await (const event of adapter.streamEvents()) events.push(event);
  })();
  const threadId = `cursor-ext-${crypto.randomUUID()}`;
  await adapter.startSession({
    provider: 'acp',
    threadId,
    cwd: '/tmp/project',
    metadata: {
      connectionId: 'cursor',
      ...(options.unattended ? { delegation: UNATTENDED_DELEGATION } : {}),
    },
  });
  if (!proc?.client) throw new Error('adapter did not build a Client');
  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
  const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
  const client = proc.client;
  new ClientSideConnection(
    () => client,
    ndJsonStream(clientToAgent.writable, agentToClient.readable),
  );
  const agent = new AgentSideConnection(
    () => ({}) as never,
    ndJsonStream(agentToClient.writable, clientToAgent.readable),
  );

  async function waitFor<T extends CanonicalRuntimeEvent>(
    predicate: (event: CanonicalRuntimeEvent) => event is T,
    label: string,
  ): Promise<T> {
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      const found = events.find(predicate);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`Timed out waiting for ${label}`);
  }

  return {
    adapter,
    agent,
    events,
    threadId,
    waitFor,
    stop: async () => {
      await adapter.stopAll();
      await drained;
    },
  };
}

type RequestOpened = Extract<
  CanonicalRuntimeEvent,
  { method: 'request.opened' }
>;
type PlanUpdated = Extract<CanonicalRuntimeEvent, { method: 'plan.updated' }>;
const isRequestOpened = (
  event: CanonicalRuntimeEvent,
): event is RequestOpened => event.method === 'request.opened';
const isPlanUpdated = (event: CanonicalRuntimeEvent): event is PlanUpdated =>
  event.method === 'plan.updated';

/** Settles within `ms` or reports that it did not: a hang is a failure. */
function within<T>(promise: Promise<T>, ms = 1000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`no response within ${ms}ms`)), ms),
    ),
  ]);
}

describe('cursor/ask_question reaches the harness-question contract', () => {
  test("the person's answer goes back as the documented response", async () => {
    const session = await startCursorSession();
    const response = session.agent.extMethod(
      'cursor/ask_question',
      ASK_QUESTION,
    );

    const opened = await session.waitFor(isRequestOpened, 'request.opened');
    // The form every surface reads from a request event (#3390).
    const form = inputRequestFromRequestEvent(opened);
    expect(form).toMatchObject({
      source: 'harness:cursor',
      requester: 'Cursor',
      message: 'Need input',
      body: {
        fields: [
          {
            name: 'q1',
            kind: 'choice',
            title: 'Which mode should I use?',
            options: [
              { value: '0', label: 'Agent' },
              { value: '1', label: 'Plan' },
            ],
          },
        ],
      },
    });
    if (!form) throw new Error('no form');
    // What the orchestration service validates before handing it over.
    const inputContent = validateInputRequestContent(form, { q1: '1' });

    await session.adapter.respondToRequest(
      session.threadId,
      opened.requestId,
      'accept',
      { inputContent, expectedRequestEventId: opened.eventId },
    );

    await expect(within(response)).resolves.toEqual({
      outcome: {
        outcome: 'answered',
        answers: [{ questionId: 'q1', selectedOptionIds: ['plan'] }],
      },
    });
    await session.stop();
  });

  test('an answer that names another request event is refused', async () => {
    const session = await startCursorSession();
    void session.agent.extMethod('cursor/ask_question', ASK_QUESTION);
    const opened = await session.waitFor(isRequestOpened, 'request.opened');
    await expect(
      session.adapter.respondToRequest(
        session.threadId,
        opened.requestId,
        'accept',
        { inputContent: { q1: '0' }, expectedRequestEventId: 'stale' },
      ),
    ).rejects.toThrow('Inspect this question before answering it.');
    await session.stop();
  });

  test('an unattended session is answered skipped at once, not left to hang', async () => {
    const session = await startCursorSession({ unattended: true });
    await expect(
      within(session.agent.extMethod('cursor/ask_question', ASK_QUESTION)),
    ).resolves.toEqual({
      outcome: {
        outcome: 'skipped',
        reason: 'No one is present to answer this question.',
      },
    });
    expect(session.events.filter(isRequestOpened)).toHaveLength(0);
    await session.stop();
  });

  test('an oversized question is refused with the documented skip, and the person is told', async () => {
    const session = await startCursorSession();
    const oversized = {
      ...ASK_QUESTION,
      questions: [
        {
          ...ASK_QUESTION.questions[0],
          options: [
            ...ASK_QUESTION.questions[0].options,
            {
              id: 'huge',
              label: 'x'.repeat(CURSOR_PAYLOAD_MAX_JSON_CHARS),
            },
          ],
        },
      ],
    };
    await expect(
      within(session.agent.extMethod('cursor/ask_question', oversized)),
    ).resolves.toEqual({
      outcome: {
        outcome: 'skipped',
        reason: 'The client could not show this question.',
      },
    });
    expect(session.events.filter(isRequestOpened)).toHaveLength(0);
    expect(
      session.events.some(
        (event) =>
          event.method === 'runtime.warning' &&
          event.code === 'acp.extension-request-unreadable',
      ),
    ).toBe(true);
    await session.stop();
  });

  test('a question past the option-count bound is refused', async () => {
    const session = await startCursorSession();
    const tooMany = {
      ...ASK_QUESTION,
      questions: [
        {
          ...ASK_QUESTION.questions[0],
          options: Array.from({ length: 33 }, (_, index) => ({
            id: `o${index}`,
            label: `Option ${index}`,
          })),
        },
      ],
    };
    await expect(
      within(session.agent.extMethod('cursor/ask_question', tooMany)),
    ).resolves.toMatchObject({ outcome: { outcome: 'skipped' } });
    expect(session.events.filter(isRequestOpened)).toHaveLength(0);
    await session.stop();
  });

  test('an interrupted turn answers an open question cancelled', async () => {
    const session = await startCursorSession();
    await session.adapter.sendTurn({
      threadId: session.threadId,
      input: 'Plan it',
    });
    const response = session.agent.extMethod(
      'cursor/ask_question',
      ASK_QUESTION,
    );
    await session.waitFor(isRequestOpened, 'request.opened');
    await session.adapter.interruptTurn(session.threadId);
    await expect(within(response)).resolves.toEqual({
      outcome: { outcome: 'cancelled' },
    });
    await session.stop();
  });
});

describe('cursor/create_plan is a plan review', () => {
  test('todos reach the plan surface and an accepted review answers accepted', async () => {
    const session = await startCursorSession();
    const response = session.agent.extMethod('cursor/create_plan', CREATE_PLAN);

    const plan = await session.waitFor(isPlanUpdated, 'plan.updated');
    expect(plan.entries).toEqual([
      { content: 'Inspect current tab sizing logic', status: 'completed' },
      { content: 'Update layout calculations', status: 'in_progress' },
      { content: 'Verify editor behavior', status: 'pending' },
    ]);
    const opened = await session.waitFor(isRequestOpened, 'request.opened');
    expect(opened.title).toBe("Review Cursor's plan: Refactor tabs layout");
    // A plan review is addressed to a person: no session grant is offered.
    expect(toolRequestSessionGrantFromPayload(opened.payload)).toBe('none');

    // A session answer is a one-call accept here.
    await session.adapter.respondToRequest(
      session.threadId,
      opened.requestId,
      'acceptForSession',
    );
    await expect(within(response)).resolves.toEqual({
      outcome: { outcome: 'accepted' },
    });
    await session.stop();
  });

  test('a declined review answers rejected', async () => {
    const session = await startCursorSession();
    const response = session.agent.extMethod('cursor/create_plan', CREATE_PLAN);
    const opened = await session.waitFor(isRequestOpened, 'request.opened');
    await session.adapter.respondToRequest(
      session.threadId,
      opened.requestId,
      'decline',
    );
    await expect(within(response)).resolves.toEqual({
      outcome: { outcome: 'rejected', reason: 'The person rejected the plan.' },
    });
    await session.stop();
  });

  test('an unattended session answers rejected at once, never accepted', async () => {
    const session = await startCursorSession({ unattended: true });
    await expect(
      within(session.agent.extMethod('cursor/create_plan', CREATE_PLAN)),
    ).resolves.toEqual({
      outcome: {
        outcome: 'rejected',
        reason: 'No one is present to review this plan.',
      },
    });
    expect(session.events.filter(isRequestOpened)).toHaveLength(0);
    await session.stop();
  });

  test('a plan past the todo bound is refused', async () => {
    const session = await startCursorSession();
    const tooMany = {
      ...CREATE_PLAN,
      todos: Array.from({ length: 201 }, (_, index) => ({
        id: `t${index}`,
        content: `Step ${index}`,
        status: 'pending',
      })),
    };
    await expect(
      within(session.agent.extMethod('cursor/create_plan', tooMany)),
    ).resolves.toEqual({
      outcome: {
        outcome: 'rejected',
        reason: 'The client could not show this plan.',
      },
    });
    expect(session.events.filter(isRequestOpened)).toHaveLength(0);
    expect(session.events.filter(isPlanUpdated)).toHaveLength(0);
    await session.stop();
  });
});

describe('cursor/update_todos reaches the plan surface', () => {
  test('a merge folds into the plan by todo id', async () => {
    const session = await startCursorSession();
    await session.agent.extNotification('cursor/update_todos', UPDATE_TODOS);
    const first = await session.waitFor(isPlanUpdated, 'plan.updated');
    expect(first.entries).toEqual([
      { content: 'Set up project structure', status: 'completed' },
      { content: 'Add authentication', status: 'in_progress' },
      { content: 'Write unit tests', status: 'pending' },
    ]);

    await session.agent.extNotification('cursor/update_todos', {
      toolCallId: 'call_126',
      todos: [
        { id: '2', content: 'Add authentication', status: 'completed' },
        { id: '3', content: 'Write unit tests', status: 'cancelled' },
      ],
      merge: true,
    });
    const deadline = Date.now() + 1000;
    while (
      session.events.filter(isPlanUpdated).length < 2 &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 5));
    const second = session.events.filter(isPlanUpdated)[1];
    // A cancelled todo leaves the plan; the plan surface has no such state.
    expect(second?.entries).toEqual([
      { content: 'Set up project structure', status: 'completed' },
      { content: 'Add authentication', status: 'completed' },
    ]);
    await session.stop();
  });
});

describe('every other cursor/* request is still refused', () => {
  test('an undocumented cursor/* request gets -32601', async () => {
    const session = await startCursorSession();
    await expect(
      within(session.agent.extMethod('cursor/update_todos', UPDATE_TODOS)),
    ).rejects.toMatchObject({ code: -32601 });
    await expect(
      within(session.agent.extMethod('cursor/ask_questions', ASK_QUESTION)),
    ).rejects.toMatchObject({ code: -32601 });
    await session.stop();
  });
});
