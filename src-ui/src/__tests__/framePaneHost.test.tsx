/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

let isMobile = false;
vi.mock('../hooks/useIsMobile', () => ({
  useIsMobile: () => isMobile,
}));

import {
  type FramePaneHost,
  type FramePaneHostOutboundMessage,
  useFramePaneHost,
} from '../components/plugins/framePaneHost';
import {
  pluginConfirmBudget,
  pluginNavigationBudget,
  pluginToastBudget,
} from '../components/plugins/plugin-frame-budget';
import { toastStore } from '../contexts/ToastContext';

/**
 * The frame (tier 3) adapter for the pane-host contract (archive#4201 step 3).
 *
 * The sibling `PluginFrameHost.test.tsx` proves the real component routes real
 * frame messages through this adapter. This file drives the adapter itself,
 * because two of its claims are invisible from the message layer alone: that
 * the SHELL's budget lives inside the contract MEMBER (so a pane cannot spend
 * more of the user's attention by being in a different tier), and that a
 * request the frame will never be able to receive an answer to settles rather
 * than dangling — the defect C1 shipped in-process, which is strictly worse
 * across a transport.
 */

const navigateMock = vi.fn();
let posted: FramePaneHostOutboundMessage[] = [];
let latest: FramePaneHost | null = null;

function Harness({
  granted = ['navigation.dock', 'ui.confirm'],
  active = true,
  pluginName = 'demo',
  navigate = navigateMock as
    | ((path: string, params: Record<string, string | null>) => void)
    | null,
}: {
  granted?: readonly string[];
  active?: boolean;
  pluginName?: string;
  navigate?:
    | ((path: string, params: Record<string, string | null>) => void)
    | null;
}) {
  latest = useFramePaneHost({
    pluginName,
    granted,
    active,
    navigate,
    post: (message) => {
      posted.push(message);
    },
  });
  // Mirrors the real placement: the chrome renders only while the frame does.
  return <>{active ? latest.confirmChrome : null}</>;
}

function adapter(): FramePaneHost {
  if (!latest) throw new Error('Harness has not rendered');
  return latest;
}

function refusals() {
  return posted.filter((message) => message.method === 'pane-host/refused');
}

beforeEach(() => {
  posted = [];
  latest = null;
  isMobile = false;
  navigateMock.mockClear();
});

afterEach(() => {
  // Module state: the budgets deliberately outlive a mount, so a leftover one
  // would silently starve the next test's requests.
  pluginToastBudget.reset();
  pluginNavigationBudget.reset();
  pluginConfirmBudget.reset();
  toastStore.clear();
  toastStore.clearHistory();
});

