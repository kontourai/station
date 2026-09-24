import { isAgentPluginName } from '@kontourai/station-contracts/agent-plugin';
import { useCreateProjectMutation } from '@kontourai/station-sdk';
import { useMutation } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import {
  deriveProjectSlug,
  normalizeWorkingDirectory,
} from '../../components/modals/project-form-utils';
import { useApiBase } from '../../contexts/ApiBaseContext';
import { useConfig } from '../../contexts/ConfigContext';
import { useNavigation } from '../../contexts/NavigationContext';
import {
  buildPluginAuthoringPrimer,
  startPluginAuthoringChat,
} from './plugin-authoring-primer';
import {
  type PluginScaffoldTemplateChoice,
  scaffoldProjectPlugin,
} from './plugin-scaffold-client';

export const WORKTREE_OVERRIDE_REFUSED =
  "This Station runs chats in separate worktrees, and a plugin Project has to work in its folder directly. This device can't change that setting for a Project. Ask the operator to create it, or to set the Station's workspace isolation to Shared.";

export function defaultPluginTitle(name: string): string {
  return name
    .split(/[-.]/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(' ');
}

export function pluginNameProblem(name: string): string | null {
  if (!name) return null;
  return isAgentPluginName(name)
    ? null
    : 'Use lowercase letters, digits, hyphens or periods, starting and ending with a letter or digit.';
}

interface CreatedProject {
  slug: string;
  name: string;
}

/**
 * New plugin = create a Project, scaffold into its folder, open it, and offer
 * an authoring chat. The Project is created once: when scaffolding is
 * refused (the folder was not empty), Retry scaffolds into the SAME Project
 * rather than creating a second one.
 */
export function useNewPluginFlow(onDone: () => void) {
  const { apiBase } = useApiBase();
  const { setProject, setDockState } = useNavigation();
  const createProject = useCreateProjectMutation();
  const scaffold = useMutation({
    mutationFn: (input: {
      slug: string;
      name: string;
      template: PluginScaffoldTemplateChoice;
      displayName: string;
    }) =>
      scaffoldProjectPlugin(apiBase, input.slug, {
        name: input.name,
        template: input.template,
        displayName: input.displayName,
      }),
  });
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [directory, setDirectory] = useState('');
  const [template, setTemplate] =
    useState<PluginScaffoldTemplateChoice>('pane');
  const [created, setCreated] = useState<CreatedProject | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unclaimedPrimer, setUnclaimedPrimer] = useState<string | null>(null);
  const config = useConfig();

  const trimmedName = name.trim();
  const nameProblem = pluginNameProblem(trimmedName);
  const displayName = title.trim() || defaultPluginTitle(trimmedName);
  const submitting = createProject.isPending || scaffold.isPending;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!trimmedName || nameProblem || submitting) return;
    setError(null);
    try {
      let project = created;
      if (!project) {
        const normalized = normalizeWorkingDirectory(directory);
        // An authoring chat must see the scaffold it is told about. Under
        // worktree isolation it would run in a checkout that never holds
        // these uncommitted files (and a blank or non-git folder would be
        // refused outright), so this Project must work in its folder
        // directly. The override is sent ONLY when the Station default is
        // worktree: writing it takes operate scope, and a paired device that
        // could always create a Project must still be able to here. An
        // unread config sends nothing; the scaffold route then refuses a
        // worktree Project with its own fix.
        const needsSharedOverride =
          config?.defaultWorkspaceIsolation === 'worktree';
        let result: { slug: string; name?: string };
        try {
          result = await createProject.mutateAsync({
            name: displayName,
            slug: deriveProjectSlug(trimmedName),
            ...(normalized ? { workingDirectory: normalized } : {}),
            ...(needsSharedOverride
              ? { defaultWorkspaceIsolation: 'shared' as const }
              : {}),
          });
        } catch (createError) {
          // #2412: a 403 that names its own code is a different refusal (the
          // Project's folder), and says so itself.
          if (
            needsSharedOverride &&
            (createError as { status?: unknown }).status === 403 &&
            (createError as { code?: unknown }).code === undefined
          ) {
            throw new Error(WORKTREE_OVERRIDE_REFUSED);
          }
          throw createError;
        }
        project = { slug: result.slug, name: result.name ?? displayName };
        setCreated(project);
      }
      await scaffold.mutateAsync({
        slug: project.slug,
        name: trimmedName,
        template,
        displayName,
      });
      const primer = {
        projectSlug: project.slug,
        projectName: project.name,
        name: trimmedName,
        displayName,
        template,
      };
      // Asked for BEFORE navigating: navigation unmounts this dialog, and
      // when no chat pane takes the request the dialog must stay to offer
      // the opening message. Its Done then opens the Project.
      if (
        !startPluginAuthoringChat({
          ...primer,
          revealDock: () => setDockState(true),
        })
      ) {
        setUnclaimedPrimer(buildPluginAuthoringPrimer(primer));
        return;
      }
      setProject(project.slug);
      onDone();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  /** After a refused scaffold, the Project still exists: go to it. */
  function openCreatedProject() {
    if (!created) return;
    setProject(created.slug);
    onDone();
  }

  return {
    openCreatedProject,
    unclaimedPrimer,
    name,
    setName,
    title,
    setTitle,
    directory,
    setDirectory,
    template,
    setTemplate,
    displayName,
    nameProblem,
    created,
    error,
    submitting,
    canSubmit: Boolean(trimmedName) && !nameProblem && !submitting,
    submit,
  };
}
