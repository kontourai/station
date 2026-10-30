/**
 * A Claude Code Artifact publish's link survives a history read. The Claude
 * adapter reads it from the SDK's structured tool output, which the stored
 * text output does not carry, so the window cannot derive it again: it must
 * keep the field the adapter put on the event. Driven through a real
 * EventStore window read (a cut excerpt, and an output spilled out of line)
 * and the real transcript projection.
 */
import { join } from 'node:path';
import { projectRuntimeEventsToMessages } from '@kontourai/station-shared/runtime-event-projection';
import { expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { EventStore } from '../event-store.js';

const makeTempDir = trackTempDirs();

const URL =
  'https://claude.ai/code/artifact/5f0c2e4a-8d1b-4c33-9a7e-1b2c3d4e5f60';

test('a publish link is kept on a windowed and a spilled tool result, and reaches the transcript part', () => {
  const store = new EventStore(
    join(makeTempDir('claude-artifact-window-'), 'events.sqlite'),
  );
  const base = {
    provider: 'claude' as const,
    threadId: 'artifact',
    turnId: 'turn',
    createdAt: '2026-10-29T12:00:00.000Z',
  };
  try {
    store.appendEvent({
      ...base,
      eventId: 'start',
      method: 'turn.started',
      prompt: 'Publish the report',
    });
    for (const [id, output, claudeArtifact] of [
      // Longer than the window's excerpt, so the served output is cut.
      [
        'excerpt',
        `Published Q3 latency report at ${URL}. ${'detail '.repeat(40)}`,
        { url: URL, title: 'Q3 latency report' },
      ],
      // Over the stored-event target, so the output moves out of line.
      ['spilled', 'x'.repeat(40 * 1024), { url: URL }],
      // A stored link that does not check out is not served as one.
      ['lookalike', 'Published.', { url: 'https://claude.ai.evil.example/a' }],
    ] as const) {
      store.appendEvent({
        ...base,
        eventId: `${id}-call`,
        method: 'tool.started',
        itemId: id,
        toolCallId: id,
        toolName: 'Artifact',
        arguments: { file_path: '/workspace/report.html' },
      });
      store.appendEvent({
        ...base,
        eventId: id,
        method: 'tool.completed',
        itemId: id,
        toolCallId: id,
        toolName: 'Artifact',
        status: 'success',
        output,
        claudeArtifact,
      });
    }
    const window = store.listEventWindowByTurn(base.threadId, {
      turnLimit: 1,
    });
    const served = (id: string) =>
      window.events.find((event) => event.id === id)?.payload as
        | Record<string, unknown>
        | undefined;
    // Both cases really took the lossy paths they are named for.
    expect(window.events.find((e) => e.id === 'excerpt')?.elided).toBe(
      'output_limit',
    );
    expect(served('spilled')?.spilledContent).toBeDefined();

    const parts = projectRuntimeEventsToMessages(
      window.events.map((event) => event.payload),
    ).flatMap((message) => message.parts);
    const part = (id: string) => parts.find((p) => p.toolCallId === id);
    expect(part('excerpt')?.claudeArtifact).toEqual({
      url: URL,
      title: 'Q3 latency report',
    });
    expect(part('spilled')?.claudeArtifact).toEqual({ url: URL });
    expect(part('lookalike')).toBeDefined();
    expect(part('lookalike')?.claudeArtifact).toBeUndefined();
  } finally {
    store.close();
  }
});
