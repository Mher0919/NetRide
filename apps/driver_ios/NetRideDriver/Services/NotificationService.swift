import Foundation
import UserNotifications
import FirebaseCore
import FirebaseMessaging

/// Mirrors NotificationService in the driver app.
final class NotificationService: NSObject, UNUserNotificationCenterDelegate {
    static let shared = NotificationService()

    private(set) var deviceToken: String?
    private(set) var onTap: (([String: String]) -> Void)?
    private var hasConfiguredFirebase = false

    private override init() {
        super.init()
    }

    func initFirebase(onTap: @escaping ([String: String]) -> Void) {
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

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
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
        let map = data.mapValues { "\($0)" }
        onTap?(map)
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