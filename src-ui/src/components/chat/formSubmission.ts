import type { UIBlockFormSubmission } from './UIBlockActionsContext';

/**
 * Composes a submitted chat-native form into the text of a follow-up user turn:
 * a human-readable summary the user can see, plus a fenced JSON payload tagged
 * `__stationFormSubmission` so the agent can parse the structured values
 * deterministically. The agent's prior run has ended, so this is a new turn.
 */
export function formatFormSubmission(
  submission: UIBlockFormSubmission,
): string {
  const heading = submission.title
    ? `Submitted form "${submission.title}":`
    : 'Submitted form:';
  const lines = submission.values.map(
    (v) => `- ${v.label}: ${formatValue(v.value)}`,
  );
  const payload = {
    __stationFormSubmission: true,
    blockId: submission.blockId,
    ...(submission.title ? { title: submission.title } : {}),
    fields: Object.fromEntries(submission.values.map((v) => [v.name, v.value])),
  };
  return [
    heading,
    ...lines,
    '',
    '```json',
    JSON.stringify(payload, null, 2),
    '```',
  ].join('\n');
}

function formatValue(value: string | boolean): string {
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return value.trim() === '' ? '(empty)' : value;
}
