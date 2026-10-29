// @vitest-environment jsdom

import type { AuthorityObservationGrant } from '@kontourai/station-contracts/authority-observation';
import { environmentId } from '@kontourai/station-contracts/execution-target';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render as renderView,
  screen,
} from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { deviceSettingsStore } from '../../../lib/device-settings-store';
import { StartStationMenu } from '../StartMenus';
import { StartPickerMenus } from '../StartPickerMenus';
import { StartStationControl } from '../StartStationControl';

/**
 * What the server answered this caller, in the SDK query shapes the hook
 * reads. A refused `GET /api/environments/peers` (`access:manage`) is an
 * error result, exactly as react-query reports a 403.
 */
const reads = vi.hoisted(() => ({
  ssh: { isSuccess: true, isError: false, data: [] as unknown[] },
  peers: { isSuccess: true, isError: false, data: [] as unknown[] },
}));

const OPERATOR: AuthorityObservationGrant = { kind: 'operator' };
const READ_ONLY_DEVICE: AuthorityObservationGrant = {
  kind: 'device',
  deviceId: 'phone-1',
  grantedScopes: ['orchestration:read', 'access:manage'],
};
/**
 * The caller's authority observation read: answered with a grant, still
 * pending, failed (a 5xx), or missing on an older Station (a 404). The SDK
 * rejects both failures with an Error that keeps the HTTP status.
 */
const caller = vi.hoisted(() => ({
  grant: { kind: 'operator' } as AuthorityObservationGrant,
  read: 'answered' as 'answered' | 'pending' | 'failed' | 'older-host',
}));
vi.mock('@kontourai/station-sdk/authority-observation', () => ({
  getAuthorityObservation: () => {
    if (caller.read === 'pending') return new Promise(() => {});
    if (caller.read !== 'answered') {
      const status = caller.read === 'older-host' ? 404 : 503;
      return Promise.reject(
        Object.assign(
          new Error(
            `This Station refused the authority observation (HTTP ${status}).`,
          ),
          { status },
        ),
      );
    }
    return Promise.resolve({
      schemaVersion: 'station.authority-observation/v1',
      environmentId: 'env-kontour',
      principal: { kind: 'human', id: 'brian' },
      grant: caller.grant,
    });
  },
}));

/**
 * Renders under a QueryClient. An answered grant is in place before the
 * first render, as after its read; other reads go through the mock above.
 */
function render(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (caller.read === 'answered')
    client.setQueryData(
      ['execution-station-authority', 'http://station.test', 'authority-1'],
      {
        schemaVersion: 'station.authority-observation/v1',
        environmentId: 'env-kontour',
        principal: { kind: 'human', id: 'brian' },
        grant: caller.grant,
      },
    );
  return renderView(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
}

vi.mock('../../../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => ({
    apiBase: 'http://station.test',
    authorityKey: 'authority-1',
    isCurrent: () => true,
  }),
}));
vi.mock('../../../hooks/useDevicePresentation', () => ({
  useDevicePresentation: () => ({ hostName: 'kontour' }),
}));
vi.mock('@kontourai/station-sdk', () => ({
  useSshEnvironmentsQuery: () => reads.ssh,
  usePeerCredentialsQuery: () => reads.peers,
}));

const PAIRED = {
  environmentId: 'env-brian-media',
  apiBase: 'https://brian-media.example.ts.net',
  label: 'brian-media',
  scope: 'orchestration:read orchestration:operate',
};
const sshEnvironment = (verifiedProjectPath: string | null) => ({
  profile: {
    id: 'ssh-1',
    name: 'build-box',
    environmentId: 'env-build-box',
    verifiedProjectPath,
  },
  state: { phase: 'idle' },
});

beforeEach(() => {
  window.localStorage.clear();
  deviceSettingsStore.reloadFromStorage();
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  });
  Element.prototype.scrollIntoView = vi.fn();
  reads.ssh = { isSuccess: true, isError: false, data: [] };
  reads.peers = { isSuccess: true, isError: false, data: [] };
  caller.grant = OPERATOR;
  caller.read = 'answered';
});
afterEach(cleanup);

