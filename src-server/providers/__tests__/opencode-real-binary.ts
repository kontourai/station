/**
 * Which real `opencode` a process test may drive, or why it skips.
 *
 * OpenCode 1.x (npm `opencode-ai`) and 2.x are different engines to Station:
 * 1.x runs over ACP with the launch overlay and `debug agent`, 2.x natively
 * over `opencode serve` (and refuses Station's modes over ACP, ruling R1).
 * A probe written for one proves nothing on the other, so each asks for its
 * major version and skips loudly, with the reason in its title, otherwise.
 */

import { OPENCODE_SERVE_VERIFIED_FINGERPRINTS } from '../adapters/opencode-serve-fingerprint.js';
import { openCodeVersionProbe } from '../adapters/opencode-version-probe.js';
import { findCliBinaryAsync } from '../auth/cli-auth.js';

/** Points the native process test at a 2.x binary not on PATH. */
export const OPENCODE_2_BINARY_ENV = 'STATION_TEST_OPENCODE_2_BINARY';

export type RealOpenCode =
  | { readonly binary: string; readonly version: string; readonly skip?: never }
  | {
      readonly skip: string;
      readonly binary?: never;
      readonly version?: never;
    };

/** The `opencode` on PATH when it is 1.x. */
export async function realOpenCode1(): Promise<RealOpenCode> {
  const binary = await findCliBinaryAsync('opencode');
  if (!binary) return { skip: 'no opencode binary on this host' };
  const version = await openCodeVersionProbe.probe(binary);
  if (!version) return { skip: `could not read ${binary} --version` };
  if (version.major !== 1)
    return {
      skip: `opencode on this host is ${version.text}; this probe covers OpenCode 1.x over ACP`,
    };
  return { binary, version: version.text };
}

/**
 * A 2.x binary whose served API Station has verified: the one
 * {@link OPENCODE_2_BINARY_ENV} names, else the `opencode` on PATH.
 */
export async function realOpenCode2(): Promise<RealOpenCode> {
  const named = process.env[OPENCODE_2_BINARY_ENV];
  const binary = named || (await findCliBinaryAsync('opencode'));
  if (!binary)
    return {
      skip: `no opencode binary on this host (set ${OPENCODE_2_BINARY_ENV} to a 2.x binary)`,
    };
  const version = await openCodeVersionProbe.probe(binary);
  if (!version) return { skip: `could not read ${binary} --version` };
  if (!Object.hasOwn(OPENCODE_SERVE_VERIFIED_FINGERPRINTS, version.text))
    return {
      skip: `${binary} is OpenCode ${version.text}; the native transport is verified for ${Object.keys(OPENCODE_SERVE_VERIFIED_FINGERPRINTS).join(', ')} (set ${OPENCODE_2_BINARY_ENV})`,
    };
  return { binary, version: version.text };
}

/** Say loudly, once per file, that a probe did not run. */
export function warnSkipped(probe: string, found: RealOpenCode): void {
  if (found.skip)
    console.warn(`ENFORCEMENT UNVERIFIED (${probe}): ${found.skip}.`);
}
