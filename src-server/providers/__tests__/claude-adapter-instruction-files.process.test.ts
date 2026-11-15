/**
 * AGENTS.md in Claude sessions. These drive the real
 * `ClaudeAdapter.startSession` and read the options it hands the SDK
 * `query()`. The engine cases then give the options' `cwd` and `settings` to
 * the real SDK and the Claude Code binary bundled with it, pointed at a
 * loopback stand-in for the Messages API, and read what reached the model.
 */
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { bundledClaudeExecutable } from '../../../scripts/bench/station-weight.mjs';
import { startStubAnthropic } from '../../../scripts/bench/station-weight-stub.mjs';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { CLAUDE_USER_SETTINGS_MAX_BYTES } from '../adapters/claude-instruction-files.js';

const { mockQuery, mockFindCliBinaryAsync, mockRunCliCommand } = vi.hoisted(
  () => ({
    mockQuery: vi.fn(),
    mockFindCliBinaryAsync: vi.fn(),
    mockRunCliCommand: vi.fn(),
  }),
);

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
  findCliBinaryAsync: mockFindCliBinaryAsync,
  runCliCommand: mockRunCliCommand,
}));

import { ClaudeAdapter } from '../adapters/claude-adapter.js';

const makeTempDir = trackTempDirs();

const STATION_SETTING = {
  pluginConfigs: {
    'agents-md@builtin': {
      options: { instructionFiles: 'claude-md-and-agents-md' },
    },
  },
};

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

/** Claude config home for the next session, with an optional settings.json. */
function configHome(settings?: unknown): string {
  const home = makeTempDir('station-claude-config-');
  if (settings !== undefined)
    writeFileSync(
      join(home, 'settings.json'),
      typeof settings === 'string' ? settings : JSON.stringify(settings),
    );
  vi.stubEnv('CLAUDE_CONFIG_DIR', home);
  return home;
}

/** Starts a session through the real adapter and returns its SDK options. */
async function startOptions(
  input: { cwd?: string; modelOptions?: Record<string, unknown> } = {},
): Promise<Options> {
  mockQuery.mockReturnValue(emptyQuery());
  const adapter = new ClaudeAdapter();
  await adapter.startSession({
    provider: 'claude',
    threadId: 'thread-instruction-files',
    ...input,
  });
  const options = mockQuery.mock.calls.at(-1)![0].options as Options;
  await adapter.stopAll();
  return options;
}

