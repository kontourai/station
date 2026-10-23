import { createHash, createVerify } from 'node:crypto';
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const VERSION = '11.25.0';
const METADATA_URL = `https://registry.npmjs.org/pnpm/${VERSION}`;
const ARCHIVE_URL = `https://registry.npmjs.org/pnpm/-/pnpm-${VERSION}.tgz`;
const INTEGRITY =
  'sha512-XN6SW08HX3Jetx+64YpC/+eEUkeJ8ZthxzHLhyHsKKruFg4BqNWvT+2ypCzb8wDv4j2zVrDUoXtNY+EfirfJVg==';
// Same non-expiring npm registry root pinned by get-pnpm in pnpm/setup
// a0881977cd8ea73b1ed212236c99ca10dcc80cf4. Key rotation requires review.
const KEY_ID = 'SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U';
const KEY =
  'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEY6Ya7W++7aUPzvMTrezH6Ycx3c+HOKYCcNGybJZSCJq/fd7Qa8uuAKtdIkUQtQiEKERhAmE5lMMJhP8OkDOa2g==';

export function verifyMetadata(metadata) {
  if (
    metadata?.name !== 'pnpm' ||
    metadata.version !== VERSION ||
    metadata.dist?.tarball !== ARCHIVE_URL ||
    metadata.dist?.integrity !== INTEGRITY
  ) {
    throw new Error(
      'pnpm package identity, version, origin or pinned integrity differs',
    );
  }
  const signature = metadata.dist.signatures?.find(
    (entry) => entry.keyid === KEY_ID,
  );
  if (
    !signature ||
    !createVerify('SHA256')
      .update(`pnpm@${VERSION}:${INTEGRITY}`)
      .verify(
        `-----BEGIN PUBLIC KEY-----\n${KEY}\n-----END PUBLIC KEY-----`,
        signature.sig,
        'base64',
      )
  ) {
    throw new Error(
      'pnpm npm registry signature did not verify against the pinned root',
    );
  }
}

export function verifyArchive(bytes) {
  if (
    `sha512-${createHash('sha512').update(bytes).digest('base64')}` !==
    INTEGRITY
  ) {
    throw new Error('pnpm archive integrity differs');
  }
}

async function download(url, limit) {
  const response = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok || !response.body)
    throw new Error(`pnpm download failed: HTTP ${response.status}`);
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > limit) throw new Error('pnpm download exceeds its size bound');
      chunks.push(chunk);
    }
  } catch (error) {
    await response.body.cancel().catch(() => {});
    throw error;
  }
  return Buffer.concat(chunks);
}

function octal(header, start, length) {
  const value = header
    .subarray(start, start + length)
    .toString('ascii')
    .replace(/\0.*$/, '')
    .trim();
  if (!/^[0-7]+$/.test(value)) throw new Error('Invalid pnpm tar number');
  return Number.parseInt(value, 8);
}

/** Only regular package files are accepted; links and extended headers fail closed. */
export function packageFiles(archive) {
  const tar = gunzipSync(archive, { maxOutputLength: 32 * 1024 * 1024 });
  const files = new Map();
  for (let offset = 0; offset < tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.length !== 512) throw new Error('Truncated pnpm tar header');
    if (header.every((byte) => byte === 0)) {
      if (!tar.subarray(offset).every((byte) => byte === 0))
        throw new Error('Unexpected pnpm tar trailer');
      return files;
    }
    let checksum = 0;
    for (let index = 0; index < 512; index++)
      checksum += index >= 148 && index < 156 ? 32 : header[index];
    if (checksum !== octal(header, 148, 8))
      throw new Error('Invalid pnpm tar checksum');
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const prefix = header
      .subarray(345, 500)
      .toString('utf8')
      .replace(/\0.*$/, '');
    const path = prefix ? `${prefix}/${name}` : name;
    if (
      !path.startsWith('package/') ||
      path.includes('\\') ||
      posix.normalize(path) !== path ||
      path.split('/').some((part) => part === '..' || part === '') ||
      files.has(path)
    ) {
      throw new Error('Unsafe or duplicate pnpm tar path');
    }
    if (header[156] !== 0 && header[156] !== 48)
      throw new Error('pnpm tar entry is not a regular file');
    const size = octal(header, 124, 12);
    const start = offset + 512;
    if (start + size > tar.length) throw new Error('Truncated pnpm tar file');
    files.set(path, {
      bytes: tar.subarray(start, start + size),
      mode: octal(header, 100, 8) & 0o111 ? 0o755 : 0o644,
    });
    offset = start + Math.ceil(size / 512) * 512;
  }
  throw new Error('Missing pnpm tar trailer');
}

export async function installVerifiedPnpm() {
  const manifest = JSON.parse(await readFile('package.json', 'utf8'));
  if (manifest.packageManager !== `pnpm@${VERSION}`)
    throw new Error('Station must pin pnpm 11.25.0 exactly');
  const metadata = JSON.parse(
    (await download(METADATA_URL, 128 * 1024)).toString('utf8'),
  );
  verifyMetadata(metadata);
  const archive = await download(ARCHIVE_URL, 16 * 1024 * 1024);
  verifyArchive(archive);
  const files = packageFiles(archive);
  const packaged = JSON.parse(
    files.get('package/package.json')?.bytes.toString('utf8') ?? 'null',
  );
  if (
    packaged?.name !== 'pnpm' ||
    packaged.version !== VERSION ||
    !files.has('package/bin/pnpm.cjs') ||
    !files.has('package/bin/pnpm.mjs')
  ) {
    throw new Error('Verified pnpm archive has an unexpected package layout');
  }
  const root = await mkdtemp(
    join(process.env.RUNNER_TEMP ?? tmpdir(), 'station-verified-pnpm-'),
  );
  try {
    for (const [name, file] of files) {
      const target = join(
        root,
        'node_modules',
        'pnpm',
        name.slice('package/'.length),
      );
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.bytes, { flag: 'wx', mode: file.mode });
    }
    for (const [alias, script] of [
      ['pnpm', 'pnpm.cjs'],
      ['pn', 'pnpm.cjs'],
      ['pnpx', 'pnpx.cjs'],
      ['pnx', 'pnpx.cjs'],
    ]) {
      const relative = `node_modules/pnpm/bin/${script}`;
      await chmod(join(root, relative), 0o755);
      if (process.platform === 'win32') {
        await writeFile(
          join(root, `${alias}.cmd`),
          `@ECHO OFF\r\nnode "%~dp0${relative.replaceAll('/', '\\')}" %*\r\n`,
        );
        await writeFile(
          join(root, alias),
          `#!/bin/sh\nbasedir=$(dirname "$0")\nexec node "$basedir/${relative}" "$@"\n`,
          { mode: 0o755 },
        );
      } else {
        await symlink(relative, join(root, alias));
      }
    }
    if (!process.env.GITHUB_PATH || !process.env.GITHUB_ENV)
      throw new Error('GitHub environment files are required');
    await appendFile(process.env.GITHUB_PATH, `${root}\n`);
    await appendFile(
      process.env.GITHUB_ENV,
      `PNPM_HOME=${root}\nPNPM_CONFIG_GLOBAL_SHIMS={"node":false}\n`,
    );
    console.log(
      `Verified npm signature and pinned SHA512 for pnpm@${VERSION}; installed ${root}`,
    );
    return root;
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await installVerifiedPnpm();
}
