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

export async function startTauriShellFixture(): Promise<TauriShellFixture> {
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
    `${JSON.stringify({ version: 1 }, null, 2)}\n`,
    { mode: 0o600 },
  );
  const profileDirectory = join(stationRoot, 'config');
  mkdirSync(profileDirectory, { recursive: true, mode: 0o700 });
  const profileNow = Date.now();
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
      rmSync(stationRoot, { recursive: true, force: true });
    },
  };
}
