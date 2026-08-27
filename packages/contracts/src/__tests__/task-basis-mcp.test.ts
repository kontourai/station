import { describe, expect, test } from 'vitest';
import { createStationAnswerBinding } from '../task-basis.js';
import {
  buildStationTaskBasisMcpPage,
  parseStationTaskBasisMcpPage,
  STATION_TASK_BASIS_MCP_MAX_SERIALIZED_BYTES,
  STATION_TASK_BASIS_MCP_PAGE_VERSION,
} from '../task-basis-mcp.js';

const projection = {
  version: 'surface.basis-projection/v1',
  answer: {
    owner: { authority: '@kontourai/thread' },
    state: 'available',
    observedAt: '2026-08-25T00:00:00.000Z',
    value: {
      ref: {
        authority: '@kontourai/thread',
        schemaVersion: '1.2.0',
        kind: 'assistant-message',
        standing: 'observed',
        threadId: 'session-a',
        messageId: 'message-a',
      },
      fact: 'answer-observed',
      observedAt: '2026-08-25T00:00:00.000Z',
    },
  },
  standing: 'execution-only',
  unresolvedReason: null,
  assessment: {
    owner: { authority: '@kontourai/surface' },
    state: 'not-captured',
    observedAt: '2026-08-25T00:00:00.000Z',
  },
  regions: {
    inputs: [],
    execution: [],
    process: [],
    outcomes: [],
    support: [],
    sources: [],
    live: [],
  },
  relationships: [],
  gaps: [],
};

function collection(answerCount = 1) {
  return {
    version: 'station.task-basis-collection/v4',
    taskId: 'task-a',
    answers: Array.from({ length: answerCount }, (_, index) => ({
      answerReferenceId: `answer-${index}`,
      projection: {
        ...projection,
        answer: {
          ...projection.answer,
          value: {
            ...projection.answer.value,
            ref: {
              ...projection.answer.value.ref,
              messageId: `message-${index}`,
            },
          },
        },
      },
    })),
    unassociated: [
      {
        kind: 'task-output',
        taskId: 'task-a',
        outputId: 'output-a',
        kept: true,
      },
    ],
    keptToolResults: [] as ReturnType<typeof keptToolResults>,
    keptGateEvaluations: [],
    gaps: [{ state: 'restricted' }],
  };
}

function keptToolResults(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    referenceId: `tool-result-${index}`,
    ref: {
      authority: '@kontourai/thread',
      schemaVersion: '1.2.0',
      kind: 'result',
      threadId: 'session-a',
      resultId: `result-${index}`,
    },
    kept: true as const,
    associatedAnswerReferenceIds: [] as string[],
  }));
}

function escapedLargeProjection(evidenceCount = 55, includeTail = false) {
  return {
    ...projection,
    standing: 'unresolved',
    unresolvedReason: 'claim-not-in-assessment',
    assessment: {
      owner: { authority: '@kontourai/surface' },
      state: 'available',
      observedAt: '2026-08-25T00:00:00.000Z',
      value: {
        version: 'surface.answer-assessment/v2',
        ref: {
          authority: '@kontourai/surface',
          schemaVersion: 'surface.answer-assessment/v2',
          kind: 'answer-assessment',
          bundleId: 'bundle-a',
          claimId: 'claim-a',
        },
        found: false,
        bundle: {
          id: 'bundle-a',
          schemaVersion: 1,
          source: 'test',
          generatedAt: '2026-08-25T00:00:00.000Z',
        },
        claim: null,
        policy: null,
        evidence: {
          cited: Array.from({ length: evidenceCount }, (_, index) => ({
            id: `evidence-${index}`,
            label: 'opaque ref',
            sourceRef: '\u0001'.repeat(1_000),
            locator: null,
            observedAt: '2026-08-25T00:00:00.000Z',
            supportStrength: 'cited',
            result: 'passed',
            blocksClaim: false,
          })),
          entails: includeTail
            ? [
                {
                  id: 'tail',
                  label: 'tail',
                  sourceRef: 'x'.repeat(1_543),
                  locator: null,
                  observedAt: '2026-08-25T00:00:00.000Z',
                  supportStrength: 'entails',
                  result: 'passed',
                  blocksClaim: false,
                },
              ]
            : [],
          counterevidence: [],
          undeclared: [],
        },
        derivation: { available: true, directInputs: [] },
        gaps: [],
      },
    },
  };
}

