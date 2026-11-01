import { REPORT_GROUP_CONTINUATION_LIMITS } from '@kontourai/station-contracts/report-group';
import { useCreateReportGroup } from '@kontourai/station-sdk';
import {
  type ApiRequestScope,
  parseReportGroupInput,
} from '@kontourai/station-sdk/client';
import { randomCorrelationId } from '@kontourai/station-shared/random-id';
import { useState } from 'react';
import { Button } from '../components/Button';
import { useUnsavedGuard } from '../hooks/useUnsavedGuard';

export function ReportGroupCreateForm({
  scope,
}: {
  scope: ApiRequestScope & { isCurrent(): boolean };
}) {
  const create = useCreateReportGroup(scope);
  const [expanded, setExpanded] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [members, setMembers] = useState(1);
  const [flowEnabled, setFlowEnabled] = useState(false);
  const [continuationEnabled, setContinuationEnabled] = useState(false);
  const [operationId] = useState(() => randomCorrelationId());
  const [invalid, setInvalid] = useState(false);
  const { DiscardModal } = useUnsavedGuard(dirty && create.isIdle);
  const current = scope.isCurrent();
  return (
    <section aria-label="Run an advisory report group">
      <Button
        variant="secondary"
        disabled={expanded || !current}
        onClick={() => setExpanded(true)}
      >
        Run an advisory report group
      </Button>
      {expanded && (
        <form
          className="report-groups__form"
          onChange={() => setDirty(true)}
          onSubmit={(event) => {
            event.preventDefault();
            if (!current || !create.isIdle) return;
            const fields = new FormData(event.currentTarget);
            const text = (name: string) => String(fields.get(name) ?? '');
            let input: ReturnType<typeof parseReportGroupInput>;
            try {
              input = parseReportGroupInput({
                operationId,
                projectSlug: text('project'),
                ...(text('resource') ? { resourceId: text('resource') } : {}),
                ...(flowEnabled
                  ? {
                      flow: {
                        runId: text('flowRunId'),
                        steps: Object.fromEntries(
                          Array.from({ length: members }, (_, i) => [
                            text(`seat-${i}`),
                            text(`step-${i}`),
                          ]),
                        ),
                      },
                      ...(continuationEnabled
                        ? {
                            continuation: {
                              attemptsPerMember: Number(
                                text('attemptsPerMember'),
                              ),
                              maxRounds: Number(text('maxRounds')),
                              maxSyncs: Number(text('maxSyncs')),
                              maxRenewals: Number(text('maxRenewals')),
                              maxEvaluations: Number(text('maxEvaluations')),
                              maxRecoveries: Number(text('maxRecoveries')),
                            },
                          }
                        : {}),
                    }
                  : {}),
                deadlineAt: Date.now() + Number(text('minutes')) * 60_000,
                maxConcurrent: Number(text('concurrency')),
                budget: {
                  inputTokens: Number(text('inputTokens')),
                  outputTokens: Number(text('outputTokens')),
                  costMicros: Number(text('costMicros')),
                },
                members: Array.from({ length: members }, (_, i) => ({
                  seatId: text(`seat-${i}`),
                  agentId: text(`agent-${i}`),
                  brief: text(`brief-${i}`),
                  maxOutputTokens: Number(text(`output-${i}`)),
                })),
              });
            } catch {
              setInvalid(true);
              return;
            }
            setInvalid(false);
            setDirty(false);
            create.mutate(input);
          }}
        >
          <p>
            Run paid, unassessed reports with configured Agents and aggregate
            token and inference-cost limits.
          </p>
          <details>
            <summary>Source and outcomes</summary>
            <p>
              Each member receives its own brief and Project source. Members
              without Flow are independent advisory work.
            </p>
            <p>
              Closing stops waiting; it does not confirm physical termination or
              refunds.
            </p>
          </details>
          <p>
            Operation ID: <code>{operationId}</code>
          </p>
          <fieldset disabled={!current || !create.isIdle}>
            <legend>Source and limits</legend>
            <label className="field">
              Project ID
              <input
                className="control"
                name="project"
                required
                maxLength={128}
              />
            </label>
            <label className="field">
              Resource ID (optional)
              <input className="control" name="resource" maxLength={128} />
            </label>
            <label className="field">
              Deadline in minutes
              <input
                className="control"
                name="minutes"
                type="number"
                required
                min={1}
                max={5}
                defaultValue={5}
              />
            </label>
            <label className="field">
              Concurrent reports
              <input
                className="control"
                name="concurrency"
                type="number"
                required
                min={1}
                max={members}
                defaultValue={1}
              />
            </label>
            <label className="field">
              Aggregate input token limit
              <input
                className="control"
                name="inputTokens"
                type="number"
                required
                min={0}
                max={Number.MAX_SAFE_INTEGER}
              />
            </label>
            <label className="field">
              Aggregate output token limit
              <input
                className="control"
                name="outputTokens"
                type="number"
                required
                min={0}
                max={Number.MAX_SAFE_INTEGER}
              />
            </label>
            <label className="field">
              Aggregate inference cost limit (microdollars)
              <input
                className="control"
                name="costMicros"
                type="number"
                required
                min={0}
                max={Number.MAX_SAFE_INTEGER}
              />
            </label>
          </fieldset>
          <fieldset disabled={!current || !create.isIdle}>
            <legend>Coordination</legend>
            <label className="report-groups__choice">
              <input
                type="checkbox"
                checked={flowEnabled}
                onChange={(event) => setFlowEnabled(event.target.checked)}
              />
              Use an existing Flow run
            </label>
            <p>
              Flow owns readiness, claims, joins and acceptance. Selecting a run
              does not prove that this Station can currently execute it.
            </p>
          </fieldset>
          <fieldset
            hidden={!flowEnabled}
            disabled={!current || !create.isIdle || !flowEnabled}
          >
            <legend>Flow run</legend>
            <label className="field">
              Flow run ID
              <input
                className="control"
                name="flowRunId"
                required
                maxLength={128}
              />
            </label>
            <label className="report-groups__choice">
              <input
                type="checkbox"
                checked={continuationEnabled}
                onChange={(event) =>
                  setContinuationEnabled(event.target.checked)
                }
              />
              Reserve continuation for this Flow group
            </label>
            <p>
              Lifetime limits cannot expand. Returning-session qualification
              remains open; the server may refuse this path.
            </p>
          </fieldset>
          <fieldset
            hidden={!flowEnabled || !continuationEnabled}
            disabled={
              !current || !create.isIdle || !flowEnabled || !continuationEnabled
            }
          >
            <legend>Continuation limits</legend>
            {(
              [
                {
                  name: 'attemptsPerMember',
                  label: 'Attempts per member',
                  min: 1,
                  value: 3,
                },
                {
                  name: 'maxRounds',
                  label: 'Maximum rounds',
                  min: 1,
                  value: 3,
                },
                {
                  name: 'maxSyncs',
                  label: 'Maximum context operations',
                  min: 0,
                  value: 1,
                },
                {
                  name: 'maxRenewals',
                  label: 'Maximum authority renewals',
                  min: 0,
                  value: 0,
                },
                {
                  name: 'maxEvaluations',
                  label: 'Maximum evaluations',
                  min: 0,
                  value: 2,
                },
                {
                  name: 'maxRecoveries',
                  label: 'Maximum recoveries',
                  min: 0,
                  value: 0,
                },
              ] as const
            ).map(({ name, label, min, value }) => (
              <label className="field" key={name}>
                {label}
                <input
                  className="control"
                  name={name}
                  type="number"
                  required
                  min={min}
                  max={REPORT_GROUP_CONTINUATION_LIMITS[name]}
                  defaultValue={value}
                />
              </label>
            ))}
          </fieldset>
          {Array.from({ length: members }, (_, i) => (
            <fieldset key={i} disabled={!current || !create.isIdle}>
              <legend>Report member {i + 1}</legend>
              <label className="field">
                Seat ID
                <input
                  className="control"
                  name={`seat-${i}`}
                  required
                  maxLength={128}
                  defaultValue={`seat-${i + 1}`}
                />
              </label>
              <label className="field" hidden={!flowEnabled}>
                Flow step ID
                <input
                  className="control"
                  name={`step-${i}`}
                  required={flowEnabled}
                  disabled={!flowEnabled}
                  maxLength={128}
                />
              </label>
              <label className="field">
                Agent ID
                <input
                  className="control"
                  name={`agent-${i}`}
                  required
                  maxLength={128}
                />
              </label>
              <label className="field">
                Member brief
                <textarea
                  className="control control--textarea"
                  name={`brief-${i}`}
                  required
                  maxLength={65536}
                />
              </label>
              <label className="field">
                Member output token limit
                <input
                  className="control"
                  name={`output-${i}`}
                  type="number"
                  required
                  min={1}
                  max={128000}
                  defaultValue={1024}
                />
              </label>
            </fieldset>
          ))}
          <Button
            variant="secondary"
            disabled={!current || !create.isIdle || members >= 16}
            onClick={() => {
              setMembers(members + 1);
              setDirty(true);
            }}
          >
            Add report member
          </Button>
          <Button type="submit" disabled={!current || !create.isIdle}>
            Start paid reports
          </Button>
          {invalid && (
            <p role="alert">
              Check the source, receiver IDs, briefs and limits before
              submitting.
            </p>
          )}
          {current && create.isPending && (
            <p role="status">Running report group…</p>
          )}
          {current && create.isError && (
            <p role="alert">
              Report outcome unknown. Keep the operation ID and inspect retained
              groups before new work; this request is not retried.
            </p>
          )}
          {current && create.isSuccess && (
            <p role="status">
              Report group {create.data.group.groupId}:{' '}
              {create.data.group.execution}. Acceptance remains unassessed.
            </p>
          )}
          {!current && (
            <p role="alert">Station authority changed. Reopen this view.</p>
          )}
        </form>
      )}
      <DiscardModal />
    </section>
  );
}
