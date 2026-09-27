import SwiftUI
import CoreLocation
import Combine

/// Active trip screen with turn-by-turn navigation (mirrors TripScreen + NavigationScreen).
struct TripView: View {
    @EnvironmentObject var driverProvider: DriverProvider
    @EnvironmentObject var navigation: NavigationService
    @EnvironmentObject var communication: CommunicationService

    @State private var showChat = false
    @State private var showCancelled = false
    @State private var showCompleted = false
    @State private var showRating = false
    @State private var cancelledTitle = ""
    @State private var cancelledMessage = ""
    @State private var isOpen = false
    @State private var earningsCents = 0
    @State private var tipCents = 0
    @State private var completedTripId: String?
    @State private var reporter = LocationReporter(minInterval: 1, minDistanceM: 10, minHeadingDeltaDeg: 15)

    var body: some View {
        ZStack {
            mapLayer
            VStack(spacing: 0) {
                topManeuverBar
                Spacer()
                bottomCard
            }
        }
        .onAppear { setup() }
        .onChange(of: driverProvider.status) { _ in handleStatusChange() }
        .onReceive(NotificationCenter.default.publisher(for: .tripCancelledNotification)) { _ in
            showCancelledDialog()
        }
        .onReceive(NotificationCenter.default.publisher(for: .tipReceivedNotification)) { note in
            let amount = note.userInfo?["amountCents"] as? Int ?? 0
            tipCents = amount
            showCompleted = true
        }
        .sheet(isPresented: $showChat) {
            ChatSheetView(tripId: driverProvider.currentTrip?.id ?? "", peerName: "Rider")
                .environmentObject(communication)
        }
        .alert("Trip complete", isPresented: $showCompleted) {
            Button("Rate Rider") {
                showCompleted = false
                showRating = true
            }
            Button("Dismiss") { returnToDashboard() }
        } message: {
            Text("You earned $\(Double(earningsCents) / 100, specifier: "%.2f") including tip.")
        }
        .alert(cancelledTitle, isPresented: $showCancelled) {
            Button("OK") {
                driverProvider.ackCancelled()
                returnToDashboard()
            }
        } message: {
            Text(cancelledMessage)
        }
        .sheet(isPresented: $showRating) {
            DriverRatingView(rideId: completedTripId ?? "") {
                returnToDashboard()
            }
        }
    }

    private var mapLayer: some View {
        let markers = buildMarkers()
        return NetRideMapView(
            markers: markers,
            polyline: navigation.route?.points.isEmpty == false ? navigation.route?.points : nil,
            center: navigation.route?.points.first,
            showsUserLocation: true,
            followMode: true,
            userHeading: nil
        )
        .ignoresSafeArea()
    }

