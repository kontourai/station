import {
  StationBasisPane,
  type StationBasisPaneExecutionActionInput,
  type StationBasisPaneExecutionResultRef,
  type StationBasisPaneRequestScope,
  type StationBasisPaneScope,
} from '@kontourai/station-basis-pane/station-basis-pane';
import {
  useAttachTaskToolResultReferenceMutation,
  useSessionToolResultQuery,
  useTaskToolResultReferencesQuery,
} from '@kontourai/station-sdk/task-tool-results';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import {
  ResponsiveDialogHeader,
  ResponsiveDialogSurface,
} from '../components/ResponsiveDialogSurface';
import { SkeletonBlock } from '../components/state';
import { useHostRequestAuthorityScope } from '../contexts/ApiBaseContext';

const LazyBasisTaskPicker = lazy(() =>
  import('./BasisTaskPicker').then(({ BasisTaskPicker }) => ({
    default: BasisTaskPicker,
  })),
);

export interface ConnectedStationBasisPaneProps {
  scope: StationBasisPaneScope;
  /** Filters a direct-answer chooser only; a selected Task is always explicit. */
  currentProjectId?: string;
}

/**
 * Station's effectful Basis seam. The published pane gets only a render slot;
 * this host owns all SDK reads, writes, task picking, and responsive dialogs.
 */
export function ConnectedStationBasisPane({
  scope,
  currentProjectId,
}: ConnectedStationBasisPaneProps) {
  const requestScope: StationBasisPaneRequestScope | undefined =
    useHostRequestAuthorityScope();
  if (!requestScope)
    return (
      <section role="alert">
        Basis is unavailable until this Station is authorized.
      </section>
    );
  return (
    <ConnectedStationBasisPaneSurface
      key={
        requestScope
          ? `${requestScope.apiBase}\u0000${requestScope.authorityKey}`
          : 'authority-unavailable'
      }
      scope={scope}
      currentProjectId={currentProjectId}
      requestScope={requestScope}
    />
  );
}

function ConnectedStationBasisPaneSurface({
  scope,
  currentProjectId,
  requestScope,
}: ConnectedStationBasisPaneProps & {
  requestScope?: StationBasisPaneRequestScope;
}) {
  const taskResultReferences = useTaskToolResultReferencesQuery(
    scope.kind === 'task-answer' ? scope.taskId : '',
    {
      enabled: scope.kind === 'task-answer',
      requestScope,
    },
  );
  const keptStatus =
    scope.kind === 'task-answer'
      ? {
          isLoading: taskResultReferences.isLoading,
          error: taskResultReferences.error,
          retry: taskResultReferences.refetch,
        }
      : undefined;
  return (
    <StationBasisPane
      scope={scope}
      requestScope={requestScope}
      renderExecutionActions={(input) => (
        <ExecutionActions
          key={input.occurrenceKey}
          input={input}
          currentProjectId={currentProjectId}
          requestScope={requestScope}
          reauthorizedKeptReference={
            input.keptReference ??
            findExactKeptReference(taskResultReferences.data, input.ref)
          }
          keptStatus={keptStatus}
        />
      )}
    />
  );
}

function findExactKeptReference(
  references: ReturnType<typeof useTaskToolResultReferencesQuery>['data'],
  ref: StationBasisPaneExecutionResultRef,
) {
  const match = references?.find(
    (item) =>
      item.state === 'available' &&
      item.ref.threadId === ref.threadId &&
      item.ref.resultId === ref.resultId,
  );
  return match?.state === 'available'
    ? {
        referenceId: match.id,
        ref: match.ref,
        kept: true as const,
        associatedAnswerReferenceIds: [],
      }
    : undefined;
}

