/**
 * useServerEvents — single SSE connection to /events.
 * Dispatches server-pushed events to React Query invalidations and callbacks.
 */

import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import { fetchSSE } from '@kontourai/station-sdk';
import { randomCorrelationId } from '@kontourai/station-shared/random-id';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef } from 'react';
import {
  useApiBase,
  useHostRequestAuthorityScope,
} from '../contexts/ApiBaseContext';
import { navigationStore } from '../contexts/NavigationContext';
import { toastStore } from '../contexts/ToastContext';
import { deviceSettingsStore } from '../lib/device-settings-store';
import { playDeliveredNotificationSound } from '../lib/notification-sounds';

type EventHandler = (data: Record<string, unknown>) => void;

function reloadPluginRegistry(): void {
  void import('../core/PluginRegistry')
    .then(({ pluginRegistry }) => pluginRegistry.reload())
    .catch(() => {});
}

/**
 * Fixed toast display duration for a NOTIFICATION_DELIVERED event
 * (archive#1100 fix). Deliberately decoupled from
 * `Notification.ttl`: that field now has two live meanings —
 * the Web Push protocol TTL header (`push-payload-composer.ts`) and the
 * stored-record/inbox expiry (`NOTIFICATION_TTL_MS`,
 * `@kontourai/station-shared/notification-priority`), both sized in
 * minutes-to-hours (up to 24h for needs-input/failed). Reading `data.ttl`
 * here for toast duration — as this code used to — meant a job-failure
 * toast (job-failure now triggers a web push too, archive#1100) would
 * persist in the on-screen toast stack for up to 24 HOURS instead of a few
 * seconds. A fixed duration is simplest and matches how every other
 * `toastStore.show` call in this file already works (e.g.
 * `PLUGINS_UPDATES_AVAILABLE` hardcodes 10000ms, `BUILD_UPDATED` hardcodes
 * 0/sticky) — a clamp was considered and rejected: nothing in this codebase
 * intentionally sets `ttl` to signal a desired toast duration, so a clamp
 * would just let record-expiry values leak into toast display (capped, but
 * still coupled) for no benefit.
 */
export const NOTIFICATION_TOAST_DISPLAY_MS = 8000;

/**
 * NOTIFICATION_DELIVERED data handler: shows a toast for every delivered
 * notification except `approval-request` (which has its own dedicated
 * approval UI and would otherwise double-surface). Exported so it's
 * directly unit-testable without standing up the full SSE hook.
 */
export function handleNotificationDeliveredToast(
  data: Record<string, unknown>,
): void {
  const category = data.category;
  if (typeof category === 'string') {
    playDeliveredNotificationSound(
      category,
      deviceSettingsStore.get('featureSettings').notificationSounds,
    );
  }
  if (data.category === 'approval-request') {
    return;
  }
  const title = data.title as string | undefined;
  if (!title) return;
  const body = data.body as string | undefined;
  const metadata = data.metadata as Record<string, unknown> | undefined;
  toastStore.show(
    title + (body ? ` — ${body}` : ''),
    undefined,
    NOTIFICATION_TOAST_DISPLAY_MS,
    undefined,
    metadata,
  );
}

/** Apply an authorized personal-mode ui:navigate event through the shared seam. */
export function handleUiNavigate(data: Record<string, unknown>): void {
  const path = data.path;
  if (typeof path === 'string' && path.startsWith('/')) {
    navigationStore.navigate(path);
  }
}

/** Handlers that receive event data (for side-effects beyond query invalidation) */
const DATA_HANDLERS: Record<string, (data: Record<string, unknown>) => void> = {
  [SERVER_EVENTS.NOTIFICATION_DELIVERED]: handleNotificationDeliveredToast,
  [SERVER_EVENTS.PLUGINS_UPDATES_AVAILABLE]: (data) => {
    const count = data.count as number | undefined;
    const updates = data.updates as
      | Array<{
          name: string;
          currentVersion: string;
          latestVersion: string;
          source: string;
        }>
      | undefined;
    if (count && count > 0) {
      const detail = updates
        ?.map(
          (u) =>
            `${u.name}: ${u.currentVersion} → ${u.latestVersion} (${u.source})`,
        )
        .join('\n');
      toastStore.show(
        `${count} plugin update${count > 1 ? 's' : ''} available`,
        undefined,
        10000,
        [
          {
            label: 'View Updates',
            variant: 'primary',
            onClick: () => navigationStore.navigate('/plugins'),
          },
        ],
        { detail },
      );
    }
  },
  [SERVER_EVENTS.UI_NAVIGATE]: handleUiNavigate,
  [SERVER_EVENTS.BUILD_UPDATED]: () => {
    toastStore.show(
      'App updated — refresh to get the latest version',
      undefined,
      0,
      [
        {
          label: 'Refresh',
          variant: 'primary',
          onClick: () => window.location.reload(),
        },
      ],
    );
  },
};

