import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  BUILTIN_PANE_GENERATION,
  EMPTY_PANE_RELATIONS,
  keptPaneForTarget,
  PANE_RELATIONS_STORAGE_KEY,
  type PaneOpener,
  type PaneRelation,
  type PaneRelationsRead,
  type PaneRelationsRecord,
  type PaneRelationTarget,
  paneRelationOf,
  parsePaneRelations,
  prunePaneRelations,
  serializePaneRelations,
  sourceHiddenPanes,
  transientPaneForOpener,
  withKeptPane,
  withoutPaneRelation,
  withPaneRelation,
} from '../regions/pane-relations';
import { REGION_IDS, type RegionArrangement } from '../regions/region-model';
import { useAuthorityPersistence } from './AuthorityPersistenceContext';
import { navigationStore } from './navigation-store';
import { useRegionModelOptional } from './RegionModelContext';

/** What a caller records when it opens a related pane. */
export interface PaneRelationInput {
  instanceId: string;
  stateKey: string;
  opener: PaneOpener;
  target: PaneRelationTarget;
  kept?: boolean;
  generation?: string;
}

export interface PaneRelationsValue {
  /**
   * The exact Station relations are recorded against: the verified authority
   * observation's `environmentId`. Null while authority is unverified or
   * unavailable — relations are then inactive and every opener keeps its
   * pre-relationship behaviour, because nothing could prove which Station a
   * new relation belongs to.
   */
  stationId: string | null;
  relationOf(instanceId: string): PaneRelation | undefined;
  /** A placed, kept occurrence of this exact target on this Station. */
  keptFor(target: PaneRelationTarget): PaneRelation | undefined;
  /** The placed transient preview this exact opener selection owns. */
  transientFor(opener: PaneOpener): PaneRelation | undefined;
  /** Whether the arrangement holds the occurrence (raw, not suspended). */
  isPlaced(instanceId: string): boolean;
  /** Whether the occurrence holds unsaved work its own guard protects. */
  isProtected(instanceId: string): boolean;
  record(relation: PaneRelationInput): void;
  keep(instanceId: string): void;
  forget(instanceId: string): void;
  /**
   * An opener's current selection (Chat's conversation), published while it
   * is mounted. Returns the withdrawal. Transient previews of another
   * selection of that opener are source-hidden (`hiddenSurfaces`).
   */
  publishOpenerSelection(occurrenceId: string, selection: string): () => void;
  /** Transient previews hidden because their opener changed selection. */
  hiddenSurfaces: readonly string[];
}

const NO_SURFACES: readonly string[] = [];

const INACTIVE: PaneRelationsValue = {
  stationId: null,
  relationOf: () => undefined,
  keptFor: () => undefined,
  transientFor: () => undefined,
  isPlaced: () => false,
  isProtected: () => false,
  record: () => {},
  keep: () => {},
  forget: () => {},
  publishOpenerSelection: () => () => {},
  hiddenSurfaces: NO_SURFACES,
};

const PaneRelationsContext = createContext<PaneRelationsValue>(INACTIVE);

function readStoredRelations(): PaneRelationsRead {
  try {
    return parsePaneRelations(
      window.localStorage.getItem(PANE_RELATIONS_STORAGE_KEY),
    );
  } catch {
    return { status: 'empty', record: EMPTY_PANE_RELATIONS };
  }
}

function placedSurfaces(regions: RegionArrangement): Set<string> {
  return new Set(REGION_IDS.flatMap((id) => regions[id].panes));
}

/**
 * The relations side record for the mounted app. Below `RegionModelProvider`,
 * whose RAW arrangement (no suspension applies at this level) decides what is
 * placed; above the region shells, which suspend `hiddenSurfaces`.
 */
