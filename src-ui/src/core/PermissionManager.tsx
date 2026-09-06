import type { PluginPermissionPrompt } from '@kontourai/station-contracts/plugin';
import { authenticatedFetch } from '@kontourai/station-sdk';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from 'react';
import { PermissionRequestModal } from '../components/modals/PermissionRequestModal';
import { useApiBase } from '../contexts/ApiBaseContext';
import { useNativeConsentBroker } from '../platform/native/useNativeConsentBroker';

// ── Types ──────────────────────────────────────────────

interface ConsentRequest {
  pluginName: string;
  displayName: string;
  permissions: PluginPermissionPrompt[];
  /**
   * archive#4288. `true` when the plugin is NOT installed yet and the answer
   * decides whether it gets installed at all. Approving records nothing here:
   * there is no tree to bind a grant to, and grants bind to content. The
   * decision travels with `POST /install`, which grants what it covers once
   * the tree is final.
   */
  decisionOnly: boolean;
  resolve: (granted: boolean) => void;
}

interface PermissionContextType {
  /** Show consent modal for a plugin's permissions. Returns true if user approved. */
  requestConsent: (
    pluginName: string,
    displayName: string,
    permissions: PluginPermissionPrompt[],
  ) => Promise<boolean>;
  /**
   * Ask BEFORE installing (archive#4288). Same chrome, but it only returns
   * the decision — no grant is written and no host approval is opened,
   * because the plugin does not exist yet. The caller carries the answer into
   * the install, which is what refuses to mutate without it.
   */
  requestInstallConsent: (
    pluginName: string,
    displayName: string,
    permissions: PluginPermissionPrompt[],
  ) => Promise<boolean>;
  /** Grant permissions on the server */
  grantPermissions: (
    pluginName: string,
    permissions: string[],
  ) => Promise<void>;
}

const PermissionContext = createContext<PermissionContextType | null>(null);

type HostApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired';

const wait = (milliseconds: number) =>
  new Promise((resolve) => window.setTimeout(resolve, milliseconds));

// ── Provider ───────────────────────────────────────────

