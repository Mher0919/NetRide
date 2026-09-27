import SwiftUI
import CoreLocation
import Combine

/// Driver dashboard (mirrors AvailabilityScreen): offline/online + incoming request card.
struct AvailabilityView: View {
    @EnvironmentObject var driverProvider: DriverProvider

    @State private var userPosition: CLLocationCoordinate2D?
    @State private var demandZones: [DemandZone] = []
    @State private var weeklyEarnings: Double = 0
    @State private var showIncoming = false
    @State private var showTrip = false
    @State private var permissionError: String?
    @State private var locationManager = CLLocationManager()

    var body: some View {
        NavigationStack {
            ZStack {
                if driverProvider.status == .online {
                    onlineMap
                } else {
                    offlineLayout
                }
            }
            .navigationBarHidden(true)
        }
        .onAppear { setup() }
        .onReceive(NotificationCenter.default.publisher(for: .socketConnected)) { _ in
            if driverProvider.status == .online { startDemandPolling() }
        }
        .fullScreenCover(isPresented: $showTrip) {
            TripView()
        }
        .onChange(of: driverProvider.incomingRequest) { request in
            showIncoming = request != nil && driverProvider.status == .online
        }
        .onChange(of: driverProvider.status) { status in
            if status == .online {
                startDemandPolling()
            } else {
                demandTimer?.invalidate()
            }
        }
    }

    @State private var demandTimer: Timer?

    private var onlineMap: some View {
        ZStack {
            NetRideMapView(
                markers: [userPosition.map { MapMarker(coordinate: $0, kind: .user) }].compactMap { $0 },
                center: userPosition,
                showsUserLocation: true,
                followMode: true,
                heatmapZones: demandZones
            )
            .ignoresSafeArea()

            VStack {
                HStack {
                    HStack(spacing: 8) {
                        Circle().fill(AppTheme.successGreen).frame(width: 8, height: 8)
                        Text("You're Online")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundColor(AppTheme.secondaryDarkText)
                    }
                    .padding(.horizontal, 14).padding(.vertical, 8)
                    .background(Color.white.opacity(0.95))
                    .cornerRadius(20)
                    Spacer()
                }
                .padding()
                Spacer()
                AppButton(title: "GO OFFLINE", style: .outlined) {
                    driverProvider.setOffline()
                }
                .padding()
            }

            if showIncoming, let request = driverProvider.incomingRequest {
                VStack {
                    Spacer()
                    IncomingRequestCard(trip: request) { action in
                        handleRequestAction(action, trip: request)
                    }
                    .transition(.move(edge: .bottom))
                }
            }
        }
    }

    private var offlineLayout: some View {
        ScrollView {
            VStack(spacing: 16) {
                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Good day!")
                            .font(.system(size: 22, weight: .semibold))
                            .foregroundColor(AppTheme.secondaryDarkText)
                        Text(driverProvider.profile["full_name"] as? String ?? "Service Partner")
                            .font(.system(size: 15))
                            .foregroundColor(AppTheme.secondaryDarkText.opacity(0.7))
                    }
                    Spacer()
                }
                .padding(.top, 12)

                // Compliance cards
                ForEach(complianceCards, id: \.self) { card in
                    ComplianceCard(title: card.title, detail: card.detail, icon: card.icon, action: card.action)
                }

                // Weekly earnings
                AppCard {
                    HStack {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("This Week")
                                .font(.system(size: 13))
                                .foregroundColor(AppTheme.secondaryDarkText.opacity(0.6))
                            Text("$\(weeklyEarnings, specifier: "%.2f")")
                                .font(.system(size: 28, weight: .bold))
                                .foregroundColor(AppTheme.secondaryDarkText)
                        }
                        Spacer()
                    }
                }

                // Map card
                ZStack {
                    NetRideMapView(markers: [], center: userPosition, showsUserLocation: true)
                        .frame(height: 200)
                        .cornerRadius(28)
                    if let permissionError {
                        VStack {
                            Text(permissionError)
                                .font(.system(size: 13))
                                .foregroundColor(.white)
                                .multilineTextAlignment(.center)
                            Button("Enable Location") {
                                UIApplication.shared.open(URL(string: UIApplication.openSettingsURLString)!)
                            }
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundColor(.white)
                        }
                        .padding()
                        .background(Color.black.opacity(0.6))
                        .cornerRadius(16)
                    }
                }
                .frame(height: 200)

