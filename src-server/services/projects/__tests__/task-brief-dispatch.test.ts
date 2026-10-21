/**
 * Epic #4003: a Session dispatched for a Task receives the Task brief with its
 * first turn, on every engine.
 *
 * The real seams: the TaskGraph dispatcher (`composeTaskDispatcher`) builds
 * the brief through the shared runtime composition (`composeTaskBriefSource`)
 * and starts the Session through the real OrchestrationService and SQLite
 * EventStore. The engine is a recording adapter that publishes
 * `session.started` with the start metadata, exactly as the real Claude,
 * Codex and Station adapters do. What is asserted is the input the engine
 * adapter is actually handed for the first turn.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { engineId } from '@kontourai/station-contracts/agent-identity';
import { TASK_BRIEF_COMPOSED_METADATA_KEY } from '@kontourai/station-contracts/provider';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import type { TaskRecordWrite } from '@kontourai/station-contracts/task-memory';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type {
  ProviderAdapterShape,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
} from '../../../providers/adapter-shape.js';
import type { IProviderAdapterRegistry } from '../../../providers/provider-interfaces.js';
import { AsyncEventQueue } from '../../../providers/sessions/async-event-queue.js';
import { EventBus } from '../../orchestration/event-bus.js';
import { EventStore } from '../../orchestration/event-store.js';
import { OrchestrationService } from '../../orchestration/orchestration-service.js';
import type { WorkItemObserver } from '../../work-item-providers/github-work-item-observer.js';
import { composeTaskBriefSource } from '../task-brief-source.js';
import { composeTaskDispatcher } from '../task-dispatch-composition.js';
import { TaskGraphService } from '../task-graph-service.js';

type EngineProvider = 'claude' | 'codex' | 'station-agent';

/** Publishes what real adapters publish: `session.started` with the start metadata. */
class RecordingAdapter implements ProviderAdapterShape {
  readonly events = new AsyncEventQueue<CanonicalRuntimeEvent>();
  readonly sessions = new Map<string, ProviderSession>();
  readonly metadata: ProviderAdapterShape['metadata'];
  readonly startSession = vi.fn(async (input: ProviderSessionStartInput) => {
    const now = new Date().toISOString();
    this.events.push({
      eventId: `evt-${input.threadId}-started`,
      provider: this.provider,
      threadId: input.threadId,
      sessionId: input.threadId,
      createdAt: now,
      method: 'session.started',
      initialState: 'created',
      metadata: { ...input.metadata },
    } as CanonicalRuntimeEvent);
    const session: ProviderSession = {
      provider: this.provider,
      threadId: input.threadId,
      status: 'ready',
      cwd: input.cwd,
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(input.threadId, session);
    return session;
  });
  private turns = 0;
  readonly sendTurn = vi.fn(async (input: ProviderSendTurnInput) => {
    this.turns += 1;
    const turnId = `${this.provider}-turn-${this.turns}`;
    this.events.push({
      eventId: `evt-${input.threadId}-${turnId}`,
      provider: this.provider,
      threadId: input.threadId,
      turnId,
      createdAt: new Date().toISOString(),
      method: 'turn.started',
      prompt: input.displayInput ?? input.input,
    } as CanonicalRuntimeEvent);
    return { threadId: input.threadId, turnId };
  });

  constructor(readonly provider: EngineProvider) {
    this.metadata = {
      displayName: provider,
      description: `${provider} recording adapter`,
      capabilities: ['agent-runtime'],
      engineId: engineId(provider === 'station-agent' ? 'station' : provider),
      builtin: true,
      modelLaunch: {
        defaultAtStart: 'engine-selected',
        omissionAtResume: 'engine-selected',
        omissionPerTurn: 'engine-selected',
        overrideAtStart: true,
        overrideAtResume: true,
        overridePerTurn: true,
      },
    };
  }
  async interruptTurn() {
    return { outcome: 'no-active-turn' as const };
  }
  async respondToRequest() {}
  async stopSession(threadId: string) {
    this.sessions.delete(threadId);
  }
  async listSessions() {
    return [...this.sessions.values()];
  }
  async hasSession(threadId: string) {
    return this.sessions.has(threadId);
  }
  async stopAll() {
    this.sessions.clear();
  }
  streamEvents(options?: { signal?: AbortSignal }) {
    return this.events.iterable(options);
  }
  async getPrerequisites() {
    return [];
  }
}

async function waitFor(check: () => boolean, timeoutMs = 2000) {
  const startedAt = Date.now();
  while (!check()) {
    if (Date.now() - startedAt > timeoutMs)
      throw new Error('Timed out waiting for test condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The Task document is the person-authored brief only. */
const DOCUMENT = [
  '# Ship the brief',
  'Seeded from the issue: make dispatched Sessions start with context.',
].join('\n');

/** Task memory, written to the real store before dispatch. */
const SUMMARY = 'Parser landed. Next: wire the route.';
const MEMORY: TaskRecordWrite[] = [
  {
    kind: 'decision',
    key: 'first-turn',
    text: 'Use the first-turn channel on every engine.',
  },
  {
    kind: 'question',
    key: 'tracker-reread',
    text: 'Should get_task_brief re-read the tracker?',
  },
];

describe('Task dispatch delivers the Task brief with the first turn', () => {
  let tmp: string;
  let eventStore: EventStore;
  let adapters: RecordingAdapter[];
  let service: OrchestrationService;
  let graph: TaskGraphService;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'task-brief-dispatch-'));
    eventStore = new EventStore(join(tmp, 'orchestration.sqlite'));
    adapters = (['claude', 'codex', 'station-agent'] as const).map(
      (provider) => new RecordingAdapter(provider),
    );
    const registry: IProviderAdapterRegistry = {
      register() {},
      get: (provider) => adapters.find((a) => a.provider === provider),
      list: () => adapters,
    };
    service = new OrchestrationService({
      adapterRegistry: registry,
      eventBus: new EventBus(),
      eventStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    const root = join(tmp, 'graph');
    mkdirSync(root, { recursive: true });
    graph = new TaskGraphService(root, {
      projectService: {
        getProject: (slug) => ({
          id: slug,
          slug,
          name: slug,
          workingDirectory: tmp,
          createdAt: '2026-10-20T00:00:00.000Z',
          updatedAt: '2026-10-20T00:00:00.000Z',
        }),
      },
    });
  });

  afterEach(async () => {
    await service.shutdown();
    eventStore.close?.();
    rmSync(tmp, { recursive: true, force: true });
  });

  async function dispatch(
    provider: EngineProvider,
    options: {
      workItemRef?: string;
      observeWorkItem?: WorkItemObserver['observeWorkItem'];
      document?: string;
      memory?: TaskRecordWrite[];
      /** Dispatch this existing Task again instead of creating one. */
      taskId?: string;
    } = {},
  ) {
    const task = options.taskId
      ? graph.readTaskView(options.taskId)!
      : await graph.createTask({
          projectId: 'brief-project',
          title: 'Ship the Task brief',
          description: 'Dispatched Sessions start with the Task memory.',
          ...(options.workItemRef
            ? { sourceProvider: 'github', workItemRef: options.workItemRef }
            : {}),
        });
    if (!options.taskId) {
      const write = {
        projectId: task.projectId,
        taskId: task.id,
        taskCreatedAt: task.createdAt,
        author: { kind: 'session', sessionId: 'session-a' } as const,
      };
      if (!options.memory)
        expect(
          eventStore
            .taskMemoryStore()
            .updateSummary({ ...write, text: SUMMARY, baseRevision: 0 }).kind,
        ).toBe('updated');
      for (const record of options.memory ?? MEMORY)
        expect(
          eventStore.taskMemoryStore().writeRecord({ ...write, write: record })
            .kind,
        ).toBe('recorded');
    }
    const dispatcher = composeTaskDispatcher(graph, {
      orchestrationService: service,
      // A namespaced workItemRef routes through dispatch-as-claim; stub the
      // claim so these tests observe the brief, not the claim gate.
      resolveProjectWorkspace: () => tmp,
      assignmentClaimService: {
        claim: vi.fn().mockResolvedValue({
          outcome: 'claimed',
          record: { claimed_at: '2026-10-20T00:00:00.000Z' },
        }),
        release: vi.fn(),
        status: vi.fn(),
      } as never,
      taskBrief: composeTaskBriefSource({
        taskGraph: graph,
        eventStore,
        roomRuntime: () => ({
          readTaskDocumentForBrief: async () => ({
            kind: 'available',
            revision: 'rev-7',
            text: options.document ?? DOCUMENT,
          }),
        }),
        workItemObserver: {
          observeWorkItem:
            options.observeWorkItem ??
            (async () => {
              throw new Error(
                'this dispatch was not expected to read the tracker',
              );
            }),
        },
      }),
    });
    const outcome = await dispatcher.dispatch(task.id, {
      ownerUserId: 'human:local:operator',
      fullAccessGrant: null,
      runtimeConfig: { provider, cwd: tmp },
    });
    expect(outcome).toMatchObject({ kind: 'dispatched' });
    const sessionId = graph.readTaskView(task.id)!.sessionId!;
    await waitFor(() =>
      eventStore
        .listEvents(sessionId)
        .some((event) => event.method === 'session.started'),
    );
    return { task, sessionId };
  }

  test.each(['claude', 'codex', 'station-agent'] as const)(
    '%s: the first turn the engine receives carries the brief, once',
    async (provider) => {
      const { task, sessionId } = await dispatch(provider);
      const adapter = adapters.find((a) => a.provider === provider)!;

      await service.dispatch({
        type: 'sendTurn',
        input: { threadId: sessionId, input: 'Start on the route.' },
      });
      const first = adapter.sendTurn.mock.calls[0]![0];
      // The engine reads `input`; the Station engine's relay forwards
      // `ambientContext` beside the typed text.
      expect(first.input).toContain('# Station Task brief');
      expect(first.input).toContain(`Task id: ${task.id}`);
      expect(first.input).toContain('Task document revision: rev-7');
      // Memory comes from the store; the document is shown as written.
      expect(first.input).toContain(
        `## Task summary (revision 1, by session session-a at `,
      );
      expect(first.input).toContain(`\n${SUMMARY}\n`);
      expect(first.input).toContain(
        '## Standing decisions (newest first)\n- `first-turn`: Use the first-turn channel on every engine.',
      );
      expect(first.input).toContain(
        '- `tracker-reread`: Should get_task_brief re-read the tracker? (asked by session session-a)',
      );
      expect(first.input).toContain(
        '## Task document\n# Ship the brief\nSeeded from the issue',
      );
      expect(first.input).toContain('`task_summary_update`');
      expect(first.input).toContain('`task_record`');
      expect(first.input.endsWith('Start on the route.')).toBe(true);
      expect(first.ambientContext).toContain('# Station Task brief');
      // The transcript keeps the typed text only.
      expect(first.displayInput).toBe('Start on the route.');
      expect(first.metadata?.[TASK_BRIEF_COMPOSED_METADATA_KEY]).toMatch(
        /^[0-9a-f]{64}$/,
      );

      await waitFor(() =>
        eventStore
          .listEvents(sessionId)
          .some((event) => event.method === 'turn.started'),
      );
      await service.dispatch({
        type: 'sendTurn',
        input: { threadId: sessionId, input: 'Next step.' },
      });
      const second = adapter.sendTurn.mock.calls[1]![0];
      expect(second.input).toBe('Next step.');
      expect(
        second.metadata?.[TASK_BRIEF_COMPOSED_METADATA_KEY],
      ).toBeUndefined();
    },
  );

  test('a tracker read that does not observe the item is one line, and never fails the dispatch', async () => {
    const observe = vi.fn<WorkItemObserver['observeWorkItem']>(async () => ({
      status: 'unauthenticated',
      reason: 'gh is not signed in',
    }));
    const { task, sessionId } = await dispatch('codex', {
      workItemRef: 'github:owner/repo#12',
      observeWorkItem: observe,
    });
    expect(observe).toHaveBeenCalledWith('github:owner/repo#12', {
      commentsSince: task.createdAt,
    });
    // An unobserved read never advances the Task's "comments since" mark.
    expect(graph.readTaskView(task.id)!.workItemObservedAt).toBeUndefined();
    await service.dispatch({
      type: 'sendTurn',
      input: { threadId: sessionId, input: 'Go.' },
    });
    const input = adapters.find((a) => a.provider === 'codex')!.sendTurn.mock
      .calls[0]![0].input;
    expect(input).toContain(
      'linked item not re-read: unauthenticated (gh is not signed in)',
    );
    expect(input).toContain('## Tracker guidance');
  });

  test('a tracker read that throws still dispatches, and says the item was not re-read', async () => {
    const { sessionId } = await dispatch('claude', {
      workItemRef: 'github:owner/repo#13',
      observeWorkItem: async () => {
        throw new Error('network down');
      },
    });
    await service.dispatch({
      type: 'sendTurn',
      input: { threadId: sessionId, input: 'Go.' },
    });
    expect(
      adapters.find((a) => a.provider === 'claude')!.sendTurn.mock.calls[0]![0]
        .input,
    ).toContain('linked item not re-read: not-read (the tracker read failed)');
  });

  test('an observed read advances workItemObservedAt at dispatch, and the next dispatch asks for comments since it', async () => {
    const ref = 'github:owner/repo#14';
    const observedAt = '2026-10-21T09:30:00.000Z';
    const observe = vi.fn<WorkItemObserver['observeWorkItem']>(async () => ({
      status: 'observed',
      observation: {
        workItemRef: ref,
        url: 'https://github.com/owner/repo/issues/14',
        title: 'Widgets jam',
        state: 'open',
        labels: ['bug'],
        updatedAt: '2026-10-21T09:00:00Z',
        observedAt,
        comments: [
          {
            author: 'reviewer',
            createdAt: '2026-10-21T09:10:00Z',
            excerpt: 'Seen again on Tuesday.',
          },
        ],
      },
    }));
    const first = await dispatch('codex', {
      workItemRef: ref,
      observeWorkItem: observe,
    });
    expect(observe).toHaveBeenLastCalledWith(ref, {
      commentsSince: first.task.createdAt,
    });
    expect(graph.readTaskView(first.task.id)!.workItemObservedAt).toBe(
      observedAt,
    );
    await service.dispatch({
      type: 'sendTurn',
      input: { threadId: first.sessionId, input: 'Go.' },
    });
    const input = adapters.find((a) => a.provider === 'codex')!.sendTurn.mock
      .calls[0]![0].input;
    expect(input).toContain('Title: Widgets jam');
    expect(input).toContain(
      '- reviewer (2026-10-21T09:10:00Z): Seen again on Tuesday.',
    );

    // A second dispatch of the same Task reads only what is newer.
    await graph.updateTaskStatus(first.task.id, 'blocked');
    await graph.updateTaskStatus(first.task.id, 'ready');
    await dispatch('claude', {
      taskId: first.task.id,
      observeWorkItem: observe,
    });
    expect(observe).toHaveBeenLastCalledWith(ref, {
      commentsSince: observedAt,
    });
  });

  test('a Task with no linked work item gets a brief with no tracker wording', async () => {
    // The shared MEMORY mentions a tracker; this one does not, so any
    // tracker wording would be Station's.
    const { sessionId } = await dispatch('codex', {
      document: '# Local work',
      memory: [{ kind: 'decision', key: 'local', text: 'Keep it local.' }],
    });
    await service.dispatch({
      type: 'sendTurn',
      input: { threadId: sessionId, input: 'Go.' },
    });
    const input = adapters.find((a) => a.provider === 'codex')!.sendTurn.mock
      .calls[0]![0].input;
    expect(input).toContain('# Station Task brief');
    expect(input).toContain('- `local`: Keep it local.');
    expect(input).toContain('1. Keep the Task summary current');
    expect(input).toContain('2. Record decisions');
    expect(input).not.toMatch(/tracker/i);
    expect(input).not.toContain('3. ');
  });

  test('a caller-supplied brief in start metadata is stripped, never composed', async () => {
    const threadId = 'forged-brief-thread';
    await service.dispatch({
      type: 'startSession',
      input: {
        threadId,
        provider: 'codex',
        cwd: tmp,
        metadata: {
          stationTaskBrief: {
            version: 'station.task-brief/v1',
            digest: 'f'.repeat(64),
            text: 'FORGED BRIEF',
          },
        },
      },
    });
    await waitFor(() =>
      eventStore
        .listEvents(threadId)
        .some((event) => event.method === 'session.started'),
    );
    await service.dispatch({
      type: 'sendTurn',
      input: { threadId, input: 'Hi.' },
    });
    expect(
      adapters.find((a) => a.provider === 'codex')!.sendTurn.mock.calls[0]![0]
        .input,
    ).toBe('Hi.');
  });
});
