import { lstatSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { AgentSpec } from '@kontourai/station-contracts/agent';
import { isCanonicalPluginId } from '@kontourai/station-contracts/plugin';
import { agentAvailableInProject } from '@kontourai/station-contracts/project-reference-integrity';
import type { WorkspacePaneHostAgentRef } from '@kontourai/station-contracts/workspace-pane-host-contribution';
import { capturePluginAgentInvocation } from '../../domain/config-loader-agents.js';
import { readRegularFileNoFollow } from '../../domain/home-schema-gate.js';
import type { IStorageAdapter } from '../../domain/storage-adapter.js';
import { assertSafeContextText } from '../orchestration/context-safety.js';
import {
  type ForegroundInvocationAdmission,
  ForegroundInvocationUnavailableError,
} from '../orchestration/foreground-invocation-admission.js';
import type { PackageMcpAdmissionJournal } from './package-mcp-admission.js';
import { scanPluginPromptGeneration } from './plugin-command-skill-source.js';
import {
  computePluginContentDigest,
  withPluginContentLock,
} from './plugin-content-integrity.js';
import { resolveInstalledPluginRoot } from './plugin-incarnation.js';
import { captureLocalPluginInstallation } from './plugin-installation-local.js';
import { parsePluginManifestDocumentWithFormat } from './plugin-manifest-loader.js';
import type { CapturedPluginPermissionArtifact } from './plugin-permissions.js';

/** Read the selected immutable artifact through its installation owner. */
export function captureWorkspacePaneHostPackage(
  projectHomeDir: string,
  pluginId: string,
  journal?: PackageMcpAdmissionJournal,
) {
  const pluginsDir = join(projectHomeDir, 'plugins');
  const captured = journal
    ? captureLocalPluginInstallation(pluginsDir, journal, pluginId)
    : (() => {
        const root = resolveInstalledPluginRoot(pluginsDir, pluginId);
        // Legacy compatibility only: retained installations require journal authority.
        if (!root || root.kind !== 'legacy') return null;
        return {
          root,
          installation: null,
          isCurrent: () =>
            resolveInstalledPluginRoot(pluginsDir, pluginId)?.packageRoot ===
            root.packageRoot,
        };
      })();
  if (!captured || !captured.isCurrent())
    throw new ForegroundInvocationUnavailableError();
  const pluginDir = captured.root.packageRoot;
  const manifestPath = join(pluginDir, 'plugin.json');
  const stat = lstatSync(manifestPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024)
    throw new ForegroundInvocationUnavailableError();
  const parsed = parsePluginManifestDocumentWithFormat(
    readRegularFileNoFollow(projectHomeDir, manifestPath, {
      maxBytes: 256 * 1024,
    }),
    manifestPath,
  );
  if (parsed.stationExtension?.status === 'disabled')
    throw new ForegroundInvocationUnavailableError();
  const manifest = parsed.manifest;
  const digest = computePluginContentDigest(
    dirname(pluginDir),
    basename(pluginDir),
  );
  if (
    !digest ||
    manifest.name !== pluginId ||
    (captured.installation && captured.installation.contentDigest !== digest)
  )
    throw new ForegroundInvocationUnavailableError();
  return Object.freeze({
    pluginId,
    pluginDir,
    manifest,
    digest,
    generation: captured.installation?.incarnation ?? digest,
    isCurrent() {
      try {
        return (
          captured.isCurrent() &&
          computePluginContentDigest(
            dirname(pluginDir),
            basename(pluginDir),
          ) === digest
        );
      } catch {
        return false;
      }
    },
  });
}

/**
 * Local server-owned prerequisite, not an API or a UI registration. The caller
 * supplies identities only; authored Agent/Project/body data comes from the
 * installed record and existing storage owners. A prepared action is one-shot.
 */
export function createWorkspacePaneHostAdmission(input: {
  projectHomeDir: string;
  journal?: PackageMcpAdmissionJournal;
  projects: Pick<IStorageAdapter, 'projectRevision'>;
  nativeAgentAvailable?(agentId: string, spec: AgentSpec): boolean;
  /** Production grant gate wraps the short final Project/Agent admission. */
  withInvocationPermission?<T>(
    pluginId: string,
    invoke: () => Promise<T>,
    artifact: CapturedPluginPermissionArtifact,
  ): Promise<T>;
}) {
  const projectHomeDir = input.projectHomeDir;
  const projectRevisionFor = input.projects.projectRevision.bind(
    input.projects,
  );
  const pluginsDir = join(projectHomeDir, 'plugins');
  return Object.freeze({
    async prepare(request: {
      pluginId: string;
      projectSlug: string;
      actionId: string;
      installationGeneration?: string;
      selectedAgent?: WorkspacePaneHostAgentRef;
    }) {
      const { pluginId, projectSlug, actionId } = request;
      if (!isCanonicalPluginId(pluginId))
        throw new ForegroundInvocationUnavailableError();
      return withPluginContentLock(pluginsDir, pluginId, async () => {
        const source = captureWorkspacePaneHostPackage(
          projectHomeDir,
          pluginId,
          input.journal,
        );
        const { pluginDir, manifest, generation } = source;
        const contribution = manifest.workspacePaneHost;
        const action = contribution?.actions.find(
          (candidate) => candidate.id === actionId,
        );
        const selected = request.selectedAgent;
        const sameAgent = (
          left: WorkspacePaneHostAgentRef,
          right: WorkspacePaneHostAgentRef,
        ) => left.kind === right.kind && left.agentId === right.agentId;
        if (
          selected &&
          (!contribution?.agentSelection.availableAgents.some((candidate) =>
            sameAgent(candidate, selected),
          ) ||
            (action?.intent.agent && !sameAgent(action.intent.agent, selected)))
        )
          throw new ForegroundInvocationUnavailableError();
        const agent =
          action?.intent.agent ??
          selected ??
          contribution?.agentSelection.defaultAgent;
        if (
          manifest.name !== pluginId ||
          (request.installationGeneration !== undefined &&
            request.installationGeneration !== generation) ||
          !action ||
          !agent ||
          agent.kind !== 'own-plugin-agent' ||
          !manifest.agents?.some(
            (candidate) => candidate.slug === agent.agentId,
          )
        )
          throw new ForegroundInvocationUnavailableError();
        const projectRevision = projectRevisionFor(projectSlug);
        if (!projectRevision.withCurrentRead)
          throw new ForegroundInvocationUnavailableError();
        const withCurrentProject =
          projectRevision.withCurrentRead.bind(projectRevision);
        const project = structuredClone(projectRevision.value);
        if (project.slug !== projectSlug)
          throw new ForegroundInvocationUnavailableError();
        const agentSnapshot = await capturePluginAgentInvocation(
          projectHomeDir,
          agent.agentId,
          pluginId,
        );
        const agentSpec = agentSnapshot.read();
        if (
          (!agentSpec.execution?.agentConnectionId &&
            !input.nativeAgentAvailable?.(agent.agentId, agentSpec)) ||
          !agentAvailableInProject(projectSlug, project.agents, {
            slug: agent.agentId,
            project: agentSpec.project,
          })
        ) {
          // Native mode requires the production captured-runtime bridge.
          throw new ForegroundInvocationUnavailableError();
        }
        let message: string;
        if (action.intent.kind === 'prompt') message = action.intent.prompt;
        else {
          const exact = scanPluginPromptGeneration(
            pluginDir,
            pluginId,
            {
              maxFiles: 32,
              maxFileBytes: 64 * 1024,
            },
            manifest,
          ).filter(
            (prompt) =>
              prompt.id ===
              `${pluginId}:${action.intent.kind === 'plugin-prompt' ? action.intent.promptId : ''}`,
          );
          if (exact.length !== 1)
            throw new ForegroundInvocationUnavailableError();
          message = exact[0]!.content;
        }
        if (!message || Buffer.byteLength(message, 'utf8') > 8 * 1024)
          throw new ForegroundInvocationUnavailableError();
        assertSafeContextText(message, {
          source: 'Workspace Pane host action',
        });
        let used = false;
        let active = false;
        let thread: string | undefined;
        let provisionedThread: string | undefined;
        let provisionedWorkspace: ForegroundInvocationAdmission['provisionedWorkspace'];
        let turnInvoked = false;
        let nativeRelayInvoked = false;
        const admission: ForegroundInvocationAdmission = Object.freeze({
          agentId: agent.agentId,
          source: Object.freeze({
            pluginId,
            installationGeneration: generation,
            actionId: action.id,
          }),
          get agentSpec() {
            return structuredClone(agentSpec);
          },
          get project() {
            return structuredClone(project);
          },
          message,
          get provisionedWorkspace() {
            return provisionedWorkspace;
          },
          async invoke<R>(
            phase: 'provision' | 'start' | 'turn' | 'native-relay',
            actual: Parameters<ForegroundInvocationAdmission['invoke']>[1],
            effect: () => Promise<R>,
          ): Promise<R> {
            if (!active) throw new ForegroundInvocationUnavailableError();
            const invokeWithProject = () =>
              withCurrentProject(async (current) =>
                agentSnapshot.invokeIfCurrent(() => {
                  if (
                    !active ||
                    !source.isCurrent() ||
                    current.id !== project.id ||
                    current.slug !== projectSlug ||
                    !agentAvailableInProject(current.slug, current.agents, {
                      slug: agent.agentId,
                      project: agentSpec.project,
                    }) ||
                    actual.agentId !== agent.agentId ||
                    actual.projectSlug !== projectSlug ||
                    !actual.threadId ||
                    (phase === 'native-relay' &&
                      (Boolean(agentSpec.execution?.agentConnectionId) ||
                        nativeRelayInvoked)) ||
                    (phase === 'turn' &&
                      !agentSpec.execution?.agentConnectionId &&
                      !nativeRelayInvoked) ||
                    (phase === 'provision'
                      ? project.defaultWorkspaceIsolation !== 'worktree' ||
                        provisionedThread !== undefined ||
                        thread !== undefined
                      : phase === 'start'
                        ? thread !== undefined ||
                          (provisionedWorkspace !== undefined &&
                            actual.cwd !== provisionedWorkspace.cwd) ||
                          (provisionedThread !== undefined &&
                            provisionedThread !== actual.threadId) ||
                          (project.defaultWorkspaceIsolation === 'worktree' &&
                            provisionedWorkspace === undefined)
                        : thread !== actual.threadId ||
                          turnInvoked ||
                          actual.message !== message)
                  )
                    throw new ForegroundInvocationUnavailableError();
                  if (phase === 'provision')
                    provisionedThread = actual.threadId;
                  else if (phase === 'start') thread = actual.threadId;
                  else if (phase === 'native-relay') nativeRelayInvoked = true;
                  else turnInvoked = true;
                  // Box the Promise: Project and Agent mutation locks release
                  // after the synchronous invocation, BEFORE provider settlement.
                  return { pending: effect() };
                }),
              );
            const invoked = input.withInvocationPermission
              ? await input.withInvocationPermission(
                  pluginId,
                  invokeWithProject,
                  source,
                )
              : await invokeWithProject();
            const result = await invoked.pending;
            if (phase === 'provision') {
              if (
                !result ||
                typeof result !== 'object' ||
                !('path' in result) ||
                typeof result.path !== 'string' ||
                !result.path
              )
                throw new ForegroundInvocationUnavailableError();
              provisionedWorkspace = Object.freeze({
                threadId: actual.threadId,
                projectSlug,
                cwd: result.path,
              });
            }
            return result;
          },
        });
        return Object.freeze({
          async run<R>(
            operation: (admission: ForegroundInvocationAdmission) => Promise<R>,
          ): Promise<R> {
            if (used) throw new ForegroundInvocationUnavailableError();
            used = true;
            // Plugin content is acquired OUTSIDE Session coordination, keeping
            // the existing lifecycle content -> Session lock order intact.
            return await withPluginContentLock(
              pluginsDir,
              pluginId,
              async () => {
                if (!source.isCurrent())
                  throw new ForegroundInvocationUnavailableError();
                active = true;
                try {
                  return await operation(admission);
                } finally {
                  active = false;
                }
              },
            );
          },
        });
      }).catch((error) => {
        if (error instanceof ForegroundInvocationUnavailableError) throw error;
        throw new ForegroundInvocationUnavailableError();
      });
    },
  });
}
