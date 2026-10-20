import type { OrchestrationSessionSummary } from '@kontourai/station-sdk';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { PaneOpener } from '../regions/pane-relations';
import {
  openerSelectionKey,
  paneRelationOf,
  withoutPaneRelation,
} from '../regions/pane-relations';
import {
  occupiedDockRegion,
  type RegionArrangement,
} from '../regions/region-model';
import { forgetRegionPaneState } from '../regions/region-surface-panes';
import { useApiBase } from './ApiBaseContext';
import {
  guardsAllow,
  type RelatedOpenOutcome,
  watchGuardRegistrations,
} from './openRelatedOccurrence';
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
  close(instanceId: string, callerCurrent?: () => boolean): void;
  reveal(
    instanceId: string,
    surface: 'chat' | 'activity',
    commit: (
      current: () => boolean,
      signal: AbortSignal,
    ) => void | Promise<void>,
    callerCurrent: () => boolean,
  ): Promise<boolean>;
}

const ActivityReviewContext = createContext<ActivityReviewValue>({
  source: null,
  readSource: () => null,
  publish: () => () => {},
  close: () => {},
  reveal: async () => false,
});

export function ActivityReviewProvider({ children }: { children: ReactNode }) {
  const model = useRegionModelOptional();
  const relations = usePaneRelations();
  const { apiBase } = useApiBase();
  const live = useRef({ model, relations, apiBase });
  useLayoutEffect(() => {
    live.current = { model, relations, apiBase };
  });
  const [source, setSource] = useState<ActivityReviewSource | null>(null);
  const sourceRef = useRef(source);
  const alive = useRef(false);
  const operation = useRef<AbortController | null>(null);
  const scopeKey = JSON.stringify([relations.stationId, apiBase]);
  const operationScope = useRef(scopeKey);
  useLayoutEffect(() => {
    if (operationScope.current !== scopeKey) operation.current?.abort();
    operationScope.current = scopeKey;
    return () => operation.current?.abort();
  }, [scopeKey]);
  useLayoutEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
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
  const close = useCallback(
    (instanceId: string, callerCurrent: () => boolean = () => true) => {
      const {
        model: initialModel,
        relations: initialRelations,
        apiBase: initialApiBase,
      } = live.current;
      const relation = initialRelations.relationOf(instanceId);
      if (
        !initialModel ||
        !relation ||
        !callerCurrent() ||
        relation.stationId !== initialRelations.stationId
      )
        return;
      const restoreFocus = () => {
        const source = sourceRef.current;
        if (
          source &&
          source.stationId === relation.stationId &&
          source.apiBase === initialApiBase &&
          openerSelectionKey(source.opener) ===
            openerSelectionKey(relation.opener)
        )
          source.restoreFocus();
      };
      if (initialModel.phoneLayer?.surfaceId === instanceId) {
        initialModel.closePhoneLayer(
          restoreFocus,
          () =>
            alive.current &&
            callerCurrent() &&
            live.current.apiBase === initialApiBase &&
            live.current.relations.stationId === relation.stationId &&
            live.current.relations.relationOf(instanceId) === relation,
        );
        return;
      }
      const region = occupiedDockRegion(initialModel.readRegions(), instanceId);
      if (!region) return;
      const watch = watchGuardRegistrations();
      void (async () => {
        try {
          if (!(await guardsAllow([instanceId]))) return;
          const outcome = await live.current.relations.transact<void>(
            (tx) => {
              const current = live.current;
              const held = paneRelationOf(tx.record, instanceId);
              if (
                !alive.current ||
                !callerCurrent() ||
                current.apiBase !== initialApiBase ||
                watch.registered.has(instanceId) ||
                JSON.stringify(held) !== JSON.stringify(relation) ||
                !current.model ||
                occupiedDockRegion(current.model.readRegions(), instanceId) !==
                  region
              )
                return { ok: false, reason: 'superseded' };
              if (!tx.write(withoutPaneRelation(tx.record, instanceId)))
                return { ok: false, reason: 'storage' };
              if (!current.model.removePane(region, instanceId))
                return { ok: false, reason: 'superseded' };
              forgetRegionPaneState(instanceId);
              return { ok: true, value: undefined };
            },
            { station: relation.stationId },
          );
          if (outcome.ok && alive.current) restoreFocus();
        } finally {
          watch.stop();
        }
      })();
    },
    [],
  );
  const reveal = useCallback(
    async (
      instanceId: string,
      surface: 'chat' | 'activity',
      commit: (
        current: () => boolean,
        signal: AbortSignal,
      ) => void | Promise<void>,
      callerCurrent: () => boolean,
    ) => {
      operation.current?.abort();
      const controller = new AbortController();
      operation.current = controller;
      const initial = live.current;
      const relation = initial.relations.relationOf(instanceId);
      if (
        !initial.model ||
        !relation ||
        relation.stationId !== initial.relations.stationId ||
        !callerCurrent()
      )
        return false;
      const selection = initial.relations.currentSelection(
        relation.opener.occurrenceId,
      );
      const source = sourceRef.current;
      const scopeCurrent = () =>
        !controller.signal.aborted &&
        alive.current &&
        live.current.relations.stationId === relation.stationId &&
        live.current.apiBase === initial.apiBase &&
        sourceRef.current?.owner === source?.owner &&
        (source === null ||
          (sourceRef.current !== null &&
            openerSelectionKey(sourceRef.current.opener) ===
              openerSelectionKey(source.opener))) &&
        JSON.stringify(live.current.relations.relationOf(instanceId)) ===
          JSON.stringify(relation) &&
        live.current.relations.currentSelection(
          relation.opener.occurrenceId,
        ) === selection;
      const visible = (arrangement: RegionArrangement) =>
        Object.values(arrangement)
          .flatMap((region) =>
            region.visible && region.occupant !== null ? [region.occupant] : [],
          )
          .sort();
      const hidden = () => {
        const model = live.current.model;
        const preview = model?.previewOpenSurfaceInRegion(surface);
        if (!model || !preview?.ok) return null;
        const after = visible(preview.arrangement);
        return visible(model.readRegions()).filter((id) => !after.includes(id));
      };
      let expected = hidden();
      if (!expected) return false;
      const asked = expected;
      const watch = watchGuardRegistrations();
      const current = () =>
        scopeCurrent() &&
        JSON.stringify(hidden()) === JSON.stringify(expected) &&
        asked.every((owner) => !watch.registered.has(owner));
      const show = () => {
        live.current.model?.showSurface(surface);
        expected = hidden();
      };
      try {
        if (initial.model.readPhoneLayer()?.surfaceId === instanceId) {
          if (
            !(await guardsAllow(
              expected.filter((owner) => owner !== instanceId),
            )) ||
            !callerCurrent() ||
            !current()
          )
            return false;
          const closed = await initial.model.closePhoneLayer(
            show,
            () => callerCurrent() && current(),
          );
          if (!closed) return false;
        } else {
          if (!(await guardsAllow(expected)) || !callerCurrent() || !current())
            return false;
          show();
        }
        if (!scopeCurrent()) return false;
        if (!expected || !scopeCurrent()) return false;
        await commit(current, controller.signal);
        return current();
      } finally {
        watch.stop();
      }
    },
    [],
  );
  const value = useMemo(
    () => ({ source, readSource, publish, close, reveal }),
    [source, readSource, publish, close, reveal],
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
