/**
 * #5113: a workload notice for a Claude engine's own scope reaches the
 * engine through the real `ClaudeAdapter`. The adapter's own engine spawn
 * (claude-code-spawn.ts) subscribes to the spawned process's notices; the
 * test stands in for WorkloadResources at that seam and then calls the
 * PostToolUse, PostToolUseFailure and UserPromptSubmit hooks the adapter
 * hands the SDK `query()`, whose `additionalContext` Claude Code adds to the
 * model's context.
 */
import * as workload from '@kontourai/station-shared/child-workload';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

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

vi.mock('../../telemetry/metrics.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../telemetry/metrics.js')>()),
  engineWorkloadNotices: { add: vi.fn() },
}));

import { engineWorkloadNotices } from '../../telemetry/metrics.js';
import { ClaudeAdapter } from '../adapters/claude-adapter.js';
import {
  FakeClaudeChild,
  startFakeClaudeEngine,
} from './claude-engine-process-test-utils.js';

const GIB = 1024 * 1024 * 1024;
const MIB = 1024 * 1024;
const WORKING_SET = Math.round(6.4 * GIB);

const PRESSURE: workload.ChildWorkloadNotice = {
  kind: 'pressure-enter',
  workingSetBytes: WORKING_SET,
  memoryMaxBytes: 7 * GIB,
  thresholdPercent: 85,
  largestProcesses: [
    { pid: 2001, name: 'fallow', rssBytes: Math.round(5.1 * GIB) },
    { pid: 2002, name: 'node', rssBytes: 620 * MIB },
  ],
};
const PRESSURE_TEXT =
  "Station workload notice: This session's memory is at 91% of its 7.0 GiB limit; largest: fallow 5.1 GiB, node 620 MiB. Stop or serialize memory-heavy commands before the kernel kills one.";

