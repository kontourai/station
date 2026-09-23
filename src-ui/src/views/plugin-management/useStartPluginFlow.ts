import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { useApiBase } from '../../contexts/ApiBaseContext';
import { useNavigation } from '../../contexts/NavigationContext';
import { startPluginAuthoringChat } from './plugin-authoring-primer';
import {
  type PluginScaffoldTemplateChoice,
  scaffoldProjectPlugin,
} from './plugin-scaffold-client';
import { defaultPluginTitle, pluginNameProblem } from './useNewPluginFlow';

export const pluginScaffoldEligibilityKey = (
  apiBase: string,
  projectSlug: string,
) => ['plugin-scaffold-eligibility', apiBase, projectSlug] as const;

/**
 * "Start a plugin in this folder" on an existing Project. Any Project member
 * may do this (owner decision, epic #2323): it scaffolds into the Project's
 * own empty folder, then offers the authoring chat. It creates no Project
 * and installs nothing.
 */
export function useStartPluginFlow(
  project: { slug: string; name: string },
  onDone: () => void,
) {
  const { apiBase } = useApiBase();
  const { setDockState } = useNavigation();
  const queryClient = useQueryClient();
  const scaffold = useMutation({
    mutationFn: (input: {
      name: string;
      template: PluginScaffoldTemplateChoice;
      displayName: string;
    }) => scaffoldProjectPlugin(apiBase, project.slug, input),
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: pluginScaffoldEligibilityKey(apiBase, project.slug),
      }),
  });
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [template, setTemplate] =
    useState<PluginScaffoldTemplateChoice>('pane');
  const [error, setError] = useState<string | null>(null);

  const trimmedName = name.trim();
  const nameProblem = pluginNameProblem(trimmedName);
  const displayName = title.trim() || defaultPluginTitle(trimmedName);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!trimmedName || nameProblem || scaffold.isPending) return;
    setError(null);
    try {
      await scaffold.mutateAsync({
        name: trimmedName,
        template,
        displayName,
      });
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

  return {
    name,
    setName,
    title,
    setTitle,
    template,
    setTemplate,
    displayName,
    nameProblem,
    error,
    submitting: scaffold.isPending,
    canSubmit: Boolean(trimmedName) && !nameProblem && !scaffold.isPending,
    submit,
  };
}
