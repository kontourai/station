import {
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { hostImagePathFromDestination } from '@kontourai/station-contracts/chat-host-images';
import { beforeEach, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  captureHostImages,
  HOST_IMAGE_MAX_BYTES,
  HOST_IMAGE_MAX_PER_TURN,
  hostImageCaptureRoots,
  hostImageDestinations,
  hostImagePaths,
} from '../host-image-capture.js';

/**
 * chat-host-images: what Station will read from the host when a reply names
 * an image. Each refusal here is a security boundary; each was fault-injected
 * (the named guard removed, this suite seen failing, then restored).
 */

const FIXTURES = join(import.meta.dirname, 'fixtures', 'host-images');
/** Real writers' output: macOS `sips` (PNG with an `eXIf` chunk, JPEG, GIF) and Chromium's encoder (WebP, PNG). */
const fixture = (name: string) => readFileSync(join(FIXTURES, name));

function pngChunk(type: string, data: Buffer = Buffer.alloc(0)): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([length, body, crc]);
}

/** A complete PNG encoded the way any writer does (filtered rows, deflate). */
function encodePng(width: number, height: number, noise = false): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.alloc((width * 3 + 1) * height);
  if (noise)
    for (let i = 0; i < rows.length; i += 1) rows[i] = (i * 2654435761) >>> 24;
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(rows, { level: noise ? 0 : 9 })),
    pngChunk('IEND'),
  ]);
}

const makeTempDir = trackTempDirs();

describe('host image destinations', () => {
  test('reads inline, angle-bracketed, titled and reference images, not code', () => {
    const markdown = [
      'Here: ![Before and after icon sizing](/tmp/station-icon-comparison.png)',
      '![spaced](</work/a b.png> "title")',
      '`![inline code](/x/not-me.png)`',
      '```',
      '![fenced](/x/fenced.png)',
      '```',
      '![ref][shot]',
      '',
      '[shot]: /work/ref.webp',
      '[link](/work/a-link.png) is a link, not an image',
    ].join('\n');
    expect(hostImageDestinations(markdown)).toEqual([
      '/tmp/station-icon-comparison.png',
      '/work/a b.png',
      '/work/ref.webp',
    ]);
  });

  test('normalizes file: URLs and percent-encoding to the same path key the client derives', () => {
    expect(hostImagePathFromDestination('file:///work/a%20b.png')).toBe(
      '/work/a b.png',
    );
    expect(hostImagePathFromDestination('/work/a%20b.png')).toBe(
      '/work/a b.png',
    );
    expect(hostImagePathFromDestination('file://localhost/w/x.JPG')).toBe(
      '/w/x.JPG',
    );
    expect(
      hostImagePathFromDestination('file://other-host/w/x.png'),
    ).toBeNull();
    expect(
      hostImagePathFromDestination('https://example.com/x.png'),
    ).toBeNull();
    expect(hostImagePathFromDestination('relative/x.png')).toBeNull();
    expect(hostImagePathFromDestination('/work/page.svg')).toBeNull();
    expect(
      hostImagePaths([
        '![a](/w/x.png) ![b](file:///w/x.png)',
        '![c](/w/y.gif)',
      ]),
    ).toEqual(['/w/x.png', '/w/y.gif']);
  });
});

