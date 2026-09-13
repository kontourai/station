export type TrayNavigationDestination =
  | 'connections'
  | 'pairedDevices'
  | 'coreUpdates'
  | 'desktopUpdates'
  | 'serverUpdates';

type TrayNavigationTarget = {
  pathname: string;
  params?: Record<string, string | null>;
};

const DESKTOP_UPDATES_TARGET: TrayNavigationTarget = {
  pathname: '/settings',
  params: { view: 'system', highlight: 'desktop-app-updates' },
};

const SERVER_UPDATES_TARGET: TrayNavigationTarget = {
  pathname: '/settings',
  params: { view: 'system', highlight: 'core-app-updates' },
};

const DESTINATION_TARGETS: Record<
  Exclude<TrayNavigationDestination, 'pairedDevices'>,
  TrayNavigationTarget
> = {
  connections: { pathname: '/connections' },
  coreUpdates: SERVER_UPDATES_TARGET,
  desktopUpdates: DESKTOP_UPDATES_TARGET,
  serverUpdates: SERVER_UPDATES_TARGET,
};

/**
 * A closed native-tray navigation contract. Native code can only request the
 * destinations represented here; it can never supply a path or query.
 * `coreUpdates` is the pre-split compatibility alias for the server card.
 */
export function trayNavigationTarget(
  payload: unknown,
): TrayNavigationTarget | null {
  if (
    payload === 'connections' ||
    payload === 'coreUpdates' ||
    payload === 'desktopUpdates' ||
    payload === 'serverUpdates'
  ) {
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
