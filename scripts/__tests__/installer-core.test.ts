import { generateKeyPairSync } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DownloadTooLarge,
  downloadCapped,
} from '../../packages/shared/src/installer/download.js';
import {
  isAbsoluteRoot,
  plainPowerShellMessage,
  windowsInstallRootRefusal,
} from '../../packages/shared/src/installer/install.js';
import {
  ManifestRefusal,
  verifyInstallManifest,
} from '../../packages/shared/src/installer/manifest.js';
import { compareReleaseTags } from '../../packages/shared/src/installer/release-order.js';
import {
  readNamedEntry,
  unsafeEntryName,
  withZip,
  ZipRefusal,
} from '../../packages/shared/src/installer/zip.js';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { writeZip, type ZipFixtureEntry } from './fixtures/windows-archive.js';

/**
 * The Windows installer core's building blocks (#2675 slice W1), in process:
 * the zip reader's refusals, the byte-capped download, and the release order
 * its downgrade check uses. install-ps1.test.ts drives the same code through
 * the bundle install.ps1 embeds.
 */

const makeTempDir = trackTempDirs();

function zipOf(entries: ZipFixtureEntry[]): string {
  const path = join(makeTempDir('station-installer-zip-'), 'archive.zip');
  writeZip(path, entries);
  return path;
}

function openZip(path: string) {
  return withZip(path, 'station', (fd, entries) => ({
    names: entries.map((entry) => entry.name),
    read: (name: string) => readNamedEntry(fd, entries, name),
  }));
}

