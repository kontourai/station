import { describe, expect, test } from 'vitest';
import { approvalContentQueryKey } from '../query-domains/runtimeEventContent';

describe('approval content query key', () => {
  test('changes when the references shown for the call change', () => {
    const base = {
      threadId: 't',
      requestId: 'r',
      requestEventId: 'e',
      shownRefs: [`sha256-${'a'.repeat(64)}`],
    };
    expect(approvalContentQueryKey(base)).not.toEqual(
      approvalContentQueryKey({
        ...base,
        shownRefs: [`sha256-${'b'.repeat(64)}`],
      }),
    );
    expect(approvalContentQueryKey(base)).not.toEqual(
      approvalContentQueryKey({ ...base, shownRefs: [] }),
    );
    expect(approvalContentQueryKey({ ...base, shownRefs: ['y', 'x'] })).toEqual(
      approvalContentQueryKey({ ...base, shownRefs: ['x', 'y'] }),
    );
  });
});
