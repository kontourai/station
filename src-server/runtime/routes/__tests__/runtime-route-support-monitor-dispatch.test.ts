/**
 * An external monitor's actionable finding dispatches a Task through the REAL
 * `configureRuntimeSupportServices` composition. The monitored source, not the
 * operator, drives that session: it must be the operator's to read but act
 * for no one (never elevation-eligible as the operator).
 */
import { afterEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';

const captured = vi.hoisted(() => ({ options: undefined as any }));

function stub(): any {
  const fn: any = () => proxy;
  const proxy: any = new Proxy(fn, {
    get: (_target, key) =>
      key === 'then' || key === Symbol.toPrimitive ? undefined : proxy,
    apply: () => proxy,
  });
  return proxy;
}

vi.mock('../../../services/scheduling/scheduler-service.js', () => ({
  // Captures the composition's scheduler options, so the monitor hook the
  // runtime wires is the one this test calls.
  SchedulerService: class {
    constructor(options: unknown) {
      captured.options = options;
      // biome-ignore lint/correctness/noConstructorReturn: a stub scheduler
      return stub();
    }
  },
}));

const { configureRuntimeSupportServices } = await import(
  '../runtime-route-support.js'
);
const { EventBus } = await import(
  '../../../services/orchestration/event-bus.js'
);
const { LOCAL_OPERATOR_PRINCIPAL_ID } = await import(
  '../../../services/identity/principal-resolver.js'
);

const makeTempDir = trackTempDirs();
const shutdowns: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const shutdown of shutdowns.splice(0)) await shutdown();
});

test("an external monitor's Task session is the operator's to read and acts for no one", async () => {
  const home = makeTempDir('runtime-support-monitor-');
  const dispatch = vi.fn(async () => ({
    kind: 'contended' as const,
    reason: 'test stops here',
  }));
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
      taskGraphService: {
        createTaskIdempotent: async () => ({ id: 'task-monitor' }),
      },
      taskDispatcher: { dispatch },
    } as Record<PropertyKey, unknown>,
    { get: (target, key) => (key in target ? target[key] : stub()) },
  );
  const services = configureRuntimeSupportServices(context as never, stub(), {
    webPushEnabled: false,
  });
  shutdowns.push(() => services.notificationService.shutdown());

  await captured.options.builtin.onActionableMonitor({
    jobName: 'Watch',
    jobId: 'job-1',
    fingerprint: 'fp',
    triggerId: 'trigger-1',
    projectId: 'project-1',
    agentId: 'agent-1',
    prompt: 'look',
    principal: { kind: 'scheduled-job', jobId: 'job-1', runId: 'run-1' },
    monitor: {
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 60_000,
      maxCompletedTurns: 1,
      maxTokens: 1_000,
      onInitialTurnStarted: () => {},
    },
  });

  expect(dispatch).toHaveBeenCalledWith(
    'task-monitor',
    expect.objectContaining({
      sourceSurface: 'external-monitor',
      ownerUserId: LOCAL_OPERATOR_PRINCIPAL_ID,
      ownerAttribution: 'unattributed-agent',
    }),
  );
});
