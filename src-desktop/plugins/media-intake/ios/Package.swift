// swift-tools-version:5.9
import PackageDescription
let package = Package(
  name: "tauri-plugin-station-media-intake",
  platforms: [.iOS(.v14)],
  products: [.library(name: "tauri-plugin-station-media-intake", type: .static, targets: ["tauri-plugin-station-media-intake"])],
  dependencies: [.package(name: "Tauri", path: "../.tauri/tauri-api")],
  targets: [.target(name: "tauri-plugin-station-media-intake", dependencies: [.byName(name: "Tauri")], path: "Sources")]
)
