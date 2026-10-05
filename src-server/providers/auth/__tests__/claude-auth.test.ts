import { chmod, mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  detectClaudeAuthState,
  parseClaudeAuthStatus,
} from '../claude-auth.js';
import { runCliCommand } from '../cli-auth.js';

const makeTempDir = trackTempDirs();

const secure = vi.hoisted(() => ({
  platform: 'darwin',
  userInfoFailure: false,
  calls: [] as string[][],
  result: undefined as string | undefined,
  failure: undefined as
    | { code?: number | string; killed?: boolean }
    | undefined,
}));
vi.mock('node:os', async (original) => ({
  ...(await original<typeof import('node:os')>()),
  platform: () => secure.platform,
  homedir: () => '/missing',
  userInfo: () => {
    if (secure.userInfoFailure) throw new Error('fixture user lookup failure');
    return { username: 'fixture-user' };
  },
}));
vi.mock('node:child_process', async (original) => {
  const real = await original<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  const execFile = (
    command: string,
    args: string[],
    options: unknown,
    callback: (error: unknown, stdout: string, stderr: string) => void,
  ) => {
    if (command !== '/usr/bin/security')
      return Reflect.apply(real.execFile, undefined, [
        command,
        args,
        options,
        callback,
      ]);
    secure.calls.push(args);
    callback(
      secure.failure ?? (secure.result === undefined ? { code: 44 } : null),
      secure.result ?? '',
      '',
    );
  };
  Object.defineProperty(execFile, promisify.custom, {
    value: promisify(real.execFile),
  });
  return { ...real, execFile };
});

beforeEach(() => {
  secure.platform = 'darwin';
  secure.userInfoFailure = false;
  secure.calls = [];
  secure.result = undefined;
  secure.failure = undefined;
});

