/**
 * @vitest-environment jsdom
 *
* archive#4463: RegistryCatalog's tab strip had no
* render-level coverage before this. Smoke-level only — the
 * primitive itself is covered in `Tabs.test.tsx`.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import {
  RegistryCatalog,
  type RegistryCatalogActions,
  type RegistryCatalogModel,
} from '../components/registry/RegistryCatalog';

const model: RegistryCatalogModel = {
  activeTab: 'agents',
  search: '',
  message: null,
  isLoading: false,
  loadError: null,
  isCheckingInstalled: false,
  installedStatusError: null,
  available: [],
  filtered: [],
  installedIds: new Set(),
  installationOverrides: new Map(),
  selectedItem: null,
  selectedItemId: null,
  selectedInstalled: false,
  selectedActionPending: false,
  layoutPending: false,
};

function makeActions(): RegistryCatalogActions {
  return {
    setActiveTab: vi.fn(),
    setSearch: vi.fn(),
    clearMessage: vi.fn(),
    select: vi.fn(),
    runAction: vi.fn(),
    runLayoutAction: vi.fn(),
    onUseLayout: vi.fn(),
    manageSkills: vi.fn(),
    managePlugins: vi.fn(),
    openProjects: vi.fn(),
    retryInstalled: vi.fn(),
  };
}

describe('RegistryCatalog tab strip', () => {
  test('renders all six tabs, sticky, and a click activates one (setActiveTab, clearMessage, setSearch)', () => {
    const actions = makeActions();
    render(<RegistryCatalog model={model} actions={actions} />);

    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual([
      'Agents',
      'Skills',
      'Integrations',
      'Plugins',
      'Layouts',
      'Kits',
    ]);
    expect(screen.getByRole('tablist').className).toContain(
      'page__tabs--sticky',
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Plugins' }));
    expect(actions.clearMessage).toHaveBeenCalled();
    expect(actions.setSearch).toHaveBeenCalledWith('');
    expect(actions.setActiveTab).toHaveBeenCalledWith('plugins');
  });
});
