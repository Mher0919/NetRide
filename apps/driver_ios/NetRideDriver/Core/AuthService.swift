import Foundation
import Supabase

/// Mirrors AuthService in the driver Flutter app.
enum AuthService {
    static var isAuthenticated = false

    static func loginWithPassword(email: String, password: String, role: String = "DRIVER") async throws -> LoginResult {
        let res = try await APIClient.request("POST", "auth/login-password", body: [
            "email": email,
            "password": password,
            "app_role": role,
        ])
        let map = res as? [String: Any] ?? [:]
        let otpRequired = map["otp_required"] as? Bool ?? false
        if otpRequired {
            return .otpRequired(email: email)
        }
        guard let token = map["token"] as? String else {
            throw APIError.invalidData
        }
        let user = map["user"] as? [String: Any] ?? [:]
        SessionStore.shared.jwtToken = token
        SessionStore.shared.userId = user["id"] as? String
        SessionStore.shared.userRole = (user["role"] as? String) ?? role
        isAuthenticated = true
        let onboarding = map["onboarding"] as? [String: Any] ?? [:]
        let driver = onboarding["driver"] as? [String: Any] ?? [:]
        return .success(onboardingComplete: driver["onboarding_complete"] as? Bool ?? false)
    }

    static func signupWithPassword(email: String, fullName: String, password: String, role: String = "DRIVER") async throws -> SignupResult {
        let res = try await APIClient.request("POST", "auth/signup-password", body: [
            "email": email,
            "full_name": fullName,
            "password": password,
            "role": role,
        ])
        let map = res as? [String: Any] ?? [:]
        let otpRequired = map["otp_required"] as? Bool ?? false
        if otpRequired {
            return .otpRequired
        }
        if let token = map["token"] as? String {
            let user = map["user"] as? [String: Any] ?? [:]
            SessionStore.shared.jwtToken = token
            SessionStore.shared.userId = user["id"] as? String
            SessionStore.shared.userRole = (user["role"] as? String) ?? role
            isAuthenticated = true
            return .success
        }
        return .otpRequired
    }

    static func requestOTP(email: String) async throws {
        _ = try await APIClient.request("POST", "auth/request-otp", body: ["email": email])
    }

    static func verifyOTP(email: String, code: String, fullName: String? = nil, role: String = "DRIVER") async throws -> Bool {
        var body: [String: Any] = ["email": email, "code": code]
        if let fullName { body["full_name"] = fullName }
        body["role"] = role
        let res = try await APIClient.request("POST", "auth/verify-otp", body: body)
        let map = res as? [String: Any] ?? [:]
        guard let token = map["token"] as? String else {
            throw APIError.invalidData
        }
        let user = map["user"] as? [String: Any] ?? [:]
        SessionStore.shared.jwtToken = token
        SessionStore.shared.userId = user["id"] as? String
        SessionStore.shared.userRole = (user["role"] as? String) ?? role
        isAuthenticated = true
        return true
    }

    static func requestPhoneOTP(phone: String, role: String = "DRIVER") async throws -> Bool {
        let res = try await APIClient.request("POST", "auth/request-phone-otp", body: [
            "phone_number": phone,
            "role": role,
        ])
        let map = res as? [String: Any] ?? [:]
        return map["auto_verified"] as? Bool ?? false
    }

    static func verifyPhoneOTP(phone: String, code: String, role: String = "DRIVER") async throws {
        _ = try await APIClient.request("POST", "auth/verify-phone-otp", body: [
            "phone_number": phone,
            "code": code,
            "role": role,
        ])
    }

    static func forgotPassword(email: String) async throws {
        _ = try await APIClient.request("POST", "auth/forgot-password", body: ["email": email])
    }

    static func resetPassword(token: String, newPassword: String) async throws {
        _ = try await APIClient.request("POST", "auth/reset-password", body: [
            "token": token,
            "newPassword": newPassword,
        ])
    }

    static func requestPasswordChange(currentPassword: String) async throws {
        _ = try await APIClient.request("POST", "auth/request-password-change", body: ["currentPassword": currentPassword])
    }

    static func changePassword(currentPassword: String? = nil, newPassword: String) async throws {
        var body: [String: Any] = ["newPassword": newPassword]
        if let currentPassword { body["currentPassword"] = currentPassword }
        _ = try await APIClient.request("POST", "auth/change-password", body: body)
    }

