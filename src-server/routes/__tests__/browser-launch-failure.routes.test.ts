/**
 * A Chromium that dies at launch, through the real launcher.
 *
 * `POST /api/browser/sessions` runs over a real session registry and a real
 * `ChromiumServerHost` whose production launcher (`launchChromiumProcess`)
 * spawns a fake Chromium: a shell script that writes what Chromium writes to
 * stderr and exits. Its CDP pipe closes before Node reports the exit, which
 * is the race that turned the sandbox refusal into an untyped 500.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createLocalBrowserHostResolver } from '../../services/browser/browser-host.js';
import { LocalTargetStore } from '../../services/browser/browser-local-targets.js';
import { BrowserSessionRegistry } from '../../services/browser/browser-session-registry.js';
import {
  type ChromiumHostEvent,
  ChromiumServerHost,
} from '../../services/browser/hosts/chromium-server-host.js';
import { deriveStationListeners } from '../../services/browser/station-listeners.js';
import { createBrowserRoutes } from '../browser.js';

/** Chromium 154's line on Ubuntu 26.04 with AppArmor userns restriction on. */
const SANDBOX_FATAL =
  '[4242:4242:1104/093012.345678:FATAL:content/browser/zygote_host/zygote_host_impl_linux.cc:129] No usable sandbox! If you are running on Ubuntu 23.10+ or another Linux distro that has disabled unprivileged user namespaces with AppArmor, see https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md. Otherwise see https://chromium.googlesource.com/chromium/src/+/main/docs/linux/suid_sandbox_development.md for more information on developing with the (older) SUID sandbox. If you want to live dangerously and need an immediate workaround, you can try using --no-sandbox.';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** An executable that writes `stderr` lines and exits with `code`. */
function fakeChromium(stderr: readonly string[], code: number): string {
  const path = join(tempDir('station-fake-chromium-'), 'chrome');
  const lines = stderr
    .map((line) => `printf '%s\\n' '${line.replaceAll("'", "'\\''")}' >&2`)
    .join('\n');
  writeFileSync(path, `#!/bin/sh\n${lines}\nexit ${code}\n`);
  chmodSync(path, 0o755);
  return path;
}

/**
 * An executable that writes `stderr` in ONE write(2) call, then exits with
 * `code` (or, with `code` null, stays up and never answers CDP).
 */
function fakeChromiumSingleWrite(stderr: string, code: number | null): string {
  const path = join(tempDir('station-fake-chromium-'), 'chrome');
  const body =
    code === null
      ? `require('node:fs').writeSync(2, ${JSON.stringify(stderr)}); setInterval(() => {}, 1000);`
      : `require('node:fs').writeSync(2, ${JSON.stringify(stderr)}); process.exit(${code});`;
  writeFileSync(path, `#!${process.execPath}\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

function harness(executablePath: string, launchTimeoutMs?: number) {
  const stationHome = tempDir('station-browser-launch-');
  const events: ChromiumHostEvent[] = [];
  const listeners = deriveStationListeners({
    serverPort: 4100,
    configuredOrigins: [],
  });
  const registry = new BrowserSessionRegistry({
    stationHome,
    hostResolver: createLocalBrowserHostResolver(
      () =>
        new ChromiumServerHost({
          executablePath,
          egressPolicy: {
            listeners: () => listeners,
            interfaceAddresses: () => [],
            reach: { kind: 'operator' },
          },
          onEvent: (event) => events.push(event),
          ...(launchTimeoutMs ? { launchTimeoutMs } : {}),
        }),
    ),
  });
  const app = new Hono();
  app.route(
    '/api/browser',
    createBrowserRoutes({
      registry,
      acquisition: {
        status: vi.fn(() => ({
          state: 'downloaded' as const,
          executablePath,
          version: '154.0.8037.57',
        })),
        startDownload: vi.fn(),
      } as never,
      authorizeProject: async () => ({ kind: 'operator' }),
      authorizeOperator: async () => true,
      localTargets: new LocalTargetStore(stationHome),
      listeners: () => listeners,
      suggestLocalTargets: vi.fn(),
      resolveProject: (slug) =>
        slug === 'alpha' ? { id: 'p-alpha', slug } : undefined,
      isStationInternalRequest: () => false,
      isRequestPrincipalCurrent: () => true,
    }),
  );
  const open = () =>
    app.request('/api/browser/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectSlug: 'alpha', url: 'https://google.com' }),
    });
  return { open, events, registry };
}

describe.skipIf(process.platform === 'win32')(
  'POST /api/browser/sessions when Chromium cannot start',
  () => {
    test('a Linux sandbox refusal is a typed 503 with no stderr in the body', async () => {
      const chrome = fakeChromium(
        [
          '[4242:4242:1104/093012.000001:WARNING:some_noise.cc:1] noise',
          SANDBOX_FATAL,
        ],
        134,
      );
      const { open, events } = harness(chrome);
      const response = await open();
      expect(response.status).toBe(503);
      // Exactly the classified code: no reason, path or stderr excerpt.
      expect(await response.json()).toEqual({
        success: false,
        code: 'browser-sandbox-unavailable',
      });
      // The detail stays server-side, for the log.
      const failed = events.find((event) => event.kind === 'launch-failed');
      expect(failed).toMatchObject({
        kind: 'launch-failed',
        failure: 'sandbox-unavailable',
      });
      expect(failed && 'reason' in failed && failed.reason).toContain(
        'code 134',
      );
    });

    test('the FATAL line still classifies when later output overflows the stderr tail', async () => {
      const noise = Array.from(
        { length: 120 },
        (_, i) => `#${i} 0x5555deadbeef (/opt/chrome/chrome+0x${i}abcdef)`,
      );
      const { open } = harness(fakeChromium([SANDBOX_FATAL, ...noise], 134));
      const response = await open();
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        success: false,
        code: 'browser-sandbox-unavailable',
      });
    });

    test('the FATAL line classifies when one stderr write carries it and over 4 KiB after it', async () => {
      const payload = `${SANDBOX_FATAL}\n${'#0 0x5555deadbeef stack frame\n'.repeat(400)}`;
      expect(payload.length).toBeGreaterThan(4096);
      const { open } = harness(fakeChromiumSingleWrite(payload, 134));
      const response = await open();
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        success: false,
        code: 'browser-sandbox-unavailable',
      });
    });

    test('a Chromium that hangs at launch (never answers, never exits) is "could not start", not an untyped 500', async () => {
      const { open, events, registry } = harness(
        fakeChromiumSingleWrite('starting\n', null),
        300,
      );
      const response = await open();
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        success: false,
        code: 'browser-host-failed',
      });
      const failed = events.find((event) => event.kind === 'launch-failed');
      expect(failed && 'reason' in failed && failed.reason).toContain(
        'timed out',
      );
      await registry.shutdown();
    }, 20_000);

    test('any other launch death is "could not start", not an untyped 500', async () => {
      const { open, events } = harness(
        fakeChromium(['[1:1:1104/0:ERROR:gpu_init.cc:1] something else'], 1),
      );
      const response = await open();
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        success: false,
        code: 'browser-host-failed',
      });
      const failed = events.find((event) => event.kind === 'launch-failed');
      expect(failed).toBeDefined();
      expect(failed && 'failure' in failed).toBe(false);
    });

    test('a second Open relaunches and is refused the same way', async () => {
      const { open } = harness(fakeChromium([SANDBOX_FATAL], 134));
      expect((await open()).status).toBe(503);
      const again = await open();
      expect(again.status).toBe(503);
      expect(await again.json()).toEqual({
        success: false,
        code: 'browser-sandbox-unavailable',
      });
    });
  },
);
