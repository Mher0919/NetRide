import Foundation

/// Mirrors the notification models in the rider app.
struct NetRideNotification: Identifiable {
    var id: String
    var type: String
    var title: String
    var body: String
    var createdAt: Date?
    var readAt: Date?
    var data: [String: String]
    var route: String?

    init(json: Any?) {
        let map = json as? [String: Any] ?? [:]
        self.id = (map["id"] as? String) ?? UUID().uuidString
        self.type = (map["type"] as? String) ?? ""
        self.title = (map["title"] as? String) ?? ""
        self.body = (map["body"] as? String) ?? ""
        if let s = map["created_at"] as? String { self.createdAt = ISO8601DateFormatter().date(from: s) }
        if let s = map["read_at"] as? String { self.readAt = ISO8601DateFormatter().date(from: s) }
        if let raw = map["data"] as? [String: Any] {
            self.data = raw.mapValues { "\($0)" }
        } else if let raw = map["data"] as? [String: String] {
            self.data = raw
        } else {
            self.data = [:]
        }
        self.route = self.data["route"] ?? (map["route"] as? String)
    }

    var isRead: Bool { readAt != nil }
}

/// A ride-intent that the map screen consumes (special rides).
struct RideIntent {
    var sponsorId: String?
    var sponsorName: String?
    var discountLabel: String?
    var destinationLat: Double?
    var destinationLng: Double?
    var redemptionId: String?
}