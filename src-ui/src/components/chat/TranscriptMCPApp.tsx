import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { MCPToolUIFrame } from '../mcp-ui/MCPToolUIFrame';

/** Historical tool output is display data, never permission to invoke it again. */
export default function TranscriptMCPApp({
  toolRef,
  toolCallId,
  args,
  result,
}: {
  toolRef: string;
  toolCallId: string;
  args: unknown;
  result: unknown;
}) {
  const parsed = CallToolResultSchema.safeParse(result);
  if (!parsed.success) return null;
  return (
    <MCPToolUIFrame
      component={{
        kind: 'mcp-tool-ui',
        ref: toolRef,
        approvalPolicy: 'read-only',
        initialArguments:
          args && typeof args === 'object' && !Array.isArray(args)
            ? (args as Record<string, unknown>)
            : {},
      }}
      resolutionIdentity={`transcript:${toolCallId}`}
      transcriptResult={{ result: parsed.data }}
    />
  );
}
