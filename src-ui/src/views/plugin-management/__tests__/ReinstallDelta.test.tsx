/** @vitest-environment jsdom */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { InstallPreviewModal } from '../InstallPreviewModal';
import type { PreviewData, ReinstallFromSource } from '../types';

/**
 * #2323 S4: the "Reinstall from source" preview shows what changes against
 * the installed plugin before the person confirms. Rendered through the real
 * `InstallPreviewModal`, the dialog the Plugins view opens.
 */
const reinstall: ReinstallFromSource = {
  pluginName: 'pulse',
  projectName: 'Pulse Lab',
  installedVersion: '1.0.0',
  grantedPermissions: ['navigation.dock', 'network.fetch'],
  installedSourceDigest: 'sha256:installed',
};

function preview(overrides: Partial<PreviewData> = {}): PreviewData {
  return {
    valid: true,
    manifest: {
      name: 'pulse',
      displayName: 'Connected Pulse',
      version: '1.1.0',
      hasBundle: true,
    },
    components: [],
    conflicts: [],
    existingDataScope: true,
    contentDigest: 'sha256:edited',
    permissions: {
      required: ['navigation.dock', 'agents.invoke'],
      autoGranted: ['navigation.dock'],
      pendingConsent: [{ permission: 'agents.invoke', tier: 'active' }],
    },
    ...overrides,
  };
}

function renderModal(
  previewData: PreviewData,
  context: ReinstallFromSource | null = reinstall,
) {
  const onConfirm = vi.fn();
  render(
    <InstallPreviewModal
      previewData={previewData}
      previewSkips={new Set()}
      installPending={false}
      onClose={vi.fn()}
      onToggleSkip={vi.fn()}
      onConfirm={onConfirm}
      reinstall={context}
    />,
  );
  return onConfirm;
}

describe('#2323 S4 reinstall delta', () => {
  test('lists the permissions the new version adds and drops against the current grants, and says the code changed', () => {
    const onConfirm = renderModal(preview());
    expect(
      screen.getByRole('heading', { name: 'Reinstall from source' }),
    ).toBeTruthy();
    const delta = screen.getByTestId('reinstall-delta');
    expect(delta.textContent).toContain('Installed v1.0.0');
    expect(delta.textContent).toContain('this folder has v1.1.0');
    expect(screen.getByTestId('reinstall-delta-code').textContent).toBe(
      'Code changed since it was installed.',
    );
    const added = screen.getByTestId('reinstall-delta-added');
    expect(within(added).getAllByRole('listitem')).toHaveLength(1);
    expect(added.textContent).toContain('agents.invoke');
    const removed = screen.getByTestId('reinstall-delta-removed');
    expect(within(removed).getAllByRole('listitem')).toHaveLength(1);
    expect(removed.textContent).toContain('network.fetch');
    // An unchanged grant is in neither list.
    expect(added.textContent).not.toContain('navigation.dock');
    expect(removed.textContent).not.toContain('navigation.dock');
    expect(
      screen.queryByTestId('reinstall-delta-permissions-unchanged'),
    ).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Reinstall' }));
    expect(onConfirm).toHaveBeenLastCalledWith('preserve');
  });

  test('the same permissions and bytes read as no permission changes and unchanged code', () => {
    renderModal(
      preview({
        contentDigest: 'sha256:installed',
        permissions: {
          required: ['network.fetch', 'navigation.dock'],
          autoGranted: ['navigation.dock'],
          pendingConsent: [{ permission: 'network.fetch', tier: 'active' }],
        },
      }),
    );
    expect(
      screen.getByTestId('reinstall-delta-permissions-unchanged'),
    ).toBeTruthy();
    expect(screen.queryByTestId('reinstall-delta-added')).toBeNull();
    expect(screen.queryByTestId('reinstall-delta-removed')).toBeNull();
    expect(screen.getByTestId('reinstall-delta-code').textContent).toBe(
      'The code is the same as what is installed.',
    );
  });

  test('with no recorded installed digest the code comparison is unknown, never unchanged', () => {
    const { installedSourceDigest: _omitted, ...withoutDigest } = reinstall;
    renderModal(preview(), withoutDigest);
    expect(screen.getByTestId('reinstall-delta-code').textContent).toBe(
      'Station has no record of the installed code to compare with.',
    );
  });

  test('a preview that reported no permissions shows no permission delta rather than every grant dropped', () => {
    renderModal(preview({ permissions: undefined }));
    expect(screen.queryByTestId('reinstall-delta-removed')).toBeNull();
    expect(
      screen.queryByTestId('reinstall-delta-permissions-unchanged'),
    ).toBeNull();
  });

  test('an ordinary install preview shows no delta', () => {
    renderModal(preview(), null);
    expect(screen.queryByTestId('reinstall-delta')).toBeNull();
    expect(
      screen.getByRole('heading', { name: 'Install Preview' }),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Confirm Install' }),
    ).toBeTruthy();
  });
});
