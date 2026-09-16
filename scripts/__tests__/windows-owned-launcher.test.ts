import { fork } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const LAUNCHER = resolve(import.meta.dirname, '../windows-owned-launcher.mjs');

type IpcMessage = { type?: string; state?: Record<string, unknown> } & Record<
  string,
  unknown
>;

// The real launcher module, forked with an IPC channel. The guard it spawns
// is `process.execPath <pid> <start> <executable>`: node cannot load a module
// named after the pid, so it exits fast with every inherited fd closed. That
// drives the real settlement through rawEnd/guardClose/abort -- and only the
// launcher's `onState` wiring turns those transitions into
// `owned-command-settlement-state` IPC messages. This is the production
// delivery path the helper tests cannot reach.
function launch(envelope: Record<string, unknown>) {
  const child = fork(
    LAUNCHER,
    [Buffer.from(JSON.stringify(envelope)).toString('base64url')],
    { stdio: ['pipe', 'pipe', 'pipe', 'ipc'], serialization: 'json' },
  );
  const messages: IpcMessage[] = [];
  const complete = new Promise<IpcMessage>((resolveComplete, reject) => {
    const timer = setTimeout(
      () =>
        reject(new Error('launcher never published owned-command-complete')),
      15_000,
    );
    child.on('message', (message: IpcMessage) => {
      messages.push(message);
      if (message?.type === 'owned-command-complete') {
        clearTimeout(timer);
        resolveComplete(message);
      }
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`launcher exited early (${code ?? signal})`));
    });
  });
  const dispose = async () => {
    const exited = new Promise<void>((resolveExit) => {
      if (child.exitCode !== null || child.signalCode !== null)
        return resolveExit();
      child.once('exit', () => resolveExit());
    });
    if (child.connected) child.disconnect();
    child.kill('SIGTERM');
    await exited;
  };
  return { child, messages, complete, dispose };
}

describe('Windows owned launcher settlement-state delivery', () => {
  test('publishes settlement-state messages to the coordinator over IPC before completing', async () => {
    const run = launch({
      executable: 'phase.exe',
      args: [],
      guardPath: process.execPath,
      parent: { pid: process.pid, start: '2026-09-06T23:17:13.4057000Z' },
    });
    try {
      const complete = await run.complete;
      // The fake guard never speaks the protocol, so completion is an abort.
      expect(complete).toMatchObject({ status: null, signal: null });
      expect(typeof complete.error).toBe('string');

      const completeIndex = run.messages.indexOf(complete);
      const states = run.messages
        .slice(0, completeIndex)
        .filter(
          (message) => message?.type === 'owned-command-settlement-state',
        );
      // Delivery order matters: state is published by the settlement BEFORE
      // the abort result, so the coordinator folds it in before it resolves.
      expect(states.length).toBeGreaterThanOrEqual(1);
      for (const message of states) {
        expect(message.state).toMatchObject({
          complete: false,
          completeStatus: null,
          stdoutEof: expect.any(Boolean),
          stderrEof: expect.any(Boolean),
          stdoutDrained: expect.any(Boolean),
          stderrDrained: expect.any(Boolean),
          acknowledged: expect.any(Boolean),
          aborted: expect.any(Boolean),
        });
        expect([null, true, false]).toContain(message.state?.guardCloseOk);
      }
      expect(states.at(-1)?.state).toMatchObject({ aborted: true });
    } finally {
      await run.dispose();
    }
  });
});
