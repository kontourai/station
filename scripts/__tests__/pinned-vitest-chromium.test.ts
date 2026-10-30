import {
  chmodSync,
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright-core';
import { describe, expect, it, vi } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import {
  ChromiumAcquisition,
  defaultChromiumAcquisitionDeps,
} from '../../src-server/services/browser/chromium-acquisition.js';
import setup from '../../vitest.global-setup.js';
import {
  bindPinnedVitestChromium,
  configuredPinnedChromium,
} from '../lib/pinned-vitest-chromium.mjs';

const makeTempDir = trackTempDirs();
const revision = /[/\\]chromium-(\d+)[/\\]/.exec(
  chromium.executablePath(),
)?.[1];
if (!revision)
  throw new Error('Playwright must identify its pinned Chromium revision');

function fixture() {
  const home = makeTempDir('station-pinned-browser-');
  const systemBin = join(home, 'system-bin');
  const cache = join(home, 'cache');
  const directory = join(cache, `chromium-${revision}`);
  const executable = join(directory, 'chrome-linux64', 'chrome');
  const runRoot = join(home, 'run');
  mkdirSync(systemBin);
  mkdirSync(join(directory, 'chrome-linux64'), { recursive: true });
  mkdirSync(runRoot);
  const system = join(systemBin, 'google-chrome');
  for (const file of [system, executable]) {
    writeFileSync(file, '#!/bin/sh\nexit 0\n');
    chmodSync(file, 0o700);
  }
  writeFileSync(join(directory, 'INSTALLATION_COMPLETE'), '');
  const env: NodeJS.ProcessEnv = {
    PATH: systemBin,
    PLAYWRIGHT_BROWSERS_PATH: cache,
  };
  const options = { env, platform: 'linux' as const };
  const acquisition = () =>
    new ChromiumAcquisition(join(home, 'station-home'), {
      ...defaultChromiumAcquisitionDeps(),
      platform: 'linux',
      env,
    });
  return { env, options, acquisition, system, executable, directory, runRoot };
}

describe('explicit pinned Chromium for a Vitest run', () => {
  it.runIf(process.platform === 'linux')(
    'global setup binds acquisition and its teardown removes the owned alias',
    async () => {
      const f = fixture();
      vi.stubEnv('PATH', f.env.PATH);
      vi.stubEnv('PLAYWRIGHT_BROWSERS_PATH', f.env.PLAYWRIGHT_BROWSERS_PATH);
      vi.stubEnv(
        'STATION_VITEST_RUN_ROOT',
        process.env.STATION_VITEST_RUN_ROOT,
      );
      vi.stubEnv(
        'STATION_VITEST_HOST_TMPDIR',
        process.env.STATION_VITEST_HOST_TMPDIR,
      );
      let cleanup: (() => Promise<void>) | undefined;
      try {
        cleanup = await setup();
        const selected = new ChromiumAcquisition(
          join(f.runRoot, 'home'),
        ).resolveExecutable();
        expect(realpathSync(selected!)).toBe(realpathSync(f.executable));
        const alias = selected!;
        await cleanup();
        cleanup = undefined;
        expect(existsSync(alias)).toBe(false);
        expect(process.env.PATH).toBe(f.env.PATH);
      } finally {
        await cleanup?.();
        vi.unstubAllEnvs();
      }
    },
  );

  it('uses the locked binary through real acquisition even when system Chrome was first', () => {
    const f = fixture();
    expect(f.acquisition().resolveExecutable()).toBe(f.system);
    const restore = bindPinnedVitestChromium(f.runRoot, f.options);
    try {
      const selected = f.acquisition().resolveExecutable();
      expect(selected).toBe(join(f.runRoot, 'browser-bin', 'google-chrome'));
      expect(realpathSync(selected!)).toBe(realpathSync(f.executable));
    } finally {
      restore();
    }
    expect(f.env.PATH).toBe(dirname(f.system));
    expect(f.acquisition().resolveExecutable()).toBe(f.system);
    rmSync(f.runRoot, { recursive: true });
    expect(existsSync(f.executable)).toBe(true);
  });

  it.each(['completion marker', 'executable', 'locked revision'])(
    'refuses a missing %s instead of falling back to installed system Chrome',
    (missing) => {
      const f = fixture();
      if (missing === 'completion marker')
        rmSync(join(f.directory, 'INSTALLATION_COMPLETE'));
      else if (missing === 'executable') rmSync(f.executable);
      else {
        const other = join(f.directory, '..', 'chromium-1');
        mkdirSync(other);
        writeFileSync(join(other, 'INSTALLATION_COMPLETE'), '');
        rmSync(f.directory, { recursive: true });
      }
      expect(() => bindPinnedVitestChromium(f.runRoot, f.options)).toThrow(
        'unavailable',
      );
      expect(f.env.PATH).toBe(dirname(f.system));
      expect(existsSync(join(f.runRoot, 'browser-bin'))).toBe(false);
    },
  );

  it('preserves normal installed-browser selection without an explicit cache opt-in', () => {
    const f = fixture();
    delete f.env.PLAYWRIGHT_BROWSERS_PATH;
    const restore = bindPinnedVitestChromium(f.runRoot, f.options);
    expect(f.acquisition().resolveExecutable()).toBe(f.system);
    expect(existsSync(join(f.runRoot, 'browser-bin'))).toBe(false);
    restore();
  });

  it('does not change non-Linux acquisition or overwrite a later PATH edit', () => {
    const f = fixture();
    expect(
      configuredPinnedChromium({ ...f.options, platform: 'darwin' }),
    ).toBeUndefined();
    expect(
      bindPinnedVitestChromium(f.runRoot, { ...f.options, platform: 'darwin' }),
    ).not.toThrow();
    expect(f.env.PATH).toBe(dirname(f.system));
    const restore = bindPinnedVitestChromium(f.runRoot, f.options);
    f.env.PATH = '/later-owner';
    restore();
    expect(f.env.PATH).toBe('/later-owner');
  });
});
