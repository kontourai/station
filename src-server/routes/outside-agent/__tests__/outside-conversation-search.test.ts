import { join } from 'node:path';
import { STATION_CONFINEMENT_METADATA_KEY } from '@kontourai/station-contracts/provider';
import { expect, test, vi } from 'vitest';
import {
  outsideMcpFixture,
  outsideMcpPayload,
} from '../../../__test-utils__/outside-agent-mcp-fixture.js';
import { awaitSessionAttachmentSettled } from '../../../__test-utils__/session-runtime-barriers.js';
import { createStationControlCallerRecordResolver } from '../../../runtime/mcp/station-control-caller.js';
import { createStationControlDispatchScope } from '../../../runtime/mcp/station-control-dispatch-scope.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { OrchestrationService } from '../../../services/orchestration/orchestration-service.js';

test('outside transcript search admits the granted Project before native ranking and host counts', async () => {
  let changeBeforeWorkerQuery = false;
  let workerReadAfterChange: 'accepted' | 'refused' | undefined;
  const fixture = await outsideMcpFixture(
    async ({ home, projects, cleanup }) => {
      const eventStore = new EventStore(join(home, 'events.sqlite'));
      const orchestrationService = new OrchestrationService({
        eventStore,
        adoptionLedger: eventStore.createAdoptionLedger(),
        eventBus: new EventBus(),
        adapterRegistry: {
          register() {},
          get: () => undefined,
          list: () => [],
        },
        logger: { debug() {}, warn() {} },
      });
      cleanup(async () => {
        await orchestrationService.shutdown();
        await expect.poll(() => eventStore.close().kind).toBe('closed');
      });

      const seed = (
        threadId: string,
        scope: 'alpha' | 'foreign' | undefined,
        prompt: string,
        host = false,
        minute = 0,
      ) => {
        const createdAt = new Date(
          Date.UTC(2026, 10, 20, 10, minute),
        ).toISOString();
        eventStore.appendEvent({
          eventId: `${threadId}:start`,
          threadId,
          sessionId: threadId,
          provider: 'codex',
          method: 'session.started',
          createdAt,
          metadata: {
            userId: 'operator',
            ...(scope
              ? { projectSlug: scope, localProjectId: `id-${scope}` }
              : {}),
            ...(host ? { [STATION_CONFINEMENT_METADATA_KEY]: 'host' } : {}),
          },
        });
        eventStore.upsertSession({
          threadId,
          provider: 'codex',
          status: 'ready',
          createdAt,
          updatedAt: createdAt,
        });
        eventStore.appendEvent({
          eventId: `${threadId}:prompt`,
          threadId,
          turnId: `${threadId}:turn`,
          provider: 'codex',
          method: 'turn.started',
          createdAt,
          prompt,
        });
      };
      seed(
        'project-readable',
        'alpha',
        'The cobalt deployment needs a dry run.',
      );
      seed('project-host', 'alpha', 'PRIVATE cobalt host prompt', true);
      seed('global-readable', undefined, 'The cobalt guide is global.');
      for (let index = 0; index < 24; index++)
        seed(
          `outside-project-${index}`,
          'foreign',
          'cobalt',
          index === 0,
          index + 1,
        );

      for (let index = 0; index < 42; index++)
        seed(`same-project-${index}-${'a'.repeat(54)}`, 'alpha', 'indigo');

      const projectIdForSlug = (slug: string) =>
        projects.find((p) => p.slug === slug)?.id;
      const conversationId = (id: string) =>
        eventStore.conversationForSession(id)?.conversationId;
      const conversationSessionIds = (id: string) =>
        eventStore.conversationSessions(id).map((session) => session.sessionId);
      const dispatchScope = createStationControlDispatchScope({
        resolveRecord: createStationControlCallerRecordResolver({
          actingPrincipal: (id) =>
            orchestrationService.resolveSessionActingPrincipal(id),
          startedMetadata: (id) =>
            orchestrationService.firstStartedMetadataOfThread(id),
          localProjectId: projectIdForSlug,
          conversationId,
        }),
        sessionOwnerId: (id) => orchestrationService.sessionRecordedOwnerId(id),
        sessionExists: (id) => orchestrationService.hasSessionStartRecord(id),
        sessionRunsHost: (id) => orchestrationService.sessionRunsHost(id),
        conversationThreads: (id) =>
          conversationSessionIds(conversationId(id) ?? id),
        conversationSessionIds,
        defaultSessionDirectory: () => undefined,
        projectIdForSlug,
        projectDirectories: () => projects,
        sessionCwd: (id) => eventStore.readSessionByThread(id)?.cwd,
        ownerMay: (owner, id) =>
          owner === 'operator' && projects.some((p) => p.id === id),
      });
      orchestrationService.initialize();
      await awaitSessionAttachmentSettled(orchestrationService);
      const worker = eventStore.createIsolatedTranscriptReads();
      const read = worker.search.bind(worker);
      vi.spyOn(worker, 'search').mockImplementation(async (...args) => {
        if (!changeBeforeWorkerQuery) return read(...args);
        changeBeforeWorkerQuery = false;
        eventStore.appendEvent({
          eventId: 'project-readable:host-decision',
          threadId: 'project-readable',
          sessionId: 'project-readable',
          provider: 'codex',
          method: 'session.approval-mode-set',
          approvalMode: 'never',
          createdAt: '2026-11-20T11:00:00Z',
        });
        try {
          const result = await read(...args);
          workerReadAfterChange = 'accepted';
          return result;
        } catch (error) {
          workerReadAfterChange = 'refused';
          throw error;
        }
      });
      const transcripts = orchestrationService.createIsolatedTranscriptSearch();
      await transcripts.whenReady();
      return {
        eventStore,
        orchestrationService,
        dispatchScope,
        transcripts,
      };
    },
  );

  const client = async (global: boolean) => {
    const { accessToken } = fixture.grant(global);
    const { response, session } = await fixture.initialize(accessToken);
    await response.text();
    return async (args: Record<string, unknown>) =>
      outsideMcpPayload(
        await fixture.rpc(
          accessToken,
          'tools/call',
          {
            name: 'search_conversations',
            arguments: { query: 'cobalt', ...args },
          },
          session,
        ),
      );
  };
  const project = await client(false);
  const matched = await project({});
  const result = JSON.parse(matched.result.content[0].text);
  expect(
    result.data.results.map(
      (item: { conversationId: string }) => item.conversationId,
    ),
  ).toEqual(['project-readable']);
  expect(result.data.results[0].snippet).toContain('cobalt deployment');
  expect(result.data.incompleteSources).toContainEqual({
    source: 'station.work',
    state: 'partial',
    reason: 'host-execution-filtered',
    filteredCount: 1,
  });
  expect((await project({ projectSlug: 'foreign' })).error?.code).toBe(-32602);

  const global = await client(true);
  const globalResult = JSON.parse((await global({})).result.content[0].text);
  expect(
    globalResult.data.results.map(
      (item: { conversationId: string }) => item.conversationId,
    ),
  ).toEqual(['global-readable']);
  expect(globalResult.data.incompleteSources).not.toContainEqual(
    expect.objectContaining({ reason: 'host-execution-filtered' }),
  );

  changeBeforeWorkerQuery = true;
  const stale = JSON.parse((await project({})).result.content[0].text);
  expect(workerReadAfterChange).toBe('refused');
  expect(stale.data.results).toEqual([]);
  expect(stale.data.incompleteSources).toContainEqual({
    source: 'station.messages',
    state: 'unavailable',
    reason: 'source-unavailable',
  });
});
