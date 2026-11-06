import { afterEach, expect, test, vi } from 'vitest';
import {
  getJson,
  StationRequestAuthorityError,
  setClientCredentialResolver,
} from '../client/http';

const scopeA = {
  apiBase: 'https://station.example.test',
  authorityKey: 'connection-a:1',
};
const scopeB = {
  apiBase: 'https://station.example.test',
  authorityKey: 'connection-b:2',
};

afterEach(() => {
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
});

test('a scoped request fails closed before dispatch without matching resolver metadata', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  vi.stubGlobal('fetch', fetch);
  setClientCredentialResolver(() => ({ origin: scopeA.apiBase }));

  await expect(
    getJson(`${scopeA.apiBase}/api/tasks/task-a`, { requestScope: scopeA }),
  ).rejects.toBeInstanceOf(StationRequestAuthorityError);
  expect(fetch).not.toHaveBeenCalled();
});

test('one resolver settlement is checked before dispatch and cannot switch to another same-origin authority', async () => {
  let active = scopeA;
  const resolver = vi.fn(async () => {
    const captured = active;
    return {
      origin: captured.apiBase,
      requestAuthority: {
        ...captured,
        isCurrent: () => active === captured,
      },
    };
  });
  setClientCredentialResolver(resolver);
  const fetch = vi.fn<typeof globalThis.fetch>();
  vi.stubGlobal('fetch', fetch);
  const request = getJson(`${scopeA.apiBase}/api/tasks/task-a`, {
    requestScope: scopeA,
  });
  active = scopeB;

  await expect(request).rejects.toBeInstanceOf(StationRequestAuthorityError);
  expect(resolver).toHaveBeenCalledOnce();
  expect(fetch).not.toHaveBeenCalled();
});

test('a scope change during an owned response-body read cannot publish the body', async () => {
  let current = true;
  setClientCredentialResolver(() => ({
    origin: scopeA.apiBase,
    requestAuthority: { ...scopeA, isCurrent: () => current },
  }));
  let release!: (value: unknown) => void;
  const response = new Response('{"private":"old-authority"}');
  vi.spyOn(response, 'json').mockImplementation(
    () => new Promise((resolve) => (release = resolve)),
  );
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof globalThis.fetch>().mockResolvedValue(response),
  );

  const guarded = await getJson(`${scopeA.apiBase}/api/tasks/task-a`, {
    requestScope: scopeA,
  });
  const body = guarded.json();
  current = false;
  release({ private: 'old-authority' });
  await expect(body).rejects.toBeInstanceOf(StationRequestAuthorityError);
});

test.each(['reader', 'tee', 'iterator', 'transform'] as const)(
  '%s body consumption fences each pending chunk after a scope change',
  async (kind) => {
    let current = true;
    setClientCredentialResolver(() => ({
      origin: scopeA.apiBase,
      requestAuthority: { ...scopeA, isCurrent: () => current },
    }));
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const source = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(new Response(source)),
    );
    const response = await getJson(`${scopeA.apiBase}/api/events`, {
      requestScope: scopeA,
    });
    const body = response.body;
    if (!body || !controller) throw new Error('missing response stream');
    const branches = kind === 'tee' ? body.tee() : null;
    const stream =
      branches?.[0] ??
      (kind === 'transform'
        ? body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>())
        : body);
    const reader = kind === 'iterator' ? null : stream.getReader();
    const iterator =
      kind === 'iterator' ? stream[Symbol.asyncIterator]() : null;
    const next = () => (reader ? reader.read() : iterator!.next());
    const first = next();
    controller.enqueue(new TextEncoder().encode('current'));
    expect(await first).toMatchObject({
      done: false,
      value: new TextEncoder().encode('current'),
    });
    const pending = next();
    const rejected = expect(pending).rejects.toBeInstanceOf(
      StationRequestAuthorityError,
    );
    current = false;
    controller.enqueue(new TextEncoder().encode('retired'));
    await rejected;
    if (reader)
      await Promise.all([
        reader.cancel().catch(() => {}),
        branches?.[1].cancel(),
      ]);
    if (iterator) await iterator.return?.();
  },
);

test('a scoped body pipe cannot write a chunk after its authority retires', async () => {
  let current = true;
  setClientCredentialResolver(() => ({
    origin: scopeA.apiBase,
    requestAuthority: { ...scopeA, isCurrent: () => current },
  }));
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const cancelled = vi.fn();
  const source = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
    cancel: cancelled,
  });
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>().mockResolvedValue(new Response(source)),
  );
  const response = await getJson(`${scopeA.apiBase}/api/events`, {
    requestScope: scopeA,
  });
  const written = vi.fn();
  if (!response.body || !controller) throw new Error('missing response stream');
  const pending = response.body.pipeTo(
    new WritableStream<Uint8Array>({ write: written }),
  );
  const rejected = expect(pending).rejects.toBeInstanceOf(
    StationRequestAuthorityError,
  );
  current = false;
  controller.enqueue(new TextEncoder().encode('retired'));
  await rejected;
  expect(written).not.toHaveBeenCalled();
  expect(cancelled).toHaveBeenCalledOnce();
});