describe('the frame adapter implements the contract, with the shell keeping its own', () => {
  test('notify keeps the shell toast budget inside the contract member', () => {
    render(<Harness />);
    // Called as the CONTRACT, not as a message: a pane that reached `notify`
    // any other way -- a future transport, a direct call -- must still be
    // bounded, because the budget is the shell's, not the message layer's.
    for (let index = 0; index < 25; index += 1) {
      adapter().host.notify({ text: `tick ${index}`, tone: 'info' });
    }
    expect(toastStore.getSnapshot()).toHaveLength(3);
    expect(toastStore.getSnapshot().map((toast) => toast.message)).toEqual([
      'demo: tick 0',
      'demo: tick 1',
      'demo: tick 2',
    ]);
  });

  test('a frame confirm opens the SHELL modal and resolves with the decision', async () => {
    render(<Harness />);
    let decision: Promise<string> | null = null;
    act(() => {
      decision = adapter().host.confirm({
        title: 'Restart',
        message: 'Restart the runner?',
      });
    });

    // Station's own dialog, attributed to the plugin so a frame cannot draw
    // shell authority around its own words.
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('demo: Restart');
    expect(dialog.textContent).toContain('Restart the runner?');

    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await expect(decision).resolves.toBe('confirmed');
  });

  test('a confirm outstanding when the frame goes away settles as cancelled', async () => {
    const { unmount } = render(<Harness />);
    let pending: Promise<string> | null = null;
    act(() => {
      pending = adapter().host.confirm({ title: 'Outlived', message: 'open?' });
    });
    expect(screen.getByRole('dialog').textContent).toContain('Outlived');

    act(() => {
      unmount();
    });

    // Races the pending promise so a REGRESSION fails as an assertion naming
    // the dangle, not as an opaque suite timeout. Across a transport a dangle
    // is worse than in-process: the awaiting code is in another document and
    // nothing there can ever learn the request died.
    const settled = await Promise.race([
      pending as unknown as Promise<string>,
      new Promise<string>((resolve) => {
        setTimeout(() => resolve('DANGLED'), 50);
      }),
    ]);
    expect(settled).toBe('cancelled');
  });

  test('an unconsented plugin cannot interrupt the user at all', async () => {
    // The shell's confirm chrome is a focus-trapping, full-viewport overlay
    // wearing Station's authority, above Station's own buttons, and the
    // plugin writes the body text. Every other frame intent that reaches the
    // user requires a grant; this one is the most intrusive of them.
    //
    // The budget bounds the RATE, and rate was never the concern: the FIRST
    // dialog is the one that steals the keystroke.
    render(<Harness granted={['navigation.dock']} />);

    let decision: Promise<string> | null = null;
    act(() => {
      decision = adapter().host.confirm({
        title: 'Sign in to continue',
        message: 'Enter your Station password to continue.',
      });
    });

    expect(screen.queryByRole('dialog')).toBeNull();
    await expect(decision).resolves.toBe('cancelled');
    // Refused out loud: silence is what let two advertised capabilities stay
    // broken for months.
    expect(posted).toContainEqual({
      method: 'pane-host/refused',
      params: { method: 'confirm', reason: 'permission-required' },
    });
  });

  test('a confirm flood is refused, and each refusal still settles as cancelled', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      render(<Harness />);
      const decisions: Promise<string>[] = [];
      act(() => {
        for (let index = 0; index < 5; index += 1) {
          decisions.push(
            adapter().host.confirm({
              title: `Ask ${index}`,
              message: 'again?',
            }),
          );
        }
      });
      // Two is the burst; the rest never reach the user at all.
      await expect(Promise.all(decisions.slice(2))).resolves.toEqual([
        'cancelled',
        'cancelled',
        'cancelled',
      ]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain('confirmation rate');
      // Only the second of the two admitted requests is still on screen -- a
      // superseded one settles rather than stacking a second modal.
      expect(screen.getByRole('dialog').textContent).toContain('demo: Ask 1');
      await expect(decisions[0]).resolves.toBe('cancelled');
    } finally {
      warn.mockRestore();
    }
  });

  test('facts push to the frame when the shell mobile derivation flips', () => {
    const { rerender } = render(<Harness />);
    act(() => {
      expect(adapter().receive({ method: 'pane-host/facts' })).toBe(true);
    });
    // Subscribing answers with the current snapshot immediately -- a pane that
    // had to wait for a change to learn the device would render the wrong
    // layout until one happened.
    expect(posted).toEqual([
      {
        method: 'pane-host/facts-changed',
        params: { facts: { device: { isMobile: false } } },
      },
    ]);

    isMobile = true;
    act(() => {
      rerender(<Harness />);
    });
    expect(posted.at(-1)).toEqual({
      method: 'pane-host/facts-changed',
      params: { facts: { device: { isMobile: true } } },
    });
  });

  test('every navigation target the frame can send is typed, and resolved by the SHELL', () => {
    render(<Harness />);
    act(() => {
      adapter().receive({
        method: 'pane-host/navigate',
        params: { target: { kind: 'app-surface', surfaceId: 'agents' } },
      });
    });
    // The path came from the shell's own surface registry, not from the
    // message: there is nowhere in an `app-surface` target to put one.
    expect(navigateMock).toHaveBeenCalledWith('/agents', {});

    act(() => {
      adapter().receive({
        method: 'pane-host/navigate',
        params: {
          target: {
            kind: 'project-layout',
            projectSlug: 'apollo',
            layoutSlug: 'coding',
          },
        },
      });
    });
    expect(navigateMock).toHaveBeenLastCalledWith(
      '/projects/apollo/layouts/coding',
      { previewPath: null, previewLineStart: null, previewLineEnd: null },
    );
  });
});

