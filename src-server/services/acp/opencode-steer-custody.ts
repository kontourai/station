import { join } from 'node:path';
import { nativeSessionIdentityKey } from '../../providers/adapters/native-resume-binding.js';
import { JsonFileStore } from '../infra/json-store.js';

/** Pending effects survive response loss, session stop and Station restart. */
export function openCodeSteerCustody(
  home: string,
  bindingKey: string,
  sessionId: string,
) {
  const store = new JsonFileStore<string[]>(
    join(
      home,
      'service',
      'engine-effects',
      'opencode-steers',
      `${nativeSessionIdentityKey('opencode', bindingKey, sessionId)}.json`,
    ),
    [],
    {
      durableAtomicWrite: true,
      onCorruption: 'throw',
      maxReadBytes: 64 * 1024,
    },
  );
  const read = () =>
    store.read((text) => {
      const value: unknown = JSON.parse(text);
      if (!Array.isArray(value) || value.some((id) => typeof id !== 'string'))
        throw new Error('Invalid OpenCode steer custody record');
      return value;
    });
  return {
    assertClear() {
      if (read().length)
        throw new Error(
          'OpenCode has unconfirmed steering input. Start a new chat; this session may still hold queued input.',
        );
    },
    begin(id: string) {
      store.write([...new Set([...read(), id])]);
    },
    complete(id: string) {
      store.write(read().filter((pending) => pending !== id));
    },
  };
}
