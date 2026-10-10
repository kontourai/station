import * as realFs from 'node:fs';
import { mkdirSync, readlinkSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';

/**
 * The Windows switch of `current` retries a rename a scanner briefly refuses
 * (#3363), at its call sites: install.ps1's core and the service launcher.
 * `renameSync` refuses the next `refusals` renames with EPERM, as Windows
 * does while another process holds a handle in the tree.
 */
const refusals = vi.hoisted(() => ({ left: 0, seen: 0 }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const renameSync: typeof actual.renameSync = (from, to) => {
    if (refusals.left > 0) {
      refusals.left -= 1;
      refusals.seen += 1;
      throw Object.assign(new Error('EPERM: operation not permitted, rename'), {
        code: 'EPERM',
      });
    }
    actual.renameSync(from, to);
  };
  return { ...actual, default: { ...actual, renameSync }, renameSync };
});

const makeTempDir = trackTempDirs();

type Switch = {
  point: (root: string, version: string, platform: NodeJS.Platform) => void;
  recover: (root: string, platform: NodeJS.Platform) => void;
};

async function switches(): Promise<Record<string, Switch>> {
  const launcher = (await import(
    '../../packaging/portable-server/bin/station-launcher.mjs'
  )) as unknown as {
    pointCurrentAt: Switch['point'];
    recoverCurrent: Switch['recover'];
  };
  const installer = await import(
    '../../packages/shared/src/installer/full-install.js'
  );
  return {
    launcher: {
      point: launcher.pointCurrentAt,
      recover: launcher.recoverCurrent,
    },
    'install.ps1': {
      point: (root, version, platform) =>
        installer.pointCurrentAt(
          root,
          join(root, 'versions', version),
          platform,
        ),
      recover: installer.recoverCurrent,
    },
  };
}

function installRoot(): string {
  const root = makeTempDir('station-rename-retry-');
  for (const version of ['1.0.0', '1.1.0'])
    mkdirSync(join(root, 'versions', version), { recursive: true });
  symlinkSync(join(root, 'versions', '1.0.0'), join(root, 'current'));
  return root;
}

const current = (root: string) =>
  readlinkSync(join(root, 'current')).split(/[\\/]/).at(-1);

describe('the Windows switch of current survives a briefly refused rename (#3363)', {
  timeout: 30_000,
}, () => {
  it.each(['launcher', 'install.ps1'])(
    '%s: pointCurrentAt retries two refusals and switches',
    async (side) => {
      const rule = (await switches())[side];
      const root = installRoot();
      refusals.left = 2;
      refusals.seen = 0;
      rule.point(root, '1.1.0', 'win32');
      expect(refusals.seen).toBe(2);
      expect(current(root)).toBe('1.1.0');
      expect(realFs.existsSync(join(root, 'current.next'))).toBe(false);
    },
  );

  it.each(['launcher', 'install.ps1'])(
    '%s: recoverCurrent retries a refusal and finishes the switch',
    async (side) => {
      const rule = (await switches())[side];
      const root = makeTempDir('station-rename-retry-');
      mkdirSync(join(root, 'versions', '1.1.0'), { recursive: true });
      symlinkSync(join(root, 'versions', '1.1.0'), join(root, 'current.next'));
      refusals.left = 1;
      refusals.seen = 0;
      rule.recover(root, 'win32');
      expect(refusals.seen).toBe(1);
      expect(current(root)).toBe('1.1.0');
    },
  );
});
