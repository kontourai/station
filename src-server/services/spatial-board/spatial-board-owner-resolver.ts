import { resolve } from 'node:path';
import type { WorkReference } from '@kontourai/station-contracts';
import type { RunSummary } from '@kontourai/station-contracts/runs';
import type { SessionReadAuthority } from '@kontourai/station-contracts/tenancy';
import { expandTilde } from '../../utils/paths.js';
import {
  type SpatialBoardOwnerProjection,
  SpatialBoardResolver,
} from './spatial-board-resolver.js';

type Project = { id: string; name: string; workingDirectory?: string };
type Task = { id: string; projectId: string; title: string };
type Session = { threadId: string; displayTitle?: string };
type FlowRun = { run_id: string; subject: string };
type Agent = { slug: string; name: string };

export interface SpatialBoardOwnerResolverDeps {
  projects: { listProjects(): readonly Project[] };
  tasks: { listTasks(): readonly Task[] };
  sessions: {
    listSessionReadModel(
      authority: SessionReadAuthority,
    ): Promise<readonly Session[]>;
  };
  sessionAuthority: SessionReadAuthority;
  approvals: { has(id: string): boolean };
  /** Exact receipt reads: no index repair, lock acquisition, or publication. */
  reviews: { read(id: string, projectSlug: string): Promise<unknown | null> };
  flow: { listRuns(workspace: string): Promise<readonly FlowRun[]> };
  /** Canonical all-source RunService authority, shared by receipt/artifact. */
  runs: {
    listRuns(
      authority: SessionReadAuthority,
      filters?: { source?: 'schedule' },
    ): Promise<readonly RunSummary[]>;
  };
  agents: { listAgents(): Promise<readonly Agent[]> };
}

const kind = <K extends WorkReference['kind']>(
  references: readonly WorkReference[],
  target: K,
): Extract<WorkReference, { kind: K }>[] =>
  references.filter(
    (reference): reference is Extract<WorkReference, { kind: K }> =>
      reference.kind === target,
  );

/**
 * Concrete owner adapters at the Station composition seam. Each adapter sees
 * only the board's already-persisted references; owner inventories are shared
 * once per resolution request and no adapter becomes a discovery API.
 */
