import { describe, expect, test } from 'vitest';
import {
  CHAT_ATTACHMENT_MAX_COUNT,
  sniffChatImageMimeType,
  validateChatAttachment,
  validateChatAttachments,
} from '../chat-attachment.js';

const image = {
  kind: 'image' as const,
  name: 'screen.png',
  mimeType: 'image/png' as const,
  size: 3,
  dataUrl: 'data:image/png;base64,YWJj',
};

describe('chat attachment validation', () => {
  test('accepts a canonical bounded attachment', () => {
    expect(validateChatAttachment(image)).toBeNull();
  });

  test('rejects forged names, MIME headers, and decoded byte counts', () => {
    expect(
      validateChatAttachment({ ...image, name: '../screen.png' }),
    ).toContain('unsafe');
    expect(
      validateChatAttachment({
        ...image,
        dataUrl: 'data:image/jpeg;base64,YWJj',
      }),
    ).toContain('declared type and size');
    expect(validateChatAttachment({ ...image, size: 99 })).toContain(
      'declared type and size',
    );
  });

  test('bounds attachment count before provider dispatch', () => {
    expect(
      validateChatAttachments(
        Array.from({ length: CHAT_ATTACHMENT_MAX_COUNT + 1 }, () => image),
      ),
    ).toContain(`at most ${CHAT_ATTACHMENT_MAX_COUNT}`);
  });
});

describe('sniffChatImageMimeType', () => {
  const bytes = (...values: number[]) => Uint8Array.from(values);
  const ascii = (text: string) =>
    Uint8Array.from(text, (character) => character.charCodeAt(0));

  test('recognises each allowlisted type by its full magic number', () => {
    expect(
      sniffChatImageMimeType(
        bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
      ),
    ).toBe('image/png');
    expect(sniffChatImageMimeType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe(
      'image/jpeg',
    );
    expect(sniffChatImageMimeType(ascii('GIF87a'))).toBe('image/gif');
    expect(sniffChatImageMimeType(ascii('GIF89a'))).toBe('image/gif');
    expect(sniffChatImageMimeType(ascii('RIFF\x10\x00\x00\x00WEBPVP8 '))).toBe(
      'image/webp',
    );
  });

  test.each([
    ['GIF87Z (wrong sixth byte)', ascii('GIF87Z')],
    ['GIF88a (wrong version)', ascii('GIF88a')],
    ['truncated GIF', ascii('GIF89')],
    ['RIFF that is not WEBP (a WAV)', ascii('RIFF\x10\x00\x00\x00WAVEfmt ')],
    ['WEBP at the wrong offset', ascii('RIFFWEBP\x00\x00\x00\x00')],
    ['truncated WebP', ascii('RIFF\x10\x00\x00\x00WEB')],
    ['truncated PNG', bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a)],
    [
      'PNG with a corrupted byte',
      bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x0a, 0x0a),
    ],
    ['truncated JPEG', bytes(0xff, 0xd8)],
    ['HTML', ascii('<!doctype html>')],
    ['empty', bytes()],
  ])('refuses %s', (_label, head) => {
    expect(sniffChatImageMimeType(head)).toBeNull();
  });
});
