import { gzipSync } from 'node:zlib';
import { afterEach, expect, test, vi } from 'vitest';
import {
  installVerifiedPnpm,
  packageFiles,
  verifyArchive,
  verifyMetadata,
} from '../../.github/actions/setup-verified-pnpm/bootstrap.mjs';

import metadata from './fixtures/pnpm-bootstrap/11.25.0.json';

afterEach(() => vi.unstubAllGlobals());

test('accepts the published pnpm 11.25.0 signature under the pinned npm root', () => {
  expect(() => verifyMetadata(metadata)).not.toThrow();
});

test.each([
  ['different package', { ...metadata, name: '@pnpm/exe' }],
  ['different version', { ...metadata, version: '11.25.1' }],
  [
    'foreign tarball',
    {
      ...metadata,
      dist: { ...metadata.dist, tarball: 'https://example.test/pnpm.tgz' },
    },
  ],
  [
    'changed integrity',
    { ...metadata, dist: { ...metadata.dist, integrity: 'sha512-AAAA' } },
  ],
  [
    'missing signature',
    { ...metadata, dist: { ...metadata.dist, signatures: [] } },
  ],
  [
    'unknown signing key',
    {
      ...metadata,
      dist: {
        ...metadata.dist,
        signatures: [
          { keyid: 'new-root', sig: metadata.dist.signatures[0].sig },
        ],
      },
    },
  ],
  [
    'invalid signature',
    {
      ...metadata,
      dist: {
        ...metadata.dist,
        signatures: [
          {
            ...metadata.dist.signatures[0],
            sig: Buffer.from('invalid').toString('base64'),
          },
        ],
      },
    },
  ],
])('refuses %s before package execution', (_label, candidate) => {
  expect(() => verifyMetadata(candidate)).toThrow();
});

test('refuses archive bytes that do not match the reviewed signed integrity', () => {
  expect(() => verifyArchive(Buffer.from('replaced archive'))).toThrow(
    'integrity',
  );
});

function archive(name: string, type = '0', contents = 'verified file') {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100);
  header.write('0000755\0', 100);
  header.write(`${contents.length.toString(8).padStart(11, '0')}\0`, 124);
  header.fill(32, 148, 156);
  header.write(type, 156);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148);
  const bytes = Buffer.alloc(Math.ceil(contents.length / 512) * 512);
  bytes.write(contents);
  return gzipSync(Buffer.concat([header, bytes, Buffer.alloc(1024)]));
}

test('extracts regular package members without following archive links', () => {
  const files = packageFiles(archive('package/bin/pnpm.cjs'));
  expect([...files.keys()]).toEqual(['package/bin/pnpm.cjs']);
  expect(files.get('package/bin/pnpm.cjs')?.mode).toBe(0o755);
  expect(files.get('package/bin/pnpm.cjs')?.bytes.toString()).toBe(
    'verified file',
  );
});

test.each([
  '../escape',
  'package/../../escape',
  '/package/absolute',
  'package/a\\escape',
])('refuses archive path %s', (name) => {
  expect(() => packageFiles(archive(name))).toThrow('path');
});

test.each(['1', '2', 'x'])(
  'refuses tar link or extended-header type %s',
  (type) => {
    expect(() => packageFiles(archive('package/bin/pnpm.cjs', type))).toThrow(
      'regular file',
    );
  },
);

test('real setup refuses a substituted archive after checking signed metadata', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json(metadata))
    .mockResolvedValueOnce(new Response('substituted archive'));
  vi.stubGlobal('fetch', fetch);
  await expect(installVerifiedPnpm()).rejects.toThrow('integrity');
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([
    'https://registry.npmjs.org/pnpm/11.25.0',
    'https://registry.npmjs.org/pnpm/-/pnpm-11.25.0.tgz',
  ]);
  expect(
    fetch.mock.calls.every(([, options]) => options.redirect === 'error'),
  ).toBe(true);
});

test('real setup never downloads a tarball when its signature is untrusted', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(
    Response.json({
      ...metadata,
      dist: { ...metadata.dist, signatures: [] },
    }),
  );
  vi.stubGlobal('fetch', fetch);
  await expect(installVerifiedPnpm()).rejects.toThrow('signature');
  expect(fetch).toHaveBeenCalledOnce();
});
