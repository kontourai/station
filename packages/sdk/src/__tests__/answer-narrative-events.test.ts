import * as narrative from '@kontourai/station-sdk/answer-narrative-events';
import { describe, expect, it } from 'vitest';
import * as assessment from '../answer-assessment-events.js';

// `./answer-narrative-events` is a published subpath that re-exports the
// assessment implementation under narrative names. Behaviour is proven in
// answer-assessment-events.test.tsx; this pins the published alias surface.
describe('answer-narrative-events published subpath', () => {
  it('exports exactly the narrative aliases of the assessment owners', () => {
    expect(Object.keys(narrative).sort()).toEqual([
      'parseAnswerNarrativeUpdateEvent',
      'refreshAnswerNarrativeQueries',
    ]);
    expect(narrative.parseAnswerNarrativeUpdateEvent).toBe(
      assessment.parseAnswerAssessmentUpdateEvent,
    );
    expect(narrative.refreshAnswerNarrativeQueries).toBe(
      assessment.refreshAnswerAssessmentQueries,
    );
  });
});
