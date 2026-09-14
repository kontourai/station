import { type ChildProcess, spawn } from 'node:child_process';
import {
  createWriteStream,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { STATION_HOME_SCHEMA_VERSION } from '@kontourai/station-shared/station-home-schema';
import {
  findFreePortBlock,
  findFreePortOutside,
} from '../../scripts/lib/free-ports.mjs';

type WebDriverEnvelope<T> = {
  value: T & { error?: string; message?: string; stacktrace?: string };
};

type SessionValue = {
  sessionId: string;
  capabilities: { browserName?: string; browserVersion?: string };
};

export type TauriShellFixture = {
  binary: string;
  blockedPort: number;
  driver: DirectWebDriver;
  framePort: number;
  remotePort: number;
  stationHome: string;
  stationRoot: string;
  stop(): Promise<void>;
};

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

async function terminate(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const exited = new Promise<void>((resolve) =>
    child.once('exit', () => resolve()),
  );
  if (
    await Promise.race([
      exited.then(() => true),
      sleep(5_000).then(() => false),
    ])
  ) {
    return;
  }
  child.kill('SIGKILL');
  await exited;
}

export class DirectWebDriver {
  readonly origin: string;
  sessionId: string | undefined;
  capabilities: SessionValue['capabilities'] = {};

  constructor(port: number) {
    this.origin = `http://127.0.0.1:${port}`;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const response = await fetch(`${this.origin}${path}`, {
      method,
      headers:
        body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const payload = (await response.json()) as WebDriverEnvelope<T>;
    if (!response.ok || payload.value?.error) {
      throw new Error(
        `WebDriver ${method} ${path} failed: ${JSON.stringify(payload.value)}`,
      );
    }
    return payload.value;
  }

  async connect(timeout = 60_000) {
    const started = Date.now();
    let lastError: unknown;
    while (Date.now() - started < timeout) {
      try {
        await this.request('GET', '/status');
        const session = await this.request<SessionValue>('POST', '/session', {
          capabilities: {
            alwaysMatch: { browserName: 'tauri' },
            firstMatch: [{}],
          },
        });
        this.sessionId = session.sessionId;
        this.capabilities = session.capabilities;
        return;
      } catch (error) {
        lastError = error;
        await sleep(100);
      }
    }
    throw new Error(
      `Embedded WebDriver did not become ready: ${String(lastError)}`,
    );
  }

  private sessionPath(path: string) {
    if (!this.sessionId) throw new Error('WebDriver session is not connected.');
    return `/session/${this.sessionId}${path}`;
  }

  async execute<T, A extends unknown[]>(fn: (...args: A) => T, ...args: A) {
    return await this.request<T>('POST', this.sessionPath('/execute/sync'), {
      script: `return (${fn.toString()}).apply(null, arguments);`,
      args,
    });
  }

  async refresh() {
    await this.request('POST', this.sessionPath('/refresh'), {});
  }

  /** Point the WebView at a URL, the way the shell's own navigation does. */
  async navigate(url: string) {
    await this.request('POST', this.sessionPath('/url'), { url });
  }

  /**
   * A real element reference, and a real click through the driver.
   *
   * `execute()` could dispatch a synthetic click and would be shorter. It
   * would also be a different event than a user produces, which is the
   * distinction `tests/AGENTS.md` draws: a synthetic dispatch hides the
   * behavior under test. WebDriver's own `/element/:id/click` is the closest
   * thing this harness has to a press.
   */
  async findElement(css: string): Promise<string | undefined> {
    try {
      const value = await this.request<Record<string, string>>(
        'POST',
        this.sessionPath('/element'),
        { using: 'css selector', value: css },
      );
      return Object.values(value)[0];
    } catch {
      return undefined;
    }
  }

  async clickElement(elementId: string) {
    await this.request(
      'POST',
      this.sessionPath(`/element/${elementId}/click`),
      {},
    );
  }

  /** A base64 PNG of the WebView, so a claim about a render can be looked at. */
  async screenshot(): Promise<Buffer> {
    const value = await this.request<string>(
      'GET',
      this.sessionPath('/screenshot'),
    );
    return Buffer.from(value, 'base64');
  }

  async waitUntil(
    predicate: () => boolean | Promise<boolean>,
    options: { timeout: number; timeoutMsg: string; interval?: number },
  ) {
    const started = Date.now();
    let lastError: unknown;
    while (Date.now() - started < options.timeout) {
      try {
        if (await predicate()) return;
      } catch (error) {
        lastError = error;
      }
      await sleep(options.interval ?? 100);
    }
    throw new Error(
      `${options.timeoutMsg}${lastError ? ` Last error: ${String(lastError)}` : ''}`,
    );
  }

  pause(milliseconds: number) {
    return sleep(milliseconds);
  }

  async close() {
    if (!this.sessionId) return;
    const sessionId = this.sessionId;
    this.sessionId = undefined;
    try {
      await this.request('DELETE', `/session/${sessionId}`);
    } catch {
      // The app may have already closed the embedded server.
    }
  }
}

export interface TauriShellFixtureOptions {
  /**
   * Extra environment for the app process. The sidecar `Command` never calls
   * `env_clear`, so anything set here reaches the bundled Station server too
   * — which is how a test points the real service at a fixture host.
   */
  env?: Record<string, string>;
  /**
   * Whether to pre-write a `profiles.json` naming a mock REMOTE Station as
   * the default profile.
   *
   * True is the plugin-host lane's shape: the WebView talks to a server the
   * test controls. False leaves the profile store empty so the app injects
   * its own bundled local-owner profile (`setup_source: "local"`,
   * `credential_ref: None`) pointing at the sidecar it started — which is the
   * only configuration in which the WebView reaches a REAL Station route
   * under real host authority rather than a fixture's answer.
   */
  seedRemoteProfile?: boolean;
}

export async function startTauriShellFixture(
  options: TauriShellFixtureOptions = {},
): Promise<TauriShellFixture> {
  const root = resolve(import.meta.dirname, '../..');
  const binary = process.env.STATION_TAURI_E2E_BINARY;
  if (!binary) throw new Error('STATION_TAURI_E2E_BINARY is required.');
  const serverPort = await findFreePortBlock(8);
  const uiPort = await findFreePortOutside(serverPort, 8);
  const driverPort = await findFreePortOutside(uiPort, 1);
  const remotePort = serverPort + 4;
  const framePort = serverPort + 5;
  const blockedPort = serverPort + 6;
  const stationRoot = mkdtempSync(join(tmpdir(), 'station-tauri-shell-e2e-'));
  const instance = basename(stationRoot);
  const stationHome = join(stationRoot, 'instances', instance);
  mkdirSync(stationHome, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(stationHome, '.station-home-schema.json'),
    `${JSON.stringify({ version: STATION_HOME_SCHEMA_VERSION }, null, 2)}\n`,
    { mode: 0o600 },
  );
  const profileDirectory = join(stationRoot, 'config');
  mkdirSync(profileDirectory, { recursive: true, mode: 0o700 });
  const profileNow = Date.now();
  if (options.seedRemoteProfile === false)
    // An ABSENT profiles.json is not the same as an empty one. The app
    // fail-closes on a config directory that exists without it ("saved
    // Station metadata is missing from an initialized or in-progress shared
    // root"), never reaches ownership selection, and reports "Desktop local
    // ownership is not initialized" — so the store is written empty, which is
    // the shape a first run leaves behind and the one from which the app
    // selects its own bundled local owner.
    writeFileSync(
      join(profileDirectory, 'profiles.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          revision: 0,
          defaultProfile: null,
          profiles: [],
          projectProfiles: {},
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
  else
    writeFileSync(
      join(profileDirectory, 'profiles.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          revision: 0,
          defaultProfile: 'remote-plugin-proof',
          profiles: [
            {
              schemaVersion: 1,
              name: 'remote-plugin-proof',
              endpoint: `http://127.0.0.1:${remotePort}`,
              credentialRef: { kind: 'station-bearer', id: 'tauri-shell-e2e' },
              environmentId: '11111111-1111-4111-8111-111111111111',
              setupSource: 'paired',
              configurationState: 'configured',
              createdAt: profileNow,
              updatedAt: profileNow,
            },
          ],
          projectProfiles: {},
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
  const outputDir = join(root, '.kontourai', 'tauri-shell-e2e');
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(
    join(outputDir, 'context.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        sourceSha: process.env.STATION_TAURI_E2E_SOURCE_SHA,
        binary,
        stationRoot,
        stationHome,
        instance,
        serverPort,
        uiPort,
        driverPort,
        remotePort,
        framePort,
        blockedPort,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  const appLog = createWriteStream(join(outputDir, 'app.log'), { flags: 'w' });
  const child = spawn(binary, [], {
    cwd: root,
    env: {
      ...process.env,
      STATION_HOME: stationHome,
      STATION_ROOT: stationRoot,
      STATION_INSTANCE: instance,
      STATION_PORT: String(serverPort),
      STATION_UI_PORT: String(uiPort),
      STATION_NODE: process.execPath,
      STATION_DESKTOP_LOG_LEVEL: 'debug',
      STATION_TAURI_E2E_MOCK_CREDENTIAL: '1',
      TAURI_WEBDRIVER_PORT: String(driverPort),
      ...options.env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout?.pipe(appLog, { end: false });
  child.stderr?.pipe(appLog, { end: false });
  const driver = new DirectWebDriver(driverPort);
  try {
    await driver.connect();
  } catch (error) {
    await terminate(child);
    appLog.end();
    rmSync(stationRoot, { recursive: true, force: true });
    throw error;
  }
  return {
    binary,
    blockedPort,
    driver,
    framePort,
    remotePort,
    stationHome,
    stationRoot,
    async stop() {
      await driver.close();
      await terminate(child);
      appLog.end();
      const allowedPrefix = join(tmpdir(), 'station-tauri-shell-e2e-');
      if (!stationRoot.startsWith(allowedPrefix)) {
        throw new Error(
          `Refusing to remove unexpected fixture: ${stationRoot}`,
        );
      }
      // The app's SIDECAR outlives the app by a moment, and it writes into
      // this home while it shuts down — so a single `rmSync` races it and
      // dies `ENOTEMPTY` on a run whose journey already finished. Retrying
      // briefly removes the race without loosening anything: the
      // `allowedPrefix` guard above still decides WHAT may be removed, and a
      // directory that is still occupied after the window is reported rather
      // than ignored.
      let lastError: unknown;
      for (let attempt = 0; attempt < 25; attempt += 1) {
        try {
          rmSync(stationRoot, { recursive: true, force: true });
          return;
        } catch (error) {
          lastError = error;
          await sleep(200);
        }
      }
      throw new Error(
        `Could not remove the shell fixture at ${stationRoot}: ${String(lastError)}`,
      );
    },
  };
}
