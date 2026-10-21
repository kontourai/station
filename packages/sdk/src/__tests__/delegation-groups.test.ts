import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  createDelegationGroup,
  getDelegationGroup,
  readDelegationGroupEvents,
  readDelegationGroupMemberEvents,
  subscribeDelegationGroupEvents,
  subscribeDelegationGroupMemberEvents,
} from '../client/delegation-groups';
import { setClientCredentialResolver } from '../client/http';

test('group commands project intent and keep revision/sequence identities on distinct routes', async () => {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(
      JSON.stringify({ success: true, data: { observed: true } }),
    );
  };
  try {
    const input = {
      preparationId: 'prepared',
      operationId: 'operation',
      forgedAuthority: 'not sent',
    };
    await createDelegationGroup('https://station.test', input);
    await readDelegationGroupEvents('https://station.test', 'group/one', {
      afterRevision: 7,
    });
    await readDelegationGroupMemberEvents(
      'https://station.test',
      'group/one',
      'seat?two',
      { afterSequence: 83 },
    );
    assert.equal(calls[0].url, 'https://station.test/api/orchestration/groups');
    assert.equal(calls[0].init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
      preparationId: 'prepared',
      operationId: 'operation',
    });
    assert.equal(
      calls[1].url,
      'https://station.test/api/orchestration/groups/group%2Fone/events?afterRevision=7',
    );
    assert.equal(
      calls[2].url,
      'https://station.test/api/orchestration/groups/group%2Fone/members/seat%3Ftwo/events?afterSequence=83',
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('group callers retain refusal codes and enforce body limits before projection', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(
      JSON.stringify({ success: false, code: 'group_stale' }),
      { status: 409 },
    );
  };
  try {
    await assert.rejects(getDelegationGroup('https://station.test', 'g'), {
      status: 409,
      code: 'group_stale',
    });
    assert.equal(calls, 1);
    await assert.rejects(
      createDelegationGroup('https://station.test', {
        preparationId: 'x'.repeat(17000),
        operationId: 'o',
      }),
      /byte limit/,
    );
    assert.equal(calls, 1);
    globalThis.fetch = async () => {
      calls++;
      return new Response(' '.repeat(270000));
    };
    await assert.rejects(getDelegationGroup('https://station.test', 'g'));
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = original;
  }
});

test('stale authority cannot send a protected group command', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error('unexpected fetch');
  };
  setClientCredentialResolver(() => ({
    credential: 'fixture',
    origin: 'https://station.test',
    requestAuthority: {
      apiBase: 'https://station.test',
      authorityKey: 'new',
      isCurrent: () => true,
    },
  }));
  try {
    await assert.rejects(
      createDelegationGroup(
        'https://station.test',
        { preparationId: 'p', operationId: 'o' },
        {
          requestScope: {
            apiBase: 'https://station.test',
            authorityKey: 'old',
          },
        },
      ),
    );
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = original;
    setClientCredentialResolver(undefined);
  }
});

test('group and member stream callers deliver matching pages and close pending readers', async () => {
  const original = globalThis.fetch;
  const encoder = new TextEncoder();
  let cancelled = 0;
  const pages: unknown[] = [];
  const requests: string[] = [];
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    const member = String(url).includes('/members/');
    const page = member
      ? {
          groupId: 'g',
          seatId: 's',
          nextSequence: 24,
          events: [],
          hasMore: false,
          state: 'available',
        }
      : {
          groupId: 'g',
          afterRevision: 3,
          nextRevision: 4,
          events: [],
          hasMore: false,
        };
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `event: ${member ? 'member-events' : 'group-events'}\nid: ${member ? 'member:g:s:24' : 'group:g:4'}\ndata: ${JSON.stringify(page)}\n\n`,
            ),
          );
        },
        cancel() {
          cancelled++;
        },
      }),
      { headers: { 'Content-Type': 'text/event-stream' } },
    );
  };
  try {
    for (const member of [false, true]) {
      let delivered!: () => void;
      const ready = new Promise<void>((resolve) => {
        delivered = resolve;
      });
      const callbacks = {
        onPage(page: unknown) {
          pages.push(page);
          delivered();
        },
      };
      const stream = member
        ? subscribeDelegationGroupMemberEvents(
            'https://station.test',
            'g',
            's',
            23,
            callbacks,
          )
        : subscribeDelegationGroupEvents(
            'https://station.test',
            'g',
            3,
            callbacks,
          );
      await ready;
      stream.close();
      await stream.completed;
      assert.equal(stream.signal.aborted, true);
    }
    assert.equal(pages.length, 2);
    assert.equal(cancelled, 2);
    assert.equal(
      requests[0],
      'https://station.test/api/orchestration/groups/g/events/stream?afterRevision=3',
    );
    assert.equal(
      requests[1],
      'https://station.test/api/orchestration/groups/g/members/s/events/stream?afterSequence=23',
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('reconnect retains only the last delivered group checkpoint', async () => {
  const original = globalThis.fetch;
  const headers: Headers[] = [];
  const pages: number[] = [];
  let delivered!: () => void;
  const done = new Promise<void>((resolve) => {
    delivered = resolve;
  });
  globalThis.fetch = async (_url, init) => {
    headers.push(new Headers(init?.headers));
    const nextRevision = headers.length === 1 ? 4 : 5;
    const page = {
      groupId: 'g',
      afterRevision: nextRevision - 1,
      nextRevision,
      events: [],
      hasMore: false,
    };
    return new Response(
      `event: group-events\nid: group:g:${nextRevision}\ndata: ${JSON.stringify(page)}\n\n`,
      { headers: { 'Content-Type': 'text/event-stream' } },
    );
  };
  const stream = subscribeDelegationGroupEvents(
    'https://station.test',
    'g',
    3,
    {
      onPage(page) {
        pages.push(page.nextRevision);
        if (pages.length === 2) delivered();
      },
    },
  );
  try {
    await done;
    stream.close();
    await stream.completed;
    assert.deepEqual(pages, [4, 5]);
    assert.equal(headers[0].get('Last-Event-ID'), null);
    assert.equal(headers[1].get('Last-Event-ID'), 'group:g:4');
  } finally {
    stream.close();
    await stream.completed;
    globalThis.fetch = original;
  }
});
