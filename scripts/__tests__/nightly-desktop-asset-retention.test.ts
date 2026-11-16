import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  NIGHTLY_DESKTOP_MAX_DELETIONS_PER_RUN,
  NIGHTLY_DESKTOP_MAX_RELEASE_ASSETS,
  NIGHTLY_DESKTOP_RETAINED_COHORTS,
  NIGHTLY_DESKTOP_RETENTION_BUDGET_MS,
  planNightlyDesktopRetention,
  retainNightlyDesktopAssets,
} from '../lib/publish-nightly-desktop.mjs';
import {
  ASSET_KEYS,
  asset,
  CURRENT,
  cohort,
  createFakeRelease,
  deleteCalls,
  manifestBody,
  realisticListing,
  VERSIONED_SUFFIXES,
} from './fixtures/nightly-desktop-release.mjs';

/**
 * #3593: the rolling nightly-desktop release is pruned to a window of
 * cohorts. Deletion is permanent and public, so these drive the real
 * retention step against a fake of GitHub's release endpoints and assert on
 * the fake's call log, not on the step's own flags.
 */

type Asset = ReturnType<typeof asset>;
const sha256 = (text: string) =>
  createHash('sha256').update(text).digest('hex');
const versionsOf = (names: string[]) => [
  ...new Set(
    names.map((name) => /^station-(.+?-nightly\.[\d.]+?)-/.exec(name)![1]),
  ),
];
const deletedIds = (calls: string[][]) =>
  deleteCalls(calls).map((args) => Number(args.at(-1)!.split('/').at(-1)));
const OLDEST_FIVE = [
  '0.1.11-nightly.2449.2',
  '0.1.11-nightly.2449.3',
  '0.1.11-nightly.2449.4',
  '0.1.11-nightly.2449.5',
  '0.1.11-nightly.2451',
];

function realistic() {
  const { assets, manifest } = realisticListing();
  return createFakeRelease({ assets, manifest });
}
const retain = (
  fake: ReturnType<typeof createFakeRelease>,
  switchValue?: string,
  extra: Record<string, unknown> = {},
) => {
  const lines: string[] = [];
  const result = retainNightlyDesktopAssets({
    currentVersion: CURRENT,
    switchValue,
    run: fake.run,
    log: (line: string) => lines.push(line),
    ...extra,
  });
  return { result, lines };
};

it('pins the retention window and the per-run bound', () => {
  // Literals beside the constants they are derived from (#3593 brief).
  expect(NIGHTLY_DESKTOP_RETAINED_COHORTS).toBe(30);
  expect(NIGHTLY_DESKTOP_MAX_DELETIONS_PER_RUN).toBe(25);
});

it('plans the oldest whole cohorts on a realistic listing with both version forms', () => {
  const fake = realistic();
  expect(fake.state.assets.length).toBeGreaterThan(590);
  expect(Object.keys(fake.state.assets[0])).toEqual(ASSET_KEYS);
  const { result, lines } = retain(fake);
  const plan = result.plan!;
  expect(result.warning).toBeUndefined();
  expect(plan.assets).toBe(fake.state.assets.length);
  expect(plan.cohorts).toBe(119);
  expect(plan.unsettledCohorts).toBe(2);
  expect(plan.unrecognised).toBe(7);
  // Window plus the two incomplete cohorts.
  expect(plan.keptCohorts).toBe(32);
  expect(plan.newestKept).toBe(CURRENT);
  expect(plan.windowOldest).toBe('0.1.11-nightly.20261101');
  expect(plan.eligibleCohorts).toBe(87);
  expect(plan.eligibleAssets).toBe(435);
  expect(plan.deletions).toHaveLength(25);
  // Ordered by parsed version, not upload time or name: the late re-upload
  // of 2460 and the calendar-form names do not move the oldest five.
  expect(versionsOf(plan.deletions.map((entry) => entry.name))).toEqual(
    OLDEST_FIVE,
  );
  expect(lines.join('\n')).toContain('report only');
  expect(lines.join('\n')).toContain('would delete 25 assets in 5 cohorts');
});

