import Foundation
import CoreLocation
import Combine

/// Mirrors DriverProvider in the driver Flutter app.
final class DriverProvider: ObservableObject {
    static let shared = DriverProvider()

    // MARK: - Core state
    @Published private(set) var status: DriverStatus = .offline
    @Published private(set) var currentTrip: Trip?
    @Published private(set) var incomingRequest: Trip?
    @Published private(set) var isSocketConnected = false
    @Published private(set) var lastLocation: Location?
    @Published private(set) var heading: Double = 0
    @Published private(set) var riderLocation: Location?
    @Published var messages: [ChatMessage] = []
    @Published private(set) var lastCancelledTrip: Trip?
    @Published var socketError: String?
    @Published private(set) var isCancelling = false
    @Published private(set) var cancelConfirmFailed = false
    @Published private(set) var lastCancelError: String?
    @Published private(set) var showApprovedToast = false

    // Compliance state
    @Published private(set) var isVerified = false
    @Published private(set) var verificationStatus: String = "PENDING"
    @Published private(set) var rejectionReason: String?
    @Published private(set) var hasPendingProfileChange = false
    @Published private(set) var pendingChangesSummary: [String: Any] = [:]
    @Published private(set) var pendingRequestId: String?
    @Published private(set) var hasDocumentActionRequired = false
    @Published private(set) var hasVehicleInspectionRequired = false
    @Published private(set) var hasDocumentSubmitted = false
    @Published private(set) var documentTypesWithActionRequired: [String] = []
    @Published private(set) var headshotActionRequired = false
    @Published private(set) var documentRequirements: [[String: Any]] = []
    @Published private(set) var profile: [String: Any] = [:]

    private var settledTripIds: Set<String> = []
    private var isCancellingGuard = false
    private var cancelConfirmTimer: DispatchWorkItem?
    private var observers: [NSObjectProtocol] = []

    private init() {
        observers.append(NotificationCenter.default.addObserver(
            forName: .socketConnected, object: nil, queue: .main
        ) { [weak self] _ in
            self?.isSocketConnected = true
            self?.onSocketConnected()
        })
        observers.append(NotificationCenter.default.addObserver(
            forName: .socketDisconnected, object: nil, queue: .main
        ) { [weak self] _ in
            self?.isSocketConnected = false
        })
        registerSocketHandlers()
    }

    var canGoOnline: Bool {
        isVerified && !hasPendingProfileChange && !hasDocumentActionRequired
            && !hasVehicleInspectionRequired && !headshotActionRequired
    }

    // MARK: - Socket lifecycle

    func initSocket(token: String) {
        SocketService.shared.connect(token: token)
    }

    func onAppForegrounded() {
        if SocketService.shared.isConnected == false, let token = SessionStore.shared.jwtToken {
            SocketService.shared.connect(token: token)
        }
        Task {
            await refreshProfileAndDocs()
        }
    }

    private func onSocketConnected() {
        SocketService.shared.emit("getCurrentTrip")
        hydrateFromCache()
    }

    // MARK: - Socket handlers

    private func registerSocketHandlers() {
        SocketService.shared.on("currentTripNone") { [weak self] _, _ in
            guard let self else { return }
            if self.currentTrip != nil || self.incomingRequest != nil {
                self.currentTrip = nil
                self.incomingRequest = nil
                self.status = .online
            }
        }
        SocketService.shared.on("newTripRequest") { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            let trip = Trip(json: dict)
            self.incomingRequest = trip
            self.settledTripIds.removeAll()
            SoundService.shared.play("incoming_request")
        }
        SocketService.shared.on("tripUpdate") { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            let trip = Trip(json: dict)
            self.handleTripUpdate(trip)
        }
        SocketService.shared.on("acceptTripFailed") { [weak self] _, _ in
            guard let self else { return }
            if self.currentTrip?.status == .requested {
                self.currentTrip = nil
                self.status = .online
            }
        }
        SocketService.shared.on("cancelTripFailed") { [weak self] data, _ in
            guard let self else { return }
            let msg = (data.first as? [String: Any])?["message"] as? String ?? "Cancellation failed"
            self.cancelConfirmFailed = true
            self.lastCancelError = msg
        }
        SocketService.shared.on("messageReceived") { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            self.messages.append(ChatMessage(json: dict))
        }
        SocketService.shared.on("riderLocationUpdate") { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            self.riderLocation = Location(json: dict)
        }
        SocketService.shared.on("navigationStarted") { _, _ in }
        SocketService.shared.on("navigationLegAdvanced") { _, _ in }
        SocketService.shared.on("navigationRouteUpdated") { _, _ in }
        SocketService.shared.on("navigationRerouteRequested") { _, _ in }
        SocketService.shared.on("navigationEnded") { _, _ in }
        SocketService.shared.on("documentRequirementsChanged") { [weak self] _, _ in
            guard let self else { return }
            CacheService.shared.invalidateAll()
            Task { await self.refreshProfileAndDocs() }
        }
        SocketService.shared.on("vehicleRequirementsChanged") { [weak self] _, _ in
            guard let self else { return }
            CacheService.shared.invalidateAll()
            Task { await self.refreshProfileAndDocs() }
        }
        SocketService.shared.on("profileChangeReviewed") { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            if (dict["decision"] as? String) == "APPROVED" {
                self.showApprovedToast = true
            }
            Task { await self.refreshProfileAndDocs() }
        }
        SocketService.shared.on("tipReceived") { [weak self] data, _ in
            SoundService.shared.play("tip_received")
            self?.onTipReceived(data.first)
        }
        SocketService.shared.on("error") { [weak self] data, _ in
            let msg = (data.first as? String) ?? ((data.first as? [String: Any])?["message"] as? String) ?? ""
            self?.socketError = msg
        }
    }

