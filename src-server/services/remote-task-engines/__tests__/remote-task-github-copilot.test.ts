/**
 * The GitHub Copilot cloud agent binding through the real service, against
 * an HTTP fake serving the agent tasks REST API's task object and list shapes
 * (https://docs.github.com/en/rest/agent-tasks/agent-tasks).
 */
import { describe, expect, test } from 'vitest';
import { harness } from './harness.js';
import { githubFake, json } from './vendor-fakes.js';

const TOKEN = 'github_pat_test_0001';

async function setup() {
  const github = githubFake();
  const h = harness(github.fake.fetch);
  const connectionId = await h.readyConnection('github-copilot', TOKEN);
  return { github, h, connectionId };
}

describe('GitHub Copilot binding', () => {
  test('creates a task in the named repository with the preview API version', async () => {
    const { github, h, connectionId } = await setup();
    const task = await h.service.createTask(connectionId, {
      prompt: 'Fix the login button on the homepage',
      repository: { owner: 'octo', name: 'site' },
      baseRef: 'main',
      model: 'gpt-5.4',
      createPullRequest: true,
    });
    const [create] = github.fake.requests;
    expect(create?.url.pathname).toBe('/agents/repos/octo/site/tasks');
    expect(create?.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(create?.headers.get('x-github-api-version')).toBe('2026-03-10');
    expect(create?.headers.get('accept')).toBe('application/vnd.github+json');
    expect(create?.body).toEqual({
      prompt: 'Fix the login button on the homepage',
      model: 'gpt-5.4',
      base_ref: 'main',
      create_pull_request: true,
    });
    expect(task).toMatchObject({ status: 'queued', vendorStatus: 'queued' });
  });

  test('a task needs a repository', async () => {
    const { github, h, connectionId } = await setup();
    await expect(
      h.service.createTask(connectionId, { prompt: 'x' }),
    ).rejects.toMatchObject({ code: 'remote-task-invalid' });
    expect(github.fake.requests).toHaveLength(0);
  });

  test('follow-ups, message paging and cancel are refused before any request', async () => {
    const { github, h, connectionId } = await setup();
    await expect(
      h.service.sendMessage(connectionId, 'task_1', 'more'),
    ).rejects.toMatchObject({ code: 'remote-task-capability-unsupported' });
    await expect(h.service.cancelTask(connectionId, 'task_1')).rejects.toMatchObject(
      { code: 'remote-task-capability-unsupported' },
    );
    expect(github.fake.requests).toHaveLength(0);
  });

  test('reads usage per session and pull requests by id', async () => {
    const { github, h, connectionId } = await setup();
    const { taskId } = await h.service.createTask(connectionId, {
      prompt: 'Go',
      repository: { owner: 'octo', name: 'site' },
    });
    Object.assign(github.tasks.get(taskId) as object, {
      state: 'completed',
      artifacts: [
        { provider: 'github', type: 'pull', data: { id: 42, global_id: 'PR_x' } },
        { provider: 'github', type: 'branch', data: { head_ref: 'copilot/fix', base_ref: 'main' } },
      ],
      sessions: [
        { id: 's1', state: 'completed', created_at: '2026-11-14T10:00:00Z', usage: { type: 'ai_credits', amount: 1.5 } },
        { id: 's2', state: 'completed', created_at: '2026-11-14T10:05:00Z', usage: { type: 'ai_credits', amount: 2 } },
        { id: 's3', state: 'completed', created_at: '2026-11-14T10:09:00Z', usage: { type: 'premium_requests', amount: 1 } },
      ],
    });
    const result = await h.service.syncTask(connectionId, taskId);
    expect(github.fake.requests.at(-1)?.url.pathname).toBe(`/agents/tasks/${taskId}`);
    expect(result.task.usage).toEqual([
      { unit: 'ai-credits', quantity: 3.5 },
      { unit: 'premium-requests', quantity: 1 },
    ]);
    expect(result.task.outputs).toEqual([
      { kind: 'pull-request', reference: 'pull:42' },
    ]);
    expect(result.quiescent).toBe(true);
    // No message endpoint: the stored record is Station's own status line.
    expect(result.appended.map((e) => e.author)).toEqual(['system']);
  });

  test("GitHub's exhausted-quota 403 is a rate limit with the reset wait", async () => {
    const { github, h, connectionId } = await setup();
    const now = Date.now();
    github.fake.inject(1, () =>
      json(
        403,
        { message: 'API rate limit exceeded' },
        {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(Math.ceil(now / 1000) + 120),
        },
      ),
    );
    const error = await h.service
      .listTasks(connectionId, null)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'remote-task-rate-limited', status: 429 });
    const wait = (error as { details: { retryAfterMs: number } }).details
      .retryAfterMs;
    expect(wait).toBeGreaterThan(100_000);
    expect(wait).toBeLessThanOrEqual(121_000);
  });

  test("a plan refusal reaches the person as GitHub's own words", async () => {
    const { github, h, connectionId } = await setup();
    github.fake.inject(1, () =>
      json(403, {
        message: 'Copilot cloud agent is not available for this account.',
      }),
    );
    await expect(
      h.service.createTask(connectionId, {
        prompt: 'Go',
        repository: { owner: 'octo', name: 'site' },
      }),
    ).rejects.toMatchObject({
      code: 'remote-task-vendor-refused',
      message: expect.stringContaining('not available for this account'),
    });
  });

  test('lists tasks with page-number paging', async () => {
    const { github, h, connectionId } = await setup();
    await h.service.createTask(connectionId, {
      prompt: 'One',
      repository: { owner: 'octo', name: 'site' },
    });
    const page = await h.service.listTasks(connectionId, null);
    expect(page.tasks).toHaveLength(1);
    expect(page.cursor).toBeNull();
    const list = github.fake.matching('GET', /^\/agents\/tasks$/)[0];
    expect(list?.url.searchParams.get('page')).toBe('1');
    expect(list?.url.searchParams.get('per_page')).toBe('100');
  });
});
