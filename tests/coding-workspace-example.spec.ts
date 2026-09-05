/** Actual authored coding example through portable installation, Project hosts and a native model HTTP fixture. */
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { authenticatedE2EFetch } from './helpers/authenticated-request';
import { resolveE2EApiBase } from './helpers/e2e-target';
import { installPluginWithConsent } from './helpers/install-plugin';
import {
  closeFixtureServer,
  startOllamaFixture,
} from './helpers/ollama-fixture';

const api = resolveE2EApiBase();
const plugin = 'coding-starter';
const agent = 'coding-starter-assistant';
const slug = 'coding-example-project';
const connection = 'coding-example-model';
const model = 'coding-example:latest';
const answer = 'Controlled native coding review completed.';

async function json(path: string, method = 'GET', body?: unknown) {
  const response = await authenticatedE2EFetch(`${api}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
  });
  const payload = await response.text();
  expect(
    response.ok,
    `${method} ${path}: ${response.status} ${response.ok ? '' : payload.slice(0, 2000)}`,
  ).toBe(true);
  return JSON.parse(payload);
}

test('coding example preserves both Panes and its authored native Agent in a real worktree action', async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const root = mkdtempSync(join(tmpdir(), 'station-coding-example-'));
  const repo = join(root, 'repository');
  const requests: unknown[] = [];
  let fixture: Awaited<ReturnType<typeof startOllamaFixture>> | undefined;
  let previous:
    | { defaultLLMProvider?: string; defaultModel?: string }
    | undefined;
  const failures: unknown[] = [];
  let installed = false;
  let created = false;
  let connected = false;
  try {
    mkdirSync(repo);
    execFileSync('git', ['init', '--quiet', repo], { windowsHide: true });
    execFileSync(
      'git',
      [
        '-C',
        repo,
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.test',
        'commit',
        '--allow-empty',
        '-m',
        'fixture',
      ],
      { windowsHide: true },
    );
    fixture = await startOllamaFixture(
      model,
      (body) => requests.push(body),
      answer,
    );
    previous = (await json('/config/app')).data;
    const authored = JSON.parse(
      readFileSync(
        resolve(
          'examples/coding-starter/agents/coding-starter-assistant/agent.json',
        ),
        'utf8',
      ),
    );
    await json('/api/connections', 'POST', {
      id: connection,
      name: 'Coding example controlled native model',
      kind: 'model',
      type: 'ollama',
      enabled: true,
      capabilities: ['llm'],
      config: { baseUrl: fixture.origin, defaultModel: model },
      status: 'ready',
      prerequisites: [],
    });
    connected = true;
    // This is explicit operator model configuration, not a rewritten plugin Agent.
    await json('/config/app', 'PUT', {
      defaultLLMProvider: connection,
      defaultModel: model,
    });
    expect(
      (await installPluginWithConsent(api, resolve('examples/coding-starter')))
        .success,
    ).toBe(true);
    installed = true;
    await json('/api/projects', 'POST', {
      slug,
      name: 'Coding Example Project',
      workingDirectory: repo,
      defaultWorkspaceIsolation: 'worktree',
      agents: [agent],
    });
    created = true;
    await json(`/api/projects/${slug}/layouts/apply`, 'POST', {
      layoutId: 'builtin:coding',
    });
    const catalog = (await json(`/api/projects/${slug}/panes`)).data;
    const descriptors = catalog.descriptors.filter(
      (entry: any) => entry.provenance.pluginId === plugin,
    );
    expect(descriptors.map((entry: any) => entry.name).sort()).toEqual([
      'Diff',
      'Workspace',
    ]);
    for (const descriptor of descriptors)
      expect(
        catalog.instances.find(
          (entry: any) => entry.descriptorId === descriptor.id,
        ),
      ).toMatchObject({ boundContext: { projectId: catalog.projectId } });
    await page.addInitScript(() =>
      localStorage.setItem('station:onboarding-setup-dismissed', '1'),
    );
    const evidenceRoot = resolve(
      '.kontourai/coding-workspace-browser',
      basename(process.env.STATION_E2E_OUTPUT_DIR ?? 'manual'),
    );
    mkdirSync(evidenceRoot, { recursive: true });
    for (const name of ['Workspace', 'Diff']) {
      await page.goto(`/projects/${slug}`);
      await page
        .getByRole('button', { name: '+ Add pane', exact: true })
        .click();
      await page
        .getByRole('dialog', { name: 'Add workspace pane' })
        .getByRole('listitem')
        .filter({ has: page.getByText(name, { exact: true }) })
        .getByRole('button', { name: `Open ${name}`, exact: true })
        .click();
      await expect(page.locator('.coding-shell')).toBeVisible();
      await expect(
        page.getByText('Sample data', { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole('region', { name: 'Workspace actions', exact: true }),
      ).toHaveCount(1);
      await expect(
        page.getByRole('button', { name: 'Review current diff', exact: true }),
      ).toHaveCount(1);
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await page.screenshot({
          path: testInfo.outputPath(
            `coding-${name.toLowerCase()}-${width}.png`,
          ),
          fullPage: true,
          animations: 'disabled',
        });
        copyFileSync(
          testInfo.outputPath(`coding-${name.toLowerCase()}-${width}.png`),
          join(evidenceRoot, `coding-${name.toLowerCase()}-${width}.png`),
        );
      }
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/projects/${slug}/layouts/coding`);
    await page.getByRole('tab', { name: 'Files', exact: true }).click();
    await page.getByRole('button', { name: /Pane actions for Files/i }).click();
    await page.getByRole('menuitem', { name: 'Open pane catalog' }).click();
    await page
      .getByRole('dialog', { name: 'Add workspace pane' })
      .getByRole('listitem')
      .filter({ has: page.getByText('Diff', { exact: true }) })
      .getByRole('button', { name: 'Open Diff', exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name: 'Diff review', exact: true }),
    ).toBeVisible();
    const bar = page.getByRole('region', {
      name: 'Workspace actions',
      exact: true,
    });
    await expect(bar).toHaveCount(1);
    await expect(bar.getByRole('combobox', { name: 'Agent' })).toHaveValue(
      `own-plugin-agent:${agent}`,
    );
    const action = bar.getByRole('button', {
      name: 'Review current diff',
      exact: true,
    });
    await expect(action).toBeEnabled();
    const [response] = await Promise.all([
      page.waitForResponse(
        (candidate) =>
          candidate.request().method() === 'POST' &&
          new URL(candidate.url()).pathname.endsWith(
            `/pane-host/${slug}/execute`,
          ),
      ),
      action.click(),
    ]);
    const execution = (await response.json()).data;
    expect(execution).toMatchObject({ state: 'accepted' });
    await expect(action).toBeDisabled();
    let receipt: any;
    await expect
      .poll(
        async () => {
          receipt = (
            await json(
              `/api/orchestration/sessions/${encodeURIComponent(execution.sessionId)}`,
            )
          ).data;
          return receipt.events?.some(
            (event: any) =>
              event.method === 'turn.completed' &&
              event.turnId === execution.turnId &&
              event.outputText?.includes(answer),
          );
        },
        { timeout: 60_000 },
      )
      .toBe(true);
    const started = receipt.events.find(
      (event: any) => event.method === 'session.started',
    );
    expect(started.metadata.workspacePaneHostAction).toMatchObject({
      pluginId: plugin,
      actionId: 'review-diff',
    });
    expect(receipt.session).toMatchObject({
      assignedAgentSlug: agent,
      projectSlug: slug,
    });
    const cwd = receipt.session.cwd;
    expect(cwd).not.toBe(repo);
    expect(
      realpathSync(
        execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
          encoding: 'utf8',
          windowsHide: true,
        }).trim(),
      ),
    ).toBe(realpathSync(cwd));
    expect(
      execFileSync('git', ['-C', repo, 'worktree', 'list', '--porcelain'], {
        encoding: 'utf8',
        windowsHide: true,
      })
        .split('\n')
        .filter((line) => line.startsWith('worktree '))
        .map((line) => realpathSync(line.slice('worktree '.length).trim())),
    ).toContain(realpathSync(cwd));
    const actionRequests = requests.filter((request) =>
      JSON.stringify(request).includes(
        'Review the current diff for correctness',
      ),
    );
    expect(actionRequests).toHaveLength(1);
    expect(JSON.stringify(actionRequests[0])).toContain(authored.prompt);
    expect(
      JSON.parse(
        readFileSync(
          resolve(
            'examples/coding-starter/agents/coding-starter-assistant/agent.json',
          ),
          'utf8',
        ),
      ),
    ).toEqual(authored);
    writeFileSync(
      join(evidenceRoot, 'native-action-receipt.json'),
      JSON.stringify(
        {
          execution,
          provenance: started.metadata.workspacePaneHostAction,
          session: {
            agentId: receipt.session.assignedAgentSlug,
            projectSlug: receipt.session.projectSlug,
            cwd,
          },
          controlledModel: model,
          authored,
          completed: true,
        },
        null,
        2,
      ),
    );
    await json(`/api/registry/plugins/${plugin}`, 'DELETE');
    installed = false;
    await expect(
      page.getByRole('button', { name: 'Review current diff', exact: true }),
    ).toHaveCount(0);
    await expect(page.locator('.coding-shell')).toHaveCount(0);
  } catch (error) {
    failures.push(error);
  } finally {
    const clean = async (operation: () => unknown | Promise<unknown>) => {
      try {
        await operation();
      } catch (error) {
        failures.push(error);
      }
    };
    if (created) await clean(() => json(`/api/projects/${slug}`, 'DELETE'));
    if (installed)
      await clean(() => json(`/api/registry/plugins/${plugin}`, 'DELETE'));
    if (previous)
      await clean(() =>
        json('/config/app', 'PUT', {
          defaultLLMProvider: previous!.defaultLLMProvider ?? '',
          defaultModel: previous!.defaultModel ?? '',
        }),
      );
    if (connected)
      await clean(() => json(`/api/connections/${connection}`, 'DELETE'));
    await clean(() => closeFixtureServer(fixture?.server ?? null));
    await clean(() => rmSync(root, { recursive: true, force: true }));
  }
  if (failures.length)
    throw new AggregateError(
      failures,
      'Coding example execution or cleanup failed',
    );
});
