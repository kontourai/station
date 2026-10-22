import {
  agentId,
  engineConnectionId,
} from '@kontourai/station-contracts/agent-identity';
import type { EnsembleCliSessionGroupInput } from '@kontourai/station-contracts/ensemble';
import {
  useCancelCliSessionGroup,
  useCreateEnsembleCliSessionGroup,
  useRunCliSessionGroup,
} from '@kontourai/station-sdk';
import {
  type ApiRequestScope,
  parseEnsembleCliSessionGroupInput,
} from '@kontourai/station-sdk/client';
import { useState } from 'react';
import { Button } from '../components/Button';

export function EnsembleCliGroupForm({
  scope,
  path,
  presetJson,
  hash,
  memberIds,
  onDirtyChange,
}: {
  scope: ApiRequestScope & { isCurrent(): boolean };
  path?: string;
  presetJson?: string;
  hash: string;
  memberIds: string[];
  onDirtyChange(dirty: boolean): void;
}) {
  const create = useCreateEnsembleCliSessionGroup(scope);
  const run = useRunCliSessionGroup(scope);
  const cancel = useCancelCliSessionGroup(scope);
  const [expanded, setExpanded] = useState(false);
  const [brief, setBrief] = useState('');
  const [concurrency, setConcurrency] = useState(Math.min(2, memberIds.length));
  const [minutes, setMinutes] = useState(10);
  const [maxDispatches, setMaxDispatches] = useState(memberIds.length);
  const [bindings, setBindings] = useState<
    Record<
      string,
      { agent: string; engine: string; cwd: string; needs: string }
    >
  >({});
  const [operationId] = useState(() => crypto.randomUUID());
  const [inputError, setInputError] = useState(false);
  const current = scope.isCurrent();
  const saved = current ? create.data : undefined;
  const submitted = !create.isIdle;
  const complete =
    brief.trim() &&
    memberIds.every((id) => {
      const binding = bindings[id];
      return (
        binding?.agent.trim() && binding.engine.trim() && binding.cwd.trim()
      );
    });
  return (
    <section aria-label="Create a CLI session group">
      <Button
        variant="secondary"
        aria-expanded={expanded}
        onClick={() => setExpanded(true)}
        disabled={expanded || !current}
      >
        Create a CLI session group
      </Button>
      {expanded && (
        <>
          <p>
            Save this roster and brief as a group. Engines start only when the
            group is run. Dollar, token and physical attempt caps are
            unavailable. The deadline begins when the group is saved.
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!current || submitted || !complete) return;
              let input: EnsembleCliSessionGroupInput;
              try {
                input = parseEnsembleCliSessionGroupInput({
                  path,
                  presetJson,
                  expectedPresetHash: hash,
                  brief,
                  operationId,
                  maxConcurrent: concurrency,
                  maxDispatches,
                  deadlineAt: Date.now() + minutes * 60_000,
                  bindings: Object.fromEntries(
                    memberIds.map((id) => {
                      const value = bindings[id];
                      return [
                        id,
                        {
                          target: {
                            agent: agentId(value.agent.trim()),
                            expectedEngine: {
                              kind: 'connection' as const,
                              connectionId: engineConnectionId(
                                value.engine.trim(),
                              ),
                            },
                            workspace: {
                              kind: 'directory' as const,
                              cwd: value.cwd.trim(),
                            },
                          },
                          needs: value.needs
                            .split(',')
                            .map((entry) => entry.trim())
                            .filter(Boolean),
                        },
                      ];
                    }),
                  ),
                });
              } catch {
                setInputError(true);
                return;
              }
              setInputError(false);
              onDirtyChange(false);
              create.mutate(input);
            }}
          >
            <fieldset disabled={submitted || !current}>
              <legend>Group work</legend>
              <label>
                Shared brief
                <textarea
                  required
                  maxLength={100_000}
                  value={brief}
                  onChange={(event) => {
                    setBrief(event.target.value);
                    onDirtyChange(true);
                  }}
                />
              </label>
              <label>
                Concurrent members
                <input
                  type="number"
                  min={1}
                  max={memberIds.length}
                  required
                  value={concurrency}
                  onChange={(event) =>
                    setConcurrency(Number(event.target.value))
                  }
                />
              </label>
              <label>
                Maximum reserved starts
                <input
                  type="number"
                  min={0}
                  max={memberIds.length}
                  required
                  value={maxDispatches}
                  onChange={(event) => {
                    setMaxDispatches(Number(event.target.value));
                    onDirtyChange(true);
                  }}
                />
              </label>
              <p>
                Each reserved member start uses this allowance, including
                uncertain or refused starts. It does not cap provider retries or
                charges.
              </p>
              <label>
                Deadline in minutes
                <input
                  type="number"
                  min={1}
                  max={30}
                  required
                  value={minutes}
                  onChange={(event) => setMinutes(Number(event.target.value))}
                />
              </label>
            </fieldset>
            {memberIds.map((id) => {
              const value = bindings[id] ?? {
                agent: '',
                engine: '',
                cwd: '',
                needs: '',
              };
              return (
                <fieldset key={id} disabled={submitted || !current}>
                  <legend>Member {id}</legend>
                  {(
                    [
                      ['agent', 'Agent ID', 64],
                      ['engine', 'Engine connection ID', 256],
                      ['cwd', 'Working directory on This Station', 4096],
                      ['needs', 'Wait for members (comma-separated IDs)', 2048],
                    ] as const
                  ).map(([key, label, maxLength]) => (
                    <label key={key}>
                      {label}
                      <input
                        aria-label={`${label} for ${id}`}
                        required={key !== 'needs'}
                        maxLength={maxLength}
                        value={value[key]}
                        autoComplete="off"
                        spellCheck={false}
                        onChange={(event) => {
                          onDirtyChange(true);
                          setBindings({
                            ...bindings,
                            [id]: { ...value, [key]: event.target.value },
                          });
                        }}
                      />
                    </label>
                  ))}
                </fieldset>
              );
            })}
            <Button
              type="submit"
              pending={create.isPending}
              pendingLabel="Saving group…"
              disabled={!current || submitted || !complete}
            >
              Save session group
            </Button>
          </form>
          {saved && (
            <p role="status">
              Saved session group <code>{saved.groupId}</code>. Use Show session
              groups to inspect it.
            </p>
          )}
          {saved && (
            <>
              <Button
                disabled={!current || !run.isIdle || !cancel.isIdle}
                pending={run.isPending}
                pendingLabel="Supervising group…"
                onClick={() => run.mutate(saved.groupId)}
              >
                Run session group
              </Button>
              <Button
                variant="secondary"
                disabled={
                  !current ||
                  !cancel.isIdle ||
                  run.data?.flow?.status === 'completed'
                }
                pending={cancel.isPending}
                pendingLabel="Requesting cancellation…"
                onClick={() => cancel.mutate(saved.groupId)}
              >
                Cancel session group
              </Button>
              {run.isIdle && cancel.isIdle && (
                <p>No engines started by this form.</p>
              )}
              {run.data && current && (
                <p role="status">
                  Flow: {run.data.flow?.status ?? 'unavailable'}. Work
                  acceptance: not assessed.
                </p>
              )}
              {run.data?.admissionClosed === 'dispatch-limit-exhausted' &&
                current && (
                  <p role="status">
                    Dispatch allowance exhausted. No additional starts can be
                    reserved.
                  </p>
                )}
              {cancel.isSuccess && current && (
                <p role="status">
                  Cancellation requested. Engine termination is not proven.
                </p>
              )}
              {run.isError && current && (
                <p role="alert">
                  Supervision did not return a confirmed result. Inspect this
                  same group before taking another action.
                </p>
              )}
              {cancel.isError && current && (
                <p role="alert">
                  Cancellation was not confirmed. Inspect this same group.
                </p>
              )}
            </>
          )}
          {inputError && current && (
            <p role="alert">
              Check the Agent and engine connection IDs, member dependencies and
              group limits. Nothing was submitted.
            </p>
          )}
          {create.isError && current && (
            <p role="alert">
              Group creation was not confirmed. Check the session-group
              inventory before creating another group. Operation{' '}
              <code>{operationId}</code>.
            </p>
          )}
          {!current && (
            <p role="alert">
              Station authority changed. Reopen the inspector before creating a
              group.
            </p>
          )}
        </>
      )}
    </section>
  );
}
