import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classifyStationHomeRoot,
  containsExternalStationHomePath,
  isExternalStationHomePath,
  STATION_HOME_EXTERNAL_PATHS,
  STATION_HOME_ROOTS,
  STATION_HOME_SQLITE_STORES,
} from '../station-home-store-registry.js';

const repoRoot = resolve(import.meta.dirname, '../../../..');

/**
 * The variables Station's own code names a Station (or project) home with.
 * A literal joined directly onto one of them is a home root. Paths built any
 * other way (segment constants, helper functions) are outside this scan,
 * which is why an unclassified root is backed up as state at run time.
 */
const HOME_VARIABLES = [
  'home',
  'homeDir',
  'stationHome',
  'stationHomeDir',
  'baseDir',
  'projectHome',
  'projectHomeDir',
  'dataDir',
  'stateHome',
  'homePath',
];

/**
 * Literals the scan finds under one of those names that are not Station
 * home roots, each for a stated reason. Kept to entries whose owner joins
 * them onto the OPERATING SYSTEM user home or a provider's home.
 */
const NOT_STATION_HOME_ROOTS: Readonly<Record<string, string>> = {
  '.claude': "Claude Code's home under the OS user home",
  '.codex': "Codex's home under the OS user home",
  Android: 'Android SDK under the OS user home',
  AppData: 'Windows AppData under the OS user home',
  Applications: 'macOS Applications under the OS user home',
  Library: 'macOS Library under the OS user home',
  sessions: "Codex's rollout sessions under CODEX_HOME",
};

function productionSources(): string[] {
  const sources: string[] = [];
  for (const top of ['src-server', 'packages/shared/src', 'packages/cli/src']) {
    for (const entry of readdirSync(join(repoRoot, top), {
      recursive: true,
      withFileTypes: true,
    })) {
      if (!entry.isFile()) continue;
      const path = relative(repoRoot, join(entry.parentPath, entry.name));
      if (
        /\.(ts|mjs)$/.test(path) &&
        !/\.d\.ts$/.test(path) &&
        !/(^|\/)(__tests__|__test-utils__|test-support|node_modules|generated)\//.test(
          path,
        ) &&
        !/\.test\.[cm]?[jt]s$/.test(path)
      )
        sources.push(path);
    }
  }
  return sources;
}

function homeRootLiterals(): Map<string, string[]> {
  const pattern = new RegExp(
    `(?:join|resolve)\\(\\s*(?:[A-Za-z_]+\\.)?(?:${HOME_VARIABLES.join('|')})\\s*,\\s*['"\`]([^'"\`$]+)['"\`]`,
    'g',
  );
  const found = new Map<string, string[]>();
  for (const path of productionSources()) {
    const text = readFileSync(join(repoRoot, path), 'utf8');
    for (const match of text.matchAll(pattern)) {
      const root = match[1].split('/')[0];
      found.set(root, [...(found.get(root) ?? []), path]);
    }
  }
  return found;
}

describe('Station home store registry (#2675 D)', () => {
  it('classifies every home root that Station source joins onto a home', () => {
    const literals = homeRootLiterals();
    // The scan reaches real code: these are joined literally today.
    for (const known of ['config', 'agents', 'service', 'logs', 'security'])
      expect(literals.has(known)).toBe(true);
    const unclassified = [...literals.entries()]
      .filter(
        ([root]) =>
          classifyStationHomeRoot(root) === undefined &&
          !Object.hasOwn(NOT_STATION_HOME_ROOTS, root),
      )
      .map(([root, files]) => `${root} (${[...new Set(files)].join(', ')})`);
    expect(
      unclassified,
      'classify each new home root in station-home-store-registry.ts',
    ).toEqual([]);
  });

  it('keeps every exclusion necessary: an excluded name that is classified or unused is stale', () => {
    const literals = homeRootLiterals();
    for (const name of Object.keys(NOT_STATION_HOME_ROOTS)) {
      expect(classifyStationHomeRoot(name)).toBeUndefined();
      expect(literals.has(name)).toBe(true);
    }
  });

  it('names every SQLite store file Station source spells, each under a state root', () => {
    const registered = new Set(
      STATION_HOME_SQLITE_STORES.map((segments) => segments.at(-1)),
    );
    const spelled = new Set<string>();
    for (const path of productionSources()) {
      const text = readFileSync(join(repoRoot, path), 'utf8');
      for (const match of text.matchAll(/['"`]([a-z-]+\.sqlite)['"`]/g))
        spelled.add(match[1]);
    }
    // The scan reaches real code, and the plan's floor holds.
    expect(spelled.has('orchestration.sqlite')).toBe(true);
    expect(STATION_HOME_SQLITE_STORES.length).toBeGreaterThanOrEqual(8);
    expect([...spelled].filter((name) => !registered.has(name))).toEqual([]);
    for (const segments of STATION_HOME_SQLITE_STORES)
      expect(STATION_HOME_ROOTS[segments[0]]).toBe('state');
  });

  it('keeps the schema marker as state and the service-owned roots live', () => {
    expect(classifyStationHomeRoot('.station-home-schema.json')).toBe('state');
    for (const live of [
      'instances.json',
      'service',
      'logs',
      'monitoring',
      'quarantine',
      'tmp',
    ])
      expect(classifyStationHomeRoot(live)).toBe('live');
    // A durable-JSON sidecar follows its file.
    expect(classifyStationHomeRoot('notifications.json.previous')).toBe(
      'state',
    );
    expect(classifyStationHomeRoot('instances.json.previous')).toBe('live');
    expect(classifyStationHomeRoot('never-heard-of-it')).toBeUndefined();
  });

  it('excludes users repositories and the browser bytes from update rollback, and each path is one Station source writes (#2675 D review F1)', () => {
    expect(classifyStationHomeRoot('workspaces')).toBe('external');
    expect(STATION_HOME_EXTERNAL_PATHS.map((path) => path.join('/'))).toEqual([
      'workspaces',
      'browser/chromium',
      'browser/profiles',
    ]);
    // browser/ itself is Station's state; only the named parts are not.
    expect(classifyStationHomeRoot('browser')).toBe('state');
    expect(isExternalStationHomePath(['browser', 'sessions.json'])).toBe(false);
    expect(isExternalStationHomePath(['browser', 'profiles', 'a', 'b'])).toBe(
      true,
    );
    expect(isExternalStationHomePath(['workspaces', 'x', '.git'])).toBe(true);
    expect(containsExternalStationHomePath(['browser'])).toBe(true);
    expect(containsExternalStationHomePath(['config'])).toBe(false);
    // Each nested path is spelled by the code that writes it.
    const sources = productionSources().map((path) =>
      readFileSync(join(repoRoot, path), 'utf8'),
    );
    for (const [parent, child] of [
      ['browser', 'chromium'],
      ['browser', 'profiles'],
    ])
      expect(
        sources.some((text) =>
          new RegExp(`'${parent}',\\s*'${child}'`).test(text),
        ),
        `${parent}/${child}`,
      ).toBe(true);
    expect(
      sources.some((text) => /join\(home, 'workspaces', slug\)/.test(text)),
    ).toBe(true);
  });
});
