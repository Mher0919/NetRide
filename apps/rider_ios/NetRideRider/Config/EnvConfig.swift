import Foundation

/// Loads environment values from the bundled `.env` file (mirrors flutter_dotenv).
enum EnvConfig {
    private static var loaded: [String: String] = [:]

    static func load(fileName: String = ".env") {
        guard let path = Bundle.main.path(forResource: fileName, ofType: nil),
              let content = try? String(contentsOfFile: path, encoding: .utf8) else {
            assertionFailure("[ENV] Missing .env in bundle")
            return
        }
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
        loaded = values
    }

    static func string(_ key: String, default defaultValue: String) -> String {
        loaded[key] ?? defaultValue
    }

    static var supabaseURL: String {
        string("SUPABASE_URL", default: "")
    }
    static var supabaseAnonKey: String {
        string("SUPABASE_ANON_KEY", default: "")
    }
    static var googleClientIDIOS: String {
        string("GOOGLE_CLIENT_ID_IOS", default: "your_ios_client_id")
    }
    static var apiBaseURL: String {
        string("API_BASE_URL", default: "https://netride.onrender.com")
    }

    /// Canonical API base URL with trailing `/api/` (mirrors ApiService.baseUrl).
    static var apiUrl: String {
        let base = apiBaseURL
        if base.hasSuffix("/") { return base + "api/" }
        return base + "/api/"
    }

    /// Socket base URL: the API base with everything from the first `/api` onward stripped.
    static var socketBaseUrl: String {
        let base = apiBaseURL
        if let idx = base.range(of: "/api")?.lowerBound {
            return String(base[..<idx])
        }
        return base
    }
}