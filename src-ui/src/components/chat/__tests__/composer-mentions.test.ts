import { describe, expect, test } from 'vitest';
import { expandComposerMentions } from '../composer-mention-wire';
import {
  appendComposerSessionReference,
  composerDisplayValue,
  durableMentionAuthority,
  insertComposerMention,
  mentionQueryAt,
  parseComposerMentions,
  parseComposerSessionReferences,
  reconcileComposerDisplay,
  sessionReferenceBlockReason,
  sessionReferenceToken,
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

  test('rejects a persisted file token with an unknown entry type', () => {
    expect(
      expandComposerMentions(
        '@[m:file.ts|file.ts|%2Frepo|authority|symlink]',
        '/repo',
        'authority',
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

  test('keeps session references as compact persisted chips and sends only a canonical link', () => {
    const canonical = appendComposerSessionReference('compare', {
      label: 'Roadmap ](https://evil.test)\nnotes',
      conversationId: 'conversation/a b',
      projectSlug: 'private-project',
      authority: 'authority-1',
    });

    expect(composerDisplayValue(canonical)).toBe(
      'compare @Roadmap ](https://evil.test) notes ',
    );
    expect(parseComposerSessionReferences(canonical)[0]).toEqual(
      expect.objectContaining({
        conversationId: 'conversation/a b',
        projectSlug: 'private-project',
      }),
    );
    expect(expandComposerMentions(canonical, undefined, 'authority-1')).toEqual(
      {
        text: 'compare [Roadmap https://evil.test notes](/activity?session=conversation%2Fa%20b) ',
      },
    );
  });

  test('uses one block reason for revoked, duplicate, self, and capped references', () => {
    const one = appendComposerSessionReference('', {
      label: 'One',
      conversationId: 'one',
      authority: 'authority-1',
    });
    expect(
      sessionReferenceBlockReason({
        value: one,
        conversationId: 'two',
        authority: 'authority-1',
        isCurrent: () => false,
      }),
    ).toMatch(/access changed/);
    expect(
      sessionReferenceBlockReason({
        value: one,
        conversationId: 'one',
        authority: 'authority-1',
        isCurrent: () => true,
      }),
    ).toMatch(/already referenced/);
    expect(
      sessionReferenceBlockReason({
        value: '',
        conversationId: 'self',
        activeConversationId: 'self',
        authority: 'authority-1',
        isCurrent: () => true,
      }),
    ).toMatch(/already open/);
    let capped = '';
    for (let index = 0; index < 8; index += 1)
      capped = appendComposerSessionReference(capped, {
        label: `Conversation ${index}`,
        conversationId: `conversation-${index}`,
        authority: 'authority-1',
      });
    expect(
      sessionReferenceBlockReason({
        value: capped,
        conversationId: 'ninth',
        authority: 'authority-1',
        isCurrent: () => true,
      }),
    ).toMatch(/at most 8/);
  });

  test('editing a file token preserves a session token and vice versa', () => {
    const file = insertComposerMention('@file', 0, 5, {
      label: 'file.ts',
      path: 'file.ts',
      workspace: '/repo',
      authority: 'authority-1',
      type: 'file',
    });
    const both = appendComposerSessionReference(file, {
      label: 'Earlier work',
      conversationId: 'earlier',
      authority: 'authority-1',
    });
    const edited = reconcileComposerDisplay(
      both,
      composerDisplayValue(both).replace('@file.ts', 'plain'),
    );
    expect(parseComposerMentions(edited)).toHaveLength(0);
    expect(parseComposerSessionReferences(edited)).toEqual([
      expect.objectContaining({ conversationId: 'earlier' }),
    ]);

    const referenceFirst = `${sessionReferenceToken({
      label: 'First reference',
      conversationId: 'first',
      authority: 'authority-1',
    })} ${file}`;
    expect(composerDisplayValue(referenceFirst)).toBe(
      '@First reference @file.ts ',
    );
    expect(parseComposerMentions(referenceFirst)[0]).toEqual(
      expect.objectContaining({ displayStart: 17, displayEnd: 25 }),
    );

    const twoReferences = appendComposerSessionReference(referenceFirst, {
      label: 'Second reference',
      conversationId: 'second',
      authority: 'authority-1',
    });
    const withoutFirst = reconcileComposerDisplay(
      twoReferences,
      composerDisplayValue(twoReferences).replace('@First reference ', ''),
    );
    expect(parseComposerSessionReferences(withoutFirst)).toEqual([
      expect.objectContaining({ conversationId: 'second' }),
    ]);
    expect(parseComposerMentions(withoutFirst)).toEqual([
      expect.objectContaining({ path: 'file.ts' }),
    ]);
  });
});
