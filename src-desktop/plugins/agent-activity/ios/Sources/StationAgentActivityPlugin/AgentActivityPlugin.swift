import Foundation
import StationAgentActivityShared
import SwiftRs
import Tauri
import UIKit
import WebKit

// The app still deploys to iOS 14/15, where ActivityKit does not exist:
// weak-link it so the app launches there, and gate every use on iOS 18
// (broadcast channels), the floor for this feature.
@_weakLinked import ActivityKit

@available(iOS 16.1, *)
extension StationAgentActivityAttributes: ActivityAttributes {}

class ConfigureArgs: Decodable {
  let registrationId: String
  let stationId: String
  let stationKey: String
  let payloadKey: String
}

class ClearArgs: Decodable {
  let registrationId: String?
}

class PreviewArgs: Decodable {
  let registrationId: String
  let sealed: String
  let stationKey: String?
  let staleAfterSeconds: Double?
}

/// The WebView's handle on agent activity. Rendering does not go through
/// here: APNs starts and updates the Live Activity and the widget extension
/// opens the card, so this only registers identity, reports capability and
/// hands the Station the push-to-start token.
class AgentActivityPlugin: Plugin {
  private static let featureFloor = OperatingSystemVersion(majorVersion: 18, minorVersion: 0, patchVersion: 0)

  private var supported: Bool {
    ProcessInfo.processInfo.isOperatingSystemAtLeast(Self.featureFloor)
  }

  override func load(webview: WKWebView) {
    if #available(iOS 18.0, *) {
      LiveActivities.startDeduplicating()
    }
    #if DEBUG
      DebugPreview.runFromLaunchArguments()
    #endif
  }

  @objc public func status(_ invoke: Invoke) {
    var result: JsonObject = [
      "platform": "ios",
      "osVersion": UIDevice.current.systemVersion,
      "packageName": Bundle.main.bundleIdentifier ?? "",
      "liveActivitiesSupported": supported,
      "liveActivitiesEnabled": false,
      "frequentPushesEnabled": false,
      "pushConfigured": ApnsEnvironment.current != nil,
      // Local identity only: whether any Station still knows this phone is not known here.
      "configured": !RegistrationKeychain(accessGroup: nil).registrationIds().isEmpty,
    ]
    if let environment = ApnsEnvironment.current { result["apnsEnvironment"] = environment }
    if #available(iOS 18.0, *) {
      let info = ActivityAuthorizationInfo()
      result["liveActivitiesEnabled"] = info.areActivitiesEnabled
      result["frequentPushesEnabled"] = info.frequentPushesEnabled
    }
    invoke.resolve(result)
  }

  @objc public func configure(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(ConfigureArgs.self)
    guard
      let registration = AgentActivityRegistration.valid(
        id: args.registrationId,
        stationId: args.stationId,
        stationKey: args.stationKey,
        payloadKey: args.payloadKey)
    else {
      invoke.reject("registrationId, stationId, stationKey and payloadKey must be what the Station returned")
      return
    }
    guard let group = RegistrationKeychain.appSharedAccessGroup() else {
      invoke.reject("the keychain access group shared with the Live Activity is unavailable")
      return
    }
    do {
      try RegistrationKeychain(accessGroup: group).save(registration)
      invoke.resolve()
    } catch {
      invoke.reject("registration not stored", error: error)
    }
  }

  /// The user's opt-out: forget the registration (or all of them) and end
  /// its Live Activities now rather than leave a card no one updates.
  @objc public func clear(_ invoke: Invoke) throws {
    let registrationId = try invoke.parseArgs(ClearArgs.self).registrationId
    RegistrationKeychain(accessGroup: RegistrationKeychain.appSharedAccessGroup()).delete(registrationId)
    guard #available(iOS 18.0, *) else {
      invoke.resolve()
      return
    }
    Task {
      await LiveActivities.end(registrationId: registrationId)
      invoke.resolve()
    }
  }

  @objc public func pushToken(_ invoke: Invoke) {
    guard #available(iOS 18.0, *) else {
      invoke.resolve(["state": "unsupported"])
      return
    }
    guard let environment = ApnsEnvironment.current else {
      // Not an error: this build is not signed for push, so there is nothing
      // a Station could deliver to. The caller must not report push available.
      invoke.resolve(["state": "unconfigured"])
      return
    }
    Task {
      guard let token = await LiveActivities.pushToStartToken(timeout: 10) else {
        invoke.reject("push-to-start token unavailable")
        return
      }
      invoke.resolve([
        "state": "available",
        "token": token.map { String(format: "%02x", $0) }.joined(),
        "apnsEnvironment": environment,
      ])
    }
  }

  @objc public func openLiveUpdateSettings(_ invoke: Invoke) {
    DispatchQueue.main.async {
      guard let url = URL(string: UIApplication.openSettingsURLString) else {
        invoke.resolve(["opened": false])
        return
      }
      UIApplication.shared.open(url) { opened in
        invoke.resolve(["opened": opened])
      }
    }
  }

  /// Device verification only: starts a local Live Activity from a sealed
  /// card. Not in the plugin's default permission set, and a release build
  /// refuses it outright.
  @objc public func preview(_ invoke: Invoke) throws {
    #if DEBUG
      let args = try invoke.parseArgs(PreviewArgs.self)
      guard #available(iOS 18.0, *) else {
        invoke.reject("Live Activities need iOS 18")
        return
      }
      Task { @MainActor in
        do {
          try LiveActivities.startPreview(
            registrationId: args.registrationId,
            stationKey: args.stationKey,
            sealed: args.sealed,
            staleAfter: args.staleAfterSeconds ?? 3600)
          invoke.resolve()
        } catch {
          invoke.reject("preview not started", error: error)
        }
      }
    #else
      invoke.reject("preview is only available in debug builds")
    #endif
  }
}

