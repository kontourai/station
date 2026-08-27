import { parseProjectTaskRoomBrowserHistory } from '@kontourai/station-contracts/project-task-room-browser';
import { describe, expect, test } from 'vitest';
import { taskRoomRevisionLink } from '../taskRoomRevisionLink';

function parsedRecord(kind: 'finished' | 'outcome-link') {
  const link = {
    kind: 'revision',
    stableId: 'revision-1',
    digest: 'c'.repeat(64),
  } as const;
  const history = parseProjectTaskRoomBrowserHistory({
    kind: 'available',
    records: [
      {
        actor: { kind: 'agent', label: 'Agent' },
        sequence: 1,
        body:
          kind === 'finished'
            ? {
                kind: 'live-work-finished',
                sessionId: 'session-1',
                outcome: 'completed',
                revision: link,
              }
            : { kind: 'outcome-link', link },
        digests: { proposal: 'a'.repeat(64), checkpoint: 'b'.repeat(64) },
        integrity: 'L0',
      },
    ],
    checkpoint: {
      throughSeq: 1,
      checkpointDigest: 'b'.repeat(64),
      retainedAnchorSeq: 0,
      retainedAnchorDigest: 'd'.repeat(64),
    },
    hasMore: false,
    integrity: 'L0',
  });
  if (history?.kind !== 'available') throw new Error('expected parsed history');
  return history.records[0]!;
}

describe('taskRoomRevisionLink', () => {
  test.each(['finished', 'outcome-link'] as const)(
    'binds a parser-accepted %s revision when capability is composed',
    (kind) => {
      expect(taskRoomRevisionLink(parsedRecord(kind), true)).toEqual({
        state: 'available',
        link: {
          kind: 'revision',
          stableId: 'revision-1',
          digest: 'c'.repeat(64),
        },
      });
    },
  );

  test('keeps a real revision unavailable without resolver composition', () => {
    expect(
      taskRoomRevisionLink(parsedRecord('outcome-link'), false),
    ).toMatchObject({ state: 'unavailable' });
  });
});
