import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, lstat, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, win32 } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { runMediaProcess } from './media-process.js';
import type { MediaToolAsset } from './media-tools-pins.js';

function unsafePath(name: string): boolean {
  return (
    [...name].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
    /[\\:]/.test(name) ||
    name.startsWith('/') ||
    name.split('/').includes('..')
  );
}

async function checkTree(root: string, dir = root): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const rel = relative(await realpath(root), await realpath(path));
    if (entry.isSymbolicLink() || rel.startsWith('..') || isAbsolute(rel))
      throw new Error('Archive link escape refused.');
    if (entry.isDirectory()) await checkTree(root, path);
    else if (!(await lstat(path)).isFile())
      throw new Error('Archive special entry refused.');
  }
}

/** Native tar handles bz2; pinned bundles need neither symlinks nor special files. */
export async function extractMediaAsset(
  asset: MediaToolAsset,
  archive: string,
  dest: string,
): Promise<void> {
  if (asset.format !== 'tar.bz2') {
    if (!asset.output || unsafePath(asset.output))
      throw new Error('Unsafe archive output path.');
    let bytes = 0;
    const bound = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.byteLength;
        callback(
          bytes > 256 * 1024 * 1024
            ? new Error('Expanded media tool exceeds byte limit.')
            : null,
          chunk,
        );
      },
    });
    await pipeline(
      createReadStream(archive),
      ...(asset.format === 'gzip' ? [createGunzip()] : []),
      bound,
      createWriteStream(join(dest, asset.output), { flags: 'wx', mode: 0o700 }),
    );
    await chmod(join(dest, asset.output), 0o700);
    return;
  }
  const tar =
    process.platform === 'win32'
      ? win32.join(
          process.env.SystemRoot ?? 'C:\\Windows',
          'System32',
          'tar.exe',
        )
      : '/usr/bin/tar';
  const names = await runMediaProcess(tar, ['-tf', archive], {
    timeoutMs: 120_000,
  });
  if (names.stdout.split(/\r?\n/).filter(Boolean).some(unsafePath))
    throw new Error('Archive traversal refused.');
  const types = await runMediaProcess(tar, ['-tvf', archive], {
    timeoutMs: 120_000,
  });
  // Reject before extraction: even an internal link could redirect a later write.
  if (
    types.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .some((line) => !['-', 'd'].includes(line[0] ?? ''))
  )
    throw new Error('Archive link or special entry refused.');
  await runMediaProcess(tar, ['-xf', archive, '-C', dest], {
    timeoutMs: 120_000,
  });
  await checkTree(dest);
}
