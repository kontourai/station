import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type QueryConfig, resolveApiBase, useApiQuery } from '../query-core';

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
  workingDir: string,
  target: string,
  type: 'file' | 'directory',
  apiBase?: string,
): Promise<CodingFileEntry> {
  return postCodingFiles<CodingFileEntry>(
    'create',
    { path: workingDir, target, type },
    apiBase,
  );
}

/** Rename or move `from` to `to` (both relative to `workingDir`). */
export function renameCodingFile(
  workingDir: string,
  from: string,
  to: string,
  apiBase?: string,
): Promise<CodingFileEntry> {
  return postCodingFiles<CodingFileEntry>(
    'rename',
    { path: workingDir, from, to },
    apiBase,
  );
}

/** Delete a file or directory at `target` (relative to `workingDir`). */
export function deleteCodingFile(
  workingDir: string,
  target: string,
  apiBase?: string,
): Promise<void> {
  return postCodingFiles<void>('delete', { path: workingDir, target }, apiBase);
}

export async function fetchCodingFiles(
  workingDir: string,
  apiBase?: string,
): Promise<CodingFileEntry[]> {
  const resolvedApiBase = await resolveApiBase(apiBase);
  const response = await authenticatedFetch(
    `${resolvedApiBase}/api/coding/files?path=${encodeURIComponent(workingDir)}`,
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

export async function fetchCodingDiff(
  workingDir: string,
  apiBase?: string,
): Promise<string> {
  const resolvedApiBase = await resolveApiBase(apiBase);
  const response = await authenticatedFetch(
    `${resolvedApiBase}/api/coding/git/diff?path=${encodeURIComponent(workingDir)}`,
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
  workingDir: string,
  filePath: string,
  apiBase?: string,
): Promise<string> {
  const resolvedApiBase = await resolveApiBase(apiBase);
  // `path` is the workspace root and `file` is relative to it — the file tree
  // emits workspace-relative paths, so the server resolves against the project
  // directory rather than its own cwd.
  const response = await authenticatedFetch(
    `${resolvedApiBase}/api/coding/files/content?path=${encodeURIComponent(workingDir)}&file=${encodeURIComponent(filePath)}`,
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

export async function executeCodingCommand(
  command: string,
  cwd: string,
  apiBase?: string,
): Promise<{ stdout?: string; stderr?: string }> {
  const resolvedApiBase = await resolveApiBase(apiBase);
  const response = await authenticatedFetch(
    `${resolvedApiBase}/api/coding/exec`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command, cwd }),
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
  workingDir: string | undefined,
  apiBase?: string,
  config?: QueryConfig<CodingFileEntry[]>,
) {
  return useApiQuery(
    ['coding-files', workingDir ?? ''],
    () => fetchCodingFiles(workingDir!, apiBase),
    {
      enabled: !!workingDir && (config?.enabled ?? true),
      staleTime: config?.staleTime,
      gcTime: config?.gcTime,
    },
  );
}

export function useCodingDiffQuery(
  workingDir: string | undefined,
  apiBase?: string,
  config?: QueryConfig<string>,
) {
  return useApiQuery(
    ['coding-diff', workingDir ?? ''],
    () => fetchCodingDiff(workingDir!, apiBase),
    {
      enabled: !!workingDir && (config?.enabled ?? true),
      staleTime: config?.staleTime,
      gcTime: config?.gcTime,
    },
  );
}

export function useCodingFileContentQuery(
  workingDir: string | undefined,
  filePath: string | undefined,
  apiBase?: string,
  config?: QueryConfig<string>,
) {
  return useApiQuery(
    ['coding-file-content', workingDir ?? '', filePath ?? ''],
    () => fetchCodingFileContent(workingDir!, filePath!, apiBase),
    {
      enabled: !!workingDir && !!filePath && (config?.enabled ?? true),
      staleTime: config?.staleTime,
      gcTime: config?.gcTime,
    },
  );
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
  workingDir: string | undefined,
  apiBase?: string,
) {
  const invalidate = useInvalidateCodingFiles(workingDir);
  return useMutation({
    mutationFn: (vars: { target: string; type: 'file' | 'directory' }) =>
      createCodingFile(workingDir ?? '', vars.target, vars.type, apiBase),
    onSuccess: invalidate,
  });
}

export function useRenameCodingFileMutation(
  workingDir: string | undefined,
  apiBase?: string,
) {
  const invalidate = useInvalidateCodingFiles(workingDir);
  return useMutation({
    mutationFn: (vars: { from: string; to: string }) =>
      renameCodingFile(workingDir ?? '', vars.from, vars.to, apiBase),
    onSuccess: invalidate,
  });
}

export function useDeleteCodingFileMutation(
  workingDir: string | undefined,
  apiBase?: string,
) {
  const invalidate = useInvalidateCodingFiles(workingDir);
  return useMutation({
    mutationFn: (vars: { target: string }) =>
      deleteCodingFile(workingDir ?? '', vars.target, apiBase),
    onSuccess: invalidate,
  });
}

import { apiErrorMessage } from '../api-core';
import { authenticatedFetch } from '../client/http';
