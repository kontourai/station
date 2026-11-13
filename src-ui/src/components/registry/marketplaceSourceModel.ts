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

/**
 * Labels that tell sources with the same name apart: a name shared by several
 * sources gets the shortest tail of its location that no other source with
 * that name shares (`Local skills · …/.codex/skills`).
 */
export function distinctLabels(
  sources: readonly RegistrySource[],
): Map<string, string> {
  const labels = new Map<string, string>();
  const groups = new Map<string, RegistrySource[]>();
  for (const source of sources) {
    const key = source.displayName.toLocaleLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), source]);
  }
  for (const group of groups.values()) {
    if (group.length === 1) {
      labels.set(group[0]!.id, group[0]!.displayName);
      continue;
    }
    for (const source of group) {
      const segments = pathSegments(
        source.location ?? source.owner ?? source.id,
      );
      let tail = segments.slice(-1).join('/');
      for (let length = 1; length <= segments.length; length += 1) {
        tail = segments.slice(-length).join('/');
        const clash = group.some(
          (other) =>
            other.id !== source.id &&
            pathSegments(other.location ?? other.owner ?? other.id)
              .slice(-length)
              .join('/') === tail,
        );
        if (!clash) break;
      }
      labels.set(
        source.id,
        `${source.displayName} · ${tail === segments.join('/') ? '' : '…/'}${tail}`,
      );
    }
  }
  return labels;
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
