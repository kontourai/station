/**
 * Types for stream event handling system
 */

import type { UIBlock } from '@kontourai/station-contracts/ui-block';

export interface ContentPart {
  // 'tool-invocation' is the single flat tool-part vocabulary; SDK refresh parts
  // may also arrive as `tool-<toolName>`.
  type: 'text' | 'reasoning' | 'ui-block' | 'tool-invocation' | (string & {});
  content?: string;
  /** For `ui-block` parts: the structured block to render and the tool it came from. */
  uiBlock?: UIBlock;
  toolCallId?: string;
  // Flat `tool-invocation` tool-part fields.
  toolName?: string;
  name?: string;
  server?: string;
  args?: any;
  result?: any;
  error?: any;
  state?: 'pending' | 'call' | 'result' | 'complete' | 'error' | 'running';
  isError?: boolean;
  needsApproval?: boolean;
  approvalId?: string;
  cancelled?: boolean;
  approvalStatus?:
    | 'auto-approved'
    | 'user-approved'
    | 'user-denied'
    | 'policy-denied';
}

export interface StreamState {
  currentTextChunk: string;
  contentParts: ContentPart[];
  pendingApprovals?: Map<string, string>;
  approvalToasts?: Map<string, string>; // approvalId -> toastId
  reasoningChunks?: string[];
  currentReasoningChunk?: string;
}

export interface StreamEvent {
  type: string;
  [key: string]: any;
}

export interface HandlerResult {
  updated: boolean;
  currentTextChunk: string;
  contentParts: ContentPart[];
  pendingApprovals?: Map<string, string>;
  approvalToasts?: Map<string, string>; // approvalId -> toastId
  reasoningChunks?: string[];
  currentReasoningChunk?: string;
  streamingMessage?: {
    role: 'assistant';
    content: string;
    contentParts?: ContentPart[];
  };
}

export interface HandlerContext {
  sessionId: string;
  updateChat: (sessionId: string, updates: any) => void;
  apiBase?: string;
  showToolApproval?: (options: any) => string | undefined;
  handleToolApproval?: (
    sessionId: string,
    agentSlug: string,
    approvalId: string,
    toolName: string,
    action: 'once' | 'trust' | 'deny',
  ) => void;
  onNavigateToChat?: (sessionId: string) => void;
  activeChatsStore?: any;
}
