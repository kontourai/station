/**
 * #2540: what keeps a Claude engine from the finished-session park, which
 * stops an engine seconds after its turn, and what does not reach the idle,
 * recovery or relaunch parks (`hasOpenEngineWork`, unchanged). These drive
 * the real `ClaudeAdapter`: its SDK message stream (`init`, task frames) and
 * the `Stop` and `PostToolUse` hooks it hands the SDK `query()`, and read the
 * answer through `earlyParkRefusal` and `hasOpenEngineWork`, the seams the
 * parks consult.
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

/** An SDK query whose messages the test pushes. */
function controlledQuery() {
  const pending: unknown[] = [];
  let wake: (() => void) | null = null;
  return {
    push(message: unknown) {
      pending.push(message);
      wake?.();
      wake = null;
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (pending.length === 0)
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        yield pending.shift();
      }
    },
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

/** The Claude Code whose hook reporting Station checked. */
const VERIFIED_VERSION = '2.1.322';

/** Only Station's own in-process servers, as the engine reports them. */
const STATION_ONLY = [
  { name: 'station-control', status: 'connected', source: 'sdk' },
];

async function start(threadId: string) {
  mockQuery.mockReset();
  const engine = controlledQuery();
  mockQuery.mockReturnValue(engine);
  const adapter = new ClaudeAdapter({});
  const seen: Array<{ method: string }> = [];
  void (async () => {
    for await (const event of adapter.streamEvents()) seen.push(event);
  })();
  await adapter.startSession({ provider: 'claude', threadId });
  const options = mockQuery.mock.calls[0]![0].options;
  const signal = new AbortController().signal;
  const hook = (name: 'Stop' | 'PostToolUse', input: Record<string, unknown>) =>
    (options.hooks[name][0].hooks[0] as Hook)(
      {
        hook_event_name: name,
        session_id: 'engine-session',
        transcript_path: '/dev/null',
        cwd: '/workspace',
        ...input,
      },
      undefined,
      { signal },
    );
  const init = async (
    mcp_servers: unknown[],
    /** `null`: an engine that does not report its version. */
    claude_code_version: string | null = VERIFIED_VERSION,
  ) => {
    engine.push({
      type: 'system',
      subtype: 'init',
      session_id: 'engine-session',
      cwd: '/workspace',
      model: 'claude-sonnet',
      tools: [],
      mcp_servers,
      ...(claude_code_version ? { claude_code_version } : {}),
    });
    await vi.waitFor(() =>
      expect(seen.some((event) => event.method === 'session.configured')).toBe(
        true,
      ),
    );
  };
  const stop = (extra: Record<string, unknown> = {}) =>
    hook('Stop', { stop_hook_active: false, ...extra });
  const postToolUse = (tool_name: string) =>
    hook('PostToolUse', {
      tool_name,
      tool_input: {},
      tool_response: 'ok',
      tool_use_id: `post-${tool_name}`,
    });
  /** A Station-only engine that has stopped with nothing scheduled. */
  const settle = async () => {
    await init(STATION_ONLY);
    await stop({ session_crons: [] });
  };
  /** A hook from the user's settings, as the engine reports one it runs. */
  const settingsHook = (subtype: 'hook_started' | 'hook_response') =>
    engine.push({
      type: 'system',
      subtype,
      hook_id: 'hook-1',
      hook_name: 'Stop',
      hook_event: 'Stop',
      ...(subtype === 'hook_response'
        ? { output: '', stdout: '', stderr: '', outcome: 'success' }
        : {}),
      uuid: `u-${subtype}`,
      session_id: 'engine-session',
    });
  return {
    adapter,
    engine,
    init,
    stop,
    postToolUse,
    settle,
    seen,
    options,
    settingsHook,
  };
}

describe('the finished-session park on a Claude engine', () => {
  test('a Station-only engine that stopped with nothing scheduled may be parked early', async () => {
    const { adapter, settle } = await start('eligible');
    await settle();
    expect(adapter.earlyParkRefusal('eligible')).toBeUndefined();
    await adapter.stopAll();
  });

  test('the engine is asked to report every hook it runs', async () => {
    const { adapter, options } = await start('hook-events');
    expect(options.includeHookEvents).toBe(true);
    await adapter.stopAll();
  });

  // #2540 delta review 2 P1: a hook Station did not install (here an async
  // Stop hook from the user's settings) can outlive the turn and rewake the
  // engine; parking would kill it.
  test('a hook Station did not install refuses it, for the rest of the engine’s life', async () => {
    const { adapter, settle, settingsHook } = await start('foreign-hook');
    await settle();
    expect(adapter.earlyParkRefusal('foreign-hook')).toBeUndefined();
    settingsHook('hook_started');
    await vi.waitFor(() =>
      expect(adapter.earlyParkRefusal('foreign-hook')).toMatch(/hook/),
    );
    // Its end does not make the next one safe.
    settingsHook('hook_response');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(adapter.earlyParkRefusal('foreign-hook')).toMatch(/hook/);
    // And it is the finished-session park's alone.
    expect(adapter.hasOpenEngineWork('foreign-hook')).toBe(false);
    await adapter.stopAll();
  });

  test.each([
    ['older than the checked one', '2.1.200'],
    ['not reported', null],
    ['unreadable', 'next'],
    ['a prerelease of the checked one', '2.1.322-beta.1'],
    ['a prerelease of an older one', '2.1.300-rc.2'],
  ])(
    'an engine whose Claude Code version is %s is not parked early',
    async (_label, version) => {
      const { adapter, init, stop } = await start('version');
      await init(STATION_ONLY, version);
      await stop({ session_crons: [] });
      expect(adapter.earlyParkRefusal('version')).toMatch(/version/);
      await adapter.stopAll();
    },
  );

  test.each([
    ['a newer release', '2.2.0'],
    ['a prerelease of a newer one', '2.2.0-beta.1'],
  ])(
    '%s than the checked Claude Code may be parked early',
    async (_label, version) => {
      const { adapter, init, stop } = await start('newer');
      await init(STATION_ONLY, version);
      await stop({ session_crons: [] });
      expect(adapter.earlyParkRefusal('newer')).toBeUndefined();
      await adapter.stopAll();
    },
  );

  test('a wakeup the engine reported at its last stop refuses it', async () => {
    const { adapter, init, stop } = await start('wakeup-thread');
    await init(STATION_ONLY);
    await expect(
      stop({
        session_crons: [
          { id: 'cron-1', schedule: '*/5 * * * *', prompt: 'check the build' },
        ],
      }),
    ).resolves.toEqual({ continue: true });
    expect(adapter.earlyParkRefusal('wakeup-thread')).toMatch(/wakeup/);
    // An engine that omits the field says nothing new.
    await stop({});
    expect(adapter.earlyParkRefusal('wakeup-thread')).toMatch(/wakeup/);
    await stop({ session_crons: [] });
    expect(adapter.earlyParkRefusal('wakeup-thread')).toBeUndefined();
    await adapter.stopAll();
  });

  test('before any stop reports its wakeups, the engine is not parked early', async () => {
    const { adapter, init, stop } = await start('never-stopped');
    await init(STATION_ONLY);
    expect(adapter.earlyParkRefusal('never-stopped')).toMatch(/wakeup/);
    await stop({});
    expect(adapter.earlyParkRefusal('never-stopped')).toMatch(/wakeup/);
    await adapter.stopAll();
  });

  test.each(['CronCreate', 'ScheduleWakeup', 'CronDelete'])(
    'a %s call leaves the wakeups unknown until a stop reports them',
    async (tool) => {
      const { adapter, settle, stop, postToolUse } = await start(tool);
      await settle();
      await postToolUse(tool);
      // The turn then ends through StopFailure: no Stop hook runs.
      expect(adapter.earlyParkRefusal(tool)).toMatch(/wakeup/);
      await stop({});
      expect(adapter.earlyParkRefusal(tool)).toMatch(/wakeup/);
      await stop({ session_crons: [] });
      expect(adapter.earlyParkRefusal(tool)).toBeUndefined();
      await adapter.stopAll();
    },
  );

  test('an unrelated tool call leaves the reported wakeups as they were', async () => {
    const { adapter, settle, postToolUse } = await start('other-tool');
    await settle();
    await postToolUse('Bash');
    expect(adapter.earlyParkRefusal('other-tool')).toBeUndefined();
    await adapter.stopAll();
  });

  test('a housekeeping task the SDK keeps out of the transcript refuses it while it runs', async () => {
    const { adapter, engine, settle, seen } = await start('housekeeping');
    await settle();
    engine.push({
      type: 'system',
      subtype: 'task_started',
      task_id: 'memory-save',
      description: 'Saving memories',
      skip_transcript: true,
      uuid: 'u-h1',
      session_id: 'engine-session',
    });
    await vi.waitFor(() =>
      expect(adapter.earlyParkRefusal('housekeeping')).toMatch(/housekeeping/),
    );
    // Still no activity row and no open work for the other parks.
    expect(seen.some((event) => event.method === 'tool.started')).toBe(false);
    expect(adapter.hasOpenEngineWork('housekeeping')).toBe(false);
    engine.push({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'memory-save',
      status: 'completed',
      summary: 'saved',
      output_file: '/tmp/memory.output',
      uuid: 'u-h2',
      session_id: 'engine-session',
    });
    await vi.waitFor(() =>
      expect(adapter.earlyParkRefusal('housekeeping')).toBeUndefined(),
    );
    await adapter.stopAll();
  });

  test.each([
    [
      'a server from the user’s own settings',
      [
        ...STATION_ONLY,
        { name: 'browser', status: 'connected', source: 'user' },
      ],
    ],
    [
      'a server a plugin brought',
      [
        ...STATION_ONLY,
        { name: 'notes', status: 'connected', source: 'plugin' },
      ],
    ],
    [
      'a server whose origin the engine does not report',
      [{ name: 'station-control', status: 'connected' }],
    ],
  ])('%s refuses it', async (_label, servers) => {
    const { adapter, init, stop } = await start('mcp');
    await init(servers);
    await stop({ session_crons: [] });
    expect(adapter.earlyParkRefusal('mcp')).toMatch(/MCP/);
    await adapter.stopAll();
  });

  test('an engine that has not reported its init is not parked early', async () => {
    const { adapter, stop } = await start('no-init');
    await stop({ session_crons: [] });
    // Without an `init` nothing is known: neither its version nor its
    // servers.
    expect(adapter.earlyParkRefusal('no-init')).toBeDefined();
    await adapter.stopAll();
  });

  test('none of it reaches the idle, recovery or relaunch parks', async () => {
    const { adapter, init, postToolUse, stop } = await start('other-parks');
    await init([
      ...STATION_ONLY,
      { name: 'browser', status: 'connected', source: 'user' },
    ]);
    await stop({
      session_crons: [{ id: 'c', schedule: '* * * * *', prompt: 'x' }],
    });
    await postToolUse('CronDelete');
    expect(adapter.earlyParkRefusal('other-parks')).toBeDefined();
    expect(adapter.hasOpenEngineWork('other-parks')).toBe(false);
    await adapter.stopAll();
  });
});