    private var topManeuverBar: some View {
        VStack(spacing: 6) {
            if let route = navigation.route, let step = route.steps.first {
                HStack(spacing: 10) {
                    Image(systemName: maneuverIcon(step.maneuver))
                        .font(.system(size: 26))
                        .foregroundColor(AppTheme.primaryBrandGreen)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(step.instruction)
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundColor(AppTheme.secondaryDarkText)
                        if let road = step.name, !road.isEmpty {
                            Text("onto \(road)")
                                .font(.system(size: 13))
                                .foregroundColor(AppTheme.secondaryDarkText.opacity(0.7))
                        }
                    }
                    Spacer()
                    if navigation.isSpeeding {
                        Text("SPEEDING")
                            .font(.system(size: 11, weight: .bold))
                            .foregroundColor(.white)
                            .padding(.horizontal, 8).padding(.vertical, 4)
                            .background(AppTheme.errorColor)
                            .cornerRadius(6)
                    }
                }
                .padding()
                .background(Color.white.opacity(0.95))
                .cornerRadius(14)
                .padding(.horizontal, 12)
                .padding(.top, 8)
            }
        }
    }

    private var bottomCard: some View {
        VStack(spacing: 10) {
            if let progress = navigation.progress {
                HStack {
                    Text(legLabel)
                        .font(.system(size: 12, weight: .bold))
                        .foregroundColor(AppTheme.primaryBrandGreen)
                    Spacer()
                    Text("ETA \(Int(progress.etaSeconds / 60)) min")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundColor(AppTheme.secondaryDarkText)
                }
                ProgressView(value: progress.progressFraction)
                    .tint(AppTheme.primaryBrandGreen)
                HStack {
                    Text("\(distanceLabel(progress.remainingMeters)) remaining")
                        .font(.system(size: 13))
                        .foregroundColor(AppTheme.secondaryDarkText.opacity(0.7))
                    Spacer()
                }
            }

            if navigation.offRoute {
                HStack(spacing: 8) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundColor(AppTheme.warningColor)
                    Text(navigation.rerouting ? "Rerouting…" : "Off route — finding the best way back")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundColor(AppTheme.secondaryDarkText)
                    Spacer()
                }
                .padding(10)
                .background(AppTheme.warningColor.opacity(0.15))
                .cornerRadius(10)
            }

            let leg = navigation.leg
            let proximityEnabled: Bool = leg == "pickup"
                ? isWithin(pickupProximityMeters)
                : isWithinDestination
            let ctaTitle = leg == "pickup" ? "PICK UP RIDER" : "COMPLETE TRIP"

            AppButton(title: ctaTitle, isEnabled: proximityEnabled) {
                if leg == "pickup" {
                    driverProvider.pickUpRider(driverProvider.currentTrip?.id ?? "")
                    if let trip = driverProvider.currentTrip {
                        navigation.advanceToDestination(start: trip.pickup, end: trip.destination)
                    }
                } else {
                    completeTrip()
                }
            }

            HStack(spacing: 12) {
                Button {
                    openChat()
                } label: {
                    VStack(spacing: 4) {
                        Image(systemName: "message.fill")
                        Text("Chat").font(.system(size: 12))
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
                    .background(AppTheme.lightCardBackground)
                    .cornerRadius(12)
                }
                Button {
                    callRider()
                } label: {
                    VStack(spacing: 4) {
                        Image(systemName: "phone.fill")
                        Text("Call").font(.system(size: 12))
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
                    .background(AppTheme.lightCardBackground)
                    .cornerRadius(12)
                }
                if driverProvider.currentTrip?.status == .accepted {
                    Button {
                        cancelFlow()
                    } label: {
                        VStack(spacing: 4) {
                            Image(systemName: "xmark.circle.fill")
                            Text("Cancel").font(.system(size: 12))
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                        .background(AppTheme.lightCardBackground)
                        .cornerRadius(12)
                    }
                }
            }
            .foregroundColor(AppTheme.secondaryDarkText)
        }
        .padding(16)
        .background(Color.white)
        .cornerRadius(20, corners: [.topLeft, .topRight])
    }

    private var legLabel: String {
        navigation.leg == "pickup" ? "EN ROUTE TO PICKUP" : "EN ROUTE TO DESTINATION"
    }

    private var pickupProximityMeters: Double {
        if let location = GpsTracker.shared.lastKnownLocation {
            return SpatialHash.haversine(location, driverProvider.currentTrip?.pickup.coordinate ?? location)
        }
        return Double.greatestFiniteMagnitude
    }

    private var isWithinDestination: Bool {
        guard let trip = driverProvider.currentTrip else { return false }
        guard let location = lastKnownUserLocation else { return false }
        return SpatialHash.haversine(location, trip.destination.coordinate) <= 100
    }

    private var lastKnownUserLocation: CLLocationCoordinate2D? {
        GpsTracker.shared.lastKnownLocation
    }

    private func isWithin(_ meters: Double) -> Bool {
        meters <= 15
    }

    private func buildMarkers() -> [MapMarker] {
        var markers: [MapMarker] = []
        if let trip = driverProvider.currentTrip {
            markers.append(MapMarker(coordinate: trip.pickup.coordinate, kind: .pickup))
            markers.append(MapMarker(coordinate: trip.destination.coordinate, kind: .destination))
        }
        if let rider = driverProvider.riderLocation {
            markers.append(MapMarker(coordinate: rider.coordinate, kind: .rider))
        }
        return markers
    }

    private func setup() {
        guard !isOpen else { return }
        isOpen = true
        guard let trip = driverProvider.currentTrip else { return }

        communication.attach(
            socket: SocketService.shared,
            driverId: SessionStore.shared.userId ?? "",
            tripId: trip.id,
            peerName: "Rider"
        )

        navigation.stopNavigation()
        let start = driverProvider.lastLocation ?? trip.pickup
        let leg = trip.status == .inProgress ? "destination" : "pickup"
        navigation.startNavigation(tripId: trip.id, leg: leg, start: start, end: trip.pickup)

        GpsTracker.shared.fixes
            .sink { fix in
                if reporter.shouldReport(location: CLLocation(latitude: fix.position.latitude, longitude: fix.position.longitude), heading: fix.headingDeg) {
                    driverProvider.updateLocation(lat: fix.position.latitude, lng: fix.position.longitude, heading: fix.headingDeg)
                }
            }
            .store(in: &gpsCancellables)
    }

    private var gpsCancellables = Set<AnyCancellable>()

    private func handleStatusChange() {
        guard let trip = driverProvider.currentTrip else { return }
        if trip.status == .inProgress, navigation.leg == "pickup" {
            navigation.advanceToDestination(start: trip.pickup, end: trip.destination)
        }
        if trip.status == .completed {
            earningsCents = trip.driverEarningsCents ?? Int((trip.fareAmount ?? 0) * 100)
            completedTripId = trip.id
            showCompleted = true
        }
    }

    private func showCancelledDialog() {
        guard let trip = driverProvider.lastCancelledTrip else { return }
        if trip.cancelledBy == SessionStore.shared.userId {
            cancelledTitle = "You cancelled this ride"
        } else {
            cancelledTitle = "The rider cancelled this ride"
        }
        cancelledMessage = trip.cancellationReasonText ?? "This ride was cancelled."
        showCancelled = true
        navigation.stopNavigation()
    }

    private func completeTrip() {
        guard let trip = driverProvider.currentTrip else { return }
        Task {
            let confirmed = await driverProvider.completeTrip(trip.id)
            if confirmed {
                earningsCents = trip.driverEarningsCents ?? Int((trip.fareAmount ?? 0) * 100)
                completedTripId = trip.id
                navigation.stopNavigation()
                showCompleted = true
            }
        }
    }

    private func openChat() {
        guard let tripId = driverProvider.currentTrip?.id else { return }
        Task {
            try? await communication.loadHistory(tripId: tripId)
            showChat = true
        }
    }

    private func callRider() {
        guard let tripId = driverProvider.currentTrip?.id else { return }
        Task {
            let res = try? await APIClient.request("GET", "ride/\(tripId)/party-phone")
            let map = res as? [String: Any] ?? [:]
            if let phone = map["phone_number"] as? String, let url = URL(string: "tel:\(phone)") {
                await MainActor.run { UIApplication.shared.open(url) }
            }
        }
    }

    private func cancelFlow() {
        let reasons: [(String, String)] = [
            ("rider_not_at_pickup", "Rider wasn't at pickup"),
            ("rider_requested_cancel", "Rider asked to cancel"),
            ("unsafe_pickup", "Unsafe pickup area"),
            ("vehicle_issue", "Vehicle issue"),
            ("emergency", "Emergency"),
            ("unable_to_complete", "Unable to complete trip"),
            ("rider_behavior", "Rider behavior"),
            ("other", "Other"),
        ]
        let alert = UIAlertController(title: "Cancel Ride", message: "Why are you cancelling?", preferredStyle: .actionSheet)
        for (code, label) in reasons {
            alert.addAction(UIAlertAction(title: label, style: .default) { _ in
                driverProvider.cancelTrip(tripId: driverProvider.currentTrip?.id ?? "", reasonCode: code, reasonText: nil)
            })
        }
        alert.addAction(UIAlertAction(title: "Keep Driving", style: .cancel))
        UIApplication.shared.keyWindow?.rootViewController?.present(alert, animated: true)
    }

    private func returnToDashboard() {
        navigation.stopNavigation()
        driverProvider.resetTripState()
        AppRouter.shared.replaceWith(.main)
    }

    private func maneuverIcon(_ maneuver: String) -> String {
        switch maneuver.lowercased() {
        case "turn-left", "slight-left": return "arrow.turn.up.left"
        case "turn-right", "slight-right": return "arrow.turn.up.right"
        case "sharp-left": return "arrow.up.left"
        case "sharp-right": return "arrow.up.right"
        case "straight", "continue-straight": return "arrow.up"
        case "uturn", "uturn-left", "uturn-right": return "arrow.uturn.up"
        case "roundabout-left", "roundabout-right": return "arrow.triangle.branch"
        case "arrive", "destination": return "mappin.circle"
        default: return "arrow.up"
        }
    }

    private func distanceLabel(_ meters: Double) -> String {
        let miles = meters / 1609.34
        if miles >= 0.1 { return String(format: "%.1f mi", miles) }
        return "\(Int(meters * 3.28084)) ft"
    }
}