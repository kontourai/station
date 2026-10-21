import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { readPaneFence } from '../regions/pane-fence';
import {
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
} from '../regions/pane-relations';
import { useAuthorityPersistence } from './AuthorityPersistenceContext';
import { navigationStore } from './navigation-store';
import { useRegionModelOptional } from './RegionModelContext';

/** The exclusive lock every write of the shared record is made under. */
const PANE_RELATIONS_LOCK = 'station:pane-relations';

/**
 * Why a relations transaction changed nothing. Every refusal leaves the
 * record, the arrangement and every occurrence's state as they were.
 */
export type PaneRelationsRefusal =
  /** No verified Station: nothing could prove which Station a write is for. */
  | 'station-unverified'
  /** The verified Station changed while the operation was pending. */
  | 'station-changed'
  /** This browser offers no Web Locks, so a write could lose another tab's. */
  | 'lock-unavailable'
  /** Another tab is writing the record right now. */
  | 'contended'
  /** The record was written by a newer build; it is read-only here. */
  | 'unsupported-record'
  /** The record is at its bound; nothing is evicted to make room. */
  | 'capacity'
  /** The record or the opener changed under the operation's plan. */
  | 'superseded'
  /** Storage refused the write. */
  | 'storage'
  /** The operation's own step (the arrangement, a state write) refused. */
  | 'refused';

export type PaneRelationsResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: PaneRelationsRefusal };

/** One locked transaction's view: a FRESH read of the shared record. */
export interface PaneRelationsTransaction {
  readonly stationId: string | null;
  readonly record: PaneRelationsRecord;
  /** Writes immediately; rolled back if the transaction then refuses. */
  write(next: PaneRelationsRecord): boolean;
}

export interface PaneRelationsValue {
  /**
   * The exact Station new relations are recorded against: the verified
   * authority observation's `environmentId`, or null while it is unknown. The
   * record stays readable either way; only writes need a Station.
   */
  stationId: string | null;
  relationOf(instanceId: string): PaneRelation | undefined;
  /** The kept occurrence of this exact target on this Station. */
  keptFor(target: PaneRelationTarget): PaneRelation | undefined;
  /** The transient preview this exact opener selection owns. */
  transientFor(opener: PaneOpener): PaneRelation | undefined;
  /** The selection an opener currently publishes, if it is mounted. */
  currentSelection(occurrenceId: string): string | undefined;
  /**
   * Run `body` inside the exclusive lock, after a fresh read of the shared
   * record. With `station`, the verified Station must still be exactly that
   * one when the lock is granted. A refusing body, or one that throws, has
   * its record write rolled back.
   */
  transact<T>(
    body: (tx: PaneRelationsTransaction) => PaneRelationsResult<T>,
    options?: { station?: string },
  ): Promise<PaneRelationsResult<T>>;
  /** Keep a related pane: it stops being the reusable preview. */
  keep(instanceId: string): Promise<PaneRelationsResult<void>>;
  /** Drop a related pane's entry (its occurrence was removed). */
  forget(instanceId: string): Promise<PaneRelationsResult<void>>;
  /**
   * An opener's current selection key (`openerSelectionKey`), published while
   * it is mounted. Returns the withdrawal. Transient previews of another
   * selection of that opener are source-hidden (`hiddenSurfaces`).
   */
  publishOpenerSelection(occurrenceId: string, selection: string): () => void;
  /** Transient previews hidden because their opener changed selection. */
  hiddenSurfaces: readonly string[];
}

const NO_SURFACES: readonly string[] = [];

type LockManager = {
  request(
    name: string,
    options: { mode: 'exclusive'; ifAvailable?: boolean },
    callback: (lock: object | null) => unknown,
  ): Promise<unknown>;
};

function browserLocks(): LockManager | null {
  const locks = (globalThis.navigator as { locks?: LockManager } | undefined)
    ?.locks;
  return locks && typeof locks.request === 'function' ? locks : null;
}

