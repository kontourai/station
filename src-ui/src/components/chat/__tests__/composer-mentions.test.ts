import { describe, expect, test } from 'vitest';
import { expandComposerMentions } from '../composer-mention-wire';
import {
  composerDisplayValue,
  durableMentionAuthority,
  insertComposerMention,
  mentionQueryAt,
  parseComposerMentions,
  reconcileComposerDisplay,
} from '../composer-mentions';

describe('composer file mentions', () => {
  test('durable authority survives remount identity but changes on credential replacement', () => {
    const evidence = {
      apiBase: 'https://station.test',
      connectionId: 'device-a',
      authorityGeneration: 4,
      credentialState: 'ready',
    };
    expect(durableMentionAuthority({ ...evidence })).toBe(
      durableMentionAuthority({ ...evidence }),
    );
    expect(
      durableMentionAuthority({ ...evidence, authorityGeneration: 5 }),
    ).not.toBe(durableMentionAuthority(evidence));
  });
  test('keeps a compact display token while expanding the selected path on the wire', () => {
    const canonical = insertComposerMention('review @cha please', 7, 11, {
      label: 'ChatInputArea.tsx',
      path: 'src-ui/src/components/chat/ChatInputArea.tsx',
      workspace: '/repo/station',
      authority: 'http://station.test',
      type: 'file',
    });

    expect(composerDisplayValue(canonical)).toBe(
      'review @ChatInputArea.tsx  please',
    );
    expect(
      expandComposerMentions(canonical, '/repo/station', 'http://station.test'),
    ).toEqual({
      text: 'review @"/repo/station/src-ui/src/components/chat/ChatInputArea.tsx"  please',
    });
  });

  test('preserves mention identity when editing text on either side', () => {
    const canonical = insertComposerMention('see @chat', 4, 9, {
      label: 'chat',
      path: 'src/chat',
      workspace: '/repo/station',
      authority: 'http://station.test',
      type: 'directory',
    });
    const prefixed = reconcileComposerDisplay(canonical, 'please see @chat ');
    const edited = reconcileComposerDisplay(prefixed, 'please see @chat today');

    expect(parseComposerMentions(edited)).toEqual([
      expect.objectContaining({ path: 'src/chat', type: 'directory' }),
    ]);
    expect(composerDisplayValue(edited)).toBe('please see @chat today');
  });

  test('turns an edit through a chip into ordinary text instead of retaining stale hidden data', () => {
    const canonical = insertComposerMention('@one', 0, 4, {
      label: 'one',
      path: 'src/one.ts',
      workspace: '/repo/station',
      authority: 'http://station.test',
      type: 'file',
    });
    const edited = reconcileComposerDisplay(canonical, '@once');

    expect(parseComposerMentions(edited)).toEqual([]);
    expect(edited).toBe('@once');
  });

  test('editing one token preserves the hidden identity of its neighbour', () => {
    const first = insertComposerMention('@one and @two', 0, 4, {
      label: 'one',
      path: 'one.ts',
      workspace: '/repo',
      authority: 'station',
      type: 'file',
    });
    const secondStart = composerDisplayValue(first).indexOf('@two');
    const both = insertComposerMention(first, secondStart, secondStart + 4, {
      label: 'two',
      path: 'two.ts',
      workspace: '/repo',
      authority: 'station',
      type: 'file',
    });
    const edited = reconcileComposerDisplay(both, '@once and @two ');

    expect(parseComposerMentions(edited)).toEqual([
      expect.objectContaining({ path: 'two.ts' }),
    ]);
    expect(composerDisplayValue(edited)).toBe('@once and @two ');
  });

  test('rejects a persisted mention after workspace authority changes', () => {
    const canonical = insertComposerMention('@readme', 0, 7, {
      label: 'README.md',
      path: 'README.md',
      workspace: '/repo/one',
      authority: 'http://station.test',
      type: 'file',
    });

    expect(
      expandComposerMentions(canonical, '/repo/two', 'http://station.test'),
    ).toEqual({
      error:
        'A file mention belongs to a different Station or workspace. Remove it or return to that scope before sending.',
    });
  });

  test('round trips legal punctuation and unicode without delimiter ambiguity', () => {
    const canonical = insertComposerMention('@x', 0, 2, {
      label: 'a](b) café\n.ts',
      path: 'odd/a](b) café\n.ts',
      workspace: '/repo/(station)',
      authority: 'https://station.test/(personal)',
      type: 'file',
    });

    expect(parseComposerMentions(canonical)[0]).toEqual(
      expect.objectContaining({ path: 'odd/a](b) café\n.ts' }),
    );
    expect(
      expandComposerMentions(
        canonical,
        '/repo/(station)',
        'https://station.test/(personal)',
      ).text,
    ).toContain('/repo/(station)/odd/a](b) café\\n.ts');
  });

  test('rejects the same workspace path when the Station authority changes', () => {
    const canonical = insertComposerMention('@x', 0, 2, {
      label: 'x',
      path: 'x',
      workspace: '/repo',
      authority: 'https://one.test',
      type: 'file',
    });
    expect(
      expandComposerMentions(canonical, '/repo', 'https://two.test').error,
    ).toMatch(/different Station or workspace/);
  });

  test('surfaces a corrupt persisted token instead of sending its encoded text', () => {
    expect(
      expandComposerMentions(
        'review @[m:not|valid]',
        '/repo',
        'https://station.test',
      ),
    ).toEqual({
      error:
        'A saved file mention is damaged. Remove its visible token and select the file again.',
    });
  });

  test('finds only the active whitespace-delimited at trigger', () => {
    expect(mentionQueryAt('ask @src/com', 12)).toEqual({
      start: 4,
      query: 'src/com',
    });
    expect(mentionQueryAt('email@example.com', 17)).toBeNull();
  });
});
