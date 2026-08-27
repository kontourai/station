import { constants } from 'node:fs';
import { lstat, open, readdir, stat } from 'node:fs/promises';

const decoder = new TextDecoder('utf-8', { fatal: true });

function fail() {
  throw new Error('bound directory enumeration unavailable');
}

function identity(value) {
  return {
    dev: Number(value.dev),
    ino: Number(value.ino),
    nlink: Number(value.nlink),
    size: Number(value.size),
    mtimeMs: Number(value.mtimeMs),
    ctimeMs: Number(value.ctimeMs),
  };
}

function sameIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function safeName(name) {
  if (
    typeof name !== 'string' ||
    name === '' ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('\0') ||
    name.includes('\ufffd')
  )
    return false;
  const bytes = Buffer.from(name, 'utf8');
  return bytes.byteLength <= 255 && decoder.decode(bytes) === name;
}

async function readInput() {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.byteLength;
    if (total > 16 * 1024) fail();
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    fail();
  }
}

async function readFile(name, expected, fileBytes) {
  if (!constants.O_NOFOLLOW) fail();
  const handle = await open(name, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      !sameIdentity(identity(opened), expected) ||
      opened.size > fileBytes
    )
      fail();
    const content = Buffer.alloc(opened.size + 1);
    let offset = 0;
    while (offset < content.byteLength) {
      const { bytesRead } = await handle.read(
        content,
        offset,
        content.byteLength - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const afterOpen = await handle.stat();
    const afterPath = await lstat(name);
    if (
      offset !== opened.size ||
      !sameIdentity(identity(afterOpen), expected) ||
      afterPath.isSymbolicLink() ||
      !afterPath.isFile() ||
      afterPath.nlink !== 1 ||
      !sameIdentity(identity(afterPath), expected)
    )
      fail();
    return content.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

async function main() {
  const input = await readInput();
  if (input?.intent === 'publishBoundDirectoryFileExclusive') {
    return publishExclusive(input);
  }
  if (input?.intent !== 'enumerateBoundDirectory') fail();
  const expected = input?.expected;
  const limits = input?.limits;
  if (
    !expected ||
    !limits ||
    !Number.isSafeInteger(limits.entries) ||
    limits.entries < 0 ||
    !Number.isSafeInteger(limits.fileBytes) ||
    limits.fileBytes < 0 ||
    !Number.isSafeInteger(limits.totalBytes) ||
    limits.totalBytes < 0
  )
    fail();
  const initial = identity(await stat('.'));
  if (!sameIdentity(initial, expected)) fail();
  const names = await readdir('.');
  if (names.length > limits.entries || !names.every(safeName)) fail();
  names.sort((left, right) =>
    Buffer.compare(Buffer.from(left), Buffer.from(right)),
  );
  const entries = [];
  let totalBytes = 0;
  for (const name of names) {
    let listed;
    try {
      listed = await lstat(name);
    } catch {
      fail();
    }
    if (listed.isSymbolicLink()) {
      entries.push({ name, kind: 'symlink' });
      continue;
    }
    if (listed.isDirectory()) {
      entries.push({ name, kind: 'directory', identity: identity(listed) });
      continue;
    }
    if (!listed.isFile()) {
      entries.push({ name, kind: 'special-file' });
      continue;
    }
    if (listed.nlink !== 1) {
      entries.push({ name, kind: 'hard-link' });
      continue;
    }
    if (listed.size > limits.fileBytes) {
      entries.push({ name, kind: 'file-size-limit' });
      continue;
    }
    if (totalBytes + listed.size > limits.totalBytes) {
      entries.push({ name, kind: 'total-size-limit' });
      continue;
    }
    const entryIdentity = identity(listed);
    let content;
    try {
      content = await readFile(name, entryIdentity, limits.fileBytes);
    } catch {
      entries.push({ name, kind: 'unreadable' });
      continue;
    }
    totalBytes += content.byteLength;
    entries.push({
      name,
      kind: 'file',
      identity: entryIdentity,
      bytes: content.toString('base64'),
    });
  }
  if (!sameIdentity(identity(await stat('.')), expected)) fail();
  process.stdout.write(JSON.stringify({ entries }));
}

async function publishExclusive(input) {
  const { expected, name, bytes: encoded, maxBytes } = input ?? {};
  if (
    !expected ||
    !safeName(name) ||
    typeof encoded !== 'string' ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 0 ||
    !constants.O_NOFOLLOW
  )
    fail();
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.byteLength > maxBytes || bytes.toString('base64') !== encoded)
    fail();
  if (!sameIdentity(identity(await stat('.')), expected)) fail();
  let handle;
  try {
    handle = await open(
      name,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if (error?.code === 'EEXIST') {
      process.stdout.write(
        JSON.stringify({
          result: 'exists',
          identity: identity(await stat('.')),
        }),
      );
      return;
    }
    fail();
  }
  try {
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesWritten } = await handle.write(
        bytes,
        offset,
        bytes.byteLength - offset,
        offset,
      );
      if (bytesWritten === 0) fail();
      offset += bytesWritten;
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  process.stdout.write(
    JSON.stringify({ result: 'created', identity: identity(await stat('.')) }),
  );
}

main().catch(() => {
  process.exitCode = 1;
});