    static func requestEmailChange(newEmail: String) async throws {
        _ = try await APIClient.request("POST", "user/request-email-change", body: ["newEmail": newEmail])
    }

    static func deleteAccount() async throws {
        _ = try await APIClient.request("DELETE", "auth/account")
        await logout()
    }

    static func deactivateAccount() async throws {
        _ = try await APIClient.request("POST", "auth/deactivate-account")
        await logout()
    }

    static func loginWithOAuth(
        email: String,
        fullName: String,
        profileImageUrl: String?,
        role: String = "DRIVER",
        token: String
    ) async throws -> [String: Any] {
        let body: [String: Any] = [
            "email": email,
            "full_name": fullName,
            "profile_image_url": profileImageUrl as Any,
            "role": role,
            "token": token,
        ]
        let res = try await APIClient.request("POST", "auth/oauth", body: body)
        let map = res as? [String: Any] ?? [:]
        guard let backendToken = map["token"] as? String else {
            throw APIError.invalidData
        }
        let user = map["user"] as? [String: Any] ?? [:]
        SessionStore.shared.jwtToken = backendToken
        SessionStore.shared.userId = user["id"] as? String
        SessionStore.shared.userRole = (user["role"] as? String) ?? role
        isAuthenticated = true
        return map
    }

    static func syncWithBackend() async -> Bool {
        do {
            let auth = SupabaseManager.shared.client.auth
            let session = try await auth.refreshSession()
            let user = session.user
            let meta = user.userMetadata
            let fullName = (meta["full_name"]?.stringValue)
                ?? (meta["name"]?.stringValue)
                ?? "NetRide Driver"
            let avatar = (meta["avatar_url"]?.stringValue) ?? (meta["picture"]?.stringValue)
            let accessToken = session.accessToken
            _ = try await loginWithOAuth(
                email: user.email ?? "",
                fullName: fullName,
                profileImageUrl: avatar,
                role: "DRIVER",
                token: accessToken
            )
            isAuthenticated = true
            return true
        } catch {
            return false
        }
    }

    static func isJwtExpired(_ token: String) -> Bool {
        let parts = token.split(separator: ".")
        guard parts.count == 3 else { return true }
        var payload = String(parts[1])
        let remainder = payload.count % 4
        if remainder > 0 { payload += String(repeating: "=", count: 4 - remainder) }
        guard let data = Data(base64Encoded: payload),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let exp = json["exp"] as? Double else {
            return true
        }
        return Date().addingTimeInterval(60) > Date(timeIntervalSince1970: exp)
    }

    static func isAuthenticatedNow() -> Bool {
        guard let token = SessionStore.shared.jwtToken, !token.isEmpty else { return false }
        return !isJwtExpired(token)
    }

    static func getAppName() async -> String {
        do {
            let res = try await APIClient.request("GET", "auth/config")
            let map = res as? [String: Any] ?? [:]
            return (map["app_name"] as? String) ?? "NetRide"
        } catch {
            return "NetRide"
        }
    }

    static func isDriverOnboardingComplete() async -> Bool {
        do {
            let res = try await APIClient.request("GET", "auth/onboarding-status")
            let map = res as? [String: Any] ?? [:]
            let driver = map["driver"] as? [String: Any] ?? [:]
            return driver["onboarding_complete"] as? Bool ?? false
        } catch {
            return false
        }
    }

    static func uploadImage(base64: String, mimetype: String, filename: String) async throws -> String {
        let res = try await APIClient.request("POST", "upload", uploadBase64: (base64, mimetype, filename))
        let map = res as? [String: Any] ?? [:]
        guard let url = map["url"] as? String else { throw APIError.invalidData }
        return url
    }

    static func logout() async {
        if let token = SessionStore.shared.jwtToken, NotificationService.shared.deviceToken != nil {
            _ = try? await APIClient.request("DELETE", "push/token", body: ["token": NotificationService.shared.deviceToken!])
        }
        try? await SupabaseManager.shared.client.auth.signOut()
        CacheService.shared.clearAll()
        SessionStore.shared.clearAuth()
        isAuthenticated = false
        NotificationCenter.default.post(name: .authStateChanged, object: nil)
    }
}

enum LoginResult {
    case success(onboardingComplete: Bool)
    case otpRequired(email: String)
}

enum SignupResult {
    case success
    case otpRequired
}

extension Notification.Name {
    static let authStateChanged = Notification.Name("authStateChanged")
    static let appForegrounded = Notification.Name("appForegrounded")
}