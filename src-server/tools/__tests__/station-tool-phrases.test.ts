/**
 * #3418: every tool Station's own MCP servers register has a plain-language
 * phrase, and the phrase table names no tool they do not register. Read from
 * the PRODUCTION catalogs (the same factories the classification test uses),
 * with the default-off S3 knowledge tools switched on so they are covered too.
 */
import {
  STATION_TOOL_SERVERS,
  stationToolOf,
  stationToolPhrase,
  stationToolPhraseNames,
} from '@kontourai/station-contracts/station-tool-phrases';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { STATION_BROWSER_TOOL_NAMES } from '../station-browser-policy.js';
import { stationControlToolCatalog } from '../station-control-mcp-server.js';
import { stationDocsToolCatalog } from '../station-docs-mcp-server.js';
import { stationKnowledgeToolCatalog } from '../station-knowledge-mcp-server.js';

function registeredToolNames(): string[] {
  return [
    ...new Set([
      ...[
        ...stationControlToolCatalog(),
        ...stationKnowledgeToolCatalog(),
        ...stationDocsToolCatalog(),
      ].map((tool) => tool.name),
      ...STATION_BROWSER_TOOL_NAMES,
    ]),
  ].sort();
}

beforeEach(() => vi.stubEnv('STATION_EXPERIMENTAL_S3_SOURCES', '1'));
afterEach(() => vi.unstubAllEnvs());

describe('Station tool phrases', () => {
  test('the table words exactly the registered tools: none missing, none stale', () => {
    const registered = registeredToolNames();
    expect(registered.length).toBeGreaterThan(150);
    expect(registered.some((name) => name.includes('_s3_'))).toBe(true);
    expect([...stationToolPhraseNames()].sort()).toEqual(registered);
  });

  test('every registered tool has three distinct-purpose forms with no unfilled slot', () => {
    for (const name of registeredToolNames()) {
      for (const phase of ['done', 'running', 'pending'] as const) {
        const phrase = stationToolPhrase(name, phase, { args: {} });
        expect(phrase, `${name} ${phase}`).toMatch(/^[A-Z]/u);
        expect(phrase, `${name} ${phase}`).not.toMatch(
          /undefined|\{|\}|_|\s{2}/u,
        );
      }
    }
  });

  test('every server the phrases claim is one this Station registers', () => {
    expect([...STATION_TOOL_SERVERS].sort()).toEqual([
      'station-browser',
      'station-control',
      'station-docs',
      'station-knowledge',
    ]);
    expect(stationToolOf('mcp__station-control__wait_session')).toEqual({
      server: 'station-control',
      tool: 'wait_session',
    });
  });
});
