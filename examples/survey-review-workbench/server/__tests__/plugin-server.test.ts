/**
 * Unit tests for the Survey Review Workbench plugin server module:
 * per-project review-session persistence (Survey ReviewSessionEventStore
 * backing), optimistic concurrency, path safety, and trust-bundle projection.
 *
 * Persistence routes are dependency-free and always run. The example-session
 * and trust-bundle routes import `@kontourai/survey` from the plugin's own
 * node_modules, so those tests skip when the plugin's deps are not installed
 * (run `npm install` in examples/survey-review-workbench to enable them).
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error — plain ESM module without type declarations
import { register } from '../plugin.mjs';

const PROJECT = 'survey-proj';

let surveyAvailable = false;
try {
  await import('@kontourai/survey/review-workbench');
  surveyAvailable = true;
} catch {
  surveyAvailable = false;
}

interface Harness {
  app: Hono;
  projectHomeDir: string;
  workspaceDir: string;
}

function createHarness(options: { workingDirectory?: boolean } = {}): Harness {
  const projectHomeDir = mkdtempSync(join(tmpdir(), 'srw-home-'));
  const workspaceDir = mkdtempSync(join(tmpdir(), 'srw-workspace-'));
  const projectDir = join(projectHomeDir, 'projects', PROJECT);
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(
    join(projectDir, 'project.json'),
    JSON.stringify({
      id: 'p1',
      name: 'Survey Proj',
      slug: PROJECT,
      ...(options.workingDirectory === false
        ? {}
        : { workingDirectory: workspaceDir }),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  const app = new Hono();
  register(app, {
    config: { all: () => ({}), get: () => undefined },
    logger: { warn: () => {} },
    pluginName: 'survey-review-workbench',
    projectHomeDir,
    telemetry: { recordRoutingDecision: () => {} },
  });
  return { app, projectHomeDir, workspaceDir };
}

function jsonRequest(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

const snapshot = {
  items: [
    {
      apiVersion: 'survey.kontourai.io/v1alpha1',
      kind: 'ReviewItem',
      metadata: { name: 'item-1' },
      spec: { target: 'field', candidates: [] },
    },
  ],
  activeItemName: 'item-1',
  notesByItemName: {},
  decisionsByItemName: {},
  reviewedAt: '2026-06-12T00:00:00.000Z',
  actorId: 'reviewer',
};

interface ExampleSnapshotItem {
  metadata: { name: string };
  spec: { candidates: Array<{ id: string; role?: string }> };
}

/** Build a replay-valid decision event for an example-session item. */
function decisionEvent(
  item: ExampleSnapshotItem,
  decision: 'accept-proposed' | 'keep-current',
  sequence = 1,
) {
  const role = decision === 'accept-proposed' ? 'proposed' : 'current';
  const candidate = item.spec.candidates.find((c) => c.role === role);
  return {
    apiVersion: 'survey.kontourai.io/v1alpha1',
    kind: 'ReviewSessionEvent',
    metadata: { name: `demo-${sequence}-decision-changed` },
    spec: {
      sessionName: 'review-workbench-session',
      sequence,
      eventType: 'decision-changed',
      occurredAt: '2026-06-12T00:00:00.000Z',
      reviewItemName: item.metadata.name,
      candidateId: candidate?.id,
      status: 'verified',
      rationale: 'reviewed against the cited source excerpt',
      data: { workbenchDecision: decision },
    },
  };
}

function makeEvent(sequence: number, rationale: string) {
  return {
    apiVersion: 'survey.kontourai.io/v1alpha1',
    kind: 'ReviewSessionEvent',
    metadata: { name: `s-${sequence}-note-changed` },
    spec: {
      sessionName: 'review-workbench-session',
      sequence,
      eventType: 'note-changed',
      occurredAt: '2026-06-12T00:00:00.000Z',
      reviewItemName: 'item-1',
      rationale,
    },
  };
}

