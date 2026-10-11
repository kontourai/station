import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);

const parsedYaml = new Map();
const MAX_PARSED_YAML_ENTRIES = 2;
const MAX_PARSED_YAML_BYTES = 2 * 1024 * 1024;
let parsedYamlBytes = 0;

/** Read the single dependency authority. Called only after inert bootstrap. */
function readYaml(path, readFile) {
  const text = readFile(path, 'utf8');
  if (parsedYaml.has(text)) return structuredClone(parsedYaml.get(text));
  const { parseDocument } = require('yaml');
  const document = parseDocument(text, { uniqueKeys: true });
  if (document.errors.length)
    throw new Error(`pnpm lockfile is invalid: ${document.errors[0].message}`);
  const value = document.toJS({ maxAliasCount: 0 });
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= MAX_PARSED_YAML_BYTES) {
    while (
      parsedYaml.size >= MAX_PARSED_YAML_ENTRIES ||
      parsedYamlBytes + bytes > MAX_PARSED_YAML_BYTES
    ) {
      const oldest = parsedYaml.keys().next().value;
      parsedYamlBytes -= Buffer.byteLength(oldest, 'utf8');
      parsedYaml.delete(oldest);
    }
    parsedYaml.set(text, value);
    parsedYamlBytes += bytes;
  }
  return structuredClone(value);
}

/** @param {string} root @param {(path: string, encoding: 'utf8') => string} [readFile] */
export function readPnpmWorkspace(root, readFile = readFileSync) {
  const workspace = readYaml(resolve(root, 'pnpm-workspace.yaml'), readFile);
  if (!workspace || typeof workspace !== 'object' || Array.isArray(workspace))
    throw new Error('pnpm workspace has an unsupported shape');
  return workspace;
}

/** @param {string} root @param {(path: string, encoding: 'utf8') => string} [readFile] */
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
