import { parseMcpToolRef } from '@kontourai/station-contracts/layout';
import { getJson } from '@kontourai/station-sdk';
import { useQueries } from '@tanstack/react-query';
import { type ReactNode, useMemo } from 'react';
import { useApiBase } from '../../contexts/ApiBaseContext';
import { transcriptMcpToolRef } from './mcp-app-tool-ref';

/** One cached, inert catalog snapshot per server, shared by rows and batching. */
function useTranscriptAppTools(
  calls: ReadonlyArray<Parameters<typeof transcriptMcpToolRef>[0]>,
): ReadonlySet<string> {
  const { apiBase } = useApiBase();
  const servers = [
    ...new Set(
      calls.flatMap((call) => {
        const ref = transcriptMcpToolRef(call);
        const parsed = ref && parseMcpToolRef(ref);
        return parsed ? [parsed.serverId] : [];
      }),
    ),
  ].sort();
  const queries = useQueries({
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
  });
  const key = queries
    .flatMap((query, index) =>
      (query.data ?? []).map((name) => `${servers[index]}/${name}`),
    )
    .join('\n');
  return useMemo(() => new Set(key.split('\n').filter(Boolean)), [key]);
}

type Calls = ReadonlyArray<Parameters<typeof transcriptMcpToolRef>[0]>;

/** Ordinary prose/local tools do not acquire remote-data dependencies. */
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