    private func handleTripUpdate(_ trip: Trip) {
        if settledTripIds.contains(trip.id) { return }

        switch trip.status {
        case .accepted, .driverArriving, .inProgress:
            if let current = currentTrip, trip.id != current.id {
                if trip.status == .accepted || trip.status == .inProgress { return }
            }
            currentTrip = trip
            incomingRequest = nil
            status = .onTrip
            SessionStore.shared.activeTripId = trip.id
            SoundService.shared.play("order_accepted")

        case .completed:
            if let incoming = incomingRequest, incoming.id == trip.id {
                incomingRequest = nil
            }
            settledTripIds.insert(trip.id)
            currentTrip = nil
            status = .online
            SessionStore.shared.activeTripId = nil
            SoundService.shared.play("trip_completed")

        case .cancelled:
            incomingRequest = nil
            settledTripIds.insert(trip.id)
            currentTrip = nil
            messages = []
            riderLocation = nil
            lastCancelledTrip = trip
            cancelConfirmFailed = false
            lastCancelError = nil
            status = .online
            SessionStore.shared.activeTripId = nil
            SoundService.shared.play("order_cancelled")
            onCancelConfirmed()

        case .requested:
            // Re-queued / another driver accepted.
            if currentTrip?.id == trip.id {
                currentTrip = trip
            }
        }
    }

    private func onTipReceived(_ payload: Any?) {
        let map = payload as? [String: Any] ?? [:]
        let amount = (map["amount"] as? Double) ?? (map["amount"] as? NSNumber)?.doubleValue ?? 0
        let name = (map["tipperName"] as? String) ?? "Your rider"
        let cents = Int(amount * 100)
        NotificationCenter.default.post(name: .tipReceivedNotification, object: nil,
                                        userInfo: ["amountCents": cents, "tipperName": name])
    }

    private func onCancelConfirmed() {
        NotificationCenter.default.post(name: .tripCancelledNotification, object: nil,
                                        userInfo: ["tripId": lastCancelledTrip?.id ?? ""])
    }

    // MARK: - Availability

    func setOnline(lat: Double?, lng: Double?) {
        status = .online
        var payload: [String: Any] = [:]
        if let lat { payload["lat"] = lat }
        if let lng { payload["lng"] = lng }
        SocketService.shared.emit("goOnline", payload)
        SoundService.shared.play("online")
    }

    func setOffline() {
        status = .offline
        SocketService.shared.emit("goOffline")
        currentTrip = nil
        incomingRequest = nil
        SoundService.shared.play("offline")
    }

    func acceptTrip(_ trip: Trip) {
        guard isSocketConnected else { return }
        currentTrip = trip
        status = .onTrip
        if let offerId = trip.offerId {
            SocketService.shared.emit("acceptTrip", ["tripId": trip.id, "offerId": offerId])
        } else {
            SocketService.shared.emit("acceptTrip", ["tripId": trip.id])
        }
        SoundService.shared.play("order_accepted")
    }

    func declineTrip(_ trip: Trip) {
        if let offerId = trip.offerId {
            SocketService.shared.emit("declineTrip", ["tripId": trip.id, "offerId": offerId])
        } else {
            SocketService.shared.emit("declineTrip", ["tripId": trip.id])
        }
        incomingRequest = nil
        SoundService.shared.play("order_cancelled")
    }

    func pickUpRider(_ tripId: String) {
        SocketService.shared.emit("pickUpRider", tripId)
    }

    func completeTrip(_ tripId: String) async -> Bool {
        clearSocketError()
        SocketService.shared.emit("completeTrip", tripId)
        let deadline = Date().addingTimeInterval(8)
        while Date() < deadline {
            try? await Task.sleep(nanoseconds: 150_000_000)
            if currentTrip == nil { return true }
            if socketError != nil { return false }
        }
        return currentTrip == nil
    }

