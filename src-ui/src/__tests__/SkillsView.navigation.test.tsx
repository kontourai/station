// @vitest-environment jsdom

import type { Skill } from '@kontourai/station-contracts/catalog';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { _setApiBase } from '../../../packages/sdk/src/api-core';
import { routeSurfaceIdentity } from '../app-shell/route-identity';
import { resolveViewFromPath } from '../app-shell/routing';
import type { useHostRequestAuthorityScope } from '../contexts/ApiBaseContext';
import { KeyboardShortcutsProvider } from '../contexts/KeyboardShortcutsContext';
import {
  NavigationProvider,
  navigationStore,
  useNavigation,
} from '../contexts/NavigationContext';
import { GuidanceView } from '../views/GuidanceView';
import { SkillsView } from '../views/SkillsView';
import { chooseOverflow } from './helpers/overflow-menu';

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
const deleteRequestMock = vi.fn<typeof fetch>();
const removedSkills = new Set<string>();
let queryClient: QueryClient;
const requestAuthorityScope = {
  apiBase: 'http://localhost',
  authorityKey: 'skills-navigation-fixture',
  isCurrent: () => true,
} satisfies NonNullable<ReturnType<typeof useHostRequestAuthorityScope>>;

function RoutedGuidance() {
  const { pathname } = useNavigation();
  const route = resolveViewFromPath(`${pathname}${window.location.search}`);
  if (route.type !== 'guidance') return <div>Outside Skills</div>;
  return (
    <div key={routeSurfaceIdentity(route)}>
      <GuidanceView route={route} />
    </div>
  );
}

function mountRoutedLibrary() {
  return render(
    <QueryClientProvider client={queryClient}>
      <NavigationProvider>
        <KeyboardShortcutsProvider>
          <RoutedGuidance />
        </KeyboardShortcutsProvider>
      </NavigationProvider>
    </QueryClientProvider>,
  );
}

function library() {
  return (
    <QueryClientProvider client={queryClient}>
      <NavigationProvider>
        <KeyboardShortcutsProvider>
          <SkillsView basePath="/guidance" />
        </KeyboardShortcutsProvider>
      </NavigationProvider>
    </QueryClientProvider>
  );
}

function mountLibrary() {
  return render(library());
}

vi.mock('@kontourai/station-sdk', async () => {
  const actual = await vi.importActual<typeof import('@kontourai/station-sdk')>(
    '@kontourai/station-sdk',
  );
  return {
    ...actual,
    useSkillsQuery: () => ({
      data: [
        skillA,
        ...(imported ? [skillB] : []),
        ...(createdSkill ? [createdSkill] : []),
      ].filter((skill) => !removedSkills.has(skill.name)),
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
    useUninstallSkillMutation: actual.useUninstallSkillMutation,
    useRunSkill: () => ({ isPending: false, mutateAsync: vi.fn() }),
  };
});

vi.mock('../contexts/AgentsContext', () => ({ useAgents: () => [] }));
vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://localhost' }),
  useHostRequestAuthorityScope: () => requestAuthorityScope,
}));
vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: showToastMock }),
}));
vi.mock('../hooks/useActiveChatSessions', () => ({
  useLaunchChat: () => vi.fn().mockResolvedValue('session-1'),
}));

