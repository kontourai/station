import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CHAT_ATTACHMENT_MAX_BYTES,
  validateChatAttachments,
} from '@kontourai/station-contracts/chat-attachment';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  addWorkspaceImageFile,
  ModelImageCollector,
  redactInlineData,
  summarizeImageOmissions,
} from '../model-image-attachments.js';
import { projectBoundedToolOutput } from '../tool-output-projection.js';

const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const PNG_1X1 = Buffer.from(PNG_1X1_BASE64, 'base64');

describe('ModelImageCollector', () => {
  test('accepts an allowlisted image as an ingress-valid attachment', () => {
    const collector = new ModelImageCollector();
    const outcome = collector.addBase64('image/png', PNG_1X1_BASE64);
    expect(outcome).toEqual({
      kind: 'attached',
      name: 'image-1.png',
      marker: '[image: image-1.png]',
    });
    const attachments = collector.result();
    expect(attachments).toEqual([
      {
        kind: 'image',
        name: 'image-1.png',
        mimeType: 'image/png',
        size: PNG_1X1.length,
        dataUrl: `data:image/png;base64,${PNG_1X1_BASE64}`,
      },
    ]);
    // The exact validator EventStore runs on an attachment-bearing event.
    expect(validateChatAttachments(attachments!)).toBeNull();
  });

  test('tolerates wrapped base64 and the image/jpg alias', () => {
    const collector = new ModelImageCollector();
    const wrapped = PNG_1X1_BASE64.replace(/(.{20})/g, '$1\n');
    expect(collector.addBase64('image/png', wrapped).kind).toBe('attached');
    const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
    expect(
      collector.addBase64('image/jpg', jpegBytes.toString('base64')),
    ).toMatchObject({ kind: 'attached', name: 'image-2.jpg' });
    expect(collector.result()?.[1]?.mimeType).toBe('image/jpeg');
  });

  test('says what it dropped instead of persisting a non-allowlisted type', () => {
    const collector = new ModelImageCollector();
    expect(collector.addBase64('image/svg+xml', PNG_1X1_BASE64)).toEqual({
      kind: 'omitted',
      marker: '[image not shown: image/svg+xml is not a supported image type]',
    });
    expect(collector.result()).toBeUndefined();
  });

  test('refuses an oversize image before copying it', () => {
    const collector = new ModelImageCollector();
    const huge = 'A'.repeat(
      Math.ceil(((CHAT_ATTACHMENT_MAX_BYTES + 3) * 4) / 3),
    );
    expect(collector.addBase64('image/png', huge)).toEqual({
      kind: 'omitted',
      marker: '[image not shown: larger than the 5 MB limit]',
    });
    expect(collector.result()).toBeUndefined();
  });

  test('refuses data that is not canonical base64', () => {
    const collector = new ModelImageCollector();
    expect(collector.addBase64('image/png', 'not-base64!').kind).toBe(
      'omitted',
    );
    expect(collector.result()).toBeUndefined();
  });

  test('caps the count per result at the chat attachment limit', () => {
    const collector = new ModelImageCollector();
    const outcomes = Array.from({ length: 6 }, () =>
      collector.addBase64('image/png', PNG_1X1_BASE64),
    );
    expect(outcomes.filter((o) => o.kind === 'attached')).toHaveLength(5);
    expect(outcomes[5]).toEqual({
      kind: 'omitted',
      marker: '[image not shown: only 5 images can be shown per tool result]',
    });
    expect(collector.result()).toHaveLength(5);
  });

  test('accepts only inline data URLs', () => {
    const collector = new ModelImageCollector();
    expect(
      collector.addDataUrl(`data:image/png;base64,${PNG_1X1_BASE64}`).kind,
    ).toBe('attached');
    expect(collector.addDataUrl('https://example.com/a.png')).toEqual({
      kind: 'omitted',
      marker: '[image not shown: only inline image data can be shown]',
    });
  });
});

