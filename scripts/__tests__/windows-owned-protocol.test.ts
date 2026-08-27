import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { buildWindowsOwnedGuard } from '../lib/windows-owned-guard-build.mjs';
import { createWindowsOwnedProtocol } from '../lib/windows-owned-protocol.mjs';

const BOUND = 'BOUND 1 2025-08-03T00:00:00.0000000Z';

describe('Windows owned guard control protocol', () => {
  test('accepts a canonical UTC ISO BOUND identity and rejects duplicate control', () => {
    const protocol = createWindowsOwnedProtocol();
    expect(protocol.receive('@@STATION_JOB_BOUND@@')).toMatchObject({
      ok: false,
    });
    expect(protocol.receive(BOUND)).toMatchObject({
      ok: true,
      action: 'bound',
      processStart: '2025-08-03T00:00:00.0000000Z',
    });
    expect(
      protocol.receive('BOUND 2 2025-08-03T00:00:00.0000000Z'),
    ).toMatchObject({ ok: false });
  });

  test('rejects malformed or noncanonical BOUND identities without changing state', () => {
    for (const identity of [
      '123',
      '2025-08-03T00:00:00.000000Z',
      '2025-08-03T00:00:00.00000000Z',
      '2025-08-03T00:00:00.0000000+00:00',
      '2025-08-03T00:00:00.0000000z',
      '2025-13-03T00:00:00.0000000Z',
      '2025-08-03T24:00:00.0000000Z',
      '0000-08-03T00:00:00.0000000Z',
      '2025-02-29T00:00:00.0000000Z',
    ]) {
      const protocol = createWindowsOwnedProtocol();
      expect(protocol.receive(`BOUND 1 ${identity}`)).toMatchObject({
        ok: false,
      });
      expect(protocol.state()).toBe('awaiting-bound');
    }
  });

  test('requires RESUME before a signed-integer COMPLETE', () => {
    const protocol = createWindowsOwnedProtocol();
    protocol.receive(BOUND);
    expect(protocol.receive('COMPLETE 0')).toMatchObject({ ok: false });
    expect(protocol.resume()).toMatchObject({ ok: true });
    expect(protocol.receive('COMPLETE 0x0')).toMatchObject({ ok: false });
    expect(protocol.receive('COMPLETE -1')).toMatchObject({
      ok: true,
      action: 'complete',
      status: -1,
    });
  });

  test('retains zero as a valid COMPLETE status', () => {
    const protocol = createWindowsOwnedProtocol();
    protocol.receive(BOUND);
    protocol.resume();
    expect(protocol.receive('COMPLETE 0')).toMatchObject({
      ok: true,
      action: 'complete',
      status: 0,
    });
  });

  test('fails closed on control EOF or ABORT before RESUME', () => {
    const eof = createWindowsOwnedProtocol();
    expect(eof.receive(null)).toMatchObject({ ok: false });
    const aborted = createWindowsOwnedProtocol();
    aborted.receive(BOUND);
    expect(aborted.abort()).toMatchObject({ ok: true });
    expect(aborted.resume()).toMatchObject({ ok: false });
  });

  test('rejects oversized control records before they can alter state', () => {
    expect(
      createWindowsOwnedProtocol().receive(`BOUND 1 ${'9'.repeat(2048)}`),
    ).toMatchObject({ ok: false });
  });
});

test('launcher wires its settlement controller and rejects partial control EOF', () => {
  const launcher = readFileSync(
    join(import.meta.dirname, '..', 'windows-owned-launcher.mjs'),
    'utf8',
  );
  expect(launcher).toContain('createWindowsOwnedSettlement');
  expect(launcher).toContain('settlement.writeFinish');
  expect(launcher).toContain('owned-command-tree-settled');
  expect(launcher).toContain("destination.once('drain'");
  expect(launcher).toContain('control stream ended with a partial record');
  expect(launcher).toContain('const finishSuccessfulSettlement = (status)');
  expect(launcher).toContain('onComplete: finishSuccessfulSettlement');
  expect(launcher).toContain('if (successfullySettled) return process.exit(0)');
  expect(launcher).not.toContain(
    'onComplete: (status) => {\n      closeOutputs();',
  );
  expect(launcher).toContain("process.once('disconnect', disconnect)");
});

