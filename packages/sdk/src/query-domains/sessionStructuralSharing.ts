import {
  type OrchestrationSessionSummary,
  withNormalizedAnswerability,
} from '@kontourai/station-contracts/orchestration';
import { replaceEqualDeep } from '@tanstack/react-query';

function withoutObservationTimes(session: OrchestrationSessionSummary) {
  const children = session.childWork?.children;
  return {
    ...session,
    answerability: session.answerability.answerable
      ? session.answerability
      : { ...session.answerability, observedAt: undefined },
    ...(children?.observability === 'reported'
      ? {
          childWork: {
            ...session.childWork,
            children: { ...children, observedAt: undefined },
          },
        }
      : {}),
  };
}

export function shareSessionReadModel(
  previous: unknown,
  next: unknown,
): unknown {
  // TanStack's sharing callback erases the owning query's data type.
  const previousRows = previous as OrchestrationSessionSummary[] | undefined;
  const nextRows = next as OrchestrationSessionSummary[];
  // React Query erases cache types here; normalize the wire member before
  // using it, including cache entries from an older serving Station.
  const normalizedNext = nextRows.map((row) =>
    replaceEqualDeep(row, withNormalizedAnswerability(row)),
  );
  if (!previousRows) return normalizedNext;
  const normalizedPrevious = previousRows.map((row) =>
    replaceEqualDeep(row, withNormalizedAnswerability(row)),
  );
  const byThreadId = new Map(
    normalizedPrevious.map((row) => [row.threadId, row]),
  );
  const shared = normalizedNext.map((row) => {
    const prior = byThreadId.get(row.threadId);
    if (!prior) return row;
    const comparison = withoutObservationTimes(prior);
    // Keep a genuine earlier observation only while its verdict, observer
    // and all work facts remain unchanged. Server read-time semantics stay intact.
    return replaceEqualDeep(comparison, withoutObservationTimes(row)) ===
      comparison
      ? prior
      : row;
  });
  // Preserve rows matched by thread id even when the server reorders them.
  return replaceEqualDeep(previousRows, shared) === previousRows
    ? previousRows
    : shared;
}