function ExecutionActions({
  input,
  currentProjectId,
  requestScope,
  reauthorizedKeptReference,
  keptStatus,
}: {
  input: StationBasisPaneExecutionActionInput;
  currentProjectId?: string;
  requestScope?: StationBasisPaneRequestScope;
  reauthorizedKeptReference: StationBasisPaneExecutionActionInput['keptReference'];
  keptStatus?: {
    isLoading: boolean;
    error: unknown;
    retry: () => unknown;
  };
}) {
  const [inspectOpen, setInspectOpen] = useState(false);
  const actions = useRef<HTMLFieldSetElement>(null);
  const captured = inspectOpen
    ? {
        ref: input.ref,
        scope: input.scope,
        occurrenceKey: input.occurrenceKey,
      }
    : null;
  const inspection = useSessionToolResultQuery(
    captured?.ref.threadId ?? '',
    captured?.ref.resultId ?? '',
    { enabled: captured !== null, requestScope },
  );
  const taskId = taskDestination(input.scope);
  const keepUnavailable = Boolean(
    reauthorizedKeptReference || keptStatus?.isLoading || keptStatus?.error,
  );
  useEffect(() => {
    if (!inspectOpen) return;
    // This inspector can reopen inside the query's freshness window. A
    // protected result must be reauthorized for each inspection, rather than
    // presenting a prior observation as if it still had access. Join the
    // enabled query's first read when it is still settling rather than
    // cancelling and reissuing it.
    void inspection.refetch({ cancelRefetch: false });
  }, [inspectOpen, inspection.refetch]);
  useEffect(() => {
    if (!input.restoreFocusAction) return;
    if (document.activeElement === document.body) {
      const action =
        input.restoreFocusAction === 'keep' && !keepUnavailable
          ? 'keep'
          : 'inspect';
      actions.current
        ?.querySelector<HTMLButtonElement>(
          `[data-station-basis-action="${action}"]`,
        )
        ?.focus();
    }
    input.onFocusRestoreHandled?.();
  }, [input, keepUnavailable]);
  return (
    <fieldset
      ref={actions}
      aria-label="Tool result actions"
      className="station-basis-pane__execution-actions"
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (next && !event.currentTarget.contains(next)) input.onActionBlur?.();
      }}
    >
      <button
        type="button"
        onClick={() => {
          input.onActionFocus?.('inspect');
          setInspectOpen(true);
        }}
        aria-label="Inspect tool result"
        data-station-basis-action="inspect"
        onFocus={() => input.onActionFocus?.('inspect')}
      >
        Inspect
      </button>
      {taskId ? (
        <KeepInExactTask
          input={input}
          taskId={taskId}
          requestScope={requestScope}
          keptReference={reauthorizedKeptReference}
          keptStatus={keptStatus}
          onFocus={() => input.onActionFocus?.('keep')}
        />
      ) : (
        <KeepInPickedTask
          input={input}
          currentProjectId={currentProjectId}
          requestScope={requestScope}
        />
      )}
      {inspectOpen && captured ? (
        <ToolResultInspector
          resultRef={captured.ref}
          occurrenceKey={captured.occurrenceKey}
          inspection={inspection}
          onClose={() => setInspectOpen(false)}
        />
      ) : null}
    </fieldset>
  );
}

function taskDestination(scope: StationBasisPaneScope): string | null {
  return scope.kind === 'task-answer' || scope.kind === 'whole-task'
    ? scope.taskId
    : null;
}

function KeepInExactTask({
  input,
  taskId,
  requestScope,
  keptReference,
  keptStatus,
  onFocus,
}: {
  input: StationBasisPaneExecutionActionInput;
  taskId: string;
  requestScope?: StationBasisPaneRequestScope;
  keptReference: StationBasisPaneExecutionActionInput['keptReference'];
  keptStatus?: {
    isLoading: boolean;
    error: unknown;
    retry: () => unknown;
  };
  onFocus(): void;
}) {
  const attach = useAttachTaskToolResultReferenceMutation({ requestScope });
  const [mutationFailed, setMutationFailed] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    generation.current += 1;
    return () => {
      generation.current += 1;
    };
  }, []);
  const statusUnknown = Boolean(keptStatus?.isLoading || keptStatus?.error);
  const disabled = Boolean(keptReference) || attach.isPending || statusUnknown;
  return (
    <>
      <button
        type="button"
        // Keep the focused action mounted and focusable during an in-flight
        // mutation; native disabled emits blur before the authorized refresh.
        // The click guard below enforces every unavailable state.
        aria-disabled={disabled ? true : undefined}
        data-station-basis-action="keep"
        onFocus={onFocus}
        onClick={() => {
          if (disabled) return;
          onFocus();
          setMutationFailed(false);
          const capturedGeneration = generation.current;
          void attach
            .mutateAsync({
              taskId,
              sessionId: input.ref.threadId,
              eventId: input.ref.resultId,
              sourceSurface: 'nativeBasis',
            })
            .catch(() => {
              if (capturedGeneration === generation.current)
                setMutationFailed(true);
            });
        }}
      >
        {keptReference ? 'Kept' : 'Keep in Task'}
      </button>
      {keptStatus?.isLoading ? (
        <SkeletonBlock count={1} label="Checking kept status" />
      ) : null}
      {keptStatus?.error ? (
        <p role="alert">
          Unable to verify whether this result is kept.{' '}
          <button type="button" onClick={() => void keptStatus.retry()}>
            Retry
          </button>
        </p>
      ) : null}
      {mutationFailed ? (
        <p role="alert">Unable to keep this result in the Task. Try again.</p>
      ) : null}
    </>
  );
}

