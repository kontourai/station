import {
  encodeTaskToolResultReference,
  encodeTaskTurnReference,
} from '@kontourai/station-contracts/task-graph';
import {
  parseHostedTenantRegistry,
  sessionReadAuthorityFromRequest,
  tenantId,
} from '@kontourai/station-contracts/tenancy';
import { describe, expect, test, vi } from 'vitest';
import { basisInteropCollection } from '../../../../tests/helpers/basis-interop-fixture';
import { createTaskBasisAppReadModule } from '../../../services/projects/task-basis-app-read-module';
import type { TaskGraphService } from '../../../services/projects/task-graph-service';
import { createTaskRoutes } from '../tasks';

function fixture(hosted = false, keptOnly = false) {
  const source = basisInteropCollection();
  if (keptOnly) {
    source.answers = [];
    source.unassociated = [];
  }
  let credentialCurrent = true;
  let sessionCurrent = true;
  let scope = { projectId: 'fixture-project' };
  let links = source.answers.map((answer, i) => ({
    id: answer.answerReferenceId,
    targetId: encodeTaskTurnReference('fixture-session', `turn-${i}`),
  }));
  let resultLinks = source.keptToolResults.map((result) => ({
    id: result.referenceId,
    targetId: encodeTaskToolResultReference(
      result.ref.threadId,
      result.ref.resultId,
    ),
  }));
  let onRead = () => {};
  const scopeRead = vi.fn(() => ({ ...scope }));
  const linksRead = vi.fn(() => links.map((link) => ({ ...link })));
  const graph = {
    readTaskTurnReferenceScope: scopeRead,
    readTaskTurnReferenceLinks: linksRead,
    readTaskToolResultReferenceLinks: () =>
      resultLinks.map((link) => ({ ...link })),
  } as unknown as TaskGraphService;
  const read = vi.fn(async () => {
    onRead();
    return { status: 'found' as const, data: source };
  });
  const module = createTaskBasisAppReadModule({ read, isEnabled: () => true });
  const revoke = vi.spyOn(module, 'revoke');
  const registry = parseHostedTenantRegistry({
    schemaVersion: 1,
    tenants: [{ id: 'alpha', authority: 'alpha.test' }],
  });
  const app = createTaskRoutes(graph, {
    taskDispatcher: {
      dispatch: async () => {
        throw new Error('Unexpected mutation');
      },
    },
    taskBasisAppRead: module,
    readAuthorityForRequest: () =>
      sessionReadAuthorityFromRequest(
        'fixture-user',
        hosted ? { tenantId: tenantId('alpha') } : undefined,
        hosted ? registry : undefined,
      ),
    callerBindingForRequest: () => 'caller_'.padEnd(32, 'a'),
    isRequestPrincipalCurrent: () => credentialCurrent,
    canReadSession: (sessionId) =>
      sessionCurrent && sessionId === 'fixture-session',
  });
  const request = (body: string, method = 'POST') =>
    app.request('/fixture-task/basis/app-read', {
      method,
      headers: { 'Content-Type': 'application/json' },
      body,
    });
  return {
    app,
    read,
    revoke,
    linksRead,
    scopeRead,
    request,
    duringRead: (callback: () => void) => {
      onRead = callback;
    },
    revokeCredential: () => {
      credentialCurrent = false;
    },
    revokeSession: () => {
      sessionCurrent = false;
    },
    replaceLink: () => {
      links = links.map((link, i) =>
        i
          ? link
          : {
              ...link,
              targetId: encodeTaskTurnReference('other-session', 'other-turn'),
            },
      );
    },
    replaceScope: () => {
      scope = { projectId: 'other-project' };
    },
    replaceResultLink: () => {
      resultLinks = resultLinks.map((link, i) =>
        i
          ? link
          : {
              ...link,
              targetId: encodeTaskToolResultReference(
                'other-session',
                'other-result',
              ),
            },
      );
    },
    substituteResult: () => {
      source.keptToolResults[0]!.ref.resultId = 'unkept-result';
    },
  };
}

