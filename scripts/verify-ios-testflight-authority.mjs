#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SHA = /^[0-9a-f]{40}$/;
export function verifyIosTestFlightAuthority({
  sourceRef,
  sourceSha,
  resolveRef,
}) {
  if (
    !/^refs\/tags\/(v\d+\.\d+\.\d+(?:-preview\.\d+)?|nightly-version-code\/\d+)$/.test(
      sourceRef,
    )
  )
    throw new Error('source ref is not an immutable Station release authority');
  if (!SHA.test(sourceSha))
    throw new Error('source SHA must be 40 lowercase hex characters');
  let resolved;
  try {
    resolved = resolveRef(sourceRef);
  } catch {
    throw new Error(`source authority ref is missing: ${sourceRef}`);
  }
  if (resolved !== sourceSha)
    throw new Error(
      `source authority ref ${sourceRef} resolves to ${resolved}, not ${sourceSha}`,
    );
  return { sourceRef, sourceSha };
}
function value(args, name) {
  const at = args.indexOf(`--${name}`);
  return at < 0 ? undefined : args[at + 1];
}
if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const sourceRef = value(process.argv, 'source-ref');
  const sourceSha = value(process.argv, 'source-sha');
  try {
    console.log(
      JSON.stringify(
        verifyIosTestFlightAuthority({
          sourceRef,
          sourceSha,
          resolveRef: (ref) =>
            execFileSync('git', ['rev-parse', `${ref}^{commit}`], {
              encoding: 'utf8',
              windowsHide: true,
            }).trim(),
        }),
      ),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
