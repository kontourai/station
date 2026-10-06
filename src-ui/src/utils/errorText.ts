import { envelopeReasons } from '@kontourai/station-sdk/client';

/**
 * Shared "extract a displayable message from an unknown error" helper (K4
 * this ternary was previously duplicated across
 * `KnowledgeStoreSection.tsx` and `project-settings/KnowledgeSection.tsx`
 * with two slightly different, unintentionally-inconsistent fallback
 * strings). Every `ErrorState`/inline error-message call site in this repo
 * should converge on this one implementation and fallback copy rather than
 * re-deriving its own `error instanceof Error ?... :...` ternary.
 */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.';
}

/**
 * The sentence a person should read for a failed Station request (#2708).
 *
 * A `StationHttpError` thrown by the SDK's envelope helper keeps two views of
 * a validation refusal: a field-qualified message for CLI and agent readers
 * (`Validation failed: command Required, secretEnvKey Required`) and the raw
 * `details`. Schema keys such as `secretEnvKey` are not copy, so this reads
 * the server's own reason sentences out of `details` — each said once, with
 * no "Validation failed:" prefix. Any other failure reads as `errorText`.
 */
export function userFacingErrorMessage(error: unknown): string {
  // Not only StationHttpError: the SDK's family errors that extend `Error`
  // (DelegationApiError, AnswerSupportRequestError,
  // ActionOperationProtocolError, ProjectTaskRoomProtocolError) carry the same
  // `details`. Read structurally, so this shared helper does not import the
  // lazily loaded entry points those classes live in. `envelopeReasons` reads
  // only a validation `{ formErrors, fieldErrors }`; any other `details` keeps
  // the message.
  if (error instanceof Error && 'details' in error) {
    const reasons = envelopeReasons(error.details);
    if (reasons.length > 0) return reasons.join(' ');
  }
  return errorText(error);
}
