// @vitest-environment jsdom

import {
  STATION_ENVELOPE_HEADER,
  STATION_ENVELOPE_HEADER_VALUE,
} from '@kontourai/station-contracts/http';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type React from 'react';
import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  ConversationHandoffDialog,
  HANDOFF_CATCH_UP_MESSAGE,
} from '../components/chat-dock/ConversationHandoffDialog';

const handoffConversationToStation = vi.fn();
const readCapability = vi.fn(async () => true);
const gitStatus = vi.fn();

vi.mock('@kontourai/station-sdk/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk/client')>()),
  handoffConversationToStation: (...args: unknown[]) =>
    handoffConversationToStation(...args),
  readConversationStationHandoffCapability: () => readCapability(),
}));
vi.mock('@kontourai/station-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk')>()),
  useFeaturePreviewsQuery: () => ({
    data: [{ id: 'paired-station-chats', enabled: true }],
  }),
  useGitStatusQuery: () => ({ data: gitStatus() }),
}));
vi.mock('../hooks/useNewChatSelectionModel', () => ({
  useNewChatSelectionModel: () => ({
    agentConnections: [],
    selectedProjectConfig: { agents: ['claude'] },
    modelsForAgent: () => [],
    executionModelsForAgent: () => [],
    defaultEffectiveModelForAgent: () => ({ id: undefined }),
  }),
}));
vi.mock('../hooks/useExecutionStationCatalog', () => ({
  useExecutionStations: () => ({
    settled: true,
    stations: [
      { id: 'current', name: 'Laptop', kind: 'current' },
      { id: 'receiver', name: 'Receiver', kind: 'paired' },
    ],
  }),
  useExecutionStationCatalog: () => ({
    stations: [],
    stationName: 'Receiver',
    loading: false,
    unmatched: false,
    models: [
      {
        id: 'model-r',
        name: 'Receiver model',
        available: true,
        executionAgentId: 'receiver-engine',
        expectedDefinitionFingerprint: 'sha256:profile',
      },
    ],
  }),
}));
const connection = {
  isCurrent: () => true,
  stationName: 'Receiver',
  capabilities: { startChat: { state: 'allowed' } },
  binding: { version: 1, environmentId: 'receiver', stationName: 'Receiver' },
};
vi.mock('../hooks/useConversationStartTarget', async () => {
  const React = await import('react');
  return {
    useConversationStartTarget: () => {
      const [context, choose] = React.useState<string>();
      return {
        active: true,
        connection,
        connectionError: undefined,
        reconnect: vi.fn(),
        projects: {
          isSuccess: true,
          isError: false,
          data: [{ slug: 'receiver-work', name: 'Receiver work' }],
        },
        context,
        choose,
        options: [
          { value: '__global__', label: 'No project' },
          { value: 'receiver-work', label: 'Receiver work' },
        ],
      };
    },
  };
});

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  });
});

const claude = {
  slug: 'claude',
  name: 'Claude',
  available: true,
  definitionFingerprint: 'sha256:profile',
  execution: { agentConnectionId: 'claude' },
};

const receipt = {
  version: 1,
  environmentId: 'receiver',
  conversationId: 'conversation:import:one',
  carriedMessages: 4,
  omittedMessages: 0,
  nonTextMessages: 0,
  idempotent: false,
};

function renderDialog(
  onContinuedOnStation = vi.fn(),
  extra: Partial<React.ComponentProps<typeof ConversationHandoffDialog>> = {},
) {
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <ConversationHandoffDialog
        apiBase="http://station.test"
        conversationId="conversation-a"
        sessionId="session-a"
        currentAgentId="claude"
        projectSlug="project-a"
        agents={[claude] as never}
        projects={
          [
            { slug: 'project-a', name: 'Project A', workingDirectory: '/w' },
          ] as never
        }
        initialMessage=""
        attachments={[]}
        onAccepted={vi.fn()}
        onDispatchStarted={vi.fn()}
        onDefiniteFailure={vi.fn()}
        onClose={vi.fn()}
        onContinuedOnStation={onContinuedOnStation}
        {...extra}
      />
    </QueryClientProvider>,
  );
  return { ...view, onContinuedOnStation };
}

