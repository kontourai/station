import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSyncBounded } from './bounded-capture.mjs';
import { desktopPublishedAssetName } from './windows-nightly.mjs';

const repository = 'kontourai/station';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
// The macOS dmg is ~510 MiB and has twice exceeded the 10-minute API-call
// budget on the publish runner's uplink (spawnSync gh ETIMEDOUT, SIGTERM).
// Uploads get their own fence and bounded retries; read-only API calls keep
// the tighter one.
const API_TIMEOUT_MS = 600_000;
const UPLOAD_TIMEOUT_MS = 1_800_000;
const UPLOAD_ATTEMPTS = 3;
function github(args, timeoutMs = API_TIMEOUT_MS) {
  return execFileSyncBounded('gh', args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: timeoutMs,
  });
}

/**
 * `MAJOR.MINOR.PATCH-nightly.<day>[.<build>]` as a numeric tuple. Both day
 * forms on the release order correctly as numbers: the older epoch-day
 * counter (`nightly.2449.2`) is far below the current calendar date
 * (`nightly.20261116`), matching SemVer prerelease precedence; a missing
 * build is 0, below every same-day rebuild (1..99).
 */
function nightlyDesktopVersionParts(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)-nightly\.(\d+)(?:\.([1-9]\d*))?$/.exec(
    typeof version === 'string' ? version : '',
  );
  if (!match) throw new Error('Invalid Nightly updater version');
  const values = match.slice(1).map((value) => Number(value ?? 0));
  if (!values.every(Number.isSafeInteger) || values[4] > 99)
    throw new Error('Invalid Nightly updater version');
  return values;
}

/** Negative, zero or positive as `left` is older than, equal to or newer than `right`. */
function compareNightlyDesktopVersions(left, right) {
  const a = nightlyDesktopVersionParts(left);
  const b = nightlyDesktopVersionParts(right);
  const difference = a.findIndex((value, index) => value !== b[index]);
  return difference === -1 ? 0 : a[difference] - b[difference];
}

/**
 * The fixed download name of each installer: the staged name without its
 * `-desktop`, so `releases/download/nightly-desktop/<name>` normally serves
 * the newest published build (each replacement is a delete then an upload,
 * so it can briefly be missing). Not the staged name itself: older builds
 * published assets under those names, and they remain on the release.
 */
export const NIGHTLY_DESKTOP_ALIASES = Object.freeze({
  'station-nightly-desktop-macos-aarch64.dmg':
    'station-nightly-macos-aarch64.dmg',
  'station-nightly-desktop-windows-x86_64-setup.exe':
    'station-nightly-windows-x86_64-setup.exe',
});
/** `sha256sum -c` lines for this build's downloads, under both names. */
export const NIGHTLY_DESKTOP_CHECKSUMS = 'SHA256SUMS';

/**
 * The only feed writer: immutable downloads are verified before the fixed
 * names, SHA256SUMS and latest.json (the replaced assets, latest.json last)
 * change.
 */
