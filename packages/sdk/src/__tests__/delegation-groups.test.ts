import assert from 'node:assert/strict';
import type {
  DelegationGroupEventPage,
  DelegationGroupMemberEventPage,
  DelegationGroupView,
} from '@kontourai/station-contracts/delegation-group';
import { afterEach, test, vi } from 'vitest';
import {
  cancelDelegationGroup,
  createDelegationGroup,
  getDelegationGroup,
  launchDelegationGroup,
  listDelegationGroups,
  readDelegationGroupEvents,
  readDelegationGroupMemberEvents,
  readDelegationGroupMemberOutput,
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
      JSON.stringify({
        success: true,
        data: String(url).includes('/members/')
          ? memberPage(83, 83, 'group/one', 'seat?two')
          : String(url).includes('/events')
            ? groupPage(7, 7, 'group/one')
            : { replayed: false, group: groupView() },
      }),
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

test('group callers retain refusal codes and enforce body limits after command projection and before dispatch', async () => {
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
          unavailable: [],
          state: 'available',
        }
      : {
          groupId: 'g',
          afterRevision: 3,
          nextRevision: 4,
          events: [],
          hasMore: false,
          unavailable: [],
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
      unavailable: [],
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

function groupView(): DelegationGroupView {
  return {
    version: 'station.delegation-group/v1',
    groupId: 'g',
    revision: 0,
    execution: 'idle',
    cancellation: 'none',
    terminal: 'unproven',
    acceptance: 'unassessed',
    executionCapability: {
      status: 'unavailable',
      code: 'physical_adapter_unqualified',
    },
    topology: { kind: 'independent-advisory' },
    members: [],
  };
}
function groupPage(
  afterRevision = 0,
  nextRevision = 1,
  groupId = 'g',
): DelegationGroupEventPage {
  return {
    groupId,
    afterRevision,
    nextRevision,
    events:
      nextRevision > afterRevision
        ? [{ revision: nextRevision, kind: 'observed' }]
        : [],
    hasMore: false,
    unavailable: [],
  };
}
function memberPage(
  after = 0,
  nextSequence = 1,
  groupId = 'g',
  seatId = 's',
): DelegationGroupMemberEventPage {
  return {
    groupId,
    seatId,
    nextSequence,
    events:
      nextSequence > after
        ? [
            {
              eventId: `e${nextSequence}`,
              sequence: nextSequence,
              kind: 'observed',
            },
          ]
        : [],
    state: 'available',
    hasMore: false,
    unavailable: [],
  };
}
function frame(
  member: boolean,
  page: DelegationGroupEventPage | DelegationGroupMemberEventPage,
) {
  return `event: ${member ? 'member-events' : 'group-events'}\nid: ${member ? `member:g:s:${'nextSequence' in page ? page.nextSequence : 0}` : `group:g:${'nextRevision' in page ? page.nextRevision : 0}`}\ndata: ${JSON.stringify(page)}\n\n`;
}
function subscribe(
  member: boolean,
  callbacks: { onPage(page: unknown): void; onError?(error: unknown): void },
  options = {},
) {
  return member
    ? subscribeDelegationGroupMemberEvents(
        'https://station.test',
        'g',
        's',
        0,
        callbacks,
        options,
      )
    : subscribeDelegationGroupEvents(
        'https://station.test',
        'g',
        0,
        callbacks,
        options,
      );
}
afterEach(() => {
  vi.unstubAllGlobals();
  setClientCredentialResolver(undefined);
  vi.useRealTimers();
});

test('member identity cannot be reused at a new sequence after an intervening page', async () => {
  const pages = [memberPage(0, 7), memberPage(7, 80), memberPage(80, 90)];
  pages[0].events[0].eventId = 'same';
  pages[2].events[0].eventId = 'same';
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () => new Response(pages.map((page) => frame(true, page)).join('')),
    ),
  );
  const delivered: unknown[] = [];
  const errors: unknown[] = [];
  const stream = subscribe(true, {
    onPage(page) {
      delivered.push(page);
    },
    onError(error) {
      errors.push(error);
    },
  });
  try {
    await vi.waitFor(() => assert.equal(errors.length, 1));
    assert.deepEqual(delivered, pages.slice(0, 2));
    assert.equal(errors.length, 1);
  } finally {
    stream.close();
    await stream.completed;
  }
});

test('member observation stops at its retained identity bound instead of evicting old identities', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (let offset = 0; offset < 4096; offset += 64) {
                const page = memberPage(offset, offset + 64);
                page.events = Array.from({ length: 64 }, (_, index) => ({
                  eventId: `event-${offset + index + 1}`,
                  sequence: offset + index + 1,
                  kind: 'observed',
                }));
                controller.enqueue(new TextEncoder().encode(frame(true, page)));
              }
              controller.enqueue(
                new TextEncoder().encode(frame(true, memberPage(4096, 4097))),
              );
            },
          }),
        ),
    ),
  );
  let delivered = 0;
  const errors: unknown[] = [];
  const stream = subscribe(true, {
    onPage() {
      delivered++;
    },
    onError(error) {
      errors.push(error);
    },
  });
  try {
    await vi.waitFor(() => assert.equal(errors.length, 1));
    assert.equal(delivered, 64);
    await stream.completed;
  } finally {
    stream.close();
    await stream.completed;
  }
});

