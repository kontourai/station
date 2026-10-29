import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { OrchestrationSessionDetail } from '@kontourai/station-contracts/orchestration';
import { INTERNAL_SESSION_READ_SCOPE } from '@kontourai/station-contracts/tenancy';
import { projectRuntimeEventsToMessages } from '@kontourai/station-shared/runtime-event-projection';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { ConversationLineage } from '../conversation-lineage.js';
import { TRANSCRIPT_SEED_OMITTED_NOTICE } from '../conversation-transcript-seed.js';
import { EventStore } from '../event-store.js';
import { SessionTranscriptReads } from '../session-transcript-reads.js';

/**
 * docs/design/event-content-spill.md: a reply stored out of line keeps only a
 * short preview in its event. The transcript seeds an engine receives must
 * read it at its real size, through the seed-only reader, while the UI and
 * history projection keeps the reference.
 */

const ROOT = 'seed-spill';

function stoppedDetail(threadId: string): OrchestrationSessionDetail {
  return {
    session: {
      threadId,
      provider: 'claude',
      status: 'closed',
      lifecycleState: 'canceled',
      controlMode: 'station-owned',
      answerability: {
        answerable: false,
        qualification: 'past_resume',
        observedBy: 'conversation-seed-spilled-content-test',
        observedAt: '2026-10-01T00:00:00.000Z',
      },
      isLoaded: false,
      isPersisted: true,
      eventCount: 0,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:01.000Z',
    },
    events: [],
  };
}

/** A reply whose start and tail are distinct, so the seed's copy is checkable. */
function reply(bytes: number): string {
  const head = '[reply:start]';
  const tail = '[reply:tail-beyond-preview]';
  return `${head} ${'x'.repeat(bytes - head.length - tail.length - 2)} ${tail}`;
}

describe('engine seeds read content stored out of line', () => {
  const makeTempDir = trackTempDirs();
  let store: EventStore;
  let dbPath: string;
  let canRead: boolean;
  let resolveSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dbPath = join(makeTempDir('seed-spill-'), 'orchestration.sqlite');
    store = new EventStore(dbPath);
    store.upsertSession({
      provider: 'claude',
      threadId: ROOT,
      status: 'closed',
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:01.000Z',
    } as never);
    canRead = true;
    resolveSpy = vi.spyOn(store, 'resolveEventContent');
  });

  afterEach(() => {
    store.close();
  });

  function appendTurn(outputText: string): void {
    const at = (ms: number) =>
      new Date(Date.UTC(2026, 9, 1, 0, 0, 0, ms)).toISOString();
    store.appendEvent({
      eventId: 'turn-started',
      provider: 'claude',
      threadId: ROOT,
      method: 'turn.started',
      turnId: 'turn-1',
      prompt: 'Summarise the report.',
      createdAt: at(0),
    });
    store.appendEvent({
      eventId: 'turn-completed',
      provider: 'claude',
      threadId: ROOT,
      method: 'turn.completed',
      turnId: 'turn-1',
      finishReason: 'stop',
      outputText,
      createdAt: at(1),
    });
  }

  /**
   * The transcript reader and the lineage, composed the way
   * OrchestrationService composes them: `listEventPayloads` keeps
   * references, `listResolvedEventPayloads` resolves them.
   */
  function compose() {
    const reads = new SessionTranscriptReads({
      canReadSession: () => canRead,
      listEventPayloads: (threadId: string) =>
        store.listEventPayloads(threadId),
      listResolvedEventPayloads: (threadId: string) =>
        store
          .resolveEventContent(store.listEvents(threadId))
          .map((event) => event.payload),
    } as never);
    const lineage = new ConversationLineage({
      eventStore: store,
      logger: { warn: vi.fn() },
      readSession: async (threadId) =>
        threadId === ROOT ? stoppedDetail(ROOT) : null,
      readSessionMessages: (threadId, authority) =>
        reads.readSessionMessages(threadId, authority),
      readSessionSeedMessages: (threadId, authority) =>
        reads.readSessionSeedMessages(threadId, authority),
      listSessionReadModel: async () => [],
      canReadSession: () => canRead,
    });
    return { reads, lineage };
  }

  test('a spilled reply within the seed budget reaches the engine whole, past its preview', async () => {
    const text = reply(20_000);
    appendTurn(text);
    // Stored out of line: the event itself holds only a reference.
    expect(store.listEventPayloads(ROOT).at(-1)).toMatchObject({
      outputText: { $stationContent: 1 },
    });

    const { lineage } = compose();
    const resolved = await lineage.resolveConversationContinuation(
      ROOT,
      INTERNAL_SESSION_READ_SCOPE,
      { provider: 'codex' },
    );

    expect(resolved.transcriptSeed).toContain('[reply:start]');
    expect(resolved.transcriptSeed).toContain('[reply:tail-beyond-preview]');
    expect(resolved.transcriptSeed).not.toContain(
      TRANSCRIPT_SEED_OMITTED_NOTICE,
    );
  });

  test('a spilled reply over the seed budget is disclosed as omitted, not shortened to its preview', async () => {
    appendTurn(reply(200_000));
    const { lineage } = compose();
    const resolved = await lineage.resolveConversationContinuation(
      ROOT,
      INTERNAL_SESSION_READ_SCOPE,
      { provider: 'codex' },
    );
    expect(resolved.transcriptSeed).toContain(TRANSCRIPT_SEED_OMITTED_NOTICE);
  });

  test('a caller that may not read the Session resolves nothing', () => {
    appendTurn(reply(20_000));
    canRead = false;
    const { reads } = compose();
    expect(
      reads.readSessionSeedMessages(ROOT, INTERNAL_SESSION_READ_SCOPE),
    ).toEqual([]);
    expect(resolveSpy).not.toHaveBeenCalled();
  });

  test('UI and history reads keep the reference-bearing projection', () => {
    appendTurn(reply(20_000));
    const { reads } = compose();
    const messages = reads.readSessionMessages(
      ROOT,
      INTERNAL_SESSION_READ_SCOPE,
    );
    const shown = JSON.stringify(messages);
    expect(shown).toContain('[reply:start]');
    expect(shown).not.toContain('[reply:tail-beyond-preview]');
    expect(resolveSpy).not.toHaveBeenCalled();
    // The same projection the UI reads from the stored payloads.
    expect(messages).toEqual(
      projectRuntimeEventsToMessages(store.listEventPayloads(ROOT)),
    );
  });

  test('a reply whose stored content is missing is not presented as complete', () => {
    appendTurn(reply(20_000));
    const db = new DatabaseSync(dbPath);
    try {
      db.prepare(
        'DELETE FROM orchestration_event_content WHERE thread_id = ?',
      ).run(ROOT);
    } finally {
      db.close();
    }
    const { reads } = compose();
    const seedMessages = JSON.stringify(
      reads.readSessionSeedMessages(ROOT, INTERNAL_SESSION_READ_SCOPE),
    );
    expect(seedMessages).toContain('[content not available]');
    expect(seedMessages).not.toContain('[reply:tail-beyond-preview]');
    expect(seedMessages).not.toContain('[reply:start]');
  });
});
