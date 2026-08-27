import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import type { WorkspacePaneHostContract } from '@kontourai/station-contracts/workspace-pane-host-contract';
import { describe, expect, expectTypeOf, test } from 'vitest';
import type { ConsoleBoardPaneHost } from '../ConsoleBoardPane';

/**
 * Epic station#4142 M4a acceptance 2: this package exists BECAUSE its
 * dependency list is published contracts only — `src-ui`/`src-server` code
 * reaching in (or the package reaching out) is exactly the erosion the
 * extraction is meant to make impossible. A relative import that escapes
 * `src/`, a `src-ui`/`src-server` specifier, or an undeclared bare package
 * would all reintroduce the coupling silently, so this test walks the real
 * source and refuses them by name.
 */

const PACKAGE_ROOT = resolve(import.meta.dirname, '..', '..');
const SRC = join(PACKAGE_ROOT, 'src');

/** Every bare specifier the package may import, by exact package name. */
const ALLOWED_PACKAGES = new Set([
  '@kontourai/console-ui',
  '@kontourai/station-contracts',
  '@kontourai/station-sdk',
  '@kontourai/ui',
  'react',
]);

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* sourceFiles(full);
      continue;
    }
    if (/\.(ts|tsx|css)$/.test(entry)) yield full;
  }
}

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const pattern =
    /(?:^|\n)\s*(?:import|export)\b[^'"]*?from\s+['"]([^'"]+)['"]|(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(pattern)) {
    const specifier = match[1] ?? match[2];
    if (specifier) specifiers.push(specifier);
  }
  return specifiers;
}

function packageName(specifier: string): string {
  const segments = specifier.split('/');
  return specifier.startsWith('@')
    ? segments.slice(0, 2).join('/')
    : (segments[0] as string);
}

describe('@kontourai/station-board-pane consumes published contracts only', () => {
  test('no source file imports src-ui, src-server, or an undeclared package', () => {
    const violations: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const path = relative(PACKAGE_ROOT, file);
      const source = readFileSync(file, 'utf8');
      for (const specifier of importSpecifiers(source)) {
        if (/src-ui|src-server|src-shared/.test(specifier)) {
          violations.push(
            `${path}: '${specifier}' reaches Station internals — consume the published equivalent or extend ConsoleBoardPaneHost`,
          );
          continue;
        }
        if (specifier.startsWith('.')) {
          const target = resolve(dirname(file), specifier);
          if (relative(SRC, target).startsWith('..')) {
            violations.push(
              `${path}: relative import '${specifier}' escapes the package source`,
            );
          }
          continue;
        }
        if (specifier.startsWith('node:')) {
          violations.push(
            `${path}: '${specifier}' — the pane runs in the browser and must not import node builtins`,
          );
          continue;
        }
        if (!ALLOWED_PACKAGES.has(packageName(specifier))) {
          violations.push(
            `${path}: '${specifier}' is not one of the package's published dependencies`,
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test('package.json declares only published dependencies, react as a peer', () => {
    const manifest = JSON.parse(
      readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'),
    ) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual([
      '@kontourai/console-ui',
      '@kontourai/station-contracts',
      '@kontourai/station-sdk',
      '@kontourai/ui',
    ]);
    expect(Object.keys(manifest.peerDependencies ?? {})).toEqual(['react']);
  });

  /**
   * The design's regression tripwire (`docs/design/pane-host-contract.md`):
   * "the moment a host member has a `ComponentType`, it cannot survive the
   * frame boundary, and the tier-2 contract has silently forked from tier
   * 3." The transitional `ConsoleBoardPaneHost` carried two component slots;
   * they are deleted, and this test refuses their return — the token may
   * not appear ANYWHERE in the package source (comments included: naming it
   * approvingly is how it comes back), and the host type the mounter
   * supplies must BE the contract, not a local widening of it.
   */
  test('no component type crosses the host seam (station#4201 tripwire)', () => {
    const violations: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const source = readFileSync(file, 'utf8');
      for (const forbidden of ['ComponentType', 'FunctionComponent']) {
        if (source.includes(forbidden)) {
          violations.push(
            `${relative(PACKAGE_ROOT, file)}: '${forbidden}' — components ` +
              'never cross the pane-host contract; publish the primitive ' +
              'or express the capability as an intent',
          );
        }
      }
    }
    expect(violations).toEqual([]);
    // Erased at runtime, load-bearing at review time: the Board's host IS
    // the published contract — a member added here and not there is a fork.
    expectTypeOf<ConsoleBoardPaneHost>().toEqualTypeOf<WorkspacePaneHostContract>();
  });

  /**
   * Scope integrity (station#1559 class): a walker that silently matched
   * zero files would pass vacuously, so pin the files that must be present
   * for the boundary check to mean anything.
   */
  test('the walker actually sees the package source', () => {
    const seen = [...sourceFiles(SRC)].map((file) => relative(SRC, file));
    expect(seen).toContain('ConsoleBoardPane.tsx');
    expect(seen).toContain('workspace-board-pane.ts');
  });
});
