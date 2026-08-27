import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { ConfigLoader } from '../../domain/config-loader.js';
import { JsonFileStore } from '../infra/json-store.js';

export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error'] as const;
/** Retain the newest 256 terminal receipts; older keys may be replayed as an
 * idempotent no-op only when the requested field value is still current. */
export const LOG_LEVEL_RECEIPT_LIMIT = 256;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface LogLevelEditReceipt {
  operationId: string;
  expectedRevision: string;
  requestedValue: LogLevel;
  outcome: 'applied' | 'conflict';
  currentValue: LogLevel;
  revision: string;
}

interface ReceiptFile {
  schemaVersion: 1;
  receipts: LogLevelEditReceipt[];
}

export type LogLevelEditResult =
  | { kind: 'applied'; receipt: LogLevelEditReceipt }
  | { kind: 'conflict'; receipt: LogLevelEditReceipt }
  | { kind: 'idempotency-conflict' };

export function logLevelRevision(value: LogLevel): string {
  return `"${createHash('sha256').update(`app.logLevel:${value}`).digest('base64url')}"`;
}

export class LogLevelEditService {
  private readonly store: JsonFileStore<ReceiptFile>;
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly configLoader: ConfigLoader) {
    this.store = new JsonFileStore(
      join(
        configLoader.getProjectHomeDir(),
        'security',
        'config-edit-receipts.json',
      ),
      { schemaVersion: 1, receipts: [] },
      { durableAtomicWrite: true, onCorruption: 'throw' },
    );
  }

  async current(): Promise<{ value: LogLevel; revision: string }> {
    const config = await this.configLoader.loadAppConfig();
    const value = (config.logLevel ?? 'info') as LogLevel;
    return { value, revision: logLevelRevision(value) };
  }

  apply(
    operationId: string,
    expectedRevision: string,
    requestedValue: LogLevel,
  ): Promise<LogLevelEditResult> {
    const result = this.tail.then(() =>
      this.applySerialized(operationId, expectedRevision, requestedValue),
    );
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async applySerialized(
    operationId: string,
    expectedRevision: string,
    requestedValue: LogLevel,
  ): Promise<LogLevelEditResult> {
    const state = this.store.read();
    if (state.schemaVersion !== 1 || !Array.isArray(state.receipts)) {
      throw new Error('Unsupported log-level edit receipt store schema');
    }
    const previous = state.receipts.find(
      (entry) => entry.operationId === operationId,
    );
    if (previous) {
      if (
        previous.expectedRevision !== expectedRevision ||
        previous.requestedValue !== requestedValue
      ) {
        return { kind: 'idempotency-conflict' };
      }
      return { kind: previous.outcome, receipt: previous };
    }

    const current = await this.current();
    // A crash may occur after the config file is durably replaced but before
    // its receipt is written. Field assignment is idempotent, so observing the
    // requested value safely heals that window without performing a second write.
    if (
      current.revision !== expectedRevision &&
      current.value !== requestedValue
    ) {
      return this.record(state, {
        operationId,
        expectedRevision,
        requestedValue,
        outcome: 'conflict',
        currentValue: current.value,
        revision: current.revision,
      });
    }

    if (current.value !== requestedValue) {
      await this.configLoader.updateAppConfig({ logLevel: requestedValue });
    }
    const updated = await this.current();
    return this.record(state, {
      operationId,
      expectedRevision,
      requestedValue,
      outcome: 'applied',
      currentValue: updated.value,
      revision: updated.revision,
    });
  }

  private record(
    state: ReceiptFile,
    receipt: LogLevelEditReceipt,
  ): LogLevelEditResult {
    this.store.write({
      schemaVersion: 1,
      receipts: [...state.receipts, receipt].slice(-LOG_LEVEL_RECEIPT_LIMIT),
    });
    return { kind: receipt.outcome, receipt };
  }
}
