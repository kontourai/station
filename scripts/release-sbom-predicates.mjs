#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SBOM_ASSETS } from './lib/release-sboms.mjs';

function fail(message) {
  throw new Error(`Invalid release SBOM predicates: ${message}`);
}

function expected(scope) {
  return scope === 'portable'
    ? 'npm/runtime'
    : scope === 'container'
      ? 'container/image'
      : 'npm/runtime,rust/native';
}

export function validateReleaseSbomPredicates(root) {
  for (const [scope, asset] of Object.entries(SBOM_ASSETS)) {
    const value = JSON.parse(readFileSync(join(root, asset), 'utf8'));
    const actual =
      scope === 'container'
        ? value.documentComment
            ?.split(';', 1)[0]
            .replace('station:fragment-predicates=', '')
        : value.metadata?.properties?.find(
            (item) => item?.name === 'station:fragment-predicates',
          )?.value;
    if (actual !== expected(scope))
      fail(`${scope} scope has ${actual ?? 'no'} exact predicate`);
  }
}

if (process.argv[1]?.endsWith('release-sbom-predicates.mjs')) {
  try {
    const index = process.argv.indexOf('--assets-dir');
    if (index < 0 || !process.argv[index + 1]) fail('missing --assets-dir');
    const root = resolve(process.argv[index + 1]);
    validateReleaseSbomPredicates(root);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
