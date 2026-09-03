import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { load } from 'js-yaml';
import { afterEach, expect, test } from 'vitest';
import { cyclonedxComponents } from '../release-sbom-fragments.mjs';

const root = resolve(import.meta.dirname, '../..');
const native = resolve(root, 'src-desktop');
const output = resolve(native, 'station.cdx.json');
const release = readFileSync(
  resolve(root, '.github/workflows/release.yml'),
  'utf8',
);

// The proof executes the LITERAL workflow producer command, which needs the
// release toolchain on THIS machine: bash (the workflow's ubuntu default
// shell — not zsh, which was an author's-machine artifact and is absent on
// lean Linux runners) plus cargo with the cyclonedx producer installed.
// Absent toolchain = skip with the reason named, not a red that reads as a
// product failure (green-because-of-the-dev-machine, inverted).
const hasProducerToolchain =
  spawnSync('bash', ['-c', 'command -v cargo'], { stdio: 'ignore' }).status ===
    0 &&
  spawnSync('bash', ['-c', 'cargo cyclonedx --version'], { stdio: 'ignore' })
    .status === 0;

function producerCommand(source = release) {
  const workflow: any = load(source);
  const step = workflow.jobs?.['assemble-draft']?.steps?.find(
    (candidate: any) =>
      candidate.name === 'Generate canonical SBOM fragments and assets',
  );
  const run = step?.run;
  if (typeof run !== 'string') throw new Error('missing SBOM producer step');
  const match = run.match(
    /^\s*(\(cd src-desktop && cargo cyclonedx[^\n]+\))\s*$/m,
  );
  if (
    !match ||
    !/test -s src-desktop\/station\.cdx\.json/.test(run) ||
    !/cp src-desktop\/station\.cdx\.json/.test(run)
  )
    throw new Error(
      'Cargo producer command or its exact output consumption is missing',
    );
  for (const token of [
    '--format json',
    '--spec-version 1.5',
    '--target all',
    '--override-filename station.cdx',
  ])
    if (!match[1].includes(token))
      throw new Error(`Cargo producer is missing ${token}`);
  return match[1];
}

type LockedCargoPackage = { name: string; version: string };
type NormalizedComponent = {
  name?: unknown;
  version?: unknown;
  purl?: unknown;
};

function lockedCargoPackages(
  source = readFileSync(resolve(native, 'Cargo.lock'), 'utf8'),
): LockedCargoPackage[] {
  const blocks = source.split(/^\[\[package\]\]\r?$/m).slice(1);
  if (blocks.length === 0) {
    throw new Error('Cargo.lock has no package records');
  }
  return blocks.map((block) => {
    const name = /^name = "([^"]+)"$/m.exec(block)?.[1];
    const version = /^version = "([^"]+)"$/m.exec(block)?.[1];
    if (!name || !version) {
      throw new Error('Cargo.lock package record is missing name or version');
    }
    return { name, version };
  });
}

function resolvedCargoPackages(
  source = execFileSync(
    'cargo',
    [
      'metadata',
      '--locked',
      '--format-version',
      '1',
      '--manifest-path',
      resolve(native, 'Cargo.toml'),
    ],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 120_000 },
  ),
): LockedCargoPackage[] {
  const metadata = JSON.parse(source);
  if (
    !Array.isArray(metadata.packages) ||
    !Array.isArray(metadata.resolve?.nodes)
  )
    throw new Error('Cargo metadata has no resolved package graph');
  const packages = new Map(
    metadata.packages.map((value: any) => [value?.id, value]),
  );
  return metadata.resolve.nodes.map(({ id }: any) => {
    const value: any = packages.get(id);
    if (
      typeof value?.name !== 'string' ||
      !value.name ||
      typeof value?.version !== 'string' ||
      !value.version
    )
      throw new Error('Cargo metadata resolved an unknown package');
    return { name: value.name, version: value.version };
  });
}

function exactlyOneLockedPackage(
  lockedPackages: LockedCargoPackage[],
  name: string,
): LockedCargoPackage {
  const matches = lockedPackages.filter((locked) => locked.name === name);
  if (matches.length !== 1) {
    throw new Error(`Cargo.lock must contain exactly one ${name} record`);
  }
  return matches[0];
}

afterEach(() => {
  if (existsSync(output)) rmSync(output);
});

test('Cargo.lock has exactly one root and required plugin record', () => {
  const lockedPackages = lockedCargoPackages();
  expect(exactlyOneLockedPackage(lockedPackages, 'station')).toMatchObject({
    name: 'station',
  });
  for (const name of ['tauri-plugin-process', 'tauri-plugin-updater']) {
    expect(exactlyOneLockedPackage(lockedPackages, name)).toMatchObject({
      name,
    });
  }
});

