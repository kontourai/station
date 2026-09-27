import { describe, expect, test } from 'vitest';
import { isGitMetadataName } from '../git-metadata-name.js';

const ZWNJ = '‌';
const ZWJ = '‍';
const BOM = '﻿';

describe('isGitMetadataName', () => {
  test.each([
    ['.git'],
    ['.GIT'],
    ['.Git'],
    ['.git.'],
    ['.git '],
    ['git~1'],
    ['GIT~1'],
    // git's own `next_hfs_char` set (utf8.c), one from each range.
    [`.g${ZWNJ}it`],
    [`.git${ZWJ}`],
    [`${BOM}.git`],
    ['.g‎it'],
    ['.gi‏t'],
    ['.‪git'],
    ['.git‮'],
    ['⁪.git'],
    ['.g⁯it'],
  ])('treats %j as git metadata', (name) => {
    expect(isGitMetadataName(name)).toBe(true);
  });

  test.each([
    ['git'],
    ['.github'],
    ['.gitignore'],
    ['.gitkeep'],
    ['x.git'],
    ['.g-it'],
    ['.géit'],
  ])('leaves %j alone', (name) => {
    expect(isGitMetadataName(name)).toBe(false);
  });
});
