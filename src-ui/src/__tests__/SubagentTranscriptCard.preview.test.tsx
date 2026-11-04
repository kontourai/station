/**
 * @vitest-environment jsdom
 *
 * #4266: the collapsed subagent card shows one plain line of the stored
 * summary. A summary that opens "Found three test issues in `e80310601`:"
 * and lists them below used to stop at the colon, with its code span's
 * backticks shown and, once cut, a stray backtick left behind.
 */

import type { ChildWorkItem } from '@kontourai/station-contracts/child-work';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import {
  SubagentTranscriptCard,
  subagentSummaryPreview,
} from '../components/chat/SubagentTranscriptCard';

afterEach(cleanup);

const SUMMARY = [
  'Found three test issues in `e80310601`:',
  '',
  '- `tool-call-groups.test.ts` pins the **old** count',
  '- [the fixture](https://example.test/f) is stale',
  '- `ToolCallBatch` misses a state',
].join('\n');

function card(summary: string) {
  const item: ChildWorkItem = {
    producer: 'engine-subagent',
    reporterThreadId: 'thread-1',
    childId: 'child-1',
    status: 'completed',
    parent: { toolCallId: 'call-1', turnId: 'turn-1' },
    title: 'Review the tests',
    startedAt: '2026-10-28T00:00:00.000Z',
    endedAt: '2026-10-28T00:01:05.000Z',
    result: { summary },
  } as ChildWorkItem;
  const { container } = render(
    <SubagentTranscriptCard
      child={{ item, provider: 'claude', toolAnchor: true }}
    />,
  );
  return container.querySelector('.subagent-card__preview')?.textContent;
}

describe('subagent card preview', () => {
  test('a first line ending in ":" carries the first list item, with no Markdown syntax', () => {
    const preview = card(SUMMARY);
    expect(preview).toBe(
      'Found three test issues in e80310601: tool-call-groups.test.ts pins the old count',
    );
    expect(preview).not.toContain('`');
    expect(preview).not.toContain('*');
  });

  test('a plain first line is shown as it reads', () => {
    expect(subagentSummaryPreview('## Done\n\nAll **green**.')).toBe('Done');
    expect(subagentSummaryPreview('```ts\nconst a = 1;\n```')).toBe(
      'const a = 1;',
    );
    expect(subagentSummaryPreview('Checked `a` and `b`.')).toBe(
      'Checked a and b.',
    );
    expect(subagentSummaryPreview('Notes:\n\nNo list follows.')).toBe('Notes:');
  });
});
