import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);

/** Read the single dependency authority. Called only after inert bootstrap. */
function readYaml(path, readFile) {
  const { parseDocument } = require('yaml');
  const document = parseDocument(readFile(path, 'utf8'), {
    uniqueKeys: true,
  });
  if (document.errors.length)
    throw new Error(`pnpm lockfile is invalid: ${document.errors[0].message}`);
  return document.toJS({ maxAliasCount: 0 });
}

export function readPnpmWorkspace(root, readFile = readFileSync) {
  const workspace = readYaml(resolve(root, 'pnpm-workspace.yaml'), readFile);
  if (!workspace || typeof workspace !== 'object' || Array.isArray(workspace))
    throw new Error('pnpm workspace has an unsupported shape');
  return workspace;
}

export function readPnpmLockfile(root, readFile = readFileSync) {
  const lock = readYaml(resolve(root, 'pnpm-lock.yaml'), readFile);
  if (
    !lock ||
    String(lock.lockfileVersion) !== '9.0' ||
    !lock.importers ||
    typeof lock.importers !== 'object' ||
    Array.isArray(lock.importers)
  ) {
    throw new Error('pnpm lockfile has an unsupported shape or version');
  }
  if (
    lock.packages === undefined &&
    Object.values(lock.importers).every(
      (importer) =>
        importer &&
        typeof importer === 'object' &&
        !Array.isArray(importer) &&
        ['dependencies', 'devDependencies', 'optionalDependencies'].every(
          (section) =>
            Object.values(importer[section] ?? {}).every(
              (dependency) =>
                typeof dependency?.version === 'string' &&
                dependency.version.startsWith('link:'),
            ),
        ),
    )
  ) {
    lock.packages = {};
    lock.snapshots ??= {};
  }
  if (
    !lock.packages ||
    typeof lock.packages !== 'object' ||
    Array.isArray(lock.packages)
  )
    throw new Error('pnpm lockfile has an unsupported packages map');
  return lock;
}

export const readPnpmLock = readPnpmLockfile;
