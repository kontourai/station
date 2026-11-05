/**
 * #4519 round 1: which Tailscale may answer the startup Serve check.
 *
 * The check can only prove "nothing forwards" through something an ordinary
 * user cannot stand in for. A `tailscale` found on PATH is not that: any
 * user can put a script first on PATH that prints `"BackendState":
 * "Stopped"`, and a PATH without one does not show that no daemon runs.
 * So the check runs only a Tailscale CLI at a fixed system location that
 * the system owns:
 *
 * - macOS: the app bundle CLI (`/Applications/Tailscale.app`, from the Mac
 *   App Store or tailscale.com). `/Applications` is writable by the admin
 *   group, so a root-owned directory chain cannot be required there; the
 *   bundle must instead be root-owned and pass `codesign` against
 *   Tailscale Inc.'s Developer ID team. Homebrew's CLI belongs to the
 *   Homebrew user and is not trusted.
 * - Linux: a root-owned `tailscale` in a system bin directory whose whole
 *   directory chain is root-owned and not group- or world-writable (the
 *   checks the policy file itself gets).
 * - Windows: the installer's `C:\Program Files\Tailscale\tailscale.exe`,
 *   held to the policy file's own Windows rule (#4524): the file, its
 *   folder and every folder up to the drive must be owned by
 *   Administrators, SYSTEM or TrustedInstaller, grant no one else a right
 *   that changes them, and not be reparse points.
 *
 * The trusted CLI runs with a fixed, minimal environment, so no inherited
 * loader or Tailscale variable changes what it does (on macOS it sets
 * `TAILSCALE_BE_CLI=1`, without which the app binary starts its GUI).
 *
 * A trusted CLI is re-verified before every run (round 2): its identity
 * (device, inode, size, modification and change times of the executable
 * and, on macOS, of the bundle's code-signing manifest) is captured when it
 * is verified, and any change re-runs the full trust check, signature
 * included, before it may answer. What remains is the moment between that
 * check and the exec; replacing the file in it needs write access to the
 * bundle or system bin directory, which only an administrator has, and a
 * local administrator is outside what the limit defends against.
 *
 * A trusted CLI answers for the system daemon only. A second `tailscaled`
 * (for example a user-run userspace one with its own socket) could forward
 * while the system daemon reports stopped, so any running `tailscaled` that
 * is not the system daemon (by executable path and owner) makes the check
 * refuse, naming it (round 2). A forwarder under another name, or a
 * renamed copy, is in the same class as `ssh -R`, ngrok or cloudflared:
 * port forwarding with other tools is not covered by this check, and the
 * credential layer still refuses pairing and keeps earlier devices
 * suspended.
 *
 * Without a trusted CLI, "nothing forwards" stands only when nothing on the
 * machine looks like Tailscale: no `tailscale` or `tailscaled` on PATH, no
 * daemon socket, no Tailscale process, and no untrusted install. Any of
 * those, or a process list that cannot be read, is a sign; with a sign and
 * no trusted CLI the caller refuses and names what to install or stop.
 */
import { execFile } from 'node:child_process';
import {
  accessSync,
  existsSync,
  constants as fsConstants,
  lstatSync,
} from 'node:fs';
import { basename, delimiter, join } from 'node:path';
import {
  managedTrustedFileProblem,
  processWindowsSecurityApi,
  SYSTEM_MANAGED_POLICY_OWNERSHIP,
  type WindowsSecurityApi,
  windowsPathChainProblem,
} from '@kontourai/station-shared/managed-policy';
import { TAILSCALE_MACOS_APP_CLI } from './public-ingress-origin.js';
import type {
  TailscaleCommand,
  TailscaleCommandResult,
} from './serve-exposure.js';

const COMMAND_TIMEOUT_MS = 5_000;
const SIGNATURE_TIMEOUT_MS = 15_000;

const TAILSCALE_MACOS_APP_BUNDLE = '/Applications/Tailscale.app';
/** Tailscale Inc.'s Apple Developer team, on both the App Store and standalone app. */
const TAILSCALE_APPLE_TEAM_ID = 'W5364U7YZB';
const TAILSCALE_WINDOWS_CLI = 'C:\\Program Files\\Tailscale\\tailscale.exe';

/** The fixed locations the check may run, in order. Never a PATH lookup. */
export function trustedTailscaleExecutables(
  platform: NodeJS.Platform,
): readonly string[] {
  if (platform === 'darwin') return [TAILSCALE_MACOS_APP_CLI];
  if (platform === 'win32') return [TAILSCALE_WINDOWS_CLI];
  return [
    '/usr/bin/tailscale',
    '/usr/sbin/tailscale',
    '/usr/local/bin/tailscale',
    '/usr/local/sbin/tailscale',
    '/bin/tailscale',
    '/sbin/tailscale',
  ];
}

