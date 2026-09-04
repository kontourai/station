import { join } from 'node:path';
import { EventStore } from '../../../orchestration/event-store.js';
import { createLocalPluginInstallationService } from '../../plugin-installation-local.js';

const home = process.argv[2]!;
const store = new EventStore(join(home, 'events.sqlite'));
const service = createLocalPluginInstallationService(
  join(home, 'plugins'),
  store.createPackageMcpAdmissionJournal(),
  process.argv[3]!,
);
process.on('message', async (message: any) => {
  try {
    const result =
      message.operation === 'inspect'
        ? await service.inspect(message.input)
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
