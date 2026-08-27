import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from 'react';

type StreamingMessage = {
  role: 'assistant';
  content: string;
  contentParts?: Array<{
    type: string;
    content?: string;
    url?: string;
    mediaType?: string;
    name?: string;
    // Flat `tool-invocation` tool-part fields — the single chat tool vocabulary.
    toolCallId?: string;
    toolName?: string;
    args?: any;
    result?: any;
    state?: string;
    needsApproval?: boolean;
    approvalId?: string;
  }>;
};

type StreamingContextType = {
  getStreamingMessage: (sessionId: string) => StreamingMessage | undefined;
  setStreamingMessage: (
    sessionId: string,
    message: StreamingMessage | undefined,
  ) => void;
  clearStreamingMessage: (sessionId: string) => void;
};

const StreamingContext = createContext<StreamingContextType | undefined>(
  undefined,
);

export function StreamingProvider({ children }: { children: ReactNode }) {
  const [streamingMessages, setStreamingMessages] = useState<
    Record<string, StreamingMessage>
  >({});

  const getStreamingMessage = useCallback(
    (sessionId: string) => {
      return streamingMessages[sessionId];
    },
    [streamingMessages],
  );

  const setStreamingMessage = useCallback(
    (sessionId: string, message: StreamingMessage | undefined) => {
      // DEBUG: Log when streaming message is set
      if (message) {
      }
      setStreamingMessages((prev) => {
        if (message === undefined) {
          const next = { ...prev };
          delete next[sessionId];
          return next;
        }
        // DEBUG: Log state update
        return { ...prev, [sessionId]: message };
      });
    },
    [],
  );

  const clearStreamingMessage = useCallback((sessionId: string) => {
    setStreamingMessages((prev) => {
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
  }, []);

  // station#3796. Note `getStreamingMessage` is keyed to `streamingMessages`
  // BY DESIGN (a consumer must read fresh tokens through it), so this memo
  // still invalidates per token — it removes the churn from every OTHER
  // render of this provider, and does not pretend to make streaming cheap.
  const value = useMemo(
    () => ({
      getStreamingMessage,
      setStreamingMessage,
      clearStreamingMessage,
    }),
    [getStreamingMessage, setStreamingMessage, clearStreamingMessage],
  );

  return (
    <StreamingContext.Provider value={value}>
      {children}
    </StreamingContext.Provider>
  );
}

export function useStreaming() {
  const context = useContext(StreamingContext);
  if (!context) {
    throw new Error('useStreaming must be used within StreamingProvider');
  }
  return context;
}
