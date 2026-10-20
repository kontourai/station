import { useWorkObservation } from '../../contexts/work-observation';
import type { HomeWorkItem } from './home-view-model';
import type { WorkFacts } from './work-facts';
import { type WorkStatus, workStatus } from './work-status';

/** Observation is presentation state, outside the consent-governed Home projection. */
export function useObservedWorkStatus(
  item: HomeWorkItem,
  now: number,
  facts?: WorkFacts,
): WorkStatus {
  return useOptionalObservedWorkStatus(item, now, facts) as WorkStatus;
}

/**
 * The same read for a caller that may have no row yet (the dock's session
 * context card before the inbox lists a new chat): `null` then, rather than
 * a word nothing computed.
 */
export function useOptionalObservedWorkStatus(
  item: HomeWorkItem | undefined,
  now: number,
  facts?: WorkFacts,
): WorkStatus | null {
  const id = item ? (item.conversationId ?? item.id) : undefined;
  const observation = useWorkObservation(id);
  if (!item || !id) return null;
  return workStatus(
    item,
    now,
    facts,
    item.kind !== 'remote-session' &&
      item.kind !== 'task' &&
      Boolean(observation?.unavailable(id)),
  );
}
