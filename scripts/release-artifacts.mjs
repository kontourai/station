#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  assertOnlyExpectedAssets,
  createReleaseInventory,
  readInventory,
  validateReleaseInventory,
  writeChecksums,
} from './lib/release-artifacts.mjs';
import { canonicalJson } from './lib/release-sboms.mjs';

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing ${name}`);
  return process.argv[index + 1];
}

function optionalOption(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function updaterPublicKey() {
  return (
    optionalOption('--updater-public-key') ??
    process.env.TAURI_SIGNING_PUBLIC_KEY
  );
}

function sbomContext() {
  return JSON.parse(readFileSync(resolve(option('--sbom-context')), 'utf8'));
}

try {
  const command = process.argv[2];
  if (command === 'assemble') {
    const assetsDir = resolve(option('--assets-dir'));
    const output = resolve(option('--output'));
    const inventory = createReleaseInventory({
      tag: option('--tag'),
      sourceSha: option('--sha'),
      generatedAt: option('--generated-at'),
      assetsDir,
      dependencyLifecycle: sbomContext().dependencyLifecycle,
      containerDescriptor: resolve(option('--container-descriptor')),
      updaterPublicKey: updaterPublicKey(),
    });
    assertOnlyExpectedAssets(assetsDir, inventory.tag);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, canonicalJson(inventory));
    writeChecksums(inventory, assetsDir);
  } else if (command === 'validate') {
    const inventory = readInventory(resolve(option('--inventory')));
    validateReleaseInventory(inventory, {
      assetsDir: resolve(option('--assets-dir')),
      containerDescriptor: resolve(option('--container-descriptor')),
      updaterPublicKey: updaterPublicKey(),
    });
    assertOnlyExpectedAssets(resolve(option('--assets-dir')), inventory.tag);
  } else {
    throw new Error('Usage: release-artifacts.mjs <assemble|validate> ...');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