function emptyQuery() {
  return {
    async *[Symbol.asyncIterator]() {
      await new Promise(() => {});
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

type HookName = 'PostToolUse' | 'PostToolUseFailure' | 'UserPromptSubmit';

describe('Claude engine workload notices (#5113)', () => {
  let listeners: Array<(notice: workload.ChildWorkloadNotice) => void>;
  let unsubscribed: number;

  beforeEach(() => {
    listeners = [];
    unsubscribed = 0;
    vi.mocked(engineWorkloadNotices.add).mockClear();
    vi.spyOn(workload, 'watchChildWorkloadNotices').mockImplementation(
      (_child, listener) => {
        listeners.push(listener);
        return () => {
          unsubscribed += 1;
          listeners = listeners.filter((entry) => entry !== listener);
        };
      },
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function start(threadId: string) {
    mockQuery.mockReset();
    mockQuery.mockReturnValue(emptyQuery());
    const adapter = new ClaudeAdapter({});
    const seen: Array<Record<string, unknown> & { method: string }> = [];
    void (async () => {
      for await (const event of adapter.streamEvents())
        seen.push(event as never);
    })();
    await adapter.startSession({ provider: 'claude', threadId });
    const options = mockQuery.mock.calls[0]![0].options;
    // The SDK spawns the engine through the adapter's own spawn.
    startFakeClaudeEngine(options);
    const signal = new AbortController().signal;
    let sequence = 0;
    const hook = (name: HookName) =>
      (options.hooks[name][0].hooks[0] as Hook)(
        {
          hook_event_name: name,
          session_id: 'engine-session',
          transcript_path: '/dev/null',
          cwd: '/workspace',
          ...(name === 'UserPromptSubmit'
            ? { prompt: 'next' }
            : {
                tool_name: 'Bash',
                tool_input: { command: 'npm test' },
                tool_use_id: `tool-${++sequence}`,
                ...(name === 'PostToolUse'
                  ? { tool_response: 'ok' }
                  : { error: 'Killed' }),
              }),
        },
        `tool-${sequence}`,
        { signal },
      );
    const notify = (notice: workload.ChildWorkloadNotice) => {
      for (const listener of [...listeners]) listener(notice);
    };
    return { adapter, seen, hook, notify };
  }

  const delivered = (output: Record<string, unknown>) =>
    (output.hookSpecificOutput as { additionalContext?: string } | undefined)
      ?.additionalContext;

  test('a pressure-enter reaches the engine once, at its next tool result, and the transcript at once', async () => {
    const { seen, hook, notify } = await start('thread-claude-pressure');
    expect(listeners).toHaveLength(1);
    expect(await hook('PostToolUse')).toEqual({ continue: true });

    notify(PRESSURE);
    await vi.waitFor(() =>
      expect(
        seen.filter((event) => event.method === 'runtime.warning'),
      ).toEqual([
        expect.objectContaining({
          code: 'workload-memory-pressure',
          severity: 'warning',
          message: PRESSURE_TEXT.slice('Station workload notice: '.length),
          details: {
            workingSetBytes: WORKING_SET,
            memoryMaxBytes: 7 * GIB,
            thresholdPercent: 85,
          },
        }),
      ]),
    );

    expect(await hook('PostToolUse')).toEqual({
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: PRESSURE_TEXT,
      },
    });
    // One transition, one delivery: later tool results carry nothing.
    expect(await hook('PostToolUse')).toEqual({ continue: true });
    expect(await hook('PostToolUseFailure')).toEqual({ continue: true });
    expect(await hook('UserPromptSubmit')).toEqual({ continue: true });
    expect(vi.mocked(engineWorkloadNotices.add).mock.calls).toEqual([
      [
        1,
        {
          provider_family: 'claude',
          kind: 'pressure-enter',
          outcome: 'delivered-mid-turn',
        },
      ],
    ]);
  });

  test('a kill reaches the engine through a failed tool result, and a notice with no tool call through the next prompt', async () => {
    const { seen, hook, notify } = await start('thread-claude-kill');
    notify({
      kind: 'oom-kill',
      kill: { oomKills: 1, newKills: 1, memoryMaxBytes: 7 * GIB },
      largestProcesses: [{ pid: 2002, name: 'node', rssBytes: 620 * MIB }],
    });
    expect(delivered(await hook('PostToolUseFailure'))).toBe(
      'Station workload notice: The kernel killed 1 process in this session for exceeding its 7.0 GiB memory limit; largest now: node 620 MiB. A command that just failed may have been killed; run memory-heavy commands one at a time.',
    );
    await vi.waitFor(() =>
      expect(
        seen.find((event) => event.method === 'runtime.warning'),
      ).toMatchObject({
        code: 'workload-command-oom-killed',
        details: { newKills: 1, oomKills: 1, memoryMaxBytes: 7 * GIB },
      }),
    );

    notify(PRESSURE);
    expect(await hook('UserPromptSubmit')).toEqual({
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: PRESSURE_TEXT,
      },
    });
    expect(engineWorkloadNotices.add).toHaveBeenLastCalledWith(1, {
      provider_family: 'claude',
      kind: 'pressure-enter',
      outcome: 'delivered-turn-start',
    });
  });

  test('entering and leaving pressure before the engine hears of it says nothing', async () => {
    const { hook, notify } = await start('thread-claude-flap');
    notify(PRESSURE);
    notify({
      kind: 'pressure-exit',
      workingSetBytes: 5 * GIB,
      memoryMaxBytes: 7 * GIB,
      thresholdPercent: 85,
    });
    expect(await hook('PostToolUse')).toEqual({ continue: true });
    expect(vi.mocked(engineWorkloadNotices.add).mock.calls).toEqual([
      [
        1,
        {
          provider_family: 'claude',
          kind: 'pressure-enter',
          outcome: 'superseded',
        },
      ],
      [
        1,
        {
          provider_family: 'claude',
          kind: 'pressure-exit',
          outcome: 'superseded',
        },
      ],
    ]);
  });

  test('no notice reaches the engine or the transcript after the session ends', async () => {
    const { adapter, seen, hook, notify } = await start('thread-claude-ended');
    notify(PRESSURE);
    const stopping = adapter.stopSession('thread-claude-ended');
    // The adapter's stop terminates the fake engine; it exits.
    FakeClaudeChild.newest?.exit(null, 'SIGTERM');
    FakeClaudeChild.newest?.closeStderr();
    await stopping;
    // The engine process's subscription ended with it.
    expect(unsubscribed).toBe(1);
    expect(listeners).toEqual([]);
    expect(engineWorkloadNotices.add).toHaveBeenLastCalledWith(1, {
      provider_family: 'claude',
      kind: 'pressure-enter',
      outcome: 'discarded',
    });
    const warnings = () =>
      seen.filter((event) => event.method === 'runtime.warning').length;
    const before = warnings();
    expect(await hook('PostToolUse')).toEqual({ continue: true });
    expect(warnings()).toBe(before);
  });
});
