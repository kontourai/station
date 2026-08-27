import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StationTaskBasisCollection } from '@kontourai/station-contracts/task-basis';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { describe, expect, test, vi } from 'vitest';
import { basisInteropCollection } from '../../../../tests/helpers/basis-interop-fixture';
import {
  ConfigLoader,
  type IntegrationPolicySnapshot,
} from '../../../domain/config-loader.js';
import {
  createTaskBasisAppReadModule,
  TASK_BASIS_APP_MAX_PER_CALLER,
  TASK_BASIS_APP_MAX_SESSIONS,
  TASK_BASIS_APP_TTL_MS,
  type TaskBasisAppReadOutcome,
} from '../task-basis-app-read-module';

const caller = 'caller_'.padEnd(32, 'a');
const authority = () =>
  sessionReadAuthorityFromRequest('fixture-user', undefined, undefined);
const found = (data: StationTaskBasisCollection) => ({
  status: 'found' as const,
  data,
});

function nextInput(opened: TaskBasisAppReadOutcome) {
  expect(opened.status).toBe('available');
  if (opened.status !== 'available' || !opened.continuationToken)
    throw new Error('This proof requires a real live multipage token');
  return {
    taskId: 'fixture-task',
    occurrenceId: opened.occurrenceId,
    continuationToken: opened.continuationToken,
    callerBinding: caller,
    authority: authority(),
  };
}

function fixture() {
  let source = basisInteropCollection();
  let at = 0;
  let enabled = true;
  const read = vi.fn(async () => found(source));
  const module = createTaskBasisAppReadModule({
    read,
    isEnabled: () => enabled,
    now: () => at,
  });
  const open = () =>
    module.open({
      taskId: source.taskId,
      callerBinding: caller,
      authority: authority(),
    });
  return {
    module,
    read,
    open,
    source: () => source,
    replace: (value: StationTaskBasisCollection) => {
      source = value;
    },
    clock: (value: number) => {
      at = value;
    },
    enable: (value: boolean) => {
      enabled = value;
    },
  };
}

const policyIntegrationId = 'station-control';

function writePublicationPolicy(
  home: string,
  value: { enabled?: boolean; disabledTools?: string[] } = {},
) {
  writeFileSync(
    join(home, 'integrations', policyIntegrationId, 'integration.json'),
    JSON.stringify({
      id: policyIntegrationId,
      kind: 'mcp',
      command: 'station-control',
      ...value,
    }),
  );
}

function policyPath(home: string) {
  return join(home, 'integrations', policyIntegrationId, 'integration.json');
}

function policyHarness(
  input: {
    duringCapture?: () => void;
    read?: () => ReturnType<typeof found> | { status: 'unavailable' };
  } = {},
) {
  const home = mkdtempSync(join(tmpdir(), 'station-basis-policy-fence-'));
  mkdirSync(join(home, 'integrations', policyIntegrationId), {
    recursive: true,
  });
  writePublicationPolicy(home);
  const loader = new ConfigLoader({ projectHomeDir: home });
  let ownerReads = 0;
  let mutateAtOwnerRead = Number.POSITIVE_INFINITY;
  let mutate: () => void = () => {};
  let renderRevoked = false;
  const source = basisInteropCollection();
  const read = vi.fn(async () => {
    ownerReads += 1;
    if (ownerReads === mutateAtOwnerRead) mutate();
    return input.read?.() ?? found(source);
  });
  const module = createTaskBasisAppReadModule({
    read,
    isEnabled: () => true,
    capturePublicationPolicy: async () => {
      const snapshot =
        await loader.captureIntegrationPolicySnapshot(policyIntegrationId);
      input.duringCapture?.();
      if (
        !snapshot?.enabled ||
        snapshot.disabledTools.includes('get_task_basis') ||
        snapshot.disabledTools.includes('station-control_get_task_basis') ||
        renderRevoked
      )
        return null;
      return snapshot;
    },
    isPublicationPolicyCurrent: (snapshot) =>
      loader.isIntegrationPolicySnapshotCurrent(
        snapshot as IntegrationPolicySnapshot,
      ) && !renderRevoked,
  });
  return {
    home,
    module,
    read,
    open: () =>
      module.open({
        taskId: source.taskId,
        callerBinding: caller,
        authority: authority(),
      }),
    armFinalOwnerMutation: (at: number, action: () => void) => {
      mutateAtOwnerRead = at;
      mutate = action;
    },
    revokeRender: () => {
      renderRevoked = true;
    },
    cleanup: () => {
      try {
        chmodSync(policyPath(home), 0o600);
      } catch {
        // The policy path can deliberately be deleted or made unreadable.
      }
      rmSync(home, { recursive: true, force: true });
    },
  };
}