describe('ModelImageCollector — declared type vs. the bytes', () => {
  test.each([
    ['HTML', Buffer.from('<html><script>alert(1)</script></html>')],
    ['SVG', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')],
    ['a JPEG', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])],
  ])('refuses %s bytes declared as image/png', (_label, bytes) => {
    const collector = new ModelImageCollector();
    expect(collector.addBase64('image/png', bytes.toString('base64'))).toEqual({
      kind: 'omitted',
      marker: '[image not shown: the data is not a image/png image]',
    });
    expect(
      collector.addDataUrl(`data:image/png;base64,${bytes.toString('base64')}`)
        .kind,
    ).toBe('omitted');
    expect(collector.result()).toBeUndefined();
  });
});

describe('summarizeImageOmissions', () => {
  test('counts identical reasons and bounds distinct ones', () => {
    const markers = [
      ...Array.from(
        { length: 4000 },
        () => '[image not shown: image/tiff is not a supported image type]',
      ),
      ...Array.from(
        { length: 50 },
        (_, i) => `[image not shown: type-${i} is not a supported image type]`,
      ),
    ];
    const summary = summarizeImageOmissions(markers)!;
    expect(summary.split('\n')).toEqual([
      '[4000 images not shown: image/tiff is not a supported image type]',
      '[image not shown: type-0 is not a supported image type]',
      '[image not shown: type-1 is not a supported image type]',
      '[48 more images not shown]',
    ]);
    expect(summarizeImageOmissions([])).toBeUndefined();
  });
});

describe('addWorkspaceImageFile', () => {
  let dir: string;
  let workspace: string;
  let outside: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'host-image-'));
    workspace = join(dir, 'workspace');
    outside = join(dir, 'outside');
    mkdirSync(workspace);
    mkdirSync(outside);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('reads an image inside the workspace by its content type', async () => {
    const path = join(workspace, 'chart.png');
    writeFileSync(path, PNG_1X1);
    const collector = new ModelImageCollector();
    expect(
      await addWorkspaceImageFile(collector, path, { roots: [workspace] }),
    ).toMatchObject({ kind: 'attached', name: 'chart.png' });
    expect(collector.result()?.[0]).toMatchObject({
      mimeType: 'image/png',
      size: PNG_1X1.length,
    });
  });

  test('refuses a real image outside the workspace', async () => {
    const path = join(outside, 'private.png');
    writeFileSync(path, PNG_1X1);
    const collector = new ModelImageCollector();
    expect(
      await addWorkspaceImageFile(collector, path, { roots: [workspace] }),
    ).toEqual({
      kind: 'omitted',
      marker:
        '[image not shown: the viewed file is outside the session workspace]',
    });
    expect(collector.result()).toBeUndefined();
  });

  test('refuses a relative path that climbs out of the workspace', async () => {
    writeFileSync(join(outside, 'private.png'), PNG_1X1);
    const collector = new ModelImageCollector();
    expect(
      (
        await addWorkspaceImageFile(collector, '../outside/private.png', {
          roots: [workspace],
        })
      ).marker,
    ).toBe(
      '[image not shown: the viewed file is outside the session workspace]',
    );
  });

  test('refuses a symlink inside the workspace that points outside', async () => {
    writeFileSync(join(outside, 'private.png'), PNG_1X1);
    const link = join(workspace, 'innocent.png');
    symlinkSync(join(outside, 'private.png'), link);
    const collector = new ModelImageCollector();
    expect(
      await addWorkspaceImageFile(collector, link, { roots: [workspace] }),
    ).toEqual({
      kind: 'omitted',
      marker: '[image not shown: the viewed path is a symbolic link]',
    });
    expect(collector.result()).toBeUndefined();
  });

  test('refuses a path through a symlinked directory that leaves the workspace', async () => {
    writeFileSync(join(outside, 'private.png'), PNG_1X1);
    symlinkSync(outside, join(workspace, 'escape'));
    const collector = new ModelImageCollector();
    expect(
      (
        await addWorkspaceImageFile(
          collector,
          join(workspace, 'escape', 'private.png'),
          { roots: [workspace] },
        )
      ).marker,
    ).toBe(
      '[image not shown: the viewed file is outside the session workspace]',
    );
  });

  test('refuses everything when the session has no known workspace', async () => {
    const path = join(workspace, 'chart.png');
    writeFileSync(path, PNG_1X1);
    const collector = new ModelImageCollector();
    expect(await addWorkspaceImageFile(collector, path, { roots: [] })).toEqual(
      {
        kind: 'omitted',
        marker:
          '[image not shown: the session has no known workspace to read images from]',
      },
    );
  });

  test('never returns the contents of a non-image file, whatever its extension', async () => {
    const path = join(workspace, 'secrets.png');
    writeFileSync(path, 'API_KEY=hunter2');
    const collector = new ModelImageCollector();
    expect(
      await addWorkspaceImageFile(collector, path, { roots: [workspace] }),
    ).toEqual({
      kind: 'omitted',
      marker: '[image not shown: the file is not a supported image type]',
    });
    expect(collector.result()).toBeUndefined();
  });

  test('refuses a directory, a missing path, and an oversize file', async () => {
    const collector = new ModelImageCollector();
    const scope = { roots: [workspace] };
    expect(
      (await addWorkspaceImageFile(collector, workspace, scope)).kind,
    ).toBe('omitted');
    expect(
      (
        await addWorkspaceImageFile(
          collector,
          join(workspace, 'missing.png'),
          scope,
        )
      ).kind,
    ).toBe('omitted');
    const big = join(workspace, 'big.png');
    writeFileSync(
      big,
      Buffer.concat([PNG_1X1, Buffer.alloc(CHAT_ATTACHMENT_MAX_BYTES)]),
    );
    expect(await addWorkspaceImageFile(collector, big, scope)).toEqual({
      kind: 'omitted',
      marker: '[image not shown: larger than the 5 MB limit]',
    });
    expect(collector.result()).toBeUndefined();
  });
});

