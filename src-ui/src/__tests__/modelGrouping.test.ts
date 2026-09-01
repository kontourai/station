import { describe, expect, test } from 'vitest';
import {
  groupModelsByCanonicalIdentity,
  type SelectableModel,
} from '../utils/modelCapabilities';

const route = (
  id: string,
  providerName: string,
  canonicalId?: string,
): SelectableModel =>
  ({
    id,
    name: id,
    providerName,
    ...(canonicalId
      ? {
          canonicalModelIdentity: {
            canonicalId,
            verifiedAgainst: 'reviewed 2026-08-31',
          },
        }
      : {}),
  }) as SelectableModel;

const reviewed = (canonicalId: string) =>
  canonicalId === 'anthropic:claude-sonnet-4-5'
    ? {
        displayName: 'Claude Sonnet 4.5',
        verifiedAgainst: 'reviewed 2026-08-31',
      }
    : undefined;

describe('groupModelsByCanonicalIdentity', () => {
  test('gathers routes the reviewed map says are one model', () => {
    const sections = groupModelsByCanonicalIdentity(
      [
        route('claude-sonnet-4-5', 'Anthropic', 'anthropic:claude-sonnet-4-5'),
        route('sonnet', 'Claude Code', 'anthropic:claude-sonnet-4-5'),
      ],
      reviewed,
    );
    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({
      kind: 'model',
      displayName: 'Claude Sonnet 4.5',
    });
    expect(
      sections[0].kind === 'model' ? sections[0].routes.map((r) => r.id) : [],
    ).toEqual(['claude-sonnet-4-5', 'sonnet']);
  });

  test('leaves unrecognised routes separate rather than matching them by name', () => {
    // These two are the same model to a human reader, and their ids share a
    // long prefix. The curated map does not say so, so the picker must not
    // either.
    //
    // The lookup names ANY id on purpose. Under the strict stub a fabricated
    // grouping key fell through the "identified but unnamed" path and emitted
    // separate routes -- the same output as not grouping at all -- so this
    // assertion passed whether or not the key was honest. A fault injection
    // keying on `name.slice(0, 6)` went undetected until this changed.
    const namesAnything = (canonicalId: string) => ({
      displayName: `Reviewed ${canonicalId}`,
      verifiedAgainst: 'reviewed 2026-08-31',
    });
    const sections = groupModelsByCanonicalIdentity(
      [
        route('claude-sonnet-4-5-20250929', 'Anthropic'),
        route('claude-sonnet-4.5', 'OpenRouter'),
      ],
      namesAnything,
    );
    expect(sections.map((s) => s.kind)).toEqual(['route', 'route']);
  });

  test('a lone identified route is a route, not a group of one', () => {
    const sections = groupModelsByCanonicalIdentity(
      [route('sonnet', 'Claude Code', 'anthropic:claude-sonnet-4-5')],
      reviewed,
    );
    expect(sections).toEqual([
      { kind: 'route', model: expect.objectContaining({ id: 'sonnet' }) },
    ]);
  });

  test('an identified but unnamed model shows its routes rather than an invented heading', () => {
    const sections = groupModelsByCanonicalIdentity(
      [route('a', 'X', 'vendor:unnamed'), route('b', 'Y', 'vendor:unnamed')],
      reviewed,
    );
    expect(sections.map((s) => s.kind)).toEqual(['route', 'route']);
  });

  test('keeps first-appearance order so an upstream sort still leads', () => {
    const sections = groupModelsByCanonicalIdentity(
      [
        route('other', 'Z'),
        route('claude-sonnet-4-5', 'Anthropic', 'anthropic:claude-sonnet-4-5'),
        route('sonnet', 'Claude Code', 'anthropic:claude-sonnet-4-5'),
      ],
      reviewed,
    );
    expect(sections.map((s) => s.kind)).toEqual(['route', 'model']);
  });
});
