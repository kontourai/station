/**
 * #4508: the Task follow-up poller's runtime wiring, through the REAL
 * `configureRuntimeSupportServices`. The scheduler service is replaced only to
 * capture the `automationPoller` the composition hands it; that poller, the
 * Feature Preview registry, the follow-up store and the gh reader (a fake
 * `gh api graphql` on PATH, through the real process-group runner) are real.
 */
import type { TaskRecord } from '@kontourai/station-contracts/task-graph';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { HOSTED_TENANT_REGISTRY_FILE_ENV } from '../../bootstrap/hosted-tenant-mode.js';

const captured = vi.hoisted(() => ({ options: [] as unknown[] }));
vi.mock(
  '../../../services/scheduling/scheduler-service.js',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('../../../services/scheduling/scheduler-service.js')
    >()),
    SchedulerService: class {
      constructor(options: unknown) {
        captured.options.push(options);
      }
    },
  }),
);

const { configureRuntimeSupportServices } = await import(
  '../runtime-route-support.js'
);
const { EventBus } = await import(
  '../../../services/orchestration/event-bus.js'
);
const { FeaturePreviewRegistry } = await import(
  '../../../services/feature-previews/feature-preview-registry.js'
);
const { TaskFollowUpStoreHolder, taskFollowUpStorePath } = await import(
  '../../../services/work-item-providers/task-follow-up-store.js'
);
const { composeTaskFollowUpPoller, TASK_FOLLOW_UP_PREVIEW_ID } = await import(
  '../../../services/work-item-providers/task-follow-up-poller.js'
);
const fakeGh = await import(
  '../../../services/work-item-providers/__tests__/fixtures/fake-gh-graphql.js'
);

const { LOCAL_OPERATOR_PRINCIPAL_ID } = await import(
  '../../../services/identity/principal-resolver.js'
);

const makeTempDir = trackTempDirs();
const closers: Array<() => Promise<unknown> | unknown> = [];

type AutomationPoller = {
  poll(input: { now: number; signal: AbortSignal }): Promise<unknown>;
  close(): Promise<void> | void;
};

/** Every property a no-op whose result is the same stub (never thenable). */
function stub(): any {
  const fn: any = () => proxy;
  const proxy: any = new Proxy(fn, {
    get: (_target, key) =>
      key === 'then' || key === Symbol.toPrimitive ? undefined : proxy,
    apply: () => proxy,
  });
  return proxy;
}

const TASK: TaskRecord = {
  id: 'task-followed',
  projectId: 'project-a',
  title: 'Widgets jam',
  description: '',
  priority: 'normal',
  status: 'in_progress',
  createdBy: 'person',
  createdAt: '2026-10-01T09:00:00.000Z',
  updatedAt: '2026-10-01T09:00:00.000Z',
  sourceProvider: 'github',
  workItemRef: 'github:acme/widgets#14882',
  workItemProvenance: 'project-board',
};

let home: string;
let ghDir: string;

beforeEach(() => {
  captured.options.length = 0;
  home = makeTempDir('station-follow-up-wiring-');
  ghDir = makeTempDir('station-follow-up-wiring-gh-');
  fakeGh.installFakeGhGraphql(ghDir);
  vi.stubEnv('PATH', `${ghDir}:${process.env.PATH ?? ''}`);
});

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  vi.unstubAllEnvs();
});

/** Turn the preview on the way a person does, before the runtime composes. */
async function savePreviewEnabled() {
  const registry = new FeaturePreviewRegistry(home, {
    info: () => undefined,
    error: () => undefined,
  } as never);
  composeTaskFollowUpPoller(registry, false, {
    store: () => undefined,
    tasks: { listTasks: () => [], listKeptDeclaredPullRequests: () => [] },
    reader: { readPage: async () => ({ status: 'unavailable', reason: '' }) },
  });
  await registry.setEnabled(TASK_FOLLOW_UP_PREVIEW_ID, true);
}

type Lead = { submits: { conversationId: string; message: string }[] };

