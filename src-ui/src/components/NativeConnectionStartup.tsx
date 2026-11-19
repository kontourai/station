import { type ComponentType, type ReactNode, useCallback } from 'react';
import { beforeNativeStartupDeadline } from '../platform/native/startupDeadline';
import { usePlatformProfile } from '../platform/PlatformProfileContext';
import { LazyBoundary } from './LazyBoundary';
import { NativeStartupRecovery } from './NativeStartupRecovery';
import { StartupScreen } from './StartupScreen';

const PAIRING_STAGE = 'Station pairing controls';

export function NativeConnectionStartup({
  children,
  nonMobileRecovery,
  load,
}: {
  children: ReactNode;
  nonMobileRecovery: ReactNode;
  load: () => Promise<{ default: ComponentType<{ children: ReactNode }> }>;
}) {
  const { isMobile } = usePlatformProfile();
  const loadPairing = useCallback(
    () => beforeNativeStartupDeadline(PAIRING_STAGE, load()),
    [load],
  );
  if (!isMobile) {
    return (
      <>
        {nonMobileRecovery}
        {children}
      </>
    );
  }
  return (
    <LazyBoundary
      load={loadPairing}
      componentProps={{ children }}
      pending={<StartupScreen message="Preparing Station pairing" />}
      unavailable={() => (
        <NativeStartupRecovery detail="Station pairing controls didn’t load." />
      )}
    />
  );
}
