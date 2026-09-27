import Foundation

/// Mirrors search_result.dart.
struct SearchResult: Identifiable {
    var id = UUID()
    var displayName: String
    var lat: Double
    var lon: Double
    var state: String
    var distanceMiles: Double?
    var type: String
    var isSuggestion: Bool
    var formattedAddress: String?
    var street: String?
    var city: String?
    var zip: String?
    var category: String?
    var subcategory: String?

    var hasValidCoordinates: Bool { lat != 0 || lon != 0 }

    /// distance_miles * 2.0 — 30 mph urban assumption.
    var etaMinutes: Double? {
        guard let distanceMiles else { return nil }
        return distanceMiles * 2.0
    }

    init(json: Any?) {
        let map = json as? [String: Any] ?? [:]
        self.displayName = (map["display_name"] as? String) ?? (map["name"] as? String) ?? ""
        self.lat = (map["lat"] as? Double) ?? (map["lat"] as? NSNumber)?.doubleValue ?? 0
        self.lon = (map["lon"] as? Double) ?? (map["lng"] as? Double) ?? (map["lon"] as? NSNumber)?.doubleValue ?? (map["lng"] as? NSNumber)?.doubleValue ?? 0
        self.state = (map["state"] as? String) ?? "CA"
        self.distanceMiles = (map["distance_miles"] as? Double) ?? (map["distance"] as? Double)
        self.type = (map["type"] as? String) ?? (map["category"] as? String) ?? "poi"
        self.isSuggestion = map["is_suggestion"] as? Bool ?? false
        self.formattedAddress = map["formatted_address"] as? String
        self.street = map["street"] as? String
        self.city = map["city"] as? String
        self.zip = map["zip"] as? String
        self.category = map["category"] as? String
        self.subcategory = map["subcategory"] as? String
    }

    /// JSON used when saving search history.
    var historyPayload: [String: Any] {
        var dict: [String: Any] = [
            "displayName": displayName,
            "lat": lat,
            "lon": lon,
            "state": state,
            "type": type,
        ]
        if let distanceMiles { dict["distance"] = distanceMiles }
        if let formattedAddress { dict["formatted_address"] = formattedAddress }
        if let street { dict["street"] = street }
        if let city { dict["city"] = city }
        if let zip { dict["zip"] = zip }
        if let category { dict["category"] = category }
        if let subcategory { dict["subcategory"] = subcategory }
        return dict
    }
}