describe('redactInlineData', () => {
  const b64 = `${'QUJD'.repeat(50)}WFla`;

  test('redacts data-URL spans anywhere in a string, keeping the surrounding text', () => {
    expect(
      redactInlineData(
        `Screenshot: data:image/png;base64,${b64} done; also DATA:;base64,${b64}==`,
      ),
    ).toBe(
      'Screenshot: [inline image data omitted] done; also [inline image data omitted]',
    );
    expect(
      redactInlineData(`x data:image/svg+xml;charset=utf-8;base64,${b64}`),
    ).toBe('x [inline image data omitted]');
    const plain = 'no inline data here, just ;base64, mentioned';
    expect(redactInlineData(plain)).toBe(plain);
  });

  test.each([
    ['repeated data: prefixes', 'data:'.repeat(1_000_000)],
    [
      'near-miss media types',
      `data:${'a'.repeat(64)}/${'b'.repeat(64)};`.repeat(40_000),
    ],
    ['repeated ;base64, markers', ';base64,'.repeat(700_000)],
    // The shape that breaks a backtracking pattern: many `data:` starts, each
    // of which could only fail after scanning to a far delimiter, with a
    // `;base64,` present so the literal pre-check does not short-circuit.
    [
      'many failing data: starts before a marker',
      `${'data:x'.repeat(400_000)},;base64,`,
    ],
    [
      'one 5 MB data URL',
      `data:image/png;base64,${'A'.repeat(5 * 1024 * 1024)}`,
    ],
  ])(
    'stays linear on a multi-megabyte adversarial input: %s',
    (_label, input) => {
      const started = performance.now();
      const output = redactInlineData(input);
      expect(performance.now() - started).toBeLessThan(2_000);
      expect(output).not.toContain('AAAAAAAA');
    },
  );

  test('the shared tool-output projector redacts before it tails', () => {
    const projected = projectBoundedToolOutput({
      text: `Screenshot: data:image/png;base64,${'QUJD'.repeat(10_000)}WFla`,
    });
    expect(projected.value).toEqual({
      text: 'Screenshot: [inline image data omitted]',
    });
  });
});
