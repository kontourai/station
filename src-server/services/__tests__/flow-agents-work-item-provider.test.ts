/**
 * Fixture discipline: every CLI-output fixture below is written to a real
 * temp directory via fs.writeFileSync/mkdtempSync at test runtime (never a
 * checked-in sidecar-shaped path, never a shell redirect) — the repo's
 * config-protection hook blocks sidecar-shaped shell redirects.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  FLOW_AGENTS_WORK_ITEM_PROVIDER_IDENTITY,
  type FlowAgentsCliResult,
  type FlowAgentsCliRunner,
  FlowAgentsWorkItemProvider,
} from '../work-item-providers/flow-agents-work-item-provider.js';

const EFFECTIVE_BACKLOG_SETTINGS_CLI =
  'build/src/cli/effective-backlog-settings.js';
const PULL_WORK_PROVIDER_CLI = 'build/src/cli/pull-work-provider.js';

const tmpDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/** A fake pinned-package root with both CLI bins present (empty stub files —
 * the runner is stubbed, so these files are only used for existsSync checks).
 * mkdtempSync doesn't create nested dirs, so they're built explicitly. */
function makePackageRootWithClis(): string {
  const root = makeTempDir('flow-agents-pkg-');
  mkdirSync(join(root, 'build', 'src', 'cli'), { recursive: true });
  writeFileSync(join(root, EFFECTIVE_BACKLOG_SETTINGS_CLI), '// stub');
  writeFileSync(join(root, PULL_WORK_PROVIDER_CLI), '// stub');
  return root;
}

function stubRunner(
  responses: Record<string, FlowAgentsCliResult>,
  calls: Array<{ bin: string; args: string[]; input?: string }> = [],
): FlowAgentsCliRunner {
  return async (binPath, args, options) => {
    calls.push({ bin: binPath, args, input: options.input });
    const key = binPath.endsWith(EFFECTIVE_BACKLOG_SETTINGS_CLI)
      ? 'effective'
      : 'pull';
    const response = responses[key];
    if (!response) throw new Error(`no stub response for ${key}`);
    return response;
  };
}

const context = {
  projectId: 'project-alpha',
  workingDirectory: '/tmp/project-alpha',
};

const CONFIGURED_SETTINGS = {
  status: 'configured',
  scope: 'repo',
  current_repo: { owner: 'kontourai', name: 'station' },
  source: 'project',
  settings: {
    work_item_provider: {
      role: 'WorkItemProvider',
      kind: 'github',
      repo: { owner: 'kontourai', name: 'station' },
      capabilities: ['issues'],
    },
    board_provider: {
      role: 'BoardProvider',
      kind: 'github',
      repo: { owner: 'kontourai', name: 'station' },
      board: { type: 'github_project', owner: 'kontourai', number: 1 },
      capabilities: ['projects_boards'],
    },
    selection: {
      filters: {
        issue_state: 'open',
        include_labels: [],
        ready_statuses: ['ready'],
        exclude_statuses: [
          'in_progress',
          'blocked',
          'review',
          'verification',
          'done',
        ],
      },
      wip_policy: { prefer_finishing_active_work: true, active_statuses: [] },
    },
  },
};

const READY_QUEUE_OUTPUT = {
  ready_queue: [
    {
      id: 'github:kontourai/station#583',
      title: 'Provider seam for the Tasks board',
      status: 'ready',
      labels: ['area:tasks'],
      priority: undefined,
      source_provider: {
        role: 'WorkItemProvider',
        kind: 'github',
        owner: 'kontourai',
        repo: 'station',
        number: 583,
        url: 'https://github.com/kontourai/station/issues/583',
      },
      updated_at: '2026-07-20T00:00:00.000Z',
    },
  ],
  intake_gaps: [],
  warnings: [],
};

