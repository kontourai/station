import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const settingsView = fs.readFileSync(
  path.resolve(import.meta.dirname, '../views/SettingsView.tsx'),
  'utf8',
);
const systemSection = fs.readFileSync(
  path.resolve(import.meta.dirname, '../views/settings/SystemSection.tsx'),
  'utf8',
);

describe('/settings save models', () => {
  test('states the two scope-keyed persistence behaviors', () => {
    expect(settingsView).toContain('Saved to this Station');
    expect(settingsView).toContain('Saved to this device only');
    expect(settingsView).toContain('settings__save-pill');
  });

  // What Log Level *does* on save is asserted behaviourally in
  // settings-catalog-completeness.test.tsx (it goes to the revisioned
  // `updateAppLogLevel` client, and a plain-only save goes to `updateConfig`
  // alone). This test only guards the vocabulary that must stay out: an
  // earlier design queued Log Level per row with its own offline revision
  // store, and nothing else pins that it is gone.
  test('keeps the per-row log-level queue out of Settings', () => {
    expect(settingsView).not.toContain('saveLogLevelEdit');
    expect(settingsView).not.toContain('station-app-log-level-revision');
    expect(systemSection).not.toContain('OfflineLogLevel');
    expect(systemSection).not.toContain('Queued');
  });

  test('persists the Appearance font-size control through device settings', () => {
    expect(settingsView).toContain(
      "setDeviceSetting(\n                          'chatFontSize'",
    );
    expect(settingsView).not.toContain(
      'defaultChatFontSize: parseInt(e.target.value, 10)',
    );
  });
});
