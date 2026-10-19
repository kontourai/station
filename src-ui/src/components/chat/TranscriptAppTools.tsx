import { parseMcpToolRef } from '@kontourai/station-contracts/layout';
import { getJson } from '@kontourai/station-sdk/client';
import { QueryClient, useQueries } from '@tanstack/react-query';
import { type ReactNode, useContext, useMemo } from 'react';
import { TranscriptAppWorkspaceContext } from '../../contexts/TranscriptAppWorkspaceContext';
import { transcriptMcpToolRef } from './mcp-app-tool-ref';

// useQueries keeps a stable hook sequence outside the connected app. This
// client only hosts empty query lists; remote lookup requires the connected workspace.
const localOnlyQueryClient = new QueryClient();

/** One cached, inert catalog snapshot per server, shared by rows and batching. */
function useTranscriptAppTools(
  calls: ReadonlyArray<Parameters<typeof transcriptMcpToolRef>[0]>,
): ReadonlySet<string> {
  const workspace = useContext(TranscriptAppWorkspaceContext);
  const apiBase = workspace?.apiBase;
  const queryClient = workspace?.queryClient;
  // Apps are unavailable outside a connected workspace (including the
  // first-run sample, mounted before the app query provider). Keep rows local.
  const appsAvailable = Boolean(apiBase && queryClient);
  const servers = appsAvailable
    ? [
        ...new Set(
          calls.flatMap((call) => {
            const ref = transcriptMcpToolRef(call);
            const parsed = ref && parseMcpToolRef(ref);
            return parsed ? [parsed.serverId] : [];
          }),
        ),
      ].sort()
    : [];
  const queries = useQueries(
    {
      queries: servers.map((server) => ({
        queryKey: ['transcript-ui-tools', apiBase, server],
        queryFn: async (): Promise<string[]> => {
          const response = await getJson(
            `${apiBase}/integrations/${encodeURIComponent(server)}/ui-tools`,
          );
          if (!response.ok) throw new Error('App catalog unavailable');
          const envelope = await response.json();
          if (!envelope.success || !Array.isArray(envelope.data))
            throw new Error('Invalid App catalog');
          return envelope.data.filter(
            (name: unknown): name is string => typeof name === 'string',
          );
        },
        staleTime: 5 * 60_000,
        retry: false,
      })),
    },
    queryClient ?? localOnlyQueryClient,
  );
  const key = queries
    .flatMap((query, index) =>
      (query.data ?? []).map((name) => `${servers[index]}/${name}`),
    )
    .join('\n');
  return useMemo(() => new Set(key.split('\n').filter(Boolean)), [key]);
}

type Calls = ReadonlyArray<Parameters<typeof transcriptMcpToolRef>[0]>;

/**
 * App discovery is optional. Outside the connected workspace provider, children
 * retain ordinary transcript behavior and no catalog lookup runs. Always keep
 * this element/child ancestry stable as tool calls become eligible.
 */
export function TranscriptAppTools({
  calls,
  children,
}: {
  calls: Calls;
  children: (tools: ReadonlySet<string>) => ReactNode;
}) {
  return (
    <ResolvedTranscriptAppTools calls={calls}>
      {children}
    </ResolvedTranscriptAppTools>
  );
}

function ResolvedTranscriptAppTools({
  calls,
  children,
}: {
  calls: Calls;
  children: (tools: ReadonlySet<string>) => ReactNode;
}) {
  const tools = useTranscriptAppTools(calls);
  return children(tools);
}
