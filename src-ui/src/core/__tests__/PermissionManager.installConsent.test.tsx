/** @vitest-environment jsdom */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

/**
 * station#4288 — the pre-install decision.
 *
 * `requestInstallConsent` is asked about a plugin that does NOT exist yet, so
 * approving it cannot record anything: a grant binds to the content of an
 * installed tree, and there is no tree. The claim under test is that it
 * therefore reaches no server surface at all — not the grant route, not the
 * host-approval route — and produces only the answer, which the caller
 * carries into `POST /install`.
 */

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('@kontourai/station-sdk', () => ({
  authenticatedFetch: (...args: unknown[]) => fetchMock(...args),
}));

vi.mock('../../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://localhost:3141' }),
}));

vi.mock('../../platform/native/useNativeConsentBroker', () => ({
  useNativeConsentBroker: () => null,
}));

import { PermissionManager, usePermissions } from '../PermissionManager';

const TRUSTED_AND_ACTIVE = [
  { permission: 'network.fetch', tier: 'active' as const },
  { permission: 'plugin.server', tier: 'trusted' as const },
];

const TRUSTED_ONLY = [
  { permission: 'plugin.server', tier: 'trusted' as const },
];

function Harness({
  onResult,
  permissions,
}: {
  onResult: (granted: boolean) => void;
  permissions: typeof TRUSTED_AND_ACTIVE;
}) {
  const { requestInstallConsent } = usePermissions();
  return (
    <button
      type="button"
      onClick={() => {
        void requestInstallConsent(
          'demo-plugin',
          'Demo Plugin',
          permissions,
        ).then(onResult);
      }}
    >
      Ask
    </button>
  );
}

function ask(permissions = TRUSTED_AND_ACTIVE) {
  const results: boolean[] = [];
  render(
    <PermissionManager>
      <Harness
        onResult={(granted) => results.push(granted)}
        permissions={permissions}
      />
    </PermissionManager>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
  return results;
}

beforeEach(() => {
  fetchMock.mockReset();
  // Any call at all is the defect: if the prompt reached a server surface it
  // would be granting against a plugin that is not installed.
  fetchMock.mockImplementation(() => {
    throw new Error('the pre-install prompt must not call the server');
  });
});

test('names the plugin as not yet installed, and offers Install rather than Approve', async () => {
  ask();

  expect(await screen.findByText('Install this plugin?')).toBeTruthy();
  expect(
    screen.getByText(/has not been installed yet\. Installing it requires:/),
  ).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Install' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Review trusted access' })).toBe(
    null,
  );
  // The trusted note says where that tier is actually decided, which is not
  // here: this prompt cannot authorize it.
  expect(
    screen.getByText(/after the install, a separate host-owned review page/),
  ).toBeTruthy();
});

test('approving resolves the decision and reaches no server surface', async () => {
  const results = ask();

  fireEvent.click(await screen.findByRole('button', { name: 'Install' }));

  await waitFor(() => expect(results).toEqual([true]));
  expect(fetchMock).not.toHaveBeenCalled();
  expect(screen.queryByText('Install this plugin?')).toBe(null);
});

test('declining resolves false and reaches no server surface', async () => {
  const results = ask();

  fireEvent.click(await screen.findByRole('button', { name: 'Deny' }));

  await waitFor(() => expect(results).toEqual([false]));
  expect(fetchMock).not.toHaveBeenCalled();
});

/**
 * station#4288, review LOW 4. A plugin whose ONLY pending permission is
 * trusted still opens this prompt — the decision it takes is "install these
 * bytes", which the trusted tier has nothing to do with. So the pre-install
 * copy has to render here too, and the button must not read "Review trusted
 * access": that label belongs to the post-install prompt, which is the one
 * that can open the host review. A same-origin click cannot authorize the
 * trusted tier, and this prompt does not claim to.
 */
test('renders the pre-install copy when the only pending permission is trusted', async () => {
  const results = ask(TRUSTED_ONLY);

  expect(await screen.findByText('Install this plugin?')).toBeTruthy();
  expect(
    screen.getByText(/has not been installed yet\. Installing it requires:/),
  ).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Install' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Review trusted access' })).toBe(
    null,
  );
  expect(screen.getByText(/They are not granted by installing/)).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: 'Install' }));
  await waitFor(() => expect(results).toEqual([true]));
  // Approving an install decision grants nothing — least of all the trusted
  // tier this prompt just said it cannot decide.
  expect(fetchMock).not.toHaveBeenCalled();
});