describe('Windows owned guard build', () => {
  test('uses a unique private staged executable and rejects an empty compiler result', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-guard-build-test-'));
    const source = join(root, 'guard.cs');
    writeFileSync(source, 'source');
    try {
      expect(() =>
        buildWindowsOwnedGuard({
          source,
          tempDirectory: root,
          spawnProcess: () => ({ status: 0, stderr: '' }),
        }),
      ).toThrow(/regular executable/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('retains both compiler output streams in a failure diagnostic', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-guard-build-test-'));
    try {
      expect(() =>
        buildWindowsOwnedGuard({
          tempDirectory: root,
          spawnProcess: () => ({
            status: 1,
            stdout: 'compiler stdout diagnostic',
            stderr: 'compiler stderr diagnostic',
          }),
        }),
      ).toThrow(/compiler stdout diagnostic[\s\S]*compiler stderr diagnostic/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects a compiler result replaced with a symlink before publication', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-guard-build-test-'));
    const source = join(root, 'guard.cs');
    writeFileSync(source, 'source');
    try {
      expect(() =>
        buildWindowsOwnedGuard({
          source,
          tempDirectory: root,
          spawnProcess: (_compiler: string, args: string[]) => {
            const staged = args.find((argument) =>
              argument.startsWith('/out:'),
            );
            symlinkSync(source, staged?.slice('/out:'.length) ?? 'missing');
            return { status: 0, stderr: '' };
          },
        }),
      ).toThrow(/regular executable/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test('guard bounds the control read and binds creation identity to the opened parent handle', () => {
  const source = readFileSync(
    join(import.meta.dirname, '..', 'windows-owned-guard.cs'),
    'utf8',
  );
  expect(source).toContain('AssignProcessToJobObject(job, child.hProcess)');
  expect(source).toContain(
    'if (!resumed) KillAndReapOnce(child.hProcess, ref childReaped)',
  );
  expect(source).toContain(
    'OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, false, parentPid)',
  );
  expect(source).toContain(
    'CreationIsoAtMicrosecondPrecision(parent) != args[1]',
  );
  expect(source).toContain('const long TICKS_PER_MICROSECOND = 10');
  expect(source).toContain(
    '(ticks / TICKS_PER_MICROSECOND) * TICKS_PER_MICROSECOND',
  );
  expect(source).toContain('new DateTime(');
  expect(source).toContain('DateTimeKind.Utc');
  expect(source).toContain(
    'normalized.ToString("o", CultureInfo.InvariantCulture)',
  );
  expect(source).toContain('GetProcessTimes(process');
  expect(source).toContain('using System.Threading;');
  expect(source).toContain('TextReader reader = Console.In;');
  expect(source).toContain('TextWriter writer = Console.Out;');
  expect(source).toContain('complete while control stdin stays open');
  expect(source).toContain('normal COMPLETE exits promptly');
  expect(source).not.toContain('using (var reader = Console.In)');
  expect(source).not.toContain('using (var writer = Console.Out)');
  expect(source).toContain('const int CONTROL_PENDING = 0;');
  expect(source).toContain('const int CONTROL_RESUME = 1;');
  expect(source).toContain('const int CONTROL_ABORT = 2;');
  expect(source).toContain('const int CONTROL_INVALID = -1;');
  expect(source).toContain('sealed class OneLineControlMonitor');
  expect(source).toContain('var worker = new Thread(() =>');
  expect(source).toContain('worker.IsBackground = true;');
  expect(source).toContain('string line = reader.ReadLine();');
  expect(source).toContain('line == "RESUME" ? CONTROL_RESUME');
  expect(source).toContain('line == "ABORT" ? CONTROL_ABORT');
  expect(source).toContain('Interlocked.Exchange(ref state, next)');
  expect(source).toContain('Volatile.Read(ref state)');
  expect(source).toContain('var resumeMonitor = new OneLineControlMonitor();');
  expect(source).toContain('WaitForResumeBounded(resumeMonitor, parent)');
  expect(source).toContain('while (monitor.State == CONTROL_PENDING)');
  expect(source).toContain('return monitor.State == CONTROL_RESUME;');
  expect(source).toContain(
    'uint parentWait = WaitForSingleObject(parent, 50);',
  );
  expect(source).toContain('no RESUME, this bounds');
  expect(source).toContain('var abortMonitor = new OneLineControlMonitor();');
  expect(source).toContain('abortMonitor.State != CONTROL_PENDING');
  expect(source).not.toContain('Task<string> abortRead;');
  expect(source).not.toContain('try { abortRead = reader.ReadLineAsync(); }');
  expect(source).not.toContain('PostResumeControlState(');
  expect(source).not.toContain('using System.Threading.Tasks;');
  expect(source).not.toContain('ReadLineAsync');
  expect(source).not.toContain('ReadResumeBounded(');
  expect(source).toContain('KillAndReapOnce(child.hProcess, ref childReaped)');
  expect(source).toContain('CONTROL_DEADLINE_MS');
  expect(source).toContain('const int STARTF_USESTDHANDLES');
  expect(source).not.toContain('const uint STARTF_USESTDHANDLES');
  expect(source).toContain('WaitForSingleObject(parent, 0) != WAIT_TIMEOUT');
  expect(source).toContain('WaitForSingleObject(child.hProcess, 50)');
  expect(source).toContain('GetExitCodeProcess(child.hProcess, out exitCode)');
  expect(source).toContain('_get_osfhandle(3)');
  expect(source).toContain('_get_osfhandle(4)');
  expect(source).toContain('PROC_THREAD_ATTRIBUTE_HANDLE_LIST');
  expect(source).toContain(
    'static readonly IntPtr PROC_THREAD_ATTRIBUTE_HANDLE_LIST',
  );
  expect(source).not.toContain(
    'const IntPtr PROC_THREAD_ATTRIBUTE_HANDLE_LIST',
  );
  expect(source).toContain('EXTENDED_STARTUPINFO_PRESENT');
  expect(source).toContain('hStdOutput = rawOut');
  expect(source).toContain('hStdError = rawErr');
  expect(source).toContain('GetExitCodeProcess(child.hProcess, out exitCode)');
  expect(source).toContain(
    'CreateProcess(null, command.ToString(), IntPtr.Zero, IntPtr.Zero, true',
  );
  expect(source).not.toContain('Process.GetProcessById');
  expect(source).not.toContain('NamedPipeClientStream');
});

test('guard gives a RESUME published during the parent wait priority over the deadline', () => {
  const source = readFileSync(
    join(import.meta.dirname, '..', 'windows-owned-guard.cs'),
    'utf8',
  );
  const parentWait = source.indexOf(
    'uint parentWait = WaitForSingleObject(parent, 50);',
  );
  const stateRead = source.indexOf('int state = monitor.State;', parentWait);
  const parentDeath = source.indexOf(
    'if (parentWait != WAIT_TIMEOUT) return false;',
    stateRead,
  );
  const resume = source.indexOf(
    'if (state != CONTROL_PENDING) return state == CONTROL_RESUME;',
    parentDeath,
  );
  const deadline = source.indexOf(
    'if (DateTime.UtcNow >= deadline) return false;',
    resume,
  );
  expect(parentWait).toBeGreaterThanOrEqual(0);
  expect(stateRead).toBeGreaterThan(parentWait);
  expect(parentDeath).toBeGreaterThan(stateRead);
  expect(resume).toBeGreaterThan(parentDeath);
  expect(deadline).toBeGreaterThan(resume);
});

test('guard reports stable pre-BIND setup stages without command details', () => {
  const source = readFileSync(
    join(import.meta.dirname, '..', 'windows-owned-guard.cs'),
    'utf8',
  );
  expect(source).toContain('station-owned-guard: ');
  for (const stage of [
    'parent-open',
    'parent-identity',
    'raw-fd',
    'raw-handle-inherit',
    'nul-open',
    'attribute-list-init',
    'attribute-list-update',
    'create-process',
    'assign-job',
    'child-identity',
    'pre-bind-exception',
  ])
    expect(source).toContain(`"${stage}"`);
  expect(source).not.toContain('Console.Error.WriteLine(command');
});
