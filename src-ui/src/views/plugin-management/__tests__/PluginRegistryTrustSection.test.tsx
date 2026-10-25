/** @vitest-environment jsdom */
import type { PluginRegistryTrust } from '@kontourai/station-contracts/registry-trust';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

const recovery = vi.hoisted(() => ({ data: undefined as unknown }));
vi.mock('@kontourai/station-sdk', () => ({
  usePluginRecoveryPreviewQuery: () => ({
    data: recovery.data,
    refetch: async () => ({ data: recovery.data }),
    isFetching: false,
  }),
  usePluginRecoveryMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock('../../../core/PermissionManager', () => ({
  usePermissions: () => ({ requestInstallConsent: vi.fn() }),
}));

import { InstallPreviewModal } from '../InstallPreviewModal';
import { PluginRecoveryPanel } from '../PluginRecoveryPanel';
import { PluginRegistryTrustSection } from '../PluginRegistryTrustSection';

afterEach(cleanup);

const digest = (fill: string) => `sha256:${fill.repeat(64)}`;
// The exact receipt shape the server persists in the activation plan.
const receipt = {
  version: 1 as const,
  policyScope: 'local',
  policyEpoch: 'epoch-7',
  policyFingerprint: digest('a'),
  registryKeyDigest: digest('b'),
  registryId: 'signed-tools',
  claimDigest: digest('c'),
  packageDigest: digest('d'),
  signer: { keyId: 'primary', spkiFingerprint: digest('e') },
};
const signed: PluginRegistryTrust = {
  state: 'verified',
  revision: digest('f'),
  receipt,
};

function section() {
  return screen.getByRole('region', { name: 'Registry verification' });
}

test('a verified claim shows the persisted source, digest, signer, pin and policy outcome', () => {
  render(<PluginRegistryTrustSection trust={signed} context="preview" />);
  const region = within(section());
  const value = (term: string) =>
    region.getByText(term, { selector: 'dt' }).nextElementSibling?.textContent;
  expect(value('Source')).toBe(
    `Registry entry signed-toolsRegistry key ${digest('b')}`,
  );
  expect(value('Package digest')).toBe(digest('d'));
  expect(value('Signer')).toBe(`Key primaryFingerprint ${digest('e')}`);
  expect(value('Pin')).toBe(`${digest('f')}Claim ${digest('c')}`);
  expect(value('Policy')).toBe(
    `Signature verified with a key this policy trusts.Scope local, epoch epoch-7Fingerprint ${digest('a')}`,
  );
  expect(region.getByText(/Installing binds this exact claim and pin/));
});

test('an unsigned receipt names no signer and never claims a signature', () => {
  render(
    <PluginRegistryTrustSection
      trust={{ ...signed, receipt: { ...receipt, signer: null } }}
      context="installed"
    />,
  );
  const text = section().textContent ?? '';
  expect(text).toContain('Unsigned. No signer was verified.');
  expect(text).toContain(
    'Unsigned package accepted because the recorded policy did not require signatures.',
  );
  expect(text).toContain('This is the stored receipt, not a fresh check.');
  expect(text).not.toContain('Signature verified');
  expect(text).not.toContain('Fingerprint sha256:e');
});

test('an installation reports the recorded policy in the past tense', () => {
  render(<PluginRegistryTrustSection trust={signed} context="installed" />);
  const text = section().textContent ?? '';
  expect(text).toContain(
    'Signature verified with a key the recorded policy trusted.',
  );
  expect(text).not.toContain('this policy trusts');
});

test.each([
  [{ state: 'none' } as const, 'No verified registry claim.'],
  [{ state: 'unavailable' } as const, 'could not be read'],
  [undefined, 'did not report registry verification'],
])(
  'without a readable receipt (%o) it says so and shows no claim',
  (trust, says) => {
    render(<PluginRegistryTrustSection trust={trust} context="installed" />);
    const region = section();
    expect(region.textContent).toContain(says);
    expect(region.querySelector('dl')).toBeNull();
    expect(region.textContent).not.toMatch(
      /Signature verified|Installing binds/,
    );
  },
);

test('the install preview renders the claim the preview response carried', () => {
  render(
    <InstallPreviewModal
      previewData={{
        valid: true,
        components: [],
        conflicts: [],
        registryTrustRevision: signed.revision,
        registryTrust: signed,
      }}
      previewSkips={new Set()}
      installPending={false}
      onClose={vi.fn()}
      onToggleSkip={vi.fn()}
      onConfirm={vi.fn()}
    />,
  );
  expect(section().textContent).toContain(digest('f'));
  expect(section().textContent).toContain('Key primary');
});

test('a preview with no verified claim says so instead of staying silent', () => {
  render(
    <InstallPreviewModal
      previewData={{
        valid: true,
        components: [],
        conflicts: [],
        registryTrust: { state: 'none' },
      }}
      previewSkips={new Set()}
      installPending={false}
      onClose={vi.fn()}
      onToggleSkip={vi.fn()}
      onConfirm={vi.fn()}
    />,
  );
  expect(section().textContent).toContain(
    'No verified registry claim. Station has no verified source, signer or registry pin for this package.',
  );
});

test('the recovery review shows the recovery view’s receipt, not the list row’s', async () => {
  recovery.data = {
    recoveryRevision: 'review-1',
    contentDigest: digest('d'),
    grantRevision: 'grant-1',
    registryTrustRevision: signed.revision,
    registryTrust: signed,
    permissions: { required: [], autoGranted: [], pendingConsent: [] },
    dependencies: [],
  };
  render(
    <PluginRecoveryPanel
      plugin={{
        name: 'signed-tools',
        displayName: 'Signed Tools',
        version: '1.0.0',
        hasBundle: false,
        installationReadiness: { state: 'pending', recovery: 'review' },
        // A stale list row must not stand in for the reviewed receipt.
        registryTrust: { state: 'none' },
      }}
      onRemove={vi.fn()}
    />,
  );
  expect(
    screen.queryByRole('region', { name: 'Registry verification' }),
  ).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Review recovery' }));
  await waitFor(() => expect(section().textContent).toContain(digest('d')));
  expect(section().textContent).toContain(
    'Recorded when this installation was verified.',
  );
  expect(section().textContent).not.toContain('No verified registry claim');
  recovery.data = undefined;
});
