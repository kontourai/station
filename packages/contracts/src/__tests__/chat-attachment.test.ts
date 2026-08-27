import { describe, expect, test } from 'vitest';
import {
  CHAT_ATTACHMENT_MAX_COUNT,
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
