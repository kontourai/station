import { execFile } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { expect } from '@playwright/test';
import {
  e2eOperatorAuthorizationHeaders,
  readE2EOperatorCredential,
} from './helpers/e2e-operator-credential';
import { test } from './helpers/fixture-audit';
import {
  allocateLiveStation,
  createRepository,
  type LiveStation,
  startStation,
  stationRootForLiveHome,
  stopStation,
} from './helpers/live-station-task';
import {
  closeFixtureServer,
  startOllamaFixture,
} from './helpers/ollama-fixture';

const execFileAsync = promisify(execFile);
const MODEL = 'native-restart-fixture:latest';
const REPLY = 'The restart fixture retained the conversation.';
const PROMPTS = [
  'Remember the exact token COPPER-574 in this Project.',
  'Repeat the token I gave you in the previous turn.',
  'After the server restart, which token and Project are we discussing?',
] as const;

interface ModelMessage {
  role?: string;
  content?: string | Array<{ text?: string }>;
}
interface ModelRequest {
  messages?: ModelMessage[];
}
interface TurnHandle {
  conversationId: string;
  sessionId: string;
  currentSessionId?: string;
  providerTurnId?: string;
}
interface SessionEvent {
  method: string;
  turnId?: string;
  prompt?: string;
  cwd?: string;
  metadata?: { projectSlug?: string };
}
function textOf(message: ModelMessage): string {
  return typeof message.content === 'string'
    ? message.content
    : (message.content ?? []).map((part) => part.text ?? '').join('\n');
}
async function api<T>(
  live: LiveStation,
  path: string,
  method = 'GET',
  data?: unknown,
): Promise<T> {
  const response = await fetch(`${live.api}${path}`, {
    method,
    headers: {
      ...e2eOperatorAuthorizationHeaders(readE2EOperatorCredential(live.home)),
      ...(data === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    signal: AbortSignal.timeout(30_000),
  });
  expect(response.ok, `${method} ${path}: HTTP ${response.status}`).toBe(true);
  return (await response.json()) as T;
}
async function completed(
  live: LiveStation,
  handle: TurnHandle,
  prompt: string,
) {
  const sessionId = handle.currentSessionId ?? handle.sessionId;
  expect(sessionId).toBeTruthy();
  let events: SessionEvent[] = [];
  await expect
    .poll(
      async () => {
        events = (
          await api<{ data: SessionEvent[] }>(
            live,
            `/api/orchestration/sessions/${encodeURIComponent(sessionId)}/events`,
          )
        ).data;
        const started = events.find(
          (event) => event.method === 'turn.started' && event.prompt === prompt,
        );
        const turnId = handle.providerTurnId ?? started?.turnId;
        return (
          Boolean(turnId) &&
          events.some(
            (event) =>
              event.method === 'turn.completed' && event.turnId === turnId,
          )
        );
      },
      { timeout: 45_000 },
    )
    .toBe(true);
  return events;
}

for (const runtimeFramework of ['voltagent', 'strands'] as const) {
  test.describe(runtimeFramework, () => {
    let active: LiveStation | undefined;
    let fixtureServer: Server | null = null;
    // biome-ignore lint/correctness/noEmptyPattern: Playwright requires fixture destructuring before testInfo
    test.afterEach(async ({}, testInfo) => {
      testInfo.setTimeout(180_000);
      let stopFailure: unknown;
      try {
        if (active) await stopStation(active);
      } catch (error) {
        stopFailure = error;
      }
      await closeFixtureServer(fixtureServer);
      fixtureServer = null;
      if (active && !stopFailure) {
        rmSync(stationRootForLiveHome(active.home), {
          recursive: true,
          force: true,
        });
        active = undefined;
      }
      if (stopFailure)
        throw new Error(
          'Nested Station stop failed; retained its diagnostic home.',
          { cause: stopFailure },
        );
    });
    // biome-ignore lint/correctness/noEmptyPattern: Playwright requires fixture destructuring before testInfo
    test(`${runtimeFramework}: CLI continues the same Project conversation after server restart`, async ({}, testInfo) => {
      testInfo.setTimeout(420_000);
      const live = await allocateLiveStation(
        `station-native-${runtimeFramework}-`,
        `native-${runtimeFramework}`,
      );
      active = live;
      const ownedRoot = stationRootForLiveHome(live.home);
      const repository = join(ownedRoot, 'project');
      const projectSlug = 'native-restart-project';
      const agentSlug = 'native-restart-agent';
      const lifecycle = { runtimeFramework, deterministicReadiness: false };
      const requests: ModelRequest[] = [];
      await createRepository(repository, 'native-restart');
      await startStation(live, true, lifecycle);
      // Persist the boot selection through the real config owner. A feature
      // flag alone is lost from appConfig when Agent setup reloads from disk.
      await api(live, '/api/config/app', 'PUT', { runtime: runtimeFramework });
      const fixture = await startOllamaFixture(
        MODEL,
        (body) => {
          requests.push(body as ModelRequest);
          mkdirSync(testInfo.outputDir, { recursive: true });
          writeFileSync(
            testInfo.outputPath('model-requests.json'),
            JSON.stringify(requests, null, 2),
          );
        },
        REPLY,
      );
      fixtureServer = fixture.server;
      await api(live, '/api/connections', 'POST', {
        id: 'native-restart-model',
        kind: 'model',
        type: 'ollama',
        name: 'Native restart fixture',
        enabled: true,
        capabilities: ['llm'],
        config: { baseUrl: fixture.origin, defaultModel: MODEL },
        status: 'ready',
        prerequisites: [],
      });
      await api(live, '/api/projects', 'POST', {
        slug: projectSlug,
        name: 'Native restart Project',
        workingDirectory: repository,
      });
      await api(live, '/agents', 'POST', {
        slug: agentSlug,
        name: 'Native restart Agent',
        prompt: 'Answer in one short sentence.',
      });
      expect(await api(live, '/api/system/runtime')).toEqual({
        runtime: runtimeFramework,
      });
      const target = {
        environment: { kind: 'current' },
        agent: agentSlug,
        model: { override: MODEL },
        workspace: { kind: 'project', projectSlug },
      };
      const first = (
        await api<{ data: TurnHandle }>(
          live,
          '/api/orchestration/chat',
          'POST',
          {
            target,
            message: PROMPTS[0],
          },
        )
      ).data;
      expect(first.conversationId).toBeTruthy();
      expect(first.providerTurnId).toBeTruthy();
      await completed(live, first, PROMPTS[0]);
      const second = (
        await api<{ data: TurnHandle }>(
          live,
          '/api/orchestration/chat',
          'POST',
          {
            target,
            conversationId: first.conversationId,
            message: PROMPTS[1],
          },
        )
      ).data;
      expect(second.conversationId).toBe(first.conversationId);
      expect(second.providerTurnId).toBeTruthy();
      await completed(live, second, PROMPTS[1]);

      await stopStation(live);
      await startStation(live, false, lifecycle);
      expect(await api(live, '/api/system/runtime')).toEqual({
        runtime: runtimeFramework,
      });
      // This is the public CLI continuation path. No caller Agent, Project,
      // cwd, or prior memory identity is supplied to repair a lost binding.
      const args = [
        'delegate',
        `--session=${first.conversationId}`,
        PROMPTS[2],
        '--json',
        `--api-base=${live.api}`,
        `--model=${MODEL}`,
      ];
      const command =
        process.platform === 'win32'
          ? ([
              process.execPath,
              ['--import', 'tsx', 'scripts/station-cli.ts', ...args],
            ] as const)
          : (['./station', args] as const);
      const { stdout } = await execFileAsync(command[0], [...command[1]], {
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        env: {
          ...process.env,
          PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}`,
          STATION_ROOT: ownedRoot,
          STATION_HOME: live.home,
          STATION_API_CREDENTIAL: readE2EOperatorCredential(live.home),
        },
      });
      const result = JSON.parse(stdout) as { ok: boolean; data: TurnHandle };
      expect(result.ok).toBe(true);
      expect(result.data.conversationId).toBe(first.conversationId);
      const thirdEvents = await completed(live, result.data, PROMPTS[2]);
      expect(
        thirdEvents.some(
          (event) => event.metadata?.projectSlug === projectSlug,
        ),
      ).toBe(true);
      expect(
        thirdEvents.some(
          (event) =>
            event.cwd === repository ||
            (event.metadata as { cwd?: string } | undefined)?.cwd ===
              repository,
        ),
      ).toBe(true);
      const thirdRequests = requests.filter((body) => {
        const lastUser = body.messages
          ?.filter((message) => message.role === 'user')
          .at(-1);
        return lastUser && textOf(lastUser).trim().endsWith(PROMPTS[2]);
      });
      expect(thirdRequests).toHaveLength(1);
      const messages = thirdRequests[0]!.messages ?? [];
      const conversation = messages.filter(
        (message) => message.role !== 'system',
      );
      expect(conversation.map((message) => message.role)).toEqual([
        'user',
        'assistant',
        'user',
        'assistant',
        'user',
      ]);
      for (const [index, prompt] of PROMPTS.entries()) {
        expect(
          textOf(conversation[index * 2]!)
            .trim()
            .endsWith(prompt),
        ).toBe(true);
      }
      expect(textOf(conversation[1]!).trim()).toBe(REPLY);
      expect(textOf(conversation[3]!).trim()).toBe(REPLY);
      await testInfo.attach('conversation-restart', {
        contentType: 'application/json',
        body: JSON.stringify({
          runtimeFramework,
          first,
          second,
          third: result.data,
          projectSlug,
          repository,
        }),
      });
    });
  });
}
