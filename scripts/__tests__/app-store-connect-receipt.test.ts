import { generateKeyPairSync, verify } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import {
  appStoreConnectErrorDetail,
  appStoreConnectRequest,
  assertCanonicalArtifactBuiltAt,
  createAppStoreConnectJwt,
  receiptArtifactProvenance,
  selectAppResource,
  selectBuildResources,
  selectInternalGroup,
  selectProcessedBuildResource,
} from '../app-store-connect-receipt.mjs';

const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });

describe('App Store Connect receipt authority', () => {
  test('keeps artifact build time distinct and canonical', () => {
    expect(() =>
      assertCanonicalArtifactBuiltAt('2026-08-30T12:00:00.000Z'),
    ).not.toThrow();
    expect(() =>
      assertCanonicalArtifactBuiltAt('2026-02-31T12:00:00.000Z'),
    ).toThrow(/artifact-built-at/);
  });
  test('attributes an artifact timestamp to the provider only after this run uploaded it', () => {
    const builtAt = '2026-08-30T12:00:00.000Z';
    expect(receiptArtifactProvenance('uploaded', builtAt)).toEqual({
      candidateArtifactBuiltAt: builtAt,
      providerArtifactBuiltAt: builtAt,
    });
    expect(receiptArtifactProvenance('reconciled', builtAt)).toEqual({
      candidateArtifactBuiltAt: builtAt,
      providerArtifactBuiltAt: null,
    });
  });
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

  test('reconciliation allows absent or one build and refuses ambiguity', () => {
    expect(selectBuildResources({ data: [] }, '10399')).toEqual([]);
    expect(
      selectBuildResources(
        {
          data: [
            { type: 'builds', id: 'one', attributes: { version: '10399' } },
          ],
        },
        '10399',
      ),
    ).toHaveLength(1);
    expect(() =>
      selectBuildResources(
        {
          data: [
            { type: 'builds', attributes: { version: '10399' } },
            { type: 'builds', attributes: { version: '10399' } },
          ],
        },
        '10399',
      ),
    ).toThrow(/at most one/);
  });

  test('accepts only the exact internal group', () => {
    const payload = {
      data: [
        {
          type: 'betaGroups',
          id: 'group-id',
          attributes: { name: 'Station Beta Internal', isInternalGroup: true },
        },
      ],
    };
    expect(
      selectInternalGroup(payload, {
        appId: 'app-id',
        groupId: 'group-id',
        groupName: 'Station Beta Internal',
      }).id,
    ).toBe('group-id');
    expect(() =>
      selectInternalGroup(
        {
          data: [
            {
              type: 'betaGroups',
              id: 'group-id',
              attributes: {
                name: 'Station Beta Internal',
                isInternalGroup: false,
              },
            },
          ],
        },
        {
          appId: 'app-id',
          groupId: 'group-id',
          groupName: 'Station Beta Internal',
        },
      ),
    ).toThrow(/exact internal group/);
  });
});

describe('appStoreConnectErrorDetail', () => {
  test('names the provider errors from a body or its text, bounded and in order', () => {
    const body = {
      errors: [
        { code: 'STATE_ERROR', detail: 'Export compliance is missing.' },
        { title: 'Build not eligible' },
        { code: 'ENTITY_ERROR' },
        { detail: 'a fourth error that is dropped' },
      ],
    };
    expect(appStoreConnectErrorDetail(body)).toBe(
      'Export compliance is missing.; Build not eligible; ENTITY_ERROR',
    );
    expect(appStoreConnectErrorDetail(JSON.stringify(body))).toBe(
      'Export compliance is missing.; Build not eligible; ENTITY_ERROR',
    );
    expect(
      appStoreConnectErrorDetail({ errors: [{ detail: 'x'.repeat(400) }] }),
    ).toHaveLength(300);
  });
  test('is empty for non-JSON, non-error, and malformed payloads', () => {
    expect(appStoreConnectErrorDetail('<html>')).toBe('');
    expect(appStoreConnectErrorDetail({ data: [] })).toBe('');
    expect(appStoreConnectErrorDetail({ errors: [{ detail: 7 }, null] })).toBe(
      '',
    );
    expect(appStoreConnectErrorDetail(undefined)).toBe('');
  });
  test('the beta-group assignment failure carries the provider detail (HTTP 422)', async () => {
    const { attachInternalGroup } = await import(
      '../app-store-connect-receipt.mjs'
    );
    const group = {
      data: [
        {
          type: 'betaGroups',
          id: 'group-1',
          attributes: {
            name: 'Station Nightly Internal',
            isInternalGroup: true,
          },
          relationships: { app: { data: { type: 'apps', id: 'app-1' } } },
        },
      ],
    };
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (input: URL | string, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`);
      if (url.includes('/v1/betaGroups?'))
        return new Response(JSON.stringify(group), { status: 200 });
      return new Response(
        JSON.stringify({
          errors: [
            { code: 'STATE_ERROR', detail: 'Export compliance is missing.' },
          ],
        }),
        { status: 422 },
      );
    });
    try {
      await expect(
        attachInternalGroup(
          [
            '--app-id',
            'app-1',
            '--build-id',
            'build-1',
            '--group-id',
            'group-1',
            '--group-name',
            'Station Nightly Internal',
            '--output',
            join(tmpdir(), 'unused.json'),
          ],
          {
            APPLE_API_ISSUER_ID: 'issuer',
            APPLE_API_KEY_ID: 'key',
            APPLE_API_PRIVATE_KEY: privateKey,
          },
        ),
      ).rejects.toThrow(
        'beta-group assignment returned HTTP 422: Export compliance is missing.',
      );
      expect(calls).toEqual([
        'GET /v1/betaGroups',
        'POST /v1/betaGroups/group-1/relationships/builds',
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
