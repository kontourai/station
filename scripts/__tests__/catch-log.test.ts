import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * File-integrity checks for `docs/strategy/catches/catches.jsonl`.
 *
 * Deliberately NOT a delivery gate. Nothing here asserts that a change
 * produced a catch record, and nothing should: the log's own README explains
 * why enforcement would be counterproductive. These tests only keep a
 * machine-readable file machine-readable, and keep the README's published
 * counts honest against the data they describe.
 */

const LOG_PATH = 'docs/strategy/catches/catches.jsonl';
const SCHEMA_PATH = 'docs/strategy/catches/catches.schema.json';
const README_PATH = 'docs/strategy/catches/README.md';

interface CatchRecord {
  id: string;
  date: string;
  repo: string;
  class: string;
  detector: string;
  detector_kind: string;
  caught_by_machine: boolean;
  summary: string;
  evidence_ref: string;
  fix_ref: string | null;
  confidence: string;
  unverified: string[];
  notes: string | null;
}

interface Schema {
  required: string[];
  properties: {
    class: { enum: string[] };
    detector_kind: { enum: string[] };
    confidence: { enum: string[] };
    id: { pattern: string };
    date: { pattern: string };
    summary: { minLength: number };
    evidence_ref: { minLength: number };
  };
}

const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as Schema;
const rawLines = readFileSync(LOG_PATH, 'utf8').split('\n');
const contentLines = rawLines.filter((line) => line.length > 0);
const records = contentLines.map((line) => JSON.parse(line) as CatchRecord);

describe('catch log', () => {
  it('is well-formed JSON Lines with a trailing newline and no blank lines', () => {
    expect(records.length).toBeGreaterThan(0);
    expect(rawLines.at(-1)).toBe('');
    expect(rawLines.slice(0, -1).some((line) => line.trim() === '')).toBe(
      false,
    );
  });

  it('matches its own schema on every record', () => {
    const idPattern = new RegExp(schema.properties.id.pattern);
    const datePattern = new RegExp(schema.properties.date.pattern);
    const problems: string[] = [];

    for (const record of records) {
      const where = record.id || '<record with no id>';
      const keys = Object.keys(record).sort();
      const required = [...schema.required].sort();
      if (JSON.stringify(keys) !== JSON.stringify(required)) {
        problems.push(
          `${where}: fields ${keys.join(',')} !== schema ${required.join(',')}`,
        );
      }
      if (!idPattern.test(record.id)) problems.push(`${where}: bad id`);
      if (!datePattern.test(record.date)) problems.push(`${where}: bad date`);
      if (!schema.properties.class.enum.includes(record.class)) {
        problems.push(
          `${where}: class "${record.class}" is not in the schema enum. ` +
            `Add it to the schema AND to the README class table, with the ` +
            `real event that justifies it.`,
        );
      }
      if (!schema.properties.detector_kind.enum.includes(record.detector_kind))
        problems.push(`${where}: bad detector_kind "${record.detector_kind}"`);
      if (!schema.properties.confidence.enum.includes(record.confidence))
        problems.push(`${where}: bad confidence "${record.confidence}"`);
      if (typeof record.caught_by_machine !== 'boolean')
        problems.push(`${where}: caught_by_machine must be a boolean`);
      if (record.summary.length < schema.properties.summary.minLength)
        problems.push(`${where}: summary too short to be useful`);
      if (record.evidence_ref.length < schema.properties.evidence_ref.minLength)
        problems.push(`${where}: evidence_ref too short to resolve`);
      if (!Array.isArray(record.unverified))
        problems.push(`${where}: unverified must be an array`);
    }

    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('keeps ids unique and the file sorted by date then id', () => {
    const ids = records.map((r) => r.id);
    expect(new Set(ids).size, 'duplicate id in the catch log').toBe(ids.length);

    const sorted = [...records].sort((a, b) =>
      a.date === b.date
        ? a.id.localeCompare(b.id)
        : a.date.localeCompare(b.date),
    );
    expect(records.map((r) => r.id)).toEqual(sorted.map((r) => r.id));
  });

  it('requires an unverified list and a note wherever confidence is low', () => {
    const problems: string[] = [];
    for (const record of records) {
      if (record.confidence === 'low') {
        if (record.unverified.length === 0)
          problems.push(`${record.id}: confidence low but unverified is empty`);
        if (!record.notes)
          problems.push(`${record.id}: confidence low but no notes`);
      }
      if (record.detector_kind === 'unknown' && record.confidence !== 'low') {
        problems.push(
          `${record.id}: an unknown detector cannot be recorded at ` +
            `confidence "${record.confidence}" — it would enter the ratio ` +
            `on an attribution nobody verified.`,
        );
      }
      if (record.fix_ref === null && !record.notes) {
        problems.push(
          `${record.id}: fix_ref is null, which claims the catch is unfixed. ` +
            `Say so in notes.`,
        );
      }
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('keeps the README class table matching the data', () => {
    const readme = readFileSync(README_PATH, 'utf8');
    const counts = new Map<string, { total: number; machine: number }>();
    for (const record of records) {
      const entry = counts.get(record.class) ?? { total: 0, machine: 0 };
      entry.total += 1;
      if (record.caught_by_machine) entry.machine += 1;
      counts.set(record.class, entry);
    }

    const problems: string[] = [];
    for (const [className, { total, machine }] of counts) {
      const row = new RegExp(
        `^\\| \`${className}\` \\| (\\d+) \\| (\\d+) \\|`,
        'm',
      ).exec(readme);
      if (!row) {
        problems.push(`README class table has no row for \`${className}\``);
        continue;
      }
      if (Number(row[1]) !== total || Number(row[2]) !== machine) {
        problems.push(
          `README says ${className} = ${row[1]}/${row[2]} but the log has ` +
            `${total}/${machine}`,
        );
      }
    }

    // The published ratio is the document's headline claim; it must not drift.
    const counted = records.filter((r) => r.confidence !== 'low');
    const machine = counted.filter((r) => r.caught_by_machine).length;
    const human = counted.length - machine;
    const pct = (n: number) => Math.round((n / counted.length) * 100);
    const dates = records.map((r) => r.date).sort();
    const expectedRows = [
      `| records (${dates[0]} → ${dates.at(-1)}) | **${records.length}** |`,
      `| counted toward the ratio (\`confidence\` ≠ \`low\`) | **${counted.length}** |`,
      `| \`caught_by_machine: true\` | **${machine}** (${pct(machine)}%) |`,
      `| \`caught_by_machine: false\` | **${human}** (${pct(human)}%) |`,
    ];
    for (const expected of expectedRows) {
      if (!readme.includes(expected)) {
        problems.push(`README is missing the ratio row: ${expected}`);
      }
    }

    expect(problems, problems.join('\n')).toEqual([]);
  });
});
