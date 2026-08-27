import type { ProviderKind } from '@kontourai/station-contracts/provider';
import type {
  CanonicalRuntimeEvent,
  ToolCompletedEvent,
} from '@kontourai/station-contracts/runtime-events';
import type { UIBlockProvenanceSourceRef } from '@kontourai/station-contracts/ui-block';
import type {
  ConversationMessage,
  MessagePart,
} from '@kontourai/station-shared/conversation-message';
import { describe, expect, test, vi } from 'vitest';
import {
  computeUIBlockProvenanceDigest,
  safeSanitizeUIBlockCarrierOutput,
  safeSanitizeUIBlockEventProvenance,
  sanitizeConversationMessagesUIBlockProvenance,
  sanitizeUIBlockEventProvenance,
} from '../ui-block-provenance';

describe('computeUIBlockProvenanceDigest', () => {
  const toolRef: UIBlockProvenanceSourceRef = {
    kind: 'toolCallId',
    toolCallId: 'call_1',
  };
  const messageRef: UIBlockProvenanceSourceRef = {
    kind: 'messageId',
    messageId: 'msg_1',
  };
  const fileRef: UIBlockProvenanceSourceRef = {
    kind: 'fileDigest',
    path: 'README.md',
    digest: 'abc123',
  };

  test('is stable under source-order permutation', () => {
    const forward = computeUIBlockProvenanceDigest([
      toolRef,
      messageRef,
      fileRef,
    ]);
    const reversed = computeUIBlockProvenanceDigest([
      fileRef,
      messageRef,
      toolRef,
    ]);
    const shuffled = computeUIBlockProvenanceDigest([
      messageRef,
      fileRef,
      toolRef,
    ]);

    expect(reversed).toBe(forward);
    expect(shuffled).toBe(forward);
  });

  test('changes when a source is added', () => {
    const before = computeUIBlockProvenanceDigest([toolRef]);
    const after = computeUIBlockProvenanceDigest([toolRef, messageRef]);

    expect(after).not.toBe(before);
  });

  test('changes when a source value changes (same kind, different id)', () => {
    const original = computeUIBlockProvenanceDigest([toolRef]);
    const changed = computeUIBlockProvenanceDigest([
      { kind: 'toolCallId', toolCallId: 'call_2' },
    ]);

    expect(changed).not.toBe(original);
  });

  test('changes when a source is removed', () => {
    const withBoth = computeUIBlockProvenanceDigest([toolRef, messageRef]);
    const withOne = computeUIBlockProvenanceDigest([toolRef]);

    expect(withOne).not.toBe(withBoth);
  });

  test('deduplicates a repeated identical source ref', () => {
    const once = computeUIBlockProvenanceDigest([toolRef]);
    const twice = computeUIBlockProvenanceDigest([toolRef, { ...toolRef }]);

    expect(twice).toBe(once);
  });

  test('is a hex-encoded SHA-256 digest', () => {
    const digest = computeUIBlockProvenanceDigest([toolRef]);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });
});

/**
 * station#1399 fix round (independent review H1/M4/M6) — the single-writer
 * seam. Every `tool.completed` event flows through
 * `OrchestrationService#publishCanonicalEvent`, which calls
 * `sanitizeUIBlockEventProvenance` before persistence AND before the live
 * SSE publish, so a live-streamed copy and a persisted/reloaded copy of the
 * same block are always provenance-identical by construction — this suite
 * covers the pure function directly rather than standing up the full
 * OrchestrationService.
 */
