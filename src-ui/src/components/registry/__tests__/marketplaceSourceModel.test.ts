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

  // These three ids share their last four hash digits (t5c6), and their
  // names and paths differ only by punctuation, so the short tag alone
  // cannot tell them apart.
  const shortTagCollision = [
    source(
      '159bafac-955d-4d19-a772-694feea0c565',
      '/home/alex/.codex/skills',
      'Local skills',
    ),
    source(
      '7209dfab-62ba-41e1-ac74-2890f2bbb3c8',
      '/home/alex/codex/skills',
      'Local-skills',
    ),
    source(
      '8c0d0983-4201-4a3b-a38c-9e52b9e5a861',
      '/home/alex/co.dex/skills',
      'Local_skills',
    ),
  ];
  const orders = <T>(items: readonly T[]): T[][] =>
    items.length <= 1
      ? [[...items]]
      : items.flatMap((item, index) =>
          orders([...items.slice(0, index), ...items.slice(index + 1)]).map(
            (rest) => [item, ...rest],
          ),
        );

  test('three ids whose short tags collide still get labels unique ignoring punctuation, in every input order', () => {
    const labels = distinctLabels(shortTagCollision);
    expect(labels.size).toBe(3);
    expect(unique(labels)).toBe(true);
    for (const order of orders(shortTagCollision))
      expect(distinctLabels(order)).toEqual(labels);
    // A longer tag replaces the short one rather than repeating it.
    for (const label of labels.values())
      expect(label.match(/#/g)?.length).toBe(1);
  });

  test('when every tag length is taken, an ordinal tells sources apart, in every input order', () => {
    // FNV-1a of both ids is the same 32-bit value (07ko21p), and three other
    // sources are named exactly as the longer tags would label them.
    const sources = [
      source('source-825528', '/srv/x', 'Solo'),
      source('source-1023002', '/srv/x', 'Solo'),
      source('a1', '/srv/a1', 'Solo · srv/x #ko21p'),
      source('a2', '/srv/a2', 'Solo · srv/x #7ko21p'),
      source('a3', '/srv/a3', 'Solo · srv/x #07ko21p'),
    ];
    const labels = distinctLabels(sources);
    expect(unique(labels)).toBe(true);
    expect(labels.get('source-1023002')).toBe('Solo · srv/x #o21p');
    expect(labels.get('source-825528')).toBe('Solo · srv/x #07ko21p-2');
    for (const order of orders(sources))
      expect(distinctLabels(order)).toEqual(labels);
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
