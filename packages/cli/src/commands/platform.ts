import { execFileSync, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createInterface } from 'node:readline/promises';
import { resolveStationRuntimeContext } from '@kontourai/station-shared/runtime-path-resolver';

export const IS_WINDOWS = process.platform === 'win32';
export const IS_MAC = process.platform === 'darwin';

export type ProcessFingerprint = {
  pid: number;
  startToken: string;
  commandDigest: string;
};

type StableFingerprintOptions = {
  inspect?: (pid: number) => ProcessFingerprint | null;
  intervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => void;
  stableMs?: number;
  timeoutMs?: number;
};

type InspectFingerprintDependencies = {
  exec?: typeof execFileSync;
};

/**
 * C-locale `lstart` is `Www Mmm [ d]d HH:MM:SS YYYY` (day space-padded).
 * Field-parsing instead of the previous fixed 24-character slice: a shape
 * this regex does not recognize returns null (fail-closed) rather than a
 * token cut mid-field (station#3049).
 *
 * Accepted residual (review LOW-3): callers read null as "process absent"
 * — stopRecord's already-absent path, not a refusal — so a LIVE process
 * whose ps output somehow defies the LC_ALL=C pin would be treated as
 * gone. Reaching that requires the OS to ignore the env pin this same
 * call sets, which no supported platform does.
 */
const C_LOCALE_LSTART_COMMAND =
  /^([A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} \d{4})\s+([\s\S]+)$/;

export function inspectProcessFingerprint(
  pid: number,
  dependencies: InspectFingerprintDependencies = {},
): ProcessFingerprint | null {
  if (!Number.isInteger(pid) || pid < 1) return null;
  const exec = dependencies.exec ?? execFileSync;
  try {
    const output = exec(
      'ps',
      ['-o', 'lstart=', '-o', 'command=', '-p', String(pid)],
      {
        encoding: 'utf8',
        // `ps` renders lstart through the caller's locale AND timezone, so
        // the same live process fingerprints differently between a terminal
        // and launchd (or across a TZ change) — and `stopRecord` refuses to
        // signal on mismatch, blocking a legitimate stop (station#3049).
        // Pin both so the token is a property of the process, not of who
        // asked; same pin as process-identity.mjs's birth probe.
        env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      },
    ).trim();
    if (!output) return null;
    const match = output.match(C_LOCALE_LSTART_COMMAND);
    if (!match) return null;
    return {
      pid,
      startToken: match[1],
      commandDigest: createHash('sha256').update(match[2].trim()).digest('hex'),
    };
  } catch {
    return null;
  }
}

/**
 * The pre-#3049 probe, byte-for-byte: caller env (unpinned locale/TZ) and
 * the fixed 24-character slice. Exists ONLY so `fingerprintMatchesRecorded`
 * can recognize records written by an older CLI — see the migration note
 * there. Never record fingerprints from this.
 */
function inspectProcessFingerprintLegacyEnv(
  pid: number,
  dependencies: InspectFingerprintDependencies = {},
): ProcessFingerprint | null {
  if (!Number.isInteger(pid) || pid < 1) return null;
  const exec = dependencies.exec ?? execFileSync;
  try {
    const output = exec(
      'ps',
      ['-o', 'lstart=', '-o', 'command=', '-p', String(pid)],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      },
    ).trim();
    if (!output) return null;
    const match = output.match(/^(.{24})\s+([\s\S]+)$/);
    if (!match) return null;
    return {
      pid,
      startToken: match[1].trim(),
      commandDigest: createHash('sha256').update(match[2].trim()).digest('hex'),
    };
  } catch {
    return null;
  }
}

function sameProcessFingerprint(
  left: ProcessFingerprint | null,
  right: ProcessFingerprint | null,
): boolean {
  return (
    left !== null &&
    right !== null &&
    left.pid === right.pid &&
    left.startToken === right.startToken &&
    left.commandDigest === right.commandDigest
  );
}

type FingerprintMatchDependencies = {
  legacyInspect?: (pid: number) => ProcessFingerprint | null;
};

/**
 * Does the live observation `actual` correspond to the fingerprint a start
 * recorded? Field-wise comparison (the previous `JSON.stringify` equality
 * was key-order-sensitive), with one migration path (station#3049): a
 * record written by a pre-pin CLI captured `lstart` through the RECORDER's
 * locale/TZ, so a pinned observation of the same live process mismatches.
 * On mismatch, re-probe once with the legacy algorithm; a legacy match is
 * the same process observed through the old lens, not a pid reuse — the
 * command digest (env-independent) must also agree, so a reused pid cannot
 * ride this path. Without it, upgrading the CLI would strand every running
 * pre-upgrade instance unstoppable ("Refusing to signal PID ...").
 */
