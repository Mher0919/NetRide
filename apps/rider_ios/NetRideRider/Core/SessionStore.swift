import Foundation

/// Central session store mirroring SharedPreferences keys used by the Flutter app.
final class SessionStore {
    static let shared = SessionStore()
    private let defaults = UserDefaults.standard

    static let jwtTokenKey = "jwt_token"
    static let userIdKey = "user_id"
    static let userRoleKey = "user_role"
    static let soundEnabledKey = "sound_enabled"
    static let activeTripIdKey = "active_trip_id"
    static let onboardingPhoneStepKey = "onboarding_phone_step"
    static let installIdKey = "netride_install_id"
    static let voiceMutedKey = "voice_muted"
    static let deviceIdKey = "device_id"

    private init() {}

    var jwtToken: String? {
        get { defaults.string(forKey: Self.jwtTokenKey) }
        set { defaults.set(newValue, forKey: Self.jwtTokenKey) }
    }
    var userId: String? {
        get { defaults.string(forKey: Self.userIdKey) }
        set { defaults.set(newValue, forKey: Self.userIdKey) }
    }
    var userRole: String? {
        get { defaults.string(forKey: Self.userRoleKey) }
        set { defaults.set(newValue, forKey: Self.userRoleKey) }
    }
    var soundEnabled: Bool {
        get { defaults.object(forKey: Self.soundEnabledKey) as? Bool ?? true }
        set { defaults.set(newValue, forKey: Self.soundEnabledKey) }
    }
    var voiceMuted: Bool {
        get { defaults.object(forKey: Self.voiceMutedKey) as? Bool ?? false }
        set { defaults.set(newValue, forKey: Self.voiceMutedKey) }
    }
    var activeTripId: String? {
        get { defaults.string(forKey: Self.activeTripIdKey) }
        set { defaults.set(newValue, forKey: Self.activeTripIdKey) }
    }

    /// 32-char hex install id, generated once (mirrors DeviceIdentity).
    var installId: String {
        if let existing = defaults.string(forKey: Self.installIdKey) { return existing }
        var bytes = [UInt8](repeating: 0, count: 16)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        let value: String
        if status == errSecSuccess {
            value = bytes.map { String(format: "%02x", $0) }.joined()
        } else {
            value = UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(32).description
        }
        defaults.set(value, forKey: Self.installIdKey)
        return value
    }

    /// Stable per-install UUID device id (mirrors DeviceFingerprint for driver app).
    var deviceId: String {
        if let existing = defaults.string(forKey: Self.deviceIdKey) { return existing }
        let value = UUID().uuidString
        defaults.set(value, forKey: Self.deviceIdKey)
        return value
    }

    func clearAuth() {
        defaults.removeObject(forKey: Self.jwtTokenKey)
        defaults.removeObject(forKey: Self.userIdKey)
        defaults.removeObject(forKey: Self.userRoleKey)
    }

    func setString(_ value: String?, forKey key: String) {
        defaults.set(value, forKey: key)
    }

    func string(forKey key: String) -> String? {
        defaults.string(forKey: key)
    }

    func clearAll() {
        defaults.removePersistentDomain(forName: Bundle.main.bundleIdentifier ?? "")
    }
}