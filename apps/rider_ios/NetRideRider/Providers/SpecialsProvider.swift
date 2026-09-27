import Foundation
import Combine

/// Mirrors SpecialsProvider in the rider app.
final class SpecialsProvider: ObservableObject {
    @Published var sponsors: [Sponsor] = []
    @Published var specialCount = 0
    @Published var introSeen = true
    @Published var current: SpecialRedemption?
    @Published var pending: [SpecialRedemption] = []
    @Published var isLoading = false
    @Published var rideIntent: RideIntent?

    private var codes: [String: String] = [:]
    private var readyNotices: [SpecialRedemption] = []
    private var cancellations: Set<String> = []
    private var rideProvider: RideProvider?
    private var cancellables = Set<AnyCancellable>()

    var canAttachToRide: Bool { current?.status == .created }

    func bind(rideProvider: RideProvider) {
        self.rideProvider = rideProvider
        rideProvider.specialRedemptionUpdates.sink { [weak self] update in
            self?.onRedemptionUpdate(update)
        }.store(in: &cancellables)
    }

    func refresh(userLat: Double? = nil, userLng: Double? = nil) async {
        isLoading = true
        defer { isLoading = false }
        async let list = SpecialsService.list(lat: userLat, lng: userLng)
        async let count = SpecialsService.count()
        async let intro = SpecialsService.introState()
        async let current = SpecialsService.currentRedemption()
        do {
            let (l, c, i, cur) = try await (list, count, intro, current)
            sponsors = l
            specialCount = c
            introSeen = i
            self.current = cur
        } catch {
            // Background refresh failures are non-fatal.
        }
        await loadPendingCodes()
        await recoverPendingCodes()
    }

    private func loadPendingCodes() async {
        if let pending = try? await SpecialsService.pendingRedemptions() {
            self.pending = pending
        }
    }

    private func recoverPendingCodes() async {
        let notifications = (try? await NotificationService.shared.fetchNotifications(limit: 50)) ?? []
        for n in notifications where n.type == "special_reward_ready" {
            guard let redemptionId = n.data["redemptionId"] else { continue }
            if let code = n.data["code"] {
                codes[redemptionId] = code
            }
        }
    }

    func code(for redemptionId: String) -> String? {
        codes[redemptionId]
    }

    func pickSponsor(id: String) async throws -> SpecialRedemption {
        let redemption = try await SpecialsService.createRedemption(sponsorId: id)
        self.current = redemption
        return redemption
    }

    func consumeReadyNotice(for redemptionId: String) -> SpecialRedemption? {
        if let idx = readyNotices.firstIndex(where: { $0.id == redemptionId }) {
            return readyNotices.remove(at: idx)
        }
        return nil
    }

    private func onRedemptionUpdate(_ update: [String: Any]) {
        let id = (update["id"] as? String) ?? ""
        if let code = update["code"] as? String {
            codes[id] = code
        }
        let status = (update["status"] as? String) ?? ""
        if status == "WAITING_FOR_SPONSOR" || status == "SPONSOR_VALIDATED" {
            readyNotices.append(SpecialRedemption(json: update))
        }
        Task { await refresh() }
    }

    func markSeenIntro() async {
        do {
            try await SpecialsService.markIntroSeen()
            introSeen = true
        } catch {}
    }
}