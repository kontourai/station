import { managedRemoteClientsStatement } from '@kontourai/station-contracts/managed-policy-controls';
import type { ManagedPolicySummary } from '@kontourai/station-contracts/managed-policy-status';
import type { MouseEvent } from 'react';
import { openExternalLink } from '../../platform/openExternalLink';

/**
 * #4519: why this Station cannot pair other devices, with the policy's
 * support link as a "Get help" link (the managed Settings pattern) rather
 * than a bare URL.
 */
export function ManagedRemoteClientsNote({
  summary,
  className,
  id,
}: {
  summary: ManagedPolicySummary;
  className?: string;
  id?: string;
}) {
  const href = summary.supportUrl;
  // A plain anchor would navigate the native webview away from Station.
  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!href) return;
    event.preventDefault();
    void openExternalLink(href);
  };
  return (
    <p className={className} id={id}>
      {managedRemoteClientsStatement(summary)}{' '}
      {href ? (
        <a href={href} target="_blank" rel="noopener noreferrer" onClick={open}>
          Get help
        </a>
      ) : (
        'Contact your administrator for help.'
      )}
    </p>
  );
}