async function chooseReceiver() {
  fireEvent.click(await screen.findByRole('radio', { name: 'Receiver' }));
  fireEvent.change(await screen.findByLabelText('Project on Receiver'), {
    target: { value: 'receiver-work' },
  });
}

describe('continuing a chat on a paired Station', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Queued one-shot answers must not leak into the next test.
    handoffConversationToStation.mockReset();
    sessionStorage.clear();
    readCapability.mockResolvedValue(true);
    gitStatus.mockReturnValue({
      isRepo: true,
      branch: 'main',
      changes: [],
      staged: 1,
      unstaged: 1,
      untracked: 0,
      ahead: 2,
      behind: 0,
      lastCommit: null,
    });
  });

  test('says what stays behind, retries an unconfirmed handoff with the same key, then hands the dock the new chat', async () => {
    const unconfirmed = Object.assign(new Error('Unconfirmed'), {
      status: 502,
      outcome: 'indeterminate',
    });
    handoffConversationToStation
      .mockRejectedValueOnce(unconfirmed)
      .mockResolvedValueOnce(receipt);
    const { onContinuedOnStation } = renderDialog();
    await chooseReceiver();
    expect(
      screen.getByText(
        '2 uncommitted changes and 2 unpushed commits on main stay on this machine. Commit and push first to use them there.',
      ),
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole('button', { name: 'Continue on Receiver' }),
    );
    expect(
      await screen.findByText(
        "Receiver didn't confirm the handoff. Retrying won't create a second chat.",
      ),
    ).toBeTruthy();
    expect(onContinuedOnStation).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry safely' }));
    await waitFor(() => expect(onContinuedOnStation).toHaveBeenCalledTimes(1));

    const [first, second] = handoffConversationToStation.mock.calls;
    expect(first![0]).toBe('http://station.test');
    expect(first![1]).toBe('receiver');
    expect(first![2]).toEqual({
      idempotencyKey: expect.any(String),
      conversationId: 'conversation-a',
      targetAgent: 'claude',
      projectSlug: 'receiver-work',
    });
    expect(second![2]).toEqual(first![2]);
    expect(onContinuedOnStation).toHaveBeenCalledWith(
      expect.objectContaining({
        connection,
        receipt,
        agentSlug: 'claude',
        projectSlug: 'receiver-work',
        projectName: 'Receiver work',
        executionAgentId: 'receiver-engine',
        expectedDefinitionFingerprint: 'sha256:profile',
        modelId: 'model-r',
        message: HANDOFF_CATCH_UP_MESSAGE,
      }),
    );
    // Settled: nothing is left to replay.
    expect(Object.keys(sessionStorage)).toEqual([]);
  });

  test("the source Station's definite refusal, read by the real client, is shown and the next attempt is a new request", async () => {
    const real = await vi.importActual<
      typeof import('@kontourai/station-sdk/client')
    >('@kontourai/station-sdk/client');
    const fetch = vi.fn(async () =>
      Response.json(
        {
          success: false,
          code: 'peer_conversation_handoff_refused',
          error: 'The paired Station refused this chat.',
        },
        {
          status: 424,
          headers: { [STATION_ENVELOPE_HEADER]: STATION_ENVELOPE_HEADER_VALUE },
        },
      ),
    );
    vi.stubGlobal('fetch', fetch);
    handoffConversationToStation
      .mockImplementationOnce((...args: unknown[]) =>
        real.handoffConversationToStation(
          ...(args as Parameters<typeof real.handoffConversationToStation>),
        ),
      )
      .mockResolvedValueOnce(receipt);
    try {
      const { onContinuedOnStation } = renderDialog();
      await chooseReceiver();
      fireEvent.click(
        screen.getByRole('button', { name: 'Continue on Receiver' }),
      );
      expect((await screen.findByRole('alert')).textContent).toBe(
        "Receiver didn't take this chat. Check that it has this Agent and the chosen project.",
      );
      expect(
        screen.getByRole('button', { name: 'Continue on Receiver' }),
      ).toBeTruthy();
      expect(Object.keys(sessionStorage)).toEqual([]);
      fireEvent.click(
        screen.getByRole('button', { name: 'Continue on Receiver' }),
      );
      await waitFor(() =>
        expect(onContinuedOnStation).toHaveBeenCalledTimes(1),
      );
      const [first, second] = handoffConversationToStation.mock.calls;
      expect(second![2].idempotencyKey).not.toBe(first![2].idempotencyKey);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('a reload during an unconfirmed handoff offers that same request again', async () => {
    handoffConversationToStation.mockRejectedValueOnce(
      Object.assign(new Error('lost'), { outcome: 'indeterminate' }),
    );
    const firstView = renderDialog();
    await chooseReceiver();
    fireEvent.click(
      screen.getByRole('button', { name: 'Continue on Receiver' }),
    );
    await screen.findByRole('button', { name: 'Retry safely' });
    const key = handoffConversationToStation.mock.calls[0]![2].idempotencyKey;
    firstView.unmount();

    handoffConversationToStation.mockResolvedValueOnce(receipt);
    const { onContinuedOnStation } = renderDialog();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Retry safely' }),
    );
    await waitFor(() => expect(onContinuedOnStation).toHaveBeenCalledTimes(1));
    expect(handoffConversationToStation.mock.calls[1]![2]).toEqual({
      idempotencyKey: key,
      conversationId: 'conversation-a',
      targetAgent: 'claude',
      projectSlug: 'receiver-work',
    });
  });

  test('offers no other Station when this one cannot hand a chat off', async () => {
    readCapability.mockResolvedValue(false);
    renderDialog();
    await waitFor(() => expect(readCapability).toHaveBeenCalled());
    expect(screen.queryByRole('radiogroup', { name: 'Station' })).toBeNull();
  });

  test.each([
    [
      'peer_conversation_handoff_access_refused',
      "Receiver didn't let this Station continue chats there. Check the pairing's access in Connections.",
    ],
    [
      'peer_conversation_handoff_pairing_required',
      'Receiver is connected with a device sign-in. Pair it as a Station in Connections to continue chats there.',
    ],
  ])('the refusal %s says why', async (code, message) => {
    const real = await vi.importActual<
      typeof import('@kontourai/station-sdk/client')
    >('@kontourai/station-sdk/client');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          { success: false, code, error: 'refused' },
          {
            status: 424,
            headers: {
              [STATION_ENVELOPE_HEADER]: STATION_ENVELOPE_HEADER_VALUE,
            },
          },
        ),
      ),
    );
    handoffConversationToStation.mockImplementationOnce((...args: unknown[]) =>
      real.handoffConversationToStation(
        ...(args as Parameters<typeof real.handoffConversationToStation>),
      ),
    );
    try {
      renderDialog();
      await chooseReceiver();
      fireEvent.click(
        screen.getByRole('button', { name: 'Continue on Receiver' }),
      );
      expect((await screen.findByRole('alert')).textContent).toBe(message);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("a typed draft leaves through the composer's send preparation and is cleared with its quotes", async () => {
    handoffConversationToStation.mockResolvedValueOnce(receipt);
    const quote = { id: 'q1', text: 'quoted' } as never;
    const prepareDraft = vi.fn(async () => ({
      text: 'Prepared: carry on @mention-expanded',
      draft: 'carry on',
      quotes: [quote],
    }));
    const { onContinuedOnStation } = renderDialog(vi.fn(), {
      initialMessage: 'carry on',
      prepareDraft,
    });
    await chooseReceiver();
    fireEvent.click(
      screen.getByRole('button', { name: 'Continue on Receiver' }),
    );
    await waitFor(() => expect(onContinuedOnStation).toHaveBeenCalledTimes(1));
    expect(prepareDraft).toHaveBeenCalledTimes(1);
    expect(onContinuedOnStation).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Prepared: carry on @mention-expanded',
        clearsComposer: true,
        sentQuotes: [quote],
      }),
    );
  });
});
