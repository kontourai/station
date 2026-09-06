/**
 * #1536 B5. One session was labelled four ways at once — "Opus 5" on Home and
 * the sidebar, "claude-opus-5" in the transcript's provenance strip,
 * "Default (recommended)" on the dock header and composer chip, and
 * "Requested default · Reported claude-opus-5" on the turn row. Four surfaces,
 * four derivations, one fact.
 *
 * `modelIdentityLabel` is now the one rule; these pin the rule, and the
 * agreement block below pins that the surfaces read it rather than each other.
 */

import { describe, expect, test } from 'vitest';
import { chatModelLabel } from '../components/chat-dock/chat-dock-utils';
import {
  modelIdentityLabel,
  type SelectableModel,
} from '../utils/modelCapabilities';
import { defaultResolveModelLabel } from '../views/home/home-view-model';

/** The engine-default entry a Claude Code catalog actually publishes. */
const engineDefault: SelectableModel = {
  id: 'default',
  name: 'Default (recommended)',
  capabilities: {} as never,
};

const resolvedEngineDefault: SelectableModel = {
  ...engineDefault,
  resolvedModel: 'claude-opus-5',
};

const opus: SelectableModel = {
  id: 'claude-opus-5',
  name: 'Opus 5',
  originalId: 'claude-opus-5',
  capabilities: {} as never,
};

describe('modelIdentityLabel', () => {
  test('names the engine default "Default", not the catalog\'s option copy', () => {
    // "(recommended)" is real information on an OPTION and a lie about
    // identity: it tells the reader nothing about what the session runs.
    expect(modelIdentityLabel('default', [engineDefault])).toBe('Default');
  });

  test('prefers the concrete model an alias has resolved to', () => {
    expect(modelIdentityLabel('default', [resolvedEngineDefault, opus])).toBe(
      'Opus 5',
    );
  });

  test('uses the catalog name for a concrete id', () => {
    expect(modelIdentityLabel('claude-opus-5', [opus])).toBe('Opus 5');
  });

  test('never hands back a bare internal id it can prettify', () => {
    expect(modelIdentityLabel('claude-opus-5')).toBe('Opus 5');
    expect(modelIdentityLabel('claude-opus-5[1m]')).toBe('Opus 5 (1M)');
  });

  test('says nothing was reported rather than inventing a name', () => {
    expect(modelIdentityLabel(undefined)).toBe('Model not reported');
    expect(modelIdentityLabel('   ')).toBe('Model not reported');
  });
});

/**
 * The point of the finding was not any one label but that the labels
 * DISAGREED. Each surface's own entry point is exercised here against the same
 * inputs; a surface that grows a private derivation again fails this.
 */
describe("every surface that names a session's model agrees (#1536 B5)", () => {
  const catalog = [engineDefault, opus];

  test.each([
    ['the engine default with nothing resolved', 'default', 'Default'],
    ['a concrete catalogued model', 'claude-opus-5', 'Opus 5'],
  ])('%s', (_case, modelId, expected) => {
    // Dock header identity row.
    expect(chatModelLabel(modelId, catalog)).toBe(expected);
    // Home's "Continue most recent work" card and the sidebar's Open chats
    // rows, through their catalog-less default (the prettified id path).
    expect(defaultResolveModelLabel(modelId)).toBe(modelIdentityLabel(modelId));
    expect(modelIdentityLabel(modelId, catalog)).toBe(expected);
  });

  test('the dock row shows nothing, rather than a claim, with no model reported', () => {
    // Its one documented departure: "Model not reported" is a claim about the
    // SESSION, which a compact identity row is not entitled to make.
    expect(chatModelLabel(undefined, catalog)).toBeNull();
    expect(defaultResolveModelLabel(undefined)).toBe('Model not reported');
  });
});
