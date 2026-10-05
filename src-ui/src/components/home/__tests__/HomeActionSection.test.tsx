/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { continueWorkDetail } from '../HomeActionSection';

describe('continueWorkDetail', () => {
  const now = 1_700_000_000_000;

  it('omits Model not reported, names no kind, and uses the compact time', () => {
    expect(
      continueWorkDetail(
        {
          agentLabel: 'Station',
          modelLabel: 'Model not reported',
          lifecycleLabel: 'Current',
          updatedAt: now - 12 * 60_000,
        },
        now,
      ),
    ).toBe('Station · 12m');
  });

  it('names a Failed turn', () => {
    expect(
      continueWorkDetail(
        {
          agentLabel: 'Claude Code',
          modelLabel: 'Opus 5',
          lifecycleLabel: 'Failed',
          updatedAt: now - 3_000,
        },
        now,
      ),
    ).toBe('Claude Code · Opus 5 · Failed · now');
  });
});
