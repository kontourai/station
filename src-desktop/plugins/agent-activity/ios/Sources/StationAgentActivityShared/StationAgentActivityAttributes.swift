/// The Live Activity's static attributes and dynamic content, as the push
/// gateway writes them (`NativePushLiveActivityAttributes` and
/// `NativePushLiveActivityState` in packages/contracts/src/native-push.ts).
///
/// The `ActivityAttributes` conformance is declared separately by the app
/// plugin and by the widget extension: this file is compiled into both and
/// may not import ActivityKit (the app still deploys to iOS versions that
/// predate it). APNs push-to-start names this type by its unqualified name
/// (`NATIVE_PUSH_IOS_ATTRIBUTES_TYPE`), so the name is part of the contract.
public struct StationAgentActivityAttributes: Codable, Hashable {
  public struct ContentState: Codable, Hashable {
    /// Content-state version; only `liveActivityStateVersion` renders.
    public var v: Int
    /// The registration this card was sealed for; must equal `rid` below.
    public var rid: String
    /// Station key thumbprint, stamped by the gateway after it verified the
    /// Station's signature. Absent on anything the gateway did not relay.
    public var sk: String?
    /// base64url(nonce ‖ ciphertext ‖ tag) of the plaintext card JSON.
    public var sealed: String

    public init(v: Int, rid: String, sk: String?, sealed: String) {
      self.v = v
      self.rid = rid
      self.sk = sk
      self.sealed = sealed
    }
  }

  public var rid: String

  public init(rid: String) {
    self.rid = rid
  }
}

public let liveActivityStateVersion = 1
