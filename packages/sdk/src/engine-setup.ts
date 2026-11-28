import type {
  EngineInstallTerminalSetup,
  EngineStationToolsSetup,
} from '@kontourai/station-contracts/acp';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import {
  type ApiRequestScope,
  getJson,
  mutateJson,
  readEnvelopeOrThrow,
} from './client/http';
import { useFeaturePreviewsQuery } from './query-domains/featurePreviews';

const terminalSchema = z.object({
  projectSlug: z.string(),
  projectId: z.string(),
  bindingKey: z.string(),
  terminalId: z.string(),
  operationId: z.string().optional(),
  status: z.enum(['starting', 'running', 'exited', 'failed']),
  exitCode: z.number().nullable(),
});
const installSchema: z.ZodType<EngineInstallTerminalSetup> = z.object({
  name: z.string(),
  command: z.string(),
  allowed: z.boolean(),
  canStop: z.boolean(),
  terminal: terminalSchema.nullable(),
});
const toolsSchema: z.ZodType<EngineStationToolsSetup> = z.object({
  agentSlug: z.string().nullable(),
  supported: z.boolean(),
  selected: z.boolean(),
  recommended: z
    .object({
      id: z.string(),
      name: z.string(),
      command: z.string(),
      args: z.array(z.string()),
    })
    .optional(),
});
async function body<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  return schema.parse(await readEnvelopeOrThrow(response));
}
async function read<T>(
  url: string,
  scope: ApiRequestScope,
  schema: z.ZodType<T>,
): Promise<T | null> {
  try {
    return await body(await getJson(url, { requestScope: scope }), schema);
  } catch (error) {
    if (error instanceof Error && 'status' in error && error.status === 404)
      return null;
    throw error;
  }
}
const key = (scope: ApiRequestScope, id: string, kind: string) => [
  'engine-setup',
  scope.apiBase,
  scope.authorityKey,
  id,
  kind,
];
const base = (scope: ApiRequestScope, id: string) =>
  `${scope.apiBase}/acp/registry/${encodeURIComponent(id)}/install-terminal`;

export function useEngineInstallTerminal(id: string, scope: ApiRequestScope) {
  const queryClient = useQueryClient();
  const queryKey = key(scope, id, 'installer');
  const previews = useFeaturePreviewsQuery(scope.apiBase);
  const offered =
    previews.data?.some(
      (preview) => preview.id === 'guided-engine-setup' && preview.enabled,
    ) === true;
  const query = useQuery({
    queryKey,
    queryFn: () => read(base(scope, id), scope, installSchema),
    retry: false,
    gcTime: 0,
    refetchInterval: (value) =>
      value.state.status !== 'error' &&
      ['running', 'starting'].includes(value.state.data?.terminal?.status ?? '')
        ? 1000
        : false,
  });
  const start = useMutation({
    mutationFn: ({
      command,
      operationId,
    }: {
      command: string;
      operationId: string;
    }) =>
      mutateJson(
        base(scope, id),
        'POST',
        { requestScope: scope },
        { command, operationId },
      ).then((value) =>
        body(value, z.object({ terminal: terminalSchema.nullable() })),
      ),
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
    retry: false,
  });
  const stop = useMutation({
    mutationFn: (target: { terminalId: string; operationId: string }) =>
      mutateJson(
        base(scope, id),
        'DELETE',
        { requestScope: scope },
        target,
      ).then(readEnvelopeOrThrow),
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
    retry: false,
  });
  return { query, start, stop, offered };
}
export function useEngineStationTools(id: string, scope: ApiRequestScope) {
  const client = useQueryClient();
  const queryKey = key(scope, id, 'station-tools');
  const previews = useFeaturePreviewsQuery(scope.apiBase);
  const offered =
    previews.data?.some(
      (preview) => preview.id === 'guided-engine-setup' && preview.enabled,
    ) === true;
  const url = `${scope.apiBase}/acp/connections/${encodeURIComponent(id)}/station-tools`;
  const query = useQuery({
    queryKey,
    queryFn: () => read(url, scope, toolsSchema),
    enabled: offered,
    retry: false,
    gcTime: 0,
  });
  const enable = useMutation({
    mutationFn: () =>
      mutateJson(url, 'POST', { requestScope: scope }, {}).then(
        readEnvelopeOrThrow,
      ),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['agents'] });
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey });
    },
    retry: false,
  });
  const repair = useMutation({
    mutationFn: (launch: NonNullable<EngineStationToolsSetup['recommended']>) =>
      mutateJson(
        `${scope.apiBase}/acp/connections/${encodeURIComponent(id)}/recommended-setup`,
        'POST',
        { requestScope: scope },
        { id: launch.id, command: launch.command, args: launch.args },
      ).then(readEnvelopeOrThrow),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['acp-connections'] });
      void client.invalidateQueries({ queryKey: ['engine-connections'] });
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey });
    },
    retry: false,
  });
  return { query, enable, repair, offered };
}
