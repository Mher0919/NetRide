import SwiftUI
import CoreLocation
import MapKit
import Combine

/// Live in-trip UI (mirrors TripScreen in the rider app).
struct TripView: View {
    @EnvironmentObject var rideProvider: RideProvider
    @EnvironmentObject var communication: CommunicationService

    @State private var showChat = false
    @State private var showTip = false
    @State private var showRating = false
    @State private var showCancelled = false
    @State private var showArrivalSummary = false
    @State private var showReport = false
    @State private var cancelledInfo: (title: String, message: String)?
    @State private var finalFare: Double?
    @State private var isReturning = false
    private let reporter = LocationReporter(minInterval: 1, minDistanceM: 5)

    var body: some View {
        ZStack {
            let markers = buildMarkers()
            NetRideMapView(markers: markers, polyline: rideProvider.navigationRoute.isEmpty ? nil : rideProvider.navigationRoute, showsUserLocation: true, followMode: true)
                .ignoresSafeArea()

            VStack(spacing: 0) {
                header
                Spacer()
                bottomCard
            }
        }
        .onAppear { setup() }
        .onChange(of: rideProvider.status) { _ in handleStatusChange() }
        .sheet(isPresented: $showChat) {
            ChatView(tripId: rideProvider.tripId ?? "", peerName: rideProvider.driver?.name ?? "Driver")
                .environmentObject(communication)
        }
        .sheet(isPresented: $showTip) {
            TipView { amount in
                submitTip(amount)
            }
        }
        .sheet(isPresented: $showReport) {
            ReportSheetView(rideId: rideProvider.tripId ?? "")
        }
        .fullScreenCover(isPresented: $showRating) {
            if let trip = rideProvider.currentTrip {
                RatingView(trip: trip) {
                    finishRatingFlow()
                }
            }
        }
        .alert("Ride cancelled", isPresented: $showCancelled) {
            Button("Report") { showReport = true }
            Button("OK") { returnToExplore() }
        } message: {
            Text(cancelledInfo?.message ?? "")
        }
        .alert("You have arrived!", isPresented: $showArrivalSummary) {
            Button("RATE YOUR TRIP") {
                showArrivalSummary = false
                rideProvider.reset()
                showRating = true
            }
            Button("Later", role: .cancel) {
                returnToExplore()
            }
        } message: {
            Text("Final fare: \(fareString(finalFare))")
        }
    }

