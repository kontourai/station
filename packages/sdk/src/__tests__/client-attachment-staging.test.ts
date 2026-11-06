import {
  PUBLIC_HANDSHAKE_SCHEMA_VERSION,
  REMOTE_AUTH_PROTOCOL_VERSION,
  STATION_COMPAT_MIN_CLIENT_PROTOCOL,
  STATION_COMPAT_PROTOCOL_VERSION,
} from '@kontourai/station-contracts/environment-security';
import { PEER_CHAT_UPLOAD_GRANT_HEADER } from '@kontourai/station-contracts/peer-chat';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  getAttachmentStagingCapability,
  uploadAttachmentStage,
} from '../client/attachment-staging.js';
import {
  setClientCredentialResolver,
  setClientRawEgressPolicyResolver,
} from '../client/http.js';

const validHandshake = {
  schemaVersion: PUBLIC_HANDSHAKE_SCHEMA_VERSION,
  environmentId: 'station-fixture',
  authentication: {
    scheme: 'bearer',
    protocolVersion: REMOTE_AUTH_PROTOCOL_VERSION,
  },
  transports: {
    http: REMOTE_AUTH_PROTOCOL_VERSION,
    sse: REMOTE_AUTH_PROTOCOL_VERSION,
    websocket: REMOTE_AUTH_PROTOCOL_VERSION,
  },
  compatibility: {
    serverVersion: '0.4.1',
    protocolVersion: STATION_COMPAT_PROTOCOL_VERSION,
    minClientProtocol: STATION_COMPAT_MIN_CLIENT_PROTOCOL,
  },
};

