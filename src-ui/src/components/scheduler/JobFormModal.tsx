import type {
  SchedulerJob,
  SchedulerSchedule,
} from '@kontourai/station-contracts/scheduler';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAgentCatalogRead, useAgents } from '../../contexts/AgentsContext';
import type { SchedulerProviderInfo } from '../../hooks/useScheduler';
import { useAddJob, useEditJob } from '../../hooks/useScheduler';
import { errorText } from '../../utils/errorText';
import { Button } from '../Button';
import { Dialog } from '../Dialog';
import { SkeletonList } from '../state';
import { Toggle } from '../Toggle';
import { AgentPicker } from './AgentPicker';
import { CronPreview } from './CronEditor';
import { ScheduleModeEditor } from './ScheduleModeEditor';
import {
  SCHEDULER_ENGINE_AGENT_NOTE,
  schedulerAgentOptions,
  schedulerAgentRunnability,
} from './schedulerAgentOptions';
import {
  browserTimeZone,
  datetimeLocalValue,
  type ExactIntervalUnit,
  intervalToMs,
  scheduleEquals,
  scheduleForJob,
  splitEveryMs,
  WEEKDAY_MORNING_CRON,
  weekdayMorningSchedule,
} from './scheduleValue';

/**
 * The one catalog-failure message both Agent fields describe themselves by
 * (#1536 S1). Named here so the element and every reference to it move
 * together — a hardcoded id in the picker is how the monitor branch ended up
 * pointing at something that was not rendered.
 */
const AGENT_CATALOG_ERROR_ID = 'schedule-agent-catalog-error';

