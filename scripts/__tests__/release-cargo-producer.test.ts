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

afterEach(() => {
  if (existsSync(output)) rmSync(output);
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
    expect(source.components).toHaveLength(561);
    const components = cyclonedxComponents(source, 'cargo', output);
    expect(components).toHaveLength(561);
    expect(JSON.stringify(components)).not.toMatch(/file:|\/private\//);
    expect(components).toContainEqual(
      expect.objectContaining({
        name: 'android-native-keyring-store',
        purl: 'pkg:cargo/android-native-keyring-store@1.0.0',
      }),
    );
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
