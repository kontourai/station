#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { generateReleaseSboms } from './lib/release-sbom-generation.mjs';

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing ${name}`);
  return process.argv[index + 1];
}

try {
  const context = JSON.parse(
    readFileSync(resolve(option('--context')), 'utf8'),
  );
  generateReleaseSboms({
    assetsDir: resolve(option('--assets-dir')),
    fragmentsDir: resolve(option('--fragments-dir')),
    context,
    fragments: {
      npm: resolve(option('--npm-fragment')),
      rust: resolve(option('--rust-fragment')),
      container: resolve(option('--container-fragment')),
    },
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
