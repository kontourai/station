/**
 * station#4463 slice 5 (Button): the audit found the five primary
 * page-header actions using three label grammars and two sizes — "New
 * agent", "+ Install Plugin", "+ Add Job", "+ New Skill", "Add model
 * connection". The fix collapsed them onto one rule: "Verb noun", first
 * word capitalized, no `+` prefix (the button IS the add affordance, so a
 * `+` restates what the primary-filled treatment already says).
 *
 * This is a source-scan inventory, not a render test, deliberately: the five
 * actions live behind different providers/contexts (SplitPaneLayout,
 * PageFrameActions, a connections-hub config table), so asserting on their
 * literal source strings is the narrowest layer that still catches a
 * regression — a `+` returning to any one of them reds this file without
 * standing up five separate view trees.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const VERB_NOUN_GRAMMAR = /^[A-Z][a-z]+(?: [a-z][a-z]*)+$/;

function extractBetween(
  content: string,
  startMarker: string,
  endMarker: string,
): string {
  const start = content.indexOf(startMarker);
  if (start === -1) {
    throw new Error(`marker not found: ${startMarker}`);
  }
  const end = content.indexOf(endMarker, start + startMarker.length);
  if (end === -1) {
    throw new Error(`marker not found after ${startMarker}: ${endMarker}`);
  }
  return content.slice(start, end);
}

function extractAddLabel(file: string): string {
  const content = readFileSync(file, 'utf8');
  const match = content.match(/addLabel="([^"]+)"/);
  if (!match) {
    throw new Error(`no addLabel="..." found in ${file}`);
  }
  return match[1];
}

/** Reads the "models" section's addLabel out of the shared IA table. */
function extractModelsAddLabel(file: string): string {
  const content = readFileSync(file, 'utf8');
  const modelsEntry = extractBetween(content, "id: 'models'", '},');
  const match = modelsEntry.match(/addLabel: '([^']+)'/);
  if (!match) {
    throw new Error(`no addLabel: '...' found in the models entry of ${file}`);
  }
  return match[1];
}

/** Reads the label text off ScheduleView's page-header primary `<Button>`. */
function extractScheduleAddLabel(file: string): string {
  const content = readFileSync(file, 'utf8');
  const actionsBlock = extractBetween(
    content,
    '<PageFrameActions>',
    '</PageFrameActions>',
  );
  // The JSX tag's closing `>` must be matched precisely: a naive `[\s\S]*?>`
  // stops at the FIRST `>` in the block, which is the one inside
  // `onClick={() => setShowAddForm(true)}` — an arrow function, not the tag
  // close. Requiring the `>` to sit alone on its own (whitespace-only) line,
  // as this file's formatting always renders it, disambiguates the two.
  const match = actionsBlock.match(
    /<Button\b[\s\S]*?\n\s*variant="primary"[\s\S]*?\n\s*>\s*\n\s*([^<{\n]+?)\s*\n\s*<\/Button>/,
  );
  if (!match) {
    throw new Error(`no primary <Button> label found in ${file}`);
  }
  return match[1].trim();
}

describe('primary page-action label grammar (station#4463 slice 5)', () => {
  test('Agents: "New agent"', () => {
    expect(extractAddLabel('src-ui/src/views/AgentsView.tsx')).toBe(
      'New agent',
    );
  });

  test('Plugins: "Install plugin"', () => {
    expect(extractAddLabel('src-ui/src/views/PluginManagementView.tsx')).toBe(
      'Install plugin',
    );
  });

  test('Schedule: "Add job"', () => {
    expect(extractScheduleAddLabel('src-ui/src/views/ScheduleView.tsx')).toBe(
      'Add job',
    );
  });

  test('Skills: "New skill"', () => {
    expect(extractAddLabel('src-ui/src/views/SkillsView.tsx')).toBe(
      'New skill',
    );
  });

  test('Models: "Add model connection"', () => {
    expect(
      extractModelsAddLabel(
        'src-ui/src/views/connections-hub/connection-sections.ts',
      ),
    ).toBe('Add model connection');
  });

  test('none of the five carry a `+` prefix', () => {
    const labels = [
      extractAddLabel('src-ui/src/views/AgentsView.tsx'),
      extractAddLabel('src-ui/src/views/PluginManagementView.tsx'),
      extractScheduleAddLabel('src-ui/src/views/ScheduleView.tsx'),
      extractAddLabel('src-ui/src/views/SkillsView.tsx'),
      extractModelsAddLabel(
        'src-ui/src/views/connections-hub/connection-sections.ts',
      ),
    ];
    for (const label of labels) {
      expect(label.startsWith('+')).toBe(false);
    }
  });

  test('all five read as "Verb noun" (capitalized first word, lowercase rest)', () => {
    const labels = [
      extractAddLabel('src-ui/src/views/AgentsView.tsx'),
      extractAddLabel('src-ui/src/views/PluginManagementView.tsx'),
      extractScheduleAddLabel('src-ui/src/views/ScheduleView.tsx'),
      extractAddLabel('src-ui/src/views/SkillsView.tsx'),
      extractModelsAddLabel(
        'src-ui/src/views/connections-hub/connection-sections.ts',
      ),
    ];
    for (const label of labels) {
      expect(label).toMatch(VERB_NOUN_GRAMMAR);
    }
  });
});
