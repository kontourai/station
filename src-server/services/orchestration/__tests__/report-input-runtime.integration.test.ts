import { test } from 'vitest';
import { qualifyReportInputRuntime } from './report-input-runtime-fixture.js';

test.each([
  'accept',
  'decline',
  'cancel',
  'abort',
  'owner-close',
  'no-grant',
  'send-failed',
  'storage-drift',
  'close-failed',
  'registration-failed',
  'publication-retire',
  'delivery-withdrawn',
] as const)(
  'fixed MCP input preserves canonical answer and durable send custody: %s',
  qualifyReportInputRuntime,
);
