// @vitest-environment jsdom

import { beforeEach, describe, expect, test, vi } from 'vitest';

const { authenticatedFetch } = vi.hoisted(() => ({
  authenticatedFetch: vi.fn(),
}));
vi.mock('@kontourai/station-sdk', () => ({ authenticatedFetch }));

import {
  RetryAttachmentsUnavailableError,
  resolveRetryAttachments,
  retryAttachmentsFromParts,
} from '../retry-attachments';

const REF = `sha256-${'b'.repeat(64)}`;

beforeEach(() => {
  authenticatedFetch.mockReset();
});

describe('recovering a failed turn s attachments (station#3385)', () => {
  test('keeps a reference-only part instead of filtering it away', () => {
    const attachments = retryAttachmentsFromParts(
      [
        { type: 'text', content: 'what is this?' },
        { type: 'file', blobRef: REF, mediaType: 'image/png', name: 'a.png' },
        {
          type: 'file',
          url: 'data:image/png;base64,aGk=',
          mediaType: 'image/png',
          name: 'b.png',
        },
      ],
      'retry-3',
    );

    // The old filter kept only the inline one, which is how a retry became
    // silently text-only for a restored transcript.
    expect(attachments).toHaveLength(2);
    expect(attachments[0]).toMatchObject({ kind: 'reference', blobRef: REF });
    expect(attachments[1]).toMatchObject({ kind: 'inline', name: 'b.png' });
    // Decoded bytes, not the data URL's length — `data:image/png;base64,aGk=`
    // is 26 characters carrying 2 bytes.
    expect(attachments[1]).toMatchObject({ size: 2 });
  });

  test('fetches referenced bytes back into a data URL the send path can carry', async () => {
    authenticatedFetch.mockResolvedValueOnce(
      new Response(new Uint8Array([104, 105]), { status: 200 }),
    );

    const [resolved] = await resolveRetryAttachments(
      [
        {
          kind: 'reference',
          id: 'r-0',
          name: 'a.png',
          type: 'image/png',
          blobRef: REF,
        },
      ],
      'http://station.test',
    );

    expect(authenticatedFetch).toHaveBeenCalledWith(
      `http://station.test/api/attachments/${REF}`,
    );
    expect(resolved.data).toBe('data:image/png;base64,aGk=');
    expect(resolved.size).toBe(2);
  });

  test('refuses the whole retry when any attachment cannot be recovered', async () => {
    authenticatedFetch.mockResolvedValueOnce(
      new Response(null, { status: 404 }),
    );

    await expect(
      resolveRetryAttachments(
        [
          {
            kind: 'inline',
            id: 'r-0',
            name: 'kept.png',
            type: 'image/png',
            size: 4,
            data: 'data:image/png;base64,aGk=',
          },
          {
            kind: 'reference',
            id: 'r-1',
            name: 'reclaimed.png',
            type: 'image/png',
            blobRef: REF,
          },
        ],
        'http://station.test',
      ),
      // Sending the one that survived would be the silent subset — the caller
      // must be able to say WHICH attachment is gone.
    ).rejects.toThrowError(
      expect.objectContaining({
        name: 'RetryAttachmentsUnavailableError',
        names: ['reclaimed.png'],
      }) as unknown as Error,
    );
  });

  test('a part carrying neither bytes nor a reference fails rather than vanishing', async () => {
    await expect(
      resolveRetryAttachments(
        [
          {
            kind: 'reference',
            id: 'r-0',
            name: 'unknown.png',
            type: 'image/png',
            blobRef: '',
          },
        ],
        'http://station.test',
      ),
    ).rejects.toBeInstanceOf(RetryAttachmentsUnavailableError);
    expect(authenticatedFetch).not.toHaveBeenCalled();
  });

  test('sends everything when every attachment resolves', async () => {
    authenticatedFetch.mockResolvedValueOnce(
      new Response(new Uint8Array([104, 105]), { status: 200 }),
    );

    const resolved = await resolveRetryAttachments(
      [
        {
          kind: 'inline',
          id: 'r-0',
          name: 'inline.png',
          type: 'image/png',
          size: 4,
          data: 'data:image/png;base64,aGk=',
        },
        {
          kind: 'reference',
          id: 'r-1',
          name: 'fetched.png',
          type: 'image/png',
          blobRef: REF,
        },
      ],
      'http://station.test',
    );

    // Order preserved, and no `kind` leaks into the send payload.
    expect(resolved.map((a) => a.name)).toEqual(['inline.png', 'fetched.png']);
    expect(resolved.every((a) => !('kind' in a))).toBe(true);
  });
});
