/**
 * #2540: a Claude engine that scheduled a wakeup for itself (CronCreate,
 * ScheduleWakeup, a loop) is waiting to run again, and the wakeup lives in
 * its process: an idle or finished-session park would drop it. These drive
 * the real `ClaudeAdapter.startSession` and the `Stop` hook it hands the SDK
 * `query()`, and read the answer through `hasOpenEngineWork`, the seam the
 * park consults.
 */
import { describe, expect, test, vi } from 'vitest';

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));

vi.mock('node:os', async (original) => ({
  ...(await original<typeof import('node:os')>()),
  platform: () => 'linux',
}));

vi.mock('../adapters/claude-code-spawn.js', async (importOriginal) => {
  const { fakeEngineProcessModule } = await import(
    './claude-engine-process-test-utils.js'
  );
  return fakeEngineProcessModule(
    await importOriginal<typeof import('../adapters/claude-code-spawn.js')>(),
  );
});

vi.mock('@anthropic-ai/claude-agent-sdk', async () => {
  const { withRecordedClaudeAsks } = await import(
    './claude-engine-process-test-utils.js'
  );
  return {
    deleteSession: vi.fn(),
    forkSession: vi.fn(),
    listSessions: vi.fn(),
    query: (args: { options?: unknown }) =>
      mockQuery(withRecordedClaudeAsks(args)),
  };
});

vi.mock('../auth/cli-auth.js', () => ({
  buildCliRuntimePrerequisites: vi.fn(),
  augmentedSpawnEnv: vi.fn(),
  findCliBinaryAsync: vi.fn(),
  runCliCommand: vi.fn(),
}));

import { ClaudeAdapter } from '../adapters/claude-adapter.js';

function emptyQuery() {
  return {
    async *[Symbol.asyncIterator]() {},
    interrupt: vi.fn().mockResolvedValue(undefined),
    supportedModels: vi.fn().mockResolvedValue([]),
    close: vi.fn(),
    setModel: vi.fn().mockResolvedValue(undefined),
    setPermissionMode: vi.fn().mockResolvedValue(undefined),
    applyFlagSettings: vi.fn().mockResolvedValue(undefined),
  };
}

type Hook = (
  input: Record<string, unknown>,
  toolUseId: string | undefined,
  options: { signal: AbortSignal },
) => Promise<Record<string, unknown>>;

async function start(threadId: string) {
  mockQuery.mockReset();
  mockQuery.mockReturnValue(emptyQuery());
  const adapter = new ClaudeAdapter({});
  await adapter.startSession({ provider: 'claude', threadId });
  const options = mockQuery.mock.calls[0]![0].options;
  const signal = new AbortController().signal;
  const postToolUse = (tool_name: string) =>
    (options.hooks.PostToolUse[0].hooks[0] as Hook)(
      {
        hook_event_name: 'PostToolUse',
        session_id: 'engine-session',
        transcript_path: '/dev/null',
        cwd: '/workspace',
        tool_name,
        tool_input: {},
        tool_response: 'scheduled',
        tool_use_id: `post-${tool_name}`,
      },
      `post-${tool_name}`,
      { signal },
    );
  const stop = (extra: Record<string, unknown>) =>
    (options.hooks.Stop[0].hooks[0] as Hook)(
      {
        hook_event_name: 'Stop',
        session_id: 'engine-session',
        transcript_path: '/dev/null',
        cwd: '/workspace',
        stop_hook_active: false,
        ...extra,
      },
      undefined,
      { signal },
    );
  return { adapter, stop, postToolUse };
}

describe('a Claude engine with a scheduled wakeup has open work', () => {
  test('while its last stop reports one, and not once none remain', async () => {
    const { adapter, stop } = await start('wakeup-thread');
    expect(adapter.hasOpenEngineWork('wakeup-thread')).toBe(false);

    await expect(
      stop({
        session_crons: [
          { id: 'cron-1', schedule: '*/5 * * * *', prompt: 'check the build' },
        ],
      }),
    ).resolves.toEqual({ continue: true });
    expect(adapter.hasOpenEngineWork('wakeup-thread')).toBe(true);

    // An engine that omits the field says nothing new.
    await stop({});
    expect(adapter.hasOpenEngineWork('wakeup-thread')).toBe(true);

    await stop({ session_crons: [] });
    expect(adapter.hasOpenEngineWork('wakeup-thread')).toBe(false);
    await adapter.stopAll();
  });

  test.each(['CronCreate', 'ScheduleWakeup', 'CronDelete'])(
    'a %s call leaves the wakeups unknown until a stop reports them, so a turn that fails after it keeps the engine',
    async (tool) => {
      const { adapter, stop, postToolUse } = await start(`wakeup-${tool}`);
      await stop({ session_crons: [] });
      expect(adapter.hasOpenEngineWork(`wakeup-${tool}`)).toBe(false);
      await postToolUse(tool);
      // The turn then ends through StopFailure: no Stop hook runs.
      expect(adapter.hasOpenEngineWork(`wakeup-${tool}`)).toBe(true);
      // An engine that omits the field cannot settle it either.
      await stop({});
      expect(adapter.hasOpenEngineWork(`wakeup-${tool}`)).toBe(true);
      await stop({ session_crons: [] });
      expect(adapter.hasOpenEngineWork(`wakeup-${tool}`)).toBe(false);
      await adapter.stopAll();
    },
  );

  test('an unrelated tool call leaves the reported wakeups as they were', async () => {
    const { adapter, stop, postToolUse } = await start('wakeup-other');
    await stop({ session_crons: [] });
    await postToolUse('Bash');
    expect(adapter.hasOpenEngineWork('wakeup-other')).toBe(false);
    await adapter.stopAll();
  });
});
