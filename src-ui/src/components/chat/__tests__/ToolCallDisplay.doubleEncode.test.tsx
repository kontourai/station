/**
 * @vitest-environment jsdom
 *
 * archive#3507 — a restored transcript double-encodes a structured tool
 * result. `ToolCallDisplay.tsx`'s Response section used
 * `JSON.stringify(result, null, 2)` unconditionally, but whether that is
 * right depends on whether `result` is already a string:
 *
 * - live path (`streamHandlers.ts`'s `handleToolCompletedEvent`) sets
 *   `result: event.output` — the raw object, so `JSON.stringify` is the
 *   first and only encoding.
 * - restored path (an event-window read) hands down a string: the load-
 *   bearing derivation is `runtime-event-projection.ts`'s `resultText`, which
 *   returns a string for EVERY tool result unconditionally — a non-string
 *   `output` is JSON-serialised there, a string `output` passes through
 *   as-is — so restored `result` is always a string, never sometimes.
 *   `event-store.ts`'s `snapshotEvent` upstream also JSON-serialises a
 *   structured `output` before it reaches the client (archive#3462), but
 *   `resultText` is what actually guarantees the string-ness this component
 *   sees. Stringifying that string a second time wraps it in an extra layer
 *   of quotes and escapes.
 *
 * Fix round (same issue): `ToolCallDetails`'s Arguments section had the
 * identical bug three lines above the Response fix — `argsJson` stringified
 * `remainingArgs` unconditionally, and `remainingArgs` can also already be a
 * string (`runtime-event-projection.ts` passes `args: ev.arguments`
 * unchanged, and an ACP-connected engine's `resolveToolArguments` can hand
 * back a raw, unstringified string).
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { ToolCallDisplay } from '../ToolCallDisplay';

afterEach(cleanup);

function expand(_toolName: string) {
  // The collapsed row itself is the disclosure button (archive#2652
  // redesign); its accessible name is its visible verb-first label.
  fireEvent.click(document.querySelector('button.tool-call__line')!);
}

function responseText(): string | null | undefined {
  return document.querySelector('.tool-call__code--scrollable')?.textContent;
}

/**
 * The Arguments `<pre>` carries exactly `tool-call__code` with no modifier
 * class — the Response `<pre>` adds `--scrollable` and the shell-`command`
 * special case adds `--command` (`ToolCallDisplay.tsx`'s `ToolCallDetails`).
 * An exact class match, not position, is what tells them apart: none of
 * these fixtures use `args.command`, so this is always the sole match.
 */
function argsText(): string | null | undefined {
  return Array.from(document.querySelectorAll('pre.tool-call__code')).find(
    (el) => el.className === 'tool-call__code',
  )?.textContent;
}

describe('ToolCallDisplay result rendering (station#3507)', () => {
  test('live path: an object result renders as pretty-printed JSON', () => {
    const structuredResult = [{ type: 'text', text: 'total 24' }];
    render(
      <ToolCallDisplay
        toolCall={{
          type: 'tool-invocation',
          toolCallId: 'call-live',
          name: 'ls',
          result: structuredResult,
        }}
      />,
    );
    expand('ls');

    expect(responseText()).toBe(JSON.stringify(structuredResult, null, 2));
  });

  test('restored path: an already-serialized string result renders as-is, not double-encoded', () => {
    const preSerialized = JSON.stringify([{ type: 'text', text: 'total 24' }]);
    render(
      <ToolCallDisplay
        toolCall={{
          type: 'tool-invocation',
          toolCallId: 'call-restored',
          name: 'ls',
          result: preSerialized,
        }}
      />,
    );
    expand('ls');

    // The pre-fix behavior wraps a string result in an extra layer of
    // quotes/escapes (`"[{\"type\":...}]"`); the fix renders the string
    // unchanged.
    expect(responseText()).toBe(preSerialized);
    expect(responseText()).not.toContain('\\"');
  });

  // Named to say what the fix does, not "either way" — that phrasing would
  // read as "regardless of the fix," which is false: the pre-fix code wraps
  // this exact fixture in quotes too (proven by the 's fault
  // injection, which reddened this test along with the restored-path one
  // above), so it only holds once the type check exists.
  test('a plain string result (e.g. a shell tool) is not wrapped in quotes by the fix', () => {
    render(
      <ToolCallDisplay
        toolCall={{
          type: 'tool-invocation',
          toolCallId: 'call-string',
          name: 'echo',
          result: 'hello world',
        }}
      />,
    );
    expand('echo');

    expect(responseText()).toBe('hello world');
  });
});

