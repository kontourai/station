import type { RegistrySource } from '@kontourai/station-contracts/catalog';
import { describe, expect, test } from 'vitest';
import {
  distinctLabels,
  labelKey,
  locationHint,
  redactHome,
} from '../marketplaceSourceModel';

const source = (
  id: string,
  location: string,
  displayName = 'Local skills',
): RegistrySource => ({
  id,
  kind: 'skills',
  displayName,
  origin: 'user',
  location,
  adapter: 'directory',
  enabled: true,
  status: 'ready',
});

const ACCOUNTS = /alex|bob/i;

describe('location hints never name a home folder', () => {
  test.each([
    // Mac
    ['/Users/alex', '~'],
    ['/Users/alex/project', '~/project'],
    ['/Users/alex/.codex/skills', '~/.codex/skills'],
    ['/Users/alex/a/b/c/skills', '~/…/c/skills'],
    // Linux
    ['/home/alex', '~'],
    ['/home/alex/project', '~/project'],
    ['/root/skills', '~/skills'],
    // Windows
    ['C:\\Users\\alex', '~'],
    ['C:\\Users\\alex\\project', '~/project'],
    ['C:\\Users\\alex\\a\\b\\skills', '~/…/b/skills'],
    // Not a home folder
    ['/opt/station/skills/team', '…/skills/team'],
    ['/srv/skills', 'srv/skills'],
  ])('%s → %s', (location, hint) => {
    expect(locationHint(source('one', location))).toBe(hint);
    expect(locationHint(source('one', location))).not.toMatch(ACCOUNTS);
  });

  test('home redaction happens before shortening, on every platform spelling', () => {
    expect(redactHome('/Users/alex/x')).toBe('~/x');
    expect(redactHome('/home/alex')).toBe('~');
    expect(redactHome('C:\\Users\\alex\\x\\y')).toBe('~/x/y');
    expect(redactHome('/opt/alexandria/x')).toBe('/opt/alexandria/x');
  });
});

describe('labels for sources named alike', () => {
  const unique = (labels: Map<string, string>) => {
    const keys = [...labels.values()].map(labelKey);
    return new Set(keys).size === keys.length;
  };

  test('paths that differ only by punctuation get a stable non-punctuation tag', () => {
    const sources = [
      source('dotted', '/home/alex/.codex/skills'),
      source('plain', '/home/alex/codex/skills'),
    ];
    const labels = distinctLabels(sources);
    expect(unique(labels)).toBe(true);
    for (const label of labels.values()) expect(label).not.toMatch(ACCOUNTS);
    // Stable across renders and input order.
    expect(distinctLabels([...sources].reverse())).toEqual(labels);
  });

  test('identical locations with distinct ids are still told apart', () => {
    const labels = distinctLabels([
      source('first', '/srv/skills'),
      source('second', '/srv/skills'),
    ]);
    expect(unique(labels)).toBe(true);
  });

  test("two users' homes collapse to ~ and never appear in a label", () => {
    const labels = distinctLabels([
      source('mac', '/Users/alex/x'),
      source('linux', '/home/bob/x'),
      source('windows', 'C:\\Users\\alex\\deep\\x'),
    ]);
    expect(unique(labels)).toBe(true);
    for (const label of labels.values()) expect(label).not.toMatch(ACCOUNTS);
  });

  test('a path tail that tells sources apart is still preferred to a tag', () => {
    const labels = distinctLabels([
      source('a', '/srv/team/a/skills'),
      source('b', '/srv/team/b/skills'),
    ]);
    expect(labels.get('a')).toBe('Local skills · …/a/skills');
    expect(labels.get('b')).toBe('Local skills · …/b/skills');
  });
});