describe('survey-review-workbench server module', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();
  });

  afterEach(() => {
    rmSync(harness.projectHomeDir, { recursive: true, force: true });
    rmSync(harness.workspaceDir, { recursive: true, force: true });
  });

  it('rejects unknown projects with 404', async () => {
    const res = await harness.app.request('/projects/nope/review-sessions');
    expect(res.status).toBe(404);
  });

  it('rejects unsafe session names', async () => {
    const res = await harness.app.request(
      `/projects/${PROJECT}/review-sessions/a..b`,
      jsonRequest('PUT', { snapshot, events: [] }),
    );
    expect(res.status).toBe(400);
  });

  it('requires a snapshot on first save', async () => {
    const res = await harness.app.request(
      `/projects/${PROJECT}/review-sessions/s1`,
      jsonRequest('PUT', { events: [] }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('snapshot');
  });

  it('round-trips a session: save, load, list', async () => {
    const save = await harness.app.request(
      `/projects/${PROJECT}/review-sessions/s1`,
      jsonRequest('PUT', { snapshot, events: [makeEvent(1, 'first note')] }),
    );
    expect(save.status).toBe(200);
    expect((await save.json()).eventCount).toBe(1);

    const load = await harness.app.request(
      `/projects/${PROJECT}/review-sessions/s1`,
    );
    expect(load.status).toBe(200);
    const loaded = await load.json();
    expect(loaded.session.snapshot.activeItemName).toBe('item-1');
    expect(loaded.session.events).toHaveLength(1);
    expect(loaded.session.events[0].spec.rationale).toBe('first note');

    const list = await harness.app.request(
      `/projects/${PROJECT}/review-sessions`,
    );
    const listed = await list.json();
    expect(listed.sessions).toEqual([
      expect.objectContaining({ name: 's1', eventCount: 1 }),
    ]);
  });

  it('enforces optimistic concurrency via expectedEventCount', async () => {
    await harness.app.request(
      `/projects/${PROJECT}/review-sessions/s1`,
      jsonRequest('PUT', { snapshot, events: [makeEvent(1, 'first')] }),
    );

    // Stale writer believes the store is still empty.
    const conflict = await harness.app.request(
      `/projects/${PROJECT}/review-sessions/s1`,
      jsonRequest('PUT', {
        events: [makeEvent(1, 'stale')],
        expectedEventCount: 0,
      }),
    );
    expect(conflict.status).toBe(409);
    const conflictBody = await conflict.json();
    expect(conflictBody.eventCount).toBe(1);
    expect(conflictBody.events[0].spec.rationale).toBe('first');

    // Correct expectation appends fine.
    const append = await harness.app.request(
      `/projects/${PROJECT}/review-sessions/s1`,
      jsonRequest('PUT', {
        events: [makeEvent(1, 'first'), makeEvent(2, 'second')],
        expectedEventCount: 1,
      }),
    );
    expect(append.status).toBe(200);
    expect((await append.json()).eventCount).toBe(2);
  });

  describe.skipIf(!surveyAvailable)('with @kontourai/survey installed', () => {
    it('creates an example session from Survey example data', async () => {
      const res = await harness.app.request(
        `/projects/${PROJECT}/review-sessions`,
        jsonRequest('POST', { example: 'public-directory', name: 'demo-1' }),
      );
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.session.name).toBe('demo-1');
      expect(body.session.snapshot.items).toHaveLength(1);
      expect(body.session.events).toEqual([]);

      const dup = await harness.app.request(
        `/projects/${PROJECT}/review-sessions`,
        jsonRequest('POST', { example: 'public-directory', name: 'demo-1' }),
      );
      expect(dup.status).toBe(409);
    });

    it('refuses to project a session with no resolved items', async () => {
      await harness.app.request(
        `/projects/${PROJECT}/review-sessions`,
        jsonRequest('POST', { example: 'public-directory', name: 'demo-1' }),
      );
      const res = await harness.app.request(
        `/projects/${PROJECT}/trust-bundles`,
        jsonRequest('POST', { sessionName: 'demo-1' }),
      );
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toContain('not projectable');
    });

    it('projects a reviewed session to a trust bundle in the workspace', async () => {
      const created = await harness.app.request(
        `/projects/${PROJECT}/review-sessions`,
        jsonRequest('POST', { example: 'public-directory', name: 'demo-1' }),
      );
      const { session } = await created.json();
      const item = session.snapshot.items[0] as ExampleSnapshotItem;

      await harness.app.request(
        `/projects/${PROJECT}/review-sessions/demo-1`,
        jsonRequest('PUT', {
          events: [decisionEvent(item, 'accept-proposed')],
          expectedEventCount: 0,
        }),
      );

      const res = await harness.app.request(
        `/projects/${PROJECT}/trust-bundles`,
        jsonRequest('POST', { sessionName: 'demo-1' }),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.location).toBe('workspace');
      expect(body.claimCount).toBeGreaterThan(0);
      expect(body.summary.accepted).toBe(1);
      expect(body.path).toBe(
        join(
          harness.workspaceDir,
          '.station',
          'trust-bundles',
          'survey-demo-1.json',
        ),
      );
      expect(existsSync(body.path)).toBe(true);

      const bundle = JSON.parse(await readFile(body.path, 'utf-8'));
      expect(bundle.schemaVersion).toBeDefined();
      expect(Array.isArray(bundle.claims)).toBe(true);
      expect(bundle.claims.length).toBe(body.claimCount);
      expect(Array.isArray(bundle.evidence)).toBe(true);
    });

    it('falls back to station home when the project has no workspace', async () => {
      const local = createHarness({ workingDirectory: false });
      try {
        await local.app.request(
          `/projects/${PROJECT}/review-sessions`,
          jsonRequest('POST', { example: 'public-directory', name: 'demo-2' }),
        );
        const { session } = await (
          await local.app.request(`/projects/${PROJECT}/review-sessions/demo-2`)
        ).json();
        const item = session.snapshot.items[0] as ExampleSnapshotItem;
        await local.app.request(
          `/projects/${PROJECT}/review-sessions/demo-2`,
          jsonRequest('PUT', {
            events: [decisionEvent(item, 'keep-current')],
            expectedEventCount: 0,
          }),
        );
        const res = await local.app.request(
          `/projects/${PROJECT}/trust-bundles`,
          jsonRequest('POST', { sessionName: 'demo-2' }),
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.location).toBe('station-home');
        expect(body.path).toContain(
          join('plugin-data', 'survey-review-workbench', 'trust-bundles'),
        );
        expect(existsSync(body.path)).toBe(true);
      } finally {
        rmSync(local.projectHomeDir, { recursive: true, force: true });
        rmSync(local.workspaceDir, { recursive: true, force: true });
      }
    });
  });
});
