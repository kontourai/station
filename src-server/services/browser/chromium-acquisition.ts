/**
 * Finding or fetching the Chromium the Browser pane runs (#90, design D3).
 *
 * Order of preference:
 * 1. An installed Google Chrome or Microsoft Edge (or Chromium) in the
 *    standard per-OS location.
 * 2. A pinned Chrome-for-Testing build this Station already downloaded into
 *    `<STATION_HOME>/browser/chromium/<version>/`.
 * 3. Otherwise `needs-consent`: the caller is told the pinned version and
 *    download size and nothing is fetched.
 *
 * A download happens ONLY through {@link ChromiumAcquisition.startDownload}
 * with `consent: true`; status reads never touch the network. The archive
 * must match its pinned byte length and SHA-256, the trust root, recorded
 * here per platform by hashing each archive once at pin time. The MD5 Google
 * storage publishes (`x-goog-hash`) is also pinned and checked, but only as a
 * transport-corruption check: MD5 is not a trust root. Entry names are
 * checked before extraction and the extracted tree (symlinks included) after
 * it, so nothing lands outside the install directory.
 *
 * No new dependency: extraction uses the platform's own archive tool (`ditto`
 * on macOS, which preserves the app bundle's symlinks; `tar` on Windows 10+;
 * `unzip` on Linux).
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  accessSync,
  createWriteStream,
  existsSync,
  constants as fsConstants,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, posix, relative, resolve, win32 } from 'node:path';

export type ChromeForTestingPlatform =
  | 'mac-arm64'
  | 'mac-x64'
  | 'linux64'
  | 'linux-arm64'
  | 'win64'
  | 'win32';

export interface PinnedBuild {
  /** Exact archive length in bytes (x-goog-stored-content-length). */
  bytes: number;
  /** Base64 MD5 of the archive (x-goog-hash md5=): transport corruption check. */
  md5: string;
  /**
   * Hex SHA-256 of the archive: the trust root. Recorded 2026-09-22 by
   * streaming each archive through `shasum -a 256` in a scratch directory
   * outside the repository and Station home (nothing kept); the streamed byte
   * count matched `bytes` for every platform.
   */
  sha256: string;
  /** Executable path inside the extracted archive. */
  executable: readonly string[];
}

/**
 * Pinned 2026-09-22 from Chrome-for-Testing's last-known-good Stable channel.
 * Bump deliberately: re-record bytes and md5 from the storage object's
 * metadata (HEAD request) and sha256 by hashing each archive once, outside
 * the repository, and cross-check the byte count against the metadata.
 */
export const CHROME_FOR_TESTING_PIN = {
  version: '154.0.8037.57',
  baseUrl: 'https://storage.googleapis.com/chrome-for-testing-public',
  builds: {
    'mac-arm64': {
      bytes: 191_429_663,
      md5: 'TsIlmo+9Ym7Xr8cEuw69TQ==',
      sha256:
        '0e6b3439469c1b8b95b2e89c72ea29f7af00fb2c28a8878358a0b6002b6d3a64',
      executable: [
        'chrome-mac-arm64',
        'Google Chrome for Testing.app',
        'Contents',
        'MacOS',
        'Google Chrome for Testing',
      ],
    },
    'mac-x64': {
      bytes: 201_976_957,
      md5: 'rxEx6zkiaeqPlTzy/bUoFg==',
      sha256:
        'f6c0dff4662f1ffb01f63f9de3888ea95e4c634870a8b9f55e6d2208ba29a8a9',
      executable: [
        'chrome-mac-x64',
        'Google Chrome for Testing.app',
        'Contents',
        'MacOS',
        'Google Chrome for Testing',
      ],
    },
    linux64: {
      bytes: 196_223_440,
      md5: 'D+qnMtvRxrB1r9bMVeDIrw==',
      sha256:
        'ceee2972074d441ea7c4ba8bcc0eaab77e7e87680f6653d73d3065851fe10302',
      executable: ['chrome-linux64', 'chrome'],
    },
    'linux-arm64': {
      bytes: 196_514_864,
      md5: '0orw9rf7Xn32EcM3AKpu0g==',
      sha256:
        'da83171e552650df34272a9c51f62182bae88d467d1ac19c92dd97917dfa0bca',
      executable: ['chrome-linux-arm64', 'chrome'],
    },
    win64: {
      bytes: 205_808_814,
      md5: 'BpFTc5nUB8I7TZiCrPjW+Q==',
      sha256:
        '676f51fb82608330db5510ffba53d9e2762d3d7a99464afce54f9e9e25ad6bf7',
      executable: ['chrome-win64', 'chrome.exe'],
    },
    win32: {
      bytes: 184_475_517,
      md5: '00BKE11aWAf+ECMR5RDgmQ==',
      sha256:
        '7bf2a5abc4ab6239782298e8514cb239d7e2664e37ea88ac88f7a13d76d7774e',
      executable: ['chrome-win32', 'chrome.exe'],
    },
  } satisfies Record<ChromeForTestingPlatform, PinnedBuild>,
} as const;

