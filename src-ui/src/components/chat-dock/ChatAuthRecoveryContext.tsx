import { createContext, type ReactNode, useContext } from 'react';

type ChatAuthRecovery = () => Promise<boolean> | undefined;

const ChatAuthRecoveryContext = createContext<ChatAuthRecovery | undefined>(
  undefined,
);

/**
 * Keeps authentication recovery owned by the application while allowing every
 * placement of the one Chat pane renderer to request the same recovery flow.
 */
export function ChatAuthRecoveryProvider({
  children,
  onRequestAuth,
}: {
  children: ReactNode;
  onRequestAuth: ChatAuthRecovery;
}) {
  return (
    <ChatAuthRecoveryContext.Provider value={onRequestAuth}>
      {children}
    </ChatAuthRecoveryContext.Provider>
  );
}

export function useChatAuthRecovery(): ChatAuthRecovery | undefined {
  return useContext(ChatAuthRecoveryContext);
}
