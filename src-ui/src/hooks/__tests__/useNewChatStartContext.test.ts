// @vitest-environment jsdom

import { describe, expect, test } from 'vitest';
import { GLOBAL_CONTEXT } from '../../components/modals/new-chat-modal-utils';
import type { ProjectMetadata } from '../../contexts/ProjectsContext';
import { resolveNewChatStartContext } from '../useNewChatStartContext';

// #3312 review HIGH: Home names the Agent and Model "Start a chat" will use,
// and Start runs in the context the ambient dock's New Chat opens on. These
// pin that context: the dock's remembered project binding, never the route.
const projects = [
  { id: 'p1', slug: 'station', name: 'Station', workingDirectory: '/w/s' },
  { id: 'p2', slug: 'notes', name: 'Notes', workingDirectory: '   ' },
] as ProjectMetadata[];

describe('resolveNewChatStartContext', () => {
  test('a dock bound to a project with a directory starts in that project', () => {
    expect(
      resolveNewChatStartContext({
        dockProjectSlug: 'station',
        routeActiveProjectSlug: null,
        projects,
        projectsLoaded: true,
      }),
    ).toBe('station');
  });

  test('an unbound dock starts global even when the route names a project', () => {
    // The dock's New Chat ignores the route project; a Home that read it
    // would name a project's identity Start does not use.
    expect(
      resolveNewChatStartContext({
        dockProjectSlug: null,
        routeActiveProjectSlug: 'station',
        projects,
        projectsLoaded: true,
      }),
    ).toBe(GLOBAL_CONTEXT);
  });

  test('a project without a working directory starts in it; one that is gone starts global', () => {
    // No folder: the server runs it in the home folder, deliberately.
    expect(
      resolveNewChatStartContext({
        dockProjectSlug: 'notes',
        routeActiveProjectSlug: null,
        projects,
        projectsLoaded: true,
      }),
    ).toBe('notes');
    expect(
      resolveNewChatStartContext({
        dockProjectSlug: 'deleted',
        routeActiveProjectSlug: null,
        projects,
        projectsLoaded: true,
      }),
    ).toBe(GLOBAL_CONTEXT);
  });

  // #3350 item 1: on a first launch the dock names a project before the
  // project list arrives. The context is unknown then, not global: a start
  // in that window used to run global with the global Model.
  test('a bound project is unresolved until the project list has loaded', () => {
    expect(
      resolveNewChatStartContext({
        dockProjectSlug: 'station',
        routeActiveProjectSlug: null,
        projects: [],
        projectsLoaded: false,
      }),
    ).toBeUndefined();
    // Nothing bound: global needs no project list.
    expect(
      resolveNewChatStartContext({
        dockProjectSlug: null,
        routeActiveProjectSlug: null,
        projects: [],
        projectsLoaded: false,
      }),
    ).toBe(GLOBAL_CONTEXT);
  });
});
