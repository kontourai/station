/**
 * @vitest-environment jsdom
 *
 * archive#1399: shipped
 * `attestationState` data with no reader anywhere in the product — nothing
 * inspected it, so an `'unattested'` claiming block rendered identically to
 * an `'attested'` one. This suite proves the minimal visible treatment: a
 * badge on `'unattested'` card/table blocks, and NOTHING extra on
 * `'decorative'` ones (there is nothing to mark unattested about prose).
 */
import type {
  UICardBlock,
  UITableBlock,
} from '@kontourai/station-contracts/ui-block';
import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { SyntaxHighlighterProvider } from '../../../contexts/SyntaxHighlighterContext';

const { highlightCode } = vi.hoisted(() => ({ highlightCode: vi.fn() }));
vi.mock('../../../highlight/highlight-client', () => ({ highlightCode }));

import { UIBlockRenderer } from '../UIBlockRenderer';

describe('UIBlockRenderer — attestation badge (station#1399 fix round, H2)', () => {
  test('renders an Unattested badge on a claiming card block with attestationState unattested', () => {
    const block: UICardBlock = {
      type: 'card',
      body: 'All checks passed',
      fields: [{ label: 'Coverage', value: '98%' }],
      attestationState: 'unattested',
    };
    render(<UIBlockRenderer block={block} />);
    expect(screen.getByText('Unattested')).toBeTruthy();
  });

  // archive#1399: the badge carries
  // the precise meaning of 'attested' — a receipted source DECLARATION
  // with a bound digest, not "sources verified to exist" — as a tooltip.
  test('the Unattested badge carries the precise-meaning tooltip', () => {
    const block: UICardBlock = {
      type: 'card',
      body: 'All checks passed',
      fields: [{ label: 'Coverage', value: '98%' }],
      attestationState: 'unattested',
    };
    render(<UIBlockRenderer block={block} />);
    const badgeText = screen.getByText('Unattested');
    const tooltipHost = badgeText.closest('[title]');
    expect(tooltipHost?.getAttribute('title')).toMatch(
      /not verified against anything/,
    );
  });

  test('renders an Unattested badge on a claiming table block with attestationState unattested', () => {
    const block: UITableBlock = {
      type: 'table',
      columns: ['Name', 'Status'],
      rows: [['report.md', 'generated']],
      attestationState: 'unattested',
    };
    render(<UIBlockRenderer block={block} />);
    expect(screen.getByText('Unattested')).toBeTruthy();
  });

  test('renders NO badge on a decorative card block (no data claim)', () => {
    const block: UICardBlock = {
      type: 'card',
      body: 'All checks passed',
      attestationState: 'decorative',
    };
    render(<UIBlockRenderer block={block} />);
    expect(screen.queryByText('Unattested')).toBeNull();
  });

  test('renders NO badge on a decorative table block (columns but no rows)', () => {
    const block: UITableBlock = {
      type: 'table',
      columns: ['Name', 'Status'],
      rows: [],
      attestationState: 'decorative',
    };
    render(<UIBlockRenderer block={block} />);
    expect(screen.queryByText('Unattested')).toBeNull();
  });

  test('renders NO badge on an attested claiming block', () => {
    const block: UICardBlock = {
      type: 'card',
      body: 'All checks passed',
      fields: [{ label: 'Coverage', value: '98%' }],
      derivedFrom: [{ kind: 'toolCallId', toolCallId: 'call_1' }],
      provenanceDigest: 'a'.repeat(64),
      attestationState: 'attested',
    };
    render(<UIBlockRenderer block={block} />);
    expect(screen.queryByText('Unattested')).toBeNull();
  });

  test('renders NO badge when attestationState is entirely absent (not yet stamped)', () => {
    const block: UICardBlock = {
      type: 'card',
      body: 'All checks passed',
      fields: [{ label: 'Coverage', value: '98%' }],
    };
    render(<UIBlockRenderer block={block} />);
    expect(screen.queryByText('Unattested')).toBeNull();
  });
});

test('code blocks use the async highlight client and discard stale results and failures', async () => {
  let finish!: (html: string) => void;
  highlightCode.mockImplementationOnce(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  );
  const mounted = render(
    <UIBlockRenderer block={{ type: 'code', code: '<old>', language: 'ts' }} />,
    { wrapper: SyntaxHighlighterProvider },
  );
  expect(screen.getByText('<old>')).toBeTruthy();
  await waitFor(() =>
    expect(highlightCode).toHaveBeenCalledWith('<old>', 'ts'),
  );
  highlightCode.mockResolvedValueOnce(
    '<pre><code><span>new highlighted</span></code></pre>',
  );
  mounted.rerender(
    <UIBlockRenderer block={{ type: 'code', code: 'new', language: 'js' }} />,
  );
  await screen.findByText('new highlighted');
  await act(async () => finish('<pre><code>old highlighted</code></pre>'));
  expect(screen.queryByText('old highlighted')).toBeNull();
  highlightCode.mockRejectedValueOnce(new Error('worker unavailable'));
  mounted.rerender(
    <UIBlockRenderer
      block={{ type: 'code', code: '<script>current</script>', language: 'ts' }}
    />,
  );
  await waitFor(() =>
    expect(highlightCode).toHaveBeenLastCalledWith(
      '<script>current</script>',
      'ts',
    ),
  );
  expect(screen.getByText('<script>current</script>')).toBeTruthy();
  expect(mounted.container.querySelector('script')).toBeNull();
  expect(screen.queryByText('new highlighted')).toBeNull();
  mounted.unmount();
});
