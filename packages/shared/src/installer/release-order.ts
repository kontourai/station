/**
 * Station's release order as install.sh's downgrade check applies it: X.Y.Z,
 * or X.Y.Z-<ring>.N for a prerelease ring, where a release outranks every
 * prerelease of its X.Y.Z and two prereleases of one X.Y.Z compare only
 * within one ring. Null when two tags cannot be ordered.
 */
type Parsed = { core: number[]; label: string | null; build: number | null };

function parse(
  tag: string,
  prereleaseRings: ReadonlySet<string>,
): Parsed | null {
  const match =
    /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([a-z]+)\.([1-9][0-9]*))?$/.exec(
      tag,
    );
  if (!match) return null;
  if (match[4] !== undefined && !prereleaseRings.has(match[4])) return null;
  return {
    core: match.slice(1, 4).map(Number),
    label: match[4] ?? null,
    build: match[5] ? Number(match[5]) : null,
  };
}

export type ReleaseRelation = 'older' | 'same' | 'newer';

/** How `candidate` relates to `installed`, or null when incomparable. */
export function compareReleaseTags(
  installed: string,
  candidate: string,
  prereleaseRings: ReadonlySet<string>,
): ReleaseRelation | null {
  const a = parse(installed, prereleaseRings);
  const b = parse(candidate, prereleaseRings);
  if (!a || !b) return null;
  let order = 0;
  for (let index = 0; index < 3 && order === 0; index += 1)
    order = Math.sign(b.core[index] - a.core[index]);
  if (order === 0) {
    if (a.label === null && b.label === null) order = 0;
    else if (a.label === null) order = -1;
    else if (b.label === null) order = 1;
    else if (a.label !== b.label) return null;
    else order = Math.sign((b.build ?? 0) - (a.build ?? 0));
  }
  return order < 0 ? 'older' : order > 0 ? 'newer' : 'same';
}
