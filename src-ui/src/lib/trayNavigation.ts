export type TrayNavigationDestination =
  | 'connections'
  | 'pairedDevices'
  | 'coreUpdates';

export type TrayNavigationTarget = {
  pathname: string;
  params?: Record<string, string | null>;
};

const DESTINATION_TARGETS: Record<
  Exclude<TrayNavigationDestination, 'pairedDevices'>,
  TrayNavigationTarget
> = {
  connections: { pathname: '/connections' },
  coreUpdates: {
    pathname: '/settings',
    params: { view: 'system', highlight: 'core-app-updates' },
  },
};

/**
 * A closed native-tray navigation contract. Native code can only request the
 * two destinations represented here; it can never supply a path or query.
 */
export function trayNavigationTarget(
  payload: unknown,
): TrayNavigationTarget | null {
  if (payload === 'connections' || payload === 'coreUpdates') {
    return DESTINATION_TARGETS[payload];
  }
  return null;
}

export function subscribeToTrayNavigation(
  navigate: (pathname: string, params?: Record<string, string | null>) => void,
  openPairedDevices?: () => void,
  nativePromise = import('../platform/native').then(
    ({ nativePlatformPromise }) => nativePlatformPromise,
  ),
): () => void {
  let disposed = false;
  let subscription: { dispose(): void } | undefined;
  void nativePromise
    .then((native) =>
      native.subscribeToTrayNavigation(({ destination }) => {
        if (destination === 'pairedDevices') {
          if (!disposed) openPairedDevices?.();
          return;
        }
        const target = trayNavigationTarget(destination);
        if (!disposed && target) navigate(target.pathname, target.params);
      }),
    )
    .then((registered) => {
      subscription = registered;
      if (disposed) subscription.dispose();
    })
    .catch(() => {
      // Tray navigation is a convenience; a failed native listener cannot
      // degrade ordinary browser navigation or turn an invalid payload into UI.
    });

  return () => {
    disposed = true;
    subscription?.dispose();
  };
}
