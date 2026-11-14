import { test } from 'vitest';
import { qualifyReportInputRuntime } from './report-input-runtime-fixture.js';

test.each([
  'close-before-authorization',
  'close-before-evidence',
  'close-before-result',
] as const)(
  'input close joins its admitted owner work: %s',
  qualifyReportInputRuntime,
);
