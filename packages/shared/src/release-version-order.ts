/**
 * Station's release-version order, shared by the host's update check, the
 * installer's downgrade check and clients that compare themselves with the
 * host they reach. Browser-safe: no Node imports.
 */

/**
 * Station's release order, the one install.sh's downgrade check and the
 * service launcher (packaging/portable-server/bin/station-launcher.mjs
 * `compareVersions`) apply: X.Y.Z, or X.Y.Z-<ring>.N within one ring, and a
 * release outranks every prerelease of its X.Y.Z. Null when the two cannot be
 * ordered (another ring's prerelease, or not a Station version at all).
 */
export function compareStationReleaseVersions(
  left: string,
  right: string,
): -1 | 0 | 1 | null {
  const shape =
    /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([a-z]+)\.([1-9][0-9]*))?$/;
  const read = (version: string) => {
    const match = shape.exec(version);
    if (!match) return null;
    return {
      release: match.slice(1, 4).map((part) => BigInt(part)),
      ring: match[4] ?? null,
      build: match[5] === undefined ? null : BigInt(match[5]),
    };
  };
  const a = read(left);
  const b = read(right);
  if (!a || !b) return null;
  const order = (x: bigint | null, y: bigint | null): -1 | 0 | 1 =>
    x === y ? 0 : (x ?? 0n) < (y ?? 0n) ? -1 : 1;
  for (let part = 0; part < 3; part += 1) {
    const result = order(a.release[part] ?? 0n, b.release[part] ?? 0n);
    if (result !== 0) return result;
  }
  if (a.ring === b.ring) return a.ring === null ? 0 : order(a.build, b.build);
  if (a.ring === null) return 1;
  if (b.ring === null) return -1;
  return null;
}

// ---------------------------------------------------------------------------
// Interim Nightly bridge (#2962). Everything below exists only because native
// clients and the portable host name one Nightly in two shapes; delete it
// when #2962 gives every Nightly one version identity.
// ---------------------------------------------------------------------------

/** Day zero of the Nightly day number (nightly-build-identity.mjs EPOCH). */
const NIGHTLY_EPOCH_UTC = Date.UTC(2020, 0, 1);
const MS_PER_DAY = 86_400_000;

/**
 * Builds a day can carry, as scripts/lib/nightly-build-identity.mjs
 * allocates them: a Nightly's version code is `day * 100 + build`.
 */
const NIGHTLY_BUILDS_PER_DAY = 100;

/**
 * A client build's version written in the host stream's shape, so it can be
 * ordered against a host's version with {@link compareStationReleaseVersions}.
 * Null when the version is not a Station release version.
 *
 * Releases and previews already share one shape. Nightlies do not (#2962):
 * a native client's build identity is `X.Y.Z-nightly.<day>` or
 * `X.Y.Z-nightly.<day>.<build>` (nightlyVersion; Android and macOS stamp it,
 * and iOS stamps its web bundle with it although Apple's marketing version
 * is the bare `X.Y.Z`), while the portable host
 * names the same night's allocation by its version code,
 * `X.Y.Z-nightly.<day * 100 + build>` (portableNightlyVersion). The caller
 * states which writer produced the value; this never guesses a form from the
 * number's size.
 */
export function clientVersionInHostOrder(version: string): string | null {
  const nightly =
    /^((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))-nightly\.(0|[1-9][0-9]*)(?:\.([1-9][0-9]*))?$/.exec(
      version,
    );
  if (nightly) {
    const day = Number(nightly[2]);
    const build = nightly[3] === undefined ? 0 : Number(nightly[3]);
    if (build >= NIGHTLY_BUILDS_PER_DAY) return null;
    const code = day * NIGHTLY_BUILDS_PER_DAY + build;
    if (!Number.isSafeInteger(code) || code < 1) return null;
    return `${nightly[1]}-nightly.${code}`;
  }
  return compareStationReleaseVersions(version, version) === 0 ? version : null;
}

/** One Nightly allocation: the UTC day it was built and that day's build. */
export interface NightlyAllocation {
  date: Date;
  build: number;
}

/**
 * The allocation a host-order Nightly version names, for display. Reads the
 * version-code form `X.Y.Z-nightly.<day * 100 + build>` and, ahead of #2962,
 * the dated form `X.Y.Z-nightly.<YYYYMMDD>.<build>`. Null for anything else.
 */
export function hostNightlyAllocation(
  version: string,
): NightlyAllocation | null {
  const dated =
    /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)-nightly\.([0-9]{4})([0-9]{2})([0-9]{2})\.(0|[1-9][0-9]*)$/.exec(
      version,
    );
  if (dated) {
    const [year, month, day] = [dated[1], dated[2], dated[3]].map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day
    ) {
      return null;
    }
    return { date, build: Number(dated[4]) };
  }
  const coded =
    /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)-nightly\.([1-9][0-9]*)$/.exec(
      version,
    );
  if (!coded) return null;
  const code = Number(coded[1]);
  if (!Number.isSafeInteger(code)) return null;
  return {
    date: new Date(
      NIGHTLY_EPOCH_UTC +
        Math.floor(code / NIGHTLY_BUILDS_PER_DAY) * MS_PER_DAY,
    ),
    build: code % NIGHTLY_BUILDS_PER_DAY,
  };
}
