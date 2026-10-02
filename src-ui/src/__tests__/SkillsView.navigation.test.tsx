// @vitest-environment jsdom

import type { Skill } from '@kontourai/station-contracts/catalog';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  NavigationProvider,
  navigationStore,
} from '../contexts/NavigationContext';
import { SkillsView } from '../views/SkillsView';

type SkillRecord = Partial<Skill> & { name: string };

const skillA: SkillRecord = {
  name: 'skill-a',
  description: 'Original skill',
  body: 'Original instructions',
  origin: 'user',
  writable: true,
};
const skillB: SkillRecord = {
  name: 'skill-b',
  description: 'Imported skill',
  body: 'Imported instructions',
  origin: 'user',
  writable: true,
};
let imported = false;

vi.mock('@kontourai/station-sdk', () => ({
  useSkillsQuery: () => ({
    data: imported ? [skillA, skillB] : [skillA],
    isPending: false,
    error: null,
    refetch: vi.fn().mockResolvedValue(undefined),
  }),
  useSkillQuery: (name: string | undefined) => ({
    data: name === 'skill-a' ? skillA : name === 'skill-b' ? skillB : undefined,
    isPending: false,
    error: null,
    refetch: vi.fn(),
  }),
  useImportSkills: () => ({
    isPending: false,
    mutateAsync: async () => {
      imported = true;
      return {
        imported: 1,
        results: [{ filename: 'skill-b.md', success: true, name: 'skill-b' }],
      };
    },
  }),
  useCreateLocalSkillMutation: () => ({
    isPending: false,
    mutateAsync: vi.fn(),
  }),
  useUpdateLocalSkillMutation: () => ({
    isPending: false,
    mutateAsync: vi.fn(),
  }),
  useUninstallSkillMutation: () => ({ isPending: false, mutate: vi.fn() }),
  useRunSkill: () => ({ isPending: false, mutateAsync: vi.fn() }),
}));

vi.mock('../contexts/AgentsContext', () => ({ useAgents: () => [] }));
vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://localhost' }),
}));
vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));
vi.mock('../hooks/useActiveChatSessions', () => ({
  useCreateChatSession: () => vi.fn(),
  useSendMessage: () => vi.fn(),
}));
vi.mock('../hooks/useCloseShortcut', () => ({ useCloseShortcut: vi.fn() }));

beforeEach(() => {
  imported = false;
  navigationStore.navigate('/guidance/skill-a', { tab: 'skills' });
});

afterEach(() => {
  cleanup();
  navigationStore.navigate('/');
});

test.each(['Cancel', 'Discard'])(
  'opening an imported skill honors %s through the navigation owner',
  async (decision) => {
    render(
      <NavigationProvider>
        <SkillsView basePath="/guidance" />
      </NavigationProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Edit skill' }));
    fireEvent.change(screen.getByLabelText('Body'), {
      target: { value: 'Unsaved original instructions' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Import .md' }));
    const fileInput = document.querySelector('input[type="file"]');
    expect(fileInput).not.toBeNull();
    fireEvent.change(fileInput!, {
      target: { files: [new File(['Imported instructions'], 'skill-b.md')] },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Import 1' }));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Open skill-b' }),
    );

    expect(
      screen.getByRole('dialog', { name: 'Unsaved Changes' }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: decision }));
    if (decision === 'Cancel') {
      expect(navigationStore.getSnapshot().pathname).toBe('/guidance/skill-a');
      expect((screen.getByLabelText('Body') as HTMLTextAreaElement).value).toBe(
        'Unsaved original instructions',
      );
      expect(screen.getByText('unsaved')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'skill-b' }));
      expect(
        screen.getByRole('dialog', { name: 'Unsaved Changes' }),
      ).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(navigationStore.getSnapshot().pathname).toBe('/guidance/skill-a');
      return;
    }
    expect(navigationStore.getSnapshot().pathname).toBe('/guidance/skill-b');
    expect(screen.getByRole('region', { name: 'Skill overview' })).toBeTruthy();
    expect(screen.getAllByText('Imported skill').length).toBeGreaterThan(0);
    expect(
      screen.queryByRole('dialog', { name: 'Unsaved Changes' }),
    ).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Edit skill' }));
    expect((screen.getByLabelText('Body') as HTMLTextAreaElement).value).toBe(
      'Imported instructions',
    );
  },
);
