import type {
  BrowserAcquisitionView,
  BrowserLocalTargetSuggestionsView,
  BrowserLocalTargetView,
  BrowserPaneAccessView,
  BrowserSessionView,
  BrowserUrlRejectionView,
  BrowserViewportView,
} from '@kontourai/station-contracts/workspace-browser-pane';
import { authenticatedFetch } from '@kontourai/station-sdk';

/**
 * `/api/browser/*` for the Browser pane (#90). Every call goes through the
 * SDK's authenticated fetch; the server decides every refusal and this module
 * only carries its typed code back to the view.
 */

export type BrowserFetch = typeof authenticatedFetch;

/** A refusal the server made, with its typed code when it sent one. */
export class BrowserApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    readonly detail?: { urlRejection?: BrowserUrlRejectionView },
  ) {
    super(code ? `Browser request refused: ${code}` : `HTTP ${status}`);
    this.name = 'BrowserApiError';
  }
}

async function call<T>(
  fetcher: BrowserFetch,
  url: string,
  init?: { method?: string; body?: unknown; signal?: AbortSignal },
): Promise<T> {
  const response = await fetcher(url, {
    method: init?.method ?? 'GET',
    ...(init?.body !== undefined
      ? {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(init.body),
        }
      : {}),
    ...(init?.signal ? { signal: init.signal } : {}),
  });
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }
  const envelope = (payload ?? {}) as {
    success?: boolean;
    data?: unknown;
    code?: unknown;
    detail?: unknown;
  };
  if (!response.ok || envelope.success !== true) {
    throw new BrowserApiError(
      response.status,
      typeof envelope.code === 'string' ? envelope.code : undefined,
      typeof envelope.detail === 'object' && envelope.detail !== null
        ? (envelope.detail as { urlRejection?: BrowserUrlRejectionView })
        : undefined,
    );
  }
  return envelope.data as T;
}

const enc = encodeURIComponent;

export const browserPaneKeys = {
  access: (apiBase: string, projectSlug: string) =>
    ['browser-pane', apiBase, 'access', projectSlug] as const,
  acquisition: (apiBase: string) =>
    ['browser-pane', apiBase, 'acquisition'] as const,
  sessions: (apiBase: string, projectSlug: string) =>
    ['browser-pane', apiBase, 'sessions', projectSlug] as const,
  session: (apiBase: string, browserSessionId: string) =>
    ['browser-pane', apiBase, 'session', browserSessionId] as const,
  fullHistory: (apiBase: string, browserSessionId: string) =>
    ['browser-pane', apiBase, 'full-history', browserSessionId] as const,
  localTargets: (apiBase: string, projectSlug: string) =>
    ['browser-pane', apiBase, 'local-targets', projectSlug] as const,
  suggestions: (apiBase: string, projectSlug: string) =>
    ['browser-pane', apiBase, 'suggestions', projectSlug] as const,
  settings: (apiBase: string, projectSlug: string) =>
    ['browser-pane', apiBase, 'settings', projectSlug] as const,
};

/** Per-Project browser permissions (#90 D4). */
export interface BrowserProjectSettingsView {
  browserEvaluate: boolean;
  updatedBy?: string;
  updatedAt?: string;
}

