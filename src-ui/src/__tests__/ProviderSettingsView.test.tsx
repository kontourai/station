/**
 * @vitest-environment jsdom
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const saveMutate = vi.fn();
const testMutate = vi.fn();
const deleteMutate = vi.fn();
let saveMutationState: { isPending: boolean } = { isPending: false };
let saveMutationOptions: {
  onError?: (error: Error) => void;
  onSuccess?: (saved: { id: string }, variables: unknown) => void;
} = {};
let modelConnections: unknown[] = [];
let modelConnectionsError: Error | null = null;
const refetchModelConnections = vi.fn();

vi.mock('@kontourai/station-sdk', () => ({
  ConnectionModelSelectionError: class ConnectionModelSelectionError extends Error {
    modelOptions: Array<{ id: string; name: string; originalId: string }>;

    constructor(
      message: string,
      modelOptions: Array<{ id: string; name: string; originalId: string }>,
    ) {
      super(message);
      this.modelOptions = modelOptions;
    }
  },
  useModelConnectionsQuery: () => ({
    data: modelConnections,
    isLoading: false,
    error: modelConnectionsError,
    refetch: refetchModelConnections,
  }),
  useConnectionsQuery: () => ({ data: [] }),
  useSystemStatusQuery: () => ({
    data: {
      providers: {
        detected: { ollama: true, bedrock: false },
      },
    },
  }),
  useSaveModelConnectionMutation: (options: typeof saveMutationOptions) => {
    saveMutationOptions = options;
    return {
      mutate: saveMutate,
      isPending: saveMutationState.isPending,
    };
  },
  useDeleteModelConnectionMutation: () => ({
    mutate: deleteMutate,
    isPending: false,
  }),
  useTestModelConnectionMutation: () => ({
    mutate: testMutate,
    isPending: false,
  }),
  useAwsProfilesQuery: () => ({
    data: undefined,
    isLoading: true,
    isError: false,
    error: null,
  }),
}));

vi.mock('../hooks/useACPConnections', () => ({
  useACPConnections: () => ({ data: [] }),
  useACPConnectionRegistry: () => ({ data: [] }),
}));

vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate: vi.fn() }),
}));

import { deviceSettingsStore } from '../lib/device-settings-store';
import { resetModelPickerPreferencesCacheForTests } from '../settings/modelPickerPreferences';
import { ProviderSettingsView } from '../views/ProviderSettingsView';

describe('ProviderSettingsView — Ollama dedup client debounce (#191 R5)', () => {
  const onNavigate = vi.fn();

  beforeEach(() => {
    saveMutate.mockReset();
    testMutate.mockReset();
    deleteMutate.mockReset();
    onNavigate.mockReset();
    saveMutationState = { isPending: false };
    saveMutationOptions = {};
    modelConnections = [];
    modelConnectionsError = null;
    refetchModelConnections.mockReset();
    window.localStorage.clear();
    resetModelPickerPreferencesCacheForTests();
    window.history.replaceState({}, '', '/connections/providers');
  });

  // archive#771 regression: `isLoading` was consulted by `SplitPaneLayout`'s
  // `loading` prop but the query's `error` was never passed through, so a
  // settled read failure rendered the same "no model connections" empty
  // state as a host with none configured.
  test('renders the providers list error state with retry when the model-connections query fails', () => {
    modelConnections = [];
    modelConnectionsError = new Error('model connections unavailable');

    render(<ProviderSettingsView onNavigate={onNavigate} />);

    expect(screen.getByText('model connections unavailable')).toBeTruthy();
    expect(screen.queryByText('No model connections yet')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetchModelConnections).toHaveBeenCalledTimes(1);
  });

  test('the detected-Ollama quickstart button is enabled while no save is in flight', () => {
    render(<ProviderSettingsView onNavigate={onNavigate} />);

    const button = screen.getByRole('button', {
      name: /Add detected Ollama/,
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });

  // archive#4463 (then /):
  // four states through the real view, each with exactly ONE empty message
  // the detail panel's own "nothing to select" label used to restate
  // whichever fact the list pane had already stated (genuinely-empty OR
  // filtered-to-nothing), and a typed query over an already-empty
  // collection used to misattribute the emptiness to the search.
  describe('exactly one empty message per state (H2a, M2, M3)', () => {
    test('genuinely empty: the list states the fact, the detail panel does not restate it', () => {
      render(<ProviderSettingsView onNavigate={onNavigate} />);

      // The list pane's own listEmptyTitle is the ONE place this is
      // said — the detail panel's compact Empty is suppressed entirely
      // (: llmEmbeddingProviders.length === 0).
      expect(screen.getAllByText('No model connections yet')).toHaveLength(1);
      expect(
        screen.queryByText('Add a model connection to power chats and agents.'),
      ).toBeNull();
      expect(screen.queryByText('Select a model connection')).toBeNull();
      // The quickstart/detected-actions panel and the (always-useful)
      // provider stack overview still stand alone.
      expect(
        screen.getByRole('button', { name: /Add detected Ollama/ }),
      ).toBeTruthy();
    });

    test('filtered to nothing: FilteredEmpty is the one message, the detail panel defers too', () => {
      modelConnections = [
        {
          id: 'bedrock-prod',
          kind: 'model',
          type: 'bedrock',
          name: 'Bedrock · Prod',
          config: {},
          enabled: true,
          capabilities: ['llm'],
          status: 'ready',
          prerequisites: [],
        },
      ];
      render(<ProviderSettingsView onNavigate={onNavigate} />);

      fireEvent.change(
        screen.getByPlaceholderText('Search model connections…'),
        { target: { value: 'zzz-does-not-match' } },
      );

      expect(screen.queryByText('No model connections yet')).toBeNull();
      expect(
        screen.getByText(
          'Nothing in model connections matches “zzz-does-not-match”',
        ),
      ).toBeTruthy();
      // a connection exists but is filtered off the list, so the detail
      // panel's "Select a model connection" is ALSO suppressed now — it
      // would otherwise be a second message on top of FilteredEmpty.
      expect(screen.queryByText('Select a model connection')).toBeNull();
      // The (always-useful, unfiltered) provider stack overview still
      // shows the real connection regardless of the list's search.
      expect(
        screen.getByRole('button', { name: /Bedrock · Prod/ }),
      ).toBeTruthy();
    });

    test('populated, nothing selected: the detail panel says "Select a model connection" exactly once', () => {
      modelConnections = [
        {
          id: 'bedrock-prod',
          kind: 'model',
          type: 'bedrock',
          name: 'Bedrock · Prod',
          config: {},
          enabled: true,
          capabilities: ['llm'],
          status: 'ready',
          prerequisites: [],
        },
      ];
      render(<ProviderSettingsView onNavigate={onNavigate} />);

      expect(screen.queryByText('No model connections yet')).toBeNull();
      expect(screen.getAllByText('Select a model connection')).toHaveLength(1);
    });

    // modelConnections is EMPTY (nothing exists regardless of the
    // query), so a typed query must not make this read as "your search
    // matched nothing" — collectionEmpty routes it to the plain empty state.
    test('empty collection + a typed query: the plain empty state, never "Nothing matches"', () => {
      render(<ProviderSettingsView onNavigate={onNavigate} />);

      fireEvent.change(
        screen.getByPlaceholderText('Search model connections…'),
        { target: { value: 'anything' } },
      );

      expect(screen.getAllByText('No model connections yet')).toHaveLength(1);
      expect(
        screen.queryByText(/Nothing in model connections matches/),
      ).toBeNull();
      expect(screen.queryByRole('button', { name: 'Clear filter' })).toBeNull();
    });
  });

  test('uses the provider catalog for Quick Setup, including recognizable presets', () => {
    render(<ProviderSettingsView onNavigate={onNavigate} />);

    expect(
      screen.getByRole('heading', { name: 'Station model connections' }),
    ).toBeTruthy();
    expect(
      screen
        .getAllByRole('button')
        .some((button) => button.textContent?.startsWith('OpenAI')),
    ).toBe(true);
    expect(screen.getByRole('button', { name: /LiteLLM/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Amazon Bedrock/ })).toBeTruthy();
  });

  test('manages model favorites, visibility, and order on this device', () => {
    modelConnections = [
      {
        id: 'bedrock-prod',
        kind: 'model',
        type: 'bedrock',
        name: 'Bedrock · Prod',
        config: {
          modelOptions: [
            { id: 'sonnet', name: 'Claude Sonnet' },
            { id: 'haiku', name: 'Claude Haiku' },
          ],
        },
        enabled: true,
        capabilities: ['llm'],
        status: 'ready',
        prerequisites: [],
      },
    ];
    render(
      <ProviderSettingsView
        selectedProviderId="bedrock-prod"
        onNavigate={onNavigate}
      />,
    );

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Add Claude Sonnet to favorites',
      }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Move Claude Sonnet down' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Hide Claude Sonnet' }));

    // archive#settings-revamp (archive#1359 convergence): model-picker
    // preferences now live in the registry-driven envelope's
    // `modelPickerPreferences` entry, not the retired
    // `station.device-settings` root.
    const saved = deviceSettingsStore.get('modelPickerPreferences');
    expect(saved.favorites).toContain('bedrock-prod\u001fsonnet');
    expect(saved.hidden).toContain('bedrock-prod\u001fsonnet');
    expect(saved.order).toEqual([
      'bedrock-prod\u001fhaiku',
      'bedrock-prod\u001fsonnet',
    ]);
  });

  // 6- — the list rail carried no readiness at all (a green dot meaning
  // `enabled`) while the hub card for the same connection asserted "Ready".
  // One resolver feeds both, so they cannot disagree about one connection.
  test('the provider list carries the same readiness the hub card does', () => {
    modelConnections = [
      {
        id: 'anthropic-1',
        kind: 'model',
        type: 'anthropic',
        name: 'Anthropic',
        config: {},
        enabled: true,
        capabilities: ['llm'],
        status: 'ready',
        prerequisites: [],
        readinessEvidence: {
          evidenceVersion: 1,
          level: 'prerequisite-ready',
          observedAt: '2026-08-20T10:00:00.000Z',
          freshness: 'fresh',
          summary: 'Required prerequisites are currently satisfied.',
          smoke: { status: 'not-tested', freshness: 'unknown', turnLimit: 1 },
          check: { status: 'not-checked' },
        },
      },
    ];
    render(<ProviderSettingsView onNavigate={onNavigate} />);

    expect(screen.getByText(/Saved — not verified · LLM/)).toBeTruthy();
  });

  // agent delete has always opened a confirm modal; provider delete
  // was a single click that removed the connection and its saved API key from
  // disk with no confirmation of any kind.
  test('provider delete confirms before removing the connection', () => {
    modelConnections = [
      {
        id: 'anthropic-1',
        kind: 'model',
        type: 'anthropic',
        name: 'Anthropic',
        config: {},
        enabled: true,
        capabilities: ['llm'],
        status: 'ready',
        prerequisites: [],
      },
    ];
    render(
      <ProviderSettingsView
        selectedProviderId="anthropic-1"
        onNavigate={onNavigate}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(deleteMutate).not.toHaveBeenCalled();

    const dialog = screen.getByRole('alertdialog');
    expect(dialog.textContent).toContain('Delete provider');
    expect(dialog.textContent).toContain('This cannot be undone.');

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(deleteMutate).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(
      screen
        .getAllByRole('button', { name: 'Delete' })
        .find((button) =>
          button.closest('.station-dialog__footer'),
        ) as HTMLElement,
    );
    expect(deleteMutate).toHaveBeenCalledWith('anthropic-1');
  });

  // The draft stays on `new` until it is created. It used to navigate to the
  // not-yet-created id the moment a type was picked, which reads fine here —
  // this suite re-renders the SAME component instance — but the app shell
  // remounts a route subtree when the route's identity changes, and the id is
  // part of that identity. In the product that navigation threw the draft
  // away and left a blank pane with no Create button.
  test('continues the deep-linked new selection into a resumable setup draft', async () => {
    render(
      <ProviderSettingsView selectedProviderId="new" onNavigate={onNavigate} />,
    );

    expect(screen.getByRole('heading', { name: 'Add provider' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /LiteLLM/ }));

    expect(
      await screen.findByRole('heading', { name: 'Connect LiteLLM' }),
    ).toBeTruthy();
    expect(screen.getByLabelText('Server URL')).toHaveProperty(
      'value',
      'http://localhost:4000/v1',
    );
    expect(screen.getByText('Setup required')).toBeTruthy();
    expect(screen.getByText('Advanced').parentElement).not.toHaveProperty(
      'open',
      true,
    );
    // The route may move to `new` (a stable identity for a draft) but never
    // to a generated id the server has never heard of — that navigation is
    // what destroyed the draft.
    for (const call of onNavigate.mock.calls) {
      expect(call[0]).toEqual({ type: 'connections-provider-edit', id: 'new' });
    }
    expect(saveMutate).not.toHaveBeenCalled();
    expect(testMutate).not.toHaveBeenCalled();
  });

  test('creating the draft posts it under a real id, and the route follows the saved connection', async () => {
    render(
      <ProviderSettingsView selectedProviderId="new" onNavigate={onNavigate} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /LiteLLM/ }));
    await screen.findByRole('heading', { name: 'Connect LiteLLM' });
    await screen.findByRole('heading', { name: 'Connect LiteLLM' });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    const created = saveMutate.mock.calls.at(-1)?.[0] as {
      connection: { id: string };
      isNew: boolean;
    };
    expect(created.isNew).toBe(true);
    expect(created.connection.id).not.toBe('new');
    expect(created.connection.id.length).toBeGreaterThan(8);

    act(() => {
      saveMutationOptions.onSuccess?.({ id: created.connection.id }, undefined);
    });
    expect(onNavigate).toHaveBeenCalledWith({
      type: 'connections-provider-edit',
      id: created.connection.id,
    });
  });

  test('defers a dirty draft selection change until discard is confirmed', () => {
    modelConnections = [
      {
        id: 'first',
        kind: 'model',
        type: 'ollama',
        name: 'First provider',
        config: { baseUrl: 'http://localhost:11434' },
        enabled: true,
        capabilities: ['llm'],
        status: 'ready',
        prerequisites: [],
        lastCheckedAt: null,
      },
      {
        id: 'second',
        kind: 'model',
        type: 'ollama',
        name: 'Second provider',
        config: { baseUrl: 'http://localhost:11435' },
        enabled: true,
        capabilities: ['llm'],
        status: 'ready',
        prerequisites: [],
        lastCheckedAt: null,
      },
    ];
    render(
      <ProviderSettingsView
        selectedProviderId="first"
        onNavigate={onNavigate}
      />,
    );

    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Edited provider' },
    });
    fireEvent.click(screen.getByText('Second provider'));

    expect(
      screen.getByRole('dialog', { name: 'Unsaved Changes' }),
    ).toBeTruthy();
    expect(onNavigate).not.toHaveBeenCalledWith({
      type: 'connections-provider-edit',
      id: 'second',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(onNavigate).toHaveBeenCalledWith({
      type: 'connections-provider-edit',
      id: 'second',
    });
  });

  test('disables the detected-Ollama quickstart button while a connection save is pending', () => {
    saveMutationState = { isPending: true };
    render(<ProviderSettingsView onNavigate={onNavigate} />);

    const button = screen.getByRole('button', {
      name: /Add detected Ollama/,
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  test('a click on the quickstart button while disabled does not stage another draft (no second onNavigate)', () => {
    saveMutationState = { isPending: true };
    render(<ProviderSettingsView onNavigate={onNavigate} />);

    const button = screen.getByRole('button', { name: /Add detected Ollama/ });
    fireEvent.click(button);

    expect(onNavigate).not.toHaveBeenCalled();
  });

  test('an ambiguous Ollama catalog becomes an inline model selector', async () => {
    const view = render(<ProviderSettingsView onNavigate={onNavigate} />);
    fireEvent.click(
      screen.getByRole('button', { name: /Add detected Ollama/ }),
    );
    // Quick setup composes the draft and moves the route to `new`, which the
    // app shell does for real; mirror it here, then read the id from what the
    // create posts (the draft's id never appears in a navigation).
    view.rerender(
      <ProviderSettingsView selectedProviderId="new" onNavigate={onNavigate} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    const created = saveMutate.mock.calls.at(-1)?.[0] as {
      connection: { id: string };
    };
    expect(created).toBeDefined();
    const selectedId = created.connection.id;
    modelConnections = [
      {
        id: selectedId,
        kind: 'model',
        type: 'ollama',
        name: 'Local Ollama',
        config: { baseUrl: 'http://localhost:11434' },
        enabled: true,
        capabilities: ['llm'],
        status: 'ready',
        prerequisites: [],
        lastCheckedAt: null,
      },
    ];
    view.rerender(
      <ProviderSettingsView
        selectedProviderId={selectedId}
        onNavigate={onNavigate}
      />,
    );

    const SelectionError = (await import('@kontourai/station-sdk'))
      .ConnectionModelSelectionError;
    act(() => {
      saveMutationOptions.onError?.(
        new SelectionError('Choose which installed Ollama model to use.', [
          { id: 'llama3.2', name: 'Llama 3.2', originalId: 'llama3.2' },
          { id: 'qwen3:30b', name: 'Qwen 3 30B', originalId: 'qwen3:30b' },
        ]),
      );
    });

    expect(
      screen.getByText('Choose which installed Ollama model to use.'),
    ).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Llama 3.2' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Qwen 3 30B' })).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Default model'), {
      target: { value: 'qwen3:30b' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(saveMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        connection: expect.objectContaining({
          config: {
            baseUrl: 'http://localhost:11434',
            defaultModel: 'qwen3:30b',
          },
        }),
      }),
    );
  });

  // / TESTS(d) : saving a Bedrock connection must
  // persist only the fields the selected authMode uses — a stale apiKey
  // left over from a prior mode switch must never reach the saved config.
  test('saving a profile-mode Bedrock connection omits the unused apiKey field entirely', () => {
    const selectedId = 'bedrock-conn';
    modelConnections = [
      {
        id: selectedId,
        kind: 'model',
        type: 'bedrock',
        name: 'AWS Bedrock',
        config: {
          region: 'us-east-1',
          authMode: 'profile',
          profile: 'work',
          apiKey: 'leftover-from-a-previous-mode',
        },
        enabled: true,
        capabilities: ['llm', 'embedding'],
        status: 'ready',
        prerequisites: [],
        lastCheckedAt: null,
      },
    ];
    render(
      <ProviderSettingsView
        selectedProviderId={selectedId}
        onNavigate={onNavigate}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(saveMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        connection: expect.objectContaining({
          config: { region: 'us-east-1', authMode: 'profile', profile: 'work' },
        }),
      }),
    );
    const [[savedArgs]] = saveMutate.mock.calls;
    expect(savedArgs.connection.config).not.toHaveProperty('apiKey');
  });

  // Save must be disabled — not merely
  // stripped-on-save — while a profile/api-key mode's required field is
  // still empty.
  test('disables Save for a profile-mode Bedrock connection with no profile chosen yet', () => {
    const selectedId = 'bedrock-conn-incomplete';
    modelConnections = [
      {
        id: selectedId,
        kind: 'model',
        type: 'bedrock',
        name: 'AWS Bedrock',
        config: { region: 'us-east-1', authMode: 'profile' },
        enabled: true,
        capabilities: ['llm', 'embedding'],
        status: 'ready',
        prerequisites: [],
        lastCheckedAt: null,
      },
    ];
    render(
      <ProviderSettingsView
        selectedProviderId={selectedId}
        onNavigate={onNavigate}
      />,
    );

    const saveButton = screen.getByRole('button', {
      name: 'Save',
    }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);

    fireEvent.click(saveButton);
    expect(saveMutate).not.toHaveBeenCalled();
  });

  test('keeps Save available for a Bedrock connection with a redacted saved API key', () => {
    const selectedId = 'bedrock-saved-key';
    modelConnections = [
      {
        id: selectedId,
        kind: 'model',
        type: 'bedrock',
        name: 'AWS Bedrock',
        config: {
          region: 'us-east-1',
          authMode: 'api-key',
          apiKeyConfigured: true,
        },
        enabled: true,
        capabilities: ['llm', 'embedding'],
        status: 'ready',
        prerequisites: [],
        lastCheckedAt: null,
      },
    ];
    render(
      <ProviderSettingsView
        selectedProviderId={selectedId}
        onNavigate={onNavigate}
      />,
    );

    const saveButton = screen.getByRole('button', {
      name: 'Save',
    }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(false);
    fireEvent.click(saveButton);
    expect(saveMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        connection: expect.objectContaining({
          config: expect.objectContaining({ apiKeyConfigured: true }),
        }),
      }),
    );
  });
});

describe('ProviderSettingsView — server refetch must not clobber edits (#794)', () => {
  const onNavigate = vi.fn();
  const PROVIDER_ID = 'ollama-existing';

  // What the server currently has: no default model chosen yet.
  const storedConnection = () => ({
    id: PROVIDER_ID,
    kind: 'model',
    type: 'ollama',
    name: 'Local Ollama',
    config: { baseUrl: 'http://localhost:11434' },
    enabled: true,
    capabilities: ['llm'],
    status: 'ready',
    prerequisites: [],
    lastCheckedAt: null,
  });

  beforeEach(() => {
    saveMutate.mockReset();
    onNavigate.mockReset();
    saveMutationState = { isPending: false };
    saveMutationOptions = {};
    modelConnections = [storedConnection()];
  });

  test('a provider refetch landing mid-edit does not discard the picked default model', () => {
    const view = render(
      <ProviderSettingsView
        selectedProviderId={PROVIDER_ID}
        onNavigate={onNavigate}
      />,
    );

    fireEvent.change(screen.getByLabelText('Default model'), {
      target: { value: 'qwen3:30b' },
    });

    // Test Connection triggers a provider refetch; a background refetch shortly
    // after page load does the same. Either way fresh server data arrives as a
    // new array identity while the field is dirty — and the server copy still
    // has no defaultModel, because the user has not saved yet.
    modelConnections = [storedConnection()];
    view.rerender(
      <ProviderSettingsView
        selectedProviderId={PROVIDER_ID}
        onNavigate={onNavigate}
      />,
    );

    expect(
      (screen.getByLabelText('Default model') as HTMLInputElement).value,
    ).toBe('qwen3:30b');

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(saveMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        connection: expect.objectContaining({
          config: expect.objectContaining({ defaultModel: 'qwen3:30b' }),
        }),
      }),
    );
  });

  test('a field the user has not touched still picks up server changes', () => {
    const view = render(
      <ProviderSettingsView
        selectedProviderId={PROVIDER_ID}
        onNavigate={onNavigate}
      />,
    );

    fireEvent.change(screen.getByLabelText('Default model'), {
      target: { value: 'qwen3:30b' },
    });

    // Only the model was edited. A refetch carrying a rename made elsewhere
    // must land — merging, not freezing the form, is the point.
    modelConnections = [{ ...storedConnection(), name: 'Renamed elsewhere' }];
    view.rerender(
      <ProviderSettingsView
        selectedProviderId={PROVIDER_ID}
        onNavigate={onNavigate}
      />,
    );

    // The Name label carries no htmlFor, so match the input by its value.
    expect(screen.getByDisplayValue('Renamed elsewhere')).toBeTruthy();
    expect(
      (screen.getByLabelText('Default model') as HTMLInputElement).value,
    ).toBe('qwen3:30b');
  });

  test("an edit made while a save is in flight survives that save's own refetch", () => {
    // handleSave snapshots the payload, so anything typed during the round trip
    // was never sent. Clearing the whole dirty set on success would let the
    // save's own invalidation revert it — the same silent drop this file fixes,
    // narrowed to the round-trip window.
    const view = render(
      <ProviderSettingsView
        selectedProviderId={PROVIDER_ID}
        onNavigate={onNavigate}
      />,
    );

    fireEvent.change(screen.getByLabelText('Default model'), {
      target: { value: 'qwen3:30b' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    // Still typing while the request is out.
    fireEvent.change(screen.getByLabelText('Default model'), {
      target: { value: 'llama3.2' },
    });

    // The save resolves with only what was submitted, then its refetch lands.
    act(() => {
      saveMutationOptions.onSuccess?.({ id: PROVIDER_ID }, undefined);
    });
    modelConnections = [
      {
        ...storedConnection(),
        config: {
          baseUrl: 'http://localhost:11434',
          defaultModel: 'qwen3:30b',
        },
      },
    ];
    view.rerender(
      <ProviderSettingsView
        selectedProviderId={PROVIDER_ID}
        onNavigate={onNavigate}
      />,
    );

    expect(
      (screen.getByLabelText('Default model') as HTMLInputElement).value,
    ).toBe('llama3.2');
  });

  test('selecting a different provider still re-seeds the form from server data', () => {
    const other = {
      ...storedConnection(),
      id: 'ollama-other',
      name: 'Other Ollama',
      config: { baseUrl: 'http://localhost:11435', defaultModel: 'llama3.2' },
    };
    modelConnections = [storedConnection(), other];

    const view = render(
      <ProviderSettingsView
        selectedProviderId={PROVIDER_ID}
        onNavigate={onNavigate}
      />,
    );
    fireEvent.change(screen.getByLabelText('Default model'), {
      target: { value: 'qwen3:30b' },
    });

    view.rerender(
      <ProviderSettingsView
        selectedProviderId="ollama-other"
        onNavigate={onNavigate}
      />,
    );

    expect(
      (screen.getByLabelText('Default model') as HTMLInputElement).value,
    ).toBe('llama3.2');
  });
});