describe('sanitizeUIBlockEventProvenance', () => {
  const base = {
    eventId: 'evt_1',
    provider: 'claude' as ProviderKind,
    threadId: 'thread_1',
    createdAt: '2026-03-28T12:00:00.000Z',
    turnId: 'turn_1',
    itemId: 'tool_item',
    toolCallId: 'call_1',
    toolName: 'render_summary',
    status: 'success' as const,
  };

  function toolCompleted(output: unknown): ToolCompletedEvent {
    return { ...base, method: 'tool.completed', output };
  }

  test('passes through a non-tool.completed event untouched (same reference)', () => {
    const event = {
      eventId: 'evt_2',
      provider: 'claude' as ProviderKind,
      threadId: 'thread_1',
      createdAt: '2026-03-28T12:00:00.000Z',
      method: 'turn.completed' as const,
      turnId: 'turn_1',
    } as CanonicalRuntimeEvent;
    expect(sanitizeUIBlockEventProvenance(event)).toBe(event);
  });

  test('passes through a tool.completed event with no uiBlock/uiBlocks untouched (same reference)', () => {
    const event = toolCompleted({ bytes: 128 });
    expect(sanitizeUIBlockEventProvenance(event)).toBe(event);
  });

  test('a generic (non-render_component) tool cannot mint attested from source presence alone with a fake digest', () => {
    // H1's reproduction: a data-bearing table with a fabricated digest and
    // no real host computation behind it, from a tool that is NOT
    // render_component (so nothing upstream ever validated it).
    const event = toolCompleted({
      uiBlocks: [
        {
          type: 'table',
          columns: ['Name', 'Value'],
          rows: [['Coverage', 98]],
          derivedFrom: [{ kind: 'toolCallId', toolCallId: 'call_1' }],
          provenanceDigest: 'a'.repeat(64),
          attestationState: 'attested',
        },
      ],
    });
    const sanitized = sanitizeUIBlockEventProvenance(
      event,
    ) as ToolCompletedEvent;
    const output = sanitized.output as {
      uiBlocks: Array<Record<string, unknown>>;
    };
    const block = output.uiBlocks[0]!;

    // The state IS 'attested' here because the sources are real/valid — but
    // the DIGEST is the host's own computation, never the fabricated one.
    expect(block.attestationState).toBe('attested');
    expect(block.provenanceDigest).not.toBe('a'.repeat(64));
    expect(block.provenanceDigest).toBe(
      computeUIBlockProvenanceDigest([
        { kind: 'toolCallId', toolCallId: 'call_1' },
      ]),
    );
  });

  test('a data-bearing block with no derivedFrom is unattested regardless of a supplied attested claim', () => {
    const event = toolCompleted({
      uiBlock: {
        type: 'card',
        body: 'All checks passed',
        fields: [{ label: 'Coverage', value: '98%' }],
        // No derivedFrom at all — a bare forged claim.
        attestationState: 'attested',
        provenanceDigest: 'a'.repeat(64),
      },
    });
    const sanitized = sanitizeUIBlockEventProvenance(
      event,
    ) as ToolCompletedEvent;
    const output = sanitized.output as { uiBlock: Record<string, unknown> };

    expect(output.uiBlock.attestationState).toBe('unattested');
    expect(output.uiBlock.provenanceDigest).toBeUndefined();
    expect(output.uiBlock.derivedFrom).toBeUndefined();
  });

  // M6: the reverse override — a self-declared 'unattested'/'decorative' on
  // a block that DOES carry valid sources must not survive either. The
  // host-derived state wins in both directions, not just the one that
  // looks like an attack.
  test('reverse override: a self-declared decorative/unattested claim on a genuinely valid data-bearing block is corrected to attested', () => {
    const decorativeClaim = toolCompleted({
      uiBlock: {
        type: 'table',
        columns: ['Name'],
        rows: [['report.md']],
        derivedFrom: [{ kind: 'toolCallId', toolCallId: 'call_1' }],
        attestationState: 'decorative',
      },
    });
    const unattestedClaim = toolCompleted({
      uiBlock: {
        type: 'table',
        columns: ['Name'],
        rows: [['report.md']],
        derivedFrom: [{ kind: 'toolCallId', toolCallId: 'call_1' }],
        attestationState: 'unattested',
      },
    });

    for (const event of [decorativeClaim, unattestedClaim]) {
      const sanitized = sanitizeUIBlockEventProvenance(
        event,
      ) as ToolCompletedEvent;
      const output = sanitized.output as { uiBlock: Record<string, unknown> };
      expect(output.uiBlock.attestationState).toBe('attested');
      expect(output.uiBlock.provenanceDigest).toBe(
        computeUIBlockProvenanceDigest([
          { kind: 'toolCallId', toolCallId: 'call_1' },
        ]),
      );
    }
  });

  test('a decorative block (no data-bearing fields) is always stamped decorative, ignoring any supplied claim', () => {
    const event = toolCompleted({
      uiBlock: {
        type: 'card',
        body: 'All checks passed',
        attestationState: 'attested',
        provenanceDigest: 'a'.repeat(64),
        derivedFrom: [{ kind: 'toolCallId', toolCallId: 'call_1' }],
      },
    });
    const sanitized = sanitizeUIBlockEventProvenance(
      event,
    ) as ToolCompletedEvent;
    const output = sanitized.output as { uiBlock: Record<string, unknown> };

    expect(output.uiBlock.attestationState).toBe('decorative');
    expect(output.uiBlock.provenanceDigest).toBeUndefined();
    expect(output.uiBlock.derivedFrom).toBeUndefined();
  });

  test('sanitizes every entry of a uiBlocks array', () => {
    const event = toolCompleted({
      uiBlocks: [
        {
          type: 'table',
          columns: ['Name'],
          rows: [['a']],
          attestationState: 'attested',
          provenanceDigest: 'forged',
        },
        { type: 'code', code: 'echo hi', attestationState: 'attested' },
      ],
    });
    const sanitized = sanitizeUIBlockEventProvenance(
      event,
    ) as ToolCompletedEvent;
    const output = sanitized.output as {
      uiBlocks: Array<Record<string, unknown>>;
    };

    // No derivedFrom on the table → unattested, forged digest discarded.
    expect(output.uiBlocks[0]!.attestationState).toBe('unattested');
    expect(output.uiBlocks[0]!.provenanceDigest).toBeUndefined();
    // code is never data-bearing → decorative, regardless of the claim.
    expect(output.uiBlocks[1]!.attestationState).toBe('decorative');
  });

  test('unwraps the AI-SDK { type: "json", value } persisted shape and re-wraps it after sanitizing', () => {
    const event = toolCompleted({
      type: 'json',
      value: {
        uiBlock: {
          type: 'form',
          fields: [{ name: 'x', label: 'X', type: 'text' }],
          attestationState: 'attested',
        },
      },
    });
    const sanitized = sanitizeUIBlockEventProvenance(
      event,
    ) as ToolCompletedEvent;
    const output = sanitized.output as {
      type: string;
      value: { uiBlock: Record<string, unknown> };
    };

    expect(output.type).toBe('json');
    // form is never data-bearing → decorative, forged claim discarded.
    expect(output.value.uiBlock.attestationState).toBe('decorative');
  });

  test('the direct-persisted-part branch sees the SAME sanitized data as the live stream (M4) — persistence never carries an unsanitized copy', () => {
    // Simulates: whatever `event` this function hands back is exactly what
    // BOTH `eventStore.appendEvent` persists AND the SSE publish sends —
    // there is no second, unsanitized copy for a later replay/reload read
    // (`chatRuntimeStream.ts`'s direct-persisted-part branch) to see.
    const raw = toolCompleted({
      uiBlock: {
        type: 'table',
        columns: ['Name'],
        rows: [['a']],
        attestationState: 'attested',
        provenanceDigest: 'forged-digest',
      },
    });
    const forPersistence = sanitizeUIBlockEventProvenance(raw);
    const forLiveStream = sanitizeUIBlockEventProvenance(raw);

    expect(forPersistence).toEqual(forLiveStream);
    const persistedBlock = (forPersistence as ToolCompletedEvent).output as {
      uiBlock: Record<string, unknown>;
    };
    expect(persistedBlock.uiBlock.provenanceDigest).not.toBe('forged-digest');
    expect(persistedBlock.uiBlock.attestationState).toBe('unattested');
  });

  test('render_component output that already carries a real host-computed digest re-sanitizes idempotently', () => {
    const sources: UIBlockProvenanceSourceRef[] = [
      { kind: 'toolCallId', toolCallId: 'call_1' },
    ];
    const realDigest = computeUIBlockProvenanceDigest(sources);
    const event = toolCompleted({
      uiBlock: {
        type: 'card',
        body: 'Status',
        fields: [{ label: 'Coverage', value: '98%' }],
        derivedFrom: sources,
        provenanceDigest: realDigest,
        attestationState: 'attested',
      },
    });
    const sanitized = sanitizeUIBlockEventProvenance(
      event,
    ) as ToolCompletedEvent;
    const output = sanitized.output as { uiBlock: Record<string, unknown> };

    expect(output.uiBlock.provenanceDigest).toBe(realDigest);
    expect(output.uiBlock.attestationState).toBe('attested');
  });
});

