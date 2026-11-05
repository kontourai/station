// swift-tools-version:5.9
import PackageDescription
let package = Package(
  name: "tauri-plugin-station-fold",
  platforms: [.iOS(.v14)],
  products: [.library(name: "tauri-plugin-station-fold", type: .static, targets: ["tauri-plugin-station-fold"])],
  dependencies: [.package(name: "Tauri", path: "../.tauri/tauri-api")],
  targets: [.target(name: "tauri-plugin-station-fold", dependencies: [.byName(name: "Tauri")], path: "Sources")]
)
