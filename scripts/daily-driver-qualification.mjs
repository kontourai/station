#!/usr/bin/env node

import Ajv2020 from 'ajv/dist/2020.js';
import schema from '../schemas/daily-driver-qualification.schema.json' with {
  type: 'json',
};
import {
  assertDailyDriverQualificationSemantics,
  createDailyDriverQualificationReport,
} from './lib/daily-driver-qualification.mjs';

function optionValue(name) {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((argument) => argument.startsWith(prefix));
}

function numberOption(name, defaultValue) {
  const raw = optionValue(name);
  if (!raw) return defaultValue;
  const value = Number(raw.slice(name.length + 3));
  if (!Number.isInteger(value) || value < 1)
    throw new Error(`--${name} must be a positive integer`);
  return value;
}

const json = process.argv.includes('--json');
const report = await createDailyDriverQualificationReport({
  repetitions: numberOption('repetitions', 1),
  timeoutMs: numberOption('timeout-ms', 5),
});
const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
if (!validate(report))
  throw new Error(
    `invalid daily-driver qualification report: ${JSON.stringify(validate.errors)}`,
  );
assertDailyDriverQualificationSemantics(report);

if (json) process.stdout.write(`${JSON.stringify(report)}\n`);
else {
  const counts = { PASS: 0, FAIL: 0, NOT_VERIFIED: 0, unavailable: 0 };
  for (const row of report.rows) counts[row.status] += 1;
  process.stdout.write(
    `${[
      'Station daily-driver deterministic qualification',
      `Harness: ${report.run.harnessStatus}`,
      `Promotion: ${report.promotion.status}`,
      `Rows: PASS=${counts.PASS}, FAIL=${counts.FAIL}, NOT_VERIFIED=${counts.NOT_VERIFIED}, unavailable=${counts.unavailable}`,
      'No live engine, UI, CLI, project, attachment, self-edit, performance, or phone path was run.',
      'Use --json for the machine qualification report.',
    ].join('\n')}\n`,
  );
}