for (const member of [false, true]) {
  test(`live ${member ? 'member' : 'group'} authority is checked before every callback and checkpoint`, async () => {
    let current = true;
    let body!: ReadableStreamDefaultController<Uint8Array>;
    let opened!: () => void;
    const ready = new Promise<void>((resolve) => {
      opened = resolve;
    });
    const cancel = vi.fn();
    const fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(c) {
              body = c;
            },
            cancel,
          }),
        ),
    );
    vi.stubGlobal('fetch', fetch);
    setClientCredentialResolver(() => ({
      credential: 'fixture',
      origin: 'https://station.test',
      requestAuthority: {
        apiBase: 'https://station.test',
        authorityKey: 'captured',
        isCurrent: () => current,
      },
    }));
    const pages: unknown[] = [];
    const errors: unknown[] = [];
    const callbacks = {
      onPage(page: unknown) {
        pages.push(page);
        current = false;
      },
      onError(error: unknown) {
        errors.push(error);
      },
      onOpen: opened,
    };
    const stream = member
      ? subscribeDelegationGroupMemberEvents(
          'https://station.test',
          'g',
          's',
          0,
          callbacks,
          {
            requestScope: {
              apiBase: 'https://station.test',
              authorityKey: 'captured',
            },
          },
        )
      : subscribeDelegationGroupEvents(
          'https://station.test',
          'g',
          0,
          callbacks,
          {
            requestScope: {
              apiBase: 'https://station.test',
              authorityKey: 'captured',
            },
          },
        );
    try {
      await ready;
      current = false;
      body.enqueue(
        new TextEncoder().encode(
          frame(member, member ? memberPage() : groupPage()),
        ),
      );
      await vi.waitFor(() => assert.equal(errors.length, 1));
      assert.equal(pages.length, 0);
      assert.equal(cancel.mock.calls.length, 1);
      assert.equal(fetch.mock.calls.length, 1);
    } finally {
      stream.close();
      await stream.completed;
    }
  });
  test(`pre-aborted ${member ? 'member' : 'group'} subscription never dispatches`, async () => {
    const fetch = vi.fn(
      async () =>
        new Response(frame(member, member ? memberPage() : groupPage())),
    );
    vi.stubGlobal('fetch', fetch);
    const stop = new AbortController();
    stop.abort();
    const onPage = vi.fn();
    const stream = subscribe(member, { onPage }, { signal: stop.signal });
    try {
      await Promise.resolve();
      await Promise.resolve();
      assert.equal(fetch.mock.calls.length, 0);
      assert.equal(onPage.mock.calls.length, 0);
      assert.equal(stream.signal.aborted, true);
    } finally {
      stream.close();
      await stream.completed;
    }
  });
  test(`${member ? 'member' : 'group'} replay filters duplicate events but delivers same-cursor status`, async () => {
    const page = member ? memberPage(0, 7) : groupPage();
    const empty = member
      ? { ...memberPage(7, 7), state: 'unavailable' as const }
      : {
          ...groupPage(1, 1),
          unavailable: [{ cursor: 1, code: 'item_too_large' as const }],
        };
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            frame(member, page) + frame(member, page) + frame(member, empty),
          ),
      ),
    );
    const pages: unknown[] = [];
    const stream = subscribe(member, {
      onPage(page) {
        pages.push(page);
      },
    });
    try {
      await vi.waitFor(() => assert.equal(pages.length, 2));
      assert.deepEqual(pages, [page, empty]);
    } finally {
      stream.close();
      await stream.completed;
    }
  });
  test(`${member ? 'member' : 'group'} rejects foreign id-only checkpoints`, async () => {
    const errors: unknown[] = [];
    const fetch = vi.fn(
      async () =>
        new Response(
          `id: ${member ? 'group:g:700' : 'member:foreign:s:700'}\n\n`,
        ),
    );
    vi.stubGlobal('fetch', fetch);
    const stream = subscribe(member, {
      onPage() {},
      onError(error) {
        errors.push(error);
      },
    });
    try {
      await vi.waitFor(() => assert.equal(errors.length, 1));
      assert.match(String(errors[0]), /cursor|checkpoint/i);
      assert.equal(fetch.mock.calls.length, 1);
    } finally {
      stream.close();
      await stream.completed;
    }
  });
}