it('performs no delete and no per-asset read in report mode, whatever else the switch says', () => {
  for (const value of [
    undefined,
    '',
    'report',
    'Enabled',
    'enabled ',
    'true',
    '1',
    'ENABLED',
  ]) {
    const fake = realistic();
    const before = fake.state.assets.length;
    const { result } = retain(fake, value);
    expect(result.mode).toBe('report');
    expect(result.plan!.deletions).toHaveLength(25);
    expect(deleteCalls(fake.calls)).toEqual([]);
    expect(fake.state.assets).toHaveLength(before);
  }
});

it('deletes exactly the planned ids when enabled, oldest first, re-reading each, and stops at the bound', () => {
  const fake = realistic();
  const { result } = retain(fake, 'enabled');
  expect(result.mode).toBe('delete');
  expect(result.warning).toBeUndefined();
  const planned = result.plan!.deletions.map((entry) => entry.id);
  expect(deletedIds(fake.calls)).toEqual(planned);
  expect(planned).toHaveLength(25);
  expect(
    versionsOf(result.deleted.map((entry: { name: string }) => entry.name)),
  ).toEqual(OLDEST_FIVE);
  // Each delete follows a read of that same asset id.
  for (const id of planned) {
    const del = fake.calls.findIndex(
      (args) => args.includes('DELETE') && args.at(-1)!.endsWith(`/${id}`),
    );
    expect(fake.calls[del - 1]).toEqual([
      'api',
      `repos/kontourai/station/releases/assets/${id}`,
    ]);
  }
  // The next run works off the next five cohorts of the backlog.
  const next = retain(fake, 'enabled');
  expect(
    versionsOf(next.result.deleted.map((e: { name: string }) => e.name)),
  ).toEqual([
    '0.1.11-nightly.2452',
    '0.1.11-nightly.2452.1',
    '0.1.11-nightly.2453',
    '0.1.11-nightly.2453.1',
    '0.1.11-nightly.2454',
  ]);
});

it('refuses a run asked to delete more than the per-run bound', () => {
  const fake = realistic();
  const { result } = retain(fake, 'enabled', { maxDeletions: 100 });
  expect(result.plan!.deletions.length).toBeGreaterThan(25);
  // `?? ''` keeps a missing warning a plain assertion failure.
  expect(result.warning ?? '').toContain('per-run bound is 25');
  expect(deleteCalls(fake.calls)).toEqual([]);
});

it('never selects the current cohort, the manifest cohort, fixed names, sums, manifest, legacy, unrecognised or incomplete assets', () => {
  const current = '0.1.11-nightly.20261115';
  const referenced = '0.1.11-nightly.2449.3';
  const keptNames = [
    'station-nightly-macos-aarch64.dmg',
    'station-nightly-windows-x86_64-setup.exe',
    'SHA256SUMS',
    'latest.json',
    'station-nightly-desktop-macos-aarch64.dmg',
    'station-nightly-desktop-macos-aarch64.app.tar.gz',
    'station-nightly-desktop-macos-aarch64.app.tar.gz.sig',
    // Close to the versioned shapes, but not one of them.
    'station-0.1.11-nightly.02449-macos-aarch64.dmg',
    'station-0.1.11-nightly.2449.0-macos-aarch64.dmg',
    'station-0.1.11-nightly.2449.100-macos-aarch64.dmg',
    'station-0.1.11-nightly.2449.7-linux-x86_64.AppImage',
    'station-0.1.11-nightly.2449.7-macos-aarch64.dmg.bak',
    'station-0.1.11-beta.2449-macos-aarch64.dmg',
    'notes-station-0.1.11-nightly.2449.7-macos-aarch64.dmg',
  ];
  const assets: Asset[] = [
    ...cohort('0.1.11-nightly.2449.2'),
    ...cohort(referenced),
    ...cohort('0.1.11-nightly.2449.4'),
    ...cohort(current),
    ...keptNames.map((name) => asset(name)),
    asset('station-0.1.11-nightly.2449.5-macos-aarch64.dmg'),
    asset('station-0.1.11-nightly.2449.5-macos-aarch64.app.tar.gz', {
      state: 'starter',
    }),
  ];
  const plan = planNightlyDesktopRetention({
    assets,
    currentVersion: current,
    manifest: JSON.parse(manifestBody(referenced)),
    keepCohorts: 0,
    maxDeletions: 1000,
  });
  const deleted = plan.deletions.map((entry: { name: string }) => entry.name);
  // Positive control: with no window, the two unprotected cohorts go.
  expect(versionsOf(deleted)).toEqual([
    '0.1.11-nightly.2449.2',
    '0.1.11-nightly.2449.4',
  ]);
  expect(deleted).toHaveLength(2 * VERSIONED_SUFFIXES.length);
  for (const name of keptNames) expect(deleted).not.toContain(name);
});

