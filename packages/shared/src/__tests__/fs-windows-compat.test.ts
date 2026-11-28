import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs.js';
import {
  fsyncDirectorySync,
  fsyncFileSync,
  renameFileSyncRetrying,
  renamePathSyncRetrying,
  rmDirSyncRetrying,
} from '../fs-windows-compat.js';
import {
  encodePowerShellCommand,
  runWindowsTrustCommand,
  windowsSystemUtilityPath,
} from '../windows-path-trust.js';

const makeTempDir = trackTempDirs();

function setWindowsDataDenial(file: string, denied: boolean): void {
  const encodedPath = Buffer.from(file).toString('base64');
  const command = encodePowerShellCommand(
    `$ErrorActionPreference='Stop'; $file=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}')); $acl=[IO.File]::GetAccessControl($file); $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $rights=[Security.AccessControl.FileSystemRights]::ReadData -bor [Security.AccessControl.FileSystemRights]::WriteData; $rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,$rights,[Security.AccessControl.AccessControlType]::Deny); ${denied ? '$acl.AddAccessRule($rule)' : '$acl.RemoveAccessRuleSpecific($rule)'}; [IO.File]::SetAccessControl($file,$acl)`,
  );
  const result = runWindowsTrustCommand(
    windowsSystemUtilityPath('powershell'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', command],
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
}

describe('fsyncFileSync (#2675 W3)', () => {
  test('flushes a writable file with host-supported platform rules', () => {
    const dir = makeTempDir('station-fsync-file-');
    const file = join(dir, 'data');
    writeFileSync(file, 'x');
    expect(() => fsyncFileSync(file)).not.toThrow();
    if (process.platform !== 'win32')
      expect(() => fsyncFileSync(file, 'win32')).not.toThrow();
  });

  test('the Windows rule opens for writing, and leaves a read-only file unflushed', () => {
    const dir = makeTempDir('station-fsync-file-');
    const file = join(dir, 'data');
    writeFileSync(file, 'x');
    chmodSync(file, 0o444);
    try {
      if (process.platform !== 'win32')
        expect(() => fsyncFileSync(file, 'linux')).not.toThrow();
      const reported: string[] = [];
      expect(() =>
        fsyncFileSync(file, 'win32', (message) => reported.push(message)),
      ).not.toThrow();
      expect(reported).toEqual([
        `${file} is read-only, so it was not flushed to disk (Windows flushes only through a writable handle)`,
      ]);
    } finally {
      chmodSync(file, 0o600);
    }
    // A missing file is still an error under both.
    expect(() => fsyncFileSync(join(dir, 'missing'), 'win32')).toThrow(
      /ENOENT/,
    );
  });

  test('the Windows rule throws a refusal that is not the read-only case', () => {
    const dir = makeTempDir('station-fsync-file-');
    const locked = join(dir, 'locked');
    mkdirSync(locked);
    const file = join(locked, 'data');
    writeFileSync(file, 'x');
    const reported: string[] = [];
    try {
      if (process.platform === 'win32') {
        setWindowsDataDenial(file, true);
        expect(statSync(file).mode & 0o200).not.toBe(0);
        expect(() => readFileSync(file)).toThrow(/EPERM/);
      } else {
        chmodSync(locked, 0o000);
      }
      expect(() =>
        fsyncFileSync(file, 'win32', (message) => reported.push(message)),
      ).toThrow(process.platform === 'win32' ? /EPERM/ : /EACCES/);
      expect(reported).toEqual([]);
    } finally {
      if (process.platform === 'win32') setWindowsDataDenial(file, false);
      else chmodSync(locked, 0o700);
    }
    expect(readFileSync(file, 'utf8')).toBe('x');
    expect(() => fsyncFileSync(file)).not.toThrow();
  });
});

describe('fsyncDirectorySync', () => {
  test('runs the identity check on every platform', () => {
    const dir = makeTempDir('fs-windows-compat-');
    let sawIdentity = false;
    fsyncDirectorySync(dir, (stat) => {
      sawIdentity = true;
      expect(stat.isDirectory()).toBe(true);
    });
    expect(sawIdentity).toBe(true);
  });

  test('propagates a failing identity check instead of swallowing it', () => {
    const dir = makeTempDir('fs-windows-compat-');
    expect(() =>
      fsyncDirectorySync(dir, () => {
        throw new Error('identity mismatch');
      }),
    ).toThrow('identity mismatch');
  });
});

describe('rmDirSyncRetrying', () => {
  test('removes a populated directory tree', () => {
    const dir = makeTempDir('fs-windows-compat-rm-');
    mkdirSync(join(dir, 'nested'), { recursive: true });
    writeFileSync(join(dir, 'nested', 'file.txt'), 'content');

    rmDirSyncRetrying(dir);

    expect(existsSync(dir)).toBe(false);
  });

  test('does not throw when the directory is already gone', () => {
    const dir = makeTempDir('fs-windows-compat-rm-');
    rmDirSyncRetrying(dir);
    expect(() => rmDirSyncRetrying(dir)).not.toThrow();
  });
});

test('rename retry never hides an absent source or removes the existing destination', () => {
  const root = makeTempDir('station-rename-fault-');
  const destination = join(root, 'target.json');
  writeFileSync(destination, 'original');
  const waiting = vi.spyOn(Atomics, 'wait');
  try {
    expect(() =>
      renameFileSyncRetrying(join(root, 'absent'), destination, 'win32'),
    ).toThrow(/ENOENT/);
    expect(waiting).not.toHaveBeenCalled();
    expect(readFileSync(destination, 'utf8')).toBe('original');
  } finally {
    waiting.mockRestore();
    rmDirSyncRetrying(root);
  }
});

describe('renamePathSyncRetrying (#3363)', () => {
  const refused = (code: string) =>
    Object.assign(new Error(`${code}: operation not permitted, rename`), {
      code,
    });

  test('retries a transient Windows refusal of a real directory rename until it clears', () => {
    const dir = makeTempDir('station-rename-');
    const source = join(dir, '.incoming.1');
    mkdirSync(source);
    writeFileSync(join(source, 'file'), 'x');
    let refusals = 2;
    const waits: number[] = [];
    renamePathSyncRetrying(source, join(dir, '1.0.0'), {
      platform: 'win32',
      rename: (from, to) => {
        if (refusals > 0) {
          refusals -= 1;
          throw refused('EPERM');
        }
        renameSync(from, to);
      },
      wait: (ms) => waits.push(ms),
    });
    expect(readFileSync(join(dir, '1.0.0', 'file'), 'utf8')).toBe('x');
    expect(waits).toEqual([500, 500]);
  });

  test('a refusal that persists surfaces the original error after ten tries', () => {
    const errors = ['EBUSY', 'EPERM', 'EACCES'].map(refused);
    let calls = 0;
    const thrown = (() => {
      try {
        renamePathSyncRetrying('a', 'b', {
          platform: 'win32',
          rename: () => {
            throw errors[Math.min(calls++, 2)];
          },
          wait: () => undefined,
        });
      } catch (error) {
        return error;
      }
    })();
    expect(thrown).toBe(errors[0]);
    expect(calls).toBe(10);
  });

  test('is not retried off Windows, nor for any other error', () => {
    let calls = 0;
    const once = (platform: NodeJS.Platform, code: string) => {
      calls = 0;
      expect(() =>
        renamePathSyncRetrying('a', 'b', {
          platform,
          rename: () => {
            calls += 1;
            throw refused(code);
          },
          wait: () => undefined,
        }),
      ).toThrow(code);
      return calls;
    };
    expect(once('linux', 'EPERM')).toBe(1);
    expect(once('win32', 'ENOENT')).toBe(1);
  });
});
