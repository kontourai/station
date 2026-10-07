import type { McpElicitationForm } from '@kontourai/station-contracts/mcp-elicitation';
import { inputRequestFromRequestEvent } from './input-request.js';

export {
  INPUT_REQUEST_MAX_FIELDS as MCP_ELICITATION_MAX_FIELDS,
  INPUT_REQUEST_MAX_MESSAGE_CHARS as MCP_ELICITATION_MAX_MESSAGE_CHARS,
  INPUT_REQUEST_MAX_OPTIONS as MCP_ELICITATION_MAX_OPTIONS,
  INPUT_REQUEST_MAX_TEXT_CHARS as MCP_ELICITATION_MAX_TEXT_CHARS,
} from './input-request.js';

/** Compatibility shape; admission is owned by the unified request reader. */
export function readMcpElicitationForm(
  value: unknown,
): McpElicitationForm | null {
  const form = inputRequestFromRequestEvent({
    payload: { mcpElicitation: value },
  });
  return form
    ? {
        serverId: form.requester,
        message: form.message,
        fields: form.body.fields,
      }
    : null;
}