function KeepInPickedTask({
  input,
  currentProjectId,
  requestScope,
}: {
  input: StationBasisPaneExecutionActionInput;
  currentProjectId?: string;
  requestScope?: StationBasisPaneRequestScope;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        data-station-basis-action="keep"
        aria-label="Keep this tool result in a Task"
        onClick={() => setOpen(true)}
      >
        Keep in Task
      </button>
      {open ? (
        <Suspense
          fallback={<SkeletonBlock count={2} label="Loading Task picker" />}
        >
          <LazyBasisTaskPicker
            input={input}
            currentProjectId={currentProjectId}
            requestScope={requestScope}
            onClose={() => setOpen(false)}
          />
        </Suspense>
      ) : null}
    </>
  );
}

function ToolResultInspector({
  resultRef,
  occurrenceKey,
  inspection,
  onClose,
}: {
  resultRef: StationBasisPaneExecutionResultRef;
  occurrenceKey: string;
  inspection: ReturnType<typeof useSessionToolResultQuery>;
  onClose: () => void;
}) {
  const result = inspection.data;
  return (
    <ResponsiveDialogSurface
      ariaLabel="Tool result"
      panelClassName="station-basis-pane__inspector"
      onClose={onClose}
    >
      <ResponsiveDialogHeader
        title="Tool result"
        closeLabel="Close tool result"
        onClose={onClose}
      />
      <div
        className="station-basis-pane__inspector-body"
        data-occurrence={occurrenceKey}
      >
        {inspection.isLoading ? (
          <SkeletonBlock count={3} label="Loading tool result" />
        ) : null}
        {inspection.error ? (
          <p role="alert">Tool result is unavailable.</p>
        ) : null}
        {result ? (
          <SafeToolResultText resultRef={resultRef} result={result} />
        ) : null}
      </div>
    </ResponsiveDialogSurface>
  );
}

function SafeToolResultText({
  resultRef,
  result,
}: {
  resultRef: StationBasisPaneExecutionResultRef;
  result: NonNullable<ReturnType<typeof useSessionToolResultQuery>['data']>;
}) {
  return (
    <>
      <dl className="station-basis-pane__facts">
        <dt>Name</dt>
        <dd>{result.name}</dd>
        <dt>Status</dt>
        <dd>{result.terminalStatus}</dd>
        <dt>Result</dt>
        <dd>{resultRef.resultId}</dd>
        <dt>Truncated</dt>
        <dd>{result.truncated ? 'Yes' : 'No'}</dd>
        <dt>Omitted parts</dt>
        <dd>{result.omittedParts}</dd>
        <dt>Omitted text bytes</dt>
        <dd>{result.omittedTextBytes}</dd>
        <dt>Omitted metadata bytes</dt>
        <dd>{result.omittedMetadataBytes}</dd>
      </dl>
      {result.authorityDecision ? (
        <p>
          Authority decision: {result.authorityDecision.decision} by{' '}
          {result.authorityDecision.authority}
          {result.authorityDecision.policyId
            ? ` (policy ${result.authorityDecision.policyId})`
            : ''}
        </p>
      ) : null}
      {result.content.map((part, index) =>
        part.type === 'text' ? (
          <pre key={`${part.type}:${index}`}>{part.text}</pre>
        ) : (
          <p key={`${part.type}:${index}`}>
            {part.type === 'image'
              ? `Image (${part.mediaType}) not displayed.`
              : `File (${part.name}, ${part.mediaType}) not displayed.`}
          </p>
        ),
      )}
    </>
  );
}