function readStoredRelations(): PaneRelationsRead {
  try {
    return parsePaneRelations(
      window.localStorage.getItem(PANE_RELATIONS_STORAGE_KEY),
    );
  } catch {
    return parsePaneRelations(null);
  }
}

/** A related occurrence exists while its fence does (`pane-fence.ts`). */
function fenceExists(instanceId: string): boolean {
  return readPaneFence(window.localStorage, instanceId).status !== 'none';
}

const DEFAULT_VALUE: PaneRelationsValue = {
  stationId: null,
  relationOf: () => undefined,
  keptFor: () => undefined,
  transientFor: () => undefined,
  currentSelection: () => undefined,
  transact: async () => ({ ok: false, reason: 'station-unverified' }),
  keep: async () => ({ ok: false, reason: 'station-unverified' }),
  forget: async () => ({ ok: false, reason: 'station-unverified' }),
  publishOpenerSelection: () => () => {},
  hiddenSurfaces: NO_SURFACES,
};

const PaneRelationsContext = createContext<PaneRelationsValue>(DEFAULT_VALUE);

/**
 * The relations side record for the mounted app, below `RegionModelProvider`
 * (a Keep made over a phone layer retains the layer's pane in the
 * arrangement) and above the region shells, which suspend `hiddenSurfaces`.
 */