describe('installer zip reader', () => {
  it('lists and inflates a stored and a deflated entry', () => {
    const path = zipOf([
      { name: 'station/' },
      { name: 'station/a.txt', data: 'alpha', method: 0 },
      { name: 'station/b/c.txt', data: 'gamma'.repeat(1000) },
    ]);
    const zip = openZip(path);
    expect(zip.names).toEqual(['station/', 'station/a.txt', 'station/b/c.txt']);
    const read = withZip(path, 'station', (fd, entries) => [
      readNamedEntry(fd, entries, 'station/a.txt')?.toString(),
      readNamedEntry(fd, entries, 'station/b/c.txt')?.toString(),
      readNamedEntry(fd, entries, 'station/missing'),
    ]);
    expect(read).toEqual(['alpha', 'gamma'.repeat(1000), null]);
  });

  it.each<[string, string]>([
    ['other/file', 'is outside station/'],
    ['/station/file', 'is outside station/'],
    ['station', 'is outside station/'],
    ['station/../x', 'has an empty, `.` or `..` path segment'],
    ['station/./x', 'has an empty, `.` or `..` path segment'],
    ['station//x', 'has an empty, `.` or `..` path segment'],
    [
      'station/a\\..\\..\\x',
      'contains a character Windows forbids or reinterprets',
    ],
    ['station/C:x', 'contains a character Windows forbids or reinterprets'],
    [
      'station/file:stream',
      'contains a character Windows forbids or reinterprets',
    ],
    ['station/a\u0001b', 'contains a control character'],
    [
      'station/trailing.',
      'has a segment Windows would rename (a trailing dot or space)',
    ],
    [
      'station/trailing ',
      'has a segment Windows would rename (a trailing dot or space)',
    ],
    ['station/CON', 'names a Windows device'],
    ['station/dir/nul.txt', 'names a Windows device'],
    ['station/com1.log', 'names a Windows device'],
    ['station/CONIN$', 'names a Windows device'],
    ['station/conout$.txt', 'names a Windows device'],
    ['station/CLOCK$', 'names a Windows device'],
    ['station/nul .txt', 'names a Windows device'],
  ])('refuses the entry name %j', (name, reason) => {
    expect(unsafeEntryName(name, 'station')).toBe(reason);
    expect(() => openZip(zipOf([{ name, data: 'x' }]))).toThrow(
      new ZipRefusal(`zip entry ${name} ${reason}`),
    );
  });

  it.each([
    'station/',
    'station/a/b.txt',
    'station/console.txt',
    'station/.hidden',
  ])('accepts the entry name %j', (name) => {
    expect(unsafeEntryName(name, 'station')).toBeNull();
  });

  it('refuses two entries that name one path on a case-insensitive filesystem', () => {
    expect(() =>
      openZip(
        zipOf([
          { name: 'station/Readme', data: 'a' },
          { name: 'station/README', data: 'b' },
        ]),
      ),
    ).toThrow(
      /zip entries station\/Readme and station\/README name the same path/,
    );
  });

  it('refuses a file that another entry uses as a directory', () => {
    expect(() =>
      openZip(
        zipOf([
          { name: 'station/lib', data: 'a' },
          { name: 'station/lib/x', data: 'b' },
        ]),
      ),
    ).toThrow(
      /zip entry station\/lib is a file that other entries use as a directory/,
    );
  });

  it.each<[string, ZipFixtureEntry, RegExp]>([
    [
      'a Unix symbolic link',
      { name: 'station/link', data: 'target', unixMode: 0o120777 },
      /is not a regular file or directory/,
    ],
    [
      'a Unix FIFO',
      { name: 'station/fifo', unixMode: 0o010644 },
      /is not a regular file or directory/,
    ],
    [
      'a DOS reparse point',
      { name: 'station/junction', madeBy: 0, dosAttributes: 0x400 },
      /is a reparse point/,
    ],
    [
      'an encrypted entry',
      { name: 'station/secret', data: 'x', flags: 0x0801 },
      /is encrypted/,
    ],
    [
      'an unsupported compression method',
      { name: 'station/bzip', data: 'x', method: 12 },
      /uses unsupported compression 12/,
    ],
    [
      'a non-ASCII name without the UTF-8 flag',
      { name: 'station/café', data: 'x', flags: 0 },
      /is not ASCII or declared UTF-8/,
    ],
    [
      'a directory entry with content',
      { name: 'station/dir/', data: 'x', method: 0 },
      /has content/,
    ],
  ])('refuses %s', (_name, entry, message) => {
    expect(() => openZip(zipOf([entry]))).toThrow(message);
  });

  it.each<[string, ZipFixtureEntry, RegExp]>([
    [
      'a CRC-32 mismatch',
      { name: 'station/a', data: 'abc', crc32: 7 },
      /fails its CRC-32 check/,
    ],
    [
      'a declared size smaller than the inflated bytes',
      { name: 'station/a', data: 'abcdef'.repeat(100), size: 10 },
      /does not inflate to 10 bytes/,
    ],
    [
      'a declared size larger than the stored bytes',
      { name: 'station/a', data: 'abc', size: 4, method: 0 },
      /does not inflate to 4 bytes|ends inside a zip record/,
    ],
  ])('refuses %s when the entry is read', (_name, entry, message) => {
    const path = zipOf([entry]);
    expect(() =>
      withZip(path, 'station', (fd, entries) =>
        readNamedEntry(fd, entries, entry.name),
      ),
    ).toThrow(message);
  });

  it('refuses a file that is not a zip, and a zip with bytes after its end record', () => {
    const dir = makeTempDir('station-installer-zip-');
    const notZip = join(dir, 'not.zip');
    writeFileSync(notZip, 'plain text, not an archive');
    expect(() => openZip(notZip)).toThrow(/archive is not a zip file/);
    const trailing = zipOf([{ name: 'station/a', data: 'x' }]);
    writeFileSync(
      trailing,
      Buffer.concat([readFileSync(trailing), Buffer.from('junk')]),
    );
    expect(() => openZip(trailing)).toThrow(
      /followed by unexpected bytes|not a zip file/,
    );
  });
});

