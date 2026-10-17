import { invokedDirectly } from '../../scripts/lib/module-entry.mjs';

const REPO = 'https://api.github.com/repos/kontourai/station';
const PACKAGE = '@kontourai/station-cli';
const MAX_PAGES = 100;

async function json(url) {
  const response = await fetch(url, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'station-passive-signal-report',
    },
    signal: AbortSignal.timeout(15000),
    redirect: 'error',
  });
  if (!response.ok)
    throw new Error(`Public metadata request refused: HTTP ${response.status}`);
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > 8 * 1024 * 1024)
      throw new Error('Public metadata response exceeded 8 MiB');
    chunks.push(chunk);
  }
  return {
    value: JSON.parse(Buffer.concat(chunks).toString('utf8')),
    next: /rel="next"/.test(response.headers.get('link') ?? ''),
  };
}
async function pages(path) {
  const values = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const response = await json(`${REPO}${path}?per_page=100&page=${page}`);
    if (!Array.isArray(response.value))
      throw new Error('Invalid public metadata page');
    values.push(...response.value);
    if (!response.next) return values;
  }
  throw new Error(
    'Public metadata pagination exceeded 100 pages; no complete report',
  );
}
function count(value) {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error('Invalid public download count');
  return value;
}

export async function collectPassiveSignals() {
  const npm = [];
  for (const period of ['last-day', 'last-week', 'last-month']) {
    const { value } = await json(
      `https://api.npmjs.org/downloads/point/${period}/${PACKAGE}`,
    );
    if (
      value.package !== PACKAGE ||
      !/^\d{4}-\d{2}-\d{2}$/.test(value.start) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(value.end)
    )
      throw new Error('Invalid npm download window');
    npm.push({
      period,
      start: value.start,
      end: value.end,
      downloads: count(value.downloads),
    });
  }
  const releases = [];
  for (const release of await pages('/releases')) {
    if (
      !Number.isSafeInteger(release.id) ||
      release.id <= 0 ||
      typeof release.tag_name !== 'string'
    )
      throw new Error('Invalid release metadata');
    const assets = [];
    for (const asset of await pages(`/releases/${release.id}/assets`)) {
      if (typeof asset.name !== 'string')
        throw new Error('Invalid release asset');
      assets.push({ name: asset.name, downloads: count(asset.download_count) });
    }
    releases.push({
      tag: release.tag_name,
      assets,
      totalAssetDownloads: assets.reduce(
        (sum, a) => count(sum + a.downloads),
        0,
      ),
    });
  }
  return {
    scope: 'passive-public-distribution-signals',
    observedAt: new Date().toISOString(),
    npmPackage: PACKAGE,
    npm,
    releases,
    totalAssetDownloads: releases.reduce(
      (sum, r) => count(sum + r.totalAssetDownloads),
      0,
    ),
    limits:
      'Download requests are not installs, active devices or people. npm windows overlap; GitHub asset counts are lifetime snapshots. No broker or push-gateway production query is made.',
  };
}

if (invokedDirectly(import.meta.url)) {
  if (process.argv.length !== 2)
    throw new Error(
      'Usage: node packages/telemetry-broker/passive-signals.mjs',
    );
  console.log(JSON.stringify(await collectPassiveSignals(), null, 2));
}
