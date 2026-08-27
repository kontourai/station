import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { StarterWorkModule } from '../starter-work-module.js';

describe('StarterWorkModule', () => {
  it.each([
    {
      starterId: 'inspect-approval' as const,
      targetRef: { kind: 'approval' as const, id: 'notification-1' },
    },
    {
      starterId: 'inspect-receipt' as const,
      targetRef: {
        kind: 'receipt' as const,
        owner: 'independent-review' as const,
        id: 'receipt-1',
        projectSlug: 'alpha',
      },
    },
    {
      starterId: 'run-scheduled-check' as const,
      targetRef: {
        kind: 'receipt' as const,
        owner: 'scheduler-run' as const,
        id: 'schedule:built-in:station-starter-check:run-1',
      },
    },
  ])(
    'persists exact $starterId correlation without owner facts',
    async (input) => {
      const root = await mkdtemp(join(tmpdir(), 'starter-work-'));
      const file = join(root, 'starter-work.json');
      const module = new StarterWorkModule(
        file,
        () => '2026-08-24T00:00:00.000Z',
      );
      await expect(
        module.bind({ ...input, operationId: `operation:${input.starterId}` }),
      ).resolves.toMatchObject({ outcome: 'bound', replayed: false });
      const stored = JSON.parse(await readFile(file, 'utf8'));
      expect(stored.bindings).toEqual([
        {
          schemaVersion: 1,
          ...input,
          operationId: `operation:${input.starterId}`,
          boundAt: '2026-08-24T00:00:00.000Z',
        },
      ]);
      expect(JSON.stringify(stored)).not.toContain('completion');
    },
  );

  it('persists only exact correlation and binds idempotently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'starter-work-'));
    const file = join(root, 'starter-work.json');
    const module = new StarterWorkModule(
      file,
      () => '2026-08-23T00:00:00.000Z',
    );
    const input = {
      starterId: 'start-task' as const,
      operationId: 'op-1',
      targetRef: {
        kind: 'task' as const,
        id: 'task-1',
        projectId: 'project-1',
      },
    };
    await expect(module.bind(input)).resolves.toMatchObject({
      outcome: 'bound',
      replayed: false,
      binding: { boundAt: '2026-08-23T00:00:00.000Z' },
    });
    await expect(module.bind(input)).resolves.toMatchObject({
      outcome: 'bound',
      replayed: true,
    });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      schemaVersion: 1,
      bindings: [
        { schemaVersion: 1, ...input, boundAt: '2026-08-23T00:00:00.000Z' },
      ],
      launches: [],
    });
  });

  it('persists an in-flight dispatch fence and replays its durable terminal outcome', async () => {
    const root = await mkdtemp(join(tmpdir(), 'starter-work-'));
    const module = new StarterWorkModule(join(root, 'starter-work.json'));
    const binding = (
      await module.bind({
        starterId: 'start-task',
        operationId: 'op-1',
        targetRef: { kind: 'task', id: 'task-1', projectId: 'project-1' },
      })
    ).binding;
    const first = await module.beginLaunch({
      operationId: 'op-1',
      task: { kind: 'task', id: 'task-1', projectId: 'project-1' },
      binding,
    });
    expect(first.replayed).toBe(false);
    expect(
      (
        await module.beginLaunch({
          ...first.record,
          task: first.record.task,
          binding,
        })
      ).replayed,
    ).toBe(true);
    await module.completeLaunch(
      'op-1',
      { state: 'indeterminate', reason: 'lost response', retrySafe: false },
      { state: 'NOT_VERIFIED', reason: 'owner outcome is unknown' },
    );
    expect(
      (
        await module.beginLaunch({
          ...first.record,
          task: first.record.task,
          binding,
        })
      ).record.dispatch,
    ).toEqual({
      state: 'indeterminate',
      reason: 'lost response',
      retrySafe: false,
    });
  });

  it('preserves an admitted dispatch fence across correlation clear', async () => {
    const root = await mkdtemp(join(tmpdir(), 'starter-work-'));
    const module = new StarterWorkModule(join(root, 'starter-work.json'));
    const binding = (
      await module.bind({
        starterId: 'start-task',
        operationId: 'op-clear-race',
        targetRef: { kind: 'task', id: 'task-1', projectId: 'project-1' },
      })
    ).binding;
    const launch = {
      operationId: 'op-clear-race',
      task: { kind: 'task' as const, id: 'task-1', projectId: 'project-1' },
      binding,
    };
    await module.beginLaunch(launch);
    await module.clearBinding('start-task');
    await expect(module.status('start-task')).resolves.toEqual({
      state: 'unbound',
    });
    await expect(module.beginLaunch(launch)).resolves.toMatchObject({
      replayed: true,
    });
    await expect(
      module.completeLaunch(
        'op-clear-race',
        { state: 'indeterminate', reason: 'response lost', retrySafe: false },
        { state: 'NOT_VERIFIED', reason: 'owner outcome is unknown' },
      ),
    ).resolves.toMatchObject({ dispatch: { state: 'indeterminate' } });
  });

  it('fails closed for corrupt correlation data', async () => {
    const root = await mkdtemp(join(tmpdir(), 'starter-work-'));
    const file = join(root, 'starter-work.json');
    await writeFile(
      file,
      JSON.stringify({
        schemaVersion: 1,
        bindings: [
          {
            schemaVersion: 1,
            starterId: 'x',
            targetRef: { kind: 'task', id: 't', projectId: 'p' },
            operationId: 'o',
            boundAt: 'now',
            title: 'forbidden',
          },
        ],
      }),
    );
    await expect(new StarterWorkModule(file).status('x')).rejects.toThrow(
      'corrupt',
    );
  });

  it('fails closed for malformed or duplicate dispatch fences', async () => {
    const root = await mkdtemp(join(tmpdir(), 'starter-work-'));
    const file = join(root, 'starter-work.json');
    const binding = {
      schemaVersion: 1,
      starterId: 'start-task',
      targetRef: { kind: 'task', id: 'task-1', projectId: 'project-1' },
      operationId: 'op-1',
      boundAt: '2026-08-23T00:00:00.000Z',
    } as const;
    const launch = {
      operationId: 'op-1',
      task: binding.targetRef,
      binding,
    };
    await writeFile(
      file,
      JSON.stringify({
        schemaVersion: 1,
        bindings: [binding],
        launches: [{ ...launch, untrusted: true }],
      }),
    );
    await expect(
      new StarterWorkModule(file).status('start-task'),
    ).rejects.toThrow('corrupt');

    await writeFile(
      file,
      JSON.stringify({
        schemaVersion: 1,
        bindings: [binding],
        launches: [launch, launch],
      }),
    );
    await expect(
      new StarterWorkModule(file).status('start-task'),
    ).rejects.toThrow('corrupt');
  });

  it('rejects persisted bindings whose reference kind belongs to another starter', async () => {
    const root = await mkdtemp(join(tmpdir(), 'starter-work-'));
    const file = join(root, 'starter-work.json');
    for (const binding of [
      {
        schemaVersion: 1,
        starterId: 'continue-session',
        targetRef: { kind: 'task', id: 'task-1', projectId: 'project-1' },
        operationId: 'wrong-kind-1',
        boundAt: '2026-08-23T00:00:00.000Z',
      },
      {
        schemaVersion: 1,
        starterId: 'start-task',
        targetRef: { kind: 'session', id: 'session-1' },
        operationId: 'wrong-kind-2',
        boundAt: '2026-08-23T00:00:00.000Z',
      },
    ]) {
      await writeFile(
        file,
        JSON.stringify({ schemaVersion: 1, bindings: [binding], launches: [] }),
      );
      await expect(
        new StarterWorkModule(file).status(binding.starterId),
      ).rejects.toThrow('corrupt');
    }
  });

  it('fails closed when persisted bindings name non-Starter Work kinds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'starter-work-'));
    const file = join(root, 'starter-work.json');
    for (const targetRef of [
      { kind: 'project', id: 'project-1' },
      { kind: 'run', owner: 'flow', projectId: 'project-1', id: 'run-1' },
      {
        kind: 'artifact',
        owner: 'run-output',
        runId: 'run-1',
        id: 'artifact-1',
      },
      { kind: 'agent', id: 'agent-1' },
    ]) {
      await writeFile(
        file,
        JSON.stringify({
          schemaVersion: 1,
          bindings: [
            {
              schemaVersion: 1,
              starterId: 'start-task',
              targetRef,
              operationId: 'not-a-starter-reference',
              boundAt: '2026-08-23T00:00:00.000Z',
            },
          ],
          launches: [],
        }),
      );
      await expect(
        new StarterWorkModule(file).status('start-task'),
      ).rejects.toThrow('corrupt');
    }
  });

  it('rejects runtime-shaped bindings before they can poison a prior store', async () => {
    const root = await mkdtemp(join(tmpdir(), 'starter-work-'));
    const file = join(root, 'starter-work.json');
    const module = new StarterWorkModule(
      file,
      () => '2026-08-24T00:00:00.000Z',
    );
    await module.bind({
      starterId: 'start-task',
      operationId: 'admitted-binding',
      targetRef: { kind: 'task', id: 'task-1', projectId: 'project-1' },
    });
    const before = await readFile(file, 'utf8');

    for (const targetRef of [
      { kind: 'project', id: 'project-1' },
      { kind: 'run', owner: 'flow', projectId: 'project-1', id: 'run-1' },
      {
        kind: 'artifact',
        owner: 'run-output',
        runId: 'run-1',
        id: 'artifact-1',
      },
      { kind: 'agent', id: 'agent-1' },
      {
        kind: 'task',
        id: 'task-2',
        projectId: 'project-1',
        title: 'copied authority',
      },
    ]) {
      await expect(
        module.bind({
          starterId: 'start-task',
          operationId: `invalid-${targetRef.kind}`,
          targetRef,
        } as never),
      ).rejects.toThrow('invalid');
      await expect(readFile(file, 'utf8')).resolves.toBe(before);
    }
  });

  it('refuses capacity before admitting a remote dispatch fence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'starter-work-'));
    const file = join(root, 'starter-work.json');
    const binding = {
      schemaVersion: 1 as const,
      starterId: 'start-task',
      targetRef: { kind: 'task', id: 'task-current', projectId: 'project-1' },
      operationId: 'op-current',
      boundAt: '2026-08-23T00:00:00.000Z',
    } as const;
    const launches = Array.from({ length: 100 }, (_, index) => ({
      operationId: `op-${index}`,
      task: {
        kind: 'task',
        id: `task-${index}`,
        projectId: 'project-1',
      },
      binding: {
        ...binding,
        operationId: `op-${index}`,
        targetRef: {
          kind: 'task',
          id: `task-${index}`,
          projectId: 'project-1',
        },
      },
    }));
    await writeFile(
      file,
      JSON.stringify({ schemaVersion: 1, bindings: [binding], launches }),
    );
    const module = new StarterWorkModule(file);
    await expect(
      module.beginLaunch({
        operationId: 'op-over-capacity',
        task: {
          kind: 'task',
          id: 'task-over-capacity',
          projectId: 'project-1',
        },
        binding: {
          ...binding,
          operationId: 'op-over-capacity',
          targetRef: {
            kind: 'task',
            id: 'task-over-capacity',
            projectId: 'project-1',
          },
        },
      }),
    ).rejects.toThrow('capacity');
    expect(JSON.parse(await readFile(file, 'utf8')).launches).toHaveLength(100);
  });
});
