import Foundation
@preconcurrency import JavaScriptCore

/// Where the JavaScript lives. The app bundle's Resources mirror the
/// checkout (core/*.js, macos/js/*.js), so one layout serves both;
/// OMACAST_SOURCE_DIR points tests or a debug run at a checkout.
public enum Sources {
  public static func root() -> URL? {
    if let dir = ProcessInfo.processInfo.environment["OMACAST_SOURCE_DIR"], !dir.isEmpty {
      return URL(fileURLWithPath: dir)
    }
    return Bundle.main.resourceURL
  }

  /// Shared modules in core/, then the macOS-only ones in macos/js/.
  public static let core = ["Rpc", "Paths", "Log", "Schema", "Migrate", "Ranker", "Frecency", "OmarchyMenu", "RootSearch", "Calculator", "Backend", "Store", "CalculatorData", "LauncherState"]
  public static let macos = ["MacCommands", "Themes"]

  static func url(_ root: URL, _ name: String) -> URL {
    root.appendingPathComponent(core.contains(name) ? "core/\(name).js" : "macos/js/\(name).js")
  }
}

public enum EngineError: Error, CustomStringConvertible {
  case missingSources
  case script(String)
  public var description: String {
    switch self {
    case .missingSources: return "cannot find core/*.js (set OMACAST_SOURCE_DIR)"
    case .script(let message): return message
    }
  }
}

/// One JSContext holding core/*.js and macos/js/App.js. Every call happens
/// on the main thread.
@MainActor
public final class JSEngine {
  public let context: JSContext
  public private(set) var app: JSValue!
  public var lastException: String?
  let native: Native

  public init(native: Native, root: URL? = Sources.root()) throws {
    guard let root else { throw EngineError.missingSources }
    self.native = native
    context = JSContext()!
    context.name = "omacast"
    context.exceptionHandler = { [weak self] _, exception in
      let message = exception?.toString() ?? "unknown error"
      let line = exception?.objectForKeyedSubscript("line")?.toString() ?? "?"
      let file = exception?.objectForKeyedSubscript("sourceURL")?.toString() ?? "?"
      self?.lastException = "\(message) (\(file):\(line))"
      Log.write("[omacast] [error] [js] \(message) at \(file):\(line)")
    }

    let modules = JSValue(newObjectIn: context)!
    for name in Sources.core + Sources.macos {
      modules.setObject(try load(Sources.url(root, name)), forKeyedSubscript: name as NSString)
    }
    let appModule = try load(root.appendingPathComponent("macos/js/App.js"))
    let nativeObject = native.install(in: context)
    guard let created = appModule.objectForKeyedSubscript("create")?.call(withArguments: [nativeObject, modules]),
          !created.isUndefined, lastException == nil else {
      throw EngineError.script(lastException ?? "App.create returned nothing")
    }
    app = created
  }

  /// Evaluates one CommonJS-style file in its own function scope, so the
  /// top-level names of different modules never collide.
  private func load(_ url: URL) throws -> JSValue {
    let source = try String(contentsOf: url, encoding: .utf8)
    let wrapped = "(function(module) {\n\(source)\n;return module.exports\n})({ exports: {} })"
    lastException = nil
    let value = context.evaluateScript(wrapped, withSourceURL: url)
    if let error = lastException { throw EngineError.script(error) }
    guard let value, value.isObject else { throw EngineError.script("\(url.lastPathComponent) exported nothing") }
    return value
  }

  @discardableResult
  public func invoke(_ method: String, _ args: [Any] = []) -> JSValue? {
    lastException = nil
    return app.invokeMethod(method, withArguments: args)
  }

  public func string(_ method: String, _ args: [Any] = []) -> String {
    guard let value = invoke(method, args), value.isString else { return "" }
    return value.toString()
  }

  /// RPC through the backend: {ok, data|error} as JSON.
  public func call(_ method: String, _ json: String) -> String {
    let reply = string("call", [method, json])
    return reply.isEmpty ? #"{"ok":false,"error":"\#(lastException ?? "no reply")"}"# : reply
  }
}
