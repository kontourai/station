import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../../telemetry/metrics.js', () => ({
  terminalOps: { add: vi.fn() },
}));

const { TerminalService } = await import('../terminal-service.js');
const { PtyUnavailableError } = await import('../../../domain/pty-adapter.js');

function createMockPty() {
  return {
    spawn: vi.fn().mockResolvedValue({
      pid: 12345,
      onData: vi.fn().mockReturnValue(vi.fn()),
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
    pty = createMockPty();
    svc = new TerminalService(pty as any, createMockHistoryStore() as any);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await svc.dispose();
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

  test('open hands the PTY an env without boot-internal secrets', async () => {
    const priorToken = process.env.STATION_INTERNAL_API_TOKEN;
    const priorBootstrap = process.env.STATION_UI_BOOTSTRAP_TOKEN;
    process.env.STATION_INTERNAL_API_TOKEN = 'pty-must-not-see-this-token';
    process.env.STATION_UI_BOOTSTRAP_TOKEN = 'pty-must-not-see-bootstrap';
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
      expect(spawnEnv.TERM).toBe('xterm-256color');
    } finally {
      if (priorToken === undefined)
        delete process.env.STATION_INTERNAL_API_TOKEN;
      else process.env.STATION_INTERNAL_API_TOKEN = priorToken;
      if (priorBootstrap === undefined)
        delete process.env.STATION_UI_BOOTSTRAP_TOKEN;
      else process.env.STATION_UI_BOOTSTRAP_TOKEN = priorBootstrap;
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
        'node-pty failed to load. Interactive terminal panes are unavailable; run `npm rebuild node-pty`.',
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

  test('write is no-op for unknown session', () => {
    svc.write('unknown:t1', 'data');
    // Should not throw
  });

  test('close is no-op for unknown session', async () => {
    await svc.close('unknown:t1');
    // Should not throw
  });
});
