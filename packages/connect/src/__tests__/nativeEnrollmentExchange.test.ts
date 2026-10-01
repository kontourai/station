// @vitest-environment node
import {
  NATIVE_RELAY_ENROLLMENT_BEGIN_PATH,
  type NativeRelayEnrollmentPreparedRequest,
} from '@kontourai/station-contracts/native-relay-enrollment';
import { describe, expect, test, vi } from 'vitest';
import {
  type ApplicationChannel,
  serveApplicationChannel,
} from '../core/applicationChannel.js';
import {
  createNativeEnrollmentExchange,
  type NativeEnrollmentOpenedPeer,
} from '../core/nativeEnrollmentExchange.js';

const PEER_HANDLE = 'p'.repeat(43);
const REQUEST_HANDLE = 'r'.repeat(43);
const ORIGIN = 'https://station.test';

function fixture(
  response?: (request: Request) => Promise<Response> | Response,
) {
  const lifetime = new AbortController();
  const listeners: Array<
    { message: (value: unknown) => void; closed: () => void } | undefined
  > = [];
  let closed = false;
  const channels = [0, 1].map(
    (index): ApplicationChannel => ({
      send(value) {
        if (closed) throw new Error('closed fixture transport');
        queueMicrotask(() => {
          if (!closed) listeners[1 - index]?.message(value);
        });
      },
      close() {
        if (closed) return;
        closed = true;
        queueMicrotask(() => listeners.forEach((value) => value?.closed()));
      },
      subscribe(message, onClosed) {
        listeners[index] = { message, closed: onClosed };
        return () => {
          listeners[index] = undefined;
        };
      },
    }),
  );
  const dispatched = vi.fn(async (request: Request) => {
    if (response) return response(request);
    return Response.json({
      path: new URL(request.url).pathname,
      body: await request.text(),
    });
  });
  serveApplicationChannel(channels[1]!, ORIGIN, {
    signal: lifetime.signal,
    fetch: dispatched,
  });
  const peer: NativeEnrollmentOpenedPeer['peer'] = {
    peerHandle: PEER_HANDLE,
    expiresAt: Date.now() + 30_000,
    stationAudience: ORIGIN,
  };
  const assertCurrent = vi.fn(async () => {});
  const close = vi.fn(async () => channels[0]!.close());
  const open = vi.fn(async () => ({
    peer,
    channel: channels[0]!,
    assertCurrent,
    close,
  }));
  return {
    exchange: createNativeEnrollmentExchange({ signal: lifetime.signal, open }),
    open,
    dispatched,
    assertCurrent,
    close,
    isClosed: () => closed,
    signal: lifetime,
    channel: channels[0]!,
  };
}

function prepared(): NativeRelayEnrollmentPreparedRequest {
  return {
    version: 'station-native-enrollment-request/v1',
    requestHandle: REQUEST_HANDLE,
    peerHandle: PEER_HANDLE,
    method: 'POST',
    path: NATIVE_RELAY_ENROLLMENT_BEGIN_PATH,
    headers: { 'Content-Type': 'application/json' },
    body: '{"recipient":"public-only"}',
  };
}

describe('native enrollment one-request exchange', () => {
  test('prepares using the opened owner handle and forwards the retained request to host acceptance after EOF', async () => {
    const f = fixture();
    const prepare = vi.fn(async (handle: string) => {
      expect(handle).toBe(PEER_HANDLE);
      expect(f.open).toHaveBeenCalledOnce();
      return prepared();
    });
    const accept = vi.fn(async (handle, response, status) => {
      expect(f.isClosed()).toBe(true);
      expect(handle).toBe(REQUEST_HANDLE);
      expect(status).toBe(200);
      expect(response).toEqual({
        path: NATIVE_RELAY_ENROLLMENT_BEGIN_PATH,
        body: prepared().body,
      });
      return { hostAccepted: true };
    });
    await expect(f.exchange(prepare, accept)).resolves.toEqual({
      hostAccepted: true,
    });
    expect(f.dispatched).toHaveBeenCalledOnce();
    expect(f.close).toHaveBeenCalledOnce();
  });

  test('refuses an operation prepared for another peer before application dispatch', async () => {
    const f = fixture();
    await expect(
      f.exchange(
        async () => ({ ...prepared(), peerHandle: 'x'.repeat(43) }),
        vi.fn(),
      ),
    ).rejects.toThrow('native_enrollment_request_invalid');
    expect(f.dispatched).not.toHaveBeenCalled();
    expect(f.close).toHaveBeenCalledOnce();
  });

  test('freezes host-prepared bytes across the asynchronous currentness checkpoint', async () => {
    const f = fixture();
    const request = prepared();
    f.assertCurrent.mockImplementationOnce(async () => {});
    f.assertCurrent.mockImplementationOnce(async () => {
      Object.assign(request, {
        path: '/api/projects',
        body: '{"changed":true}',
      });
    });
    const accept = vi.fn(async (_handle, response) => response);
    await expect(f.exchange(async () => request, accept)).resolves.toEqual({
      path: NATIVE_RELAY_ENROLLMENT_BEGIN_PATH,
      body: prepared().body,
    });
  });

  test('refuses oversized channel replies before host acceptance and closes the owner', async () => {
    const f = fixture(() =>
      Response.json({ ciphertext: 'x'.repeat(65 * 1024) }),
    );
    const accept = vi.fn();
    await expect(f.exchange(async () => prepared(), accept)).rejects.toThrow(
      'native_enrollment_response_too_large',
    );
    expect(accept).not.toHaveBeenCalled();
    expect(f.close).toHaveBeenCalledOnce();
  });

  test('cancellation during host preparation releases the peer without sending application bytes', async () => {
    const f = fixture();
    let release:
      | ((value: NativeRelayEnrollmentPreparedRequest) => void)
      | undefined;
    const preparedResult = new Promise<NativeRelayEnrollmentPreparedRequest>(
      (resolve) => {
        release = resolve;
      },
    );
    const prepare = vi.fn(async () => {
      f.signal.abort();
      return preparedResult;
    });
    const accept = vi.fn();
    const outcome = f.exchange(prepare, accept);
    await expect(outcome).rejects.toThrow();
    release?.(prepared());
    expect(f.dispatched).not.toHaveBeenCalled();
    expect(accept).not.toHaveBeenCalled();
    expect(f.close).toHaveBeenCalledOnce();
  });

  test('releases the owned host peer even when synchronous channel cleanup throws', async () => {
    const f = fixture();
    f.close.mockResolvedValueOnce();
    f.channel.close = () => {
      throw new Error('channel_cleanup_failed');
    };
    await expect(
      f.exchange(
        async () => ({ ...prepared(), peerHandle: 'x'.repeat(43) }),
        vi.fn(),
      ),
    ).rejects.toThrow('channel_cleanup_failed');
    expect(f.close).toHaveBeenCalledOnce();
  });
});
