/** Context isolation only: pages are inert; no business authority is fabricated. */
import { createServer } from 'node:http';
import { expect, test } from 'vitest';
import {
  enableStationServerSelfAttestation,
  INTERNAL_SERVER_SELF_HEADER,
  runAsStationServer,
  stationServerScopeHeaders,
} from '../../../security/station-server-scope.js';
import { controlRequestOptions } from '../../../tools/station-control-shared.js';
import {
  createGroupStreamLifetime,
  type GroupPageIterator,
  type GroupStreamHint,
  watchGroupPages,
} from '../delegation-group-transport.js';

test('group stream callbacks cannot inherit server-self authority from creation, iteration, notification or abort', async ({
  signal,
}) => {
  const received: Array<{ stage: string; serverSelf: boolean }> = [];
  const receiver = createServer((request, response) => {
    received.push({
      stage: decodeURIComponent((request.url ?? '/').slice(1)),
      serverSelf: request.headers[INTERNAL_SERVER_SELF_HEADER] !== undefined,
    });
    response.writeHead(204);
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    receiver.once('error', reject);
    receiver.listen(0, '127.0.0.1', resolve);
  });
  const address = receiver.address();
  if (!address || typeof address === 'string')
    throw new Error('Actual loopback receiver required');
  const origin = `http://127.0.0.1:${address.port}`;
  const snapshots: Array<{
    stage: string;
    scopeKeys: string[];
    forwarded: boolean;
  }> = [];
  const pending: Promise<void>[] = [];
  const observe = (stage: string) => {
    const options = controlRequestOptions();
    snapshots.push({
      stage,
      scopeKeys: Object.keys(stationServerScopeHeaders()),
      forwarded: new Headers(options.headers).has(INTERNAL_SERVER_SELF_HEADER),
    });
    const work = fetch(`${origin}/${encodeURIComponent(stage)}`, {
      ...options,
      signal,
    }).then((response) => {
      expect(response.status).toBe(204);
    });
    pending.push(work);
    void work.catch(() => {});
    return work;
  };
  enableStationServerSelfAttestation();
  const parent = new AbortController();
  let pages: GroupPageIterator<{ revision: number }> | undefined;
  let lifetime: ReturnType<typeof createGroupStreamLifetime> | undefined;
  let timed: ReturnType<typeof createGroupStreamLifetime> | undefined;
  try {
    await runAsStationServer(() => observe('positive-server-entry'));
    expect(snapshots[0]).toEqual({
      stage: 'positive-server-entry',
      scopeKeys: [INTERNAL_SERVER_SELF_HEADER],
      forwarded: true,
    });
    expect(received[0]).toEqual({
      stage: 'positive-server-entry',
      serverSelf: true,
    });
    let notify: ((hint: GroupStreamHint) => void) | undefined;
    let revision = 0;
    lifetime = runAsStationServer(() =>
      createGroupStreamLifetime(parent.signal, 5000),
    );
    const streamLifetime = lifetime;
    pages = runAsStationServer(() =>
      watchGroupPages({
        signal: streamLifetime.signal,
        lifetimeMs: 5000,
        refreshMs: 15,
        subscribe(listener) {
          void observe('subscribe');
          notify = listener;
          return () => {
            void observe('unsubscribe');
          };
        },
        relevant() {
          void observe('subscription-callback');
          return true;
        },
        async read() {
          await new Promise<void>((resolve) => setImmediate(resolve));
          void observe('delayed-page-read');
          return { revision: ++revision };
        },
        fingerprint(page) {
          void observe('fingerprint');
          return String(page.revision);
        },
        hasMore() {
          void observe('has-more');
          return false;
        },
      }),
    );
    const iterator = pages;
    runAsStationServer(() => {
      streamLifetime.signal.addEventListener(
        'abort',
        () => {
          void observe('parent-abort-callback');
        },
        { once: true },
      );
      iterator.signal.addEventListener(
        'abort',
        () => {
          void observe('iterator-abort-callback');
        },
        { once: true },
      );
    });
    expect((await runAsStationServer(() => iterator.next())).value).toEqual({
      revision: 1,
    });
    expect((await runAsStationServer(() => iterator.next())).value).toEqual({
      revision: 2,
    });
    const notified = runAsStationServer(() => iterator.next());
    if (!notify) throw new Error('Actual subscription callback required');
    const notifyActual = notify;
    runAsStationServer(() => notifyActual({ event: 'group-write' }));
    expect((await notified).done).toBe(false);
    runAsStationServer(() =>
      parent.abort(new Error('controlled external abort')),
    );
    await runAsStationServer(() => iterator.return?.());
    timed = runAsStationServer(() =>
      createGroupStreamLifetime(new AbortController().signal, 15),
    );
    const timerLifetime = timed;
    await new Promise<void>((resolve) => {
      runAsStationServer(() =>
        timerLifetime.signal.addEventListener(
          'abort',
          () => {
            void observe('timer-abort-callback');
            resolve();
          },
          { once: true },
        ),
      );
    });
    await Promise.all(pending);
    for (const stage of [
      'subscribe',
      'delayed-page-read',
      'fingerprint',
      'has-more',
      'subscription-callback',
      'unsubscribe',
      'parent-abort-callback',
      'iterator-abort-callback',
      'timer-abort-callback',
    ]) {
      expect(
        snapshots.some((snapshot) => snapshot.stage === stage),
        `actual ${stage} callback must execute`,
      ).toBe(true);
      expect(
        received.some((request) => request.stage === stage),
        `actual ${stage} HTTP request must arrive`,
      ).toBe(true);
    }
    for (const snapshot of snapshots.filter(
      ({ stage }) => stage !== 'positive-server-entry',
    )) {
      expect(
        snapshot.scopeKeys,
        `${snapshot.stage} must run outside server scope`,
      ).toEqual([]);
      expect(
        snapshot.forwarded,
        `${snapshot.stage} must not forward server-self`,
      ).toBe(false);
    }
    for (const request of received.filter(
      ({ stage }) => stage !== 'positive-server-entry',
    )) {
      expect(
        request.serverSelf,
        `${request.stage} loopback request must not carry server-self`,
      ).toBe(false);
    }
  } finally {
    parent.abort();
    lifetime?.stop();
    timed?.stop();
    await pages?.return?.();
    await Promise.allSettled(pending);
    receiver.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      receiver.close((error) => (error ? reject(error) : resolve())),
    );
  }
}, 10_000);