export function publishNightlyDesktop({
  root,
  output,
  plan,
  receipts,
  run = github,
}) {
  if (
    plan.versionIdentities.desktop.releaseTag !== 'nightly-desktop' ||
    !/^[a-f0-9]{40}$/.test(plan.sourceSha) ||
    receipts.length !== 2 ||
    receipts
      .map((r) => r.platform)
      .sort()
      .join(',') !== 'macos,windows'
  ) {
    throw new Error('Expected one exact-source desktop cohort');
  }
  mkdirSync(output, { recursive: false });
  const assets = [];
  let manifest;
  for (const receipt of receipts) {
    if (
      receipt.sourceSha !== plan.sourceSha ||
      receipt.cohortId !== plan.cohortId ||
      receipt.planContentDigest !== plan.planContentDigest
    ) {
      throw new Error('Desktop receipt differs from admitted plan');
    }
    for (const record of receipt.artifacts) {
      const path = join(root, `cohort-${receipt.platform}`, record.name);
      const bytes = readFileSync(path);
      if (bytes.length !== record.size || hash(bytes) !== record.sha256)
        throw new Error('Desktop bytes changed after admission');
      if (record.name === 'windows-build-receipt.json') continue;
      const name = desktopPublishedAssetName(
        record.name,
        plan.versionIdentities.desktop.version,
      );
      const destination = join(output, name);
      copyFileSync(path, destination);
      const asset = {
        ...record,
        name,
        path: destination,
        stagedName: record.name,
      };
      if (record.name === 'latest.json') manifest = asset;
      else assets.push(asset);
    }
  }
  if (!manifest || assets.length !== 5)
    throw new Error('Incomplete desktop publication inventory');
  const query = () =>
    JSON.parse(
      run(['api', `repos/${repository}/releases/tags/nightly-desktop`]),
    );
  const checkRelease = (release) => {
    if (
      release.tag_name !== 'nightly-desktop' ||
      release.draft !== false ||
      release.prerelease !== true ||
      !Array.isArray(release.assets)
    ) {
      throw new Error('Unexpected desktop release state');
    }
    return release;
  };
  const matches = (release, asset) => {
    const found = release.assets.filter((entry) => entry.name === asset.name);
    return (
      found.length === 1 &&
      found[0].state === 'uploaded' &&
      found[0].size === asset.size &&
      found[0].digest === `sha256:${asset.sha256}`
    );
  };
  const before = checkRelease(query());
  const previous = before.assets.filter(
    (asset) => asset.name === 'latest.json',
  );
  if (
    previous.length > 1 ||
    (previous.length === 0 && before.assets.length > 0)
  ) {
    throw new Error('Existing desktop feed is missing or duplicated');
  }
  if (previous.length === 1) {
    const asset = previous[0];
    if (!Number.isSafeInteger(asset.id) || asset.id < 1)
      throw new Error('Invalid current manifest asset ID');
    const currentBytes = run([
      'api',
      `repos/${repository}/releases/assets/${asset.id}`,
      '-H',
      'Accept: application/octet-stream',
    ]);
    if (`sha256:${hash(Buffer.from(currentBytes))}` !== asset.digest)
      throw new Error('Current manifest changed during publication preflight');
    if (
      compareNightlyDesktopVersions(
        plan.versionIdentities.desktop.version,
        JSON.parse(currentBytes).version,
      ) < 0
    )
      throw new Error(
        'Desktop publication would regress the current Nightly version',
      );
  }
  const readRelease = () =>
    checkRelease(
      JSON.parse(
        run(['api', `repos/${repository}/releases/tags/nightly-desktop`]),
      ),
    );
  for (const asset of assets) {
    // A client-side timeout does not prove the bytes never landed: the next
    // attempt re-reads the release first, so an asset that completed
    // server-side is adopted via matches() instead of re-uploaded, and a
    // conflicting asset with the same name still fails closed.
    for (let attempt = 1; ; attempt++) {
      const state = attempt === 1 ? before : readRelease();
      if (state.assets.some((entry) => entry.name === asset.name)) {
        if (!matches(state, asset))
          throw new Error(
            'An immutable desktop asset already exists with different bytes',
          );
        break;
      }
      try {
        run(
          [
            'release',
            'upload',
            'nightly-desktop',
            '--repo',
            repository,
            asset.path,
          ],
          UPLOAD_TIMEOUT_MS,
        );
      } catch (error) {
        if (attempt >= UPLOAD_ATTEMPTS) throw error;
        continue;
      }
      break;
    }
  }
  const uploaded = checkRelease(query());
  if (!assets.every((asset) => matches(uploaded, asset)))
    throw new Error(
      'Desktop uploads are not available with the staged digests; feed unchanged',
    );
  // Replaced, not immutable: GitHub has no asset alias, so each fixed name is
  // a second upload of the verified installer bytes. Each replacement is a
  // delete then an upload, so a download in between can briefly miss, or
  // pair a fixed name with the other build's SHA256SUMS line, which fails the
  // check rather than passing the wrong bytes.
  const aliases = assets
    .filter((asset) => Object.hasOwn(NIGHTLY_DESKTOP_ALIASES, asset.stagedName))
    .map((asset) => {
      const name = NIGHTLY_DESKTOP_ALIASES[asset.stagedName];
      const path = join(output, name);
      copyFileSync(asset.path, path);
      return { ...asset, name, path };
    });
  if (aliases.length !== Object.keys(NIGHTLY_DESKTOP_ALIASES).length)
    throw new Error('Incomplete desktop installer aliases');
  const sums = Buffer.from(
    [...assets, ...aliases]
      .map(({ name, sha256 }) => `${sha256}  ${name}\n`)
      .sort()
      .join(''),
  );
  const checksums = {
    name: NIGHTLY_DESKTOP_CHECKSUMS,
    path: join(output, NIGHTLY_DESKTOP_CHECKSUMS),
    size: sums.length,
    sha256: hash(sums),
  };
  writeFileSync(checksums.path, sums);
  for (const asset of [...aliases, checksums]) {
    for (let attempt = 1; ; attempt++) {
      try {
        run(
          [
            'release',
            'upload',
            'nightly-desktop',
            '--repo',
            repository,
            '--clobber',
            asset.path,
          ],
          UPLOAD_TIMEOUT_MS,
        );
      } catch (error) {
        if (attempt >= UPLOAD_ATTEMPTS) throw error;
        continue;
      }
      break;
    }
  }
  run([
    'release',
    'upload',
    'nightly-desktop',
    '--repo',
    repository,
    '--clobber',
    manifest.path,
  ]);
  const published = checkRelease(query());
  if (
    ![...assets, ...aliases, checksums, manifest].every((asset) =>
      matches(published, asset),
    )
  )
    throw new Error('Desktop publication readback differs from staged bytes');
  return published;
}