const DOWNLOAD =
  'https://github.com/kontourai/station/releases/download/nightly-desktop/';
const twoCohorts = (current: string, other: string, manifest: object) =>
  planNightlyDesktopRetention({
    assets: [...cohort(current), ...cohort(other)],
    currentVersion: current,
    manifest,
    keepCohorts: 0,
  });

it('protects the cohort latest.json points its downloads at, on its own', () => {
  const current = '0.1.11-nightly.2449.2';
  // The version names this cohort; only the URLs name the other one.
  const manifest = JSON.parse(manifestBody(current, '0.1.11-nightly.2449.3'));
  expect(
    twoCohorts(current, '0.1.11-nightly.2449.3', manifest).deletions,
  ).toEqual([]);
  // Control: without that URL the other cohort is selected.
  expect(
    twoCohorts(
      current,
      '0.1.11-nightly.2449.3',
      JSON.parse(manifestBody(current)),
    ).deletions,
  ).toHaveLength(5);
});

it('protects the cohort latest.json names as its version, on its own', () => {
  const current = '0.1.11-nightly.2449.2';
  // The URLs name this cohort; only the version names the other one.
  const manifest = JSON.parse(manifestBody('0.1.11-nightly.2449.3', current));
  expect(
    twoCohorts(current, '0.1.11-nightly.2449.3', manifest).deletions,
  ).toEqual([]);
});

describe('plans nothing from a latest.json URL that is not exactly one versioned asset', () => {
  const name = 'station-0.1.11-nightly.2449.3-macos-aarch64.app.tar.gz';
  for (const url of [
    `${DOWNLOAD}${name}?raw=1`,
    `${DOWNLOAD}${name}#x`,
    `${DOWNLOAD}${name.replace('2449.3', '2449%2E3')}`,
    `${DOWNLOAD}x/../${name}`,
    `${DOWNLOAD}./${name}`,
    `${DOWNLOAD}whatever.bin`,
    `${DOWNLOAD}latest.json`,
    `${DOWNLOAD}station-nightly-desktop-macos-aarch64.app.tar.gz`,
    'https://objects.githubusercontent.com/x',
    `https://user@github.com/kontourai/station/releases/download/nightly-desktop/${name}`,
  ])
    it(url, () => {
      const manifest = JSON.parse(manifestBody('0.1.11-nightly.2449.2'));
      manifest.platforms['darwin-aarch64'].url = url;
      expect(() =>
        twoCohorts('0.1.11-nightly.2449.2', '0.1.11-nightly.2449.3', manifest),
      ).toThrow(/latest\.json names a download/);
    });
  it('an empty platforms map', () => {
    expect(() =>
      twoCohorts('0.1.11-nightly.2449.2', '0.1.11-nightly.2449.3', {
        version: '0.1.11-nightly.2449.2',
        platforms: {},
      }),
    ).toThrow('latest.json names no platforms');
  });
  it('through the step: warns and deletes nothing', () => {
    const { assets } = realisticListing();
    const manifest = JSON.parse(manifestBody(CURRENT));
    manifest.platforms['windows-x86_64'].url += '?raw=1';
    const body = JSON.stringify(manifest);
    const listed = assets.map((entry: Asset) =>
      entry.name === 'latest.json'
        ? { ...entry, size: body.length, digest: `sha256:${sha256(body)}` }
        : entry,
    );
    const fake = createFakeRelease({ assets: listed, manifest: body });
    const { result } = retain(fake, 'enabled');
    expect(result.plan).toBeUndefined();
    expect(result.warning ?? '').toContain('not exactly one versioned asset');
    expect(deleteCalls(fake.calls)).toEqual([]);
  });
});

