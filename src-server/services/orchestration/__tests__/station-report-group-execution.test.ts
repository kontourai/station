import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { type FlowMultiCursorClaimEvent, loadRun } from '@kontourai/flow';
import {
  createReportGroup,
  finalizeReportGroupCancel,
  getReportGroup,
  listReportGroups,
  readReportGroupEvents,
  readReportGroupResult,
} from '@kontourai/station-sdk/client';
import { Hono } from 'hono';
import { test, vi } from 'vitest';
import { runCli } from '../../../../packages/cli/src/cli.js';
import { createGateTestRegistry } from '../../../__test-utils__/orchestration-gate-test-harness.js';
import { StationAgentAdapter } from '../../../providers/adapters/station-agent-adapter.js';
import { createReportGroupRoutes } from '../../../routes/orchestration/report-groups.js';
import { AnthropicSealedPreparation } from '../../../runtime/conversation/anthropic-sealed-preparation.js';
import {
  bindRuntimeLocalOperator,
  getRuntimeAuthenticatedRequestPrincipal,
  setRuntimeAuthenticatedRequestPrincipal,
} from '../../../security/runtime-request-security.js';
import { ApprovalRegistry } from '../../approvals/approval-registry.js';
import { StationDelegationPersistence } from '../delegation-group-persistence.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';
import { createSessionAgentResolver } from '../session-agent-resolution.js';
import { StationReportGroupRuntime } from '../station-report-group-runtime.js';
import {
  reportTerminalWitnessSchema,
  verifyReportTerminalWitness,
} from '../station-report-terminal-witness.js';
import { createReportFlow } from './delegation-source-fixtures/flow.js';
import {
  installControl,
  NOW,
  newGrant,
  setup,
} from './delegation-source-fixtures/report.js';
import { controlledTextStream } from './delegation-source-fixtures/streamed-text.js';

type View = NonNullable<Awaited<ReturnType<StationReportGroupRuntime['get']>>>;
type Operation = Awaited<ReturnType<StationReportGroupRuntime['create']>>;