describe('installer byte-capped download', () => {
  let server: Server | undefined;
  afterEach(async () => {
    await new Promise<void>((resolve) =>
      server ? server.close(() => resolve()) : resolve(),
    );
    server = undefined;
  });

  async function serve(
    handler: Parameters<typeof createServer>[1],
  ): Promise<string> {
    server = createServer(handler);
    await new Promise<void>((resolve) =>
      server?.listen(0, '127.0.0.1', resolve),
    );
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/file`;
  }

  it('downloads a body at exactly the cap', async () => {
    const url = await serve((_request, response) =>
      response.end('x'.repeat(100)),
    );
    const out = join(makeTempDir('station-download-'), 'out');
    await downloadCapped(url, out, { maxBytes: 100, allowTestUrls: true });
    expect(readFileSync(out, 'utf8')).toBe('x'.repeat(100));
  });

  it('refuses a declared Content-Length over the cap before reading the body', async () => {
    const url = await serve((_request, response) =>
      response.end('x'.repeat(101)),
    );
    const out = join(makeTempDir('station-download-'), 'out');
    await expect(
      downloadCapped(url, out, { maxBytes: 100, allowTestUrls: true }),
    ).rejects.toBeInstanceOf(DownloadTooLarge);
  });

  it('stops a chunked body at the first byte past the cap', async () => {
    let written = 0;
    const url = await serve((_request, response) => {
      // No Content-Length: the body streams in chunks until the client stops.
      const timer = setInterval(() => {
        written += 64;
        if (written > 10_000) {
          clearInterval(timer);
          response.end();
          return;
        }
        response.write('y'.repeat(64));
      }, 1);
      response.on('close', () => clearInterval(timer));
    });
    const out = join(makeTempDir('station-download-'), 'out');
    await expect(
      downloadCapped(url, out, { maxBytes: 200, allowTestUrls: true }),
    ).rejects.toBeInstanceOf(DownloadTooLarge);
    expect(readFileSync(out).length).toBeLessThanOrEqual(200);
  });

  it('refuses http: and file: URLs without the test-only flag', async () => {
    const dir = makeTempDir('station-download-');
    const source = join(dir, 'source');
    writeFileSync(source, 'x');
    await expect(
      downloadCapped(pathToFileURL(source).href, join(dir, 'a'), {
        maxBytes: 10,
        allowTestUrls: false,
      }),
    ).rejects.toThrow(/is not an HTTPS URL/);
    await expect(
      downloadCapped('http://127.0.0.1:9/file', join(dir, 'b'), {
        maxBytes: 10,
        allowTestUrls: false,
      }),
    ).rejects.toThrow(/is not an HTTPS URL/);
  });

  it('refuses a file: source over the cap under the test-only flag', async () => {
    const dir = makeTempDir('station-download-');
    const source = join(dir, 'source');
    writeFileSync(source, 'x'.repeat(11));
    await expect(
      downloadCapped(pathToFileURL(source).href, join(dir, 'out'), {
        maxBytes: 10,
        allowTestUrls: true,
      }),
    ).rejects.toBeInstanceOf(DownloadTooLarge);
  });

  it('does not retry an HTTP 404', async () => {
    let requests = 0;
    const url = await serve((_request, response) => {
      requests += 1;
      response.statusCode = 404;
      response.end();
    });
    await expect(
      downloadCapped(url, join(makeTempDir('station-download-'), 'out'), {
        maxBytes: 10,
        allowTestUrls: true,
      }),
    ).rejects.toThrow(/answered HTTP 404/);
    expect(requests).toBe(1);
  });
});

describe('installer release order', () => {
  const rings = new Set(['preview', 'nightly']);
  it.each<[string, string, string | null]>([
    ['v1.2.3', 'v1.2.4', 'newer'],
    ['v1.2.3', 'v1.2.3', 'same'],
    ['v1.2.3', 'v1.2.2', 'older'],
    ['v1.2.3-nightly.9', 'v1.2.3-nightly.10', 'newer'],
    ['v1.2.3-nightly.10', 'v1.2.3-nightly.9', 'older'],
    ['v1.2.3-nightly.4', 'v1.2.3', 'newer'],
    ['v1.2.3', 'v1.2.3-nightly.4', 'older'],
    ['v1.2.3-nightly.4', 'v1.2.3-preview.4', null],
    ['v1.2.3-beta.1', 'v1.2.4', null],
    ['1.2.3', 'v1.2.4', null],
  ])('%s -> %s is %s', (installed, candidate, expected) => {
    expect(compareReleaseTags(installed, candidate, rings)).toBe(expected);
  });
});

describe('installer Windows install-root rule (#2675 W1)', () => {
  it('accepts a root beneath the profile and refuses one outside it, or the profile itself', () => {
    expect(
      windowsInstallRootRefusal('/home/u/.station/installs/nightly', '/home/u'),
    ).toBeNull();
    expect(
      windowsInstallRootRefusal('/srv/station/installs/nightly', '/home/u'),
    ).toBe(
      'on Windows, install.ps1 installs only beneath your user profile (/home/u); /srv/station/installs/nightly is outside it',
    );
    expect(windowsInstallRootRefusal('/home/u', '/home/u')).not.toBeNull();
    // A sibling that shares the profile's prefix is not inside it.
    expect(
      windowsInstallRootRefusal('/home/user2/.station', '/home/u'),
    ).not.toBeNull();
  });
});

describe('installer absolute-root rule', () => {
  it.each<[string, NodeJS.Platform, boolean]>([
    ['C:\\Users\\u\\.station', 'win32', true],
    ['C:/Users/u/.station', 'win32', true],
    ['\\\\server\\share\\station', 'win32', true],
    ['station', 'win32', false],
    ['.\\station', 'win32', false],
    ['C:station', 'win32', false],
    ['\\station', 'win32', false],
    ['/home/u/.station', 'linux', true],
    ['station', 'linux', false],
    ['./station', 'linux', false],
  ])('%j on %s is absolute: %s', (value, platform, expected) => {
    expect(isAbsoluteRoot(value, platform)).toBe(expected);
  });
});

describe('installer test-only key gate', () => {
  it('refuses a test-only key without the test-only flag, after the key id checks', () => {
    const pair = generateKeyPairSync('ed25519');
    const pem = pair.publicKey.export({
      format: 'pem',
      type: 'spki',
    }) as string;
    const keys = {
      keys: [
        {
          keyId: 'fixture-nightly',
          algorithm: 'ed25519',
          publicKeySpkiPem: pem,
          channels: ['nightly'],
        },
      ],
    };
    const envelope = {
      schemaVersion: 1,
      algorithm: 'ed25519',
      keyId: 'fixture-nightly',
      payload: { channel: 'nightly' },
      signature: 'AAAA',
    };
    let caught: unknown;
    try {
      verifyInstallManifest(envelope, keys, {
        expectedChannel: 'nightly',
        allowTestUrls: false,
        testKeyPem: pem,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ManifestRefusal);
    expect((caught as Error).message).toBe(
      'a test-only key needs the test-only flag',
    );
  });
});

describe('plainPowerShellMessage', () => {
  it('keeps the first error record of a CLIXML error stream', () => {
    // As Windows PowerShell wrote it on the install-smoke Windows leg.
    const clixml =
      'Windows current-user ACL verification failed: #< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><Obj S="progress" RefId="0"><TN RefId="0"><T>System.Management.Automation.PSCustomObject</T><T>System.Object</T></TN><MS><I64 N="SourceId">1</I64><PR N="Record"><AV>Preparing modules for first use.</AV><AI>0</AI><Nil /><PI>-1</PI><PC>-1</PC><T>Completed</T><SR>-1</SR><SD> </SD></PR></MS></Obj><S S="Error">Station trust ACL has unrelated entries: D:\\a\\root_x000D__x000A_</S><S S="Error">At line:57 char:29_x000D__x000A_</S></Objs>';
    expect(plainPowerShellMessage(clixml)).toBe(
      'Windows current-user ACL verification failed: Station trust ACL has unrelated entries: D:\\a\\root',
    );
    expect(plainPowerShellMessage('plain failure')).toBe('plain failure');
  });
});
