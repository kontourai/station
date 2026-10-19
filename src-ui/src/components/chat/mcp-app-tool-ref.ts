import { parseMcpToolRef } from '@kontourai/station-contracts/layout';
import { isSuccessfulMcpResult } from '@kontourai/station-shared/mcp-app-result';

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
    !isSuccessfulMcpResult(result)
  )
    return undefined;
  const name = call.toolName ?? call.name ?? '';
  const ref =
    call.server && call.originalName
      ? `${call.server}/${call.originalName}`
      : name;
  return parseMcpToolRef(ref) ? ref : undefined;
}
