import { parseGateEvaluationRef } from '@kontourai/flow/gate-evaluation-contract';
import {
  flowRunDisplayIdentity,
  isRetiredFlowDefinition,
} from '@kontourai/station-contracts';
import {
  type ApiRequestScope,
  type FlowConsoleEvidenceVM,
  type FlowConsoleGateVM,
  type FlowRunConsoleVM,
  type FlowRunSummaryVM,
  isApiRequestScope,
  useFlowRunConsoleQuery,
  useFlowRunsQuery,
  useTasksQuery,
} from '@kontourai/station-sdk';
import {
  useAttachTaskFlowGateEvaluationMutation,
  useProjectFlowGateEvaluationQuery,
} from '@kontourai/station-sdk/flow-gate-evaluations';
import { Badge, Metric } from '@kontourai/ui/react';
import {
  type RefObject,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { useNavigation } from '../../contexts/NavigationContext';
import { copyToClipboard } from '../../lib/clipboard';
import {
  TaskPicker,
  type TaskPickerAdapter,
  type TaskPickerTask,
} from '../chat/TaskPicker';
import { flowRunStatusTone } from '../kontour/station-tones';
import { Empty, Skeleton, SkeletonList } from '../state';
import './flow-events.css';
import './FlowRunConsole.css';

// ─── FlowRunConsole ───────────────────────────────────────────────────────────
// Project-wide gated-run visibility (roadmap S2): every Flow run in the
// project workspace, with per-run gate outcomes, open expectations,
// exceptions, evidence manifest, route-back state, and report paths. Data is
// Flow's own console projection (`projectFlowRunFromFiles`) served by the
// flow-runs routes — Station renders it without interpreting semantics.
//
// Registered as the builtin layout component `flow-run-console`, so any
// project layout can include it as a tab:
//   { "component": { "kind": "builtin-component", "name": "flow-run-console" } }
//
// Styled on the Console Kit contract (S2 item 4): `.panel` section chrome,
// `Badge` + tone classes for run statuses, `Metric` for the evidence-manifest
// status counts, `Empty` for empty states, `--k-*` tokens throughout. Gate
// cards keep the shared `.flow-gate-card--*` verdict mapping from
// flow-events.css (the same classes the chat verdict cards use).

const GATE_CARD_STATUSES = new Set(['pass', 'route-back', 'block', 'wait']);

function gateCardClass(status: string): string {
  return GATE_CARD_STATUSES.has(status)
    ? `flow-gate-card flow-gate-card--${status}`
    : 'flow-gate-card';
}

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return 'unknown';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

/**
 * Evidence label: the trust.bundle's claim type(s) when present, joined with
 * ' · ' for multi-claim bundles, falling back to the evidence kind or id.
 * Trust.bundle claims live at `entry.raw.bundle.claims` — the raw manifest
 * evidence entry Flow's console projection keeps verbatim (the retired
 * top-level `claim` field is gone as of Flow 1.3.x).
 */
function formatClaimTypes(entry: FlowConsoleEvidenceVM): string {
  const claimTypes = (entry.raw?.bundle?.claims ?? [])
    .map((claim) => claim.claimType)
    .filter((claimType): claimType is string => Boolean(claimType));
  if (claimTypes.length > 0) {
    return claimTypes.join(' · ');
  }
  return entry.kind ?? entry.id;
}

function RunListItem({
  run,
  active,
  onSelect,
}: {
  run: FlowRunSummaryVM;
  active: boolean;
  onSelect: (runId: string) => void;
}) {
  return (
    <li>
      <button
        type="button"
        className={`flow-run-console__run ${active ? 'flow-run-console__run--active' : ''}`}
        aria-current={active}
        onClick={() => onSelect(run.run_id)}
      >
        <span className="flow-run-console__run-id">
          {flowRunDisplayIdentity(run.definition_id, run.run_id)}
        </span>
        <span className="flow-run-console__run-meta">
          <Badge
            value={run.status}
            tone={flowRunStatusTone(run.status)}
            className="flow-run-console__status"
          />
          <span>{flowRunDisplayIdentity(run.definition_id)}</span>
        </span>
        <span className="flow-run-console__run-meta">
          <span>step: {run.current_step}</span>
          <span>{formatTimestamp(run.updated_at)}</span>
        </span>
      </button>
    </li>
  );
}

type GateEvaluationCapture = {
  projectSlug: string;
  ref: { runId: string; gateId: string; evaluationId: string };
  requestScope: ApiRequestScope;
};
type GateEvaluationNotice = GateEvaluationCapture & { taskTitle: string };

function sameGateEvaluationRef(
  left: GateEvaluationCapture['ref'] | null | undefined,
  right: GateEvaluationCapture['ref'],
) {
  return (
    left?.runId === right.runId &&
    left.gateId === right.gateId &&
    left.evaluationId === right.evaluationId
  );
}

function sameAuthorityScope(
  left: ApiRequestScope | undefined,
  right: ApiRequestScope,
) {
  return (
    left?.apiBase === right.apiBase && left.authorityKey === right.authorityKey
  );
}

function CapturedGateTaskPicker({
  capture,
  onClose,
  onAttached,
  returnFocusTargetRef,
}: {
  capture: GateEvaluationCapture;
  onClose: () => void;
  onAttached: (task: TaskPickerTask) => void;
  returnFocusTargetRef: RefObject<HTMLButtonElement | null>;
}) {
  const [returnFocusTarget, setReturnFocusTarget] =
    useState<HTMLButtonElement | null>(null);
  useLayoutEffect(() => {
    setReturnFocusTarget(returnFocusTargetRef.current);
  }, [returnFocusTargetRef]);
  const tasks = useTasksQuery(capture.projectSlug, {
    enabled: false,
    requestScope: capture.requestScope,
  });
  const attach = useAttachTaskFlowGateEvaluationMutation({
    requestScope: capture.requestScope,
  });
  const adapter = useMemo<TaskPickerAdapter>(
    () => ({
      tasks: tasks.data,
      isLoading: tasks.isLoading,
      error: tasks.error,
      refetch: tasks.refetch,
      isPending: attach.isPending,
    }),
    [attach.isPending, tasks.data, tasks.error, tasks.isLoading, tasks.refetch],
  );
  if (!returnFocusTarget) return null;
  return (
    <TaskPicker
      initiallyOpen
      hideTrigger
      returnFocusTarget={returnFocusTarget}
      target={capture.ref}
      triggerLabel="Keep in Task"
      triggerAriaLabel={`Keep gate evaluation ${capture.ref.evaluationId} in a Task`}
      dialogTitle="Keep gate evaluation in Task"
      eyebrow="Flow gate evaluation"
      projectId={capture.projectSlug}
      adapter={adapter}
      onOpen={() => void tasks.refetch()}
      onClose={onClose}
      onAttached={onAttached}
      attach={(taskId, target) =>
        attach.mutateAsync({
          taskId,
          ref: target,
          sourceSurface: 'flow-console',
        })
      }
      successMessage={(task) => `Gate evaluation kept in Task “${task.title}”.`}
    />
  );
}

function GateCard({
  gate,
  projectSlug,
}: {
  gate: FlowConsoleGateVM;
  projectSlug: string;
}) {
  const requestScope = useHostRequestAuthorityScope();
  const ref = gate.evaluation_ref
    ? parseGateEvaluationRef(gate.evaluation_ref)
    : null;
  const [inspect, setInspect] = useState(false);
  const [capture, setCapture] = useState<GateEvaluationCapture | null>(null);
  const [notice, setNotice] = useState<GateEvaluationNotice | null>(null);
  const keepButtonRef = useRef<HTMLButtonElement>(null);
  const captureMatches =
    capture !== null && sameAuthorityScope(requestScope, capture.requestScope);
  // Do not leave an old captured capability waiting to reappear if a caller
  // switches away and back before a passive effect runs. The mismatched frame
  // renders no picker, and this render-phase reset makes the closure terminal.
  if (capture && !captureMatches) setCapture(null);
  const currentWitnessRef = useRef({ projectSlug, ref, requestScope });
  currentWitnessRef.current = { projectSlug, ref, requestScope };
  const noticeMatches =
    notice !== null &&
    notice.projectSlug === projectSlug &&
    sameGateEvaluationRef(ref, notice.ref) &&
    sameAuthorityScope(requestScope, notice.requestScope);
  const evaluation = useProjectFlowGateEvaluationQuery(
    projectSlug,
    ref ?? undefined,
    {
      enabled: inspect && Boolean(ref),
      requestScope,
    },
  );
  const attemptLabel =
    gate.attempt != null && gate.max_attempts != null
      ? `attempt ${gate.attempt} of ${gate.max_attempts}`
      : null;

  return (
    <section
      className={gateCardClass(gate.status)}
      aria-label={`Gate ${gate.id}`}
    >
      <div className="flow-gate-card__header">
        <span className="flow-gate-card__title">
          {gate.id} · {gate.status}
        </span>
        {attemptLabel && (
          <span className="flow-gate-card__attempt">{attemptLabel}</span>
        )}
      </div>
      {gate.summary && (
        <p className="flow-gate-card__summary">{gate.summary}</p>
      )}
      <div className="flow-gate-card__meta">
        Step: {gate.step_id}
        {gate.is_open ? ' · open' : ''}
      </div>
      {gate.route_back_to && (
        <div className="flow-gate-card__meta">
          Routed back to step: <strong>{gate.route_back_to}</strong>
          {gate.route_reason ? ` (${gate.route_reason})` : ''}
        </div>
      )}
      {gate.missing.length > 0 && (
        <>
          <div className="flow-gate-card__meta">Open expectations:</div>
          <ul className="flow-gate-card__missing">
            {gate.missing.map((expectation) => (
              <li key={expectation}>{expectation}</li>
            ))}
          </ul>
        </>
      )}
      {gate.evidence.length > 0 && (
        <ul className="flow-run-console__gate-evidence">
          {gate.evidence.map((entry) => (
            <li key={entry.id} className="flow-run-console__evidence-row">
              <span className="flow-run-console__evidence-claim">
                {formatClaimTypes(entry)}
              </span>
              <span className="flow-run-console__evidence-meta">
                {entry.producer ?? 'unknown producer'} ·{' '}
                {entry.status ?? 'recorded'}
              </span>
            </li>
          ))}
        </ul>
      )}
      {ref && (
        <div className="flow-gate-card__actions">
          <button
            type="button"
            className="flow-gate-card__copy-btn"
            onClick={() => setInspect(true)}
          >
            Inspect evaluation
          </button>
          <button
            ref={keepButtonRef}
            type="button"
            className="task-picker__trigger"
            aria-label={`Keep gate evaluation ${ref.evaluationId} in a Task`}
            onClick={() => {
              if (!isApiRequestScope(requestScope)) return;
              setCapture({
                projectSlug,
                ref: { ...ref },
                requestScope: {
                  apiBase: requestScope.apiBase,
                  authorityKey: requestScope.authorityKey,
                },
              });
            }}
          >
            Keep in Task
          </button>
          {captureMatches && capture && (
            <CapturedGateTaskPicker
              key={`${capture.projectSlug}\u0000${capture.ref.runId}\u0000${capture.ref.gateId}\u0000${capture.ref.evaluationId}\u0000${capture.requestScope.apiBase}\u0000${capture.requestScope.authorityKey}`}
              capture={capture}
              onClose={() => {
                setCapture(null);
              }}
              onAttached={(task) => {
                const current = currentWitnessRef.current;
                if (
                  current.projectSlug !== capture.projectSlug ||
                  !sameGateEvaluationRef(current.ref, capture.ref) ||
                  !sameAuthorityScope(
                    current.requestScope,
                    capture.requestScope,
                  )
                )
                  return;
                setNotice({ ...capture, taskTitle: task.title });
              }}
              returnFocusTargetRef={keepButtonRef}
            />
          )}
          {noticeMatches && notice && (
            <span className="task-picker__status" role="status">
              Gate evaluation kept in Task “{notice.taskTitle}”.
            </span>
          )}
        </div>
      )}
      {inspect && ref && (
        <div className="flow-gate-card__meta" aria-live="polite">
          {evaluation.isLoading
            ? 'Loading immutable evaluation…'
            : evaluation.error
              ? 'Gate evaluation is unavailable.'
              : evaluation.data
                ? `Original verdict: ${evaluation.data.originalVerdict} · current standing: ${evaluation.data.currentStanding} · valid as of ${formatTimestamp(evaluation.data.validityAsOf)} · external revocation: ${evaluation.data.externalRevocation}`
                : 'Gate evaluation is unavailable.'}
        </div>
      )}
    </section>
  );
}

function RunDetail({
  projectSlug,
  runId,
}: {
  projectSlug: string;
  runId: string;
}) {
  const { data, isLoading, error } = useFlowRunConsoleQuery(projectSlug, runId);

  if (isLoading) {
    // A run projection can legitimately sit loading for a while (gate/verify
    // work in flight). The indeterminate sweep (station#2651) is the "working,
    // not stalled" signal on top of the canonical Skeleton primitives.
    return (
      <div
        className="flow-run-console__loading indeterminate-sweep"
        role="status"
        aria-label="Loading run"
      >
        <Skeleton variant="line" className="flow-run-console__loading-line" />
        <Skeleton variant="line" className="flow-run-console__loading-line" />
        <Skeleton variant="line" className="flow-run-console__loading-line" />
      </div>
    );
  }
  if (error) {
    return (
      <p className="flow-run-console__error" role="alert">
        Run unavailable:{' '}
        {error instanceof Error ? error.message : String(error)}
      </p>
    );
  }
  if (!data) return null;

  return <RunDetailBody data={data} projectSlug={projectSlug} />;
}

function RunDetailBody({
  data,
  projectSlug,
}: {
  data: FlowRunConsoleVM;
  projectSlug: string;
}) {
  // The report path used to be copied silently — a swallowed `.catch` behind an
  // optional chain that could not even run on the origin with no clipboard
  // (station#3341). The path stays on screen either way; the button now says
  // which happened.
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>(
    'idle',
  );
  const copyResetRef = useRef<number | undefined>(undefined);
  useEffect(
    () => () => {
      if (copyResetRef.current !== undefined) {
        window.clearTimeout(copyResetRef.current);
      }
    },
    [],
  );
  const copyReportPath = async (path: string) => {
    const copied = await copyToClipboard(path);
    setCopyState(copied ? 'copied' : 'failed');
    if (copyResetRef.current !== undefined) {
      window.clearTimeout(copyResetRef.current);
    }
    copyResetRef.current = window.setTimeout(() => setCopyState('idle'), 1500);
  };
  const reportPath = isRetiredFlowDefinition(data.run.definition_id)
    ? null
    : (data.report?.path ?? null);
  const evidenceByStatus = data.evidence.reduce<Record<string, number>>(
    (counts, entry) => {
      const status = entry.status ?? 'recorded';
      counts[status] = (counts[status] ?? 0) + 1;
      return counts;
    },
    {},
  );

  return (
    <div className="flow-run-console__detail-body">
      <header className="flow-run-console__detail-header">
        <h3 className="flow-run-console__detail-title">
          {flowRunDisplayIdentity(data.run.definition_id, data.run.run_id)}
        </h3>
        <p className="flow-run-console__detail-sub">
          {flowRunDisplayIdentity(data.run.definition_id)} v
          {data.run.definition_version} ·{' '}
          <Badge
            value={data.run.status ?? 'unknown'}
            tone={flowRunStatusTone(data.run.status)}
            className="flow-run-console__status"
          />{' '}
          · step: {data.current_step ?? 'done'} · updated{' '}
          {formatTimestamp(data.run.updated_at)}
        </p>
        {data.next_action && (
          <p className="flow-run-console__next-action">
            Next: {data.next_action}
          </p>
        )}
      </header>

      <section aria-label="Gates" className="panel flow-run-console__section">
        <h4 className="flow-run-console__section-title">Gates</h4>
        {data.gates.length === 0 && (
          <Empty
            label="This definition has no gates."
            className="flow-run-console__hint"
          />
        )}
        {data.gates.map((gate) => (
          <GateCard key={gate.id} gate={gate} projectSlug={projectSlug} />
        ))}
      </section>

      {data.exceptions.length > 0 && (
        <section
          aria-label="Exceptions"
          className="panel flow-run-console__section"
        >
          <h4 className="flow-run-console__section-title">Exceptions</h4>
          <ul className="flow-run-console__list">
            {data.exceptions.map((exception) => (
              <li key={exception.id} className="flow-run-console__list-row">
                <span>
                  {exception.gate_id ?? 'run'} —{' '}
                  {exception.reason ?? 'no reason recorded'}
                </span>
                <span className="flow-run-console__evidence-meta">
                  authority: {exception.authority ?? 'unknown'} ·{' '}
                  {formatTimestamp(exception.accepted_at)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {data.route_backs.length > 0 && (
        <section
          aria-label="Route-backs"
          className="panel flow-run-console__section"
        >
          <h4 className="flow-run-console__section-title">Route-backs</h4>
          <ul className="flow-run-console__list">
            {data.route_backs.map((routeBack) => (
              <li key={routeBack.id} className="flow-run-console__list-row">
                <span>
                  {routeBack.gate_id ?? 'run'} →{' '}
                  {routeBack.route_back_to ?? 'unknown step'}
                  {routeBack.reason ? ` (${routeBack.reason})` : ''}
                </span>
                <span className="flow-run-console__evidence-meta">
                  {routeBack.attempt != null && routeBack.max_attempts != null
                    ? `attempt ${routeBack.attempt} of ${routeBack.max_attempts}`
                    : ''}
                  {routeBack.limit_exceeded
                    ? ` · budget exhausted${routeBack.recovery_step ? ` → ${routeBack.recovery_step}` : ''}`
                    : ''}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section
        aria-label="Evidence"
        className="panel flow-run-console__section"
      >
        <h4 className="flow-run-console__section-title">
          Evidence ({data.evidence.length})
        </h4>
        {data.evidence.length === 0 && (
          <Empty
            label="No evidence attached yet."
            className="flow-run-console__hint"
          />
        )}
        {data.evidence.length > 0 && (
          <div className="flow-run-console__metrics">
            {Object.entries(evidenceByStatus).map(([status, count]) => (
              <Metric
                key={status}
                label={status}
                value={count}
                className="flow-run-console__metric"
              />
            ))}
          </div>
        )}
        <ul className="flow-run-console__list">
          {data.evidence.map((entry) => (
            <li key={entry.id} className="flow-run-console__list-row">
              <span>{formatClaimTypes(entry)}</span>
              <span className="flow-run-console__evidence-meta">
                gate: {entry.gate_id ?? '—'} · producer: {entry.producer ?? '—'}{' '}
                · {entry.status ?? 'recorded'}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {reportPath && (
        <section
          aria-label="Report"
          className="panel flow-run-console__section"
        >
          <h4 className="flow-run-console__section-title">Report</h4>
          <div className="flow-gate-card__report">
            <span className="flow-gate-card__report-path">{reportPath}</span>
            <button
              type="button"
              className={`flow-gate-card__copy-btn${
                copyState === 'failed' ? ' copy-affordance--failed' : ''
              }`}
              aria-label="Copy report path"
              title={
                copyState === 'failed'
                  ? 'This browser refused clipboard access — select the path to copy it manually.'
                  : undefined
              }
              onClick={() => {
                void copyReportPath(reportPath);
              }}
            >
              {copyState === 'copied'
                ? 'Copied'
                : copyState === 'failed'
                  ? "Can't copy"
                  : 'Copy path'}
            </button>
            {/* The button's own name is fixed, so its label change is never
                announced; this sibling carries the outcome. */}
            <span role="status" className="copy-status-sr">
              {copyState === 'copied'
                ? 'Report path copied.'
                : copyState === 'failed'
                  ? 'This browser refused clipboard access. The report path was not copied.'
                  : ''}
            </span>
          </div>
        </section>
      )}
    </div>
  );
}

export interface FlowRunConsoleProps {
  /**
   * Overrides `navigation.selectedProject` — the deterministic
   * `/projects/:slug/flow-console` route (station#612) passes this
   * explicitly so the console works outside a project layout tab.
   */
  projectSlug?: string;
  /**
   * `?run=` deep-link target. The attention inbox's gate items
   * (route-back/blocked/exception-pending) land here with the owning run
   * preselected instead of whatever run happens to sort first.
   */
  initialRunId?: string;
}

export function FlowRunConsole({
  projectSlug: projectSlugProp,
  initialRunId,
}: FlowRunConsoleProps = {}) {
  const navigation = useNavigation() as unknown as {
    selectedProject?: string | null;
  };
  const projectSlug = projectSlugProp ?? navigation.selectedProject ?? null;
  const [selectedRunId, setSelectedRunId] = useState<string | null>(
    initialRunId ?? null,
  );

  const {
    data: runs,
    isLoading,
    error,
  } = useFlowRunsQuery(projectSlug ?? undefined);

  const sortedRuns = useMemo(
    () =>
      [...(runs ?? [])].sort((a, b) =>
        (b.updated_at ?? '').localeCompare(a.updated_at ?? ''),
      ),
    [runs],
  );
  const activeRunId =
    selectedRunId && sortedRuns.some((run) => run.run_id === selectedRunId)
      ? selectedRunId
      : (sortedRuns[0]?.run_id ?? null);

  if (!projectSlug) {
    return (
      <div className="flow-run-console flow-run-console--empty">
        <Empty
          label="Open this console inside a project to see its Flow runs."
          className="flow-run-console__hint"
        />
      </div>
    );
  }

  return (
    <div className="flow-run-console">
      <aside className="flow-run-console__sidebar" aria-label="Flow runs">
        <h2 className="flow-run-console__sidebar-title">Flow runs</h2>
        {isLoading && (
          <div className="indeterminate-sweep">
            <SkeletonList count={3} withIcon={false} label="Loading runs" />
          </div>
        )}
        {!isLoading && error && (
          <p className="flow-run-console__error" role="alert">
            Flow runs unavailable:{' '}
            {error instanceof Error ? error.message : String(error)}
          </p>
        )}
        {!isLoading && !error && sortedRuns.length === 0 && (
          <p className="flow-run-console__hint">
            No Flow runs yet. Gated sessions and <code>flow start</code> runs in
            this project workspace will appear here.
          </p>
        )}
        <ul className="flow-run-console__runs">
          {sortedRuns.map((run) => (
            <RunListItem
              key={run.run_id}
              run={run}
              active={run.run_id === activeRunId}
              onSelect={setSelectedRunId}
            />
          ))}
        </ul>
      </aside>
      {/* `section`, not `main`: this renders inside the shell's `#station-main`
          landmark, and a nested second `main` makes the landmark list
          ambiguous. */}
      <section className="flow-run-console__detail">
        {activeRunId ? (
          <RunDetail projectSlug={projectSlug} runId={activeRunId} />
        ) : (
          <Empty
            label="Select a run to inspect."
            className="flow-run-console__hint"
          />
        )}
      </section>
    </div>
  );
}
