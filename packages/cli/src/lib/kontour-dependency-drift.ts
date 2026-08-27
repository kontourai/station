import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;
const EXACT_VERSION =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;
const KONTOUR_PACKAGE_NAME = /^@kontourai\/[a-z0-9][a-z0-9._-]*$/;

export interface KontourDependencyVersion {
  name: string;
  pinned: string;
  installed: string | null;
}

export interface KontourDependencyState {
  exactPins: KontourDependencyVersion[];
  mismatches: KontourDependencyVersion[];
}

export interface KontourDependencyInspectorDeps {
  exists: (path: string) => boolean;
  readJson: (path: string) => unknown;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function installedVersion(
  repoRoot: string,
  name: string,
  deps: KontourDependencyInspectorDeps,
): string | null {
  const packageJsonPath = join(
    repoRoot,
    'node_modules',
    ...name.split('/'),
    'package.json',
  );
  if (!deps.exists(packageJsonPath)) return null;

  try {
    const manifest = record(deps.readJson(packageJsonPath));
    return typeof manifest?.version === 'string' && manifest.version.trim()
      ? manifest.version
      : null;
  } catch {
    return null;
  }
}

export function inspectExactKontourDependencyPins(
  repoRoot: string,
  overrides: Partial<KontourDependencyInspectorDeps> = {},
): KontourDependencyState {
  const deps: KontourDependencyInspectorDeps = {
    exists: existsSync,
    readJson,
    ...overrides,
  };
  const manifestPath = join(repoRoot, 'package.json');
  const manifest = record(deps.readJson(manifestPath));
  if (!manifest) {
    throw new Error(
      `Station package manifest is not an object: ${manifestPath}`,
    );
  }

  const pins = new Map<string, string>();
  for (const field of DEPENDENCY_FIELDS) {
    const dependencies = record(manifest[field]);
    if (!dependencies) continue;
    for (const [name, specifier] of Object.entries(dependencies)) {
      if (
        !KONTOUR_PACKAGE_NAME.test(name) ||
        typeof specifier !== 'string' ||
        !EXACT_VERSION.test(specifier)
      ) {
        continue;
      }
      pins.set(name, specifier);
    }
  }

  const exactPins = [...pins.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, pinned]) => ({
      name,
      pinned,
      installed: installedVersion(repoRoot, name, deps),
    }));

  return {
    exactPins,
    mismatches: exactPins.filter(
      ({ installed, pinned }) => installed !== pinned,
    ),
  };
}

export function formatKontourDependencyState(
  state: KontourDependencyState,
): string {
  if (state.mismatches.length === 0) {
    return `${state.exactPins.length} exact pin(s) match installed versions.`;
  }
  return state.mismatches
    .map(
      ({ installed, name, pinned }) =>
        `${name}: pinned ${pinned}, installed ${installed ?? 'missing'}`,
    )
    .join('; ');
}
