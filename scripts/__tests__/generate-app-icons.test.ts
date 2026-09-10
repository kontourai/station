import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  IOS_ICON_SET_CHANNELS,
  iosIconSetDir,
  ROUNDED_MASTER,
  readDesktopIcns,
  writeIosIconSet,
} from '../generate-app-icons.mjs';
import {
  catalogFilenames,
  IOS_APP_ICON_CATALOG,
} from '../ios-channel-icons.mjs';
import { canonicalizeIcns, parseIcnsMembers } from '../lib/icns.mjs';

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

/**
 * Assemble members into an `.icns` in the given order -- the inverse of
 * `parseIcnsMembers`, written here independently so a permutation fixture
 * does not come from the code under test.
 */
function writeIcns(members: { type: string; body: Buffer }[]) {
  const total =
    8 + members.reduce((sum, member) => sum + 8 + member.body.length, 0);
  const out = Buffer.alloc(total);
  out.write('icns', 0, 'ascii');
  out.writeUInt32BE(total, 4);
  let offset = 8;
  for (const { type, body } of members) {
    out.write(type, offset, 4, 'ascii');
    out.writeUInt32BE(8 + body.length, offset + 4);
    body.copy(out, offset + 8);
    offset += 8 + body.length;
  }
  return out;
}

/**
 * Every `.icns` Git tracks. The set the generator must leave byte-identical
 * is derived from the repository rather than declared here, so adding a
 * channel does not quietly leave its icon out of the pin.
 */
const trackedIcns = execFileSync('git', ['ls-files', '*.icns'], {
  cwd: root,
  encoding: 'utf8',
  windowsHide: true,
})
  .split('\n')
  .filter(Boolean)
  .sort();

const memberDigest = (icns: Buffer) =>
  parseIcnsMembers(icns)
    .map(
      ({ type, body }) =>
        `${type}:${createHash('sha256').update(body).digest('hex')}`,
    )
    .sort();

describe('desktop .icns determinism (#1797)', () => {
  it('emits the committed icon.icns byte-identically on two real tauri runs', () => {
    const first = readDesktopIcns(
      ROUNDED_MASTER,
      mkdtempSync(join(tmpdir(), 'station-icns-a-')),
    );
    const second = readDesktopIcns(
      ROUNDED_MASTER,
      mkdtempSync(join(tmpdir(), 'station-icns-b-')),
    );
    // Before the canonicalization two runs differed on 2,066,287 of the
    // file's 2,074,696 bytes -- same members, same bodies, random sequence.
    expect(
      first.equals(second),
      'two runs of tauri icon on one master disagree',
    ).toBe(true);
    // ...and the committed file is that output, so regenerating is a no-op
    // until the artwork changes.
    expect(
      first.equals(readFileSync(resolve(root, 'src-desktop/icons/icon.icns'))),
      'committed src-desktop/icons/icon.icns is not the rounded master fan-out',
    ).toBe(true);
  }, 120_000);

  it('covers every tracked .icns, not a list someone remembered to extend', () => {
    // Discovery, so a channel added later is pinned without editing this
    // file -- and an empty or failed `git ls-files` must not read as "all
    // four are canonical".
    expect(trackedIcns).toContain('src-desktop/icons/icon.icns');
    expect(trackedIcns.length).toBeGreaterThanOrEqual(4);
  });

  // The dev/beta/nightly masters are rendered in-memory from the artwork and
  // never committed, so the pin for their icns is that they already hold the
  // canonical order the generator now writes: a regeneration that produces
  // the same members produces the same bytes.
  it.each(trackedIcns)('holds %s in canonical member order', (path) => {
    const committed = readFileSync(resolve(root, path));
    expect(
      canonicalizeIcns(committed).equals(committed),
      `${path} would be rewritten by a regeneration`,
    ).toBe(true);
  });

  it('maps every member order of a real .icns onto the same bytes', () => {
    const committed = readFileSync(
      resolve(root, 'src-desktop/icons/nightly/icon.icns'),
    );
    const members = parseIcnsMembers(committed);
    expect(members.length).toBeGreaterThan(1);
    // Rotations plus a reversal: each is an order tauri's HashMap walk could
    // have produced, and none is the committed one except rotation 0.
    for (const order of [
      ...members.map((_, index) => [
        ...members.slice(index),
        ...members.slice(0, index),
      ]),
      [...members].reverse(),
    ]) {
      const permuted = writeIcns(order);
      expect(canonicalizeIcns(permuted).equals(committed)).toBe(true);
    }
  });

  it('carries every member body through unchanged', () => {
    const committed = readFileSync(
      resolve(root, 'src-desktop/icons/beta/icon.icns'),
    );
    const shuffled = writeIcns([...parseIcnsMembers(committed)].reverse());
    expect(memberDigest(canonicalizeIcns(shuffled))).toEqual(
      memberDigest(committed),
    );
  });

  it('refuses an .icns whose bytes it cannot account for', () => {
    const committed = readFileSync(
      resolve(root, 'src-desktop/icons/icon.icns'),
    );
    const members = parseIcnsMembers(committed);

    const badMagic = Buffer.from(committed);
    badMagic.write('icnt', 0, 'ascii');
    expect(() => canonicalizeIcns(badMagic)).toThrow(/expected magic/);

    const badLength = Buffer.from(committed);
    badLength.writeUInt32BE(committed.length - 1, 4);
    expect(() => canonicalizeIcns(badLength)).toThrow(/header declares/);

    const overrun = Buffer.from(committed);
    overrun.writeUInt32BE(committed.length, 12);
    expect(() => canonicalizeIcns(overrun)).toThrow(/past the end of the file/);

    const undersized = Buffer.from(committed);
    undersized.writeUInt32BE(4, 12);
    expect(() => canonicalizeIcns(undersized)).toThrow(
      /less than its own header/,
    );

    // A TOC records the members in file order; reordering them without
    // rewriting it would leave an index that lies about the file.
    const withToc = writeIcns([
      { type: 'TOC ', body: Buffer.alloc(8 * members.length) },
      ...members,
    ]);
    expect(() => canonicalizeIcns(withToc)).toThrow(/"TOC "/);

    expect(() => canonicalizeIcns(Buffer.from('icns'))).toThrow(
      /shorter than its 8-byte header/,
    );
  });
});
