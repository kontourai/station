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
 *
 * The connection is deliberately not named Cursor: any engine can send these
 * methods, and every label must name the engine that did.
 */

const makeTempDir = trackTempDirs();

const CONNECTIONS: ACPConnectionConfig[] = [
  {
    id: 'lab',
    name: 'Lab Engine',
    command: 'lab-agent',
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
      connectionId: 'lab',
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
    proc,
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

/** Answer an open form request as the orchestration service would. */
async function answerForm(
  session: Awaited<ReturnType<typeof startCursorSession>>,
  opened: RequestOpened,
  content: unknown,
): Promise<void> {
  const form = inputRequestFromRequestEvent(opened);
  if (!form) throw new Error('no form');
  await session.adapter.respondToRequest(
    session.threadId,
    opened.requestId,
    'accept',
    {
      inputContent: validateInputRequestContent(form, content),
      expectedRequestEventId: opened.eventId,
    },
  );
}

/** Lets in-flight wire traffic land before asserting something did not. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

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
      requester: 'Lab Engine',
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
    // Named so no session grant is offered on any surface.
    expect(toolRequestSessionGrantFromPayload(opened.payload)).toBe('none');
    await answerForm(session, opened, { q1: '1' });

    await expect(within(response)).resolves.toEqual({
      outcome: {
        outcome: 'answered',
        answers: [{ questionId: 'q1', selectedOptionIds: ['plan'] }],
      },
    });
    await session.stop();
  });

  test('a multi-select answer maps back to every chosen option id', async () => {
    const session = await startCursorSession();
    const response = session.agent.extMethod('cursor/ask_question', {
      ...ASK_QUESTION,
      questions: [{ ...ASK_QUESTION.questions[0], allowMultiple: true }],
    });
    const opened = await session.waitFor(isRequestOpened, 'request.opened');
    expect(inputRequestFromRequestEvent(opened)?.body.fields[0]).toMatchObject({
      kind: 'multi-choice',
    });
    await answerForm(session, opened, { q1: ['1', '0'] });
    await expect(within(response)).resolves.toEqual({
      outcome: {
        outcome: 'answered',
        answers: [{ questionId: 'q1', selectedOptionIds: ['plan', 'agent'] }],
      },
    });
    await session.stop();
  });

  test('a declined question answers skipped, not cancelled', async () => {
    const session = await startCursorSession();
    const response = session.agent.extMethod(
      'cursor/ask_question',
      ASK_QUESTION,
    );
    const opened = await session.waitFor(isRequestOpened, 'request.opened');
    await session.adapter.respondToRequest(
      session.threadId,
      opened.requestId,
      'decline',
      { expectedRequestEventId: opened.eventId },
    );
    await expect(within(response)).resolves.toEqual({
      outcome: { outcome: 'skipped', reason: 'The person declined to answer.' },
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
    const warning = session.events.find(
      (event) =>
        event.method === 'runtime.warning' &&
        event.code === 'acp.extension-request-unreadable',
    );
    expect(warning && 'message' in warning && warning.message).toMatch(
      /^Lab Engine asked a question/,
    );
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

  test('stopping the session answers an open question and plan cancelled', async () => {
    const session = await startCursorSession();
    const question = session.agent.extMethod(
      'cursor/ask_question',
      ASK_QUESTION,
    );
    const plan = session.agent.extMethod('cursor/create_plan', CREATE_PLAN);
    const deadline = Date.now() + 1000;
    while (
      session.events.filter(isRequestOpened).length < 2 &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 5));
    await session.adapter.stopSession(session.threadId);
    await expect(within(question)).resolves.toEqual({
      outcome: { outcome: 'cancelled' },
    });
    await expect(within(plan)).resolves.toEqual({
      outcome: { outcome: 'cancelled' },
    });
    expect(session.events.filter(isPlanUpdated)).toHaveLength(0);
    await session.stop();
  });

  test('an engine exit mid-turn answers an open question and plan cancelled', async () => {
    const session = await startCursorSession();
    await session.adapter.sendTurn({
      threadId: session.threadId,
      input: 'Plan it',
    });
    const question = session.agent.extMethod(
      'cursor/ask_question',
      ASK_QUESTION,
    );
    const plan = session.agent.extMethod('cursor/create_plan', CREATE_PLAN);
    const deadline = Date.now() + 1000;
    while (
      session.events.filter(isRequestOpened).length < 2 &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 5));
    // The engine dying fails its open `session/prompt`.
    session.proc?.rejectPrompt(new Error('engine exited'));
    await expect(within(question)).resolves.toEqual({
      outcome: { outcome: 'cancelled' },
    });
    await expect(within(plan)).resolves.toEqual({
      outcome: { outcome: 'cancelled' },
    });
    await session.stop();
  });

  test('a request that arrives while the session stops is cancelled, not opened', async () => {
    const session = await startCursorSession();
    await session.adapter.stopSession(session.threadId);
    const opened = session.events.filter(isRequestOpened).length;
    await expect(
      within(session.agent.extMethod('cursor/ask_question', ASK_QUESTION)),
    ).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
    await expect(
      within(session.agent.extMethod('cursor/create_plan', CREATE_PLAN)),
    ).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
    expect(session.events.filter(isRequestOpened)).toHaveLength(opened);
    await session.stop();
  });
});

describe('cursor/create_plan is a plan review', () => {
  test('the person reads the whole plan, and only an approved plan reaches the plan surface', async () => {
    const session = await startCursorSession();
    const response = session.agent.extMethod('cursor/create_plan', CREATE_PLAN);

    const opened = await session.waitFor(isRequestOpened, 'request.opened');
    expect(opened.title).toBe(
      'Lab Engine wants you to review a plan: Refactor tabs layout',
    );
    // A plan review is addressed to a person: no session grant is offered.
    expect(toolRequestSessionGrantFromPayload(opened.payload)).toBe('none');
    const form = inputRequestFromRequestEvent(opened);
    expect(form?.requester).toBe('Lab Engine');
    expect(form?.message).toContain(CREATE_PLAN.plan);
    expect(form?.message).toContain(CREATE_PLAN.overview);
    expect(form?.message).toContain(
      '- Update layout calculations (in progress)',
    );
    // Approving says what happens next: the engine stops (follow-up pending).
    expect(form?.body.fields[0]).toMatchObject({
      options: [
        {
          value: 'approve',
          description:
            "Station doesn't resume Lab Engine after approval; send a message to continue.",
        },
        { value: 'reject' },
      ],
    });
    // Proposed, not yet the session's plan.
    await settle();
    expect(session.events.filter(isPlanUpdated)).toHaveLength(0);

    await answerForm(session, opened, { review: 'approve' });
    await expect(within(response)).resolves.toEqual({
      outcome: { outcome: 'accepted' },
    });
    const plan = await session.waitFor(isPlanUpdated, 'plan.updated');
    expect(plan.entries).toEqual([
      { content: 'Inspect current tab sizing logic', status: 'completed' },
      { content: 'Update layout calculations', status: 'in_progress' },
      { content: 'Verify editor behavior', status: 'pending' },
    ]);
    await session.stop();
  });

  test.each([
    ['choosing Reject', 'reject'],
    ['declining the form', undefined],
  ])(
    '%s answers rejected and leaves the plan surface alone',
    async (_label, choice) => {
      const session = await startCursorSession();
      const response = session.agent.extMethod(
        'cursor/create_plan',
        CREATE_PLAN,
      );
      const opened = await session.waitFor(isRequestOpened, 'request.opened');
      if (choice) await answerForm(session, opened, { review: choice });
      else
        await session.adapter.respondToRequest(
          session.threadId,
          opened.requestId,
          'decline',
          { expectedRequestEventId: opened.eventId },
        );
      await expect(within(response)).resolves.toEqual({
        outcome: {
          outcome: 'rejected',
          reason: 'The person rejected the plan.',
        },
      });
      await settle();
      expect(session.events.filter(isPlanUpdated)).toHaveLength(0);
      await session.stop();
    },
  );

  test('an ordinary long plan reaches the person, its todos counted rather than listed', async () => {
    // 6000 characters of plan and 40 todos overflow one form message
    // together; that is no reason to refuse a plan a person could review.
    const session = await startCursorSession();
    const todos = Array.from({ length: 40 }, (_, index) => ({
      id: `t${index}`,
      content: `Step ${index} of the migration, with enough words to matter`,
      status: 'pending',
    }));
    const plan = 'p'.repeat(6000);
    const response = session.agent.extMethod('cursor/create_plan', {
      ...CREATE_PLAN,
      plan,
      todos,
    });
    const opened = await session.waitFor(isRequestOpened, 'request.opened');
    const message = inputRequestFromRequestEvent(opened)?.message ?? '';
    expect(message).toContain(plan);
    expect(message).toContain('40 todos, shown on the plan once approved.');
    expect(message).not.toContain('Step 0 of the migration');
    await answerForm(session, opened, { review: 'approve' });
    await expect(within(response)).resolves.toEqual({
      outcome: { outcome: 'accepted' },
    });
    const planned = await session.waitFor(isPlanUpdated, 'plan.updated');
    expect(planned.entries).toHaveLength(40);
    await session.stop();
  });

  test('a plan too long to show whole is cut with a note, never refused', async () => {
    const session = await startCursorSession();
    const plan = `${'q'.repeat(7990)}TAIL`;
    void session.agent.extMethod('cursor/create_plan', {
      ...CREATE_PLAN,
      plan,
    });
    const opened = await session.waitFor(isRequestOpened, 'request.opened');
    const message = inputRequestFromRequestEvent(opened)?.message ?? '';
    expect(message.length).toBeLessThanOrEqual(8000);
    expect(message).not.toContain('TAIL');
    expect(message).toMatch(
      /\[Plan truncated for display: \d+ more characters\.\]/,
    );
    await session.stop();
  });

  test('an approval that lands as the session stops plans nothing', async () => {
    const session = await startCursorSession();
    void session.agent.extMethod('cursor/create_plan', CREATE_PLAN);
    const opened = await session.waitFor(isRequestOpened, 'request.opened');
    const form = inputRequestFromRequestEvent(opened);
    if (!form) throw new Error('no form');
    // The answer resolves the request synchronously; the stop lands before
    // the plan handler resumes.
    const answered = session.adapter.respondToRequest(
      session.threadId,
      opened.requestId,
      'accept',
      {
        inputContent: validateInputRequestContent(form, { review: 'approve' }),
        expectedRequestEventId: opened.eventId,
      },
    );
    const stopped = session.adapter.stopSession(session.threadId);
    await answered;
    await stopped;
    await settle();
    expect(session.events.filter(isPlanUpdated)).toHaveLength(0);
    await session.stop();
  });

  test("phases' todos are shown and planned under their phase name", async () => {
    const session = await startCursorSession();
    const response = session.agent.extMethod('cursor/create_plan', {
      ...CREATE_PLAN,
      todos: [CREATE_PLAN.todos[0]],
      phases: [
        {
          name: 'Build',
          todos: [
            { id: 'todo-4', content: 'Write the layout', status: 'pending' },
          ],
        },
      ],
    });
    const opened = await session.waitFor(isRequestOpened, 'request.opened');
    expect(inputRequestFromRequestEvent(opened)?.message).toContain(
      '- Build: Write the layout (to do)',
    );
    await answerForm(session, opened, { review: 'approve' });
    await within(response);
    const plan = await session.waitFor(isPlanUpdated, 'plan.updated');
    expect(plan.entries).toEqual([
      { content: 'Inspect current tab sizing logic', status: 'completed' },
      { content: 'Build: Write the layout', status: 'pending' },
    ]);
    await session.stop();
  });

  test('a later update_todos merges onto the approved plan', async () => {
    const session = await startCursorSession();
    const response = session.agent.extMethod('cursor/create_plan', CREATE_PLAN);
    const opened = await session.waitFor(isRequestOpened, 'request.opened');
    await answerForm(session, opened, { review: 'approve' });
    await within(response);
    await session.waitFor(isPlanUpdated, 'plan.updated');

    await session.agent.extNotification('cursor/update_todos', {
      toolCallId: 'call_125',
      todos: [
        {
          id: 'todo-2',
          content: 'Update layout calculations',
          status: 'completed',
        },
        { id: 'todo-4', content: 'Ship it', status: 'pending' },
      ],
      merge: true,
    });
    const deadline = Date.now() + 1000;
    while (
      session.events.filter(isPlanUpdated).length < 2 &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect(session.events.filter(isPlanUpdated)[1]?.entries).toEqual([
      { content: 'Inspect current tab sizing logic', status: 'completed' },
      { content: 'Update layout calculations', status: 'completed' },
      { content: 'Verify editor behavior', status: 'pending' },
      { content: 'Ship it', status: 'pending' },
    ]);
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
    await settle();
    expect(session.events.filter(isPlanUpdated)).toHaveLength(0);
    await session.stop();
  });

  test('a plan past the payload bound is refused, not shown cut', async () => {
    // The plan text has no bound of its own: only the payload bound holds it.
    const session = await startCursorSession();
    const oversized = {
      ...CREATE_PLAN,
      plan: 'x'.repeat(CURSOR_PAYLOAD_MAX_JSON_CHARS),
    };
    await expect(
      within(session.agent.extMethod('cursor/create_plan', oversized)),
    ).resolves.toEqual({
      outcome: {
        outcome: 'rejected',
        reason: 'The client could not show this plan.',
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
