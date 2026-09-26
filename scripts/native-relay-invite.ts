import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { invokedDirectly } from './lib/module-entry.mjs';
import { loadSelfHostedBrokerConnectorConfig } from '../src-server/runtime/bootstrap/self-hosted-connector-config.js';

/** Operator terminal only: public prepare file in, private invitation file out. */
export async function writeNativeRelayInvitation(
  args: string[],
): Promise<void> {
  if (args.length !== 4 || args.some((path) => !isAbsolute(path)))
    throw new Error('native_invitation_usage');
  const [homeDir, configPath, preparePath, outputPath] = args;
  const factory = loadSelfHostedBrokerConnectorConfig({
    homeDir,
    env: { STATION_BROKER_CONFIG_FILE: configPath },
  });
  if (!factory) throw new Error('native_invitation_connector_unconfigured');
  const parent = lstatSync(dirname(outputPath!));
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    parent.uid !== process.getuid?.() ||
    (parent.mode & 0o077) !== 0
  )
    throw new Error('native_invitation_output_not_private');
  const fd = openSync(
    preparePath!,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  let prepare: unknown;
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > 16 * 1024)
      throw new Error('native_invitation_prepare_invalid');
    const bytes = Buffer.alloc(16 * 1024 + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = readSync(fd, bytes, count, bytes.length - count, null);
      if (!read) break;
      count += read;
    }
    if (count > 16 * 1024) throw new Error('native_invitation_prepare_invalid');
    prepare = JSON.parse(bytes.subarray(0, count).toString('utf8'));
  } finally {
    closeSync(fd);
  }
  const invitation = await factory.issueNativeInvitation(
    prepare,
    AbortSignal.timeout(30_000),
  );
  writeFileSync(outputPath!, `${JSON.stringify(invitation)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
}

if (invokedDirectly(import.meta.url)) {
  writeNativeRelayInvitation(process.argv.slice(2)).then(
    () => {
      process.stdout.write('STATION_NATIVE_INVITATION_WRITTEN\n');
    },
    () => {
      // Errors may originate from credential-bearing responses; never print them.
      process.stderr.write(
        'Native invitation refused. Expected absolute home, connector config, prepare JSON, and new private output paths.\n',
      );
      process.exitCode = 1;
    },
  );
}
