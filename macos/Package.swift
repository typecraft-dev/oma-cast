// swift-tools-version:5.9
// omacast for macOS (MACOS.md). Build the app bundle with macos/bin/build-app.
import PackageDescription

let package = Package(
  name: "omacast",
  platforms: [.macOS(.v14)],
  targets: [
    .target(
      name: "OmacastKit",
      path: "Sources/OmacastKit",
      linkerSettings: [.linkedFramework("Carbon"), .linkedFramework("JavaScriptCore"), .linkedFramework("ServiceManagement")]
    ),
    .executableTarget(name: "omacast", dependencies: ["OmacastKit"], path: "Sources/omacast"),
    .testTarget(name: "OmacastKitTests", dependencies: ["OmacastKit"], path: "Tests/OmacastKitTests")
  ]
)
