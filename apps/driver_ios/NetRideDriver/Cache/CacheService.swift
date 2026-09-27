import Foundation

/// Cache policies (mirrors cache_policy.dart in the driver app).
enum CachePolicy {
    static let profile = CachePolicyEntry(stale: 5 * 60, ttl: 30 * 60, persist: true)
    static let profilePicture = CachePolicyEntry(stale: 15 * 60, ttl: 2 * 3600, persist: true)
    static let vehicle = CachePolicyEntry(stale: 5 * 60, ttl: 3600, persist: true)
    static let license = CachePolicyEntry(stale: 5 * 60, ttl: 3600, persist: true)
    static let verificationStatus = CachePolicyEntry(stale: 30, ttl: 5 * 60, persist: false)
    static let documentRequirements = CachePolicyEntry(stale: 15, ttl: 2 * 60, persist: false)
    static let vehicleSubmission = CachePolicyEntry(stale: 30, ttl: 5 * 60, persist: false)
    static let eligibility = CachePolicyEntry(stale: 30, ttl: 3 * 60, persist: false)
    static let profileChange = CachePolicyEntry(stale: 15, ttl: 2 * 60, persist: false)
    static let wallet = CachePolicyEntry(stale: 30, ttl: 5 * 60, persist: false)
    static let payouts = CachePolicyEntry(stale: 60, ttl: 10 * 60, persist: false)
    static let operational = CachePolicyEntry(stale: 0, ttl: 0, persist: false)
}

struct CachePolicyEntry {
    var stale: TimeInterval
    var ttl: TimeInterval
    var persist: Bool
}

/// Cache keys (mirrors cache_keys.dart in the driver app).
enum CacheKeys {
    static func profile(_ id: String) -> String { "profile:driver:\(id)" }
    static func profilePicture(_ id: String) -> String { "profile:picture:\(id)" }
    static func vehicle(_ id: String) -> String { "vehicle:active:\(id)" }
    static func license(_ id: String) -> String { "license:driver:\(id)" }
    static func verificationStatus(_ id: String) -> String { "status:verification:\(id)" }
    static func documentRequirements(_ id: String) -> String { "documents:requirements:\(id)" }
    static func vehicleSubmission(_ id: String) -> String { "vehicle:submissions:\(id)" }
    static func eligibility(_ id: String) -> String { "status:eligibility:\(id)" }
    static func profileChange(_ id: String) -> String { "profile:change:\(id)" }
    static func walletPayoutCard(_ id: String) -> String { "wallet:payout_card:\(id)" }
    static func walletBalance(_ id: String) -> String { "wallet:balance:\(id)" }
    static func walletPayouts(_ id: String) -> String { "wallet:payouts:\(id)" }

    static func allKeysForUser(_ id: String) -> [String] {
        [profile(id), profilePicture(id), vehicle(id), license(id),
         verificationStatus(id), documentRequirements(id), vehicleSubmission(id),
         eligibility(id), profileChange(id), walletPayoutCard(id), walletBalance(id), walletPayouts(id)]
    }
}

enum Staleness {
    case fresh, stale, expired
}

/// L1 memory + L2 disk cache (mirrors cache_service.dart).
final class CacheService {
    static let shared = CacheService()

    private struct Entry {
        var value: Any
        var cachedAt: Date
        var policy: CachePolicyEntry
    }

    private var l1: [String: Entry] = [:]
    private let queue = DispatchQueue(label: "netride.cache")
    private var defaults: UserDefaults?

    private init() {}

    func initCache(prefs: UserDefaults) {
        defaults = prefs
    }

    private func policyName(_ policy: CachePolicyEntry) -> Int {
        if policy === CachePolicy.profile { return 0 }
        if policy === CachePolicy.profilePicture { return 1 }
        if policy === CachePolicy.vehicle { return 2 }
        if policy === CachePolicy.license { return 3 }
        if policy === CachePolicy.verificationStatus { return 4 }
        if policy === CachePolicy.documentRequirements { return 5 }
        if policy === CachePolicy.vehicleSubmission { return 6 }
        if policy === CachePolicy.eligibility { return 7 }
        if policy === CachePolicy.profileChange { return 8 }
        if policy === CachePolicy.wallet { return 9 }
        if policy === CachePolicy.payouts { return 10 }
        return 11
    }

    func staleness(_ key: String) -> Staleness {
        queue.sync {
            guard let entry = l1[key] else { return .expired }
            let age = Date().timeIntervalSince(entry.cachedAt)
            if age > entry.policy.ttl { return .expired }
            if age > entry.policy.stale { return .stale }
            return .fresh
        }
    }

    func get(_ key: String) -> Any? {
        queue.sync {
            if let entry = l1[key], Date().timeIntervalSince(entry.cachedAt) <= entry.policy.ttl {
                return entry.value
            }
            // Disk hydrate
            guard let defaults, let raw = defaults.dictionary(forKey: "cache:\(key)") else { return nil }
            let cachedAt = (raw["t"] as? Date) ?? Date()
            let policyIndex = (raw["p"] as? Int) ?? 11
            let entry = Entry(value: raw["v"] as Any, cachedAt: cachedAt, policy: policyFromIndex(policyIndex))
            if Date().timeIntervalSince(cachedAt) > entry.policy.ttl {
                defaults.removeObject(forKey: "cache:\(key)")
                return nil
            }
            l1[key] = entry
            return entry.value
        }
    }

    private func policyFromIndex(_ index: Int) -> CachePolicyEntry {
        switch index {
        case 0: return CachePolicy.profile
        case 1: return CachePolicy.profilePicture
        case 2: return CachePolicy.vehicle
        case 3: return CachePolicy.license
        case 4: return CachePolicy.verificationStatus
        case 5: return CachePolicy.documentRequirements
        case 6: return CachePolicy.vehicleSubmission
        case 7: return CachePolicy.eligibility
        case 8: return CachePolicy.profileChange
        case 9: return CachePolicy.wallet
        case 10: return CachePolicy.payouts
        default: return CachePolicy.operational
        }
    }

    func set(_ key: String, value: Any, policy: CachePolicyEntry) {
        queue.sync {
            let entry = Entry(value: value, cachedAt: Date(), policy: policy)
            l1[key] = entry
            if policy.persist, let defaults {
                defaults.set(["v": value, "t": Date(), "p": policyName(policy)], forKey: "cache:\(key)")
            }
        }
    }

    func invalidate(_ key: String) {
        queue.sync {
            l1.removeValue(forKey: key)
            defaults?.removeObject(forKey: "cache:\(key)")
        }
    }

    func invalidateAll() {
        queue.sync {
            l1.removeAll()
        }
    }

    func clearAll() {
        queue.sync {
            l1.removeAll()
            guard let defaults else { return }
            let keys = defaults.dictionaryRepresentation().keys.filter { $0.hasPrefix("cache:") }
            for k in keys { defaults.removeObject(forKey: k) }
        }
    }
}