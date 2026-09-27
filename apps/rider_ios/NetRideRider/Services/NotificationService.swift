import Foundation
import UserNotifications
import FirebaseCore
import FirebaseMessaging

/// Mirrors NotificationService in the rider app: FCM token registry + in-app notifications.
/// Degrades gracefully when Firebase is not configured.
final class NotificationService: NSObject, UNUserNotificationCenterDelegate {
    static let shared = NotificationService()

    private(set) var deviceToken: String?
    private(set) var onTap: ((NetRideNotification) -> Void)?
    private var hasConfiguredFirebase = false

    private override init() {
        super.init()
    }

    func initFirebase(onTap: @escaping (NetRideNotification) -> Void) {
        self.onTap = onTap
        let center = UNUserNotificationCenter.current()
        center.delegate = self

        let hasPlist = Bundle.main.path(forResource: "GoogleService-Info", ofType: "plist") != nil
        if hasPlist {
            FirebaseApp.configure()
            Messaging.messaging().delegate = self
            hasConfiguredFirebase = true
        }

        center.requestAuthorization(options: [.alert, .badge, .sound]) { _, _ in
            DispatchQueue.main.async {
                UIApplication.shared.registerForRemoteNotifications()
            }
        }
    }

    func registerDevice(token: String? = nil) {
        let tok = token ?? deviceToken
        guard let tok, SessionStore.shared.jwtToken != nil else { return }
        Task {
            _ = try? await APIClient.request("POST", "push/register-token", body: [
                "token": tok,
                "platform": "ios",
            ])
        }
    }

    func clearDevice() {
        guard let token = deviceToken else { return }
        Task {
            _ = try? await APIClient.request("DELETE", "push/token", body: ["token": token])
        }
    }

    // MARK: - Remote token plumbing (wired from AppDelegate)

    func didRegisterForRemoteNotifications(deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02.2hhx", $0) }.joined()
        if hasConfiguredFirebase {
            Messaging.messaging().apnsToken = deviceToken
            if let fcm = Messaging.messaging().fcmToken {
                self.deviceToken = fcm
                registerDevice(token: fcm)
            }
        } else {
            self.deviceToken = token
            registerDevice(token: token)
        }
    }

    func didReceiveRemoteNotification(userInfo: [AnyHashable: Any]) {
        if let data = userInfo["data"] as? [String: Any] {
            handleTap(data: data)
        }
    }

    func didReceiveRegistrationToken(fcmToken: String) {
        deviceToken = fcmToken
        registerDevice(token: fcmToken)
    }

    // MARK: - UNUserNotificationCenterDelegate

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        // Foreground: system tray owns display; pass through.
        completionHandler([.banner, .sound, .badge])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        if let data = response.notification.request.content.userInfo["data"] as? [String: Any] {
            handleTap(data: data)
        }
        completionHandler()
    }

    private func handleTap(data: [String: Any]) {
        var map = data
        map["type"] = map["type"] ?? ""
        map["title"] = map["title"] ?? ""
        map["body"] = map["body"] ?? ""
        map["route"] = map["route"] ?? "/"
        onTap?(NetRideNotification(json: map))
    }

    // MARK: - In-app notification history

    func fetchNotifications(limit: Int = 50) async throws -> [NetRideNotification] {
        let res = try await APIClient.request("GET", "notifications", query: ["limit": "\(limit)"])
        let map = res as? [String: Any] ?? [:]
        let arr = map["notifications"] as? [[String: Any]] ?? []
        return arr.map { NetRideNotification(json: $0) }
    }

    func unreadCount() async throws -> Int {
        let res = try await APIClient.request("GET", "notifications/unread-count")
        let map = res as? [String: Any] ?? [:]
        return map["count"] as? Int ?? 0
    }

    func markRead(ids: [String]) async throws {
        _ = try await APIClient.request("POST", "notifications/read", body: ["ids": ids])
    }

    func markRead(id: String) async throws {
        _ = try await APIClient.request("POST", "notifications/read", body: ["id": id])
    }
}

extension NotificationService: MessagingDelegate {
    func messaging(_ messaging: Messaging, didReceiveRegistrationToken fcmToken: String?) {
        if let fcmToken {
            deviceToken = fcmToken
            registerDevice(token: fcmToken)
        }
    }
}