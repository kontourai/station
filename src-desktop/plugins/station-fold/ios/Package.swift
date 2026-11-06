// swift-tools-version:5.9

import Foundation
import PackageDescription

// `build.rs` builds this package through swift-rs for the iOS app, which needs
// the plugin target and the Tauri iOS API it copies to ../.tauri. Neither
// builds for macOS (both import UIKit), so the host test run of the
// UIKit-free core sets STATION_FOLD_HOST_TESTS=1 and gets only that target:
//
//   STATION_FOLD_HOST_TESTS=1 swift test
let hostTestsOnly = ProcessInfo.processInfo.environment["STATION_FOLD_HOST_TESTS"] == "1"

var products: [Product] = []
var dependencies: [Package.Dependency] = []
var targets: [Target] = [
  // Foundation only: snapshots, revisions and what `state` answers.
  .target(name: "StationFoldCore", path: "Sources/StationFoldCore"),
  .testTarget(
    name: "StationFoldCoreTests",
    dependencies: ["StationFoldCore"],
    path: "Tests/StationFoldCoreTests"),
]

if !hostTestsOnly {
  products.append(
    .library(
      name: "tauri-plugin-station-fold",
      type: .static,
      targets: ["tauri-plugin-station-fold", "StationFoldCore"]))
  dependencies.append(.package(name: "Tauri", path: "../.tauri/tauri-api"))
  targets.append(
    .target(
      name: "tauri-plugin-station-fold",
      dependencies: [.byName(name: "Tauri"), "StationFoldCore"],
      path: "Sources/StationFoldPlugin"))
}

let package = Package(
  name: "tauri-plugin-station-fold",
  platforms: [
    .iOS(.v14),
    .macOS(.v12),
  ],
  products: products,
  dependencies: dependencies,
  targets: targets
)
