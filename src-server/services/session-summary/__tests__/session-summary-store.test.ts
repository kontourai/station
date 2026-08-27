import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  FileSessionSummaryStore,
  isStoredSessionSummary,
  SessionSummaryCoordinator,
} from '../session-summary-store.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe('FileSessionSummaryStore', () => {
  test('persists a derived record outside the transcript and keeps dismissal across a fresh reader', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-session-summary-'));
    roots.push(root);
    const first = new FileSessionSummaryStore(root);
    const alpha = {
      ownerScope: 'tenant:alpha',
      agentSlug: 'station',
      conversationId: 'c1',
    };
    await first.write(alpha, {
      version: 2,
      text: 'Derived output',
      overview: 'Derived output',
      goals: [],
      constraints: [],
      progress: [],
      nextSteps: [],
      reportedCompletion: [],
      relatedEvidenceRefs: [],
      verificationRefs: [],
      model: 'structure-model',
      generatedAt: '2026-08-16T12:00:00.000Z',
      sourceRange: {
        fromMessageId: 'm1',
        throughMessageId: 'm2',
        messageCount: 2,
      },
      sourceRevision: 'revision',
      sourceRanges: [
        { fromMessageId: 'm1', throughMessageId: 'm2', messageCount: 2 },
      ],
      sourceMessageCount: 2,
      partialMessageIncluded: false,
      contextBoundaryCount: 0,
      contextBoundaries: [],
      generationUsage: { state: 'unknown' },
    });
    expect(await new FileSessionSummaryStore(root).read(alpha)).toMatchObject({
      text: 'Derived output',
    });
    expect(
      await new FileSessionSummaryStore(root).read({
        ...alpha,
        ownerScope: 'tenant:bravo',
      }),
    ).toBeNull();
    await first.dismiss(alpha);
    expect(await new FileSessionSummaryStore(root).read(alpha)).toMatchObject({
      dismissedAt: expect.any(String),
    });
  });

  test('reads v1 at its old agent path but v2 survives an agent handoff and delete reaps both', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-session-summary-v2-'));
    roots.push(root);
    const coordinate = {
      ownerScope: 'user:alpha',
      agentSlug: 'old-agent',
      conversationId: 'c1',
    };
    const oldPath = join(
      root,
      'session-summaries',
      encodeURIComponent(coordinate.ownerScope),
      encodeURIComponent(coordinate.agentSlug),
      `${coordinate.conversationId}.json`,
    );
    mkdirSync(join(oldPath, '..'), { recursive: true });
    writeFileSync(
      oldPath,
      JSON.stringify({
        text: 'old',
        model: 'm',
        generatedAt: 'now',
        summarizedFromMessageId: 'm1',
        summarizedThroughMessageId: 'm1',
        summarizedMessageCount: 1,
        sourceMessageCount: 1,
        partialMessageIncluded: false,
      }),
    );
    const store = new FileSessionSummaryStore(root);
    expect(await store.read(coordinate)).toMatchObject({ text: 'old' });
    await store.write(coordinate, {
      version: 2,
      text: 'new',
      overview: 'new',
      goals: [],
      constraints: [],
      progress: [],
      nextSteps: [],
      reportedCompletion: [],
      relatedEvidenceRefs: [],
      verificationRefs: [],
      model: 'm',
      generatedAt: 'now',
      sourceRange: {
        fromMessageId: 'm1',
        throughMessageId: 'm1',
        messageCount: 1,
      },
      sourceRevision: 'r',
      sourceRanges: [
        { fromMessageId: 'm1', throughMessageId: 'm1', messageCount: 1 },
      ],
      sourceMessageCount: 1,
      partialMessageIncluded: false,
      contextBoundaryCount: 0,
      contextBoundaries: [],
      generationUsage: { state: 'unknown' },
    });
    expect(
      await store.read({ ...coordinate, agentSlug: 'third-agent' }),
    ).toMatchObject({ version: 2, text: 'new' });
    await store.dismiss(coordinate);
    expect(await store.read(coordinate)).toMatchObject({
      dismissedAt: expect.any(String),
    });
  });

  test('fences overlapping generation and makes a prior epoch unable to resurrect after dismiss', () => {
    const coordinator = new SessionSummaryCoordinator();
    const coordinate = { ownerScope: 'user:alpha', conversationId: 'c1' };
    const first = coordinator.begin(coordinate);
    expect(first).not.toBeNull();
    expect(coordinator.begin(coordinate)).toBeNull();
    coordinator.invalidate(coordinate);
    expect(coordinator.current(first!)).toBe(false);
    coordinator.finish(first!);
    expect(coordinator.begin(coordinate)).not.toBeNull();
  });

  test('a timed-out provider remains exclusive until its underlying call settles', async () => {
    const coordinator = new SessionSummaryCoordinator();
    const coordinate = { ownerScope: 'user:alpha', conversationId: 'c1' };
    const token = coordinator.begin(coordinate)!;
    let settle!: () => void;
    const pending = new Promise<void>((resolve) => {
      settle = resolve;
    });
    coordinator.finishWhenSettled(token, pending);
    expect(coordinator.begin(coordinate)).toBeNull();
    settle();
    await pending;
    await Promise.resolve();
    expect(coordinator.begin(coordinate)).not.toBeNull();
  });

  test('a rejected timed-out provider releases the fence without a derived unhandled rejection', async () => {
    const coordinator = new SessionSummaryCoordinator();
    const coordinate = { ownerScope: 'user:alpha', conversationId: 'c1' };
    const token = coordinator.begin(coordinate)!;
    const rejected = Promise.reject(new Error('provider aborted'));
    // The coordinator must attach the rejection handler synchronously.
    coordinator.finishWhenSettled(token, rejected);
    await rejected.catch(() => undefined);
    await Promise.resolve();
    expect(coordinator.begin(coordinate)).not.toBeNull();
  });

  test('dismissal persists independently from destructive deletion', async () => {
    const root = mkdtempSync(
      join(tmpdir(), 'station-session-summary-dismiss-'),
    );
    roots.push(root);
    const store = new FileSessionSummaryStore(root);
    const coordinate = { ownerScope: 'user:alpha', conversationId: 'c1' };
    const summary = {
      version: 2 as const,
      text: 'safe',
      overview: 'safe',
      goals: [],
      constraints: [],
      progress: [],
      nextSteps: [],
      reportedCompletion: [],
      relatedEvidenceRefs: [],
      verificationRefs: [],
      model: 'm',
      generatedAt: 'now',
      sourceRange: {
        fromMessageId: 'm1',
        throughMessageId: 'm1',
        messageCount: 1,
      },
      sourceRanges: [
        { fromMessageId: 'm1', throughMessageId: 'm1', messageCount: 1 },
      ],
      sourceRevision: 'r',
      sourceMessageCount: 1,
      partialMessageIncluded: false,
      contextBoundaryCount: 0,
      contextBoundaries: [],
      generationUsage: { state: 'unknown' as const },
    };
    await store.write(coordinate, summary);
    await store.dismiss(coordinate);
    expect(await store.read(coordinate)).toMatchObject({
      dismissedAt: expect.any(String),
    });
    await store.show(coordinate);
    expect(await store.read(coordinate)).not.toHaveProperty('dismissedAt');
    await store.delete(coordinate);
    expect(await store.read(coordinate)).toBeNull();
  });

  test('fails closed for future/corrupt v2 records and rejects oversized writes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-session-summary-limits-'));
    roots.push(root);
    const store = new FileSessionSummaryStore(root);
    const coordinate = { ownerScope: 'user:alpha', conversationId: 'c1' };
    const path = join(
      root,
      'conversation-intent-summaries',
      'v2',
      encodeURIComponent(coordinate.ownerScope),
      `${coordinate.conversationId}.json`,
    );
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, '{not-json');
    expect(await store.read(coordinate)).toBeNull();
    writeFileSync(path, JSON.stringify({ version: 3, overview: 'future' }));
    expect(await store.read(coordinate)).toBeNull();
    writeFileSync(path, 'x'.repeat(32 * 1024 + 1));
    expect(await store.read(coordinate)).toBeNull();
    await expect(
      store.write(coordinate, {
        version: 2,
        text: 'x'.repeat(40_000),
        overview: 'x'.repeat(40_000),
        goals: [],
        constraints: [],
        progress: [],
        nextSteps: [],
        reportedCompletion: [],
        relatedEvidenceRefs: [],
        verificationRefs: [],
        model: 'm',
        generatedAt: 'now',
        sourceRange: {
          fromMessageId: 'm1',
          throughMessageId: 'm1',
          messageCount: 1,
        },
        sourceRanges: [
          { fromMessageId: 'm1', throughMessageId: 'm1', messageCount: 1 },
        ],
        sourceRevision: 'r',
        sourceMessageCount: 1,
        partialMessageIncluded: false,
        contextBoundaryCount: 0,
        contextBoundaries: [],
        generationUsage: { state: 'unknown' },
      }),
    ).rejects.toThrow('32 KiB');
  });

  test('accepts 32 structural refs and rejects 33 before write', () => {
    const related = Array.from({ length: 32 }, (_, index) => ({
      kind: 'task-turn' as const,
      taskId: `task-${index}`,
      turnId: `turn-${index}`,
      eventId: `event-${index}`,
    }));
    const verification = Array.from({ length: 32 }, () => ({
      kind: 'task-turn' as const,
      state: 'unavailable' as const,
      unavailableReason: 'not-captured-by-station' as const,
    }));
    const summary = {
      version: 2,
      text: 'summary',
      overview: 'summary',
      goals: [],
      constraints: [],
      progress: [],
      nextSteps: [],
      reportedCompletion: [],
      relatedEvidenceRefs: related,
      verificationRefs: verification,
      model: 'model',
      generatedAt: '2026-08-25T00:00:00.000Z',
      sourceRange: {
        fromMessageId: 'm1',
        throughMessageId: 'm1',
        messageCount: 1,
      },
      sourceRanges: [
        { fromMessageId: 'm1', throughMessageId: 'm1', messageCount: 1 },
      ],
      sourceRevision: 'revision',
      sourceMessageCount: 1,
      partialMessageIncluded: false,
      contextBoundaryCount: 0,
      contextBoundaries: [],
      generationUsage: { state: 'unknown' as const },
    };
    expect(isStoredSessionSummary(summary)).toBe(true);
    expect(
      isStoredSessionSummary({
        ...summary,
        relatedEvidenceRefs: [...related, related[0]!],
      }),
    ).toBe(false);
    expect(
      isStoredSessionSummary({
        ...summary,
        verificationRefs: [...verification, verification[0]!],
      }),
    ).toBe(false);
  });
});