beforeEach(() => {
  // jsdom clears its window-focus flag when the focused trigger is removed.
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  imported = false;
  createdSkill = null;
  createPending = false;
  showToastMock.mockReset();
  removedSkills.clear();
  queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  _setApiBase('http://localhost');
  deleteRequestMock.mockReset();
  vi.stubGlobal('fetch', deleteRequestMock);
  createSkillMock.mockReset().mockImplementation(async (payload) => {
    createdSkill = { ...payload, writable: true, origin: 'user' };
  });
  navigationStore.navigate('/guidance/skill-a', { tab: 'skills' });
  sessionStorage.setItem('station-guidance-tab', 'skills');
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  _setApiBase('');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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
    expect(showToastMock).toHaveBeenCalledWith('Try again in a moment.'),
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

function deferRemoval() {
  let resolve!: () => void;
  let reject!: () => void;
  const pending = new Promise<Response>((yes) => {
    resolve = () => {
      removedSkills.add('skill-a');
      yes(Response.json({ success: true }));
    };
    reject = () =>
      yes(
        Response.json(
          { success: false, error: 'Removal refused' },
          { status: 503 },
        ),
      );
  });
  deleteRequestMock.mockImplementationOnce(async () => pending);
  return { resolve, reject };
}

async function requestRemoval() {
  screen.getByRole('button', { name: 'More skill actions' }).focus();
  chooseOverflow('More skill actions', 'Remove');
  await waitFor(() => expect(deleteRequestMock).toHaveBeenCalledOnce());
  const [input, init] = deleteRequestMock.mock.calls[0];
  expect(String(input)).toBe('http://localhost/api/registry/skills/skill-a');
  expect(init?.method).toBe('DELETE');
}

test('removing a filtered skill preserves the query and returns keyboard focus to search', async () => {
  const removal = deferRemoval();
  mountRoutedLibrary();
  fireEvent.change(screen.getByPlaceholderText('Search skills…'), {
    target: { value: 'skill-a' },
  });
  await requestRemoval();
  await act(async () => removal.resolve());
  await waitFor(() =>
    expect(showToastMock).toHaveBeenCalledWith('Skill removed'),
  );
  await waitFor(() => expect(queryClient.isMutating()).toBe(0));
  await act(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );

  const search = screen.getByPlaceholderText('Search skills…');
  expect.soft((search as HTMLInputElement).value).toBe('skill-a');
  expect.soft(document.activeElement).toBe(search);
  expect(navigationStore.getSnapshot().pathname).toBe('/guidance');
  expect(screen.queryByRole('button', { name: 'skill-a' })).toBeNull();
});

test('a refused removal preserves the filtered selection and its retry trigger', async () => {
  const removal = deferRemoval();
  mountRoutedLibrary();
  fireEvent.change(screen.getByPlaceholderText('Search skills…'), {
    target: { value: 'skill-a' },
  });
  await requestRemoval();
  await act(async () => removal.reject());
  await waitFor(() =>
    expect(showToastMock).toHaveBeenCalledWith('Failed to remove skill'),
  );
  await waitFor(() => expect(queryClient.isMutating()).toBe(0));
  await act(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );

  expect(navigationStore.getSnapshot().pathname).toBe('/guidance/skill-a');
  expect(
    (screen.getByPlaceholderText('Search skills…') as HTMLInputElement).value,
  ).toBe('skill-a');
  expect(screen.getByRole('region', { name: 'Skill overview' })).toBeTruthy();
  expect(document.activeElement).toBe(
    screen.getByRole('button', { name: 'More skill actions' }),
  );
});

test.each(['connected control', 'another skill', 'outside Guidance'])(
  'late removal respects a deliberate move to %s',
  async (destination) => {
    imported = true;
    const removal = deferRemoval();
    mountRoutedLibrary();
    await requestRemoval();
    if (destination === 'connected control') {
      screen.getByPlaceholderText('Search skills…').focus();
    } else if (destination === 'another skill') {
      fireEvent.click(screen.getByRole('button', { name: 'skill-b' }));
      screen.getByRole('button', { name: 'Edit skill' }).focus();
    } else {
      act(() => navigationStore.navigate('/'));
    }
    const keeper = document.activeElement;
    await act(async () => removal.resolve());
    await waitFor(() => expect(queryClient.isMutating()).toBe(0));
    await act(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );

    expect(navigationStore.getSnapshot().pathname).toBe(
      destination === 'outside Guidance'
        ? '/'
        : destination === 'another skill'
          ? '/guidance/skill-b'
          : '/guidance',
    );
    expect(document.activeElement).toBe(keeper);
  },
);
