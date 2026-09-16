/**
 * @vitest-environment jsdom
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

// The attention projection has its own tests; here it is a controllable value
// so these pin what the footer DOES with the count it is given. Same field
// and same registry badge the header bell reads.
const attentionState = vi.hoisted(() => ({ pendingCount: 0 }));
vi.mock('@kontourai/station-sdk', () => ({
  useAttentionQuery: () => ({
    data: { pendingCount: attentionState.pendingCount },
  }),
}));
vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://station.test' }),
}));

// Mutable so one test can put the registry in the state it is in for the
// first tick after boot: `CommandPalette` registers `command-palette` from a
// lazily-loaded chunk, and `getDisplay` answers '' until it lands.
let paletteChord = 'Ctrl+K';
vi.mock('../hooks/useKeyboardShortcut', () => ({
  useShortcutDisplay: () => paletteChord,
}));

// The presence tray reads the SAME cache entry the Activity surface reads, so
// here it is the controllable value and these tests pin what the footer DOES
// with the projection it is handed. Every fixture below is built through the
// production parser, so a fixture that drifts from the wire shape fails loudly
// rather than proving the tray works on a payload Station never sends.
const liveActivity = vi.hoisted(() => ({
  data: undefined as unknown,
  isPending: false,
  isError: false,
}));
vi.mock('@kontourai/station-sdk/live-activity', () => ({
  useLiveActivityQuery: () => ({
    data: liveActivity.data,
    isPending: liveActivity.isPending,
    isError: liveActivity.isError,
  }),
}));
// `RegionModelProvider` wraps the whole application, so `useShowSurface`
// requires it; this harness mounts a fragment of that tree. The stub is the
// assertion seam for the follow action, which must command the SAME surface
// `LiveCollaboratorsSection`'s "View session" commands.
const showSurfaceStub = vi.hoisted(() => vi.fn());
vi.mock('../contexts/useShowSurface', () => ({
  useShowSurface: () => showSurfaceStub,
}));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  LIVE_ACTIVITY_SCHEMA_VERSION,
  parseLiveActivityProjection,
} from '@kontourai/station-contracts/live-activity';
import { ACTIVITY_SURFACE_ID } from '@kontourai/station-contracts/surface-deep-link';
import { ProjectSidebarFooter } from '../components/project-sidebar/ProjectSidebarFooter';
import { pointerClick } from './helpers/pointer';

/** A participant id is exactly 24 lowercase hex characters on the wire. */
function participantId(seed: number): string {
  return seed.toString(16).padStart(24, '0');
}

function human(seed: number, label: string) {
  return {
    id: participantId(seed),
    actor: { kind: 'human', label },
    scope: { projectId: 'p1', projectSlug: 'station', taskId: '77' },
    work: {
      workName: 'Reviewing the panel',
      workState: 'reviewing',
      startedAt: 1_700_000_000_000,
    },
  };
}

function agent(
  seed: number,
  label: string,
  workName: string,
  sessionId?: string,
) {
  return {
    id: participantId(seed),
    actor: { kind: 'agent', label },
    scope: { projectId: 'p1', projectSlug: 'station', taskId: '77' },
    work: {
      ...(sessionId ? { sessionId } : {}),
      workName,
      workState: 'working',
      startedAt: 1_700_000_000_000,
    },
  };
}

/**
 * The exact body `/api/live-activity` serves, run through the exact parser the
 * SDK runs it through. If a field here is not one production emits, the parse
 * returns undefined and the fixture refuses to exist.
 */
function projection(
  participants: readonly unknown[],
  connectedClients = participants.length,
) {
  const parsed = parseLiveActivityProjection({
    schemaVersion: LIVE_ACTIVITY_SCHEMA_VERSION,
    observedAt: 1_700_000_000_000,
    connectedClients,
    participants,
  });
  if (!parsed)
    throw new Error(
      'fixture is not a projection the production parser accepts',
    );
  return parsed;
}

function openTray() {
  const trigger = screen.getByRole('button', { name: /^Who is here:/ });
  trigger.focus();
  fireEvent.click(trigger);
  return trigger;
}

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockImplementation(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
      media: '',
      onchange: null,
    })),
  });
});

