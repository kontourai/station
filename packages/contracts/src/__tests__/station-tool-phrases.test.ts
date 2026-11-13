import { describe, expect, test } from 'vitest';
import { stationToolOf, stationToolPhrase } from '../station-tool-phrases.js';

describe('stationToolPhrase', () => {
  test('takes the verb form of the phase', () => {
    const args = { sessionId: 'thread-1' };
    const sessionTitle = (id: string) =>
      id === 'thread-1' ? 'Fix login' : undefined;
    expect(
      stationToolPhrase('wait_session', 'done', { args, sessionTitle }),
    ).toBe('Waited for “Fix login”');
    expect(
      stationToolPhrase('wait_session', 'running', { args, sessionTitle }),
    ).toBe('Waiting for “Fix login”');
    expect(
      stationToolPhrase('wait_session', 'pending', { args, sessionTitle }),
    ).toBe('Wait for “Fix login”');
  });

  test('names a Session only by a title the reader knows, never by a guess', () => {
    expect(
      stationToolPhrase('send_to_session', 'done', {
        args: { sessionId: 'thread-9' },
        sessionTitle: () => undefined,
      }),
    ).toBe('Sent to a Session');
    expect(
      stationToolPhrase('read_conversation', 'done', {
        args: { conversationId: 'c-1' },
      }),
    ).toBe('Read a Conversation');
    // A blank title is no title.
    expect(
      stationToolPhrase('wait_session', 'done', {
        args: { sessionId: 'thread-1' },
        sessionTitle: () => '   ',
      }),
    ).toBe('Waited for a Session');
  });

  test('fills the ids the call carries', () => {
    expect(
      stationToolPhrase('declare_pull_request', 'done', {
        args: { ref: '3271' },
      }),
    ).toBe('Declared PR #3271');
    // Not a pull request number: not shown as one.
    expect(
      stationToolPhrase('declare_pull_request', 'pending', {
        args: { ref: '03271' },
      }),
    ).toBe('Declare a pull request');
    // GitLab's own words: a merge request, numbered with `!`.
    expect(
      stationToolPhrase('declare_pull_request', 'done', {
        args: { provider: 'gitlab', ref: '42' },
      }),
    ).toBe('Declared MR !42');
    expect(
      stationToolPhrase('declare_pull_request', 'pending', {
        args: { provider: 'gitlab' },
      }),
    ).toBe('Declare a merge request');
    expect(
      stationToolPhrase('claim_work', 'done', {
        args: { workItemRef: '#3158' },
      }),
    ).toBe('Claimed #3158');
    expect(
      stationToolPhrase('schedule_wake_up', 'done', {
        args: { minutes: 20 },
      }),
    ).toBe('Scheduled a check-back in 20 min');
    // Engines that pass arguments as a JSON string are read the same.
    expect(
      stationToolPhrase('search_knowledge', 'running', {
        args: JSON.stringify({ query: 'retry policy' }),
      }),
    ).toBe('Searching knowledge for “retry policy”');
  });

  test('shows an argument as one clipped line', () => {
    const phrase = stationToolPhrase('notify_user', 'done', {
      args: { title: `${'a'.repeat(60)}\nsecond line` },
    });
    expect(phrase).toBe(`Notified you: “${'a'.repeat(47)}…”`);
    // An emoji at the cut is never split into a lone surrogate.
    const emoji = stationToolPhrase('rename_session', 'done', {
      args: { title: `${'b'.repeat(46)}😀😀😀` },
    });
    expect(emoji).toBe(`Renamed a Session to “${'b'.repeat(46)}😀…”`);
  });

  test('is undefined for a tool it does not word, including an inherited key', () => {
    expect(stationToolPhrase('not_a_tool', 'done')).toBeUndefined();
    expect(stationToolPhrase('constructor', 'done')).toBeUndefined();
    expect(stationToolPhrase('toString', 'done')).toBeUndefined();
  });
});

describe('stationToolOf', () => {
  test.each([
    ['mcp__station-control__wait_session', 'station-control', 'wait_session'],
    ['station-control_claim_work', 'station-control', 'claim_work'],
    ['station-control/notify_user', 'station-control', 'notify_user'],
    ['station-control.get_task', 'station-control', 'get_task'],
    ['Tool: station-control/html_render', 'station-control', 'html_render'],
    [
      'mcp__station-knowledge__search_knowledge',
      'station-knowledge',
      'search_knowledge',
    ],
    ['mcp__station-browser__browser_open', 'station-browser', 'browser_open'],
    [
      'mcp__station-docs__search_station_docs',
      'station-docs',
      'search_station_docs',
    ],
  ])('reads %s', (name, server, tool) => {
    expect(stationToolOf(name)).toEqual({ server, tool });
  });

  test('claims a bare name only with a Station server field', () => {
    expect(stationToolOf('wait_session')).toBeUndefined();
    expect(stationToolOf('wait_session', 'other-server')).toBeUndefined();
    expect(stationToolOf('wait_session', 'station-control')).toEqual({
      server: 'station-control',
      tool: 'wait_session',
    });
    expect(stationToolOf('mcp__other__wait_session')).toBeUndefined();
    expect(stationToolOf('station-controlled_x')).toBeUndefined();
    expect(stationToolOf(undefined)).toBeUndefined();
  });
});
