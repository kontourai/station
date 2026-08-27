/**
 * Content-free client for importing a supported existing agent setup.
 *
 * This module deliberately owns the complete route vocabulary.  Browser
 * hooks, the CLI, and any future non-React caller receive stable projections
 * instead of re-creating paths or request bodies at their call sites.
 */
import { apiErrorMessage } from './api-error-message';
import { type ClientRequestOptions, getJson, mutateJson } from './http';

interface Envelope<T> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface ExistingSetupImportSource {
  id: string;
  available: boolean;
}

export interface ExistingSetupImportEntry {
  id: string;
  /** Source-relative identity only; never a local filesystem path. */
  name: string;
  size: number;
  digest: string;
  skillName: string;
  collision: boolean;
  /** Server-derived, stable reason codes; never client heuristics. */
  warnings: string[];
}

export interface ExistingSetupImportPreview {
  id: string;
  createdAt: string;
  expiresAt: string;
  entries: ExistingSetupImportEntry[];
  excluded: Record<string, number>;
  /** Server-derived warnings from the reviewed source/exclusion state. */
  warnings: string[];
}

export interface ExistingSetupImportItem {
  id: string;
  action: 'import' | 'skip';
  targetName?: string;
}
export interface ExistingSetupImportTargetWitness {
  id: string;
  expiresAt: string;
  items: Array<ExistingSetupImportItem & { targetRevision?: string | null }>;
}
export interface ExistingSetupImportTargetReview {
  preview: ExistingSetupImportPreview;
  witness: ExistingSetupImportTargetWitness;
}

export interface ExistingSetupImportOutcome {
  /** Source-relative identity from the persisted review record. */
  sourceId: string;
  reviewedTarget?: string;
  state:
    | 'pending'
    | 'applying'
    | 'applied'
    | 'skipped'
    | 'failed'
    | 'compensating'
    | 'compensated'
    | 'indeterminate';
  outcome: 'imported' | 'skipped' | 'failed' | 'rolled-back' | 'indeterminate';
  reasonCode?: string;
  repairCode?: string;
  targetRevision?: string;
  rollback: {
    state: 'available' | 'applied' | 'conflict' | 'failed' | 'indeterminate';
    retryable: boolean;
  };
}

export interface ExistingSetupImportReceipt {
  id: string;
  createdAt: string;
  previewId: string;
  /** The server's persisted effect journal projection. */
  items: ExistingSetupImportOutcome[];
  retryable: boolean;
  rolledBackAt?: string;
}

function resultData<T>(result: Envelope<T>, fallback: string): T {
  if (!result.success || result.data === undefined) {
    throw new Error(apiErrorMessage(result, fallback));
  }
  return result.data;
}

/** `GET /api/setup-imports/sources` — supported source capabilities. */
export async function fetchExistingSetupImportSources(
  apiBase: string,
  opts?: ClientRequestOptions,
): Promise<ExistingSetupImportSource[]> {
  const response = await getJson(`${apiBase}/api/setup-imports/sources`, opts);
  return resultData(
    (await response.json()) as Envelope<ExistingSetupImportSource[]>,
    'Failed to load setup import sources',
  );
}

/** Alias that makes a capability probe explicit for UI callers. */
export const detectExistingSetupImportSources = fetchExistingSetupImportSources;

/** `POST /api/setup-imports/previews` — inspect a server-owned source. */
export async function createExistingSetupImportPreview(
  apiBase: string,
  sourceId: string,
  opts?: ClientRequestOptions,
): Promise<ExistingSetupImportPreview> {
  const response = await mutateJson(
    `${apiBase}/api/setup-imports/previews`,
    'POST',
    opts,
    { sourceId },
  );
  return resultData(
    (await response.json()) as Envelope<ExistingSetupImportPreview>,
    'Failed to create setup import preview',
  );
}

/** `POST /api/setup-imports/previews/:id/targets` — bind final targets. */
export async function reviewExistingSetupImportTargets(
  apiBase: string,
  input: { previewId: string; items: ExistingSetupImportItem[] },
  opts?: ClientRequestOptions,
): Promise<ExistingSetupImportTargetReview> {
  const response = await mutateJson(
    `${apiBase}/api/setup-imports/previews/${encodeURIComponent(input.previewId)}/targets`,
    'POST',
    opts,
    { items: input.items },
  );
  return resultData(
    (await response.json()) as Envelope<ExistingSetupImportTargetReview>,
    'Failed to review setup import targets',
  );
}

/** `POST /api/setup-imports/previews/:id/apply` — apply an explicit witness. */
export async function applyExistingSetupImport(
  apiBase: string,
  input: { previewId: string; witnessId: string },
  opts?: ClientRequestOptions,
): Promise<ExistingSetupImportReceipt> {
  const response = await mutateJson(
    `${apiBase}/api/setup-imports/previews/${encodeURIComponent(input.previewId)}/apply`,
    'POST',
    opts,
    { witnessId: input.witnessId },
  );
  return resultData(
    (await response.json()) as Envelope<ExistingSetupImportReceipt>,
    'Failed to apply setup import',
  );
}

/** `GET /api/setup-imports/receipts/:id` — durable import outcome. */
export async function fetchExistingSetupImportReceipt(
  apiBase: string,
  receiptId: string,
  opts?: ClientRequestOptions,
): Promise<ExistingSetupImportReceipt> {
  const response = await getJson(
    `${apiBase}/api/setup-imports/receipts/${encodeURIComponent(receiptId)}`,
    opts,
  );
  return resultData(
    (await response.json()) as Envelope<ExistingSetupImportReceipt>,
    'Setup import receipt not found',
  );
}

/** `POST /api/setup-imports/receipts/:id/rollback` — compensate one receipt. */
export async function rollbackExistingSetupImport(
  apiBase: string,
  receiptId: string,
  opts?: ClientRequestOptions,
): Promise<ExistingSetupImportReceipt> {
  const response = await mutateJson(
    `${apiBase}/api/setup-imports/receipts/${encodeURIComponent(receiptId)}/rollback`,
    'POST',
    opts,
  );
  return resultData(
    (await response.json()) as Envelope<ExistingSetupImportReceipt>,
    'Failed to roll back setup import',
  );
}
