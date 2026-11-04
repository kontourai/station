import { apiErrorMessage } from '../api-core';
import { authenticatedFetch } from '../client/http';
import { unlessDeadline } from '../client/request-deadline';
import {
  type QueryConfig,
  resolveApiBase,
  useApiMutation,
  useApiQuery,
} from '../query-core';

/** `GET /api/terminal/history`: disk used by terminal history (#3994). */
export interface TerminalHistoryUsage {
  /** False: new terminals write no history to disk. */
  enabled: boolean;
  /** The directory terminal history is kept in. */
  directory: string;
  projects: {
    projectId: string;
    terminals: number;
    running: number;
    bytes: number;
  }[];
  terminals: number;
  bytes: number;
}

/**
 * Thrown when this Station does not serve terminal history (an older or a
 * hosted Station). Callers say so rather than show an error.
 */
export class TerminalHistoryUnsupportedError extends Error {
  constructor() {
    super('This Station does not report terminal history.');
    this.name = 'TerminalHistoryUnsupportedError';
  }
}

async function readEnvelope<T>(response: Response): Promise<T> {
  const result = (await response.json().catch(unlessDeadline(() => ({})))) as {
    success?: boolean;
    data?: T;
    error?: string;
  };
  if (response.status === 404) throw new TerminalHistoryUnsupportedError();
  if (!response.ok || !result.success || !result.data)
    throw new Error(apiErrorMessage(result, `HTTP ${response.status}`));
  return result.data;
}

export async function fetchTerminalHistory(
  apiBase?: string,
): Promise<TerminalHistoryUsage> {
  const base = await resolveApiBase(apiBase);
  return readEnvelope(await authenticatedFetch(`${base}/api/terminal/history`));
}

/**
 * Deletes ended terminals' history in one Project, or everywhere when
 * `projectId` is absent. Running terminals keep theirs and are counted.
 */
export async function clearTerminalHistory(
  projectId?: string,
  apiBase?: string,
): Promise<{ cleared: number; running: number }> {
  const base = await resolveApiBase(apiBase);
  const query =
    projectId === undefined
      ? ''
      : `?projectId=${encodeURIComponent(projectId)}`;
  return readEnvelope(
    await authenticatedFetch(`${base}/api/terminal/history${query}`, {
      method: 'DELETE',
    }),
  );
}

export function useTerminalHistoryQuery(
  apiBase?: string,
  config?: QueryConfig<TerminalHistoryUsage>,
) {
  return useApiQuery(
    ['terminal-history', apiBase ?? 'default'],
    () => fetchTerminalHistory(apiBase),
    config,
  );
}

export function useClearTerminalHistoryMutation(apiBase?: string) {
  return useApiMutation(
    (projectId: string | undefined) => clearTerminalHistory(projectId, apiBase),
    { invalidateKeys: [['terminal-history']] },
  );
}