async function expectUnavailable(response: Response) {
  expect(response.status).toBe(503);
  expect(response.headers.get('cache-control')).toContain('no-store');
  expect(await response.json()).toEqual({
    success: false,
    error: 'Basis unavailable',
  });
}

describe('Task Basis App owner API publication boundary', () => {
  test.each(['session', 'link', 'substitution'] as const)(
    'withholds kept-only pages when result %s changes during owner I/O',
    async (change) => {
      const f = fixture(false, true);
      f.duringRead(
        change === 'session'
          ? f.revokeSession
          : change === 'link'
            ? f.replaceResultLink
            : f.substituteResult,
      );
      await expectUnavailable(await f.request('{}'));
      expect(f.read).toHaveBeenCalledOnce();
      expect(f.revoke).toHaveBeenCalledOnce();
    },
  );

  test('publishes authorized kept-only pages without requiring any answer', async () => {
    const f = fixture(false, true);
    const response = await f.request('{}');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: {
        answers: [],
        keptToolResults: expect.arrayContaining([
          expect.objectContaining({ referenceId: 'fixture-kept-result-0' }),
        ]),
      },
    });
  });
  test.each([
    '',
    '{',
    'null',
    '[]',
    '{"policy":"read-only"}',
    '{"continuationToken":"forged"}',
    '{"occurrenceId":"forged"}',
  ])('rejects invalid body %s without reading the collection', async (body) => {
    const f = fixture();
    await expectUnavailable(await f.request(body));
    expect(f.read).not.toHaveBeenCalled();
  });

  test('opens, continues and revokes an exact read occurrence with no-store envelopes', async () => {
    const f = fixture();
    const first = await f.request('{}');
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toContain('no-store');
    const body = (await first.json()) as {
      meta: Record<string, { occurrenceId: string; continuationToken: string }>;
    };
    const meta = body.meta['station.task-basis-app/v1'];
    expect(meta.continuationToken).toMatch(/^[A-Za-z0-9_-]+$/);
    const next = await f.request(JSON.stringify(meta));
    expect(next.status).toBe(200);
    expect(next.headers.get('cache-control')).toContain('no-store');
    expect(await next.json()).toMatchObject({
      data: { answers: [expect.any(Object)] },
    });
    const revoked = await f.request(
      JSON.stringify({ occurrenceId: meta.occurrenceId }),
      'DELETE',
    );
    expect(revoked.status).toBe(200);
    expect(revoked.headers.get('cache-control')).toContain('no-store');
    await expectUnavailable(await f.request(JSON.stringify(meta)));
    expect(f.read).toHaveBeenCalledTimes(2);
  });

  test.each(['credential', 'session', 'link', 'scope'] as const)(
    'withholds the entire result when %s changes during the owner read',
    async (change) => {
      const f = fixture();
      f.duringRead(
        change === 'credential'
          ? f.revokeCredential
          : change === 'session'
            ? f.revokeSession
            : change === 'link'
              ? f.replaceLink
              : f.replaceScope,
      );
      await expectUnavailable(await f.request('{}'));
      expect(f.read).toHaveBeenCalledOnce();
      expect(f.revoke).toHaveBeenCalledWith(
        'fixture-task',
        'caller_'.padEnd(32, 'a'),
        expect.any(String),
      );
    },
  );

  test('hosted requests do not touch personal Task graph or collection owners', async () => {
    const f = fixture(true);
    await expectUnavailable(await f.request('{}'));
    expect(f.scopeRead).not.toHaveBeenCalled();
    expect(f.linksRead).not.toHaveBeenCalled();
    expect(f.read).not.toHaveBeenCalled();
  });

  test('publication lookup outage is the same generic no-store unavailable result', async () => {
    const f = fixture();
    f.duringRead(() =>
      f.linksRead.mockImplementation(() => {
        throw new Error('SECRET_SCOPE_CANARY');
      }),
    );
    await expectUnavailable(await f.request('{}'));
    expect(f.revoke).toHaveBeenCalledOnce();
  });
});