export function createSpatialBoardOwnerResolver(
  deps: SpatialBoardOwnerResolverDeps,
): SpatialBoardResolver {
  return new SpatialBoardResolver(() => {
    // This snapshot and promise live for ONE GET /resolved observation. They
    // make owner groups agree within the request without caching a rejected or
    // fulfilled inventory across the next read.
    let projects: Promise<ReadonlyMap<string, Project>> | undefined;
    const readProjects = () =>
      (projects ??= Promise.resolve().then(
        () =>
          new Map(
            deps.projects
              .listProjects()
              .map((project) => [project.id, project]),
          ),
      ));
    let allRuns: Promise<readonly RunSummary[]> | undefined;
    const readAllRuns = () =>
      (allRuns ??= deps.runs.listRuns(deps.sessionAuthority));
    return {
      project: {
        resolve: async (references) => {
          const projects = await readProjects();
          return kind(references, 'project').map((reference) => {
            const project = projects.get(reference.id);
            return project
              ? { reference, state: 'current', title: project.name }
              : { reference, state: 'missing' };
          });
        },
      },
      task: {
        resolve: async (references) => {
          const tasks = new Map(
            deps.tasks.listTasks().map((task) => [task.id, task]),
          );
          return kind(references, 'task').map((reference) => {
            const task = tasks.get(reference.id);
            if (!task) return { reference, state: 'missing' };
            return task.projectId === reference.projectId
              ? { reference, state: 'current', title: task.title }
              : { reference, state: 'stale' };
          });
        },
      },
      session: {
        resolve: async (references) => {
          const sessions = new Map(
            (
              await deps.sessions.listSessionReadModel(deps.sessionAuthority)
            ).map((session) => [session.threadId, session]),
          );
          return kind(references, 'session').map((reference) => {
            const session = sessions.get(reference.id);
            return session
              ? {
                  reference,
                  state: 'current',
                  ...(session.displayTitle
                    ? { title: session.displayTitle }
                    : {}),
                }
              : { reference, state: 'missing' };
          });
        },
      },
      approval: {
        resolve: async (references) =>
          kind(references, 'approval').map((reference) =>
            deps.approvals.has(reference.id)
              ? { reference, state: 'current' }
              : { reference, state: 'missing' },
          ),
      },
      receipt: {
        resolve: async (references) => {
          const receipts = kind(references, 'receipt');
          const scheduler = receipts.filter(
            (
              reference,
            ): reference is Extract<
              WorkReference,
              { kind: 'receipt'; owner: 'scheduler-run' }
            > => reference.owner === 'scheduler-run',
          );
          const reviews = receipts.filter(
            (
              reference,
            ): reference is Extract<
              WorkReference,
              { kind: 'receipt'; owner: 'independent-review' }
            > => reference.owner === 'independent-review',
          );
          const [schedulerResult, reviewResults] = await Promise.all([
            scheduler.length
              ? readAllRuns().then(
                  (runs) => ({
                    runs: runs.filter((run) => run.source === 'schedule'),
                  }),
                  () => ({ unavailable: true as const }),
                )
              : Promise.resolve({ runs: [] as readonly RunSummary[] }),
            Promise.all(
              reviews.map(async (reference) => {
                try {
                  return {
                    reference,
                    receipt: await deps.reviews.read(
                      reference.id,
                      reference.projectSlug,
                    ),
                  };
                } catch {
                  return { reference, unavailable: true as const };
                }
              }),
            ),
          ]);
          const schedulerProjections: SpatialBoardOwnerProjection[] =
            scheduler.map((reference) =>
              'unavailable' in schedulerResult
                ? { reference, state: 'unavailable' }
                : schedulerResult.runs.some((run) => run.runId === reference.id)
                  ? { reference, state: 'current' }
                  : { reference, state: 'missing' },
            );
          return [
            ...schedulerProjections,
            ...reviewResults.map((result) =>
              'unavailable' in result
                ? { reference: result.reference, state: 'unavailable' as const }
                : result.receipt
                  ? { reference: result.reference, state: 'current' as const }
                  : { reference: result.reference, state: 'missing' as const },
            ),
          ];
        },
      },
      run: {
        resolve: async (references) => {
          const flowRefs = kind(references, 'run');
          const projects = await readProjects();
          const runsByProject = new Map(
            await Promise.all(
              [
                ...new Set(flowRefs.map((reference) => reference.projectId)),
              ].map(async (projectId) => {
                // A stored workingDirectory holds `~/...` verbatim, and Flow
                // resolves a run directory relative to the cwd it is handed —
                // so the raw value lists runs from a directory literally named
                // `~` and reports the project as having none (station#3155).
                const stored = projects.get(projectId)?.workingDirectory;
                const workspace = stored
                  ? resolve(expandTilde(stored))
                  : undefined;
                try {
                  return [
                    projectId,
                    workspace ? await deps.flow.listRuns(workspace) : undefined,
                  ] as const;
                } catch {
                  return [projectId, null] as const;
                }
              }),
            ),
          );
          return flowRefs.map((reference) => {
            const runs = runsByProject.get(reference.projectId);
            if (runs === null) return { reference, state: 'unavailable' };
            const run = runs?.find(
              (candidate) => candidate.run_id === reference.id,
            );
            if (!run) return { reference, state: 'missing' };
            return reference.gateId
              ? { reference, state: 'NOT_VERIFIED' }
              : { reference, state: 'current', title: run.subject };
          });
        },
      },
      artifact: {
        resolve: async (references) => {
          const artifacts = kind(references, 'artifact');
          try {
            const runs = await readAllRuns();
            return artifacts.map((reference) =>
              runs.some(
                (run) =>
                  run.runId === reference.runId &&
                  run.outputRef?.artifactId === reference.id,
              )
                ? { reference, state: 'current' }
                : { reference, state: 'missing' },
            );
          } catch {
            return artifacts.map((reference) => ({
              reference,
              state: 'unavailable' as const,
            }));
          }
        },
      },
      agent: {
        resolve: async (references) => {
          const agents = new Map(
            (await deps.agents.listAgents()).map((agent) => [
              agent.slug,
              agent,
            ]),
          );
          return kind(references, 'agent').map((reference) => {
            const agent = agents.get(reference.id);
            return agent
              ? { reference, state: 'current', title: agent.name }
              : { reference, state: 'missing' };
          });
        },
      },
    };
  });
}
