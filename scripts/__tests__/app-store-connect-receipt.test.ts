import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import {
  appStoreConnectRequest,
  createAppStoreConnectJwt,
  selectAppResource,
  selectProcessedBuildResource,
} from '../app-store-connect-receipt.mjs';

const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });

describe('App Store Connect receipt authority', () => {
  test('creates a bounded ES256 App Store Connect token', () => {
    const token = createAppStoreConnectJwt({
      issuerId: 'issuer-id',
      keyId: 'KEY123',
      privateKey,
      now: Date.parse('2026-08-29T00:00:00Z'),
    });
    const [header, claims, signature] = token.split('.');
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({
      alg: 'ES256',
      kid: 'KEY123',
      typ: 'JWT',
    });
    expect(JSON.parse(Buffer.from(claims, 'base64url').toString())).toEqual({
      iss: 'issuer-id',
      iat: 1_787_961_600,
      exp: 1_787_962_200,
      aud: 'appstoreconnect-v1',
    });
    expect(
      verify(
        'SHA256',
        Buffer.from(`${header}.${claims}`),
        { key: pair.publicKey, dsaEncoding: 'ieee-p1363' },
        Buffer.from(signature, 'base64url'),
      ),
    ).toBe(true);
  });

  test('selects exactly one matching app and one VALID build', () => {
    const app = selectAppResource(
      {
        data: [
          {
            type: 'apps',
            id: '6805330833',
            attributes: { bundleId: 'io.kontourai.station', name: 'Station' },
          },
        ],
      },
      'io.kontourai.station',
    );
    expect(app.id).toBe('6805330833');

    const build = selectProcessedBuildResource(
      {
        data: [
          {
            type: 'builds',
            id: 'build-id',
            attributes: { version: '10399', processingState: 'VALID' },
          },
        ],
      },
      '10399',
    );
    expect(build.id).toBe('build-id');
    expect(() =>
      selectProcessedBuildResource(
        {
          data: [
            {
              type: 'builds',
              id: 'build-id',
              attributes: { version: '10399', processingState: 'FAILED' },
            },
          ],
        },
        '10399',
      ),
    ).toThrow(/not VALID/);
  });

  test('fails closed on provider errors without echoing credentials', async () => {
    const response = new Response(
      JSON.stringify({ errors: [{ detail: 'The app is unavailable.' }] }),
      { status: 403 },
    );
    await expect(
      appStoreConnectRequest(
        '/v1/apps',
        { issuerId: 'issuer', keyId: 'key', privateKey },
        async () => response,
      ),
    ).rejects.toThrow('HTTP 403: The app is unavailable.');
  });

  test('rejects ambiguous or absent provider resources', () => {
    expect(() =>
      selectAppResource({ data: [] }, 'io.kontourai.station'),
    ).toThrow(/found 0/);
    expect(() =>
      selectProcessedBuildResource(
        {
          data: [
            { type: 'builds', attributes: { version: '10399' } },
            { type: 'builds', attributes: { version: '10399' } },
          ],
        },
        '10399',
      ),
    ).toThrow(/found 2/);
  });
});
