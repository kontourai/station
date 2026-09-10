import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { publishNightlyDesktop } from '../lib/publish-nightly-desktop.mjs';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'station-desktop-publish-'));
  roots.push(root);
  const plan = {
    sourceSha: 'a'.repeat(40),
    cohortId: 'cohort',
    planContentDigest: 'digest',
    versionIdentities: {
      desktop: {
        releaseTag: 'nightly-desktop',
        version: '0.1.11-nightly.2443.2',
      },
    },
  };
  const receipts = ['macos', 'windows'].map((platform) => {
    const directory = join(root, `cohort-${platform}`);
    mkdirSync(directory);
    const names =
      platform === 'macos'
        ? [
            'latest.json',
            'station-nightly-desktop-macos-aarch64.dmg',
            'station-nightly-desktop-macos-aarch64.app.tar.gz',
            'station-nightly-desktop-macos-aarch64.app.tar.gz.sig',
          ]
        : [
            'station-nightly-desktop-windows-x86_64.msi',
            'station-nightly-desktop-windows-x86_64.msi.zip',
            'station-nightly-desktop-windows-x86_64.msi.zip.sig',
            'windows-build-receipt.json',
          ];
    const artifacts = names.map((name) => {
      const bytes = Buffer.from(name);
      writeFileSync(join(directory, name), bytes);
      return {
        name,
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
    });
    return {
      platform,
      sourceSha: plan.sourceSha,
      cohortId: plan.cohortId,
      planContentDigest: plan.planContentDigest,
      artifacts,
    };
  });
  const release = {
    tag_name: 'nightly-desktop',
    draft: false,
    prerelease: true,
    assets: [] as Array<{
      name: string;
      state: string;
      size: number;
      digest: string;
    }>,
  };
  const writes: string[] = [];
  let corrupt = false;
  const run = (args: string[]) => {
    if (args[0] === 'api') return JSON.stringify(release);
    const path = args.at(-1)!;
    const name = basename(path);
    writes.push(name);
    const bytes = readFileSync(path);
    release.assets.push({
      name,
      state: 'uploaded',
      size: bytes.length,
      digest: corrupt
        ? 'sha256:wrong'
        : `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    });
    return '';
  };
  return {
    root,
    output: join(root, 'publish'),
    plan,
    receipts,
    run,
    writes,
    release,
    corrupt: () => {
      corrupt = true;
    },
  };
}
it('publishes all immutable downloads before the only mutable manifest', () => {
  const f = fixture();
  publishNightlyDesktop(f);
  expect(f.writes).toHaveLength(7);
  expect(f.writes.at(-1)).toBe('latest.json');
  expect(
    f.writes
      .slice(0, -1)
      .every((name) => name.includes(f.plan.versionIdentities.desktop.version)),
  ).toBe(true);
});
it('keeps the existing feed untouched when upload readback differs', () => {
  const f = fixture();
  f.corrupt();
  expect(() => publishNightlyDesktop(f)).toThrow('feed unchanged');
  expect(f.writes).not.toContain('latest.json');
});
it('refuses changed admitted bytes before any upload', () => {
  const f = fixture();
  writeFileSync(
    join(
      f.root,
      'cohort-windows',
      'station-nightly-desktop-windows-x86_64.msi',
    ),
    'changed',
  );
  expect(() => publishNightlyDesktop(f)).toThrow('changed after admission');
  expect(f.writes).toEqual([]);
});
