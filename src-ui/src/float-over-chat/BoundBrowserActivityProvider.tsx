import type { ComponentProps } from 'react';
import { BrowserActivityProvider } from '../components/chat/BrowserActivityContext';
import { useHostRequestAuthorityScope } from '../contexts/ApiBaseContext';

/** Resolve the viewer's authority at the host adapter before admitting a bound conversation. */
export function BoundBrowserActivityProvider(
  props: Omit<ComponentProps<typeof BrowserActivityProvider>, 'hostAuthority'>,
) {
  const hostAuthority = useHostRequestAuthorityScope();
  const localScope =
    hostAuthority &&
    props.apiBase === hostAuthority.apiBase &&
    props.requestScope?.authorityKey === hostAuthority.authorityKey;
  return (
    <BrowserActivityProvider
      {...props}
      hostAuthority={hostAuthority}
      routeKind={props.routeKind ?? (localScope ? 'host' : undefined)}
    />
  );
}
