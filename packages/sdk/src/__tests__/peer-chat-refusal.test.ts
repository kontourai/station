import { agentId } from '@kontourai/station-contracts/agent-identity';
import {
  STATION_ENVELOPE_HEADER,
  STATION_ENVELOPE_HEADER_VALUE,
} from '@kontourai/station-contracts/http';
import { PEER_CHAT_REFUSAL_CODE } from '@kontourai/station-contracts/peer-chat';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  sendExecutionMessageWithInventory,
  sentTurnKey,
  setClientCredentialResolver,
} from '../client/index';

const source = 'https://source.example.test';
const relay = `${source}/api/environments/peers/receiver/chat-api`;
const scope = { apiBase: source, authorityKey: 'source-lease' };
const input = {
  target: {
    environment: { kind: 'current' as const },
    agent: agentId('codex'),
  },
  message: 'Hello',
  clientTurnId: 'turn-one',
};
const observation = {
  success: false,
  code: PEER_CHAT_REFUSAL_CODE,
  error: 'Reconnect to the paired Station.',
  details: {
    version: 1,
    failureAuthority: 'target',
    environmentId: 'receiver',
    remoteStatus: 401,
    disposition: 'refused-before-dispatch',
    mutationKey: 'turn-one',
  },
};
afterEach(() => {
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
});

function client() {
  const unauthorized = vi.fn();
  setClientCredentialResolver(() => ({
    origin: source,
    credential: 'source-device',
    requestAuthority: { ...scope, isCurrent: () => true },
    onUnauthorized: unauthorized,
  }));
  const call = () =>
    sendExecutionMessageWithInventory(relay, input, vi.fn(), {
      requestScope: scope,
    });
  return { call, unauthorized };
}

describe('source-verified relay refusal through the public chat client', () => {
  test('a source-observed known pre-effect rejection is definite; arbitrary target codes stay uncertain', async () => {
    const { call } = client();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json(
          {
            ...observation,
            details: {
              ...observation.details,
              remoteStatus: 409,
              refusalCode: 'inbox_stale_head',
            },
          },
          {
            status: 424,
            headers: {
              [STATION_ENVELOPE_HEADER]: STATION_ENVELOPE_HEADER_VALUE,
            },
          },
        ),
      ),
    );
    await expect(call()).rejects.toMatchObject({
      status: 424,
      stationEnvelope: true,
      details: { remoteStatus: 409, refusalCode: 'inbox_stale_head' },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json(
          {
            success: false,
            error: '401 unauthorized',
            code: 'inbox_stale_head',
          },
          { status: 409 },
        ),
      ),
    );
    await expect(call()).rejects.toMatchObject({
      status: 409,
      stationEnvelope: false,
    });
  });
  test.each([401, 403])(
    'target %i is a bound refusal and never retires the source credential',
    async (remoteStatus) => {
      const { call, unauthorized } = client();
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          Response.json(
            {
              ...observation,
              details: { ...observation.details, remoteStatus },
            },
            {
              status: 424,
              headers: {
                [STATION_ENVELOPE_HEADER]: STATION_ENVELOPE_HEADER_VALUE,
              },
            },
          ),
        ),
      );
      const error = await call().catch((error: unknown) => error);
      expect(error).toMatchObject({
        status: 424,
        stationEnvelope: true,
        details: { remoteStatus },
      });
      expect(sentTurnKey(error)).toBe('turn-one');
      expect(unauthorized).not.toHaveBeenCalled();
    },
  );

  test.each([
    {
      name: 'wrong target',
      marked: true,
      details: { ...observation.details, environmentId: 'other' },
    },
    {
      name: 'wrong key',
      marked: true,
      details: { ...observation.details, mutationKey: 'other' },
    },
    {
      name: 'unknown disposition',
      marked: true,
      details: { ...observation.details, disposition: 'probably-refused' },
    },
    {
      name: 'raw unmarked target body',
      marked: false,
      details: observation.details,
    },
  ])('$name is indeterminate', async ({ marked, details }) => {
    const { call } = client();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json(
          { ...observation, details },
          {
            status: 424,
            headers: marked
              ? { [STATION_ENVELOPE_HEADER]: STATION_ENVELOPE_HEADER_VALUE }
              : {},
          },
        ),
      ),
    );
    const error = await call().catch((error: unknown) => error);
    expect(error).toMatchObject({ status: 424, stationEnvelope: false });
    expect(sentTurnKey(error)).toBe('turn-one');
  });

  test('source 401 still reaches its unauthorized handler', async () => {
    const { call, unauthorized } = client();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json(
          { success: false, error: 'Unauthorized' },
          {
            status: 401,
            headers: {
              [STATION_ENVELOPE_HEADER]: STATION_ENVELOPE_HEADER_VALUE,
            },
          },
        ),
      ),
    );
    await expect(call()).rejects.toMatchObject({
      status: 401,
      stationEnvelope: true,
    });
    expect(unauthorized).toHaveBeenCalledOnce();
  });

  test('a lost response preserves its original key without refusal evidence', async () => {
    const { call } = client();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new TypeError('Connection lost')),
    );
    const error = await call().catch((error: unknown) => error);
    expect(error).toBeInstanceOf(TypeError);
    expect(sentTurnKey(error)).toBe('turn-one');
    expect(error).not.toHaveProperty('stationEnvelope');
  });
});
