/** @vitest-environment jsdom */

/**
 * A phone layer's exits ask the unsaved-changes guards. The pull request
 * review pane keeps its typed comment in component state behind
 * `useUnsavedGuard`, and the layer's restore unmounts it; `dialog-history`'s
 * Back and the "‹ Chat" control are not route changes, so without this a
 * single Back discarded the draft. Driven with the REAL review panel (its own
 * guard registration) under the real provider, navigation store and history.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('@kontourai/station-sdk/pull-request-review', () => ({
  getPullRequestReview: async () => ({
    available: true,
    effectiveCapabilities: {
      list: true,
      detail: true,
      open: false,
      comment: true,
      approve: false,
      merge: false,
      autoMerge: false,
    },
    data: {
      pullRequest: {
        provider: 'github',
        host: 'github.com',
        repository: { owner: 'kontourai', name: 'station' },
        ref: '2049',
        nativeId: '2049',
        url: 'https://github.com/kontourai/station/pull/2049',
        title: 'Open panes over Chat',
        body: 'Body',
        state: 'open',
        author: { login: 'author' },
        sourceBranch: 'fix',
        targetBranch: 'main',
        commits: 1,
        reviewStatus: 'NONE',
        comments: 0,
        mergeability: 'mergeable',
      },
      headSha: 'a'.repeat(40),
      baseSha: 'b'.repeat(40),
      observedAt: '2026-09-10T00:00:00Z',
      diff: { state: 'unavailable', reason: 'Not supplied.' },
      discussion: [],
      discussionPartial: false,
    },
  }),
  mergeReviewedPullRequest: vi.fn(),
  submitPullRequestReview: vi.fn(),
}));
vi.mock('../ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => ({
    apiBase: 'http://station.test',
    authorityKey: 'test',
    isCurrent: () => true,
  }),
}));
vi.mock('../ActiveChatsContext', () => ({
  activeChatsStore: { getSnapshot: () => ({}) },
  useActiveChatActions: () => ({
    getDraft: () => '',
    setDraft: () => {},
    updateChat: () => {},
  }),
}));

import { PullRequestReviewPanel } from '../../components/coding-layout/PullRequestReviewPanel';
import { DIALOG_HISTORY_KEY } from '../../components/dialog-history';
import { MOBILE_MEDIA_QUERY } from '../../hooks/useIsMobile';
import { deviceSettingsStore } from '../../lib/device-settings-store';
import { KeyboardShortcutsProvider } from '../KeyboardShortcutsContext';
import { NavigationProvider } from '../NavigationContext';
import { navigationStore } from '../navigation-store';
import { RegionModelProvider, useRegionModel } from '../RegionModelContext';

const PR = 'pr:github.com/kontourai/station#2049';
let model: ReturnType<typeof useRegionModel> | null = null;

function Probe() {
  const value = useRegionModel();
  useEffect(() => {
    model = value;
  }, [value]);
  return null;
}

function current() {
  if (!model) throw new Error('probe never rendered');
  return model;
}

function onLayerEntry(): boolean {
  const marker = (window.history.state as Record<string, unknown> | null)?.[
    DIALOG_HISTORY_KEY
  ];
  return typeof marker === 'string' && marker.startsWith('phone-pane-layer:');
}

async function mountWithDraft() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <KeyboardShortcutsProvider>
        <NavigationProvider>
          <RegionModelProvider>
            <Probe />
            <PullRequestReviewPanel
              target={{
                provider: 'github',
                host: 'github.com',
                owner: 'kontourai',
                repository: 'station',
                ref: '2049',
                project: 'station',
              }}
            />
          </RegionModelProvider>
        </NavigationProvider>
      </KeyboardShortcutsProvider>
    </QueryClientProvider>,
  );
  await waitFor(() => expect(current().regions.bottom.visible).toBe(true));
  act(() => {
    current().openSurfaceInRegion(PR);
  });
  await waitFor(() => expect(onLayerEntry()).toBe(true));
  const comment = (await screen.findByLabelText(
    'Comment',
  )) as HTMLTextAreaElement;
  fireEvent.change(comment, { target: { value: 'Half-written review' } });
  return comment;
}

function expectLayerOpen() {
  expect(current().phoneLayer).toEqual({ region: 'bottom', surfaceId: PR });
  expect(current().regions.bottom).toMatchObject({
    occupant: PR,
    visible: true,
  });
}

beforeEach(() => {
  model = null;
  localStorage.clear();
  deviceSettingsStore.reloadFromStorage();
  window.history.replaceState({}, '', '/?dock=open');
  navigationStore.navigate('/', { dock: 'open', maximize: null });
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: 390,
  });
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === MOBILE_MEDIA_QUERY || query === '(pointer: coarse)',
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  navigationStore.navigate('/', { dock: null, dockSlotPlacement: null });
});

describe('leaving a phone layer asks before discarding a review draft', () => {
  test('Back asks; Cancel keeps the pane, its draft and a live history entry; Discard returns to Chat', async () => {
    const comment = await mountWithDraft();

    act(() => window.history.back());
    const dialog = await screen.findByRole('dialog', {
      name: /Unsaved Changes/,
    });
    expect(dialog).toBeTruthy();
    expectLayerOpen();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(onLayerEntry()).toBe(true));
    expectLayerOpen();
    await waitFor(() => expect(current().regions.bottom.maximized).toBe(true));
    expect(comment.value).toBe('Half-written review');

    // The re-pushed entry is live: a second Back asks again.
    act(() => window.history.back());
    await screen.findByRole('dialog', { name: /Unsaved Changes/ });
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await waitFor(() =>
      expect(current().regions.bottom).toMatchObject({
        panes: ['chat'],
        occupant: 'chat',
        maximized: false,
      }),
    );
    expect(current().phoneLayer).toBeNull();
  });

  test('"‹ Chat" asks too; Cancel keeps the layer, Discard closes it', async () => {
    const comment = await mountWithDraft();

    act(() => current().closePhoneLayer());
    await screen.findByRole('dialog', { name: /Unsaved Changes/ });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: /Unsaved Changes/ }),
      ).toBeNull(),
    );
    expectLayerOpen();
    expect(onLayerEntry()).toBe(true);
    expect(comment.value).toBe('Half-written review');

    act(() => current().closePhoneLayer());
    await screen.findByRole('dialog', { name: /Unsaved Changes/ });
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(current().phoneLayer).toBeNull());
    expect(current().regions.bottom.occupant).toBe('chat');
  });
});
