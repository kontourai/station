import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

function assertRegularPrivateFile(path) {
  let info;
  try {
    info = lstatSync(path);
  } catch {
    throw new Error(
      'Windows Job guard compiler did not publish a regular executable',
    );
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1)
    throw new Error(
      'Windows Job guard compiler did not publish a regular executable',
    );
  chmodSync(path, 0o700);
}

function compilerDiagnostic(compiled) {
  return [
    compiled.error?.message,
    compiled.stdout?.trim(),
    compiled.stderr?.trim(),
    compiled.status == null ? undefined : `exit ${compiled.status}`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** Build a per-owner guard; never trust a predictable shared executable. */
export function buildWindowsOwnedGuard({
  source = resolve(import.meta.dirname, '../windows-owned-guard.cs'),
  spawnProcess = spawnSync,
  tempDirectory = tmpdir(),
  windir = process.env.WINDIR,
} = {}) {
  const directory = mkdtempSync(join(tempDirectory, 'station-owned-guard-'));
  const staged = join(directory, `${randomUUID()}.partial.exe`);
  const output = join(directory, 'station-windows-owned-guard.exe');
  const compiler = windir
    ? join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
    : 'csc.exe';
  try {
    const compiled = spawnProcess(
      compiler,
      ['/nologo', '/target:exe', `/out:${staged}`, source],
      { encoding: 'utf8', windowsHide: true },
    );
    if (compiled.error || compiled.status !== 0) {
      const diagnostic = compilerDiagnostic(compiled);
      throw new Error(
        `Windows Job guard compilation failed: ${diagnostic || 'unknown compiler failure'}`,
      );
    }
    assertRegularPrivateFile(staged);
    renameSync(staged, output);
    assertRegularPrivateFile(output);
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    path: output,
    cleanup() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