const EVENT_HANDLERS: Record<string, (queryClient: any) => void> = {
  [SERVER_EVENTS.AGENTS_CHANGED]: (qc) =>
    qc.invalidateQueries({ queryKey: ['agents'], refetchType: 'none' }),
  [SERVER_EVENTS.ACP_STATUS]: (qc) => {
    qc.invalidateQueries({ queryKey: ['agents'] });
    qc.invalidateQueries({ queryKey: ['acp-connections'] });
    qc.invalidateQueries({ queryKey: ['system-status'] });
  },
  [SERVER_EVENTS.CONFIG_CHANGED]: (qc) => {
    qc.invalidateQueries({ queryKey: ['config'], refetchType: 'none' });
    qc.invalidateQueries({ queryKey: ['agents'], refetchType: 'none' });
  },
  [SERVER_EVENTS.RUNTIME_HEALTH_CHANGED]: (qc) => {
    qc.invalidateQueries({ queryKey: ['connections'] });
    qc.invalidateQueries({ queryKey: ['agents'] });
  },
  [SERVER_EVENTS.SYSTEM_STATUS_CHANGED]: (qc) =>
    qc.invalidateQueries({ queryKey: ['system-status'] }),
  [SERVER_EVENTS.PLUGINS_INSTALLED]: (qc) => {
    qc.invalidateQueries({ queryKey: ['plugins'] });
    qc.invalidateQueries({ queryKey: ['layouts'] });
    qc.invalidateQueries({ queryKey: ['agents'] });
    reloadPluginRegistry();
  },
  [SERVER_EVENTS.PLUGINS_UPDATED]: (qc) => {
    qc.setQueryData?.(['plugins'], []);
    qc.invalidateQueries({ queryKey: ['plugins'] });
    qc.invalidateQueries({ queryKey: ['layouts'] });
    reloadPluginRegistry();
  },
  // archive#3815: a withdrawn permission must stop working in
  // ALREADY-LOADED frames. `PluginRegistry` copies `permissions.granted` into
  // each loaded layout record, and `PluginFrameHost` authorizes frame
  // navigation and its authenticated API bridge against that snapshot — so
  // invalidating the `plugins` query alone left an open frame bridging with
  // a permission the panel had just reported as removed, until some
  // unrelated reload happened to refresh the registry.
  [SERVER_EVENTS.PLUGINS_GRANTS_CHANGED]: (qc) => {
    qc.setQueryData?.(['plugins'], []);
    qc.invalidateQueries({ queryKey: ['plugins'] });
    reloadPluginRegistry();
  },
  [SERVER_EVENTS.PLUGINS_REMOVED]: (qc) => {
    qc.setQueryData?.(['plugins'], []);
    qc.invalidateQueries({ queryKey: ['plugins'] });
    qc.invalidateQueries({ queryKey: ['layouts'] });
    reloadPluginRegistry();
  },
  [SERVER_EVENTS.PLUGINS_UPDATES_AVAILABLE]: (qc) => {
    qc.invalidateQueries({ queryKey: ['plugin-updates'] });
  },
  [SERVER_EVENTS.NOTIFICATION_DELIVERED]: invalidateInboxQueries,
  [SERVER_EVENTS.NOTIFICATION_DISMISSED]: invalidateInboxQueries,
  [SERVER_EVENTS.NOTIFICATION_UPDATED]: invalidateInboxQueries,
  [SERVER_EVENTS.NOTIFICATION_CLEARED]: invalidateInboxQueries,
  [SERVER_EVENTS.UI_NAVIGATE]: () => {},
};