/** Where `tailscaled` puts its LocalAPI socket (a sign it is installed). */
const DAEMON_SOCKETS = [
  '/var/run/tailscaled.socket',
  '/var/run/tailscale/tailscaled.sock',
  '/run/tailscale/tailscaled.sock',
];

/** Process names Tailscale runs under (`ps` gives a path on macOS). */
const TAILSCALE_PROCESS =
  /^(tailscaled?|tailscale-ipn|Tailscale|IPNExtension|io\.tailscale\..+)(\.exe)?$/i;

export type TailscaleAuthority =
  | {
      kind: 'trusted';
      executable: string;
      command: TailscaleCommand;
      /**
       * Running `tailscaled` processes the trusted CLI does not answer for,
       * each described; `null` when the process list cannot be read. Asked
       * on every check, never cached.
       */
      foreignDaemons(): Promise<string[] | null>;
    }
  | { kind: 'absent' }
  | { kind: 'untrusted'; signs: string[]; remedy: string };

export interface TailscaleAuthorityProbe {
  platform: NodeJS.Platform;
  executables: readonly string[];
  /** Why `path` is not trusted, `null` if it is, `undefined` if absent. */
  trustProblem(path: string): Promise<string | null | undefined>;
  /** Signs of Tailscale besides the fixed locations; `null` if unreadable. */
  signs(): Promise<string[] | null>;
  /**
   * The identity of the trusted file at `path` (see the module comment), or
   * `null` when it cannot be read; compared before every run.
   */
  fingerprint(path: string): string | null;
  /** See `TailscaleAuthority.foreignDaemons`. */
  foreignDaemons(): Promise<string[] | null>;
  run(
    executable: string,
    args: readonly string[],
  ): Promise<TailscaleCommandResult>;
}

function execBounded(
  executable: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeout: number,
): Promise<TailscaleCommandResult> {
  return new Promise((resolve) => {
    execFile(
      executable,
      [...args],
      {
        timeout,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        encoding: 'utf8',
        env,
      },
      (error, stdout, stderr) => {
        const code = (error as { code?: unknown } | null)?.code;
        resolve({
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          exitCode: !error ? 0 : typeof code === 'number' ? code : null,
        });
      },
    );
  });
}

/** Only what the CLI needs to find its user; no loader or `TS_*` variables. */
export function trustedTailscaleEnvironment(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const keep =
    platform === 'win32'
      ? [
          'SystemRoot',
          'windir',
          'USERPROFILE',
          'LOCALAPPDATA',
          'APPDATA',
          'ProgramData',
          'TEMP',
          'TMP',
        ]
      : ['HOME', 'USER', 'LOGNAME', 'TMPDIR'];
  const out: NodeJS.ProcessEnv = {};
  for (const key of keep) if (env[key] !== undefined) out[key] = env[key];
  out.PATH =
    platform === 'win32'
      ? `${env.SystemRoot ?? 'C:\\Windows'}\\System32`
      : '/usr/bin:/bin:/usr/sbin:/sbin';
  // The macOS app binary is the GUI unless told otherwise; with no shell
  // around it (`SHLVL` unset, as for a GUI-launched sidecar) it tries to
  // start the GUI and fails. This is Tailscale's switch for CLI mode.
  if (platform === 'darwin') out.TAILSCALE_BE_CLI = '1';
  return out;
}

/** What the trust check reads from the system; tests substitute fakes. */
export interface TailscaleTrustSystem {
  exists?: (path: string) => boolean;
  windowsSecurity?: () => WindowsSecurityApi;
}

async function systemTrustProblem(
  platform: NodeJS.Platform,
  path: string,
  system: TailscaleTrustSystem = {},
): Promise<string | null | undefined> {
  if (platform === 'win32') {
    if (!(system.exists ?? existsSync)(path)) return undefined;
    // #4524: the policy file's owner and ACL rule, for the CLI and every
    // folder above it. A CLI someone else could replace is not trusted.
    return windowsPathChainProblem(
      path,
      (system.windowsSecurity ?? processWindowsSecurityApi)(),
    );
  }
  const file = managedTrustedFileProblem(
    path,
    SYSTEM_MANAGED_POLICY_OWNERSHIP,
    { directories: platform !== 'darwin' },
  );
  if (file !== null || platform !== 'darwin') return file;
  const signature = await execBounded(
    '/usr/bin/codesign',
    [
      '--verify',
      `-R=anchor apple generic and certificate leaf[subject.OU] = "${TAILSCALE_APPLE_TEAM_ID}"`,
      TAILSCALE_MACOS_APP_BUNDLE,
    ],
    trustedTailscaleEnvironment(platform),
    SIGNATURE_TIMEOUT_MS,
  );
  return signature.exitCode === 0
    ? null
    : `${TAILSCALE_MACOS_APP_BUNDLE} is not signed by Tailscale Inc. (${TAILSCALE_APPLE_TEAM_ID})`;
}