/// Which APNs environment this build's `aps-environment` entitlement names.
/// Entitlements cannot be read back at runtime on iOS, so
/// scripts/ensure-ios-agent-activity-extension.mjs writes the entitlement
/// and Info.plist `StationApsEnvironment` from its one `--aps-environment`
/// argument. Absent means the build is not signed for push.
enum ApnsEnvironment {
  static var current: String? {
    switch Bundle.main.object(forInfoDictionaryKey: "StationApsEnvironment") as? String {
    case "production": return "production"
    case "development": return "sandbox"
    default: return nil
    }
  }
}

@available(iOS 18.0, *)
enum LiveActivities {
  typealias StationActivity = Activity<StationAgentActivityAttributes>

  /// APNs can start a second activity for a registration (a restart after
  /// the 8-hour cap, or a start racing an end). Keep only the newest per
  /// registration; this runs only while the app does.
  static func startDeduplicating() {
    Task {
      await endDuplicates(keeping: nil)
      for await activity in StationActivity.activityUpdates {
        await endDuplicates(keeping: activity)
      }
    }
  }

  private static func endDuplicates(keeping newest: StationActivity?) async {
    let byRegistration = Dictionary(grouping: StationActivity.activities) { $0.attributes.rid }
    for (_, activities) in byRegistration where activities.count > 1 {
      let keep =
        newest.flatMap { newest in activities.first { $0.id == newest.id } }
        ?? activities.max { ($0.content.staleDate ?? .distantPast) < ($1.content.staleDate ?? .distantPast) }
      for activity in activities where activity.id != keep?.id {
        await activity.end(nil, dismissalPolicy: .immediate)
      }
    }
  }

  static func end(registrationId: String?) async {
    for activity in StationActivity.activities
    where registrationId == nil || activity.attributes.rid == registrationId {
      await activity.end(nil, dismissalPolicy: .immediate)
    }
  }

  static func pushToStartToken(timeout seconds: Double) async -> Data? {
    if let token = StationActivity.pushToStartToken { return token }
    return await firstValue(timeout: seconds) { StationActivity.pushToStartTokenUpdates }
  }

  #if DEBUG
    @MainActor
    @discardableResult
    static func startPreview(registrationId: String, stationKey: String?, sealed: String, staleAfter: Double)
      throws -> StationActivity
    {
      let state = StationAgentActivityAttributes.ContentState(
        v: liveActivityStateVersion, rid: registrationId, sk: stationKey, sealed: sealed)
      return try StationActivity.request(
        attributes: StationAgentActivityAttributes(rid: registrationId),
        content: ActivityContent(state: state, staleDate: Date().addingTimeInterval(staleAfter)),
        pushType: nil)
    }
  #endif
}

