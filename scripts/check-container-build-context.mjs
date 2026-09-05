#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Exercise Docker's actual ignore semantics; source allowlists must never
// overlay a Linux install with a contributor's host dependencies/build output.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync(join(tmpdir(), 'station-container-context-'));
try {
  const context = join(scratch, 'context');
  const output = join(scratch, 'output');
  mkdirSync(context);
  copyFileSync(join(root, '.dockerignore'), join(context, '.dockerignore'));
  writeFileSync(
    join(context, 'Dockerfile'),
    'FROM scratch\nCOPY packages /packages\nCOPY examples /examples\n',
  );
  const sourceFiles = [
    'packages/cli/src/cli.ts',
    'examples/fieldwork-review/src/index.tsx',
  ];
  const generatedFiles = [
    'packages/cli/node_modules/host-only/package.json',
    'packages/cli/dist/station.mjs',
    'examples/fieldwork-review/node_modules/host-only/package.json',
    'examples/fieldwork-review/dist/index.js',
  ];
  for (const path of [...sourceFiles, ...generatedFiles]) {
    const target = join(context, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, 'container context canary\n');
  }
  const result = spawnSync(
    'docker',
    ['build', '--output', `type=local,dest=${output}`, context],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 120_000,
    },
  );
  if (result.error || result.status !== 0)
    throw new Error(
      `Docker context probe failed: ${result.error?.message ?? result.stderr}`,
    );
  for (const path of sourceFiles)
    if (!existsSync(join(output, path)))
      throw new Error(`Container context omitted source: ${path}`);
  for (const path of generatedFiles)
    if (existsSync(join(output, path)))
      throw new Error(
        `Container context admitted host-generated content: ${path}`,
      );
  console.log(
    'Container context passed: source admitted, host dependencies and builds excluded.',
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