describe('FlowAgentsWorkItemProvider', () => {
  test('declares a read-only, no-write identity', () => {
    const provider = new FlowAgentsWorkItemProvider({
      packageRoot: makePackageRootWithClis(),
      runCli: async () => {
        throw new Error('not called');
      },
    });
    expect(provider.identity).toEqual(FLOW_AGENTS_WORK_ITEM_PROVIDER_IDENTITY);
    expect(provider.capabilities).toEqual({
      readOnly: true,
      supportsDispatch: false,
      supportsStatusWrite: false,
    });
  });

  test('reports unavailable when the package is not installed (no CLI bins found)', async () => {
    const emptyRoot = makeTempDir('flow-agents-empty-');
    const provider = new FlowAgentsWorkItemProvider({
      packageRoot: emptyRoot,
      runCli: async () => {
        throw new Error('not called');
      },
    });
    expect(provider.isPackageAvailable).toBe(false);

    const result = await provider.listWorkItems(context);
    expect(result).toEqual({
      available: false,
      items: [],
      reason: '@kontourai/flow-agents is not installed',
    });
  });

  test('reports unavailable when no backlog provider settings are configured', async () => {
    const calls: Array<{ bin: string; args: string[]; input?: string }> = [];
    const runCli = stubRunner(
      {
        effective: {
          stdout: JSON.stringify({
            status: 'ask_user',
            reason: 'no_backlog_provider_settings',
            message: 'Ask the user which backlog WorkItemProvider to use.',
          }),
          stderr: '',
          exitCode: 2,
        },
      },
      calls,
    );
    const provider = new FlowAgentsWorkItemProvider({
      packageRoot: makePackageRootWithClis(),
      runCli,
    });

    const result = await provider.listWorkItems(context);
    expect(result.available).toBe(false);
    expect(result.items).toEqual([]);
    expect(result.reason).toBe(
      'Ask the user which backlog WorkItemProvider to use.',
    );
    // The project-settings flag must be scoped to the project's own
    // workspace — never the CLI's own upward-walking default (which would
    // read an arbitrary ancestor directory's settings file).
    expect(calls[0]?.args).toEqual([
      '--repo-path',
      '/tmp/project-alpha',
      '--project-settings',
      '/tmp/project-alpha/context/settings/backlog-provider-settings.json',
      '--json',
    ]);
  });

  test('reports unavailable on malformed effective-backlog-settings JSON', async () => {
    const runCli = stubRunner({
      effective: { stdout: 'not json', stderr: '', exitCode: 0 },
    });
    const provider = new FlowAgentsWorkItemProvider({
      packageRoot: makePackageRootWithClis(),
      runCli,
    });
    const result = await provider.listWorkItems(context);
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/malformed JSON/);
  });

  test('reports unavailable when effective-backlog-settings exits with a hard failure', async () => {
    const runCli = stubRunner({
      effective: { stdout: '', stderr: 'boom', exitCode: 1 },
    });
    const provider = new FlowAgentsWorkItemProvider({
      packageRoot: makePackageRootWithClis(),
      runCli,
    });
    const result = await provider.listWorkItems(context);
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/effective-backlog-settings failed/);
  });

  test('lists ready work items when a GitHub-backed config resolves (render-only read)', async () => {
    const calls: Array<{ bin: string; args: string[]; input?: string }> = [];
    const runCli = stubRunner(
      {
        effective: {
          stdout: JSON.stringify(CONFIGURED_SETTINGS),
          stderr: '',
          exitCode: 0,
        },
        pull: {
          stdout: JSON.stringify(READY_QUEUE_OUTPUT),
          stderr: '',
          exitCode: 0,
        },
      },
      calls,
    );
    const provider = new FlowAgentsWorkItemProvider({
      packageRoot: makePackageRootWithClis(),
      runCli,
    });

    const result = await provider.listWorkItems(context);

    expect(result.available).toBe(true);
    expect(result.items).toEqual([
      {
        id: 'github:kontourai/station#583',
        title: 'Provider seam for the Tasks board',
        status: 'ready',
        provider: {
          kind: 'flow-agents-github',
          id: 'flow-agents-github:kontourai/station',
          label: 'GitHub (kontourai/station)',
        },
        workItemRef: 'github:kontourai/station#583',
        url: 'https://github.com/kontourai/station/issues/583',
        labels: ['area:tasks'],
        priority: undefined,
        updatedAt: '2026-07-20T00:00:00.000Z',
      },
    ]);

    // pull-work-provider receives the resolved settings via stdin, never a
    // shell redirect or a hand-authored Station-specific settings shape.
    const pullCall = calls.find((call) =>
      call.bin.endsWith(PULL_WORK_PROVIDER_CLI),
    );
    expect(pullCall?.args).toEqual(['--settings-json', '-']);
    expect(JSON.parse(pullCall?.input ?? '{}')).toEqual(
      CONFIGURED_SETTINGS.settings,
    );
  });

  test('surfaces a zero_ready_items dead-source warning without failing', async () => {
    const runCli = stubRunner({
      effective: {
        stdout: JSON.stringify(CONFIGURED_SETTINGS),
        stderr: '',
        exitCode: 0,
      },
      pull: {
        stdout: JSON.stringify({
          ready_queue: [],
          intake_gaps: [],
          warnings: [
            {
              code: 'zero_ready_items',
              message:
                'Configured BoardProvider yielded zero ready items; treat this as a dead readiness source and do not silently fall back to WorkItemProvider issue listing.',
            },
          ],
        }),
        stderr: '',
        exitCode: 0,
      },
    });
    const provider = new FlowAgentsWorkItemProvider({
      packageRoot: makePackageRootWithClis(),
      runCli,
    });

    const result = await provider.listWorkItems(context);
    expect(result.available).toBe(true);
    expect(result.items).toEqual([]);
    expect(result.warnings).toEqual([
      'Configured BoardProvider yielded zero ready items; treat this as a dead readiness source and do not silently fall back to WorkItemProvider issue listing.',
    ]);
  });

  test('drops a malformed ready-queue candidate defensively instead of throwing', async () => {
    const runCli = stubRunner({
      effective: {
        stdout: JSON.stringify(CONFIGURED_SETTINGS),
        stderr: '',
        exitCode: 0,
      },
      pull: {
        stdout: JSON.stringify({
          ready_queue: [
            { id: 'github:kontourai/station#583' /* missing title/status */ },
          ],
          intake_gaps: [],
          warnings: [],
        }),
        stderr: '',
        exitCode: 0,
      },
    });
    const provider = new FlowAgentsWorkItemProvider({
      packageRoot: makePackageRootWithClis(),
      runCli,
    });

    const result = await provider.listWorkItems(context);
    expect(result.available).toBe(true);
    expect(result.items).toEqual([]);
    expect(result.warnings).toEqual([
      'skipped a malformed ready-queue candidate',
    ]);
  });

  test.each([
    ['a null top-level response', 'null'],
    ['an array top-level response', '[]'],
    [
      'an object missing ready_queue entirely',
      JSON.stringify({ intake_gaps: [], warnings: [] }),
    ],
    [
      'ready_queue present but not an array',
      JSON.stringify({ ready_queue: 'not-an-array' }),
    ],
  ])(
    'reports unavailable (not an empty-but-healthy board) for %s',
    async (_label, stdout) => {
      const runCli = stubRunner({
        effective: {
          stdout: JSON.stringify(CONFIGURED_SETTINGS),
          stderr: '',
          exitCode: 0,
        },
        pull: { stdout, stderr: '', exitCode: 0 },
      });
      const provider = new FlowAgentsWorkItemProvider({
        packageRoot: makePackageRootWithClis(),
        runCli,
      });

      const result = await provider.listWorkItems(context);

      // A structurally invalid response must never coerce into
      // `available: true, items: []` — that would mask an upstream contract
      // break (e.g. a pull-work-provider CLI shape change) as a healthy,
      // simply-empty board.
      expect(result.available).toBe(false);
      expect(result.items).toEqual([]);
      expect(result.reason).toMatch(/invalid response shape/);
    },
  );

  test('reports unavailable when pull-work-provider exits non-zero (e.g. gh missing/unauthenticated)', async () => {
    const runCli = stubRunner({
      effective: {
        stdout: JSON.stringify(CONFIGURED_SETTINGS),
        stderr: '',
        exitCode: 0,
      },
      pull: { stdout: '', stderr: 'gh: command not found', exitCode: 1 },
    });
    const provider = new FlowAgentsWorkItemProvider({
      packageRoot: makePackageRootWithClis(),
      runCli,
    });

    const result = await provider.listWorkItems(context);
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/pull-work-provider failed/);
    expect(result.reason).toMatch(/gh: command not found/);
  });

  test('never throws out of listWorkItems on an unexpected runner exception', async () => {
    const provider = new FlowAgentsWorkItemProvider({
      packageRoot: makePackageRootWithClis(),
      runCli: async () => {
        throw new Error('unexpected spawn failure');
      },
    });
    const result = await provider.listWorkItems(context);
    expect(result.available).toBe(false);
    expect(result.reason).toBe('unexpected spawn failure');
  });
});