#if DEBUG
  /// `simctl launch <device> <bundle> -StationAgentActivityPreview <case>`
  /// starts a local Live Activity once the app is active, so the widget can
  /// be checked on a simulator without a Station or APNs. The registration is
  /// NATIVE_PUSH_SEALED_TEST_VECTOR's (packages/contracts/src/native-push.ts).
  /// Cases: `kat` (renders), `bad-seal`, `bad-key` (placeholder), `stale`
  /// (goes stale 5 s in), `stale-past` (an update whose stale date has
  /// already passed, which is how a Station that stopped updating looks).
  /// ActivityKit does not show an activity requested with a past stale date,
  /// so `stale-past` starts fresh and then updates with one.
  enum DebugPreview {
    static let registrationId = "AAECAwQFBgcICQoLDA0ODw"
    static let payloadKey = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
    static let stationId = "11111111-1111-4111-8111-111111111111"
    static let stationKey = String(repeating: "K", count: 43)
    static let sealed =
      "AAECAwQFBgcICQoLPCCjaKCXnXLpY62pgNhJXLLntgXdSm5NCUrRtCxYLYowIZ_RnvAjqUWVTty5thkJzHVC-Cqywq5a83V4bMHPzMEE9krj4RZRLGSaXt-tIspZ6b0LAAZxUt-J7Lkd0pWvqpstj9IovGPBbFbTOxADRZgQA8KXrEv9Epk4v92HHn7JPXan2PXncWmCPMhLszi7aZiKW1BOo2i2fakHiqCGmPL7wmGvlrRe0wu42rns59Dk7qZN7MIdnBG6s7MtsfucdCXk2kytpusbdLKFziiv7ZUHpxdedNOHFM75qDQm-9h5AeWNygJiRiYuzmHBaCMw3OfcG-lZ5stICAgG5ehguzbg0Ly_uytKHqkbc85yX3Kq3bio89Tg21MVT2AyxIp7MTTseIr1_iewEBg7ZvDSp8ejP3xztv8nqAEtJqcNddn5pU8au1BI2ZPQSxBt4y1SoyrntKwktTh5k0hWvYF4z2kfyem1ZEL7EJ-UE6eFUhi0zS9J3sEi7b2EWLmuIwZGzPesvKU98Z3RAIwQSCF-p4xuCd_6RHD4H3GyIz-S5DR2Hi5J-fMXG9iYqDqa2NbJPAA9MnDsR4yJmZeI9d8_us1a4rLJPtFdqmqQdYyGxMFWrOh4YsInKEEUM74P"

    private static var observer: NSObjectProtocol?

    static func runFromLaunchArguments() {
      let arguments = ProcessInfo.processInfo.arguments
      guard let flag = arguments.firstIndex(of: "-StationAgentActivityPreview"),
        flag + 1 < arguments.count
      else { return }
      let preview = arguments[flag + 1]
      DispatchQueue.main.async {
        // ActivityKit only starts activities for a foreground app.
        observer = NotificationCenter.default.addObserver(
          forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main
        ) { _ in
          if let observer { NotificationCenter.default.removeObserver(observer) }
          observer = nil
          start(preview)
        }
        if UIApplication.shared.applicationState == .active {
          if let observer { NotificationCenter.default.removeObserver(observer) }
          observer = nil
          start(preview)
        }
      }
    }

    private static func start(_ preview: String) {
      guard #available(iOS 18.0, *) else { return }
      Task { @MainActor in
        let group = RegistrationKeychain.appSharedAccessGroup()
        NSLog("[agent-activity] preview \(preview) using keychain group \(group ?? "<none>")")
        guard let group,
          let registration = AgentActivityRegistration.valid(
            id: registrationId, stationId: stationId, stationKey: stationKey, payloadKey: payloadKey)
        else { return }
        do {
          try RegistrationKeychain(accessGroup: group).save(registration)
          await LiveActivities.end(registrationId: nil)
          var sealed = self.sealed
          var key: String? = stationKey
          var staleAfter = 3600.0
          switch preview {
          case "bad-seal":
            sealed = String(sealed.dropLast()) + (sealed.last == "P" ? "Q" : "P")
          case "bad-key":
            key = String(repeating: "J", count: 43)
          case "stale":
            staleAfter = 5
          case "stale-past":
            staleAfter = 2
          default:
            break
          }
          let activity = try LiveActivities.startPreview(
            registrationId: registrationId, stationKey: key, sealed: sealed, staleAfter: staleAfter)
          if preview == "stale-past" {
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            await activity.update(
              ActivityContent(state: activity.content.state, staleDate: Date(timeIntervalSinceNow: -1)))
          }
          NSLog("[agent-activity] preview \(preview) started")
        } catch {
          NSLog("[agent-activity] preview \(preview) failed: \(error)")
        }
      }
    }
  }
#endif

@_cdecl("init_plugin_station_agent_activity")
func initPlugin() -> Plugin {
  return AgentActivityPlugin()
}
