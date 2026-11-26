/**
 * AGENTS.md in Claude sessions. These drive the real
 * `ClaudeAdapter.startSession` and read the options it hands the SDK
 * `query()`. The engine cases then give the options' `cwd` and `settings` to
 * the real SDK and the Claude Code binary bundled with it, pointed at a
 * loopback stand-in for the Messages API, and read what reached the model.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { bundledClaudeExecutable } from '../../../scripts/bench/station-weight.mjs';
import { startStubAnthropic } from '../../../scripts/bench/station-weight-stub.mjs';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import {
  CLAUDE_MANAGED_DROP_IN_MAX_FILES,
  CLAUDE_USER_SETTINGS_MAX_BYTES,
} from '../adapters/claude-instruction-files.js';

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

/**
 * The engine's managed settings folder for the next session: a fresh empty
 * folder unless a test writes into it, so this machine's own managed settings
 * never decide a case.
 */
let managedRoot: string;

/** Writes a managed settings file (or a drop-in) into the managed folder. */
function managed(name: string, settings: unknown) {
  const path = join(managedRoot, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(settings));
}

/** Starts a session through the real adapter and returns its SDK options. */
async function startOptions(
  input: { cwd?: string; modelOptions?: Record<string, unknown> } = {},
): Promise<Options> {
  mockQuery.mockReturnValue(emptyQuery());
  const adapter = new ClaudeAdapter({ managedSettingsRoot: managedRoot });
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
  managedRoot = makeTempDir('station-claude-managed-');
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

  test('a managed choice, on either key and in either managed file, is kept', async () => {
    const legacyNone = {
      pluginConfigs: {
        'agents-md@builtin': { options: { projectInstructions: 'none' } },
      },
    };
    const modern = {
      pluginConfigs: {
        'agents-md@builtin': { options: { instructionFiles: 'claude-md' } },
      },
    };
    for (const [label, name, settings] of [
      [
        'legacy key, managed-settings.json',
        'managed-settings.json',
        legacyNone,
      ],
      ['legacy key, drop-in', 'managed-settings.d/10-policy.json', legacyNone],
      ['modern key, drop-in', 'managed-settings.d/20-policy.json', modern],
    ] as const) {
      managedRoot = makeTempDir('station-claude-managed-');
      configHome();
      managed(name, settings);
      expect((await startOptions()).settings, label).toBeUndefined();
    }
    // Control: managed settings that make no choice leave Station's setting.
    managedRoot = makeTempDir('station-claude-managed-');
    managed('managed-settings.json', { permissions: { deny: ['WebFetch'] } });
    managed('managed-settings.d/10-other.json', {
      pluginConfigs: {
        'other@market': { options: { projectInstructions: 1 } },
      },
    });
    managed('managed-settings.d/notes.txt', legacyNone);
    expect((await startOptions()).settings).toEqual(STATION_SETTING);
  });

  test('drop-ins the engine skips are skipped: a dot-prefixed name, a folder, a non-.json name', async () => {
    const legacyNone = {
      pluginConfigs: {
        'agents-md@builtin': { options: { projectInstructions: 'none' } },
      },
    };
    configHome();
    managed('managed-settings.d/.disabled-policy.json', legacyNone);
    managed('managed-settings.d/policy.json.off', legacyNone);
    mkdirSync(join(managedRoot, 'managed-settings.d', '20-folder.json'));
    expect((await startOptions()).settings).toEqual(STATION_SETTING);
    // Control: the same choice under a name the engine reads is kept.
    managed('managed-settings.d/30-policy.json', legacyNone);
    expect((await startOptions()).settings).toBeUndefined();
  });

  test('a file in place of managed-settings.d is no drop-ins, as the engine reads it', async () => {
    configHome();
    writeFileSync(join(managedRoot, 'managed-settings.d'), '');
    expect((await startOptions()).settings).toEqual(STATION_SETTING);
  });

  test('the drop-in cap counts only drop-ins the engine reads', async () => {
    configHome();
    const dropIns = join(managedRoot, 'managed-settings.d');
    mkdirSync(dropIns);
    for (let index = 0; index < CLAUDE_MANAGED_DROP_IN_MAX_FILES; index += 1) {
      writeFileSync(
        join(dropIns, `${String(index).padStart(3, '0')}.json`),
        '{}',
      );
      writeFileSync(join(dropIns, `.${index}-disabled.json`), '{}');
    }
    // At the cap, with as many skipped names again: read and set.
    expect((await startOptions()).settings).toEqual(STATION_SETTING);
    // One more drop-in the engine reads: Station cannot read them all.
    writeFileSync(join(dropIns, 'zzz.json'), '{}');
    expect((await startOptions()).settings).toBeUndefined();
  });

  test('a relative CLAUDE_CONFIG_DIR is read where the engine reads it: under the session cwd', async () => {
    const repo = makeTempDir('station-claude-relative-');
    mkdirSync(join(repo, 'cfg'));
    writeFileSync(
      join(repo, 'cfg', 'settings.json'),
      JSON.stringify({
        pluginConfigs: {
          'agents-md@builtin': { options: { instructionFiles: 'claude-md' } },
        },
      }),
    );
    vi.stubEnv('CLAUDE_CONFIG_DIR', 'cfg');
    // Station's own cwd has no cfg/settings.json; the session cwd does.
    expect(process.cwd()).not.toBe(repo);
    expect((await startOptions({ cwd: repo })).settings).toBeUndefined();
  });
});

describe.skipIf(process.platform === 'win32')(
  'a FIFO as the settings file',
  () => {
    test('is refused at once rather than blocking the session start', async () => {
      const home = makeTempDir('station-claude-fifo-');
      execFileSync('mkfifo', [join(home, 'settings.json')], {
        windowsHide: true,
      });
      const module = join(__dirname, '../adapters/claude-instruction-files.ts');
      // A blocking open would stall this process's event loop for good, so the
      // call runs in a child that is killed if it has not returned in time.
      const code = `
      const { claudeInstructionFilesSettings } = await import(${JSON.stringify(module)});
      process.stdout.write('AT_CALL\\n');
      const decision = claudeInstructionFilesSettings(${JSON.stringify(home)}, { managedRoot: ${JSON.stringify(managedRoot)} });
      process.stdout.write(JSON.stringify(decision) + '\\n');
    `;
      const outcome = await new Promise<{ output: string; blocked: boolean }>(
        (resolve, reject) => {
          const child = spawn(
            process.execPath,
            ['--import', 'tsx', '--input-type=module', '--eval', code],
            { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
          );
          let output = '';
          let stderr = '';
          let blocked = false;
          let callTimer: ReturnType<typeof setTimeout> | undefined;
          const startup = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error(`child did not reach the call: ${stderr}`));
          }, 30_000);
          child.stdout.on('data', (chunk) => {
            output += chunk.toString();
            if (output.includes('AT_CALL') && !callTimer) {
              clearTimeout(startup);
              callTimer = setTimeout(() => {
                blocked = true;
                child.kill('SIGKILL');
              }, 5_000);
            }
          });
          child.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
          });
          child.on('error', reject);
          child.on('exit', () => {
            clearTimeout(startup);
            clearTimeout(callTimer);
            resolve({ output, blocked });
          });
        },
      );
      expect(outcome.blocked, 'the call returned without a writer').toBe(false);
      const decision = JSON.parse(outcome.output.split('\n')[1] ?? 'null');
      expect(decision).toMatchObject({
        reason: expect.stringContaining('not a regular file'),
      });
      expect(decision.settings).toBeUndefined();
    }, 60_000);
  },
);

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
