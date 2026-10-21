import assert from 'node:assert/strict';
import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
import { test } from 'vitest';
import { runCli } from '../cli';
import { parseCoreArgs } from '../commands/core-api';
import { runGroupCommand } from '../commands/group';

test('registered group command reaches the SDK with explicit target credentials', async () => {
  const original = globalThis.fetch;
  const log = console.log;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  console.log = () => {};
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(
      JSON.stringify({ success: true, data: { groupId: 'g' } }),
    );
  };
  try {
    await runCli([
      'group',
      'get',
      'g',
      '--api-base=https://station.test',
      '--credential=fixture',
      '--json',
    ]);
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].url,
      'https://station.test/api/orchestration/groups/g',
    );
    assert.equal(
      new Headers(calls[0].init?.headers).get('Authorization'),
      'Bearer fixture',
    );
  } finally {
    globalThis.fetch = original;
    console.log = log;
    setClientCredentialResolver(undefined);
  }
});

test('CLI group write carries explicit operation and revision and never invents a retry', async () => {
  const original = globalThis.fetch;
  const log = console.log;
  const output: string[] = [];
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  console.log = (value) => {
    output.push(String(value));
  };
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(
      JSON.stringify({
        success: true,
        data: { replayed: false, group: { groupId: 'g' } },
      }),
    );
  };
  try {
    await runGroupCommand(
      'https://station.test',
      parseCoreArgs(['run', 'g', '--operation=op', '--revision=7', '--json']),
    );
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].url,
      'https://station.test/api/orchestration/groups/g/run',
    );
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
      operationId: 'op',
      expectedRevision: 7,
    });
    assert.equal(JSON.parse(output[0]).group.groupId, 'g');
    await assert.rejects(
      runGroupCommand(
        'https://station.test',
        parseCoreArgs(['run', 'g', '--operation=op']),
      ),
      /revision/,
    );
    await assert.rejects(
      runGroupCommand(
        'https://station.test',
        parseCoreArgs([
          'run',
          'g',
          '--operation=op',
          '--revision=7',
          '--authority=forged',
        ]),
      ),
      /Unsupported/,
    );
    assert.equal(calls.length, 1);
    globalThis.fetch = async () => {
      calls.push({ url: 'refusal' });
      return new Response(
        JSON.stringify({ success: false, code: 'group_stale' }),
        { status: 409 },
      );
    };
    await assert.rejects(
      runGroupCommand(
        'https://station.test',
        parseCoreArgs(['run', 'g', '--operation=op', '--revision=7']),
      ),
      { code: 'group_stale' },
    );
    assert.equal(calls.length, 2);
  } finally {
    globalThis.fetch = original;
    console.log = log;
  }
});

test('CLI follow closes its stream and SIGINT listener after interruption', async () => {
  const original = globalThis.fetch;
  const log = console.log;
  const listeners = process.listenerCount('SIGINT');
  let cancelled = false;
  let emitted!: () => void;
  const printed = new Promise<void>((resolve) => {
    emitted = resolve;
  });
  console.log = () => {
    emitted();
  };
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              `event: group-events\nid: group:g:1\ndata: ${JSON.stringify({ groupId: 'g', afterRevision: 0, nextRevision: 1, events: [], hasMore: false })}\n\n`,
            ),
          );
        },
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { 'Content-Type': 'text/event-stream' } },
    );
  try {
    const running = runGroupCommand(
      'https://station.test',
      parseCoreArgs(['events', 'g', '--follow', '--json']),
    );
    await printed;
    assert.equal(process.listenerCount('SIGINT'), listeners + 1);
    process.emit('SIGINT');
    await running;
    assert.equal(cancelled, true);
    assert.equal(process.listenerCount('SIGINT'), listeners);
  } finally {
    globalThis.fetch = original;
    console.log = log;
  }
});
