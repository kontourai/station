import {
  cpSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { execFileSyncBounded } from './bounded-capture.mjs';

const MANIFEST = 'examples/registry/default.json';

/** Stage the reviewed catalog and its local targets, never ignored build-host files. */
export function stageBundledRegistry({ projectRoot, outputRoot }) {
  const root = realpathSync(projectRoot);
  const manifestPath = join(root, MANIFEST);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.version !== 1)
    throw new Error('Bundled registry must use manifest version 1');
  const roots = new Set([MANIFEST]);
  for (const entries of Object.values(manifest).filter(Array.isArray)) {
    for (const entry of entries) {
      if (typeof entry.source !== 'string')
        throw new Error('Bundled registry entry is missing its source');
      if (/^https?:\/\//i.test(entry.source)) continue;
      if (isAbsolute(entry.source))
        throw new Error(
          `Bundled registry source must be relative: ${entry.source}`,
        );
      const source = resolve(dirname(manifestPath), entry.source);
      const local = relative(join(root, 'examples'), source);
      if (isAbsolute(local) || local === '..' || local.startsWith(`..${sep}`))
        throw new Error(
          `Bundled registry source escapes examples: ${entry.source}`,
        );
      roots.add(relative(root, source).split(sep).join('/'));
    }
  }
  const paths = execFileSyncBounded(
    'git',
    ['--literal-pathspecs', 'ls-files', '-z', '--', ...roots],
    { cwd: root, encoding: 'utf8', windowsHide: true },
  )
    .split('\0')
    .filter(Boolean);
  const tracked = new Set(paths);
  if (!tracked.has(MANIFEST))
    throw new Error('Bundled registry manifest must be tracked');
  for (const source of roots) {
    if (!paths.some((path) => path === source || path.startsWith(`${source}/`)))
      throw new Error(
        `Bundled registry source has no tracked files: ${source}`,
      );
  }
  for (const path of paths) {
    const source = join(root, path);
    const actual = realpathSync(source);
    const actualLocal = relative(root, actual).split(sep).join('/');
    const info = lstatSync(source);
    if (!tracked.has(actualLocal))
      throw new Error(`Bundled registry source escapes staged files: ${path}`);
    if (info.isSymbolicLink()) {
      if (isAbsolute(readlinkSync(source)))
        throw new Error(`Bundled registry link escapes staged files: ${path}`);
    } else if (!info.isFile()) {
      throw new Error(`Bundled registry source is not a regular file: ${path}`);
    }
    const destination = join(outputRoot, path);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination, { dereference: false, verbatimSymlinks: true });
  }
}
