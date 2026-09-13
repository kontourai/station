import { describe, expect, test, vi } from 'vitest';
import type { EnrolmentAuthState } from '../credential-enrolment.js';
import {
  DEVICE_CODE_LOGIN_TIMEOUT_MS,
  DEVICE_CODE_MAX_LIVE_LOGINS,
  DEVICE_CODE_PROMPT_TIMEOUT_MS,
  type DeviceCodeChildProcess,
  type DeviceCodeLoginDeps,
  DeviceCodeLoginManager,
  parseDeviceCodePrompt,
} from '../device-code-login.js';
import type { EngineLoginCapabilities } from '../engine-login-capabilities.js';
import {
  CODEX_DEVICE_CODE_EXPECTED,
  CODEX_DEVICE_CODE_STDOUT,
  MUSE_DEVICE_CODE_EXPECTED,
  MUSE_DEVICE_CODE_STDOUT,
} from './device-code-cli-output.js';

const PROFILE_DIR = '/app-homes/credential-profile-abc';

class FakeStream {
  #listener?: (chunk: unknown) => void;
  on(_event: 'data', listener: (chunk: unknown) => void) {
    this.#listener = listener;
    return this;
  }
  write(text: string) {
    this.#listener?.(Buffer.from(text, 'utf8'));
  }
}

class FakeChild implements DeviceCodeChildProcess {
  readonly stdout = new FakeStream() as unknown as NodeJS.ReadableStream & {
    write(text: string): void;
  };
  readonly stderr = new FakeStream() as unknown as NodeJS.ReadableStream & {
    write(text: string): void;
  };
  readonly signals: string[] = [];
  #exit?: (code: number | null) => void;
  #error?: (error: Error) => void;

  on(event: 'exit' | 'error', listener: never) {
    if (event === 'exit') this.#exit = listener;
    else this.#error = listener;
    return this;
  }
  kill(signal?: NodeJS.Signals) {
    this.signals.push(signal ?? 'SIGTERM');
    return true;
  }
  emitExit(code: number | null) {
    this.#exit?.(code);
  }
  emitError(error: Error) {
    this.#error?.(error);
  }
}

