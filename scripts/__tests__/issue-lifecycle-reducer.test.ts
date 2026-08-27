import { describe, expect, test } from 'vitest';
import {
  isSubstantiveReply,
  NEEDS_MAINTAINER,
  NEEDS_REPORTER,
  reduceIssueLifecycle,
  visibleCommentText,
} from '../issue-lifecycle-reducer.mjs';

const unrelated = ['P1', 'agent:claimed', 'stage:preview', 'security'];

describe('issue lifecycle reducer', () => {
  test('opens and reopens at the maintainer handoff without replacing unrelated labels', () => {
    for (const kind of ['issue-opened', 'issue-reopened']) {
      expect(
        reduceIssueLifecycle({
          kind,
          issue: { labels: [...unrelated, NEEDS_REPORTER] },
        }),
      ).toEqual({ add: [NEEDS_MAINTAINER], remove: [NEEDS_REPORTER] });
    }
  });

  test('only an authorized deliberate reporter request changes a maintainer handoff', () => {
    expect(
      reduceIssueLifecycle({
        kind: 'maintainer-requested-reporter',
        label: NEEDS_REPORTER,
        actorPermission: 'triage',
        issue: { labels: [...unrelated, NEEDS_MAINTAINER] },
      }),
    ).toEqual({ add: [NEEDS_REPORTER], remove: [NEEDS_MAINTAINER] });
    for (const actorPermission of ['read', 'none', undefined]) {
      expect(
        reduceIssueLifecycle({
          kind: 'maintainer-requested-reporter',
          label: NEEDS_REPORTER,
          actorPermission,
          issue: { labels: [NEEDS_MAINTAINER] },
        }),
      ).toEqual({ add: [], remove: [] });
    }
  });

  test('requires the exact reporter and a substantive response', () => {
    const base = {
      kind: 'reporter-commented',
      reporterLogin: 'reporter',
      actorLogin: 'reporter',
      issue: { labels: [...unrelated, NEEDS_REPORTER] },
    };
    expect(
      reduceIssueLifecycle({
        ...base,
        commentBody:
          'It fails on macOS 15.6 when I reopen the app; the attached log is from the second launch.',
      }),
    ).toEqual({ add: [NEEDS_MAINTAINER], remove: [NEEDS_REPORTER] });
    expect(
      reduceIssueLifecycle({
        ...base,
        actorLogin: 'someone-else',
        commentBody: 'Here are the steps.',
      }),
    ).toEqual({ add: [], remove: [] });
    expect(
      reduceIssueLifecycle({
        ...base,
        issue: { labels: [] },
        commentBody: 'Here are the steps.',
      }),
    ).toEqual({ add: [], remove: [] });
  });

  test.each([
    '',
    '   ',
    '<!-- hidden evidence -->',
    '> quoted prior reply\n> more quote',
    '👍',
    '+1',
    'Thanks!',
    'Thank you!',
    'Thanks again!',
    'ack',
    'got it',
    'sounds good',
    'Okay',
    'OK',
    'Understood',
    'I understand',
    'Will do',
    "I'll do that",
    'No problem',
    '✅\n<!-- hidden -->',
  ])('treats %j as non-substantive', (body) => {
    expect(isSubstantiveReply(body)).toBe(false);
  });

  test('strips hidden and quoted Markdown but keeps a reporter’s actual content', () => {
    const body =
      '<!-- machine note -->\n> old question\n\nThe crash happens after selecting a project.';
    expect(visibleCommentText(body)).toBe(
      'The crash happens after selecting a project.',
    );
    expect(isSubstantiveReply(body)).toBe(true);
  });

  test('does not mistake an acknowledgement phrase with new information for an acknowledgement-only reply', () => {
    expect(
      isSubstantiveReply(
        'Okay, here is the log ID 4732 from the failed launch.',
      ),
    ).toBe(true);
  });

  test('is idempotent once the desired handoff labels are already present', () => {
    expect(
      reduceIssueLifecycle({
        kind: 'issue-opened',
        issue: { labels: [...unrelated, NEEDS_MAINTAINER] },
      }),
    ).toEqual({ add: [], remove: [] });
  });
});