    private var header: some View {
        VStack(spacing: 6) {
            Text(statusTitle)
                .font(.system(size: 15, weight: .bold))
                .foregroundColor(AppTheme.secondaryDarkText)
            if let driver = rideProvider.driver {
                Text("\(driver.name) · \(driver.vehicle ?? "") · \(driver.plate ?? "")")
                    .font(.system(size: 13))
                    .foregroundColor(AppTheme.secondaryDarkText)
            }
            if let eta = etaMinutes {
                Text(etaLabel)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(AppTheme.primaryBrandGreen)
            }
        }
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity)
        .background(Color.white.opacity(0.95))
        .cornerRadius(0, corners: [.bottomLeft, .bottomRight])
    }

    private var bottomCard: some View {
        VStack(spacing: 12) {
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
                    callDriver()
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
                if rideProvider.status == .accepted || rideProvider.status == .driverArriving || rideProvider.status == .inProgress {
                    Button {
                        showTip = true
                    } label: {
                        VStack(spacing: 4) {
                            Image(systemName: "dollarsign.circle.fill")
                            Text("Tip").font(.system(size: 12))
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                        .background(AppTheme.lightCardBackground)
                        .cornerRadius(12)
                    }
                }
            }
            .foregroundColor(AppTheme.secondaryDarkText)

            Button {
                cancelFlow()
            } label: {
                Text("Cancel Ride")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundColor(AppTheme.errorColor)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .overlay(RoundedRectangle(cornerRadius: 14).stroke(AppTheme.errorColor, lineWidth: 1.2))
            }
        }
        .padding(16)
        .background(Color.white)
        .cornerRadius(20, corners: [.topLeft, .topRight])
    }

    private var statusTitle: String {
        switch rideProvider.status {
        case .accepted, .driverArriving:
            return "DRIVER IS ARRIVING"
        case .inProgress:
            return "TRIP IN PROGRESS"
        case .requested:
            return "FINDING YOUR DRIVER"
        case .completed:
            return "TRIP COMPLETED"
        case .cancelled:
            return "RIDE CANCELLED"
        default:
            return "YOUR TRIP"
        }
    }

    private var etaMinutes: Double? {
        rideProvider.driverEtaSeconds ?? rideProvider.navigationEtaSeconds
    }

    private var etaLabel: String {
        guard let eta = etaMinutes else { return "" }
        let mins = Int(eta / 60)
        if rideProvider.status == .accepted || rideProvider.status == .driverArriving {
            return "Arriving in \(mins) min"
        }
        return "ETA \(mins) min"
    }

    private func buildMarkers() -> [MapMarker] {
        var markers: [MapMarker] = []
        if let driver = rideProvider.driver?.location {
            markers.append(MapMarker(coordinate: driver.coordinate, kind: .driver))
        }
        if rideProvider.status == .inProgress, let dest = rideProvider.currentTrip?.destination {
            markers.append(MapMarker(coordinate: dest.coordinate, kind: .destination))
        }
        return markers
    }

    private func setup() {
        guard let trip = rideProvider.currentTrip else { return }
        // Attach communication service.
        communication.attach(
            socket: SocketService.shared,
            riderId: SessionStore.shared.userId ?? "",
            tripId: trip.id,
            peerName: trip.driverInfo?.name ?? "Driver"
        )
        // GPS → updateLocation
        let locationManager = CLLocationManager()
        locationManager.startUpdatingLocation()
        NotificationCenter.default.addObserver(forName: .appForegrounded, object: nil, queue: .main) { _ in
            rideProvider.onAppForegrounded()
        }
    }

    private func handleStatusChange() {
        switch rideProvider.status {
        case .completed:
            finalFare = rideProvider.currentTrip?.fareAmount
            showArrivalSummary = true
        case .cancelled:
            let who = cancelledByTitle
            let reason = rideProvider.currentTrip?.cancellationReasonText
                ?? "This ride was cancelled."
            cancelledInfo = (who, reason)
            showCancelled = true
        default:
            break
        }
    }

    private var cancelledByTitle: String {
        guard let trip = rideProvider.currentTrip else { return "Ride cancelled" }
        if trip.cancelledBy == SessionStore.shared.userId {
            return "You cancelled this ride"
        }
        return "The driver cancelled this ride"
    }

    private func openChat() {
        guard let tripId = rideProvider.tripId else { return }
        Task {
            try? await communication.loadHistory(tripId: tripId)
            showChat = true
        }
    }

    private func callDriver() {
        guard let tripId = rideProvider.tripId else { return }
        Task {
            do {
                let res = try await APIClient.request("GET", "ride/\(tripId)/party-phone")
                let map = res as? [String: Any] ?? [:]
                if let phone = map["phone_number"] as? String,
                   let url = URL(string: "tel:\(phone)") {
                    await MainActor.run { UIApplication.shared.open(url) }
                }
            } catch {}
        }
    }

    private func cancelFlow() {
        // Static rider cancellation reasons.
        let reasons: [(String, String)] = [
            ("driver_took_too_long", "Driver took too long"),
            ("wrong_pickup", "Wrong pickup location"),
            ("driver_unprofessional", "Driver was unprofessional"),
            ("emergency", "Emergency"),
            ("changed_plans", "I changed my plans"),
            ("other", "Other"),
        ]
        let alert = UIAlertController(title: "Cancel Ride", message: "Why are you cancelling?", preferredStyle: .actionSheet)
        for (code, label) in reasons {
            alert.addAction(UIAlertAction(title: label, style: .default) { _ in
                Task {
                    _ = await rideProvider.cancelRide(reasonCode: code, reasonText: nil)
                }
            })
        }
        alert.addAction(UIAlertAction(title: "Keep Riding", style: .cancel))
        UIApplication.shared.keyWindow?.rootViewController?.present(alert, animated: true)
    }

    private func submitTip(_ amount: Double) {
        guard let tripId = rideProvider.tripId else { return }
        Task {
            try? await UserService.submitTip(rideId: tripId, amount: amount)
        }
    }

    private func finishRatingFlow() {
        showRating = false
        returnToExplore()
    }

    private func returnToExplore() {
        if isReturning { return }
        isReturning = true
        rideProvider.reset()
        AppRouter.shared.replaceWith(.main)
        isReturning = false
    }

    private func fareString(_ fare: Double?) -> String {
        guard let fare else { return "—" }
        return String(format: "$%.2f", fare)
    }
}