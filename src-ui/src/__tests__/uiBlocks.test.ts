import type { UIBlock } from '@kontourai/station-contracts/ui-block';
import { describe, expect, test } from 'vitest';
import { upsertToolResultBlocks } from '../hooks/orchestration/messageParts';
import { extractUIBlocks } from '../utils/uiBlocks';

describe('ui block helpers', () => {
  test('extracts valid card and table blocks from tool output', () => {
    expect(
      extractUIBlocks({
        uiBlocks: [
          {
            type: 'card',
            title: 'Summary',
            body: 'Ready to ship',
          },
          {
            type: 'table',
            columns: ['Metric', 'Value'],
            rows: [['Coverage', 98]],
          },
          {
            type: 'code',
            title: 'config',
            caption: 'station.config.json',
            language: 'json',
            code: '{ "mcpUiHost": true }',
          },
          { type: 'unknown' },
        ],
      }),
    ).toEqual([
      {
        type: 'card',
        title: 'Summary',
        body: 'Ready to ship',
        tone: undefined,
        fields: undefined,
        id: undefined,
 // no fields → decorative, no data claim (archive#1399).
        attestationState: 'decorative',
      },
      {
        type: 'table',
        columns: ['Metric', 'Value'],
        rows: [['Coverage', 98]],
        caption: undefined,
        id: undefined,
        title: undefined,
// rows → data-bearing, but no derivedFrom was supplied: rendered
// (never dropped) and marked unattested, not silently 'attested'.
        derivedFrom: undefined,
        provenanceDigest: undefined,
        attestationState: 'unattested',
      },
      {
        type: 'code',
        title: 'config',
        caption: 'station.config.json',
        language: 'json',
        code: '{ "mcpUiHost": true }',
        id: undefined,
// code is inert text, not structured data → always decorative.
        attestationState: 'decorative',
      },
    ]);
  });

// archive#1399, (independent review —, confirmed by
// triage): this test used to ENSHRINE the exact bug the review caught —
// it supplied a `derivedFrom` array and a completely fabricated
// `provenanceDigest` ('a'.repeat(64), not a hash of anything) with no
// `attestationState` claim at all, and asserted BOTH survived as
// `attested` + the forged digest verbatim. That is exactly how a tool
// this module has no way to trust could paint an unverified claim with
// Station's own "checked" visual. Inverted per the ruling: a supplied
// digest/derivedFrom with no matching attestationState claim MUST NOT
// mint 'attested', and the forged digest MUST NOT survive.
  test('a data-bearing block with derivedFrom but no attestationState claim is unattested — the forged digest does not survive', () => {
    const [block] = extractUIBlocks({
      uiBlocks: [
        {
          type: 'table',
          columns: ['Metric', 'Value'],
          rows: [['Coverage', 98]],
          derivedFrom: [{ kind: 'toolCallId', toolCallId: 'call_1' }],
// A fabricated digest — not a real hash of anything, and no tool
// output can independently prove it is. Mere presence must not
// mint 'attested' anymore.
          provenanceDigest: 'a'.repeat(64),
        },
      ],
    });
    expect(block?.attestationState).toBe('unattested');
    expect(block?.provenanceDigest).toBeUndefined();
    expect(block?.provenanceDigest).not.toBe('a'.repeat(64));
  });

 // archive#1399 fix, : this test does NOT
// prove a forged tuple can't reach the UI — the reviewer's own probe
// showed the opposite, that a WELL-SHAPED forged tuple (real derivedFrom
// + fake digest + attestationState already 'attested', all mutually
// consistent) sails straight through this mirror, because this module
// cannot independently verify a digest. It only proves this module's
// DESIGNED behavior: it trusts server-sanitized input by design, and
// relies ENTIRELY on the server (`safeSanitizeUIBlockEventProvenance` at
// the write/publish seams, `sanitizeConversationMessagesUIBlockProvenance`
// at the message-serve boundary — both in
// `src-server/runtime/conversation/ui-block-provenance.ts`) to have
// already made the claim true before this code ever runs. The actual
// "does a forged tuple survive" proof lives server-side, in
// `ui-block-provenance.test.ts`'s
// "a well-shaped forged tuple served from the FileMemory store does NOT
// survive serving".
  test('trusts a server-sanitized attested claim by design — the client cannot verify a digest itself', () => {
    const [block] = extractUIBlocks({
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
    });
    expect(block?.attestationState).toBe('attested');
    expect(block?.provenanceDigest).toBe('b'.repeat(64));
  });

  test('a self-declared attested claim on a data-bearing block with NO sources is never trusted — downgraded', () => {
    const [block] = extractUIBlocks({
      uiBlocks: [
        {
          type: 'table',
          columns: ['Metric', 'Value'],
          rows: [['Coverage', 98]],
// No real derivedFrom, but the tool output lies about its state.
          attestationState: 'attested',
        },
      ],
    });
    expect(block?.attestationState).toBe('unattested');
  });

 //  — the reverse override, observed at THIS layer.
// The full host-derived correction (self-declared decorative/unattested
// on a genuinely valid data-bearing block gets corrected UP to 'attested')
// is server-only — this module cannot independently verify a digest, so
// its authority is downgrade-only: a self-declared non-'attested' claim on
// data-bearing content with real sources still reads 'unattested' here,
// never silently promoted. The upgrade correction is covered server-side
// in `ui-block-provenance.test.ts`'s "reverse override" test.
  test('a self-declared decorative claim on a data-bearing block with real sources is not promoted here (downgrade-only authority)', () => {
    const [block] = extractUIBlocks({
      uiBlocks: [
        {
          type: 'table',
          columns: ['Metric', 'Value'],
          rows: [['Coverage', 98]],
          derivedFrom: [{ kind: 'toolCallId', toolCallId: 'call_1' }],
          attestationState: 'decorative',
        },
      ],
    });
    expect(block?.attestationState).toBe('unattested');
  });

  test('drops a code block with no code string', () => {
    expect(
      extractUIBlocks({ uiBlocks: [{ type: 'code', language: 'ts' }] }),
    ).toEqual([]);
  });

  test('extracts a form block, keeping only valid fields', () => {
    expect(
      extractUIBlocks({
        uiBlock: {
          type: 'form',
          title: 'Approve gate',
          submitLabel: 'Approve',
          fields: [
            {
              name: 'decision',
              label: 'Decision',
              type: 'select',
              options: ['approve', 'reject', 7],
            },
            { name: 'note', label: 'Note', type: 'textarea', required: true },
            { name: 'bad', label: 'Bad', type: 'range' },
            { label: 'No name', type: 'text' },
          ],
        },
      }),
    ).toEqual([
      {
        type: 'form',
        id: undefined,
        title: 'Approve gate',
        description: undefined,
        submitLabel: 'Approve',
        fields: [
          {
            name: 'decision',
            label: 'Decision',
            type: 'select',
            required: undefined,
            placeholder: undefined,
            defaultValue: undefined,
            options: ['approve', 'reject'],
          },
          {
            name: 'note',
            label: 'Note',
            type: 'textarea',
            required: true,
            placeholder: undefined,
            defaultValue: undefined,
            options: undefined,
          },
        ],
// form fields are input definitions, not asserted facts → decorative.
        attestationState: 'decorative',
      },
    ]);
  });

  test('drops a form block with no valid fields', () => {
    expect(
      extractUIBlocks({
        uiBlock: { type: 'form', fields: [{ type: 'text' }] },
      }),
    ).toEqual([]);
  });

  test('inserts ui blocks immediately after their tool result', () => {
    const parts = upsertToolResultBlocks(
      [
        {
          type: 'tool-invocation',
          toolCallId: 'tool-1',
          sourceEventId: 'result-1',
          toolName: 'summarize',
        },
      ],
      'tool-1',
      'result-1',
      [
        {
          type: 'card',
          title: 'Summary',
          body: 'Ready to ship',
        } satisfies UIBlock,
      ],
    );

    expect(parts).toHaveLength(2);
    expect(parts[1]).toMatchObject({
      type: 'ui-block',
      toolCallId: 'tool-1',
      sourceEventId: 'result-1',
      uiBlock: {
        type: 'card',
        title: 'Summary',
        body: 'Ready to ship',
      },
    });
  });

  test('keeps UI blocks for repeated calls distinct by terminal event id', () => {
    const base = [
      {
        type: 'tool-invocation' as const,
        toolCallId: 'tool',
        sourceEventId: 'result-a',
      },
      {
        type: 'tool-invocation' as const,
        toolCallId: 'tool',
        sourceEventId: 'result-b',
      },
    ];
    const withFirst = upsertToolResultBlocks(base, 'tool', 'result-a', [
      { type: 'card', title: 'A', body: 'first' } satisfies UIBlock,
    ]);
    const withBoth = upsertToolResultBlocks(withFirst, 'tool', 'result-b', [
      { type: 'card', title: 'B', body: 'second' } satisfies UIBlock,
    ]);
    const duplicate = upsertToolResultBlocks(withBoth, 'tool', 'result-b', [
      { type: 'card', title: 'B', body: 'second' } satisfies UIBlock,
    ]);
    const blocks = duplicate.filter((part) => part.type === 'ui-block');
    expect(blocks).toHaveLength(2);
    expect(blocks.map((part) => part.sourceEventId)).toEqual([
      'result-a',
      'result-b',
    ]);
  });
});
