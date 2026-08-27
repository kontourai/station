export type ConversationStatus = 'idle' | 'streaming' | 'processing';

export type ConversationData = {
  id: string;
  agentSlug: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
  messageCount?: number;
};

export type MessageData = {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: string;
  traceId?: string;
  contentParts?: Array<{
    type: string;
    content?: string;
    url?: string;
    mediaType?: string;
    name?: string;
  }>;
};

export type ConversationsContextType = {
  /** Resolves `false` on a failed fetch (logged and swallowed internally)
   *  instead of throwing — station#1312 review: `useOpenConversation` reads
   *  this to avoid rehydrating into a permanently empty chat tab. */
  fetchMessages: (
    apiBase: string,
    agentSlug: string,
    conversationId: string,
  ) => Promise<boolean>;
  refreshMessages: (
    apiBase: string,
    agentSlug: string,
    conversationId: string,
  ) => Promise<boolean>;
  deleteConversation: (
    apiBase: string,
    agentSlug: string,
    conversationId: string,
  ) => Promise<void>;
  setStatus: (
    agentSlug: string,
    conversationId: string,
    status: ConversationStatus,
  ) => void;
};
