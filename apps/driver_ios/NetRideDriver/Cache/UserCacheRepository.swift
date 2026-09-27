import Foundation

/// Cache-first wrappers over the driver API (mirrors user_cache_repository.dart).
final class UserCacheRepository {
    static let shared = UserCacheRepository()

    private init() {}

    private var driverId: String?

    func setDriverId(_ id: String) {
        driverId = id
    }

    func getProfile(cache: CacheService) async -> [String: Any]? {
        guard let driverId else { return nil }
        let key = CacheKeys.profile(driverId)
        if let cached = cache.get(key) as? [String: Any] { return cached }
        do {
            let res = try await APIClient.request("GET", "driver/profile")
            let profile = res as? [String: Any] ?? [:]
            cache.set(key, value: profile, policy: CachePolicy.profile)
            return profile
        } catch {
            return nil
        }
    }

    func revalidateProfile(cache: CacheService) async -> [String: Any]? {
        guard let driverId else { return nil }
        let key = CacheKeys.profile(driverId)
        do {
            let res = try await APIClient.request("GET", "driver/profile")
            let profile = res as? [String: Any] ?? [:]
            cache.set(key, value: profile, policy: CachePolicy.profile)
            return profile
        } catch {
            return cache.get(key) as? [String: Any]
        }
    }

    func refreshProfile(cache: CacheService) async -> [String: Any]? {
        guard let driverId else { return nil }
        let key = CacheKeys.profile(driverId)
        cache.invalidate(key)
        return await revalidateProfile(cache: cache)
    }

    func invalidateAfterProfileChange(cache: CacheService) {
        guard let driverId else { return }
        cache.invalidate(CacheKeys.profile(driverId))
        cache.invalidate(CacheKeys.profileChange(driverId))
        cache.invalidate(CacheKeys.eligibility(driverId))
    }

    func invalidateAfterDocumentResubmit(cache: CacheService) {
        guard let driverId else { return }
        cache.invalidate(CacheKeys.documentRequirements(driverId))
        cache.invalidate(CacheKeys.profile(driverId))
    }

    func invalidateAfterVehicleChange(cache: CacheService) {
        guard let driverId else { return }
        cache.invalidate(CacheKeys.vehicle(driverId))
        cache.invalidate(CacheKeys.profile(driverId))
    }

    func invalidateAllComplianceState(cache: CacheService) {
        guard let driverId else { return }
        for key in CacheKeys.allKeysForUser(driverId) {
            cache.invalidate(key)
        }
    }
}