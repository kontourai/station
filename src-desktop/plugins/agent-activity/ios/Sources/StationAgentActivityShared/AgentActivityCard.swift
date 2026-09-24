/// What the Live Activity shows for one content update.
public enum AgentActivityCard: Equatable {
  /// Something did not check out; the view shows a neutral
  /// "Agent activity — open Station" and nothing from the push.
  case placeholder
  case card(ActivityModel)
}

public enum AgentActivityCardResolver {
  /// Every check must pass, in this order, before anything from the push is
  /// shown. The Station key pin (`sk`) is what stops another Station, which
  /// can also get a signature past the gateway, from writing on this phone's
  /// card; `user_id` inside the seal must name the Station that registered.
  public static func resolve(
    state: StationAgentActivityAttributes.ContentState,
    attributesRid: String,
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
    return .card(ActivityModel(data: card, active: card["active"] == "true"))
  }
}
