/**
 * A terminal whose cleanup misses its deadline says which step of its ending
 * was still pending (the tree kill, the exit event, output), so a hosted
 * failure is evidence rather than a bare timeout (#4626). A fake shell host:
 * no native backend, every platform.
 */
import { realpath } from 'node:fs/promises';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import type { IPtyProcess } from '../../../domain/pty-adapter.js';
import type { ShellHost } from '../shell-host.js';
import { TerminalSessions } from '../terminal-sessions.js';

const temp = trackTempDirs();
const scope = { projectId: 'project-a', bindingKey: 'project' };

/** A shell whose ending stalls until released, and reports where it is. */
class StallingProcess implements IPtyProcess {
  pid = 4321;
  private exits = new Set<
    (event: { exitCode: number; signal: number | null }) => void
  >();
  private release!: () => void;
  private readonly ended = new Promise<void>((resolve) => {
    this.release = resolve;
  });
  write() {}
  resize() {}
  kill() {}
  terminate(): Promise<void> {
    return this.ended;
  }
  describeTermination(): string {
    return 'taskkill exited 0 after 4800 ms; no exit event yet; last output 30 ms ago';
  }
  end(): void {
    for (const exit of [...this.exits]) exit({ exitCode: 1, signal: null });
    this.release();
  }
  onData() {
    return () => {};
  }
  onExit(cb: (event: { exitCode: number; signal: number | null }) => void) {
    this.exits.add(cb);
    return () => this.exits.delete(cb);
  }
}

const opened: TerminalSessions<string>[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const sessions of opened.splice(0)) await sessions.dispose();
});

describe('a missed terminal cleanup deadline', () => {
  test('names the step of the ending that was still pending', async () => {
    const processes: StallingProcess[] = [];
    const host: ShellHost = {
      spawn: async () => {
        const process = new StallingProcess();
        processes.push(process);
        return process;
      },
    };
    const root = await realpath(temp('terminal-cleanup-root-'));
    const sessions = new TerminalSessions<string>(
      temp('terminal-cleanup-home-'),
      host,
      { authorize: () => true, resolveRoot: async () => root },
    );
    opened.push(sessions);
    const { terminalId } = await sessions.open('operator', scope, {
      cols: 80,
      rows: 24,
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const closing = sessions.close('operator', scope, terminalId).then(
      () => null,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(6_000);
    const failure = await closing;
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      'Terminal process-group cleanup did not settle (taskkill exited 0 after 4800 ms; no exit event yet; last output 30 ms ago)',
    );
    vi.useRealTimers();
    processes[0]!.end();
  });
});