export function PaneRelationsProvider({ children }: { children: ReactNode }) {
  const authority = useAuthorityPersistence();
  const stationId =
    authority.status === 'verified'
      ? (authority.observation?.environmentId ?? null)
      : null;
  const model = useRegionModelOptional();
  const placedRef = useRef<Set<string>>(new Set());
  placedRef.current = model ? placedSurfaces(model.regions) : new Set();
  // Occupancies recorded since the arrangement last rendered: an open commits
  // the arrangement and records its relation in one event, before React
  // renders the arrangement that holds it, so "placed" means rendered or just
  // recorded. Cleared as the arrangement catches up.
  const pendingRef = useRef<Set<string>>(new Set());
  for (const id of pendingRef.current)
    if (placedRef.current.has(id)) pendingRef.current.delete(id);
  const isPlacedRef = useRef(
    (id: string) => placedRef.current.has(id) || pendingRef.current.has(id),
  );
  const [stored, setStored] = useState(readStoredRelations);
  // A record a newer build wrote is read-only here: applying none of it and
  // writing over none of it is what keeps its kept work intact.
  const writable = stored.status !== 'unsupported';
  const recordRef = useRef(stored.record);
  recordRef.current = stored.record;
  const [selections, setSelections] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );

  const write = useCallback(
    (update: (record: PaneRelationsRecord) => PaneRelationsRecord) => {
      if (!writable) return;
      const next = update(
        prunePaneRelations(recordRef.current, isPlacedRef.current),
      );
      if (next === recordRef.current) return;
      recordRef.current = next;
      try {
        window.localStorage.setItem(
          PANE_RELATIONS_STORAGE_KEY,
          serializePaneRelations(next),
        );
      } catch {
        // Per-device storage is optional: the relation still holds for this
        // page load.
      }
      setStored({ status: 'ok', record: next });
    },
    [writable],
  );

  // Another tab's write is the newest record; adopt it rather than writing
  // this tab's older copy back over it.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== PANE_RELATIONS_STORAGE_KEY) return;
      const next = parsePaneRelations(event.newValue);
      recordRef.current = next.record;
      setStored(next);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const publishOpenerSelection = useCallback(
    (occurrenceId: string, selection: string) => {
      setSelections((current) => {
        if (current.get(occurrenceId) === selection) return current;
        const next = new Map(current);
        next.set(occurrenceId, selection);
        return next;
      });
      return () =>
        setSelections((current) => {
          if (current.get(occurrenceId) !== selection) return current;
          const next = new Map(current);
          next.delete(occurrenceId);
          return next;
        });
    },
    [],
  );

  const hiddenList = sourceHiddenPanes(
    stored.record,
    stationId,
    selections,
    (id) => navigationStore.hasNavigationGuard(id),
  ).filter((id) => isPlacedRef.current(id));
  const hiddenKey = hiddenList.join('\n');
  // biome-ignore lint/correctness/useExhaustiveDependencies: the joined key is the list's identity; suspension readers memoize on it.
  const hiddenSurfaces = useMemo(
    () => (hiddenList.length === 0 ? NO_SURFACES : hiddenList),
    [hiddenKey],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: `stored` re-renders readers after a write; the methods read the ref, which is current within one event.
  const value = useMemo<PaneRelationsValue>(() => {
    if (stationId === null) return INACTIVE;
    const isPlaced = isPlacedRef.current;
    return {
      stationId,
      relationOf: (instanceId) => paneRelationOf(recordRef.current, instanceId),
      keptFor: (target) =>
        keptPaneForTarget(recordRef.current, stationId, target, isPlaced),
      transientFor: (opener) =>
        transientPaneForOpener(recordRef.current, stationId, opener, isPlaced),
      isPlaced,
      isProtected: (instanceId) =>
        navigationStore.hasNavigationGuard(instanceId),
      record: (input) => {
        pendingRef.current.add(input.instanceId);
        write((record) =>
          withPaneRelation(record, {
            instanceId: input.instanceId,
            stateKey: input.stateKey,
            stationId,
            generation: input.generation ?? BUILTIN_PANE_GENERATION,
            opener: input.opener,
            target: input.target,
            kept: input.kept ?? false,
            openedAt: Date.now(),
          }),
        );
      },
      keep: (instanceId) => write((record) => withKeptPane(record, instanceId)),
      forget: (instanceId) => {
        pendingRef.current.delete(instanceId);
        write((record) => withoutPaneRelation(record, instanceId));
      },
      publishOpenerSelection,
      hiddenSurfaces,
    };
  }, [stationId, write, publishOpenerSelection, hiddenSurfaces, stored]);

  return (
    <PaneRelationsContext.Provider value={value}>
      {children}
    </PaneRelationsContext.Provider>
  );
}

export function usePaneRelations(): PaneRelationsValue {
  return useContext(PaneRelationsContext);
}

/**
 * Publish an opener's current selection for as long as it is mounted, so the
 * previews it opened for another selection hide (and come back with it).
 */
export function usePublishOpenerSelection(
  occurrenceId: string | null,
  selection: string | null,
): void {
  const { publishOpenerSelection } = usePaneRelations();
  useEffect(() => {
    if (occurrenceId === null || selection === null) return;
    return publishOpenerSelection(occurrenceId, selection);
  }, [occurrenceId, selection, publishOpenerSelection]);
}
