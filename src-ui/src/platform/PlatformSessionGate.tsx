import type { ReactNode } from 'react';
import { LocalUiSessionGate } from '../components/LocalUiSessionGate';
import { usePlatformProfile } from './PlatformProfileContext';

/**
 * The web client resolves a local device session before mounting the
 * protected tree. The Tauri shell is never an HTTP Station at its own origin
 * (`tauri://localhost`), so it must not mount the gate that probes one.
 */
export function PlatformSessionGate({
  apiBase,
  children,
}: {
  apiBase: string;
  children: ReactNode;
}) {
  const profile = usePlatformProfile();
  return profile.isTauri ? (
    children
  ) : (
    <LocalUiSessionGate apiBase={apiBase}>{children}</LocalUiSessionGate>
  );
}
