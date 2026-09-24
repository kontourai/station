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

/**
 * How long the DRIVER may spend on ONE injected script (#2089, #2109).
 *
 * This bounds a single attempt. It is deliberately SHORTER than every lane
 * budget that wraps it, and that ordering is the whole point — see
 * {@link DirectWebDriver.waitUntil}, which can only re-check its budget after
 * a predicate returns. A per-attempt bound longer than the budget containing
 * it means every wait gets exactly one attempt and the retry loop cannot run.
 *
 * The scripts this bounds are one-expression probes (`document.readyState`,
 * `typeof window.__TAURI_INTERNALS__`). They do not take seconds to EVALUATE.
 * What takes time is being QUEUED: the embedded macOS driver runs
 * `execute/sync` on the WebView's main loop, which the app's own boot occupies
 * — mounting the shell parses two ~40 KB JSON payloads and fires ~50 requests,
 * and in a debug binary that runs well past 30 s. Tolerating that queue is the
 * RETRY LOOP's job, not this bound's. Abandon the queued attempt cheaply and
 * ask again; once boot finishes, the same probe answers in milliseconds.
 *
 * HISTORY, because the reasoning here has been correct and then wrong twice,
 * and both times the prose outlived the regime it described.
 *
 * It was first the W3C default of 30 s against a 30 s lane budget, so a probe
 * queued behind boot consumed the whole budget in one attempt. The docblock
 * that lived here concluded "widening any lane's `waitUntil` cannot help",
 * which was accurate for that arrangement.
 *
 * It was then set to 120 s — but passed as `capabilities.alwaysMatch.timeouts
 * .script`, which THIS driver ignores, so the session still reported
 * `"script":30000` while the constant claimed 120 s and the lane kept failing
 * at exactly 30,039 ms. #2107 fixed the application (`POST
 * /session/:id/timeouts`, read back in {@link DirectWebDriver.connect}), which
 * made the 120 s real — and inverted the fault rather than removing it. The
 * bound went from too short to ever succeed to too long to ever retry, and
 * the old sentence about widening survived into a world where the opposite
 * was true.
 *
 * MEASURED on a quiet host (load 7.9-13.7, no orphaned emulator), ten runs of
 * the plugin-host lane at 120 s: 8 passed in 26-39 s, 2 failed at 125-126 s,
 * both on `script timeout`, with nothing in between. That 86-second gap is
 * this constant — either the probe got through or it blocked for the entire
 * bound, once. The value below is short enough that the gap cannot exist.
 */
export const SCRIPT_TIMEOUT_MS = 5_000;

/**
 * How long this client waits for one request, and it MUST exceed
 * {@link SCRIPT_TIMEOUT_MS} (#2089/#2091).
 *
 * Both were 30_000, so a genuine script timeout was a race between the driver
 * answering `script timeout` at ~30,018 ms and this client aborting at 30,000 —
 * and the client won, replacing the only diagnostic that named the cause with
 * `TimeoutError: The operation was aborted due to timeout`. That is what made
 * this lane look like it failed at three unrelated places; all three were this.
 * Derived from the script timeout rather than written down separately, so the
 * ordering cannot drift.
 */
const REQUEST_TIMEOUT_MS = SCRIPT_TIMEOUT_MS + 30_000;

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

/**
 * A request the driver answered with a WebDriver error, carrying the error
 * CODE so a caller can tell one refusal from another (#2091).
 *
 * `message` is byte-identical to what {@link DirectWebDriver.request} threw
 * before this class existed, because every other caller only ever reads it:
 * the timeout messages desktop lanes print are built from `String(error)`.
 *
 * Not exported. The one caller that needs to discriminate is `findElement`
 * below, in this file.
 */
class WebDriverErrorResponse extends Error {
  /** The W3C error code, e.g. `no such element`, when the payload carried one. */
  readonly webDriverError: string | undefined;

