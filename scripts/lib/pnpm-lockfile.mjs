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

/**
 * Dependency-free read of the lockfile's importer keys (workspace directories)
 * for the cold bootstrap check, which runs before `yaml` is installed. pnpm
 * writes `importers` as a block map whose keys sit at two-space indentation;
 * `readLifecycleImporters` re-reads the same keys through the full parser and
 * refuses to proceed when the two readers disagree.
 * @param {string} root
 * @param {(path: string, encoding: 'utf8') => string} [readFile]
 * @returns {Set<string>}
 */
export function readPnpmLockfileImporters(root, readFile = readFileSync) {
  const lines = readFile(resolve(root, 'pnpm-lock.yaml'), 'utf8').split(
    /\r?\n/,
  );
  const start = lines.findIndex((line) => line.startsWith('importers:'));
  if (start === -1) throw new Error('pnpm lockfile has no importers map');
  const inline = lines[start].slice('importers:'.length).trim();
  if (inline === '{}') return new Set();
  if (inline !== '')
    throw new Error('pnpm lockfile importers map has an unsupported shape');
  const importers = new Set();
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const match = /^ {2}(\S.*?):(.*)$/.exec(line);
    if (!match) continue;
    // pnpm writes a dependency-less importer (including the root) inline as
    // `<dir>: {}`; any other inline value is a shape this reader does not
    // understand and must not silently drop.
    const inlineValue = match[2].trim();
    if (inlineValue !== '' && inlineValue !== '{}')
      throw new Error(
        `pnpm lockfile importer ${match[1]} has an unsupported inline value`,
      );
    const key = match[1];
    importers.add(/^(['"]).*\1$/.test(key) ? key.slice(1, -1) : key);
  }
  return importers;
}
