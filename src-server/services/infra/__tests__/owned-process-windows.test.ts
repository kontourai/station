import { ChildProcess, execFile, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  evaluateWindowsRegistryDirTrust,
  forgetOwnedProcess,
  type ProcessIdentityProbe,
  recordOwnedProcess,
  resolveOwnedProcessOwner,
  sweepOrphanedOwnedProcesses,
  verifiedWindowsProcessTree,
  type WindowsProcessEntry,
  windowsBirthMicroseconds,
} from '../process-utils.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: vi.fn(actual.execFile) };
});

/**
 * #3873: the owned-process registry on Windows. Node reports synthetic POSIX
 * modes there (a writable directory reads 0o666), so the POSIX trust rule
 * would refuse every Windows registry. Windows trusts a real directory inside
 * the user's %LOCALAPPDATA%, records and forgets engines, and reaps an
 * orphaned engine together with only the descendants provably its own.
 */

const tempDir = trackTempDirs();

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  vi.unstubAllEnvs();
  vi.mocked(execFile).mockReset();
});

function simulateWindows(): { localAppData: string; registryDir: string } {
  const localAppData = tempDir('station-localappdata-');
  vi.stubEnv('LOCALAPPDATA', localAppData);
  Object.defineProperty(process, 'platform', { value: 'win32' });
  return {
    localAppData,
    registryDir: join(localAppData, 'Temp', 'station-owned-processes'),
  };
}

const ENGINE_BIRTH = '2026-10-31T10:00:00.1234560Z';

describe('Windows registry trust policy (#3873)', () => {
  const directory = { isDirectory: () => true, isSymbolicLink: () => false };
  const identity = (path: string) => path;

  test('trusts a real directory inside %LOCALAPPDATA%, case-insensitively', () => {
    expect(
      evaluateWindowsRegistryDirTrust(
        'C:\\Users\\me\\AppData\\Local\\Temp\\station-owned-processes',
        'c:\\users\\ME\\appdata\\local',
        { lstat: () => directory, realpath: identity },
      ),
    ).toBeNull();
  });

  test('refuses a junction or symlink, whatever it points at', () => {
    expect(
      evaluateWindowsRegistryDirTrust(
        'C:\\Users\\me\\AppData\\Local\\Temp\\station-owned-processes',
        'C:\\Users\\me\\AppData\\Local',
        {
          lstat: () => ({
            isDirectory: () => true,
            isSymbolicLink: () => true,
          }),
          realpath: identity,
        },
      ),
    ).toEqual({ kind: 'reparse-point' });
  });

  test('refuses a directory whose real path leaves the profile through a linked ancestor', () => {
    expect(
      evaluateWindowsRegistryDirTrust(
        'C:\\Users\\me\\AppData\\Local\\Temp\\station-owned-processes',
        'C:\\Users\\me\\AppData\\Local',
        {
          lstat: () => directory,
          realpath: (path) =>
            path.includes('Temp')
              ? 'D:\\shared\\station-owned-processes'
              : path,
        },
      ),
    ).toMatchObject({ kind: 'outside-user-profile' });
  });

  test('refuses a host-wide directory and the profile root itself', () => {
    for (const registryDir of [
      'C:\\ProgramData\\station-owned-processes',
      'C:\\Users\\me\\AppData\\LocalLow\\x',
      'C:\\Users\\me\\AppData\\Local',
    ]) {
      expect(
        evaluateWindowsRegistryDirTrust(
          registryDir,
          'C:\\Users\\me\\AppData\\Local',
          { lstat: () => directory, realpath: identity },
        ),
      ).toMatchObject({ kind: 'outside-user-profile' });
    }
  });

  test('fails closed without %LOCALAPPDATA%', () => {
    for (const localAppData of [undefined, '', 'relative\\path']) {
      expect(
        evaluateWindowsRegistryDirTrust('C:\\x\\y', localAppData, {
          lstat: () => directory,
          realpath: identity,
        }),
      ).toMatchObject({ kind: 'outside-user-profile' });
    }
  });

  test('a real junction under the profile is refused on this host', () => {
    const localAppData = tempDir('station-localappdata-');
    const target = tempDir('station-registry-target-');
    const link = join(localAppData, 'station-owned-processes');
    // A junction needs no privilege on Windows; elsewhere the type is ignored.
    symlinkSync(target, link, 'junction');
    expect(evaluateWindowsRegistryDirTrust(link, localAppData)).toEqual({
      kind: 'reparse-point',
    });
  });
});

