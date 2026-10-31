/** @vitest-environment jsdom */
import { LEARNING_REVIEW_PREVIEW } from '@kontourai/station-contracts/learning-review';
import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Hono } from 'hono';
import { afterEach, expect, test, vi } from 'vitest';
import { evidence, proposal, scope } from '../../../../../src-server/__test-utils__/learning-review-fixture.js';
import { createProjectLearningReviewRoutes } from '../../../../../src-server/routes/projects/learning-review-routes.js';
import { LearningReviewService, type LearningLifecycleOwnerPort } from '../../../../../src-server/services/learning-review/learning-review-service.js';
import { LearningReviewPanel } from '../LearningReviewPanel';

const flags = vi.hoisted(() => new Set<string>());
vi.mock('../../../hooks/useSurfaceVisibilityFlags', () => ({ useSurfaceVisibilityFlags: () => flags }));
const clients: QueryClient[] = [];
afterEach(() => { cleanup(); for (const client of clients.splice(0)) client.clear(); flags.clear(); setClientCredentialResolver(undefined); vi.unstubAllGlobals(); });

test('real Project review renders evidence and receipts, and an activation acknowledgement cannot turn into active guidance', async () => {
  flags.add(LEARNING_REVIEW_PREVIEW);
  const apply = vi.fn(async () => ({ id: 'activation-receipt', intentId: 'intent', requestDigest: 'd'.repeat(64), learningId: proposal.record.id,
    revision: 2, action: 'activate' as const, actorId: 'person:reviewer', at: '2026-10-30T10:01:00.000Z' }));
  const owner: LearningLifecycleOwnerPort = { version: 'knowledge.learning/v1', authority: 'knowledge-kit',
    get: async () => structuredClone(proposal), list: async () => ({ records: [structuredClone(proposal)], coverage: 'partial' }), apply };
  const service = new LearningReviewService(owner, async () => ({ scope, supporting: [evidence], counter: [], conflicts: [], targets: proposal.record.proposal.targets }));
  const app = new Hono().route('/api/projects', createProjectLearningReviewRoutes({ enabled: () => true,
    authorize: async () => ({ scope, service, isCurrent: () => true }) }));
  const authority = { apiBase: 'http://learning.test', authorityKey: 'operator', isCurrent: () => true };
  setClientCredentialResolver(() => ({ origin: authority.apiBase, requestAuthority: authority }));
  vi.stubGlobal('fetch', vi.fn(async (url: string | Request, init?: RequestInit) => app.request(String(url), init)));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); clients.push(client);
  render(<QueryClientProvider client={client}><LearningReviewPanel slug="demo" projectId="project-id" authority={authority} /></QueryClientProvider>);
  fireEvent.change(await screen.findByLabelText('Learning'), { target: { value: 'learning-one' } });
  expect(await screen.findByText('Proposed guidance')).toBeTruthy();
  expect(screen.getByText('No effect observed.')).toBeTruthy();
  expect(screen.getByText('Some owner records or evidence are unavailable.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Decision receipts (1)' }));
  expect(screen.getByText(/receipt-propose/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'activate' } });
  fireEvent.click(screen.getByRole('button', { name: 'Submit to owner' }));
  await waitFor(() => expect(apply).toHaveBeenCalledWith(expect.objectContaining({ action: 'activate', expectedRevision: 1, scope })));
  await waitFor(() => expect(screen.getByText('Not active')).toBeTruthy());
  expect(screen.queryByText('Active guidance')).toBeNull();
});

test('unsupported host gives a retryable upgrade/preview explanation without exposing a proposal editor by default', async () => {
  flags.add(LEARNING_REVIEW_PREVIEW);
  const authority = { apiBase: 'http://old-host.test', authorityKey: 'operator', isCurrent: () => true };
  setClientCredentialResolver(() => ({ origin: authority.apiBase, requestAuthority: authority }));
  vi.stubGlobal('fetch', vi.fn(async () => new Response('Not found', { status: 404 })));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client);
  render(<QueryClientProvider client={client}><LearningReviewPanel slug="demo" projectId="project-id" authority={authority} /></QueryClientProvider>);
  expect(await screen.findByText(/Learning review is unsupported on this host/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  expect(screen.queryByLabelText('Proposed guidance')).toBeNull();
});
