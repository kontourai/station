import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { TerminalEvent } from '../../../domain/terminal-types.js';

const probes = vi.hoisted(() => ({ execFile: vi.fn(), execSync: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  ...probes,
}));

vi.mock('../../../telemetry/metrics.js', () => ({
  terminalOps: { add: vi.fn() },
}));

const { TerminalService } = await import('../terminal-service.js');
const { PtyUnavailableError } = await import('../../../domain/pty-adapter.js');

function createMockPty() {
  const dataListeners = new Set<(data: string) => void>();
  return {
    emitData: (data: string) => {
      for (const cb of dataListeners) cb(data);
    },
    spawn: vi.fn().mockResolvedValue({
      pid: 12345,
      onData: vi.fn((cb: (data: string) => void) => {
        dataListeners.add(cb);
        return () => {
          dataListeners.delete(cb);
        };
      }),
      onExit: vi.fn().mockReturnValue(vi.fn()),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
    }),
  };
}

function createMockHistoryStore() {
  const store = new Map<string, string>();
  return {
    load: vi.fn(async (id: string) => store.get(id) || ''),
    save: vi.fn(async (id: string, data: string) => {
      store.set(id, data);
    }),
    delete: vi.fn(async (id: string) => {
      store.delete(id);
    }),
  };
}

function deferred<T>() {
  let resolve: (value: T) => void;
  let reject: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve: resolve!, reject: reject! };
}

