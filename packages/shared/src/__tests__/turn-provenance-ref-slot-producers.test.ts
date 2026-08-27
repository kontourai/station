/**
 * station#1558 — the tripwire for documented-but-inert reference slots.
 *
 * The defect it exists to stop: `TurnProvenanceEnvelope.trustReport` shipped
 * with a docblock describing a live dereference path — naming the API route
 * that would re-authorize the caller and the component that would render the
 * result — while no code anywhere wrote the metadata key the fold reads. The
 * reader existed, the renderer existed, and every test of the `referenced`
 * state hand-built the payload the producer could not emit. That is the
 * station#1510 shape: a fixture that constructs the artifact under test can
 * confirm the fold and never the reachability.
 *
 * So this test does not test a fold. It reconciles
 * `TURN_PROVENANCE_REF_SLOTS` against the source tree, in both directions:
 *
 *   - a slot declared `producerImplemented: true` with no producer fails —
 *     that is the over-claim #1558 found;
 *   - a slot declared `producerImplemented: false` that HAS acquired a
 *     producer fails too — otherwise the contract quietly under-claims a
 *     capability that shipped, and the card keeps saying
 *     `not-captured-by-station` about a fact Station now captures.
 *
 * The producer surface is DISCOVERED, not listed: every non-test source file
 * that mentions a terminal turn event (`turn.completed` / `turn.aborted`) is
 * a candidate producer. A new one cannot be added to a curated list nobody
 * updates, because there is no curated list.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TurnProvenanceRefSlotName } from '@kontourai/station-contracts/turn-provenance';
import { TURN_PROVENANCE_REF_SLOTS } from '@kontourai/station-contracts/turn-provenance';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..', '..');

/** Where Station's own runtime code lives. Not `src-ui` — a renderer cannot produce a turn event. */
const SCAN_ROOTS = ['src-server', 'packages', 'src-shared'];

const SOURCE_EXTENSIONS = ['.ts', '.tsx'];

/**
 * The two files that name a reference slot's metadata key WITHOUT producing
 * it, each for a reason that is part of the design:
 *
 *   - the contract declares the type and this very table;
 *   - the fold READS the key off the terminal event.
 *
 * Listed rather than pattern-excluded so the exclusion itself is checked: the
 * test below asserts each still exists and still matches, so a file that stops
 * being a reader (or is renamed) cannot leave a silent hole in the scan.
 */
const KNOWN_NON_PRODUCERS = [
  join('packages', 'contracts', 'src', 'turn-provenance.ts'),
  join('packages', 'shared', 'src', 'turn-provenance-fold.ts'),
];

function isTestPath(path: string): boolean {
  return (
    path.includes(`${sep}__tests__${sep}`) ||
    path.includes('.test.') ||
    path.includes(`${sep}node_modules${sep}`) ||
    path.includes(`${sep}dist${sep}`)
  );
}

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) {
      continue;
    }
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      walk(full, out);
    } else if (
      SOURCE_EXTENSIONS.some((extension) => entry.endsWith(extension)) &&
      !isTestPath(full)
    ) {
      out.push(full);
    }
  }
  return out;
}

/** Files that construct or emit a terminal turn event — the only places a producer can live. */
function terminalEventSurface(): string[] {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) {
    for (const path of walk(join(REPO_ROOT, root))) {
      const source = readFileSync(path, 'utf8');
      if (
        source.includes('turn.completed') ||
        source.includes('turn.aborted')
      ) {
        files.push(path);
      }
    }
  }
  return files;
}

/** A WRITE of the key: an object-literal property or a bracket assignment, never a read. */
function writesKey(source: string, key: string): boolean {
  return (
    new RegExp(`\\b${key}\\s*:`).test(source) ||
    new RegExp(`\\[['"\`]${key}['"\`]\\]\\s*=`).test(source)
  );
}

const SURFACE = terminalEventSurface();

const slotNames = Object.keys(
  TURN_PROVENANCE_REF_SLOTS,
) as TurnProvenanceRefSlotName[];

describe('every reference slot declares whether it has a producer', () => {
  it('discovers a non-empty terminal-event surface to scan', () => {
    // A scan that finds nothing would pass every assertion below by vacuity —
    // the absence-of-signal-as-success failure this whole test exists against.
    expect(SURFACE.length).toBeGreaterThan(10);
  });

  it('keeps the known non-producers honest', () => {
    // An exclusion nobody re-checks is how a scan goes quietly blind. Each
    // entry must still exist and still name the key it is excluded for; a
    // rename or a rewrite that drops the mention fails here rather than
    // leaving a hole a real producer could later occupy unnoticed.
    for (const relativePath of KNOWN_NON_PRODUCERS) {
      const full = join(REPO_ROOT, relativePath);
      const source = readFileSync(full, 'utf8');
      expect(
        writesKey(source, 'trustReport'),
        `${relativePath} no longer names the key it is excluded for; the exclusion is stale`,
      ).toBe(true);
    }
  });

  it.each(slotNames)('%s: the declaration matches the source tree', (slot) => {
    const status = TURN_PROVENANCE_REF_SLOTS[slot];
    if (status.metadataKey === null) {
      // No metadata channel at all: the fold hardcodes `unavailable`, so a
      // producer is impossible without a code change that would also have
      // to add the key. Declaring such a slot implemented is incoherent.
      expect(
        status.producerImplemented,
        `${slot} has no metadata channel, so it cannot have a producer`,
      ).toBe(false);
      return;
    }

    const producers = SURFACE.filter((path) => {
      if (KNOWN_NON_PRODUCERS.includes(relative(REPO_ROOT, path))) {
        return false;
      }
      return writesKey(
        readFileSync(path, 'utf8'),
        status.metadataKey as string,
      );
    }).map((path) => relative(REPO_ROOT, path));

    expect(
      producers.length > 0,
      producers.length > 0
        ? `${slot} now has a producer (${producers.join(', ')}) but is declared unimplemented — flip TURN_PROVENANCE_REF_SLOTS and say so in the contract`
        : `${slot} is declared implemented but nothing on the terminal-event surface writes metadata.${status.metadataKey} — either build the producer or say the slot is unimplemented`,
    ).toBe(status.producerImplemented);
  });

  it('states a reason for every slot without a producer', () => {
    // A bare `false` is a fact with no explanation attached, which is the
    // rendering this envelope's own honesty bar rejects everywhere else.
    for (const slot of slotNames) {
      const status = TURN_PROVENANCE_REF_SLOTS[slot];
      if (status.producerImplemented) continue;
      expect(status.note.length).toBeGreaterThan(40);
    }
  });
});
