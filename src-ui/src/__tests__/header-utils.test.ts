import { describe, expect, test } from 'vitest';
import {
  getHeaderBreadcrumb,
  getHelpPrompts,
} from '../components/header/utils';

describe('header utils', () => {
  test('offers concrete reads of this Station and scopes project questions', () => {
    expect(getHelpPrompts()[0].prompt).toContain('list_active_work');
    expect(getHelpPrompts()[1].prompt).toContain('system_status');
    expect(getHelpPrompts({ type: 'connections-tools' })[0].prompt).toContain(
      'list_integrations',
    );
    expect(getHelpPrompts({ type: 'schedule' })[0].prompt).toContain(
      'get_job_logs',
    );
    expect(
      getHelpPrompts({
        type: 'layout',
        projectSlug: 'alpha',
        layoutSlug: 'coding',
      })[0].prompt,
    ).toContain('project "alpha"');
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
    // A direct pane route names its project and which pane it shows.
    expect(
      getHeaderBreadcrumb({
        type: 'workspace-pane',
        projectSlug: 'alpha',
        descriptorId: 'pane:builtin:workspace-preview:browser-preview',
        instanceId: 'browser-preview:1',
      }),
    ).toEqual({
      projectSlug: 'alpha',
      paneDescriptorId: 'pane:builtin:workspace-preview:browser-preview',
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
