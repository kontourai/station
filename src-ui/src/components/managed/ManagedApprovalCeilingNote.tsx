import { managedApprovalCeilingStatement } from '@kontourai/station-contracts/managed-policy';
import type { MouseEvent } from 'react';
import { useManagedApprovalCeiling } from '../../contexts/ManagedPolicyContext';
import { openExternalLink } from '../../platform/openExternalLink';

/**
 * #4518: the sentence an approval picker shows under a managed ceiling, with
 * the organization's support link as a "Get help" link (Settings' external
 * link pattern) rather than a bare URL. Renders nothing without a ceiling.
 */
export function ManagedApprovalCeilingNote({
  className,
  id,
}: {
  className?: string;
  id?: string;
}) {
  const { summary, ceiling } = useManagedApprovalCeiling();
  if (!summary || !ceiling) return null;
  const href = summary.supportUrl;
  // A plain anchor would navigate the native webview away from Station.
  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!href) return;
    event.preventDefault();
    void openExternalLink(href);
  };
  return (
    <p className={className} id={id}>
      {managedApprovalCeilingStatement(summary, ceiling)}{' '}
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
