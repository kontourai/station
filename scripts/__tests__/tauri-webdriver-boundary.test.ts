import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { DirectWebDriver } from '../../tests/tauri-shell/direct-webdriver';
import { tauriShellBinaryCandidates } from '../run-tauri-shell-e2e.mjs';

const root = new URL('../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');

describe('Tauri embedded WebDriver boundary', () => {
  test('keeps the automation server optional, explicit, and out of releases', () => {
    const cargo = read('src-desktop/Cargo.toml');
    const rust = read('src-desktop/src/lib.rs');
    const webdriverConfig = JSON.parse(
      read('src-desktop/tauri.webdriver.conf.json'),
    );
    const webdriverRunner = read('tests/tauri-shell/direct-webdriver.ts');
    const release = read('.github/workflows/release.yml');

    expect(cargo).toContain('webdriver = ["dep:tauri-plugin-wdio-webdriver"]');
    expect(cargo).toContain(
      'tauri-plugin-wdio-webdriver = { version = "=1.4.0", optional = true }',
    );
    expect(rust).toContain('#[cfg(all(not(mobile), feature = "webdriver"))]');
    expect(rust).toContain(
      'builder.plugin(tauri_plugin_wdio_webdriver::init())',
    );
    expect(webdriverConfig.identifier).toBe('io.kontourai.station.webdriver');
    expect(rust).toContain(
      'if !cfg!(debug_assertions) || app_identifier != "io.kontourai.station.webdriver"',
    );
    expect(rust).toContain('keyring_core::mock::Store::new()');
    expect(webdriverRunner).toContain("STATION_TAURI_E2E_MOCK_CREDENTIAL: '1'");
    expect(webdriverRunner).toContain('TAURI_WEBDRIVER_PORT');
    expect(webdriverRunner).not.toContain('@wdio/');
    expect(release).not.toContain('tauri.webdriver.conf.json');
    expect(release).not.toMatch(/--features[= ]+webdriver/);
    expect(release).not.toContain('STATION_TAURI_E2E_MOCK_CREDENTIAL');
  });

  test('resolves only bounded platform-specific binary locations', () => {
    expect(tauriShellBinaryCandidates('/repo', 'win32')).toEqual([
      join('/repo', 'src-desktop', 'target', 'debug', 'station.exe'),
    ]);
    expect(tauriShellBinaryCandidates('/repo', 'linux')).toEqual([
      join('/repo', 'src-desktop', 'target', 'debug', 'station'),
    ]);
    expect(tauriShellBinaryCandidates('/repo', 'darwin')).toContain(
      join(
        '/repo',
        'src-desktop',
        'target',
        'debug',
        'bundle',
        'macos',
        'Station Tauri Shell E2E.app',
        'Contents',
        'MacOS',
        'station',
      ),
    );
  });

  /**
   * #2091. `findElement` used to answer `undefined` for every failure its
   * request can produce, so a dead session read as "the page does not have
   * this element" and every desktop lane printed a product-shaped timeout for
   * a harness fault.
   *
   * WHY THIS IS A UNIT TEST AND NOT A LANE ASSERTION. All four `findElement`
   * callers sit inside a `waitUntil` predicate, and on the SUCCESS path a throw
   * and an `undefined` are indistinguishable, so a green lane cannot tell the
   * two implementations apart. Confirmed by injection: narrowing to an error
   * code that can never match still passed the whole `device-pane` lane. The
   * difference the change buys is in the FAILURE message, which is exactly the
   * discrimination below. A lane run remains the proof that the not-found
   * answer is still `undefined` in production (`device-pane` is green with this
   * narrowing).
   *
   * `waitUntil` used to record EVERY predicate throw into `lastError` and keep
   * polling regardless. Narrowing `findElement` revived that machinery — before
   * it, the predicate never threw at all and `lastError` stayed `undefined`, so
   * the `Last error:` suffix the class was built for could not be produced.
   * `SESSION_FATAL_WEBDRIVER_ERRORS` is the layer above: see the block below.
   */
  describe('findElement answers only for a genuinely missing element (#2091)', () => {
    afterEach(() => vi.unstubAllGlobals());

    function connected(
      respond: (url: string) => Promise<unknown> | unknown,
    ): DirectWebDriver {
      const driver = new DirectWebDriver(4444);
      driver.sessionId = 'session-under-test';
      vi.stubGlobal('fetch', (url: string) =>
        Promise.resolve(respond(String(url))),
      );
      return driver;
    }

    const payload = (status: number, value: unknown) => ({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve({ value }),
    });

    test('a W3C no-such-element answer is `undefined`, as every wait expects', async () => {
      const driver = connected(() =>
        payload(404, {
          error: 'no such element',
          message: 'Unable to locate element: .missing',
          stacktrace: '',
        }),
      );
      await expect(driver.findElement('.missing')).resolves.toBeUndefined();
    });

    test('a found element still resolves to its reference', async () => {
      const driver = connected(() =>
        payload(200, { 'element-6066-11e4-a52e-4f735466cecf': 'element-1' }),
      );
      await expect(driver.findElement('.present')).resolves.toBe('element-1');
    });

    test('a transport failure propagates instead of reading as absence', async () => {
      const driver = new DirectWebDriver(4444);
      driver.sessionId = 'session-under-test';
      vi.stubGlobal('fetch', () =>
        Promise.reject(new TypeError('fetch failed: connection refused')),
      );
      await expect(driver.findElement('.anything')).rejects.toThrow(
        /connection refused/,
      );
    });

    test('a different WebDriver error propagates and names itself', async () => {
      // The one that mattered: a session the driver has forgotten. Answering
      // `undefined` here is what turned "the shell is gone" into "the pane
      // never appeared".
      const driver = connected(() =>
        payload(404, {
          error: 'invalid session id',
          message: 'Session does not exist',
          stacktrace: '',
        }),
      );
      await expect(driver.findElement('.anything')).rejects.toThrow(
        /invalid session id/,
      );
    });

    test('a non-success status carrying no error code still propagates', async () => {
      const driver = connected(() => payload(500, {}));
      await expect(driver.findElement('.anything')).rejects.toThrow(
        /WebDriver POST .* failed/,
      );
    });

    test('looking for an element with no session says so', async () => {
      // `sessionPath` throws before any request is made, and the old bare
      // catch swallowed that too.
      const driver = new DirectWebDriver(4444);
      await expect(driver.findElement('.anything')).rejects.toThrow(
        /session is not connected/,
      );
    });
  });

  /**
   * The layer above `findElement`'s narrowing.
   *
   * Once a fault propagates OUT of the predicate, `waitUntil` decides what
   * happens to it. Recording every throw into `lastError` and polling on means
   * a session that has ENDED is retried for the whole 30-60s budget and then
   * reported behind the lane's own product-shaped headline — "The Device pane
   * never appeared in the shell." with the WebDriver refusal appended as a
   * suffix. The harness fault reads as secondary to a product claim the
   * harness was never in a position to observe, which is the misdirection
   * #2091 removed one layer down.
   *
   * These drive `waitUntil` ITSELF rather than a helper that feeds it, because
   * the decision under test is the catch in the loop, not the predicate.
   */
  describe('waitUntil stops polling a fault a retry cannot clear', () => {
    afterEach(() => vi.unstubAllGlobals());

    function refusing(code: string): DirectWebDriver {
      const driver = new DirectWebDriver(4444);
      driver.sessionId = 'session-under-test';
      vi.stubGlobal('fetch', () =>
        Promise.resolve({
          ok: false,
          status: 404,
          json: () =>
            Promise.resolve({
              value: {
                error: code,
                message: `driver says: ${code}`,
                stacktrace: '',
              },
            }),
        }),
      );
      return driver;
    }

    test('an ended session is reported as itself, not as the lane sentence', async () => {
      const driver = refusing('invalid session id');
      const started = Date.now();
      // 8_000 rather than the lane's real 30_000, deliberately: a wait that
      // polls to ITS deadline must still finish inside vitest's own budget, or
      // the pre-fix behaviour reds as `Test timed out in 30000ms` — a vitest
      // artifact — instead of as the assertion that names what went wrong.
      // Confirmed by injection: with the narrowing removed this now fails on
      // `expected ... to match /invalid session id/`, naming the defect.
      await expect(
        driver.waitUntil(
          async () => Boolean(await driver.findElement('.pane')),
          {
            timeout: 8_000,
            timeoutMsg: 'The Device pane never appeared in the shell.',
          },
        ),
      ).rejects.toThrow(/invalid session id/);
      // The budget is not spent before saying so. Bounded well under the
      // 8_000 it was given, and well over any plausible single round trip, so
      // this discriminates "returned promptly" from "polled to the deadline"
      // without pinning a machine-speed number.
      expect(Date.now() - started).toBeLessThan(3_000);
    });

    test('the refusal is not delivered behind a claim about the product', async () => {
      const driver = refusing('no such window');
      await expect(
        driver.waitUntil(
          async () => Boolean(await driver.findElement('.pane')),
          {
            timeout: 8_000,
            timeoutMsg: 'The Device pane never appeared in the shell.',
          },
        ),
      ).rejects.toThrow(
        // The thrown error is the driver's own, so the lane's sentence — which
        // asserts a product fact nothing observed — is absent entirely.
        expect.objectContaining({
          message: expect.not.stringContaining('never appeared in the shell'),
        }),
      );
    });

    test('a fault a retry CAN clear is still retried, then summarised', async () => {
      // The power guard. If everything propagated, the loop would be pointless
      // and this test would fail — a wait that begins while the shell is still
      // starting legitimately sees these.
      let attempts = 0;
      const driver = new DirectWebDriver(4444);
      driver.sessionId = 'session-under-test';
      vi.stubGlobal('fetch', () => {
        attempts += 1;
        return Promise.reject(
          new TypeError('fetch failed: connection refused'),
        );
      });
      await expect(
        driver.waitUntil(
          async () => Boolean(await driver.findElement('.pane')),
          {
            timeout: 600,
            interval: 50,
            timeoutMsg: 'The Device pane never appeared in the shell.',
          },
        ),
      ).rejects.toThrow(
        /never appeared in the shell.*Last error:.*connection refused/s,
      );
      expect(attempts).toBeGreaterThan(1);
    });

    test('a transient refusal keeps polling and can still succeed', async () => {
      let attempts = 0;
      const driver = new DirectWebDriver(4444);
      driver.sessionId = 'session-under-test';
      vi.stubGlobal('fetch', () => {
        attempts += 1;
        if (attempts < 3)
          return Promise.resolve({
            ok: false,
            status: 404,
            json: () =>
              Promise.resolve({
                value: {
                  error: 'stale element reference',
                  message: 'stale',
                  stacktrace: '',
                },
              }),
          });
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              value: { 'element-6066-11e4-a52e-4f735466cecf': 'element-1' },
            }),
        });
      });
      await expect(
        driver.waitUntil(
          async () => Boolean(await driver.findElement('.pane')),
          {
            timeout: 5_000,
            interval: 10,
            timeoutMsg: 'The Device pane never appeared in the shell.',
          },
        ),
      ).resolves.toBeUndefined();
      expect(attempts).toBe(3);
    });
  });

  describe('the script timeout is applied, not merely requested (#2089)', () => {
    afterEach(() => vi.unstubAllGlobals());

    /**
     * Answers like the real embedded driver, which IGNORES
     * `capabilities.timeouts` and only moves on `POST /timeouts`. `adopts`
     * false is that driver before this was fixed; true is it after.
     */
    function driverThatOnlyHonoursThePostCommand(adopts: boolean) {
      const calls: string[] = [];
      let script = 30_000;
      vi.stubGlobal('fetch', (url: string, init?: { method?: string; body?: string }) => {
        const path = String(url).replace('http://127.0.0.1:4444', '');
        const method = init?.method ?? 'GET';
        calls.push(`${method} ${path}`);
        if (path === '/status') return Promise.resolve(ok({}));
        if (path === '/session') {
          // The capability is echoed back UNAPPLIED, exactly as observed.
          return Promise.resolve(
            ok({
              sessionId: 'session-under-test',
              capabilities: { timeouts: { script: 30_000 } },
            }),
          );
        }
        if (path === '/session/session-under-test/timeouts') {
          if (method === 'POST') {
            if (adopts) script = JSON.parse(init?.body ?? '{}').script;
            return Promise.resolve(ok(null));
          }
          return Promise.resolve(ok({ implicit: 0, pageLoad: 300_000, script }));
        }
        throw new Error(`unexpected ${method} ${path}`);
      });
      return calls;
    }

    const ok = (value: unknown) => ({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ value }),
    });

    test('connect() sends the timeouts command rather than trusting the capability', async () => {
      const calls = driverThatOnlyHonoursThePostCommand(true);
      await new DirectWebDriver(4444).connect();
      expect(calls).toContain('POST /session/session-under-test/timeouts');
      // And reads it back, which is what makes the value a derivation rather
      // than a constant nothing applied.
      expect(calls).toContain('GET /session/session-under-test/timeouts');
    });

    test('a driver that will not adopt the bound fails connect() instead of running on the default', async () => {
      driverThatOnlyHonoursThePostCommand(false);
      await expect(new DirectWebDriver(4444).connect()).rejects.toThrow(
        /did not adopt the script timeout: asked for 120000ms, session reports .*"script":30000/,
      );
    });
  });

  test('does not install unrelated external browser drivers', () => {
    // Station has one pnpm lockfile. Reading a removed npm lockfile made this
    // policy test fail before it could establish anything about the resolved
    // dependency graph.
    const lock = read('pnpm-lock.yaml');
    expect(lock).not.toMatch(/^\s{2}edgedriver@/m);
    expect(lock).not.toMatch(/^\s{2}geckodriver@/m);
  });
});
