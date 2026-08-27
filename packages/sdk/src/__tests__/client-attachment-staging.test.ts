import {
  PUBLIC_HANDSHAKE_SCHEMA_VERSION,
  REMOTE_AUTH_PROTOCOL_VERSION,
  STATION_COMPAT_MIN_CLIENT_PROTOCOL,
  STATION_COMPAT_PROTOCOL_VERSION,
} from '@kontourai/station-contracts/environment-security';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  getAttachmentStagingCapability,
  uploadAttachmentStage,
} from '../client/attachment-staging.js';

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
  afterEach(() => vi.unstubAllGlobals());

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
        { transport, onProgress: progress },
      ),
    ).resolves.toMatchObject({ stageId: 'stage-1' });
    expect(transport).toHaveBeenCalledWith(
      expect.objectContaining({ grant: 'short-lived' }),
    );
    expect(progress).toHaveBeenCalledWith({ loaded: 4, total: 8 });
  });
});