                AppButton(title: "GO ONLINE", style: .dark) {
                    goOnline()
                }
                .padding(.bottom, 20)
            }
            .padding(.horizontal, 16)
        }
        .background(AppTheme.primaryBackground)
        .refreshable { await refreshAll() }
    }

    private var complianceCards: [ComplianceCardModel] {
        var cards: [ComplianceCardModel] = []
        if driverProvider.hasPendingProfileChange {
            cards.append(ComplianceCardModel(title: "Profile change under review",
                                             detail: "Your recent changes are being reviewed by our team.",
                                             icon: "clock.fill") {
                showPendingChangeSheet = true
            })
        }
        if driverProvider.verificationStatus == "REJECTED" {
            cards.append(ComplianceCardModel(title: "Application rejected",
                                             detail: driverProvider.rejectionReason ?? "Please contact support.",
                                             icon: "xmark.seal.fill") {})
        }
        if driverProvider.verificationStatus == "PENDING" {
            cards.append(ComplianceCardModel(title: "Background check in progress",
                                             detail: "We're reviewing your application.",
                                             icon: "hourglass") {})
        }
        if driverProvider.hasDocumentActionRequired {
            cards.append(ComplianceCardModel(title: "Documents required",
                                             detail: "Some documents need to be re-uploaded.",
                                             icon: "doc.badge.arrow.up") {
                AppRouter.shared.push(.documents)
            })
        }
        if driverProvider.hasVehicleInspectionRequired {
            cards.append(ComplianceCardModel(title: "Vehicle inspection required",
                                             detail: "Please complete your vehicle inspection.",
                                             icon: "car.fill") {
                AppRouter.shared.push(.vehicleInspection)
            })
        }
        if driverProvider.headshotActionRequired {
            cards.append(ComplianceCardModel(title: "Headshot required",
                                             detail: "Please upload a clear headshot.",
                                             icon: "person.crop.circle") {})
        }
        return cards
    }

    private struct ComplianceCardModel: Identifiable {
        let id = UUID()
        var title: String
        var detail: String
        var icon: String
        var action: () -> Void
    }

    @State private var showPendingChangeSheet = false

    private func setup() {
        checkPermission()
        Task {
            await refreshAll()
        }
    }

    private func checkPermission() {
        let status = locationManager.authorizationStatus
        switch status {
        case .authorizedWhenInUse, .authorizedAlways:
            permissionError = nil
            locationManager.startUpdatingLocation()
        case .denied, .restricted:
            permissionError = "Location access is required to receive ride requests."
        default:
            locationManager.requestWhenInUseAuthorization()
        }
    }

    private func refreshAll() async {
        await driverProvider.refreshAll()
        await loadWeeklyEarnings()
        await loadDemand()
    }

    private func loadWeeklyEarnings() async {
        let history = (try? await UserService.getRideHistory()) ?? []
        let weekAgo = Date().addingTimeInterval(-7 * 24 * 3600)
        var total = 0.0
        for trip in history {
            let status = (trip["status"] as? String) ?? ""
            guard status == "COMPLETED" else { continue }
            let dateStr = (trip["requested_at"] as? String) ?? (trip["created_at"] as? String) ?? ""
            if let date = ISO8601DateFormatter().date(from: dateStr), date < weekAgo { continue }
            total += (trip["fare_amount"] as? Double) ?? 0
            total += (trip["tip_amount"] as? Double) ?? 0
        }
        weeklyEarnings = total
    }

    private func loadDemand() async {
        guard let userPosition else { return }
        demandZones = (try? await HeatmapService.fetch(lat: userPosition.latitude, lng: userPosition.longitude))?.zones ?? []
    }

    private func startDemandPolling() {
        demandTimer?.invalidate()
        demandTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { _ in
            Task { await loadDemand() }
        }
    }

    private func goOnline() {
        guard driverProvider.canGoOnline else {
            showBlockedReason()
            return
        }
        checkPermission()
        let lat = userPosition?.latitude
        let lng = userPosition?.longitude
        driverProvider.setOnline(lat: lat, lng: lng)
    }

    private func showBlockedReason() {
        var message = "You can't go online right now."
        if driverProvider.hasPendingProfileChange {
            message = "Your profile change is under review."
        } else if driverProvider.hasDocumentActionRequired {
            message = "You have documents that need re-uploading."
        } else if driverProvider.hasVehicleInspectionRequired {
            message = "You have a vehicle inspection that needs completing."
        } else if driverProvider.verificationStatus != "APPROVED" {
            message = "Your application hasn't been approved yet."
        }
        let alert = UIAlertController(title: "Not yet available", message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default))
        UIApplication.shared.keyWindow?.rootViewController?.present(alert, animated: true)
    }

    private func handleRequestAction(_ action: RequestAction, trip: Trip) {
        switch action {
        case .accept:
            driverProvider.acceptTrip(trip)
            showIncoming = false
            showTrip = true
        case .decline:
            driverProvider.declineTrip(trip)
        }
    }
}

enum RequestAction {
    case accept, decline
}

struct IncomingRequestCard: View {
    var trip: Trip
    var onAction: (RequestAction) -> Void
    @State private var countdown = 15

