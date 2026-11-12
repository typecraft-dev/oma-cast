import Foundation

/// Private file I/O (SPEC §2.0 "Privacy"): dirs 0700, store files 0600.
enum Files {
  static func read(_ path: String) -> String? {
    guard let data = FileManager.default.contents(atPath: path) else { return nil }
    return String(data: data, encoding: .utf8)
  }

  static func mtime(_ path: String) -> Double {
    guard let attrs = try? FileManager.default.attributesOfItem(atPath: path),
          let date = attrs[.modificationDate] as? Date else { return 0 }
    return date.timeIntervalSince1970 * 1000
  }

  /// Atomic write: a 0600 temp file in the same directory, then rename(2).
  /// An existing file is never left half-written or readable by others.
  static func writePrivate(_ path: String, _ text: String) -> String {
    let dir = (path as NSString).deletingLastPathComponent
    let temp = dir + "/." + (path as NSString).lastPathComponent + ".\(getpid()).tmp"
    let fd = open(temp, O_WRONLY | O_CREAT | O_TRUNC, 0o600)
    if fd < 0 { return String(cString: strerror(errno)) }
    let data = Array(text.utf8)
    var offset = 0
    while offset < data.count {
      let n = data[offset...].withUnsafeBufferPointer { write(fd, $0.baseAddress, $0.count) }
      if n <= 0 { let e = String(cString: strerror(errno)); close(fd); unlink(temp); return e }
      offset += n
    }
    fchmod(fd, 0o600)
    fsync(fd)
    close(fd)
    if rename(temp, path) != 0 { let e = String(cString: strerror(errno)); unlink(temp); return e }
    return ""
  }

  /// mkdir -p each dir owner-only.
  static func ensurePrivateDirs(_ dirs: [String]) -> String {
    var failures: [String] = []
    for dir in dirs {
      do {
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        chmod(dir, 0o700)
      } catch {
        failures.append("\(dir): \(error.localizedDescription)")
      }
    }
    return failures.joined(separator: "; ")
  }
}

/// Log lines go to ~/Library/Logs/omacast/omacast.log (0600) and stderr.
/// A file rather than os.Logger: `omacast log` tails it like `qs log` on
/// Omarchy, and the unified log would redact the details. [D]
public enum Log {
  static let path = FileManager.default.homeDirectoryForCurrentUser.path + "/Library/Logs/omacast/omacast.log"
  private static let queue = DispatchQueue(label: "omacast.log")
  private static let limit = 1 << 20

  public static func write(_ line: String) {
    let stamped = ISO8601DateFormatter().string(from: Date()) + " " + line + "\n"
    FileHandle.standardError.write(stamped.data(using: .utf8)!)
    queue.async {
      if Files.mtime(path) > 0, let size = (try? FileManager.default.attributesOfItem(atPath: path))?[.size] as? Int, size > limit {
        rename(path, path + ".1")
      }
      var fd = open(path, O_WRONLY | O_CREAT | O_APPEND, 0o600)
      if fd < 0 {
        // The first lines can come before App.js has made the folder.
        _ = Files.ensurePrivateDirs([(path as NSString).deletingLastPathComponent])
        fd = open(path, O_WRONLY | O_CREAT | O_APPEND, 0o600)
      }
      guard fd >= 0 else { return }
      let bytes = Array(stamped.utf8)
      _ = bytes.withUnsafeBufferPointer { Darwin.write(fd, $0.baseAddress, $0.count) }
      close(fd)
    }
  }
}
