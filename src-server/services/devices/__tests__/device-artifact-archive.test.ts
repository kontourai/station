import { expect, test } from 'vitest';
import { ZipFile } from 'yazl';
import { inspectDeviceArchive } from '../device-artifact-archive.mjs';

async function archive(
  entries: Array<{ name: string; bytes: string; mode?: number }>,
): Promise<Buffer> {
  const zip = new ZipFile();
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    zip.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on('error', reject);
  });
  for (const entry of entries)
    zip.addBuffer(Buffer.from(entry.bytes), entry.name, {
      compress: false,
      ...(entry.mode === undefined ? {} : { mode: entry.mode }),
    });
  zip.end();
  return done;
}

test('accepts one bounded simulator app and preserves its executable bytes', async () => {
  const bytes = await archive([
    { name: 'Sample.app/Info.plist', bytes: 'plist' },
    { name: 'Sample.app/Sample', bytes: 'binary', mode: 0o100755 },
  ]);
  const entries = await inspectDeviceArchive(bytes, 'ios');
  expect(entries).toEqual(
    expect.arrayContaining([
      { path: 'Info.plist', executable: false, bytes: Buffer.from('plist') },
      { path: 'Sample', executable: true, bytes: Buffer.from('binary') },
    ]),
  );
});

test('rejects traversal, symlinks, colliding names and corrupt content before extraction', async () => {
  const good = await archive([
    { name: 'Sample.app/Info.plist', bytes: 'plist' },
    { name: 'Sample.app/aa/ok', bytes: 'payload' },
  ]);
  const traversal = Buffer.from(good);
  let offset = traversal.indexOf('aa/ok');
  while (offset !== -1) {
    traversal.write('../ok', offset);
    offset = traversal.indexOf('aa/ok', offset + 5);
  }
  await expect(inspectDeviceArchive(traversal, 'ios')).rejects.toThrow();
  const linked = await archive([
    { name: 'Sample.app/Info.plist', bytes: 'plist' },
    { name: 'Sample.app/link', bytes: '/tmp', mode: 0o120777 },
  ]);
  await expect(inspectDeviceArchive(linked, 'ios')).rejects.toThrow();
  const collision = await archive([
    { name: 'Sample.app/Info.plist', bytes: 'plist' },
    { name: 'Sample.app/A', bytes: 'a' },
    { name: 'Sample.app/a', bytes: 'b' },
  ]);
  await expect(inspectDeviceArchive(collision, 'ios')).rejects.toThrow();
  const conflictingParent = await archive([
    { name: 'Sample.app/Info.plist', bytes: 'plist' },
    { name: 'Sample.app/a/b', bytes: 'x' },
    { name: 'Sample.app/a', bytes: 'y' },
  ]);
  await expect(
    inspectDeviceArchive(conflictingParent, 'ios'),
  ).rejects.toThrow();
  const tooDeep = await archive([
    { name: 'Sample.app/Info.plist', bytes: 'plist' },
    { name: `Sample.app/${'a/'.repeat(32)}file`, bytes: 'x' },
  ]);
  await expect(inspectDeviceArchive(tooDeep, 'ios')).rejects.toThrow();
  const corrupt = Buffer.from(good);
  const payload = corrupt.indexOf('payload');
  if (payload < 0) throw new Error('fixture payload missing');
  corrupt[payload] ^= 1;
  await expect(inspectDeviceArchive(corrupt, 'ios')).rejects.toThrow();
});

test('Android archive requires a manifest and retains no extracted file bytes', async () => {
  const apk = await archive([
    { name: 'AndroidManifest.xml', bytes: 'binary manifest' },
    { name: 'lib/arm64-v8a/libapp.so', bytes: 'library' },
  ]);
  expect(await inspectDeviceArchive(apk, 'android')).toEqual(
    expect.arrayContaining([
      { path: 'AndroidManifest.xml', executable: false },
      { path: 'lib/arm64-v8a/libapp.so', executable: false },
    ]),
  );
  await expect(
    inspectDeviceArchive(
      await archive([{ name: 'assets/a', bytes: 'x' }]),
      'android',
    ),
  ).rejects.toThrow();
});

test('an aborted archive inspection refuses rather than publishing partial entries', async () => {
  const bytes = await archive([
    { name: 'AndroidManifest.xml', bytes: 'manifest' },
  ]);
  const controller = new AbortController();
  const result = inspectDeviceArchive(bytes, 'android', controller.signal);
  controller.abort();
  await expect(result).rejects.toThrow();
});
