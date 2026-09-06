import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentId } from '@kontourai/station-contracts/agent-identity';
import { humanPrincipal } from '@kontourai/station-contracts/principal';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import type { WorkspacePaneHostActionPrepareRequest } from '@kontourai/station-contracts/workspace-pane-host-contribution';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { readJson } from '../../../__test-utils__/read-json.js';
import { FileStorageAdapter } from '../../../domain/file-storage-adapter.js';
import { PLUGIN_AGENT_OWNER_FILE } from '../../../domain/plugin-agent-ownership.js';
import { createWorkspacePaneHostActionRoutes } from '../../../routes/orchestration/workspace-pane-host-actions.js';
import { grantPermissions, revokeAllGrants } from '../plugin-permissions.js';
import { createWorkspacePaneHostActions } from '../workspace-pane-host-actions.js';

let home: string;
let project: FileStorageAdapter;
let service: ReturnType<typeof createWorkspacePaneHostActions>;
let clock = 0;
let beforeTurn: (() => Promise<void>) | undefined;
let provider: ReturnType<
  typeof vi.fn<
    (
      agentId: string,
      body: string,
    ) => Promise<{
      conversationId: string;
      sessionId: string;
      turnId: string;
      agentId?: string;
      body?: string;
    }>
  >
>;
const principal = humanPrincipal('test', 'owner', 'Owner');
const actor = {
  isCurrent: () => true,
  principal,
  readAuthority: sessionReadAuthorityFromRequest(
    principal.id,
    undefined,
    undefined,
  ),
};
const pluginId = 'host-actions';
const ref = {
  kind: 'own-plugin-agent' as const,
  agentId: agentId('assistant'),
};

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'station-host-actions-'));
  const plugin = join(home, 'plugins', pluginId);
  mkdirSync(plugin, { recursive: true });
  for (const agentId of ['assistant', 'alternate']) {
    const path = join(home, 'agents', agentId);
    mkdirSync(path, { recursive: true });
    writeFileSync(
      join(path, 'agent.json'),
      JSON.stringify({
        name: agentId,
        prompt: 'Authored instructions.',
        execution: { agentConnectionId: 'claude' },
      }),
    );
    writeFileSync(
      join(path, PLUGIN_AGENT_OWNER_FILE),
      JSON.stringify({ plugin: pluginId }),
    );
  }
  writeFileSync(
    join(plugin, 'plugin.json'),
    JSON.stringify({
      name: pluginId,
      version: '1.0.0',
      permissions: ['agents.invoke'],
      agents: [
        { slug: 'assistant', source: './assistant.json' },
        { slug: 'alternate', source: './alternate.json' },
      ],
      workspacePaneHost: {
        version: 'station.workspace-pane-host-contribution/v1',
        agentSelection: {
          availableAgents: [ref, { ...ref, agentId: 'alternate' }],
          defaultAgent: ref,
        },
        actions: [
          {
            id: 'overview',
            label: 'Overview',
            presentation: 'action',
            intent: { kind: 'prompt', prompt: 'Exact overview body.' },
          },
          {
            id: 'fixed',
            label: 'Fixed',
            presentation: 'action',
            intent: { kind: 'prompt', prompt: 'Exact fixed body.', agent: ref },
          },
        ],
      },
    }),
  );
  project = new FileStorageAdapter(home);
  await project.createProject({
    id: 'project-one',
    slug: 'one',
    name: 'One',
    workingDirectory: home,
    agents: [agentId('assistant'), agentId('alternate')],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  await grantPermissions(home, pluginId, ['agents.invoke']);
  clock = 0;
  beforeTurn = undefined;
  provider = vi.fn(async (agentId, body) => ({
    conversationId: 'conversation-one',
    sessionId: 'session-one',
    turnId: 'turn-one',
    agentId,
    body,
  }));
  service = createWorkspacePaneHostActions({
    projectHomeDir: home,
    projects: project,
    getConnection: async (id) => ({
      id,
      name: 'Controlled connection',
      kind: 'agent',
      type: 'claude',
      enabled: true,
      status: 'ready',
      capabilities: ['agent-runtime'],
      config: { provider: 'claude' },
      prerequisites: [],
    }),
    now: () => clock,
    execute: async (_actor, captured) => {
      await captured.invoke(
        'start',
        {
          threadId: 'session-one',
          projectSlug: 'one',
          agentId: captured.agentId,
        },
        async () => undefined,
      );
      await beforeTurn?.();
      return captured.invoke(
        'turn',
        {
          threadId: 'session-one',
          projectSlug: 'one',
          agentId: captured.agentId,
          message: captured.message,
        },
        () => provider(captured.agentId, captured.message),
      );
    },
  });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

async function request(
  action = 'overview',
): Promise<WorkspacePaneHostActionPrepareRequest> {
  const { projection } = (await service.catalog('one')).contributions[0]!;
  return {
    ...projection.owner,
    actionKey: projection.actions.find((item) => item.id === action)!.key,
  };
}
async function ticket(input = request()) {
  const prepared = await service.prepare(actor, 'one', await input);
  expect(prepared.state).toBe('prepared');
  if (prepared.state !== 'prepared')
    throw new Error('Expected prepared ticket');
  return prepared.ticket;
}

async function legacyRequest() {
  const root = join(home, 'plugins', pluginId);
  const manifest = JSON.parse(readFileSync(join(root, 'plugin.json'), 'utf8'));
  delete manifest.workspacePaneHost;
  manifest.layout = { slug: 'legacy', source: './layout.json' };
  writeFileSync(join(root, 'plugin.json'), JSON.stringify(manifest));
  writeFileSync(
    join(root, 'layout.json'),
    JSON.stringify({
      availableAgents: [`${pluginId}:assistant`],
      defaultAgent: `${pluginId}:assistant`,
      globalSkills: [
        {
          id: 'safe-skill',
          label: 'Legacy label is not the prompt',
          prompt: 'Exact legacy Skill prompt.',
        },
      ],
    }),
  );
  await grantPermissions(home, pluginId, ['agents.invoke']);
  const projection = (await service.catalog('one')).contributions[0]!
    .projection;
  return { ...projection.owner, actionKey: projection.actions[0]!.key };
}

test('safe legacy declarations use the same captured action admission and exact authored body', async () => {
  const prepared = await ticket(Promise.resolve(await legacyRequest()));
  expect((await service.execute(actor, 'one', prepared)).state).toBe(
    'accepted',
  );
  expect(provider).toHaveBeenCalledWith(
    'assistant',
    'Exact legacy Skill prompt.',
  );
});

test('uninstall after a legacy catalog and preparation cannot launch the saved action', async () => {
  const prepared = await ticket(Promise.resolve(await legacyRequest()));
  rmSync(join(home, 'plugins', pluginId), { recursive: true, force: true });
  expect((await service.execute(actor, 'one', prepared)).state).toBe(
    'unavailable',
  );
  expect(provider).not.toHaveBeenCalled();
});

test('invalid Station namespace does not claim known absence of host actions', async () => {
  writeFileSync(
    join(home, 'plugins', pluginId, 'plugin.json'),
    JSON.stringify({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name: pluginId,
      version: '1.0.0',
      extensions: {
        'io.kontourai.station': {
          schemaVersion: 'unsupported',
          workspacePaneHost: {},
        },
      },
    }),
  );
  const catalog = await service.catalog('one');
  expect(catalog.contributions).toEqual([]);
  expect(catalog.complete).toBe(false);
  expect(provider).not.toHaveBeenCalled();
});

test('HTTP host catalog -> prepare -> execute routes exact explicit Agent and literal intent once', async () => {
  const app = createWorkspacePaneHostActionRoutes({
    service,
    actorFor: () => actor,
  });
  const catalog = await readJson(await app.request('/one/catalog'));
  const projection = catalog.data.contributions[0].projection;
  expect(projection.agentSelection.defaultAgent.declaration).toEqual(ref);
  const prepareResponse = await app.request('/one/prepare', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...projection.owner,
      actionKey: projection.actions[0].key,
      selectedAgent: { ...ref, agentId: 'alternate' },
    }),
  });
  const prepared = (await readJson(prepareResponse)).data;
  const execute = () =>
    app.request('/one/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket: prepared.ticket }),
    });
  const [first, duplicate] = await Promise.all([execute(), execute()]);
  expect((await readJson(first)).data.state).toBe('accepted');
  expect((await readJson(duplicate)).data.state).toBe('indeterminate');
  expect(provider).toHaveBeenCalledExactlyOnceWith(
    'alternate',
    'Exact overview body.',
  );
});