  constructor(message: string, webDriverError: string | undefined) {
    super(message);
    this.name = 'WebDriverErrorResponse';
    this.webDriverError = webDriverError;
  }
}

/**
 * W3C error codes for which RETRYING IS A CATEGORY ERROR: the session or window
 * the poll would retry against no longer exists, or the driver does not
 * implement the command at all, so every remaining attempt fails identically.
 *
 * Everything NOT here stays retryable, which is the point of the narrowing
 * rather than a hedge: a wait that begins while the shell is still coming up
 * legitimately sees transport failures (`ECONNREFUSED`) and `stale element
 * reference` for as long as the page is settling, and those are what the loop
 * is for. `no such element` never reaches here at all — `findElement` answers
 * `undefined` for it, which is a poll result and not a fault.
 */
const SESSION_FATAL_WEBDRIVER_ERRORS: ReadonlySet<string> = new Set([
  'invalid session id',
  'no such window',
  'no such frame',
  'session not created',
  'unknown command',
]);

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
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const payload = (await response.json()) as WebDriverEnvelope<T>;
    if (!response.ok || payload.value?.error) {
      throw new WebDriverErrorResponse(
        `WebDriver ${method} ${path} failed: ${JSON.stringify(payload.value)}`,
        payload.value?.error,
      );
    }
    return payload.value;
  }

  async connect(timeout = 60_000) {
    const started = Date.now();
    let lastError: unknown;
    let connected = false;
    while (Date.now() - started < timeout) {
      try {
        await this.request('GET', '/status');
        const session = await this.request<SessionValue>('POST', '/session', {
          capabilities: {
            alwaysMatch: {
              browserName: 'tauri',
              // Sent because it is the W3C spelling, NOT because it works:
              // this driver answers with `script: 30000` regardless. The
              // binding call is `applyScriptTimeout` below.
              timeouts: { script: SCRIPT_TIMEOUT_MS },
            },
            firstMatch: [{}],
          },
        });
        this.sessionId = session.sessionId;
        this.capabilities = session.capabilities;
        connected = true;
        break;
      } catch (error) {
        lastError = error;
        await sleep(100);
      }
    }
    if (!connected) {
      throw new Error(
        `Embedded WebDriver did not become ready: ${String(lastError)}`,
      );
    }
    // Outside the retry loop deliberately: a driver that will not adopt the
    // bound is a fault to report, not a reason to open another session.
    await this.applyScriptTimeout();
  }

  /**
   * Set the script timeout through the command that actually binds it, and
   * prove it took.
   *
   * The read-back is the point. The capability request alone left the session
   * on the 30 s default while every comment in this file said 120 s, which is
   * how the widening shipped inert — so this asserts the driver's own answer
   * rather than trusting the request.
   */
  private async applyScriptTimeout() {
    await this.request('POST', this.sessionPath('/timeouts'), {
      script: SCRIPT_TIMEOUT_MS,
    });
    const applied = await this.request<{ script?: number }>(
      'GET',
      this.sessionPath('/timeouts'),
    );
    if (applied.script !== SCRIPT_TIMEOUT_MS) {
      throw new Error(
        `WebDriver did not adopt the script timeout: asked for ${SCRIPT_TIMEOUT_MS}ms, session reports ${JSON.stringify(applied)}.`,
      );
    }
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
   * A real element reference, for a real click through the driver.
   *
   * `execute()` could dispatch a synthetic click and would be shorter. It
   * would also be a different event than a user produces, which is the
   * distinction `tests/AGENTS.md` draws: a synthetic dispatch hides the
   * behavior under test. WebDriver's own `/element/:id/click`
   * ({@link DirectWebDriver.clickElement}) is the closest thing this harness
   * has to a press, and it needs the reference this returns.
   *
   * ONLY the page genuinely not having the element answers `undefined` (#2091).
   *
   * This used to be a bare `catch { return undefined }`, and
   * {@link DirectWebDriver.request} throws on transport failure, on its own
   * request timeout, on any non-success status and on a WebDriver error
   * payload — so all four became the same answer. Every wait in every desktop
   * lane is keyed on this lookup, so a dead session, a hung driver or a shell
   * that never came up surfaced as a product-shaped sentence like "the pane
   * never appeared", and the reader went looking at the product for a fault in
   * the harness. It could never produce a false GREEN — swallowing only ever
   * yields a timeout — but the misdirected failure is paid for by whoever
   * reads it next, and there are now two lanes doing the reading.
   *
   * `no such element` is the W3C error code for the one case that is an
   * answer rather than a fault. Everything else propagates with its own
   * message, which `waitUntil` then prints as `Last error:` beside the
   * lane's own sentence.
   */
  async findElement(css: string): Promise<string | undefined> {
    try {
      const value = await this.request<Record<string, string>>(
        'POST',
        this.sessionPath('/element'),
        { using: 'css selector', value: css },
      );
      return Object.values(value)[0];
    } catch (error) {
      if (
        error instanceof WebDriverErrorResponse &&
        error.webDriverError === 'no such element'
      )
        return undefined;
      throw error;
    }
  }

  async clickElement(elementId: string) {
    await this.request(
      'POST',
      this.sessionPath(`/element/${elementId}/click`),
      {},
    );
  }

  /** W3C WebDriver keystrokes, so shell journeys use actual input events. */
  async typeElement(elementId: string, value: string) {
    await this.request('POST', this.sessionPath(`/element/${elementId}/value`), {
      text: value,
      value: [...value],
    });
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
        // A fault the next attempt cannot clear is reported AS ITSELF, now,
        // rather than retried for the rest of the budget and then delivered as
        // a suffix on a product-shaped sentence. `findElement` was narrowed so
        // a dead session stops reading as "the page does not have this
        // element" (#2091); this is the layer above it. Without this the
        // WebDriver refusal still arrives, but only after the lane has spent
        // its whole 30-60s budget polling a session that ended, and only
        // BEHIND a headline asserting a product fact ("The Device pane never
        // appeared in the shell.") that the harness was never in a position to
        // observe. The reader is sent to the product for a fault in the
        // harness — which is the misdirection #2091 set out to remove, one
        // layer up.
        if (
          error instanceof WebDriverErrorResponse &&
          error.webDriverError !== undefined &&
          SESSION_FATAL_WEBDRIVER_ERRORS.has(error.webDriverError)
        ) {
          throw error;
        }
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
  /** An inert saved broker route for native approval checks; no grant or trust. */
  seedRelayRoute?: {
    name: string;
    endpoint: string;
    brokerOrigin: string;
    stationId: string;
    enrollmentId: string;
    clientInstanceId: string;
  };
  /** Use the real OS keyring for a specifically owned native custody proof. */
  realCredentialStore?: boolean;
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
          profiles: options.seedRelayRoute
            ? [
                {
                  schemaVersion: 1,
                  name: options.seedRelayRoute.name,
                  endpoint: options.seedRelayRoute.endpoint,
                  clientInstanceId: options.seedRelayRoute.clientInstanceId,
                  relayRoute: {
                    brokerOrigin: options.seedRelayRoute.brokerOrigin,
                    stationId: options.seedRelayRoute.stationId,
                    enrollmentId: options.seedRelayRoute.enrollmentId,
                  },
                  setupSource: 'manual',
                  configurationState: 'unconfigured',
                  createdAt: profileNow,
                  updatedAt: profileNow,
                },
              ]
            : [],
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
  const childEnv: NodeJS.ProcessEnv = {
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
  };
  if (options.realCredentialStore)
    delete childEnv.STATION_TAURI_E2E_MOCK_CREDENTIAL;
  const child = spawn(binary, [], {
    cwd: root,
    env: childEnv,
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