function renderFooter(
  props: Partial<{
    activePath: string;
    navigate: (path: string) => void;
    isMobile: boolean;
    onAfterNavigate: () => void;
  }> = {},
) {
  return render(
    <ProjectSidebarFooter
      activePath={props.activePath ?? '/'}
      isMobile={props.isMobile ?? false}
      navigate={props.navigate ?? vi.fn()}
      onAfterNavigate={props.onAfterNavigate}
    />,
  );
}

describe('ProjectSidebarFooter', () => {
  beforeEach(() => {
    paletteChord = 'Ctrl+K';
    attentionState.pendingCount = 0;
    liveActivity.data = projection([]);
    liveActivity.isPending = false;
    liveActivity.isError = false;
    showSurfaceStub.mockReset();
  });

  // #2059 (design record D3): "Footer: presence, the attention bell, and the
  // gear." The bell and the gear are the panel's only entry points to
  // Notifications and Settings now that neither has a row; presence is the
  // tray #2066 landed in the slot #2059 held open for it.
  test('carries the presence tray, the palette chord, the bell and the gear', () => {
    const { container } = renderFooter();
    expect(container.querySelector('.sidebar__footer-presence')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Who is here:/ })).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Command palette' }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Notifications' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Settings' })).toBeTruthy();
  });

  // The count and the stack are a read of the projection this render was
  // handed, not of anything stored. Four distinct participants and one agent:
  // three
  // faces plus a "+1", and the accessible name carries the true count the
  // stack cannot show.
  test('the count and the avatar stack derive from the live projection', () => {
    liveActivity.data = projection([
      human(1, 'Ada Lovelace'),
      human(2, 'Grace Hopper'),
      human(3, 'Alan Turing'),
      human(4, 'Katherine Johnson'),
      agent(5, 'Codex', 'Refactor the router', 'session-42'),
    ]);
    const { container } = renderFooter();
    const trigger = screen.getByRole('button', {
      name: 'Who is here: 4 participants, 1 agent worker',
    });
    const faces = Array.from(
      trigger.querySelectorAll<HTMLElement>('.sidebar__presence-avatar'),
    ).map((face) => face.textContent);
    expect(faces).toEqual(['AL', 'GH', 'AT', '+1']);
    expect(
      container.querySelector('.sidebar__presence-count')?.textContent,
    ).toBe('4');
  });

  // The SAME paired device publishing in two task rooms is two participants
  // with two ids: the contract calls `id` an "opaque per-room actor key"
  // (packages/contracts/src/live-activity.ts). The fold is on the label, which
  // is what makes the count one per participant rather than one per row.
  //
  // The unit is a DEVICE, not a person — the label is
  // `Participant <sha(operatorId, deviceId) suffix>` and the runtime's own
  // test pins two devices of one operator as two distinct actors — which is
  // why this tray counts "participants" and never claims to count people.
  test('counts distinct participants rather than participant rows', () => {
    liveActivity.data = projection([
      human(1, 'Participant 0123456789ab'),
      {
        ...human(2, 'Participant 0123456789ab'),
        scope: { projectId: 'p2', projectSlug: 'ferry', taskId: '9' },
      },
    ]);
    renderFooter();
    expect(
      screen.getByRole('button', { name: 'Who is here: 1 participant' }),
    ).toBeTruthy();
  });

  // #2066 acceptance: presence is DERIVED, never a stored flag. What removes a
  // participant is NOT the SSH client's connection lease — an earlier version
  // of this comment credited it, and the tray's own docblock now records why
  // that is wrong: `client-connection-presence.ts` feeds only
  // `connectedClients`, a field this tray never reads. A participant leaves
  // its task room's live-work session by an explicit `depart` or by TTL expiry
  // (`src-server/domain/live-work-session.ts`, `ttlMs: 30_000`), and the
  // server half of that chain is pinned in
  // `src-server/services/orchestration/__tests__/project-task-room-runtime.test.ts`
  // ("a participant that stops heartbeating expires from the projection").
  //
  // What THIS test owns is the client half: whichever way the participant
  // left, the next projection simply does not carry it, and the tray must hold
  // no memory of the answer it just rendered. It drives the real component
  // across exactly that transition, with the tray open, through the production
  // parser both times.
  test('a participant the next projection omits disappears from the tray', () => {
    // `connectedClients` is threaded only because the parser requires the
    // field; it is deliberately held CONSTANT across the transition, because
    // the tray reads `participants` and nothing else. A fixture that moved it
    // in step would imply this test passes because of a number the component
    // never looks at.
    liveActivity.data = projection(
      [human(1, 'Ada Lovelace'), human(2, 'Grace Hopper')],
      2,
    );
    const { rerender } = renderFooter();
    openTray();
    expect(screen.getByText('Grace Hopper')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Who is here: 2 participants' }),
    ).toBeTruthy();

    // Grace is gone from the next projection — departed, or her lease expired.
    // `connectedClients` stays 2, so the only thing that changed is the one
    // field the tray reads.
    liveActivity.data = projection([human(1, 'Ada Lovelace')], 2);
    rerender(
      <ProjectSidebarFooter
        activePath="/"
        isMobile={false}
        navigate={vi.fn()}
      />,
    );

    expect(screen.queryByText('Grace Hopper')).toBeNull();
    expect(screen.getByText('Ada Lovelace')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Who is here: 1 participant' }),
    ).toBeTruthy();
  });

  // Read-only first (docs/design/project-membership.md): shared-resource
  // admission is incomplete, so Station cannot address another member. The
  // reason is on screen and bound to the control, not in a `title` a keyboard
  // user never reaches.
  test('the message action is disabled and says why', () => {
    liveActivity.data = projection([human(1, 'Ada Lovelace')]);
    renderFooter();
    openTray();
    const message = screen.getByRole('button', { name: 'Message' });
    expect(message.hasAttribute('disabled')).toBe(true);
    const describedBy = message.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    const reason = document.getElementById(describedBy!);
    expect(reason?.textContent).toMatch(/membership admission/i);
  });

  // Follow opens the worker's live session the same way Activity does:
  // `LiveCollaboratorsSection`'s "View session" commands `useShowSurface` with
  // the Activity surface id and a session intent. The assertion is on that
  // shared seam and the shared contract constant — not on a route string this
  // file could spell the same way while the product spelled it differently —
  // and the footer's own navigation must stay out of it.
  test('follow commands the same Activity surface Live collaborators does', () => {
    liveActivity.data = projection([
      agent(5, 'Codex', 'Refactor the router', 'session-42'),
    ]);
    const navigate = vi.fn();
    renderFooter({ navigate });
    openTray();
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Follow Codex on Refactor the router',
      }),
    );
    expect(showSurfaceStub).toHaveBeenCalledTimes(1);
    expect(showSurfaceStub.mock.calls[0]![0]).toBe(ACTIVITY_SURFACE_ID);
    expect(showSurfaceStub.mock.calls[0]![1]).toEqual({
      session: 'session-42',
    });
    expect(navigate).not.toHaveBeenCalled();
  });

  // The contract carries `sessionId` only for an already-authorized
  // agent-session reference. Without one there is nothing to open, and a
  // button that could only fail is worse than saying so.
  test('a worker with no authorized session reference offers no follow', () => {
    liveActivity.data = projection([agent(6, 'Codex', 'Draft the release')]);
    renderFooter();
    openTray();
    expect(screen.queryByRole('button', { name: /^Follow/ })).toBeNull();
    expect(screen.getByText('No session to follow')).toBeTruthy();
  });

  test('the tray opens, closes on Escape, and returns focus to its trigger', () => {
    liveActivity.data = projection([
      agent(5, 'Codex', 'Refactor the router', 'session-42'),
    ]);
    renderFooter();
    const trigger = openTray();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const tray = screen.getByRole('dialog', { name: 'Who is here' });
    // Focus must ENTER the tray, or the return assertion below has no power:
    // focus that never left the trigger is trivially still on the trigger.
    // The tray is not in the trigger's sequential order, so without this Tab
    // walks out of an open popover into the panel behind it.
    expect(tray.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(tray, { key: 'Escape' });

    expect(screen.queryByRole('dialog', { name: 'Who is here' })).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
  });

  // MED-2. The defect this pins is a browser behaviour jsdom does not have:
  // pressing a button MOVES FOCUS to it, which for an open tray is a focusout
  // of the tray, which `useMenuFocus` dismisses on — so by the time the click
  // handler ran, `open` was already false and the click re-opened what the
  // pointer meant to dismiss. The tray was unclosable by mouse from its own
  // trigger.
  //
  // `pointerClick` is therefore not decoration: firing `click` alone would
  // pass with or without the fix, because jsdom moves focus for neither. It
  // emulates exactly the one step jsdom omits, and only when the element did
  // not cancel the press — which is what makes `preventDefault` on mousedown
  // the thing under test. It lives in `helpers/pointer.ts` since #2081, which
  // found the same defect on the header's notification bell and on the
  // per-turn actions menu; one model of the browser, not three.

  test('a pointer click on the trigger closes the tray, it does not reopen it', () => {
    liveActivity.data = projection([human(1, 'Ada Lovelace')]);
    renderFooter();
    const trigger = screen.getByRole('button', { name: /^Who is here:/ });

    pointerClick(trigger);
    const tray = screen.getByRole('dialog', { name: 'Who is here' });
    // The press must not have left focus on the trigger, or the dismissal the
    // second click relies on would never have been armed.
    expect(tray.contains(document.activeElement)).toBe(true);

    pointerClick(trigger);
    expect(screen.queryByRole('dialog', { name: 'Who is here' })).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  // The LOW alongside it: the Escape handler now sits on the control rather
  // than on the dialog, so it covers the trigger too. Defensive rather than a
  // reported dead end — opening moves focus into the tray, so a user does not
  // normally stand on the trigger — but the two children of one control
  // answering the same key differently was a difference nothing enforced.
  test('Escape closes the tray from the trigger, not only from the dialog', () => {
    liveActivity.data = projection([human(1, 'Ada Lovelace')]);
    renderFooter();
    const trigger = openTray();
    fireEvent.keyDown(trigger, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Who is here' })).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  // Tab out. The tray is a sibling of the trigger rather than a portal, so
  // sequential focus walks into it and then out the far side; `useMenuFocus`
  // dismisses on that exit so the popover cannot be left open over content the
  // user has moved on to. jsdom does not move focus on a Tab keypress, so the
  // landing is what is driven here — the assertion is about where focus ENDS
  // UP, which is the part a browser would do for us.
  test('tabbing out of the tray dismisses it and leaves focus where it landed', () => {
    liveActivity.data = projection([human(1, 'Ada Lovelace')]);
    renderFooter();
    openTray();
    const tray = screen.getByRole('dialog', { name: 'Who is here' });
    expect(tray.contains(document.activeElement)).toBe(true);

    const settings = screen.getByRole('button', { name: 'Settings' });
    // `act`, because a bare `.focus()` is not a `fireEvent`: the native
    // focusout fires and `useMenuFocus` calls `onClose`, but React would not
    // have flushed that state before the assertions below read the DOM.
    act(() => {
      settings.focus();
    });

    expect(screen.queryByRole('dialog', { name: 'Who is here' })).toBeNull();
    // Focus stays where Tab aimed it: the dismissal must not yank it back to
    // the trigger, which would make Tab appear to do nothing.
    expect(document.activeElement).toBe(settings);
  });

  // The quiet state. A presence control that disappears when nobody is here is
  // indistinguishable from one that broke, so it holds its place and states
  // what it read.
  test('with nobody publishing, the control stays and says what it read', () => {
    liveActivity.data = projection([], 3);
    const { container } = renderFooter();
    const trigger = screen.getByRole('button', {
      name: 'Who is here: nobody is publishing live work',
    });
    // #2150: a zero roster draws the glyph alone. The count used to render a
    // bare `0` beside it, which read as a bug rather than as "nobody here";
    // the number is information only when it is non-zero, and the accessible
    // name (asserted above) already carries the full sentence.
    expect(container.querySelector('.sidebar__presence-count')).toBeNull();
    expect(container.querySelector('.sidebar__presence-glyph')).toBeTruthy();
    trigger.focus();
    fireEvent.click(trigger);
    const tray = screen.getByRole('dialog', { name: 'Who is here' });
    expect(tray.textContent).toMatch(/nobody is publishing live work/);
    // MED-4. The copy used to promise "never from a saved status", which read
    // as immediacy the mechanism does not have. What is true is the heartbeat
    // bound: a participant is dropped when its lease expires, up to ~30s after
    // its tab closed, so the sentence has to state a delay rather than deny
    // one.
    expect(tray.textContent).toMatch(/holds by heartbeat/);
    expect(tray.textContent).toMatch(/not the instant its tab closes/);
    // And the bound it states is the WORST case, not the friendly half of it:
    // the ~30s lease plus this query's 10s poll. Copy claiming "about half a
    // minute" would have been more optimistic than the component's own
    // docblock, which is the one place a user never gets to read.
    expect(tray.textContent).toMatch(/about forty seconds/);
    expect(
      screen.queryByRole('list', { name: 'Participants here' }),
    ).toBeNull();
  });

  // Three non-roster reads, each a different thing to say. `undefined` before
  // the first answer is not "nobody is here" — that would be a claim about
  // people made from the absence of an answer. `null` is the Station answering
  // that it does not publish live work at all, which is not a failure. An
  // error is the Station not answering. What these pin is the COPY for each;
  // that the query really produces all three, and that the last two do not
  // collapse into one, needs a real cache and lives in
  // `ProjectSidebarPresenceTrayLiveQuery.test.tsx`.
  test.each([
    ['no answer yet', undefined, true, false, 'Who is here: not read yet'],
    [
      'a Station that does not publish live work',
      null,
      false,
      false,
      'Who is here: not published by this Station',
    ],
    [
      'a Station that did not answer',
      undefined,
      false,
      true,
      'Who is here: Station is not answering',
    ],
  ])(
    'says what it read rather than claiming nobody is here (%s)',
    (_case, data, isPending, isError, name) => {
      liveActivity.data = data;
      liveActivity.isPending = isPending;
      liveActivity.isError = isError;
      const { container } = renderFooter();
      expect(screen.getByRole('button', { name })).toBeTruthy();
      expect(container.querySelector('.sidebar__presence-count')).toBeNull();
      // No roster rows either: none of these three knows who is here.
      expect(
        screen.queryByRole('list', { name: 'Participants here' }),
      ).toBeNull();
    },
  );

  // MED-3. The collapsed rail hides the stack and the count in CSS, so when
  // the glyph was the ELSE-branch of "is anyone here", a populated roster left
  // the rail's trigger with two hidden children and nothing else: a blank
  // button. The glyph is unconditional now, which is the only version of this
  // that does not depend on which state the roster happens to be in.
  test.each([
    ['nobody present', []],
    ['someone present', [human(1, 'Ada Lovelace')]],
  ])('the trigger always renders its glyph (%s)', (_case, participants) => {
    liveActivity.data = projection(participants);
    renderFooter();
    const glyph = screen
      .getByRole('button', { name: /^Who is here:/ })
      .querySelector('.sidebar__presence-glyph');
    expect(glyph).toBeTruthy();
    expect(glyph!.querySelector('svg')).toBeTruthy();
  });

  // The other half of MED-3: the component test above proves the glyph is
  // RENDERED, and this proves the collapsed rail does not then hide it.
  //
  // It used to read the stylesheet as text and assert that no line mentioning
  // `.sidebar--collapsed .sidebar__presence` also mentioned the glyph class.
  // A delta reviewer defeated that in one line — a rule routed through the
  // wrapper, `.sidebar--collapsed .sidebar__footer-presence
  // .sidebar__presence-glyph { display: none }`, hid the glyph for real while
  // the scan stayed green, because it does not match the scan's prefix. That
  // is an entirely ordinary way to write the rule, so the regression the guard
  // is named for was still reachable.
  //
  // So the stylesheet is applied instead of read: mounted under a real
  // `.sidebar--collapsed` ancestor with the file in a `<style>`, the question
  // becomes what the cascade actually computes, which is the question the
  // guard's name has always claimed to answer. It now also asserts the
  // POSITIVE half (the glyph really resolves to a visible display), which the
  // text scan could only ever assert by absence.
  test('the collapsed rail computes the stack and the count away, never the glyph', () => {
    const style = document.createElement('style');
    style.textContent = readFileSync(
      join(
        __dirname,
        '../components/project-sidebar/ProjectSidebarPresenceTray.css',
      ),
      'utf-8',
    );
    document.head.append(style);
    // A container React did not create is not cleaned up for us.
    const rail = document.createElement('div');
    rail.className = 'sidebar sidebar--collapsed';
    document.body.append(rail);
    try {
      liveActivity.data = projection([human(1, 'Ada Lovelace')]);
      render(
        <ProjectSidebarFooter
          activePath="/"
          isMobile={false}
          navigate={vi.fn()}
        />,
        { container: rail },
      );
      const trigger = screen.getByRole('button', { name: /^Who is here:/ });
      const glyph = trigger.querySelector<HTMLElement>(
        '.sidebar__presence-glyph',
      );
      const stack = trigger.querySelector<HTMLElement>(
        '.sidebar__presence-stack',
      );
      const count = trigger.querySelector<HTMLElement>(
        '.sidebar__presence-count',
      );
      if (!glyph || !stack || !count)
        throw new Error('the rail must render all three children to compare');

      // The rail is 48px of icon column: the count and the stack have nowhere
      // to go, and the glyph is the child that keeps the trigger from being an
      // empty box.
      expect(getComputedStyle(stack).display).toBe('none');
      expect(getComputedStyle(count).display).toBe('none');
      expect(getComputedStyle(glyph).display).not.toBe('none');
    } finally {
      rail.remove();
      style.remove();
    }
  });

  test('the bell navigates to the notifications route', () => {
    const navigate = vi.fn();
    renderFooter({ navigate });
    fireEvent.click(screen.getByRole('button', { name: 'Notifications' }));
    expect(navigate).toHaveBeenCalledWith('/notifications');
  });

  test('the gear navigates to the settings route', () => {
    const navigate = vi.fn();
    renderFooter({ navigate });
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(navigate).toHaveBeenCalledWith('/settings');
  });

  test('closes the mobile drawer after a footer navigation, and only on mobile', () => {
    const onAfterNavigate = vi.fn();
    const { unmount } = renderFooter({ isMobile: false, onAfterNavigate });
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(onAfterNavigate).not.toHaveBeenCalled();
    unmount();

    renderFooter({ isMobile: true, onAfterNavigate });
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(onAfterNavigate).toHaveBeenCalledTimes(1);
  });

  // The badge is the registry's projection of the attention count, not a
  // second derivation: the number and the phrase both come from
  // `destination-registry.ts`'s `badge`, which is what the header bell reads
  // from the same `['attention', apiBase]` cache entry.
  test('the bell carries the attention count in its accessible name and its badge', () => {
    attentionState.pendingCount = 3;
    renderFooter();
    const bell = screen.getByRole('button', {
      name: 'Notifications (3 need attention)',
    });
    expect(bell.textContent).toBe('3');
  });

  test('caps the visible badge at 9+ while the accessible name keeps the true count', () => {
    attentionState.pendingCount = 42;
    renderFooter();
    const bell = screen.getByRole('button', {
      name: 'Notifications (42 need attention)',
    });
    expect(bell.textContent).toBe('9+');
  });

  test('shows no badge at all when nothing needs attention', () => {
    attentionState.pendingCount = 0;
    renderFooter();
    const bell = screen.getByRole('button', { name: 'Notifications' });
    expect(bell.textContent).toBe('');
  });

  // Exactly one control may claim to be the current location, and it is
  // derived through the registry's view ownership rather than a path-prefix
  // comparison here (#1582 D4's rule, applied to the footer's two routed
  // controls).
  test.each([
    ['/notifications', 'Notifications', 'Settings'],
    ['/settings', 'Settings', 'Notifications'],
  ])('marks the %s control as the current page', (path, current, other) => {
    renderFooter({ activePath: path });
    expect(
      screen
        .getByRole('button', { name: current })
        .getAttribute('aria-current'),
    ).toBe('page');
    expect(
      screen.getByRole('button', { name: other }).getAttribute('aria-current'),
    ).toBeNull();
  });

  test('marks neither control on an unrelated route', () => {
    renderFooter({ activePath: '/agents' });
    expect(
      screen
        .getAllByRole('button')
        .filter((button) => button.getAttribute('aria-current') === 'page'),
    ).toHaveLength(0);
  });

  // #2059 product decision: the build identity left the footer. It is not
  // panel chrome — `ReportProblemDialog` stamps `buildLabel` into every
  // report, which is where the number is actually needed. The old
  // "renders the build identity with full detail in the tooltip" test went
  // with the element it described; what replaces it is the assertion that the
  // rail no longer carries a version at all.
  test('carries no build identity', () => {
    const { container } = renderFooter();
    expect(screen.queryByTestId('sidebar-build-version')).toBeNull();
    expect(container.textContent).not.toMatch(/v\d+\.\d+\.\d+/);
  });

  test('the palette chip shows the chord the registry reports (#1649)', () => {
    // It used to render a literal `⌘K`, which named a chord Windows and Linux
    // users cannot press and which would not have followed a rebinding from
    // Settings either. The stub is deliberately NOT the default chord: an
    // assertion of `Ctrl+K` here would pass on the static fallback too, and
    // prove nothing about which of the two the chip is reading.
    paletteChord = 'Ctrl+Shift+P';
    renderFooter();
    const chip = screen.getByRole('button', { name: 'Command palette' });
    expect(chip.textContent).toBe('Ctrl+Shift+P');
    expect(chip.textContent).not.toContain('⌘');
  });

  test('the palette chip still names a chord before the registry has one', () => {
    // The lazy-chunk window: `CommandPalette` registers `command-palette` from
    // a deferred chunk, so `getDisplay` answers '' for the first tick. An
    // empty chip would collapse the button to its padding. The fallback is
    // platform-derived, so it is never the Mac keycap on a non-Mac platform —
    // jsdom reports no Mac here, which is exactly the platform the bug was on.
    paletteChord = '';
    renderFooter();
    const chip = screen.getByRole('button', { name: 'Command palette' });
    expect(chip.textContent).toBe('Ctrl+K');
    expect(chip.textContent).not.toContain('⌘');
  });

  test('an unbound shortcut falls back rather than reading "Not set"', () => {
    paletteChord = 'Not set';
    renderFooter();
    expect(
      screen.getByRole('button', { name: 'Command palette' }).textContent,
    ).toBe('Ctrl+K');
  });

  test('the palette chip dispatches open-command-palette', () => {
    renderFooter();
    const listener = vi.fn();
    window.addEventListener('open-command-palette', listener);
    fireEvent.click(screen.getByRole('button', { name: 'Command palette' }));
    window.removeEventListener('open-command-palette', listener);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  // Keyboard operability of the panel's bottom controls, which the retired
  // status line's controls had. Every one is a real `button` element — which
  // is what carries Enter/Space activation and tab order — rather than a
  // clickable `div`, and none is removed from the tab order.
  test('every footer control is a focusable button in the tab order', () => {
    renderFooter();
    const buttons = screen.getAllByRole('button');
    expect(buttons.map((button) => button.tagName)).toEqual(
      buttons.map(() => 'BUTTON'),
    );
    expect(buttons.map((button) => button.getAttribute('type'))).toEqual(
      buttons.map(() => 'button'),
    );
    for (const button of buttons) {
      expect(button.getAttribute('tabindex')).toBeNull();
      expect(button.hasAttribute('disabled')).toBe(false);
      button.focus();
      expect(document.activeElement).toBe(button);
    }
  });
});
