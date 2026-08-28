import { describe, expect, test } from 'vitest';
import {
  deriveWorkflowPlanArtifact,
  deriveWorkflowRuntimeStrip,
  parseInlineMarkdown,
  renderInlineMarkdown,
  toWorkflowPlanArtifact,
} from '../components/flow/WorkflowPlanPanel';
import type { ChatMessage } from '../types';
import type { PlanArtifact } from '../utils/planArtifacts';

describe('deriveWorkflowPlanArtifact', () => {
  test('parses plan steps from reasoning updates', () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: '',
        timestamp: 1700000000000,
        contentParts: [
          {
            type: 'reasoning',
            content:
              '✅ Capture requirements\n🔄 Build workflow panel\n⬜ Verify coding layout visibility',
          },
        ],
      },
    ];

    const artifact = deriveWorkflowPlanArtifact(messages);

    expect(artifact).not.toBeNull();
    expect(artifact?.steps).toEqual([
      {
        id: 'plan-step-0',
        label: 'Capture requirements',
        status: 'completed',
      },
      {
        id: 'plan-step-1',
        label: 'Build workflow panel',
        status: 'in_progress',
      },
      {
        id: 'plan-step-2',
        label: 'Verify coding layout visibility',
        status: 'pending',
      },
    ]);
    expect(artifact?.markdown).toContain('# Workflow plan');
  });

  test('prefers the latest assistant plan markdown', () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: '# Earlier plan\n\n- [x] Done',
        timestamp: 1,
      },
      {
        role: 'assistant',
        content: '# Shipping plan\n\n- [x] Wire data\n- [ ] Render panel',
        timestamp: 2,
      },
    ];

    const artifact = deriveWorkflowPlanArtifact(messages);

    expect(artifact?.title).toBe('Shipping plan');
    expect(artifact?.steps).toHaveLength(2);
    expect(artifact?.markdown).toContain('# Shipping plan');
  });

  test('returns null when content is not plan-like', () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: 'General status update without any plan structure.',
        timestamp: 1,
      },
    ];

    expect(deriveWorkflowPlanArtifact(messages)).toBeNull();
  });

  test('preserves in-progress status when converting cached plan artifacts', () => {
    const artifact: PlanArtifact = {
      source: 'reasoning',
      rawText:
        '✅ Capture requirements\n⏳ Build workflow panel\n⬜ Verify layout',
      steps: [
        { content: 'Capture requirements', status: 'completed' },
        { content: 'Build workflow panel', status: 'in_progress' },
        { content: 'Verify layout', status: 'pending' },
      ],
      updatedAt: '2026-01-01T00:00:00.000Z',
    };

    const workflowArtifact = toWorkflowPlanArtifact(artifact);

    expect(workflowArtifact?.markdown).toContain('- [>] Build workflow panel');
    expect(workflowArtifact?.steps[1]).toMatchObject({
      label: 'Build workflow panel',
      status: 'in_progress',
    });
  });
});

describe('deriveWorkflowRuntimeStrip — runtime-state strip derivation', () => {
  test('pending approvals win as an attention state, even alongside other signals', () => {
    expect(
      deriveWorkflowRuntimeStrip({
        pendingApprovals: 2,
        isProcessingStep: true,
        status: 'running',
      }),
    ).toEqual({
      label: 'Approval required (2)',
      tone: 'attention',
      live: true,
    });
  });

  test('in-flight tool activity is a live state', () => {
    expect(
      deriveWorkflowRuntimeStrip({ isProcessingStep: true, status: 'idle' }),
    ).toEqual({ label: 'Tool activity running', tone: 'live', live: true });
  });

  test('awaiting-approval status is an attention state', () => {
    expect(deriveWorkflowRuntimeStrip({ status: 'awaiting-approval' })).toEqual(
      { label: 'Awaiting approval', tone: 'attention', live: true },
    );
  });

  test('running/sending status is a live state', () => {
    expect(deriveWorkflowRuntimeStrip({ status: 'running' })).toEqual({
      label: 'Engine running',
      tone: 'live',
      live: true,
    });
    expect(deriveWorkflowRuntimeStrip({ status: 'sending' })).toEqual({
      label: 'Engine running',
      tone: 'live',
      live: true,
    });
  });

  test('completed/exited status is a complete, non-live state', () => {
    expect(deriveWorkflowRuntimeStrip({ status: 'completed' })).toEqual({
      label: 'Engine complete',
      tone: 'complete',
      live: false,
    });
    expect(deriveWorkflowRuntimeStrip({ status: 'exited' })).toEqual({
      label: 'Engine complete',
      tone: 'complete',
      live: false,
    });
  });

  test('no runtimeState, and an unrecognized status, both yield null (no strip rendered)', () => {
    expect(deriveWorkflowRuntimeStrip(undefined)).toBeNull();
    expect(deriveWorkflowRuntimeStrip({ status: 'idle' })).toBeNull();
    expect(deriveWorkflowRuntimeStrip({})).toBeNull();
  });
});

