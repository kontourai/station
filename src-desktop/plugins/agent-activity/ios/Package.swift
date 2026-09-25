// swift-tools-version:5.9

import Foundation
import PackageDescription

// `build.rs` builds this package through swift-rs for the iOS app, which
// needs the plugin target and the Tauri iOS API it copies to ../.tauri.
// Neither builds for macOS (both import UIKit), so the host `swift test` run
// of the shared card code sets STATION_AGENT_ACTIVITY_HOST_TESTS=1 and gets
// only the shared target and its tests:
//
//   STATION_AGENT_ACTIVITY_HOST_TESTS=1 swift test
let hostTestsOnly = ProcessInfo.processInfo.environment["STATION_AGENT_ACTIVITY_HOST_TESTS"] == "1"

var products: [Product] = []
var dependencies: [Package.Dependency] = []
var targets: [Target] = [
  // CryptoKit and Security only: the widget extension compiles these same
  // sources, so nothing here may depend on UIKit, ActivityKit or Tauri.
  .target(
    name: "StationAgentActivityShared",
    path: "Sources/StationAgentActivityShared"),
  .testTarget(
    name: "StationAgentActivitySharedTests",
    dependencies: ["StationAgentActivityShared"],
    path: "Tests/StationAgentActivitySharedTests"),
  // The app's APNs device token for alert pushes (#2589): Foundation and the
  // Objective-C runtime only, so it is tested on macOS too. App-only: the
  // widget extension does not compile it.
  .target(
    name: "StationAgentActivityAlerts",
    dependencies: ["StationAgentActivityShared"],
    path: "Sources/StationAgentActivityAlerts"),
  .testTarget(
    name: "StationAgentActivityAlertsTests",
    dependencies: ["StationAgentActivityAlerts", "StationAgentActivityShared"],
    path: "Tests/StationAgentActivityAlertsTests"),
]

if !hostTestsOnly {
  products.append(
    .library(
      name: "tauri-plugin-station-agent-activity",
      type: .static,
      targets: [
        "tauri-plugin-station-agent-activity", "StationAgentActivityShared", "StationAgentActivityAlerts",
      ]))
  dependencies.append(.package(name: "Tauri", path: "../.tauri/tauri-api"))
  targets.append(
    .target(
      name: "tauri-plugin-station-agent-activity",
      dependencies: [.byName(name: "Tauri"), "StationAgentActivityShared", "StationAgentActivityAlerts"],
      path: "Sources/StationAgentActivityPlugin"))
}

let package = Package(
  name: "tauri-plugin-station-agent-activity",
  platforms: [
    .iOS(.v13),
    .macOS(.v10_15),
  ],
  products: products,
  dependencies: dependencies,
  targets: targets
)