export interface ChromeForTestingPin {
  version: string;
  baseUrl: string;
  builds: Readonly<Record<ChromeForTestingPlatform, PinnedBuild>>;
}

export type SystemBrowser = 'google-chrome' | 'microsoft-edge' | 'chromium';

export type ChromiumAcquisitionFailure =
  | 'unsupported-platform'
  | 'download-failed'
  | 'size-mismatch'
  | 'integrity-mismatch'
  | 'extract-failed';

export type ChromiumAcquisitionStatus =
  | { state: 'found-system'; executablePath: string; browser: SystemBrowser }
  | { state: 'downloaded'; executablePath: string; version: string }
  | {
      state: 'needs-consent';
      version: string;
      platform: ChromeForTestingPlatform;
      downloadBytes: number;
      installDir: string;
    }
  | {
      state: 'downloading';
      version: string;
      receivedBytes: number;
      totalBytes: number;
    }
  | {
      state: 'failed';
      reason: ChromiumAcquisitionFailure;
      detail: string;
      /** A consented retry is possible unless the platform is unsupported. */
      retryable: boolean;
    };

/** Refusal of a download request that did not carry explicit consent. */
export class ChromiumConsentRequiredError extends Error {
  constructor() {
    super('Downloading Chromium requires explicit user consent.');
    this.name = 'ChromiumConsentRequiredError';
  }
}

export interface ChromiumAcquisitionDeps {
  platform: NodeJS.Platform;
  arch: string;
  env: NodeJS.ProcessEnv;
  homeDir: string;
  isExecutableFile(path: string): boolean;
  fetch: typeof fetch;
  extract(zipPath: string, destDir: string): Promise<void>;
  /** Entry names in the archive, read before anything is extracted. */
  listEntries(zipPath: string): Promise<string[]>;
  /** The build to fetch. Production uses {@link CHROME_FOR_TESTING_PIN}. */
  pin: ChromeForTestingPin;
}

const MARKER_FILE = 'station-chromium.json';

export function chromeForTestingPlatform(
  platform: NodeJS.Platform,
  arch: string,
): ChromeForTestingPlatform | undefined {
  if (platform === 'darwin' && arch === 'arm64') return 'mac-arm64';
  if (platform === 'darwin' && arch === 'x64') return 'mac-x64';
  if (platform === 'linux' && arch === 'x64') return 'linux64';
  if (platform === 'linux' && arch === 'arm64') return 'linux-arm64';
  if (platform === 'win32' && arch === 'x64') return 'win64';
  if (platform === 'win32' && arch === 'ia32') return 'win32';
  return undefined;
}

