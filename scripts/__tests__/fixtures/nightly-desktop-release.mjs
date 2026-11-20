// A fake of the GitHub endpoints the nightly-desktop publisher and its
// retention step call, over a listing in the exact shape GitHub returns.
// Importable in-process (`createFakeRelease`) and runnable as a `gh` stand-in
// whose state lives in the JSON file named by FAKE_GH_STATE.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const REPO = 'kontourai/station';
const RELEASE_ID = 378881001;
const DOWNLOAD = `https://github.com/${REPO}/releases/download/nightly-desktop/`;
const sha = (text) => createHash('sha256').update(text).digest('hex');

// One asset as `GET repos/kontourai/station/releases/{id}/assets` returned it
// for the real nightly-desktop release (read for #3593); every generated
// entry has exactly these keys, and `starter` entries carry `digest: null`.
const UPLOADER = Object.freeze({
  login: 'github-actions[bot]',
  id: 41898282,
  node_id: 'MDM6Qm90NDE4OTgyODI=',
  avatar_url: 'https://avatars.githubusercontent.com/in/15368?v=4',
  gravatar_id: '',
  url: 'https://api.github.com/users/github-actions%5Bbot%5D',
  html_url: 'https://github.com/apps/github-actions',
  followers_url:
    'https://api.github.com/users/github-actions%5Bbot%5D/followers',
  following_url:
    'https://api.github.com/users/github-actions%5Bbot%5D/following{/other_user}',
  gists_url:
    'https://api.github.com/users/github-actions%5Bbot%5D/gists{/gist_id}',
  starred_url:
    'https://api.github.com/users/github-actions%5Bbot%5D/starred{/owner}{/repo}',
  subscriptions_url:
    'https://api.github.com/users/github-actions%5Bbot%5D/subscriptions',
  organizations_url:
    'https://api.github.com/users/github-actions%5Bbot%5D/orgs',
  repos_url: 'https://api.github.com/users/github-actions%5Bbot%5D/repos',
  events_url:
    'https://api.github.com/users/github-actions%5Bbot%5D/events{/privacy}',
  received_events_url:
    'https://api.github.com/users/github-actions%5Bbot%5D/received_events',
  type: 'Bot',
  user_view_type: 'public',
  site_admin: false,
});
export const ASSET_KEYS = Object.freeze([
  'url',
  'id',
  'node_id',
  'name',
  'label',
  'uploader',
  'content_type',
  'state',
  'size',
  'digest',
  'download_count',
  'created_at',
  'updated_at',
  'browser_download_url',
]);
export const VERSIONED_SUFFIXES = Object.freeze([
  'macos-aarch64.app.tar.gz',
  'macos-aarch64.app.tar.gz.sig',
  'macos-aarch64.dmg',
  'windows-x86_64-setup.exe',
  'windows-x86_64-setup.exe.sig',
]);

let nextId = 559450063;
export function asset(name, { state = 'uploaded', body = name, at } = {}) {
  const id = nextId++;
  const time = at ?? new Date(Date.UTC(2026, 8, 12) + id).toISOString();
  return {
    url: `https://api.github.com/repos/${REPO}/releases/assets/${id}`,
    id,
    node_id: `RA_${id}`,
    name,
    label: '',
    uploader: UPLOADER,
    content_type: 'application/octet-stream',
    state,
    size: Buffer.byteLength(body),
    digest: state === 'uploaded' ? `sha256:${sha(body)}` : null,
    download_count: 0,
    created_at: time,
    updated_at: time,
    browser_download_url: `${DOWNLOAD}${name}`,
  };
}

export const cohort = (version, options) =>
  VERSIONED_SUFFIXES.map((suffix) =>
    asset(`station-${version}-${suffix}`, options),
  );

export function manifestBody(version, referenced = version) {
  return JSON.stringify({
    version,
    notes: 'notes',
    pub_date: '2026-11-16T00:00:00Z',
    platforms: {
      'darwin-aarch64': {
        signature: 'sig',
        url: `${DOWNLOAD}station-${referenced}-macos-aarch64.app.tar.gz`,
      },
      'windows-x86_64': {
        signature: 'sig',
        url: `${DOWNLOAD}station-${referenced}-windows-x86_64-setup.exe`,
      },
    },
  });
}

/** The old epoch-day versions, oldest first, then the calendar versions. */
export const OLD_FORM = Object.freeze([
  ...[2, 3, 4, 5].map((build) => `0.1.11-nightly.2449.${build}`),
  '0.1.11-nightly.2451',
  ...Array.from({ length: 36 }, (_, day) => [
    `0.1.11-nightly.${2452 + day}`,
    `0.1.11-nightly.${2452 + day}.1`,
  ]).flat(),
]);
export const NEW_FORM = Object.freeze(
  Array.from({ length: 20 }, (_, day) => {
    const date = new Date(Date.UTC(2026, 9, 27 + day))
      .toISOString()
      .slice(0, 10)
      .replaceAll('-', '');
    return [`0.1.11-nightly.${date}`, `0.1.11-nightly.${date}.1`];
  }).flat(),
);
export const CURRENT = NEW_FORM.at(-1);

