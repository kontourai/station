/**
 * Survey Review Workbench pane — mounts @kontourai/survey's Review
 * Workbench inside a Station Project.
 *
 * - Sessions persist per project through the plugin's server module
 *   (Survey `ReviewSessionEventStore` contract via
 *   `createPersistentReviewSessionEventStore`).
 * - Example sessions are seeded server-side from Survey's published example
 *   data, clearly labeled as demo content.
 * - "Project to Trust Bundle" asks the server module to replay the persisted
 *   events over the pre-decision snapshot and write the
 *   `buildSurveyTrustBundle` output into the project workspace at
 *   `.station/trust-bundles/survey-<session>.json` (Survey's server-apply
 *   guidance: results derive from persisted events, not browser state).
 *
 * Browser-side we import only the `review-workbench` subpath — Survey's main
 * export (and its Surface dependency) touches node builtins and stays on the
 * server.
 */

import {
  createPersistentReviewSessionEventStore,
  mountReviewWorkbench,
  type ReviewQueueSessionState,
  type ReviewSessionEvent,
  type ReviewSessionPersistenceStatus,
} from '@kontourai/survey/review-workbench';
import '@kontourai/survey/review-workbench.css';
import type { LayoutComponentProps } from '@kontourai/station-sdk';
import { useApiBase, useNavigation } from '@kontourai/station-sdk';
import { useCallback, useEffect, useRef, useState } from 'react';
import './workbench.css';

const PLUGIN_NAME = 'survey-review-workbench';

interface SessionListEntry {
  name: string;
  eventCount: number;
  updatedAt?: string;
}

interface StoredSession {
  name: string;
  snapshot: ReviewQueueSessionState;
  events: ReviewSessionEvent[];
  updatedAt?: string;
}

interface Notice {
  kind: 'info' | 'error' | 'success';
  text: string;
}

function pluginApi(apiBase: string, projectSlug: string): string {
  return `${apiBase}/api/plugins/${PLUGIN_NAME}/projects/${encodeURIComponent(projectSlug)}`;
}

async function fetchJson(
  url: string,
  init?: RequestInit,
): Promise<Record<string, unknown>> {
  const response = await fetch(url, init);
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok || body.success === false) {
    throw new Error(
      typeof body.error === 'string'
        ? body.error
        : `request failed (${response.status})`,
    );
  }
  return body;
}

