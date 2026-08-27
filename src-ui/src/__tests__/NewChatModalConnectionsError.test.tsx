// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import { NewChatModal } from '../components/modals/NewChatModal';
import { GLOBAL_CONTEXT } from '../components/modals/new-chat-modal-utils';

// Minimal SDK mock: NewChatModal's Enable action posts through this mutation,
// and a mocked `useNewChatSelectionModel` below removes every other query.
vi.mock('@kontourai/station-sdk', () => ({
  useMaterializeEngineAgentMutation: () => ({ mutateAsync: vi.fn() }),
  authenticatedFetch: vi.fn(async () => ({ ok: false })),
}));

vi.mock('../hooks/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('../hooks/useDevicePresentation', () => ({
  useDevicePresentation: () => undefined,
}));

const refetchAgentConnections = vi.fn();
const refetchModelConnections = vi.fn();
let runtimeLoading = false;
let modelsLoading = false;
let runtimeError: unknown;
let modelsError: unknown;

const emptyViewModel = {
  isGlobal: true,
  selectedProject: undefined,
  contextOptions: [
    { value: GLOBAL_CONTEXT, label: 'No workspace', glyph: 'globe' },
  ],
  filteredContextOptions: [
    { value: GLOBAL_CONTEXT, label: 'No workspace', glyph: 'globe' },
  ],
  currentContextOption: {
    value: GLOBAL_CONTEXT,
    label: 'No workspace',
    glyph: 'globe',
  },
  groups: [],
  flatList: [],
  compatibilityMessage: undefined,
};

vi.mock('../hooks/useNewChatSelectionModel', () => ({
  useNewChatSelectionModel: () => ({
    viewModel: emptyViewModel,
    agentConnections: [],
    modelConnections: [],
    acpConnections: [],
    runtimeLoading,
    modelsLoading,
    runtimeError,
    modelsError,
    refetchAgentConnections,
    refetchModelConnections,
    modelPickerAgent: null,
    setModelPickerAgent: vi.fn(),
    modelChoices: {},
    setModelChoices: vi.fn(),
    modelsForAgent: () => [],
    modelChoiceKey: (agent: { slug: string }) => agent.slug,
    defaultEffectiveModelForAgent: () => undefined,
  }),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockReturnValue({ matches: false }),
  });
  Element.prototype.scrollIntoView = vi.fn();
});

/**
 * station#771 regression. `NewChatModal`'s empty-list branch used to check
 * only `runtimeLoading || modelsLoading` — a settled read failure fell
 * straight through to "Nothing to chat with yet", identical to a host with
 * genuinely no engines or model connections configured, with no error and no
 * retry.
 */
describe('NewChatModal connections read failure (#771)', () => {
  beforeEach(() => {
    runtimeLoading = false;
    modelsLoading = false;
    runtimeError = undefined;
    modelsError = undefined;
    refetchAgentConnections.mockReset();
    refetchModelConnections.mockReset();
  });

  test('renders an error state with retry instead of the empty state when the engine connections read fails', () => {
    runtimeError = new Error('engine connections unavailable');

    render(
      <NewChatModal
        agents={[]}
        projects={[]}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("Couldn't load engines or models")).toBeTruthy();
    expect(screen.queryByText('Nothing to chat with yet')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetchAgentConnections).toHaveBeenCalledTimes(1);
    expect(refetchModelConnections).not.toHaveBeenCalled();
  });

  test('renders an error state with retry instead of the empty state when the model connections read fails', () => {
    modelsError = new Error('model connections unavailable');

    render(
      <NewChatModal
        agents={[]}
        projects={[]}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("Couldn't load engines or models")).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetchModelConnections).toHaveBeenCalledTimes(1);
    expect(refetchAgentConnections).not.toHaveBeenCalled();
  });

  test('still shows the genuine empty state when nothing errored and nothing is configured', () => {
    render(
      <NewChatModal
        agents={[]}
        projects={[]}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('Nothing to chat with yet')).toBeTruthy();
    expect(screen.queryByText("Couldn't load engines or models")).toBeNull();
  });
});
