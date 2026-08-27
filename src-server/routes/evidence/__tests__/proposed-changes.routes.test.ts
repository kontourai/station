import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';

vi.mock('../../../telemetry/metrics.js', () => ({
  reviewDecisions: { add: vi.fn() },
  reviewProposals: { add: vi.fn() },
  reviewQueueDepthSamples: { add: vi.fn() },
  reviewTimeToDecision: { record: vi.fn() },
}));

const { createProposedChangeRoutes } = await import('../proposed-changes.js');
const { ProposedChangeService } = await import(
  '../../../services/projects/proposed-change-service.js'
);

describe('ProposedChange Routes', () => {
  let dir: string;
  let service: InstanceType<typeof ProposedChangeService>;
  let app: ReturnType<typeof createProposedChangeRoutes>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'proposed-change-routes-test-'));
    service = new ProposedChangeService(dir);
    app = createProposedChangeRoutes(service);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('POST / creates and GET / filters proposed changes', async () => {
    const created = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'session-1',
        projectId: 'project-a',
        path: 'README.md',
        changeType: 'modify',
        contentKind: 'markdown',
        baseSnapshot: { content: '# Old' },
        proposedSnapshot: { content: '# New' },
        sourceRuntime: 'claude',
      }),
    });

    expect(created.status).toBe(201);
    const createdBody = await json(created);
    expect(createdBody.success).toBe(true);

    const listBody = await json(
      await app.request('/?status=pending&projectId=project-a'),
    );
    expect(listBody.data).toEqual([
      expect.objectContaining({
        id: createdBody.data.id,
        path: 'README.md',
      }),
    ]);
  });

  test('approve, reject, and bulk decision routes update statuses', async () => {
    const first = await service.create({
      sessionId: 'session-1',
      projectId: 'project-a',
      path: 'a.ts',
      changeType: 'modify',
      contentKind: 'code',
      baseSnapshot: { content: 'a' },
      proposedSnapshot: { content: 'b' },
      sourceRuntime: 'codex',
    });
    const second = await service.create({
      sessionId: 'session-1',
      projectId: 'project-a',
      path: 'b.ts',
      changeType: 'modify',
      contentKind: 'code',
      baseSnapshot: { content: 'a' },
      proposedSnapshot: { content: 'b' },
      sourceRuntime: 'codex',
    });
    const third = await service.create({
      sessionId: 'session-1',
      projectId: 'project-a',
      path: 'c.ts',
      changeType: 'modify',
      contentKind: 'code',
      baseSnapshot: { content: 'a' },
      proposedSnapshot: { content: 'b' },
      sourceRuntime: 'codex',
    });

    const approveBody = await json(
      await app.request(`/${first.id}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'ship it' }),
      }),
    );
    expect(approveBody.data.status).toBe('approved');

    const rejectBody = await json(
      await app.request(`/${second.id}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'not safe' }),
      }),
    );
    expect(rejectBody.data.status).toBe('rejected');

    const bulkBody = await json(
      await app.request('/bulk/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [third.id], reason: 'batch' }),
      }),
    );
    expect(bulkBody.data).toEqual([
      expect.objectContaining({ id: third.id, status: 'approved' }),
    ]);
  });

  test('returns 409 when deciding an already-decided change', async () => {
    const change = await service.create({
      sessionId: 'session-1',
      projectId: 'project-a',
      path: 'a.ts',
      changeType: 'modify',
      contentKind: 'code',
      baseSnapshot: { content: 'a' },
      proposedSnapshot: { content: 'b' },
      sourceRuntime: 'codex',
    });

    await app.request(`/${change.id}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const res = await app.request(`/${change.id}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(409);
  });

  test('returns 409 and preserves the existing record for a duplicate caller id', async () => {
    const body = {
      id: 'caller-provided-change',
      sessionId: 'session-1',
      projectId: 'project-a',
      path: 'a.ts',
      changeType: 'modify',
      contentKind: 'code',
      baseSnapshot: { content: 'a' },
      proposedSnapshot: { content: 'b' },
      sourceRuntime: 'codex',
    };
    expect(
      (
        await app.request('/', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      ).status,
    ).toBe(201);
    const duplicate = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, path: 'replacement.ts' }),
    });

    expect(duplicate.status).toBe(409);
    expect(service.get(body.id)?.path).toBe('a.ts');
  });
});
