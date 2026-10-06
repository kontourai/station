import { chmod, mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  detectClaudeAuthState,
  parseClaudeAuthStatus,
} from '../claude-auth.js';
import { runCliCommand } from '../cli-auth.js';

describe('detectClaudeAuthState', () => {
  test('accepts explicit API authentication without touching the CLI', async () => {
    await expect(
      detectClaudeAuthState({ ANTHROPIC_API_KEY: 'configured' }, '/missing'),
    ).resolves.toBe('authenticated');
  });

  test('recognizes a user-owned OAuth credential without exposing it', async () => {
    const home = await mkdtemp(join(tmpdir(), 'station-claude-auth-'));
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
    const home = await mkdtemp(join(tmpdir(), 'station-claude-auth-'));
    await expect(detectClaudeAuthState({}, home)).resolves.toBe(
      'unauthenticated',
    );
  });

  test('fails closed on malformed credential state', async () => {
    const home = await mkdtemp(join(tmpdir(), 'station-claude-auth-'));
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