export function browserPaneApi(apiBase: string, fetcher: BrowserFetch) {
  const root = `${apiBase}/api/browser`;
  return {
    access: (projectSlug: string, signal?: AbortSignal) =>
      call<BrowserPaneAccessView>(
        fetcher,
        `${root}/projects/${enc(projectSlug)}/access`,
        { signal },
      ),
    acquisition: (signal?: AbortSignal) =>
      call<BrowserAcquisitionView>(fetcher, `${root}/acquisition`, { signal }),
    download: () =>
      call<BrowserAcquisitionView>(fetcher, `${root}/acquisition/download`, {
        method: 'POST',
        body: { consent: true },
      }),
    sessions: (projectSlug: string, signal?: AbortSignal) =>
      call<BrowserSessionView[]>(
        fetcher,
        `${root}/sessions?projectSlug=${enc(projectSlug)}`,
        { signal },
      ),
    /** What the pane polls: the session with only its latest actions. */
    sessionSummary: (browserSessionId: string, signal?: AbortSignal) =>
      call<BrowserSessionView>(
        fetcher,
        `${root}/sessions/${enc(browserSessionId)}?view=summary`,
        { signal },
      ),
    /** The session with its full retained history, read on demand. */
    session: (browserSessionId: string, signal?: AbortSignal) =>
      call<BrowserSessionView>(
        fetcher,
        `${root}/sessions/${enc(browserSessionId)}`,
        { signal },
      ),
    create: (input: {
      projectSlug: string;
      url: string;
      viewport?: BrowserViewportView;
      /** Restore the caller's own open session for exactly this URL. */
      reuse?: boolean;
    }) =>
      call<BrowserSessionView>(fetcher, `${root}/sessions`, {
        method: 'POST',
        body: input,
      }),
    navigate: (browserSessionId: string, url: string, generation?: number) =>
      call<{
        session: BrowserSessionView;
        errorText?: string;
        blocked?: 'station-listener';
      }>(fetcher, `${root}/sessions/${enc(browserSessionId)}/navigate`, {
        method: 'POST',
        body: generation === undefined ? { url } : { url, generation },
      }),
    history: (
      browserSessionId: string,
      action: 'back' | 'forward' | 'reload',
      generation?: number,
    ) =>
      call<BrowserSessionView>(
        fetcher,
        `${root}/sessions/${enc(browserSessionId)}/history`,
        {
          method: 'POST',
          body: generation === undefined ? { action } : { action, generation },
        },
      ),
    viewport: (
      browserSessionId: string,
      viewport: BrowserViewportView,
      generation?: number,
    ) =>
      call<BrowserSessionView>(
        fetcher,
        `${root}/sessions/${enc(browserSessionId)}/viewport`,
        {
          method: 'POST',
          body:
            generation === undefined ? { viewport } : { viewport, generation },
        },
      ),
    reopen: (browserSessionId: string) =>
      call<BrowserSessionView>(
        fetcher,
        `${root}/sessions/${enc(browserSessionId)}/reopen`,
        { method: 'POST', body: {} },
      ),
    close: (browserSessionId: string) =>
      call<BrowserSessionView>(
        fetcher,
        `${root}/sessions/${enc(browserSessionId)}`,
        { method: 'DELETE' },
      ),
    localTargets: (projectSlug: string, signal?: AbortSignal) =>
      call<BrowserLocalTargetView[]>(
        fetcher,
        `${root}/projects/${enc(projectSlug)}/local-targets`,
        { signal },
      ),
    suggestions: (projectSlug: string, signal?: AbortSignal) =>
      call<BrowserLocalTargetSuggestionsView>(
        fetcher,
        `${root}/projects/${enc(projectSlug)}/local-target-suggestions`,
        { signal },
      ),
    addTarget: (
      projectSlug: string,
      target: { host: string; port: number; label: string },
    ) =>
      call<BrowserLocalTargetView>(
        fetcher,
        `${root}/projects/${enc(projectSlug)}/local-targets`,
        { method: 'POST', body: target },
      ),
    settings: (projectSlug: string, signal?: AbortSignal) =>
      call<BrowserProjectSettingsView>(
        fetcher,
        `${root}/projects/${enc(projectSlug)}/settings`,
        { signal },
      ),
    setBrowserEvaluate: (projectSlug: string, browserEvaluate: boolean) =>
      call<BrowserProjectSettingsView>(
        fetcher,
        `${root}/projects/${enc(projectSlug)}/settings`,
        { method: 'PUT', body: { browserEvaluate } },
      ),
    removeTarget: (projectSlug: string, targetId: string) =>
      call<unknown>(
        fetcher,
        `${root}/projects/${enc(projectSlug)}/local-targets/${enc(targetId)}`,
        { method: 'DELETE' },
      ),
  };
}

export type BrowserPaneApi = ReturnType<typeof browserPaneApi>;

/** The scheme the user typed, for an honest "can't open X: URLs". */
function typedScheme(input: string): string | undefined {
  return /^\s*([A-Za-z][A-Za-z0-9+.-]*):/.exec(input)?.[1]?.toLowerCase();
}

/** Say why the server refused a URL, in the user's terms. */
function describeUrlRefusal(
  rejection: BrowserUrlRejectionView | undefined,
  typed: string,
): string {
  switch (rejection) {
    case 'unsupported-scheme': {
      const scheme = typedScheme(typed);
      return scheme
        ? `Station can't open ${scheme}: URLs. Only http and https pages open here.`
        : 'Station opens only http and https pages.';
    }
    case 'credentials':
      return "Station can't open a URL with a username or password in it.";
    case 'too-long':
      return 'That address is too long.';
    case 'empty':
      return 'Enter an address to open.';
    case 'malformed':
      return "That doesn't look like a web address.";
    default:
      return 'Station refused that address.';
  }
}

/** Why a browser request failed, for a notice line. */
export function describeBrowserFailure(error: unknown, typed = ''): string {
  if (!(error instanceof BrowserApiError))
    return 'Station could not reach the browser.';
  switch (error.code) {
    case 'url-not-allowed':
      return error.detail?.urlRejection
        ? describeUrlRefusal(error.detail.urlRejection, typed)
        : 'That page is outside what Station opens (only http and https).';
    case 'access-denied':
      return 'You do not have access to this browser session.';
    case 'browser-unavailable':
      return 'The browser is not set up on this Station yet.';
    case 'browser-host-failed':
      return 'The browser could not start, or stopped unexpectedly.';
    case 'browser-refused':
      return 'The browser refused that request.';
    case 'browser-error':
      return 'The browser reported an error for that request.';
    case 'not-live':
      return 'The browser behind this session is not running.';
    case 'stale-generation':
      return 'The browser restarted. Reload this session to continue.';
    case 'no-history-entry':
      return 'There is no page to go to in that direction.';
    case 'not-found':
      return 'This browser session no longer exists.';
    case 'invalid-viewport':
      return 'That viewport size is not supported.';
    case 'station-listener':
      return 'Station’s own ports can never be shared.';
    case 'duplicate':
      return 'That target is already shared with this Project.';
    default:
      return 'The browser refused the request.';
  }
}