/**
 * Retention (#3593). Every cohort adds five versioned downloads to the one
 * rolling release, and GitHub refuses uploads past 1,000 assets. Only these
 * five exact shapes, with a canonical Nightly version, are ever candidates;
 * the fixed names, SHA256SUMS, latest.json, the legacy
 * `station-nightly-desktop-*` assets and anything else are kept untouched.
 * A cohort with any asset that is not `uploaded` is kept whole, indefinitely:
 * it may be an upload still in progress, which only its publisher may
 * resolve. Two such `starter` uploads from 2026-09-17 (`2451.1`, `2451.2`)
 * therefore stay on the release.
 */
export const NIGHTLY_DESKTOP_RETAINED_COHORTS = 30;
/** Five cohorts; a larger backlog is worked off oldest first over later runs. */
export const NIGHTLY_DESKTOP_MAX_DELETIONS_PER_RUN = 25;
/**
 * Read as `vars.<name>` in the native-release job, so an environment-level
 * variable wins over the repository's. Only the exact value `enabled` deletes.
 */
export const NIGHTLY_DESKTOP_PRUNE_VARIABLE = 'STATION_NIGHTLY_DESKTOP_PRUNE';
/** GitHub's per-release cap; a longer listing is refused, not truncated. */
export const NIGHTLY_DESKTOP_MAX_RELEASE_ASSETS = 1000;
const ASSET_PAGE_SIZE = 100;
// Ten full pages hold the cap. The eleventh page is read only to refuse a
// listing that does not end there.
const MAX_ASSET_PAGES =
  NIGHTLY_DESKTOP_MAX_RELEASE_ASSETS / ASSET_PAGE_SIZE + 1;
// The step's own timeout is 5 minutes of the job's 60. Each request is
// bounded, and no request starts after the budget, so a hung GitHub call
// ends the step as a warning well before the step or job timeout.
const RETENTION_REQUEST_TIMEOUT_MS = 15_000;
export const NIGHTLY_DESKTOP_RETENTION_BUDGET_MS = 180_000;
const VERSIONED_DOWNLOADS = Object.freeze([
  'station-nightly-desktop-macos-aarch64.app.tar.gz',
  'station-nightly-desktop-macos-aarch64.app.tar.gz.sig',
  'station-nightly-desktop-macos-aarch64.dmg',
  'station-nightly-desktop-windows-x86_64-setup.exe',
  'station-nightly-desktop-windows-x86_64-setup.exe.sig',
]);
const DOWNLOAD_PREFIX = `https://github.com/${repository}/releases/download/nightly-desktop/`;

/** `delete` only for the exact owner value; anything else reports. */
function nightlyDesktopPruneMode(value) {
  return value === 'enabled' ? 'delete' : 'report';
}

