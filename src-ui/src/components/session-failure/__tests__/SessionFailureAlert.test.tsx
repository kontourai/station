/**
 * @vitest-environment jsdom
 *
 * archive#3213: the ONE failure banner, proven to be the one both surfaces
 * render. The session detail's own markup was lifted into this component when
 * the chat dock became a second consumer — a parallel banner with the same
 * words is how two surfaces come to describe one failure differently.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { SessionDetailErrors } from '../../session-detail/SessionDetailErrors';
import { SessionFailureAlert } from '../SessionFailureAlert';

describe('SessionFailureAlert', () => {
  test('renders nothing when nothing failed', () => {
    const { container } = render(<SessionFailureAlert failureText={null} />);
    expect(container.innerHTML).toBe('');
  });

  test('announces the cause as an alert, in the shared copy shape — quoted verbatim, because it carries real content', () => {
    // The banner's contract is to QUOTE the recorded cause (archive#3213) —
    // rewriting a cause that names a host would attribute a meaning its
    // producer never stated (see archive#3299's narrow exception below).
    render(<SessionFailureAlert failureText="ECONNREFUSED host:8443" />);

    const banner = screen.getByTestId('session-failure');
    expect(banner.getAttribute('role')).toBe('alert');
    expect(banner.textContent).toBe('Failed: ECONNREFUSED host:8443');
  });

  test('station#3299: a browser-internal stream exception never reaches the banner verbatim', () => {
    // The one rewrite: this cause's entire content is a JS API name plus a
    // parser state — nothing a user can act on — so the banner prints the
    // same product sentence the transcript's error card uses for the shape.
    render(
      <SessionFailureAlert failureText="Failed to execute 'close' on 'ReadableStreamDefaultController': Unexpected end of JSON input" />,
    );

    const banner = screen.getByTestId('session-failure');
    expect(banner.textContent).not.toContain('ReadableStreamDefaultController');
    expect(banner.textContent).not.toContain("Failed to execute 'close'");
    expect(banner.textContent).toMatch(/^Failed: /);
  });

  test('an unrecognized cause still renders verbatim — nothing is ever swallowed', () => {
    render(
      <SessionFailureAlert failureText="Session process exited with code 137" />,
    );

    expect(screen.getByTestId('session-failure').textContent).toBe(
      'Failed: Session process exited with code 137',
    );
  });

  test('the note is opt-in, so a surface that cannot promise a next step says nothing', () => {
    const { rerender } = render(<SessionFailureAlert failureText="boom" />);
    expect(
      screen
        .getByTestId('session-failure')
        .querySelector('.session-failure__note'),
    ).toBeNull();

    rerender(<SessionFailureAlert failureText="boom" note="carry on" />);
    expect(screen.getByText('carry on')).toBeTruthy();
  });

  test('the test id is per-surface, because the dock is mounted over the detail', () => {
    render(<SessionFailureAlert failureText="boom" testId="dock-failure" />);

    expect(screen.getByTestId('dock-failure')).toBeTruthy();
    expect(screen.queryByTestId('session-failure')).toBeNull();
  });

  test('a host className is placement only — the banner keeps its own class', () => {
    render(<SessionFailureAlert failureText="boom" className="host-inset" />);

    const banner = screen.getByTestId('session-failure');
    expect(banner.classList.contains('session-failure')).toBe(true);
    expect(banner.classList.contains('host-inset')).toBe(true);
  });
});

describe('the session detail renders that same component', () => {
  test('its failure banner is the shared one, not a local copy', () => {
    render(
      <SessionDetailErrors
        failureText="ECONNREFUSED api.example.com:443"
        stopTaskError={null}
        sendTurnError={null}
        respondError={null}
      />,
    );

    const banner = screen.getByTestId('session-failure');
    expect(banner.classList.contains('session-failure')).toBe(true);
    expect(banner.textContent).toBe('Failed: ECONNREFUSED api.example.com:443');
    // The detail hides its composer for a terminal session, so it must not
    // carry the dock's "you can continue" note.
    expect(banner.querySelector('.session-failure__note')).toBeNull();
  });

  test('mutation errors are unaffected and still render alongside it', () => {
    render(
      <SessionDetailErrors
        failureText={null}
        stopTaskError={new Error('Unable to stop')}
        sendTurnError={null}
        respondError={null}
      />,
    );

    expect(screen.queryByTestId('session-failure')).toBeNull();
    expect(screen.getByText('Unable to stop')).toBeTruthy();
  });
});
