import { inspectSdkSourceWire } from '../../delegation-group-sdk-source-wire-owner.js';
import type { PreparedStationReportGroup } from '../../station-report-group-preparation.js';
import { publicFenceFixture } from './fence.js';
import type { setup } from './report.js';

export async function taskDriver(
  h: Awaited<ReturnType<typeof setup>>,
  handle: PreparedStationReportGroup,
) {
  await h.custody.retain(h.f.context(), h.owner, handle);
  const prepared = h.owner.read(handle, h.f.req);
  const sdk = h.owner.sdk(handle, h.f.req, 'left');
  const captured = inspectSdkSourceWire(sdk.owner, sdk.sdkHandle);
  const driver = await publicFenceFixture(
    h.f,
    captured.sourceBinding.source,
    sdk.owner,
    sdk.sdkHandle,
    captured.wire,
    () => {},
    {
      protocol: 'rounds',
      provider: 'anthropic',
      modelId: prepared.members[0].modelId,
      allocation: prepared.spec.seats[0].allocation,
      contract: captured.contract,
      now: Date.now,
      preparedGroup: { owner: h.owner, handle },
    },
  );
  return { prepared, sdk, driver };
}
