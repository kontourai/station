import type {
  RegistrySource,
  RegistrySourceDetectedKind,
} from '@kontourai/station-contracts/catalog';
import type { SemanticTone } from '@kontourai/ui/react';

type CatalogKind = RegistrySource['kind'];

/** Whether a detected kind can be listed and installed from this source now. */
function usable(
  kind: RegistrySourceDetectedKind,
): kind is RegistrySourceDetectedKind & {
  kind: CatalogKind;
} {
  return (
    kind.installable &&
    kind.kind !== 'integrations' &&
    kind.managedDenial === undefined
  );
}

/**
 * Whether a source supplies a catalog of one of `kinds`: its primary kind, or
 * an installable kind its content was detected to provide.
 */
export function suppliesAny(
  source: RegistrySource,
  kinds?: readonly CatalogKind[],
): boolean {
  if (!kinds) return true;
  return (
    kinds.includes(source.kind) ||
    (source.detection?.kinds ?? []).some(
      (detected) =>
        detected.installable &&
        detected.kind !== 'integrations' &&
        kinds.includes(detected.kind),
    )
  );
}

/** The catalog kinds a source supplies, primary first. */
export function suppliedKinds(source: RegistrySource): CatalogKind[] {
  const kinds: CatalogKind[] = [source.kind];
  for (const detected of source.detection?.kinds ?? [])
    if (
      detected.installable &&
      detected.kind !== 'integrations' &&
      !kinds.includes(detected.kind)
    )
      kinds.push(detected.kind);
  return kinds;
}

/**
 * Whether opening the source's catalog would show anything to install: it is
 * on, not refused by policy, and (when its content was read) provides at least
 * one kind Station can list and install from it.
 */
export function isBrowsable(source: RegistrySource): boolean {
  if (!source.enabled || source.managedDenial !== undefined) return false;
  if (!source.detection) return true;
  return source.detection.kinds.some(usable);
}

const KIND_NAMES: Record<RegistrySourceDetectedKind['kind'], [string, string]> =
  {
    skills: ['skill', 'skills'],
    plugins: ['plugin', 'plugins'],
    agents: ['agent', 'agents'],
    integrations: ['tool server', 'tool servers'],
  };

export function countLabel(
  kind: RegistrySourceDetectedKind['kind'],
  count: number,
): string {
  const [one, many] = KIND_NAMES[kind];
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * What a source without a detection (a default, configured or plugin
 * catalog) is known to hold: the count of its last listing, or that it has
 * not been listed yet.
 */
export function coverageLabel(source: RegistrySource): string | undefined {
  if (source.detection) return undefined;
  return source.itemCount === undefined
    ? 'Not scanned yet'
    : countLabel(source.kind, source.itemCount);
}

const pathSegments = (location: string) =>
  location.split(/[\\/:]+/).filter(Boolean);

/** A label reduced to letters and digits, so punctuation cannot be the only difference. */
export function labelKey(label: string): string {
  return label.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * A local path with any home folder replaced by `~` before anything is
 * shortened, so no label or hint can name an account. The browser cannot
 * tell which home is the Station's, so every home (`/Users/<name>`,
 * `/home/<name>`, `/root`, `C:\Users\<name>`) becomes the same neutral `~`.
 */
export function redactHome(location: string): string {
  const home = location.match(
    /^(?:[A-Za-z]:)?[\\/](?:(?:Users|home)[\\/][^\\/]+|root)(?=[\\/]|$)(.*)$/i,
  );
  if (!home) return location;
  const rest = home[1]!.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  return rest ? `~/${rest}` : '~';
}

/** A stable hash of a source's identity: 32-bit FNV-1a, 7 base-36 digits. */
function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(7, '0');
}

const TAG_LENGTH = 4;

/** A stable short tag for a source, used when its path cannot tell it apart. */
function stableTag(value: string): string {
  return stableHash(value).slice(-TAG_LENGTH);
}

/**
 * Labels that tell sources apart. Station names its default sources by
 * engine, owner and scope; a name that still repeats (two sources a person
 * named alike) gets the shortest tail of its home-redacted location that no
 * other source with that name shares once punctuation is ignored. When the
 * paths run out (they differ only by punctuation, or are the same), a
 * stable tag from the source's identity tells them apart. Every label is
 * finally checked to be unique ignoring punctuation.
 */
