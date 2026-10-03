import type { ReactNode } from 'react';
import { LazyBoundary } from '../../components/LazyBoundary';
import { SkeletonBlock } from '../../components/state';
import { usePlatformProfile } from '../PlatformProfileContext';

const loadIntake = () =>
  import('./NativeRelayLinkIntakeController').then((module) => ({
    default: module.NativeRelayLinkIntakeController,
  }));

export function NativeRelayLinkIntake({ children }: { children: ReactNode }) {
  const profile = usePlatformProfile();
  if (!profile.isTauri || profile.target !== 'ios') return children;
  return (
    <LazyBoundary
      load={loadIntake}
      componentProps={{ children }}
      pending={<SkeletonBlock label="Checking Station invitations" />}
    />
  );
}
