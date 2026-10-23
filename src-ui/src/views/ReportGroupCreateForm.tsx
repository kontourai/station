import { useCreateReportGroup } from '@kontourai/station-sdk';
import {
  type ApiRequestScope,
  parseReportGroupInput,
} from '@kontourai/station-sdk/client';
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
  const [operationId] = useState(() => crypto.randomUUID());
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
            Submitting starts paid, independent advisory reports using
            configured Agents. Each member receives its own brief and the
            selected Project source. Aggregate token and inference-cost limits
            are required. Returned reports remain unassessed. Closing this view
            stops waiting; it does not prove physical termination or refunds.
          </p>
          <p>
            Operation ID: <code>{operationId}</code>
          </p>
          <fieldset disabled={!current || !create.isIdle}>
            <legend>Source and limits</legend>
            <label>
              Project ID
              <input name="project" required maxLength={128} />
            </label>
            <label>
              Resource ID (optional)
              <input name="resource" maxLength={128} />
            </label>
            <label>
              Deadline in minutes
              <input
                name="minutes"
                type="number"
                required
                min={1}
                max={5}
                defaultValue={5}
              />
            </label>
            <label>
              Concurrent reports
              <input
                name="concurrency"
                type="number"
                required
                min={1}
                max={members}
                defaultValue={1}
              />
            </label>
            <label>
              Aggregate input token limit
              <input
                name="inputTokens"
                type="number"
                required
                min={0}
                max={Number.MAX_SAFE_INTEGER}
              />
            </label>
            <label>
              Aggregate output token limit
              <input
                name="outputTokens"
                type="number"
                required
                min={0}
                max={Number.MAX_SAFE_INTEGER}
              />
            </label>
            <label>
              Aggregate inference cost limit (microdollars)
              <input
                name="costMicros"
                type="number"
                required
                min={0}
                max={Number.MAX_SAFE_INTEGER}
              />
            </label>
          </fieldset>
          {Array.from({ length: members }, (_, i) => (
            <fieldset key={i} disabled={!current || !create.isIdle}>
              <legend>Report member {i + 1}</legend>
              <label>
                Seat ID
                <input
                  name={`seat-${i}`}
                  required
                  maxLength={128}
                  defaultValue={`seat-${i + 1}`}
                />
              </label>
              <label>
                Agent ID
                <input name={`agent-${i}`} required maxLength={128} />
              </label>
              <label>
                Member brief
                <textarea name={`brief-${i}`} required maxLength={65536} />
              </label>
              <label>
                Member output token limit
                <input
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
              Report outcome unknown. Retain the operation ID and inspect
              retained groups before starting any new work. This request will
              not be resent.
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
