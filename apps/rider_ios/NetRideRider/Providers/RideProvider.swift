import Foundation
import CoreLocation
import Combine

/// Mirrors RideProvider in the rider app — the ride state machine + socket relay.
final class RideProvider: ObservableObject {
    static let shared = RideProvider()

    @Published var status: TripStatus = .idle
    @Published var tripId: String?
    @Published var currentTrip: Trip?
    @Published var driver: DriverInfo?
    @Published var estimatedFare: Double?
    @Published var isSocketConnected = false
    @Published var messages: [ChatMessage] = []
    @Published var nearbyDrivers: [String: Location] = [:]
    @Published var requestFailure: String?
    @Published var navigationRoute: [CLLocationCoordinate2D] = []
    @Published var navigationEtaSeconds: Double?
    @Published var navigationCacheHit = false
    @Published var driverEtaSeconds: Double?
    @Published var driverRemainingMeters: Double?
    @Published var driverCancelledNotice: [String: Any]?
    @Published var driverCancelledNoticeSeq = 0
    @Published var isCancelling = false
    @Published var lastKnownLocation: Location?

    // Specials live updates relay
    let specialRedemptionUpdates = PassthroughSubject<[String: Any], Never>()
    let notificationPing = PassthroughSubject<Void, Never>()

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

    var isSearchingForDriver: Bool {
        status == .requested && tripId != nil
    }

    // MARK: - Socket lifecycle

    func initSocket(token: String) {
        SocketService.shared.connect(token: token)
    }

    func onAppForegrounded() {
        if SocketService.shared.isConnected == false, let token = SessionStore.shared.jwtToken {
            SocketService.shared.connect(token: token)
        }
        reportActivity(type: "APP_ACTIVE")
    }

    private func onSocketConnected() {
        if status != .idle, let tripId {
            SocketService.shared.emit("getCurrentTrip")
        } else {
            SocketService.shared.emit("getCurrentTrip")
        }
        _restoreActiveTripAfterRestart()
    }

    private func _restoreActiveTripAfterRestart() {
        guard let saved = SessionStore.shared.activeTripId else { return }
        if tripId == nil {
            status = .requested
            tripId = saved
            SocketService.shared.emit("getCurrentTrip")
        }
    }

    // MARK: - Socket handlers

    private func registerSocketHandlers() {
        SocketService.shared.on("tripUpdate") { [weak self] data, _ in
            guard let self else { return }
            guard let dict = data.first as? [String: Any] else { return }
            let trip = Trip(json: dict)
            if self.status == .idle { return }
            if let currentId = self.tripId, trip.id != currentId { return }
            self.applyTripUpdate(trip)
        }
        SocketService.shared.on("currentTripNone") { [weak self] _, _ in
            guard let self else { return }
            if self.status != .idle {
                self.reset()
            }
        }
        SocketService.shared.on("tripDriverCancelled") { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            self.driver = nil
            self.navigationRoute = []
            self.driverCancelledNoticeSeq += 1
            var notice = dict
            notice["noticeId"] = self.driverCancelledNoticeSeq
            self.driverCancelledNotice = notice
        }
        SocketService.shared.on("driverLocationUpdate") { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            let driverId = (dict["driverId"] as? String) ?? ""
            if self.driver?.id == driverId {
                let loc = Location(json: dict)
                if self.driver != nil {
                    var d = self.driver!
                    d.location = loc
                    self.driver = d
                }
            } else {
                self.nearbyDrivers[driverId] = Location(json: dict)
            }
        }
        SocketService.shared.on("messageReceived") { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            let msg = ChatMessage(json: dict)
            self.messages.append(msg)
        }
        SocketService.shared.on("navigationStarted") { [weak self] data, _ in
            self?.setNavigationRoute(data.first)
        }
        SocketService.shared.on("navigationLegAdvanced") { [weak self] data, _ in
            self?.setNavigationRoute(data.first)
        }
        SocketService.shared.on("navigationRerouteRequested") { [weak self] data, _ in
            self?.setNavigationRoute(data.first)
        }
        SocketService.shared.on("navigationEnded") { [weak self] _, _ in
            self?.navigationRoute = []
            self?.navigationEtaSeconds = nil
            self?.driverEtaSeconds = nil
            self?.driverRemainingMeters = nil
        }
        SocketService.shared.on("driverEtaUpdate") { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            if let tripId = dict["tripId"] as? String, let current = self.tripId, tripId != current { return }
            self.driverEtaSeconds = (dict["etaSeconds"] as? Double) ?? (dict["etaSeconds"] as? NSNumber)?.doubleValue
            self.driverRemainingMeters = (dict["remainingMeters"] as? Double) ?? (dict["remainingMeters"] as? NSNumber)?.doubleValue
        }
        SocketService.shared.on("tipReceived") { _, _ in
            SoundService.shared.play("tip_received")
        }
        SocketService.shared.on("notificationReceived") { [weak self] _, _ in
            self?.notificationPing.send(())
            NotificationCenter.default.post(name: .notificationPing, object: nil)
        }
        SocketService.shared.on("specialRedemptionUpdate") { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            self.specialRedemptionUpdates.send(dict)
        }
        SocketService.shared.on("error") { [weak self] data, _ in
            guard let self else { return }
            let msg = (data.first as? String) ?? ((data.first as? [String: Any])?["message"] as? String) ?? "Ride request failed"
            self.requestFailure = msg
        }
        SocketService.shared.on("cancelTripFailed") { _, _ in
            // REST confirm path surfaces the message.
        }
    }

