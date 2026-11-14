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
    [
      'continue-from-history',
      'Context reset: continued from history',
      'The agent rebuilt its context from this chat.',
    ],
    [
      'empty-next-cold-start',
      'Context reset: started fresh',
      'The agent no longer sees messages above this line.',
    ],
    [
      'summary-next-cold-start',
      'Context reset: continued from a summary',
      'The agent sees a summary, without its tool state, approvals, attachments or earlier tool results. Messages above stay readable.',
    ],
    [
      'task-state-next-cold-start',
      'Context reset: continued from a summary',
      'The agent sees a summary, without its tool state, approvals, attachments or earlier tool results. Messages above stay readable.',
    ],
  ] as const)(
    'marks a %s reset with its own heading and one-line body',
    (policy, heading, body) => {
      const { container } = render(
        <ConversationContextBoundary boundary={marker(policy)} />,
      );
      expect(screen.getByText(heading).tagName).toBe('STRONG');
      expect(screen.getByText(body)).toBeTruthy();
      // The heading names the section; no aria-label repeats it.
      expect(container.querySelector('[aria-label]')).toBeNull();
    },
  );
});
