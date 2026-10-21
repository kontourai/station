import type { PaneHostFacts } from '@kontourai/station-contracts/workspace-pane-host-contract';
import {
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react';
import { getPluginHeaders } from '../api-core';
import { createPluginTelemetry } from '../client/plugin-telemetry';
import type {
  SDKAuthContext,
  SDKAuthState,
  SDKHost,
  SDKNavigation,
  SDKShortcut,
  SDKShortcutRegistration,
  SDKToast,
} from '../host-contexts';
import { SDKContext } from '../providers';
import { useProjectQuery, useProjectsQuery } from '../queries';
import type { AgentSummary } from '../types';

export function useSDK() {
  const sdk = useContext(SDKContext);
  if (!sdk) throw new Error('SDK context not available');
  return {
    apiBase: sdk.apiBase,
    pluginName: sdk.pluginApiIdentity?.pluginName ?? '',
    telemetryCapability: sdk.pluginApiIdentity?.telemetryCapability,
    getPluginHeaders: sdk.pluginApiIdentity?.getHeaders ?? getPluginHeaders,
  };
}

/** The calling Pane's publisher counts, through its Station kernel. */
export function useTelemetry() {
  const { apiBase, telemetryCapability } = useSDK();
  return useMemo(
    () =>
      createPluginTelemetry(apiBase, telemetryCapability ?? (() => undefined)),
    [apiBase, telemetryCapability],
  );
}

export function useAgents(): AgentSummary[] {
  const sdk = useContext(SDKContext);
  if (!sdk?.contexts?.agents) throw new Error('AgentsContext not available');
  return sdk.contexts.agents.useAgents();
}

export function useAgent(slug: string): AgentSummary | undefined {
  const agents = useAgents();
  return agents.find((a) => a.slug === slug);
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

const fallbackAuth: SDKAuthContext = {
  useAuth: () => ({
    status: 'missing',
    user: null,
    expiresAt: null,
    provider: '',
    renew: async () => {},
    isRenewing: false,
  }),
};

export function useAuth(): SDKAuthState {
  const sdk = useContext(SDKContext);
  const authContext = sdk?.contexts?.auth ?? fallbackAuth;
  return authContext.useAuth();
}

export function useConfig() {
  const sdk = useContext(SDKContext);
  if (!sdk?.contexts?.config) throw new Error('ConfigContext not available');
  return sdk.contexts.config.useConfig();
}

export function useNavigation(): SDKNavigation {
  const sdk = useContext(SDKContext);
  if (!sdk?.contexts?.navigation)
    throw new Error('NavigationContext not available');
  return sdk.contexts.navigation.useNavigation();
}

export function useDockState() {
  const navigation = useNavigation();
  return {
    isOpen: navigation.isDockOpen,
    setOpen: navigation.setDockState,
    toggle: () => navigation.setDockState(!navigation.isDockOpen),
  };
}

export function useToast(): SDKToast {
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

/**
 * The host's own requests: clipboard, external links, and its prompt and
 * confirm dialogs. Throws when the host supplies no `host` slot.
 */
export function useHost(): SDKHost {
  const sdk = useContext(SDKContext);
  if (!sdk?.contexts?.host) throw new Error('Host services not available');
  return sdk.contexts.host.useHost();
}

/** The pane host's environment facts, re-rendering when they change. */
export function useHostFacts(): PaneHostFacts {
  const sdk = useContext(SDKContext);
  if (!sdk?.contexts?.host) throw new Error('Host facts not available');
  const { facts } = sdk.contexts.host;
  return useSyncExternalStore(facts.subscribe, facts.read, facts.read);
}

/**
 * Registers a shortcut in the host's registry for the component's lifetime.
 * It appears in the host's shortcut list and Settings, and is suppressed
 * under modals like the host's own shortcuts. The host namespaces the id to
 * this plugin and refuses a chord reserved for the kernel (the command
 * palette, Settings, the shortcut list); the result says which.
 */
export function useShortcut(shortcut: SDKShortcut): SDKShortcutRegistration {
  const sdk = useContext(SDKContext);
  const host = sdk?.contexts?.shortcuts;
  if (!host) throw new Error('Shortcut registration not available');
  const runRef = useRef(shortcut.run);
  runRef.current = shortcut.run;
  const { id, description, when, enabled = true } = shortcut;
  // A malformed `keys` (missing, or without a modifiers array) must reach the
  // host's validation as-is and come back `invalid-keys`, not throw here.
  const keysKey = JSON.stringify(shortcut.keys ?? null);
  const whenKey = JSON.stringify(when ?? null);
  // Keyed on content, so an inline `keys`/`when` literal does not re-register
  // on every render.
  // biome-ignore lint/correctness/useExhaustiveDependencies: content keys above
  const input = useMemo(
    () => ({
      id,
      description,
      keys: shortcut.keys,
      ...(when === undefined ? {} : { when }),
    }),
    [id, description, keysKey, whenKey],
  );
  const registration = useMemo(() => host.validate(input), [host, input]);

  useEffect(() => {
    if (!registration.ok)
      console.warn(`Station refused shortcut "${id}": ${registration.message}`);
  }, [id, registration]);

  // Before paint, like the host's own shortcuts: a key pressed as the view
  // appears must not land before its shortcut exists.
  useLayoutEffect(() => {
    if (!enabled || !registration.ok) return;
    return host.register({ ...input, run: () => runRef.current() });
  }, [host, input, enabled, registration]);

  return registration;
}

/**
 * Turns one of this plugin's shortcut scopes on while mounted and `active`.
 * A shortcut whose `when` names the scope fires only then.
 */
export function useShortcutScope(name: string, active = true): void {
  const sdk = useContext(SDKContext);
  const host = sdk?.contexts?.shortcuts;
  if (!host) throw new Error('Shortcut registration not available');
  useLayoutEffect(() => {
    if (!active) return;
    return host.activateScope(name);
  }, [host, name, active]);
}

/**
 * @deprecated Use `useShortcut`. This signature has no id or description, so
 * a shortcut registered through it could not appear in the host's shortcut
 * list or be checked against reserved kernel chords; Station's adapter does
 * not supply it.
 */
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

/**
 * @deprecated Use `useShortcut`. Handing a plugin the raw registry would let
 * it replace or rebind kernel shortcuts; Station's adapter does not supply it.
 */
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
