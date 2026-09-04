import { join } from 'node:path';
import {
  type ApprovedSourceManifest,
  importOpenRouterModelsSnapshot,
  isDefaultApprovedSourceIdentity,
  OPENROUTER_MODELS_SOURCE,
  type OpenRouterModelsImportInput,
} from '@kontourai/bearing';
import { loadPackagedApprovedSourceManifest } from '@kontourai/bearing/node';
import type { Snapshot, SnapshotStore } from '@kontourai/forage';
import { createFilesystemSnapshotStore } from '@kontourai/forage';
import {
  buildSnapshotSourceRef,
  fetchSource,
  parseSnapshotSourceRef,
} from '@kontourai/forage/fetch';
import {
  CURATED_MODEL_IDENTITIES,
  type RoutePricingReference,
} from '@kontourai/station-contracts/model-inventory';

/**
 * Per-route pricing for OpenRouter routes, sourced through bearing (#1127).
 *
 * WHAT THIS REFUSES TO DO, ON PURPOSE. It prices a route only when the route's
 * own provider-native id is an OpenRouter row that reviewed data has named.
 * A direct Anthropic route for the same model gets nothing from here: the
 * OpenRouter figure is OpenRouter's routing price, and showing it beside a
 * route OpenRouter never touched is the fabrication #949 decided against and
 * #1165/#1186 removed elsewhere.
 *
 * The rows it will price are READ from the curated identity table's
 * `openrouter` routes, not inferred from ids that look OpenRouter-shaped.
 * Bearing's importer independently refuses unreviewed rows and emits a
 * `configured-model-missing` diagnostic when a reviewed row is absent from
 * the live catalogue; both are logged, neither is guessed around.
 *
 * Acquisition follows bearing's own proof script: forage's guarded egress
 * into a filesystem snapshot store under the Station home, a snapshot source
 * ref built for bearing's import, then bearing's manifest-validated import.
 * Station holds no manifest of its own -- it uses the one bearing packages and
 * checks that it still names the reviewed OpenRouter source identity.
 *
 * The store is written, and read back only by forage when it revalidates.
 * Serving the last stored snapshot when the network is down is deliberately
 * NOT built here: this seam sets no refresh cadence, and what a Station that
 * boots offline should show belongs with the code that decides when to
 * refresh. Until then a failed refresh leaves the previous read in place and
 * an empty table prices nothing.
 */

const PRICE_KEYS = {
  prompt: 'openrouter.price.prompt_usd_per_token',
  completion: 'openrouter.price.completion_usd_per_token',
} as const;
const TOKENS_PER_MILLION = 1_000_000;
/**
 * `value * 1_000_000` on an exact decimal turns "0.0000001" into
 * 0.09999999999999999; 143 of the live catalogue's price values land on a
 * noisy double, and a surface that stringifies one shows every digit. Six
 * decimal places is finer than any figure the source quotes, and is the
 * precision `RoutePricingReference` promises.
 */
const PRICE_DECIMALS = 6;

function perMillionTokens(value: number): number {
  return Number((value * TOKENS_PER_MILLION).toFixed(PRICE_DECIMALS));
}

/**
 * The lowest prompt-token threshold at which each row's schedule charges a
 * higher rate, read from the snapshot body bearing has already accepted.
 *
 * Bearing validates `pricing.overrides` and then surfaces only the base keys,
 * so in its observations a tiered schedule is indistinguishable from a flat
 * one. Publishing the base figure alone would assert a flatness the source
 * never stated -- the route priced today doubles its prompt rate above
 * 200,000 tokens. This reads one integer per row out of the same sha256-
 * verified bytes bearing parsed; no price is ever taken from this path.
 */
