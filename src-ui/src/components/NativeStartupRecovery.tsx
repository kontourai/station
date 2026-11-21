import { FullScreenLoader } from '@kontourai/station-sdk';
import { StartupHandoff } from './StartupHandoff';

export function NativeStartupRecovery({ detail }: { detail: string }) {
  return (
    <>
      <StartupHandoff recovery />
      <FullScreenLoader
        label="Station"
        message="Station couldn’t finish starting"
        action={
          <>
            <p role="alert" aria-label="Station couldn’t finish starting">
              {detail}
            </p>
            <button type="button" onClick={() => window.location.reload()}>
              Reload Station
            </button>
          </>
        }
      />
    </>
  );
}