describe('TerminalService', () => {
  let svc: InstanceType<typeof TerminalService>;
  let pty: ReturnType<typeof createMockPty>;

  beforeEach(() => {
    probes.execFile.mockReset();
    probes.execSync.mockReset();
    pty = createMockPty();
    svc = new TerminalService(pty as any, createMockHistoryStore() as any);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await svc.dispose();
  });

  test('an attach-only open joins a running session and never starts a shell in its place', async () => {
    const base = {
      projectSlug: '.engine-sign-in',
      terminalId: 'pi-1',
      cwd: homedir(),
      cols: 80,
      rows: 24,
    };
    await expect(svc.open({ ...base, attachOnly: true })).rejects.toThrow(
      'ended',
    );
    expect(pty.spawn).not.toHaveBeenCalled();

    await svc.open({ ...base, shell: '/bin/echo', shellArgs: ['login'] });
    const attached = await svc.open({ ...base, attachOnly: true });
    expect(attached.sessionId).toBe('.engine-sign-in:pi-1');
    expect(pty.spawn).toHaveBeenCalledTimes(1);
  });

  test('open refuses an empty working directory instead of letting node-pty pick one', async () => {
    // archive#1497 — node-pty's unixTerminal resolves `opt.cwd || process.cwd()`,
    // so a blank cwd spawns the user's shell in whatever directory
    // station-control was launched from and renders as a working prompt rather
    // than as an error. The UI's `config.workingDirectory ?? ''` is a display
    // default and must not become an execution decision. Newly reachable now
    // that a project with no working directory yields no key at all.
    for (const cwd of ['', '   ']) {
      await expect(
        svc.open({
          projectSlug: 'test',
          terminalId: 't-empty',
          cwd,
          cols: 80,
          rows: 24,
        }),
      ).rejects.toThrow(/no working directory configured/);
    }
    expect(pty.spawn).not.toHaveBeenCalled();
  });

  test('open hands the PTY an env without boot secrets or the server compile cache', async () => {
    const priorToken = process.env.STATION_INTERNAL_API_TOKEN;
    const priorBootstrap = process.env.STATION_UI_BOOTSTRAP_TOKEN;
    const priorCache = process.env.NODE_COMPILE_CACHE;
    process.env.STATION_INTERNAL_API_TOKEN = 'pty-must-not-see-this-token';
    process.env.STATION_UI_BOOTSTRAP_TOKEN = 'pty-must-not-see-bootstrap';
    process.env.NODE_COMPILE_CACHE = '/server-only/cache/node-compile';
    try {
      await svc.open({
        projectSlug: 'test',
        terminalId: 't-env',
        cwd: '/tmp',
        cols: 80,
        rows: 24,
        env: { STATION_INTERNAL_API_TOKEN: 'client-reinject' },
      });
      expect(pty.spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          env: expect.not.objectContaining({
            STATION_INTERNAL_API_TOKEN: expect.anything(),
            STATION_UI_BOOTSTRAP_TOKEN: expect.anything(),
          }),
        }),
      );
      const spawnEnv = pty.spawn.mock.calls[0][0].env as NodeJS.ProcessEnv;
      expect(
        spawnEnv,
        'STATION_INTERNAL_API_TOKEN leaked into spawned PTY env',
      ).not.toHaveProperty('STATION_INTERNAL_API_TOKEN');
      expect(spawnEnv).not.toHaveProperty('STATION_UI_BOOTSTRAP_TOKEN');
      expect(spawnEnv).not.toHaveProperty('NODE_COMPILE_CACHE');
      expect(spawnEnv.TERM).toBe('xterm-256color');
    } finally {
      if (priorToken === undefined)
        delete process.env.STATION_INTERNAL_API_TOKEN;
      else process.env.STATION_INTERNAL_API_TOKEN = priorToken;
      if (priorBootstrap === undefined)
        delete process.env.STATION_UI_BOOTSTRAP_TOKEN;
      else process.env.STATION_UI_BOOTSTRAP_TOKEN = priorBootstrap;
      if (priorCache === undefined) delete process.env.NODE_COMPILE_CACHE;
      else process.env.NODE_COMPILE_CACHE = priorCache;
    }
  });

  test('open spawns a PTY process', async () => {
    const snap = await svc.open({
      projectSlug: 'test',
      terminalId: 't1',
      cwd: '/tmp',
      cols: 80,
      rows: 24,
    });
    expect(snap.sessionId).toBe('test:t1');
    expect(snap.status).toBe('running');
    expect(snap.pid).toBe(12345);
    expect(pty.spawn).toHaveBeenCalled();
  });

  test('open expands a leading ~ in cwd before spawning', async () => {
    // The project workingDirectory is stored as `~/...`; node-pty cannot chdir
    // into a literal `~`, so the shell would spawn and exit immediately.
    await svc.open({
      projectSlug: 'test',
      terminalId: 't1',
      cwd: '~/dev/project',
      cols: 80,
      rows: 24,
    });
    const expected = join(homedir(), 'dev/project');
    expect(pty.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: expected }),
    );
    expect(svc.listProcessSummaries()[0]?.cwd).toBe(expected);
  });

  test('open returns existing session if running', async () => {
    await svc.open({
      projectSlug: 'test',
      terminalId: 't1',
      cwd: '/tmp',
      cols: 80,
      rows: 24,
    });
    const snap2 = await svc.open({
      projectSlug: 'test',
      terminalId: 't1',
      cwd: '/tmp',
      cols: 80,
      rows: 24,
    });
    expect(snap2.status).toBe('running');
    expect(pty.spawn).toHaveBeenCalledTimes(1); // not spawned again
  });

  test('bounds newline-free PTY history by UTF-8 bytes while retaining the exact output tail on reattach and restore', async () => {
    vi.useFakeTimers();
    const history = createMockHistoryStore();
    await svc.dispose();
    svc = new TerminalService(pty, history);
    const input = {
      projectSlug: 'test',
      terminalId: 'bounded',
      cwd: '/tmp',
      cols: 80,
      rows: 24,
    };
    await svc.open(input);
    const chunk = '進捗🙂\r'.repeat(1024);
    for (let i = 0; i < 2048; i++) pty.emitData(chunk);
    pty.emitData('final-tail');
    const replay = (await svc.open(input)).history;
    expect(Buffer.byteLength(replay)).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(replay.length).toBeGreaterThan(100_000);
    expect(`${chunk.repeat(512)}final-tail`.endsWith(replay)).toBe(true);
    expect(/^[\uDC00-\uDFFF]/.test(replay)).toBe(false);
    expect(svc.readProcess('test:bounded')?.history).toBe(replay);
    await vi.advanceTimersByTimeAsync(40);
    expect(history.save).toHaveBeenLastCalledWith('test:bounded', replay);
    await svc.close('test:bounded');
    expect((await svc.open(input)).history).toBe(replay);
  });

  test('bounds legacy plain-text history on restore and retains the latest live lines', async () => {
    const history = createMockHistoryStore();
    await svc.dispose();
    svc = new TerminalService(pty, history);
    const input = {
      projectSlug: 'test',
      terminalId: 'legacy',
      cwd: '/tmp',
      cols: 80,
      rows: 24,
    };
    history.load.mockResolvedValueOnce(
      `${'old'.repeat(800_000)}\n\x1b[32mlatest🙂\x1b[0m`,
    );
    const restored = (await svc.open(input)).history;
    expect(Buffer.byteLength(restored)).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(restored.endsWith('\x1b[32mlatest🙂\x1b[0m')).toBe(true);
    for (let i = 0; i < 6000; i++) pty.emitData(`\nline-${i}`);
    const replay = (await svc.open(input)).history;
    expect(replay.split('\n')).toHaveLength(5000);
    expect(replay).toBe(
      Array.from({ length: 5000 }, (_, i) => `line-${i + 1000}`).join('\n'),
    );
  });

  test.each([
    ['CSI', '\x1b[', '31m'],
    ['OSC', '\x1b]title;', '\x1b\\'],
    ['DCS', '\x1bP', '\x1b\\'],
  ])(
    'does not start truncated replay inside a split %s sequence',
    async (_name, prefix, suffix) => {
      const input = {
        projectSlug: 'test',
        terminalId: 'ansi',
        cwd: '/tmp',
        cols: 80,
        rows: 24,
      };
      await svc.open(input);
      pty.emitData(prefix);
      pty.emitData('1'.repeat(32));
      pty.emitData(suffix);
      const visible = 'v'.repeat(2 * 1024 * 1024 - 16);
      pty.emitData(visible);
      expect((await svc.open(input)).history === visible).toBe(true);
    },
  );

  test('retains normal output after an unterminated OSC followed by 30,000 lines', async () => {
    const input = {
      projectSlug: 'test',
      terminalId: 'binary',
      cwd: '/tmp',
      cols: 80,
      rows: 24,
    };
    await svc.open(input);
    pty.emitData('\x1b]garbage');
    const line = `${'normal output '.padEnd(86, 'x')}\n`;
    for (let i = 0; i < 30_000; i++) pty.emitData(line);
    const replay = (await svc.open(input)).history;
    expect(replay.length).toBeGreaterThan(400_000);
    expect(replay.endsWith(line.repeat(100))).toBe(true);
    expect(replay.split('\n').length).toBeLessThanOrEqual(5000);
  });

  test.each(['\x18', '\x1a', '\x1b[32m'])(
    'recovers a truncated OSC after cancellation or a new escape (%j)',
    async (abort) => {
      const input = {
        projectSlug: 'test',
        terminalId: 'abort',
        cwd: '/tmp',
        cols: 80,
        rows: 24,
      };
      await svc.open(input);
      pty.emitData(`\x1b]${'g'.repeat(100)}${abort}`);
      const visible = 'v'.repeat(2 * 1024 * 1024 - 64);
      pty.emitData(visible);
      expect((await svc.open(input)).history === visible).toBe(true);
    },
  );

  test('keeps surrogate pairs intact when PTY callbacks divide them at the history limit', async () => {
    const input = {
      projectSlug: 'test',
      terminalId: 'unicode',
      cwd: '/tmp',
      cols: 80,
      rows: 24,
    };
    await svc.open(input);
    pty.emitData(`${'🙂'.repeat(524_288)}\uD83D`);
    pty.emitData('\uDE42');
    const replay = (await svc.open(input)).history;
    expect(Buffer.byteLength(replay)).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(replay.length).toBe(524_288 * 2);
    expect(replay.replaceAll('🙂', '')).toBe('');
  });

  test.skipIf(process.platform === 'win32')(
    'starts terminal activity probes concurrently and ignores results for closed sessions',
    async () => {
      vi.useFakeTimers();
      await svc.dispose();
      svc = new TerminalService(pty, createMockHistoryStore());
      const callbacks: Array<(error: Error | null) => void> = [];
      probes.execFile.mockImplementation((_file, _args, _options, callback) => {
        callbacks.push(callback);
      });
      const events: TerminalEvent[] = [];
      svc.subscribe((event) => events.push(event));
      for (const terminalId of ['one', 'two']) {
        await svc.open({
          projectSlug: 'test',
          terminalId,
          cwd: '/tmp',
          cols: 80,
          rows: 24,
        });
      }
      await vi.advanceTimersByTimeAsync(60_000);
      expect(callbacks).toHaveLength(2);
      expect(probes.execSync).not.toHaveBeenCalled();
      expect(probes.execFile).toHaveBeenCalledWith(
        'pgrep',
        ['-P', '12345'],
        expect.objectContaining({ timeout: 2000, windowsHide: true }),
        expect.any(Function),
      );
      await vi.advanceTimersByTimeAsync(60_000);
      expect(callbacks).toHaveLength(2);
      await svc.close('test:one');
      callbacks[0]!(null);
      callbacks[1]!(null);
      await vi.advanceTimersByTimeAsync(0);
      expect(events.filter((event) => event.type === 'activity')).toEqual([
        { type: 'activity', sessionId: 'test:two', hasRunningSubprocess: true },
      ]);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(callbacks).toHaveLength(3);
      callbacks[2]!(
        Object.assign(new Error('pgrep timed out'), { killed: true }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(svc.readProcess('test:two')?.process.hasRunningSubprocess).toBe(
        true,
      );
      await vi.advanceTimersByTimeAsync(60_000);
      await svc.dispose();
      callbacks[3]!(null);
      await vi.advanceTimersByTimeAsync(0);
      expect(events.filter((event) => event.type === 'activity')).toHaveLength(
        1,
      );
    },
  );

  test('write delegates to process', async () => {
    await svc.open({
      projectSlug: 'test',
      terminalId: 't1',
      cwd: '/tmp',
      cols: 80,
      rows: 24,
    });
    svc.write('test:t1', 'ls\n');
    const proc = await pty.spawn.mock.results[0].value;
    expect(proc.write).toHaveBeenCalledWith('ls\n');
  });

  test('reads the running shell cwd without falling back to its launch directory', async () => {
    const liveCwd = '/tmp/after-shell-cd';
    pty.spawn.mockResolvedValueOnce({
      pid: 12345,
      getCwd: vi.fn(async () => liveCwd),
      onData: vi.fn().mockReturnValue(vi.fn()),
      onExit: vi.fn().mockReturnValue(vi.fn()),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
    });
    await svc.open({
      projectSlug: 'test',
      terminalId: 't-cwd',
      cwd: '/tmp/launch-directory',
      cols: 80,
      rows: 24,
    });

    await expect(svc.getCwd('test:t-cwd')).resolves.toBe(liveCwd);
    await expect(svc.getCwd('missing')).resolves.toBeNull();
  });

  test('resize delegates to process', async () => {
    await svc.open({
      projectSlug: 'test',
      terminalId: 't1',
      cwd: '/tmp',
      cols: 80,
      rows: 24,
    });
    svc.resize('test:t1', 120, 40);
    const proc = await pty.spawn.mock.results[0].value;
    expect(proc.resize).toHaveBeenCalledWith(120, 40);
  });

  test('close kills process', async () => {
    await svc.open({
      projectSlug: 'test',
      terminalId: 't1',
      cwd: '/tmp',
      cols: 80,
      rows: 24,
    });
    await svc.close('test:t1');
    const proc = await pty.spawn.mock.results[0].value;
    expect(proc.kill).toHaveBeenCalled();
  });

  test('closeForProject terminates only the exact project-scoped terminal', async () => {
    await svc.open({
      projectSlug: 'project-a',
      terminalId: 'terminal-1',
      cwd: '/tmp',
      cols: 80,
      rows: 24,
    });

    expect(await svc.closeForProject('project-b', 'terminal-1')).toBeNull();
    expect(svc.readProcess('project-a:terminal-1')).not.toBeNull();

    await expect(
      svc.closeForProject('project-a', 'terminal-1'),
    ).resolves.toEqual({
      sessionId: 'project-a:terminal-1',
      projectSlug: 'project-a',
      terminalId: 'terminal-1',
    });
    expect(svc.readProcess('project-a:terminal-1')).toBeNull();
  });

  test('an accepted close during spawn kills the delayed process without returning a running session', async () => {
    const spawn = deferred<any>();
    const proc = {
      pid: 45678,
      onData: vi.fn().mockReturnValue(vi.fn()),
      onExit: vi.fn().mockReturnValue(vi.fn()),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
    };
    pty.spawn.mockReturnValueOnce(spawn.promise);

    const opening = svc.open({
      projectSlug: 'project-a',
      terminalId: 'terminal-starting',
      cwd: '/tmp',
      cols: 80,
      rows: 24,
    });
    await vi.waitFor(() => expect(pty.spawn).toHaveBeenCalledTimes(1));

    await expect(
      svc.closeForProject('project-a', 'terminal-starting'),
    ).resolves.toEqual({
      sessionId: 'project-a:terminal-starting',
      projectSlug: 'project-a',
      terminalId: 'terminal-starting',
    });
    expect(svc.readProcess('project-a:terminal-starting')).toBeNull();

    spawn.resolve(proc);

    await expect(opening).rejects.toThrow(/open cancelled/);
    expect(proc.kill).toHaveBeenCalledTimes(1);
    expect(proc.onData).not.toHaveBeenCalled();
    expect(svc.listProcessSummaries()).toEqual([]);
  });

  test('an accepted close during a rejecting spawn reports cancellation rather than a spawn result', async () => {
    const spawn = deferred<any>();
    pty.spawn.mockReturnValueOnce(spawn.promise);

    const opening = svc.open({
      projectSlug: 'project-a',
      terminalId: 'terminal-rejecting',
      cwd: '/tmp',
      cols: 80,
      rows: 24,
    });
    await vi.waitFor(() => expect(pty.spawn).toHaveBeenCalledTimes(1));

    await svc.closeForProject('project-a', 'terminal-rejecting');
    spawn.reject(new Error('spawn failed'));

    await expect(opening).rejects.toThrow(/open cancelled/);
    expect(svc.readProcess('project-a:terminal-rejecting')).toBeNull();
  });

  test('reopening a session clears the pending hard-kill fallback', async () => {
    vi.useFakeTimers();

    await svc.open({
      projectSlug: 'test',
      terminalId: 't1',
      cwd: '/tmp',
      cols: 80,
      rows: 24,
    });
    const firstProc = await pty.spawn.mock.results[0].value;

    await svc.close('test:t1');
    expect(firstProc.kill).toHaveBeenCalledTimes(1);

    await svc.open({
      projectSlug: 'test',
      terminalId: 't1',
      cwd: '/tmp',
      cols: 80,
      rows: 24,
    });

    await vi.advanceTimersByTimeAsync(3000);
    expect(firstProc.kill).toHaveBeenCalledTimes(1);
  });

  test('subscribe receives events', async () => {
    const events: any[] = [];
    svc.subscribe((e) => events.push(e));
    await svc.open({
      projectSlug: 'test',
      terminalId: 't1',
      cwd: '/tmp',
      cols: 80,
      rows: 24,
    });
    expect(events.some((e) => e.type === 'started')).toBe(true);
  });

  test('lists and reads process summaries for active terminal sessions', async () => {
    await svc.open({
      projectSlug: 'test',
      terminalId: 't1',
      cwd: '/tmp',
      cols: 80,
      rows: 24,
    });

    expect(svc.listProcessSummaries()).toEqual([
      {
        kind: 'terminal',
        sessionId: 'test:t1',
        projectSlug: 'test',
        terminalId: 't1',
        cwd: '/tmp',
        status: 'running',
        pid: 12345,
        exitCode: null,
        hasRunningSubprocess: false,
        cols: 80,
        rows: 24,
      },
    ]);

    expect(svc.readProcess('test:t1')).toEqual({
      process: {
        kind: 'terminal',
        sessionId: 'test:t1',
        projectSlug: 'test',
        terminalId: 't1',
        cwd: '/tmp',
        status: 'running',
        pid: 12345,
        exitCode: null,
        hasRunningSubprocess: false,
        cols: 80,
        rows: 24,
      },
      history: '',
    });
  });

  test('open throws when no shell found', async () => {
    pty.spawn.mockRejectedValue(new Error('spawn failed'));
    await expect(
      svc.open({
        projectSlug: 'test',
        terminalId: 't1',
        cwd: '/tmp',
        cols: 80,
        rows: 24,
      }),
    ).rejects.toThrow('no viable shell');
  });

  test('open reports the specific degraded reason when the PTY backend is unavailable (#1244)', async () => {
    // A missing node-pty fails EVERY shell candidate identically, so the
    // service must rethrow the adapter's PtyUnavailableError instead of
    // exhausting the candidate list into "no viable shell found" — the
    // generic message reads as a shell problem the user cannot act on.
    pty.spawn.mockRejectedValue(
      new PtyUnavailableError(
        'node-pty failed to load. Interactive terminal panes are unavailable; run `npm run dependencies:install`.',
      ),
    );
    await expect(
      svc.open({
        projectSlug: 'test',
        terminalId: 't-no-pty',
        cwd: '/tmp',
        cols: 80,
        rows: 24,
      }),
    ).rejects.toThrow(/node-pty failed to load/);
  });

  test('probeCapability forwards the adapter probe and defaults to available without one', async () => {
    // The default mock adapter has no probe: absence of a native backend to
    // lose must not be reported as a degradation nothing observed.
    await expect(svc.probeCapability()).resolves.toEqual({
      state: 'available',
    });
    const degraded = new TerminalService(
      {
        ...createMockPty(),
        probeCapability: vi.fn(async () => ({
          state: 'unavailable' as const,
          reason: 'node-pty failed to load.',
        })),
      } as any,
      createMockHistoryStore() as any,
    );
    try {
      await expect(degraded.probeCapability()).resolves.toEqual({
        state: 'unavailable',
        reason: 'node-pty failed to load.',
      });
    } finally {
      await degraded.dispose();
    }
  });

  // Both cases used to assert nothing at all ("should not throw"), which a
  // method that closed the WRONG session, or wrote into one, would also
  // satisfy. Each opens a real session first so "no-op" has something
  // observable to be a no-op against.

  test('write for an unknown session id reaches no live PTY', async () => {
    await svc.open({
      projectSlug: 'live',
      terminalId: 't1',
      cwd: homedir(),
      cols: 80,
      rows: 24,
    });
    const proc = await pty.spawn.mock.results[0]!.value;
    proc.write.mockClear();

    svc.write('unknown:t1', 'data');

    expect(proc.write).not.toHaveBeenCalled();
    expect(svc.readProcess('unknown:t1')).toBeNull();
    expect(svc.listProcessSummaries().map((s) => s.sessionId)).toEqual([
      'live:t1',
    ]);
  });

  test('close for an unknown session id leaves the live session open', async () => {
    const history = createMockHistoryStore();
    const local = new TerminalService(pty as any, history as any);
    try {
      await local.open({
        projectSlug: 'live',
        terminalId: 't1',
        cwd: homedir(),
        cols: 80,
        rows: 24,
      });
      const proc = await pty.spawn.mock.results[0]!.value;
      proc.kill.mockClear();
      history.save.mockClear();

      await local.close('unknown:t1');

      // `close` returns before its side effects when the id is unknown: no
      // kill, no persist, and the real session is still running.
      expect(proc.kill).not.toHaveBeenCalled();
      expect(history.save).not.toHaveBeenCalled();
      expect(local.readProcess('live:t1')?.process.status).toBe('running');
      expect(local.listProcessSummaries().map((s) => s.sessionId)).toEqual([
        'live:t1',
      ]);
    } finally {
      await local.dispose();
    }
  });
});
