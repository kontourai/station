import { parseMcpToolRef } from '@kontourai/station-contracts/layout';

/** Only provider-reported MCP names; never infer a server by splitting underscores. */
export function transcriptMcpToolRef(call: {
  toolCallId?: string;
  toolName?: string;
  name?: string;
  server?: string;
  originalName?: string;
  result?: unknown;
  output?: unknown;
  error?: string;
  errorText?: string;
  cancelled?: boolean;
  outputTruncated?: boolean;
}): string | undefined {
  const result = call.output ?? call.result;
  if (
    !call.toolCallId ||
    call.error ||
    call.errorText ||
    call.cancelled ||
    call.outputTruncated ||
    !result ||
    typeof result !== 'object' ||
    !Array.isArray((result as { content?: unknown }).content) ||
    (result as { isError?: unknown }).isError === true
  )
    return undefined;
  const name = call.toolName ?? call.name ?? '';
  const claude = /^mcp__(.+?)__(.+)$/.exec(name);
  const ref =
    call.server && call.originalName
      ? `${call.server}/${call.originalName}`
      : claude
        ? `${claude[1]}/${claude[2]}`
        : name;
  return parseMcpToolRef(ref) ? ref : undefined;
}
