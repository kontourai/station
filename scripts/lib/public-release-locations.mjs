// The one source of truth for where Station's signed public host manifests
// live (ADR 0020 D3, #2959). Every location is derived from the release
// download base below: the versioned release that holds a version's archives
// and its signed manifest, and, per release ring, the rolling pointer release
// whose one manifest asset always names that ring's newest version.
//
// The publication helpers (scripts/lib/portable-publication.mjs, and through
// it the Nightly and tagged-release publishers) read it today. install.sh's
// generated blocks and the docs are meant to project it too (#2960), so a
// later move to a kontourai.io redirect is a change to releaseBaseUrl, not to
// its callers.
import { STATION_RELEASE_RINGS } from '../../packages/shared/src/release-rings.generated.mjs';

/** The repository whose releases hold Station's public host manifests. */
const PUBLIC_RELEASE_REPOSITORY = 'kontourai/station';

const REPOSITORY = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

/**
 * The release download base for `repository`: GitHub release assets, as
 * `<base><release tag>/<asset name>`. Workflows pass their own repository so
 * a fork's dry run names its own releases.
 */
export function releaseBaseUrl(repository = PUBLIC_RELEASE_REPOSITORY) {
  if (typeof repository !== 'string' || !REPOSITORY.test(repository))
    throw new Error(`invalid repository ${String(repository)}`);
  return `https://github.com/${repository}/releases/download/`;
}

/** The BASE_URL an installer and the docs use: the public repository's. */
export const PUBLIC_RELEASE_BASE_URL = releaseBaseUrl();

/**
 * Per release ring: the rolling pointer release (a release tag the owner
 * creates once) and the manifest asset name it carries. The versioned
 * release carries the same asset name.
 */
export const PUBLIC_MANIFEST_POINTERS = Object.freeze({
  stable: Object.freeze({
    rollingTag: 'portable-stable',
    manifestAsset: 'station-portable-stable-manifest.json',
  }),
  preview: Object.freeze({
    rollingTag: 'portable-preview',
    manifestAsset: 'station-portable-preview-manifest.json',
  }),
  nightly: Object.freeze({
    rollingTag: 'portable-nightly',
    manifestAsset: 'station-portable-nightly-manifest.json',
  }),
});

/** The pointer entry for `ring`; throws for a ring that has none. */
export function manifestPointer(ring) {
  if (
    typeof ring !== 'string' ||
    !Object.hasOwn(STATION_RELEASE_RINGS, ring) ||
    !Object.hasOwn(PUBLIC_MANIFEST_POINTERS, ring)
  )
    throw new Error(`${String(ring)} is not a release ring`);
  return PUBLIC_MANIFEST_POINTERS[ring];
}

/** The rolling manifest URL for `ring` under `repository`'s release base. */
export function rollingManifestUrl(ring, repository) {
  const { rollingTag, manifestAsset } = manifestPointer(ring);
  return `${releaseBaseUrl(repository)}${rollingTag}/${manifestAsset}`;
}