/** Standard install locations, most preferred first. Pure. */
export function systemBrowserCandidates(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  homeDir: string,
): Array<{ path: string; browser: SystemBrowser }> {
  if (platform === 'darwin') {
    const apps = ['/Applications', posix.join(homeDir, 'Applications')];
    const bundles: Array<[string, string, SystemBrowser]> = [
      ['Google Chrome.app', 'Google Chrome', 'google-chrome'],
      ['Microsoft Edge.app', 'Microsoft Edge', 'microsoft-edge'],
      ['Chromium.app', 'Chromium', 'chromium'],
    ];
    return bundles.flatMap(([bundle, binary, browser]) =>
      apps.map((root) => ({
        path: posix.join(root, bundle, 'Contents', 'MacOS', binary),
        browser,
      })),
    );
  }
  if (platform === 'win32') {
    // Windows' own process.env is case-insensitive; an injected one is not.
    const roots = [
      env.ProgramFiles ?? env.PROGRAMFILES,
      env['ProgramFiles(x86)'] ?? env['PROGRAMFILES(X86)'],
      env.LOCALAPPDATA ?? env.LocalAppData,
    ].filter((root): root is string => typeof root === 'string' && root !== '');
    const installs: Array<[string[], SystemBrowser]> = [
      [['Google', 'Chrome', 'Application', 'chrome.exe'], 'google-chrome'],
      [['Microsoft', 'Edge', 'Application', 'msedge.exe'], 'microsoft-edge'],
    ];
    return installs.flatMap(([parts, browser]) =>
      roots.map((root) => ({ path: win32.join(root, ...parts), browser })),
    );
  }
  if (platform === 'linux') {
    const dirs = (env.PATH ?? '')
      .split(posix.delimiter)
      .filter((dir) => dir.startsWith('/'));
    const names: Array<[string, SystemBrowser]> = [
      ['google-chrome', 'google-chrome'],
      ['google-chrome-stable', 'google-chrome'],
      ['microsoft-edge', 'microsoft-edge'],
      ['microsoft-edge-stable', 'microsoft-edge'],
      ['chromium', 'chromium'],
      ['chromium-browser', 'chromium'],
    ];
    return names.flatMap(([name, browser]) =>
      dirs.map((dir) => ({ path: posix.join(dir, name), browser })),
    );
  }
  return [];
}

export function chromiumInstallRoot(stationHome: string): string {
  return join(stationHome, 'browser', 'chromium');
}

