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
   * WHY THIS IS A UNIT TEST AND NOT A LANE ASSERTION. `waitUntil` catches
   * whatever its predicate throws into `lastError` and keeps polling, and all
   * four `findElement` callers are inside a `waitUntil` predicate — so on the
   * SUCCESS path a throw and an `undefined` are indistinguishable, and a green
   * lane cannot tell the two implementations apart. Confirmed by injection:
   * narrowing to an error code that can never match still passed the whole
   * `device-pane` lane. The difference the change buys is in the FAILURE
   * message, which is exactly the discrimination below. A lane run remains the
   * proof that the not-found answer is still `undefined` in production
   * (`device-pane` is green with this narrowing).
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

  test('does not install unrelated external browser drivers', () => {
    // Station has one pnpm lockfile. Reading a removed npm lockfile made this
    // policy test fail before it could establish anything about the resolved
    // dependency graph.
    const lock = read('pnpm-lock.yaml');
    expect(lock).not.toMatch(/^\s{2}edgedriver@/m);
    expect(lock).not.toMatch(/^\s{2}geckodriver@/m);
  });
});
