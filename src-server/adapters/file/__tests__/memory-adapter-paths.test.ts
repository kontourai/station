import { join } from 'node:path';
import { expect, test } from 'vitest';
import {
  ConversationPathEscapeError,
  MemoryAdapterPaths,
} from '../memory-adapter-paths.js';

const home = join('/', 'station-home');
const conversations = join(
  home,
  'agents',
  'default',
  'memory',
  'conversations',
);

test('#3075 review: a conversation file never resolves outside its conversations directory', () => {
  const paths = new MemoryAdapterPaths(home, 'linux');
  for (const id of ['../escaped', '../../agents/other/memory/x', 'a/../../b'])
    expect(() => paths.getConversationPath('default', id), id).toThrow(
      ConversationPathEscapeError,
    );
  // Ids that stay inside keep their file name, the engine colon included.
  expect(paths.getConversationPath('default', 'codex:abc')).toBe(
    join(conversations, 'codex:abc.json'),
  );
  expect(paths.getConversationPath('default', 'a..b')).toBe(
    join(conversations, 'a..b.json'),
  );
  // `..` alone names the file `...json`, inside the directory.
  expect(paths.getConversationPath('default', '..')).toBe(
    join(conversations, '...json'),
  );
});