export function PermissionManager({ children }: { children: ReactNode }) {
  const { apiBase } = useApiBase();
  const [pending, setPending] = useState<ConsentRequest | null>(null);
  // archive#3677: a Tauri host reviews trusted approvals in native OS
  // chrome — the WebView cannot reach the distinct-origin consent page on
  // some targets, and the native dialog is unscriptable by design.
  const reviewNatively = useNativeConsentBroker();

  const requestConsent = useCallback(
    (
      pluginName: string,
      displayName: string,
      permissions: PluginPermissionPrompt[],
    ): Promise<boolean> => {
      return new Promise((resolve) => {
        setPending({
          pluginName,
          displayName,
          permissions,
          decisionOnly: false,
          resolve,
        });
      });
    },
    [],
  );

  const requestInstallConsent = useCallback(
    (
      pluginName: string,
      displayName: string,
      permissions: PluginPermissionPrompt[],
    ): Promise<boolean> => {
      return new Promise((resolve) => {
        setPending({
          pluginName,
          displayName,
          permissions,
          decisionOnly: true,
          resolve,
        });
      });
    },
    [],
  );

  const grantPermissions = useCallback(
    async (pluginName: string, permissions: string[]) => {
      const response = await authenticatedFetch(
        `${apiBase}/api/plugins/${encodeURIComponent(pluginName)}/grant`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ permissions }),
        },
      );
      if (!response.ok) {
        let message = 'Permission grant failed';
        try {
          const body = await response.json();
          if (typeof body?.error === 'string') message = body.error;
        } catch {}
        throw new Error(message);
      }
    },
    [apiBase],
  );

  const requestTrustedApproval = useCallback(
    async (pluginName: string, permissions: string[]): Promise<boolean> => {
      const response = await authenticatedFetch(
        `${apiBase}/api/plugins/host-approvals`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pluginName, permissions }),
        },
      );
      const body = await response.json().catch(() => null);
      if (!response.ok || !body?.approval?.id) {
        throw new Error(body?.error || 'Could not create host approval');
      }

      if (reviewNatively) {
        // The native host reviews and decides with its OWN local-grant
        // credential; the returned status is the server-settled decision.
        // No popup exists on this path, so nothing here needs transient
        // activation.
        const outcome = await reviewNatively(body.approval.id);
        if (outcome.status !== 'ok') {
          throw new Error(
            outcome.status === 'error' ? outcome.message : outcome.reason,
          );
        }
        return outcome.value.status === 'approved';
      }

      // No browser way in, and no native path to take instead: the consent
      // listener is down for a caller that needed it (archive#3731). Say so
      // rather than opening a popup at nothing.
      if (!body.approval.reviewUrl) {
        throw new Error(
          'The consent review page is unavailable, so nothing was granted.',
        );
      }

      // archive#3677: the server mints an ABSOLUTE review URL on the
      // distinct-origin consent listener (same hostname, its own port) —
      // deliberately NOT this app's origin, so plugin code sharing our origin
      // cannot script the review page. `apiBase` stays only as the base for a
      // hypothetical relative URL; an absolute one passes through unchanged.
      const reviewTarget = new URL(body.approval.reviewUrl, apiBase);
      if (
        reviewTarget.protocol !== 'http:' &&
        reviewTarget.protocol !== 'https:'
      ) {
        throw new Error('Unexpected consent review URL');
      }
      const reviewUrl = reviewTarget.toString();
      const reviewWindow = window.open(
        'about:blank',
        `station-plugin-approval-${body.approval.id}`,
        'popup,width=620,height=760',
      );
      if (!reviewWindow) {
        throw new Error('Allow pop-ups to open the trusted approval page');
      }
      reviewWindow.opener = null;
      reviewWindow.location.replace(reviewUrl);

      const statusUrl = `${apiBase}/api/plugins/host-approvals/${encodeURIComponent(body.approval.id)}`;
      for (let attempt = 0; attempt < 600; attempt += 1) {
        await wait(500);
        const statusResponse = await authenticatedFetch(statusUrl);
        if (!statusResponse.ok) continue;
        const statusBody = await statusResponse.json().catch(() => null);
        const status = statusBody?.approval?.status as
          | HostApprovalStatus
          | undefined;
        if (status === 'approved') return true;
        if (status === 'denied' || status === 'expired') return false;
        if (reviewWindow.closed) return false;
      }
      return false;
    },
    [apiBase, reviewNatively],
  );

  const handleApprove = async () => {
    if (!pending) return;
    if (pending.decisionOnly) {
      // Nothing to write: the plugin is not installed, and a grant binds to
      // the content of an installed tree. The answer is the whole product of
      // this prompt.
      pending.resolve(true);
      setPending(null);
      return;
    }
    const trusted = pending.permissions
      .filter((permission) => permission.tier === 'trusted')
      .map((permission) => permission.permission);
    const direct = pending.permissions
      .filter((permission) => permission.tier !== 'trusted')
      .map((permission) => permission.permission);
    try {
      if (
        trusted.length > 0 &&
        !(await requestTrustedApproval(pending.pluginName, trusted))
      ) {
        pending.resolve(false);
        setPending(null);
        return;
      }
      if (direct.length > 0) {
        await grantPermissions(pending.pluginName, direct);
      }
      pending.resolve(true);
      setPending(null);
    } catch {
      pending.resolve(false);
      setPending(null);
    }
  };

  const handleDeny = () => {
    if (!pending) return;
    pending.resolve(false);
    setPending(null);
  };

  // archive#3796: one memoised value per provider — a fresh object literal
  // here republishes the context to every consumer on any render of this
  // provider, whatever the render was actually about.
  // This provider owns the consent modal's own state, so it re-renders on
  // every consent open/close and every native-broker resolution — none of
  // which changes what it PUBLISHES.
  const value = useMemo(
    () => ({ requestConsent, requestInstallConsent, grantPermissions }),
    [requestConsent, requestInstallConsent, grantPermissions],
  );

  return (
    <PermissionContext.Provider value={value}>
      {children}
      {pending && (
        <PermissionRequestModal
          request={pending}
          onApprove={handleApprove}
          onDeny={handleDeny}
        />
      )}
    </PermissionContext.Provider>
  );
}

export function usePermissions() {
  const ctx = useContext(PermissionContext);
  if (!ctx)
    throw new Error('usePermissions must be used within PermissionManager');
  return ctx;
}