describe('detectClaudeAuthState', () => {
  test.each([
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN',
  ])(
    'accepts explicit %s authentication without touching the CLI',
    async (key) => {
      await expect(
        detectClaudeAuthState({ [key]: 'configured' }, '/missing'),
      ).resolves.toBe('authenticated');
      expect(secure.calls).toEqual([]);
    },
  );

  test('recognizes the selected secure credential without a credential file', async () => {
    secure.result = JSON.stringify({
      claudeAiOauth: { refreshToken: 'fixture-token' },
    });
    await expect(
      detectClaudeAuthState({ USER: 'fixture-user' }, '/missing'),
    ).resolves.toBe('authenticated');
    expect(secure.calls).toEqual([
      [
        'find-generic-password',
        '-a',
        'fixture-user',
        '-w',
        '-s',
        'Claude Code-credentials',
      ],
    ]);
  });

  test.each([' fixture-user ', 'invalid/account'])(
    'refuses an invalid selected Keychain account %j without borrowing another account',
    async (user) => {
      secure.result = JSON.stringify({
        claudeAiOauth: { accessToken: 'fixture-token' },
      });
      await expect(
        detectClaudeAuthState({ USER: user }, '/missing'),
      ).resolves.toBe('unknown');
      expect(secure.calls).toEqual([]);
    },
  );

  test('retains an OS username lookup failure as unknown without querying another account', async () => {
    secure.userInfoFailure = true;
    await expect(detectClaudeAuthState({}, '/missing')).resolves.toBe(
      'unknown',
    );
    expect(secure.calls).toEqual([]);
  });

  test('uses the secure-store override without borrowing a global credential', async () => {
    await expect(
      detectClaudeAuthState(
        {
          USER: 'fixture-user',
          CLAUDE_CONFIG_DIR: '/qa/config',
          CLAUDE_SECURESTORAGE_CONFIG_DIR: '/qa/secure',
        },
        '/missing',
      ),
    ).resolves.toBe('unauthenticated');
    expect(secure.calls).toEqual([
      [
        'find-generic-password',
        '-a',
        'fixture-user',
        '-w',
        '-s',
        'Claude Code-credentials-c7724621',
      ],
    ]);
  });

  test.each([
    ['', 'Claude Code-credentials'],
    [' /qa/secure ', 'Claude Code-credentials-569775b7'],
  ])(
    'preserves the selected secure override %j namespace',
    async (storage, service) => {
      secure.result = JSON.stringify({
        claudeAiOauth: { accessToken: 'fixture-token' },
      });
      await expect(
        detectClaudeAuthState(
          {
            CLAUDE_CONFIG_DIR: '/qa/config',
            CLAUDE_SECURESTORAGE_CONFIG_DIR: storage,
          },
          '/missing',
        ),
      ).resolves.toBe('authenticated');
      expect(secure.calls).toEqual([
        ['find-generic-password', '-a', 'fixture-user', '-w', '-s', service],
      ]);
    },
  );

  test.each([
    ['', 'Claude Code-credentials'],
    [' /qa/config ', 'Claude Code-credentials-1c810106'],
    ['   ', 'Claude Code-credentials-0aad7da7'],
  ])(
    'preserves the selected config value %j namespace',
    async (config, service) => {
      secure.result = JSON.stringify({
        claudeAiOauth: { accessToken: 'fixture-token' },
      });
      await expect(
        detectClaudeAuthState({ CLAUDE_CONFIG_DIR: config }, '/missing'),
      ).resolves.toBe('authenticated');
      expect(secure.calls).toEqual([
        ['find-generic-password', '-a', 'fixture-user', '-w', '-s', service],
      ]);
    },
  );

  test('does not trim the selected config credential-file directory', async () => {
    secure.platform = 'linux';
    const home = makeTempDir('station-claude-auth-');
    const selected = join(home, 'config ');
    const other = join(home, 'config');
    await mkdir(selected);
    await mkdir(other);
    await writeFile(
      join(other, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'different-account' } }),
      { mode: 0o600 },
    );
    const env = { CLAUDE_CONFIG_DIR: selected };
    await expect(detectClaudeAuthState(env, home)).resolves.toBe(
      'unauthenticated',
    );
    await writeFile(
      join(selected, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { refreshToken: 'selected-account' } }),
      { mode: 0o600 },
    );
    await writeFile(join(other, '.credentials.json'), '{}', { mode: 0o600 });
    await expect(detectClaudeAuthState(env, home)).resolves.toBe(
      'authenticated',
    );
  });

  test('keeps credential-file fallback in the selected secure-storage directory', async () => {
    const home = makeTempDir('station-claude-auth-');
    const config = join(home, 'config');
    const storage = join(home, 'secure');
    await mkdir(config);
    await mkdir(storage);
    await writeFile(
      join(config, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'different-account' } }),
      { mode: 0o600 },
    );
    const env = {
      CLAUDE_CONFIG_DIR: config,
      CLAUDE_SECURESTORAGE_CONFIG_DIR: storage,
    };
    const probe = vi.fn().mockResolvedValue({
      stdout: '{"loggedIn":false}',
      stderr: '',
      code: 1,
    });
    await expect(detectClaudeAuthState(env, home, probe)).resolves.toBe(
      'unauthenticated',
    );
    expect(probe).toHaveBeenCalledTimes(1);
    await writeFile(
      join(storage, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { refreshToken: 'selected-account' } }),
      { mode: 0o600 },
    );
    await writeFile(join(config, '.credentials.json'), '{}', { mode: 0o600 });
    probe.mockClear();
    await expect(detectClaudeAuthState(env, home, probe)).resolves.toBe(
      'authenticated',
    );
    expect(probe).not.toHaveBeenCalled();
  });

  test('an empty secure-storage override selects the default credential-file directory', async () => {
    secure.platform = 'linux';
    const home = makeTempDir('station-claude-auth-');
    await mkdir(join(home, '.claude'));
    await mkdir(join(home, 'config'));
    await writeFile(
      join(home, '.claude', '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { refreshToken: 'selected-account' } }),
      { mode: 0o600 },
    );
    await expect(
      detectClaudeAuthState(
        {
          CLAUDE_CONFIG_DIR: join(home, 'config'),
          CLAUDE_SECURESTORAGE_CONFIG_DIR: '',
        },
        home,
      ),
    ).resolves.toBe('authenticated');
    expect(secure.calls).toEqual([]);
  });

  test.each([{ code: 36 }, { code: 'ENOENT' }, { code: 44, killed: true }])(
    'retains an unreadable secure-store result as unknown: %j',
    async (failure) => {
      secure.failure = failure;
      await expect(detectClaudeAuthState({}, '/missing')).resolves.toBe(
        'unknown',
      );
    },
  );

  test('does not borrow a file credential after malformed secure state', async () => {
    const home = makeTempDir('station-claude-auth-');
    await mkdir(join(home, '.claude'));
    await writeFile(
      join(home, '.claude', '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'file-token' } }),
    );
    secure.result = '{';
    await expect(detectClaudeAuthState({}, home)).resolves.toBe('unknown');
  });

  test('recognizes a user-owned OAuth credential without exposing it', async () => {
    const home = makeTempDir('station-claude-auth-');
    await mkdir(join(home, '.claude'));
    await writeFile(
      join(home, '.claude', '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { refreshToken: 'private-value' } }),
      { mode: 0o600 },
    );

    await expect(detectClaudeAuthState({}, home)).resolves.toBe(
      'authenticated',
    );
  });

  test('reports absent credentials as unauthenticated', async () => {
    const home = makeTempDir('station-claude-auth-');
    await expect(detectClaudeAuthState({}, home)).resolves.toBe(
      'unauthenticated',
    );
  });

  test('fails closed on malformed credential state', async () => {
    const home = makeTempDir('station-claude-auth-');
    await mkdir(join(home, '.claude'));
    await writeFile(join(home, '.claude', '.credentials.json'), '{');
    await expect(detectClaudeAuthState({}, home)).resolves.toBe('unknown');
  });
});

describe('detectClaudeAuthState with a login probe (#3303)', () => {
  const makeTempDir = trackTempDirs();
  const result = (stdout: string, code = 0) => ({ stdout, stderr: '', code });

  /** A home whose config dir exists but holds no credentials file (macOS Keychain). */
  function keychainHome() {
    const home = makeTempDir('station-claude-keychain-');
    return mkdir(join(home, '.claude')).then(() => home);
  }

  test('no credentials file and the probe reports logged in is authenticated', async () => {
    const home = await keychainHome();
    const probe = vi.fn().mockResolvedValue(result('{"loggedIn":true}'));
    await expect(detectClaudeAuthState({}, home, probe)).resolves.toBe(
      'authenticated',
    );
    expect(probe).toHaveBeenCalledTimes(1);
  });

  test('the probe reporting logged out is unauthenticated, even with exit 1', async () => {
    const home = await keychainHome();
    const probe = vi.fn().mockResolvedValue(result('{"loggedIn":false}', 1));
    await expect(detectClaudeAuthState({}, home, probe)).resolves.toBe(
      'unauthenticated',
    );
  });

  test.each([
    ['exits non-zero without JSON', result('error', 2)],
    ['prints garbage', result('<html>')],
    ['prints nothing', result('')],
    ['prints JSON without loggedIn', result('{"ok":true}')],
    ['prints a non-boolean loggedIn', result('{"loggedIn":"true"}')],
    [
      'is cut at the capture bound',
      { ...result('{"loggedIn":true'), outputTruncated: true as const },
    ],
    [
      'is killed at its deadline',
      { ...result('{"loggedIn":true}', 1), timedOut: true as const },
    ],
    ['fails to spawn', null],
  ])('a probe that %s is unknown', async (_name, probeResult) => {
    const home = await keychainHome();
    const probe = vi.fn().mockResolvedValue(probeResult);
    await expect(detectClaudeAuthState({}, home, probe)).resolves.toBe(
      'unknown',
    );
  });

  test('a probe that rejects is unknown', async () => {
    const home = await keychainHome();
    const probe = vi.fn().mockRejectedValue(new Error('spawn failed'));
    await expect(detectClaudeAuthState({}, home, probe)).resolves.toBe(
      'unknown',
    );
  });

  test('the env fast path and a credentials file never reach the probe', async () => {
    const home = await keychainHome();
    const probe = vi.fn().mockResolvedValue(result('{"loggedIn":false}'));
    await expect(
      detectClaudeAuthState({ ANTHROPIC_API_KEY: 'k' }, home, probe),
    ).resolves.toBe('authenticated');
    await writeFile(
      join(home, '.claude', '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 't' } }),
    );
    await expect(detectClaudeAuthState({}, home, probe)).resolves.toBe(
      'authenticated',
    );
    expect(probe).not.toHaveBeenCalled();
  });

  test('a missing config dir is not probed and nothing is created', async () => {
    const home = makeTempDir('station-claude-keychain-');
    const probe = vi.fn().mockResolvedValue(result('{"loggedIn":true}'));
    await expect(detectClaudeAuthState({}, home, probe)).resolves.toBe(
      'unauthenticated',
    );
    expect(probe).not.toHaveBeenCalled();
    expect(await readdir(home)).toEqual([]);
  });

  test('CLAUDE_CONFIG_DIR picks the dir that must exist', async () => {
    const home = await keychainHome();
    const probe = vi.fn().mockResolvedValue(result('{"loggedIn":true}'));
    await expect(
      detectClaudeAuthState(
        { CLAUDE_CONFIG_DIR: join(home, 'elsewhere') },
        home,
        probe,
      ),
    ).resolves.toBe('unauthenticated');
    expect(probe).not.toHaveBeenCalled();
  });

  test('a secure-storage override does not allow a probe to create a missing CLI config directory', async () => {
    const home = await keychainHome();
    const config = join(home, 'missing-config');
    const probe = vi.fn().mockResolvedValue(result('{"loggedIn":true}'));
    await expect(
      detectClaudeAuthState(
        {
          CLAUDE_CONFIG_DIR: config,
          CLAUDE_SECURESTORAGE_CONFIG_DIR: join(home, '.claude'),
        },
        home,
        probe,
      ),
    ).resolves.toBe('unauthenticated');
    expect(probe).not.toHaveBeenCalled();
    expect(await readdir(home)).toEqual(['.claude']);
  });

  test('without a probe the answer stays file-only', async () => {
    const home = await keychainHome();
    await expect(detectClaudeAuthState({}, home)).resolves.toBe(
      'unauthenticated',
    );
  });

  test('parseClaudeAuthStatus reads only an explicit boolean', () => {
    expect(parseClaudeAuthStatus(result('{"loggedIn":true}'))).toBe(
      'authenticated',
    );
    expect(parseClaudeAuthStatus(result('[true]'))).toBe('unknown');
    expect(parseClaudeAuthStatus(result('null'))).toBe('unknown');
  });
});

// The real child-process seam: a stub `claude` that answers from the config dir
// it is handed, run through the shared `runCliCommand` the adapter uses.
describe.skipIf(process.platform === 'win32')(
  'detectClaudeAuthState against a stub claude executable (#3303)',
  () => {
    const makeTempDir = trackTempDirs();

    async function stubClaude(body: string) {
      const dir = makeTempDir('station-claude-stub-');
      const path = join(dir, 'claude');
      await writeFile(path, `#!/bin/sh\n${body}\n`);
      await chmod(path, 0o755);
      return path;
    }

    async function probeVia(
      stub: string,
      configDir: string,
      timeoutMs = 5000,
      maxBuffer = 64 * 1024,
    ) {
      return detectClaudeAuthState(
        { CLAUDE_CONFIG_DIR: configDir },
        '/unused',
        () =>
          runCliCommand(
            stub,
            ['auth', 'status', '--json'],
            undefined,
            { CLAUDE_CONFIG_DIR: configDir },
            { timeoutMs, maxBuffer, killSignal: 'SIGKILL' },
          ),
      );
    }

    // Logged in only if the config dir it was handed holds a marker, so a probe
    // that dropped CLAUDE_CONFIG_DIR could not pass.
    const keychainStub =
      '[ "$1 $2 $3" = "auth status --json" ] || exit 9\n' +
      'if [ -f "$CLAUDE_CONFIG_DIR/logged-in" ]; then echo \'{"loggedIn":true}\'; else echo \'{"loggedIn":false}\'; exit 1; fi';

    test('logged in and logged out, by the config dir passed through', async () => {
      const stub = await stubClaude(keychainStub);
      const loggedIn = makeTempDir('station-claude-cfg-');
      await writeFile(join(loggedIn, 'logged-in'), '');
      const loggedOut = makeTempDir('station-claude-cfg-');
      await expect(probeVia(stub, loggedIn)).resolves.toBe('authenticated');
      await expect(probeVia(stub, loggedOut)).resolves.toBe('unauthenticated');
    });

    test('non-zero exit, garbage and a hang are unknown', async () => {
      const cfg = makeTempDir('station-claude-cfg-');
      await expect(
        probeVia(await stubClaude('echo broken >&2; exit 3'), cfg),
      ).resolves.toBe('unknown');
      await expect(
        probeVia(await stubClaude('echo "welcome to claude"'), cfg),
      ).resolves.toBe('unknown');
      // Prints a logged-in answer, then hangs past the deadline.
      await expect(
        probeVia(
          await stubClaude('echo \'{"loggedIn":true}\'; sleep 5'),
          cfg,
          300,
        ),
      ).resolves.toBe('unknown');
    });

    test('output past the capture bound is unknown, flagged as truncated', async () => {
      const cfg = makeTempDir('station-claude-cfg-');
      const stub = await stubClaude(
        'printf \'{"loggedIn":true,"pad":"%s"}\' "$(head -c 4000 /dev/zero | tr \'\\0\' a)"',
      );
      await expect(probeVia(stub, cfg, 5000, 512)).resolves.toBe('unknown');
      const raw = await runCliCommand(stub, [], undefined, undefined, {
        maxBuffer: 512,
      });
      expect(raw?.outputTruncated).toBe(true);
      expect(raw?.timedOut).toBeUndefined();
    });

    test('a child that ignores SIGTERM is still killed at the deadline', async () => {
      const dir = makeTempDir('station-claude-stub-');
      const stub = join(dir, 'claude');
      await writeFile(
        stub,
        `#!${process.execPath}\nprocess.on('SIGTERM', () => {});\nconsole.log('{"loggedIn":true}');\nsetInterval(() => {}, 1000);\n`,
      );
      await chmod(stub, 0o755);
      const startedAt = Date.now();
      const raw = await runCliCommand(stub, [], undefined, undefined, {
        timeoutMs: 400,
        killSignal: 'SIGKILL',
      });
      expect(raw?.timedOut).toBe(true);
      expect(raw?.outputTruncated).toBeUndefined();
      expect(Date.now() - startedAt).toBeLessThan(4000);
      await expect(
        probeVia(stub, makeTempDir('station-claude-cfg-'), 400),
      ).resolves.toBe('unknown');
    });
  },
);
