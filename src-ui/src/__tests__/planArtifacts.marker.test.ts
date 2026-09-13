/**
 * `derivePlanArtifactFromText` is re-run on every streamed token with the whole
 * accumulated answer, and its parse splits the text into lines and runs six
 * regexes over each one. Text containing no character any of those patterns
 * can start a step with cannot produce a step, so the scan is now skipped.
 *
 * That skip is semantics-neutral by construction, which means it has no
 * behavioural test of its own. What it CAN break is real: a marker family
 * missing from the guard is a plan that silently stops rendering. So the guard
 * is walked against every pattern the parser owns, from both sides — the
 * marker predicate itself, and the artifact the streaming derivation returns.
 */

import { describe, expect, test } from 'vitest';
import {
  derivePlanArtifactFromStreamingState,
  derivePlanArtifactFromText,
  hasPlanMarker,
  type PlanArtifact,
} from '../utils/planArtifacts';

/**
 * One line per `LINE_STATUS_PATTERNS` entry, in the order the parser declares
 * them. Each is a plan on its own: `looksLikePlan` accepts a single step when
 * the text also names a plan, so every case carries the word.
 */
const PATTERN_SAMPLES: Array<{ family: string; text: string }> = [
  { family: 'markdown checkbox', text: 'Plan\n- [ ] draft the change' },
  { family: 'checkbox, checked', text: 'Plan\n* [x] draft the change' },
  { family: 'white heavy check mark', text: 'Plan\n✅ draft the change' },
  { family: 'ballot box with check', text: 'Plan\n☑️ draft the change' },
  { family: 'heavy check mark', text: 'Plan\n✔️ draft the change' },
  {
    family: 'arrows counterclockwise',
    text: 'Plan\n\u{1f504} draft the change',
  },
  { family: 'hourglass', text: 'Plan\n⏳ draft the change' },
  { family: 'white large square', text: 'Plan\n⬜ draft the change' },
  { family: 'white square', text: 'Plan\n□ draft the change' },
  { family: 'ordered, period', text: 'Plan\n1. draft the change' },
  { family: 'ordered, paren', text: 'Plan\n2) draft the change' },
  { family: 'bullet, dash', text: 'Plan\n- draft the change' },
  { family: 'bullet, star', text: 'Plan\n* draft the change' },
];

const PRIOR: PlanArtifact = {
  source: 'assistant',
  rawText: 'Plan\n- [ ] the previous plan',
  steps: [{ content: 'the previous plan', status: 'pending' }],
  updatedAt: '2026-07-18T00:00:00.000Z',
};

function streamingChat(text: string) {
  return {
    streamingMessage: {
      contentParts: [{ type: 'text' as const, content: text }],
    },
    planArtifact: PRIOR,
  } as any;
}

describe('plan marker guard', () => {
  test.each(PATTERN_SAMPLES)(
    'the guard admits the $family step pattern',
    ({ text }) => {
      expect(hasPlanMarker(text)).toBe(true);
      // The whole point of admitting it: the parser still produces the plan.
      const artifact = derivePlanArtifactFromText(text, 'assistant');
      expect(artifact?.steps.length).toBeGreaterThan(0);
    },
  );

  test.each(PATTERN_SAMPLES)(
    'a streamed $family plan still reaches the panel',
    ({ text }) => {
      const artifact = derivePlanArtifactFromStreamingState(
        streamingChat(text),
      );
      expect(artifact).not.toBe(PRIOR);
      expect(artifact?.steps.length).toBeGreaterThan(0);
    },
  );

  test('prose with no step character keeps the previous artifact by reference', () => {
    const prose =
      'I looked at the file and the answer seems fine to me as written.';
    expect(hasPlanMarker(prose)).toBe(false);
    expect(derivePlanArtifactFromStreamingState(streamingChat(prose))).toBe(
      PRIOR,
    );
  });

  test('a marker-free stream with no previous artifact stays null', () => {
    expect(
      derivePlanArtifactFromStreamingState({
        streamingMessage: {
          contentParts: [{ type: 'text', content: 'just some prose' }],
        },
        planArtifact: undefined,
      } as any),
    ).toBeNull();
  });
});