test('a fixed action refuses a different selected Agent instead of overriding author intent', async () => {
  const prepared = await service.prepare(actor, 'one', {
    ...(await request('fixed')),
    selectedAgent: { ...ref, agentId: 'alternate' },
  } as WorkspacePaneHostActionPrepareRequest);
  expect(prepared.state).toBe('unavailable');
  expect(provider).not.toHaveBeenCalled();
});

test('withdrawn permission between preparation and turn prevents provider invocation', async () => {
  const key = await ticket();
  beforeTurn = () => revokeAllGrants(home, pluginId);
  expect((await service.execute(actor, 'one', key)).state).not.toBe('accepted');
  expect(provider).not.toHaveBeenCalled();
  expect((await service.execute(actor, 'one', key)).state).toBe(
    'indeterminate',
  );
});

test('stale generation and changed Agent bytes cannot borrow a refreshed installation', async () => {
  const stale = await request();
  const path = join(home, 'plugins', pluginId, 'plugin.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  manifest.version = '2.0.0';
  writeFileSync(path, JSON.stringify(manifest));
  expect(await service.prepare(actor, 'one', stale)).toEqual({
    state: 'unavailable',
    reason: 'installation-changed',
  });
  await grantPermissions(home, pluginId, ['agents.invoke']);
  const key = await ticket();
  writeFileSync(
    join(home, 'agents', 'assistant', 'agent.json'),
    JSON.stringify({
      name: 'replacement',
      prompt: 'Replacement.',
      execution: { agentConnectionId: 'claude' },
    }),
  );
  expect((await service.execute(actor, 'one', key)).state).not.toBe('accepted');
  expect(provider).not.toHaveBeenCalled();
});

test('tickets cannot cross actor or Project and expiration never reconstructs work', async () => {
  const key = await ticket();
  const other = humanPrincipal('test', 'other', 'Other');
  expect(
    await service.execute(
      {
        principal: other,
        isCurrent: () => true,
        readAuthority: sessionReadAuthorityFromRequest(
          other.id,
          undefined,
          undefined,
        ),
      },
      'one',
      key,
    ),
  ).toEqual({ state: 'indeterminate' });
  expect(await service.execute(actor, 'other-project', key)).toEqual({
    state: 'indeterminate',
  });
  clock = 60_001;
  expect(await service.execute(actor, 'one', key)).toEqual({
    state: 'indeterminate',
  });
  expect(provider).not.toHaveBeenCalled();
});

test('provider uncertainty consumes the ticket and exposes no exception or replay', async () => {
  provider.mockRejectedValue(new Error('/secret/provider/path API_KEY=secret'));
  const key = await ticket();
  expect(await service.execute(actor, 'one', key)).toEqual({
    state: 'indeterminate',
  });
  expect(await service.execute(actor, 'one', key)).toEqual({
    state: 'indeterminate',
  });
  expect(provider).toHaveBeenCalledTimes(1);
});

test('grant revocation completes during provider settlement without cancelling or replaying its effect', async () => {
  let entered!: () => void;
  let settle!: (value: {
    conversationId: string;
    sessionId: string;
    turnId: string;
  }) => void;
  const invoked = new Promise<void>((resolve) => {
    entered = resolve;
  });
  provider.mockImplementation(() => {
    entered();
    return new Promise((resolve) => {
      settle = resolve;
    });
  });
  const key = await ticket();
  const pending = service.execute(actor, 'one', key);
  await invoked;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      revokeAllGrants(home, pluginId),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Grant lease spanned provider settlement')),
          5000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
    settle({
      conversationId: 'conversation-one',
      sessionId: 'session-one',
      turnId: 'turn-one',
    });
    await pending;
  }
  expect(await pending).toMatchObject({ state: 'accepted' });
  expect(await service.execute(actor, 'one', key)).toEqual({
    state: 'indeterminate',
  });
  expect(provider).toHaveBeenCalledTimes(1);
});