export function fingerprintMatchesRecorded(
  actual: ProcessFingerprint | null,
  expected: ProcessFingerprint | null,
  dependencies: FingerprintMatchDependencies = {},
): boolean {
  if (sameProcessFingerprint(actual, expected)) return true;
  if (actual === null || expected === null) return false;
  const legacyInspect =
    dependencies.legacyInspect ?? inspectProcessFingerprintLegacyEnv;
  return sameProcessFingerprint(legacyInspect(actual.pid), expected);
}

/**
 * Capture a post-exec process identity instead of the transient command that
 * can be visible immediately after spawn. The fingerprint must remain
 * unchanged for the full settling window; a process that exits or keeps
 * changing fails closed.
 *
 * The settling window is measured against a wall clock, and a wall clock is
 * not monotonic. If it stops advancing — a stepped-back NTP correction, a
 * suspended host, a frozen clock under test — `deadline` can never be reached
 * and `observedAt - stableSince` can never grow, so the loop had no bound at
 * all and blocked the CLI's main thread forever (station#1712 wedged
 * `station start` and hung the whole `test-full-process-heavy` phase). The
 * observation budget below is that missing bound: a correctly advancing clock
 * consumes at least `intervalMs` per observation, so it can never exhaust the
 * budget before the deadline it already honours, while a clock that does not
 * advance fails closed like any other unconfirmable identity.
 */
export function captureStableProcessFingerprint(
  pid: number,
  options: StableFingerprintOptions = {},
): ProcessFingerprint | null {
  const inspect = options.inspect ?? inspectProcessFingerprint;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? sleepSync;
  const intervalMs = Math.max(1, options.intervalMs ?? 20);
  const stableMs = Math.max(intervalMs, options.stableMs ?? 100);
  const timeoutMs = Math.max(stableMs, options.timeoutMs ?? 2_000);
  const deadline = now() + timeoutMs;
  const observationBudget = Math.ceil(timeoutMs / intervalMs) + 2;
  let candidate: ProcessFingerprint | null = null;
  let stableSince = 0;

  for (let observation = 0; observation < observationBudget; observation++) {
    const observedAt = now();
    const current = inspect(pid);
    if (!sameProcessFingerprint(candidate, current)) {
      candidate = current;
      stableSince = observedAt;
    } else if (current && observedAt - stableSince >= stableMs) {
      return current;
    }

    const remainingMs = deadline - observedAt;
    if (remainingMs <= 0) return null;
    sleep(Math.min(intervalMs, remainingMs));
  }
  return null;
}

/** Cross-platform synchronous sleep — no shell spawn needed. */
export function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // Keep the fallback independent of wall-clock corrections. The stable
    // fingerprint caller is explicitly bounded when Date.now stalls, so its
    // sleep primitive must not reintroduce the same infinite-loop class.
    const end = performance.now() + ms;
    while (performance.now() < end) {} // busy-wait fallback
  }
}

/**
 * Kill a process and its entire child tree, then wait for it to exit.
 * Unix : SIGTERM → poll 5 s → SIGKILL (process-group first, then single PID)
 * Windows : taskkill /F /T /PID (kills tree synchronously)
 */
export function killProcessTree(pid: number): void {
  if (IS_WINDOWS) {
    try {
      execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      /* already gone */
    }
    return;
  }
  // Unix: try process-group kill first, fall back to single-PID
  let signaled = false;
  try {
    process.kill(-pid, 'SIGTERM');
    signaled = true;
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
      signaled = true;
    } catch {
      console.error(
        `  ⚠ killProcessTree(${pid}): could not send SIGTERM (process may already be gone)`,
      );
    }
  }
  if (!signaled) return;

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    sleepSync(200);
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {}
  try {
    process.kill(pid, 'SIGKILL');
  } catch {}
}

