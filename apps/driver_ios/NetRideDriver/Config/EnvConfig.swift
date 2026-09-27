import Foundation

/// Loads environment values from the bundled env file (mirrors flutter_dotenv).
///
/// OneDrive famously renames dotfiles (`.env` → `env`) when syncing to macOS, and
/// Xcode's "Copy Bundle Resources" build phase silently drops hidden dotfiles, so
/// the loader searches several candidate resource names in order.
enum EnvConfig {
    private static var loaded: [String: String] = [:]

    /// Candidate resource names to try, in order. The leading-dot `.env` is checked
    /// last because Xcode often fails to copy it into the bundle.
    private static let candidateNames = ["env", "NetRide.env", "netride.env", ".env"]

    static func load(fileName: String? = nil) {
        var content: String? = nil
        var usedName: String? = nil

        var names = candidateNames
        if let fileName, !candidateNames.contains(fileName) {
            names.insert(fileName, at: 0)
        }

        for name in names {
            if let path = Bundle.main.path(forResource: name, ofType: nil),
               let text = try? String(contentsOfFile: path, encoding: .utf8),
               !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                content = text
                usedName = name
                break
            }
        }

        if let content {
            loaded = parse(content)
            print("[ENV] Loaded \(content.count) bytes from bundled file '\(usedName ?? "?")'")
        } else {
            // Fallback 1: environment variables injected via the Xcode scheme.
            var env: [String: String] = [:]
            for key in ["SUPABASE_URL", "SUPABASE_ANON_KEY", "GOOGLE_CLIENT_ID_IOS", "GOOGLE_CLIENT_ID_WEB", "API_BASE_URL"] {
                if let value = ProcessInfo.processInfo.environment[key] {
                    env[key] = value
                }
            }
            if !env.isEmpty {
                loaded = env
                print("[ENV] Loaded values from Xcode scheme environment variables.")
                return
            }
            // Fallback 2: Info.plist keys.
            var plist: [String: String] = [:]
            if let dict = Bundle.main.infoDictionary {
                for key in ["SUPABASE_URL", "SUPABASE_ANON_KEY", "GOOGLE_CLIENT_ID_IOS", "GOOGLE_CLIENT_ID_WEB", "API_BASE_URL"] {
                    if let value = dict[key] as? String {
                        plist[key] = value
                    }
                }
            }
            if !plist.isEmpty {
                loaded = plist
                print("[ENV] Loaded values from Info.plist.")
                return
            }
            print("[ENV] ⚠️ No env file or fallback values found. Using defaults.")
            loaded = [:]
        }
    }

    private static func parse(_ content: String) -> [String: String] {
        var values: [String: String] = [:]
        for rawLine in content.split(separator: "\n") {
            let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
            if line.isEmpty || line.hasPrefix("#") { continue }
            let parts = line.split(separator: "=", maxSplits: 1)
            guard parts.count == 2 else { continue }
            let key = parts[0].trimmingCharacters(in: .whitespaces)
            var value = parts[1].trimmingCharacters(in: .whitespaces)
            if value.hasPrefix("\"") && value.hasSuffix("\"") && value.count >= 2 {
                value = String(value.dropFirst().dropLast())
            }
            values[key] = value
        }
        return values
    }

    static func string(_ key: String, default defaultValue: String) -> String {
        loaded[key] ?? defaultValue
    }

    static var supabaseURL: String { string("SUPABASE_URL", default: "") }
    static var supabaseAnonKey: String { string("SUPABASE_ANON_KEY", default: "") }
    static var googleClientIDIOS: String { string("GOOGLE_CLIENT_ID_IOS", default: "your_ios_client_id") }
    static var apiBaseURL: String { string("API_BASE_URL", default: "https://netride.onrender.com") }

    static var apiUrl: String {
        let base = apiBaseURL
        if base.hasSuffix("/") { return base + "api/" }
        return base + "/api/"
    }

    static var socketBaseUrl: String {
        let base = apiBaseURL
        if let idx = base.range(of: "/api")?.lowerBound {
            return String(base[..<idx])
        }
        return base
    }
}