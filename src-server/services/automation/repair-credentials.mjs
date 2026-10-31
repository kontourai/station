import { tmpdir } from 'node:os';
import { parseAuthRef } from '@kontourai/station-contracts/datum-secret-reference';
import { runInProcessGroup } from '../../utils/process-group-exec.js';

/** Datum owns reference parsing; this async owner bounds secret-tool execution without blocking revocation. */
export async function materializeRepairCredential(
  reference,
  { assertCurrent, signal } = {},
) {
  await assertCurrent?.();
  if (signal?.aborted) throw new Error('repair-credential-unavailable');
  let value;
  try {
    const auth = parseAuthRef(reference);
    if ('env' in auth) value = process.env[auth.env];
    else {
      let executable;
      let args;
      if ('keychain' in auth) {
        if (process.platform !== 'darwin') throw new Error('unsupported');
        executable = '/usr/bin/security';
        args = [
          'find-generic-password',
          '-s',
          auth.keychain.service,
          ...(auth.keychain.account ? ['-a', auth.keychain.account] : []),
          '-w',
        ];
      } else {
        executable = 'op';
        args = ['read', auth.op];
      }
      const result = await runInProcessGroup(executable, args, {
        cwd: tmpdir(),
        timeout: 10_000,
        maxBuffer: 65_536,
        signal,
      });
      value = result.stdout.replace(/\n$/, '');
    }
    if (
      typeof value !== 'string' ||
      !value.length ||
      Buffer.byteLength(value) > 65_536
    )
      throw new Error('missing');
  } catch {
    throw new Error('repair-credential-unavailable');
  }
  await assertCurrent?.();
  if (signal?.aborted) throw new Error('repair-credential-unavailable');
  return value;
}
