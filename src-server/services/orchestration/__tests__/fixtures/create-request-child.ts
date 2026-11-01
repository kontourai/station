import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import {
  CreateRequestClaims,
  markCreateRequestStarting,
  recordCreateRequestStartResult,
} from '../../create-request-claims.js';

const [home, cut] = process.argv.slice(2);
await new CreateRequestClaims(home).run(
  {
    kind: 'foreground',
    principal: undefined,
    authority: sessionReadAuthorityFromRequest(
      'operator',
      undefined,
      undefined,
    ),
    requestKey: 'crash-key',
    intent: { message: 'original input' },
    sessionExists: () => false,
  },
  async (id) => {
    if (cut !== 'reserved') await markCreateRequestStarting(id);
    if (cut === 'rejected')
      await recordCreateRequestStartResult(id, 'rejected');
    process.stdout.write('READY\n');
    await new Promise((resolve) => setTimeout(resolve, 15_000));
    throw new Error('Crash fixture was not killed');
  },
);
