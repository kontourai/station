import type {
  PermissionTier,
  PluginPermissionPrompt,
} from '@kontourai/station-contracts/plugin';
import { describePermission } from '../../core/permission-vocabulary';
import { Button } from '../Button';
import { Dialog } from '../Dialog';

const TIER_STYLES: Record<
  PermissionTier,
  { label: string; color: string; bg: string; border: string }
> = {
  passive: {
    label: 'Passive',
    color: 'var(--success-text)',
    bg: 'var(--success-bg)',
    border: 'var(--success-border)',
  },
  active: {
    label: 'Active',
    color: 'var(--warning-text)',
    bg: 'var(--warning-bg)',
    border: 'var(--warning-border)',
  },
  trusted: {
    label: 'Trusted',
    color: 'var(--error-text)',
    bg: 'var(--error-bg)',
    border: 'var(--error-border)',
  },
};

export function PermissionRequestModal({
  request,
  onApprove,
  onDeny,
}: {
  request: {
    pluginName: string;
    displayName?: string;
    permissions: PluginPermissionPrompt[];
    decisionOnly?: boolean;
    recovery?: boolean;
  };
  onApprove: () => void | Promise<void>;
  onDeny: () => void;
}) {
  return (
    <Dialog
      title={
        request.recovery
          ? 'Recover this plugin?'
          : request.decisionOnly
            ? 'Install this plugin?'
            : 'Permission Request'
      }
      onClose={onDeny}
      closeLabel="Close permission request"
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onDeny}>
            Deny
          </Button>
          <Button onClick={onApprove}>
            {request.decisionOnly
              ? request.recovery
                ? 'Recover plugin'
                : 'Install'
              : request.permissions.some((p) => p.tier === 'trusted')
                ? 'Review trusted access'
                : 'Approve'}
          </Button>
        </>
      }
    >
      <p
        style={{
          margin: '0 0 1rem',
          fontSize: '13px',
          color: 'var(--text-secondary)',
        }}
      >
        <strong>{request.displayName || request.pluginName}</strong>
        {request.decisionOnly
          ? request.recovery
            ? ' has retained files awaiting activation. Recovery requires:'
            : ' has not been installed yet. Installing it requires:'
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
        {request.permissions.map((p) => {
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
                  border: `1px solid ${style.border}`,
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
                <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                  {describePermission(p.permission)}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {request.permissions.some((p) => p.tier === 'trusted') && (
        <div
          style={{
            padding: '10px 12px',
            marginBottom: '1rem',
            borderRadius: 8,
            background: 'var(--error-bg)',
            border: '1px solid var(--error-border)',
            fontSize: '12px',
            color: 'var(--error-text)',
          }}
        >
          Trusted permissions can run server-side code or modify Station
          behavior.{' '}
          {request.decisionOnly
            ? request.recovery
              ? 'This decision does not grant them; a separate host-owned review does, and plugin code can’t approve them.'
              : 'Installing does not grant them; they’re reviewed separately after install, and plugin code can’t approve them.'
            : 'Approval opens a separate, host-owned review page; plugin code can’t approve them.'}
        </div>
      )}
    </Dialog>
  );
}