test.each(['independent', 'flow', 'mixed'] as const)(
  'report HTTP owner runs %s seats through canonical tasks and retained tariffs; expired-profile replay reads without qualification or resend',
  async (mode) => {
    const wallNow = Date.now;
    const h = await setup();
    const startedAt = wallNow();
    const runNow = NOW;
    vi.mocked(Date.now).mockImplementation(
      () => runNow + wallNow() - startedAt,
    );
    installControl(h);
    if (mode === 'mixed') {
      await h.f.storage.saveProviderConnection({
        id: 'google-1',
        name: 'Controlled Google connection',
        type: 'google',
        enabled: true,
        capabilities: ['llm'],
        config: {
          apiKey: 'synthetic-google-not-live',
          baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        },
      });
      await h.f.loader.saveAgent('google-reviewer', {
        name: 'Google reviewer',
        prompt: 'Configured Google report-only instructions',
        execution: {
          modelConnectionId: 'google-1',
          modelId: 'gemini-2.5-flash-lite',
        },
      });
    }
    const memberCount = mode === 'independent' ? 2 : 3;
    const flowRunId = 'report-http-flow';
    if (mode === 'flow') {
      await createReportFlow(h.f, flowRunId, [
        { id: 'left' },
        { id: 'right' },
        { id: 'join', needs: ['left', 'right'] },
      ]);
    }
    const reportText = 'Controlled report '.repeat(1200);
    h.rawFetch.mockImplementation(async (url) =>
      String(url).startsWith('https://generativelanguage.googleapis.com/')
        ? controlledTextStream('google', 'gemini-2.5-flash-lite', reportText, {
            promptTokenCount: 4,
            candidatesTokenCount: 8000,
            thoughtsTokenCount: 0,
            totalTokenCount: 8004,
            cachedContentTokenCount: 0,
            serviceTier: 'standard',
          })
        : controlledTextStream('anthropic', 'claude-sonnet-4-6', reportText, {
            input_tokens: 4,
            output_tokens: 8000,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          }),
    );
    const input = {
      ...h.input,
      deadlineAt: runNow + 240_000,
      budget: {
        inputTokens: memberCount * 1048576,
        outputTokens: memberCount * 8000,
        costMicros: memberCount * (1048576 * 3 + 8000 * 15),
      },
      ...(mode === 'flow'
        ? {
            flow: {
              runId: flowRunId,
              steps: { left: 'left', right: 'right', join: 'join' },
            },
          }
        : {}),
      members: [
        ...h.input.members,
        ...(mode !== 'independent'
          ? [
              {
                ...h.input.members[0],
                seatId: 'join',
                brief: 'Review combined findings',
              },
            ]
          : []),
      ].map((member) => ({
        ...member,
        maxOutputTokens: 8000,
        ...(mode === 'mixed' && member.seatId === 'right'
          ? { agentId: 'google-reviewer' }
          : {}),
      })),
    };

    const bus = new EventBus();
    const eventStore = new EventStore(
      join(h.f.root, 'report-execution.sqlite'),
    );
    const logger = { debug() {}, warn() {} };
    const relay = vi.fn<typeof fetch>(async () => {
      throw Error('reserved execution must not relay');
    });
    const adapter = new StationAgentAdapter({
      apiBase: 'http://report-control.test',
      hasAgent: () => true,
      eventBus: bus,
      approvalRegistry: new ApprovalRegistry(logger, { eventBus: bus }),
      fetch: relay,
    });
    const orchestration = new OrchestrationService({
      adapterRegistry: createGateTestRegistry(adapter),
      eventBus: bus,
      eventStore,
      logger,
      resolveSessionAgent: createSessionAgentResolver({
        loadAgentSpec: (slug) => h.f.loader.loadAgent(slug),
        resolveToolServer: async () => null,
        resolveSkillDir: async () => null,
      }),
    });
    const owners = {
      runtime: h.preparationOwners.runtime,
      orchestration,
      rawFetch: h.rawFetch,
    };
    const qualifies = vi.spyOn(AnthropicSealedPreparation, 'create');
    const stampedPrincipal = getRuntimeAuthenticatedRequestPrincipal(h.f.req);
    assert.ok(stampedPrincipal && stampedPrincipal.kind !== 'internal');
    const principal = { ...stampedPrincipal };
    function appFor(runtime: StationReportGroupRuntime | null) {
      const app = new Hono();
      // Controlled ingress stamps; current credential and scope checks remain real owners.
      app.use('*', async (c, next) => {
        setRuntimeAuthenticatedRequestPrincipal(c.req.raw, {
          ...principal,
          credential:
            c.req.header('Authorization')?.replace(/^Bearer /, '') ?? '',
        });
        if (c.req.header('X-Test-Operator') === 'yes')
          bindRuntimeLocalOperator(c.req.raw);
        await next();
      });
      app.route(
        '/api/orchestration/report-groups',
        createReportGroupRoutes(runtime),
      );
      return app;
    }
    const createFailures: unknown[] = [];
    const create = StationReportGroupRuntime.prototype.create;
    vi.spyOn(StationReportGroupRuntime.prototype, 'create').mockImplementation(
      async function (this: StationReportGroupRuntime, ...args) {
        try {
          return await create.apply(this, args);
        } catch (error) {
          createFailures.push(error);
          throw error;
        }
      },
    );
    let app = appFor(new StationReportGroupRuntime(owners));
    const abort = new AbortController();
    const send = (
      method: 'GET' | 'POST',
      path = '',
      body?: unknown,
      credential = h.f.paired.credential,
      operator = true,
      extraHeaders: Record<string, string> = {},
    ) =>
      app.request(
        `http://report-control.test/api/orchestration/report-groups${path}`,
        {
          method,
          signal: abort.signal,
          headers: {
            Authorization: `Bearer ${credential}`,
            'Content-Type': 'application/json',
            ...(operator ? { 'X-Test-Operator': 'yes' } : {}),
            ...extraHeaders,
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
      );
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      assert.equal(qualifies.mock.calls.length, 0);
      assert.equal(
        (await send('POST', '', input, undefined, false)).status,
        503,
      );
      const response = await Promise.race([
        send('POST', '', input),
        new Promise<never>((_resolve, reject) => {
          watchdog = setTimeout(() => {
            abort.abort();
            reject(Error('report HTTP execution deadline'));
          }, input.deadlineAt - Date.now());
        }),
      ]);
      if (watchdog) clearTimeout(watchdog);
      const body = (await response.json()) as {
        success: boolean;
        data: Operation;
      };
      assert.equal(
        response.status,
        200,
        `${JSON.stringify(body)} ${createFailures.map((error) => inspect(error, { depth: 8 })).join('\n')}`,
      );
      assert.equal(body.success, true);
      const result = body.data;
      assert.equal(result.replayed, false);
      assert.equal(result.group.execution, 'returned');
      assert.equal(result.group.acceptance, 'unassessed');
      assert.equal(result.group.members.length, memberCount);
      assert.deepEqual(
        result.group.topology,
        mode === 'flow'
          ? { kind: 'flow', runId: flowRunId }
          : { kind: 'independent-advisory' },
      );
      if (mode === 'flow') {
        const run = await loadRun(flowRunId, h.f.repo);
        assert.equal(run.state.status, 'completed');
        const history: FlowMultiCursorClaimEvent[] =
          run.state.multi_cursor.claim_history;
        const claimed = history.filter((event) => event.action === 'claimed');
        const settled = history.filter((event) => event.action === 'settled');
        assert.deepEqual(claimed.map((event) => event.step_id).sort(), [
          'join',
          'left',
          'right',
        ]);
        assert.equal(new Set(claimed.map((event) => event.claim_id)).size, 3);
        assert.deepEqual(
          settled.map((event) => event.claim_id).sort(),
          claimed.map((event) => event.claim_id).sort(),
        );
        assert.deepEqual(run.state.multi_cursor.active_claims, []);
        assert.deepEqual(run.state.multi_cursor.blocked_steps, []);
      }
      assert.equal(h.rawFetch.mock.calls.length, memberCount);
      assert.equal(relay.mock.calls.length, 0);
      for (const member of result.group.members) {
        assert.equal(member.attempts.length, 1);
        assert.deepEqual(member.attempts[0].usage, {
          inputTokens: 4,
          outputTokens: 8000,
          costMicros:
            mode === 'mixed' && member.seatId === 'right' ? 3201 : 120012,
        });
        assert.equal(member.attempts[0].accountingTerminal, true);
        assert.ok(member.attempts[0].terminal);
        const terminal = JSON.parse(
          readFileSync(
            join(
              h.f.home,
              'report-groups',
              'station-report-observations-v1',
              `${member.attempts[0].terminal.id}.json`,
            ),
            'utf8',
          ),
        );
        assert.ok(terminal.observation.recipient);
        const witness = reportTerminalWitnessSchema.parse(
          terminal.observation.witness,
        );
        assert.equal(
          verifyReportTerminalWitness(witness, h.f.environment),
          true,
        );
        assert.equal(witness.data.groupId, result.group.groupId);
        assert.equal(
          witness.data.invocationId,
          member.attempts[0].invocationId,
        );
        assert.equal(witness.data.terminal.sessionId, member.taskId);
        assert.equal(witness.data.terminal.clientTurnId, member.clientTurnId);
        assert.equal(
          witness.data.terminal.terminalEventId,
          terminal.observation.eventId,
        );
        const receipt = JSON.parse(
          readFileSync(
            join(
              h.f.home,
              'report-groups',
              'station-report-flow-observations-v1',
              `${terminal.observation.recipient.id}.json`,
            ),
            'utf8',
          ),
        );
        assert.equal(receipt.kind, 'recipient');
        assert.equal(
          receipt.value.invocationId,
          member.attempts[0].invocationId,
        );
        assert.equal(receipt.value.identity.executionId, member.taskId);
        assert.equal(receipt.value.identity.generation, 1);
        assert.match(receipt.value.identity.recipientId, /^station-recipient:/);
      }
      for (const privateValue of [
        'synthetic-not-a-live-key',
        'synthetic-google-not-live',
        'credentialDigest',
        'authenticated_principal_ref',
        'Configured report-only instructions',
        'Review correctness',
        h.f.root,
      ])
        assert.ok(!JSON.stringify(body).includes(privateValue), privateValue);
      assert.equal(qualifies.mock.calls.length, 1);
      vi.mocked(Date.now).mockReturnValue(Date.parse('2026-10-26T19:51:03Z'));
      await assert.rejects(() => AnthropicSealedPreparation.create(), {
        code: 'stale_contract',
      });
      const returning = newGrant(h);
      h.f.environment.devicePairing.revokeDevice(
        h.f.paired.device.id,
        'operator-credential',
      );
      app = appFor(new StationReportGroupRuntime(owners));
      assert.equal(qualifies.mock.calls.length, 2);
      const controlFetch = globalThis.fetch;
      let cliIngress = false;
      vi.stubGlobal(
        'fetch',
        vi.fn<typeof fetch>(async (url, init) => {
          if (
            String(url).startsWith(
              'http://report-control.test/api/orchestration/report-groups',
            ) ||
            String(url).startsWith(
              'http://127.0.0.1:43979/api/orchestration/report-groups',
            )
          )
            return app.request(
              String(url),
              cliIngress
                ? {
                    ...init,
                    headers: {
                      ...Object.fromEntries(new Headers(init?.headers)),
                      'X-Test-Operator': 'yes',
                    },
                  }
                : init,
            );
          return controlFetch(url, init);
        }),
      );
      const sdkOptions = {
        credential: returning.credential,
        credentialOrigin: 'http://report-control.test',
        headers: { 'X-Test-Operator': 'yes' },
        signal: abort.signal,
      };
      const sdkReplay = await createReportGroup(
        'http://report-control.test',
        input,
        sdkOptions,
      );
      assert.equal(sdkReplay.replayed, true);
      assert.deepEqual(sdkReplay.group, result.group);
      assert.deepEqual(
        await getReportGroup(
          'http://report-control.test',
          result.group.groupId,
          sdkOptions,
        ),
        result.group,
      );
      assert.deepEqual(
        (
          await listReportGroups(
            'http://report-control.test',
            undefined,
            sdkOptions,
          )
        ).groups,
        [result.group],
      );
      const cliOutput: string[] = [];
      const priorExitCode = process.exitCode;
      const log = vi.spyOn(console, 'log').mockImplementation((value) => {
        cliOutput.push(String(value));
      });
      cliIngress = true;
      try {
        await runCli([
          'group',
          'report-get',
          result.group.groupId,
          '--api-base=http://127.0.0.1:43979',
          `--credential=${returning.credential}`,
          '--json',
        ]);
      } finally {
        cliIngress = false;
        log.mockRestore();
        process.exitCode = priorExitCode;
      }
      assert.deepEqual(JSON.parse(cliOutput[0]), result.group);
      const replayResponse = await send(
        'POST',
        '',
        input,
        returning.credential,
      );
      assert.equal(replayResponse.status, 200);
      const replay = (await replayResponse.json()) as { data: Operation };
      assert.equal(replay.data.replayed, true);
      assert.deepEqual(replay.data.group, result.group);
      assert.equal(qualifies.mock.calls.length, 2);
      const changed = await send(
        'POST',
        '',
        { ...input, maxConcurrent: 1 },
        returning.credential,
      );
      assert.equal(changed.status, 503);
      const groupId = result.group.groupId;
      assert.equal((await send('GET', `/${groupId}`)).status, 503);
      const inspected = await send(
        'GET',
        `/${groupId}`,
        undefined,
        returning.credential,
      );
      assert.equal(inspected.headers.get('Cache-Control'), 'no-store');
      assert.deepEqual(
        ((await inspected.json()) as { data: View }).data,
        result.group,
      );
      const list = await send('GET', '', undefined, returning.credential);
      assert.deepEqual(
        ((await list.json()) as { data: { groups: View[] } }).data.groups,
        [result.group],
      );
      const eventsResponse = await send(
        'GET',
        `/${groupId}/events`,
        undefined,
        returning.credential,
      );
      assert.equal(eventsResponse.status, 200);
      const eventsPage = (
        (await eventsResponse.json()) as {
          data: {
            events: { revision: number; kind: string }[];
            nextRevision: number;
            hasMore: boolean;
          };
        }
      ).data;
      assert.deepEqual(
        eventsPage.events.map((e) => e.revision),
        Array.from({ length: result.group.revision }, (_, i) => i + 1),
      );
      assert.equal(eventsPage.nextRevision, result.group.revision);
      assert.equal(eventsPage.hasMore, false);
      assert.deepEqual(
        await readReportGroupEvents(
          'http://report-control.test',
          groupId,
          0,
          sdkOptions,
        ),
        eventsPage,
      );
      const resumed = await send(
        'GET',
        `/${groupId}/events?afterRevision=${eventsPage.nextRevision}`,
        undefined,
        returning.credential,
      );
      assert.deepEqual(
        ((await resumed.json()) as { data: { events: unknown[] } }).data.events,
        [],
      );
      const streamResponse = await send(
        'GET',
        `/${groupId}/events/stream`,
        undefined,
        returning.credential,
      );
      assert.equal(streamResponse.status, 200);
      const reader = streamResponse.body!.getReader();
      try {
        const first = await reader.read();
        const frame = new TextDecoder().decode(first.value);
        assert.ok(frame.includes('event: report-group-events'));
        assert.ok(frame.includes(`id: report:${encodeURIComponent(groupId)}:`));
        assert.ok(!frame.includes('authenticated_principal_ref'));
      } finally {
        await reader.cancel();
      }
      const foreignCursor = await send(
        'GET',
        `/${groupId}/events/stream`,
        undefined,
        returning.credential,
        true,
        { 'Last-Event-ID': `group:${encodeURIComponent(groupId)}:0` },
      );
      assert.equal(foreignCursor.status, 400);
      const member = result.group.members[0];
      const attempt = member.attempts[0];
      const resultPath = `/${groupId}/members/${member.seatId}/results/${attempt.invocationId}`;
      const rawResponse = await send(
        'GET',
        resultPath,
        undefined,
        returning.credential,
      );
      assert.equal(rawResponse.status, 200);
      const raw = (
        (await rawResponse.json()) as {
          data: {
            kind: string;
            text: string;
            nextOffset: number;
            hasMore: boolean;
          };
        }
      ).data;
      assert.equal(raw.kind, 'result');
      assert.equal(raw.text, reportText.slice(0, 16_384));
      assert.equal(raw.hasMore, true);
      assert.deepEqual(
        await readReportGroupResult(
          'http://report-control.test',
          groupId,
          member.seatId,
          attempt.invocationId,
          0,
          sdkOptions,
        ),
        raw,
      );
      const eof = await send(
        'GET',
        `${resultPath}?afterOffset=${raw.nextOffset}`,
        undefined,
        returning.credential,
      );
      const rest = (
        (await eof.json()) as {
          data: { text: string; hasMore: boolean; nextOffset: number };
        }
      ).data;
      assert.equal(raw.text + rest.text, reportText);
      assert.equal(rest.hasMore, false);
      assert.ok(attempt.observation);
      const observationFile = join(
        h.f.home,
        'report-groups',
        'station-report-observations-v1',
        `${attempt.observation.id}.json`,
      );
      const retainedBytes = readFileSync(observationFile);
      const substituted = JSON.parse(retainedBytes.toString());
      substituted.observation.text = 'Altered raw result';
      writeFileSync(observationFile, JSON.stringify(substituted), {
        mode: 0o600,
      });
      assert.equal(
        (await send('GET', resultPath, undefined, returning.credential)).status,
        503,
      );
      writeFileSync(observationFile, retainedBytes, { mode: 0o600 });
      assert.equal(
        (await send('GET', resultPath, undefined, returning.credential)).status,
        200,
      );
      const memberRead = vi
        .spyOn(orchestration, 'inspectTurnDelivery')
        .mockReturnValueOnce(null);
      assert.equal(
        (await send('GET', resultPath, undefined, returning.credential)).status,
        503,
      );
      memberRead.mockRestore();
      const interrupt = vi.spyOn(orchestration, 'dispatchWithReceipt');
      const command = {
        operationKey: 'cancel-completed',
        expectedRevision: result.group.revision,
      };
      const originalRoundsStore =
        StationDelegationPersistence.prototype.roundsStore;
      const journalCommit = vi
        .spyOn(StationDelegationPersistence.prototype, 'roundsStore')
        .mockImplementation(function (
          this: StationDelegationPersistence,
          current,
        ) {
          const store = originalRoundsStore.call(this, current);
          return {
            transact: (id, body) =>
              store.transact(id, async (previous) => {
                const next = await body(previous);
                if (
                  next.journal.events[next.journal.events.length - 1]?.kind ===
                  'cancel_requested'
                )
                  throw Error('controlled cancellation journal commit loss');
                return next;
              }),
          };
        });
      const cancelResponse = await send(
        'POST',
        `/${groupId}/cancel`,
        command,
        returning.credential,
      );
      journalCommit.mockRestore();
      assert.equal(cancelResponse.status, 503);
      const repeated = await send(
        'POST',
        `/${groupId}/cancel`,
        command,
        returning.credential,
      );
      assert.equal(
        ((await repeated.json()) as { data: { replayed: boolean } }).data
          .replayed,
        true,
      );
      const pending = await getReportGroup(
        'http://report-control.test',
        groupId,
        sdkOptions,
      );
      assert.ok(pending);
      assert.equal(pending.cancellation, 'pending');
      const recovery = {
        operationKey: 'finalize-completed',
        cancelOperationKey: command.operationKey,
        expectedRevision: pending.revision,
      };
      const finalized = await finalizeReportGroupCancel(
        'http://report-control.test',
        groupId,
        recovery,
        sdkOptions,
      );
      assert.equal(finalized.replayed, false);
      assert.equal(finalized.cancellation, 'requested');
      const finalCli: string[] = [];
      const finalLog = vi.spyOn(console, 'log').mockImplementation((value) => {
        finalCli.push(String(value));
      });
      cliIngress = true;
      try {
        await runCli([
          'group',
          'report-finalize-cancel',
          groupId,
          '--api-base=http://127.0.0.1:43979',
          `--credential=${returning.credential}`,
          `--operation=${recovery.operationKey}`,
          `--cancel-operation=${command.operationKey}`,
          `--revision=${recovery.expectedRevision}`,
          '--json',
        ]);
      } finally {
        cliIngress = false;
        finalLog.mockRestore();
        process.exitCode = priorExitCode;
      }
      assert.equal(JSON.parse(finalCli[0]).replayed, true);
      const after = await send(
        'GET',
        `/${groupId}`,
        undefined,
        returning.credential,
      );
      const afterView = ((await after.json()) as { data: View }).data;
      assert.equal(afterView.authorityRevoked, true);
      assert.deepEqual(afterView.members, result.group.members);
      assert.equal(interrupt.mock.calls.length, 0);
      assert.equal(h.rawFetch.mock.calls.length, memberCount);
      app = appFor(null);
      assert.equal(
        (await send('GET', '', undefined, returning.credential)).status,
        503,
      );
    } finally {
      if (watchdog) clearTimeout(watchdog);
      abort.abort();
      await orchestration.shutdown();
      eventStore.close();
    }
  },
  270_000,
);