    var body: some View {
        VStack(spacing: 12) {
            HStack {
                Text("New Ride Request")
                    .font(.system(size: 16, weight: .bold))
                    .foregroundColor(AppTheme.secondaryDarkText)
                Spacer()
                Text("\(countdown)s")
                    .font(.system(size: 14, weight: .bold))
                    .foregroundColor(countdown <= 5 ? AppTheme.errorColor : AppTheme.secondaryDarkText)
            }
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text("You earn $\(earnings)")
                        .font(.system(size: 18, weight: .bold))
                        .foregroundColor(AppTheme.primaryBrandGreen)
                    Text(trip.pickup.address ?? "Pickup")
                        .font(.system(size: 14))
                        .foregroundColor(AppTheme.secondaryDarkText)
                    Text(trip.destination.address ?? "Destination")
                        .font(.system(size: 14))
                        .foregroundColor(AppTheme.secondaryDarkText)
                }
                Spacer()
            }
            HStack(spacing: 8) {
                VStack(spacing: 2) {
                    Text(etaLabel).font(.system(size: 12, weight: .semibold)).foregroundColor(AppTheme.secondaryDarkText)
                    Text("TO PICKUP").font(.system(size: 10)).foregroundColor(AppTheme.secondaryDarkText.opacity(0.6))
                }
                .frame(maxWidth: .infinity)
                VStack(spacing: 2) {
                    Text(distanceLabel).font(.system(size: 12, weight: .semibold)).foregroundColor(AppTheme.secondaryDarkText)
                    Text("TRIP").font(.system(size: 10)).foregroundColor(AppTheme.secondaryDarkText.opacity(0.6))
                }
                .frame(maxWidth: .infinity)
                VStack(spacing: 2) {
                    Text(ratingLabel).font(.system(size: 12, weight: .semibold)).foregroundColor(AppTheme.secondaryDarkText)
                    Text("RIDER").font(.system(size: 10)).foregroundColor(AppTheme.secondaryDarkText.opacity(0.6))
                }
                .frame(maxWidth: .infinity)
            }
            .padding()
            .background(AppTheme.lightCardBackground)
            .cornerRadius(12)

            AppButton(title: "ACCEPT", style: .primary) {
                onAction(.accept)
            }
            AppButton(title: "Decline", style: .outlined) {
                onAction(.decline)
            }
        }
        .padding(16)
        .background(Color.white)
        .cornerRadius(20, corners: [.topLeft, .topRight])
        .shadow(color: .black.opacity(0.15), radius: 8, y: -2)
        .onAppear {
            startCountdown()
        }
    }

    private var earnings: String {
        if let cents = trip.driverEarningsCents {
            return String(format: "%.2f", Double(cents) / 100)
        }
        return String(format: "%.2f", trip.fareAmount ?? 0)
    }

    private var etaLabel: String {
        guard let eta = trip.driverToPickupEta else { return "—" }
        return "\(Int(eta / 60)) min"
    }

    private var distanceLabel: String {
        guard let m = trip.tripDistanceMeters else { return "—" }
        return String(format: "%.1f mi", m / 1609.34)
    }

    private var ratingLabel: String {
        String(format: "%.1f", trip.riderInfo?.rating ?? 5.0)
    }

    private func startCountdown() {
        var deadline = trip.expiresAt ?? Date().addingTimeInterval(15)
        let now = Date()
        let seconds = min(max(deadline.timeIntervalSince(now), 1), 30)
        deadline = now.addingTimeInterval(seconds)
        countdown = Int(seconds)
        Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { timer in
            let remaining = deadline.timeIntervalSinceNow
            if remaining <= 0 {
                timer.invalidate()
                SoundService.shared.play("order_cancelled")
                onAction(.decline)
            } else {
                countdown = Int(remaining)
                SoundService.shared.play("countdown_tick")
            }
        }
    }
}

struct ComplianceCard: View {
    var title: String
    var detail: String
    var icon: String
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: icon)
                    .font(.system(size: 18))
                    .foregroundColor(AppTheme.warningColor)
                    .frame(width: 30)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundColor(AppTheme.secondaryDarkText)
                    Text(detail)
                        .font(.system(size: 12))
                        .foregroundColor(AppTheme.secondaryDarkText.opacity(0.6))
                }
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.system(size: 12))
                    .foregroundColor(AppTheme.softBorderColor)
            }
            .padding()
            .background(AppTheme.lightCardBackground)
            .cornerRadius(16)
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(AppTheme.softBorderColor, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }
}

extension UIApplication {
    var keyWindow: UIWindow? {
        connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .first?.windows
            .first { $0.isKeyWindow }
    }
}

extension View {
    func cornerRadius(_ radius: CGFloat, corners: UIRectCorner) -> some View {
        clipShape(RoundedCorner(radius: radius, corners: corners))
    }
}

struct RoundedCorner: Shape {
    var radius: CGFloat
    var corners: UIRectCorner
    func path(in rect: CGRect) -> Path {
        Path(UIBezierPath(roundedRect: rect, byRoundingCorners: corners, cornerRadii: CGSize(width: radius, height: radius)).cgPath)
    }
}