describe('independent Basis App read-session boundary proofs', () => {
  test.each([
    ['caller', { callerBinding: 'other_'.padEnd(32, 'b') }],
    ['task', { taskId: 'other-task' }],
    ['occurrence', { occurrenceId: 'other_'.padEnd(32, 'c') }],
    [
      'authority user',
      {
        authority: sessionReadAuthorityFromRequest(
          'other-user',
          undefined,
          undefined,
        ),
      },
    ],
  ])(
    'rejects %s substitution on a STILL LIVE token before owner I/O',
    async (_name, replacement) => {
      const f = fixture();
      const opened = await f.open();
      const args = nextInput(opened);
      await expect(
        f.module.continue({ ...args, ...replacement }),
      ).resolves.toEqual({ status: 'unavailable' });
      expect(f.read).toHaveBeenCalledTimes(2);
    },
  );

  test('another caller cannot burn a live token belonging to its legitimate caller', async () => {
    const f = fixture();
    const args = nextInput(await f.open());
    await f.module.continue({
      ...args,
      callerBinding: 'other_'.padEnd(32, 'b'),
    });
    const continued = await f.module.continue(args);
    expect(continued.status).toBe('available');
    expect(f.read).toHaveBeenCalledTimes(4);
  });

  test('two concurrent continuations using one live token issue one owner read', async () => {
    const f = fixture();
    const args = nextInput(await f.open());
    let release!: (value: ReturnType<typeof found>) => void;
    f.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const first = f.module.continue(args);
    await vi.waitFor(() => expect(f.read).toHaveBeenCalledTimes(3));
    await expect(f.module.continue(args)).resolves.toEqual({
      status: 'unavailable',
    });
    expect(f.read).toHaveBeenCalledTimes(3);
    release(found(f.source()));
    expect((await first).status).toBe('available');
    await expect(f.module.continue(args)).resolves.toEqual({
      status: 'unavailable',
    });
    expect(f.read).toHaveBeenCalledTimes(4);
  });

  test.each([
    'order',
    'answer identity',
    'output',
    'kept result',
    'gap',
  ] as const)(
    'rejects %s drift and makes the failed token terminal',
    async (change) => {
      const f = fixture();
      const args = nextInput(await f.open());
      const source = f.source();
      if (change === 'order')
        f.replace({ ...source, answers: [...source.answers].reverse() });
      if (change === 'answer identity')
        f.replace({
          ...source,
          answers: source.answers.map((item, i) =>
            i ? item : { ...item, answerReferenceId: 'changed-answer' },
          ),
        });
      if (change === 'output') f.replace({ ...source, unassociated: [] });
      if (change === 'kept result')
        f.replace({
          ...source,
          keptToolResults: [
            {
              referenceId: 'changed-tool-result',
              ref: {
                authority: '@kontourai/thread',
                schemaVersion: '1.2.0',
                kind: 'result',
                threadId: 'fixture-session',
                resultId: 'changed-result',
              },
              kept: true,
              associatedAnswerReferenceIds: [],
            },
          ],
        });
      if (change === 'gap')
        f.replace({
          ...source,
          gaps: [...source.gaps, { state: 'unavailable' }],
        });
      await expect(f.module.continue(args)).resolves.toEqual({
        status: 'unavailable',
      });
      f.replace(source);
      await expect(f.module.continue(args)).resolves.toEqual({
        status: 'unavailable',
      });
      expect(f.read).toHaveBeenCalledTimes(4);
    },
  );

  test('expired token is denied before owner I/O', async () => {
    const f = fixture();
    const args = nextInput(await f.open());
    f.clock(TASK_BASIS_APP_TTL_MS + 1);
    await expect(f.module.continue(args)).resolves.toEqual({
      status: 'unavailable',
    });
    expect(f.read).toHaveBeenCalledTimes(2);
  });

  test('expiry during an asynchronous owner read prevents late publication', async () => {
    const f = fixture();
    f.read.mockImplementationOnce(async () => {
      f.clock(TASK_BASIS_APP_TTL_MS + 1);
      return found(f.source());
    });
    await expect(f.open()).resolves.toEqual({ status: 'unavailable' });
  });

  test('owner outage consumes the token and never exposes exception text', async () => {
    const f = fixture();
    const args = nextInput(await f.open());
    f.read.mockRejectedValueOnce(new Error('SECRET_OWNER_CANARY'));
    await expect(f.module.continue(args)).resolves.toEqual({
      status: 'unavailable',
    });
    await expect(f.module.continue(args)).resolves.toEqual({
      status: 'unavailable',
    });
    expect(f.read).toHaveBeenCalledTimes(3);
  });

  test('policy failure before owner I/O is generic and terminates an existing token', async () => {
    const source = basisInteropCollection();
    const read = vi.fn(async () => found(source));
    let broken = false;
    const module = createTaskBasisAppReadModule({
      read,
      isEnabled: () => {
        if (broken) throw new Error('SECRET_POLICY_CANARY');
        return true;
      },
    });
    const args = nextInput(
      await module.open({
        taskId: source.taskId,
        callerBinding: caller,
        authority: authority(),
      }),
    );
    broken = true;
    await expect(module.continue(args)).resolves.toEqual({
      status: 'unavailable',
    });
    broken = false;
    await expect(module.continue(args)).resolves.toEqual({
      status: 'unavailable',
    });
    expect(read).toHaveBeenCalledTimes(2);
  });

  test('parallel opens reserve the per-caller cap before awaiting owners', async () => {
    const source = basisInteropCollection();
    let release!: (value: ReturnType<typeof found>) => void;
    const pending = new Promise<ReturnType<typeof found>>((resolve) => {
      release = resolve;
    });
    const read = vi.fn(() => pending);
    const module = createTaskBasisAppReadModule({
      read,
      isEnabled: () => true,
    });
    const opens = Array.from({ length: TASK_BASIS_APP_MAX_PER_CALLER }, () =>
      module.open({
        taskId: source.taskId,
        callerBinding: caller,
        authority: authority(),
      }),
    );
    await expect(
      module.open({
        taskId: source.taskId,
        callerBinding: caller,
        authority: authority(),
      }),
    ).resolves.toEqual({ status: 'unavailable' });
    await vi.waitFor(() =>
      expect(read).toHaveBeenCalledTimes(TASK_BASIS_APP_MAX_PER_CALLER),
    );
    release(found(source));
    expect(
      (await Promise.all(opens)).every(
        (result) => result.status === 'available',
      ),
    ).toBe(true);
  });

  test('global capacity is bounded even across distinct callers', async () => {
    const source = basisInteropCollection();
    const read = vi.fn(async () => found(source));
    const module = createTaskBasisAppReadModule({
      read,
      isEnabled: () => true,
    });
    const opens = await Promise.all(
      Array.from({ length: TASK_BASIS_APP_MAX_SESSIONS }, (_, i) =>
        module.open({
          taskId: source.taskId,
          callerBinding: `caller_${i}`.padEnd(32, 'a'),
          authority: authority(),
        }),
      ),
    );
    expect(opens.every((result) => result.status === 'available')).toBe(true);
    await expect(
      module.open({
        taskId: source.taskId,
        callerBinding: 'overflow_'.padEnd(32, 'z'),
        authority: authority(),
      }),
    ).resolves.toEqual({ status: 'unavailable' });
    expect(read).toHaveBeenCalledTimes(TASK_BASIS_APP_MAX_SESSIONS * 2);
  });

  test('rate limiting applies even when terminal pages retain no session', async () => {
    const full = basisInteropCollection();
    const read = vi.fn(async () =>
      found({
        ...full,
        answers: full.answers.slice(0, 1),
        keptToolResults: [],
      }),
    );
    const module = createTaskBasisAppReadModule({
      read,
      isEnabled: () => true,
      now: () => 0,
    });
    for (let i = 0; i < 64; i += 1) {
      expect(
        (
          await module.open({
            taskId: full.taskId,
            callerBinding: caller,
            authority: authority(),
          })
        ).status,
      ).toBe('available');
    }
    await expect(
      module.open({
        taskId: full.taskId,
        callerBinding: caller,
        authority: authority(),
      }),
    ).resolves.toEqual({ status: 'unavailable' });
    expect(read).toHaveBeenCalledTimes(128);
  });

  test('keeps a live continuation through rate limiting and reaches the final byte-limited result page', async () => {
    const initial = basisInteropCollection();
    const source: StationTaskBasisCollection = {
      ...initial,
      answers: [],
      unassociated: Array.from({ length: 64 }, (_, index) => ({
        kind: 'task-output',
        taskId: initial.taskId,
        outputId: `output-${index}-${'x'.repeat(1_000)}`,
        kept: true,
      })),
      keptToolResults: [
        {
          referenceId: 'r'.repeat(500),
          ref: {
            authority: '@kontourai/thread',
            schemaVersion: '1.2.0',
            kind: 'result',
            threadId: 't'.repeat(500),
            resultId: 'i'.repeat(500),
          },
          kept: true,
          associatedAnswerReferenceIds: [],
        },
      ],
      // This byte-limit proof isolates the oversized result stream. Flow's
      // independently paged Process stream is covered by the AppBridge UI
      // fixture rather than making this terminal-page budget impossible.
      keptGateEvaluations: [],
    };
    let at = 0;
    const module = createTaskBasisAppReadModule({
      read: async () => found(source),
      isEnabled: () => true,
      now: () => at,
      pageBudget: 2_000,
    });
    let outcome = await module.open({
      taskId: source.taskId,
      callerBinding: caller,
      authority: authority(),
    });
    const seenOutputs: string[] = [];
    const seenResults: string[] = [];
    for (let pageNumber = 0; pageNumber < 64; pageNumber += 1) {
      expect(outcome.status).toBe('available');
      if (outcome.status !== 'available') throw new Error('expected page');
      expect(outcome.page.status).toBe('available');
      if (outcome.page.status !== 'available') throw new Error('expected page');
      expect(outcome.page.answers).toEqual([]);
      expect(outcome.page.unassociated).toHaveLength(1);
      seenOutputs.push(
        ...outcome.page.unassociated.map((item) =>
          item.kind === 'task-output' ? item.outputId : '',
        ),
      );
      seenResults.push(
        ...outcome.page.keptToolResults.map((item) => item.referenceId),
      );
      if (pageNumber === 63) break;
      if (!outcome.continuationToken) throw new Error('expected continuation');
      outcome = await module.continue({
        taskId: source.taskId,
        occurrenceId: outcome.occurrenceId,
        continuationToken: outcome.continuationToken,
        callerBinding: caller,
        authority: authority(),
      });
    }
    if (outcome.status !== 'available' || !outcome.continuationToken)
      throw new Error('expected live continuation after answer pages');
    const input = {
      taskId: source.taskId,
      occurrenceId: outcome.occurrenceId,
      continuationToken: outcome.continuationToken,
      callerBinding: caller,
      authority: authority(),
    };
    await expect(module.continue(input)).resolves.toEqual({
      status: 'unavailable',
    });
    at = 60_001;
    outcome = await module.continue(input);
    expect(outcome).toMatchObject({
      status: 'available',
      page: {
        status: 'available',
        answers: [],
        keptToolResults: [
          expect.objectContaining({ referenceId: 'r'.repeat(500) }),
        ],
      },
    });
    expect(seenOutputs).toEqual(
      Array.from(
        { length: 64 },
        (_, index) => `output-${index}-${'x'.repeat(1_000)}`,
      ),
    );
    expect(new Set(seenOutputs).size).toBe(64);
    expect(seenResults).toEqual([]);
  });

  test.each([
    [
      'the integration is disabled',
      (harness: ReturnType<typeof policyHarness>) =>
        writePublicationPolicy(harness.home, { enabled: false }),
    ],
    [
      'the basis tool is disabled',
      (harness: ReturnType<typeof policyHarness>) =>
        writePublicationPolicy(harness.home, {
          disabledTools: ['station-control_get_task_basis'],
        }),
    ],
    [
      'MCP UI rendering is revoked',
      (harness: ReturnType<typeof policyHarness>) => harness.revokeRender(),
    ],
    [
      'the policy file is removed',
      (harness: ReturnType<typeof policyHarness>) =>
        rmSync(policyPath(harness.home)),
    ],
    [
      'the policy file becomes corrupt',
      (harness: ReturnType<typeof policyHarness>) =>
        writeFileSync(policyPath(harness.home), '{not-json'),
    ],
    [
      'the policy file becomes unreadable',
      (harness: ReturnType<typeof policyHarness>) =>
        chmodSync(policyPath(harness.home), 0o000),
    ],
  ])(
    'withholds both OPEN and CONTINUATION when %s during the final owner read',
    async (_label, mutate) => {
      const opening = policyHarness();
      try {
        opening.armFinalOwnerMutation(2, () => mutate(opening));
        await expect(opening.open()).resolves.toEqual({
          status: 'unavailable',
        });
      } finally {
        opening.cleanup();
      }

      const continuation = policyHarness();
      try {
        const opened = await continuation.open();
        const input = nextInput(opened);
        continuation.armFinalOwnerMutation(4, () => mutate(continuation));
        await expect(continuation.module.continue(input)).resolves.toEqual({
          status: 'unavailable',
        });
      } finally {
        continuation.cleanup();
      }
    },
  );

  test.each(['Flow membership', 'workspace', 'principal'] as const)(
    'withholds OPEN when %s changes while policy capture is in flight',
    async () => {
      let ownerCurrent = true;
      const harness = policyHarness({
        duringCapture: () => {
          ownerCurrent = false;
        },
        read: () =>
          ownerCurrent
            ? found(basisInteropCollection())
            : { status: 'unavailable' as const },
      });
      try {
        await expect(harness.open()).resolves.toEqual({
          status: 'unavailable',
        });
        expect(harness.read).toHaveBeenCalledOnce();
      } finally {
        harness.cleanup();
      }
    },
  );

  test('publishes an unchanged Basis fixture collection while the policy remains current', async () => {
    const harness = policyHarness();
    try {
      const result = await harness.open();
      expect(result.status).toBe('available');
      if (result.status !== 'available') throw new Error('expected a page');
      expect(result.page.status).toBe('available');
      if (result.page.status !== 'available') throw new Error('expected data');
      expect(result.page.answers[0]).toMatchObject({
        answerReferenceId: 'fixture-answer-0',
      });
      expect(harness.read).toHaveBeenCalledTimes(2);
    } finally {
      harness.cleanup();
    }
  });
});
