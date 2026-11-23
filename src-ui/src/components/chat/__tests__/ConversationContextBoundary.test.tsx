// @vitest-environment jsdom

import type {
  ConversationContextBoundaryPolicy,
  ConversationContextBoundaryTranscriptMarker,
} from '@kontourai/station-contracts/conversation-context-boundary';
import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { ConversationContextBoundary } from '../ConversationContextBoundary';

function marker(
  policy: ConversationContextBoundaryPolicy,
): ConversationContextBoundaryTranscriptMarker {
  return {
    boundaryId: 'boundary-a',
    policy,
    // Mirrors the server: only continue-from-history injects the transcript.
    priorTranscriptInjected: policy === 'continue-from-history',
    successorSessionId: 'session-b',
    consumedAt: '2026-11-12T00:00:00.000Z',
  };
}

describe('ConversationContextBoundary', () => {
  test.each([
    ['continue-from-history', 'The agent rebuilt its memory from this chat.'],
    [
      'empty-next-cold-start',
      'The agent forgot everything above. You still see it.',
    ],
    [
      'summary-next-cold-start',
      'The agent kept only a summary of everything above. You still see it.',
    ],
    [
      'task-state-next-cold-start',
      'The agent kept only a summary of everything above. You still see it.',
    ],
  ] as const)(
    'marks a %s reset as a fresh context with its own line',
    (policy, body) => {
      const { container } = render(
        <ConversationContextBoundary boundary={marker(policy)} />,
      );
      expect(screen.getByText('Fresh context')).toBeTruthy();
      expect(screen.getByText(body)).toBeTruthy();
      // Text in reading order: no landmark, no label repeating it.
      expect(container.querySelector('[aria-label]')).toBeNull();
    },
  );

  test('names the engine the last recorded turn ran on', () => {
    render(
      <ConversationContextBoundary
        boundary={marker('empty-next-cold-start')}
        previousEngine={{ provider: 'claude' }}
      />,
    );
    expect(
      screen.getByText(
        'Claude Code forgot everything above. You still see it.',
      ),
    ).toBeTruthy();
  });
});
