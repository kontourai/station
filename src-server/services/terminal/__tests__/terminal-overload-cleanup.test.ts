import { realpath } from 'node:fs/promises';
import { expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import type { IPtyProcess } from '../../../domain/pty-adapter.js';
import { TerminalSessions } from '../terminal-sessions.js';

const temp = trackTempDirs();
const scope = { projectId: 'project', bindingKey: 'project' };

test('disposal waits for an overload stop after the process exit event', async () => {
  let data!: (value: string) => void;
  let exit!: (event: { exitCode: number; signal: number | null }) => void;
  let release!: () => void;
  let terminating!: () => void;
  const started = new Promise<void>((resolve) => {
    terminating = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const process: IPtyProcess = {
    pid: 1234,
    write() {},
    resize() {},
    kill() {},
    onData(callback) {
      data = callback;
      return () => {};
    },
    onExit(callback) {
      exit = callback;
      return () => {};
    },
    async terminate() {
      exit({ exitCode: 1, signal: null });
      terminating();
      await held;
    },
  };
  const root = await realpath(temp('terminal-overload-root-'));
  const sessions = new TerminalSessions<string>(
    temp('terminal-overload-home-'),
    { spawn: async () => process },
    { authorize: () => true, resolveRoot: async () => root },
    { maxPendingBytes: 1024 },
  );
  await sessions.open('operator', scope, { cols: 80, rows: 24 });
  data('x'.repeat(1025));
  await started;
  let settled = false;
  const disposal = sessions.dispose().then(
    () => {
      settled = true;
      return null;
    },
    (error: unknown) => {
      settled = true;
      return error;
    },
  );
  try {
    await new Promise<void>((resolve) => setTimeout(resolve, 1000));
    expect(settled).toBe(false);
  } finally {
    release();
    const failure = await disposal;
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('overloaded');
  }
});
