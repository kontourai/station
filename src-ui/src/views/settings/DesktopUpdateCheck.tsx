import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { Button } from '../../components/Button';
import {
  checkForDesktopUpdate,
  type DesktopUpdateOutcome,
} from '../../platform/native/desktopUpdate';

/** Explicit checks report failures; the automatic launch check stays quiet. */
export function DesktopUpdateCheck() {
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
        {check.isFetching ? 'Checking…' : 'Check for Desktop Updates'}
      </Button>
      {!check.isFetching && check.data?.status === 'update-available' && (
        <>
          <p role="status">Station {check.data.version} is available.</p>
          <Button disabled={install.isPending} onClick={() => install.mutate()}>
            {install.isPending ? 'Installing…' : 'Install and restart'}
          </Button>
        </>
      )}
      {!check.isFetching && check.data?.status === 'no-update' && (
        <p role="status">This desktop app is up to date.</p>
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
        Updates the app on this device from its signed release channel and
        restarts it. The connected Station server is checked separately below.
      </span>
    </div>
  );
}
