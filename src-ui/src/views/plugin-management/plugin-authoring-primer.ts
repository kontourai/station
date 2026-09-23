import type { ProjectChatComposerDraft } from '../../lib/projectChatEvents';
import type { PluginScaffoldTemplateChoice } from './plugin-scaffold-client';

/**
 * The opening message offered to the authoring chat. It is placed in the
 * composer, never sent: the person finishes the last line with what they
 * want the plugin to do.
 *
 * It names the station-docs `plugin-authoring` topic and the
 * `validate_plugin` tool so the Agent learns the format from Station itself,
 * and it keeps installing with the person: an Agent may author a plugin, but
 * only a person approves its install.
 */
export function buildPluginAuthoringPrimer({
  name,
  displayName,
  template,
}: {
  name: string;
  displayName: string;
  template: PluginScaffoldTemplateChoice;
}): string {
  return [
    `Let's build a Station plugin called "${displayName}" (${name}). Its starter files are already in this Project's folder, made from the ${template} template.`,
    '',
    'Before you change anything, read the station-docs `plugin-authoring` topic for the manifest format, Workspace Panes, renderer kinds and SDK hooks. After each change, run the `validate_plugin` tool on this folder and fix what it reports.',
    '',
    "Don't install, update or remove plugins. When it's ready, tell me and I'll install it myself from Plugins → Install plugin.",
    '',
    'What I want it to do: ',
  ].join('\n');
}

export function pluginAuthoringComposerDraft(input: {
  name: string;
  displayName: string;
  template: PluginScaffoldTemplateChoice;
}): ProjectChatComposerDraft {
  return {
    title: 'Plugin authoring',
    description:
      'Choose an Agent. This opening message goes into the composer for you to finish; nothing is sent until you send it.',
    label: 'Opening message',
    detail: `Continue building ${input.displayName}`,
    message: buildPluginAuthoringPrimer(input),
  };
}
