import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type QueryConfig, resolveApiBase, useApiQuery } from '../query-core';

/**
 * Where a coding request acts (#2412): the Project it belongs to and the
 * folder inside it. The server refuses a folder outside the named Project's
 * working directory (or its worktrees folder beside it), so every coding
 * call carries both.
 */
export interface CodingLocation {
  projectSlug: string;
  workingDir: string;
}

function codingQuery(location: CodingLocation): string {
  return `projectSlug=${encodeURIComponent(location.projectSlug)}&path=${encodeURIComponent(location.workingDir)}`;
}

function isCodingLocation(
  location: CodingLocation | undefined,
): location is CodingLocation {
  return !!location?.projectSlug && !!location.workingDir;
}

export interface CodingFileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  modified?: string;
  children?: CodingFileEntry[];
}

async function postCodingFiles<T>(
  op: 'create' | 'rename' | 'delete',
  body: Record<string, unknown>,
  apiBase?: string,
): Promise<T> {
  const resolvedApiBase = await resolveApiBase(apiBase);
  const response = await authenticatedFetch(
    `${resolvedApiBase}/api/coding/files/${op}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  const result = (await response.json()) as {
    success: boolean;
    data?: T;
    error?: string;
  };
  if (!result.success) {
    throw new Error(apiErrorMessage(result, `Failed to ${op} file`));
  }
  return result.data as T;
}

/** Create an empty file or a directory at `target` (relative to `workingDir`). */
export function createCodingFile(
  location: CodingLocation,
  target: string,
  type: 'file' | 'directory',
  apiBase?: string,
): Promise<CodingFileEntry> {
  return postCodingFiles<CodingFileEntry>(
    'create',
    {
      projectSlug: location.projectSlug,
      path: location.workingDir,
      target,
      type,
    },
    apiBase,
  );
}

/** Rename or move `from` to `to` (both relative to `workingDir`). */
export function renameCodingFile(
  location: CodingLocation,
  from: string,
  to: string,
  apiBase?: string,
): Promise<CodingFileEntry> {
  return postCodingFiles<CodingFileEntry>(
    'rename',
    {
      projectSlug: location.projectSlug,
      path: location.workingDir,
      from,
      to,
    },
    apiBase,
  );
}

/** Delete a file or directory at `target` (relative to `workingDir`). */
export function deleteCodingFile(
  location: CodingLocation,
  target: string,
  apiBase?: string,
): Promise<void> {
  return postCodingFiles<void>(
    'delete',
    { projectSlug: location.projectSlug, path: location.workingDir, target },
    apiBase,
  );
}

export async function fetchCodingFiles(
  location: CodingLocation,
  apiBase?: string,
): Promise<CodingFileEntry[]> {
  const resolvedApiBase = await resolveApiBase(apiBase);
  const response = await authenticatedFetch(
    `${resolvedApiBase}/api/coding/files?${codingQuery(location)}`,
  );
  const result = (await response.json()) as {
    success: boolean;
    data?: CodingFileEntry[];
    error?: string;
  };
  if (!result.success) {
    throw new Error(apiErrorMessage(result, 'Failed to load files'));
  }
  return result.data ?? [];
}

export interface CodingFileMentionCandidates {
  entries: CodingFileEntry[];
  partial: boolean;
}

const FILE_MENTION_LOOKUP_LIMIT = 200;

/** Bounded, request-fresh metadata lookup for composer file mentions. */
export async function fetchCodingFileMentionCandidates(
  location: CodingLocation,
  query: string,
  requestScope: ApiRequestScope & { isCurrent: () => boolean },
  signal?: AbortSignal,
): Promise<CodingFileMentionCandidates> {
  const resolvedApiBase = await resolveApiBase(requestScope.apiBase);
  const response = await getJson(
    `${resolvedApiBase}/api/coding/files/search?${codingQuery(location)}&query=${encodeURIComponent(query)}&maxResults=${FILE_MENTION_LOOKUP_LIMIT + 1}`,
    { signal, requestScope },
  );
  const result = (await response.json()) as {
    success: boolean;
    data?: CodingFileEntry[];
    scanTruncated?: boolean;
    error?: string;
  };
  if (!result.success)
    throw new Error(apiErrorMessage(result, 'Failed to load file mentions'));
  const source = result.data ?? [];
  return {
    entries: source.slice(0, FILE_MENTION_LOOKUP_LIMIT),
    partial:
      result.scanTruncated === true ||
      source.length > FILE_MENTION_LOOKUP_LIMIT,
  };
}

export async function fetchCodingDiff(
  location: CodingLocation,
  apiBase?: string,
): Promise<string> {
  const resolvedApiBase = await resolveApiBase(apiBase);
  const response = await authenticatedFetch(
    `${resolvedApiBase}/api/coding/git/diff?${codingQuery(location)}`,
  );
  const result = (await response.json()) as {
    success: boolean;
    data?: { diff?: string } | string;
    error?: string;
  };
  if (!result.success) {
    throw new Error(apiErrorMessage(result, 'Failed to load diff'));
  }
  if (typeof result.data === 'string') {
    return result.data;
  }
  return result.data?.diff ?? '';
}

export async function fetchCodingFileContent(
  location: CodingLocation,
  filePath: string,
  apiBase?: string,
): Promise<string> {
  const resolvedApiBase = await resolveApiBase(apiBase);
  // `path` is the workspace root and `file` is relative to it — the file tree
  // emits workspace-relative paths, so the server resolves against the project
  // directory rather than its own cwd.
  const response = await authenticatedFetch(
    `${resolvedApiBase}/api/coding/files/content?${codingQuery(location)}&file=${encodeURIComponent(filePath)}`,
  );
  const result = (await response.json()) as {
    success: boolean;
    data?: { content?: string } | string;
    error?: string;
  };
  if (!result.success) {
    throw new Error(apiErrorMessage(result, 'Failed to load file content'));
  }
  if (typeof result.data === 'string') {
    return result.data;
  }
  return result.data?.content ?? '';
}

export async function fetchTerminalPort(apiBase?: string): Promise<number> {
  const resolvedApiBase = await resolveApiBase(apiBase);
  const response = await authenticatedFetch(
    `${resolvedApiBase}/api/system/terminal-port`,
  );
  const result = (await response.json()) as {
    port?: number;
    data?: { port?: number };
  };
  const port = result.port ?? result.data?.port;
  if (!port) {
    throw new Error('Terminal port unavailable');
  }
  return port;
}

/**
 * Mirrors {@link fetchTerminalPort}: the Voice WebSocket server binds a
 * dedicated port (`serverPort + 2`) that is independent of `apiBase`'s own
 * port (the client's resolved API base may be the UI's same-origin port,
 * not the server's — see #198), so it must be queried from the backend
 * rather than derived by arithmetic on `apiBase`.
 */
export async function fetchVoicePort(apiBase?: string): Promise<number> {
  const resolvedApiBase = await resolveApiBase(apiBase);
  const response = await authenticatedFetch(
    `${resolvedApiBase}/api/system/voice-port`,
  );
  const result = (await response.json()) as {
    port?: number;
    data?: { port?: number };
  };
  const port = result.port ?? result.data?.port;
  if (!port) {
    throw new Error('Voice port unavailable');
  }
  return port;
}

/**
 * Runs a command in `location` as the Station's operator (#2412). A paired
 * device needs the operator's `coding:exec` grant; without it the server
 * answers 403 with code `coding-exec-not-granted`, and this rejects with its
 * message.
 */
export async function executeCodingCommand(
  command: string,
  location: CodingLocation,
  apiBase?: string,
): Promise<{ stdout?: string; stderr?: string }> {
  const resolvedApiBase = await resolveApiBase(apiBase);
  const response = await authenticatedFetch(
    `${resolvedApiBase}/api/coding/exec`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectSlug: location.projectSlug,
        command,
        cwd: location.workingDir,
      }),
    },
  );
  const result = (await response.json()) as {
    success?: boolean;
    data?: { stdout?: string; stderr?: string };
    error?: string;
  };
  if (!response.ok) {
    throw new Error(apiErrorMessage(result, `HTTP ${response.status}`));
  }
  return result.data ?? {};
}

export function useCodingFilesQuery(
  location: CodingLocation | undefined,
  apiBase?: string,
  config?: QueryConfig<CodingFileEntry[]>,
) {
  return useApiQuery(
    ['coding-files', location?.workingDir ?? ''],
    () => fetchCodingFiles(location!, apiBase),
    {
      enabled: isCodingLocation(location) && (config?.enabled ?? true),
      staleTime: config?.staleTime,
      gcTime: config?.gcTime,
    },
  );
}

export function useCodingFileMentionCandidatesQuery(
  location: CodingLocation | undefined,
  query: string,
  requestScope?: ApiRequestScope & { isCurrent: () => boolean },
) {
  return useApiQuery(
    [
      'coding-file-mentions',
      requestScope?.apiBase ?? '',
      requestScope?.authorityKey ?? '',
      location?.projectSlug ?? '',
      location?.workingDir ?? '',
      query,
    ],
    (signal) =>
      fetchCodingFileMentionCandidates(location!, query, requestScope!, signal),
    {
      enabled: isCodingLocation(location) && !!requestScope,
      staleTime: 0,
      gcTime: 0,
    },
  );
}

export function useCodingDiffQuery(
  location: CodingLocation | undefined,
  apiBase?: string,
  config?: QueryConfig<string>,
) {
  return useApiQuery(
    ['coding-diff', location?.workingDir ?? ''],
    () => fetchCodingDiff(location!, apiBase),
    {
      enabled: isCodingLocation(location) && (config?.enabled ?? true),
      staleTime: config?.staleTime,
      gcTime: config?.gcTime,
    },
  );
}

export function useCodingFileContentQuery(
  location: CodingLocation | undefined,
  filePath: string | undefined,
  apiBase?: string,
  config?: QueryConfig<string>,
) {
  return useApiQuery(
    ['coding-file-content', location?.workingDir ?? '', filePath ?? ''],
    () => fetchCodingFileContent(location!, filePath!, apiBase),
    {
      enabled:
        isCodingLocation(location) && !!filePath && (config?.enabled ?? true),
      staleTime: config?.staleTime,
      gcTime: config?.gcTime,
    },
  );
}

function requireCodingLocation(
  location: CodingLocation | undefined,
): CodingLocation {
  if (!isCodingLocation(location))
    throw new Error('No Project folder to change files in');
  return location;
}

/** Invalidate the file tree for `workingDir` after a successful mutation. */
function useInvalidateCodingFiles(workingDir: string | undefined) {
  const queryClient = useQueryClient();
  return () =>
    queryClient.invalidateQueries({
      queryKey: ['coding-files', workingDir ?? ''],
    });
}

export function useCreateCodingFileMutation(
  location: CodingLocation | undefined,
  apiBase?: string,
) {
  const invalidate = useInvalidateCodingFiles(location?.workingDir);
  return useMutation({
    mutationFn: (vars: { target: string; type: 'file' | 'directory' }) =>
      createCodingFile(
        requireCodingLocation(location),
        vars.target,
        vars.type,
        apiBase,
      ),
    onSuccess: invalidate,
  });
}

export function useRenameCodingFileMutation(
  location: CodingLocation | undefined,
  apiBase?: string,
) {
  const invalidate = useInvalidateCodingFiles(location?.workingDir);
  return useMutation({
    mutationFn: (vars: { from: string; to: string }) =>
      renameCodingFile(
        requireCodingLocation(location),
        vars.from,
        vars.to,
        apiBase,
      ),
    onSuccess: invalidate,
  });
}

export function useDeleteCodingFileMutation(
  location: CodingLocation | undefined,
  apiBase?: string,
) {
  const invalidate = useInvalidateCodingFiles(location?.workingDir);
  return useMutation({
    mutationFn: (vars: { target: string }) =>
      deleteCodingFile(requireCodingLocation(location), vars.target, apiBase),
    onSuccess: invalidate,
  });
}

import { apiErrorMessage } from '../api-core';
import {
  type ApiRequestScope,
  authenticatedFetch,
  getJson,
} from '../client/http';
