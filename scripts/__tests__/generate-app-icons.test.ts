import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  IOS_ICON_SET_CHANNELS,
  iosIconSetDir,
  writeIosIconSet,
} from '../generate-app-icons.mjs';
import {
  catalogFilenames,
  IOS_APP_ICON_CATALOG,
} from '../ios-channel-icons.mjs';

const root = resolve(import.meta.dirname, '../..');
const squareMaster = resolve(root, 'assets/brand/icon-square-1024.png');
const pngs = (dir: string) =>
  readdirSync(dir)
    .filter((name) => name.endsWith('.png'))
    .sort();

describe('iOS channel icon set generation', () => {
  it('fans the square master out byte-stably to exactly the catalog filenames', () => {
    const first = mkdtempSync(join(tmpdir(), 'station-ios-fanout-a-'));
    const second = mkdtempSync(join(tmpdir(), 'station-ios-fanout-b-'));
    const filesA = writeIosIconSet(squareMaster, first);
    const filesB = writeIosIconSet(squareMaster, second);
    expect(filesA).toEqual(filesB);
    expect(filesA).toEqual(
      catalogFilenames(resolve(root, IOS_APP_ICON_CATALOG)),
    );
    for (const name of filesA) {
      expect(
        readFileSync(join(first, name)).equals(
          readFileSync(join(second, name)),
        ),
        `${name} differs between two runs of tauri icon`,
      ).toBe(true);
    }
    // The committed stable set is that fan-out, so a regeneration is a no-op
    // until the master changes.
    const stable = iosIconSetDir('stable');
    expect(pngs(stable)).toEqual(filesA);
    for (const name of filesA) {
      expect(
        readFileSync(join(stable, name)).equals(
          readFileSync(join(first, name)),
        ),
        `committed stable ${name} is not the square master's fan-out`,
      ).toBe(true);
    }
  }, 60_000);

  it('emits a set for every channel that ships on iOS and none for dev', () => {
    expect([...IOS_ICON_SET_CHANNELS]).toEqual(['stable', 'beta', 'nightly']);
    expect(iosIconSetDir('nightly')).toBe(
      resolve(root, 'src-desktop/icons/nightly/ios'),
    );
    for (const channel of IOS_ICON_SET_CHANNELS)
      expect(pngs(iosIconSetDir(channel)).length).toBeGreaterThan(0);
    expect(() =>
      readdirSync(resolve(root, 'src-desktop/icons/dev/ios')),
    ).toThrow();
  });
});
