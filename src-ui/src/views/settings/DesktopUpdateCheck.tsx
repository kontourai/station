import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { Button } from '../../components/Button';
import {
  checkForDesktopUpdate,
  type DesktopUpdateOutcome,
} from '../../platform/native/desktopUpdate';
import { usePlatformProfile } from '../../platform/PlatformProfileContext';

/** Explicit checks report failures; the automatic launch check stays quiet. */
export function DesktopUpdateCheck() {
  const { target } = usePlatformProfile();
  const owned = useRef<Extract<
    DesktopUpdateOutcome,
    { status: 'update-available' }
  > | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      void owned.current?.dispose().catch(console.debug);
      owned.current = null;
    };
  }, []);
  const check = useQuery({
    queryKey: ['desktop-update', 'manual'],
    queryFn: async ({ signal }) => {
      const result = await checkForDesktopUpdate();
      const available = result.status === 'update-available' ? result : null;
      if (!mounted.current || signal.aborted) {
        await available?.dispose();
      } else {
        void owned.current?.dispose().catch(console.debug);
        owned.current = available;
      }
      return result;
    },
    enabled: false,
    retry: false,
    gcTime: 0,
  });
  const install = useMutation({
    mutationFn: async () => {
      if (check.data?.status === 'update-available') {
        await check.data.install();
      }
    },
    retry: false,
  });

  return (
    <div className="settings__update-check">
      <Button
        disabled={check.isFetching || install.isPending}
        onClick={() => {
          install.reset();
          void check.refetch();
        }}
      >
        {check.isFetching
          ? 'Checking for desktop app updates…'
          : 'Check for desktop app updates'}
      </Button>
      {!check.isFetching && check.data?.status === 'update-available' && (
        <>
          <p role="status">
            Desktop app version {check.data.version} is available.
          </p>
          <Button disabled={install.isPending} onClick={() => install.mutate()}>
            {install.isPending
              ? 'Installing desktop app update…'
              : 'Install desktop app update and restart'}
          </Button>
        </>
      )}
      {!check.isFetching && check.data?.status === 'no-update' && (
        <p role="status">
          No desktop app update was offered by this app’s configured release
          channel.
        </p>
      )}
      {!check.isFetching &&
        (check.isError || check.data?.status === 'check-failed') && (
          <p role="alert">
            Could not check for desktop updates. Check your connection and try
            again. This build may not have an update channel configured.
          </p>
        )}
      {install.isError && (
        <p role="alert">Could not install the update. Try installing again.</p>
      )}
      <span className="settings__field-hint">
        Updates Station on this {target === 'macos' ? 'Mac' : 'device'},
        including its built-in server, then restarts the app.
      </span>
    </div>
  );
}
