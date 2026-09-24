import { existsSync, readFileSync } from 'node:fs';
import type { ApplicationChannel } from '@kontourai/station-connect/application-channel';
import { startPionApplicationAdapter } from '../../src-server/services/connections/pion-application-adapter.js';
export async function startPionFixture(input: {
  executable: string;
  directory: string;
  certificate: string;
  key: string;
  offer: { type: string; sdp: string };
  turnPort: number;
  username: string;
  password: string;
  signal?: AbortSignal;
  application?: { label: string; accept(channel: ApplicationChannel): void };
}) {
  if (input.offer.type !== 'offer')
    throw new Error('Pion fixture requires an offer');
  // A missing build must be diagnosed as a missing build, not as a missing
  // cert file: the binary check runs before any cert/key file read.
  if (!existsSync(input.executable))
    throw new Error('Build the Pion fixture before running --peer=pion');
  return await startPionApplicationAdapter({
    executable: input.executable,
    profile: input.application ? 'application' : 'diagnosticEcho',
    ...(input.application
      ? { applicationChannelLabel: input.application.label }
      : {}),
    offer: { type: 'offer', sdp: input.offer.sdp },
    certificatePem: readFileSync(input.certificate, 'utf8'),
    privateKeyPem: readFileSync(input.key, 'utf8'),
    turn: {
      url: `turn:127.0.0.1:${input.turnPort}?transport=tcp`,
      username: input.username,
      password: input.password,
    },
    accept: input.application?.accept ?? (() => {}),
    signal: input.signal ?? new AbortController().signal,
    maxLifetimeMs: 300_000,
  });
}
