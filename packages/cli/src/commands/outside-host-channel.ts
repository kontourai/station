// UNWIRED(#4115): composed by the inert outside-clients command until R6.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import {
  PUBLIC_DEVICE_PAIRING_LOCAL_GRANT_ELIGIBILITY_PATH,
  PUBLIC_DEVICE_PAIRING_LOCAL_GRANT_PATH,
} from '@kontourai/station-contracts/environment-security';
import {
  isLoopbackSelfAuthEndpoint,
  localGrantSecretPath,
} from './local-self-auth.js';
import {
  type ProfileCredentialStore,
  profileCredentialRef,
} from './profile-credentials.js';

/** The caller first verifies that this loopback listener owns the selected local home. */
export async function openOutsideHostChannel(input: {
  home: string;
  apiBase: string;
  credentialStore: ProfileCredentialStore;
  request: (
    apiBase: string,
    path: string,
    init?: RequestInit,
  ) => Promise<unknown>;
}) {
  if (!isAbsolute(input.home) || !isLoopbackSelfAuthEndpoint(input.apiBase))
    throw new Error(
      'Outside-client administration requires an explicit local home and loopback endpoint.',
    );
  const secret = readFileSync(localGrantSecretPath(input.home), 'utf8').trim();
  if (secret.length < 20 || secret.length > 100)
    throw new Error('Station’s local-grant secret has an unexpected length.');
  // A dedicated stable UUID supersedes this CLI's own prior device, never the desktop's.
  const identity = createHash('sha256')
    .update(JSON.stringify(['outside-clients', resolve(input.home)]))
    .digest('hex');
  const clientInstanceId = `${identity.slice(0, 8)}-${identity.slice(8, 12)}-5${identity.slice(13, 16)}-a${identity.slice(17, 20)}-${identity.slice(20, 32)}`;
  const ref = profileCredentialRef(
    `local-grant:outside-clients:${clientInstanceId}`,
  );
  const canCache = input.credentialStore.status(ref) !== 'unavailable';
  let credential = canCache ? input.credentialStore.get(ref) : undefined;
  const post = (path: string, body: unknown) =>
    input.request(input.apiBase, path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  if (credential) {
    // The owner-secret eligibility route checks live revocation without spending a mint slot.
    const eligibility = await post(
      PUBLIC_DEVICE_PAIRING_LOCAL_GRANT_ELIGIBILITY_PATH,
      { secret, credential },
    );
    if (
      !eligibility ||
      typeof eligibility !== 'object' ||
      !('eligible' in eligibility) ||
      typeof eligibility.eligible !== 'boolean'
    )
      throw new Error('Station refused host credential validation.');
    if (!eligibility.eligible) credential = undefined;
  }
  if (!credential) {
    const exchanged = await post(PUBLIC_DEVICE_PAIRING_LOCAL_GRANT_PATH, {
      secret,
      deviceName: 'Outside-client host CLI',
      clientInstanceId,
    });
    if (
      !exchanged ||
      typeof exchanged !== 'object' ||
      !('credential' in exchanged) ||
      typeof exchanged.credential !== 'string' ||
      !exchanged.credential ||
      exchanged.credential.length > 16 * 1024
    )
      throw new Error('Station refused host-possession proof.');
    credential = exchanged.credential;
    // OS keyring only. Without one, stable server-side supersession still bounds live credentials.
    if (canCache) input.credentialStore.set(ref, credential);
  }
  const bearer = credential;
  return {
    request: (path: string, init?: RequestInit) =>
      input.request(input.apiBase, path, {
        ...init,
        headers: {
          ...init?.headers,
          Authorization: `Bearer ${bearer}`,
          'x-station-host-proof': secret,
        },
      }),
  };
}
