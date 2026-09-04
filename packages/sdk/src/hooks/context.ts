import { useContext } from 'react';
import { getPluginHeaders } from '../api-core';
import { SDKContext } from '../providers';
import { useProjectQuery, useProjectsQuery } from '../queries';
import type { AgentSummary } from '../types';

export function useSDK() {
  const sdk = useContext(SDKContext);
  if (!sdk) throw new Error('SDK context not available');
  return {
    apiBase: sdk.apiBase,
    pluginName: sdk.pluginApiIdentity?.pluginName ?? '',
    getPluginHeaders: sdk.pluginApiIdentity?.getHeaders ?? getPluginHeaders,
  };
}

export function useAgents() {
  const sdk = useContext(SDKContext);
  if (!sdk?.contexts?.agents) throw new Error('AgentsContext not available');
  return sdk.contexts.agents.useAgents();
}

export function useAgent(slug: string) {
  const agents = useAgents();
  return agents.find((a: AgentSummary) => a.slug === slug);
}

export function useLayouts() {
  const sdk = useContext(SDKContext);
  if (!sdk?.contexts?.layouts) throw new Error('LayoutsContext not available');
  return sdk.contexts.layouts.useLayouts();
}

export function useLayout(slug: string, enabled = true) {
  const sdk = useContext(SDKContext);
  if (!sdk?.contexts?.layouts) throw new Error('LayoutsContext not available');
  return sdk.contexts.layouts.useLayout(slug, enabled);
}

export function useProjects() {
  return useProjectsQuery();
}

export function useProject(slug: string) {
  return useProjectQuery(slug);
}

export function useConversations(agentSlug?: string) {
  const sdk = useContext(SDKContext);
  if (!sdk?.contexts?.conversations)
    throw new Error('ConversationsContext not available');
  return sdk.contexts.conversations.useConversations(agentSlug);
}

export function useConversation(conversationId: string) {
  const sdk = useContext(SDKContext);
  if (!sdk?.contexts?.conversations)
    throw new Error('ConversationsContext not available');
  return sdk.contexts.conversations.useConversation(conversationId);
}

export function useConversationMessages(conversationId: string) {
  const sdk = useContext(SDKContext);
  if (!sdk?.contexts?.conversations)
    throw new Error('ConversationsContext not available');
  return sdk.contexts.conversations.useConversationMessages(conversationId);
}

export function useCreateChatSession() {
  const sdk = useContext(SDKContext);
  if (!sdk?.contexts?.activeChats)
    throw new Error('ActiveChatsContext not available');
  return sdk.contexts.activeChats.useCreateChatSession();
}

/** Open/resume an existing conversation in the chat dock. Returns the session ID. */
export function useOpenConversation() {
  const sdk = useContext(SDKContext);
  if (!sdk?.contexts?.activeChats?.useOpenConversation)
    throw new Error('ActiveChatsContext not available');
  return sdk.contexts.activeChats.useOpenConversation();
}

export function useSendMessage() {
  const sdk = useContext(SDKContext);
  if (!sdk?.contexts?.activeChats)
    throw new Error('ActiveChatsContext not available');
  return sdk.contexts.activeChats.useSendMessage();
}

/**
 * Launch a new chat session: create → open dock → activate → send.
 * Shared primitive used by useSendToChat and core tab actions.
 */
export function useLaunchChat() {
  const sdk = useContext(SDKContext);
  if (!sdk?.contexts?.activeChats?.useLaunchChat)
    throw new Error('ActiveChatsContext not available');
  return sdk.contexts.activeChats.useLaunchChat();
}

export function useActiveChatActions(sessionId: string) {
  const sdk = useContext(SDKContext);
  if (!sdk?.contexts?.activeChats)
    throw new Error('ActiveChatsContext not available');
  return sdk.contexts.activeChats.useActiveChatActions(sessionId);
}

export function useActiveChatState(sessionId: string) {
  const sdk = useContext(SDKContext);
  if (!sdk?.contexts?.activeChats)
    throw new Error('ActiveChatsContext not available');
  return sdk.contexts.activeChats.useActiveChatState(sessionId);
}

