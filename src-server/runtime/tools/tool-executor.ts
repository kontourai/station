/**
 * Tool execution functions
 * Handles tool invocation, approval flow, and elicitation
 */

export {
  canonicalizeExternalToolName,
  isAuthenticStationBrowserCall,
  isAutoApproved,
  isAutoApprovedExternalTool,
  isIntrinsicStationEngineGrant,
} from './tool-approval.js';
