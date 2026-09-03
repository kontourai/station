import { SessionInventory } from '@kontourai/station-basis-pane/session-inventory';
import {
  buildSessionInventoryViewModel,
  mergeSessionInventoryGroupPages,
  type SessionInventoryAction,
  type SessionInventorySelection,
  type SessionInventoryViewItem,
} from '@kontourai/station-basis-pane/session-inventory-view';
import { BasisStandingAssessmentSummary } from '@kontourai/station-basis-pane/station-basis-pane';
import {
  type AnySessionInventoryGroupPage,
  type AnySessionInventoryProjection,
  deriveSessionWorkItemGithubUrl,
  type SessionInventoryScope,
  type SessionInventoryV2GroupId,
  type StationSessionOutputRow,
  type StationSessionWorkItemRow,
} from '@kontourai/station-contracts/session-inventory';
import {
  useSessionInventoryGroupPage,
  useSessionInventoryQuery,
} from '@kontourai/station-sdk/session-inventory';
import { useKeepSessionOutputMutation } from '@kontourai/station-sdk/session-output-actions';
import { randomCorrelationId } from '@kontourai/station-shared/random-id';
import { buildBasisPanelViewModel } from '@kontourai/surface/basis/view';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import {
  releaseSessionInventoryLiveBinding,
  useSessionInventoryLiveBinding,
} from '../components/chat-dock/sessionInventoryLiveBinding';
import {
  sessionInventoryLiveItems,
  useSessionInventoryLive,
} from '../components/chat-dock/useSessionInventoryLive';
import { SkeletonBlock } from '../components/state';
import { useHostRequestAuthorityScope } from '../contexts/ApiBaseContext';
import {
  clearSessionInventorySelectionsForAuthority,
  commitSessionInventorySelection,
  readSessionInventoryKnownScopes,
  readSessionInventorySelection,
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
  initialScope,
}: {
  sessionId: string;
  currentProjectId?: string;
  /** A caller-captured occurrence is authoritative over this surface's old whole-session default. */
  initialScope?: SessionInventoryScope;
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
      initialScope={initialScope}
      requestScope={requestScope}
    />
  );
}

function ConnectedSessionInventorySurface({
  sessionId,
  currentProjectId,
  requestScope,
  initialScope,
}: {
  sessionId: string;
  currentProjectId?: string;
  requestScope: { apiBase: string; authorityKey: string };
  initialScope?: SessionInventoryScope;
}) {
  const initial = useMemo<SessionInventorySelection>(
    () => ({
      scope: initialScope ?? { kind: 'whole-session', sessionId },
      groupId: 'inputs',
    }),
    [initialScope, sessionId],
  );
  const selectionKey = useMemo(
    () => ({ ...requestScope, sessionId }),
    [requestScope, sessionId],
  );
  const observedSelection = useSessionInventorySelection(selectionKey, initial);
  const storedSelection = readSessionInventorySelection(selectionKey);
  // A caller-provided exact scope replaces a previous scope before any query
  // sees it; the ordinary whole-session default and a same-scope reopen both
  // preserve the existing group and item.
  const selection =
    !initialScope ||
    (storedSelection &&
      scopeKey(storedSelection.scope) === scopeKey(initial.scope))
      ? observedSelection
      : initial;
  useEffect(() => {
    if (
      initialScope &&
      (!storedSelection ||
        scopeKey(storedSelection.scope) !== scopeKey(initial.scope))
    )
      commitSessionInventorySelection(selectionKey, initial);
  }, [initial, initialScope, selectionKey, storedSelection]);
  const [focusGroupToken, setFocusGroupToken] = useState(0);
  const inventory = useSessionInventoryQuery(selection.scope, { requestScope });
  const registryBinding = useSessionInventoryLiveBinding(
    requestScope,
    sessionId,
  );
  useEffect(() => {
    if (!registryBinding?.hostId.startsWith('hosted:')) return;
    return () =>
      releaseSessionInventoryLiveBinding(
        requestScope.apiBase,
        requestScope.authorityKey,
        sessionId,
        registryBinding,
      );
  }, [registryBinding, requestScope, sessionId]);
  const live = useSessionInventoryLive(
    requestScope,
    sessionId,
    registryBinding?.chatStoreId,
  );
  const [nextPage, setNextPage] = useState<{
    groupId: SessionInventoryV2GroupId;
    continuation: string;
    scopeKey: string;
  } | null>(null);
  const selectedScopeKey = scopeKey(selection.scope);
  const previousScopeKey = useRef(selectedScopeKey);
  const [loadedPages, setLoadedPages] = useState<
    readonly { key: string; page: AnySessionInventoryGroupPage }[]
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
  const projection = mergeSessionInventoryGroupPages(
    inventory.data,
    loadedPages.map((entry) => entry.page),
    selection.scope,
  );
  const model = projection
    ? buildSessionInventoryViewModel(
        projection,
        selection,
        'full',
        sessionInventoryLiveItems(live),
      )
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
      {model.scope.kind === 'current-answer' &&
      projection?.scope.kind === 'current-answer' &&
      projection.basis ? (
        <CurrentAnswerStanding
          key={currentAnswerStandingIdentity(model.scope, requestScope)}
          scope={model.scope}
          requestScope={requestScope}
          basis={projection.basis}
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
          <InventoryAction
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
  basis: Extract<
    AnySessionInventoryProjection,
    { scope: { kind: 'current-answer' } }
  >['basis'];
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

function scopeKey(scope: SessionInventoryScope): string {
  return JSON.stringify(scope);
}

function InventoryAction(props: {
  action: SessionInventoryAction;
  item: SessionInventoryViewItem;
  scope: SessionInventoryScope;
  currentProjectId?: string;
  requestScope: { apiBase: string; authorityKey: string };
  onUnavailable(): void;
}) {
  if (props.action === 'open-work-item')
    return (
      <OpenWorkItem
        row={
          props.item.row?.kind === 'station-session-work-item'
            ? props.item.row
            : null
        }
      />
    );
  return <OutputAction {...props} />;
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
  const row = item.row?.kind === 'station-session-output' ? item.row : null;
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

function OpenWorkItem({ row }: { row: StationSessionWorkItemRow | null }) {
  const href = row ? deriveSessionWorkItemGithubUrl(row) : null;
  if (!row || !href) return null;
  const providerContext = `${row.provider.id} ${row.repository.owner}/${row.repository.name}`;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Open work item ${row.workItemRef} in ${providerContext}`}
    >
      Open work item
    </a>
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
              operationId: randomCorrelationId(),
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
