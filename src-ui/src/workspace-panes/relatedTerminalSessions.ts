import type { AuthorityObservation } from '@kontourai/station-contracts/authority-observation';
import {
  type TerminalLaunchProfile,
  terminalScopeAllows,
} from '@kontourai/station-contracts/terminal-transport';
import {
  authenticatedFetch,
  closeProjectTerminal,
  type TerminalSession,
  type TerminalSessionTarget,
} from '@kontourai/station-sdk';
import { useMemo } from 'react';
import { borrowTerminalSessionStore } from '../components/coding-layout/terminalSessionStore';
import { useApiBase } from '../contexts/ApiBaseContext';
import { useAuthorityPersistence } from '../contexts/AuthorityPersistenceContext';

/**
 * What the viewer may do with terminals. A plugin principal holds no terminal
 * grant: the pane is Station's own UI and its socket authenticates as the
 * viewer, so the viewer's grant decides (docs/design/terminal.md, "Plugins").
 */
export type ViewerTerminalAuthority = 'operate' | 'observe' | null;

export function viewerTerminalAuthority(
  observation: AuthorityObservation | null,
): ViewerTerminalAuthority {
  const grant = observation?.grant;
  if (!grant) return null;
  if (grant.kind === 'operator') return 'operate';
  if (
    grant.grantedScopes.some((scope) => terminalScopeAllows(scope, 'operate'))
  )
    return 'operate';
  if (
    grant.grantedScopes.some((scope) => terminalScopeAllows(scope, 'observe'))
  )
    return 'observe';
  return null;
}

/** The server reads a related terminal open is checked against. */
export interface RelatedTerminalSessions {
  readonly authority: ViewerTerminalAuthority;
  /** The Project slug a thread's session recorded; null when it is not readable. */
  threadProjectSlug(threadId: string): Promise<string | null>;
  /** Whether `terminalId` is a running session in exactly `scope`. */
  running(scope: TerminalSessionTarget, terminalId: string): Promise<boolean>;
  /** Starts a server-resolved program in `scope`: its id, or null if refused. */
  start(
    scope: TerminalSessionTarget,
    launch: TerminalLaunchProfile,
  ): Promise<string | null>;
  /** Ends a session this open started and then could not show. */
  end(projectSlug: string, terminalId: string): Promise<void>;
}

const START_TIMEOUT_MS = 15_000;

function startSession(
  session: TerminalSession,
  done: () => void,
): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (terminalId: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      session.detach();
      done();
      resolve(terminalId);
    };
    const check = (current: TerminalSession) => {
      if (current.terminalId) finish(current.terminalId);
      else if (current.state === 'failed' || current.state === 'detached')
        finish(null);
    };
    const timer = setTimeout(() => finish(null), START_TIMEOUT_MS);
    const unsubscribe = session.subscribe({ change: check });
    check(session);
  });
}

export function useRelatedTerminalSessions(): RelatedTerminalSessions {
  const { apiBase, connectionId } = useApiBase();
  const { observation } = useAuthorityPersistence();
  const authority = viewerTerminalAuthority(observation);
  return useMemo(
    () => ({
      authority,
      async threadProjectSlug(threadId) {
        const response = await authenticatedFetch(
          `${apiBase}/api/orchestration/sessions/${encodeURIComponent(threadId)}?view=window-v1&turnLimit=1`,
        );
        if (response.status === 403 || response.status === 404) return null;
        const result = (await response.json()) as {
          success?: boolean;
          data?: { session?: { projectSlug?: unknown } };
        };
        if (!response.ok || !result.success)
          throw new Error('Station could not read that session.');
        const slug = result.data?.session?.projectSlug;
        return typeof slug === 'string' ? slug : null;
      },
      async running(scope, terminalId) {
        const borrowed = borrowTerminalSessionStore(apiBase, connectionId);
        try {
          const records = await borrowed.store.list(scope);
          return records.some(
            (record) =>
              record.terminalId === terminalId &&
              record.projectId === scope.projectId &&
              record.bindingKey === scope.bindingKey &&
              (record.status === 'running' || record.status === 'starting'),
          );
        } finally {
          borrowed.release();
        }
      },
      start(scope, launch) {
        const borrowed = borrowTerminalSessionStore(apiBase, connectionId);
        if (borrowed.store.failure) borrowed.store.restart();
        return startSession(
          borrowed.store.open(scope, { cols: 80, rows: 24, launch }),
          borrowed.release,
        );
      },
      async end(projectSlug, terminalId) {
        await closeProjectTerminal(apiBase, projectSlug, terminalId).catch(
          () => undefined,
        );
      },
    }),
    [apiBase, authority, connectionId],
  );
}
