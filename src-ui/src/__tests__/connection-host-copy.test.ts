/**
 * The connections surface never composes its own sentence about the host.
 *
 * `components/host-action/host-action-copy.ts` claims to be "The ONE map of
 * host-naming copy" and `HostAction.test.tsx` proves the map answers both
 * branches and that its adopters render it verbatim. What nothing checked was
 * whether a surface that needs host copy USES it -- so the connections pages,
 * which are the ones you navigate to in order to fix an engine, asserted
 * "Found on this computer" unconditionally while the first-run wizard said
 * "Not found on <host>. Agent CLIs run on that computer."
 *
 * On a paired device "this computer" is the phone, and the fact is about the
 * machine Station runs on. That is not vague copy, it is a false statement,
 * and it is how a correct observation about a Windows host got read as a
 * broken screen.
 *
 * Scoped to the connections surface deliberately. A repo-wide sweep would red
 * on lanes this change has no business gating, and a count would misattribute
 * to whoever pushes next. This is a named surface list: every file under it is
 * scanned, so a NEW file in these directories is covered the moment it lands.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const SRC_UI = join(__dirname, '..');

/** Directories and files whose copy describes a connection to the host. */
const CONNECTION_SURFACES = [
  'views/provider-settings',
  'views/connections-hub',
  'components/acp-connections',
  'views/AgentConnectionView.tsx',
];

/**
 * Device-ambiguous only. "this Station host" and "the computer Station runs
 * on" are true for every reader and are the phrasings the server already uses
 * (`routes/system/system-status-routes.ts`), so they are not matched.
 */
const AMBIGUOUS_HOST_PHRASE = /\bthis (computer|machine)\b/i;

/**
 * Deictic uses, where "this computer" names the row's subject rather than the
 * reader's device. Keyed on the exact trimmed line, not the file, so a
 * genuinely ambiguous sentence added to the same file still fails.
 */
const DEICTIC_EXEMPTIONS: ReadonlyArray<{
  file: string;
  line: string;
  why: string;
}> = [
  {
    file: 'views/connections-hub/SshComputerCreatorDialog.tsx',
    line: ": 'This computer could not be saved.',",
    why: 'The save-failure message for the computer being ADDED. Its subject is the new SSH host, not the device reading it.',
  },
  {
    file: 'views/connections-hub/ComputersSection.tsx',
    line: 'Remove this computer',
    why: 'The label of a per-row button. "This computer" is the row\'s subject — the machine being removed — not the device reading it.',
  },
];

function isExempt(file: string, line: string): boolean {
  return DEICTIC_EXEMPTIONS.some(
    (entry) => entry.file === file && entry.line === line.trim(),
  );
}

function sourceFiles(entry: string): string[] {
  const full = join(SRC_UI, entry);
  if (statSync(full).isFile()) return [entry];
  const out: string[] = [];
  for (const child of readdirSync(full)) {
    if (child === '__tests__') continue;
    const rel = `${entry}/${child}`;
    if (statSync(join(SRC_UI, rel)).isDirectory())
      out.push(...sourceFiles(rel));
    else if (/\.tsx?$/.test(child)) out.push(rel);
  }
  return out;
}

/**
 * Comments are stripped before matching: the rule has to be explainable in
 * the files it governs, and an explanation of why a phrase is forbidden must
 * not itself trip the gate.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

describe('the connections surface does not compose its own host copy', () => {
  const files = CONNECTION_SURFACES.flatMap(sourceFiles);

  test('the surface list actually resolves to files', () => {
    // Without this, a renamed directory silently empties the sweep and the
    // gate below passes by scanning nothing.
    expect(files.length).toBeGreaterThan(10);
  });

  test.each(DEICTIC_EXEMPTIONS)(
    'exemption for $file is still load-bearing',
    ({ file, line }) => {
      // An exemption whose line has been edited away stops describing
      // anything and silently widens the gate. Fail so it gets deleted.
      const source = withoutComments(readFileSync(join(SRC_UI, file), 'utf8'));
      expect(
        source.split('\n').some((candidate) => candidate.trim() === line),
      ).toBe(true);
    },
  );

  test.each(files)('%s names no device-ambiguous machine', (file) => {
    const offending = withoutComments(readFileSync(join(SRC_UI, file), 'utf8'))
      .split('\n')
      .filter(
        (line) => AMBIGUOUS_HOST_PHRASE.test(line) && !isExempt(file, line),
      );

    expect(
      offending,
      `${file} says "this computer"/"this machine". On a paired device that ` +
        'names the wrong machine. Use hostActionCopy/HostAction to name the ' +
        'host, or phrase it so it is true for any reader.',
    ).toEqual([]);
  });
});
