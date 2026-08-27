import {
  requireE2EBrowserSessionCredential,
  requireE2EOperatorCredential,
} from './e2e-operator-credential';

export interface E2EBrowserStorageStateOptions {
  baseURL: string;
  establishedUser: boolean;
  browserSessionCredential?: string;
  operatorCredential?: string;
  runnerOwned: boolean;
}

export function buildE2EBrowserStorageState({
  baseURL,
  establishedUser,
  browserSessionCredential,
  operatorCredential,
  runnerOwned,
}: E2EBrowserStorageStateOptions) {
  if (!runnerOwned) return undefined;
  const credential = requireE2EOperatorCredential(operatorCredential);
  const sessionCredential = requireE2EBrowserSessionCredential(
    browserSessionCredential,
  );
  const origin = new URL(baseURL).origin;
  const connectionId = 'e2e-host';
  const profile = {
    profileVersion: 4,
    id: connectionId,
    name: 'Station E2E',
    url: origin,
    credentialRef: {
      credentialVersion: 1,
      kind: 'connection',
      id: connectionId,
    },
    credentialState: 'saved',
  };

  return {
    cookies: [
      {
        name:
          new URL(origin).protocol === 'https:'
            ? '__Host-station-device'
            : 'station-device',
        value: sessionCredential,
        domain: new URL(origin).hostname,
        path: '/',
        expires: Math.floor(Date.now() / 1_000) + 365 * 24 * 60 * 60,
        httpOnly: true,
        secure: new URL(origin).protocol === 'https:',
        sameSite: 'Strict' as const,
      },
    ],
    origins: [
      {
        origin,
        localStorage: [
          ...(establishedUser
            ? [
                {
                  name: 'station:onboarding-setup-dismissed',
                  value: '1',
                },
              ]
            : []),
          {
            name: 'station-connect-connections',
            value: JSON.stringify([profile]),
          },
          {
            name: 'station-connect-connections-active',
            value: connectionId,
          },
          // Playwright storage state cannot initialize sessionStorage. Connect
          // moves this credential map into its session vault and removes this
          // local copy before constructing the first ConnectionStore snapshot.
          {
            name: 'station-connect-connections-credentials',
            value: JSON.stringify({
              [`connection:${connectionId}`]: credential,
            }),
          },
        ],
      },
    ],
  };
}
