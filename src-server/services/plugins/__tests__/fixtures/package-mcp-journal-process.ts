/** Disposable IPC fixture: real EventStore process, no MCP/network/provider effects. */
import { EventStore } from '../../../orchestration/event-store.js';
import type {
  PackageMcpClaim,
  PackageMcpRetirement,
} from '../../package-mcp-admission.js';

const store = new EventStore(process.argv[2]!);
const journal = store.createPackageMcpAdmissionJournal();
const claims = new Map<number, PackageMcpClaim>();
const retirements = new Map<number, PackageMcpRetirement>();
let next = 0;
process.on('message', (message: any) => {
  try {
    let result: unknown;
    if (message.operation === 'record')
      result = journal.recordInstallation(message.input);
    else if (message.operation === 'current')
      result = journal.currentInstallation(message.pluginId);
    else if (message.operation === 'reserve') {
      const outcome = journal.reserve(
        message.installation,
        message.purpose ?? 'managed',
      );
      if (outcome.state === 'reserved') {
        const handle = ++next;
        claims.set(handle, outcome.claim);
        result = { state: outcome.state, handle };
      } else result = outcome;
    } else if (message.operation === 'effect')
      result = claims.get(message.handle)!.enterEffectBoundary();
    else if (message.operation === 'release')
      result = claims.get(message.handle)!.releaseNotStarted();
    else if (message.operation === 'local-settled')
      result = claims.get(message.handle)!.observeLocalSettlement();
    else if (message.operation === 'retire') {
      const outcome = journal.requestRetirement(message.installation);
      if (outcome.state === 'fenced') {
        const handle = ++next;
        retirements.set(handle, outcome.retirement);
        result = {
          state: outcome.state,
          handle,
          inspection: outcome.retirement.inspect(),
        };
      } else result = outcome;
    } else if (message.operation === 'cancel')
      result = retirements.get(message.handle)!.cancel();
    else if (message.operation === 'inspect')
      result = journal.inspect(message.installation);
    else throw new Error('Unknown fixture command');
    process.send?.({ id: message.id, result });
  } catch {
    process.send?.({ id: message.id, error: 'fixture command failed' });
  }
});
process.send?.({ ready: true });
