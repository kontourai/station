/**
 * #895 wave A: shared session.configured metadata merge for the
 * channel-delivery stage of capability delivery
 * (docs/design/agent-engine-unification.md §5/§6.2), used by both
 * `acp-adapter.ts` (tool servers) and `claude-adapter.ts` (skills).
 *
 * Two-stage receipts: the orchestration-layer resolver
 * (`session-agent-resolution.ts`) records *resolution-stage* undelivered
 * entries (not-found, secret-boundary-env, engine-unsupported) into
 * `input.metadata.capabilityDelivery` before the adapter ever runs. This
 * helper lets the delivering adapter merge its *channel-stage* outcome
 * (delivered ids + channel-specific skips, e.g. unsupported-transport,
 * binary-not-found, materialization-skipped) into that SAME report rather
 * than replacing it — an agent-authored id that failed resolution and one
 * that failed delivery both end up in one `undelivered` list, and the
 * original `requested`/`source` (set at resolution time, when the full
 * authored id list was known) is preserved rather than narrowed down to
 * only the ids that made it through resolution.
 *
 * `channelReport.undelivered` passed in here must be the CHANNEL-STAGE
 * skips only — this function prepends any resolution-stage undelivered
 * entries already present in `inputMetadata` automatically.
 */
import {
  type CapabilityDeliveryCapability,
  type CapabilityDeliveryChannelReport,
  SESSION_CAPABILITY_DELIVERY_METADATA_KEY,
  type SessionCapabilityDeliveryMetadata,
} from '@kontourai/station-contracts/provider';

export function mergeCapabilityDeliveryMetadata(
  inputMetadata: Record<string, unknown> | undefined,
  capability: CapabilityDeliveryCapability,
  channelReport: CapabilityDeliveryChannelReport,
): Record<string, unknown> {
  const existingDelivery = inputMetadata?.[
    SESSION_CAPABILITY_DELIVERY_METADATA_KEY
  ] as SessionCapabilityDeliveryMetadata | undefined;
  const existingReport = existingDelivery?.[capability];

  return {
    ...inputMetadata,
    [SESSION_CAPABILITY_DELIVERY_METADATA_KEY]: {
      ...existingDelivery,
      [capability]: {
        source: existingReport?.source ?? channelReport.source,
        requested: existingReport?.requested ?? channelReport.requested,
        delivered: channelReport.delivered ?? [],
        // station#1547 AC5. Union rather than `??`, and channel-stage first
        // only because that is where grants are made today: a runtime grant
        // is an addition by whichever stage made it, so a later stage adding
        // one must not erase an earlier stage's — unlike `source` and
        // `requested`, which are single facts owned by the resolution stage.
        // Omitted entirely when neither stage granted anything, so an
        // ordinary session's receipt is byte-identical to before this field
        // existed and an empty array never reads as "a grant happened and
        // delivered nothing".
        ...(() => {
          const granted = [
            ...(existingReport?.runtimeProvided ?? []),
            ...(channelReport.runtimeProvided ?? []),
          ];
          return granted.length > 0 ? { runtimeProvided: granted } : {};
        })(),
        undelivered: [
          ...(existingReport?.undelivered ?? []),
          ...channelReport.undelivered,
        ],
      },
    },
  };
}