/**
 * The cohort a latest.json platform URL names. The URL must be exactly this
 * release's download prefix and one versioned asset name: no query,
 * fragment, encoding, dot or extra segment. Anything else throws, so the
 * step plans nothing rather than dropping that protection.
 */
function manifestCohortOf(raw) {
  if (typeof raw !== 'string' || !raw.startsWith(DOWNLOAD_PREFIX))
    throw new Error('latest.json names a download outside nightly-desktop');
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('latest.json names a download that is not a URL');
  }
  const name = raw.slice(DOWNLOAD_PREFIX.length);
  const version = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(name)
    ? versionedCohortOf(name)
    : undefined;
  if (
    url.href !== raw ||
    url.search !== '' ||
    url.hash !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    version === undefined
  )
    throw new Error(
      'latest.json names a download that is not exactly one versioned asset of this release',
    );
  return version;
}

/** The cohort version of an exact versioned download name, else undefined. */
function versionedCohortOf(name) {
  const match = /^station-(\d+\.\d+\.\d+-nightly\.\d+(?:\.\d+)?)-/.exec(name);
  if (!match) return undefined;
  const version = match[1];
  let parts;
  try {
    parts = nightlyDesktopVersionParts(version);
  } catch {
    return undefined;
  }
  // `nightly.02449` would order like `nightly.2449`; only the form the
  // version writer produces is recognised.
  const canonical = `${parts.slice(0, 3).join('.')}-nightly.${parts[3]}${parts[4] ? `.${parts[4]}` : ''}`;
  if (canonical !== version) return undefined;
  return VERSIONED_DOWNLOADS.some(
    (staged) => desktopPublishedAssetName(staged, version) === name,
  )
    ? version
    : undefined;
}

/**
 * Which versioned downloads this run would delete. Pure: `assets` is the
 * complete listing, `manifest` the parsed live latest.json. The newest
 * `keepCohorts` cohorts, the cohort just published, every cohort latest.json
 * names, and any cohort with an asset that is not `uploaded` (possibly an
 * upload in progress, so kept indefinitely) are kept. The
 * remaining cohorts are selected whole, oldest first, while they fit in
 * `maxDeletions`.
 */
export function planNightlyDesktopRetention({
  assets,
  currentVersion,
  manifest,
  keepCohorts = NIGHTLY_DESKTOP_RETAINED_COHORTS,
  maxDeletions = NIGHTLY_DESKTOP_MAX_DELETIONS_PER_RUN,
}) {
  const protectedVersions = new Set([currentVersion, manifest?.version]);
  const platforms = manifest?.platforms;
  if (
    !platforms ||
    typeof platforms !== 'object' ||
    Object.keys(platforms).length === 0
  )
    throw new Error('latest.json names no platforms');
  for (const platform of Object.values(platforms))
    protectedVersions.add(manifestCohortOf(platform?.url));
  // Throws on anything that is not a Nightly version.
  for (const version of protectedVersions) nightlyDesktopVersionParts(version);
  const cohorts = new Map();
  let unrecognised = 0;
  for (const asset of assets) {
    const version = versionedCohortOf(asset.name);
    if (!version) {
      unrecognised += 1;
      continue;
    }
    const cohort = cohorts.get(version) ?? {
      version,
      assets: [],
      settled: true,
    };
    cohort.assets.push(asset);
    if (asset.state !== 'uploaded') cohort.settled = false;
    cohorts.set(version, cohort);
  }
  const newestFirst = [...cohorts.values()].sort((a, b) =>
    compareNightlyDesktopVersions(b.version, a.version),
  );
  const kept = [];
  const eligible = [];
  newestFirst.forEach((cohort, index) => {
    if (
      index < keepCohorts ||
      protectedVersions.has(cohort.version) ||
      !cohort.settled
    )
      kept.push(cohort);
    else eligible.unshift(cohort);
  });
  const deletions = [];
  let selectedCohorts = 0;
  for (const cohort of eligible) {
    if (deletions.length + cohort.assets.length > maxDeletions) break;
    selectedCohorts += 1;
    for (const asset of [...cohort.assets].sort((a, b) =>
      a.name < b.name ? -1 : 1,
    ))
      deletions.push({
        id: asset.id,
        name: asset.name,
        url: asset.browser_download_url,
        version: cohort.version,
      });
  }
  return {
    assets: assets.length,
    cohorts: newestFirst.length,
    unsettledCohorts: newestFirst.filter((cohort) => !cohort.settled).length,
    unrecognised,
    keptCohorts: kept.length,
    newestKept: kept[0]?.version,
    oldestKept: kept.at(-1)?.version,
    windowCohorts: Math.min(keepCohorts, newestFirst.length),
    windowOldest:
      newestFirst[Math.min(keepCohorts, newestFirst.length) - 1]?.version,
    eligibleCohorts: eligible.length,
    eligibleAssets: eligible.reduce(
      (total, cohort) => total + cohort.assets.length,
      0,
    ),
    selectedCohorts,
    deletions,
  };
}

