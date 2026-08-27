import type { FormEvent } from 'react';
import { errorText, type RunSummary } from './api';

export function LaunchCard({
  pending,
  sourcePath,
  taskPath,
  setSourcePath,
  setTaskPath,
  submit,
}: {
  pending: boolean;
  sourcePath: string;
  taskPath: string;
  setSourcePath: (value: string) => void;
  setTaskPath: (value: string) => void;
  submit: (event: FormEvent) => void;
}) {
  return (
    <section
      className="fieldwork-review__card"
      aria-labelledby="fieldwork-launch-title"
    >
      <h3 id="fieldwork-launch-title">Launch a run</h3>
      <form className="fieldwork-review__form" onSubmit={submit}>
        <label htmlFor="fieldwork-task-path">
          Task file
          <input
            id="fieldwork-task-path"
            data-testid="fieldwork-task-path"
            value={taskPath}
            onChange={(event) => setTaskPath(event.target.value)}
            required
            spellCheck={false}
          />
        </label>
        <label htmlFor="fieldwork-source-path">
          Source file <span>(optional)</span>
          <input
            id="fieldwork-source-path"
            data-testid="fieldwork-source-path"
            value={sourcePath}
            onChange={(event) => setSourcePath(event.target.value)}
            spellCheck={false}
          />
        </label>
        <button type="submit" data-testid="fieldwork-launch" disabled={pending}>
          {pending ? 'Launching…' : 'Launch Fieldwork'}
        </button>
      </form>
    </section>
  );
}

function RunList({
  runs,
  selectedRunId,
  selectRun,
}: {
  runs: RunSummary[] | undefined;
  selectedRunId: string | null;
  selectRun: (runId: string) => void;
}) {
  return (
    <ul className="fieldwork-review__run-list">
      {runs?.map((run) => (
        <li key={run.id}>
          <button
            type="button"
            className={
              run.id === selectedRunId
                ? 'fieldwork-review__run fieldwork-review__run--selected'
                : 'fieldwork-review__run'
            }
            onClick={() => selectRun(run.id)}
            aria-pressed={run.id === selectedRunId}
          >
            <span>
              {run.proposalCount} proposal{run.proposalCount === 1 ? '' : 's'}
            </span>
            <small>{new Date(run.createdAt).toLocaleString()}</small>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function RunsCard({
  loading,
  refresh,
  runs,
  selectedRunId,
  selectRun,
}: {
  loading: boolean;
  refresh: () => void;
  runs: RunSummary[] | undefined;
  selectedRunId: string | null;
  selectRun: (runId: string) => void;
}) {
  return (
    <aside
      className="fieldwork-review__card fieldwork-review__runs"
      aria-labelledby="fieldwork-runs-title"
    >
      <div className="fieldwork-review__section-heading">
        <h3 id="fieldwork-runs-title">Recent runs</h3>
        <button
          type="button"
          className="fieldwork-review__text-button"
          onClick={refresh}
        >
          Refresh
        </button>
      </div>
      {loading ? <p>Loading runs…</p> : null}
      {!loading && runs?.length === 0 ? (
        <p className="fieldwork-review__muted">
          No runs yet. Task and source paths are resolved inside this project
          only.
        </p>
      ) : null}
      <RunList
        runs={runs}
        selectedRunId={selectedRunId}
        selectRun={selectRun}
      />
    </aside>
  );
}

function ReviewFrame({ reviewUrl }: { reviewUrl: string | null }) {
  return reviewUrl ? (
    <iframe
      className="fieldwork-review__frame"
      data-testid="fieldwork-review-frame"
      src={reviewUrl}
      title="Fieldwork review"
      sandbox="allow-same-origin allow-scripts"
      referrerPolicy="no-referrer"
    />
  ) : (
    <div
      className="fieldwork-review__frame-placeholder"
      data-testid="fieldwork-review-placeholder"
    >
      Open a run to load its capability-protected Fieldwork review application
      here.
    </div>
  );
}

export function ReviewCard({
  available,
  close,
  closePending,
  open,
  openPending,
  reviewUrl,
  selectedRun,
}: {
  available: boolean;
  close: () => void;
  closePending: boolean;
  open: () => void;
  openPending: boolean;
  reviewUrl: string | null;
  selectedRun: RunSummary | null;
}) {
  const status = !selectedRun
    ? 'Select a run to open its review surface.'
    : available
      ? 'Reviewed output is available.'
      : 'Reviewed output becomes available after Fieldwork review is complete.';
  return (
    <section
      className="fieldwork-review__card fieldwork-review__review"
      aria-labelledby="fieldwork-review-title"
    >
      <div className="fieldwork-review__section-heading">
        <div>
          <h3 id="fieldwork-review-title">Review surface</h3>
          <p className="fieldwork-review__muted">{status}</p>
        </div>
        {selectedRun ? (
          <div className="fieldwork-review__actions">
            <button type="button" onClick={open} disabled={openPending}>
              {openPending ? 'Opening…' : 'Open review'}
            </button>
            <button
              type="button"
              className="fieldwork-review__secondary"
              onClick={close}
              disabled={closePending || !selectedRun.open}
            >
              Close review
            </button>
          </div>
        ) : null}
      </div>
      <ReviewFrame reviewUrl={reviewUrl} />
    </section>
  );
}

export function Feedback({
  mutationError,
  notice,
  runsError,
}: {
  mutationError: unknown;
  notice: string | null;
  runsError: unknown;
}) {
  return (
    <>
      {notice ? (
        <p className="fieldwork-review__notice" role="status">
          {notice}
        </p>
      ) : null}
      {mutationError ? (
        <p className="fieldwork-review__error" role="alert">
          {errorText(mutationError)}
        </p>
      ) : null}
      {runsError ? (
        <p className="fieldwork-review__error" role="alert">
          {errorText(runsError)}
        </p>
      ) : null}
    </>
  );
}