describe('a message the frame adapter cannot serve is refused, never dropped', () => {
  test('a method outside the contract is not this adapter’s to answer', () => {
    render(<Harness />);
    // `fill` is a real frame lifecycle message owned by the placement. The
    // adapter must not claim it -- returning true would silently eat it.
    expect(adapter().receive({ method: 'fill', params: { height: 10 } })).toBe(
      false,
    );
    expect(refusals()).toHaveLength(0);
  });

  test('an unknown pane-host method is refused with a reply', () => {
    render(<Harness />);
    act(() => {
      expect(adapter().receive({ method: 'pane-host/exfiltrate' })).toBe(true);
    });
    expect(refusals()).toEqual([
      {
        method: 'pane-host/refused',
        params: {
          method: 'pane-host/exfiltrate',
          reason: 'method is not a pane-host capability',
        },
      },
    ]);
  });

  test('hostile and malformed payloads are refused, and nothing acts on them', () => {
    render(<Harness />);
    act(() => {
      // A params field that is not an object at all.
      adapter().receive({
        method: 'pane-host/notify',
        params: 'not-an-object',
      });
      // Empty and non-string notice text.
      adapter().receive({
        method: 'pane-host/notify',
        params: { text: '   ' },
      });
      adapter().receive({ method: 'pane-host/notify', params: { text: 42 } });
      // A navigation off Station, and one to a surface that does not exist.
      adapter().receive({
        method: 'pane-host/navigate',
        params: { target: 'https://evil.example/steal' },
      });
      adapter().receive({
        method: 'pane-host/navigate',
        params: { target: { kind: 'app-surface', surfaceId: '../../etc' } },
      });
      adapter().receive({
        method: 'pane-host/navigate',
        params: {
          target: {
            kind: 'project-layout',
            projectSlug: '..',
            layoutSlug: 'x',
          },
        },
      });
      // A confirm with no id to answer, and one with no words to show.
      adapter().receive({
        method: 'pane-host/confirm',
        params: { title: 'Sure?', message: 'really?' },
      });
      adapter().receive({
        method: 'pane-host/confirm',
        params: { id: 'c1', title: '', message: '' },
      });
      // An unavailable reason the contract does not define.
      adapter().receive({
        method: 'pane-host/present-unavailable',
        params: { reason: 'because-i-said-so' },
      });
    });

    expect(refusals().map((message) => message.params.reason)).toEqual([
      'params must be an object',
      'notice text must be a non-empty string',
      'notice text must be a non-empty string',
      'navigation target is not allowed',
      'navigation target is not allowed',
      'navigation target is not allowed',
      'confirm request needs an id to answer',
      'confirm needs a title and a message',
      'unavailable reason is not recognised',
    ]);
    // Nothing was shown, nothing moved, and no answer was fabricated.
    expect(toastStore.getSnapshot()).toHaveLength(0);
    expect(navigateMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(
      posted.filter((message) => message.method === 'pane-host/confirm-result'),
    ).toHaveLength(0);
  });

  test('a refused confirm names the request it is refusing', () => {
    render(<Harness />);
    act(() => {
      adapter().receive({
        method: 'pane-host/confirm',
        params: { id: 'c7', title: 'ok', message: '' },
      });
    });
    // Without the id the frame cannot tell WHICH outstanding request died,
    // which is the same dangle in a different costume.
    expect(refusals()[0]?.params).toEqual({
      method: 'pane-host/confirm',
      reason: 'confirm needs a title and a message',
      id: 'c7',
    });
  });
});

/**
 * Acceptance 1 of archive#4201 step 3, as a tripwire rather than a one-time
 * grep: `PluginFrameHost` must route these intents THROUGH the contract, not
 * beside it. The failure this guards against is not a broken feature -- it is
 * a second implementation growing back next to the first, which is exactly
 * how the frame's `toast` and `navigate` came to exist as bespoke cases in
 * the first place. TypeScript cannot express "does not reach the toast store
 * itself", so the pin is structural.
 */
describe('the placement holds no second implementation of a contract member', () => {
  const SOURCE = readFileSync(
    join(
      import.meta.dirname,
      '..',
      'components',
      'plugins',
      'PluginFrameHost.tsx',
    ),
    'utf8',
  );

  function withoutComments(source: string): string {
    return source
      .replaceAll(/\/\*[\s\S]*?\*\//g, '')
      .replaceAll(/(^|[^:])\/\/[^\n]*/gm, '$1');
  }

  test('PluginFrameHost reaches no shell capability a contract member owns', () => {
    const code = withoutComments(SOURCE);
    for (const forbidden of [
      // The toast store and the navigation seam are `notify` and `navigate`.
      'toastStore',
      'navigation.navigate',
      'navigationRef',
      // The budgets belong to the adapter's members, not to the message loop.
      'pluginToastBudget',
      'pluginNavigationBudget',
      'reportRefusal',
      // Target validation is the adapter's decode step.
      'resolvePluginNavigationTarget',
    ]) {
      expect(
        code,
        `'${forbidden}' must not reappear in PluginFrameHost`,
      ).not.toContain(forbidden);
    }
  });

  test('the two original capability messages have exactly one handler', () => {
    const code = withoutComments(SOURCE);
    // The strings themselves are gone from the placement: both spellings are
    // decoded inside the adapter now.
    expect(code).not.toMatch(/'toast'/);
    expect(code).not.toMatch(/'navigate'/);
    expect(code).toContain('receivePaneHostMessage');
  });
});