describe('attachment staging client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setClientRawEgressPolicyResolver(undefined);
    setClientCredentialResolver(undefined);
  });

  test('allows inline fallback only after a valid Station handshake', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response('', {
            status: 404,
            headers: { 'x-station-attachment-handshake': 'inline-v1' },
          }),
        )
        .mockResolvedValueOnce(new Response(JSON.stringify(validHandshake))),
    );
    await expect(
      getAttachmentStagingCapability('http://station.test'),
    ).resolves.toEqual({ state: 'legacy' });
  });

  test('relay PUT uses scoped source auth and carries the receiver stage grant separately, with no fabricated progress', async () => {
    const source = 'http://station.test';
    const requestScope = { apiBase: source, authorityKey: 'source-lease' };
    const relay = `${source}/api/environments/peers/receiver/chat-api`;
    setClientCredentialResolver(() => ({
      origin: source,
      credential: 'source-device',
      requestAuthority: { ...requestScope, isCurrent: () => true },
    }));
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ stageId: 'stage-1' }));
    vi.stubGlobal('fetch', fetcher);
    const progress = vi.fn();
    const transport = vi.fn();
    await uploadAttachmentStage(
      relay,
      {
        stageId: 'stage-1',
        uploadGrant: 'receiver-grant',
        expiresAt: '2030-01-01T00:00:00.000Z',
        clientAttachmentId: 'one',
        kind: 'file',
        name: 'a.txt',
        mimeType: 'text/plain',
        size: 2,
      },
      'data:text/plain;base64,aGk=',
      { requestScope, onProgress: progress, transport },
    );
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(`${relay}/api/orchestration/attachment-staging/stage-1`);
    const headers = new Headers(init!.headers);
    expect(headers.get('Authorization')).toBe('Bearer source-device');
    expect(headers.get(PEER_CHAT_UPLOAD_GRANT_HEADER)).toBe('receiver-grant');
    expect(init!.body).toBe('data:text/plain;base64,aGk=');
    expect(transport).not.toHaveBeenCalled();
    expect(progress).not.toHaveBeenCalled();
  });

  test('blocks a misrouted 404 even when it carries the old header', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response('', {
            status: 404,
            headers: { 'x-station-attachment-handshake': 'inline-v1' },
          }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ not: 'station' })),
        ),
    );
    await expect(
      getAttachmentStagingCapability('http://station.test'),
    ).resolves.toEqual({ state: 'unknown' });
  });

  test('uses an injected upload transport and forwards native progress', async () => {
    const progress = vi.fn();
    setClientRawEgressPolicyResolver(() => ({
      kind: 'direct',
      apiBase: 'http://station.test',
      connectionId: 'direct-1',
      activationEpoch: 'selection-1',
      authorityKey: 'authority-1',
      isCurrent: () => true,
    }));
    const transport = vi.fn(async (request) => {
      request.onProgress?.({ loaded: 4, total: 8 });
      return new Response(
        JSON.stringify({
          stageId: 'stage-1',
          clientAttachmentId: 'file-1',
          source: 'current-composer',
          kind: 'file',
          name: 'notes.txt',
          mimeType: 'text/plain',
          size: 8,
          digest:
            'sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          expiresAt: '2030-01-01T00:00:00.000Z',
        }),
      );
    });
    await expect(
      uploadAttachmentStage(
        'http://station.test',
        {
          stageId: 'stage-1',
          uploadGrant: 'short-lived',
          expiresAt: '2030-01-01T00:00:00.000Z',
          clientAttachmentId: 'file-1',
          kind: 'file',
          name: 'notes.txt',
          mimeType: 'text/plain',
          size: 8,
        },
        'data:text/plain;base64,aGk=',
        {
          transport,
          onProgress: progress,
          requestScope: {
            apiBase: 'http://station.test',
            authorityKey: 'authority-1',
          },
        },
      ),
    ).resolves.toMatchObject({ stageId: 'stage-1' });
    expect(transport).toHaveBeenCalledWith(
      expect.objectContaining({ grant: 'short-lived' }),
    );
    expect(progress).toHaveBeenCalledWith({ loaded: 4, total: 8 });
  });

  test('refuses the explicit upload grant before raw transport on a broker route', async () => {
    const transport = vi.fn();
    setClientRawEgressPolicyResolver(() => ({
      kind: 'broker',
      apiBase: 'http://station.test',
      connectionId: 'broker-1',
      activationEpoch: 'selection-1',
      authorityKey: 'authority-1',
      isCurrent: () => true,
    }));

    await expect(
      uploadAttachmentStage(
        'http://station.test',
        {
          stageId: 'stage-1',
          uploadGrant: 'short-lived',
          expiresAt: '2030-01-01T00:00:00.000Z',
          clientAttachmentId: 'file-1',
          kind: 'file',
          name: 'notes.txt',
          mimeType: 'text/plain',
          size: 8,
        },
        'data:text/plain;base64,aGk=',
        { transport },
      ),
    ).rejects.toThrow(
      'Browser broker routes do not support direct attachment upload',
    );
    expect(transport).not.toHaveBeenCalled();
  });

  test('rejects a stale selection binding immediately before raw upload', async () => {
    const transport = vi.fn();
    setClientRawEgressPolicyResolver(() => ({
      kind: 'direct',
      apiBase: 'http://station.test',
      connectionId: 'direct-2',
      activationEpoch: 'selection-2',
      authorityKey: 'authority-2',
      isCurrent: () => true,
    }));

    await expect(
      uploadAttachmentStage(
        'http://station.test',
        {
          stageId: 'stage-1',
          uploadGrant: 'old-station-grant',
          expiresAt: '2030-01-01T00:00:00.000Z',
          clientAttachmentId: 'file-1',
          kind: 'file',
          name: 'notes.txt',
          mimeType: 'text/plain',
          size: 8,
        },
        'data:text/plain;base64,aGk=',
        {
          transport,
          requestScope: {
            apiBase: 'http://station.test',
            authorityKey: 'authority-1',
          },
        },
      ),
    ).rejects.toThrow('requested Station authority is no longer available');
    expect(transport).not.toHaveBeenCalled();
  });
});
