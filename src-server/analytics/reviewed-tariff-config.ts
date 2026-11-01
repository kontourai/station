import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  type CatalogSnapshot,
  validateCatalogSnapshot,
} from '@kontourai/bearing';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import { z } from 'zod/v3';
import {
  readPrivateJsonFile,
  writePrivateJsonFileSync,
} from '../services/notifications/private-json-file.js';
import {
  BearingUsagePricingSnapshotCapture,
  type ReviewedTariffBinding,
} from './bearing-usage-pricing-snapshot-capture.js';
import type { UsagePricingSnapshotCapture } from './usage-pricing-snapshot-capture.js';

const MAX_BYTES = 2 * 1024 * 1024;
const text = z.string().min(1).max(512);
const date = z.string().datetime();
const binding = z
  .object({
    observationId: text,
    provider: text,
    model: text,
    basis: z
      .object({
        routeId: text,
        modelRevision: text,
        tariffId: text,
        sourceUrl: z.string().url().max(2048),
        sourceArtifactId: text,
        reviewedAt: date,
        effectiveAt: date,
        validUntil: date,
        cacheInput: z.enum(['disjoint', 'included']),
        reasoning: z.enum(['included-in-output', 'separate', 'unknown']),
      })
      .strict(),
    measurements: z
      .object({
        input: text.optional(),
        output: text.optional(),
        cacheRead: text.optional(),
        cacheWrite: text.optional(),
        reasoning: text.optional(),
      })
      .strict(),
  })
  .strict();
const request = z
  .object({
    expectedRevision: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
    operationId: z.string().uuid(),
    catalog: z.unknown(),
    bindings: z.array(binding).min(1).max(64),
  })
  .strict();
const stored = z
  .object({
    version: z.literal('station.reviewed-tariffs/v1'),
    revision: z.number().int().positive(),
    operationId: z.string().uuid(),
    requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
    reviewedBy: text,
    reviewedAt: date,
    catalog: z.unknown(),
    bindings: z.array(binding).min(1).max(64),
    catalogDigest: text,
  })
  .strict();
export interface ReviewedTariffConfiguration {
  version: 'station.reviewed-tariffs/v1';
  revision: number;
  operationId: string;
  requestDigest: string;
  reviewedBy: string;
  reviewedAt: string;
  catalog: CatalogSnapshot;
  bindings: ReviewedTariffBinding[];
  catalogDigest: string;
}
export type ReviewedTariffConfigurationRead =
  | {
      state: 'available';
      configuration: ReviewedTariffConfiguration;
      capture: BearingUsagePricingSnapshotCapture;
    }
  | { state: 'not-configured' | 'unavailable' };
export class ReviewedTariffConfigurationError extends Error {
  constructor(
    readonly code: 'restricted' | 'conflict' | 'invalid' | 'unavailable',
  ) {
    super(`Reviewed tariff configuration ${code}`);
  }
}

