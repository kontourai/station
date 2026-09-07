import type { NavigationView } from '../../types';

export interface HeaderHelpPrompt {
  label: string;
  prompt: string;
}

export interface HeaderBreadcrumb {
  /** Set for project/layout views — the project the user is inside. */
  projectSlug?: string;
  layoutSlug?: string;
  /** Set for standalone section views (Agents, Settings, …) — the section name. */
  section?: string;
  /** The view a section crumb navigates "up" to when clicked. */
  sectionRoot?: NavigationView;
}

export function getHelpPrompts(view?: NavigationView): HeaderHelpPrompt[] {
  const generic = [
    {
      label: 'What can you do?',
      prompt: 'What can you help me with? List your capabilities.',
    },
    {
      label: 'System health check',
      prompt:
        'Run a system health check and tell me if anything needs attention.',
    },
  ];

  if (!view) return generic;

  const contextual: HeaderHelpPrompt[] = [];

  switch (view.type) {
    case 'agents':
      contextual.push(
        {
          label: 'Create an agent for me',
          prompt: 'Help me create a new agent. Ask me what I need it to do.',
        },
        {
          label: 'What skills should I add?',
          prompt:
            'List available skills and recommend which ones to install based on common use cases.',
        },
      );
      break;
    case 'connections-tools':
      contextual.push(
        {
          label: 'Add an MCP server',
          prompt:
            'Help me add a new MCP tool server. What popular ones are available?',
        },
        {
          label: 'Browse the registry',
          prompt:
            'List available integrations from the registry and help me pick ones to install.',
        },
      );
      break;
    case 'guidance':
      contextual.push({
        label: 'Install recommended skills',
        prompt:
          'What skills are available in the registry? Recommend the most useful ones and install them.',
      });
      break;
    case 'schedule':
      contextual.push({
        label: 'Schedule a recurring task',
        prompt:
          'Help me set up a scheduled job. Ask me what I want to run and when.',
      });
      break;
    case 'connections-models':
      contextual.push({
        label: 'Add a model connection',
        prompt: 'Help me set up a new model connection.',
      });
      break;
  }

  return [...contextual, ...generic];
}

/** Display label for a standalone section view, or null if it has none. */
function sectionLabel(view: NavigationView): string | null {
  const t = view.type;
  if (t.startsWith('agent')) return 'Agents';
  if (t.startsWith('connections')) return 'Connections';
  switch (t) {
    case 'plugins':
      return 'Plugins';
    case 'registry':
      return 'Registry';
    case 'review-queue':
      return 'Review';
    case 'developer':
      return 'Developer';
    case 'schedule':
      return 'Schedule';
    case 'settings':
      return 'Settings';
    case 'profile':
      return 'Profile';
    case 'notifications':
      return 'Notifications';
    default:
      return null;
  }
}

/** The root view a section crumb links "up" to (sub-views climb to their family). */
export function sectionRootView(view: NavigationView): NavigationView {
  const t = view.type;
  if (t.startsWith('agent')) return { type: 'agents' };
  if (t.startsWith('connections')) return { type: 'connections' };
  return view;
}

export function getHeaderBreadcrumb(
  view?: NavigationView,
): HeaderBreadcrumb | null {
  if (!view) return null;

  switch (view.type) {
    case 'layout':
      return {
        projectSlug: view.projectSlug,
        layoutSlug: view.layoutSlug,
      };
    case 'project':
    case 'project-session-board':
    case 'project-flow-console':
      return { projectSlug: view.slug };
    default: {
      const section = sectionLabel(view);
      return section ? { section, sectionRoot: sectionRootView(view) } : null;
    }
  }
}
