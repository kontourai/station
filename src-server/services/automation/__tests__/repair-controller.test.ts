import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { createIsolatedRepairRoutes } from '../../../routes/operations/repairs.js';
import { execGitSync } from '../../../utils/git-exec.js';
import { TaskGraphService } from '../../projects/task-graph-service.js';
import { recordAutomationEvent } from '../automation-intake.js';
import { createAutomationLedger } from '../automation-ledger.js';
import { AutomationStore } from '../automation-store.js';
import { normalizeGitHubWorkflowRun } from '../github-workflow-run.js';
import { IsolatedRepairController } from '../repair-controller.js';
import type {
  RepairWorkerEvidence,
  RepairWorkerInput,
} from '../repair-worker.mjs';
import {
  QUALIFICATION_RULE,
  workflowRun,
} from './fixtures/workflow-run-fixture.js';

const temporary = trackTempDirs();
const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0)) await close();
  vi.unstubAllEnvs();
});
const operator = { id: 'fixture-operator', assertCurrent: async () => {} };
const image = `sha256:${'a'.repeat(64)}`;
const gitHash = (type: string, value: Buffer) =>
  createHash('sha1')
    .update(`${type} ${value.length}\0`)
    .update(value)
    .digest('hex');

async function fixture(
  options: { failure?: 'protected' | 'authority' | 'stopped' | 'case' } = {},
) {
  const home = temporary('isolated-repair-caller-');
  const repo = join(home, 'repository');
  mkdirSync(repo);
  const git = (...args: string[]) =>
    String(
      execGitSync(args, {
        cwd: repo,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      }),
    ).trim();
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(repo, 'repair.txt'), '\uFEFFbefore\n');
  writeFileSync(join(repo, 'remove.txt'), 'remove without newline');
  writeFileSync(join(repo, 'empty-remove.txt'), '');
  git('add', '.');
  git('commit', '-qm', 'fixture');
  git('remote', 'add', 'origin', 'https://github.com/kontourai/station.git');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  const baseSha = git('rev-parse', 'HEAD');
  const baseTree = git('rev-parse', 'HEAD^{tree}');
  const graphHome = join(home, 'graph');
  mkdirSync(graphHome);
  const tasks = new TaskGraphService(graphHome, {
    projectService: {
      getProject: (slug) => ({
        id: slug,
        slug,
        name: slug,
        workingDirectory: repo,
        createdAt: '2026-10-30T10:00:00.000Z',
        updatedAt: '2026-10-30T10:00:00.000Z',
      }),
    },
  });
  const policy = new AutomationStore(home);
  const ledger = createAutomationLedger({
    directory: join(home, 'automation'),
  });
  let enabled = true;
  const worker = vi.fn(
    async (input: RepairWorkerInput): Promise<RepairWorkerEvidence> => {
      await input.assertCurrent();
      expect(readFileSync(join(input.workspace, 'repair.txt'), 'utf8')).toBe(
        '\uFEFFbefore\n',
      );
      expect(input.observation['run.run_attempt']).toBe('2');
      if (options.failure === 'case')
        await writeFile(join(input.workspace, 'REPAIR.txt'), 'case collision');
      else
        await writeFile(
          join(input.workspace, 'repair.txt'),
          '\uFEFFafter without newline',
        );
      await writeFile(join(input.workspace, 'added.txt'), '\uFEFFadded\n');
      await writeFile(join(input.workspace, 'empty-added.txt'), '');
      await rm(join(input.workspace, 'remove.txt'));
      await rm(join(input.workspace, 'empty-remove.txt'));
      // A hostile Git config must remain inert when the host captures this result.
      await mkdir(join(input.workspace, '.git'));
      await writeFile(
        join(input.workspace, '.git', 'config'),
        '[core]\n\thooksPath = /untrusted-repair-hooks\n',
      );
      if (options.failure === 'protected') {
        await mkdir(join(input.workspace, '.github'));
        await writeFile(
          join(input.workspace, '.github', 'bypass.yml'),
          'malicious',
        );
      }
      if (options.failure === 'authority') enabled = false;
      return {
        receipt: {
          container_removed: true,
          storage_violation: null,
          terminal: { status: 0, timeout: false, overflow: false },
          provider_thread_id: 'synthetic-turn',
          observed: {
            execution_owner: input.ownerId,
            invocation_id: input.runId,
            image: input.profile.image,
            argv_model: input.profile.model,
            host_setup: { station_repair_binding: input.bindingDigest },
          },
        },
        provider: {
          transportMode: 'fixture',
          counters: {
            forwarded: 1,
            total_forwarded: 1,
            max_requests: input.budget.maxProviderRequests,
          },
          evidence: [],
        },
        outboundConfinement: 'not-established',
        hostUidMapping: 'not-verified',
      };
    },
  );
  const observeWorker = vi.fn(async () => {
    if (options.failure === 'stopped' && worker.mock.calls.length)
      throw new Error('worker still present');
  });
  const calls: {
    path: string;
    method: string;
    body: Record<string, unknown>;
  }[] = [];
  let expectedTree = '';
  let branch = '';
  let commitSha = '';
  const publisherFetch = vi.fn(async (url: string, init: RequestInit) => {
    const path = url.slice('https://api.github.com'.length);
    const method = init.method ?? 'GET';
    const body = init.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : {};
    calls.push({ path, method, body });
    if (path === '/app') return Response.json({ id: 7 });
    if (path === '/app/installations/8')
      return Response.json({
        id: 8,
        app_id: 7,
        account: { login: 'kontourai' },
      });
    if (path.endsWith('/access_tokens'))
      return Response.json({
        token: 'synthetic-installation-token',
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        permissions: {
          contents: 'write',
          pull_requests: 'write',
          metadata: 'read',
        },
        repositories: [{ id: 19, full_name: 'kontourai/station' }],
      });
    if (path.startsWith('/installation/repositories'))
      return Response.json({
        total_count: 1,
        repositories: [{ id: 19, full_name: 'kontourai/station' }],
      });
    if (path === '/repos/kontourai/station')
      return Response.json({
        id: 19,
        full_name: 'kontourai/station',
        default_branch: 'main',
      });
    if (path.endsWith('/git/ref/heads/main'))
      return Response.json({ object: { type: 'commit', sha: baseSha } });
    if (path.endsWith(`/git/commits/${baseSha}`))
      return Response.json({ sha: baseSha, tree: { sha: baseTree } });
    if (path.includes('/git/ref/heads/'))
      return Response.json({}, { status: 404 });
    if (path.endsWith('/git/blobs'))
      return Response.json(
        { sha: gitHash('blob', Buffer.from(String(body.content), 'base64')) },
        { status: 201 },
      );
    if (path.endsWith('/git/trees'))
      return Response.json({ sha: expectedTree }, { status: 201 });
    if (path.endsWith('/git/commits')) {
      const author = body.author as {
        name: string;
        email: string;
        date: string;
      };
      const raw = `tree ${expectedTree}\nparent ${baseSha}\nauthor ${author.name} <${author.email}> ${Date.parse(author.date) / 1000} +0000\ncommitter ${author.name} <${author.email}> ${Date.parse(author.date) / 1000} +0000\n\n${body.message}`;
      commitSha = String(
        execGitSync(['hash-object', '-t', 'commit', '--stdin'], {
          cwd: repo,
          input: raw,
          encoding: 'utf8',
        }),
      ).trim();
      return Response.json(
        {
          sha: commitSha,
          tree: { sha: expectedTree },
          parents: [{ sha: baseSha }],
          message: body.message,
          author,
          committer: author,
        },
        { status: 201 },
      );
    }
    if (path.endsWith('/git/refs')) {
      branch = String(body.ref).replace('refs/heads/', '');
      return Response.json(
        { ref: body.ref, object: { type: 'commit', sha: commitSha } },
        { status: 201 },
      );
    }
    if (path.includes('/pulls?')) return Response.json([]);
    if (path.endsWith('/pulls'))
      return Response.json(
        {
          number: 23,
          html_url: 'https://github.com/kontourai/station/pull/23',
          state: 'open',
          draft: body.draft,
          title: body.title,
          body: body.body,
          head: { ref: branch, sha: commitSha, repo: { id: 19 } },
          base: { ref: 'main', sha: baseSha, repo: { id: 19 } },
        },
        { status: 201 },
      );
    throw new Error(`Unexpected publication request ${path}`);
  });
  const controller = new IsolatedRepairController({
    home,
    enabled: () => enabled,
    policy,
    ledger: () => ledger,
    tasks,
    projectRoot: () => repo,
    isAgentCurrent: async () => true,
    logger: { warn: vi.fn() },
    worker,
    observeWorker,
    publisher: { fetch: publisherFetch },
  });
  closes.push(async () => {
    await controller.close();
    for (const [input] of worker.mock.calls)
      await rm(input.directory, { recursive: true, force: true });
    ledger.close();
  });
  const execution = await controller.store.configure(
    {
      expectedRevision: 0,
      profile: {
        kind: 'execution',
        projectId: 'project',
        agentId: 'repairer',
        repository: 'kontourai/station',
        repositoryId: 19,
        image,
        model: 'synthetic-model',
        reasoningEffort: 'medium',
        providerAuth: { env: 'STATION_SYNTHETIC_PROVIDER' },
      },
    },
    operator,
  );
  expect(execution.enabled).toBe(false);
  await controller.store.setEnabled(execution.id, 1, true, operator);
  const publisher = await controller.store.configure(
    {
      expectedRevision: 0,
      profile: {
        kind: 'publisher',
        repository: 'kontourai/station',
        repositoryId: 19,
        appId: 7,
        installationId: 8,
        privateKeyAuth: { env: 'STATION_SYNTHETIC_APP_KEY' },
      },
    },
    operator,
  );
  await controller.store.setEnabled(publisher.id, 1, true, operator);
  const app = createIsolatedRepairRoutes({
    controller,
    operator: async () => operator,
  });
  const request = async (path: string, value: unknown) =>
    app.request(`http://fixture.test/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(value),
    });
  const sourceInput = {
    kind: 'github-poll',
    name: 'fixture',
    repository: 'kontourai/station',
    grants: [
      {
        projectId: 'project',
        agentId: 'repairer',
        actions: ['isolated-repair', 'publish-branch'],
      },
    ],
  };
  expect((await request('sources', sourceInput)).status).toBe(200);
  const source = policy.listSources()[0]!;
  expect(source.enabled).toBe(false);
  expect(
    (
      await request('rules', {
        name: QUALIFICATION_RULE.name,
        sourceId: source.id,
        match: QUALIFICATION_RULE.match,
        episode: QUALIFICATION_RULE.episode,
        rateLimit: QUALIFICATION_RULE.rateLimit,
        action: {
          kind: 'isolated-repair',
          projectId: 'project',
          agentId: 'repairer',
          profileId: execution.id,
          instructions: 'Repair the failing fixture.',
          budget: { maxProviderRequests: 2, maxWallRuntimeMs: 60_000 },
        },
      })
    ).status,
  ).toBe(200);
  const before = controller.automationConfiguration();
  expect(
    (
      await request('configuration/enable', {
        kind: 'source',
        id: source.id,
        expectedFingerprint: before.fingerprint,
        enabled: true,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await request('configuration/enable', {
        kind: 'rule',
        id: policy.read().rules[0]!.id,
        expectedFingerprint: before.fingerprint,
        enabled: true,
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await request('configuration/enable', {
        kind: 'rule',
        id: policy.read().rules[0]!.id,
        expectedFingerprint: controller.automationConfiguration().fingerprint,
        enabled: true,
      })
    ).status,
  ).toBe(200);
  const config = policy.read();
  const run = workflowRun({
    conclusion: 'failure',
    runAttempt: 2,
    updatedAt: new Date(Date.now() - 1000).toISOString(),
  });
  run.head_sha = baseSha;
  const event = normalizeGitHubWorkflowRun(run, {
    source: config.sources[0]!,
    receivedAt: Date.now(),
  });
  if (event.kind !== 'event') throw new Error(event.reason);
  const intake = () =>
    recordAutomationEvent({
      ledger,
      source: config.sources[0],
      rules: [config.rules[0]!],
      event: event.event,
      transportId: event.event.semanticKey,
      now: Date.now(),
    });
  expect(intake().outcome).toBe('matched');
  await controller.tick();
  await vi.waitFor(() =>
    expect(controller.list()[0]?.phase, controller.list()[0]?.reasonCode).toBe(
      options.failure ? 'indeterminate' : 'proposed',
    ),
  );
  const retained = controller.store.read(controller.list()[0]!.runId)!;
  const artifact = await controller.artifact(retained.runId, operator);
  const applyPatch = () => {
    execGitSync(['apply', '--index', '--whitespace=nowarn', '-'], {
      cwd: repo,
      input: artifact.result!.patch,
      encoding: 'utf8',
    });
    expectedTree = git('write-tree');
    expect(expectedTree).toBe(artifact.result!.expectedTreeSha);
  };
  return {
    home,
    repo,
    controller,
    tasks,
    ledger,
    policy,
    worker,
    calls,
    retained,
    artifact,
    publisher,
    publisherFetch,
    execution,
    intake,
    request,
    app,
    applyPatch,
    disable: () => {
      enabled = false;
    },
  };
}

async function approve(context: Awaited<ReturnType<typeof fixture>>) {
  const binding = {
    bindingDigest: context.artifact.bindingDigest,
    resultDigest: context.artifact.result!.digest,
  };
  expect(
    (
      await context.request(`${context.retained.runId}/review`, {
        ...binding,
        verdict: 'approve',
        rationale: 'Reviewed exact fixture patch and native receipt limits.',
      })
    ).status,
  ).toBe(200);
  const reviewed = context.controller.store.read(context.retained.runId)!;
  const response = await context.request(`${context.retained.runId}/grant`, {
    ...binding,
    reviewId: reviewed.review!.id,
    publisherId: context.publisher.id,
  });
  expect(response.status).toBe(200);
  const currentGrant = context.controller.store.read(context.retained.runId)!
    .grant!;
  expect(await response.json()).toMatchObject({
    data: { id: currentGrant.id },
  });
  return currentGrant;
}

test('normalized observation creates one real Task and exact source proposal; a distinct operator review and consumed grant publish only a draft', async () => {
  const context = await fixture();
  context.applyPatch();
  expect(readFileSync(join(context.repo, 'repair.txt'), 'utf8')).toBe(
    '\uFEFFafter without newline',
  );
  expect(context.intake().outcome).toBe('duplicate');
  await context.controller.tick();
  expect(context.worker).toHaveBeenCalledTimes(1);
  expect(context.tasks.readTaskView(context.retained.taskId)?.status).toBe(
    'review',
  );
  expect(context.calls).toHaveLength(0);
  expect(
    (
      await context.request(`${context.retained.runId}/publish`, {
        grantId: '12345678-1234-4123-8123-123456789abc',
      })
    ).status,
  ).toBe(409);
  const key = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  vi.stubEnv('STATION_SYNTHETIC_APP_KEY', String(key));
  const grant = await approve(context);
  expect(context.calls).toHaveLength(0);
  const responses = await Promise.all([
    context.request(`${context.retained.runId}/publish`, { grantId: grant.id }),
    context.request(`${context.retained.runId}/publish`, { grantId: grant.id }),
  ]);
  expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
  expect(await responses.find((r) => r.status === 200)!.json()).toMatchObject({
    data: { outcome: 'published' },
  });
  expect(context.controller.store.read(context.retained.runId)?.phase).toBe(
    'published',
  );
  expect(
    context.calls.filter((c) => c.path.endsWith('/access_tokens')),
  ).toHaveLength(1);
  expect(
    context.calls.find((c) => c.path.endsWith('/pulls'))?.body,
  ).toMatchObject({ draft: true, maintainer_can_modify: false });
  expect(context.calls.some((c) => /merge|labels|automerge/.test(c.path))).toBe(
    false,
  );
  expect(context.tasks.readTaskView(context.retained.taskId)?.status).toBe(
    'done',
  );
  expect(
    (await context.request(`${context.retained.runId}/archive`, {})).status,
  ).toBe(200);
  expect(context.controller.list()).toHaveLength(0);
  expect(
    (await context.controller.artifact(context.retained.runId, operator))
      .publication?.outcome,
  ).toBe('published');
});

test.each(['protected', 'authority', 'stopped'] as const)(
  'refuses %s result before a proposal or publication credential can exist',
  async (failure) => {
    const context = await fixture({ failure });
    expect(context.retained.result).toBeUndefined();
    expect(context.calls).toHaveLength(0);
    await context.controller.tick();
    expect(context.worker).toHaveBeenCalledTimes(1);
    expect(
      (
        await context.request(`${context.retained.runId}/grant`, {
          bindingDigest: 'a'.repeat(64),
          resultDigest: 'b'.repeat(64),
          reviewId: crypto.randomUUID(),
          publisherId: context.publisher.id,
        })
      ).status,
    ).toBe(failure === 'authority' ? 404 : 409);
  },
);

test('revocation preserves operator inspection and historical repository attribution; unresolved publication cannot consume its grant again', async () => {
  const context = await fixture();
  context.applyPatch();
  const grant = await approve(context);
  vi.stubEnv('STATION_SYNTHETIC_APP_KEY', 'not-a-private-key');
  const receipt = await context.controller.publish(
    context.retained.runId,
    grant.id,
    operator,
  );
  expect(receipt.outcome).toBe('indeterminate');
  expect(
    context.controller.store.read(context.retained.runId)?.grant?.consumedAt,
  ).toBeTruthy();
  await expect(
    context.controller.publish(context.retained.runId, grant.id, operator),
  ).rejects.toThrow();
  context.disable();
  await context.controller.store.configure(
    {
      expectedRevision: 2,
      profile: {
        ...context.controller.store.execution(context.execution.id)!,
        repository: 'other/repository',
      },
    },
    operator,
  );
  expect(context.controller.list()[0]?.repository).toBe('kontourai/station');
  expect(
    (await context.controller.artifact(context.retained.runId, operator)).result
      ?.patch,
  ).toContain('repair.txt');
  expect(
    (
      await context.request(`${context.retained.runId}/followup`, {
        rationale:
          'Inspect the immutable branch/checkpoints manually before any new event.',
      })
    ).status,
  ).toBe(200);
  expect(context.controller.store.read(context.retained.runId)?.phase).toBe(
    'indeterminate',
  );
  const denied = createIsolatedRepairRoutes({
    controller: context.controller,
    operator: async () => {
      throw new Error('agent');
    },
  });
  expect((await denied.request('http://fixture.test/profiles')).status).toBe(
    403,
  );
  expect(
    (
      await denied.request('http://fixture.test/profiles', {
        method: 'POST',
        body: '{}',
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await createIsolatedRepairRoutes({
        operator: async () => operator,
      }).request('http://fixture.test/')
    ).status,
  ).toBe(404);
});

test('publication cancellation revokes authority while an unknown HTTP effect settles; it never reports that a remote effect was undone', async () => {
  const context = await fixture();
  context.applyPatch();
  const key = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  vi.stubEnv('STATION_SYNTHETIC_APP_KEY', String(key));
  const grant = await approve(context);
  let announce: () => void = () => {};
  let release: () => void = () => {};
  const reached = new Promise<void>((resolve) => {
    announce = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetch = context.publisherFetch.getMockImplementation()!;
  context.publisherFetch.mockImplementation(async (url, init) => {
    if (url.endsWith('/access_tokens')) {
      announce();
      await released;
    }
    return fetch(url, init);
  });
  const publication = context.controller.publish(
    context.retained.runId,
    grant.id,
    operator,
  );
  await reached;
  const cancellation = context.controller.cancel(
    context.retained.runId,
    operator,
  );
  await vi.waitFor(() =>
    expect(
      context.controller.store.read(context.retained.runId)?.grant?.revokedAt,
    ).toBeTruthy(),
  );
  release();
  expect((await publication).outcome).toBe('indeterminate');
  expect((await cancellation)?.phase).toBe('indeterminate');
  await context.controller.cancel(context.retained.runId, operator);
  expect(context.controller.store.read(context.retained.runId)?.phase).toBe(
    'indeterminate',
  );
  expect(context.calls.some((call) => call.path.endsWith('/git/refs'))).toBe(
    false,
  );
});

test('result census rejects a case-fold collision against an unchanged source path on a case-sensitive filesystem', async (testContext) => {
  const root = temporary('repair-case-sensitivity-');
  writeFileSync(join(root, 'a'), 'a');
  try {
    writeFileSync(join(root, 'A'), 'A', { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      testContext.skip('Case-sensitive filesystem required');
    throw error;
  }
  const context = await fixture({ failure: 'case' });
  expect(context.worker).toHaveBeenCalledTimes(1);
  expect(context.retained.reasonCode).toBe('repair-source-case-collision');
  expect(context.retained.result).toBeUndefined();
});

test('operator resolution releases global admission after stopped unknown repairs while retaining unknown-effect evidence and refusing replay', async () => {
  const context = await fixture({ failure: 'protected' });
  const config = context.policy.read();
  const original = config.rules[0]!;
  const second = await context.policy.createRule({
    ...original,
    name: 'second failed repair',
  });
  await context.policy.setEnabled({
    kind: 'rule',
    id: second.id,
    expectedFingerprint:
      context.controller.automationConfiguration().fingerprint,
    enabled: true,
  });
  const source = context.policy.read().sources[0]!;
  const normalized = normalizeGitHubWorkflowRun(
    workflowRun({
      id: 55555555,
      runAttempt: 2,
      conclusion: 'failure',
      updatedAt: new Date(Date.now() - 1000).toISOString(),
    }),
    { source, receivedAt: Date.now() },
  );
  if (normalized.kind !== 'event') throw new Error(normalized.reason);
  recordAutomationEvent({
    ledger: context.ledger,
    source,
    rules: context.policy
      .actionableRules(source.id)
      .filter((r) => r.id === second.id),
    event: normalized.event,
    transportId: normalized.event.semanticKey,
    now: Date.now(),
  });
  await context.controller.tick();
  await vi.waitFor(() =>
    expect(
      context.controller.list().filter((r) => r.phase === 'indeterminate'),
    ).toHaveLength(2),
  );
  context.ledger.openEpisode({
    ruleId: 'capacity-probe',
    episodeKey: 'capacity-probe',
    episodeId: '1',
    maxAttempts: 1,
    now: Date.now(),
  });
  const admission = {
    episodeKey: 'capacity-probe',
    expectedEpisodeId: '1',
    deliveryKey: 'a'.repeat(64),
    now: Date.now(),
    maxStartsPerHour: 2,
    maxConcurrentActions: 2,
  };
  expect(context.ledger.claimAction(admission).kind).not.toBe('claimed');
  vi.spyOn(context.ledger, 'updateIntent').mockImplementationOnce(() => {
    throw new Error('synthetic SQLite release failure');
  });
  expect(
    (
      await context.request(`${context.retained.runId}/resolve`, {
        acknowledgeUnknownEffects: true,
        rationale:
          'Acknowledge unknown effects; try durable admission release.',
      })
    ).status,
  ).toBe(409);
  expect(
    context.controller.store.read(context.retained.runId)?.admissionReleasedAt,
  ).toBeUndefined();
  expect(
    (await context.request(`${context.retained.runId}/archive`, {})).status,
  ).toBe(409);
  expect(context.ledger.claimAction(admission).kind).not.toBe('claimed');
  expect(
    (
      await context.request(`${context.retained.runId}/resolve`, {
        acknowledgeUnknownEffects: true,
        rationale:
          'Worker stopped; acknowledge unknown effects and release admission without retry.',
      })
    ).status,
  ).toBe(200);
  expect(
    context.ledger.readIntent(context.retained.intent.intentId)?.state,
  ).toBe('failed');
  expect(context.controller.store.read(context.retained.runId)?.phase).toBe(
    'indeterminate',
  );
  const claim = context.ledger.claimAction(admission);
  expect(claim.kind).toBe('claimed');
  if (claim.kind === 'claimed') claim.receipt.release();
  expect(
    (await context.request(`${context.retained.runId}/archive`, {})).status,
  ).toBe(200);
  expect(
    (await context.controller.artifact(context.retained.runId, operator)).phase,
  ).toBe('indeterminate');
});