/**
 * Every page of the release's asset listing. Unlike the release object, the
 * listing includes uploads that never completed (`starter`), which still
 * occupy the release.
 */
function listReleaseAssets(releaseId, run) {
  const listing = [];
  for (let page = 1; ; page += 1) {
    const entries = JSON.parse(
      run([
        'api',
        `repos/${repository}/releases/${releaseId}/assets?per_page=${ASSET_PAGE_SIZE}&page=${page}`,
      ]),
    );
    if (!Array.isArray(entries) || entries.length > ASSET_PAGE_SIZE)
      throw new Error('Malformed release asset listing page');
    if (page === MAX_ASSET_PAGES && entries.length > 0)
      throw new Error('Release asset listing does not end within 1,000 assets');
    listing.push(...entries);
    if (entries.length < ASSET_PAGE_SIZE) break;
  }
  for (const asset of listing) {
    if (
      !Number.isSafeInteger(asset?.id) ||
      asset.id < 1 ||
      typeof asset.name !== 'string' ||
      typeof asset.state !== 'string' ||
      typeof asset.browser_download_url !== 'string'
    )
      throw new Error('Malformed release asset entry');
  }
  if (
    new Set(listing.map((asset) => asset.id)).size !== listing.length ||
    new Set(listing.map((asset) => asset.name)).size !== listing.length
  )
    throw new Error('Release asset listing has duplicate entries');
  return listing;
}

function readLiveManifest(listing, run) {
  const found = listing.filter((asset) => asset.name === 'latest.json');
  if (found.length !== 1 || found[0].state !== 'uploaded')
    throw new Error('The live latest.json is missing or incomplete');
  const bytes = run([
    'api',
    `repos/${repository}/releases/assets/${found[0].id}`,
    '-H',
    'Accept: application/octet-stream',
  ]);
  if (`sha256:${hash(Buffer.from(bytes))}` !== found[0].digest)
    throw new Error('The live latest.json changed while it was read');
  return JSON.parse(bytes);
}

const ids = (assets) =>
  JSON.stringify(assets.map((asset) => asset?.id).sort((a, b) => a - b));

/**
 * Runs after the cohort's publication is read back and its claims recorded.
 * Always prints the plan; deletes only in `delete` mode. Never throws: the
 * cohort is already published, so a failure is a warning and the next run
 * finishes the work.
 */
