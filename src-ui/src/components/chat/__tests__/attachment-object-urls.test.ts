// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  acquireAttachmentObjectUrl,
  moveAttachmentObjectUrl,
  peekAttachmentObjectUrl,
  releaseAttachmentObjectUrl,
  resetAttachmentObjectUrls,
  seedAttachmentObjectUrl,
  storeAttachmentObjectUrl,
} from '../attachment-object-urls';

const revokeObjectURL = vi.fn();

beforeEach(() => {
  Object.assign(URL, { revokeObjectURL });
  revokeObjectURL.mockClear();
});

afterEach(() => {
  resetAttachmentObjectUrls();
});

describe('attachment object-URL cache (station#3385)', () => {
  test('one URL per reference, and the loser of a mint race is the one revoked', () => {
    const winner = storeAttachmentObjectUrl('ref-a', 'blob:first');
    const loser = storeAttachmentObjectUrl('ref-a', 'blob:second');

    // Two URLs for one digest would break the preview gallery, which
    // identifies the displayed image by its URL string.
    expect(winner).toBe('blob:first');
    expect(loser).toBe('blob:first');
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:second');
    expect(peekAttachmentObjectUrl('ref-a')).toBe('blob:first');
  });

  test('an entry a component is displaying survives eviction pressure', () => {
    storeAttachmentObjectUrl('held', 'blob:held');

    // Far past the 32-entry idle budget, with the held entry oldest.
    for (let index = 0; index < 80; index += 1) {
      storeAttachmentObjectUrl(`idle-${index}`, `blob:idle-${index}`);
      releaseAttachmentObjectUrl(`idle-${index}`);
    }

    // Revoking a URL a mounted <img> is using would blank a picture the user
    // is looking at, which is worse than holding the bytes.
    expect(peekAttachmentObjectUrl('held')).toBe('blob:held');
    expect(revokeObjectURL).not.toHaveBeenCalledWith('blob:held');
    // Pressure was genuinely applied, so the survival above means something.
    expect(revokeObjectURL.mock.calls.length).toBeGreaterThan(40);
  });

  test('an entry becomes evictable once its last holder leaves', () => {
    storeAttachmentObjectUrl('transient', 'blob:transient');
    releaseAttachmentObjectUrl('transient');

    for (let index = 0; index < 40; index += 1) {
      storeAttachmentObjectUrl(`filler-${index}`, `blob:filler-${index}`);
      releaseAttachmentObjectUrl(`filler-${index}`);
    }

    expect(revokeObjectURL).toHaveBeenCalledWith('blob:transient');
    expect(peekAttachmentObjectUrl('transient')).toBeUndefined();
  });

  test('remount reuses the cached URL instead of minting a second one', () => {
    storeAttachmentObjectUrl('ref-b', 'blob:b');
    releaseAttachmentObjectUrl('ref-b');

    // The unmount/remount race: released, not yet evicted, then re-acquired.
    expect(acquireAttachmentObjectUrl('ref-b')).toBe('blob:b');
    expect(revokeObjectURL).not.toHaveBeenCalled();

    // Two mounts, two releases — the second must not double-decrement into a
    // state where a still-mounted holder looks idle.
    acquireAttachmentObjectUrl('ref-b');
    releaseAttachmentObjectUrl('ref-b');
    for (let index = 0; index < 40; index += 1) {
      storeAttachmentObjectUrl(`pressure-${index}`, `blob:pressure-${index}`);
      releaseAttachmentObjectUrl(`pressure-${index}`);
    }
    expect(peekAttachmentObjectUrl('ref-b')).toBe('blob:b');
  });

  test('acquiring an unknown reference reports a miss rather than inventing one', () => {
    expect(acquireAttachmentObjectUrl('never-fetched')).toBeUndefined();
    expect(peekAttachmentObjectUrl('never-fetched')).toBeUndefined();
  });

  // A chip's first render shows a seeded (or moved) URL before its effect takes
  // a hold; eviction in that gap would revoke what it is already showing.
  function crowdOut() {
    for (let index = 0; index < 40; index += 1) {
      storeAttachmentObjectUrl(`idle-${index}`, `blob:idle-${index}`);
      releaseAttachmentObjectUrl(`idle-${index}`);
    }
  }
  test('seeded bytes survive eviction until their chip can hold them, then become ordinary idle entries', () => {
    vi.useFakeTimers();
    try {
      Object.assign(URL, { createObjectURL: () => 'blob:seeded' });
      seedAttachmentObjectUrl('seeded', new Blob([new Uint8Array([1])]));
      crowdOut();
      expect(peekAttachmentObjectUrl('seeded')).toBe('blob:seeded');
      vi.advanceTimersByTime(10_000);
      crowdOut();
      expect(peekAttachmentObjectUrl('seeded')).toBeUndefined();
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:seeded');
    } finally {
      vi.useRealTimers();
    }
  });

  test('a moved entry is found only under its new key, and survives eviction until its chip can hold it', () => {
    vi.useFakeTimers();
    try {
      storeAttachmentObjectUrl(
        'thumbnail data:image/png;base64,AAAA',
        'blob:thumb',
      );
      moveAttachmentObjectUrl(
        'thumbnail data:image/png;base64,AAAA',
        'thumbnail ref',
      );
      expect(
        peekAttachmentObjectUrl('thumbnail data:image/png;base64,AAAA'),
      ).toBeUndefined();
      // The hold taken under the old key no longer pins anything.
      releaseAttachmentObjectUrl('thumbnail data:image/png;base64,AAAA');
      crowdOut();
      expect(peekAttachmentObjectUrl('thumbnail ref')).toBe('blob:thumb');
      vi.advanceTimersByTime(10_000);
      crowdOut();
      expect(peekAttachmentObjectUrl('thumbnail ref')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