export function SurveyReviewWorkbench(_props: LayoutComponentProps) {
  const { apiBase } = useApiBase();
  const navigation = useNavigation() as { selectedProject?: string | null };
  const projectSlug = navigation.selectedProject ?? null;

  const mountRef = useRef<HTMLDivElement | null>(null);
  const [sessions, setSessions] = useState<SessionListEntry[]>([]);
  const [activeSession, setActiveSession] = useState<string | null>(null);
  const [persistence, setPersistence] =
    useState<ReviewSessionPersistenceStatus>('idle');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [bundlePath, setBundlePath] = useState<string | null>(null);
  const [projecting, setProjecting] = useState(false);

  const refreshSessions = useCallback(async (): Promise<SessionListEntry[]> => {
    if (!projectSlug) return [];
    const body = await fetchJson(
      `${pluginApi(apiBase, projectSlug)}/review-sessions`,
    );
    const list = (body.sessions as SessionListEntry[]) ?? [];
    setSessions(list);
    return list;
  }, [apiBase, projectSlug]);

  // Initial load: list sessions, auto-open the most recently updated one.
  useEffect(() => {
    if (!projectSlug) return;
    let cancelled = false;
    refreshSessions()
      .then((list) => {
        if (cancelled || list.length === 0) return;
        const latest = [...list].sort((a, b) =>
          String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')),
        )[0];
        setActiveSession((current) => current ?? latest.name);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setNotice({
            kind: 'error',
            text: `Could not list review sessions: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectSlug, refreshSessions]);

  // Mount the workbench whenever the active session changes.
  useEffect(() => {
    if (!projectSlug || !activeSession || !mountRef.current) return;
    const root = mountRef.current;
    let cancelled = false;

    (async () => {
      const body = await fetchJson(
        `${pluginApi(apiBase, projectSlug)}/review-sessions/${encodeURIComponent(activeSession)}`,
      );
      if (cancelled) return;
      const stored = body.session as unknown as StoredSession;
      const eventStore = createPersistentReviewSessionEventStore({
        initialEvents: stored.events ?? [],
        persist: async (request) => {
          const saved = await fetchJson(
            `${pluginApi(apiBase, projectSlug)}/review-sessions/${encodeURIComponent(activeSession)}`,
            {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                events: request.events,
                expectedEventCount: request.expectedEventCount,
              }),
            },
          );
          return {
            events: saved.events as ReviewSessionEvent[],
            eventCount: saved.eventCount as number,
          };
        },
        onStatusChange: (state) => {
          if (cancelled) return;
          setPersistence(state.status);
          if (state.status === 'error') {
            setNotice({
              kind: 'error',
              text: `Saving review events failed: ${state.error instanceof Error ? state.error.message : String(state.error)}`,
            });
          }
        },
      });
      root.innerHTML = '';
      mountReviewWorkbench(root, stored.snapshot, { eventStore });
    })().catch((error: unknown) => {
      if (!cancelled) {
        setNotice({
          kind: 'error',
          text: `Could not load session '${activeSession}': ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    });

    return () => {
      cancelled = true;
      root.innerHTML = '';
    };
  }, [apiBase, projectSlug, activeSession]);

  /**
   * Create a new review session seeded server-side with Survey's published
   * example data (clearly labeled — demo content from
   * `@kontourai/survey/example-data/*`, not project data).
   */
  const loadExample = useCallback(async () => {
    if (!projectSlug) return;
    try {
      const created = await fetchJson(
        `${pluginApi(apiBase, projectSlug)}/review-sessions`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ example: 'public-directory' }),
        },
      );
      const session = created.session as unknown as StoredSession;
      await refreshSessions();
      setBundlePath(null);
      setActiveSession(session.name);
      setNotice({
        kind: 'info',
        text: `Created '${session.name}' from Survey example data (public-directory review).`,
      });
    } catch (error: unknown) {
      setNotice({
        kind: 'error',
        text: `Could not create example session: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }, [apiBase, projectSlug, refreshSessions]);

  /**
   * Project the session to a Surface trust bundle. The server module replays
   * the persisted snapshot + events (the auditable input) and writes the
   * bundle into the project workspace.
   */
  const projectToTrustBundle = useCallback(async () => {
    if (!projectSlug || !activeSession) return;
    setProjecting(true);
    setBundlePath(null);
    try {
      const written = await fetchJson(
        `${pluginApi(apiBase, projectSlug)}/trust-bundles`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionName: activeSession }),
        },
      );
      const summary = written.summary as
        | { accepted: number; keptCurrent: number; rejected: number }
        | undefined;
      setBundlePath(written.path as string);
      setNotice({
        kind: 'success',
        text: `Trust bundle written (${written.claimCount} claims; ${summary?.accepted ?? 0} accepted, ${summary?.keptCurrent ?? 0} kept, ${summary?.rejected ?? 0} rejected)${written.location === 'station-home' ? ' — project has no working directory, stored in Station home instead' : ''}.`,
      });
    } catch (error: unknown) {
      setNotice({
        kind: 'error',
        text: `Trust bundle projection failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    } finally {
      setProjecting(false);
    }
  }, [apiBase, projectSlug, activeSession]);

  if (!projectSlug) {
    return (
      <div className="srw-shell srw-empty" data-testid="srw-no-project">
        <h2>Survey Review Workbench</h2>
        <p>
          Open this pane inside a Project — review sessions are stored per
          Project.
        </p>
      </div>
    );
  }

  return (
    <div className="srw-shell">
      <div className="srw-toolbar">
        <div className="srw-toolbar-group">
          <label className="srw-label" htmlFor="srw-session-select">
            Session
          </label>
          <select
            id="srw-session-select"
            data-testid="srw-session-select"
            className="srw-select"
            value={activeSession ?? ''}
            onChange={(event) => {
              setBundlePath(null);
              setActiveSession(event.target.value || null);
            }}
          >
            <option value="">— select —</option>
            {sessions.map((entry) => (
              <option key={entry.name} value={entry.name}>
                {entry.name} ({entry.eventCount} events)
              </option>
            ))}
          </select>
          <button
            type="button"
            className="srw-button"
            data-testid="srw-load-example"
            onClick={loadExample}
          >
            Load example review
          </button>
        </div>
        <div className="srw-toolbar-group">
          <span
            className={`srw-status srw-status-${persistence}`}
            data-testid="srw-persistence-status"
          >
            {persistence === 'idle' ? 'no unsaved changes' : persistence}
          </span>
          <button
            type="button"
            className="srw-button srw-button-primary"
            data-testid="srw-project-bundle"
            disabled={!activeSession || projecting}
            onClick={projectToTrustBundle}
          >
            {projecting ? 'Projecting…' : 'Project to Trust Bundle'}
          </button>
        </div>
      </div>
      {notice ? (
        <div
          className={`srw-notice srw-notice-${notice.kind}`}
          data-testid="srw-notice"
        >
          {notice.text}
        </div>
      ) : null}
      {bundlePath ? (
        <div className="srw-bundle-path" data-testid="srw-bundle-path">
          {bundlePath}
        </div>
      ) : null}
      {!activeSession ? (
        <div className="srw-empty" data-testid="srw-empty">
          <p>
            No review session open. Use <strong>Load example review</strong> to
            seed one from Survey&apos;s published example data, or select an
            existing session.
          </p>
        </div>
      ) : null}
      <div className="srw-workbench" ref={mountRef} data-testid="srw-mount" />
    </div>
  );
}

export const components = {
  'survey-review-workbench-main': SurveyReviewWorkbench,
};

export default SurveyReviewWorkbench;
