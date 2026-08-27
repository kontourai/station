import { SessionInventory } from '@kontourai/station-basis-pane/session-inventory';
import {
  buildSessionInventoryViewModel,
  type SessionInventoryAction,
  type SessionInventorySelection,
  type SessionInventoryViewItem,
} from '@kontourai/station-basis-pane/session-inventory-view';
import { BasisStandingAssessmentSummary } from '@kontourai/station-basis-pane/station-basis-pane';
import type {
  SessionInventoryGroupId,
  SessionInventoryGroupPage,
  SessionInventoryProjection,
  SessionInventoryScope,
  StationSessionOutputRow,
} from '@kontourai/station-contracts/session-inventory';
import {
  useSessionInventoryGroupPage,
  useSessionInventoryQuery,
} from '@kontourai/station-sdk/session-inventory';
import { useKeepSessionOutputMutation } from '@kontourai/station-sdk/session-output-actions';
import { buildBasisPanelViewModel } from '@kontourai/surface/basis/view';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { SkeletonBlock } from '../components/state';
import { useHostRequestAuthorityScope } from '../contexts/ApiBaseContext';
import {
  clearSessionInventorySelectionsForAuthority,
  commitSessionInventorySelection,
  readSessionInventoryKnownScopes,
  useSessionInventorySelection,
} from './sessionInventorySelection';
import './SessionInventory.css';

const LazySessionOutputInspector = lazy(() =>
  import('./SessionOutputInspector').then(({ SessionOutputInspector }) => ({
    default: SessionOutputInspector,
  })),
);
const LazySessionInventoryTaskPicker = lazy(() =>
  import('./SessionInventoryTaskPicker').then(
    ({ SessionInventoryTaskPicker }) => ({
      default: SessionInventoryTaskPicker,
    }),
  ),
);

export function ConnectedSessionInventory({
  sessionId,
  currentProjectId,
}: {
  sessionId: string;
  currentProjectId?: string;
}) {
  const requestScope = useHostRequestAuthorityScope();
  const previousAuthority = useRef(requestScope);
  useEffect(() => {
    const previous = previousAuthority.current;
    if (
      previous &&
      (!requestScope ||
        previous.apiBase !== requestScope.apiBase ||
        previous.authorityKey !== requestScope.authorityKey)
    )
      clearSessionInventorySelectionsForAuthority(
        previous.apiBase,
        previous.authorityKey,
      );
    previousAuthority.current = requestScope;
  }, [requestScope]);
  if (!requestScope)
    return (
      <section role="alert">
        Session inventory is unavailable until this Station is authorized.
      </section>
    );
  return (
    <ConnectedSessionInventorySurface
      key={`${requestScope.apiBase}\u0000${requestScope.authorityKey}\u0000${sessionId}`}
      sessionId={sessionId}
      currentProjectId={currentProjectId}
      requestScope={requestScope}
    />
  );
}

