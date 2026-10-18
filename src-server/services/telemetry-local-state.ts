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
  lowerings?: Partial<Record<Publisher, { at: string; feedbackSent: boolean }>>;
  feedbackDays?: Partial<Record<Publisher, string>>;
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
        const entries = current.filter(
          (row) => Date.parse(row.recordedAt) >= cutoff,
        );
        if (entry && Date.parse(entry.recordedAt) >= cutoff) {
          const summary = 'count' in entry.payload ? entry.payload : undefined;
          const prior = summary
            ? entries.find(
                (row) =>
                  row.publisher === entry.publisher &&
                  row.tier === entry.tier &&
                  row.reason === entry.reason &&
                  row.recordedAt.slice(0, 10) ===
                    entry.recordedAt.slice(0, 10) &&
                  'count' in row.payload,
              )
            : undefined;
          if (summary && prior && 'count' in prior.payload)
            prior.payload.count += summary.count;
          else entries.push(entry);
        }
        entries.sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
        // Each element is serialized once, with the same indentation as the writer.
        const sizes = entries.map((row) =>
          Buffer.byteLength(
            JSON.stringify(row, null, 2)
              .split('\n')
              .map((line) => `  ${line}`)
              .join('\n'),
          ),
        );
        let bytes =
          4 +
          sizes.reduce((sum, size) => sum + size, 0) +
          Math.max(0, sizes.length - 1) * 2;
        let start = 0;
        while (
          bytes > TELEMETRY_OUTBOX_LIMITS.maxBytes &&
          start < entries.length
        ) {
          bytes -= sizes[start++] + 2;
        }
        return entries.slice(start);
      },
      { maxBytes: TELEMETRY_OUTBOX_LIMITS.maxBytes, label: 'Telemetry outbox' },
    );
  }
}
