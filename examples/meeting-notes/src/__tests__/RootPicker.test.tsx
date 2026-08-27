/**
 * @vitest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { RootPicker } from '../RootPicker';

const useKnowledgeRootsQueryMock = vi.fn();

vi.mock('@kontourai/station-sdk', () => ({
  isRelevantKnowledgeRoot: (
    root: { scope: { kind: string; projectSlug?: string } },
    project: string | null,
  ) => root.scope.kind === 'personal' || root.scope.projectSlug === project,
  useNavigation: () => ({ selectedProject: 'proj-a' }),
  useKnowledgeRootsQuery: () => useKnowledgeRootsQueryMock(),
}));

describe('RootPicker', () => {
  test('filters to personal roots plus the active project roots only', () => {
    useKnowledgeRootsQueryMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: [
        {
          id: 'root:personal',
          scope: { kind: 'personal' },
          displayName: 'Personal',
          adapterId: 'x',
          storeRoot: '/p',
          createdAt: '',
        },
        {
          id: 'root:proj-a',
          scope: { kind: 'project', projectSlug: 'proj-a' },
          displayName: 'Project A',
          adapterId: 'x',
          storeRoot: '/a',
          createdAt: '',
        },
        {
          id: 'root:proj-b',
          scope: { kind: 'project', projectSlug: 'proj-b' },
          displayName: 'Project B',
          adapterId: 'x',
          storeRoot: '/b',
          createdAt: '',
        },
      ],
    });

    render(<RootPicker value={null} onChange={() => {}} />);

    expect(screen.getByText(/Personal \(personal\)/)).toBeTruthy();
    expect(screen.getByText(/Project A \(project\)/)).toBeTruthy();
    expect(screen.queryByText(/Project B/)).toBeNull();
  });

  test('renders an honest empty state when no relevant root is registered', () => {
    useKnowledgeRootsQueryMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: [],
    });

    render(<RootPicker value={null} onChange={() => {}} />);

    expect(
      screen.getByText(/No personal or project knowledge root registered yet/),
    ).toBeTruthy();
  });

  test('renders an error state honestly on query failure', () => {
    useKnowledgeRootsQueryMock.mockReturnValue({
      isLoading: false,
      isError: true,
      error: new Error('network down'),
      data: undefined,
    });

    render(<RootPicker value={null} onChange={() => {}} />);

    expect(screen.getByRole('alert').textContent).toContain('network down');
  });
});