/**
 * station#1399 fix round 2, B4 (independent review) — the sanitizer must
 * never throw an exception into an adapter stream. Proven with a poisoned
 * getter: a property access that throws, exactly the shape an exotic or
 * hostile tool output could produce.
 */
describe('safeSanitizeUIBlockEventProvenance — B4 failure policy', () => {
  const base = {
    eventId: 'evt_poison',
    provider: 'claude' as ProviderKind,
    threadId: 'thread_1',
    createdAt: '2026-03-28T12:00:00.000Z',
    turnId: 'turn_1',
    itemId: 'tool_item',
    toolCallId: 'call_1',
    toolName: 'render_summary',
    status: 'success' as const,
  };

  function poisonedUiBlockOutput(): unknown {
    const uiBlock: Record<string, unknown> = {
      type: 'table',
      columns: ['Name'],
    };
    // A getter that throws on every read — the sanitizer's own
    // `isRawUIBlockDataBearing` reads `.rows` to decide data-bearing-ness,
    // so this is exactly what an adversarial or corrupted tool output could
    // do to defeat that check.
    Object.defineProperty(uiBlock, 'rows', {
      enumerable: true,
      get() {
        throw new Error('poisoned getter: rows');
      },
    });
    return { uiBlocks: [uiBlock] };
  }

  test('never throws — the caller gets a value back, not an exception', () => {
    const event: ToolCompletedEvent = {
      ...base,
      method: 'tool.completed',
      output: poisonedUiBlockOutput(),
    };
    expect(() => safeSanitizeUIBlockEventProvenance(event)).not.toThrow();
  });

  test('logs a warning naming the event (B4: "log a warning naming the block")', () => {
    const event: ToolCompletedEvent = {
      ...base,
      method: 'tool.completed',
      output: poisonedUiBlockOutput(),
    };
    const onWarn = vi.fn();
    safeSanitizeUIBlockEventProvenance(event, onWarn);
    expect(onWarn).toHaveBeenCalledTimes(1);
    const [message, meta] = onWarn.mock.calls[0]!;
    expect(message).toMatch(/sanitizer threw/);
    expect(meta).toMatchObject({ eventId: 'evt_poison' });
  });

  test('never drops the event — the returned event still carries its identity', () => {
    const event: ToolCompletedEvent = {
      ...base,
      method: 'tool.completed',
      output: poisonedUiBlockOutput(),
    };
    const result = safeSanitizeUIBlockEventProvenance(event, vi.fn());
    expect(result.eventId).toBe('evt_poison');
    expect(result.method).toBe('tool.completed');
  });

  test('never publishes the unsanitized carrier — nothing recoverable from the poisoned block survives', () => {
    const event: ToolCompletedEvent = {
      ...base,
      method: 'tool.completed',
      output: poisonedUiBlockOutput(),
    };
    const result = safeSanitizeUIBlockEventProvenance(
      event,
      vi.fn(),
    ) as ToolCompletedEvent;
    // The output is either force-stripped to unattested, or dropped
    // wholesale (the last-resort tier) — either way, no `attestationState`
    // of 'attested' and no forged digest can have survived.
    const serialized = JSON.stringify(result.output ?? null);
    expect(serialized).not.toContain('"attestationState":"attested"');
  });
});

