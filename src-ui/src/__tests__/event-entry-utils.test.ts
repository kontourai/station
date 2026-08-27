import { describe, expect, it } from 'vitest';
import { K } from '../../../src-shared/monitoring-keys';
import {
  buildToolInputDisplay,
  getArtifactSummary,
  getTotalChars,
  getTotalTokens,
} from '../components/monitoring/event-entry/utils';

describe('event-entry utils', () => {
  it('builds parameter labels for structured tool input', () => {
    expect(
      buildToolInputDisplay({
        [K.TOOL_CALL_ARGS]: { query: 'status', limit: 5 },
      }),
    ).toEqual({
      text: JSON.stringify({ query: 'status', limit: 5 }, null, 2),
      label: '2 params',
    });
  });

  it('extracts final output and tool calls from artifacts', () => {
    expect(
      getArtifactSummary({
        [K.ARTIFACTS]: [
          { type: 'tool-call', name: 'search' },
          { type: 'text', content: 'first' },
          { type: 'text', content: 'final' },
        ],
      }),
    ).toEqual({
      finalOutput: 'final',
      toolCalls: [{ type: 'tool-call', name: 'search' }],
    });
  });

  it('computes aggregate char and token totals only when both values exist', () => {
    const event = {
      [K.INPUT_CHARS]: 10,
      [K.OUTPUT_CHARS]: 15,
      [K.INPUT_TOKENS]: 7,
      [K.OUTPUT_TOKENS]: 9,
    };

    expect(getTotalChars(event)).toBe(25);
    expect(getTotalTokens(event)).toBe(16);
    expect(getTotalChars({ [K.INPUT_CHARS]: 10 })).toBeNull();
    expect(getTotalTokens({ [K.OUTPUT_TOKENS]: 9 })).toBeNull();
  });
});
