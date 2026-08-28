/**
 * Build identity for the running UI, injected into index.html by vite.config.ts.
 * Keeping it out of the JavaScript module graph prevents a commit-only change
 * from perturbing content hashes and the entry-bundle gzip measurement.
 *
 * Source-derived fields only — a wall-clock build time here makes the bundle
 * non-reproducible and its measured size non-deterministic (archive#1080). Build time
 * belongs to the instance, not the bundle: it is carried by the build manifest
 * and rendered by Settings → Deployed Build (`BuildProvenance`), which also
 * shows a live age.
 */
export interface StationBuildInfo {
  version: string;
  commit: string;
}

const FALLBACK_BUILD_INFO: StationBuildInfo = {
  version: '0.0.0',
  commit: 'dev',
};

export function readBuildInfo(
  documentLike:
    | Pick<Document, 'querySelectorAll'>
    | undefined = typeof document === 'undefined' ? undefined : document,
): StationBuildInfo {
  if (!documentLike) return FALLBACK_BUILD_INFO;

  const versions = documentLike.querySelectorAll<HTMLMetaElement>(
    'meta[name="station-build-version"]',
  );
  const commits = documentLike.querySelectorAll<HTMLMetaElement>(
    'meta[name="station-build-commit"]',
  );
  if (versions.length !== 1 || commits.length !== 1) {
    return FALLBACK_BUILD_INFO;
  }

  const version = versions[0]?.content.trim();
  const commit = commits[0]?.content.trim();
  return version && commit ? { version, commit } : FALLBACK_BUILD_INFO;
}

export const buildInfo: StationBuildInfo = readBuildInfo();

/** Compact label for always-visible chrome, e.g. `v0.1.0 · 3f2a1c9`. */
export const buildLabel = `v${buildInfo.version} · ${buildInfo.commit}`;

/**
 * The label ONLY when real build metadata resolved — null on the dev
 * fallback. For provenance surfaces that must never fabricate an identity
 * (archive#2585): "v0.0.0 · dev" is a placeholder, not a Station.
 */
export const verifiedBuildLabel: string | null =
  buildInfo.version === '0.0.0' && buildInfo.commit === 'dev'
    ? null
    : buildLabel;

/** Full detail for tooltips. */
export const buildTitle = `Station v${buildInfo.version} · commit ${buildInfo.commit}`;
