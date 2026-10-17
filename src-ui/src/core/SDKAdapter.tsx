import type { LayoutDefinition } from '@kontourai/station-contracts/layout';
import {
  _setApiBase,
  _setProviderFunctions,
  type SDKContextValue,
  SDKProvider,
  type SDKToast,
  type ToastAction,
  type ToastRequest,
  type ToastType,
  useProjectLayoutQuery,
  useProjectLayoutsQuery,
} from '@kontourai/station-sdk';
import { getPluginHeaders } from '@kontourai/station-sdk/client';
import { type ReactNode, useEffect, useMemo } from 'react';
import { useActiveChatActions } from '../contexts/ActiveChatsContext';
import { useAgents } from '../contexts/AgentsContext';
import { useApiBase } from '../contexts/ApiBaseContext';
import { useAuth } from '../contexts/AuthContext';
import { useConversations } from '../contexts/ConversationsContext';
import {
  useNavigation,
  useNavigationActions,
} from '../contexts/NavigationContext';
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

const EMPTY_LAYOUTS: never[] = [];

/** Every button a toast request names, `action` first; none is `undefined`. */
function toastActions(request: ToastRequest): ToastAction[] | undefined {
  const actions = [
    ...(request.action ? [request.action] : []),
    ...(request.actions ?? []),
  ];
  return actions.length > 0 ? actions : undefined;
}

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
      boundPluginName
        ? Object.freeze({
            pluginName: boundPluginName,
            getHeaders: (extraHeaders?: Record<string, string>) =>
              getPluginHeaders(extraHeaders, boundPluginName),
          })
        : undefined,
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
  const navigation = useNavigation((state) => ({
    pathname: state.pathname,
    selectedAgent: state.selectedAgent,
    selectedProject: boundProjectSlug ?? state.selectedProject,
    // Direct Panes own their layout; an ambient layout must not leak in.
    selectedProjectLayout: boundProjectSlug
      ? null
      : state.selectedProjectLayout,
    activeConversation: state.activeConversation,
    activeChat: state.activeChat,
    activeTab: state.activeTab,
    isDockOpen: state.isDockOpen,
    isDockMaximized: state.isDockMaximized,
  }));
  const navigationActions = useNavigationActions();
  const sdkNavigation = useMemo(
    () => ({ ...navigation, ...navigationActions }),
    [navigation, navigationActions],
  );
  const { selectedProject, selectedProjectLayout } = navigation;
  const { data: layouts = EMPTY_LAYOUTS } = useProjectLayoutsQuery(
    selectedProject || '',
    {
      enabled: !!selectedProject,
    },
  );
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
  const sdkToast = useMemo<SDKToast>(
    () => ({
      ...toast,
      showToast: (
        request: string | ToastRequest,
        type: ToastType = 'info',
        duration?: number,
      ) =>
        typeof request === 'string'
          ? toast.showToast(request, undefined, duration, undefined, type)
          : toast.showToast(
              request.message,
              undefined,
              request.duration,
              toastActions(request),
              request.type ?? 'info',
            ),
    }),
    [toast],
  );
  const sendMessage = useSendMessage(apiBase);
  const createChatSession = useCreateChatSession();
  const activeChatActions = useActiveChatActions();
  const openConversation = useOpenConversation(apiBase);
  const launchChat = useLaunchChat(apiBase);
  const auth = useAuth();

  // Create SDK context value with injected contexts. The agents, navigation,
  // toast and auth slots are the SDK's published contracts (#2399), so this
  // object is where the host is checked against them.
  const sdkValue = useMemo(
    () =>
      ({
        apiBase,
        ...(pluginApiIdentity ? { pluginApiIdentity } : {}),
        contexts: {
          agents: { useAgents: () => agents },
          layouts: {
            useLayouts: () => layouts,
            useLayout: () => ({ data: activeLayout?.config ?? layout }),
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
        hooks: {},
      }) satisfies SDKContextValue,
    [
      apiBase,
      pluginApiIdentity,
      agents,
      layouts,
      activeLayout?.config,
      layout,
      conversations,
      sdkNavigation,
      sdkToast,
      sendMessage,
      createChatSession,
      activeChatActions,
      openConversation,
      launchChat,
      auth,
    ],
  );

  return <SDKProvider value={sdkValue}>{children}</SDKProvider>;
}