describe('captureHostImages', () => {
  let base: string;
  let root: string;
  let outside: string;

  beforeEach(() => {
    base = realpathSync(makeTempDir('host-images-'));
    root = join(base, 'workspace');
    outside = join(base, 'outside');
    mkdirSync(root);
    mkdirSync(outside);
  });

  const capture = (paths: string[], roots = [root]) =>
    captureHostImages({ paths, roots });

  test('keeps every supported type real writers produce, by content', async () => {
    const names = [
      'sips-exif.png',
      'sips.jpg',
      'sips.gif',
      'chromium.webp',
      'chromium.png',
    ];
    for (const name of names) writeFileSync(join(root, name), fixture(name));
    const result = await capture(names.map((name) => join(root, name)));
    expect(result.sources).toEqual(
      names.map((name, index) => ({
        path: join(root, name),
        attachmentIndex: index,
      })),
    );
    expect(result.attachments.map((a) => a.mimeType)).toEqual([
      'image/png',
      'image/jpeg',
      'image/gif',
      'image/webp',
      'image/png',
    ]);
    const first = result.attachments[0];
    expect(first.name).toBe('sips-exif.png');
    expect(
      Buffer.from(first.dataUrl.split(',')[1], 'base64').equals(
        fixture('sips-exif.png'),
      ),
    ).toBe(true);
  });

  test('refuses a path outside every root without saying whether it exists (e.g. /etc/passwd)', async () => {
    const result = await capture(['/etc/passwd.png', '/etc/passwd']);
    expect(result.sources).toEqual([
      { path: '/etc/passwd.png', refused: 'outside-allowed-roots' },
      { path: '/etc/passwd', refused: 'outside-allowed-roots' },
    ]);
    expect(result.attachments).toEqual([]);
  });

  test('a session defaulted to the home folder admits nothing in it (an ssh key renamed .png)', async () => {
    const home = join(base, 'home');
    mkdirSync(join(home, '.ssh'), { recursive: true });
    const key = join(home, '.ssh', 'id_rsa.png');
    writeFileSync(key, fixture('chromium.png'));
    const roots = await hostImageCaptureRoots({
      cwd: home,
      home,
      stationHome: join(base, 'station-home'),
      listWorktrees: async () => [],
    });
    expect(roots).toEqual([]);
    const result = await capture([key], roots);
    expect(result.sources).toEqual([
      { path: key, refused: 'outside-allowed-roots' },
    ]);
  });

  test('a project working directory and the session temp folder are roots', async () => {
    const home = join(base, 'home');
    const tmp = join(base, 'session-tmp');
    mkdirSync(home);
    mkdirSync(tmp);
    expect(
      await hostImageCaptureRoots({
        cwd: root,
        sessionTmpDir: tmp,
        home,
        stationHome: join(base, 'station-home'),
        listWorktrees: async () => [],
      }),
    ).toEqual([root, tmp]);
    writeFileSync(join(tmp, 'shot.png'), fixture('chromium.png'));
    const result = await capture([join(tmp, 'shot.png')], [root, tmp]);
    expect(result.sources).toEqual([
      { path: join(tmp, 'shot.png'), attachmentIndex: 0 },
    ]);
  });

  test('admits a path through a symlinked prefix of a root (macOS /tmp is /private/tmp)', async () => {
    writeFileSync(join(root, 'shot.png'), fixture('chromium.png'));
    const alias = join(base, 'alias');
    symlinkSync(root, alias);
    const result = await capture([join(alias, 'shot.png'), join(alias, 'gone.png')]);
    expect(result.sources).toEqual([
      { path: join(alias, 'shot.png'), attachmentIndex: 0 },
      { path: join(alias, 'gone.png'), refused: 'not-found' },
    ]);
  });

  test('refuses a symlink inside the root that resolves outside it', async () => {
    writeFileSync(join(outside, 'secret.png'), fixture('chromium.png'));
    symlinkSync(join(outside, 'secret.png'), join(root, 'link.png'));
    symlinkSync(outside, join(root, 'linked-dir'));
    const result = await capture([
      join(root, 'link.png'),
      join(root, 'linked-dir', 'secret.png'),
    ]);
    expect(result.sources).toEqual([
      { path: join(root, 'link.png'), refused: 'outside-allowed-roots' },
      {
        path: join(root, 'linked-dir', 'secret.png'),
        refused: 'outside-allowed-roots',
      },
    ]);
    expect(result.attachments).toEqual([]);
  });

  test('refuses `..` traversal even when it lands inside a root', async () => {
    writeFileSync(join(outside, 'x.png'), fixture('chromium.png'));
    writeFileSync(join(root, 'y.png'), fixture('chromium.png'));
    const result = await capture([
      `${root}/../outside/x.png`,
      `${root}/sub/../y.png`,
    ]);
    expect(result.sources).toEqual([
      { path: `${root}/../outside/x.png`, refused: 'invalid-path' },
      { path: `${root}/sub/../y.png`, refused: 'invalid-path' },
    ]);
  });

  test('refuses non-image bytes named .png, and SVG', async () => {
    writeFileSync(
      join(root, 'id_rsa.png'),
      '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n',
    );
    writeFileSync(
      join(root, 'page.png'),
      '<svg xmlns="http://www.w3.org/2000/svg"><script>x()</script></svg>',
    );
    const truncated = fixture('chromium.png').subarray(0, 60);
    writeFileSync(join(root, 'truncated.png'), truncated);
    const result = await capture([
      join(root, 'id_rsa.png'),
      join(root, 'page.png'),
      join(root, 'truncated.png'),
    ]);
    expect(result.sources.map((source) => source.refused)).toEqual([
      'unsupported-image',
      'unsupported-image',
      'unsupported-image',
    ]);
  });

  test('refuses an image over the byte limit and one over the pixel limit', async () => {
    const big = encodePng(500, 500, true);
    expect(big.length).toBeGreaterThan(HOST_IMAGE_MAX_BYTES);
    writeFileSync(join(root, 'big.png'), big);
    // Small file, huge raster: a decompression bomb by dimensions.
    writeFileSync(join(root, 'bomb.png'), encodePng(4096, 4096));
    const result = await capture([
      join(root, 'big.png'),
      join(root, 'bomb.png'),
    ]);
    expect(result.sources).toEqual([
      { path: join(root, 'big.png'), refused: 'too-large' },
      { path: join(root, 'bomb.png'), refused: 'too-many-pixels' },
    ]);
  });

  test('keeps at most one turn’s worth and says so for the rest', async () => {
    const paths = Array.from(
      { length: HOST_IMAGE_MAX_PER_TURN + 1 },
      (_, i) => {
        const path = join(root, `shot-${i}.png`);
        writeFileSync(path, fixture('chromium.png'));
        return path;
      },
    );
    const result = await capture(paths);
    expect(result.attachments).toHaveLength(HOST_IMAGE_MAX_PER_TURN);
    expect(result.sources.at(-1)).toEqual({
      path: paths.at(-1),
      refused: 'limit-reached',
    });
  });

  test('a missing file and a directory are refused with their own reasons', async () => {
    mkdirSync(join(root, 'dir.png'));
    const result = await capture([
      join(root, 'gone.png'),
      join(root, 'dir.png'),
    ]);
    expect(result.sources.map((source) => source.refused)).toEqual([
      'not-found',
      'not-a-file',
    ]);
  });

  test('a file swapped for an outside link between admission and open is refused', async () => {
    const target = join(root, 'swap.png');
    writeFileSync(target, fixture('chromium.png'));
    writeFileSync(join(outside, 'secret.png'), fixture('sips-exif.png'));
    const result = await captureHostImages({
      paths: [target],
      roots: [root],
      hooks: {
        beforeOpen: () => {
          renameSync(target, join(root, 'moved.png'));
          symlinkSync(join(outside, 'secret.png'), target);
        },
      },
    });
    expect(result.sources).toEqual([{ path: target, refused: 'unreadable' }]);
    expect(result.attachments).toEqual([]);
  });
});