/** Host-private reviewed configuration; reading neither fetches tariffs nor approves a mapping. */
export class ReviewedTariffConfigurationService {
  private readonly root: string;
  private readonly anchor: { dev: number; ino: number };
  private readonly file: string;
  private cached?: {
    fingerprint: string;
    capture: BearingUsagePricingSnapshotCapture;
  };
  constructor(privateRoot: string) {
    this.root = resolve(privateRoot);
    const anchor = lstatSync(this.root);
    this.anchor = { dev: anchor.dev, ino: anchor.ino };
    this.file = join(this.root, 'reviewed-usage-tariffs.json');
    this.assertRoot();
  }
  private assertRoot() {
    const current = lstatSync(this.root);
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.dev !== this.anchor.dev ||
      current.ino !== this.anchor.ino ||
      (process.platform !== 'win32' &&
        (current.uid !== process.getuid?.() || (current.mode & 0o077) !== 0))
    )
      throw new ReviewedTariffConfigurationError('unavailable');
  }
  private fingerprint(): string | undefined {
    try {
      const value = lstatSync(this.file);
      if (
        !value.isFile() ||
        value.isSymbolicLink() ||
        value.nlink !== 1 ||
        value.size > MAX_BYTES ||
        (process.platform !== 'win32' && (value.mode & 0o777) !== 0o600)
      )
        throw new ReviewedTariffConfigurationError('unavailable');
      return JSON.stringify([
        value.dev,
        value.ino,
        value.size,
        value.mtimeMs,
        value.ctimeMs,
        value.mode,
      ]);
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ENOENT'
      )
        return undefined;
      throw error;
    }
  }
  /** Approved updates atomically replace the file; unchanged token observations reuse inert parsed rates. */
  async capture(input: Parameters<UsagePricingSnapshotCapture['capture']>[0]) {
    try {
      this.assertRoot();
      const fingerprint = this.fingerprint();
      if (!fingerprint) {
        this.cached = undefined;
        return undefined;
      }
      if (this.cached?.fingerprint === fingerprint)
        return this.cached.capture.capture(input);
      const loaded = this.read();
      return loaded.state === 'available'
        ? loaded.capture.capture(input)
        : undefined;
    } catch {
      this.cached = undefined;
      return undefined;
    }
  }
  read(): ReviewedTariffConfigurationRead {
    try {
      this.assertRoot();
      const fingerprint = this.fingerprint();
      const value = readPrivateJsonFile(
        this.file,
        MAX_BYTES,
        'reviewed tariffs',
      );
      if (value === null) {
        this.cached = undefined;
        return { state: 'not-configured' };
      }
      const parsed = stored.parse(value);
      const catalog = validateCatalogSnapshot(parsed.catalog);
      if (parsed.catalogDigest !== catalog.digest)
        throw new ReviewedTariffConfigurationError('invalid');
      const capture = new BearingUsagePricingSnapshotCapture(
        catalog,
        parsed.bindings,
      );
      this.assertRoot();
      if (!fingerprint || fingerprint !== this.fingerprint())
        throw new ReviewedTariffConfigurationError('unavailable');
      this.cached = { fingerprint, capture };
      return {
        state: 'available',
        configuration: { ...parsed, catalog },
        capture,
      };
    } catch {
      this.cached = undefined;
      return { state: 'unavailable' };
    }
  }
  async review(
    input: unknown,
    admission: { actorId: string; assertCurrent(): void },
  ): Promise<ReviewedTariffConfiguration> {
    admission.assertCurrent();
    const parsed = request.parse(input);
    if (Buffer.byteLength(JSON.stringify(parsed)) > MAX_BYTES)
      throw new ReviewedTariffConfigurationError('invalid');
    const catalog = validateCatalogSnapshot(parsed.catalog);
    new BearingUsagePricingSnapshotCapture(catalog, parsed.bindings);
    this.assertRoot();
    const release = await acquireFileMutationLockAsync(`${this.file}.mutation`);
    try {
      admission.assertCurrent();
      const current = this.read();
      if (current.state === 'unavailable')
        throw new ReviewedTariffConfigurationError('unavailable');
      const digest = createHash('sha256')
        .update(JSON.stringify(parsed))
        .digest('hex');
      if (
        current.state === 'available' &&
        current.configuration.operationId === parsed.operationId
      ) {
        if (
          current.configuration.requestDigest !== digest ||
          current.configuration.reviewedBy !== admission.actorId
        )
          throw new ReviewedTariffConfigurationError('conflict');
        return current.configuration;
      }
      if (
        (current.state === 'available' ? current.configuration.revision : 0) !==
        parsed.expectedRevision
      )
        throw new ReviewedTariffConfigurationError('conflict');
      const reviewedBy = text.parse(admission.actorId);
      const reviewedAt = new Date().toISOString();
      const configuration: ReviewedTariffConfiguration = {
        version: 'station.reviewed-tariffs/v1',
        revision: parsed.expectedRevision + 1,
        operationId: parsed.operationId,
        requestDigest: digest,
        reviewedBy,
        reviewedAt,
        catalog,
        bindings: parsed.bindings.map((binding) => ({
          ...binding,
          basis: { ...binding.basis, reviewedAt },
        })),
        catalogDigest: catalog.digest,
      };
      admission.assertCurrent();
      this.assertRoot();
      writePrivateJsonFileSync(
        this.file,
        configuration,
        MAX_BYTES,
        'reviewed tariffs',
      );
      this.cached = undefined;
      return configuration;
    } finally {
      await release();
    }
  }
}