describe('ToolCallDisplay args rendering (station#3507 fix round)', () => {
  test('an object args value renders as pretty-printed JSON', () => {
    const structuredArgs = { path: '/tmp', recursive: true };
    render(
      <ToolCallDisplay
        toolCall={{
          type: 'tool-invocation',
          toolCallId: 'call-args-object',
          name: 'ls',
          args: structuredArgs,
        }}
      />,
    );
    expand('ls');

    expect(argsText()).toBe(JSON.stringify(structuredArgs, null, 2));
  });

  test('an already-serialized string args value renders as-is, not double-encoded', () => {
    const preSerialized = JSON.stringify({ path: '/tmp', recursive: true });
    render(
      <ToolCallDisplay
        toolCall={{
          type: 'tool-invocation',
          toolCallId: 'call-args-string',
          name: 'ls',
          args: preSerialized,
        }}
      />,
    );
    expand('ls');

    expect(argsText()).toBe(preSerialized);
    expect(argsText()).not.toContain('\\"');
  });
});

/**
 * Independent review of this branch (archive#3559): the
 * old collapsed header's `argsPreview` had the SAME string-args hazard as
 * `argsJson` above — `Object.keys('git commit -m "fix"')` returns index keys
 * ('0', '1', '2', …), so a string tool-call argument rendered as `0: "g",
 * 1: "i", 2: "t", …` for the whole command. The archive#2652 redesign
 * replaced the preview with the verb-first label; these tests keep the
 * defect class pinned against the label derivation, which must show a
 * string command intact, never index-keyed.
 */
describe('ToolCallDisplay collapsed row label (station#3559 defect class)', () => {
  function labelText(): string | null | undefined {
    return document.querySelector('.tool-call__label')?.textContent;
  }

  test('a string args value renders intact in the collapsed row, not index-keyed', () => {
    render(
      <ToolCallDisplay
        toolCall={{
          type: 'tool-invocation',
          toolCallId: 'call-preview-string',
          name: 'bash',
          args: 'git commit -m "fix"',
        }}
      />,
    );

    // Bare infinitive, not "Ran": this fixture carries no terminal state, so
    // nothing observed the command finish. These tests pin the ARGS preview;
    // they previously demanded past tense here and so held the overclaim in
    // place (archive#3690) — the tense contract itself is asserted in
    // `ToolCallDisplay.test.tsx`.
    expect(labelText()).toBe('Run git commit -m "fix"');
    // The pre-fix defect: index-keyed characters, not the command text.
    expect(labelText()).not.toMatch(/0: /);
  });

  test('an object args value renders its extracted target in the collapsed row', () => {
    render(
      <ToolCallDisplay
        toolCall={{
          type: 'tool-invocation',
          toolCallId: 'call-preview-object',
          name: 'read_file',
          args: { path: '/tmp/app.tsx' },
        }}
      />,
    );

    expect(labelText()).toBe('Read app.tsx');
  });

  test('a call with no args, no result, and no error renders a static row with no expand affordance', () => {
    render(
      <ToolCallDisplay
        toolCall={{
          type: 'tool-invocation',
          toolCallId: 'call-preview-empty',
          name: 'noop',
        }}
      />,
    );

    // No detail exists, so no disclosure is promised: no button, no chevron,
    // no tab stop — just the labelled line. Verb is the infinitive because
    // this fixture never reached a terminal state (see the note above).
    expect(labelText()).toBe('Use noop');
    expect(document.querySelector('button.tool-call__line')).toBeNull();
    expect(document.querySelector('.tool-call__chevron')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
