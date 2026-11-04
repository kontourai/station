import { StationHttpError } from '@kontourai/station-sdk/client';
import { userFacingErrorMessage } from '../../utils/errorText';

/**
 * Sentences for the refusal codes the Project access routes send
 * (`project-membership-routes.ts`). Those bodies carry only a machine code,
 * which the SDK keeps as the error message, so without this the code itself
 * would be shown.
 */
const REFUSALS: Readonly<Record<string, string>> = {
  project_access_forbidden:
    'You don’t have permission to change who can access this Project.',
  project_access_conflict:
    'This Project changed while you were working. Refresh access and try again.',
  project_access_invitation_invalid: 'That invitation is no longer valid.',
  project_access_unavailable:
    'Project access is unavailable right now. Try again in a moment.',
  project_sharing_unavailable:
    'Project sharing is not enabled on this Station.',
  invalid_project_access_request:
    'Station couldn’t read that request. Refresh access and try again.',
  request_body_too_large: 'That request is too large to send.',
};

/** What a person reads when a Project access read or change fails. */
export function projectAccessErrorMessage(
  error: unknown,
  /** Replaces the generic `forbidden` sentence when the action has a more specific one. */
  forbidden?: string,
): string {
  if (!(error instanceof StationHttpError))
    return userFacingErrorMessage(error);
  if (error.code === 'project_access_forbidden' && forbidden) return forbidden;
  const known = error.code === undefined ? undefined : REFUSALS[error.code];
  if (known) return known;
  // A code this list doesn't know arrives as the message itself.
  if (error.code !== undefined && error.message === error.code)
    return 'Station couldn’t complete this change. Refresh access and try again.';
  return userFacingErrorMessage(error);
}

/** The `forbidden` sentence for turning sharing on. */
export const ENABLE_SHARING_FORBIDDEN =
  'You can’t turn on sharing from this device. It needs Station owner authority, such as the Station’s own computer.';
