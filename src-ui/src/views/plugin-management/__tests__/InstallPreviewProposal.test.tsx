/** @vitest-environment jsdom */
import type { PluginLifecycleProposal } from '@kontourai/station-contracts/plugin';
import { render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { InstallPreviewModal } from '../InstallPreviewModal';

/**
 * #2323 S5: a preview reached from an agent's proposal says who proposed it,
 * and warns when the bytes staged now are not the bytes the agent proposed.
 * The digests compared are the proposal's recorded one and the preview's own
 * `contentDigest` (the server test pins that the two use one encoding).
 */
const DIGEST_AT_PROPOSAL = `sha256:${'1'.repeat(64)}`;
const DIGEST_NOW = `sha256:${'2'.repeat(64)}`;

function proposal(
  overrides: Partial<PluginLifecycleProposal> = {},
): PluginLifecycleProposal {
  return {
    id: 'p1',
    kind: 'install',
    source: '/tmp/pulse',
    rationale: 'Adds the pulse pane.',
    author: { principal: 'agent', agentSlug: 'station', conversationId: 'c1' },
    createdAt: '2026-09-22T00:00:00.000Z',
    updatedAt: '2026-09-22T00:00:00.000Z',
    proposedContentDigest: DIGEST_AT_PROPOSAL,
    status: 'open',
    ...overrides,
  };
}

function renderPreview(
  contentDigest: string | undefined,
  value: PluginLifecycleProposal | null,
) {
  return render(
    <InstallPreviewModal
      previewData={{
        valid: true,
        components: [],
        conflicts: [],
        contentDigest,
        manifest: { name: 'pulse', version: '1.0.0' } as never,
      }}
      previewSkips={new Set()}
      installPending={false}
      onClose={vi.fn()}
      onToggleSkip={vi.fn()}
      onConfirm={vi.fn()}
      proposal={value}
    />,
  );
}

test('names the proposing agent and conversation, and shows its rationale', () => {
  renderPreview(DIGEST_AT_PROPOSAL, proposal());
  const block = screen.getByTestId('install-preview-proposal');
  expect(block.textContent).toContain('Proposed by station in conversation c1');
  expect(block.textContent).toContain('Adds the pulse pane.');
  expect(screen.queryByTestId('install-preview-proposal-changed')).toBeNull();
});

test('warns “changed since proposed” when the preview digest differs', () => {
  renderPreview(DIGEST_NOW, proposal());
  const warning = screen.getByTestId('install-preview-proposal-changed');
  expect(warning.getAttribute('role')).toBe('alert');
  expect(warning.textContent).toContain('Changed since proposed');
  // The decision stays the person's: the confirm button is still there.
  expect(screen.getByRole('button', { name: 'Confirm Install' })).toBeTruthy();
});

test('says it cannot tell when nothing was recorded at proposal time', () => {
  renderPreview(DIGEST_NOW, proposal({ proposedContentDigest: undefined }));
  expect(
    screen.getByTestId('install-preview-proposal-unrecorded'),
  ).toBeTruthy();
  expect(screen.queryByTestId('install-preview-proposal-changed')).toBeNull();
});

test('an ordinary preview shows no proposal block', () => {
  renderPreview(DIGEST_NOW, null);
  expect(screen.queryByTestId('install-preview-proposal')).toBeNull();
});
