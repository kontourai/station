/** A visible assistant-shaped message is not proof of a successful turn. */
export function acceptedTurnReply(events, turnId, expectedText) {
  if (typeof turnId !== 'string' || !turnId)
    throw new Error('Acceptance did not identify its provider turn.');
  const matching = events.filter((event) => event.turnId === turnId);
  const failure = matching.find((event) => event.method === 'runtime.error');
  if (failure)
    throw new Error(
      `Provider turn failed: ${String(failure.message ?? failure.error ?? 'unknown error').slice(0, 500)}`,
    );
  const completion = matching.find(
    (event) => event.method === 'turn.completed',
  );
  if (!completion) return false;
  if (
    completion.finishReason !== 'stop' ||
    completion.outputText?.trim() !== expectedText
  )
    throw new Error(
      'Provider completed without the expected successful reply.',
    );
  return true;
}