function manualScheduler() {
  const timers: Array<{
    run: () => void;
    delayMs: number;
    cancelled: boolean;
  }> = [];
  return {
    schedule(run: () => void, delayMs: number) {
      const timer = { run, delayMs, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    /** Run every live timer registered for exactly this delay. */
    fire(delayMs: number) {
      for (const timer of [...timers]) {
        if (!timer.cancelled && timer.delayMs === delayMs) timer.run();
      }
    },
    liveCount() {
      return timers.filter((timer) => !timer.cancelled).length;
    },
  };
}

function capabilitiesWith(
  argument: string | undefined,
  mechanism: 'device-code' | 'api-key-stdin' = 'device-code',
): EngineLoginCapabilities {
  return {
    engine: 'codex',
    observedAt: '2026-09-11T00:00:00.000Z',
    evidence: [
      {
        mechanism,
        observedCommand: ['codex', 'login', '--help'],
        observedMatch: argument ?? 'stdin',
        ...(argument ? { argument } : {}),
      },
    ],
  };
}

const BASE_ENV = { PATH: '/usr/bin', TMPDIR: '/tmp/station-engine' };

function harness(
  overrides: {
    capabilities?: EngineLoginCapabilities;
    /** What the engine reports BEFORE the login is spawned. */
    preAuthState?: EnrolmentAuthState;
    /** What the engine reports once a login process has exited. */
    authState?: EnrolmentAuthState;
    authDetail?: string;
    schedule?: DeviceCodeLoginDeps['schedule'];
    baseEnv?: DeviceCodeLoginDeps['baseEnv'];
  } = {},
) {
  const children: FakeChild[] = [];
  const spawned: Array<{
    command: string;
    args: string[];
    env: NodeJS.ProcessEnv;
    windowsHide: boolean;
  }> = [];
  const scheduler = manualScheduler();
  // The engine is asked twice in a login's life: before the spawn (is this
  // profile already signed in?) and after the process exits (did an account
  // land?). The real answer changes exactly when a login process exits, so the
  // harness answers `preAuthState` until one has, and `authState` after.
  let exits = 0;
  const verify = vi.fn(async () =>
    exits === 0
      ? {
          state:
            overrides.preAuthState ?? ('unauthenticated' as EnrolmentAuthState),
        }
      : {
          state: overrides.authState ?? ('authenticated' as EnrolmentAuthState),
          ...(overrides.authDetail ? { detail: overrides.authDetail } : {}),
        },
  );
  const spawnLogin = vi.fn((command: string, args: string[], options) => {
    spawned.push({ ...options, command, args });
    const child = new FakeChild();
    const emitExit = child.emitExit.bind(child);
    child.emitExit = (code: number | null) => {
      exits += 1;
      emitExit(code);
    };
    children.push(child);
    return child as unknown as DeviceCodeChildProcess;
  });
  const capabilities = vi.fn(
    async () => overrides.capabilities ?? capabilitiesWith('--device-auth'),
  );
  const deps: DeviceCodeLoginDeps = {
    spawnLogin: spawnLogin as never,
    baseEnv: overrides.baseEnv ?? (async () => ({ ...BASE_ENV })),
    capabilities: capabilities as never,
    verify: verify as never,
    now: () => new Date('2026-09-11T12:00:00.000Z'),
    schedule: overrides.schedule ?? scheduler.schedule,
  };
  return {
    manager: new DeviceCodeLoginManager(deps),
    children,
    spawned,
    spawnLogin,
    verify,
    capabilities,
    scheduler,
  };
}

describe('reading a device-code prompt out of a CLI', () => {
  test("parses codex's live output, ANSI attributes and banner included", () => {
    expect(parseDeviceCodePrompt(CODEX_DEVICE_CODE_STDOUT)).toEqual(
      CODEX_DEVICE_CODE_EXPECTED,
    );
  });

  test("parses muse's live output, whose code is also inside the URL", () => {
    expect(parseDeviceCodePrompt(MUSE_DEVICE_CODE_STDOUT)).toEqual(
      MUSE_DEVICE_CODE_EXPECTED,
    );
  });

  test('a code printed before any URL is not read as this login’s code', () => {
    // Synthetic: neither observed CLI prints an all-caps banner, but the
    // ordering rule exists so one could not be mistaken for a code.
    const output = [
      'ACME-CLI',
      'Open this page to sign in:',
      '  https://auth.example.com/device',
      '  WXYZ-4321',
    ].join('\n');
    expect(parseDeviceCodePrompt(output)?.userCode).toBe('WXYZ-4321');
  });

  test('a prompt with no code yields nothing rather than half of one', () => {
    expect(
      parseDeviceCodePrompt('Open https://auth.example.com/device to sign in.'),
    ).toBeUndefined();
  });

  test('a plaintext verification URL is not relayed', () => {
    const output = [
      'Open this page:',
      '  http://auth.example.com/device',
      '  WXYZ-4321',
    ].join('\n');
    expect(parseDeviceCodePrompt(output)).toBeUndefined();
  });

  test('a number on its own line is not a user code', () => {
    const output = [
      'Open this page:',
      '  https://auth.example.com/device',
      '  12345678',
      '  WXYZ-4321',
    ].join('\n');
    expect(parseDeviceCodePrompt(output)?.userCode).toBe('WXYZ-4321');
  });
});

describe('starting a login', () => {
  test("runs the engine's own login with the observed flag, adding only the config-home override", async () => {
    const { manager, spawned } = harness();

    const result = await manager.start('codex', PROFILE_DIR);

    expect(result.kind).toBe('started');
    expect(spawned).toHaveLength(1);
    expect(spawned[0].command).toBe('codex');
    expect(spawned[0].args).toEqual(['login', '--device-auth']);
    expect(spawned[0].windowsHide).toBe(true);
    // The child's environment is the base environment plus exactly one key.
    expect(spawned[0].env).toEqual({ ...BASE_ENV, CODEX_HOME: PROFILE_DIR });
    expect(JSON.stringify(spawned[0].env)).not.toMatch(
      /token|secret|password/i,
    );
  });

  test('passes no extra argument when the mechanism needs none', async () => {
    const { manager, spawned } = harness({
      capabilities: capabilitiesWith(undefined),
    });

    await manager.start('codex', PROFILE_DIR);
    expect(spawned[0].args).toEqual(['login']);
  });

  test('refuses, and spawns nothing, when no evidence establishes device-code', async () => {
    const { manager, spawnLogin } = harness({
      capabilities: capabilitiesWith('--with-api-key', 'api-key-stdin'),
    });

    const result = await manager.start('codex', PROFILE_DIR);

    expect(result).toEqual({
      kind: 'unsupported',
      reason: expect.stringMatching(/does not offer a device-code login/),
    });
    expect(spawnLogin).not.toHaveBeenCalled();
  });

  test("relays the CLI's unavailable reason rather than inventing one", async () => {
    const { manager } = harness({
      capabilities: {
        engine: 'codex',
        observedAt: '2026-09-11T00:00:00.000Z',
        evidence: [],
        unavailableReason: 'The codex command was not found on this host.',
      },
    });

    const result = await manager.start('codex', PROFILE_DIR);
    expect(result).toEqual({
      kind: 'unsupported',
      reason: 'The codex command was not found on this host.',
    });
  });

  test('surfaces the URL and code the CLI printed', async () => {
    const { manager, children } = harness();
    await manager.start('codex', PROFILE_DIR);

    children[0].stdout.write(CODEX_DEVICE_CODE_STDOUT);

    expect(manager.status(PROFILE_DIR)).toMatchObject({
      phase: 'awaiting-approval',
      ...CODEX_DEVICE_CODE_EXPECTED,
    });
  });

  test('a second start while one is live returns the same login and spawns nothing', async () => {
    const { manager, children, spawnLogin, capabilities } = harness();
    await manager.start('codex', PROFILE_DIR);
    children[0].stdout.write(CODEX_DEVICE_CODE_STDOUT);

    const second = await manager.start('codex', PROFILE_DIR);

    expect(second.kind).toBe('existing');
    expect(second.kind === 'existing' && second.record.userCode).toBe(
      CODEX_DEVICE_CODE_EXPECTED.userCode,
    );
    expect(spawnLogin).toHaveBeenCalledTimes(1);
    // The live session short-circuits BEFORE the capability probe. Without
    // this the pre-await guard is unobservable: the post-await re-check
    // (which exists for the concurrent case) already covers the sequential
    // one, so removing the first guard passed every other assertion here.
    expect(capabilities).toHaveBeenCalledTimes(1);
  });

  test('concurrent starts race through the capability probe without a second process', async () => {
    const { manager, spawnLogin } = harness();

    await Promise.all([
      manager.start('codex', PROFILE_DIR),
      manager.start('codex', PROFILE_DIR),
    ]);

    expect(spawnLogin).toHaveBeenCalledTimes(1);
  });

  test('refuses to exceed the live-login cap', async () => {
    const { manager, children, spawnLogin } = harness();
    for (let index = 0; index < DEVICE_CODE_MAX_LIVE_LOGINS; index += 1) {
      await manager.start('codex', `${PROFILE_DIR}-${index}`);
      children[index].stdout.write(CODEX_DEVICE_CODE_STDOUT);
    }

    const overflow = await manager.start('codex', `${PROFILE_DIR}-overflow`);

    expect(overflow.kind).toBe('busy');
    expect(spawnLogin).toHaveBeenCalledTimes(DEVICE_CODE_MAX_LIVE_LOGINS);
  });

  test('a CLI that cannot be executed fails with a stated reason', async () => {
    const { manager, children } = harness();
    await manager.start('codex', PROFILE_DIR);

    const missing = new Error('spawn codex ENOENT') as NodeJS.ErrnoException;
    missing.code = 'ENOENT';
    children[0].emitError(missing);

    expect(manager.status(PROFILE_DIR)).toMatchObject({
      phase: 'failed',
      reason: 'The codex command was not found on this host.',
    });
  });
});

describe('completion is the engine’s answer, not the exit code', () => {
  test('a clean exit with no account signed in is a failure', async () => {
    const { manager, children, verify } = harness({
      authState: 'unauthenticated',
    });
    await manager.start('codex', PROFILE_DIR);
    children[0].stdout.write(CODEX_DEVICE_CODE_STDOUT);

    children[0].emitExit(0);
    await vi.waitFor(() =>
      expect(manager.status(PROFILE_DIR)?.phase).toBe('failed'),
    );

    expect(verify).toHaveBeenCalledWith('codex', PROFILE_DIR);
    expect(manager.status(PROFILE_DIR)?.reason).toMatch(/still signed out/);
  });

  test('a non-zero exit with an account signed in is a completion', async () => {
    const { manager, children } = harness({
      authState: 'authenticated',
      authDetail: 'Logged in using ChatGPT',
    });
    await manager.start('codex', PROFILE_DIR);
    children[0].stdout.write(CODEX_DEVICE_CODE_STDOUT);

    children[0].emitExit(1);
    await vi.waitFor(() =>
      expect(manager.status(PROFILE_DIR)?.phase).toBe('completed'),
    );

    expect(manager.status(PROFILE_DIR)?.detail).toBe('Logged in using ChatGPT');
  });

  test('an engine that cannot answer leaves the login failed, never completed', async () => {
    const { manager, children } = harness({ authState: 'unknown' });
    await manager.start('codex', PROFILE_DIR);
    children[0].stdout.write(CODEX_DEVICE_CODE_STDOUT);

    children[0].emitExit(0);
    await vi.waitFor(() =>
      expect(manager.status(PROFILE_DIR)?.phase).toBe('failed'),
    );
    expect(manager.status(PROFILE_DIR)?.reason).toMatch(
      /could not report whether the sign-in succeeded/,
    );
  });

  test('an exit before any code was printed fails without asking the engine', async () => {
    const { manager, children, verify } = harness();
    await manager.start('codex', PROFILE_DIR);

    children[0].emitExit(2);

    // Only the pre-start sign-in check ran; an exit before a code asks nothing.
    expect(verify).toHaveBeenCalledTimes(1);
    expect(manager.status(PROFILE_DIR)).toMatchObject({
      phase: 'failed',
      reason:
        'The codex login exited with code 2 without printing a verification code.',
    });
  });
});

describe('a login cannot outlive its bounds', () => {
  test('a CLI that never prints a code is killed and reported, not parked', async () => {
    const { manager, children, scheduler } = harness();
    await manager.start('codex', PROFILE_DIR);
    children[0].stdout.write('Contacting the provider...\n');

    scheduler.fire(DEVICE_CODE_PROMPT_TIMEOUT_MS);

    expect(children[0].signals).toContain('SIGTERM');
    expect(manager.status(PROFILE_DIR)).toMatchObject({
      phase: 'failed',
      reason: expect.stringMatching(/did not print a verification code/),
    });
  });

  test('an approval that never arrives is killed at the code’s own expiry', async () => {
    const { manager, children, scheduler } = harness();
    await manager.start('codex', PROFILE_DIR);
    children[0].stdout.write(CODEX_DEVICE_CODE_STDOUT);

    scheduler.fire(DEVICE_CODE_LOGIN_TIMEOUT_MS);

    expect(children[0].signals).toContain('SIGTERM');
    expect(manager.status(PROFILE_DIR)).toMatchObject({
      phase: 'failed',
      reason: 'The device code expired before it was approved.',
    });
  });

  test('the prompt deadline does not fire once a code has been printed', async () => {
    const { manager, children, scheduler } = harness();
    await manager.start('codex', PROFILE_DIR);
    children[0].stdout.write(CODEX_DEVICE_CODE_STDOUT);

    scheduler.fire(DEVICE_CODE_PROMPT_TIMEOUT_MS);

    expect(children[0].signals).toEqual([]);
    expect(manager.status(PROFILE_DIR)?.phase).toBe('awaiting-approval');
  });

  test('settling a login cancels its remaining deadlines', async () => {
    const { manager, children, scheduler } = harness();
    await manager.start('codex', PROFILE_DIR);
    const armed = scheduler.liveCount();
    expect(armed).toBeGreaterThanOrEqual(2);

    manager.cancel(PROFILE_DIR);

    expect(scheduler.liveCount()).toBeLessThan(armed);
    expect(children[0].signals).toContain('SIGTERM');
  });
});

describe('cancelling', () => {
  test('kills the process and records the cancellation', async () => {
    const { manager, children } = harness();
    await manager.start('codex', PROFILE_DIR);
    children[0].stdout.write(CODEX_DEVICE_CODE_STDOUT);

    const cancelled = manager.cancel(PROFILE_DIR);

    expect(cancelled?.phase).toBe('cancelled');
    expect(children[0].signals).toContain('SIGTERM');
  });

  test('a cancelled login is not revised into a completion by a late exit', async () => {
    const { manager, children, verify } = harness({
      authState: 'authenticated',
    });
    await manager.start('codex', PROFILE_DIR);
    children[0].stdout.write(CODEX_DEVICE_CODE_STDOUT);
    manager.cancel(PROFILE_DIR);

    children[0].emitExit(0);
    await Promise.resolve();

    // Exactly the pre-start sign-in check: the late exit asked nothing, so it
    // had no answer it could revise the cancellation with.
    expect(verify).toHaveBeenCalledTimes(1);
    expect(manager.status(PROFILE_DIR)?.phase).toBe('cancelled');
  });

  test('cancelling nothing reports nothing rather than inventing a record', async () => {
    const { manager } = harness();
    expect(manager.cancel(PROFILE_DIR)).toBeUndefined();
  });

  test('a cancelled profile can start a new login', async () => {
    const { manager, children, spawnLogin } = harness();
    await manager.start('codex', PROFILE_DIR);
    manager.cancel(PROFILE_DIR);

    const restarted = await manager.start('codex', PROFILE_DIR);

    expect(restarted.kind).toBe('started');
    expect(spawnLogin).toHaveBeenCalledTimes(2);
    expect(children).toHaveLength(2);
  });
});

type BaseEnv = Awaited<ReturnType<DeviceCodeLoginDeps['baseEnv']>>;

/*
 * Independent review of the first version found each of these reachable
 * against the real manager: a cancel during environment preparation that still
 * spawned an untracked process, a live-login cap that concurrent requests
 * walked straight past, and a "completed" that was really the credential the
 * profile already had. Each test here fails against that version.
 */
describe('a login starts only when it can be bounded and believed', () => {
  test('a profile that is already signed in is refused, and nothing is spawned', async () => {
    const { manager, spawnLogin } = harness({ preAuthState: 'authenticated' });

    const result = await manager.start('codex', PROFILE_DIR);

    expect(result.kind).toBe('already-signed-in');
    expect(spawnLogin).not.toHaveBeenCalled();
    expect(manager.status(PROFILE_DIR)).toBeUndefined();
  });

  test('a profile whose sign-in state the engine cannot report is refused', async () => {
    const { manager, spawnLogin } = harness({ preAuthState: 'unknown' });

    const result = await manager.start('codex', PROFILE_DIR);

    expect(result.kind).toBe('sign-in-state-unknown');
    expect(spawnLogin).not.toHaveBeenCalled();
  });

  test('cancelling while the environment is being prepared spawns nothing, and a restart spawns exactly one', async () => {
    let releaseEnv: (() => void) | undefined;
    let holdEnv = true;
    const { manager, spawnLogin } = harness({
      baseEnv: () =>
        holdEnv
          ? new Promise<BaseEnv>((resolve) => {
              releaseEnv = () => resolve({ ...BASE_ENV });
            })
          : Promise.resolve({ ...BASE_ENV }),
    });

    const pending = manager.start('codex', PROFILE_DIR);
    await vi.waitFor(() =>
      expect(manager.status(PROFILE_DIR)?.phase).toBe('starting'),
    );
    expect(manager.cancel(PROFILE_DIR)?.phase).toBe('cancelled');
    releaseEnv?.();

    expect((await pending).kind).toBe('cancelled');
    expect(spawnLogin).not.toHaveBeenCalled();

    holdEnv = false;
    expect((await manager.start('codex', PROFILE_DIR)).kind).toBe('started');
    expect(spawnLogin).toHaveBeenCalledTimes(1);
  });

  test('an environment that cannot be prepared fails the login instead of parking it in starting', async () => {
    let broken = true;
    const { manager, spawnLogin } = harness({
      baseEnv: async () => {
        if (broken) throw new Error('login shell resolution failed');
        return { ...BASE_ENV };
      },
    });

    const result = await manager.start('codex', PROFILE_DIR);

    expect(result.kind).toBe('failed');
    expect(manager.status(PROFILE_DIR)?.phase).toBe('failed');
    expect(spawnLogin).not.toHaveBeenCalled();
    // It holds no slot and blocks nothing: the next start proceeds.
    broken = false;
    expect((await manager.start('codex', PROFILE_DIR)).kind).toBe('started');
    expect(spawnLogin).toHaveBeenCalledTimes(1);
  });

  test('concurrent starts on different profiles never exceed the live-login cap', async () => {
    const { manager, spawnLogin } = harness();
    const overflow = 6;

    const results = await Promise.all(
      Array.from(
        { length: DEVICE_CODE_MAX_LIVE_LOGINS + overflow },
        (_, index) => manager.start('codex', `${PROFILE_DIR}-${index}`),
      ),
    );

    expect(spawnLogin).toHaveBeenCalledTimes(DEVICE_CODE_MAX_LIVE_LOGINS);
    expect(results.filter((result) => result.kind === 'busy')).toHaveLength(
      overflow,
    );
  });

  test('a spawn that throws is reported as a failure, not a start', async () => {
    const { manager, spawnLogin } = harness();
    spawnLogin.mockImplementationOnce(() => {
      throw new Error('spawn EACCES');
    });

    const result = await manager.start('codex', PROFILE_DIR);

    expect(result.kind).toBe('failed');
    expect(manager.status(PROFILE_DIR)?.phase).toBe('failed');
  });

  test('the code expiring while the engine is being asked does not overrule its answer', async () => {
    let answer: ((state: EnrolmentAuthState) => void) | undefined;
    const { manager, children, scheduler, verify } = harness();
    await manager.start('codex', PROFILE_DIR);
    children[0].stdout.write(CODEX_DEVICE_CODE_STDOUT);
    verify.mockImplementationOnce(
      (() =>
        new Promise((resolve) => {
          answer = (state) => resolve({ state });
        })) as never,
    );

    children[0].emitExit(0);
    await vi.waitFor(() =>
      expect(manager.status(PROFILE_DIR)?.phase).toBe('verifying'),
    );
    scheduler.fire(DEVICE_CODE_LOGIN_TIMEOUT_MS);
    expect(manager.status(PROFILE_DIR)?.phase).toBe('verifying');

    answer?.('authenticated');
    await vi.waitFor(() =>
      expect(manager.status(PROFILE_DIR)?.phase).toBe('completed'),
    );
  });
});

describe('only a URL fit to relay is relayed', () => {
  const PROMPT_TAIL = ['2. Enter this one-time code', '   7IEZ-B1FLE', ''];
  const EXPECTED = {
    verificationUri: 'https://auth.openai.com/codex/device',
    userCode: '7IEZ-B1FLE',
  };

  test('a link printed before the prompt, such as an update notice, is not the verification URL', () => {
    const output = [
      'A new version is available: https://github.com/openai/codex/releases/latest',
      CODEX_DEVICE_CODE_STDOUT,
    ].join('\n');

    expect(parseDeviceCodePrompt(output)).toEqual(CODEX_DEVICE_CODE_EXPECTED);
  });

  test('a URL carrying userinfo is not relayed', () => {
    const output = [
      '   https://auth.openai.com@evil.example/device',
      ...PROMPT_TAIL,
    ].join('\n');

    expect(parseDeviceCodePrompt(output)).toBeUndefined();
  });

  test('an OSC 8 hyperlink yields the bare URL with no escape residue', () => {
    const osc = (text: string) => `\x1b]8;;${text}\x07`;
    const output = [
      `   ${osc(EXPECTED.verificationUri)}${EXPECTED.verificationUri}${osc('')}`,
      ...PROMPT_TAIL,
    ].join('\n');

    expect(parseDeviceCodePrompt(output)).toEqual(EXPECTED);
  });

  test('a URL containing a bidi override is not relayed', () => {
    const output = [
      '   https://auth.openai.com/co\u202edex/device',
      ...PROMPT_TAIL,
    ].join('\n');

    expect(parseDeviceCodePrompt(output)).toBeUndefined();
  });

  test('an oversized URL is not relayed', () => {
    const output = [
      `   https://auth.openai.com/${'a'.repeat(3000)}`,
      ...PROMPT_TAIL,
    ].join('\n');

    expect(parseDeviceCodePrompt(output)).toBeUndefined();
  });

  test('an ungrouped word between the URL and the code is not read as the code', () => {
    const output = [
      `   ${EXPECTED.verificationUri}`,
      'WARNING',
      '   7IEZ-B1FLE',
      '',
    ].join('\n');

    expect(parseDeviceCodePrompt(output)).toEqual(EXPECTED);
  });
});

describe('what reaches another device is what the CLI meant', () => {
  const PROMPT_TAIL = ['2. Enter this one-time code', '   7IEZ-B1FLE', ''];

  test('a backslash cannot disguise the host: the relayed URL is the parsed one', () => {
    const output = [
      '   https://evil.example\\.auth.openai.com/device',
      ...PROMPT_TAIL,
    ].join('\n');

    expect(parseDeviceCodePrompt(output)?.verificationUri).toBe(
      'https://evil.example/.auth.openai.com/device',
    );
  });

  test('a help link between the verification URL and the code is not relayed instead', () => {
    const output = [
      '   https://auth.openai.com/codex/device',
      'Trouble? See https://help.openai.com/device',
      '   7IEZ-B1FLE',
      '',
    ].join('\n');

    expect(parseDeviceCodePrompt(output)).toEqual({
      verificationUri: 'https://auth.openai.com/codex/device',
      userCode: '7IEZ-B1FLE',
    });
  });

  test('a URL only ever printed inside a sentence yields nothing rather than a guess', () => {
    const output = [
      'Open https://auth.openai.com/codex/device to continue',
      '   7IEZ-B1FLE',
      '',
    ].join('\n');

    expect(parseDeviceCodePrompt(output)).toBeUndefined();
  });
});

describe('a cancel or shutdown during the pre-spawn checks is honoured', () => {
  function holdCapabilities(
    capabilities: ReturnType<typeof harness>['capabilities'],
  ) {
    const gate: { release?: () => void } = {};
    capabilities.mockImplementationOnce(
      (() =>
        new Promise((resolve) => {
          gate.release = () => resolve(capabilitiesWith('--device-auth'));
        })) as never,
    );
    return gate;
  }

  test('cancelling while the engine is being probed stops the login before it registers', async () => {
    const { manager, spawnLogin, capabilities } = harness();
    const gate = holdCapabilities(capabilities);

    const pending = manager.start('codex', PROFILE_DIR);
    await vi.waitFor(() => expect(gate.release).toBeTypeOf('function'));
    // Nothing is registered yet, so there is no record to hand back...
    expect(manager.cancel(PROFILE_DIR)).toBeUndefined();
    gate.release?.();

    // ...but the start honours the cancel instead of spawning after it.
    expect((await pending).kind).toBe('cancelled');
    expect(spawnLogin).not.toHaveBeenCalled();
    expect((await manager.start('codex', PROFILE_DIR)).kind).toBe('started');
    expect(spawnLogin).toHaveBeenCalledTimes(1);
  });

  test('shutdown during the pre-spawn checks spawns nothing and refuses every later start', async () => {
    const { manager, spawnLogin, capabilities } = harness();
    const gate = holdCapabilities(capabilities);

    const pending = manager.start('codex', PROFILE_DIR);
    await vi.waitFor(() => expect(gate.release).toBeTypeOf('function'));
    manager.cancelAll();
    gate.release?.();

    expect((await pending).kind).toBe('cancelled');
    expect((await manager.start('codex', `${PROFILE_DIR}-later`)).kind).toBe(
      'closed',
    );
    expect(spawnLogin).not.toHaveBeenCalled();
  });

  test('an environment failure after a cancel reports the cancel, not a start failure', async () => {
    const gate: { reject?: () => void } = {};
    const { manager, spawnLogin } = harness({
      baseEnv: () =>
        new Promise<BaseEnv>((_, reject) => {
          gate.reject = () =>
            reject(new Error('login shell resolution failed'));
        }),
    });

    const pending = manager.start('codex', PROFILE_DIR);
    await vi.waitFor(() =>
      expect(manager.status(PROFILE_DIR)?.phase).toBe('starting'),
    );
    manager.cancel(PROFILE_DIR);
    gate.reject?.();

    expect((await pending).kind).toBe('cancelled');
    expect(spawnLogin).not.toHaveBeenCalled();
  });
});

describe('a cancel reaches only the profile it names', () => {
  test("cancelling one profile leaves another profile's pending start alone", async () => {
    const { manager, spawnLogin, capabilities } = harness();
    const gate: { release?: () => void } = {};
    capabilities.mockImplementationOnce(
      (() =>
        new Promise((resolve) => {
          gate.release = () => resolve(capabilitiesWith('--device-auth'));
        })) as never,
    );

    const other = manager.start('codex', `${PROFILE_DIR}-other`);
    await vi.waitFor(() => expect(gate.release).toBeTypeOf('function'));
    manager.cancel(PROFILE_DIR);
    gate.release?.();

    expect((await other).kind).toBe('started');
    expect(spawnLogin).toHaveBeenCalledTimes(1);
  });
});

describe('zero-width characters', () => {
  test('a URL containing a zero-width character is not relayed', () => {
    // Without the rejection, the parser would percent-encode it into the path
    // and relay a URL that looks like the real one but is not.
    const output = [
      '   https://auth.openai.com/co\u200bdex/device',
      '2. Enter this one-time code',
      '   7IEZ-B1FLE',
      '',
    ].join('\n');

    expect(parseDeviceCodePrompt(output)).toBeUndefined();
  });
});
