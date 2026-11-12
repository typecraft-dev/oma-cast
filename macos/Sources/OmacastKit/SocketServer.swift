import Foundation

/// The CLI's way in (the macOS stand-in for omarchy-shell's IPC socket): a
/// Unix socket, mode 0600, one JSON request line {"fn": "...", "args": [...]}
/// and one reply line per connection.
final class SocketServer {
  let path: String
  private var fd: Int32 = -1
  private let handler: @MainActor (String, [String]) -> String

  init(path: String, handler: @escaping @MainActor (String, [String]) -> String) {
    self.path = path
    self.handler = handler
  }

  /// True when another omacast answers on the socket already.
  static func isServing(_ path: String) -> Bool {
    SocketServer.send(path, fn: "ping", args: []) == "ok"
  }

  func start() throws {
    guard path.utf8.count < MemoryLayout.size(ofValue: sockaddr_un().sun_path) else {
      throw NSError(domain: NSPOSIXErrorDomain, code: Int(ENAMETOOLONG), userInfo: [NSLocalizedDescriptionKey: "socket path too long: \(path)"])
    }
    unlink(path)
    fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { throw posixError("socket") }
    var addr = SocketServer.address(path)
    let old = umask(0o077)
    let bound = withUnsafePointer(to: &addr) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
    }
    umask(old)
    guard bound == 0 else { throw posixError("bind \(path)") }
    chmod(path, 0o600)
    guard listen(fd, 8) == 0 else { throw posixError("listen") }
    let thread = Thread { [weak self] in self?.acceptLoop() }
    thread.name = "omacast.socket"
    thread.start()
  }

  func stop() {
    if fd >= 0 { close(fd); fd = -1 }
    unlink(path)
  }

  private func acceptLoop() {
    while fd >= 0 {
      let client = accept(fd, nil, nil)
      if client < 0 { if errno == EINTR { continue } else { break } }
      // Only our own user may talk to us.
      var uid: uid_t = 0, gid: gid_t = 0
      if getpeereid(client, &uid, &gid) != 0 || uid != getuid() { close(client); continue }
      DispatchQueue.global().async { self.serve(client) }
    }
  }

  private func serve(_ client: Int32) {
    defer { close(client) }
    var timeout = timeval(tv_sec: 5, tv_usec: 0)
    setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
    guard let line = SocketServer.readLine(client) else { return }
    var reply = #"{"ok":false,"error":"bad request"}"#
    if let data = line.data(using: .utf8),
       let request = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
       let fn = request["fn"] as? String {
      let args = (request["args"] as? [Any] ?? []).map { "\($0)" }
      reply = DispatchQueue.main.sync { MainActor.assumeIsolated { handler(fn, args) } }
    }
    SocketServer.writeAll(client, reply + "\n")
  }

  // MARK: client side (used for the single-instance check)

  static func send(_ path: String, fn: String, args: [String], timeout seconds: Int = 2) -> String? {
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { return nil }
    defer { close(fd) }
    var addr = address(path)
    let connected = withUnsafePointer(to: &addr) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
    }
    guard connected == 0,
          let body = try? JSONSerialization.data(withJSONObject: ["fn": fn, "args": args]),
          let text = String(data: body, encoding: .utf8) else { return nil }
    var timeout = timeval(tv_sec: seconds, tv_usec: 0)
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
    writeAll(fd, text + "\n")
    return readAll(fd)
  }

  /// The reply may span lines (doctor); the server closes after it.
  private static func readAll(_ fd: Int32) -> String? {
    var buffer = [UInt8](repeating: 0, count: 65536)
    var out = [UInt8]()
    while true {
      let n = read(fd, &buffer, buffer.count)
      if n <= 0 { break }
      out.append(contentsOf: buffer[0..<n])
    }
    while out.last == 0x0A { out.removeLast() }
    return out.isEmpty ? nil : String(decoding: out, as: UTF8.self)
  }

  private static func address(_ path: String) -> sockaddr_un {
    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(path.utf8.prefix(MemoryLayout.size(ofValue: addr.sun_path) - 1))
    withUnsafeMutableBytes(of: &addr.sun_path) { raw in
      for (i, b) in bytes.enumerated() { raw[i] = b }
      raw[bytes.count] = 0
    }
    return addr
  }

  private static func readLine(_ fd: Int32) -> String? {
    var buffer = [UInt8]()
    var byte: UInt8 = 0
    while read(fd, &byte, 1) == 1 {
      if byte == 0x0A { break }
      buffer.append(byte)
      if buffer.count > 4 << 20 { return nil }
    }
    return buffer.isEmpty ? nil : String(decoding: buffer, as: UTF8.self)
  }

  private static func writeAll(_ fd: Int32, _ text: String) {
    let bytes = Array(text.utf8)
    var offset = 0
    while offset < bytes.count {
      let n = bytes[offset...].withUnsafeBufferPointer { write(fd, $0.baseAddress, $0.count) }
      if n <= 0 { return }
      offset += n
    }
  }

  private func posixError(_ what: String) -> NSError {
    NSError(domain: NSPOSIXErrorDomain, code: Int(errno), userInfo: [NSLocalizedDescriptionKey: "\(what): \(String(cString: strerror(errno)))"])
  }
}
