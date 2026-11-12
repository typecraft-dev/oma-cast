import Foundation
import XCTest
@testable import OmacastKit

/// core/*.js inside JavaScriptCore must answer exactly as it does under node
/// (MACOS.md M1 accept).
@MainActor
final class EngineTests: XCTestCase {
  static let repo = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent().deletingLastPathComponent()

  var home: URL!
  var engine: JSEngine!

  override func setUpWithError() throws {
    home = FileManager.default.temporaryDirectory.appendingPathComponent("omacast-test-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
    engine = try JSEngine(native: Native(environment: ["HOME": home.path]), root: EngineTests.repo)
    let apps = #"[{"id":"org.mozilla.firefox","name":"Firefox","path":"/Applications/Firefox.app"},{"id":"com.apple.Safari","name":"Safari","path":"/Applications/Safari.app"},{"id":"com.apple.finder","name":"Finder","path":"/System/Library/CoreServices/Finder.app"}]"#
    engine.invoke("setApps", [apps])
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(at: home)
  }

  func data(_ json: String) -> Any? {
    let reply = JSON.object(json)
    XCTAssertEqual(reply["ok"] as? Bool, true, json)
    return reply["data"]
  }

  func testSearchFindsAppsAndCommands() {
    let sections = data(engine.call("rootSearch.search", #"{"query":"fir"}"#)) as? [[String: Any]] ?? []
    let first = (sections.first?["rows"] as? [[String: Any]])?.first
    XCTAssertEqual(first?["title"] as? String, "Firefox")
    let lock = data(engine.call("rootSearch.search", #"{"query":"lock"}"#)) as? [[String: Any]] ?? []
    let titles = lock.flatMap { ($0["rows"] as? [[String: Any]] ?? []).map { $0["title"] as? String ?? "" } }
    XCTAssertTrue(titles.contains("Lock Screen"))
  }

  func testCalculatorRunsInJavaScriptCore() {
    let calc = data(engine.call("calculator.calculate", #"{"query":"5 ft to cm"}"#)) as? [String: Any]
    XCTAssertEqual(calc?["result"] as? String, "152.4 cm")
  }

  func testStoresArePrivate() throws {
    let db = home.appendingPathComponent("Library/Application Support/omacast/db").path
    let mode = try FileManager.default.attributesOfItem(atPath: db)[.posixPermissions] as? NSNumber
    XCTAssertEqual(mode?.intValue, 0o700)
  }

  /// The same queries through node's require() and through JSC give the same sections.
  func testMatchesNode() throws {
    let node = ["/opt/homebrew/bin/node", "/usr/local/bin/node", ProcessInfo.processInfo.environment["NODE"] ?? ""]
      .first { !$0.isEmpty && FileManager.default.isExecutableFile(atPath: $0) }
      ?? (try? which("node"))
    guard let node else { throw XCTSkip("node not found") }
    let queries = ["fir", "saf", "sleep", "settings", "2+3", "f", "wifi", ""]
    let script = """
      const M = {}; for (const n of \(Sources.core.description)) M[n] = require(process.argv[1] + "/core/" + n + ".js"); for (const n of \(Sources.macos.description)) M[n] = require(process.argv[1] + "/macos/js/" + n + ".js")
      const App = require(process.argv[1] + "/macos/js/App.js")
      const fs = require("fs")
      const native = new Proxy({ env: (k) => k === "HOME" ? process.argv[2] : "", readFile: () => null, writeFile: () => "", mtime: () => 0,
        ensurePrivateDirs: () => "", zoneOffsets: () => ({}), hour12: () => false, later: () => 0, readClipboard: () => "", listDir: () => [] }, { get: (t, k) => t[k] || (() => "") })
      const app = App.create(native, M)
      app.setApps(process.argv[3])
      const out = JSON.parse(process.argv[4]).map((q) => JSON.parse(app.call("rootSearch.search", JSON.stringify({ query: q }))).data.map((s) => [s.id, s.rows.map((r) => r.id)]))
      process.stdout.write(JSON.stringify(out))
      """
    let apps = #"[{"id":"org.mozilla.firefox","name":"Firefox","path":"/Applications/Firefox.app"},{"id":"com.apple.Safari","name":"Safari","path":"/Applications/Safari.app"},{"id":"com.apple.finder","name":"Finder","path":"/System/Library/CoreServices/Finder.app"}]"#
    let queriesJSON = String(data: try JSONSerialization.data(withJSONObject: queries), encoding: .utf8)!
    let nodeHome = home.appendingPathComponent("node").path
    let process = Process()
    process.executableURL = URL(fileURLWithPath: node)
    process.arguments = ["-e", script, EngineTests.repo.path, nodeHome, apps, queriesJSON]
    let pipe = Pipe()
    process.standardOutput = pipe
    try process.run()
    let output = pipe.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    let fromNode = try JSONSerialization.jsonObject(with: output) as? [[Any]]

    var fromJSC: [[Any]] = []
    for q in queries {
      let body = String(data: try JSONSerialization.data(withJSONObject: ["query": q]), encoding: .utf8)!
      let sections = data(engine.call("rootSearch.search", body)) as? [[String: Any]] ?? []
      fromJSC.append(sections.map { [$0["id"] as? String ?? "", ($0["rows"] as? [[String: Any]] ?? []).map { $0["id"] as? String ?? "" }] })
    }
    XCTAssertEqual(NSArray(array: fromNode ?? []), NSArray(array: fromJSC))
  }

  private func which(_ name: String) throws -> String? {
    for dir in (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":") {
      let path = "\(dir)/\(name)"
      if FileManager.default.isExecutableFile(atPath: path) { return path }
    }
    return nil
  }

  func testHotkeySpecs() {
    XCTAssertEqual(Hotkey.Spec.parse("alt+space")?.display, "⌥ Space")
    XCTAssertEqual(Hotkey.Spec.parse("cmd+shift+k")?.display, "⇧⌘ K")
    XCTAssertNil(Hotkey.Spec.parse("space"))
    XCTAssertNil(Hotkey.Spec.parse("alt+nope"))
    XCTAssertNil(Hotkey.Spec.parse("cmd+q"), "⌘Q belongs to every app")
    XCTAssertNil(Hotkey.Spec.parse("command+W"))
    XCTAssertTrue(Hotkey.Spec.isReserved("shift+cmd+q"))
    XCTAssertNotNil(Hotkey.Spec.parse("cmd+space"))
  }
}
