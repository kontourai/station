import {
  parseSessionGoalCommand,
  parseSessionGoalControlResult,
  parseSessionGoalRead,
  type SessionGoalCommand,
} from '@kontourai/station-contracts/session-goal';
import { envelopeError } from './api-error-message';
import {
  type ClientRequestOptions,
  getJson,
  mutateJson,
  readJsonBody,
} from './http';

function path(apiBase: string, sessionId: string) {
  if (!sessionId || sessionId.length > 512)
    throw Error('An exact Session is required.');
  return `${apiBase}/api/orchestration/sessions/${encodeURIComponent(sessionId)}/goal`;
}

async function envelope(response: Response) {
  const body = await readJsonBody(response);
  if (!response.ok)
    throw envelopeError(response, body, 'Session goals unavailable');
  if (
    !body ||
    typeof body !== 'object' ||
    !('success' in body) ||
    body.success !== true ||
    !('data' in body)
  )
    throw Error('Invalid Session goal response');
  return body.data;
}

export async function readSessionGoal(
  apiBase: string,
  sessionId: string,
  options?: ClientRequestOptions,
) {
  const response = await getJson(path(apiBase, sessionId), options);
  // Older hosts have no Goal route; the caller retains the unavailable response.
  if (response.status === 404) return { state: 'unsupported' as const };
  const result = parseSessionGoalRead(await envelope(response));
  if (!result) throw Error('Invalid Session goal response');
  return result;
}

export async function controlSessionGoal(
  apiBase: string,
  sessionId: string,
  command: SessionGoalCommand,
  options?: ClientRequestOptions,
) {
  const parsed = parseSessionGoalCommand(command);
  if (!parsed) throw Error('Invalid Goal command');
  const result = parseSessionGoalControlResult(
    await envelope(
      await mutateJson(path(apiBase, sessionId), 'POST', options, parsed),
    ),
  );
  if (!result)
    throw Error(
      'The Goal outcome could not be confirmed. Inspect before trying again.',
    );
  return result;
}
