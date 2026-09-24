import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CHAT_ATTACHMENT_MAX_BYTES,
  validateChatAttachments,
} from '@kontourai/station-contracts/chat-attachment';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  addHostImageFile,
  ModelImageCollector,
} from '../model-image-attachments.js';

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

describe('addHostImageFile', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'host-image-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('reads a real image by its content type and keeps its file name', () => {
    const path = join(dir, 'chart.png');
    writeFileSync(path, PNG_1X1);
    const collector = new ModelImageCollector();
    expect(addHostImageFile(collector, path)).toMatchObject({
      kind: 'attached',
      name: 'chart.png',
    });
    expect(collector.result()?.[0]).toMatchObject({
      mimeType: 'image/png',
      size: PNG_1X1.length,
    });
  });

  test('never returns the contents of a non-image file, whatever its extension', () => {
    const path = join(dir, 'secrets.png');
    writeFileSync(path, 'API_KEY=hunter2');
    const collector = new ModelImageCollector();
    const outcome = addHostImageFile(collector, path);
    expect(outcome).toEqual({
      kind: 'omitted',
      marker:
        '[image not shown: the viewed file is not a supported image type]',
    });
    expect(collector.result()).toBeUndefined();
  });

  test('refuses a directory, a missing path, and an oversize file', () => {
    const collector = new ModelImageCollector();
    expect(addHostImageFile(collector, dir).kind).toBe('omitted');
    expect(addHostImageFile(collector, join(dir, 'missing.png')).kind).toBe(
      'omitted',
    );
    const big = join(dir, 'big.png');
    writeFileSync(
      big,
      Buffer.concat([PNG_1X1, Buffer.alloc(CHAT_ATTACHMENT_MAX_BYTES)]),
    );
    expect(addHostImageFile(collector, big)).toEqual({
      kind: 'omitted',
      marker: '[image not shown: larger than the 5 MB limit]',
    });
    expect(collector.result()).toBeUndefined();
  });
});