function compose(lead?: Lead) {
  const featurePreviews = new FeaturePreviewRegistry(home, {
    info: () => undefined,
    error: () => undefined,
  } as never);
  const holder = new TaskFollowUpStoreHolder(() => taskFollowUpStorePath(home));
  const context = new Proxy(
    {
      eventBus: new EventBus(),
      logger: {
        warn: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
      },
      configLoader: { getProjectHomeDir: () => home },
      featurePreviews,
      taskFollowUps: holder,
      orchestrationEventStore: lead
        ? new Proxy(
            { conversationForSession: () => undefined } as Record<
              PropertyKey,
              unknown
            >,
            { get: (target, key) => (key in target ? target[key] : stub()) },
          )
        : undefined,
      ...(lead
        ? {
            // The lead Session the Task recorded, idle, owned by the operator.
            orchestrationService: new Proxy(
              {
                currentConversationSessionId: (id: string) => id,
                readSession: async () => ({
                  session: {
                    provider: 'codex',
                    threadId: 'session-lead',
                    status: 'ready',
                    createdAt: TASK.createdAt,
                    updatedAt: TASK.createdAt,
                  },
                  events: [],
                }),
                sessionRecordedOwnerId: () => LOCAL_OPERATOR_PRINCIPAL_ID,
              } as Record<PropertyKey, unknown>,
              { get: (target, key) => (key in target ? target[key] : stub()) },
            ),
            projectService: new Proxy(
              {
                listProjects: () => [{ id: 'project-a', slug: 'project-a' }],
              } as Record<PropertyKey, unknown>,
              { get: (target, key) => (key in target ? target[key] : stub()) },
            ),
          }
        : {}),
      taskGraphService: new Proxy(
        {
          listTasks: () => [TASK],
          listKeptDeclaredPullRequests: () => [],
          readTaskView: () => ({ ...TASK, sessionId: 'session-lead' }),
        } as Record<PropertyKey, unknown>,
        { get: (target, key) => (key in target ? target[key] : stub()) },
      ),
    } as Record<PropertyKey, unknown>,
    { get: (target, key) => (key in target ? target[key] : stub()) },
  );
  const services = configureRuntimeSupportServices(context as never, stub(), {
    webPushEnabled: false,
    ...(lead
      ? {
          threadInbox: () => ({
            submit: (input: {
              conversationId: string;
              payload: { message: string };
            }) => {
              lead.submits.push({
                conversationId: input.conversationId,
                message: input.payload.message,
              });
              return { outcome: 'queued', entry: {} } as never;
            },
            entry: () => undefined,
          }),
        }
      : {}),
  });
  closers.push(() => services.notificationService.shutdown());
  const options = captured.options.at(-1) as {
    builtin: { automationPoller: AutomationPoller };
  };
  const poller = options.builtin.automationPoller;
  closers.unshift(() => poller.close());
  return { poller, featurePreviews, services };
}

const within = <T>(promise: Promise<T>, ms: number) =>
  Promise.race([
    promise.then(() => 'settled' as const),
    new Promise<'late'>((resolve) => setTimeout(() => resolve('late'), ms)),
  ]);

test('the scheduler tick starts a follow-up poll and does not wait for a hanging gh', async () => {
  await savePreviewEnabled();
  fakeGh.hang(ghDir);
  const { poller } = compose();

  // The automation chain finishes while the follow-up read still hangs.
  await expect(
    within(
      poller.poll({ now: Date.now(), signal: new AbortController().signal }),
      3_000,
    ),
  ).resolves.toBe('settled');
  // ...and that read was really started, through gh on PATH.
  await vi.waitFor(() => expect(fakeGh.calls(ghDir)).toHaveLength(1), {
    timeout: 5_000,
  });
  expect(fakeGh.calls(ghDir)[0]).toMatchObject({
    hostname: 'github.com',
    number: '14882',
  });
  // A second tick while the first is in flight starts nothing new, and the
  // automation chain again does not wait.
  await expect(
    within(
      poller.poll({ now: Date.now(), signal: new AbortController().signal }),
      3_000,
    ),
  ).resolves.toBe('settled');
  expect(fakeGh.calls(ghDir)).toHaveLength(1);
  // Shutdown stops the hanging gh process rather than waiting a minute.
  await expect(within(Promise.resolve(poller.close()), 5_000)).resolves.toBe(
    'settled',
  );
});

test('hosted mode offers no follow-up preview and polls nothing, even with a saved choice', async () => {
  await savePreviewEnabled();
  fakeGh.answer(ghDir, { number: 14882 }, fakeGh.fixture('issue-page-2'));
  vi.stubEnv(HOSTED_TENANT_REGISTRY_FILE_ENV, '/hosted/tenants.json');
  const { poller, featurePreviews } = compose();
  await poller.poll({ now: Date.now(), signal: new AbortController().signal });
  // Give a started poll time to reach gh before concluding none was.
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(fakeGh.calls(ghDir)).toEqual([]);
  expect(featurePreviews.list().map((p) => p.id)).not.toContain(
    TASK_FOLLOW_UP_PREVIEW_ID,
  );
});

test('the personal control: the same saved choice polls the Task', async () => {
  await savePreviewEnabled();
  fakeGh.answer(ghDir, { number: 14882 }, fakeGh.fixture('issue-page-2'));
  const { poller } = compose();
  await poller.poll({ now: Date.now(), signal: new AbortController().signal });
  await vi.waitFor(() => expect(fakeGh.calls(ghDir)).toHaveLength(1), {
    timeout: 5_000,
  });
});

test("the composed poller wakes the Task's lead through the runtime's thread inbox", async () => {
  await savePreviewEnabled();
  // The followed item answers as a pull request with a member's review.
  const page1 = fakeGh.fixture('pull-request-page-1');
  const page2 = fakeGh.fixture('pull-request-page-2');
  const last = (page: any, stream: string) =>
    page.data.repository.issueOrPullRequest[stream].edges.at(-1).cursor;
  fakeGh.answer(ghDir, { number: 14882 }, page1);
  fakeGh.answer(
    ghDir,
    {
      number: 14882,
      commentsAfter: last(page1, 'comments'),
      reviewsAfter: last(page1, 'reviews'),
    },
    page2,
  );
  const lead: Lead = { submits: [] };
  const { poller, services } = compose(lead);
  expect(services.taskFollowUpWake).toBeDefined();
  await poller.poll({ now: Date.now(), signal: new AbortController().signal });
  await vi.waitFor(() => expect(lead.submits).toHaveLength(1), {
    timeout: 10_000,
  });
  expect(lead.submits[0]).toMatchObject({ conversationId: 'session-lead' });
  expect(lead.submits[0].message).toContain(
    'Review comment 4363072349 on github:acme/widgets#14882 by member-reviewer (member, MEMBER)',
  );
});
