/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { continueWorkDetail } from '../HomeActionSection';

describe('continueWorkDetail', () => {
  const now = 1_700_000_000_000;

  it('omits Model not reported and includes time', () => {
    expect(
      continueWorkDetail(
        {
          kindLabel: 'Direct chat',
          agentLabel: 'Station',
          modelLabel: 'Model not reported',
          lifecycleLabel: 'Current',
          updatedAt: now - 12 * 60_000,
        },
        now,
      ),
    ).toBe('Direct chat · Station · 12m ago');
  });

  it('names a Failed turn', () => {
    expect(
      continueWorkDetail(
        {
          kindLabel: 'Direct chat',
          agentLabel: 'Claude Code',
          modelLabel: 'Opus 5',
          lifecycleLabel: 'Failed',
          updatedAt: now - 3_000,
        },
        now,
      ),
    ).toBe('Direct chat · Claude Code · Opus 5 · Failed · just now');
  });
});
