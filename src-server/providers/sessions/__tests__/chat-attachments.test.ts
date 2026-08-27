import { describe, expect, test } from 'vitest';
import {
  decodeChatAttachments,
  decodeUtf8Attachment,
  rejectFileAttachments,
} from '../chat-attachments.js';

describe('provider chat attachments', () => {
  test('decodes validated data without trusting client metadata', () => {
    const [decoded] = decodeChatAttachments([
      {
        kind: 'file',
        name: 'notes.txt',
        mimeType: 'text/plain',
        size: 5,
        dataUrl: 'data:text/plain;base64,aGVsbG8=',
      },
    ]);

    expect(decoded.base64).toBe('aGVsbG8=');
    expect(decodeUtf8Attachment(decoded)).toBe('hello');
  });

  test('gives an actionable error for image-only providers', () => {
    const decoded = decodeChatAttachments([
      {
        kind: 'file',
        name: 'notes.txt',
        mimeType: 'text/plain',
        size: 5,
        dataUrl: 'data:text/plain;base64,aGVsbG8=',
      },
    ]);

    expect(() => rejectFileAttachments('Codex', decoded)).toThrow(
      'Attach an image or paste the file contents as text',
    );
  });
});
