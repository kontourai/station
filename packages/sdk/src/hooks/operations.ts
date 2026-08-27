import type { AgentId } from '@kontourai/station-contracts/agent-identity';
import { useCallback, useContext, useEffect, useState } from 'react';
import { _getApiBase, _getPluginName } from '../api';
import { apiErrorMessage } from '../api-core';
import { SDKContext } from '../providers';
import { useAgents, useLaunchChat, useToast } from './context';
export function useNotifications() {
  const toast = useToast();
  const sdk = useContext(SDKContext);
  const apiBase = sdk?.apiBase ?? '';

  return {
    /** Show an immediate toast notification (backward compat) */
    notify: (
      message: string,
      options?: {
        type?: 'info' | 'warning' | 'error' | 'success';
        duration?: number;
      },
    ) => {
      toast.showToast(message, options?.type || 'info', options?.duration);
    },
    /** Schedule a notification via the server */
    schedule: async (opts: {
      category: string;
      title: string;
      body?: string;
      priority?: 'low' | 'normal' | 'high' | 'urgent';
      scheduledAt?: string;
      ttl?: number;
      actions?: Array<{
        id: string;
        label: string;
        variant?: 'primary' | 'secondary' | 'danger';
      }>;
      metadata?: Record<string, unknown>;
      dedupeTag?: string;
    }) => {
      const res = await fetch(`${apiBase}/notifications`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'sdk', ...opts }),
      });
      if (!res.ok)
        throw new Error(`Failed to schedule notification: ${res.statusText}`);
      return res.json();
    },
    /** Dismiss a notification */
    dismiss: async (id: string) => {
      await fetch(`${apiBase}/notifications/${id}`, { method: 'DELETE' });
    },
  };
}

/**
 * Hook to send a message to chat and open the dock.
 * Plugins MUST specify the agent slug - there is no default.
 *
 * @param agentSlug - The agent to send messages to (required). Can be short name (e.g., 'my-agent')
 *                    which will be resolved using current layout context, or fully qualified
 *                    (e.g., 'sa-agent:station-agent').
 * @returns Function to send a message and open chat
 *
 * @example
 * ```typescript
 * const sendToChat = useSendToChat('my-agent');
 * sendToChat('Summarize this account');
 * ```
 */
export function useSendToChat(agentSlug: AgentId) {
  const agents = useAgents();
  const launchChat = useLaunchChat();

  return useCallback(
    (message: string) => {
      const agent = agents.find((a: any) => a.slug === agentSlug);
      if (!agent) {
        console.warn(`[useSendToChat] Agent '${agentSlug}' not found`);
        return;
      }
      launchChat(agentSlug, agent.name, message);
    },
    [agents, agentSlug, launchChat],
  );
}

/**
 * Hook to look up a user by alias via the user directory provider.
 * Returns { data, loading, error } for the given alias.
 */
export function useUserLookup(alias: string | null) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!alias) {
      setData(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    _getApiBase()
      .then((apiBase) =>
        fetch(`${apiBase}/api/users/${encodeURIComponent(alias)}`),
      )
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [alias]);

  return { data, loading, error };
}

/**
 * Server-side fetch proxy for plugins.
 * Requires `network.fetch` permission in plugin.json.
 * Returns a fetch-like function that routes through the backend to avoid CORS.
 */
export function useServerFetch() {
  return useCallback(
    async (
      url: string,
      options?: {
        method?: string;
        headers?: Record<string, string>;
        body?: string;
      },
    ) => {
      const apiBase = await _getApiBase();
      const pluginName = _getPluginName();
      const fetchUrl = pluginName
        ? `${apiBase}/api/plugins/${encodeURIComponent(pluginName)}/fetch`
        : `${apiBase}/api/plugins/fetch`;

      const resp = await fetch(fetchUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url,
          method: options?.method,
          headers: options?.headers,
          body: options?.body,
        }),
      });
      const data = await resp.json();
      if (!data.success)
        throw new Error(apiErrorMessage(data, 'Server fetch failed'));
      return {
        status: data.status,
        contentType: data.contentType,
        body: data.body,
      } as { status: number; contentType: string; body: string };
    },
    [],
  );
}