function ConnectedSessionInventorySurface({
  sessionId,
  currentProjectId,
  requestScope,
}: {
  sessionId: string;
  currentProjectId?: string;
  requestScope: { apiBase: string; authorityKey: string };
}) {
  const initial: SessionInventorySelection = {
    scope: { kind: 'whole-session', sessionId },
    groupId: 'inputs',
  };
  const selectionKey = useMemo(
    () => ({ ...requestScope, sessionId }),
    [requestScope, sessionId],
  );
  const selection = useSessionInventorySelection(selectionKey, initial);
  const [focusGroupToken, setFocusGroupToken] = useState(0);
  const inventory = useSessionInventoryQuery(selection.scope, { requestScope });
  const [nextPage, setNextPage] = useState<{
    groupId: SessionInventoryGroupId;
    continuation: string;
    scopeKey: string;
  } | null>(null);
  const selectedScopeKey = scopeKey(selection.scope);
  const previousScopeKey = useRef(selectedScopeKey);
  const [loadedPages, setLoadedPages] = useState<
    readonly { key: string; page: SessionInventoryGroupPage }[]
  >([]);
  useEffect(() => {
    if (previousScopeKey.current === selectedScopeKey) return;
    previousScopeKey.current = selectedScopeKey;
    setNextPage(null);
    setLoadedPages([]);
  }, [selectedScopeKey]);
  const page = useSessionInventoryGroupPage(
    selection.scope,
    nextPage?.groupId ?? 'inputs',
    nextPage?.continuation,
    {
      enabled: nextPage?.scopeKey === selectedScopeKey,
      requestScope,
    },
  );
  useEffect(() => {
    const received = page.data;
    if (!received || scopeKey(received.scope) !== selectedScopeKey) return;
    const key = `${selectedScopeKey}\u0000${received.group.id}\u0000${nextPage?.continuation ?? ''}`;
    setLoadedPages((current) =>
      current.some((entry) => entry.key === key)
        ? current
        : [...current, { key, page: received }],
    );
  }, [nextPage?.continuation, page.data, selectedScopeKey]);
  const projection = mergePages(inventory.data, loadedPages, selection.scope);
  const model = projection
    ? buildSessionInventoryViewModel(projection, selection, 'full')
    : null;
  useEffect(() => {
    if (model?.repairedSelection)
      commitSessionInventorySelection(selectionKey, model.selection);
  }, [model, selectionKey]);
  const pageFailed = Boolean(
    page.error && nextPage?.scopeKey === selectedScopeKey,
  );
  const unavailable = Boolean(inventory.error || pageFailed);
  if (unavailable) {
    return (
      <section role="alert">
        Session inventory is unavailable.
        {pageFailed ? (
          <button type="button" onClick={() => void page.refetch()}>
            Retry page
          </button>
        ) : null}
      </section>
    );
  }
  if (inventory.isLoading || !model)
    return <SkeletonBlock count={4} label="Loading Session inventory" />;
  return (
    <>
      {model.scope.kind === 'current-answer' ? (
        <CurrentAnswerStanding
          key={currentAnswerStandingIdentity(model.scope, requestScope)}
          scope={model.scope}
          requestScope={requestScope}
          basis={projection?.basis}
        />
      ) : null}
      <SessionInventory
        model={model}
        onSelect={(next) => commitSessionInventorySelection(selectionKey, next)}
        scopeOptions={availableScopes(
          selection.scope,
          readSessionInventoryKnownScopes(selectionKey),
        )}
        onScopeChange={(scope) =>
          commitSessionInventorySelection(selectionKey, {
            scope,
            groupId: 'inputs',
          })
        }
        onLoadMore={(groupId, continuation) =>
          setNextPage({ groupId, continuation, scopeKey: selectedScopeKey })
        }
        renderAction={({ action, item }) => (
          <OutputAction
            action={action}
            item={item}
            scope={model.scope}
            currentProjectId={currentProjectId}
            requestScope={requestScope}
            onUnavailable={() => {
              commitSessionInventorySelection(selectionKey, {
                scope: model.scope,
                groupId: 'outputs',
              });
              setFocusGroupToken((current) => current + 1);
            }}
          />
        )}
        repairFocus={model.repairedSelection}
        focusGroupToken={focusGroupToken || undefined}
      />
    </>
  );
}

function CurrentAnswerStanding({
  scope,
  requestScope,
  basis,
}: {
  scope: Extract<SessionInventoryScope, { kind: 'current-answer' }>;
  requestScope: { apiBase: string; authorityKey: string };
  basis: SessionInventoryProjection['basis'];
}) {
  const identity = currentAnswerStandingIdentity(scope, requestScope);
  const [assessmentOpen, setAssessmentOpen] = useState(false);
  const [visibleItemWindows, setVisibleItemWindows] = useState<
    Readonly<Record<string, number>>
  >({});
  const model = basis ? buildBasisPanelViewModel(basis) : null;
  if (!model)
    return <section role="alert">Current answer Basis is unavailable.</section>;
  return (
    <BasisStandingAssessmentSummary
      identity={identity}
      model={model}
      assessmentOpen={assessmentOpen}
      onAssessmentOpenChange={setAssessmentOpen}
      visibleItemCount={(resetKey) => visibleItemWindows[resetKey] ?? 20}
      onVisibleItemCountChange={(resetKey, count) =>
        setVisibleItemWindows((current) => ({ ...current, [resetKey]: count }))
      }
    />
  );
}

function currentAnswerStandingIdentity(
  scope: Extract<SessionInventoryScope, { kind: 'current-answer' }>,
  requestScope: { apiBase: string; authorityKey: string },
) {
  return JSON.stringify([
    requestScope.apiBase,
    requestScope.authorityKey,
    scope.sessionId,
    scope.turnId,
  ]);
}

function availableScopes(
  scope: SessionInventoryScope,
  known: readonly SessionInventoryScope[],
) {
  const whole = { kind: 'whole-session' as const, sessionId: scope.sessionId };
  const all = [
    whole,
    ...known.filter((candidate) => candidate.kind !== 'whole-session'),
  ];
  return all.filter(
    (candidate, index) =>
      all.findIndex(
        (other) => JSON.stringify(other) === JSON.stringify(candidate),
      ) === index,
  );
}

function mergePages(
  projection: SessionInventoryProjection | undefined,
  pages: readonly { key: string; page: SessionInventoryGroupPage }[],
  scope: SessionInventoryScope,
): SessionInventoryProjection | undefined {
  if (!projection) return projection;
  let current = projection;
  for (const entry of pages) {
    const page = entry.page;
    if (scopeKey(page.scope) !== scopeKey(scope)) continue;
    current = {
      ...current,
      groups: current.groups.map((group) =>
        group.id === page.group.id
          ? {
              ...group,
              ...page.group,
              items: dedupeItems([...group.items, ...page.group.items]),
            }
          : group,
      ),
    };
  }
  return current;
}

