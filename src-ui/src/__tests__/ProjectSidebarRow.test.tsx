/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { ProjectMetadata } from '../contexts/ProjectsContext';

const layoutsQueryMock = vi.fn();
const boardAvailabilityQueryMock = vi.fn();

vi.mock('@kontourai/station-sdk', () => ({
  useProjectLayoutsQuery: (...args: unknown[]) => layoutsQueryMock(...args),
  useBoardAvailabilityQuery: (...args: unknown[]) =>
    boardAvailabilityQueryMock(...args),
}));

vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({
    navigate: vi.fn(),
    setProject: vi.fn(),
    setLayout: vi.fn(),
  }),
}));

import { ProjectSidebarRow } from '../components/project-sidebar/ProjectSidebarRow';

const project: ProjectMetadata = {
  id: 'proj-1',
  slug: 'demo',
  name: 'Demo Project',
  hasWorkingDirectory: true,
  layoutCount: 1,
  hasKnowledge: false,
};

describe('ProjectSidebarRow', () => {
  beforeEach(() => {
    boardAvailabilityQueryMock.mockReset();
    boardAvailabilityQueryMock.mockReturnValue({
      data: { hasBuilderRun: true },
    });
  });

  test('defers the layouts request until the row is expanded', () => {
    layoutsQueryMock.mockReturnValue({ data: [] });
    render(
      <ProjectSidebarRow
        project={project}
        isActive={false}
        activeLayout={null}
        collapsed={false}
      />,
    );

    expect(layoutsQueryMock).toHaveBeenLastCalledWith('demo', {
      enabled: false,
    });

    fireEvent.click(
      screen.getByRole('button', { name: 'Expand Demo Project layouts' }),
    );
    expect(layoutsQueryMock).toHaveBeenLastCalledWith('demo', {
      enabled: true,
    });
  });

  /**
   * archive#3202. The number was `aria-hidden` beside a visually-hidden
   * sentence, so it was announced but never SHOWN in words — "what does the
   * '6' next to kontour mean?". The label is supplied by the same derivation
   * that produced the count; the row must render it in both channels and must
   * not compose a second wording of its own.
   */
  test('shows the live-work count and says what it means in both channels', () => {
    layoutsQueryMock.mockReturnValue({ data: [] });
    const { container } = render(
      <ProjectSidebarRow
        project={project}
        isActive={false}
        activeLayout={null}
        collapsed={false}
        liveCount={3}
        liveLabel="Needs you: 2 · Active now: 1"
      />,
    );

    const count = container.querySelector('.sidebar__project-live-count');
    const label = container.querySelector('.sidebar__project-live-label');
    expect(count?.textContent).toBe('3');
    // Visible to a pointer user…
    expect(count?.getAttribute('title')).toBe('Needs you: 2 · Active now: 1');
    // …announced once to everyone else, and the two are the same sentence.
    expect(label?.textContent).toBe(count?.getAttribute('title'));
    expect(count?.getAttribute('aria-hidden')).toBe('true');
    expect(
      screen.getByRole('button', {
        name: /demo project.*needs you: 2 · active now: 1/i,
      }),
    ).toBeTruthy();
  });

  test('renders no badge at all for a project with nothing live', () => {
    layoutsQueryMock.mockReturnValue({ data: [] });
    const { container } = render(
      <ProjectSidebarRow
        project={project}
        isActive={false}
        activeLayout={null}
        collapsed={false}
        liveCount={0}
        liveLabel=""
      />,
    );

    expect(container.querySelector('.sidebar__project-live-count')).toBeNull();
    expect(container.querySelector('.sidebar__project-live-label')).toBeNull();
  });

  test('keeps the hardcoded Board shortcut for a project without the layout', () => {
    layoutsQueryMock.mockReturnValue({
      data: [{ slug: 'coding', name: 'Coding', type: 'coding' }],
    });

    render(
      <ProjectSidebarRow
        project={project}
        isActive
        activeLayout={null}
        collapsed={false}
      />,
    );

    // Only the hardcoded shortcut renders "Board" — the real per-project
    // layout list only has Coding here.
    expect(screen.getAllByRole('button', { name: 'Board' })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Coding' })).toBeTruthy();
  });

  /**
   * D8: the shortcut is the NAV half of the one Builder-run predicate. With
   * the server answering `false` the entry is not offered at all — the same
   * answer the route guard acts on, so a reader is never shown a Board they
   * would immediately be redirected out of.
   */
  test('offers no Board shortcut when the server reports no Builder run', () => {
    boardAvailabilityQueryMock.mockReturnValue({
      data: { hasBuilderRun: false },
    });
    layoutsQueryMock.mockReturnValue({
      data: [{ slug: 'coding', name: 'Coding', type: 'coding' }],
    });

    render(
      <ProjectSidebarRow
        project={project}
        isActive
        activeLayout={null}
        collapsed={false}
      />,
    );

    // The strip itself renders — this is the absence of one entry inside it,
    // not the absence of the whole sidebar.
    expect(screen.getByRole('button', { name: 'Coding' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Board' })).toBeNull();
  });

  /**
   * The availability read is gated exactly like the layouts read beside it:
   * the server answers it by scanning the project's workflow sidecar
   * directory, and the entry it decides only exists inside an expanded row.
   */
  test('defers the board-availability request until the row is expanded', () => {
    layoutsQueryMock.mockReturnValue({ data: [] });
    render(
      <ProjectSidebarRow
        project={project}
        isActive={false}
        activeLayout={null}
        collapsed={false}
      />,
    );

    expect(boardAvailabilityQueryMock).toHaveBeenCalledWith('demo', {
      enabled: false,
    });
  });

  test('hides the hardcoded shortcut once the project has a session-board layout instance', () => {
    layoutsQueryMock.mockReturnValue({
      data: [
        { slug: 'coding', name: 'Coding', type: 'coding' },
        {
          slug: 'session-board',
          name: 'Session Board',
          type: 'session-board',
        },
      ],
    });

    render(
      <ProjectSidebarRow
        project={project}
        isActive
        activeLayout={null}
        collapsed={false}
      />,
    );

    // Exactly one "Session Board" button remains: the real layout-list
    // entry. If the dedupe regressed, the hardcoded shortcut would add a
    // second one.
    expect(
      screen.getAllByRole('button', { name: 'Session Board' }),
    ).toHaveLength(1);
  });

  test('does not render the shortcut when the project has no layouts yet', () => {
    layoutsQueryMock.mockReturnValue({ data: [] });

    render(
      <ProjectSidebarRow
        project={project}
        isActive
        activeLayout={null}
        collapsed={false}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Session Board' })).toBeNull();
  });

  test('renders a deterministic supplemental accent', () => {
    layoutsQueryMock.mockReturnValue({ data: [] });

    const { container } = render(
      <ProjectSidebarRow
        project={project}
        isActive={false}
        activeLayout={null}
        collapsed={false}
      />,
    );

    const accent = container.querySelector('.sidebar__project-accent');
    expect(accent?.getAttribute('style')).toContain('background-color');
  });

  test('does not render a Chats pill', () => {
    layoutsQueryMock.mockReturnValue({ data: [] });

    render(
      <ProjectSidebarRow
        project={project}
        isActive={false}
        activeLayout={null}
        collapsed={false}
      />,
    );

    expect(screen.queryByRole('button', { name: /Project chats/ })).toBeNull();
  });

  test('uses the set-aware accent prop when provided', () => {
    layoutsQueryMock.mockReturnValue({ data: [] });
    const { container } = render(
      <ProjectSidebarRow
        project={project}
        isActive={false}
        activeLayout={null}
        collapsed={false}
        accent="var(--event-tool-result)"
      />,
    );

    const accent = container.querySelector('.sidebar__project-accent');
    expect(accent?.getAttribute('style')).toContain('var(--event-tool-result)');
  });
});