describe('verifiedWindowsProcessTree (#3873)', () => {
  const engineUs = windowsBirthMicroseconds(ENGINE_BIRTH)!;
  const engine = 40_000;
  const table: WindowsProcessEntry[] = [
    { pid: engine, ppid: 4, createdUs: engineUs },
    { pid: engine + 1, ppid: engine, createdUs: engineUs + 5n },
    { pid: engine + 3, ppid: engine + 1, createdUs: engineUs + 9n },
    // Its parent pid named an earlier process that held `engine`'s pid: it
    // predates the engine, so it was never the engine's child.
    { pid: engine + 2, ppid: engine, createdUs: engineUs - 1_000_000n },
    { pid: engine + 4, ppid: engine + 2, createdUs: engineUs + 20n },
    { pid: 77, ppid: 4, createdUs: engineUs + 1n },
  ];

  test('includes only descendants born after the parent they name', () => {
    expect(verifiedWindowsProcessTree(engine, ENGINE_BIRTH, table)).toEqual([
      engine,
      engine + 1,
      engine + 3,
    ]);
  });

  test('is null when the engine is absent or born at another time', () => {
    expect(verifiedWindowsProcessTree(engine + 9, ENGINE_BIRTH, table)).toBe(
      null,
    );
    expect(
      verifiedWindowsProcessTree(engine, '2026-10-31T10:00:00.1234570Z', table),
    ).toBe(null);
    expect(verifiedWindowsProcessTree(engine, 'not a birth', table)).toBe(null);
  });
});