/** Cross-platform async yes/no prompt via node:readline (no shell). */
export async function promptYN(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question} [y/N] `);
  rl.close();
  return answer.trim().toLowerCase() === 'y';
}

/**
 * Register the station CLI globally on PATH.
 * Unix    : symlink repoRoot/station → ~/.local/bin/station (no sudo needed)
 * Windows : write station.cmd shim to %APPDATA%\npm\ (npm puts that on PATH)
 */
export function createPathLink(repoRoot: string): void {
  if (IS_WINDOWS) {
    const cliTs = join(repoRoot, 'packages', 'cli', 'src', 'cli.ts');
    const npmBin = join(
      process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'),
      'npm',
    );
    mkdirSync(npmBin, { recursive: true });
    writeFileSync(
      join(npmBin, 'station.cmd'),
      `@echo off\nnpx tsx "${cliTs}" %*\n`,
    );
    console.log(`  ✓ station.cmd → ${cliTs}`);
    console.log("  You can now run 'station' from anywhere");
    return;
  }
  const source = join(repoRoot, 'station');
  if (!existsSync(source)) {
    console.error('No station script found in current directory.');
    process.exit(1);
    return;
  }
  const binDir =
    process.env.STATION_BIN_DIR || join(homedir(), '.local', 'bin');
  mkdirSync(binDir, { recursive: true });
  const target = join(binDir, 'station');
  execFileSync('ln', ['-sf', source, target], {
    stdio: 'pipe',
    windowsHide: true,
  });
  console.log(`  ✓ Linked: station → ${source}`);

  // Check if ~/.local/bin is on PATH
  const pathDirs = (process.env.PATH || '').split(':');
  if (!pathDirs.includes(binDir)) {
    console.log(`\n  ⚠ ${binDir} is not on your PATH.`);
    console.log(
      '  Add this to your shell profile (~/.zshrc, ~/.bashrc, etc.):',
    );
    console.log(`    export PATH="${binDir}:$PATH"`);
  } else {
    console.log("  You can now run 'station' from anywhere");
  }
}

/**
 * Create a platform-specific one-click launcher.
 * macOS   : ~/Applications/Station.app
 * Windows : ~/Desktop/Station.bat
 * Linux   : ~/.local/share/applications/station.desktop
 */
export function createAppShortcut(repoRoot: string): void {
  const uiUrl = `http://localhost:${resolveStationRuntimeContext().uiPort}`;
  if (IS_WINDOWS) {
    const cliTs = join(repoRoot, 'packages', 'cli', 'src', 'cli.ts');
    let desktop: string;
    try {
      desktop = execSync(
        'powershell -NoProfile -Command "[Environment]::GetFolderPath(\'Desktop\')"',
        { encoding: 'utf-8', windowsHide: true },
      ).trim();
    } catch {
      desktop = join(homedir(), 'Desktop');
    }
    const bat = join(desktop, 'Station.bat');
    writeFileSync(
      bat,
      `@echo off\nstart "" /B npx tsx "${cliTs}" start\ntimeout /t 2 /nobreak >nul\nstart "" ${uiUrl}\n`,
    );
    console.log(`  ✓ Created ${bat}`);
    console.log('  Double-click to launch Station and open in browser');
    return;
  }

  const stationPath = join(repoRoot, 'station');

  if (IS_MAC) {
    const applicationsDir =
      process.env.STATION_APPLICATIONS_DIR || join(homedir(), 'Applications');
    const appDir = join(applicationsDir, 'Station.app');
    const macosDir = join(appDir, 'Contents', 'MacOS');
    mkdirSync(macosDir, { recursive: true });
    writeFileSync(
      join(appDir, 'Contents', 'Info.plist'),
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Station</string>
  <key>CFBundleDisplayName</key><string>Station</string>
  <key>CFBundleIdentifier</key><string>com.station.launcher</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundleExecutable</key><string>launch</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>`,
    );
    writeFileSync(
      join(macosDir, 'launch'),
      `#!/bin/bash\n"${stationPath}" start &\nsleep 2\nopen "${uiUrl}"\n`,
    );
    execFileSync('chmod', ['+x', join(macosDir, 'launch')], {
      windowsHide: true,
    });
    console.log('  ✓ Created ~/Applications/Station.app');
    console.log('  Double-click to launch Station and open in browser');
    return;
  }

  // Linux
  const desktopDir =
    process.env.STATION_LINUX_APPS_DIR ||
    join(homedir(), '.local', 'share', 'applications');
  mkdirSync(desktopDir, { recursive: true });
  writeFileSync(
    join(desktopDir, 'station.desktop'),
    `[Desktop Entry]\nName=Station\nExec=bash -c '"${stationPath}" start & sleep 2 && xdg-open ${uiUrl}'\nType=Application\nTerminal=false\n`,
  );
  console.log('  ✓ Created ~/.local/share/applications/station.desktop');
  console.log('  Launch from your application menu');
}
