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

function boundGraph(value: unknown, depth = 0, budget = { nodes: 0 }): unknown {
  if (depth > 6 || budget.nodes++ > 200) return '[OMITTED: LIMIT]';
  if (Array.isArray(value))
    return value
      .slice(0, 50)
      .map((item) => boundGraph(item, depth + 1, budget));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 50)
        .map(([key, item]) => [key, boundGraph(item, depth + 1, budget)]),
    );
  return value;
}

/** Reviewable composer text for an error hand-off; never dispatches itself. */
export function errorAgentDraft(input: {
  attempted: string;
  error: unknown;
  context?: Record<string, unknown>;
}): string {
  const details = redactDeep(
    boundGraph({
      attempted: input.attempted,
      failure: errorFacts(input.error),
      context: input.context,
    }),
  ) as Record<string, unknown>;
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
      attempted: details.attempted,
      failure: '[DETAILS OMITTED: TOO LARGE]',
    });
  return `Help me diagnose this Station error. Review this context before sending.\n\n\
\`\`\`json\n${encoded}\n\`\`\``;
}
