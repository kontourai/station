#!/usr/bin/env node
// Builds station-server-<os>-<arch> for THIS host from a built checkout
// (`npm run build` first): the pinned official Node.js, the server bundle,
// the UI, schemas and the pruned runtime node_modules, plus a JSON descriptor
// carrying the archive's sha256 and size. Nothing is published.
//
//   node scripts/build-portable-server-archive.mjs --ref v0.0.0 \
//     [--sha <40-hex>] [--created-at <ISO>] [--output-dir dist-portable-server] \
//     [--node-distribution <path to the pinned node-v*.tar.gz|zip>] [--keep-stage]
//
// The build refuses a --sha other than HEAD, and a dirty working tree.
// --allow-unverified-source lifts that for tests and local experiments only;
// such an archive's provenance is not the source of its bytes.
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  assertBuildSourceIsCheckout,
  buildPortableServerArchive,
} from './lib/portable-server-archive.mjs';

const projectRoot = process.cwd();
const { values } = parseArgs({
  options: {
    ref: { type: 'string' },
    sha: { type: 'string' },
    'created-at': { type: 'string' },
    'output-dir': { type: 'string' },
    'node-distribution': { type: 'string' },
    'keep-stage': { type: 'boolean', default: false },
    'allow-unverified-source': { type: 'boolean', default: false },
  },
  strict: true,
});

function git(args) {
  return execFileSync('git', args, {
    cwd: projectRoot,
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
}

if (!values.ref) {
  console.error(
    'error: --ref is required (vMAJOR.MINOR.PATCH or vMAJOR.MINOR.PATCH-preview.N)',
  );
  process.exit(1);
}
try {
  const sha = values.sha ?? git(['rev-parse', 'HEAD']);
  // Default to the commit time, like scripts/package-portable-release.sh, so a
  // rebuild of one commit claims one creation time.
  const createdAt =
    values['created-at'] ??
    new Date(
      Number(git(['show', '-s', '--format=%ct', sha])) * 1000,
    ).toISOString();
  if (!values['allow-unverified-source']) {
    assertBuildSourceIsCheckout({ sha, git });
  }
  const { archivePath, descriptorPath, descriptor } =
    await buildPortableServerArchive({
      projectRoot,
      ...(values['output-dir']
        ? { outputDir: resolve(values['output-dir']) }
        : {}),
      tag: values.ref,
      sha,
      createdAt,
      ...(values['node-distribution']
        ? { nodeDistribution: resolve(values['node-distribution']) }
        : {}),
      keepStage: values['keep-stage'],
    });
  console.log(`Created ${archivePath}`);
  console.log(`Created ${descriptorPath}`);
  const mib = (bytes) => `${(bytes / 1048576).toFixed(1)} MiB`;
  const summary = `${descriptor.name}: ${mib(descriptor.size)} compressed (${descriptor.size} bytes), sha256 ${descriptor.sha256}; unpacked ${mib(descriptor.unpacked.bytes)} in ${descriptor.unpacked.files} files, longest path ${descriptor.unpacked.longestRelativePath} characters`;
  console.log(summary);
  // On a CI runner, also put the measurement on the run's summary page.
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  }
} catch (error) {
  console.error(
    `error: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
