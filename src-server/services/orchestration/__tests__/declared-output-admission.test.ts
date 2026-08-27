import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { afterEach, describe, expect, test } from 'vitest';
import { EventStore } from '../event-store.js';

const directories: string[] = [];
afterEach(() =>
  directories
    .splice(0)
    .forEach((directory) =>
      rmSync(directory, { recursive: true, force: true }),
    ),
);

type TerminalEvent = Extract<
  CanonicalRuntimeEvent,
  { method: 'turn.completed' }
>;

function terminal(eventId = randomUUID()): TerminalEvent {
  return {
    eventId,
    provider: 'station-agent',
    threadId: 'session-a',
    turnId: 'turn-a',
    createdAt: '2026-08-26T00:00:00.000Z',
    method: 'turn.completed',
    finishReason: 'stop',
  };
}

describe('EventStore declared-output admission', () => {
  test('commits descriptor and unique handle use in the terminal savepoint and accepts only exact event replay', () => {
    const directory = mkdtempSync(join(tmpdir(), 'station-declared-output-'));
    directories.push(directory);
    const store = new EventStore(join(directory, 'orchestration.sqlite'));
    try {
      const event = terminal('00000000-0000-4000-8000-000000000001');
      const admission = {
        handle: 'opaque-handle-a',
        declaration: {
          version: 'declared-output/v1' as const,
          declarationId: 'declaration-a',
          sessionId: 'session-a',
          eventId: event.eventId,
          turnId: 'turn-a',
          toolCallId: 'framework-call-a',
          declaredAt: event.createdAt,
          descriptor: {
            kind: 'workspace-file' as const,
            relativePath: 'report.txt',
            digest: 'a'.repeat(64),
            length: 12,
            mediaType: 'text/plain',
          },
        },
      };
      expect(store.appendEvent(event, [admission])).toBe(1);
      expect(store.appendEvent(event, [admission])).toBe(1);
      const conflictingReplay: TerminalEvent = {
        ...event,
        finishReason: 'cancelled',
      };
      expect(() => store.appendEvent(conflictingReplay, [admission])).toThrow(
        'replay does not match',
      );
      expect(() =>
        store.appendEvent(terminal('00000000-0000-4000-8000-000000000002'), [
          admission,
        ]),
      ).toThrow('Invalid declared output admission');
    } finally {
      store.close();
    }
  });
});