export function useModels() {
  const sdk = useContext(SDKContext);
  if (!sdk?.contexts?.models) throw new Error('ModelsContext not available');
  return sdk.contexts.models.useModels();
}

export function useAvailableModels() {
  const sdk = useContext(SDKContext);
  if (!sdk?.contexts?.models) throw new Error('ModelsContext not available');
  return sdk.contexts.models.useAvailableModels();
}

export function useApiBase() {
  const sdk = useContext(SDKContext);
  if (!sdk?.contexts?.config) throw new Error('ConfigContext not available');
  return sdk.contexts.config.useApiBase();
}

const fallbackAuth = {
  useAuth: () => ({
    status: 'missing' as const,
    user: null,
    expiresAt: null,
    provider: '',
    renew: async () => {},
    isRenewing: false,
  }),
};

export function useAuth() {
  const sdk = useContext(SDKContext);
  const authContext = sdk?.contexts?.auth ?? fallbackAuth;
  return authContext.useAuth();
}

export function useConfig() {
  const sdk = useContext(SDKContext);
  if (!sdk?.contexts?.config) throw new Error('ConfigContext not available');
  return sdk.contexts.config.useConfig();
}

export function useNavigation() {
  const sdk = useContext(SDKContext);
  if (!sdk?.contexts?.navigation)
    throw new Error('NavigationContext not available');
  return sdk.contexts.navigation.useNavigation();
}

export function useDockState() {
  const navigation = useNavigation();
  return {
    isOpen: navigation.dockState,
    setOpen: navigation.setDockState,
    toggle: () => navigation.setDockState(!navigation.dockState),
  };
}

export function useToast() {
  const sdk = useContext(SDKContext);
  if (!sdk?.contexts?.toast) throw new Error('ToastContext not available');
  return sdk.contexts.toast.useToast();
}

export function useSlashCommandHandler() {
  const sdk = useContext(SDKContext);
  if (!sdk?.hooks?.slashCommandHandler)
    throw new Error('useSlashCommandHandler not available');
  return sdk.hooks.slashCommandHandler();
}

export function useSlashCommands() {
  const sdk = useContext(SDKContext);
  if (!sdk?.hooks?.slashCommands)
    throw new Error('useSlashCommands not available');
  return sdk.hooks.slashCommands();
}

export function useToolApproval() {
  const sdk = useContext(SDKContext);
  if (!sdk?.hooks?.toolApproval)
    throw new Error('useToolApproval not available');
  return sdk.hooks.toolApproval();
}

export function useStats() {
  const sdk = useContext(SDKContext);
  if (!sdk?.contexts?.stats) throw new Error('StatsContext not available');
  return sdk.contexts.stats.useStats();
}

export function useConversationStats(conversationId?: string) {
  const sdk = useContext(SDKContext);
  if (!sdk?.contexts?.stats) throw new Error('StatsContext not available');
  return sdk.contexts.stats.useConversationStats(conversationId);
}

export function useKeyboardShortcut(
  key: string,
  callback: () => void,
  deps?: any[],
) {
  const sdk = useContext(SDKContext);
  if (!sdk?.hooks?.keyboardShortcut)
    throw new Error('useKeyboardShortcut not available');
  return sdk.hooks.keyboardShortcut(key, callback, deps);
}

export function useKeyboardShortcuts() {
  const sdk = useContext(SDKContext);
  if (!sdk?.contexts?.keyboardShortcuts)
    throw new Error('KeyboardShortcutsContext not available');
  return sdk.contexts.keyboardShortcuts.useKeyboardShortcuts();
}

export function useWorkflows(agentSlug?: string) {
  const sdk = useContext(SDKContext);
  if (!sdk?.contexts?.workflows)
    throw new Error('WorkflowsContext not available');
  return sdk.contexts.workflows.useWorkflows(agentSlug);
}

export function useWorkflowFiles(agentSlug: string) {
  const sdk = useContext(SDKContext);
  if (!sdk?.contexts?.workflows)
    throw new Error('WorkflowsContext not available');
  return sdk.contexts.workflows.useWorkflowFiles(agentSlug);
}