// One UUID per browser document. Do not use sessionStorage: a window opened
// from another can clone its tab state and collapse two live tabs into one.
const serverEventClientSessionId = randomCorrelationId();

function invalidateInboxQueries(queryClient: {
  invalidateQueries: (options: { queryKey: string[] }) => unknown;
}) {
  queryClient.invalidateQueries({ queryKey: ['notifications'] });
  queryClient.invalidateQueries({ queryKey: ['attention'] });
}

export function invalidateQueriesForServerEvent(
  event: string,
  queryClient: {
    invalidateQueries: (options: any) => unknown;
    setQueryData?: (queryKey: readonly unknown[], value: unknown) => unknown;
  },
) {
  EVENT_HANDLERS[event]?.(queryClient);
}

export function useServerEvents(handlers?: Record<string, EventHandler>) {
  const { apiBase } = useApiBase();
  const requestAuthority = useHostRequestAuthorityScope();
  const authorityApiBase = requestAuthority?.apiBase;
  const authorityKey = requestAuthority?.authorityKey;
  const authorityIsCurrent = requestAuthority?.isCurrent;
  const subscriptionAuthority = useMemo(
    () =>
      authorityApiBase && authorityKey && authorityIsCurrent
        ? {
            apiBase: authorityApiBase,
            authorityKey,
            isCurrent: authorityIsCurrent,
          }
        : undefined,
    [authorityApiBase, authorityIsCurrent, authorityKey],
  );
  const queryClient = useQueryClient();
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    const url = `${apiBase}/events`;
    const authenticatedStream = fetchSSE(url, {
      authentication: 'required',
      headers: { 'X-Station-Client-Session': serverEventClientSessionId },
      // archive#1848: see `ensureOrchestrationEventStream.ts` — a ceiling
      // equal to the initial delay is a fixed poll, not a ladder.
      retryDelayMs: 3000,
      maxRetryDelayMs: 30_000,
      onMessage: (message) => {
        // This capture belongs to THIS subscription. Never resolve a fresh
        // authority here: a late event from A must not be adopted by B (or by
        // a later A generation) after the connection has changed.
        if (!subscriptionAuthority?.isCurrent()) return;
        const event = message.event;
        if (
          event === SERVER_EVENTS.ANSWER_ASSESSMENT_UPDATED ||
          event === SERVER_EVENTS.ANSWER_NARRATIVE_UPDATED
        ) {
          if (!authorityKey) return;
          try {
            const payload = JSON.parse(message.data);
            // Basis invalidation is a rare, exact-answer event. Keep its
            // parser and cache fence out of first paint, then recheck the
            // captured authority so an A-era event cannot mutate B after the
            // lazy boundary settles.
            void import('@kontourai/station-sdk/answer-assessment-events')
              .then(({ refreshAnswerAssessmentQueries }) => {
                if (!subscriptionAuthority.isCurrent()) return;
                refreshAnswerAssessmentQueries(
                  queryClient,
                  payload,
                  subscriptionAuthority,
                );
              })
              .catch(() => {});
          } catch {
            // A malformed scoped notification has no cache effect.
          }
          return;
        }
        if (EVENT_HANDLERS[event]) {
          invalidateQueriesForServerEvent(event, queryClient);
          // Also run data handler if one exists for this event
          if (DATA_HANDLERS[event]) {
            try {
              DATA_HANDLERS[event](JSON.parse(message.data));
            } catch {
              /* ignore parse errors */
            }
          }
        }
        if (event === SERVER_EVENTS.DATA_CHANGED) {
          try {
            const data = JSON.parse(message.data);
            const keys = data.keys as string[] | undefined;
            if (keys) {
              for (const key of keys) {
                queryClient.invalidateQueries({ queryKey: [key] });
              }
            }
          } catch {}
        }
        const handler = handlersRef.current?.[event];
        if (handler) {
          try {
            handler(JSON.parse(message.data));
          } catch {
            handler({});
          }
        }
      },
    });

    return () => {
      authenticatedStream.close();
    };
  }, [apiBase, authorityKey, queryClient, subscriptionAuthority]);
}
