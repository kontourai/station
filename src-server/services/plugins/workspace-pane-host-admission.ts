import { lstatSync } from 'node:fs';
import { join } from 'node:path';
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
import { scanPluginPromptGeneration } from './plugin-command-skill-source.js';
import {
  computePluginContentDigest,
  withPluginContentLock,
} from './plugin-content-integrity.js';
import { withPluginInstallationGeneration } from './plugin-installation-generation-fence.js';
import { parsePluginManifest } from './plugin-manifest-loader.js';

/**
 * Local server-owned prerequisite, not an API or a UI registration. The caller
 * supplies identities only; authored Agent/Project/body data comes from the
 * installed record and existing storage owners. A prepared action is one-shot.
 */
export function createWorkspacePaneHostAdmission(input: {
  projectHomeDir: string;
  projects: Pick<IStorageAdapter, 'projectRevision'>;
  nativeAgentAvailable?(agentId: string, spec: AgentSpec): boolean;
  /** Production grant gate wraps the short final Project/Agent admission. */
  withInvocationPermission?<T>(
    pluginId: string,
    invoke: () => Promise<T>,
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
        const pluginDir = join(pluginsDir, pluginId);
        const manifestPath = join(pluginDir, 'plugin.json');
        for (const directory of [pluginsDir, pluginDir]) {
          const stat = lstatSync(directory);
          if (!stat.isDirectory() || stat.isSymbolicLink())
            throw new ForegroundInvocationUnavailableError();
        }
        const manifestStat = lstatSync(manifestPath);
        if (
          !manifestStat.isFile() ||
          manifestStat.isSymbolicLink() ||
          manifestStat.size > 256 * 1024
        ) {
          throw new ForegroundInvocationUnavailableError();
        }
        const manifest = parsePluginManifest(
          readRegularFileNoFollow(projectHomeDir, manifestPath, {
            maxBytes: 256 * 1024,
          }),
          manifestPath,
        );
        const digest = computePluginContentDigest(pluginsDir, pluginId);
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
          !digest ||
          (request.installationGeneration !== undefined &&
            request.installationGeneration !== digest) ||
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
        if (
          project.slug !== projectSlug ||
          project.defaultWorkspaceIsolation === 'worktree'
        ) {
          // Worktree provisioning is a pre-invocation effect and is not admitted
          // by this bounded first slice. Never silently substitute shared work.
          throw new ForegroundInvocationUnavailableError();
        }
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
          const exact = scanPluginPromptGeneration(pluginDir, pluginId, {
            maxFiles: 32,
            maxFileBytes: 64 * 1024,
          }).filter(
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
        let turnInvoked = false;
        let nativeRelayInvoked = false;
        const admission: ForegroundInvocationAdmission = Object.freeze({
          agentId: agent.agentId,
          source: Object.freeze({
            pluginId,
            installationGeneration: digest,
            actionId: action.id,
          }),
          get agentSpec() {
            return structuredClone(agentSpec);
          },
          get project() {
            return structuredClone(project);
          },
          message,
          async invoke<R>(
            phase: 'start' | 'turn' | 'native-relay',
            actual: Parameters<ForegroundInvocationAdmission['invoke']>[1],
            effect: () => Promise<R>,
          ): Promise<R> {
            if (!active) throw new ForegroundInvocationUnavailableError();
            const invokeWithProject = () =>
              withCurrentProject(async (current) =>
                agentSnapshot.invokeIfCurrent(() => {
                  if (
                    !active ||
                    computePluginContentDigest(pluginsDir, pluginId) !==
                      digest ||
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
                    (phase === 'start'
                      ? thread !== undefined
                      : thread !== actual.threadId ||
                        turnInvoked ||
                        actual.message !== message)
                  )
                    throw new ForegroundInvocationUnavailableError();
                  if (phase === 'start') thread = actual.threadId;
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
                )
              : await invokeWithProject();
            return invoked.pending;
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
            const outcome = await withPluginInstallationGeneration({
              pluginsDir,
              pluginName: pluginId,
              expected: { installed: true, installationGeneration: digest },
              effect: async () => {
                active = true;
                try {
                  return await operation(admission);
                } finally {
                  active = false;
                }
              },
            });
            if (outcome.kind !== 'applied')
              throw new ForegroundInvocationUnavailableError();
            return outcome.value;
          },
        });
      }).catch((error) => {
        if (error instanceof ForegroundInvocationUnavailableError) throw error;
        throw new ForegroundInvocationUnavailableError();
      });
    },
  });
}
