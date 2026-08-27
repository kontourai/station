import type { PermissionTier } from '@kontourai/station-contracts/plugin';
import { authenticatedFetch } from '@kontourai/station-sdk';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from 'react';
import { useApiBase } from '../contexts/ApiBaseContext';
import { useNativeConsentBroker } from '../platform/native/useNativeConsentBroker';
import { describePermission } from './permission-vocabulary';

// ── Types ──────────────────────────────────────────────

interface PermissionRequest {
  permission: string;
  tier: PermissionTier;
}

interface ConsentRequest {
  pluginName: string;
  displayName: string;
  permissions: PermissionRequest[];
  /**
   * station#4288. `true` when the plugin is NOT installed yet and the answer
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
    permissions: PermissionRequest[],
  ) => Promise<boolean>;
  /**
   * Ask BEFORE installing (station#4288). Same chrome, but it only returns
   * the decision — no grant is written and no host approval is opened,
   * because the plugin does not exist yet. The caller carries the answer into
   * the install, which is what refuses to mutate without it.
   */
  requestInstallConsent: (
    pluginName: string,
    displayName: string,
    permissions: PermissionRequest[],
  ) => Promise<boolean>;
  /** Grant permissions on the server */
  grantPermissions: (
    pluginName: string,
    permissions: string[],
  ) => Promise<void>;
}

const PermissionContext = createContext<PermissionContextType | null>(null);

// ── Tier badge styling ─────────────────────────────────

const TIER_STYLES: Record<
  PermissionTier,
  { label: string; color: string; bg: string }
> = {
  passive: { label: 'Passive', color: '#22c55e', bg: '#22c55e20' },
  active: { label: 'Active', color: '#f59e0b', bg: '#f59e0b20' },
  trusted: { label: 'Trusted', color: '#ef4444', bg: '#ef444420' },
};

type HostApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired';

const wait = (milliseconds: number) =>
  new Promise((resolve) => window.setTimeout(resolve, milliseconds));

// ── Provider ───────────────────────────────────────────

export function PermissionManager({ children }: { children: ReactNode }) {
  const { apiBase } = useApiBase();
  const [pending, setPending] = useState<ConsentRequest | null>(null);
  // station#3677 PR 3: a Tauri host reviews trusted approvals in native OS
  // chrome — the WebView cannot reach the distinct-origin consent page on
  // some targets, and the native dialog is unscriptable by design.
  const reviewNatively = useNativeConsentBroker();

  const requestConsent = useCallback(
    (
      pluginName: string,
      displayName: string,
      permissions: PermissionRequest[],
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
      permissions: PermissionRequest[],
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
      // listener is down for a caller that needed it (station#3731). Say so
      // rather than opening a popup at nothing.
      if (!body.approval.reviewUrl) {
        throw new Error(
          'The consent review page is unavailable, so nothing was granted.',
        );
      }

      // station#3677: the server mints an ABSOLUTE review URL on the
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

  // station#3796: one memoised value per provider — a fresh object literal
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
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.6)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 10000,
          }}
        >
          {/* biome-ignore lint/a11y/noStaticElementInteractions: this dialog surface only shields backdrop dismissal; it is not an interactive control. */}
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard users do not need to activate a propagation shield. */}
          <div
            style={{
              background: 'var(--bg-primary, #1a1a2e)',
              borderRadius: 12,
              padding: '1.5rem',
              maxWidth: 480,
              width: '90%',
              boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ margin: '0 0 4px', fontSize: '1rem' }}>
              {pending.decisionOnly
                ? 'Install this plugin?'
                : 'Permission Request'}
            </h3>
            <p
              style={{
                margin: '0 0 1rem',
                fontSize: '13px',
                color: 'var(--text-secondary)',
              }}
            >
              <strong>{pending.displayName || pending.pluginName}</strong>
              {pending.decisionOnly
                ? ' has not been installed yet. Installing it requires:'
                : ' is requesting the following permissions:'}
            </p>

            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '8px',
                marginBottom: '1.25rem',
              }}
            >
              {pending.permissions.map((p) => {
                const style = TIER_STYLES[p.tier];
                return (
                  <div
                    key={p.permission}
                    style={{
                      padding: '10px 12px',
                      borderRadius: 8,
                      background: 'var(--bg-secondary)',
                      border: '1px solid var(--border-primary)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '10px',
                    }}
                  >
                    <span
                      style={{
                        fontSize: '10px',
                        fontWeight: 600,
                        padding: '2px 6px',
                        borderRadius: 4,
                        background: style.bg,
                        color: style.color,
                        border: `1px solid ${style.color}40`,
                        textTransform: 'uppercase',
                        letterSpacing: '0.5px',
                      }}
                    >
                      {style.label}
                    </span>
                    <div>
                      <div style={{ fontSize: '13px', fontWeight: 500 }}>
                        {p.permission}
                      </div>
                      <div
                        style={{ fontSize: '11px', color: 'var(--text-muted)' }}
                      >
                        {describePermission(p.permission)}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {pending.permissions.some((p) => p.tier === 'trusted') && (
              <div
                style={{
                  padding: '10px 12px',
                  marginBottom: '1rem',
                  borderRadius: 8,
                  background: '#ef444415',
                  border: '1px solid #ef444440',
                  fontSize: '12px',
                  color: '#fca5a5',
                }}
              >
                Trusted permissions can run server-side code or modify Station
                behavior.{' '}
                {pending.decisionOnly
                  ? 'They are not granted by installing: after the install, a separate host-owned review page — which plugin code cannot submit for you — decides them.'
                  : 'Approval opens a separate, host-owned review page that plugin code cannot submit for you.'}
              </div>
            )}

            <div
              style={{
                display: 'flex',
                gap: '8px',
                justifyContent: 'flex-end',
              }}
            >
              <button
                type="button"
                onClick={handleDeny}
                style={{
                  padding: '8px 16px',
                  borderRadius: 6,
                  fontSize: '13px',
                  border: '1px solid var(--border-primary)',
                  background: 'transparent',
                  color: 'var(--text-primary)',
                  cursor: 'pointer',
                }}
              >
                Deny
              </button>
              <button
                type="button"
                onClick={handleApprove}
                style={{
                  padding: '8px 16px',
                  borderRadius: 6,
                  fontSize: '13px',
                  border: 'none',
                  background: 'var(--accent-primary)',
                  color: 'white',
                  cursor: 'pointer',
                  fontWeight: 600,
                }}
              >
                {pending.decisionOnly
                  ? 'Install'
                  : pending.permissions.some((p) => p.tier === 'trusted')
                    ? 'Review trusted access'
                    : 'Approve'}
              </button>
            </div>
          </div>
        </div>
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
