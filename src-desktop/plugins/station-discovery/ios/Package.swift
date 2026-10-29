// swift-tools-version:5.9
import PackageDescription
let package = Package(
  name: "tauri-plugin-station-discovery",
  platforms: [.iOS(.v14)],
  products: [.library(name: "tauri-plugin-station-discovery", type: .static, targets: ["tauri-plugin-station-discovery"])],
  dependencies: [.package(name: "Tauri", path: "../.tauri/tauri-api")],
  targets: [.target(name: "tauri-plugin-station-discovery", dependencies: [.byName(name: "Tauri")], path: "Sources")]
)
