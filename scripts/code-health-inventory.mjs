import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';

const KINDS = new Map([
  ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'].map(
    (ext) => [ext, 'javascript-typescript'],
  ),
  ...['.rs', '.swift', '.kt', '.c', '.cpp', '.h', '.m', '.mm'].map((ext) => [
    ext,
    'native',
  ]),
  ...['.html', '.vue', '.svelte'].map((ext) => [ext, 'markup']),
  ...['.sh', '.ps1'].map((ext) => [ext, 'shell']),
  ...['.css', '.scss'].map((ext) => [ext, 'styles']),
  ...['.json', '.yaml', '.yml', '.toml'].map((ext) => [ext, 'configuration']),
]);

/** Git supplies the scope; links are inventoried without following them outside it. */
export function inventoryCodeHealthFiles(root, paths) {
  const files = [];
  for (const path of [...new Set(paths)].sort()) {
    let kind = KINDS.get(extname(path)) ?? 'other';
    const target = resolve(root, path);
    const inside = relative(resolve(root), target);
    if (
      !inside ||
      inside === '..' ||
      inside.startsWith(`..${sep}`) ||
      isAbsolute(inside)
    )
      throw new Error(`Inventory path leaves its root: ${path}`);
    let info;
    try {
      info = lstatSync(target);
    } catch (error) {
      if (error.code === 'ENOENT') {
        files.push({ path, kind, status: 'missing' });
        continue;
      }
      throw error;
    }
    if (info.isSymbolicLink()) {
      files.push({
        path,
        kind,
        status: 'link-not-followed',
        target: readlinkSync(target),
      });
      continue;
    }
    if (!info.isFile() || info.size > 32 * 1024 * 1024) {
      files.push({
        path,
        kind,
        status: 'not-read',
        reason: info.isFile() ? 'over-32-MiB' : 'not-a-regular-file',
      });
      continue;
    }
    const bytes = readFileSync(target);
    if (kind === 'other' && bytes[0] === 35 && bytes[1] === 33)
      kind = 'launcher';
    if (
      ['Dockerfile', 'Containerfile', 'justfile', 'Makefile'].includes(
        path.split('/').pop(),
      )
    )
      kind = 'configuration';
    const binary = bytes.includes(0);
    files.push({
      path,
      kind,
      status: 'inventoried',
      binary,
      mode: info.mode,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
      lines: binary
        ? undefined
        : bytes.reduce((sum, byte) => sum + (byte === 10 ? 1 : 0), 0),
      test:
        /(__tests__\/|\.(test|spec)\.)/.test(path) || path.startsWith('tests/'),
    });
  }
  return {
    schemaVersion: 1,
    files,
    qualification:
      'Inventory is not manual review or runtime coverage. Analyzer reports retain their own language and configuration limits.',
  };
}