/**
 * station#1399 fix round 2, B2 (independent review) — sanitization at the
 * message-SERVE boundary, distinct from the event-write boundary above:
 * this is what closes the FileMemory bypass the reviewer found (a
 * `ConversationMessage` read back from `memory-adapter-messages.ts` never
 * becomes a `CanonicalRuntimeEvent`, so `sanitizeUIBlockEventProvenance`
 * never sees it).
 */
describe('sanitizeConversationMessagesUIBlockProvenance', () => {
  function messageWithToolOutput(output: unknown): ConversationMessage {
    return {
      id: 'msg_1',
      role: 'assistant',
      parts: [
        {
          type: 'tool-render_summary',
          toolCallId: 'call_1',
          output,
        },
      ],
    };
  }

  // This is the B2 reproduction: a well-shaped, internally-consistent
  // forged tuple (real derivedFrom + a fake digest + attestationState
  // already 'attested') — exactly what the independent review proved
  // survives the CLIENT mirror (see uiBlocks.test.ts's
  // "mirrors an explicit attested claim..." test) when nothing server-side
  // ever recomputed it. Server-SERVE sanitization must not let it through.
  test('a well-shaped forged tuple served from the FileMemory store does NOT survive serving', () => {
    const messages = [
      messageWithToolOutput({
        uiBlocks: [
          {
            type: 'table',
            columns: ['Metric', 'Value'],
            rows: [['Coverage', 98]],
            derivedFrom: [{ kind: 'toolCallId', toolCallId: 'call_1' }],
            provenanceDigest: 'b'.repeat(64),
            attestationState: 'attested',
          },
        ],
      }),
    ];

    const served = sanitizeConversationMessagesUIBlockProvenance(messages);
    const output = served[0]!.parts[0]!.output as {
      uiBlocks: Array<Record<string, unknown>>;
    };

    // The block IS genuinely data-bearing with a real source, so it is
    // correctly 'attested' after serving — but with the HOST'S digest, not
    // the forged one the store happened to contain.
    expect(output.uiBlocks[0]!.attestationState).toBe('attested');
    expect(output.uiBlocks[0]!.provenanceDigest).not.toBe('b'.repeat(64));
    expect(output.uiBlocks[0]!.provenanceDigest).toBe(
      computeUIBlockProvenanceDigest([
        { kind: 'toolCallId', toolCallId: 'call_1' },
      ]),
    );
  });

  test('a forged attested claim with no real sources does not survive serving', () => {
    const messages = [
      messageWithToolOutput({
        uiBlock: {
          type: 'card',
          body: 'All checks passed',
          fields: [{ label: 'Coverage', value: '98%' }],
          attestationState: 'attested',
          provenanceDigest: 'a'.repeat(64),
        },
      }),
    ];

    const served = sanitizeConversationMessagesUIBlockProvenance(messages);
    const output = served[0]!.parts[0]!.output as {
      uiBlock: Record<string, unknown>;
    };
    expect(output.uiBlock.attestationState).toBe('unattested');
    expect(output.uiBlock.provenanceDigest).toBeUndefined();
  });

  test('a message with no ui-block-bearing parts is returned unchanged (same reference)', () => {
    const messages: ConversationMessage[] = [
      {
        id: 'msg_2',
        role: 'user',
        parts: [{ type: 'text', text: 'hello' }],
      },
    ];
    expect(sanitizeConversationMessagesUIBlockProvenance(messages)).toBe(
      messages,
    );
  });

  test('B4: a poisoned part is sanitized to unattested rather than throwing, and a warning names it', () => {
    const uiBlock: Record<string, unknown> = { type: 'table', columns: ['x'] };
    Object.defineProperty(uiBlock, 'rows', {
      enumerable: true,
      get() {
        throw new Error('poisoned');
      },
    });
    const messages = [messageWithToolOutput({ uiBlocks: [uiBlock] })];
    const onWarn = vi.fn();

    expect(() =>
      sanitizeConversationMessagesUIBlockProvenance(messages, onWarn),
    ).not.toThrow();
    expect(onWarn).toHaveBeenCalled();
  });

  // station#1399 micro-round, M2 (independent review) — the existing
  // poisoned-part tests above only cover `part.output`; the DIRECT
  // `part.uiBlock` branch (the memory-store write shape) has its own
  // fallback (`forceUIBlockCandidateUnattested`), and that fallback can
  // itself throw — it spreads the SAME raw object, so a getter poisoned to
  // throw on every read (not just the first) throws again during the
  // fallback attempt. Before the fix this second throw was uncaught here
  // and would have reached the /messages route as a 500 instead of a
  // sanitized response.
  function messageWithDirectUiBlock(uiBlock: unknown): ConversationMessage {
    return {
      id: 'msg_poisoned_direct',
      role: 'assistant',
      parts: [
        { type: 'ui-block', toolCallId: 'call_1', uiBlock } as MessagePart,
      ],
    };
  }

  test('a direct part.uiBlock poisoned on EVERY read (defeating the fallback too) never throws and drops the field', () => {
    const uiBlock: Record<string, unknown> = { type: 'table', columns: ['x'] };
    Object.defineProperty(uiBlock, 'rows', {
      enumerable: true,
      get() {
        // Throws every time it's read — including the fallback's own
        // `{...block}` spread, which reads it again.
        throw new Error('poisoned: rows (every read)');
      },
    });
    const messages = [messageWithDirectUiBlock(uiBlock)];
    const onWarn = vi.fn();

    let result: ConversationMessage[] | undefined;
    expect(() => {
      result = sanitizeConversationMessagesUIBlockProvenance(messages, onWarn);
    }).not.toThrow();

    // Warned at least twice: once for the primary sanitizer's failure, once
    // for the fallback's own failure.
    expect(onWarn.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(
      onWarn.mock.calls.some(([message]) =>
        /fallback also threw/.test(message as string),
      ),
    ).toBe(true);

    // The field is gone rather than carrying anything recoverable from the
    // poisoned object — served JSON would omit it entirely.
    const servedPart = result?.[0]?.parts[0] as
      | (MessagePart & { uiBlock?: unknown })
      | undefined;
    expect(servedPart?.uiBlock).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(
      '"attestationState":"attested"',
    );
  });
});

describe('safeSanitizeUIBlockCarrierOutput — B4 on a bare carrier', () => {
  test('never throws on a poisoned candidate; logs and force-strips', () => {
    const uiBlock: Record<string, unknown> = { type: 'card', body: 'hi' };
    Object.defineProperty(uiBlock, 'fields', {
      enumerable: true,
      get() {
        throw new Error('poisoned: fields');
      },
    });
    const onWarn = vi.fn();
    const result = safeSanitizeUIBlockCarrierOutput({ uiBlock }, onWarn);
    expect(onWarn).toHaveBeenCalled();
    // Even a poisoned candidate that defeats the "blank it" fallback too
    // (the spread re-triggers the same poisoned getter) must not leak an
    // attested claim — the ultimate fallback tier drops the whole carrier
    // (`undefined`) rather than propagate or publish anything from it.
    expect(JSON.stringify(result) ?? '').not.toContain(
      '"attestationState":"attested"',
    );
  });
});