describe('StartStationControl', () => {
  test('with another Station to run on, it names where the work runs and opens the Station choice, not a task launcher', () => {
    reads.peers = { isSuccess: true, isError: false, data: [PAIRED] };
    const onOpen = vi.fn();
    render(<StartStationControl canChoose onOpen={onOpen} />);
    const trigger = screen.getByRole('button', {
      name: 'Runs on kontour. Choose where this work runs',
    });
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
    expect(trigger.querySelector('.choice-caret')).not.toBeNull();
    fireEvent.click(trigger);
    expect(onOpen).toHaveBeenCalledWith(trigger);
    // The control owns no dialog of its own: the old trigger mounted the
    // "Run on a Station" task launcher here.
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('a caller refused the paired-Station read sees plain text: no button, no caret', () => {
    // A scoped phone: `GET /api/environments/peers` is `access:manage`.
    reads.peers = { isSuccess: false, isError: true, data: undefined as never };
    const onOpen = vi.fn();
    const { container } = render(
      <StartStationControl canChoose onOpen={onOpen} />,
    );
    expect(screen.getByText('Runs on kontour')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(container.querySelector('.choice-caret')).toBeNull();
  });

  test('an SSH environment the task launcher would refuse (unverified) is not a choice', () => {
    reads.ssh = {
      isSuccess: true,
      isError: false,
      data: [sshEnvironment(null)],
    };
    render(<StartStationControl canChoose onOpen={vi.fn()} />);
    expect(screen.queryByRole('button')).toBeNull();
    cleanup();
    reads.ssh = {
      isSuccess: true,
      isError: false,
      data: [sshEnvironment('/srv/project')],
    };
    render(<StartStationControl canChoose onOpen={vi.fn()} />);
    expect(
      screen.getByRole('button', { name: /^Runs on kontour\./ }),
    ).toBeTruthy();
  });

  test('offers nothing before the Station reads answer, or without an Agent to apply it to', () => {
    // A usable SSH Station is already known, but the paired read has not
    // answered: no partial list is offered.
    reads.ssh = {
      isSuccess: true,
      isError: false,
      data: [sshEnvironment('/srv/project')],
    };
    reads.peers = {
      isSuccess: false,
      isError: false,
      data: undefined as never,
    };
    render(<StartStationControl canChoose onOpen={vi.fn()} />);
    expect(screen.queryByRole('button')).toBeNull();
    cleanup();
    reads.peers = { isSuccess: true, isError: false, data: [PAIRED] };
    render(<StartStationControl canChoose={false} onOpen={vi.fn()} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('Runs on kontour')).toBeTruthy();
  });

  test('a caller that may list Stations but not start tasks on them sees plain text', () => {
    // Reading the lists is `orchestration:read`/`access:manage`; starting
    // the task on another Station is `orchestration:operate`.
    caller.grant = READ_ONLY_DEVICE;
    reads.ssh = {
      isSuccess: true,
      isError: false,
      data: [sshEnvironment('/srv/project')],
    };
    reads.peers = { isSuccess: true, isError: false, data: [PAIRED] };
    const { container } = render(
      <StartStationControl canChoose onOpen={vi.fn()} />,
    );
    expect(screen.getByText('Runs on kontour')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(container.querySelector('.choice-caret')).toBeNull();
    cleanup();
    caller.grant = {
      ...READ_ONLY_DEVICE,
      grantedScopes: ['orchestration:read', 'orchestration:operate'],
    };
    render(<StartStationControl canChoose onOpen={vi.fn()} />);
    expect(
      screen.getByRole('button', { name: /^Runs on kontour\./ }),
    ).toBeTruthy();
  });

  test('inside a Project, an SSH Station is not offered (the launcher refuses it there)', () => {
    reads.ssh = {
      isSuccess: true,
      isError: false,
      data: [sshEnvironment('/srv/project')],
    };
    const { container } = render(
      <StartStationControl canChoose projectSelected onOpen={vi.fn()} />,
    );
    expect(screen.getByText('Runs on kontour')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(container.querySelector('.choice-caret')).toBeNull();
    cleanup();
    render(
      <StartStationControl
        canChoose
        projectSelected={false}
        onOpen={vi.fn()}
      />,
    );
    expect(
      screen.getByRole('button', { name: /^Runs on kontour\./ }),
    ).toBeTruthy();
  });

  test('a paired Station whose credential cannot operate there is not offered', () => {
    reads.peers = {
      isSuccess: true,
      isError: false,
      data: [{ ...PAIRED, scope: 'orchestration:read' }],
    };
    render(<StartStationControl canChoose onOpen={vi.fn()} />);
    expect(screen.queryByRole('button')).toBeNull();
    cleanup();
    reads.peers = { isSuccess: true, isError: false, data: [PAIRED] };
    render(<StartStationControl canChoose onOpen={vi.fn()} />);
    expect(
      screen.getByRole('button', { name: /^Runs on kontour\./ }),
    ).toBeTruthy();
  });

  test('offers nothing while the caller\u2019s authority is still being read', () => {
    caller.read = 'pending';
    reads.peers = { isSuccess: true, isError: false, data: [PAIRED] };
    render(<StartStationControl canChoose onOpen={vi.fn()} />);
    expect(screen.getByText('Runs on kontour')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  test.each(['failed', 'older-host'] as const)(
    'an authority read that %s still offers the listed Stations; the launcher and server enforce',
    async (read) => {
      caller.read = read;
      reads.peers = { isSuccess: true, isError: false, data: [PAIRED] };
      render(<StartStationControl canChoose onOpen={vi.fn()} />);
      expect(
        await screen.findByRole('button', { name: /^Runs on kontour\./ }),
      ).toBeTruthy();
    },
  );

  test('a remembered Station keeps its name when it is not offered to this caller', () => {
    caller.grant = READ_ONLY_DEVICE;
    reads.peers = { isSuccess: true, isError: false, data: [PAIRED] };
    render(
      <StartStationControl
        canChoose
        environmentId="env-brian-media"
        onOpen={vi.fn()}
      />,
    );
    expect(
      screen.getByRole('button', { name: /^Runs on brian-media\./ }),
    ).toBeTruthy();
  });

  test('names the chosen or Project-default Station', () => {
    reads.peers = { isSuccess: true, isError: false, data: [PAIRED] };
    render(
      <StartStationControl
        canChoose
        environmentId="env-brian-media"
        onOpen={vi.fn()}
      />,
    );
    expect(
      screen.getByRole('button', { name: /^Runs on brian-media\./ }),
    ).toBeTruthy();
    cleanup();
    render(
      <StartStationControl
        canChoose
        defaultEnvironment={{
          kind: 'saved',
          id: environmentId('env-brian-media'),
        }}
        onOpen={vi.fn()}
      />,
    );
    expect(
      screen.getByRole('button', { name: /^Runs on brian-media\./ }),
    ).toBeTruthy();
  });
});

test('the Station choice marks where the work runs now and reports the chosen Station', () => {
  const onChoose = vi.fn();
  render(
    <StartStationMenu
      anchor={null}
      layer="dialog"
      stations={[
        { id: 'current', name: 'kontour', kind: 'current' },
        { id: 'env-brian-media', name: 'brian-media', kind: 'paired' },
      ]}
      selectedId="current"
      stationsUnavailable={false}
      onChoose={onChoose}
      onClose={vi.fn()}
    />,
  );
  expect(
    screen.getByRole('dialog', { name: 'Where this work runs' }),
  ).toBeTruthy();
  const here = screen.getByRole('button', { name: /kontour/ });
  const there = screen.getByRole('button', { name: /brian-media/ });
  expect(here.getAttribute('aria-current')).toBe('true');
  expect(there.getAttribute('aria-current')).toBeNull();
  fireEvent.click(there);
  expect(onChoose).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'env-brian-media' }),
  );
});

describe('the start menus wire the Station choice to the start', () => {
  function renderMenus(environment?: string) {
    reads.peers = { isSuccess: true, isError: false, data: [PAIRED] };
    const agent = { slug: 'reviewer', name: 'Reviewer' };
    const start = {
      modelChoiceFor: () =>
        environment
          ? { environmentId: environment, providerOptions: {} }
          : undefined,
      setExecutionEnvironment: vi.fn(),
    };
    const setMenu = vi.fn();
    const trigger = document.createElement('button');
    render(
      <StartPickerMenus
        menu={{ kind: 'station', trigger, agentSlug: 'reviewer' }}
        setMenu={setMenu}
        layer="dialog"
        selection={
          {
            viewModel: { scopedAgents: [agent], selectedProject: undefined },
          } as never
        }
        start={start as never}
        context="station"
        search=""
        onSearch={vi.fn()}
        onFeedbackClear={vi.fn()}
        onSetup={vi.fn()}
        onRepair={vi.fn()}
        enablePending={false}
        onChooseProject={vi.fn()}
        icons={new Map()}
        accents={new Map()}
      />,
    );
    return { agent, start, setMenu, trigger };
  }

  test('choosing another Station sets it for this start and continues to its engine and model', () => {
    const { agent, start, setMenu, trigger } = renderMenus();
    fireEvent.click(screen.getByRole('button', { name: /brian-media/ }));
    expect(start.setExecutionEnvironment).toHaveBeenCalledWith(
      agent,
      'env-brian-media',
    );
    expect(setMenu).toHaveBeenCalledWith({
      kind: 'model',
      trigger,
      agentSlug: 'reviewer',
    });
  });

  test('re-choosing where it already runs changes nothing and closes', () => {
    const { start, setMenu } = renderMenus('env-brian-media');
    fireEvent.click(screen.getByRole('button', { name: /brian-media/ }));
    expect(start.setExecutionEnvironment).not.toHaveBeenCalled();
    expect(setMenu).toHaveBeenCalledWith(null);
  });

  test('choosing This Station back sets it and closes', () => {
    const { agent, start, setMenu } = renderMenus('env-brian-media');
    fireEvent.click(screen.getByRole('button', { name: /kontour/ }));
    expect(start.setExecutionEnvironment).toHaveBeenCalledWith(
      agent,
      'current',
    );
    expect(setMenu).toHaveBeenCalledWith(null);
  });
});
