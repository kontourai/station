/**
 * Narrative and assessment mutations carry the same closed owner-update wire
 * and invalidate the same scoped Basis projections.  Keep one implementation
 * so a consumer that asks for both owners does not pay for duplicate parsing
 * or cache-fencing code.
 */
export {
  type AnswerAssessmentUpdateEvent as AnswerNarrativeUpdateEvent,
  parseAnswerAssessmentUpdateEvent as parseAnswerNarrativeUpdateEvent,
  refreshAnswerAssessmentQueries as refreshAnswerNarrativeQueries,
} from './answer-assessment-events.js';
