import { listStationTempEntries } from '@kontourai/station-shared/temp-dir';
import { describe, expect, test } from 'vitest';
import {
  startPionApplicationAdapter,
  validatePionAdapterProfile,
} from '../pion-application-adapter.js';

describe('production Pion application adapter ownership', () => {
  test('profiles fail closed and diagnostic echo cannot carry an application label', () => {
    expect(() => validatePionAdapterProfile(undefined, undefined)).toThrow(
      'pion_profile_required',
    );
    expect(() => validatePionAdapterProfile('application', undefined)).toThrow(
      'pion_application_label_required',
    );
    expect(() =>
      validatePionAdapterProfile('diagnosticEcho', 'application'),
    ).toThrow('pion_diagnostic_profile_invalid');
  });
  test('an untrusted executable is refused before Station temp custody is allocated', async () => {
    const before = await listStationTempEntries('pion-application');
    await expect(
      startPionApplicationAdapter({
        executable: 'relative-peer',
        profile: 'application',
        applicationChannelLabel: 'station-application-v1',
        offer: { type: 'offer', sdp: 'offer' },
        certificatePem: 'certificate',
        privateKeyPem: 'key',
        turn: {
          url: 'turn:127.0.0.1:1',
          username: 'user',
          password: 'password',
        },
        accept: () => {},
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('pion_executable_invalid');
    expect(await listStationTempEntries('pion-application')).toEqual(before);
  });
});
