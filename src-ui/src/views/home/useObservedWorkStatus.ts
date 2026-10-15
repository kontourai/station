import { useWorkObservation } from '../../contexts/work-observation';
import type { HomeWorkItem } from './home-view-model';
import type { WorkFacts } from './work-facts';
import { workStatus } from './work-status';

/** Observation is presentation state, outside the consent-governed Home projection. */
export function useObservedWorkStatus(
  item: HomeWorkItem,
  now: number,
  facts?: WorkFacts,
) {
  const observation = useWorkObservation(item.conversationId ?? item.id);
  return workStatus(
    item,
    now,
    facts,
    item.kind !== 'remote-session' &&
      item.kind !== 'task' &&
      Boolean(observation?.unavailable(item.conversationId ?? item.id)),
  );
}
