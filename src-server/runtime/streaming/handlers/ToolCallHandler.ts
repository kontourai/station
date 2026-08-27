import { parseToolName } from '../../../utils/tool-name-normalizer.js';
import type { StreamChunk, StreamHandler } from '../types.js';

/**
 * Augments tool events with parsed server/tool fields for UI compatibility
 *
 * Adds `server` and `tool` fields to tool-call events by parsing the toolName.
 * Example: "myServer_doSomething" → server: "myServer", tool: "doSomething"
 */
export class ToolCallHandler implements StreamHandler {
  name = 'tool-call';

  async *process(
    input: AsyncIterable<StreamChunk>,
  ): AsyncGenerator<StreamChunk> {
    for await (const chunk of input) {
      // Augment tool-call events with parsed server/tool fields
      if (chunk.type === 'tool-call' && chunk.toolName) {
        const { server, tool } = parseToolName(chunk.toolName);
        yield {
          ...chunk,
          server,
          tool,
        } as unknown as StreamChunk;
      } else {
        yield chunk;
      }
    }
  }
}
