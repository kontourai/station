import { redactDeep } from '@kontourai/station-shared/redaction';

function errorFacts(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { value: error };
  const candidate = error as Error & {
    code?: unknown;
    status?: unknown;
    context?: unknown;
  };
  return {
    name: error.name,
    message: error.message,
    ...(candidate.code !== undefined ? { code: candidate.code } : {}),
    ...(candidate.status !== undefined ? { status: candidate.status } : {}),
    ...(candidate.context !== undefined ? { context: candidate.context } : {}),
  };
}

/** Reviewable composer text for an error hand-off; never dispatches itself. */
export function errorAgentDraft(input: {
  attempted: string;
  error: unknown;
  context?: Record<string, unknown>;
}): string {
  const details = redactDeep({
    attempted: input.attempted,
    failure: errorFacts(input.error),
    context: input.context,
  });
  const seen = new WeakSet<object>();
  let encoded = JSON.stringify(
    details,
    (_key, value: unknown) => {
      if (typeof value === 'bigint') return value.toString();
      if (typeof value === 'string' && value.length > 2_000)
        return `${value.slice(0, 2_000)}…`;
      if (value && typeof value === 'object') {
        if (seen.has(value)) return '[CIRCULAR]';
        seen.add(value);
      }
      return value;
    },
    2,
  );
  if (encoded.length > 12_000)
    encoded = JSON.stringify({
      attempted: input.attempted,
      failure: '[DETAILS OMITTED: TOO LARGE]',
    });
  return `Help me diagnose this Station error. Review this context before sending.\n\n\
\`\`\`json\n${encoded}\n\`\`\``;
}