export function PaneRelationsProvider({ children }: { children: ReactNode }) {
  const authority = useAuthorityPersistence();
  const stationId =
    authority.status === 'verified'
      ? (authority.observation?.environmentId ?? null)
      : null;
  const stationRef = useRef(stationId);
  stationRef.current = stationId;
  const model = useRegionModelOptional();
  const modelRef = useRef(model);
  useLayoutEffect(() => {
    modelRef.current = model;
  });
  const [stored, setStored] = useState(readStoredRelations);
  const recordRef = useRef(stored.record);
  recordRef.current = stored.record;
  const [selections, setSelections] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );
  const selectionsRef = useRef(selections);
  selectionsRef.current = selections;

  // Another tab's write is the newest record; adopt it for display. Writes
  // never start from this copy: they re-read inside the lock.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== PANE_RELATIONS_STORAGE_KEY) return;
      setStored(parsePaneRelations(event.newValue));
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const transact = useCallback(
    async <T,>(
      body: (tx: PaneRelationsTransaction) => PaneRelationsResult<T>,
      options: { station?: string } = {},
    ): Promise<PaneRelationsResult<T>> => {
      const locks = browserLocks();
      if (!locks) return { ok: false, reason: 'lock-unavailable' };
      let result: PaneRelationsResult<T> = { ok: false, reason: 'contended' };
      try {
        await locks.request(
          PANE_RELATIONS_LOCK,
          { mode: 'exclusive', ifAvailable: true },
          (lock) => {
            if (!lock) return;
            if (
              options.station !== undefined &&
              stationRef.current !== options.station
            ) {
              result = { ok: false, reason: 'station-changed' };
              return;
            }
            let freshRaw: string | null;
            try {
              freshRaw = window.localStorage.getItem(
                PANE_RELATIONS_STORAGE_KEY,
              );
            } catch {
              result = { ok: false, reason: 'storage' };
              return;
            }
            const fresh = parsePaneRelations(freshRaw);
            if (fresh.status === 'unsupported') {
              setStored(fresh);
              result = { ok: false, reason: 'unsupported-record' };
              return;
            }
            const base = prunePaneRelations(fresh.record, fenceExists);
            let written: PaneRelationsRecord | null = null;
            const tx: PaneRelationsTransaction = {
              stationId: stationRef.current,
              record: base,
              write: (next) => {
                try {
                  window.localStorage.setItem(
                    PANE_RELATIONS_STORAGE_KEY,
                    serializePaneRelations(next),
                  );
                  written = next;
                  return true;
                } catch {
                  return false;
                }
              },
            };
            let outcome: PaneRelationsResult<T>;
            try {
              outcome = body(tx);
            } catch {
              outcome = { ok: false, reason: 'refused' };
            }
            if (!outcome.ok && written) {
              try {
                if (freshRaw === null)
                  window.localStorage.removeItem(PANE_RELATIONS_STORAGE_KEY);
                else
                  window.localStorage.setItem(
                    PANE_RELATIONS_STORAGE_KEY,
                    freshRaw,
                  );
              } catch {
                // The write itself succeeded moments ago; a failing restore
                // leaves the newer record, which names only occurrences that
                // exist.
              }
              written = null;
            }
            // A successful transaction that wrote nothing still persists the
            // prune it read through, so the record and this owner's copy
            // agree that removed occurrences are gone.
            if (outcome.ok && written === null && base !== fresh.record)
              tx.write(base);
            const latest: PaneRelationsRecord = outcome.ok
              ? (written ?? base)
              : fresh.record;
            recordRef.current = latest;
            setStored({ status: 'ok', record: latest });
            result = outcome;
          },
        );
      } catch {
        return { ok: false, reason: 'lock-unavailable' };
      }
      return result;
    },
    [],
  );

  const keep = useCallback(
    async (instanceId: string): Promise<PaneRelationsResult<void>> => {
      const station = stationRef.current;
      if (station === null) return { ok: false, reason: 'station-unverified' };
      const outcome = await transact<void>(
        (tx) => {
          const current = paneRelationOf(tx.record, instanceId);
          if (!current || current.stationId !== station)
            return { ok: false, reason: 'superseded' };
          const next = withKeptPane(tx.record, instanceId);
          if (next === tx.record) return { ok: true, value: undefined };
          return tx.write(next)
            ? { ok: true, value: undefined }
            : { ok: false, reason: 'storage' };
        },
        { station },
      );
      // A pane a phone layer put over Chat becomes an ordinary tab, so Back
      // and a later replacement leave it where it is.
      if (outcome.ok) modelRef.current?.retainLayerPane(instanceId);
      return outcome;
    },
    [transact],
  );

  const forget = useCallback(
    (instanceId: string) =>
      transact<void>((tx) => {
        const next = withoutPaneRelation(tx.record, instanceId);
        if (next === tx.record) return { ok: true, value: undefined };
        return tx.write(next)
          ? { ok: true, value: undefined }
          : { ok: false, reason: 'storage' };
      }),
    [transact],
  );

  // Beginning an edit protects the target: the moment a related preview's
  // own unsaved-changes guard registers, it is kept. A refused keep (another
  // tab writing) still leaves the guard itself, which every replacement and
  // close asks first.
  useEffect(
    () =>
      navigationStore.subscribeNavigationGuardOwners((owner) => {
        const relation = paneRelationOf(recordRef.current, owner);
        if (
          relation &&
          !relation.kept &&
          relation.stationId === stationRef.current
        )
          void keep(owner);
      }),
    [keep],
  );

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
  );
  const hiddenKey = hiddenList.join('\n');
  // biome-ignore lint/correctness/useExhaustiveDependencies: the joined key is the list's identity; suspension readers memoize on it.
  const hiddenSurfaces = useMemo(
    () => (hiddenList.length === 0 ? NO_SURFACES : hiddenList),
    [hiddenKey],
  );

  const record = stored.record;
  const value = useMemo<PaneRelationsValue>(
    () => ({
      stationId,
      relationOf: (instanceId) => paneRelationOf(record, instanceId),
      keptFor: (target) =>
        stationId === null
          ? undefined
          : keptPaneForTarget(record, stationId, target),
      transientFor: (opener) =>
        stationId === null
          ? undefined
          : transientPaneForOpener(record, stationId, opener),
      currentSelection: (occurrenceId) =>
        selectionsRef.current.get(occurrenceId),
      transact,
      keep,
      forget,
      publishOpenerSelection,
      hiddenSurfaces,
    }),
    [
      forget,
      hiddenSurfaces,
      keep,
      publishOpenerSelection,
      record,
      stationId,
      transact,
    ],
  );

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
 * Publish an opener's current selection key for as long as it is mounted, so
 * the previews it opened for another selection hide (and come back with it).
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
