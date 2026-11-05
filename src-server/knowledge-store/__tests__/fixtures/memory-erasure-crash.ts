import { join } from 'node:path';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { FileStorageAdapter } from '../../../domain/file-storage-adapter.js';
import { SqliteVecIndexProvider } from '../../../knowledge-index/sqlite-vec-index-provider.js';
import { KnowledgeStoreProvider } from '../../knowledge-store-provider.js';
import { MemoryErasureCoordinator } from '../../memory-erasure-coordinator.js';
import { MemoryRootManager } from '../../memory-root.js';

const [home, id, revision] = process.argv.slice(2);
if (!home || !id || !revision) throw new Error('Missing fixture arguments.');
process.env.STATION_HOME = home;
const owner = sessionReadAuthorityFromRequest(
  'human:owner',
  undefined,
  undefined,
);
const store = new KnowledgeStoreProvider(new FileStorageAdapter(home));
const manager = new MemoryRootManager(
  store,
  new FileStorageAdapter(home),
  home,
  () => true,
);
const root = await manager.findRoot(owner, () => {});
if (!root) throw new Error('Missing memory root.');
const index = new SqliteVecIndexProvider({ dbPath: join(home, 'index.db') });
index.removeErasedRecords = async (rootId, ids) => {
  await index.removeByRecord(rootId, ids);
  process.kill(process.pid, 'SIGKILL');
};
await new MemoryErasureCoordinator(home, store, manager, index).erase(
  owner,
  root,
  () => {},
  'record',
  id,
  revision,
  'crash-process',
);
throw new Error('Crash cut was not reached.');
