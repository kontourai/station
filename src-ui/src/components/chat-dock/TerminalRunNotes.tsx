import { stationControlToolName } from '@kontourai/station-contracts/station-control-refusal';
import {
  approveTerminalRun,
  closeProjectTerminalSession,
  declineTerminalRun,
  listConversationTerminalRuns,
  type TerminalRun,
} from '@kontourai/station-sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { Button } from '../Button';
import { TerminalGlyph } from '../icons/Glyph';
import './AgentScheduleNotes.css';

/** While a run waits or runs, the chat reads it again this often. */
const OPEN_RUN_POLL_MS = 2_000;

/**
 * When the chat's terminal runs may have changed without one already open: a
 * turn started or ended, or the running turn finished a `terminal_run` call.
 */
export function terminalRunRefreshKey(
  openTurnId: string | undefined,
  parts:
    | readonly { type?: string; toolName?: string; state?: string }[]
    | undefined,
): string {
  const requested = (parts ?? []).filter(
    (part) =>
      part.type === 'tool-invocation' &&
      stationControlToolName(part.toolName) === 'terminal_run' &&
      part.state !== 'call' &&
      part.state !== 'running' &&
      part.state !== 'partial-call',
  ).length;
  return `${openTurnId ?? 'idle'}:${requested}`;
}

/**
 * Commands an agent asked to run in this chat (#3994): an approval card for
 * each one waiting, showing exactly what runs and where, and a note for each
 * one running. Every run asks; approving one never approves the next.
 */
export function TerminalRunNotes({
  conversationId,
  refreshKey,
}: {
  conversationId: string;
  refreshKey: string;
}) {
  const scope = useHostRequestAuthorityScope();
  const client = useQueryClient();
  const apiBase = scope?.apiBase ?? '';
  const options = scope ? { requestScope: scope } : undefined;
  const key = [
    'terminal-runs',
    scope?.apiBase ?? null,
    scope?.authorityKey ?? null,
    conversationId,
  ];
  const enabled = Boolean(scope?.isCurrent());
  const query = useQuery({
    queryKey: key,
    enabled,
    retry: false,
    queryFn: () =>
      listConversationTerminalRuns(apiBase, conversationId, options),
    refetchInterval: (current) =>
      current.state.data?.length ? OPEN_RUN_POLL_MS : false,
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is the trigger.
  useEffect(() => {
    if (enabled) void query.refetch({ cancelRefetch: false });
  }, [refreshKey]);
  const settle = () => client.invalidateQueries({ queryKey: key });
  const approve = useMutation({
    mutationFn: (runId: string) => approveTerminalRun(apiBase, runId, options),
    onSettled: settle,
  });
  const decline = useMutation({
    mutationFn: (runId: string) => declineTerminalRun(apiBase, runId, options),
    onSettled: settle,
  });
  const stop = useMutation({
    mutationFn: (run: TerminalRun) =>
      closeProjectTerminalSession(
        apiBase,
        run.projectSlug,
        run.terminalId!,
        run.bindingKey,
        options,
      ),
    onSettled: settle,
  });

  const runs = query.data ?? [];
  if (runs.length === 0) return null;
  const busy = approve.isPending || decline.isPending;
  return (
    <ul className="agent-schedule-notes" aria-label="Terminal commands">
      {runs.map((run) => (
        <li className="agent-schedule-notes__item" key={run.runId}>
          {run.state === 'needs_approval' ? (
            <section
              className="agent-schedule-card"
              aria-label={`Run ${run.command}?`}
            >
              <p className="agent-schedule-card__title">
                <TerminalGlyph className="agent-schedule-notes__glyph" />
                <strong>Run this command?</strong>
              </p>
              <dl className="agent-schedule-card__facts">
                <dt>Command</dt>
                <dd
                  className="agent-schedule-card__prompt agent-schedule-card__command"
                  // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be focusable to be scrolled by keyboard.
                  tabIndex={0}
                >
                  {run.command}
                </dd>
                <dt>Directory</dt>
                <dd className="agent-schedule-card__command">{run.cwd}</dd>
              </dl>
              {(approve.isError && approve.variables === run.runId) ||
              (decline.isError && decline.variables === run.runId) ? (
                <p className="agent-schedule-card__error" role="alert">
                  {(
                    (approve.variables === run.runId
                      ? approve.error
                      : decline.error) as Error | null
                  )?.message ?? "That didn't go through. Try again."}
                </p>
              ) : null}
              <div className="agent-schedule-card__actions">
                <Button
                  variant="primary"
                  size="sm"
                  pending={approve.isPending && approve.variables === run.runId}
                  pendingLabel="Starting…"
                  disabled={busy}
                  onClick={() => approve.mutate(run.runId)}
                >
                  Run
                </Button>
                <Button
                  size="sm"
                  pending={decline.isPending && decline.variables === run.runId}
                  pendingLabel="Declining…"
                  disabled={busy}
                  onClick={() => decline.mutate(run.runId)}
                >
                  Decline
                </Button>
              </div>
            </section>
          ) : (
            <div className="agent-schedule-notes__note" title={run.cwd}>
              <TerminalGlyph className="agent-schedule-notes__glyph" />
              <span className="agent-schedule-notes__text">
                Running <code>{run.command}</code>
              </span>
              {run.terminalId ? (
                <Button
                  size="sm"
                  variant="ghost"
                  pending={
                    stop.isPending && stop.variables?.runId === run.runId
                  }
                  pendingLabel="Stopping…"
                  disabled={stop.isPending}
                  aria-label={`Stop ${run.command}`}
                  onClick={() => stop.mutate(run)}
                >
                  Stop
                </Button>
              ) : null}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