/**
 * About 600 assets: 117 complete cohorts in both version forms, one cohort
 * left with an incomplete (`starter`) upload, one starter-only cohort, the
 * three legacy assets, the fixed names, SHA256SUMS and latest.json. One old
 * cohort was re-uploaded last, and the listing is in no version order.
 */
export function realisticListing({ manifestVersion = CURRENT } = {}) {
  const late = '0.1.11-nightly.2460';
  const listing = [
    ...[
      'station-nightly-desktop-macos-aarch64.dmg',
      'station-nightly-desktop-macos-aarch64.app.tar.gz',
      'station-nightly-desktop-macos-aarch64.app.tar.gz.sig',
    ].map((name) => asset(name)),
    ...[...OLD_FORM, ...NEW_FORM]
      .filter((version) => version !== late)
      .flatMap((version) => cohort(version)),
    asset('station-0.1.11-nightly.2451.1-macos-aarch64.app.tar.gz'),
    asset('station-0.1.11-nightly.2451.1-macos-aarch64.app.tar.gz.sig'),
    asset('station-0.1.11-nightly.2451.1-macos-aarch64.dmg', {
      state: 'starter',
    }),
    asset('station-0.1.11-nightly.2451.2-macos-aarch64.app.tar.gz', {
      state: 'starter',
    }),
    ...cohort(late, { at: '2026-11-16T04:00:00Z' }),
    asset('station-nightly-macos-aarch64.dmg'),
    asset('station-nightly-windows-x86_64-setup.exe'),
    asset('SHA256SUMS'),
  ];
  const manifest = manifestBody(manifestVersion);
  listing.push(asset('latest.json', { body: manifest }));
  // GitHub's listing order is neither upload nor version order.
  const shuffled = listing
    .map((entry, index) => ({ entry, key: (index * 7919) % 1009 }))
    .sort((a, b) => a.key - b.key)
    .map(({ entry }) => entry);
  return { assets: shuffled, manifest };
}

/**
 * `run(args)` answers like `gh` for the calls the publisher makes, and
 * records each call. The release object omits non-uploaded assets, as
 * GitHub's does; the paged listing includes them.
 */
export function createFakeRelease(state, hooks = {}) {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    if (hooks.before) {
      const answer = hooks.before(args, state);
      if (answer !== undefined) return answer;
    }
    if (args[0] !== 'api') throw new Error(`unexpected gh ${args.join(' ')}`);
    const method = args.includes('--method')
      ? args[args.indexOf('--method') + 1]
      : 'GET';
    const endpoint = args.find(
      (arg, index) => index > 0 && arg.startsWith('repos/'),
    );
    if (endpoint === `repos/${REPO}/releases/tags/nightly-desktop`)
      return JSON.stringify({
        id: RELEASE_ID,
        tag_name: 'nightly-desktop',
        draft: false,
        prerelease: true,
        assets: state.assets.filter((entry) => entry.state === 'uploaded'),
      });
    const page = new RegExp(
      `^repos/${REPO}/releases/${RELEASE_ID}/assets\\?per_page=100&page=(\\d+)$`,
    ).exec(endpoint ?? '');
    if (page) {
      const start = (Number(page[1]) - 1) * 100;
      return JSON.stringify(state.assets.slice(start, start + 100));
    }
    const one = new RegExp(`^repos/${REPO}/releases/assets/(\\d+)$`).exec(
      endpoint ?? '',
    );
    if (one) {
      const id = Number(one[1]);
      const found = state.assets.find((entry) => entry.id === id);
      if (!found) throw new Error(`gh: Not Found (HTTP 404) ${id}`);
      if (method === 'DELETE') {
        state.assets = state.assets.filter((entry) => entry.id !== id);
        return '';
      }
      if (args.includes('Accept: application/octet-stream'))
        return found.name === 'latest.json' ? state.manifest : found.name;
      return JSON.stringify(found);
    }
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  return { run, calls, state };
}

/** @param {string[][]} calls */
export const deleteCalls = (calls) =>
  calls.filter((args) => args.includes('--method') && args.includes('DELETE'));

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const file = process.env.FAKE_GH_STATE;
  const state = JSON.parse(readFileSync(file, 'utf8'));
  const fake = createFakeRelease(state);
  try {
    process.stdout.write(fake.run(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
  state.log = [...(state.log ?? []), process.argv.slice(2)];
  writeFileSync(file, JSON.stringify(state));
}