    private func setNavigationRoute(_ payload: Any?) {
        guard let dict = payload as? [String: Any] else { return }
        if let tid = dict["tripId"] as? String, let current = tripId, tid != current { return }
        let route = dict["route"] as? [String: Any] ?? [:]
        var points: [CLLocationCoordinate2D] = []
        if let raw = route["points_list"] as? [[Any]] {
            points = raw.compactMap { pair in
                guard pair.count >= 2,
                      let lng = (pair[0] as? NSNumber)?.doubleValue,
                      let lat = (pair[1] as? NSNumber)?.doubleValue else { return nil }
                return CLLocationCoordinate2D(latitude: lat, longitude: lng)
            }
        } else if let raw = route["polyline"] as? [[Any]] {
            points = raw.compactMap { pair in
                guard pair.count >= 2,
                      let lng = (pair[0] as? NSNumber)?.doubleValue,
                      let lat = (pair[1] as? NSNumber)?.doubleValue else { return nil }
                return CLLocationCoordinate2D(latitude: lat, longitude: lng)
            }
        } else if let geom = route["geometry"] as? [String: Any], let coords = geom["coordinates"] as? [[Any]] {
            points = coords.compactMap { pair in
                guard pair.count >= 2,
                      let lng = (pair[0] as? NSNumber)?.doubleValue,
                      let lat = (pair[1] as? NSNumber)?.doubleValue else { return nil }
                return CLLocationCoordinate2D(latitude: lat, longitude: lng)
            }
        } else if let encoded = route["encodedPolyline"] as? String {
            points = PolylineDecoder.decode(encoded, precision: 6)
        }
        if !points.isEmpty {
            navigationRoute = points
            if let t = route["trafficDurationSeconds"] as? Double, t > 0 {
                navigationEtaSeconds = t
            } else if let eta = route["eta"] as? Double, eta > 0 {
                navigationEtaSeconds = eta
            } else if let d = route["duration"] as? Double {
                navigationEtaSeconds = d
            }
            navigationCacheHit = route["cache_hit"] as? Bool ?? route["cacheHit"] as? Bool ?? false
        }
    }

    private func applyTripUpdate(_ trip: Trip) {
        currentTrip = trip
        tripId = trip.id
        status = trip.status

        switch trip.status {
        case .accepted, .driverArriving, .inProgress:
            if let info = trip.driverInfo {
                driver = info
            }
            if let info = trip.driverInfo, info.location == nil, let driverLocation = trip.driverInfo?.location {
                var d = driver!
                d.location = driverLocation
                driver = d
            }
        case .requested:
            driver = nil
            navigationRoute = []
        case .completed:
            SoundService.shared.play("trip_completed")
            SessionStore.shared.activeTripId = nil
        case .cancelled:
            SoundService.shared.play("order_cancelled")
            messages = []
            SessionStore.shared.activeTripId = nil
        default:
            break
        }

        switch trip.status {
        case .accepted, .driverArriving, .inProgress:
            SessionStore.shared.activeTripId = trip.id
        default:
            break
        }

        if trip.status == .accepted {
            SoundService.shared.play("order_accepted")
        }
    }

    // MARK: - Ride actions

