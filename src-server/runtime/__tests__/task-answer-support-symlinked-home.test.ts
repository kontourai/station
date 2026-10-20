import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { TaskAnswerSupportUnavailableError } from '../../services/evidence/task-answer-support-module.js';
import { TaskGraphService } from '../../services/projects/task-graph-service.js';
import { createPersonalTaskAnswerSupportModule } from '../routes/runtime-routes.js';

// The Station home is canonicalized once in the composition root. Plugin-data
// lives inside it, so a symlink planted under the home must stay refused while
// a symlinked ANCESTOR of the home (macOS /tmp) must not.
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const bundle = {
  schemaVersion: 5,
  source: 'factory-test',
  claims: [
    {
      id: 'claim-a',
      subjectType: 'artifact',
      subjectId: 'repo:demo',
      claimType: 'quality.test',
      fieldOrBehavior: 'test',
      value: 'pass',
      status: 'verified',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ],
  evidence: [],
  policies: [],
  events: [],
};

function writeBundle(base: string) {
  const dir = join(base, 'plugin-data', 'demo', 'trust-bundles');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'basis.json'), JSON.stringify(bundle));
}

async function bundlesThrough(homeSpelling: string, realHome: string) {
  const projects = {
    getProject: vi.fn((slug: string) => ({ slug })),
  };
  const graph = new TaskGraphService(realHome, {
    projectService: projects as never,
  });
  const task = await graph.createTask({ projectId: 'project-a', title: 'b' });
  await graph.createTaskReference(task.id, {
    kind: 'turn',
    sessionId: 'session-a',
    turnId: 'turn-a',
  });
  const reference = graph.readTaskTurnReferenceLinks(task.id)![0];
  const module = createPersonalTaskAnswerSupportModule({
    taskGraphService: graph,
    projectService: projects,
    orchestrationService: {
      sessionQueries: {
        readAnswerBasis: async () => ({
          status: 'found',
          sessionId: 'session-a',
          turnId: 'turn-a',
          projectSlug: 'project-a',
          binding: {},
        }),
      },
    },
    configLoader: { getProjectHomeDir: () => homeSpelling },
    getLiveAppConfig: () => ({}),
  } as never);
  return module.bundles(task.id, reference.id, {} as never);
}

function aliasedHome() {
  const base = mkdtempSync(join(realpathSync(tmpdir()), 'station-symhome-'));
  roots.push(base);
  const real = join(base, 'real');
  mkdirSync(join(real, 'home'), { recursive: true });
  const alias = join(base, 'alias');
  symlinkSync(real, alias);
  return { base, realHome: join(real, 'home'), aliasHome: join(alias, 'home') };
}

test('a Station home reached through a symlinked ancestor still lists plugin-data bundles', async () => {
  const { realHome, aliasHome } = aliasedHome();
  writeBundle(join(realHome, 'projects', 'project-a'));

  const choices = await bundlesThrough(aliasHome, realHome);

  expect(choices).toHaveLength(1);
});

test('a symlink planted at <home>/projects/<slug> is refused, not followed', async () => {
  const { base, realHome } = aliasedHome();
  const elsewhere = join(base, 'elsewhere');
  writeBundle(elsewhere);
  mkdirSync(join(realHome, 'projects'));
  symlinkSync(elsewhere, join(realHome, 'projects', 'project-a'));

  await expect(bundlesThrough(realHome, realHome)).rejects.toBeInstanceOf(
    TaskAnswerSupportUnavailableError,
  );
});
