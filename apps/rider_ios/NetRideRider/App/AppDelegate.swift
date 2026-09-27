import UIKit
import UserNotifications

class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        NotificationService.shared.initFirebase { notification in
            DispatchQueue.main.async {
                Self.routeFromNotification(notification)
            }
        }
        if let userInfo = launchOptions?[.remoteNotification] as? [AnyHashable: Any] {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                NotificationService.shared.didReceiveRemoteNotification(userInfo: userInfo)
            }
        }
        return true
    }

    func application(_ application: UIApplication,
                     didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationService.shared.didRegisterForRemoteNotifications(deviceToken: deviceToken)
    }

    func application(_ application: UIApplication,
                     didFailToRegisterForRemoteNotificationsWithError error: Error) {
        print("[PUSH] Failed to register for remote notifications: \(error)")
    }

    func application(_ application: UIApplication,
                     didReceiveRemoteNotification userInfo: [AnyHashable: Any],
                     fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void) {
        NotificationService.shared.didReceiveRemoteNotification(userInfo: userInfo)
        completionHandler(.newData)
    }

    func application(_ app: UIApplication, open url: URL,
                     options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        DeepLinkHandler.handle(url)
        return true
    }

    static func routeFromNotification(_ notification: NetRideNotification) {
        let router = AppRouter.shared
        if notification.type == "special_reward_ready" {
            router.push(.specialRedemption(
                code: notification.data["code"],
                redemptionId: notification.data["redemptionId"]
            ))
            return
        }
        switch notification.route {
        case "/trip":
            router.push(.trip)
        case "/credits":
            router.push(.credits)
        default:
            break
        }
    }
}

/// Mirrors the deep-link handling in main.dart.
enum DeepLinkHandler {
    static func handle(_ url: URL) {
        if url.host == "password-reset" || url.path.contains("password-reset") {
            if let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
               let token = components.queryItems?.first(where: { $0.name == "token" })?.value {
                AppRouter.shared.push(.resetPassword(token: token))
            }
        }
    }
}