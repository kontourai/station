import type { OrchestrationSessionSummary } from '@kontourai/station-contracts/orchestration';
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
  if (!previousRows) return nextRows;
  const byThreadId = new Map(previousRows.map((row) => [row.threadId, row]));
  const shared = nextRows.map((row) => {
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
