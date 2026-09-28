import { CHANNEL_VERSION } from '../../packages/shared/src/release-manifest.mjs';
import { STATION_RELEASE_RINGS } from '../../packages/shared/src/release-rings.generated.mjs';
import { invokedDirectly } from './module-entry.mjs';

const SHA = /^[0-9a-f]{40}$/i;
/**
 * Container images are published for the stable and preview rings only: a
 * Nightly image has no registry tag policy (its prerelease would take the
 * `preview` tag), so createContainerReleaseMetadata refuses every other ring.
 */
const CONTAINER_RINGS = new Set(['stable', 'preview']);
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const CONTAINER_PLATFORMS = ['linux/amd64', 'linux/arm64'];

function fail(message) {
  throw new Error(`Invalid container release metadata: ${message}`);
}

/**
 * The release ring a `v<version>` tag belongs to, read from the generated
 * ring table (config/channel-ports.json releaseRings) through the shared
 * verifier's per-ring version grammar, so every installable ring is accepted
 * and no ring list is typed here.
 */
function releaseRingForTag(tag) {
  if (typeof tag !== 'string' || !tag.startsWith('v')) return undefined;
  const version = tag.slice(1);
  return Object.keys(STATION_RELEASE_RINGS).find((ring) =>
    CHANNEL_VERSION[ring]?.test(version),
  );
}

export function createPackagedReleaseManifest({ tag, sha, createdAt }) {
  const ring = releaseRingForTag(tag);
  if (!ring) {
    fail(
      `tag must be one release ring's version: ${Object.entries(
        STATION_RELEASE_RINGS,
      )
        .map(([name, { prerelease }]) =>
          prerelease ? `vMAJOR.MINOR.PATCH-${name}.N` : 'vMAJOR.MINOR.PATCH',
        )
        .join(', ')}`,
    );
  }
  if (typeof sha !== 'string' || !SHA.test(sha))
    fail('sha must be a 40-character Git SHA');
  const createdAtMs =
    typeof createdAt === 'string' ? Date.parse(createdAt) : Number.NaN;
  if (
    !Number.isFinite(createdAtMs) ||
    new Date(createdAtMs).toISOString() !== createdAt
  ) {
    fail('createdAt must be a canonical ISO-8601 timestamp');
  }
  const { runtimeChannel, prerelease } = STATION_RELEASE_RINGS[ring];
  return {
    schemaVersion: 2,
    sha: sha.toLowerCase(),
    ref: tag,
    createdAt,
    channel: runtimeChannel,
    releaseChannel: ring,
    prerelease,
  };
}

export function createContainerReleaseMetadata({
  tag,
  sha,
  createdAt,
  repository,
}) {
  const manifest = createPackagedReleaseManifest({ tag, sha, createdAt });
  if (!CONTAINER_RINGS.has(manifest.releaseChannel))
    fail(
      `container images are published for stable and preview tags only, not ${manifest.releaseChannel}`,
    );
  if (
    typeof repository !== 'string' ||
    !/^[a-z0-9][a-z0-9._/-]*$/.test(repository)
  ) {
    fail('repository must be lowercase GHCR image path');
  }
  const version = tag.slice(1);
  const shaTag = `sha-${manifest.sha}`;
  return {
    image: `ghcr.io/${repository}`,
    tag,
    sha: manifest.sha,
    createdAt,
    channel: manifest.releaseChannel,
    tags: [tag, version, shaTag, manifest.prerelease ? 'preview' : 'latest'],
    labels: {
      'org.opencontainers.image.created': createdAt,
      'org.opencontainers.image.revision': manifest.sha,
      'org.opencontainers.image.version': tag,
      'org.opencontainers.image.source': `https://github.com/${repository}`,
    },
    stationManifest: manifest,
  };
}

export function createContainerReleaseDescriptor({ metadata, digest }) {
  if (
    !metadata ||
    typeof metadata !== 'object' ||
    !DIGEST.test(digest ?? '') ||
    !Array.isArray(metadata.tags)
  ) {
    fail('descriptor requires valid metadata and a sha256 digest');
  }
  return {
    image: metadata.image,
    digest,
    sha: metadata.sha,
    tag: metadata.tag,
    createdAt: metadata.createdAt,
    platforms: [...CONTAINER_PLATFORMS],
    tags: [...metadata.tags],
  };
}

function option(name, args) {
  const prefix = `--${name}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

if (invokedDirectly(import.meta.url)) {
  const args = process.argv.slice(2);
  const metadata = createContainerReleaseMetadata({
    tag: option('tag', args) ?? process.env.RELEASE_TAG,
    sha: option('sha', args) ?? process.env.RELEASE_SHA,
    createdAt: option('created-at', args) ?? process.env.RELEASE_CREATED_AT,
    repository: option('repository', args) ?? process.env.GITHUB_REPOSITORY,
  });
  const manifestPath = option('station-manifest', args);
  if (manifestPath) {
    const fs = await import('node:fs');
    fs.writeFileSync(
      manifestPath,
      `${JSON.stringify(metadata.stationManifest, null, 2)}\n`,
      { mode: 0o644 },
    );
  }
  const descriptorPath = option('container-descriptor', args);
  if (descriptorPath) {
    const fs = await import('node:fs');
    fs.writeFileSync(
      descriptorPath,
      `${JSON.stringify(
        createContainerReleaseDescriptor({
          metadata,
          digest: option('digest', args),
        }),
        null,
        2,
      )}\n`,
      { mode: 0o644 },
    );
  }
  if (args.includes('--github-output')) {
    if (!process.env.GITHUB_OUTPUT)
      fail('GITHUB_OUTPUT is required with --github-output');
    const fs = await import('node:fs');
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      `metadata=${JSON.stringify(metadata)}\n`,
    );
  }
  process.stdout.write(`${JSON.stringify(metadata)}\n`);
}