describe('re-reads each asset by id before deleting it and stops on any difference', () => {
  const cases: Array<[string, (found: Asset) => string]> = [
    [
      'the same id under another name',
      (found) => JSON.stringify({ ...found, name: `${found.name}.x` }),
    ],
    [
      'the same id and name at another download URL',
      (found) =>
        JSON.stringify({
          ...found,
          browser_download_url: `${found.browser_download_url}x`,
        }),
    ],
    [
      'an asset that is gone (404)',
      () => {
        throw new Error('gh: Not Found (HTTP 404)');
      },
    ],
  ];
  for (const [label, answer] of cases)
    it(label, () => {
      const { assets, manifest } = realisticListing();
      const fake = createFakeRelease(
        { assets, manifest },
        {
          before: (args: string[], state: { assets: Asset[] }) => {
            const one = /\/releases\/assets\/(\d+)$/.exec(args[1] ?? '');
            if (!one || args.length !== 2) return undefined;
            return answer(
              state.assets.find((entry) => entry.id === Number(one[1]))!,
            );
          },
        },
      );
      const { result } = retain(fake, 'enabled');
      expect(result.plan!.deletions).toHaveLength(25);
      expect(result.warning ?? '').not.toBe('');
      expect(deleteCalls(fake.calls)).toEqual([]);
    });
});

it('refuses two assets with one name, even under different ids', () => {
  const { assets, manifest } = realisticListing();
  const twin = { ...assets[1], id: 999_999_999 };
  const fake = createFakeRelease({ assets: [...assets, twin], manifest });
  const { result } = retain(fake, 'enabled');
  expect(result.plan).toBeUndefined();
  expect(result.warning ?? '').toContain('duplicate');
  expect(deleteCalls(fake.calls)).toEqual([]);
});

it('refuses to prune when this cohort is not fully published', () => {
  const { assets, manifest } = realisticListing();
  const missing = `station-${CURRENT}-windows-x86_64-setup.exe.sig`;
  const fake = createFakeRelease({
    assets: assets.filter((entry: Asset) => entry.name !== missing),
    manifest,
  });
  const { result } = retain(fake, 'enabled');
  expect(result.plan).toBeUndefined();
  expect(result.warning ?? '').toContain('is not fully published');
  expect(deleteCalls(fake.calls)).toEqual([]);
});

it('reads a listing of exactly 1,000 assets and refuses 1,001', () => {
  expect(NIGHTLY_DESKTOP_MAX_RELEASE_ASSETS).toBe(1000);
  const listing = (count: number) => {
    const { assets, manifest } = realisticListing();
    const pad = Array.from({ length: count - assets.length }, (_, index) =>
      asset(`padding-${index}.txt`),
    );
    return createFakeRelease({ assets: [...assets, ...pad], manifest });
  };
  const full = listing(1000);
  expect(full.state.assets).toHaveLength(1000);
  const accepted = retain(full);
  expect(accepted.result.warning).toBeUndefined();
  expect(accepted.result.plan!.assets).toBe(1000);
  const over = listing(1001);
  const refused = retain(over, 'enabled');
  expect(refused.result.plan).toBeUndefined();
  expect(refused.result.warning ?? '').toContain('within 1,000 assets');
  expect(deleteCalls(over.calls)).toEqual([]);
});

it('stops starting requests once its time budget is spent', () => {
  expect(NIGHTLY_DESKTOP_RETENTION_BUDGET_MS).toBe(180_000);
  const fake = realistic();
  let clock = 0;
  const { result } = retain(fake, 'enabled', {
    // Each request appears to take ten seconds.
    now: () => clock,
    run: (args: string[]) => {
      clock += 10_000;
      return fake.run(args);
    },
  });
  // Requests start at 0 s through 180 s: 19 of them, the release, seven
  // pages and latest.json, then five re-read/delete pairs; the 20th is refused.
  expect(result.warning ?? '').toContain('time budget is spent');
  expect(deleteCalls(fake.calls)).toHaveLength(5);
  expect(fake.calls).toHaveLength(19);
});

