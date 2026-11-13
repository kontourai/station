import type { NavigationView } from '../../types';

export interface HeaderHelpPrompt {
  label: string;
  prompt: string;
}

interface HeaderBreadcrumb {
  /** Set for project/layout views — the project the user is inside. */
  projectSlug?: string;
  layoutSlug?: string;
  /** Set for a direct pane route — the descriptor whose name follows the project. */
  paneDescriptorId?: string;
  /** Set for standalone section views (Agents, Settings, …) — the section name. */
  section?: string;
  /** The view a section crumb navigates "up" to when clicked. */
  sectionRoot?: NavigationView;
}

export function getHelpPrompts(view?: NavigationView): HeaderHelpPrompt[] {
  const common = [
    {
      label: 'What needs my attention?',
      prompt:
        'Use list_active_work to summarize work visible to this conversation, what is waiting on me, and recorded blockers. State the scope and any gaps.',
    },
    {
      label: 'Check my Station',
      prompt:
        'Use system_status to check my Station and explain reported problems. Identify unavailable checks.',
    },
  ];
  const projectSlug = getHeaderBreadcrumb(
    view ?? { type: 'home' },
  )?.projectSlug;
  if (projectSlug)
    return [
      {
        label: 'What is happening in this project?',
        prompt: `Use list_active_work and read_conversation to summarize work visible to this conversation. Report whether its scope includes project ${JSON.stringify(projectSlug)}; do not imply a Station-wide inventory.`,
      },
      ...common,
    ];
  switch (view?.type) {
    case 'agents':
      return [
        {
          label: 'Which agents have I configured?',
          prompt:
            'Use list_agents and get_agent to summarize my configured agents, their engines and instructions.',
        },
        ...common,
      ];
    case 'connections-tools':
      return [
        {
          label: 'Which tool connections are configured?',
          prompt:
            'Use list_integrations and get_integration to summarize my tool connections and any reported setup problems.',
        },
        ...common,
      ];
    case 'connections':
    case 'connections-models':
      return [
        {
          label: 'Check my model connections',
          prompt:
            'Use list_providers and system_status to check my model connections. Which need attention, and why?',
        },
        ...common,
      ];
    case 'guidance':
      return [
        {
          label: 'Which skills are installed?',
          prompt:
            'Use list_skills to summarize my installed skills and what each helps me do.',
        },
        ...common,
      ];
    case 'schedule':
      return [
        {
          label: 'What happened to my automations?',
          prompt:
            'Use list_jobs and get_job_logs to summarize my automations and their latest outcomes, failures and missing receipts.',
        },
        ...common,
      ];
    default:
      return common;
  }
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
    case 'developer':
      return 'Developer';
    case 'schedule':
      return 'Automations';
    case 'settings':
      return 'Settings';
    case 'appearance':
      return 'Appearance';
    case 'profile':
      return 'Profile';
    case 'notifications':
      return 'Notifications';
    default:
      return null;
  }
}

/** The root view a section crumb links "up" to (sub-views climb to their family). */
function sectionRootView(view: NavigationView): NavigationView {
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
    case 'workspace-pane':
      return {
        projectSlug: view.projectSlug,
        paneDescriptorId: view.descriptorId,
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