function dedupeItems<T extends { key: string }>(
  items: readonly T[],
): readonly T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.key)) return false;
    seen.add(item.key);
    return true;
  });
}

function scopeKey(scope: SessionInventoryScope): string {
  return JSON.stringify(scope);
}

function OutputAction({
  action,
  item,
  scope,
  currentProjectId,
  requestScope,
  onUnavailable,
}: {
  action: SessionInventoryAction;
  item: SessionInventoryViewItem;
  scope: SessionInventoryScope;
  currentProjectId?: string;
  requestScope: { apiBase: string; authorityKey: string };
  onUnavailable(): void;
}) {
  const row = item.row.kind === 'station-session-output' ? item.row : null;
  const trigger = useRef<HTMLButtonElement>(null);
  const [inspectOpen, setInspectOpen] = useState(false);
  if (!row) return null;
  if (action === 'inspect-output')
    return (
      <>
        <button
          ref={trigger}
          type="button"
          onClick={() => setInspectOpen(true)}
          aria-label="Inspect output"
        >
          Inspect
        </button>
        {inspectOpen ? (
          <Suspense
            fallback={<SkeletonBlock count={2} label="Loading output" />}
          >
            <LazySessionOutputInspector
              row={row}
              requestScope={requestScope}
              returnFocusTarget={trigger.current}
              onClose={() => setInspectOpen(false)}
              onUnavailable={() => {
                setInspectOpen(false);
                onUnavailable();
              }}
            />
          </Suspense>
        ) : null}
      </>
    );
  return (
    <KeepOutput
      row={row}
      scope={scope}
      currentProjectId={currentProjectId}
      requestScope={requestScope}
      label={action === 'keep-file' ? 'Keep file' : 'Keep PR'}
    />
  );
}

function KeepOutput({
  row,
  scope,
  currentProjectId,
  requestScope,
  label,
}: {
  row: StationSessionOutputRow;
  scope: SessionInventoryScope;
  currentProjectId?: string;
  requestScope: { apiBase: string; authorityKey: string };
  label: string;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const taskId = scope.kind === 'kept-in-task' ? scope.taskId : null;
  if (taskId)
    return (
      <KeepOutputInTask
        key={JSON.stringify([
          taskId,
          row.output.ref.sessionId,
          row.output.ref.eventId,
          requestScope.apiBase,
          requestScope.authorityKey,
        ])}
        row={row}
        taskId={taskId}
        label={label}
        requestScope={requestScope}
      />
    );
  return (
    <>
      <button type="button" onClick={() => setPickerOpen(true)}>
        {label}
      </button>
      {pickerOpen ? (
        <Suspense
          fallback={<SkeletonBlock count={2} label="Loading Task picker" />}
        >
          <LazySessionInventoryTaskPicker
            row={row}
            currentProjectId={currentProjectId}
            requestScope={requestScope}
            onClose={() => setPickerOpen(false)}
          />
        </Suspense>
      ) : null}
    </>
  );
}

function KeepOutputInTask({
  row,
  taskId,
  label,
  requestScope,
}: {
  row: StationSessionOutputRow;
  taskId: string;
  label: string;
  requestScope: { apiBase: string; authorityKey: string };
}) {
  const keep = useKeepSessionOutputMutation();
  const [outcome, setOutcome] = useState<string | null>(null);
  const generation = useRef(0);
  const operationTarget = JSON.stringify([
    taskId,
    row.output.ref.sessionId,
    row.output.ref.eventId,
    requestScope.apiBase,
    requestScope.authorityKey,
  ]);
  useEffect(() => {
    if (!operationTarget) return;
    return () => {
      generation.current += 1;
    };
  }, [operationTarget]);
  return (
    <>
      <button
        type="button"
        aria-disabled={keep.isPending || undefined}
        onClick={() => {
          if (keep.isPending) return;
          const capturedGeneration = generation.current;
          void keep
            .mutateAsync({
              taskId,
              sessionId: row.output.ref.sessionId,
              eventId: row.output.ref.eventId,
              operationId: crypto.randomUUID(),
              requestScope,
            })
            .then(
              (result) =>
                capturedGeneration === generation.current &&
                setOutcome(
                  result.outcome === 'already-kept' ? 'Already kept' : 'Kept',
                ),
            )
            .catch(
              () =>
                capturedGeneration === generation.current &&
                setOutcome('Unable to keep this output.'),
            );
        }}
      >
        {label}
      </button>
      {row.output.descriptor.kind === 'workspace-file' ? (
        <small>Kept files are immutable snapshots.</small>
      ) : (
        <small>Kept pull requests are live external references.</small>
      )}
      {outcome ? <span role="status">{outcome}</span> : null}
    </>
  );
}
