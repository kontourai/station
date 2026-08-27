/**
 * @vitest-environment jsdom
 */

import type { DevicePresentation } from '@kontourai/station-contracts/system-status';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { HostAction } from '../HostAction';
import {
  HOST_ACTION_COPY,
  type HostActionId,
  hostActionCopy,
} from '../host-action-copy';

const HOST: DevicePresentation = {
  deviceClass: 'host',
  hostName: 'workshop',
};
const PAIRED: DevicePresentation = {
  deviceClass: 'paired',
  hostName: 'workshop',
};

describe('HostAction — three branches, no fourth', () => {
  it('branch 1: on the host the affordance renders untouched', () => {
    render(
      <HostAction
        id="ssh-trust-command"
        presentation={HOST}
        command="printf '%s\\n' 'key' >> known_hosts"
      >
        <button type="button">Copy command</button>
      </HostAction>,
    );
    expect(screen.getByRole('button', { name: 'Copy command' })).toBeTruthy();
    // Nothing about a second machine is stated to someone sitting at the one
    // machine there is.
    expect(screen.queryByText(/workshop/)).toBeNull();
    expect(document.querySelector('.host-action')).toBeNull();
  });

  it('branch 2: a remote-safe affordance on a paired device keeps its affordance and names the host', () => {
    render(
      <HostAction id="developer-logs" presentation={PAIRED}>
        <ul aria-label="Server logs" />
      </HostAction>,
    );
    // The affordance survives — a paired device is not shown a degraded page.
    expect(screen.getByLabelText('Server logs')).toBeTruthy();
    expect(
      screen.getByText(hostActionCopy('developer-logs', PAIRED)),
    ).toBeTruthy();
  });

  it('branch 2: the helper is met BEFORE the affordance, not under it', () => {
    // A sentence placed after a long list is below the fold, which is where
    // this lane's first paired capture put the only account of why the log
    // read looks thin.
    const { container } = render(
      <HostAction id="developer-logs" presentation={PAIRED}>
        <ul aria-label="Server logs" />
      </HostAction>,
    );
    const wrapper = container.querySelector('.host-action');
    expect(wrapper?.firstElementChild?.className).toBe('host-action__helper');
    expect(wrapper?.lastElementChild?.getAttribute('aria-label')).toBe(
      'Server logs',
    );
  });

  it('branch 3: a host-hands affordance on a paired device becomes the instruction, the command and a Copy control', () => {
    const command = "printf '%s\\n' 'host key' >> \"$HOME/.ssh/known_hosts\"";
    render(
      <HostAction
        id="ssh-trust-command"
        presentation={PAIRED}
        command={command}
      >
        <button type="button">Copy command</button>
      </HostAction>,
    );
    expect(
      screen.getByText(hostActionCopy('ssh-trust-command', PAIRED)),
    ).toBeTruthy();
    expect(screen.getByText(command)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy command' })).toBeTruthy();
    // Never a disabled button, never silently hidden.
    expect(
      (
        screen.getByRole('button', {
          name: 'Copy command',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  it('branch 3 without a single command states the instruction alone rather than an empty code block', () => {
    render(<HostAction id="engine-missing" presentation={PAIRED} />);
    expect(
      screen.getByText(hostActionCopy('engine-missing', PAIRED)),
    ).toBeTruthy();
    expect(document.querySelector('.host-action__command')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('an unanswered projection takes the host branch — no device is claimed', () => {
    render(
      <HostAction id="ssh-trust-command" presentation={undefined} command="x">
        <button type="button">Copy command</button>
      </HostAction>,
    );
    expect(screen.getByRole('button', { name: 'Copy command' })).toBeTruthy();
    expect(document.querySelector('.host-action')).toBeNull();
  });

  it('does not branch on viewport: the same presentation renders the same way at 390 and 1440', () => {
    const at = (width: number) => {
      window.innerWidth = width;
      const { container, unmount } = render(
        <HostAction id="engine-missing" presentation={PAIRED} />,
      );
      const html = container.innerHTML;
      unmount();
      return html;
    };
    expect(at(390)).toBe(at(1440));
  });
});

describe('the copy map is the single source', () => {
  const ids = Object.keys(HOST_ACTION_COPY) as HostActionId[];

  it('every id answers both branches', () => {
    for (const id of ids) {
      const entry = HOST_ACTION_COPY[id];
      expect(typeof entry.host).toBe('string');
      expect(entry.paired('workshop')).toContain('workshop');
    }
  });

  it('the paired branch always names the host and the host branch never does', () => {
    for (const id of ids) {
      expect(hostActionCopy(id, PAIRED)).toContain('workshop');
      expect(hostActionCopy(id, HOST)).not.toContain('workshop');
    }
  });

  it('an unanswered projection reads the host branch verbatim', () => {
    for (const id of ids) {
      expect(hostActionCopy(id, undefined)).toBe(HOST_ACTION_COPY[id].host);
    }
  });

  it('renders the map entry verbatim — no surface re-words it', () => {
    for (const id of ids) {
      const entry = HOST_ACTION_COPY[id];
      expect(hostActionCopy(id, PAIRED)).toBe(entry.paired('workshop'));
      expect(hostActionCopy(id, HOST)).toBe(entry.host);
    }
  });
});