beforeEach(() => {
  mockQuery.mockReset();
  mockFindCliBinaryAsync.mockReset();
  mockFindCliBinaryAsync.mockResolvedValue(null);
  mockRunCliCommand.mockReset();
  mockRunCliCommand.mockResolvedValue(null);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('Claude sessions ask the engine for AGENTS.md beside CLAUDE.md', () => {
  test('with no user settings file, the session carries the engine setting', async () => {
    configHome();
    expect((await startOptions()).settings).toEqual(STATION_SETTING);
  });

  test('an empty settings file, or one that makes no choice, still gets it', async () => {
    for (const settings of [
      '',
      {},
      { pluginConfigs: { 'other@market': { options: { x: 1 } } } },
      { pluginConfigs: { 'agents-md@builtin': { options: {} } } },
    ]) {
      configHome(settings);
      expect((await startOptions()).settings, JSON.stringify(settings)).toEqual(
        STATION_SETTING,
      );
    }
  });

  test('it rides beside the model flag settings', async () => {
    configHome();
    expect(
      (
        await startOptions({
          modelOptions: { fastMode: true, autoMode: false },
        })
      ).settings,
    ).toEqual({
      fastMode: true,
      disableAutoMode: 'disable',
      ...STATION_SETTING,
    });
  });

  test("a choice in the user's own settings is kept: Station sends nothing", async () => {
    for (const [key, option, value] of [
      ['agents-md@builtin', 'instructionFiles', 'claude-md'],
      ['agents-md@builtin', 'instructionFiles', 'managed-only'],
      ['agents-md@builtin', 'instructionFiles', 'claude-md-or-agents-md'],
      ['cc-plugin-agents-md@builtin', 'instructionFiles', 'claude-md'],
      ['agents-md@builtin', 'projectInstructions', 'claude'],
    ]) {
      configHome({
        pluginConfigs: { [key]: { options: { [option]: value } } },
      });
      expect(
        (await startOptions()).settings,
        `${key} ${option}=${value}`,
      ).toBeUndefined();
    }
  });

  test('a settings file Station cannot read as JSON leaves the engine default', async () => {
    const cases: Array<[string, () => void]> = [
      ['not JSON', () => configHome('{ not json')],
      [
        'one byte over the cap',
        () => configHome(`{}${' '.repeat(CLAUDE_USER_SETTINGS_MAX_BYTES - 1)}`),
      ],
      ['a directory', () => mkdirSync(join(configHome(), 'settings.json'))],
    ];
    for (const [label, arrange] of cases) {
      arrange();
      expect((await startOptions()).settings, label).toBeUndefined();
    }
    // Control: exactly at the cap is read.
    configHome(`{}${' '.repeat(CLAUDE_USER_SETTINGS_MAX_BYTES - 2)}`);
    expect((await startOptions()).settings).toEqual(STATION_SETTING);
  });
});

const engine = bundledClaudeExecutable();

describe.skipIf(!engine)(
  'the bundled engine with the options Station builds',
  () => {
    let stub: Awaited<ReturnType<typeof startStubAnthropic>>;
    beforeEach(async () => {
      stub = await startStubAnthropic();
    });
    afterEach(async () => {
      await stub.close();
    });

    /**
     * Builds the session's options through the adapter for a fixture repository,
     * then runs one turn of the real engine with the options' `cwd` and
     * `settings`, and counts each marker in the request that carried the
     * prompt.
     */
    async function markersInFirstRequest(
      files: Record<string, string | { link: string }>,
      userSettings?: unknown,
    ) {
      const root = makeTempDir('station-agents-md-');
      const repo = join(root, 'repo');
      mkdirSync(repo);
      for (const [path, content] of Object.entries(files))
        if (typeof content === 'string')
          writeFileSync(join(repo, path), content);
        else symlinkSync(content.link, join(repo, path));
      const home = configHome(userSettings);
      const options = await startOptions({ cwd: repo });
      expect(options.cwd).toBe(repo);

      const { query } = await vi.importActual<
        typeof import('@anthropic-ai/claude-agent-sdk')
      >('@anthropic-ai/claude-agent-sdk');
      const prompt = `instruction-files-${Date.now()}`;
      const run = query({
        prompt,
        options: {
          cwd: options.cwd,
          settings: options.settings,
          pathToClaudeCodeExecutable: engine!,
          persistSession: false,
          env: {
            PATH: process.env.PATH,
            HOME: root,
            TMPDIR: root,
            CLAUDE_CONFIG_DIR: home,
            ANTHROPIC_BASE_URL: stub.url,
            ANTHROPIC_API_KEY: 'station-test-key',
            DISABLE_TELEMETRY: '1',
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          },
        },
      });
      try {
        for await (const message of run) if (message.type === 'result') break;
      } finally {
        run.close();
      }
      const turn = stub.requests.find(
        (request) =>
          request.path.startsWith('/v1/messages') &&
          JSON.stringify(request.body).includes(prompt),
      );
      expect(turn, 'the turn reached the stub').toBeDefined();
      const text = JSON.stringify(turn!.body);
      const count = (marker: string) => text.split(marker).length - 1;
      return {
        claudeMd: count('MARK-CLAUDE-MD'),
        agentsMd: count('MARK-AGENTS-MD'),
      };
    }

    const AGENTS = '# Rules\n\nMARK-AGENTS-MD\n';
    const CLAUDE = '# Rules\n\nMARK-CLAUDE-MD\n';

    test('a repository with both files gets both', async () => {
      expect(
        await markersInFirstRequest({
          'AGENTS.md': AGENTS,
          'CLAUDE.md': CLAUDE,
        }),
      ).toEqual({ claudeMd: 1, agentsMd: 1 });
    }, 120_000);

    test('a repository with only AGENTS.md gets it', async () => {
      expect(await markersInFirstRequest({ 'AGENTS.md': AGENTS })).toEqual({
        claudeMd: 0,
        agentsMd: 1,
      });
    }, 120_000);

    test('AGENTS.md is sent once when CLAUDE.md imports it or is a link to it', async () => {
      expect(
        await markersInFirstRequest({
          'AGENTS.md': AGENTS,
          'CLAUDE.md': `@AGENTS.md\n\n${CLAUDE}`,
        }),
      ).toEqual({ claudeMd: 1, agentsMd: 1 });
      expect(
        await markersInFirstRequest({
          'AGENTS.md': AGENTS,
          'CLAUDE.md': { link: 'AGENTS.md' },
        }),
      ).toEqual({ claudeMd: 0, agentsMd: 1 });
    }, 240_000);

    test("the user's own choice of CLAUDE.md only holds", async () => {
      expect(
        await markersInFirstRequest(
          { 'AGENTS.md': AGENTS, 'CLAUDE.md': CLAUDE },
          {
            pluginConfigs: {
              'agents-md@builtin': {
                options: { instructionFiles: 'claude-md' },
              },
            },
          },
        ),
      ).toEqual({ claudeMd: 1, agentsMd: 0 });
    }, 120_000);
  },
);