export function defaultIsExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (process.platform !== 'win32') accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function runArchiveTool(
  command: string,
  args: string[],
  timeoutMs: number,
  collect?: (chunk: Buffer) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', collect ? 'pipe' : 'ignore', 'ignore'],
      windowsHide: true,
    });
    if (collect) child.stdout?.on('data', collect);
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${command} did not finish within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${command} exited ${code ?? signal}`));
    });
  });
}

export function defaultExtract(
  platform: NodeJS.Platform,
): (zipPath: string, destDir: string) => Promise<void> {
  const timeoutMs = 10 * 60 * 1000;
  if (platform === 'darwin')
    return (zip, dest) =>
      runArchiveTool('/usr/bin/ditto', ['-x', '-k', zip, dest], timeoutMs);
  if (platform === 'win32')
    return (zip, dest) =>
      runArchiveTool(
        win32.join(
          process.env.SystemRoot ?? 'C:\\Windows',
          'System32',
          'tar.exe',
        ),
        ['-xf', zip, '-C', dest],
        timeoutMs,
      );
  return (zip, dest) =>
    runArchiveTool('unzip', ['-q', zip, '-d', dest], timeoutMs);
}

export function defaultListEntries(
  platform: NodeJS.Platform,
): (zipPath: string) => Promise<string[]> {
  const timeoutMs = 2 * 60 * 1000;
  const [command, args]: [string, (zip: string) => string[]] =
    platform === 'win32'
      ? [
          win32.join(
            process.env.SystemRoot ?? 'C:\\Windows',
            'System32',
            'tar.exe',
          ),
          (zip) => ['-tf', zip],
        ]
      : [
          platform === 'darwin' ? '/usr/bin/zipinfo' : 'zipinfo',
          (zip) => ['-1', zip],
        ];
  return async (zip) => {
    const chunks: Buffer[] = [];
    await runArchiveTool(command, args(zip), timeoutMs, (chunk) =>
      chunks.push(chunk),
    );
    return Buffer.concat(chunks)
      .toString('utf8')
      .split(/\r?\n/)
      .filter((line) => line !== '');
  };
}

/**
 * Zip-slip: an entry name that is absolute, has a drive or UNC prefix, or has
 * a `..` segment could land outside the install directory. Refused before
 * extraction.
 */
export function unsafeArchiveEntry(name: string): boolean {
  if (name.includes('\0')) return true;
  const normalized = name.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return true;
  return normalized.split('/').some((segment) => segment === '..');
}

/**
 * After extraction, every entry — and every symlink's target — must resolve
 * inside the extraction root (the app bundle's own relative symlinks do).
 * Returns the first escaping path, or undefined.
 */
export function findEscapingEntry(root: string): string | undefined {
  const realRoot = realpathSync(root);
  const within = (candidate: string) => {
    const rel = relative(realRoot, candidate);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  };
  const stack = [realRoot];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        const target = resolve(dir, readlinkSync(path));
        let real: string;
        try {
          real = realpathSync(target);
        } catch {
          // A dangling link is judged by where it points.
          real = target;
        }
        if (!within(real)) return path;
        continue;
      }
      if (!within(realpathSync(path))) return path;
      if (entry.isDirectory()) stack.push(path);
    }
  }
  return undefined;
}

export function defaultChromiumAcquisitionDeps(): ChromiumAcquisitionDeps {
  return {
    platform: process.platform,
    arch: process.arch,
    env: process.env,
    homeDir: homedir(),
    isExecutableFile: defaultIsExecutableFile,
    fetch: globalThis.fetch.bind(globalThis),
    extract: defaultExtract(process.platform),
    listEntries: defaultListEntries(process.platform),
    pin: CHROME_FOR_TESTING_PIN,
  };
}

export class ChromiumAcquisition {
  private downloading:
    | { receivedBytes: number; totalBytes: number; done: Promise<void> }
    | undefined;
  private lastFailure:
    | Extract<ChromiumAcquisitionStatus, { state: 'failed' }>
    | undefined;

  constructor(
    private readonly stationHome: string,
    private readonly deps: ChromiumAcquisitionDeps = defaultChromiumAcquisitionDeps(),
  ) {}

  private get cftPlatform(): ChromeForTestingPlatform | undefined {
    return chromeForTestingPlatform(this.deps.platform, this.deps.arch);
  }

  get installDir(): string {
    return join(chromiumInstallRoot(this.stationHome), this.deps.pin.version);
  }

  /** Read-only. Never downloads, never touches the network. */
  status(): ChromiumAcquisitionStatus {
    for (const candidate of systemBrowserCandidates(
      this.deps.platform,
      this.deps.env,
      this.deps.homeDir,
    )) {
      if (this.deps.isExecutableFile(candidate.path)) {
        return {
          state: 'found-system',
          executablePath: candidate.path,
          browser: candidate.browser,
        };
      }
    }
    const platform = this.cftPlatform;
    if (platform === undefined) {
      return {
        state: 'failed',
        reason: 'unsupported-platform',
        detail: `No installed Chrome/Edge was found and Chrome for Testing has no build for ${this.deps.platform}/${this.deps.arch}.`,
        retryable: false,
      };
    }
    const downloaded = this.readDownloaded(platform);
    if (downloaded) return downloaded;
    if (this.downloading) {
      return {
        state: 'downloading',
        version: this.deps.pin.version,
        receivedBytes: this.downloading.receivedBytes,
        totalBytes: this.downloading.totalBytes,
      };
    }
    if (this.lastFailure) return this.lastFailure;
    return {
      state: 'needs-consent',
      version: this.deps.pin.version,
      platform,
      downloadBytes: this.deps.pin.builds[platform].bytes,
      installDir: this.installDir,
    };
  }

  /** The executable to launch, or undefined when acquisition is incomplete. */
  resolveExecutable(): string | undefined {
    const status = this.status();
    return status.state === 'found-system' || status.state === 'downloaded'
      ? status.executablePath
      : undefined;
  }

  /**
   * Start the pinned download. `consent` must be the literal `true` the
   * caller received from the user; anything else throws before any I/O.
   * Returns the status right after starting (or the existing terminal state
   * when nothing needs downloading). `completion` settles when the download
   * finishes either way.
   */
  startDownload(request: { consent: true }): {
    status: ChromiumAcquisitionStatus;
    completion: Promise<void>;
  } {
    if (request?.consent !== true) throw new ChromiumConsentRequiredError();
    const current = this.status();
    if (current.state !== 'needs-consent' && current.state !== 'failed') {
      return {
        status: current,
        completion: this.downloading?.done ?? Promise.resolve(),
      };
    }
    const platform = this.cftPlatform;
    if (
      platform === undefined ||
      (current.state === 'failed' && !current.retryable)
    ) {
      return { status: current, completion: Promise.resolve() };
    }
    const build = this.deps.pin.builds[platform];
    this.lastFailure = undefined;
    const progress = {
      receivedBytes: 0,
      totalBytes: build.bytes,
      done: Promise.resolve(),
    };
    this.downloading = progress;
    progress.done = this.download(platform, build, progress)
      .then(() => {
        this.lastFailure = undefined;
      })
      .catch((error: unknown) => {
        this.lastFailure =
          error instanceof AcquisitionFailure
            ? {
                state: 'failed',
                reason: error.reason,
                detail: error.message,
                retryable: true,
              }
            : {
                state: 'failed',
                reason: 'download-failed',
                detail: error instanceof Error ? error.message : String(error),
                retryable: true,
              };
      })
      .finally(() => {
        if (this.downloading === progress) this.downloading = undefined;
      });
    return { status: this.status(), completion: progress.done };
  }

  private readDownloaded(
    platform: ChromeForTestingPlatform,
  ): ChromiumAcquisitionStatus | undefined {
    const markerPath = join(this.installDir, MARKER_FILE);
    if (!existsSync(markerPath)) return undefined;
    try {
      const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as {
        version?: unknown;
        platform?: unknown;
      };
      if (
        marker.version !== this.deps.pin.version ||
        marker.platform !== platform
      )
        return undefined;
    } catch {
      return undefined;
    }
    const executablePath = join(
      this.installDir,
      ...this.deps.pin.builds[platform].executable,
    );
    if (!this.deps.isExecutableFile(executablePath)) return undefined;
    return {
      state: 'downloaded',
      executablePath,
      version: this.deps.pin.version,
    };
  }

  private async download(
    platform: ChromeForTestingPlatform,
    build: PinnedBuild,
    progress: { receivedBytes: number },
  ): Promise<void> {
    const root = chromiumInstallRoot(this.stationHome);
    mkdirSync(root, { recursive: true });
    const staging = join(
      root,
      `.staging-${this.deps.pin.version}-${randomBytes(6).toString('hex')}`,
    );
    mkdirSync(staging, { recursive: true });
    try {
      const zipPath = join(staging, 'chromium.zip');
      const url = `${this.deps.pin.baseUrl}/${this.deps.pin.version}/${platform}/chrome-${platform}.zip`;
      let response: Response;
      try {
        response = await this.deps.fetch(url, { redirect: 'error' });
      } catch (error) {
        throw new AcquisitionFailure(
          'download-failed',
          `Could not reach Chrome for Testing: ${(error as Error).message}`,
        );
      }
      if (!response.ok || !response.body) {
        throw new AcquisitionFailure(
          'download-failed',
          `Chrome for Testing answered HTTP ${response.status}.`,
        );
      }
      const declared = Number(response.headers.get('content-length'));
      if (
        Number.isFinite(declared) &&
        declared > 0 &&
        declared !== build.bytes
      ) {
        throw new AcquisitionFailure(
          'size-mismatch',
          `Archive length ${declared} does not match the pinned ${build.bytes}.`,
        );
      }
      const hash = createHash('md5');
      const sha256 = createHash('sha256');
      const file = createWriteStream(zipPath);
      try {
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          progress.receivedBytes += chunk.byteLength;
          if (progress.receivedBytes > build.bytes) {
            throw new AcquisitionFailure(
              'size-mismatch',
              `Archive exceeded the pinned ${build.bytes} bytes.`,
            );
          }
          hash.update(chunk);
          sha256.update(chunk);
          if (!file.write(chunk)) {
            await new Promise<void>((resolve) => file.once('drain', resolve));
          }
        }
      } finally {
        await new Promise<void>((resolve) => file.end(resolve));
      }
      if (progress.receivedBytes !== build.bytes) {
        throw new AcquisitionFailure(
          'size-mismatch',
          `Archive was ${progress.receivedBytes} bytes; the pin is ${build.bytes}.`,
        );
      }
      const md5 = hash.digest('base64');
      if (md5 !== build.md5) {
        throw new AcquisitionFailure(
          'integrity-mismatch',
          `Archive MD5 ${md5} does not match the pinned ${build.md5}.`,
        );
      }
      const digest = sha256.digest('hex');
      if (!/^[0-9a-f]{64}$/.test(build.sha256) || digest !== build.sha256) {
        throw new AcquisitionFailure(
          'integrity-mismatch',
          `Archive SHA-256 ${digest} does not match the pinned ${build.sha256}.`,
        );
      }
      let entries: string[];
      try {
        entries = await this.deps.listEntries(zipPath);
      } catch (error) {
        throw new AcquisitionFailure(
          'extract-failed',
          `Could not list the archive: ${(error as Error).message}`,
        );
      }
      const unsafe = entries.find(unsafeArchiveEntry);
      if (unsafe !== undefined || entries.length === 0) {
        throw new AcquisitionFailure(
          'extract-failed',
          unsafe !== undefined
            ? `The archive has an entry outside its root: ${unsafe}`
            : 'The archive is empty.',
        );
      }
      const extracted = join(staging, 'extracted');
      mkdirSync(extracted, { recursive: true });
      try {
        await this.deps.extract(zipPath, extracted);
      } catch (error) {
        throw new AcquisitionFailure(
          'extract-failed',
          `Could not extract the archive: ${(error as Error).message}`,
        );
      }
      const escaping = findEscapingEntry(extracted);
      if (escaping !== undefined) {
        throw new AcquisitionFailure(
          'extract-failed',
          `An extracted entry resolves outside the install directory: ${escaping}`,
        );
      }
      if (!this.deps.isExecutableFile(join(extracted, ...build.executable))) {
        throw new AcquisitionFailure(
          'extract-failed',
          'The extracted archive has no Chromium executable at the pinned path.',
        );
      }
      writeFileSync(
        join(extracted, MARKER_FILE),
        `${JSON.stringify({ version: this.deps.pin.version, platform, md5, sha256: digest })}\n`,
      );
      rmSync(this.installDir, { recursive: true, force: true });
      renameSync(extracted, this.installDir);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }
}

class AcquisitionFailure extends Error {
  constructor(
    readonly reason: ChromiumAcquisitionFailure,
    message: string,
  ) {
    super(message);
    this.name = 'AcquisitionFailure';
  }
}