describe('whole-task Basis MCP page contract', () => {
  test('builds deterministic bounded pages with mandatory gaps and a progressing continuation', () => {
    const first = buildStationTaskBasisMcpPage(collection(9));
    expect(first).toMatchObject({
      version: STATION_TASK_BASIS_MCP_PAGE_VERSION,
      status: 'available',
      offsets: {
        answerOffset: 0,
        unassociatedOffset: 0,
        keptToolResultOffset: 0,
        keptGateEvaluationOffset: 0,
      },
      gaps: [{ state: 'restricted' }],
      continuation: {
        offsets: {
          answerOffset: 8,
          unassociatedOffset: 0,
          keptToolResultOffset: 0,
          keptGateEvaluationOffset: 0,
        },
      },
    });
    if (first?.status !== 'available') throw new Error('expected page');
    expect(first.answers).toHaveLength(8);
    expect(first).not.toHaveProperty('standing');
    const second = buildStationTaskBasisMcpPage(
      collection(9),
      first.continuation?.offsets,
    );
    expect(second).toMatchObject({
      status: 'available',
      offsets: {
        answerOffset: 8,
        unassociatedOffset: 0,
        keptToolResultOffset: 0,
        keptGateEvaluationOffset: 0,
      },
      answers: [{ answerReferenceId: 'answer-8' }],
      unassociated: [{ kind: 'task-output', outputId: 'output-a' }],
      gaps: [{ state: 'restricted' }],
    });
  });

  test('uses the public Surface parser for every projection and rejects duplicates', () => {
    const invalid = collection();
    invalid.answers[0]!.projection = { ...projection, standing: 'policy-met' };
    expect(buildStationTaskBasisMcpPage(invalid)).toBeNull();
    const duplicate = collection(2);
    duplicate.answers[1]!.answerReferenceId = 'answer-0';
    expect(buildStationTaskBasisMcpPage(duplicate)).toBeNull();
    duplicate.answers[1]!.answerReferenceId = 'opaque:answer-1';
    duplicate.unassociated = [
      {
        kind: 'task-output',
        taskId: 'task-a',
        outputId: 'opaque:output',
        kept: true,
      },
      {
        kind: 'task-output',
        taskId: 'task-a',
        outputId: 'opaque:output',
        kept: true,
      },
    ];
    expect(buildStationTaskBasisMcpPage(duplicate)).toBeNull();
  });

  test('parses bounded explicit unavailable results rather than dropping them', () => {
    const unavailable = {
      version: STATION_TASK_BASIS_MCP_PAGE_VERSION,
      status: 'unavailable',
      taskId: 'task-a',
      offsets: {
        answerOffset: 0,
        unassociatedOffset: 0,
        keptToolResultOffset: 0,
        keptGateEvaluationOffset: 0,
      },
      reason: 'page-size-exceeded',
    };
    expect(parseStationTaskBasisMcpPage(unavailable)).toEqual(unavailable);
  });

  test('paginates kept tool results independently and never duplicates them', () => {
    const source = collection();
    source.answers = [];
    source.unassociated = [];
    source.keptToolResults = keptToolResults(17);
    const first = buildStationTaskBasisMcpPage(source);
    expect(first).toMatchObject({
      status: 'available',
      offsets: {
        answerOffset: 0,
        unassociatedOffset: 0,
        keptToolResultOffset: 0,
        keptGateEvaluationOffset: 0,
      },
      continuation: {
        offsets: {
          answerOffset: 0,
          unassociatedOffset: 0,
          keptToolResultOffset: 16,
          keptGateEvaluationOffset: 0,
        },
      },
    });
    if (first?.status !== 'available') throw new Error('expected page');
    expect(parseStationTaskBasisMcpPage(first)).toEqual(first);
    expect(first.keptToolResults.map((item) => item.referenceId)).toEqual(
      Array.from({ length: 16 }, (_, index) => `tool-result-${index}`),
    );
    const second = buildStationTaskBasisMcpPage(
      source,
      first.continuation?.offsets,
    );
    expect(second).toMatchObject({
      status: 'available',
      offsets: {
        answerOffset: 0,
        unassociatedOffset: 0,
        keptToolResultOffset: 16,
        keptGateEvaluationOffset: 0,
      },
      keptToolResults: [
        expect.objectContaining({ referenceId: 'tool-result-16' }),
      ],
    });
    if (second?.status !== 'available') throw new Error('expected page');
    expect(second.continuation).toBeUndefined();
    expect(
      new Set([
        ...first.keptToolResults.map((item) => item.referenceId),
        ...second.keptToolResults.map((item) => item.referenceId),
      ]).size,
    ).toBe(17);
  });

  test('parses a result associated with an answer on an earlier page', () => {
    const page = parseStationTaskBasisMcpPage({
      version: STATION_TASK_BASIS_MCP_PAGE_VERSION,
      status: 'available',
      taskId: 'task-a',
      offsets: {
        answerOffset: 1,
        unassociatedOffset: 0,
        keptToolResultOffset: 0,
        keptGateEvaluationOffset: 0,
      },
      answers: [],
      unassociated: [],
      keptToolResults: [
        {
          ...keptToolResults(1)[0],
          associatedAnswerReferenceIds: ['answer-on-earlier-page'],
        },
      ],
      keptGateEvaluations: [],
      gaps: [],
    });
    expect(page).toMatchObject({
      status: 'available',
      keptToolResults: [
        expect.objectContaining({
          associatedAnswerReferenceIds: ['answer-on-earlier-page'],
        }),
      ],
    });
  });

  test('returns unavailable for a valid projection that expands past the serialized page budget', () => {
    const source = collection();
    source.answers[0]!.projection = escapedLargeProjection() as never;
    expect(buildStationTaskBasisMcpPage(source)).toMatchObject({
      status: 'unavailable',
      reason: 'page-size-exceeded',
    });
  });

  test('reserves worst-case continuation bytes while filling a near-cap page', () => {
    const source = collection(2);
    source.answers[0]!.projection = escapedLargeProjection(20) as never;
    source.answers[1]!.projection = escapedLargeProjection(20) as never;
    const page = buildStationTaskBasisMcpPage(source);
    if (page?.status !== 'available') throw new Error('expected page');
    expect(page.answers).toHaveLength(1);
    expect(page.continuation).toEqual({
      offsets: {
        answerOffset: 1,
        unassociatedOffset: 0,
        keptToolResultOffset: 0,
        keptGateEvaluationOffset: 0,
      },
    });
    expect(
      new TextEncoder().encode(JSON.stringify(page)).byteLength,
    ).toBeLessThanOrEqual(STATION_TASK_BASIS_MCP_MAX_SERIALIZED_BYTES);
  });

  test('admits a near-cap terminal page without reserving a continuation it cannot have', () => {
    const source = collection();
    source.unassociated = [];
    source.gaps = [];
    source.answers[0]!.projection = escapedLargeProjection(20, true) as never;
    const page = buildStationTaskBasisMcpPage(source);
    if (page?.status !== 'available') throw new Error('expected terminal page');
    expect(page.continuation).toBeUndefined();
    expect(
      new TextEncoder().encode(JSON.stringify(page)).byteLength,
    ).toBeGreaterThan(120_000);
    expect(parseStationTaskBasisMcpPage(page)).toEqual(page);
  });

  test('measures a terminal multi-stream page in its final shape at the exact byte limit', () => {
    const source = collection();
    source.taskId = 'a';
    source.answers[0]!.answerReferenceId = 'a';
    const terminal = escapedLargeProjection(20, true) as any;
    source.answers[0]!.projection = terminal;
    source.unassociated = [
      { kind: 'task-output', taskId: 'a', outputId: 'a', kept: true },
    ];
    source.gaps = [];
    // Derive the final body length from the real v3 header/row shape. The
    // escaped cited scalar supplies six serialized bytes per source byte; the
    // tail fills the remaining exact bytes without exceeding Flow's 4 KiB
    // scalar limit.
    const initial = buildStationTaskBasisMcpPage(source);
    if (initial?.status !== 'available') throw new Error('expected seed page');
    const initialBytes = new TextEncoder().encode(
      JSON.stringify(initial),
    ).byteLength;
    const remaining =
      STATION_TASK_BASIS_MCP_MAX_SERIALIZED_BYTES - initialBytes;
    const tail = terminal.assessment.value.evidence.entails[0];
    const cited = terminal.assessment.value.evidence.cited[0];
    const tailHeadroom = 4_096 - tail.sourceRef.length;
    const escapedExtra = Math.max(0, Math.ceil((remaining - tailHeadroom) / 6));
    cited.sourceRef += '\u0001'.repeat(escapedExtra);
    tail.sourceRef += 'x'.repeat(remaining - escapedExtra * 6);
    const page = buildStationTaskBasisMcpPage(source);
    if (page?.status !== 'available') throw new Error('expected terminal page');
    expect(page.continuation).toBeUndefined();
    expect(new TextEncoder().encode(JSON.stringify(page)).byteLength).toBe(
      131_072,
    );
    expect(parseStationTaskBasisMcpPage(page)).toEqual(page);

    const oneByteOver = JSON.parse(JSON.stringify(source)) as any;
    oneByteOver.answers[0].projection.assessment.value.evidence.entails[0].sourceRef +=
      'x';
    expect(buildStationTaskBasisMcpPage(oneByteOver)).toMatchObject({
      status: 'unavailable',
      reason: 'page-size-exceeded',
    });
  });

  test('fails closed for accessors, hostile proxies, and non-progressing continuation', () => {
    let reads = 0;
    const accessor = Object.defineProperty({}, 'answerOffset', {
      enumerable: true,
      get() {
        reads += 1;
        return 0;
      },
    });
    expect(buildStationTaskBasisMcpPage(collection(), accessor)).toBeNull();
    expect(reads).toBe(0);
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('nope');
        },
      },
    );
    expect(() => parseStationTaskBasisMcpPage(hostile)).not.toThrow();
    const page = buildStationTaskBasisMcpPage(collection());
    if (page?.status !== 'available') throw new Error('expected page');
    expect(
      parseStationTaskBasisMcpPage({
        ...page,
        continuation: { offsets: page.offsets },
      }),
    ).toBeNull();
    expect(
      parseStationTaskBasisMcpPage({ ...page, reason: undefined }),
    ).toBeNull();
    const accessorContinuation = { ...page };
    Object.defineProperty(accessorContinuation, 'continuation', {
      enumerable: true,
      get() {
        reads += 1;
        return undefined;
      },
    });
    expect(parseStationTaskBasisMcpPage(accessorContinuation)).toBeNull();
    expect(reads).toBe(0);
  });

  test('enforces per-page bounds and bounded in-memory offsets', () => {
    const source = collection();
    source.answers = [];
    source.unassociated = Array.from({ length: 17 }, (_, index) => ({
      kind: 'task-output' as const,
      taskId: 'task-a',
      outputId: `output-${index}`,
      kept: true as const,
    }));
    const first = buildStationTaskBasisMcpPage(source);
    expect(first).toMatchObject({
      status: 'available',
      unassociated: expect.arrayContaining([
        expect.objectContaining({ outputId: 'output-15' }),
      ]),
      continuation: {
        offsets: {
          answerOffset: 0,
          unassociatedOffset: 16,
          keptToolResultOffset: 0,
          keptGateEvaluationOffset: 0,
        },
      },
    });
    if (first?.status !== 'available') throw new Error('expected page');
    expect(first.unassociated).toHaveLength(16);
    expect(
      parseStationTaskBasisMcpPage({
        ...first,
        offsets: {
          answerOffset: 65,
          unassociatedOffset: 0,
          keptToolResultOffset: 0,
          keptGateEvaluationOffset: 0,
        },
      }),
    ).toBeNull();
    expect(
      parseStationTaskBasisMcpPage({
        ...first,
        offsets: {
          answerOffset: 0,
          unassociatedOffset: 64,
          keptToolResultOffset: 0,
          keptGateEvaluationOffset: 0,
        },
      }),
    ).toBeNull();
    expect(
      buildStationTaskBasisMcpPage({ ...source, taskId: '\ud800' }),
    ).toBeNull();
    expect(
      buildStationTaskBasisMcpPage({ ...source, taskId: '🧪'.repeat(257) }),
    ).toBeNull();
  });

  test('keeps distinct opaque binding tuples distinct', () => {
    const first = createStationAnswerBinding({
      sessionId: 's:a',
      turnId: 't',
      messageId: 'm',
    });
    const second = createStationAnswerBinding({
      sessionId: 's',
      turnId: 'a:t',
      messageId: 'm',
    });
    const source = collection();
    source.answers = [];
    source.unassociated = [
      { kind: 'answer-binding', binding: first, kept: true },
      { kind: 'answer-binding', binding: second, kept: true },
    ] as never;
    expect(buildStationTaskBasisMcpPage(source)).toMatchObject({
      status: 'available',
      unassociated: [{ binding: first }, { binding: second }],
    });
  });

  test('rejects Thread-valid but Station-oversized binding message ids', () => {
    const binding = createStationAnswerBinding({
      sessionId: 'session',
      turnId: 'turn',
      messageId: 'message',
    });
    const oversizedBinding = {
      ...binding,
      answer: { ...binding.answer, messageId: 'x'.repeat(1_025) },
    };
    const source = collection();
    source.answers = [];
    source.unassociated = [
      { kind: 'answer-binding', binding: oversizedBinding, kept: true },
    ] as never;
    expect(buildStationTaskBasisMcpPage(source)).toBeNull();
    const validSource = collection();
    validSource.answers = [];
    validSource.unassociated = [
      { kind: 'answer-binding', binding, kept: true },
    ] as never;
    const page = buildStationTaskBasisMcpPage(validSource);
    if (page?.status !== 'available') throw new Error('expected page');
    expect(
      parseStationTaskBasisMcpPage({
        ...page,
        unassociated: [
          { kind: 'answer-binding', binding: oversizedBinding, kept: true },
        ],
      }),
    ).toBeNull();
  });
});
