import Foundation

/// What the Live Activity shows for one content update.
public enum AgentActivityCard: Equatable {
  /// Something did not check out; the view shows a neutral
  /// "Agent activity — open Station" and nothing from the push.
  case placeholder
  /// A genuine card for this registration that is past its expiry (or that
  /// ActivityKit has marked stale): the view shows "Waiting for Station" in
  /// its paused styling and nothing from the card, so a replayed older card
  /// cannot put its titles, rows or counts on screen.
  case stale
  case card(ActivityModel)
}

public enum AgentActivityCardResolver {
  /// Every check must pass, in this order, before anything from the push is
  /// shown. What keeps another Station off this phone's card is the seal:
  /// only this registration's payload key opens it, with the registration id
  /// bound in as associated data. The Station key pin (`sk`) is defence in
  /// depth on top of that, and `user_id` inside the seal must name the
  /// Station that registered.
  ///
  /// A card without a readable `activity_expires_at` (epoch millis, which
  /// the Station always writes) is the placeholder. One at or past it is
  /// `.stale`, never current content: a replayed older card carries its
  /// own, earlier, expiry. The Station also sets the activity's stale date
  /// to that expiry, rounded down to whole seconds, so ActivityKit can mark
  /// the view stale up to a second early; `contextIsStale` makes that
  /// `.stale` too, so the two never disagree about what shows. There is
  /// deliberately no render-time age limit on `updated_at` (Android has
  /// one); a Live Activity can legitimately sit unchanged for longer.
  public static func resolve(
    state: StationAgentActivityAttributes.ContentState,
    attributesRid: String,
    now: Date = Date(),
    contextIsStale: Bool = false,
    registration lookup: (String) -> AgentActivityRegistration?
  ) -> AgentActivityCard {
    guard state.v == liveActivityStateVersion else { return .placeholder }
    guard state.rid == attributesRid else { return .placeholder }
    guard let registration = lookup(state.rid), registration.id == state.rid else {
      return .placeholder
    }
    guard let stationKey = state.sk, stationKey == registration.stationKey else {
      return .placeholder
    }
    guard
      let card = CardOpener.open(
        payloadKey: registration.payloadKey,
        registrationId: registration.id,
        sealed: state.sealed)
    else { return .placeholder }
    guard card["user_id"] == registration.stationId else { return .placeholder }
    guard let expiresAt = card["activity_expires_at"].flatMap({ Int64($0) }) else {
      return .placeholder
    }
    if contextIsStale || Double(expiresAt) <= now.timeIntervalSince1970 * 1000 {
      return .stale
    }
    return .card(ActivityModel(data: card, active: card["active"] == "true"))
  }
}
