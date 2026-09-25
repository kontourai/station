/**
 * Tool execution functions
 * Handles tool invocation, approval flow, and elicitation
 */

export {
  canonicalizeExternalToolName,
  isAutoApproved,
  isAutoApprovedExternalTool,
  withIntrinsicAutoApprovals,
} from './tool-approval.js';
