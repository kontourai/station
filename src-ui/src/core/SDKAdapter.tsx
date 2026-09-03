import type { LayoutDefinition } from '@kontourai/station-contracts/layout';
import {
  _setApiBase,
  _setProviderFunctions,
  createPluginApiIdentity,
  SDKProvider,
  useProjectLayoutQuery,
  useProjectLayoutsQuery,
} from '@kontourai/station-sdk';
import { type ReactNode, useEffect, useMemo } from 'react';
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
  /**
   * Project slug already admitted by the host's authoritative bound context.
   * Direct Pane routes use this instead of ambient navigation selection.
   */
  boundProjectSlug?: string;
  /** Owning installed plugin, distinct from this Pane occurrence/layout id. */
  boundPluginName?: string;
}

/**
 * SDKAdapter - Provides SDK context to plugin components
 * Injects core app contexts into the SDK for plugin consumption
 */
export function SDKAdapter({
  children,
  layout,
  boundProjectSlug,
  boundPluginName,
}: SDKAdapterProps) {
  // Get API base from the single source of truth
  const { apiBase } = useApiBase();

  _setApiBase(apiBase);
  const pluginApiIdentity = useMemo(
    () =>
      boundPluginName ? createPluginApiIdentity(boundPluginName) : undefined,
    [boundPluginName],
  );

  // Configure process-wide host functions only. Plugin request identity stays
  // on the SDKProvider value below and is never installed as ambient state.
  useEffect(() => {
    _setProviderFunctions({
      getProvider,
      hasProvider,
      getActiveProviderId,
      registerProvider,
      configureProvider,
    });
  }, []);

  // Get all the core contexts
  const agents = useAgents();
  const navigation = useNavigation();
  const selectedProject = boundProjectSlug ?? navigation.selectedProject;
  // A direct Pane occurrence is not a persisted legacy Layout selection. Do
  // not let the last ambient layout from another route leak into its SDK
  // `useLayout` result or query identity; the explicit Pane layout below is
  // the only layout-shaped context it owns.
  const selectedProjectLayout = boundProjectSlug
    ? null
    : navigation.selectedProjectLayout;
  const sdkNavigation = boundProjectSlug
    ? {
        ...navigation,
        selectedProject: boundProjectSlug,
        selectedProjectLayout: null,
      }
    : navigation;
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
  // The public SDK has shipped both `showToast(message, type, duration)` and
  // the object form used by the first-party starters. The shell context's
  // second argument is an internal session id, so passing it through directly
  // silently turns a public toast type into attribution and renders an object
  // as `[object Object]`. Normalize both public spellings at the ONE adapter
  // seam instead of teaching plugin panes about shell storage.
  const sdkToast = {
    ...toast,
    showToast: (
      request:
        | string
        | {
            message: string;
            type?: 'info' | 'success' | 'warning' | 'error';
            duration?: number;
            action?: { label: string; onClick: () => void };
          },
      type: 'info' | 'success' | 'warning' | 'error' = 'info',
      duration?: number,
    ) =>
      typeof request === 'string'
        ? toast.showSdkToast(request, type, duration)
        : toast.showSdkToast(
            request.message,
            request.type ?? 'info',
            request.duration,
            request.action ? [request.action] : undefined,
          ),
  };
  const sendMessage = useSendMessage(apiBase);
  const createChatSession = useCreateChatSession();
  const activeChatActions = useActiveChatActions();
  const openConversation = useOpenConversation(apiBase);
  const launchChat = useLaunchChat(apiBase);
  const auth = useAuth();

  // Create SDK context value with injected contexts
  const sdkValue = {
    apiBase,
    ...(pluginApiIdentity ? { pluginApiIdentity } : {}),
    contexts: {
      agents: { useAgents: () => agents },
      layouts: { useLayouts: () => layouts } as {
        useLayouts: () => typeof layouts;
        useLayout?: () => { data: unknown };
      },
      conversations: { useConversations: () => conversations },
      navigation: { useNavigation: () => sdkNavigation },
      toast: { useToast: () => sdkToast },
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
