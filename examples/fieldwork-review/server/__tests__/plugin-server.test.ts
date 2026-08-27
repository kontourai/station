import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error Plain ESM plugin module without declarations.
import { close, register, reviewedSources } from '../plugin.mjs';

const PROJECT = 'fieldwork-project';
const TASK = {
  apiVersion: 'fieldwork.kontourai.io/v1alpha1',
  kind: 'FieldworkTask',
  metadata: { name: 'station-fieldwork-test' },
  spec: {
    traverse: {
      version: '1',
      targetSchema: [
        { path: 'record.status', type: 'string', inferenceType: 'explicit' },
      ],
    },
    projections: [
      {
        fieldPath: 'record.status',
        pattern: 'Status: ([^\\n]+)',
        claim: {
          subjectType: 'record',
          subjectId: 'station-fieldwork-test',
          facet: 'review',
          claimType: 'field',
          impactLevel: 'medium',
        },
      },
    ],
  },
};

interface Harness {
  app: Hono;
  projectHomeDir: string;
  telemetry: Array<Record<string, string | number | boolean>>;
  warnings: string[];
  workspaceDir: string;
}

let harness: Harness;

function createHarness(): Harness {
  const projectHomeDir = mkdtempSync(join(tmpdir(), 'fieldwork-station-home-'));
  const workspaceDir = mkdtempSync(
    join(tmpdir(), 'fieldwork-station-workspace-'),
  );
  const projectDir = join(projectHomeDir, 'projects', PROJECT);
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(
    join(projectDir, 'project.json'),
    JSON.stringify({
      id: 'project-1',
      name: 'Fieldwork project',
      slug: PROJECT,
      workingDirectory: workspaceDir,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(join(workspaceDir, 'task.json'), JSON.stringify(TASK));
  writeFileSync(join(workspaceDir, 'source.txt'), 'Status: Active\n');

  const telemetry: Array<Record<string, string | number | boolean>> = [];
  const warnings: string[] = [];
  const app = new Hono();
  register(app, {
    config: { all: () => ({}), get: () => undefined },
    logger: { warn: (message: string) => warnings.push(message) },
    pluginName: 'fieldwork-review',
    projectHomeDir,
    telemetry: {
      recordRoutingDecision: (
        attributes: Record<string, string | number | boolean>,
      ) => telemetry.push(attributes),
    },
  });
  return { app, projectHomeDir, telemetry, warnings, workspaceDir };
}

function request(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

async function launchRun(taskPath = 'task.json', sourcePath = 'source.txt') {
  const response = await harness.app.request(
    `/projects/${PROJECT}/runs`,
    request({ taskPath, sourcePath }),
  );
  expect(response.status).toBe(201);
  return (await response.json()) as {
    run: { id: string; proposalCount: number; open: boolean };
  };
}

beforeEach(() => {
  harness = createHarness();
});

afterEach(async () => {
  vi.useRealTimers();
  await close();
  rmSync(harness.projectHomeDir, { recursive: true, force: true });
  rmSync(harness.workspaceDir, { recursive: true, force: true });
});

describe('fieldwork-review server module', () => {
  it('resolves a reviewed-source read without creating owner storage', async () => {
    const result = await reviewedSources.readReviewedSource(
      {
        version: 'station.reviewed-sources/v1',
        operation: 'currentness',
        pluginName: 'fieldwork-review',
        projectId: PROJECT,
        exactRef: `fieldwork-reviewed-source:v1:${'a'.repeat(64)}`,
        assessment: {
          revision: 1,
          sourceClaimId: 'source-claim',
          sourceEvidenceId: 'source-evidence',
          answerClaimId: 'answer-claim',
          answerCitationEvidenceId: 'answer-citation-evidence',
        },
      },
      { projectHomeDir: harness.projectHomeDir },
    );

    expect(result).toEqual({
      version: 'station.reviewed-sources/v1',
      status: 'missing',
    });
    expect(
      existsSync(
        join(
          harness.projectHomeDir,
          'projects',
          PROJECT,
          'plugin-data',
          'fieldwork-review',
          'runs',
        ),
      ),
    ).toBe(false);
  });

  it('rejects an unknown project', async () => {
    const response = await harness.app.request('/projects/missing/runs');
    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe('Project not found');
  });

  it('rejects absolute paths and traversal before Fieldwork runs', async () => {
    const absolute = await harness.app.request(
      `/projects/${PROJECT}/runs`,
      request({
        taskPath: join(harness.workspaceDir, 'task.json'),
        sourcePath: 'source.txt',
      }),
    );
    expect(absolute.status).toBe(400);

    const traversal = await harness.app.request(
      `/projects/${PROJECT}/runs`,
      request({ taskPath: '../task.json', sourcePath: 'source.txt' }),
    );
    expect(traversal.status).toBe(400);
  });

  it('rejects a source symlink whose real path escapes the project workspace', async () => {
    const outside = join(tmpdir(), `fieldwork-escape-${Date.now()}.txt`);
    writeFileSync(outside, 'Status: Escaped\n');
    try {
      symlinkSync(outside, join(harness.workspaceDir, 'escape.txt'));
      const response = await harness.app.request(
        `/projects/${PROJECT}/runs`,
        request({ taskPath: 'task.json', sourcePath: 'escape.txt' }),
      );
      expect(response.status).toBe(400);
      expect((await response.json()).error).toContain('Source');
    } finally {
      rmSync(outside, { force: true });
    }
  });

  it('rejects symlinked run storage before writing outside project plugin data', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'fieldwork-storage-escape-'));
    const projectDir = join(harness.projectHomeDir, 'projects', PROJECT);
    try {
      symlinkSync(outside, join(projectDir, 'plugin-data'));
      const response = await harness.app.request(
        `/projects/${PROJECT}/runs`,
        request({ taskPath: 'task.json', sourcePath: 'source.txt' }),
      );
      expect(response.status).toBe(409);
      expect((await response.json()).error).toContain('storage');
      expect(existsSync(join(outside, 'fieldwork-review'))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('rejects a symlinked project directory before writing outside the projects root', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'fieldwork-project-escape-'));
    const projectDir = join(harness.projectHomeDir, 'projects', PROJECT);
    try {
      writeFileSync(
        join(outside, 'project.json'),
        JSON.stringify({
          slug: PROJECT,
          workingDirectory: harness.workspaceDir,
        }),
      );
      rmSync(projectDir, { recursive: true, force: true });
      symlinkSync(outside, projectDir, 'dir');
      const response = await harness.app.request(
        `/projects/${PROJECT}/runs`,
        request({ taskPath: 'task.json', sourcePath: 'source.txt' }),
      );
      expect(response.status).toBe(409);
      expect((await response.json()).error).toContain('storage');
      expect(existsSync(join(outside, 'plugin-data'))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('handles concurrent first access to owned storage', async () => {
    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        harness.app.request(`/projects/${PROJECT}/runs`),
      ),
    );
    expect(responses.every((response) => response.status === 200)).toBe(true);
  });

  it('fails closed without replacing a corrupt existing run index', async () => {
    await launchRun();
    const indexFile = join(
      harness.projectHomeDir,
      'projects',
      PROJECT,
      'plugin-data',
      'fieldwork-review',
      'runs',
      'station-runs.json',
    );
    writeFileSync(indexFile, '{"version":1,"runs":"corrupt"}');

    const listed = await harness.app.request(`/projects/${PROJECT}/runs`);
    expect(listed.status).toBe(409);
    const launched = await harness.app.request(
      `/projects/${PROJECT}/runs`,
      request({ taskPath: 'task.json', sourcePath: 'source.txt' }),
    );
    expect(launched.status).toBe(409);
    expect(readFileSync(indexFile, 'utf8')).toBe(
      '{"version":1,"runs":"corrupt"}',
    );
  });

  it('resolves a retained ref through the producer index after 130 historical runs', async () => {
    await launchRun();
    const runsRoot = join(
      harness.projectHomeDir,
      'projects',
      PROJECT,
      'plugin-data',
      'fieldwork-review',
      'runs',
    );
    const current = JSON.parse(
      readFileSync(join(runsRoot, 'station-runs.json'), 'utf8'),
    ).runs[0];
    const refs = Object.fromEntries(
      Array.from({ length: 130 }, (_, index) => [
        `fieldwork-reviewed-source:v1:${index.toString(16).padStart(64, '0')}`,
        { runId: current.id, runDirectory: current.runDirectory },
      ]),
    );
    writeFileSync(
      join(runsRoot, 'station-reviewed-source-refs.json'),
      JSON.stringify({ version: 1, refs }),
    );

    const result = await reviewedSources.readReviewedSource(
      {
        version: 'station.reviewed-sources/v1',
        operation: 'describe',
        pluginName: 'fieldwork-review',
        projectId: PROJECT,
        exactRef: `fieldwork-reviewed-source:v1:${'0'.repeat(63)}0`,
        assessment: {
          revision: 1,
          sourceClaimId: 'source-claim',
          sourceEvidenceId: 'source-evidence',
          answerClaimId: 'answer-claim',
          answerCitationEvidenceId: 'answer-citation-evidence',
        },
      },
      { projectHomeDir: harness.projectHomeDir },
    );
    // Fieldwork is reached (and truthfully says this opaque test ref is not a
    // reviewed source); the historical cardinality never becomes unavailable.
    expect(result).toEqual({
      version: 'station.reviewed-sources/v1',
      status: 'missing',
    });
  });

  it('does not scan the run list or convert cap-plus-one history into unavailable', async () => {
    await launchRun();
    const runsRoot = join(
      harness.projectHomeDir,
      'projects',
      PROJECT,
      'plugin-data',
      'fieldwork-review',
      'runs',
    );
    const current = JSON.parse(
      readFileSync(join(runsRoot, 'station-runs.json'), 'utf8'),
    ).runs[0];
    const exactRef = `fieldwork-reviewed-source:v1:${'f'.repeat(64)}`;
    writeFileSync(
      join(runsRoot, 'station-reviewed-source-refs.json'),
      JSON.stringify({
        version: 1,
        refs: {
          [exactRef]: { runId: current.id, runDirectory: current.runDirectory },
        },
      }),
    );
    // If resolution still walked station-runs.json, this deliberately corrupt
    // cap-plus-one list would return unavailable before calling Fieldwork.
    writeFileSync(
      join(runsRoot, 'station-runs.json'),
      JSON.stringify({
        version: 1,
        runs: Array.from({ length: 4097 }, () => current),
      }),
    );

    const result = await reviewedSources.readReviewedSource(
      {
        version: 'station.reviewed-sources/v1',
        operation: 'describe',
        pluginName: 'fieldwork-review',
        projectId: PROJECT,
        exactRef,
        assessment: {
          revision: 1,
          sourceClaimId: 'source-claim',
          sourceEvidenceId: 'source-evidence',
          answerClaimId: 'answer-claim',
          answerCitationEvidenceId: 'answer-citation-evidence',
        },
      },
      { projectHomeDir: harness.projectHomeDir },
    );
    expect(result).toEqual({
      version: 'station.reviewed-sources/v1',
      status: 'missing',
    });
  });

  it('keeps retained refs resolvable at 10,000 and marks cap-plus-one as unavailable, never missing', async () => {
    await launchRun();
    const runsRoot = join(
      harness.projectHomeDir,
      'projects',
      PROJECT,
      'plugin-data',
      'fieldwork-review',
      'runs',
    );
    const current = JSON.parse(
      readFileSync(join(runsRoot, 'station-runs.json'), 'utf8'),
    ).runs[0];
    const refs = Object.fromEntries(
      Array.from({ length: 10_000 }, (_, index) => [
        `fieldwork-reviewed-source:v1:${index.toString(16).padStart(64, '0')}`,
        { runId: current.id, runDirectory: current.runDirectory },
      ]),
    );
    writeFileSync(
      join(runsRoot, 'station-reviewed-source-refs.json'),
      JSON.stringify({ version: 1, refs }),
    );
    const input = (exactRef: string) => ({
      version: 'station.reviewed-sources/v1' as const,
      operation: 'describe' as const,
      pluginName: 'fieldwork-review',
      projectId: PROJECT,
      exactRef,
      assessment: {
        revision: 1,
        sourceClaimId: 'source-claim',
        sourceEvidenceId: 'source-evidence',
        answerClaimId: 'answer-claim',
        answerCitationEvidenceId: 'answer-citation-evidence',
      },
    });
    const retained = await reviewedSources.readReviewedSource(
      input(`fieldwork-reviewed-source:v1:${'0'.repeat(64)}`),
      { projectHomeDir: harness.projectHomeDir },
    );
    expect(retained.status).toBe('missing');
    const refused = await reviewedSources.readReviewedSource(
      input(`fieldwork-reviewed-source:v1:${'f'.repeat(64)}`),
      { projectHomeDir: harness.projectHomeDir },
    );
    expect(refused).toEqual({
      version: 'station.reviewed-sources/v1',
      status: 'unavailable',
    });
  });

  it('rejects an oversized request before parsing it', async () => {
    const response = await harness.app.request(
      `/projects/${PROJECT}/runs`,
      request({ taskPath: 'task.json', sourcePath: 'x'.repeat(9000) }),
    );
    expect(response.status).toBe(413);
    expect((await response.json()).error).toContain('too large');
  });

  it('keeps run artifacts in the selected project plugin-data directory and returns only a summary', async () => {
    const launched = await launchRun();
    expect(launched.run.proposalCount).toBe(1);
    expect(launched.run).not.toHaveProperty('runDirectory');
    expect(launched.run).not.toHaveProperty('runResource');

    const runsRoot = join(
      harness.projectHomeDir,
      'projects',
      PROJECT,
      'plugin-data',
      'fieldwork-review',
      'runs',
    );
    const index = JSON.parse(
      readFileSync(join(runsRoot, 'station-runs.json'), 'utf8'),
    );
    expect(index.runs).toHaveLength(1);
    expect(
      relative(realpathSync(runsRoot), index.runs[0].runDirectory).startsWith(
        '..',
      ),
    ).toBe(false);
    expect(existsSync(index.runs[0].runDirectory)).toBe(true);

    const listed = await harness.app.request(`/projects/${PROJECT}/runs`);
    expect(listed.status).toBe(200);
    expect((await listed.json()).runs).toEqual([
      expect.objectContaining({
        id: launched.run.id,
        proposalCount: 1,
        open: false,
      }),
    ]);
  });

  it('opens, checks reviewed-output availability, and closes through the Fieldwork facade', async () => {
    const launched = await launchRun();
    const missingOrigin = await harness.app.request(
      `/projects/${PROJECT}/runs/${launched.run.id}/open`,
      { method: 'POST' },
    );
    expect(missingOrigin.status).toBe(400);

    const opened = await harness.app.request(
      `/projects/${PROJECT}/runs/${launched.run.id}/open`,
      {
        method: 'POST',
        headers: { Origin: 'http://station.example.test' },
      },
    );
    expect(opened.status).toBe(200);
    const openBody = await opened.json();
    expect(openBody.review.url).toMatch(/^http:\/\/127\.0\.0\.1:/);
    expect(openBody.review.url).toContain('#cap=');
    expect(openBody.review).not.toHaveProperty('capabilityToken');

    const output = await harness.app.request(
      `/projects/${PROJECT}/runs/${launched.run.id}/reviewed-output`,
    );
    expect(output.status).toBe(200);
    expect(await output.json()).toEqual({ success: true, available: false });

    const closed = await harness.app.request(
      `/projects/${PROJECT}/runs/${launched.run.id}/close`,
      { method: 'POST' },
    );
    expect(closed.status).toBe(200);
    expect((await closed.json()).run.open).toBe(false);
  });

  it('persists open false when the host disposes an active review', async () => {
    const launched = await launchRun();
    const opened = await harness.app.request(
      `/projects/${PROJECT}/runs/${launched.run.id}/open`,
      {
        method: 'POST',
        headers: { Origin: 'http://station.example.test' },
      },
    );
    expect(opened.status).toBe(200);

    await close();

    const index = JSON.parse(
      readFileSync(
        join(
          harness.projectHomeDir,
          'projects',
          PROJECT,
          'plugin-data',
          'fieldwork-review',
          'runs',
          'station-runs.json',
        ),
        'utf8',
      ),
    );
    expect(index.runs[0].open).toBe(false);
  });

  it('returns 404 when closing a well-formed unknown run', async () => {
    const response = await harness.app.request(
      `/projects/${PROJECT}/runs/fw_000000000000000000000000/close`,
      { method: 'POST' },
    );
    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe('Fieldwork run not found');
  });

  it('retries a failed idle close and persists the closed state', async () => {
    vi.useFakeTimers();
    const launched = await launchRun();
    const opened = await harness.app.request(
      `/projects/${PROJECT}/runs/${launched.run.id}/open`,
      {
        method: 'POST',
        headers: { Origin: 'http://station.example.test' },
      },
    );
    expect(opened.status).toBe(200);

    const indexFile = join(
      harness.projectHomeDir,
      'projects',
      PROJECT,
      'plugin-data',
      'fieldwork-review',
      'runs',
      'station-runs.json',
    );
    const originalIndex = readFileSync(indexFile, 'utf8');
    rmSync(indexFile, { force: true });
    mkdirSync(indexFile);

    try {
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
      await vi.waitFor(() =>
        expect(harness.warnings).toContain(
          'Fieldwork idle close failed; retrying',
        ),
      );
    } finally {
      rmSync(indexFile, { recursive: true, force: true });
      writeFileSync(indexFile, originalIndex);
    }
    await vi.advanceTimersByTimeAsync(30 * 1000);

    await vi.waitFor(() => {
      const index = JSON.parse(readFileSync(indexFile, 'utf8'));
      expect(index.runs[0].open).toBe(false);
    });
  });

  it('bounds concurrent review services per project', async () => {
    const taskPaths = Array.from({ length: 5 }, (_, index) => {
      const taskPath = `task-${index}.json`;
      writeFileSync(
        join(harness.workspaceDir, taskPath),
        JSON.stringify({
          ...TASK,
          metadata: { name: `station-fieldwork-test-${index}` },
        }),
      );
      return taskPath;
    });
    const runs = await Promise.all(
      taskPaths.map(async (taskPath) => (await launchRun(taskPath)).run),
    );
    expect(new Set(runs.map((run) => run.id)).size).toBe(5);
    for (const run of runs.slice(0, 4)) {
      const opened = await harness.app.request(
        `/projects/${PROJECT}/runs/${run.id}/open`,
        {
          method: 'POST',
          headers: { Origin: 'http://station.example.test' },
        },
      );
      expect(opened.status).toBe(200);
    }
    const rejected = await harness.app.request(
      `/projects/${PROJECT}/runs/${runs[4].id}/open`,
      {
        method: 'POST',
        headers: { Origin: 'http://station.example.test' },
      },
    );
    expect(rejected.status).toBe(429);
  });

  it('records bounded, content-free lifecycle telemetry', async () => {
    await launchRun();
    expect(harness.telemetry).toContainEqual(
      expect.objectContaining({
        domain: 'fieldwork',
        eventType: 'run-created',
        eventCount: expect.any(Number),
        eventSequence: expect.any(Number),
        revision: expect.any(Number),
      }),
    );
    const serialized = JSON.stringify(harness.telemetry);
    expect(serialized).not.toContain('Status: Active');
    expect(serialized).not.toContain('task.json');
    expect(serialized).not.toContain('fieldwork-run:v1');
  });

  it('uses only the published Fieldwork application facade', () => {
    const source = readFileSync(
      new URL('../plugin.mjs', import.meta.url),
      'utf8',
    );
    expect(source).toContain("import('@kontourai/fieldwork')");
    expect(source).toContain('createFieldworkApplication');
    expect(source).not.toMatch(
      /@kontourai\/(?:traverse|survey|relay|dispatch)/u,
    );
  });
});
