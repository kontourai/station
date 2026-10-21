/**
 * #1940: an engine's sign-in status comes from its documented status command
 * (the built-in descriptor's argv and rule), run for real against stub
 * programs that print what the vendor's command prints, or from what the
 * engine itself said. Never from an exit code the vendor does not define.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { AcpAdapter } from '../../../providers/adapters/acp-adapter.js';
import { BUILTIN_ACP_ENGINES } from '../../../providers/llm/builtin-acp-engines.js';
import {
  clearAll,
  registerACPConnectionRegistryProvider,
} from '../../../providers/registries/registry.js';
import {
  clearEngineSignInRefusal,
  engineSignInStatus,
  readStatusCommandResult,
  recordEngineAuthenticated,
  recordEngineSignInRefused,
  resetEngineAuthStatus,
  setEngineStatusTestHooks,
} from '../engine-auth-status.js';
import {
  EngineCredentials,
  registerEngineCredentials,
} from '../engine-credentials.js';

const posix = process.platform !== 'win32';
const makeTempDir = trackTempDirs();

beforeEach(() => {
  registerACPConnectionRegistryProvider(
    { listAvailable: () => BUILTIN_ACP_ENGINES.map((entry) => ({ ...entry })) },
    'builtin-acp-connections',
    true,
  );
});
afterEach(() => {
  clearAll();
  resetEngineAuthStatus();
  setEngineStatusTestHooks({});
  registerEngineCredentials(null);
});

/**
 * A stub of one engine program: records each argv (and its pid) and prints
 * `stdout`, exiting with `code`. `--version` answers like any engine would.
 */
