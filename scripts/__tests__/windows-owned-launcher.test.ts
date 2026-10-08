import { fork } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { exactProcessIdentity } from '../../packages/shared/src/process-identity.mjs';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { spawnSyncBounded } from '../lib/bounded-capture.mjs';
import { buildWindowsOwnedGuard } from '../lib/windows-owned-guard-build.mjs';

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
function launch(
  envelope: Record<string, unknown>,
  options: { birthReaderPreload?: string; resumeOnBind?: boolean } = {},
) {
  const child = fork(
    LAUNCHER,
    [Buffer.from(JSON.stringify(envelope)).toString('base64url')],
    {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      serialization: 'json',
      windowsHide: true,
      ...(options.birthReaderPreload
        ? { execArgv: ['--require', options.birthReaderPreload] }
        : {}),
    },
  );
  const messages: IpcMessage[] = [];
  let stdout = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  const complete = new Promise<IpcMessage>((resolveComplete, reject) => {
    const timer = setTimeout(
      () =>
        reject(new Error('launcher never published owned-command-complete')),
      15_000,
    );
    child.on('message', (message: IpcMessage) => {
      messages.push(message);
      if (message?.type === 'owned-command-bound' && options.resumeOnBind)
        child.send({ type: 'owned-command-resume' });
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
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGTERM');
    await exited;
  };
  return { child, messages, complete, dispose, stdout: () => stdout };
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

const makeTempDir = trackTempDirs();
const GUARD_SOURCE = resolve(import.meta.dirname, '../windows-owned-guard.cs');

function nativeGuard(wrongCreation = false) {
  const directory = makeTempDir('station-native-binding-');
  let source = GUARD_SOURCE;
  if (wrongCreation) {
    const original = readFileSync(GUARD_SOURCE, 'utf8');
    const binding =
      'Send(writer, "BOUND " + child.dwProcessId + " " + childCreation);';
    expect(original.split(binding)).toHaveLength(2);
    source = join(directory, 'wrong-creation.cs');
    writeFileSync(
      source,
      original.replace(
        binding,
        'Send(writer, "BOUND " + child.dwProcessId + " " + DateTime.Parse(childCreation, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind).AddTicks(10).ToString("o", CultureInfo.InvariantCulture));',
      ),
    );
  }
  return buildWindowsOwnedGuard({
    source,
    tempDirectory: directory,
    spawnProcess: (executable, args, options) =>
      spawnSyncBounded(executable, args, { ...options, timeout: 10_000 }),
  });
}

function nativeEnvelope(guardPath: string) {
  const parent = exactProcessIdentity(process.pid);
  if (!parent)
    throw new Error('Native binding fixture parent identity unavailable');
  return {
    executable: process.execPath,
    args: ['-e', "process.stdout.write('native-ran\\n')"],
    guardPath,
    parent,
  };
}

function unavailableBirthReader() {
  const directory = makeTempDir('station-unavailable-birth-');
  const preload = join(directory, 'unavailable-birth.cjs');
  writeFileSync(
    preload,
    [
      "const childProcess = require('node:child_process');",
      "const { syncBuiltinESMExports } = require('node:module');",
      "const { win32 } = require('node:path');",
      "const expected = win32.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');",
      'const original = childProcess.execFileSync;',
      'childProcess.execFileSync = function(command, args, options) {',
      '  if (command.toLowerCase() === expected.toLowerCase() && args.length === 4 &&',
      "      args[0] === '-NoProfile' && args[1] === '-NonInteractive' && args[2] === '-Command' &&",
      "      args[3].startsWith('$process = [System.Diagnostics.Process]::GetProcessById(') &&",
      "      args[3].includes('$process.StartTime.ToUniversalTime()')) {",
      "    if (options.timeout !== 1500) throw new Error('birth fixture expected original 1500ms bound');",
      "    throw Object.assign(new Error('controlled unavailable birth reader'), { code: 'ETIMEDOUT' });",
      '  }',
      '  return Reflect.apply(original, this, [command, args, options]);',
      '};',
      'syncBuiltinESMExports();',
    ].join('\n'),
  );
  return preload;
}

describe('Windows owned launcher exact native binding', () => {
  test.skipIf(process.platform !== 'win32')(
    'binds and runs a known native Job target before publishing success',
    async () => {
      const guard = nativeGuard();
      const run = launch(nativeEnvelope(guard.path), { resumeOnBind: true });
      try {
        expect(await run.complete).toMatchObject({
          status: 0,
          signal: null,
          error: null,
        });
        expect(
          run.messages.some(
            (message) => message.type === 'owned-command-bound',
          ),
        ).toBe(true);
        expect(run.stdout()).toContain('native-ran');
      } finally {
        await run.dispose();
        guard.cleanup();
      }
    },
  );

  test.skipIf(process.platform !== 'win32')(
    'refuses a wrong creation claim for its known native child without resuming it',
    async () => {
      const guard = nativeGuard(true);
      const run = launch(nativeEnvelope(guard.path), { resumeOnBind: true });
      try {
        const complete = await run.complete;
        expect(complete).toMatchObject({ status: null, signal: null });
        expect(complete.error).toContain(
          'Windows owned guard binding did not match exact identities',
        );
        expect(complete.error).toContain('"targetState":"exact"');
        expect(complete.error).toContain('"targetCreationMatches":false');
        expect(complete.error).toContain('"guardState":"exact"');
        expect(
          run.messages.some(
            (message) => message.type === 'owned-command-bound',
          ),
        ).toBe(false);
        expect(run.stdout()).not.toContain('native-ran');
      } finally {
        await run.dispose();
        guard.cleanup();
      }
    },
  );

  test.skipIf(process.platform !== 'win32')(
    'refuses an unavailable birth reader with bounded probe context and no target resume',
    async () => {
      const guard = nativeGuard();
      const envelope = nativeEnvelope(guard.path);
      const run = launch(envelope, {
        birthReaderPreload: unavailableBirthReader(),
        resumeOnBind: true,
      });
      try {
        const complete = await run.complete;
        expect(complete).toMatchObject({ status: null, signal: null });
        expect(complete.error).toContain('"targetState":"unavailable"');
        expect(complete.error).toContain('"targetCreationMatches":null');
        expect(complete.error).toContain(
          'powershell.exe timed out after 1500ms',
        );
        expect(
          run.messages.some(
            (message) => message.type === 'owned-command-bound',
          ),
        ).toBe(false);
        expect(run.stdout()).not.toContain('native-ran');
      } finally {
        await run.dispose();
        guard.cleanup();
      }
    },
  );
});