export function distinctLabels(
  sources: readonly RegistrySource[],
): Map<string, string> {
  const labels = new Map<string, string>();
  const groups = new Map<string, RegistrySource[]>();
  for (const source of sources) {
    const key = labelKey(source.displayName);
    groups.set(key, [...(groups.get(key) ?? []), source]);
  }
  const segmentsOf = (source: RegistrySource) =>
    pathSegments(redactHome(source.location ?? source.owner ?? source.id));
  for (const group of groups.values()) {
    if (group.length === 1) {
      labels.set(group[0]!.id, group[0]!.displayName);
      continue;
    }
    for (const source of group) {
      const segments = segmentsOf(source);
      let tail: string | undefined;
      for (let length = 1; length <= segments.length; length += 1) {
        const candidate = segments.slice(-length).join('/');
        const clash = group.some(
          (other) =>
            other.id !== source.id &&
            labelKey(segmentsOf(other).slice(-length).join('/')) ===
              labelKey(candidate),
        );
        if (!clash) {
          tail = candidate;
          break;
        }
      }
      const shown = segments.slice(-2).join('/');
      labels.set(
        source.id,
        tail === undefined
          ? `${source.displayName} · ${shown} #${stableTag(source.id)}`
          : `${source.displayName} · ${tail === segments.join('/') || tail.startsWith('~') ? '' : '…/'}${tail}`,
      );
    }
  }
  // Last guard: no two labels may be equal ignoring punctuation, even when
  // short tags collide. Labels are settled in id order, so the result does
  // not depend on input order. A label that repeats one already taken gets
  // a longer tag (up to the whole hash), then an ordinal, until it is free.
  const taken = new Set<string>();
  const byId = [...sources].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  for (const source of byId) {
    const label = labels.get(source.id)!;
    const hash = stableHash(source.id);
    const shortTag = ` #${hash.slice(-TAG_LENGTH)}`;
    const base = label.endsWith(shortTag)
      ? label.slice(0, -shortTag.length)
      : label;
    const candidates = function* () {
      yield label;
      for (let length = TAG_LENGTH; length <= hash.length; length += 1)
        yield `${base} #${hash.slice(-length)}`;
      for (let ordinal = 2; ; ordinal += 1) yield `${base} #${hash}-${ordinal}`;
    };
    for (const candidate of candidates()) {
      if (taken.has(labelKey(candidate))) continue;
      taken.add(labelKey(candidate));
      labels.set(source.id, candidate);
      break;
    }
  }
  return labels;
}

/**
 * The part of a source's location a selector option shows beside its label:
 * a repository with its branch and folder, or the last folders of a
 * home-redacted path. It never names a home folder's account.
 */
export function locationHint(source: RegistrySource): string | undefined {
  const location = source.location;
  if (!location) return undefined;
  const key = location.match(/^github:([^/]+)\/([^/]+)\/([^/]+)\/?(.*)$/);
  if (key)
    return `github.com/${key[1]}/${key[2]}${key[4] ? `/${key[4]}` : ''} @ ${key[3]}`;
  const url = location.match(/^https:\/\/(github\.com\/[^/]+\/[^/]+)/);
  if (url) return `${url[1]}${source.ref ? ` @ ${source.ref}` : ''}`;
  const redacted = redactHome(location);
  const segments = pathSegments(redacted);
  if (segments[0] === '~') {
    const below = segments.slice(1);
    if (below.length === 0) return '~';
    return below.length > 2
      ? `~/…/${below.slice(-2).join('/')}`
      : `~/${below.join('/')}`;
  }
  return segments.length > 2
    ? `…/${segments.slice(-2).join('/')}`
    : segments.join('/') || location;
}

/** The repository or folder a location names, for overlap checks. */
function sourceIdentity(
  location: string | undefined,
): { kind: 'repo' | 'path' | 'url'; value: string } | undefined {
  if (!location) return undefined;
  const repo = location.match(
    /^(?:https:\/\/github\.com\/|github:)([^/]+)\/([^/]+)/i,
  );
  if (repo)
    return {
      kind: 'repo',
      value: `${repo[1]!.toLowerCase()}/${repo[2]!.toLowerCase().replace(/\.git$/, '')}`,
    };
  if (/^(?:[A-Za-z]:)?[\\/]/.test(location))
    return { kind: 'path', value: location.replace(/[\\/]+$/, '') };
  return { kind: 'url', value: location };
}

const inside = (child: string, parent: string) =>
  child === parent ||
  child.startsWith(`${parent}/`) ||
  child.startsWith(`${parent}\\`);

/**
 * Other sources that read the same repository or an overlapping folder, so
 * the same items can appear from both as separate choices.
 */
export function overlappingSources(
  source: RegistrySource,
  sources: readonly RegistrySource[],
): RegistrySource[] {
  const identity = sourceIdentity(source.location);
  if (!identity) return [];
  return sources.filter((other) => {
    if (other.id === source.id) return false;
    const theirs = sourceIdentity(other.location);
    if (!theirs || theirs.kind !== identity.kind) return false;
    if (identity.kind === 'path')
      return (
        inside(identity.value, theirs.value) ||
        inside(theirs.value, identity.value)
      );
    return identity.value === theirs.value;
  });
}

/** Trust tier: only Station's bundled collection is vouched for. */
export function trustTier(source: RegistrySource): {
  label: string;
  detail: string;
  tone: SemanticTone;
} {
  switch (source.origin) {
    case 'station':
      return {
        label: 'Station',
        detail: 'Ships with Station',
        tone: 'positive',
      };
    case 'configured':
      return {
        label: 'Default',
        detail:
          'A default or configured catalog of this Station. Its publisher is not verified.',
        tone: 'neutral',
      };
    case 'plugin':
      return {
        label: 'Plugin',
        detail: `Provided by plugin ${source.owner ?? ''}`,
        tone: 'neutral',
      };
    default:
      return {
        label: 'Unverified',
        detail: 'Added on this Station. Its publisher is not verified.',
        tone: 'caution',
      };
  }
}

const STATUS_TONES: Record<RegistrySource['status'], SemanticTone> = {
  ready: 'positive',
  stale: 'caution',
  error: 'negative',
  disabled: 'neutral',
  unknown: 'neutral',
};

export function statusTone(status: RegistrySource['status']): SemanticTone {
  return STATUS_TONES[status];
}

/** The tone of one detected kind's count. */
export function kindTone(kind: RegistrySourceDetectedKind): SemanticTone {
  if (kind.managedDenial !== undefined) return 'caution';
  return usable(kind) ? 'active' : 'neutral';
}
