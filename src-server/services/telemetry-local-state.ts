import { join } from 'node:path';
import {
  type StationDailyPing,
  TELEMETRY_OUTBOX_LIMITS,
  type TelemetryLiteNoticeReceipt,
  type TelemetryOutboxEntry,
} from '@kontourai/station-contracts/product-telemetry';
import { mutateJsonFile } from '@kontourai/station-shared/json-file-storage';

type Publisher = 'kontour' | 'operator';
export interface TelemetryDailyState {
  firstRun: string;
  lastActiveDay: string;
  lastActiveWeek: string;
  lastActiveMonth: string;
  day: string;
  ping: { -readonly [K in keyof StationDailyPing]: StationDailyPing[K] };
  previous?: { day: string; ping: StationDailyPing };
  reported: Partial<Record<Publisher, string>>;
  engineFailures: Partial<
    Record<StationDailyPing['engines_used_today'][number], number>
  >;
  attempted: Partial<Record<Publisher, string>>;
  notices: Partial<Record<Publisher, TelemetryLiteNoticeReceipt>>;
}

/** Atomic read/derive/publish also serializes two processes sharing a home. */
export class TelemetryLocalState {
  private readonly dailyPath: string;
  private readonly outboxPath: string;
  constructor(homeDir: string) {
    this.dailyPath = join(homeDir, 'config', 'telemetry-daily.json');
    this.outboxPath = join(homeDir, 'config', 'telemetry-outbox.json');
  }
  daily(update: (state: TelemetryDailyState | null) => TelemetryDailyState) {
    return mutateJsonFile<TelemetryDailyState | null>(
      this.dailyPath,
      null,
      update,
      { maxBytes: 16 * 1024, label: 'Telemetry daily state' },
    );
  }
  async outbox(publisher?: Publisher): Promise<TelemetryOutboxEntry[]> {
    const entries = await this.updateOutbox();
    return entries.filter(
      (entry) => !publisher || entry.publisher === publisher,
    );
  }
  async record(entry: TelemetryOutboxEntry): Promise<void> {
    await this.updateOutbox(entry);
  }
  private updateOutbox(entry?: TelemetryOutboxEntry) {
    const cutoff =
      Date.now() - TELEMETRY_OUTBOX_LIMITS.retentionDays * 86_400_000;
    return mutateJsonFile<TelemetryOutboxEntry[]>(
      this.outboxPath,
      [],
      (current) => {
        const entries = [...current, ...(entry ? [entry] : [])]
          .filter((row) => Date.parse(row.recordedAt) >= cutoff)
          .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
        // mutateJsonFile writes two-space indented JSON. Count its actual bytes,
        // including array delimiters, rather than the compact wire payload size.
        let bytes = Buffer.byteLength(JSON.stringify(entries, null, 2));
        while (bytes > TELEMETRY_OUTBOX_LIMITS.maxBytes && entries.length) {
          entries.shift();
          bytes = Buffer.byteLength(JSON.stringify(entries, null, 2));
        }
        return entries;
      },
      { maxBytes: TELEMETRY_OUTBOX_LIMITS.maxBytes, label: 'Telemetry outbox' },
    );
  }
}
