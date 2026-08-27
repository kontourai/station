import { afterEach, describe, expect, it, vi } from 'vitest';
import { _setApiBase } from '../api-core';
import { fetchAvailableLayouts } from '../api-knowledge';
import {
  authenticatedFetch,
  CREDENTIAL_REPORT_DEADLINE_MS,
  getJson,
  mutateJson,
  StationCredentialConflictError,
  StationHttpError,
  StationReadOnlyError,
  setClientCredentialResolver,
} from '../client/http';

const CREDENTIAL = 'sdk-test-credential-not-for-production';

describe('authenticated client transport', () => {
  afterEach(() => {
    setClientCredentialResolver(undefined);
    vi.unstubAllGlobals();
  });

  it('drops stale host binding 200 and 401 responses before either credential reporter', async () => {
    let bindingCurrent = true;
    let release: ((response: Response) => void) | undefined;
    const onAuthenticated = vi.fn();
    const onUnauthorized = vi.fn();
    const transport = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    setClientCredentialResolver(() => ({
      origin: 'https://station.example.test',
      transport,
      transportBindingIsCurrent: () => bindingCurrent,
      onAuthenticated,
      onUnauthorized,
    }));

    const success = getJson('https://station.example.test/api/settings');
    await vi.waitFor(() => expect(release).toBeDefined());
    bindingCurrent = false;
    release?.(new Response('{}'));
    await expect(success).rejects.toMatchObject({
      name: 'StationRequestAuthorityError',
    });
    expect(onAuthenticated).not.toHaveBeenCalled();

    bindingCurrent = true;
    const rejection = mutateJson(
      'https://station.example.test/api/settings',
      'POST',
      {},
      {},
    );
    await vi.waitFor(() => expect(release).toBeDefined());
    bindingCurrent = false;
    release?.(new Response('{}', { status: 401 }));
    await expect(rejection).rejects.toMatchObject({
      name: 'StationRequestAuthorityError',
    });
    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('guards host binding before native dispatch and across owned body reads and clones', async () => {
    let bindingCurrent = false;
    const transport = vi.fn(async () => new Response('{"ok":true}'));
    setClientCredentialResolver(() => ({
      origin: 'https://station.example.test',
      transport,
      transportBindingIsCurrent: () => bindingCurrent,
    }));
    await expect(
      authenticatedFetch('https://station.example.test/api/settings'),
    ).rejects.toMatchObject({ name: 'StationRequestAuthorityError' });
    expect(transport).not.toHaveBeenCalled();

    bindingCurrent = true;
    const response = await authenticatedFetch(
      'https://station.example.test/api/settings',
    );
    const clone = response.clone();
    bindingCurrent = false;
    await expect(response.json()).rejects.toMatchObject({
      name: 'StationRequestAuthorityError',
    });
    await expect(clone.text()).rejects.toMatchObject({
      name: 'StationRequestAuthorityError',
    });
  });

  it('does not proxy an unrelated foreign-origin response for a stale host binding', async () => {
    const fetchMock = vi.fn(async () => new Response('{"public":true}'));
    vi.stubGlobal('fetch', fetchMock);
    setClientCredentialResolver(() => ({
      origin: 'https://station.example.test',
      transportBindingIsCurrent: () => false,
    }));
    const response = await getJson('https://public.example.test/health');
    expect(await response.json()).toEqual({ public: true });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('attaches Bearer credentials to a protected request on the saved origin', async () => {
    const fetchMock = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);

    await getJson('https://station.example.test/api/sessions', {
      credential: CREDENTIAL,
      credentialOrigin: 'https://station.example.test',
      authentication: 'required',
    } as any);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe('https://station.example.test/api/sessions');
    expect(
      new Headers((init as RequestInit).headers).get('Authorization'),
    ).toBe(`Bearer ${CREDENTIAL}`);
  });

  it('keeps the public handshake unauthenticated', async () => {
    const fetchMock = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);

    await getJson('https://station.example.test/.well-known/station/v1', {
      credential: CREDENTIAL,
      credentialOrigin: 'https://station.example.test',
      authentication: 'omit',
    } as any);

    const init = (fetchMock.mock.calls as unknown[][])[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).has('Authorization')).toBe(false);
  });

  it('never forwards a Station credential to another origin', async () => {
    const fetchMock = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);

    await getJson('https://plugin.example.test/resource', {
      credential: CREDENTIAL,
      credentialOrigin: 'https://station.example.test',
      authentication: 'required',
    } as any);

    const init = (fetchMock.mock.calls as unknown[][])[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).has('Authorization')).toBe(false);
  });

  it('reports a protected same-origin 401 through the credential resolver', async () => {
    const onUnauthorized = vi.fn();
    setClientCredentialResolver(() => ({
      credential: CREDENTIAL,
      origin: 'https://station.example.test',
      onUnauthorized,
    }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 401 })),
    );

    await getJson('https://station.example.test/api/sessions');

    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it('reports every accepted authenticated response so stale connection evidence can clear', async () => {
    const onAuthenticated = vi.fn();
    setClientCredentialResolver(() => ({
      credential: CREDENTIAL,
      origin: 'https://station.example.test',
      onAuthenticated,
    }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}')),
    );

    await getJson('https://station.example.test/api/settings');

    expect(onAuthenticated).toHaveBeenCalledOnce();
  });

  it('does not report a deliberately public 2xx as authenticated recovery', async () => {
    // `/.well-known/station/v1` answers 200 to an ANONYMOUS caller, and
    // `fetchEventStreamResumeCapability` / `fetchSessionEventWindowCapability`
    // both request it with `authentication: 'omit'`. Treating that 200 as
    // proof the Station accepted our credentials would retire the evidence of
    // a genuinely revoked session, which is the contradictory state
    // (chip "Connected" + banner "Request access") this callback exists to
    // remove.
    const onAuthenticated = vi.fn();
    setClientCredentialResolver(() => ({
      credential: CREDENTIAL,
      origin: 'https://station.example.test',
      onAuthenticated,
    }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}')),
    );

    await getJson('https://station.example.test/.well-known/station/v1', {
      authentication: 'omit',
    });

    expect(onAuthenticated).not.toHaveBeenCalled();

    // Same resolver, same origin, same 200 — only the `omit` declaration
    // differs, so this pins the discrimination rather than the plumbing.
    await getJson('https://station.example.test/api/settings');
    expect(onAuthenticated).toHaveBeenCalledOnce();
  });

  it('does not report a public 2xx write as authenticated recovery', async () => {
    const onAuthenticated = vi.fn();
    setClientCredentialResolver(() => ({
      credential: CREDENTIAL,
      origin: 'https://station.example.test',
      onAuthenticated,
    }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}')),
    );

    await mutateJson(
      'https://station.example.test/.well-known/station/v1/pairing/requests',
      'POST',
      { authentication: 'omit' },
      {},
    );

    expect(onAuthenticated).not.toHaveBeenCalled();
  });

  it('does not report a cross-origin 2xx as authenticated recovery', async () => {
    const onAuthenticated = vi.fn();
    setClientCredentialResolver(() => ({
      credential: CREDENTIAL,
      origin: 'https://station.example.test',
      onAuthenticated,
    }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}')),
    );

    await getJson('https://elsewhere.example.test/api/settings');

    expect(onAuthenticated).not.toHaveBeenCalled();
  });

  it('uses a host-owned transport without exposing a bearer to renderer headers', async () => {
    const transport = vi.fn(async () => new Response('{"ok":true}'));
    const browserFetch = vi.fn(async () => new Response('wrong transport'));
    vi.stubGlobal('fetch', browserFetch);
    setClientCredentialResolver(() => ({
      origin: 'https://station.example.test',
      transport,
    }));

    const response = await getJson('https://station.example.test/api/sessions');

    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(browserFetch).not.toHaveBeenCalled();
    expect(transport).toHaveBeenCalledWith(
      'https://station.example.test/api/sessions',
      expect.objectContaining({ method: 'GET' }),
    );
    const init = (transport.mock.calls as unknown[][])[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).has('Authorization')).toBe(false);
  });

  it('never dispatches an origin-scoped host transport to another origin', async () => {
    const transport = vi.fn(async () => new Response('native'));
    const browserFetch = vi.fn(async () => new Response('browser'));
    vi.stubGlobal('fetch', browserFetch);
    setClientCredentialResolver(() => ({
      origin: 'https://station.example.test',
      transport,
    }));

    await getJson('https://plugin.example.test/resource');

    expect(transport).not.toHaveBeenCalled();
    expect(browserFetch).toHaveBeenCalledOnce();
  });

  it('uses authenticated transport and exposes a status-bearing error for the layout catalog', async () => {
    const onUnauthorized = vi.fn();
    _setApiBase('https://station.example.test');
    setClientCredentialResolver(() => ({
      credential: CREDENTIAL,
      origin: 'https://station.example.test',
      onUnauthorized,
    }));
    const fetchMock = vi.fn(async () => new Response('{}', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchAvailableLayouts()).rejects.toMatchObject({
      name: 'StationHttpError',
      status: 401,
    } satisfies Partial<StationHttpError>);
    expect(onUnauthorized).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      'https://station.example.test/api/projects/layouts/available',
    );
    const headers = new Headers((init as RequestInit).headers);
    expect(headers.get('Authorization')).toBe(`Bearer ${CREDENTIAL}`);
    expect(headers.get('X-Station-Client-Origin')).toBe('1;unknown');
    expect(headers.get('x-station-plugin')).toBe('');
  });

  it('keeps valid catalog items and discards malformed optional entries', async () => {
    _setApiBase('https://station.example.test');
    const valid = {
      id: 'builtin:coding',
      source: 'builtin',
      name: 'Coding',
      slug: 'coding',
      type: 'coding',
      sourceIdentity: { id: 'builtin', kind: 'builtin' },
      contribution: {
        id: 'builtin:coding',
        version: '1.0.0',
        sourceIdentity: { id: 'builtin', kind: 'builtin' },
        provenance: { origin: 'builtin' },
      },
      lifecycle: { itemId: 'builtin:coding', state: 'installed' },
      visible: true,
      installable: false,
      enabled: true,
      policy: {},
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              success: true,
              data: [valid, { id: 'plugin:broken' }],
            }),
            { headers: { 'Content-Type': 'application/json' } },
          ),
      ),
    );

    await expect(fetchAvailableLayouts()).resolves.toEqual([valid]);
  });

  it('rejects a malformed catalog envelope', async () => {
    _setApiBase('https://station.example.test');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ success: true, data: {} }), {
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    );

    await expect(fetchAvailableLayouts()).rejects.toThrow('invalid catalog');
  });

  it('allows reads but rejects stale mutations without queueing or replay', async () => {
    let mutationAllowed = false;
    setClientCredentialResolver(() => ({
      credential: CREDENTIAL,
      origin: 'https://station.example.test',
      mutationAllowed: () => mutationAllowed,
    }));
    const fetchMock = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);

    await authenticatedFetch('https://station.example.test/api/sessions');
    await expect(
      authenticatedFetch('https://station.example.test/api/sessions', {
        method: 'POST',
      }),
    ).rejects.toBeInstanceOf(StationReadOnlyError);
    expect(fetchMock).toHaveBeenCalledOnce();

    mutationAllowed = true;
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledOnce();
    await authenticatedFetch('https://station.example.test/api/sessions', {
      method: 'POST',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('a caller-supplied Authorization header (#3601)', () => {
  afterEach(() => {
    setClientCredentialResolver(undefined);
    vi.unstubAllGlobals();
  });

  /** The ambient resolver a mounted app installs, with both reporters. */
  function installResolver() {
    const onUnauthorized = vi.fn();
    const onAuthenticated = vi.fn();
    setClientCredentialResolver(() => ({
      credential: CREDENTIAL,
      origin: 'https://station.example.test',
      onUnauthorized,
      onAuthenticated,
    }));
    return { onUnauthorized, onAuthenticated };
  }

  it("is refused rather than sent under the ambient credential's name", async () => {
    // The request would be SENT with the caller's bearer and REPORTED against
    // the ambient one: a 401 answered to somebody else's credential would
    // delete this connection's, and a 2xx would retire the evidence that a
    // revoked credential is still revoked. Nothing derives a correct
    // attribution here, so the call must not be made at all.
    const { onUnauthorized, onAuthenticated } = installResolver();
    const fetchMock = vi.fn(async () => new Response('{}', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      getJson('https://station.example.test/api/sessions', {
        headers: { Authorization: 'Bearer someone-elses-credential' },
      }),
    ).rejects.toBeInstanceOf(StationCredentialConflictError);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(onAuthenticated).not.toHaveBeenCalled();
  });

  it('names the supported explicit-credential option', async () => {
    installResolver();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}')),
    );

    let message = '';
    try {
      await mutateJson(
        'https://station.example.test/api/sessions',
        'POST',
        { headers: { Authorization: 'Bearer someone-elses-credential' } },
        { body: true },
      );
    } catch (thrown) {
      message = (thrown as Error).message;
    }

    expect(message).toContain('credentialOrigin');
    expect(message).toContain("authentication: 'omit'");
  });

  it('still sends an explicit per-call credential, which opts out of the ambient one', async () => {
    // `credential` + `credentialOrigin` is the supported way to send a
    // different credential: `resolveRequestCredential` returns nothing for it,
    // so no reporter is handed a subject it does not belong to.
    const { onUnauthorized, onAuthenticated } = installResolver();
    const fetchMock = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);

    await getJson('https://station.example.test/api/sessions', {
      credential: 'a-different-credential',
      credentialOrigin: 'https://station.example.test',
    });

    const init = (fetchMock.mock.calls as unknown[][])[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get('Authorization')).toBe(
      'Bearer a-different-credential',
    );
    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(onAuthenticated).not.toHaveBeenCalled();
  });

  it('allows a raw header on a deliberately public request, which attributes nothing', async () => {
    const { onAuthenticated } = installResolver();
    const fetchMock = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);

    await getJson('https://station.example.test/.well-known/station/v1', {
      authentication: 'omit',
      headers: { Authorization: 'Bearer a-pairing-code-not-for-production' },
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(onAuthenticated).not.toHaveBeenCalled();
  });

  it('allows a raw header for ANOTHER origin, which this connection never reports on', async () => {
    installResolver();
    const fetchMock = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);

    await getJson('https://plugin.example.test/resource', {
      headers: { Authorization: 'Bearer a-plugin-credential' },
    });

    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe('authenticatedFetch and a caller Authorization header (#3601 review)', () => {
  afterEach(() => {
    setClientCredentialResolver(undefined);
    vi.unstubAllGlobals();
  });

  it("refuses when an ambient DEVICE SESSION would be credited with the caller's header", async () => {
    // The device-session shape the review named: the resolver has no bearer
    // string, so the caller's header survived all the way to the wire while
    // both reporters still answered for the ambient credential — a 401 would
    // have deleted a session that never authenticated that request.
    const onUnauthorized = vi.fn();
    const onAuthenticated = vi.fn();
    setClientCredentialResolver(() => ({
      origin: 'https://station.example.test',
      onUnauthorized,
      onAuthenticated,
    }));
    const fetchMock = vi.fn(async () => new Response('{}', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      authenticatedFetch('https://station.example.test/api/pairing/offers', {
        method: 'POST',
        headers: { Authorization: 'Bearer an-operator-credential' },
      }),
    ).rejects.toBeInstanceOf(StationCredentialConflictError);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(onAuthenticated).not.toHaveBeenCalled();
  });

  it('sees an Authorization header hidden in a Request object', async () => {
    setClientCredentialResolver(() => ({
      origin: 'https://station.example.test',
      onUnauthorized: vi.fn(),
    }));
    const fetchMock = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      authenticatedFetch(
        new Request('https://station.example.test/api/sessions', {
          headers: { Authorization: 'Bearer an-operator-credential' },
        }),
      ),
    ).rejects.toBeInstanceOf(StationCredentialConflictError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the native host-owned transport path working, header and all', async () => {
    // `PairedDevicesPanel` hands `authenticatedFetch` to its device-management
    // calls, and on a native shell the host owns the bearer. The resolved
    // credential wins over the caller's header, which is what both reporters
    // are about, so request and report still agree — this must not refuse.
    const transport = vi.fn(async () => new Response('{}'));
    setClientCredentialResolver(() => ({
      credential: CREDENTIAL,
      origin: 'https://station.example.test',
      transport,
    }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('should not be used')),
    );

    const response = await authenticatedFetch(
      'https://station.example.test/api/pairing/devices',
      { headers: { Authorization: 'Bearer an-operator-credential' } },
    );

    expect(response.ok).toBe(true);
    expect(transport).toHaveBeenCalledOnce();
    const init = (transport.mock.calls as unknown[][])[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get('Authorization')).toBe(
      `Bearer ${CREDENTIAL}`,
    );
  });

  it('leaves a raw header for another origin alone', async () => {
    // The web pairing panels talk to a Station that is not the ambient one
    // through plain `fetch`; anything reaching here for a different origin
    // never had a report to get wrong.
    setClientCredentialResolver(() => ({
      origin: 'https://station.example.test',
      onUnauthorized: vi.fn(),
    }));
    const fetchMock = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);

    const response = await authenticatedFetch(
      'https://other-station.example.test/api/pairing/offers',
      { headers: { Authorization: 'Bearer a-pairing-code' } },
    );

    expect(response.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('leaves a raw header alone when no resolver is installed at all', async () => {
    // The CLI shape: raw `Authorization` on a loopback operator call with no
    // ambient resolver for that origin.
    const fetchMock = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);

    const response = await authenticatedFetch(
      'http://127.0.0.1:3141/api/pairing/offers',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer an-operator-credential' },
      },
    );

    expect(response.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe('fetch(request, init) header semantics (#3601 delta review)', () => {
  afterEach(() => {
    setClientCredentialResolver(undefined);
    vi.unstubAllGlobals();
  });

  it('lets a caller REPLACE an embedded Authorization by supplying init.headers', async () => {
    // `fetch(request, init)` replaces the request's header list when
    // `init.headers` is supplied; it does not merge. Merging both falsely
    // rejected a caller who removed an embedded `Authorization` exactly this
    // way, and sent embedded headers the caller had deliberately dropped.
    setClientCredentialResolver(() => ({
      origin: 'https://station.example.test',
      onUnauthorized: vi.fn(),
    }));
    const fetchMock = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);

    const response = await authenticatedFetch(
      new Request('https://station.example.test/api/sessions', {
        headers: {
          Authorization: 'Bearer an-embedded-credential',
          'X-Embedded': 'dropped',
        },
      }),
      { headers: { 'X-Replacement': 'kept' } },
    );

    expect(response.ok).toBe(true);
    const init = (fetchMock.mock.calls as unknown[][])[0]?.[1] as RequestInit;
    const sent = new Headers(init.headers);
    expect(sent.has('Authorization')).toBe(false);
    expect(sent.get('X-Replacement')).toBe('kept');
    expect(sent.has('X-Embedded')).toBe(false);
  });

  it('still reads the embedded headers when the caller supplies no init.headers', async () => {
    setClientCredentialResolver(() => ({
      origin: 'https://station.example.test',
      onUnauthorized: vi.fn(),
    }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}')),
    );

    await expect(
      authenticatedFetch(
        new Request('https://station.example.test/api/sessions', {
          headers: { Authorization: 'Bearer an-embedded-credential' },
        }),
        { method: 'GET' },
      ),
    ).rejects.toBeInstanceOf(StationCredentialConflictError);
  });
});

describe('the response boundary is ordered after the state it reports (#3602 delta review)', () => {
  afterEach(() => {
    setClientCredentialResolver(undefined);
    vi.unstubAllGlobals();
  });

  it('does not resolve a 401 before the rejection it reports has been applied', async () => {
    // A store that serializes writes across documents applies the transition
    // in a lock callback. Without awaiting the reporter, a caller that awaited
    // the request could still read the state the 401 replaced.
    let applied = false;
    let releaseTransition = () => {};
    const transition = new Promise<void>((resolve) => {
      releaseTransition = () => {
        applied = true;
        resolve();
      };
    });
    setClientCredentialResolver(() => ({
      credential: CREDENTIAL,
      origin: 'https://station.example.test',
      onUnauthorized: () => transition,
    }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 401 })),
    );

    let resolved = false;
    const request = authenticatedFetch(
      'https://station.example.test/api/boot',
    ).then((response) => {
      resolved = true;
      return response;
    });
    // A macrotask drains every microtask the request path has of its own, so
    // this is "the response has had every chance to resolve" rather than "two
    // ticks have passed" — which a `void` reporter would sail through.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(resolved, 'the response resolved before the store transition').toBe(
      false,
    );

    releaseTransition();
    await request;
    expect(applied).toBe(true);
  });

  it('does not resolve a recovery before the acceptance it reports has been applied', async () => {
    let releaseTransition = () => {};
    const transition = new Promise<void>((resolve) => {
      releaseTransition = resolve;
    });
    setClientCredentialResolver(() => ({
      credential: CREDENTIAL,
      origin: 'https://station.example.test',
      onAuthenticated: () => transition,
    }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}')),
    );

    let resolved = false;
    const request = getJson('https://station.example.test/api/settings').then(
      (response) => {
        resolved = true;
        return response;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(resolved).toBe(false);

    releaseTransition();
    await request;
    expect(resolved).toBe(true);
  });
});

describe('the post-response wait for a transition is bounded (#3602 delta review 2)', () => {
  afterEach(() => {
    setClientCredentialResolver(undefined);
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('resolves the 401 on the deadline when the transition never completes, and says so once', async () => {
    // A contended Web Lock neither rejects nor times out, so a wedged
    // same-origin holder could otherwise delay this response — and the
    // StationHttpError built from it — indefinitely. The request's own
    // deadline does not cover this phase: the response has already arrived.
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setClientCredentialResolver(() => ({
      credential: CREDENTIAL,
      origin: 'https://station.example.test',
      // Never settles: the lock holder is gone.
      onUnauthorized: () => new Promise<void>(() => {}),
    }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 401 })),
    );

    let resolved = false;
    const request = authenticatedFetch(
      'https://station.example.test/api/boot',
    ).then((response) => {
      resolved = true;
      return response;
    });

    await vi.advanceTimersByTimeAsync(CREDENTIAL_REPORT_DEADLINE_MS - 1);
    expect(resolved, 'the wait ended before its deadline').toBe(false);

    await vi.advanceTimersByTimeAsync(2);
    const response = await request;
    expect(response.status).toBe(401);
    const afterFirst = warn.mock.calls.length;
    expect(afterFirst).toBe(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain(
      String(CREDENTIAL_REPORT_DEADLINE_MS),
    );

    // A second deadline in the same process stays quiet — "logs once" is the
    // claim, and a per-request warning on a wedged lock would be a flood.
    const second = authenticatedFetch('https://station.example.test/api/boot');
    await vi.advanceTimersByTimeAsync(CREDENTIAL_REPORT_DEADLINE_MS + 1);
    await second;
    expect(warn.mock.calls.length).toBe(afterFirst);
  });

  it('still resolves as soon as a transition that DOES complete has been applied', async () => {
    // The bound must not become the normal path: a transition that settles
    // promptly still orders the response after itself.
    vi.useFakeTimers();
    let applied = false;
    setClientCredentialResolver(() => ({
      credential: CREDENTIAL,
      origin: 'https://station.example.test',
      onAuthenticated: async () => {
        applied = true;
      },
    }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}')),
    );

    await getJson('https://station.example.test/api/settings');

    expect(applied).toBe(true);
    // No timer had to fire for that.
    expect(vi.getTimerCount()).toBe(0);
  });
});