function tierThresholds(body: string | Uint8Array): Map<string, number> {
  const thresholds = new Map<string, number>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      typeof body === 'string' ? body : new TextDecoder().decode(body),
    );
  } catch {
    return thresholds;
  }
  const rows = (parsed as { data?: unknown } | null)?.data;
  if (!Array.isArray(rows)) return thresholds;
  for (const row of rows) {
    const id = (row as { id?: unknown } | null)?.id;
    const overrides = (row as { pricing?: { overrides?: unknown } } | null)
      ?.pricing?.overrides;
    if (typeof id !== 'string' || !Array.isArray(overrides)) continue;
    let lowest: number | null = null;
    for (const override of overrides) {
      const min = (override as { min_prompt_tokens?: unknown } | null)
        ?.min_prompt_tokens;
      if (typeof min !== 'number' || !Number.isFinite(min)) continue;
      if (lowest === null || min < lowest) lowest = min;
    }
    if (lowest !== null) thresholds.set(id, lowest);
  }
  return thresholds;
}

export interface OpenRouterRoutePricingDependencies {
  /** Station home; snapshots live under <home>/pricing/openrouter/snapshots. */
  homeDir: string;
  /** Test seam: forage's snapshot store. Defaults to the filesystem store. */
  store?: SnapshotStore;
  /** Test seam: the HTTP client forage uses. Defaults to global fetch. */
  fetch?: typeof fetch;
  /**
   * Test seam. Production keeps forage's guarded egress, which resolves and
   * classifies the destination address; a unit test with a fake fetch has no
   * address to classify and must say so explicitly.
   */
  egress?: { guarded: boolean };
  now?: () => Date;
  logger?: { warn: (message: string, meta?: unknown) => void };
}

interface PricedRow {
  reference: RoutePricingReference;
}

export class OpenRouterRoutePricing {
  private readonly store: SnapshotStore;
  private readonly egress: { guarded: boolean };
  private readonly now: () => Date;
  private readonly logger: { warn: (message: string, meta?: unknown) => void };
  private rows = new Map<string, PricedRow>();
  private inflight: Promise<void> | null = null;
  private manifest: ApprovedSourceManifest | null = null;

  constructor(
    private readonly dependencies: OpenRouterRoutePricingDependencies,
  ) {
    this.store =
      dependencies.store ??
      createFilesystemSnapshotStore({
        root: join(dependencies.homeDir, 'pricing', 'openrouter', 'snapshots'),
      });
    this.egress = dependencies.egress ?? { guarded: true };
    this.now = dependencies.now ?? (() => new Date());
    this.logger = dependencies.logger ?? { warn: () => {} };
  }

  /**
   * The reviewed OpenRouter rows, keyed by row id, as bearing's mapping. The
   * ModelIdentity given to bearing IS the row id: this service answers "what
   * does this route cost", and the route is the row. Station's canonical
   * identity stays Station's concept.
   */
  static reviewedRows(): OpenRouterModelsImportInput['models'] {
    const models: Record<
      string,
      OpenRouterModelsImportInput['models'][string]
    > = {};
    for (const identity of CURATED_MODEL_IDENTITIES) {
      for (const route of identity.routes) {
        if (route.family !== 'openrouter') continue;
        models[route.providerModel] = {
          model: {
            id: route.providerModel,
            revision: null,
            quantization: null,
          },
          validUntil: null,
        };
      }
    }
    return models;
  }

  /** The price for an OpenRouter row id, or undefined when Station has none it can cite. */
  priceFor(openRouterRowId: string): RoutePricingReference | undefined {
    const row = this.rows.get(openRouterRowId);
    if (!row) return undefined;
    const { validUntil } = row.reference;
    if (validUntil) {
      const expiry = Date.parse(validUntil);
      // A bound we cannot read is not a licence to serve the figure: `NaN <=
      // now` is false, so comparing directly would have served it.
      if (!Number.isFinite(expiry) || expiry <= this.now().getTime()) {
        return undefined;
      }
    }
    return row.reference;
  }

