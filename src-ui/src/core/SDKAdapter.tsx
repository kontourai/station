import type { LayoutDefinition } from '@kontourai/station-contracts/layout';
import {
  _setApiBase,
  _setLayoutContext,
  _setProviderFunctions,
  SDKProvider,
  useProjectLayoutQuery,
  useProjectLayoutsQuery,
} from '@kontourai/station-sdk';
import { type ReactNode, useEffect } from 'react';
import { useActiveChatActions } from '../contexts/ActiveChatsContext';
import { useAgents } from '../contexts/AgentsContext';
import { useApiBase } from '../contexts/ApiBaseContext';
import { useAuth } from '../contexts/AuthContext';
import { useConversations } from '../contexts/ConversationsContext';
import { useNavigation } from '../contexts/NavigationContext';
import { useToast } from '../contexts/ToastContext';
import {
  useCreateChatSession,
  useLaunchChat,
  useOpenConversation,
  useSendMessage,
} from '../hooks/useActiveChatSessions';
import {
  configureProvider,
  getActiveProviderId,
  getProvider,
  hasProvider,
  registerProvider,
} from './layoutProviders';

interface SDKAdapterProps {
  children: ReactNode;
  authToken?: string;
  layout?: LayoutDefinition;
}

/**
 * SDKAdapter - Provides SDK context to plugin components
 * Injects core app contexts into the SDK for plugin consumption
 */
export function SDKAdapter({ children, layout }: SDKAdapterProps) {
  // Get API base from the single source of truth
  const { apiBase } = useApiBase();

  // Set layout context synchronously so plugin tool calls resolve correctly on first render
  _setApiBase(apiBase);
  _setLayoutContext(layout as any);

  // Set API base and layout context for SDK API functions
  useEffect(() => {
    _setProviderFunctions({
      getProvider,
      hasProvider,
      getActiveProviderId,
      registerProvider,
      configureProvider,
    });

    return () => {
      _setLayoutContext(undefined);
    };
  }, []);

  // Get all the core contexts
  const agents = useAgents();
  const navigation = useNavigation();
  const { selectedProject, selectedProjectLayout } = navigation;
  const { data: layouts = [] } = useProjectLayoutsQuery(selectedProject || '', {
    enabled: !!selectedProject,
  });
  const { data: activeLayout } = useProjectLayoutQuery(
    selectedProject || '',
    selectedProjectLayout || '',
    {
      enabled: !!selectedProject && !!selectedProjectLayout,
    },
  );
  const conversations = useConversations(layout?.slug || '');
  const toast = useToast();
  const sendMessage = useSendMessage(apiBase);
  const createChatSession = useCreateChatSession();
  const activeChatActions = useActiveChatActions();
  const openConversation = useOpenConversation(apiBase);
  const launchChat = useLaunchChat(apiBase);
  const auth = useAuth();

  // Create SDK context value with injected contexts
  const sdkValue = {
    apiBase,
    contexts: {
      agents: { useAgents: () => agents },
      layouts: { useLayouts: () => layouts } as {
        useLayouts: () => typeof layouts;
        useLayout?: () => { data: unknown };
      },
      conversations: { useConversations: () => conversations },
      navigation: { useNavigation: () => navigation },
      toast: { useToast: () => toast },
      config: { useApiBase: () => ({ apiBase }) },
      auth: { useAuth: () => auth },
      activeChats: {
        useSendMessage: () => sendMessage,
        useCreateChatSession: () => createChatSession,
        useActiveChatActions: () => activeChatActions,
        useOpenConversation: () => openConversation,
        useLaunchChat: () => launchChat,
      },
    },
    hooks: {
      // Add other hooks as needed
    },
  };

  sdkValue.contexts.layouts.useLayout = () => ({
    data: activeLayout?.config ?? layout,
  });

  return <SDKProvider value={sdkValue as any}>{children as any}</SDKProvider>;
}
