import type {
  BrowserPaneAccessView,
  BrowserSessionView,
} from '@kontourai/station-contracts/workspace-browser-pane';
import { authenticatedFetch } from '@kontourai/station-sdk';
import { useQuery } from '@tanstack/react-query';
import { useRef } from 'react';

const FLOAT_POLL_MS = 5_000;
/** The ceiling a run of transient failures backs the poll off to. */
const FLOAT_POLL_MAX_MS = 60_000;

/** The SDK's authenticated fetch, or a test's stand-in. */
export type FloatFetch = typeof authenticatedFetch;

/** A route answered with something other than a usable 200. */
export class FloatReadError extends Error {
  constructor(
    readonly status: number,
    /** The route's typed refusal (`code`), when it named one. */
    readonly code?: string,
  ) {
    super(`Float read unavailable (HTTP ${status})`);
    this.name = 'FloatReadError';
  }
}

/**
 * When to read again after a read. A 403 (not the operator or a Project
 * admin) or a 404 (no browser on this Station) is an answer: stop. Any other
 * failure is transient: back off (5 s, 10 s, 20 s … up to a minute) and keep
 * asking, so a restart or a dropped relay never ends auto-float for good.
 * `settled` is for a read that only needs one success (the access check).
 */
export function floatReadDelay(
  error: unknown,
  failures: number,
  settled: false | number,
): number | false {
  if (error === null) return settled;
  if (
    error instanceof FloatReadError &&
    (error.status === 403 || error.status === 404)
  )
    return false;
  return Math.min(
    FLOAT_POLL_MS * 2 ** Math.max(0, failures - 1),
    FLOAT_POLL_MAX_MS,
  );
}

export async function readEnvelope(
  fetcher: FloatFetch,
  url: string,
  signal: AbortSignal,
): Promise<unknown> {
  const response = await fetcher(url, { signal });
  const envelope = (await response.json().catch(() => null)) as {
    success?: boolean;
    data?: unknown;
    code?: unknown;
  } | null;
  if (!response.ok || envelope?.success !== true)
    throw new FloatReadError(
      response.status,
      typeof envelope?.code === 'string' ? envelope.code : undefined,
    );
  return envelope.data;
}

/**
 * Read here rather than through the Browser pane's `browserPaneApi`: that
 * module lives in the pane's chunks, and importing it from this one splits
 * it into a chunk of its own that the entry bundle then has to name as a
 * preload dependency — bytes on every cold load, for two GETs.
 */
async function readProjectBrowserSessions(
  fetcher: FloatFetch,
  apiBase: string,
  projectSlug: string,
  signal: AbortSignal,
): Promise<BrowserSessionView[]> {
  const data = await readEnvelope(
    fetcher,
    `${apiBase}/api/browser/sessions?projectSlug=${encodeURIComponent(projectSlug)}`,
    signal,
  );
  if (!Array.isArray(data)) throw new FloatReadError(200);
  return data as BrowserSessionView[];
}

/** Whether this viewer may use the browser here, and as which principal. */
async function readBrowserAccess(
  fetcher: FloatFetch,
  apiBase: string,
  projectSlug: string,
  signal: AbortSignal,
): Promise<BrowserPaneAccessView> {
  return (await readEnvelope(
    fetcher,
    `${apiBase}/api/browser/projects/${encodeURIComponent(projectSlug)}/access`,
    signal,
  )) as BrowserPaneAccessView;
}

export function useBrowserSessionReads(
  apiBase: string,
  authorityKey: string,
  projectSlug: string,
  transport: FloatFetch,
  enabled: boolean,
) {
  const accessFailures = useRef(0);
  const sessionFailures = useRef(0);
  const access = useQuery({
    queryKey: ['float-over-chat', apiBase, 'access', projectSlug, authorityKey],
    queryFn: async ({ signal }) => {
      try {
        const result = await readBrowserAccess(
          transport,
          apiBase,
          projectSlug,
          signal,
        );
        accessFailures.current = 0;
        return result;
      } catch (error) {
        accessFailures.current += 1;
        throw error;
      }
    },
    enabled,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    refetchInterval: (query) =>
      floatReadDelay(query.state.error, accessFailures.current, false),
  });
  const sessions = useQuery({
    queryKey: [
      'float-over-chat',
      apiBase,
      'sessions',
      projectSlug,
      authorityKey,
    ],
    queryFn: async ({ signal }) => {
      try {
        const list = await readProjectBrowserSessions(
          transport,
          apiBase,
          projectSlug,
          signal,
        );
        sessionFailures.current = 0;
        return { list, receivedAt: performance.now() };
      } catch (error) {
        sessionFailures.current += 1;
        throw error;
      }
    },
    enabled: enabled && access.isSuccess,
    retry: false,
    refetchInterval: (query) =>
      floatReadDelay(query.state.error, sessionFailures.current, FLOAT_POLL_MS),
  });
  return { access, sessions };
}