    func cancelTrip(tripId: String, reasonCode: String?, reasonText: String?) {
        guard !isCancellingGuard else { return }
        isCancellingGuard = true
        isCancelling = true
        cancelConfirmFailed = false
        lastCancelError = nil

        var payload: [String: Any] = ["tripId": tripId]
        if let reasonCode { payload["reasonCode"] = reasonCode }
        if let reasonText { payload["reasonText"] = reasonText }
        SocketService.shared.emit("cancelTrip", payload)

        // 12s fallback timer.
        cancelConfirmTimer = DispatchWorkItem { [weak self] in
            guard let self else { return }
            if self.currentTrip != nil {
                self.cancelConfirmFailed = true
                self.lastCancelError = "Connection lost — cancellation could not be confirmed."
                self.settleCancelledLocally()
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 12, execute: cancelConfirmTimer!)
    }

    private func settleCancelledLocally() {
        guard let trip = currentTrip else { return }
        settledTripIds.insert(trip.id)
        lastCancelledTrip = trip
        currentTrip = nil
        messages = []
        riderLocation = nil
        status = .online
        isCancelling = false
        isCancellingGuard = false
        SessionStore.shared.activeTripId = nil
    }

    func clearSocketError() {
        socketError = nil
    }

    /// Clears the current trip and returns to online (used when leaving the trip screen).
    func resetTripState() {
        currentTrip = nil
        incomingRequest = nil
        messages = []
        riderLocation = nil
        status = .online
        SessionStore.shared.activeTripId = nil
    }

    func ackCancelled() {
        lastCancelledTrip = nil
    }

    // MARK: - Location

    func updateLocation(lat: Double, lng: Double, heading: Double) {
        let location = Location(lat: lat, lng: lng)
        lastLocation = location
        self.heading = heading
        SocketService.shared.emit("updateLocation", ["lat": lat, "lng": lng, "heading": heading])
    }

    // MARK: - Compliance / profile

    func refreshAll() async {
        await refreshProfileAndDocs()
    }

    private func refreshProfileAndDocs() async {
        let cache = CacheService.shared
        guard let driverId = SessionStore.shared.userId else { return }
        UserCacheRepository.shared.setDriverId(driverId)

        if let profile = await UserCacheRepository.shared.revalidateProfile(cache: cache) {
            applyProfileState(profile)
        }
        if let reqs = try? await UserService.getDocumentRequirements() {
            applyDocumentRequirements(reqs)
        }
    }

    private func hydrateFromCache() {
        let cache = CacheService.shared
        guard let driverId = SessionStore.shared.userId else { return }
        UserCacheRepository.shared.setDriverId(driverId)

        if let profile = cache.get(CacheKeys.profile(driverId)) as? [String: Any] {
            applyProfileState(profile)
        }
        if let reqs = cache.get(CacheKeys.documentRequirements(driverId)) as? [[String: Any]] {
            applyDocumentRequirements(reqs)
        }
        Task { await refreshProfileAndDocs() }
    }

    private func applyProfileState(_ profile: [String: Any]) {
        self.profile = profile
        hasPendingProfileChange = profile["has_pending_profile_change"] as? Bool ?? false
        pendingRequestId = profile["pending_request_id"] as? String
        pendingChangesSummary = profile["pending_changes_summary"] as? [String: Any] ?? [:]
        let bgStatus = (profile["background_check_status"] as? String) ?? "PENDING"
        verificationStatus = bgStatus
        rejectionReason = profile["rejection_reason"] as? String
        isVerified = bgStatus == "APPROVED" && (profile["is_active"] as? Bool ?? profile["is_active"] as? String == "true")
        headshotActionRequired = profile["headshot_uploaded"] as? Bool == false && bgStatus == "APPROVED"
    }

    private func applyDocumentRequirements(_ requirements: [[String: Any]]) {
        documentRequirements = requirements
        var docActionTypes: [String] = []
        var needsInspection = false
        var hasSubmitted = false
        for req in requirements {
            let status = (req["status"] as? String) ?? ""
            let type = (req["document_type"] as? String) ?? ""
            if status == "resubmission_required" {
                if type == "inspection_photo_url" {
                    needsInspection = true
                } else {
                    docActionTypes.append(type)
                }
            } else if status == "submitted" {
                hasSubmitted = true
            }
        }
        hasDocumentActionRequired = !docActionTypes.isEmpty
        hasVehicleInspectionRequired = needsInspection
        hasDocumentSubmitted = hasSubmitted
        documentTypesWithActionRequired = docActionTypes
    }

    func clearUserCache() {
        CacheService.shared.clearAll()
        UserCacheRepository.shared.invalidateAllComplianceState(cache: CacheService.shared)
    }
}

extension Notification.Name {
    static let tipReceivedNotification = Notification.Name("tipReceivedNotification")
    static let tripCancelledNotification = Notification.Name("tripCancelledNotification")
}