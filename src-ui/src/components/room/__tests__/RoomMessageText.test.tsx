/** @vitest-environment jsdom */

import { parseProjectTaskRoomBrowserHistory } from '@kontourai/station-contracts/project-task-room-browser';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { RoomMessageText } from '../RoomMessageText';

afterEach(cleanup);

/**
 * A Task-room history page exactly as the room serves it, with a message
 * written before structured mentions: the Agent mention is the leading
 * `**@Label**` that task-room-conversation-module.ts writes.
 */
const legacyPage = {
  kind: 'available',
  records: [
    {
      actor: { kind: 'human', label: 'Maya Chen', id: 'human:deployment:maya' },
      sequence: 1,
      occurredAt: '2026-10-15T10:00:00.000Z',
      body: {
        kind: 'human-message',
        text: '**@Scout** can you find the cause?',
      },
      digests: { proposal: 'a'.repeat(64), checkpoint: 'b'.repeat(64) },
      integrity: 'L0',
    },
  ],
  checkpoint: {
    throughSeq: 1,
    checkpointDigest: 'b'.repeat(64),
    retainedAnchorSeq: 0,
    retainedAnchorDigest: 'c'.repeat(64),
  },
  hasMore: false,
  integrity: 'L0',
};

test('an old **@Name** message in its stored shape still renders the chip', async () => {
  const page = parseProjectTaskRoomBrowserHistory(legacyPage);
  if (page?.kind !== 'available') throw new Error('fixture must parse');
  const body = page.records[0]!.body;
  if (body.kind !== 'human-message')
    throw new Error('fixture must be a message');
  const { container } = render(<RoomMessageText text={body.text} />);
  const chip = container.querySelector('.task-room-mention');
  expect(chip?.textContent).toBe('@Scout');
  expect(await screen.findByText('can you find the cause?')).toBeTruthy();
  // The Markdown markers are not shown as text.
  expect(container.textContent).not.toContain('**');
});

test('a structured mention renders the current name by id, and the stored one when unknown', async () => {
  const mentions = [
    { actorId: 'human:deployment:priya', display: 'Priya', offset: 0 },
    { actorId: 'human:deployment:jonas', display: 'Jonas', offset: 11 },
  ];
  const text = '@Priya and @Jonas, **please** look';
  const names = new Map([['human:deployment:priya', 'Priya Natarajan']]);
  const { container } = render(
    <RoomMessageText
      text={text}
      mentions={mentions}
      nameOf={(id) => names.get(id)}
      selfId="human:deployment:jonas"
    />,
  );
  await screen.findByText('please');
  const chips = [...container.querySelectorAll('.room-mention')];
  expect(chips.map((chip) => chip.textContent)).toEqual([
    '@Priya Natarajan',
    '@Jonas',
  ]);
  expect(chips[1]?.className).toContain('room-mention--self');
  // Markdown around the mentions still renders.
  expect(container.querySelector('strong')?.textContent).toBe('please');
});