  /** Refresh from the source. Failures are logged and leave the last good read in place. */
  refresh(): Promise<void> {
    if (!this.inflight) {
      this.inflight = this.acquire()
        .catch((error: unknown) => {
          this.logger.warn('OpenRouter route pricing refresh failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          this.inflight = null;
        });
    }
    return this.inflight;
  }

  private async approvedManifest(): Promise<ApprovedSourceManifest> {
    if (!this.manifest)
      this.manifest = await loadPackagedApprovedSourceManifest();
    return this.manifest;
  }

  private async acquire(): Promise<void> {
    const manifest = await this.approvedManifest();
    const source = manifest.sources.find(
      (candidate) => candidate.id === OPENROUTER_MODELS_SOURCE.id,
    );
    if (!source || !isDefaultApprovedSourceIdentity(source)) {
      throw new Error(
        'Packaged bearing manifest does not approve the reviewed OpenRouter source identity.',
      );
    }
    const entrypoint = source.resolver.entrypoint;
    const result = await fetchSource(
      {
        id: entrypoint.sourceId,
        url: entrypoint.url,
        timeoutMs: 30_000,
        retries: 2,
        respectRobots: true,
        egress: this.egress,
      },
      {
        store: this.store,
        maxResponseBytes: entrypoint.maxBytes,
        ...(this.dependencies.fetch ? { fetch: this.dependencies.fetch } : {}),
      },
    );
    if (!result.snapshot) {
      throw new Error(
        `${result.error?.kind ?? 'no-snapshot'}: ${result.error?.message ?? 'unknown error'}`,
      );
    }
    const snapshot: Snapshot = result.snapshot;
    // Every put writes a new <fetchedAt>-<digest> record even for a
    // byte-identical body, and the store never prunes -- it throws
    // permanently once it reaches its cap, and its cap cannot be changed
    // after the directory is initialised. So only a body the store does not
    // already hold is worth a record, which bounds growth by how often the
    // catalogue actually changes rather than by how often Station refreshes.
    if (!snapshot.notModified) {
      const stored = await this.store.latest(snapshot.sourceId);
      if (stored?.bodyHash !== snapshot.bodyHash)
        await this.store.put(snapshot);
    }
    const sourceRef = buildSnapshotSourceRef(snapshot);
    const reference = parseSnapshotSourceRef(sourceRef);
    if (!reference) throw new Error('Snapshot source ref did not round-trip.');
    const imported = importOpenRouterModelsSnapshot({
      manifest,
      sourceId: source.id,
      snapshot: {
        ok: true,
        integrity: 'snapshot-envelope',
        reference,
        snapshot,
      },
      models: OpenRouterRoutePricing.reviewedRows(),
    });
    for (const diagnostic of imported.diagnostics) {
      this.logger.warn('OpenRouter route pricing diagnostic', diagnostic);
    }
    // Bearing emits ONE OBSERVATION PER MEASUREMENT -- a single row yields two
    // dozen, of which exactly two carry price. Collecting per observation and
    // keying by model id let the last observation overwrite the priced ones,
    // so every price read back as null. Scan every observation for the model
    // and take the price measurements wherever they appear.
    const collected = new Map<
      string,
      {
        prompt: number | null;
        completion: number | null;
        observedAt: string;
        validUntil: string | null;
      }
    >();
    for (const observation of imported.observations) {
      const id = observation.model.id;
      const entry = collected.get(id) ?? {
        prompt: null,
        completion: null,
        observedAt: observation.freshness.observedAt,
        validUntil: observation.freshness.validUntil,
      };
      for (const measurement of observation.measurements) {
        if (typeof measurement.value !== 'number') continue;
        if (measurement.key === PRICE_KEYS.prompt) {
          entry.prompt = perMillionTokens(measurement.value);
        } else if (measurement.key === PRICE_KEYS.completion) {
          entry.completion = perMillionTokens(measurement.value);
        }
      }
      collected.set(id, entry);
    }
    const tiers = tierThresholds(snapshot.body);
    const rows = new Map<string, PricedRow>();
    for (const [id, entry] of collected) {
      // A row bearing reported with neither price is not a priced route; it
      // must read as unpriced rather than as a reference with two nulls.
      if (entry.prompt === null && entry.completion === null) continue;
      rows.set(id, {
        reference: {
          source: 'openrouter',
          attributionUrl: OPENROUTER_MODELS_SOURCE.attributionUrl,
          promptUsdPerMillionTokens: entry.prompt,
          completionUsdPerMillionTokens: entry.completion,
          tieredAbovePromptTokens: tiers.get(id) ?? null,
          observedAt: entry.observedAt,
          validUntil: entry.validUntil,
        },
      });
    }
    this.rows = rows;
  }
}
