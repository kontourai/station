const SHA = /^[0-9a-f]{40}$/i;
const STABLE = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const PREVIEW =
  /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-preview\.(?:[1-9]\d*)$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const CONTAINER_PLATFORMS = ['linux/amd64', 'linux/arm64'];

function fail(message) {
  throw new Error(`Invalid container release metadata: ${message}`);
}

export function createPackagedReleaseManifest({ tag, sha, createdAt }) {
  if (typeof tag !== 'string' || !(STABLE.test(tag) || PREVIEW.test(tag))) {
    fail('tag must be vMAJOR.MINOR.PATCH or vMAJOR.MINOR.PATCH-preview.N');
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
  const preview = PREVIEW.test(tag);
  return {
    schemaVersion: 1,
    sha: sha.toLowerCase(),
    ref: tag,
    createdAt,
    channel: preview ? 'preview' : 'stable',
    prerelease: preview,
  };
}

export function createContainerReleaseMetadata({
  tag,
  sha,
  createdAt,
  repository,
}) {
  const manifest = createPackagedReleaseManifest({ tag, sha, createdAt });
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
    channel: manifest.channel,
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

if (import.meta.url === `file://${process.argv[1]}`) {
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