describe('Windows owned-process registry (#3873)', () => {
  test('records and forgets an engine in the trusted per-user directory', () => {
    const { registryDir } = simulateWindows();
    const owner = {
      pid: 41_000,
      instanceId: 'windows-instance',
      bootId: 'windows-boot',
      birth: ENGINE_BIRTH,
    };
    recordOwnedProcess(2_000_000_001, owner, 'engine', { registryDir });
    const file = join(registryDir, 'engine-2000000001.json');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({
      enginePid: 2_000_000_001,
      owner,
    });
    forgetOwnedProcess(2_000_000_001, { registryDir });
    expect(existsSync(file)).toBe(false);
  });

  test('refuses to write a registry outside %LOCALAPPDATA%', () => {
    simulateWindows();
    const outside = tempDir('station-outside-registry-');
    const log = vi.fn();
    recordOwnedProcess(
      2_000_000_002,
      { pid: 41_001, instanceId: 'x', bootId: 'y', birth: null },
      'engine',
      { registryDir: outside, log },
    );
    expect(existsSync(join(outside, 'engine-2000000002.json'))).toBe(false);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('%LOCALAPPDATA%'),
      expect.objectContaining({ reason: 'outside-user-profile' }),
    );
  });

  test('reaps an orphaned engine and its verified descendants only, never with /t', async () => {
    const { registryDir } = simulateWindows();
    mkdirSync(registryDir, { recursive: true });
    const enginePid = 2_000_000_010;
    const ownerPid = 2_000_000_009;
    const file = join(registryDir, `engine-${enginePid}.json`);
    writeFileSync(
      file,
      `${JSON.stringify({
        schemaVersion: 1,
        enginePid,
        engineBirth: ENGINE_BIRTH,
        owner: {
          pid: ownerPid,
          instanceId: 'gone',
          bootId: 'gone',
          birth: ENGINE_BIRTH,
        },
        command: 'engine',
        spawnedAt: '2026-10-31T10:00:00Z',
      })}\n`,
    );
    const engineUs = windowsBirthMicroseconds(ENGINE_BIRTH)!;
    let killed = false;
    const probeIdentity: ProcessIdentityProbe = (pid) =>
      pid === ownerPid || killed
        ? { state: 'dead' }
        : { state: 'exact', identity: { pid, start: ENGINE_BIRTH } };
    const killWindowsProcesses = vi.fn(async (_pids: number[]) => {
      killed = true;
    });
    const kill = vi.spyOn(process, 'kill');
    try {
      const result = await sweepOrphanedOwnedProcesses({
        registryDir,
        probeIdentity,
        listWindowsProcesses: async () => [
          { pid: enginePid, ppid: ownerPid, createdUs: engineUs },
          { pid: 500, ppid: enginePid, createdUs: engineUs + 1n },
          { pid: 501, ppid: enginePid, createdUs: engineUs - 1n },
        ],
        killWindowsProcesses,
      });
      expect(result.reaped).toEqual([enginePid]);
      expect(killWindowsProcesses).toHaveBeenCalledWith([enginePid, 500]);
      expect(existsSync(file)).toBe(false);
      expect(kill).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
  });

  test.each([
    'unreadable',
    'execution',
    'invalid-output',
    'utility-resolution',
  ])(
    'retains the record when the process table cannot be read: %s',
    async (failure) => {
      const { registryDir } = simulateWindows();
      mkdirSync(registryDir, { recursive: true });
      const enginePid = 2_000_000_020;
      const file = join(registryDir, `engine-${enginePid}.json`);
      writeFileSync(
        file,
        `${JSON.stringify({
          schemaVersion: 1,
          enginePid,
          engineBirth: ENGINE_BIRTH,
          owner: {
            pid: 2_000_000_019,
            instanceId: 'g',
            bootId: 'g',
            birth: null,
          },
          command: 'engine',
          spawnedAt: '2026-10-31T10:00:00Z',
        })}\n`,
      );
      const killWindowsProcesses = vi.fn(async () => {});
      const log = vi.fn();
      if (failure === 'utility-resolution') {
        vi.stubEnv('SystemRoot', 'relative');
      } else if (failure !== 'unreadable') {
        vi.mocked(execFile).mockImplementationOnce((...args) => {
          const callback = args.at(-1);
          if (typeof callback !== 'function')
            throw new Error('missing callback');
          callback(
            failure === 'execution'
              ? Object.assign(new Error('private probe error'), {
                  code: 'ETIMEDOUT',
                  signal: 'SIGKILL',
                  killed: true,
                })
              : null,
            'private invalid process table',
            'private stderr',
          );
          return new ChildProcess();
        });
      }
      const result = await sweepOrphanedOwnedProcesses({
        registryDir,
        log,
        probeIdentity: (pid) =>
          pid === enginePid
            ? { state: 'exact', identity: { pid, start: ENGINE_BIRTH } }
            : { state: 'dead' },
        ...(failure === 'unreadable'
          ? { listWindowsProcesses: async () => null }
          : {}),
        killWindowsProcesses,
      });
      expect(result.retained).toBe(1);
      expect(killWindowsProcesses).not.toHaveBeenCalled();
      expect(existsSync(file)).toBe(true);
      if (failure !== 'unreadable') {
        expect(log).toHaveBeenCalledWith(
          'owned-process sweep: Windows process table probe failed',
          expect.objectContaining({
            stage: failure,
            timeoutMs: 30_000,
            elapsedMs: expect.any(Number),
            error:
              failure === 'execution'
                ? {
                    name: 'Error',
                    code: 'ETIMEDOUT',
                    signal: 'SIGKILL',
                    killed: true,
                  }
                : expect.any(Object),
          }),
        );
        expect(JSON.stringify(log.mock.calls)).not.toContain('private');
      }
    },
  );
});

