/**
 * Template Service — built-in + plugin-contributed templates for agents and layouts.
 */

import type {
  ITemplateProvider,
  Template,
} from '../../providers/provider-interfaces.js';
import { templateOps } from '../../telemetry/metrics.js';

const BUILTIN_AGENT_TEMPLATES: Template[] = [
  {
    id: 'chat-assistant',
    icon: '💬',
    label: 'Chat Assistant',
    description: 'General-purpose conversational agent',
    type: 'agent',
    form: {
      name: 'Chat Assistant',
      slug: 'chat-assistant',
      description: 'A helpful conversational AI assistant',
      prompt:
        "You are a helpful, friendly assistant. Answer questions clearly and concisely. If you're unsure about something, say so.",
    },
  },
  {
    id: 'code-helper',
    icon: '💻',
    label: 'Code Helper',
    description: 'Programming and development assistant',
    type: 'agent',
    form: {
      name: 'Code Helper',
      slug: 'code-helper',
      description: 'An AI assistant specialized in software development',
      prompt:
        'You are an expert software engineer. Help with code reviews, debugging, architecture decisions, and writing clean, maintainable code. Always explain your reasoning.',
    },
  },
  {
    id: 'writer',
    icon: '📝',
    label: 'Writer',
    description: 'Content creation and editing',
    type: 'agent',
    form: {
      name: 'Writer',
      slug: 'writer',
      description: 'An AI writing assistant for drafting and editing content',
      prompt:
        "You are a skilled writer and editor. Help draft, revise, and improve written content. Match the user's tone and style. Be concise unless asked for detail.",
    },
  },
  {
    id: 'research-analyst',
    icon: '🔬',
    label: 'Research Analyst',
    description: 'Deep research and analysis',
    type: 'agent',
    form: {
      name: 'Research Analyst',
      slug: 'research-analyst',
      description: 'An AI research assistant for analysis and synthesis',
      prompt:
        'You are a thorough research analyst. Gather information, identify patterns, and provide well-structured analysis. Always cite your reasoning and note uncertainties.',
    },
  },
];

const BUILTIN_LAYOUT_TEMPLATES: Template[] = [
  {
    id: 'team-dashboard',
    icon: '🏢',
    label: 'Team Dashboard',
    description: 'Multi-tab layout for team collaboration',
    type: 'layout',
    form: {
      name: 'Team Dashboard',
      slug: 'team-dashboard',
      description: 'Central hub for team collaboration and communication',
      icon: '🏢',
    },
    tabs: [
      { id: 'chat', label: 'Chat', component: 'chat' },
      { id: 'tasks', label: 'Tasks', component: 'canvas' },
    ],
  },
  {
    id: 'dev-layout',
    icon: '🔧',
    label: 'Dev Layout',
    description: 'Development-focused with code and docs tabs',
    type: 'layout',
    form: {
      name: 'Dev Layout',
      slug: 'dev-layout',
      description: 'Development layout with code review and documentation',
      icon: '🔧',
    },
    tabs: [
      { id: 'code', label: 'Code', component: 'chat' },
      { id: 'docs', label: 'Docs', component: 'canvas' },
    ],
  },
  {
    id: 'sales-hub',
    icon: '📊',
    label: 'Sales Hub',
    description: 'Customer management and outreach',
    type: 'layout',
    form: {
      name: 'Sales Hub',
      slug: 'sales-hub',
      description: 'Sales layout for customer management and outreach',
      icon: '📊',
    },
    tabs: [
      { id: 'crm', label: 'CRM', component: 'chat' },
      { id: 'outreach', label: 'Outreach', component: 'chat' },
    ],
  },
  {
    id: 'research',
    icon: '📚',
    label: 'Research',
    description: 'Research and knowledge management',
    type: 'layout',
    form: {
      name: 'Research',
      slug: 'research',
      description: 'Research layout for knowledge gathering and analysis',
      icon: '📚',
    },
    tabs: [
      { id: 'research', label: 'Research', component: 'chat' },
      { id: 'notes', label: 'Notes', component: 'canvas' },
    ],
  },
];

export class TemplateService {
  private providers: ITemplateProvider[] = [];

  addProvider(provider: ITemplateProvider) {
    this.providers.push(provider);
  }

  async listTemplates(type?: 'agent' | 'layout'): Promise<Template[]> {
    templateOps.add(1, { operation: 'list' });
    const builtins = [
      ...BUILTIN_AGENT_TEMPLATES,
      ...BUILTIN_LAYOUT_TEMPLATES,
    ].map((t) => ({ ...t, source: 'built-in' }));
    const external = (
      await Promise.all(
        this.providers.map((p) =>
          p
            .listTemplates()
            .then((ts) => ts.map((t) => ({ ...t, source: p.id })))
            .catch(() => []),
        ),
      )
    ).flat();
    const all = [...builtins, ...external];
    return type ? all.filter((t) => t.type === type) : all;
  }
}
