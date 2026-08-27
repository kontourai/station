import { describe, expect, test } from 'vitest';
import {
  deriveLatestPlanArtifactFromMessages,
  derivePlanArtifactFromStreamingState,
  derivePlanArtifactFromText,
} from '../utils/planArtifacts';

describe('plan artifact helpers', () => {
  test('parses checklist and emoji plan text into structured steps', () => {
    expect(
      derivePlanArtifactFromText(
        '- [x] Ship runtime plumbing\n- [ ] Render the panel',
        'assistant',
        '2026-01-01T00:00:00.000Z',
      ),
    ).toEqual({
      source: 'assistant',
      rawText: '- [x] Ship runtime plumbing\n- [ ] Render the panel',
      steps: [
        { content: 'Ship runtime plumbing', status: 'completed' },
        { content: 'Render the panel', status: 'pending' },
      ],
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  test('ignores non-plan text and prefers the latest assistant plan message', () => {
    expect(derivePlanArtifactFromText('Hello world', 'assistant')).toBeNull();

    const artifact = deriveLatestPlanArtifactFromMessages([
      { role: 'assistant', content: 'No plan here' },
      {
        role: 'assistant',
        content: 'Implementation notes',
        contentParts: [{ type: 'reasoning', content: '✅ First\n🔄 Second' }],
      },
    ] as any);

    expect(artifact).toEqual(
      expect.objectContaining({
        source: 'reasoning',
        steps: [
          { content: 'First', status: 'completed' },
          { content: 'Second', status: 'in_progress' },
        ],
      }),
    );
  });

  test('derives plan artifacts from streaming state and falls back to cached artifact', () => {
    const cached = derivePlanArtifactFromText('- first\n- second', 'assistant');

    expect(
      derivePlanArtifactFromStreamingState({
        streamingMessage: {
          role: 'assistant',
          content: '',
          contentParts: [{ type: 'reasoning', content: '✅ first\n⬜ second' }],
        },
        planArtifact: null,
      }),
    ).toEqual(
      expect.objectContaining({
        source: 'reasoning',
        steps: [
          { content: 'first', status: 'completed' },
          { content: 'second', status: 'pending' },
        ],
      }),
    );

    expect(
      derivePlanArtifactFromStreamingState({
        streamingMessage: {
          role: 'assistant',
          content: 'plain response',
        },
        planArtifact: cached,
      }),
    ).toEqual(cached);

    // Characterization, not a fix-discriminating test: this fallback
    // predates station#3351. It pins the by-reference contract the
    // derived-session reuse path (useDerivedSessions) depends on — if this
    // ever started minting a fresh object for non-plan text, the fallback
    // would bust that cache per token.
    expect(
      derivePlanArtifactFromStreamingState({
        streamingMessage: {
          role: 'assistant',
          content: 'plain response',
          contentParts: [{ type: 'text', content: 'plain response' }],
        },
        planArtifact: cached,
      }),
    ).toBe(cached);
  });
});
