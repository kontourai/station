import { createHash } from 'node:crypto';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  lookupProcessBirthFingerprint,
  WINDOWS_BIRTH_HELPER_DIGEST_FILENAME,
  WINDOWS_BIRTH_HELPER_FILENAME,
} from '../../packages/shared/src/process-identity.mjs';
import { execFileSyncBounded } from './bounded-capture.mjs';
import { buildWindowsOwnedGuard } from './windows-owned-guard-build.mjs';

/**
 * Precompiles the Windows Job guard (scripts/windows-owned-guard.cs) into the
 * archive's runtime/, beside node.exe, with the SHA-256 the runtime checks
 * before it runs it (#2805). Its `--identity <pid>` replaces the cold
 * PowerShell start of every process-birth probe. Compiled here, on the Windows
 * runner that builds the Windows archive, and refused anywhere else: csc.exe
 * is the .NET Framework compiler every Windows host carries. The staged helper
 * must print exactly the PowerShell probe's birth for this process, or the
 * archive is not built.
 */
export function stageWindowsBirthHelper(
  runtimeDir,
  {
    build = buildWindowsOwnedGuard,
    platform = process.platform,
    // The builder's Node.js is the runner's, not an archive runtime, so this
    // resolves no staged helper and runs the PowerShell probe.
    probeWithPowerShell = (pid) =>
      lookupProcessBirthFingerprint(pid, { timeoutMs: 60_000 }),
    run = (file, args) =>
      execFileSyncBounded(file, args, {
        encoding: 'utf8',
        timeout: 60_000,
        windowsHide: true,
      }),
  } = {},
) {
  if (platform !== 'win32') {
    throw new Error(
      'The Windows archive stages a guard compiled on Windows; build it on a Windows host',
    );
  }
  const compiled = build();
  try {
    const helper = join(runtimeDir, WINDOWS_BIRTH_HELPER_FILENAME);
    cpSync(compiled.path, helper);
    const digest = createHash('sha256')
      .update(readFileSync(helper))
      .digest('hex');
    writeFileSync(
      join(runtimeDir, WINDOWS_BIRTH_HELPER_DIGEST_FILENAME),
      `${digest}\n`,
    );
    const helperBirth = String(
      run(helper, ['--identity', String(process.pid)]),
    ).trim();
    const powerShellBirth = probeWithPowerShell(process.pid);
    if (!powerShellBirth || helperBirth !== powerShellBirth) {
      throw new Error(
        `The staged birth helper disagrees with the PowerShell probe for pid ${process.pid}: ${JSON.stringify(helperBirth)} vs ${JSON.stringify(powerShellBirth)}`,
      );
    }
    return { helper, digest };
  } finally {
    compiled.cleanup();
  }
}