function stubEngine(
  program: string,
  body: { stdout?: string; code?: number; script?: string },
): { command: string; calls: () => string[][]; dir: string } {
  const dir = makeTempDir('station-engine-status-');
  const record = join(dir, 'calls.jsonl');
  const out = join(dir, 'stdout.txt');
  writeFileSync(out, body.stdout ?? '');
  const command = join(dir, program);
  writeFileSync(
    command,
    `#!/bin/sh
printf '%s\\n' "$*" >> '${record}'
echo $$ > '${dir}/pid'
${body.script ?? `cat '${out}'\nexit ${body.code ?? 0}`}
`,
  );
  chmodSync(command, 0o755);
  return {
    command,
    dir,
    calls: () =>
      existsSync(record)
        ? readFileSync(record, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((line) => line.split(' '))
        : [],
  };
}

describe.runIf(posix)('built-in status commands, run for real', () => {
  test.each([
    // Kiro: strings in the kiro-cli binary and its open-source ancestor.
    ['kiro-cli', 'Logged in with Builder ID\n', 0, 'authenticated'],
    ['kiro-cli', 'Not logged in\n', 1, 'unauthenticated'],
    // Exit 0 with output the rule does not name is not "signed in".
    ['kiro-cli', 'kiro-cli 2.33.0\n', 0, 'unknown'],
    // Cursor: `status` exits 0 either way; the JSON field decides.
    [
      'cursor-agent',
      '{"status":"authenticated","isAuthenticated":true}\n',
      0,
      'authenticated',
    ],
    [
      'cursor-agent',
      '{"status":"unauthenticated","isAuthenticated":false,"message":"Not logged in"}\n',
      0,
      'unauthenticated',
    ],
    ['cursor-agent', 'not json\n', 0, 'unknown'],
  ] as const)(
    '%s printing %j (exit %d) reads as %s',
    async (program, stdout, code, expected) => {
      const stub = stubEngine(program, { stdout, code });
      const status = await engineSignInStatus({
        id: `${program}-test`,
        command: stub.command,
      });
      expect(status.state).toBe(expected);
      expect(status.checkable).toBe(true);
      if (expected !== 'unknown') expect(status.source).toBe('status-command');
      // The descriptor's argv, run on the connection's own binary, no shell.
      expect(stub.calls()).toEqual([
        program === 'kiro-cli' ? ['whoami'] : ['status', '--format', 'json'],
      ]);
    },
  );

  test('an engine with no documented status command is never run and stays unknown', async () => {
    const stub = stubEngine('goose', { stdout: 'Auth: ok\n' });
    const status = await engineSignInStatus({ id: 'g', command: stub.command });
    expect(status).toEqual({
      state: 'unknown',
      source: 'none',
      checkable: false,
    });
    expect(stub.calls()).toEqual([]);
  });

  test('a status command that overruns its deadline is killed and reads as unknown', async () => {
    setEngineStatusTestHooks({ timeoutMs: 300 });
    const stub = stubEngine('kiro-cli', { script: 'exec sleep 30' });
    const started = Date.now();
    const status = await engineSignInStatus({ id: 'k', command: stub.command });
    expect(status.state).toBe('unknown');
    expect(Date.now() - started).toBeLessThan(5_000);
    const pid = Number(readFileSync(join(stub.dir, 'pid'), 'utf8'));
    // `exec` made the stub's pid the sleeper itself: it must be gone.
    expect(() => process.kill(pid, 0)).toThrow();
  });

  test('output past the cap reads as unknown, even when it names a state', async () => {
    const stub = stubEngine('kiro-cli', {
      script: `printf 'Logged in with Builder ID\\n'; head -c 200000 /dev/zero | tr '\\0' 'x'`,
    });
    const status = await engineSignInStatus({ id: 'k', command: stub.command });
    expect(status.state).toBe('unknown');
  });

  test('an answer is reused within the TTL and rerun on refresh', async () => {
    let clock = 1_000_000;
    setEngineStatusTestHooks({ now: () => clock });
    const stub = stubEngine('kiro-cli', {
      stdout: 'Logged in with Builder ID',
    });
    const connection = { id: 'k', command: stub.command };
    await engineSignInStatus(connection);
    await engineSignInStatus(connection);
    expect(stub.calls()).toHaveLength(1);
    await engineSignInStatus(connection, { refresh: true });
    expect(stub.calls()).toHaveLength(2);
    clock += 61_000;
    await engineSignInStatus(connection);
    expect(stub.calls()).toHaveLength(3);
  });

  test('with a stored key present, a "signed out" answer is not trusted', async () => {
    const home = makeTempDir('station-engine-status-home-');
    const credentials = new EngineCredentials(home);
    registerEngineCredentials(credentials);
    const seen = join(makeTempDir('station-engine-status-seen-'), 'key');
    const stub = stubEngine('cursor-agent', {
      script: `printf '%s' "$CURSOR_API_KEY" > '${seen}'; printf '{"isAuthenticated":false}'`,
    });
    const connection = { id: 'cursor-key', command: stub.command };
    await credentials.set(connection.id, 'CURSOR_API_KEY', 'ck-123', [
      'CURSOR_API_KEY',
    ]);
    const status = await engineSignInStatus(connection);
    // The status command ran with this connection's key...
    expect(readFileSync(seen, 'utf8')).toBe('ck-123');
    // ...and said signed out, which it cannot be shown to have checked.
    expect(status.state).toBe('unknown');
  });
});

describe.runIf(posix)('the engine readiness row', () => {
  async function authRow(stdout: string) {
    const stub = stubEngine('cursor-agent', { stdout });
    const adapter = new AcpAdapter({
      getConnections: async () => [
        { id: 'cursor', name: 'Cursor', command: stub.command, enabled: true },
      ],
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });
    const rows = await adapter.getPrerequisites({ connectionId: 'cursor' });
    return rows.find((row) => row.id.endsWith('-auth'));
  }

  test('reads the status command: signed out is a required, missing sign-in', async () => {
    expect(await authRow('{"isAuthenticated":false}')).toMatchObject({
      status: 'missing',
      category: 'required',
    });
  });

  test('reads the status command: signed in is installed', async () => {
    expect(await authRow('{"isAuthenticated":true}')).toMatchObject({
      status: 'installed',
    });
  });

  test('an inconclusive check is optional and says it could not tell', async () => {
    const row = await authRow('{}');
    expect(row).toMatchObject({ status: 'error', category: 'optional' });
    expect(row?.description).toContain('could not tell whether Cursor');
  });

  test('a refusal alone never gates readiness', async () => {
    recordEngineSignInRefused('cursor');
    expect(await authRow('{}')).toMatchObject({ category: 'optional' });
  });
});

describe('what the engine said', () => {
  const engine = { id: 'pi', command: 'pi-acp' };

  test('a refusal reads as signed out until a later answer clears it', async () => {
    recordEngineSignInRefused(engine.id);
    expect(await engineSignInStatus(engine)).toMatchObject({
      state: 'unauthenticated',
      source: 'refusal',
    });
    // Readiness never gates on it: a refusal is only cleared by a later
    // answered prompt, which a gate would prevent.
    expect(
      (await engineSignInStatus(engine, { commandOnly: true })).state,
    ).toBe('unknown');
    clearEngineSignInRefusal(engine.id);
    expect((await engineSignInStatus(engine)).state).toBe('unknown');
  });

  test('a finished sign-in reads as signed in, and an answer does not clear it', async () => {
    recordEngineAuthenticated(engine.id);
    clearEngineSignInRefusal(engine.id);
    expect(await engineSignInStatus(engine)).toMatchObject({
      state: 'authenticated',
      source: 'sign-in',
    });
  });
});

describe('readStatusCommandResult', () => {
  const ok = (stdout: string, code: number | null = 0) => ({
    stdout,
    stderr: '',
    code,
  });

  test('exit 0 alone is unknown unless the rule says the vendor defines it', () => {
    expect(readStatusCommandResult(ok(''), { signedOutText: ['nope'] })).toBe(
      'unknown',
    );
    expect(
      readStatusCommandResult(ok(''), { exitZeroMeansSignedIn: true }),
    ).toBe('authenticated');
  });

  test('a signed-out exit code and text win over exit 0 readings', () => {
    expect(
      readStatusCommandResult(ok('', 3), {
        signedOutExitCodes: [3],
        exitZeroMeansSignedIn: true,
      }),
    ).toBe('unauthenticated');
    expect(
      readStatusCommandResult(ok('Logged in. Not logged in to org.'), {
        signedOutText: ['not logged in'],
        signedInText: ['logged in'],
      }),
    ).toBe('unauthenticated');
  });

  test('a signed-in reading needs exit 0; a timed-out or truncated run is unknown', () => {
    expect(
      readStatusCommandResult(ok('Logged in', 1), {
        signedInText: ['logged in'],
      }),
    ).toBe('unknown');
    expect(
      readStatusCommandResult(
        { ...ok('Logged in'), timedOut: true },
        { signedInText: ['logged in'] },
      ),
    ).toBe('unknown');
    expect(
      readStatusCommandResult(
        { ...ok('Logged in'), outputTruncated: true },
        { signedInText: ['logged in'] },
      ),
    ).toBe('unknown');
  });
});