test('Cargo.lock parser and root/plugin uniqueness fail closed', () => {
  expect(() => lockedCargoPackages('version = 4\n')).toThrow(
    'Cargo.lock has no package records',
  );
  expect(() => lockedCargoPackages('[[package]]\nname = "station"\n')).toThrow(
    'Cargo.lock package record is missing name or version',
  );

  const duplicateRoot = lockedCargoPackages(`
[[package]]
name = "station"
version = "0.1.2"

[[package]]
name = "station"
version = "0.1.2"
`);
  expect(() => exactlyOneLockedPackage(duplicateRoot, 'station')).toThrow(
    'Cargo.lock must contain exactly one station record',
  );

  const duplicatePlugin = lockedCargoPackages(`
[[package]]
name = "tauri-plugin-process"
version = "2.3.1"

[[package]]
name = "tauri-plugin-process"
version = "2.3.2"
`);
  expect(() =>
    exactlyOneLockedPackage(duplicatePlugin, 'tauri-plugin-process'),
  ).toThrow('Cargo.lock must contain exactly one tauri-plugin-process record');
});

test('resolved Cargo graph parser fails closed on incomplete metadata', () => {
  expect(() => resolvedCargoPackages('{}')).toThrow(
    'Cargo metadata has no resolved package graph',
  );
  expect(() =>
    resolvedCargoPackages(
      JSON.stringify({ packages: [], resolve: { nodes: [{ id: 'missing' }] } }),
    ),
  ).toThrow('Cargo metadata resolved an unknown package');
});

test.skipIf(!hasProducerToolchain)(
  'cargo-cyclonedx proof executes the literal workflow producer command and public-safe graph (skips where the release toolchain is absent)',
  () => {
    execFileSync('bash', ['-c', producerCommand()], {
      cwd: root,
      timeout: 120_000,
      stdio: 'pipe',
    });
    const source = JSON.parse(readFileSync(output, 'utf8'));
    expect(source.specVersion).toBe('1.5');
    // Cargo.lock may retain unreachable historical records. The authoritative
    // completeness boundary for the producer is Cargo's exact locked resolved
    // graph, which cargo-cyclonedx consumes, not every record in the lockfile.
    const resolvedPackages = resolvedCargoPackages();
    exactlyOneLockedPackage(resolvedPackages, 'station');
    const expectedDependencyComponents = resolvedPackages.length - 1;
    expect(source.components).toHaveLength(expectedDependencyComponents);
    const components = cyclonedxComponents(source, 'cargo', output);
    expect(components).toHaveLength(expectedDependencyComponents);
    expect(JSON.stringify(components)).not.toMatch(/file:|\/private\//);
    expect(components).toContainEqual(
      expect.objectContaining({
        name: 'android-native-keyring-store',
        purl: 'pkg:cargo/android-native-keyring-store@1.0.0',
      }),
    );
    const pluginNames = ['tauri-plugin-process', 'tauri-plugin-updater'];
    const expectedPlugins = pluginNames
      .map((name) => {
        const locked = exactlyOneLockedPackage(resolvedPackages, name);
        return {
          name,
          version: locked.version,
          purl: `pkg:cargo/${name}@${locked.version}`,
        };
      })
      .sort((left, right) =>
        `${left.name}@${left.version}`.localeCompare(
          `${right.name}@${right.version}`,
        ),
      );
    const normalizedPlugins = (components as NormalizedComponent[])
      .filter(
        (component) =>
          typeof component.name === 'string' &&
          pluginNames.includes(component.name),
      )
      .map((component) => ({
        name: component.name,
        version: component.version,
        purl: component.purl,
      }))
      .sort((left, right) =>
        `${left.name}@${left.version}`.localeCompare(
          `${right.name}@${right.version}`,
        ),
      );
    expect(normalizedPlugins).toEqual(expectedPlugins);
  },
  120_000,
);

test.each([
  ['format', '--format json', '--format xml'],
  ['specification', '--spec-version 1.5', '--spec-version 1.4'],
  ['target', '--target all', '--target x86_64-unknown-linux-gnu'],
  ['filename', '--override-filename station.cdx', '--override-filename bom'],
  ['consumption', 'cp src-desktop/station.cdx.json', 'cp src-desktop/bom.json'],
])('rejects workflow Cargo producer mutation: %s', (_name, from, to) => {
  expect(() => producerCommand(release.replace(from, to))).toThrow();
});

test('fragment converter import is inert under hostile empty argv', () => {
  const result = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      "process.argv = []; await import('./scripts/release-sbom-fragments.mjs');",
    ],
    { cwd: root, encoding: 'utf8', timeout: 10_000 },
  );
  expect(result).toBe('');
  expect(process.exitCode).not.toBe(1);
});
