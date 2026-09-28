/**
 * The platforms a prebuilt standalone server archive is published for
 * (#2675), and the archive format each uses. This is the one definition:
 * the manifest signer (scripts/ecosystem-manifest.mjs), the shared verifier
 * (release-manifest.mjs) and the archive builder read it, so a target cannot
 * be signable without being buildable, or the reverse.
 *
 * Ordered by `os`, then `arch` (code-point order), the order a signed
 * manifest's `artifacts` must follow. Windows archives are zip; every other
 * platform is tar.gz.
 */
export const PORTABLE_SERVER_TARGETS = Object.freeze(
  [
    { os: 'darwin', arch: 'arm64', format: 'tar.gz' },
    { os: 'darwin', arch: 'x64', format: 'tar.gz' },
    { os: 'linux', arch: 'arm64', format: 'tar.gz' },
    { os: 'linux', arch: 'x64', format: 'tar.gz' },
    { os: 'win32', arch: 'x64', format: 'zip' },
  ].map((target) => Object.freeze(target)),
);

/** The target for `os`/`arch`, or undefined when none is published. */
export function findPortableServerTarget(os, arch) {
  return PORTABLE_SERVER_TARGETS.find(
    (target) => target.os === os && target.arch === arch,
  );
}

/** The archive file name for a target: `station-server-<os>-<arch>.<format>`. */
export function portableServerArchiveName({ os, arch, format }) {
  return `station-server-${os}-${arch}.${format}`;
}
