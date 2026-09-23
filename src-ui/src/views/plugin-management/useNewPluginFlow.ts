import { isAgentPluginName } from '@kontourai/station-contracts/agent-plugin';
import { useCreateProjectMutation } from '@kontourai/station-sdk';
import { useMutation } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import {
  deriveProjectSlug,
  normalizeWorkingDirectory,
} from '../../components/modals/project-form-utils';
import { useApiBase } from '../../contexts/ApiBaseContext';
import { useNavigation } from '../../contexts/NavigationContext';
import { startPluginAuthoringChat } from './plugin-authoring-primer';
import {
  type PluginScaffoldTemplateChoice,
  scaffoldProjectPlugin,
} from './plugin-scaffold-client';

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
        const result = await createProject.mutateAsync({
          name: displayName,
          slug: deriveProjectSlug(trimmedName),
          ...(normalized ? { workingDirectory: normalized } : {}),
          // An authoring chat must see the scaffold it is told about. Under
          // worktree isolation it would run in a checkout that never holds
          // these uncommitted files (and a blank or non-git folder would be
          // refused outright), so this Project works in its folder directly.
          defaultWorkspaceIsolation: 'shared',
        });
        project = { slug: result.slug, name: result.name ?? displayName };
        setCreated(project);
      }
      await scaffold.mutateAsync({
        slug: project.slug,
        name: trimmedName,
        template,
        displayName,
      });
      setProject(project.slug);
      startPluginAuthoringChat({
        projectSlug: project.slug,
        projectName: project.name,
        name: trimmedName,
        displayName,
        template,
        revealDock: () => setDockState(true),
      });
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