test('all HTTP group responses validate required shapes and requested identities', async () => {
  const operations = [
    {
      call: () => getDelegationGroup('https://station.test', 'g'),
      good: groupView(),
      bad: [
        null,
        {},
        { ...groupView(), groupId: 'foreign' },
        { ...groupView(), revision: -1 },
        { ...groupView(), members: [{ seatId: 's' }] },
      ],
    },
    {
      call: () => listDelegationGroups('https://station.test'),
      good: {
        groups: [groupView()],
        nextGroupId: null,
        hasMore: false,
        unavailable: [],
      },
      bad: [
        null,
        { groups: [], hasMore: false },
        { groups: [null], nextGroupId: null, hasMore: false, unavailable: [] },
      ],
    },
    {
      call: () =>
        createDelegationGroup('https://station.test', {
          preparationId: 'p',
          operationId: 'o',
        }),
      good: { replayed: false, group: groupView() },
      bad: [null, { group: groupView() }, { replayed: false, group: null }],
    },
    {
      call: () =>
        launchDelegationGroup('https://station.test', 'g', {
          operationId: 'o',
          expectedRevision: 0,
        }),
      good: { replayed: true, group: groupView() },
      bad: [{ replayed: true, group: { ...groupView(), groupId: 'other' } }],
    },
    {
      call: () =>
        cancelDelegationGroup('https://station.test', 'g', {
          operationId: 'o',
          expectedRevision: 0,
        }),
      good: { disposition: 'pending', group: groupView() },
      bad: [{ disposition: 'finished', group: groupView() }],
    },
    {
      call: () => readDelegationGroupEvents('https://station.test', 'g'),
      good: groupPage(),
      bad: [
        null,
        { ...groupPage(), groupId: 'other' },
        { ...groupPage(), afterRevision: 8 },
        { ...groupPage(), events: [{ revision: 999, kind: 'x' }] },
        { ...groupPage(), events: 'wrong' },
        { ...groupPage(), unavailable: undefined },
        { ...groupPage(), events: [{ revision: 1 }] },
      ],
    },
    {
      call: () =>
        readDelegationGroupMemberEvents('https://station.test', 'g', 's'),
      good: memberPage(0, 71),
      bad: [
        null,
        { ...memberPage(), seatId: 'other' },
        { ...memberPage(), events: [{ sequence: 1, kind: 'x' }] },
        { ...memberPage(), state: 'bogus' },
      ],
    },
    {
      call: () =>
        readDelegationGroupMemberOutput('https://station.test', 'g', 's'),
      good: {
        reference: { id: 'o', domain: 'output', digest: 'sha' },
        raw: null,
        rawResult: { text: 'ok' },
      },
      bad: [
        null,
        { reference: {}, raw: null, rawResult: null },
        { reference: { id: 'o', domain: 'output', digest: 'sha' }, raw: null },
      ],
    },
  ];
  for (const { call, good, bad } of operations) {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(JSON.stringify({ success: true, data: good })),
      ),
    );
    assert.deepEqual(await call(), good);
    for (const data of bad) {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () => new Response(JSON.stringify({ success: true, data })),
        ),
      );
      await assert.rejects(call(), /Invalid|Missing/);
    }
  }
});

test('malformed SSE pages are rejected without delivery or reconnect', async () => {
  for (const member of [false, true]) {
    const badPages = member
      ? [
          null,
          { ...memberPage(), nextSequence: -1 },
          { ...memberPage(), unavailable: undefined },
          {
            ...memberPage(),
            events: [{ eventId: 'e', sequence: 999, kind: 'x' }],
          },
        ]
      : [
          null,
          {
            ...groupPage(),
            afterRevision: 8,
            nextRevision: 9,
            events: [{ revision: 999, kind: 'x' }],
          },
          { ...groupPage(), hasMore: undefined },
        ];
    for (const page of badPages) {
      const fetch = vi.fn(
        async () =>
          new Response(
            `event: ${member ? 'member-events' : 'group-events'}\nid: ${member ? 'member:g:s:1' : 'group:g:1'}\ndata: ${JSON.stringify(page)}\n\n`,
          ),
      );
      vi.stubGlobal('fetch', fetch);
      const onPage = vi.fn();
      const errors: unknown[] = [];
      const stream = subscribe(member, {
        onPage,
        onError(error) {
          errors.push(error);
        },
      });
      try {
        await vi.waitFor(() => assert.equal(errors.length, 1));
        assert.equal(onPage.mock.calls.length, 0);
        assert.match(String(errors[0]), /Invalid/);
        assert.equal(fetch.mock.calls.length, 1);
      } finally {
        stream.close();
        await stream.completed;
      }
    }
  }
});

test('group subscriptions enforce the configured frame byte cap before delimiter', async () => {
  for (const member of [false, true]) {
    let body!: ReadableStreamDefaultController<Uint8Array>;
    const cancel = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(c) {
                body = c;
              },
              cancel,
            }),
          ),
      ),
    );
    const errors: unknown[] = [];
    const onPage = vi.fn();
    const stream = subscribe(member, {
      onPage,
      onError(error) {
        errors.push(error);
      },
    });
    try {
      await vi.waitFor(() => assert.ok(body));
      body.enqueue(new TextEncoder().encode('data: ' + 'x'.repeat(131072)));
      await Promise.resolve();
      assert.equal(errors.length, 0);
      body.enqueue(new TextEncoder().encode('x'.repeat(131072)));
      await vi.waitFor(() => assert.equal(errors.length, 1));
      assert.match(String(errors[0]), /byte limit/);
      assert.equal(cancel.mock.calls.length, 1);
      assert.equal(onPage.mock.calls.length, 0);
    } finally {
      stream.close();
      await stream.completed;
    }
  }
});
