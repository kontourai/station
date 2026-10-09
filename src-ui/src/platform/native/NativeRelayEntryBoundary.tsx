import { useConnections } from '@kontourai/station-connect';
import type { ReactNode } from 'react';
import { LazyBoundary } from '../../components/LazyBoundary';
import { StartupScreen } from '../../components/StartupScreen';
import { usePlatformProfile } from '../PlatformProfileContext';

const loadMemberShell = () =>
  import('../../views/native-relay/NativeRelayMemberShell').then((module) => ({
    default: module.NativeRelayMemberShell,
  }));

/** Saved native routing intent selects this entry even before account sign-in. */
export function NativeRelayEntryBoundary({
  children,
}: {
  children: ReactNode;
}) {
  const profile = usePlatformProfile();
  const { activeConnection } = useConnections();
  if (!profile.isTauri || !activeConnection?.nativeBrokerRoute) return children;
  return (
    <LazyBoundary
      load={loadMemberShell}
      componentProps={{}}
      pending={<StartupScreen message="Opening shared Projects…" />}
    />
  );
}
