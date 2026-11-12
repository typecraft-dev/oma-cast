import AppKit
import CoreServices

/// The installed applications, as the entries core/MacCommands.appCandidate
/// takes: {id, name, path, keywords}. Rescans when an app folder changes.
@MainActor
final class AppIndex {
  /// `id` is unique per app; `bundleId` may repeat (Ghostty.app and Ghostty Dev.app share one).
  struct Entry: Encodable { var id: String; let bundleId: String; let name: String; let path: String; let keywords: [String] }

  /// Searched in order; the first bundle id found wins.
  nonisolated static var folders: [String] {
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    return [
      "/Applications", "/Applications/Utilities", "/System/Applications", "/System/Applications/Utilities",
      home + "/Applications", home + "/Applications/Chrome Apps.localized",
      "/System/Library/CoreServices/Applications"
    ]
  }

  var onChange: (([Entry]) -> Void)?
  private var stream: FSEventStreamRef?

  func start() {
    publish()
    watch()
  }

  private func publish() {
    DispatchQueue.global(qos: .userInitiated).async {
      let entries = AppIndex.scan()
      DispatchQueue.main.async { MainActor.assumeIsolated { self.onChange?(entries) } }
    }
  }

  nonisolated static func scan() -> [Entry] {
    var seen = Set<String>()
    var out: [Entry] = []
    let fm = FileManager.default
    func add(_ path: String) {
      guard let bundle = Bundle(path: path), let info = bundle.infoDictionary else { return }
      if (info["LSBackgroundOnly"] as? Bool) == true || (info["LSBackgroundOnly"] as? String) == "1" { return }
      // The same bundle reached twice (/Applications/Safari.app links to the
      // system copy) counts once; different bundles with one id both stay.
      let real = URL(fileURLWithPath: path).resolvingSymlinksInPath().path
      if !seen.insert(real).inserted { return }
      let id = bundle.bundleIdentifier ?? path
      let name = fm.displayName(atPath: path).replacingOccurrences(of: ".app", with: "")
      var keywords: [String] = []
      for candidate in [info["CFBundleName"] as? String, (path as NSString).lastPathComponent.replacingOccurrences(of: ".app", with: "")] {
        if let k = candidate, !k.isEmpty, k != name, !keywords.contains(k) { keywords.append(k) }
      }
      out.append(Entry(id: id, bundleId: id, name: name, path: path, keywords: keywords))
    }
    // The Finder lives outside every app folder.
    add("/System/Library/CoreServices/Finder.app")
    for folder in folders {
      guard let names = try? fm.contentsOfDirectory(atPath: folder) else { continue }
      for name in names.sorted() {
        let path = folder + "/" + name
        if name.hasSuffix(".app") { add(path); continue }
        // One level of plain folders, e.g. /Applications/Microsoft Office.
        var isDir: ObjCBool = false
        if !name.hasPrefix("."), fm.fileExists(atPath: path, isDirectory: &isDir), isDir.boolValue,
           let inner = try? fm.contentsOfDirectory(atPath: path) {
          for child in inner.sorted() where child.hasSuffix(".app") { add(path + "/" + child) }
        }
      }
    }
    // Apps that share a bundle id get ids from their paths, so search,
    // frecency and aliases tell them apart.
    var counts: [String: Int] = [:]
    for entry in out { counts[entry.bundleId.lowercased(), default: 0] += 1 }
    for i in out.indices where counts[out[i].bundleId.lowercased(), default: 0] > 1 {
      out[i].id = out[i].bundleId + "@" + out[i].path
    }
    return out
  }

  private func watch() {
    let paths = AppIndex.folders.filter { FileManager.default.fileExists(atPath: $0) } as CFArray
    var context = FSEventStreamContext(version: 0, info: Unmanaged.passUnretained(self).toOpaque(), retain: nil, release: nil, copyDescription: nil)
    let callback: FSEventStreamCallback = { _, info, _, _, _, _ in
      guard let info else { return }
      // Delivered on the main queue (FSEventStreamSetDispatchQueue below).
      MainActor.assumeIsolated { Unmanaged<AppIndex>.fromOpaque(info).takeUnretainedValue().publish() }
    }
    stream = FSEventStreamCreate(nil, callback, &context, paths, FSEventStreamEventId(kFSEventStreamEventIdSinceNow), 1.0,
                                 FSEventStreamCreateFlags(kFSEventStreamCreateFlagNone))
    if let stream {
      FSEventStreamSetDispatchQueue(stream, DispatchQueue.main)
      FSEventStreamStart(stream)
    }
  }
}

/// App icons by path, drawn once at row size.
@MainActor
enum IconCache {
  private static var cache: [String: NSImage] = [:]

  static func icon(_ path: String) -> NSImage {
    if let hit = cache[path] { return hit }
    // /Applications/Safari.app is a symlink; its own icon carries an alias badge.
    let image = NSWorkspace.shared.icon(forFile: URL(fileURLWithPath: path).resolvingSymlinksInPath().path)
    image.size = NSSize(width: 64, height: 64)
    cache[path] = image
    return image
  }
}