    func requestRide(
        pickup: Location,
        destination: Location,
        isScheduled: Bool = false,
        scheduledAt: Date? = nil,
        favoritePriority: Bool = false,
        promoCode: String? = nil,
        applyCredits: Bool = false,
        creditUseCents: Int? = nil,
        specialRedemptionId: String? = nil
    ) {
        requestFailure = nil
        var payload: [String: Any] = [
            "pickup": pickup.toJson,
            "destination": destination.toJson,
            "isScheduled": isScheduled,
            "favoritePriority": favoritePriority,
            "idempotencyKey": UUID().uuidString,
        ]
        if let scheduledAt { payload["scheduledAt"] = ISO8601DateFormatter().string(from: scheduledAt) }
        if let promoCode { payload["promoCode"] = promoCode.uppercased() }
        payload["applyCredits"] = applyCredits
        if let creditUseCents, creditUseCents > 0 { payload["creditUseCents"] = creditUseCents }
        if let specialRedemptionId { payload["specialRedemptionId"] = specialRedemptionId }

        SocketService.shared.emit("requestRide", payload)
        if !isScheduled {
            status = .requested
        }
    }

    func cancelRide(reasonCode: String?, reasonText: String?) async -> String? {
        guard !isCancelling else { return nil }
        isCancelling = true
        defer { isCancelling = false }

        if let tripId {
            var payload: [String: Any] = ["tripId": tripId]
            if let reasonCode { payload["reasonCode"] = reasonCode }
            if let reasonText { payload["reasonText"] = reasonText }
            SocketService.shared.emit("cancelTrip", payload)
        }

        do {
            var body: [String: Any] = [:]
            if let tripId { body["tripId"] = tripId }
            if let reasonCode { body["reasonCode"] = reasonCode }
            if let reasonText { body["reasonText"] = reasonText }
            let res = try await APIClient.request("POST", "ride/cancel", body: body)
            let map = res as? [String: Any] ?? [:]
            if map["cancelled"] as? Bool == true {
                reset()
                return nil
            }
            // 409 handling: probe current trip.
            if let current = try? await APIClient.request("GET", "ride/current") as? [String: Any],
               let trip = current["trip"] as? [String: Any],
               let id = trip["id"] as? String, id == tripId,
               let st = trip["status"] as? String, st != "CANCELLED" {
                return "This ride is already in progress and cannot be cancelled."
            }
            reset()
            return nil
        } catch {
            return "We couldn't cancel the ride right now. Please try again."
        }
    }

    func subscribeToNearbyDrivers(_ location: Location) {
        SocketService.shared.emit("subscribeToNearbyDrivers", location.toJson)
    }

    func updateLocation(_ location: Location) {
        lastKnownLocation = location
        SocketService.shared.emit("updateLocation", ["lat": location.lat, "lng": location.lng])
    }

    func reportActivity(type: String, lat: Double? = nil, lng: Double? = nil) {
        var payload: [String: Any] = ["type": type]
        if let lat { payload["lat"] = lat }
        if let lng { payload["lng"] = lng }
        if payload["lat"] == nil, let loc = lastKnownLocation {
            payload["lat"] = loc.lat
            payload["lng"] = loc.lng
        }
        SocketService.shared.emit("reportActivity", payload)
    }

    func reset() {
        status = .idle
        tripId = nil
        driver = nil
        estimatedFare = nil
        currentTrip = nil
        messages = []
        nearbyDrivers = [:]
        navigationRoute = []
        navigationEtaSeconds = nil
        driverEtaSeconds = nil
        driverRemainingMeters = nil
        driverCancelledNotice = nil
        isCancelling = false
        requestFailure = nil
        SessionStore.shared.activeTripId = nil
    }
}

/// Decodes Google encoded polylines (polyline5 / polyline6).
enum PolylineDecoder {
    static func decode(_ encoded: String, precision: Int = 5) -> [CLLocationCoordinate2D] {
        let factor = pow(10.0, Double(precision))
        var coords: [CLLocationCoordinate2D] = []
        var index = encoded.startIndex
        var lat = 0.0
        var lng = 0.0

        func nextValue() -> Double {
            var result = 0
            var shift = 0
            var byte = 0
            repeat {
                guard index < encoded.endIndex else { return 0 }
                byte = Int(encoded[index].asciiValue ?? 0) - 63
                index = encoded.index(after: index)
                result |= (byte & 0x1f) << shift
                shift += 5
            } while byte >= 0x20
            let delta = (result & 1) != 0 ? ~(result >> 1) : (result >> 1)
            return Double(delta)
        }

        while index < encoded.endIndex {
            lat += nextValue()
            lng += nextValue()
            coords.append(CLLocationCoordinate2D(latitude: lat / factor, longitude: lng / factor))
        }
        return coords
    }
}