it('warns and keeps the publication when a delete fails, and the next run finishes the cohort', () => {
  const { assets, manifest } = realisticListing();
  let deletes = 0;
  const fake = createFakeRelease(
    { assets, manifest },
    {
      before: (args: string[]) => {
        if (args.includes('DELETE') && ++deletes === 3)
          throw new Error('gh: HTTP 502');
        return undefined;
      },
    },
  );
  const published = JSON.parse(
    fake.run(['api', 'repos/kontourai/station/releases/tags/nightly-desktop']),
  );
  const { result, lines } = retain(fake, 'enabled');
  expect(result.deleted).toHaveLength(2);
  expect(result.warning).toContain('HTTP 502');
  expect(lines.at(-1)).toMatch(/^::warning title=Nightly desktop retention::/);
  // Everything the publication wrote is still there.
  const after = new Set(fake.state.assets.map((entry: Asset) => entry.name));
  for (const entry of published.assets as Asset[])
    if (!/nightly\.2449\.2-/.test(entry.name))
      expect(after).toContain(entry.name);
  for (const suffix of VERSIONED_SUFFIXES)
    expect(after).toContain(`station-${CURRENT}-${suffix}`);
  expect(after).toContain('latest.json');
  // The partly deleted cohort is first in the next plan.
  const next = retain(fake, 'enabled');
  expect(
    next.result.deleted.slice(0, 3).map((e: { name: string }) => e.name),
  ).toEqual(
    result.plan!.deletions.slice(2, 5).map((e: { name: string }) => e.name),
  );
});

describe('refuses to plan from an incomplete or unstable listing', () => {
  const cases: Array<
    [string, Parameters<typeof createFakeRelease>[1], string]
  > = [
    [
      'a truncated last page',
      {
        before: (args: string[]) =>
          args.some((arg) => arg.endsWith('page=6')) ? '[]' : undefined,
      },
      'changed or is truncated',
    ],
    [
      'a duplicate entry across pages',
      {
        before: (args: string[], state: { assets: Asset[] }) =>
          args.some((arg) => arg.endsWith('page=2'))
            ? JSON.stringify([state.assets[0], ...state.assets.slice(101, 200)])
            : undefined,
      },
      'duplicate',
    ],
    [
      'an asset uploaded between the two reads',
      {
        before: (args: string[], state: { assets: Asset[] }) => {
          if (args.some((arg) => arg.endsWith('page=1')))
            state.assets.push(
              asset('station-0.1.11-nightly.20261116-macos-aarch64.dmg'),
            );
          return undefined;
        },
      },
      'changed or is truncated',
    ],
    [
      'a latest.json that changes while it is read',
      {
        before: (args: string[]) =>
          args.includes('Accept: application/octet-stream')
            ? manifestBody('0.1.11-nightly.20261115')
            : undefined,
      },
      'changed while it was read',
    ],
  ];
  for (const [label, hooks, message] of cases)
    it(label, () => {
      const { assets, manifest } = realisticListing();
      const fake = createFakeRelease({ assets, manifest }, hooks);
      const { result } = retain(fake, 'enabled');
      expect(result.plan).toBeUndefined();
      expect(result.warning).toContain(message);
      expect(deleteCalls(fake.calls)).toEqual([]);
    });
});

it('prunes nothing before latest.json names this cohort', () => {
  // The previous cohort's manifest is still live: retention ran too early.
  const { assets } = realisticListing({
    manifestVersion: '0.1.11-nightly.20261115',
  });
  const manifest = manifestBody('0.1.11-nightly.20261115');
  const fake = createFakeRelease({ assets, manifest });
  const { result } = retain(fake, 'enabled');
  expect(result.plan).toBeUndefined();
  expect(result.warning).toContain(
    'nothing is pruned before this cohort is published',
  );
  expect(deleteCalls(fake.calls)).toEqual([]);
});
