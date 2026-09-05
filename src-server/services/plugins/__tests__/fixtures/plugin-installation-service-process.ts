import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { EventStore } from '../../../orchestration/event-store.js';
import { materializePluginArtifact } from '../../plugin-artifact-local.js';
import {
  createLocalPluginInstallationService,
  reconcileLocalPluginInstallations,
} from '../../plugin-installation-local.js';

const home = process.argv[2]!;
const store = new EventStore(join(home, 'events.sqlite'));
const artifacts = new Map<string, string>();
process.on('message', async (message: any) => {
  try {
    if (message.operation === 'artifact') {
      const staged = mkdtempSync(join(home, '.received-artifact-'));
      await materializePluginArtifact(
        {
          digest: message.input.digest,
          async *readEntries() {
            for (const entry of message.input.entries)
              yield entry.kind === 'file'
                ? { ...entry, bytes: Buffer.from(entry.bytes, 'base64') }
                : entry;
          },
        },
        staged,
      );
      artifacts.set(message.input.digest, staged);
      process.send?.({
        id: message.id,
        result: { digest: message.input.digest },
      });
      return;
    }
    if (message.operation === 'reconcile-all') {
      process.send?.({
        id: message.id,
        result: await reconcileLocalPluginInstallations(
          join(home, 'plugins'),
          store.createPackageMcpAdmissionJournal(),
        ),
      });
      return;
    }
    const service = createLocalPluginInstallationService(
      join(home, 'plugins'),
      store.createPackageMcpAdmissionJournal(),
      artifacts.get(message.input?.artifact?.digest) ?? process.argv[3],
    );
    const result =
      message.operation === 'inspect'
        ? await service.inspect(message.input)
        : message.operation === 'reconcile'
          ? await service.reconcile(message.input)
          : message.operation === 'withdraw'
            ? await service.withdraw(message.input)
            : await service.install(message.input);
    process.send?.({ id: message.id, result });
  } catch (error) {
    process.send?.({
      id: message.id,
      error: error instanceof Error ? error.message : 'failed',
    });
  }
});
process.on('disconnect', () => {
  store.close();
  process.exit(0);
});
process.send?.({ ready: true });