function onPath(name: string, platform: NodeJS.Platform, pathEnv: string) {
  const names = platform === 'win32' ? [`${name}.exe`] : [name];
  const found: string[] = [];
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    for (const candidate of names) {
      const full = join(dir, candidate);
      try {
        accessSync(full, fsConstants.X_OK);
        found.push(full);
      } catch {
        // Not there, or not executable.
      }
    }
  }
  return found;
}

async function processNames(
  platform: NodeJS.Platform,
): Promise<string[] | null> {
  const env = trustedTailscaleEnvironment(platform);
  const listed =
    platform === 'win32'
      ? await execBounded(
          `${env.PATH}\\tasklist.exe`,
          ['/FO', 'CSV', '/NH'],
          env,
          COMMAND_TIMEOUT_MS,
        )
      : await execBounded(
          '/bin/ps',
          ['-A', '-o', 'comm='],
          env,
          COMMAND_TIMEOUT_MS,
        );
  if (listed.exitCode !== 0) return null;
  return listed.stdout
    .split('\n')
    .map((line) =>
      platform === 'win32'
        ? (line.split(',')[0] ?? '').replace(/"/g, '').trim()
        : basename(line.trim()),
    )
    .filter(Boolean);
}

/** Signs of Tailscale on this machine; `null` when they cannot be read. */
export async function tailscaleSigns(
  platform: NodeJS.Platform = process.platform,
  pathEnv: string = process.env.PATH ?? '',
  list: typeof processNames = processNames,
): Promise<string[] | null> {
  const signs = [
    ...onPath('tailscale', platform, pathEnv),
    ...onPath('tailscaled', platform, pathEnv),
  ].map((path) => `${path} on PATH`);
  if (platform !== 'win32')
    for (const socket of DAEMON_SOCKETS)
      if (existsSync(socket)) signs.push(`the daemon socket ${socket}`);
  if (platform === 'darwin' && existsSync(TAILSCALE_MACOS_APP_BUNDLE))
    signs.push(TAILSCALE_MACOS_APP_BUNDLE);
  const names = await list(platform);
  if (names === null) return null;
  const running = [...new Set(names.filter((n) => TAILSCALE_PROCESS.test(n)))];
  if (running.length > 0)
    signs.push(
      `the running process${running.length > 1 ? 'es' : ''} ${running.join(', ')}`,
    );
  return signs;
}

function statIdentity(path: string): string {
  const stat = lstatSync(path, { bigint: true });
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}

/** See `TailscaleAuthorityProbe.fingerprint`. */
export function trustedFileFingerprint(
  platform: NodeJS.Platform,
  path: string,
): string | null {
  try {
    const parts = [statIdentity(path)];
    if (platform === 'darwin')
      parts.push(
        statIdentity(
          join(
            TAILSCALE_MACOS_APP_BUNDLE,
            'Contents/_CodeSignature/CodeResources',
          ),
        ),
      );
    return parts.join('|');
  } catch {
    return null;
  }
}

/** Where the system `tailscaled` runs from: the package's sbin and bin. */
const SYSTEM_DAEMON_PATHS = new Set(
  [
    '/usr/sbin',
    '/usr/bin',
    '/usr/local/sbin',
    '/usr/local/bin',
    '/sbin',
    '/bin',
  ].map((dir) => `${dir}/tailscaled`),
);

interface ProcessEntry {
  pid: number;
  uid: number;
  /** The executable path where the platform reports one, else argv[0]. */
  path: string;
}

/** `pid uid path` rows from `ps`; `null` when the list cannot be read. */
async function processEntries(
  platform: NodeJS.Platform,
): Promise<ProcessEntry[] | null> {
  const env = trustedTailscaleEnvironment(platform);
  // macOS `comm` is the executable path; Linux truncates it to a name, so
  // the first argument is used there. The owner is the kernel's real uid,
  // which a process cannot choose.
  const listed = await execBounded(
    '/bin/ps',
    ['-A', '-o', `pid=,ruid=,${platform === 'darwin' ? 'comm' : 'args'}=`],
    env,
    COMMAND_TIMEOUT_MS,
  );
  if (listed.exitCode !== 0) return null;
  const entries: ProcessEntry[] = [];
  for (const line of listed.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const command = (match[3] ?? '').trim();
    entries.push({
      pid: Number(match[1]),
      uid: Number(match[2]),
      path: platform === 'darwin' ? command : (command.split(/\s+/)[0] ?? ''),
    });
  }
  return entries;
}

/**
 * Running `tailscaled` processes that are not the system daemon. On macOS
 * the trusted app runs its daemon as a network extension, so every
 * `tailscaled` is foreign; on Linux the system daemon is a root-owned
 * `tailscaled` at a system path. Windows is not inspected here (the guide
 * says so).
 */
export async function foreignTailscaleDaemons(
  platform: NodeJS.Platform = process.platform,
  list: typeof processEntries = processEntries,
): Promise<string[] | null> {
  if (platform === 'win32') return [];
  const entries = await list(platform);
  if (entries === null) return null;
  return entries
    .filter((entry) => basename(entry.path) === 'tailscaled')
    .filter(
      (entry) =>
        platform === 'darwin' ||
        entry.uid !== 0 ||
        !SYSTEM_DAEMON_PATHS.has(entry.path),
    )
    .map(
      (entry) =>
        `\`tailscaled\` process ${entry.pid} (${entry.path.slice(0, 200)}, uid ${entry.uid})`,
    );
}

export function defaultTailscaleAuthorityProbe(
  platform: NodeJS.Platform = process.platform,
  system: TailscaleTrustSystem = {},
): TailscaleAuthorityProbe {
  const env = trustedTailscaleEnvironment(platform);
  return {
    platform,
    executables: trustedTailscaleExecutables(platform),
    trustProblem: (path) => systemTrustProblem(platform, path, system),
    signs: () => tailscaleSigns(platform),
    fingerprint: (path) => trustedFileFingerprint(platform, path),
    foreignDaemons: () => foreignTailscaleDaemons(platform),
    run: (executable, args) =>
      execBounded(executable, args, env, COMMAND_TIMEOUT_MS),
  };
}

/** What to install or stop so the check can answer; one sentence. */
function tailscaleAuthorityRemedy(platform: NodeJS.Platform): string {
  if (platform === 'darwin')
    return 'Install Tailscale from the Mac App Store or tailscale.com (Station runs only the signed app in /Applications/Tailscale.app), or quit Tailscale and stop any `tailscaled` (Homebrew: `sudo brew services stop tailscale`), then start Station again.';
  if (platform === 'win32')
    return `Install Tailscale with its Windows installer (Station runs only ${TAILSCALE_WINDOWS_CLI}), or quit Tailscale, then start Station again.`;
  return "Install Tailscale from your distribution or Tailscale's package repository (Station runs only a root-owned `tailscale` in /usr/bin, /usr/sbin, /usr/local/bin, /usr/local/sbin, /bin or /sbin), or stop `tailscaled` (`sudo systemctl stop tailscaled`), then start Station again.";
}

/**
 * The Tailscale the Serve check may believe. The first trusted fixed
 * location answers; an untrusted one present there is a sign, not an answer.
 */
export async function resolveTailscaleAuthority(
  probe: TailscaleAuthorityProbe = defaultTailscaleAuthorityProbe(),
): Promise<TailscaleAuthority> {
  const untrusted: string[] = [];
  for (const executable of probe.executables) {
    const problem = await probe.trustProblem(executable);
    if (problem === undefined) continue;
    if (problem !== null) {
      untrusted.push(problem);
      continue;
    }
    let verified = probe.fingerprint(executable);
    return {
      kind: 'trusted',
      executable,
      foreignDaemons: () => probe.foreignDaemons(),
      command: async (args) => {
        // Re-verified before every run: a changed file is checked again in
        // full, and runs only if it is still trusted and unchanged since.
        const current = probe.fingerprint(executable);
        if (current === null || current !== verified) {
          const again =
            current === null ? undefined : await probe.trustProblem(executable);
          if (again !== null || probe.fingerprint(executable) !== current)
            return {
              exitCode: null,
              stdout: '',
              stderr: '',
              detail: `the Tailscale CLI at ${executable} changed since Station verified it${typeof again === 'string' ? ` (${again})` : ''}`,
            };
          verified = current;
        }
        // A trusted CLI that then cannot be run is not absence: it answers
        // with no exit code, which the check reads as unverifiable.
        const { unavailable: _unused, ...result } = await probe.run(
          executable,
          args,
        );
        return result;
      },
    };
  }
  const signs = await probe.signs();
  if (signs === null) untrusted.push('the process list could not be read');
  else untrusted.push(...signs);
  if (untrusted.length === 0) return { kind: 'absent' };
  return {
    kind: 'untrusted',
    signs: untrusted,
    remedy: tailscaleAuthorityRemedy(probe.platform),
  };
}
