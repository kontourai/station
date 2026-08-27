import { describe, expect, test } from 'vitest';
import {
  getHeaderBreadcrumb,
  getHelpPrompts,
} from '../components/header/utils';

describe('header utils', () => {
  test('returns generic help prompts when no view is provided', () => {
    expect(getHelpPrompts()).toEqual([
      {
        label: 'What can you do?',
        prompt: 'What can you help me with? List your capabilities.',
      },
      {
        label: 'System health check',
        prompt:
          'Run a system health check and tell me if anything needs attention.',
      },
    ]);
  });

  test('prepends contextual help prompts for matching views', () => {
    expect(getHelpPrompts({ type: 'connections-tools' })[0]).toEqual({
      label: 'Add an MCP server',
      prompt:
        'Help me add a new MCP tool server. What popular ones are available?',
    });
  });

  test('resolves breadcrumb details for layout, project, and section views', () => {
    expect(
      getHeaderBreadcrumb({
        type: 'layout',
        projectSlug: 'alpha',
        layoutSlug: 'coding',
      }),
    ).toEqual({
      projectSlug: 'alpha',
      layoutSlug: 'coding',
    });
    expect(getHeaderBreadcrumb({ type: 'project', slug: 'alpha' })).toEqual({
      projectSlug: 'alpha',
    });
    // Standalone views now carry a section crumb that climbs to its root.
    expect(getHeaderBreadcrumb({ type: 'agents' })).toEqual({
      section: 'Agents',
      sectionRoot: { type: 'agents' },
    });
    expect(getHeaderBreadcrumb({ type: 'agent-edit', slug: 'a1' })).toEqual({
      section: 'Agents',
      sectionRoot: { type: 'agents' },
    });
    expect(getHeaderBreadcrumb({ type: 'settings' })).toEqual({
      section: 'Settings',
      sectionRoot: { type: 'settings' },
    });
    expect(getHeaderBreadcrumb({ type: 'connections-tools' })).toEqual({
      section: 'Connections',
      sectionRoot: { type: 'connections' },
    });
  });
});
