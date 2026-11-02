import { crc32 } from 'node:zlib';
import yauzl from 'yauzl';

const MAX_BYTES = 128 * 1024 * 1024;
const MAX_ENTRIES = 10_000;
const unsafe = (name) =>
  !name ||
  name.length > 512 ||
  name.startsWith('/') ||
  /^[A-Za-z]:/.test(name) ||
  name.includes('\\') ||
  [...name].some((character) => {
    const code = character.codePointAt(0);
    return code < 32 || code === 127 || code === 65533;
  }) ||
  name
    .split('/')
    .some(
      (segment) =>
        !segment ||
        segment === '.' ||
        segment === '..' ||
        segment.toLowerCase() === '.git' ||
        segment.includes(':') ||
        /[. ]$/.test(segment) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment),
    );

/** Validate every ZIP entry before returning immutable bytes. */
export async function inspectDeviceArchive(bytes, kind, signal) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length < 1 ||
    bytes.length > MAX_BYTES ||
    !['ios', 'android'].includes(kind) ||
    signal?.aborted
  )
    throw new Error('invalid-artifact');
  const zip = await new Promise((resolve, reject) =>
    yauzl.fromBuffer(
      bytes,
      {
        lazyEntries: true,
        decodeStrings: true,
        validateEntrySizes: true,
        strictFileNames: true,
      },
      (error, value) => (error ? reject(error) : resolve(value)),
    ),
  );
  return await new Promise((resolve, reject) => {
    const names = new Set();
    const files = [];
    const fileNames = new Set();
    const parentsWithChildren = new Set();
    let entries = 0;
    let declared = 0;
    let settled = false;
    let stream;
    let pendingChunks = [];
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', fail);
    };
    const fail = () => {
      if (settled) return;
      settled = true;
      cleanup();
      stream?.destroy();
      for (const file of files) file.bytes?.fill(0);
      for (const chunk of pendingChunks) chunk.fill(0);
      zip.close();
      reject(new Error('invalid-artifact'));
    };
    signal?.addEventListener('abort', fail, { once: true });
    timer = setTimeout(fail, 120_000);
    if (signal?.aborted) return fail();
    zip.on('error', fail);
    zip.on('entry', (entry) => {
      entries += 1;
      const directory = entry.fileName.endsWith('/');
      const name = directory ? entry.fileName.slice(0, -1) : entry.fileName;
      const key = name.normalize('NFD').toLowerCase();
      const mode = entry.externalFileAttributes >>> 16;
      const unix = entry.versionMadeBy >>> 8 === 3;
      const type = mode & 0o170000;
      const parts = key.split('/');
      const parents = parts
        .slice(0, -1)
        .map((_, index) => parts.slice(0, index + 1).join('/'));
      if (
        entries > MAX_ENTRIES ||
        parts.length > 32 ||
        unsafe(name) ||
        names.has(key) ||
        parents.some((parent) => fileNames.has(parent)) ||
        (!directory && parentsWithChildren.has(key)) ||
        (entry.generalPurposeBitFlag & 1) !== 0 ||
        ![0, 8].includes(entry.compressionMethod) ||
        (unix && type !== 0 && type !== (directory ? 0o040000 : 0o100000))
      )
        return fail();
      names.add(key);
      for (const parent of parents) parentsWithChildren.add(parent);
      if (directory) {
        if (entry.uncompressedSize !== 0) return fail();
        zip.readEntry();
        return;
      }
      fileNames.add(key);
      declared += entry.uncompressedSize;
      if (
        !Number.isSafeInteger(entry.uncompressedSize) ||
        entry.uncompressedSize < 0 ||
        declared > MAX_BYTES
      )
        return fail();
      zip.openReadStream(entry, (error, currentStream) => {
        if (settled) {
          currentStream?.destroy();
          return;
        }
        if (error || !currentStream) return fail();
        stream = currentStream;
        let size = 0;
        let checksum = 0;
        const chunks = [];
        pendingChunks = chunks;
        currentStream.on('error', fail);
        currentStream.on('data', (chunk) => {
          if (settled) return;
          size += chunk.length;
          if (size > entry.uncompressedSize || size > MAX_BYTES) {
            currentStream.destroy();
            fail();
            return;
          }
          checksum = crc32(chunk, checksum);
          if (kind === 'ios') chunks.push(Buffer.from(chunk));
        });
        currentStream.on('end', () => {
          if (settled) return;
          if (
            size !== entry.uncompressedSize ||
            checksum >>> 0 !== entry.crc32 >>> 0
          )
            return fail();
          const content = kind === 'ios' ? Buffer.concat(chunks) : undefined;
          for (const chunk of chunks) chunk.fill(0);
          files.push({
            path: name,
            executable: unix && (mode & 0o111) !== 0,
            ...(content ? { bytes: content } : {}),
          });
          pendingChunks = [];
          stream = undefined;
          zip.readEntry();
        });
      });
    });
    zip.on('end', () => {
      if (settled) return;
      if (!files.length) return fail();
      if (kind === 'ios') {
        const candidates = new Set(
          files
            .filter((file) => !file.path.startsWith('__MACOSX/'))
            .map((file) => {
              const parts = file.path.split('/');
              return parts[0] === 'Payload'
                ? parts.slice(0, 2).join('/')
                : parts[0];
            }),
        );
        if (candidates.size !== 1 || ![...candidates][0].endsWith('.app'))
          return fail();
        const root = `${[...candidates][0]}/`;
        const retained = files.filter(
          (file) => !file.path.startsWith('__MACOSX/'),
        );
        if (!retained.every((file) => file.path.startsWith(root)))
          return fail();
        files.splice(0, files.length, ...retained);
        for (const file of files) file.path = file.path.slice(root.length);
        if (!files.some((file) => file.path === 'Info.plist')) return fail();
      } else if (!files.some((file) => file.path === 'AndroidManifest.xml'))
        return fail();
      settled = true;
      cleanup();
      resolve(files);
    });
    zip.readEntry();
  });
}
