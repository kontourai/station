import type { ServerLogReader } from '../../services/infra/server-log-reader.js';
import { bootRecordsWritten } from '../../telemetry/metrics.js';
import type { BuildProvenanceSnapshot } from './build-provenance.js';

export const MAX_BOOT_HISTORY = 50;
const BOOT_RECORD_MESSAGE = 'Station boot record';
const DERIVED_BOOT_CLUSTER_MS = 120_000;
const LEGACY_BOOT_MARKERS = new Set([
  'Voice WebSocket listening',
  'MCP Apps sandbox proxy listening',
]);

export interface BootHistoryRecord {
  bootTime: string;
  pid?: number;
  shortSha?: string;
  fullSha?: string;
  instanceId?: string;
  source: 'recorded' | 'derived';
  cause?: string;
}
export interface BootHistoryResult {
  records: BootHistoryRecord[];
  currentUptimeSeconds: number;
}

export function writeBootRecord(
  writeLine: (line: string) => void,
  build: BuildProvenanceSnapshot | undefined,
  bootTime = new Date().toISOString(),
  pid = process.pid,
): void {
  // The durable reader admits only lines with a parseable `timestamp`
  // (server-log-reader.ts isWellFormedEntry) — `time` would persist on disk
  // yet never surface from /boot-history (sol review, finding 1).
  writeLine(
    JSON.stringify({
      level: 'info',
      timestamp: bootTime,
      msg: BOOT_RECORD_MESSAGE,
      stationBootRecord: {
        bootTime,
        pid,
        ...(build?.shortSha ? { shortSha: build.shortSha } : {}),
        ...(build?.fullSha ? { fullSha: build.fullSha } : {}),
        ...(build?.instanceId ? { instanceId: build.instanceId } : {}),
      },
    }),
  );
  // writeLine absorbs failures silently, so this counts attempted
  // writes, not proven-durable ones.
  bootRecordsWritten.add(1);
}

export async function readBootHistory(
  logReader: ServerLogReader,
  processStartedAt: number,
  now = Date.now(),
): Promise<BootHistoryResult> {
  const result = await logReader.query({ limit: MAX_BOOT_HISTORY * 20 });
  const seen = new Set<string>();
  const records: BootHistoryRecord[] = [];
  for (const entry of result.entries) {
    const record = parseBootRecord(entry);
    if (!record) continue;
    const key = `${record.bootTime}:${record.source}`;
    if (!seen.has(key)) {
      seen.add(key);
      records.push(record);
    }
  }
  records.sort((a, b) => Date.parse(b.bootTime) - Date.parse(a.bootTime));
  // One startup emits several readiness markers seconds apart; without
  // clustering, each becomes its own 'derived' row and one boot reads as
  // two restarts (sol review, finding 2). Recorded rows are exact and
  // never clustered; derived rows within the window collapse to the
  // newest marker of that boot.
  const clustered: BootHistoryRecord[] = [];
  for (const record of records) {
    const previous = clustered[clustered.length - 1];
    if (
      record.source === 'derived' &&
      previous?.source === 'derived' &&
      Date.parse(previous.bootTime) - Date.parse(record.bootTime) <=
        DERIVED_BOOT_CLUSTER_MS
    )
      continue;
    clustered.push(record);
  }
  return {
    records: clustered.slice(0, MAX_BOOT_HISTORY),
    currentUptimeSeconds: Math.max(
      0,
      Math.floor((now - processStartedAt) / 1_000),
    ),
  };
}

function parseBootRecord(
  entry: Record<string, unknown>,
): BootHistoryRecord | undefined {
  const timestamp =
    typeof entry.timestamp === 'string' ? entry.timestamp : undefined;
  const msg = typeof entry.msg === 'string' ? entry.msg : undefined;
  const value = entry.stationBootRecord;
  if (msg === BOOT_RECORD_MESSAGE && value && typeof value === 'object') {
    const bootTime = stringField(value, 'bootTime') ?? timestamp;
    if (!bootTime || Number.isNaN(Date.parse(bootTime))) return undefined;
    const pid = numberField(value, 'pid');
    const shortSha = stringField(value, 'shortSha');
    const fullSha = stringField(value, 'fullSha');
    const instanceId = stringField(value, 'instanceId');
    return {
      bootTime,
      ...(pid !== undefined ? { pid } : {}),
      ...(shortSha ? { shortSha } : {}),
      ...(fullSha ? { fullSha } : {}),
      ...(instanceId ? { instanceId } : {}),
      source: 'recorded',
    };
  }
  if (timestamp && msg && LEGACY_BOOT_MARKERS.has(msg))
    return { bootTime: timestamp, source: 'derived' };
  return undefined;
}
function stringField(value: object, key: string): string | undefined {
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'string' ? field : undefined;
}
function numberField(value: object, key: string): number | undefined {
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'number' && Number.isFinite(field)
    ? field
    : undefined;
}