export function JobFormModal({
  job,
  prefill,
  onClose,
  providers = [],
}: {
  job?: SchedulerJob;
  prefill?: Partial<{
    name: string;
    cron: string;
    schedule?: SchedulerSchedule;
    prompt: string;
    agent: string;
  }>;
  onClose: () => void;
  providers?: SchedulerProviderInfo[];
}) {
  const isEdit = !!job;
  const addJob = useAddJob();
  const editJob = useEditJob();
  const [selectedProvider, setSelectedProvider] = useState(
    job?.provider || providers[0]?.id || 'built-in',
  );
  const activeProvider = providers.find((p) => p.id === selectedProvider);
  const extraFields: SchedulerProviderInfo['formFields'] =
    activeProvider?.formFields || [];
  const init = prefill || {};
  const agents = useAgents();
  const {
    loaded: agentsLoaded,
    settled: agentsSettled,
    failed: agentsFailed,
    retrying: agentsRetrying,
    retry: retryAgents,
  } = useAgentCatalogRead();
  const agentOptions = useMemo(() => schedulerAgentOptions(agents), [agents]);
  // Weekdays 8:00 AM, not `* * * * *`. A default nobody reads must be the
  // schedule a reasonable person would have chosen, not the one that runs
  // every minute of every day.
  const initialSchedule: SchedulerSchedule = job
    ? scheduleForJob(job)
    : (init.schedule ??
      (init.cron
        ? { kind: 'cron', expr: init.cron }
        : weekdayMorningSchedule()));
  const initialInterval = splitEveryMs(
    initialSchedule.kind === 'every' ? initialSchedule.everyMs : 60_000,
  );

  const [form, setForm] = useState<{
    name: string;
    scheduleKind: SchedulerSchedule['kind'];
    cron: string;
    everyValue: number;
    everyUnit: ExactIntervalUnit;
    atTime: string;
    deleteAfterRun: boolean;
    prompt: string;
    agent: string;
    retryCount: number;
    retryDelaySecs: number;
    monitorTarget: string;
    monitorProjectId: string;
    monitorAgentId: string;
    monitorCredentialBinding: string;
    monitorType: 'none' | 'github-pull-request';
    monitorMaxTurns: number;
    monitorMaxTokens: number;
    monitorMaxRuntimeMs: number;
    [key: string]: string | number | boolean;
  }>({
    name: job?.name || init.name || '',
    scheduleKind: initialSchedule.kind,
    cron:
      initialSchedule.kind === 'cron'
        ? initialSchedule.expr
        : WEEKDAY_MORNING_CRON,
    everyValue: initialInterval.value,
    everyUnit: initialInterval.unit,
    atTime:
      initialSchedule.kind === 'at'
        ? datetimeLocalValue(initialSchedule.timeMs)
        : datetimeLocalValue(Date.now() + 60 * 60_000),
    deleteAfterRun:
      initialSchedule.kind === 'at'
        ? (initialSchedule.deleteAfterRun ?? true)
        : true,
    prompt: job?.prompt || init.prompt || '',
    agent: job?.agent || init.agent || agentOptions.defaultSlug || 'station',
    retryCount: job?.retryCount ?? 0,
    retryDelaySecs: job?.retryDelaySecs ?? 60,
    monitorTarget:
      job?.monitor?.kind === 'github-pull-request' ? job.monitor.target : '',
    monitorProjectId:
      job?.monitor?.kind === 'github-pull-request'
        ? (job.monitor.projectId ?? '')
        : '',
    monitorAgentId:
      job?.monitor?.kind === 'github-pull-request'
        ? job.monitor.agentId
        : job?.agent || '',
    monitorCredentialBinding:
      job?.monitor?.kind === 'github-pull-request'
        ? (job.monitor.credentialSecretBinding ?? '')
        : '',
    monitorType:
      job?.monitor?.kind === 'github-pull-request'
        ? 'github-pull-request'
        : 'none',
    monitorMaxTurns: job?.monitor?.budget?.maxTurns ?? 1,
    monitorMaxTokens: job?.monitor?.budget?.maxTokens ?? 100_000,
    monitorMaxRuntimeMs: job?.monitor?.budget?.maxRuntimeMs ?? 600_000,
    ...Object.fromEntries(extraFields.map((f) => [f.key, job?.[f.key] || ''])),
  });
  const [cronInput, setCronInput] = useState(form.cron);
  // #1536 D1/D8: the zone the form's expression is written in — an edited job's
  // own, or (for a new one) the default schedule's, which is the reader's. The
  // preview and the field label both read it, so what the form SAYS and what it
  // will SUBMIT cannot disagree.
  //
  // #1536 R4/S2, stated as the three cases it actually decides — it is keyed on
  // what the form OPENED with, not on the tab currently selected:
  //   - opened on a zoned cron        → that cron keeps its own zone;
  //   - opened on a legacy UNZONED cron → stays UTC, because changing an
  //     existing job's meaning is not this field's business;
  //   - opened on anything else (`every`/`at`, or a new job) → the reader's
  //     zone, so a cron the Calendar tab mints is not silently zoneless. That
  //     last case is the fix: reading `initialSchedule.timezone` alone left such
  //     an expression with no zone, so an hour the reader typed as local was
  //     saved, previewed and labelled as UTC.
  const cronTimezone =
    initialSchedule.kind === 'cron'
      ? initialSchedule.timezone
      : browserTimeZone();

  // The catalog can arrive after this form mounts, so the runnable default
  // cannot be settled at first render alone. Correct it once the catalog has
  // answered, and never after the person has chosen: an auto-correction that
  // overrides a deliberate pick is worse than a bad default.
  const agentPickedRef = useRef(false);
  useEffect(() => {
    if (isEdit || init.agent || agentPickedRef.current || !agentsLoaded) return;
    const runnableDefault = agentOptions.defaultSlug;
    if (!runnableDefault) return;
    setForm((current) =>
      schedulerAgentRunnability(agents, current.agent).runnable
        ? current
        : { ...current, agent: runnableDefault },
    );
  }, [agents, agentOptions.defaultSlug, agentsLoaded, init.agent, isEdit]);

  const jobAgentRunnability = schedulerAgentRunnability(agents, form.agent);
  const monitorAgentRunnability = schedulerAgentRunnability(
    agents,
    form.monitorAgentId,
  );
  const namedAgentRunnability =
    form.monitorType === 'none' ? jobAgentRunnability : monitorAgentRunnability;
  // #1536 H1-2: `useAgents()` is `[]` while the catalog is arriving AND when it
  // failed, so every runnability answer above is "no Agent named that" until it
  // has actually answered. Reporting that as the Agent's own fault — and
  // refusing to submit on it — blamed a missing Agent for a read that had not
  // happened, permanently once the read had failed. Nothing derived from an
  // unanswered catalog may reach the reader.
  const agentRunnabilityKnown = agentsLoaded;

  const scheduleFromForm = (): SchedulerSchedule => {
    if (form.scheduleKind === 'every') {
      return {
        kind: 'every',
        everyMs: intervalToMs(form.everyValue, form.everyUnit),
      };
    }
    if (form.scheduleKind === 'at') {
      const timeMs =
        initialSchedule.kind === 'at' &&
        form.atTime === datetimeLocalValue(initialSchedule.timeMs)
          ? initialSchedule.timeMs
          : new Date(form.atTime).getTime();
      return {
        kind: 'at',
        timeMs,
        deleteAfterRun: form.deleteAfterRun,
      };
    }
    // The zone travels with the expression: a local weekday rule has no
    // correct fixed-UTC spelling (#1536 L1). An edited job keeps whatever zone
    // it was created with; a new one inherits the default schedule's, which is
    // the reader's own.
    return {
      kind: 'cron',
      expr: form.cron,
      ...(cronTimezone ? { timezone: cronTimezone } : {}),
    };
  };

  useEffect(() => {
    const t = setTimeout(() => setCronInput(form.cron), 400);
    return () => clearTimeout(t);
  }, [form.cron]);

  const set =
    (field: string) =>
    (
      e: React.ChangeEvent<
        HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
      >,
    ) =>
      setForm((f) => ({
        ...f,
        [field]: e.target.value,
      }));

  const handleSubmit = () => {
    const nextSchedule = scheduleFromForm();
    const monitor =
      form.monitorType === 'github-pull-request'
        ? {
            kind: 'github-pull-request' as const,
            objective: 'review-ready' as const,
            target: form.monitorTarget.trim(),
            projectId: form.monitorProjectId.trim(),
            agentId: form.monitorAgentId.trim(),
            ...(form.monitorCredentialBinding.trim()
              ? {
                  credentialSecretBinding: form.monitorCredentialBinding.trim(),
                }
              : {}),
            budget: {
              maxTurns: form.monitorMaxTurns,
              maxTokens: form.monitorMaxTokens,
              maxRuntimeMs: form.monitorMaxRuntimeMs,
            },
          }
        : undefined;
    if (isEdit) {
      const opts: Record<string, unknown> = {};
      if (!scheduleEquals(nextSchedule, initialSchedule)) {
        opts.schedule = nextSchedule;
      }
      if (form.prompt !== (job.prompt || '')) opts.prompt = form.prompt;
      if (form.monitorType === 'none' && form.agent !== (job.agent || ''))
        opts.agent = form.agent;
      if (form.retryCount !== (job.retryCount ?? 0))
        opts.retryCount = form.retryCount;
      if (form.retryDelaySecs !== (job.retryDelaySecs ?? 60))
        opts.retryDelaySecs = form.retryDelaySecs;
      const previous = job.monitor;
      const monitorChanged =
        (previous?.kind === 'github-pull-request') !==
          (form.monitorType === 'github-pull-request') ||
        (form.monitorType === 'github-pull-request' &&
          (form.monitorTarget.trim() !== previous?.target ||
            form.monitorProjectId.trim() !== (previous?.projectId ?? '') ||
            form.monitorAgentId.trim() !== (previous?.agentId ?? '') ||
            form.monitorCredentialBinding.trim() !==
              (previous?.credentialSecretBinding ?? '') ||
            form.monitorMaxTurns !== (previous?.budget?.maxTurns ?? 1) ||
            form.monitorMaxTokens !==
              (previous?.budget?.maxTokens ?? 100_000) ||
            form.monitorMaxRuntimeMs !==
              (previous?.budget?.maxRuntimeMs ?? 600_000)));
      if (monitorChanged) opts.monitor = monitor ?? null;
      for (const f of extraFields) {
        if (form[f.key] !== (job[f.key] || ''))
          opts[f.key] = form[f.key] as string | number;
      }
      editJob.mutate({ target: job.name, ...opts }, { onSuccess: onClose });
    } else {
      if (!form.name.trim()) return;
      addJob.mutate(
        {
          name: form.name,
          provider: selectedProvider,
          // #1536 L1: a bare `cron` string cannot carry a timezone, so sending
          // one silently dropped the zone the expression depends on. The
          // `schedule` shape carries both and the server accepts either.
          ...(nextSchedule.kind === 'cron' && !nextSchedule.timezone
            ? { cron: nextSchedule.expr }
            : { schedule: nextSchedule }),
          prompt: form.prompt,
          ...(form.monitorType === 'none'
            ? { agent: form.agent || undefined }
            : {}),
          retryCount: form.retryCount || undefined,
          retryDelaySecs: form.retryCount ? form.retryDelaySecs : undefined,
          monitor,
          ...Object.fromEntries(
            extraFields
              .map((f) => [f.key, form[f.key] || undefined])
              .filter(([, v]) => v),
          ),
        },
        { onSuccess: onClose },
      );
    }
  };

  const pending = addJob.isPending || editJob.isPending;
  const mutationError = addJob.error ?? editJob.error;
  const scheduleValid =
    form.scheduleKind === 'cron'
      ? form.cron.trim().length > 0
      : form.scheduleKind === 'every'
        ? Number.isFinite(form.everyValue) && form.everyValue > 0
        : Number.isFinite(new Date(form.atTime).getTime());
  const monitorValid =
    form.monitorType === 'none' ||
    (form.monitorTarget.trim().length > 0 &&
      form.monitorProjectId.trim().length > 0 &&
      form.monitorAgentId.trim().length > 0 &&
      form.monitorMaxTurns >= 1 &&
      form.monitorMaxTokens >= 1 &&
      form.monitorMaxRuntimeMs >= 1);

  return (
    <Dialog
      eyebrow="Schedule"
      title={isEdit ? `Edit: ${job.name}` : 'Add Job'}
      closeLabel="Close job editor"
      onClose={onClose}
      size="lg"
      panelClassName="schedule__modal"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleSubmit}
            pending={pending}
            pendingLabel="Saving…"
            disabled={
              !scheduleValid ||
              !monitorValid ||
              // A new job is refused while it names an Agent that cannot run
              // it, or has no instructions: both produce a job whose first
              // run fails. An EDIT is deliberately still saveable — an
              // existing job whose Agent went unrunnable must stay
              // reschedulable and repointable.
              //
              // The runnability half waits for the catalog to answer: an
              // unanswered catalog cannot refuse anything (#1536 H1-2).
              (!isEdit &&
                (!form.name.trim() ||
                  !form.prompt.trim() ||
                  (agentRunnabilityKnown && !namedAgentRunnability.runnable)))
            }
          >
            {isEdit ? 'Save Changes' : 'Add Job'}
          </Button>
        </>
      }
    >
      <div className="schedule__modal-body">
        {mutationError && (
          <div role="alert" className="schedule__field-error">
            {errorText(mutationError)}
          </div>
        )}
        {!isEdit && providers.length > 1 && (
          <label className="schedule__field">
            <span className="schedule__field-label">Run with</span>
            <select
              value={selectedProvider}
              onChange={(e) => setSelectedProvider(e.target.value)}
            >
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName}
                </option>
              ))}
            </select>
          </label>
        )}
        {!isEdit && (
          <label className="schedule__field">
            <span className="schedule__field-label">Name</span>
            <input
              value={form.name}
              onChange={set('name')}
              placeholder="my-daily-briefing"
            />
            {form.name && !/^[a-z0-9-]+$/.test(form.name) && (
              <span className="schedule__field-error">
                Lowercase letters, numbers, and hyphens only
              </span>
            )}
          </label>
        )}
        {/* #1536 S1: the catalog READ's state is one fact about one catalog, so
            it is stated once — above whichever Agent field this form is
            showing. It used to live inside the non-monitor branch only, which
            left a monitor job with no account of a failed read at all AND a
            trigger describing itself by an id that was not on the page.
            The loading vocabulary names the wait in the skeleton's `label`; a
            new sentence is the eleven-treatments problem SHELL-13 removed, and
            `check-prepush-static-gates` refuses it. */}
        {!agentsSettled && <SkeletonList count={1} label="Loading agents" />}
        {agentsFailed && (
          <span className="schedule__field-error" id={AGENT_CATALOG_ERROR_ID}>
            Station could not load the Agent catalog.{' '}
            {/* #1536 D7: a retry that looks idle while it is in flight invites a
                second click at the one moment a second request helps least. */}
            <button
              type="button"
              className="schedule__field-retry"
              onClick={retryAgents}
              disabled={agentsRetrying}
            >
              {agentsRetrying ? 'Trying…' : 'Try again'}
            </button>
          </span>
        )}
        {form.monitorType === 'none' && (
          <div className="schedule__field">
            <span className="schedule__field-label">Agent</span>
            <AgentPicker
              value={form.agent}
              catalogErrorId={agentsFailed ? AGENT_CATALOG_ERROR_ID : undefined}
              onChange={(v) => {
                agentPickedRef.current = true;
                setForm((f) => ({ ...f, agent: v }));
              }}
            />
            {agentRunnabilityKnown && !jobAgentRunnability.runnable && (
              <span className="schedule__field-error">
                {jobAgentRunnability.reason}
              </span>
            )}
            {agentOptions.excludedEngineAgents.length > 0 && (
              <span className="schedule__field-hint">
                {SCHEDULER_ENGINE_AGENT_NOTE}
              </span>
            )}
          </div>
        )}
        <label className="schedule__field">
          <span className="schedule__field-label">Instructions</span>
          <textarea
            value={form.prompt}
            onChange={set('prompt')}
            rows={3}
            placeholder="What should the agent do?"
          />
        </label>
        {form.monitorType === 'github-pull-request' && (
          <>
            <div className="schedule__field">
              <span className="schedule__field-label">Monitor Agent</span>
              <AgentPicker
                value={form.monitorAgentId}
                catalogErrorId={
                  agentsFailed ? AGENT_CATALOG_ERROR_ID : undefined
                }
                onChange={(value) =>
                  setForm((current) => ({ ...current, monitorAgentId: value }))
                }
              />
              {agentRunnabilityKnown &&
                form.monitorAgentId.trim().length > 0 &&
                !monitorAgentRunnability.runnable && (
                  <span className="schedule__field-error">
                    {monitorAgentRunnability.reason}
                  </span>
                )}
            </div>
            <label className="schedule__field">
              <span className="schedule__field-label">
                Credential binding (optional)
              </span>
              <input
                value={form.monitorCredentialBinding}
                onChange={set('monitorCredentialBinding')}
                placeholder="github-token-binding"
              />
              <span className="schedule__field-hint">
                Leave blank for GitHub public data.
              </span>
            </label>
            {(
              [
                ['monitorMaxTurns', 'Maximum turns', 20],
                ['monitorMaxTokens', 'Maximum tokens', 1_000_000],
                ['monitorMaxRuntimeMs', 'Maximum runtime (ms)', 7_200_000],
              ] as const
            ).map(([field, label, max]) => (
              <label key={field} className="schedule__field">
                <span className="schedule__field-label">{label}</span>
                <input
                  type="number"
                  min={1}
                  max={max}
                  value={form[field]}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      [field]: Number(event.target.value),
                    }))
                  }
                />
              </label>
            ))}
          </>
        )}
        <label className="schedule__field">
          <span className="schedule__field-label">Monitor type</span>
          <select
            value={form.monitorType}
            onChange={(event) =>
              setForm((current) => {
                const monitorType = event.target.value as
                  | 'none'
                  | 'github-pull-request';
                // A disabled panel is not a secret-value cache. Clearing
                // all hidden fields makes a later enable an intentional
                // reconfiguration, never a revival of stale authority.
                return monitorType === 'none'
                  ? {
                      ...current,
                      monitorType,
                      monitorTarget: '',
                      monitorProjectId: '',
                      monitorAgentId: '',
                      monitorCredentialBinding: '',
                    }
                  : { ...current, monitorType };
              })
            }
          >
            <option value="none">None</option>
            <option value="github-pull-request">GitHub pull request</option>
          </select>
        </label>
        {form.monitorType === 'github-pull-request' && (
          <label className="schedule__field">
            <span className="schedule__field-label">
              Project for actionable revisions
            </span>
            <input
              value={form.monitorProjectId}
              onChange={set('monitorProjectId')}
              placeholder="project-id"
            />
            <span className="schedule__field-hint">
              When set, an actionable revision adopts one deterministic project
              Task instead of starting a scheduler turn.
            </span>
          </label>
        )}
        {form.monitorType === 'github-pull-request' && (
          <label className="schedule__field">
            <span className="schedule__field-label">
              GitHub pull request monitor
            </span>
            <input
              value={form.monitorTarget}
              onChange={set('monitorTarget')}
              placeholder="https://github.com/owner/repository/pull/123"
            />
            <span className="schedule__field-hint">
              A bounded probe runs first; unchanged or pending pull requests do
              not start an agent turn.
            </span>
          </label>
        )}
        <div className="schedule__form-divider" />
        <div className="schedule__field">
          {/* `id` retired: it was declared and never referenced — a label
              nothing consumed. The mode fieldset below names itself
              ("Schedule model"), which is the right name for a tab group and
              not this field's. */}
          <span className="schedule__field-label">
            Schedule
            {form.scheduleKind === 'cron' && (
              // #1536 D8: a calendar time is meaningless without its zone, and
              // this is the zone the job will actually be evaluated in.
              //
              // #1536 R6/R7: ONE zone vocabulary in the panel's text — the IANA
              // name, here and in the human sentence below, because that is what
              // the schedule actually carries and what an operator would type.
              // The short abbreviation appears only in the instant list, where
              // it labels a moment in the reader's own zone. And it is NAMED:
              // read on its own, "· America/Denver" says nothing about what it
              // qualifies, so it carries its own label rather than leaning on
              // the visual adjacency.
              <span className="schedule__field-hint">
                {' '}
                <span className="sr-only">
                  — evaluated in {cronTimezone ?? 'UTC'}
                </span>
                <span aria-hidden="true">· {cronTimezone ?? 'UTC'}</span>
              </span>
            )}
          </span>
          <fieldset
            className="schedule-mode-editor__tabs"
            aria-label="Schedule model"
          >
            {(
              [
                ['cron', 'Calendar'],
                ['every', 'Exact interval'],
                ['at', 'One time'],
              ] as const
            ).map(([kind, label]) => (
              <button
                key={kind}
                type="button"
                className="schedule-mode-editor__tab"
                aria-pressed={form.scheduleKind === kind}
                onClick={() =>
                  setForm((current) => ({
                    ...current,
                    scheduleKind: kind,
                  }))
                }
              >
                {label}
              </button>
            ))}
          </fieldset>
          {form.scheduleKind === 'cron' && (
            <>
              <ScheduleModeEditor
                value={form.cron}
                onChange={(v) => setForm((f) => ({ ...f, cron: v }))}
              />
              <CronPreview
                schedule={{
                  kind: 'cron',
                  expr: cronInput,
                  ...(cronTimezone ? { timezone: cronTimezone } : {}),
                }}
              />
            </>
          )}
          {form.scheduleKind === 'every' && (
            <label className="schedule-mode-editor__time-row">
              <span>Repeat every</span>
              <input
                aria-label="Interval value"
                type="number"
                min={1}
                value={form.everyValue}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    everyValue: Number(event.target.value),
                  }))
                }
              />
              <select
                aria-label="Interval unit"
                value={form.everyUnit}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    everyUnit: event.target.value as ExactIntervalUnit,
                  }))
                }
              >
                <option value="seconds">seconds</option>
                <option value="minutes">minutes</option>
                <option value="hours">hours</option>
                <option value="days">days</option>
              </select>
            </label>
          )}
          {form.scheduleKind === 'at' && (
            <>
              <label className="schedule-mode-editor__time-row">
                <span>Run once at</span>
                <input
                  aria-label="Run once at"
                  type="datetime-local"
                  value={form.atTime}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      atTime: event.target.value,
                    }))
                  }
                />
              </label>
              <label className="schedule-mode-editor__time-row">
                <input
                  type="checkbox"
                  checked={form.deleteAfterRun}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      deleteAfterRun: event.target.checked,
                    }))
                  }
                />
                <span>Delete the job after it runs</span>
              </label>
            </>
          )}
        </div>
        <label className="schedule__field">
          <span className="schedule__field-label">Retries</span>
          <input
            type="number"
            min={0}
            max={10}
            value={form.retryCount}
            onChange={(e) =>
              setForm((f) => ({
                ...f,
                retryCount: Number(e.target.value) || 0,
              }))
            }
          />
        </label>
        {form.retryCount > 0 && (
          <label className="schedule__field">
            <span className="schedule__field-label">Retry delay (s)</span>
            <input
              type="number"
              min={0}
              max={3600}
              value={form.retryDelaySecs}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  retryDelaySecs: Number(e.target.value) || 0,
                }))
              }
            />
          </label>
        )}
        {extraFields.length > 0 && <div className="schedule__form-divider" />}
        {/* A Toggle renders a role="switch" button, which a <label> cannot
            label; that branch is a plain container and names the switch
            directly. The input/textarea branches keep the real
            label-wraps-control association. */}
        {extraFields.map((f) =>
          f.type === 'boolean' ? (
            <div key={f.key} className="schedule__field">
              <span className="schedule__field-label">
                {f.label}{' '}
                {f.hint && (
                  <span className="schedule__field-hint">({f.hint})</span>
                )}
              </span>
              <Toggle
                checked={!!form[f.key]}
                onChange={(v) =>
                  setForm((prev) => ({
                    ...prev,
                    [f.key]: v,
                  }))
                }
                label={f.label}
                size="sm"
              />
            </div>
          ) : (
            <label
              key={f.key}
              htmlFor={`job-field-${f.key}`}
              className="schedule__field"
            >
              <span className="schedule__field-label">
                {f.label}{' '}
                {f.hint && (
                  <span className="schedule__field-hint">({f.hint})</span>
                )}
              </span>
              {f.type === 'textarea' ? (
                <textarea
                  id={`job-field-${f.key}`}
                  value={(form[f.key] as string) || ''}
                  onChange={set(f.key)}
                  rows={3}
                  placeholder={f.placeholder}
                />
              ) : (
                <input
                  id={`job-field-${f.key}`}
                  value={(form[f.key] as string) || ''}
                  onChange={set(f.key)}
                  placeholder={f.placeholder}
                />
              )}
            </label>
          ),
        )}
      </div>
    </Dialog>
  );
}
