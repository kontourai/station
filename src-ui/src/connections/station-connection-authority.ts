import type { ApiRequestScope } from '@kontourai/station-sdk/client';
import { StationRequestAuthorityError } from '@kontourai/station-sdk/client';

export interface StationConnectionAuthority {
  requestScope: ApiRequestScope;
  mutationAllowed: boolean;
  isCurrent(): boolean;
  release(): void;
}

type CaptureAuthority = (
  connectionId: string,
  sourceIsCurrent: () => boolean,
) => Promise<StationConnectionAuthority>;

let captureAuthority: CaptureAuthority | undefined;

/** Installed by the credential owner; the registry never handles credentials. */
export function installStationConnectionAuthorityCapture(
  capture: CaptureAuthority,
): () => void {
  captureAuthority = capture;
  return () => {
    if (captureAuthority === capture) captureAuthority = undefined;
  };
}

export function captureStationConnectionAuthority(
  connectionId: string,
  sourceIsCurrent: () => boolean = () => true,
): Promise<StationConnectionAuthority> {
  if (!captureAuthority) throw new StationRequestAuthorityError();
  return captureAuthority(connectionId, sourceIsCurrent);
}
