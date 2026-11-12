// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ClientCredential,
  StationRequestAuthorityError,
  setClientCredentialResolver,
} from '../client/http';
import { dispatchOrchestrationCommandWithReceipt } from '../query-domains/chatRuntimeOrchestration';

const API = 'https://station.example.test';
const scope = { apiBase: API, authorityKey: 'person-a' };
const command = { type: 'discardDraft' as const, threadId: 'draft-a' };
const success = () =>
  new Response(
    JSON.stringify({
      success: true,
      receipt: { commandId: 'discard-a', status: 'accepted' },
      data: null,
    }),
    { headers: { 'content-type': 'application/json' } },
  );

afterEach(() => {
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
});

describe('receipt command authority', () => {
  it('keeps the captured scope out of the public command and returns the receipt', async () => {
    setClientCredentialResolver(() => ({
      origin: API,
      credential: 'test-credential',
      requestAuthority: { ...scope, isCurrent: () => true },
    }));
    const request = vi.fn<typeof fetch>().mockResolvedValue(success());
    vi.stubGlobal('fetch', request);

    const result = await dispatchOrchestrationCommandWithReceipt(
      command,
      API,
      undefined,
      { requestScope: scope },
    );

    expect(result.receipt.commandId).toBe('discard-a');
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0][0]).toBe(`${API}/api/orchestration/commands`);
    expect(JSON.parse(String(request.mock.calls[0][1]?.body))).toEqual(command);
  });

  it('does not delete under a successor authority when credentials resolve after rotation', async () => {
    let resolve!: (credential: ClientCredential) => void;
    const credential = new Promise<ClientCredential>((finish) => {
      resolve = finish;
    });
    const resolver = vi.fn(() => credential);
    setClientCredentialResolver(resolver);
    const request = vi.fn<typeof fetch>().mockResolvedValue(success());
    vi.stubGlobal('fetch', request);
    let current = true;

    const pending = dispatchOrchestrationCommandWithReceipt(
      command,
      API,
      undefined,
      { requestScope: scope },
    );
    await vi.waitFor(() => expect(resolver).toHaveBeenCalled());
    current = false;
    resolve({
      origin: API,
      credential: 'old-test-credential',
      requestAuthority: { ...scope, isCurrent: () => current },
    });

    await expect(pending).rejects.toBeInstanceOf(StationRequestAuthorityError);
    expect(request).not.toHaveBeenCalled();
  });

  it('preserves callers that omit request options', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(success());
    vi.stubGlobal('fetch', request);

    const result = await dispatchOrchestrationCommandWithReceipt(command, API);

    expect(result.receipt.status).toBe('accepted');
    expect(request).toHaveBeenCalledOnce();
  });
});
