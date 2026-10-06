// @vitest-environment jsdom

import type { Skill } from '@kontourai/station-contracts/catalog';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { KeyboardShortcutsProvider } from '../contexts/KeyboardShortcutsContext';
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
let createdSkill: SkillRecord | null = null;
let createPending = false;
const createSkillMock = vi.fn<(payload: SkillRecord) => Promise<void>>();
const showToastMock = vi.fn();

function library() {
  return (
    <NavigationProvider>
      <KeyboardShortcutsProvider>
        <SkillsView basePath="/guidance" />
      </KeyboardShortcutsProvider>
    </NavigationProvider>
  );
}

function mountLibrary() {
  return render(library());
}

vi.mock('@kontourai/station-sdk', () => ({
  useSkillsQuery: () => ({
    data: [
      skillA,
      ...(imported ? [skillB] : []),
      ...(createdSkill ? [createdSkill] : []),
    ],
    isPending: false,
    error: null,
    refetch: vi.fn().mockResolvedValue(undefined),
  }),
  useSkillQuery: (name: string | undefined) => ({
    data:
      name === 'skill-a'
        ? skillA
        : name === 'skill-b'
          ? skillB
          : createdSkill?.name === name
            ? createdSkill
            : undefined,
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
    isPending: createPending,
    mutateAsync: createSkillMock,
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
  useToast: () => ({ showToast: showToastMock }),
}));
vi.mock('../hooks/useActiveChatSessions', () => ({
  useLaunchChat: () => vi.fn().mockResolvedValue('session-1'),
}));

beforeEach(() => {
  imported = false;
  createdSkill = null;
  createPending = false;
  showToastMock.mockReset();
  createSkillMock.mockReset().mockImplementation(async (payload) => {
    createdSkill = { ...payload, writable: true, origin: 'user' };
  });
  navigationStore.navigate('/guidance/skill-a', { tab: 'skills' });
});

afterEach(() => {
  cleanup();
  navigationStore.navigate('/');
});

test.each(['Cancel', 'Discard'])(
  'opening an imported skill honors %s through the navigation owner',
  async (decision) => {
    mountLibrary();
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

function fillNewSkill() {
  fireEvent.change(screen.getByLabelText('Name'), {
    target: { value: 'created-skill' },
  });
  fireEvent.change(screen.getByLabelText('Description'), {
    target: { value: 'A saved skill' },
  });
  fireEvent.change(screen.getByLabelText('Body'), {
    target: { value: 'Saved instructions' },
  });
}

test('a persisted Create opens the saved overview after dirty state becomes clean', async () => {
  navigationStore.navigate('/guidance/new', { tab: 'skills' });
  let finishCreate!: () => void;
  const pending = new Promise<void>((resolve) => {
    finishCreate = resolve;
  });
  createSkillMock.mockImplementationOnce(async (payload) => {
    createPending = true;
    await pending;
    createPending = false;
    createdSkill = { ...payload, origin: 'user', writable: true };
  });
  const mounted = mountLibrary();
  fillNewSkill();
  fireEvent.click(screen.getByRole('button', { name: 'Create' }));
  mounted.rerender(library());
  expect(screen.getByLabelText('Name').matches(':disabled')).toBe(true);
  expect(screen.getByLabelText('Body').matches(':disabled')).toBe(true);
  expect(
    screen
      .getByRole('switch', { name: 'Runnable as a slash command' })
      .matches(':disabled'),
  ).toBe(true);
  expect(navigationStore.getSnapshot().pathname).toBe('/guidance/new');
  expect(screen.getByText('unsaved')).toBeTruthy();
  expect(screen.queryByRole('region', { name: 'Skill overview' })).toBeNull();
  await act(async () => {
    finishCreate();
    await pending;
  });
  await waitFor(() =>
    expect(navigationStore.getSnapshot().pathname).toBe(
      '/guidance/created-skill',
    ),
  );
  expect(screen.getByRole('region', { name: 'Skill overview' })).toBeTruthy();
  expect(
    screen.getByRole('button', { name: 'Use in a new chat' }),
  ).toBeTruthy();
  expect(screen.queryByText('unsaved')).toBeNull();
  expect(screen.queryByRole('dialog', { name: 'Unsaved Changes' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Edit skill' }));
  expect((screen.getByLabelText('Body') as HTMLTextAreaElement).value).toBe(
    'Saved instructions',
  );
});

test('a failed Create retains the dirty draft and its exit protection', async () => {
  navigationStore.navigate('/guidance/new', { tab: 'skills' });
  createSkillMock.mockRejectedValueOnce(new Error('Create refused'));
  mountLibrary();
  fillNewSkill();
  fireEvent.click(screen.getByRole('button', { name: 'Create' }));
  await waitFor(() =>
    expect(showToastMock).toHaveBeenCalledWith('Create refused'),
  );
  expect(navigationStore.getSnapshot().pathname).toBe('/guidance/new');
  expect((screen.getByLabelText('Body') as HTMLTextAreaElement).value).toBe(
    'Saved instructions',
  );
  expect(screen.getByText('unsaved')).toBeTruthy();
  fireEvent.keyDown(document.body, { key: 'Escape' });
  expect(screen.getByRole('dialog', { name: 'Unsaved Changes' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(navigationStore.getSnapshot().pathname).toBe('/guidance/new');
  expect((screen.getByLabelText('Body') as HTMLTextAreaElement).value).toBe(
    'Saved instructions',
  );
});

test.each(['New skill', '← Back to list', 'Escape'])(
  '%s asks once and preserves the draft until canonical navigation is admitted',
  (action) => {
    mountLibrary();
    fireEvent.click(screen.getByRole('button', { name: 'Edit skill' }));
    fireEvent.change(screen.getByLabelText('Body'), {
      target: { value: 'Unsaved original instructions' },
    });
    const trigger = () => {
      if (action === 'Escape')
        fireEvent.keyDown(document.body, { key: 'Escape' });
      else fireEvent.click(screen.getByRole('button', { name: action }));
    };
    trigger();
    expect(
      screen.getByRole('dialog', { name: 'Unsaved Changes' }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(navigationStore.getSnapshot().pathname).toBe('/guidance/skill-a');
    expect((screen.getByLabelText('Body') as HTMLTextAreaElement).value).toBe(
      'Unsaved original instructions',
    );
    trigger();
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(navigationStore.getSnapshot().pathname).toBe(
      action === 'New skill' ? '/guidance/new' : '/guidance',
    );
    expect(
      screen.queryByRole('dialog', { name: 'Unsaved Changes' }),
    ).toBeNull();
    expect(screen.queryByText('unsaved')).toBeNull();
    if (action === 'New skill')
      expect((screen.getByLabelText('Body') as HTMLTextAreaElement).value).toBe(
        '',
      );
    else expect(screen.queryByLabelText('Body')).toBeNull();
  },
);

test('starting over in the current new-skill draft uses a local discard decision', () => {
  navigationStore.navigate('/guidance/new', { tab: 'skills' });
  mountLibrary();
  fillNewSkill();
  fireEvent.click(screen.getByRole('button', { name: 'New skill' }));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect((screen.getByLabelText('Body') as HTMLTextAreaElement).value).toBe(
    'Saved instructions',
  );
  fireEvent.click(screen.getByRole('button', { name: 'New skill' }));
  fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
  expect(navigationStore.getSnapshot().pathname).toBe('/guidance/new');
  expect((screen.getByLabelText('Body') as HTMLTextAreaElement).value).toBe('');
  expect(screen.queryByText('unsaved')).toBeNull();
});

test.each(['another skill', 'replacement draft'])(
  'a late Create response does not take over %s',
  async (destination) => {
    navigationStore.navigate('/guidance/new', { tab: 'skills' });
    let finishCreate!: () => void;
    const pending = new Promise<void>((resolve) => {
      finishCreate = resolve;
    });
    createSkillMock.mockImplementationOnce(async (payload) => {
      createPending = true;
      await pending;
      createPending = false;
      createdSkill = { ...payload, origin: 'user', writable: true };
    });
    const mounted = mountLibrary();
    fillNewSkill();
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    mounted.rerender(library());
    if (destination === 'another skill')
      fireEvent.keyDown(document.body, { key: 'Escape' });
    else fireEvent.click(screen.getByRole('button', { name: 'New skill' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    if (destination === 'another skill')
      fireEvent.click(screen.getByRole('button', { name: 'skill-a' }));
    await act(async () => {
      finishCreate();
      await pending;
    });
    mounted.rerender(library());
    expect(navigationStore.getSnapshot().pathname).toBe(
      destination === 'another skill' ? '/guidance/skill-a' : '/guidance/new',
    );
    if (destination === 'another skill') {
      expect(
        screen.getByRole('region', { name: 'Skill overview' }),
      ).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Edit skill' }));
      expect((screen.getByLabelText('Body') as HTMLTextAreaElement).value).toBe(
        'Original instructions',
      );
    } else {
      expect((screen.getByLabelText('Body') as HTMLTextAreaElement).value).toBe(
        '',
      );
    }
    expect(screen.queryByText('unsaved')).toBeNull();
  },
);