function isAlive(pid: number | null | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * The real journey on a Windows host: an owner killed outright (no cleanup)
 * leaves its engine and the engine's child running; the next boot's sweep
 * finds the record in the default per-user registry location and reaps both.
 */
describe.runIf(process.platform === 'win32')(
  'Windows orphan engine journey (#3873)',
  () => {
    // The default registry lives under the per-user %LOCALAPPDATA%\Temp, so the
    // journey's registry does too; the tracker removes it after the finally.
    const tempRoot = join(process.env.LOCALAPPDATA ?? '', 'Temp');
    const registryTempDir = trackTempDirs({ base: tempRoot });

    test('a killed owner leaves an orphan the sweep reaps, grandchild included', async () => {
      expect(
        process.env.LOCALAPPDATA,
        'LOCALAPPDATA must be set on Windows',
      ).toBeTruthy();
      mkdirSync(tempRoot, { recursive: true });
      const registryDir = registryTempDir('station-sweep-win-');
      const gcFile = join(registryDir, 'grandchild.pid');
      const owner = spawn(
        process.execPath,
        [join(__dirname, 'helpers', 'orphan-engine-owner.mjs'), gcFile],
        { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true },
      );
      let engine: number | null = null;
      let grandchild: number | null = null;
      try {
        engine = await new Promise<number>((resolve, reject) => {
          let buffer = '';
          owner.stdout!.on('data', (chunk: Buffer) => {
            buffer += chunk.toString();
            const match = /ENGINE_PID=(\d+)\r?\n/.exec(buffer);
            if (match) resolve(Number(match[1]));
          });
          owner.once('error', reject);
          owner.once('exit', (code) =>
            reject(new Error(`owner exited early code=${code}`)),
          );
        });
        for (let i = 0; i < 400 && grandchild === null; i++) {
          try {
            grandchild = Number(readFileSync(gcFile, 'utf8').trim()) || null;
          } catch {
            await new Promise((r) => setTimeout(r, 25));
          }
        }
        expect(grandchild, 'the fixture reports its grandchild').not.toBe(null);

        const record = recordOwnedProcess(
          engine,
          resolveOwnedProcessOwner(
            { STATION_INSTANCE_ID: 'win-journey', STATION_BOOT_ID: 'boot' },
            owner.pid!,
          ),
          'fake-engine',
          { registryDir },
        );
        expect(
          record.engineBirth,
          'engine birth must be readable',
        ).toBeTruthy();
        expect(record.owner.birth, 'owner birth must be readable').toBeTruthy();
        expect(existsSync(join(registryDir, `engine-${engine}.json`))).toBe(
          true,
        );

        // TerminateProcess on the owner alone: it runs no cleanup.
        process.kill(owner.pid!, 'SIGKILL');
        await new Promise<void>((resolve) => {
          if (owner.exitCode !== null || owner.signalCode !== null) resolve();
          else owner.once('exit', () => resolve());
        });
        expect(isAlive(engine)).toBe(true);
        expect(isAlive(grandchild)).toBe(true);

        const sweepLogs: Array<{ message: string; data?: unknown }> = [];
        const result = await sweepOrphanedOwnedProcesses({
          registryDir,
          log: (message, data) => sweepLogs.push({ message, data }),
        });
        const diagnostics = () => JSON.stringify({ record, result, sweepLogs });
        expect(result.reaped, diagnostics()).toEqual([engine]);
        for (
          let i = 0;
          i < 200 && (isAlive(engine) || isAlive(grandchild));
          i++
        ) {
          await new Promise((r) => setTimeout(r, 25));
        }
        expect(isAlive(engine), diagnostics()).toBe(false);
        expect(isAlive(grandchild), diagnostics()).toBe(false);
        expect(
          existsSync(join(registryDir, `engine-${engine}.json`)),
          diagnostics(),
        ).toBe(false);
      } finally {
        for (const pid of [owner.pid, engine, grandchild]) {
          if (!pid || !isAlive(pid)) continue;
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // Already gone.
          }
        }
      }
    }, 180_000);
  },
);