describe('parseInlineMarkdown — Steps view inline formatting (#764)', () => {
  test('bounds an unterminated inline-link label (station#2384)', () => {
    const input = '['.repeat(50_000);
    const startedAt = performance.now();
    expect(parseInlineMarkdown(input)).toEqual([
      { type: 'text', value: input },
    ]);
    expect(performance.now() - startedAt).toBeLessThan(250);
  });

  test('bounds a shared ]( suffix with an unterminated destination (station#2384)', () => {
    const input = `${'['.repeat(50_000)}](${'x'.repeat(50_000)}`;
    const startedAt = performance.now();
    expect(parseInlineMarkdown(input)).toEqual([
      { type: 'text', value: input },
    ]);
    expect(performance.now() - startedAt).toBeLessThan(250);
  });

  test('bounds repeated ]( candidates with no closing paren (station#2384)', () => {
    // Each `[x](` is a candidate whose destination scan finds no `)`. A
    // per-candidate scan would rescan the trailing run for every `[`; the
    // monotonic parser scans it once.
    const input = `${'[x]('.repeat(25_000)}${'z'.repeat(50_000)}`;
    const startedAt = performance.now();
    expect(parseInlineMarkdown(input)).toEqual([
      { type: 'text', value: input },
    ]);
    expect(performance.now() - startedAt).toBeLessThan(250);
  });

  test('bounds many opening brackets sharing one distant close bracket (station#2384)', () => {
    const input = `${'['.repeat(25_000)}${'x'.repeat(50_000)}]`;
    const startedAt = performance.now();
    expect(parseInlineMarkdown(input)).toEqual([
      { type: 'text', value: input },
    ]);
    expect(performance.now() - startedAt).toBeLessThan(250);
  });

  test('closes a link label at the first ], not greedily (station#2384)', () => {
    // `[a]` is not a link (no `(` follows), so it stays text and only
    // `[b](c)` links — a greedy label would wrongly capture `a] [b`.
    expect(parseInlineMarkdown('[a] [b](https://x)')).toEqual([
      { type: 'text', value: '[a] ' },
      { type: 'link', value: 'b', href: 'https://x' },
    ]);
  });

  test('leaves a nested-bracket link label as plain text (station#2384)', () => {
    // Documented limitation of this lightweight inline parser: a label with
    // nested brackets is not linkified (balanced nesting is out of scope for
    // this small step-label parser). The text is preserved.
    expect(parseInlineMarkdown('[a [b]](https://x)')).toEqual([
      { type: 'text', value: '[a [b]](https://x)' },
    ]);
  });

  test('bounds many complete adjacent links without rescanning (station#2384)', () => {
    const input = '[a](https://x)'.repeat(20_000);
    const startedAt = performance.now();
    const parsed = parseInlineMarkdown(input);
    expect(parsed).toHaveLength(20_000);
    expect(parsed[0]).toEqual({
      type: 'link',
      value: 'a',
      href: 'https://x',
    });
    expect(performance.now() - startedAt).toBeLessThan(250);
  });

  test('handles empty labels and terminal brackets as plain markup', () => {
    // `[](x)` is an empty-label link (matches the parser's link shape);
    // `[]` has an empty destination and stays text; a trailing `]` is text.
    expect(parseInlineMarkdown('[](https://x)')).toEqual([
      { type: 'link', value: '', href: 'https://x' },
    ]);
    expect(parseInlineMarkdown('keep []() here')).toEqual([
      { type: 'text', value: 'keep []() here' },
    ]);
    expect(parseInlineMarkdown('trailing ]')).toEqual([
      { type: 'text', value: 'trailing ]' },
    ]);
  });

  test('parses a bold span, matching the issue screenshot pattern', () => {
    expect(
      parseInlineMarkdown('**Mobile layout overhaul** — target mobile layout'),
    ).toEqual([
      { type: 'bold', value: 'Mobile layout overhaul' },
      { type: 'text', value: ' — target mobile layout' },
    ]);
  });

  test('parses inline code spans', () => {
    expect(parseInlineMarkdown('Run `npm test` before merging')).toEqual([
      { type: 'text', value: 'Run ' },
      { type: 'code', value: 'npm test' },
      { type: 'text', value: ' before merging' },
    ]);
  });

  test('parses markdown links', () => {
    expect(
      parseInlineMarkdown('See [the docs](https://example.com/docs) first'),
    ).toEqual([
      { type: 'text', value: 'See ' },
      { type: 'link', value: 'the docs', href: 'https://example.com/docs' },
      { type: 'text', value: ' first' },
    ]);
  });

  test('keeps long but valid link labels and URLs as links (station#2384)', () => {
    const label = `label-${'a'.repeat(2_000)}`;
    const href = `https://example.test/${'b'.repeat(2_000)}`;
    expect(parseInlineMarkdown(`[${label}](${href})`)).toEqual([
      { type: 'link', value: label, href },
    ]);
  });

  test('keeps an empty link destination as plain text', () => {
    expect(parseInlineMarkdown('Keep [label]() intact')).toEqual([
      { type: 'text', value: 'Keep [label]() intact' },
    ]);
  });

  test('passes plain text through untouched', () => {
    expect(parseInlineMarkdown('Verify coding layout visibility')).toEqual([
      { type: 'text', value: 'Verify coding layout visibility' },
    ]);
  });
});

describe('renderInlineMarkdown — link scheme guard (#764)', () => {
  const elements = (text: string) =>
    (renderInlineMarkdown(text) as {
      type: unknown;
      props: { href?: string };
    }[]) ?? [];

  test('https links render as anchors with the href intact', () => {
    const nodes = elements('[docs](https://example.test/guide)');
    expect(
      nodes.some(
        (n) => n.type === 'a' && n.props.href === 'https://example.test/guide',
      ),
    ).toBe(true);
  });

  test('javascript: links never render as anchors — text only', () => {
    const nodes = elements('[click me](javascript:alert(1))');
    expect(nodes.some((n) => n.type === 'a')).toBe(false);
    expect(JSON.stringify(nodes)).toContain('click me');
  });
});
