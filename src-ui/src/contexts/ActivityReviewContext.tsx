import type { OrchestrationSessionSummary } from '@kontourai/station-sdk';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { PaneOpener } from '../regions/pane-relations';
import { openerSelectionKey } from '../regions/pane-relations';
import { occupiedDockRegion } from '../regions/region-model';
import { forgetRegionPaneState } from '../regions/region-surface-panes';
import { navigationStore } from './navigation-store';
import type { RelatedOpenOutcome } from './openRelatedOccurrence';
import { usePaneRelations } from './PaneRelationsContext';
import { useRegionModelOptional } from './RegionModelContext';

export interface ActivityReviewSource {
  readonly owner: string;
  readonly apiBase: string;
  readonly stationId: string | null;
  readonly opener: PaneOpener;
  readonly items: readonly OrchestrationSessionSummary[];
  review(threadId: string): Promise<RelatedOpenOutcome>;
  restoreFocus(): void;
}

interface ActivityReviewValue {
  source: ActivityReviewSource | null;
  readSource(): ActivityReviewSource | null;
  publish(source: ActivityReviewSource): () => void;
  close(instanceId: string): void;
}

const ActivityReviewContext = createContext<ActivityReviewValue>({
  source: null,
  readSource: () => null,
  publish: () => () => {},
  close: () => {},
});

export function ActivityReviewProvider({ children }: { children: ReactNode }) {
  const model = useRegionModelOptional();
  const relations = usePaneRelations();
  const live = useRef({ model, relations });
  live.current = { model, relations };
  const [source, setSource] = useState<ActivityReviewSource | null>(null);
  const sourceRef = useRef(source);
  const readSource = useCallback(() => sourceRef.current, []);
  const publish = useCallback((next: ActivityReviewSource) => {
    sourceRef.current = next;
    setSource(next);
    return () => {
      if (sourceRef.current !== next) return;
      sourceRef.current = null;
      setSource(null);
    };
  }, []);
  const close = useCallback((instanceId: string) => {
    const { model: initialModel, relations: initialRelations } = live.current;
    const relation = initialRelations.relationOf(instanceId);
    if (
      !initialModel ||
      !relation ||
      relation.stationId !== initialRelations.stationId
    )
      return;
    const restoreFocus = () => {
      const source = sourceRef.current;
      if (
        source &&
        openerSelectionKey(source.opener) ===
          openerSelectionKey(relation.opener)
      )
        source.restoreFocus();
    };
    if (initialModel.phoneLayer?.surfaceId === instanceId) {
      initialModel.closePhoneLayer(
        restoreFocus,
        () =>
          live.current.relations.stationId === relation.stationId &&
          live.current.relations.relationOf(instanceId) === relation,
      );
      return;
    }
    const region = occupiedDockRegion(initialModel.readRegions(), instanceId);
    if (!region) return;
    navigationStore.runNavigationGuards(
      () => {
        const current = live.current;
        if (
          current.relations.stationId !== relation.stationId ||
          current.relations.relationOf(instanceId) !== relation ||
          !current.model?.removePane(region, instanceId)
        )
          return;
        forgetRegionPaneState(instanceId);
        void current.relations.forget(instanceId);
        restoreFocus();
      },
      undefined,
      { owner: instanceId },
    );
  }, []);
  const value = useMemo(
    () => ({ source, readSource, publish, close }),
    [source, readSource, publish, close],
  );
  return (
    <ActivityReviewContext.Provider value={value}>
      {children}
    </ActivityReviewContext.Provider>
  );
}

export function useActivityReview() {
  return useContext(ActivityReviewContext);
}