export function retainNightlyDesktopAssets({
  currentVersion,
  switchValue,
  keepCohorts = NIGHTLY_DESKTOP_RETAINED_COHORTS,
  // May lower the per-run bound, never raise it: a larger plan is refused.
  maxDeletions = NIGHTLY_DESKTOP_MAX_DELETIONS_PER_RUN,
  run: request = github,
  log = (line) => console.log(line),
  now = Date.now,
}) {
  const deadline = now() + NIGHTLY_DESKTOP_RETENTION_BUDGET_MS;
  /** @param {string[]} args */
  const run = (args) => {
    if (now() > deadline)
      throw new Error('The retention time budget is spent; stopped');
    return request(args, RETENTION_REQUEST_TIMEOUT_MS);
  };
  const mode = nightlyDesktopPruneMode(switchValue);
  /** @type {{ mode: 'delete' | 'report', plan: ReturnType<typeof planNightlyDesktopRetention> | undefined, deleted: Array<{ id: number, name: string, url: string, version: string }>, warning: string | undefined }} */
  const result = { mode, plan: undefined, deleted: [], warning: undefined };
  if (mode === 'report' && switchValue)
    log(
      `${NIGHTLY_DESKTOP_PRUNE_VARIABLE} is "${String(switchValue).slice(0, 40)}", not "enabled"; reporting only.`,
    );
  try {
    nightlyDesktopVersionParts(currentVersion);
    const release = JSON.parse(
      run(['api', `repos/${repository}/releases/tags/nightly-desktop`]),
    );
    if (
      release?.tag_name !== 'nightly-desktop' ||
      !Number.isSafeInteger(release.id) ||
      release.id < 1 ||
      !Array.isArray(release.assets)
    )
      throw new Error('Unexpected desktop release state');
    const listing = listReleaseAssets(release.id, run);
    // Two independent reads must agree, so an asset that arrived or left
    // between pages cannot be planned against.
    if (
      ids(listing.filter((asset) => asset.state === 'uploaded')) !==
      ids(release.assets)
    )
      throw new Error(
        'The asset listing differs from the release; it changed or is truncated',
      );
    const manifest = readLiveManifest(listing, run);
    if (compareNightlyDesktopVersions(manifest?.version, currentVersion) < 0)
      throw new Error(
        `latest.json still names ${manifest.version}, older than ${currentVersion}; nothing is pruned before this cohort is published`,
      );
    const uploaded = new Set(
      listing
        .filter((asset) => asset.state === 'uploaded')
        .map((asset) => asset.name),
    );
    if (
      !VERSIONED_DOWNLOADS.every((staged) =>
        uploaded.has(desktopPublishedAssetName(staged, currentVersion)),
      )
    )
      throw new Error(`${currentVersion} is not fully published`);
    const plan = planNightlyDesktopRetention({
      assets: listing,
      currentVersion,
      manifest,
      keepCohorts,
      maxDeletions,
    });
    result.plan = plan;
    log(
      `nightly-desktop retention (${mode === 'delete' ? 'deleting' : 'report only'}): ` +
        `${plan.assets} assets, ${plan.cohorts} versioned cohorts ` +
        `(${plan.unsettledCohorts} with an incomplete upload, kept), ` +
        `${plan.unrecognised} other assets kept; keeping ${plan.keptCohorts} cohorts: ` +
        `the newest ${plan.windowCohorts} (${plan.windowOldest} to ${plan.newestKept}) and ` +
        `${plan.keptCohorts - plan.windowCohorts} older protected or incomplete ones ` +
        `(oldest ${plan.oldestKept}); ${plan.eligibleAssets} assets in ` +
        `${plan.eligibleCohorts} cohorts are past the window; this run ` +
        `${mode === 'delete' ? 'deletes' : 'would delete'} ${plan.deletions.length} assets ` +
        `in ${plan.selectedCohorts} cohorts` +
        (plan.deletions.length
          ? ` (${plan.deletions[0].version} to ${plan.deletions.at(-1).version})`
          : '') +
        `, ${plan.eligibleCohorts - plan.selectedCohorts} cohorts left for later runs.`,
    );
    if (mode !== 'delete') return result;
    if (plan.deletions.length > NIGHTLY_DESKTOP_MAX_DELETIONS_PER_RUN)
      throw new Error(
        `Refusing ${plan.deletions.length} deletions; the per-run bound is ${NIGHTLY_DESKTOP_MAX_DELETIONS_PER_RUN}`,
      );
    for (const deletion of plan.deletions) {
      const current = JSON.parse(
        run(['api', `repos/${repository}/releases/assets/${deletion.id}`]),
      );
      if (
        current?.id !== deletion.id ||
        current.name !== deletion.name ||
        current.browser_download_url !== deletion.url
      )
        throw new Error(
          `Asset ${deletion.id} no longer matches ${deletion.name}; stopped`,
        );
      run([
        'api',
        '--method',
        'DELETE',
        `repos/${repository}/releases/assets/${deletion.id}`,
      ]);
      result.deleted.push(deletion);
    }
    log(`Deleted ${result.deleted.length} assets.`);
  } catch (error) {
    result.warning = error instanceof Error ? error.message : String(error);
    log(
      `::warning title=Nightly desktop retention::${result.warning}. ` +
        `Deleted ${result.deleted.length} assets this run. The published cohort is unaffected; the next run continues.`,
    );
  }
  return result;
}
