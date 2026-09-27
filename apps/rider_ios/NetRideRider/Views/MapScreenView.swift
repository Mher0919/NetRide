import SwiftUI
import CoreLocation
import MapKit
import Combine

/// Main Explore surface (mirrors MapScreen in the rider app).
struct MapScreenView: View {
    @EnvironmentObject var rideProvider: RideProvider
    @EnvironmentObject var specialsProvider: SpecialsProvider

    @State private var userPosition: CLLocationCoordinate2D?
    @State private var pickup: Location?
    @State private var destination: Location?
    @State private var routePoints: [CLLocationCoordinate2D] = []
    @State private var panelOpen = false
    @State private var mapExpanded = false
    @State private var loadingEstimates = false
    @State private var estimateFare: Double?
    @State private var estimateDurationSeconds: Double?
    @State private var requesting = false
    @State private var showSearch = false
    @State private var searchIsPickup = false
    @State private var showPromoDialog = false
    @State private var promoCode = ""
    @State private var promoPreview: PromoPreview?
    @State private var applyCredits = false
    @State private var creditUseCents: Int?
    @State private var creditsBalance = 0
    @State private var favoriteDriverEnabled = false
    @State private var favorites: [FavoriteDriver] = []
    @State private var errorMessage: String?
    @State private var profileFailed = false
    @State private var cancelledNoticeId: Int?

    private let locationManager = CLLocationManager()

    var body: some View {
        ZStack(alignment: .top) {
            // Map
            NetRideMapView(
                markers: markers,
                polyline: routePoints.isEmpty ? nil : routePoints,
                center: userPosition,
                showsUserLocation: true,
                followMode: true
            )
            .ignoresSafeArea()

            // Top bar
            VStack(spacing: 0) {
                HStack {
                    if mapExpanded {
                        Button {
                            mapExpanded = false
                        } label: {
                            Image(systemName: "chevron.down")
                                .font(.system(size: 18, weight: .semibold))
                                .padding(10)
                                .background(Color.white)
                                .clipShape(Circle())
                        }
                    }
                    Spacer()
                    if let userPosition {
                        Button {
                            locate()
                        } label: {
                            Image(systemName: "location.fill")
                                .font(.system(size: 16, weight: .semibold))
                                .foregroundColor(AppTheme.secondaryDarkText)
                                .padding(12)
                                .background(Color.white)
                                .clipShape(Circle())
                                .shadow(radius: 2)
                        }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 8)
                Spacer()
            }

            // Ride panel
            VStack {
                Spacer()
                ridePanel
            }
        }
        .sheet(isPresented: $showSearch) {
            AddressSearchView(isPickup: searchIsPickup) { result in
                handleSearchResult(result, isPickup: searchIsPickup)
            }
        }
        .onAppear { setup() }
        .onReceive(NotificationCenter.default.publisher(for: .appForegrounded)) { _ in
            rideProvider.onAppForegrounded()
        }
        .onReceive(rideProvider.$driverCancelledNoticeSeq) { seq in
            if seq > 0, seq != cancelledNoticeId {
                cancelledNoticeId = seq
                showDriverCancelledApology()
            }
        }
        .onReceive(specialsProvider.$rideIntent) { intent in
            if let intent { consumeRideIntent(intent) }
        }
    }

    private var markers: [MapMarker] {
        var result: [MapMarker] = []
        if let userPosition {
            result.append(MapMarker(coordinate: userPosition, kind: .user))
        }
        if let pickup {
            result.append(MapMarker(coordinate: pickup.coordinate, kind: .pickup))
        }
        if let destination {
            result.append(MapMarker(coordinate: destination.coordinate, kind: .destination))
        }
        if let driver = rideProvider.driver?.location {
            result.append(MapMarker(coordinate: driver.coordinate, kind: .driver))
        }
        for (_, loc) in rideProvider.nearbyDrivers {
            result.append(MapMarker(coordinate: loc.coordinate, kind: .nearbyDriver))
        }
        for sponsor in specialsProvider.sponsors {
            if let lat = sponsor.latitude, let lng = sponsor.longitude {
                result.append(MapMarker(coordinate: CLLocationCoordinate2D(latitude: lat, longitude: lng), kind: .sponsor, title: sponsor.businessName))
            }
        }
        return result
    }

    private var ridePanel: some View {
        VStack(spacing: 0) {
            if rideProvider.isSearchingForDriver {
                searchingPanel
            } else {
                planningPanel
            }
        }
        .background(Color.white)
        .cornerRadius(20, corners: [.topLeft, .topRight])
        .shadow(color: .black.opacity(0.1), radius: 8, y: -2)
    }

    private var planningPanel: some View {
        VStack(spacing: 14) {
            Capsule().fill(AppTheme.softBorderColor).frame(width: 40, height: 4).padding(.top, 8)

            Text("NetRide Premium")
                .font(.system(size: 13, weight: .semibold))
                .foregroundColor(AppTheme.primaryBrandGreen)
                .frame(maxWidth: .infinity, alignment: .leading)

            Button {
                searchIsPickup = true
                showSearch = true
            } label: {
                HStack(spacing: 10) {
                    Circle().fill(AppTheme.successGreen).frame(width: 8, height: 8)
                    Text(pickup?.address ?? "Where are you going?")
                        .foregroundColor(pickup == nil ? AppTheme.secondaryDarkText.opacity(0.6) : AppTheme.secondaryDarkText)
                    Spacer()
                    Image(systemName: "magnifyingglass").foregroundColor(AppTheme.softBorderColor)
                }
                .font(.system(size: 16))
            }

            Button {
                searchIsPickup = false
                showSearch = true
            } label: {
                HStack(spacing: 10) {
                    Image(systemName: "mappin.circle.fill")
                        .foregroundColor(AppTheme.secondaryDarkText)
                        .font(.system(size: 18))
                    Text(destination?.address ?? "Choose destination")
                        .foregroundColor(destination == nil ? AppTheme.secondaryDarkText.opacity(0.6) : AppTheme.secondaryDarkText)
                    Spacer()
                }
                .font(.system(size: 16))
            }

            if loadingEstimates {
                HStack {
                    ProgressView()
                    Text("Getting your price…").font(.system(size: 13)).foregroundColor(AppTheme.secondaryDarkText)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            } else if let estimateFare {
                HStack {
                    Text("Estimated fare")
                        .font(.system(size: 13))
                        .foregroundColor(AppTheme.secondaryDarkText)
                    Spacer()
                    Text(formatFare(estimateFare))
                        .font(.system(size: 20, weight: .semibold))
                        .foregroundColor(AppTheme.secondaryDarkText)
                    if let duration = estimateDurationSeconds {
                        Text("· \(formatDuration(duration))")
                            .font(.system(size: 13))
                            .foregroundColor(AppTheme.secondaryDarkText)
                    }
                }
            }

            if let errorMessage {
                Text(errorMessage)
                    .font(.system(size: 13))
                    .foregroundColor(AppTheme.errorColor)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            HStack(spacing: 10) {
                if destination != nil {
                    Button {
                        showPromoDialog = true
                    } label: {
                        Label(promoPreview?.discountLabel ?? "Promo", systemImage: "tag")
                            .font(.system(size: 13, weight: .medium))
                            .foregroundColor(promoPreview?.valid == true ? AppTheme.primaryBrandGreen : AppTheme.secondaryDarkText)
                            .padding(.horizontal, 12).padding(.vertical, 8)
                            .background(AppTheme.lightCardBackground)
                            .cornerRadius(10)
                    }
                    Button {
                        applyCredits.toggle()
                    } label: {
                        Label("Credits", systemImage: applyCredits ? "checkmark.circle.fill" : "circle")
                            .font(.system(size: 13, weight: .medium))
                            .foregroundColor(AppTheme.secondaryDarkText)
                            .padding(.horizontal, 12).padding(.vertical, 8)
                            .background(AppTheme.lightCardBackground)
                            .cornerRadius(10)
                    }
                    Button {
                        favoriteDriverEnabled.toggle()
                    } label: {
                        Label("Favorite driver", systemImage: favoriteDriverEnabled ? "star.fill" : "star")
                            .font(.system(size: 13, weight: .medium))
                            .foregroundColor(AppTheme.secondaryDarkText)
                            .padding(.horizontal, 12).padding(.vertical, 8)
                            .background(AppTheme.lightCardBackground)
                            .cornerRadius(10)
                    }
                }
                Spacer()
            }

            if let special = specialsProvider.current, special.status == .created {
                HStack(spacing: 8) {
                    Image(systemName: "tag.fill").foregroundColor(AppTheme.warningColor)
                    Text("SPECIAL at \(special.sponsorName) — \(special.discountLabel ?? "")")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundColor(AppTheme.secondaryDarkText)
                    Spacer()
                }
                .padding(10)
                .background(AppTheme.warningColor.opacity(0.15))
                .cornerRadius(10)
            }

            AppButton(
                title: confirmTitle,
                style: applyCredits ? .credits : .primary,
                isEnabled: destination != nil && !requesting
            ) {
                confirmRide()
            }
            .padding(.bottom, 8)
        }
        .padding(.horizontal, 20)
        .padding(.bottom, 12)
    }

    private var searchingPanel: some View {
        VStack(spacing: 14) {
            Capsule().fill(AppTheme.softBorderColor).frame(width: 40, height: 4).padding(.top, 8)
            HStack(spacing: 14) {
                ProgressView()
                VStack(alignment: .leading, spacing: 4) {
                    Text("Matching you with nearby drivers…")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundColor(AppTheme.secondaryDarkText)
                    if let fare = estimateFare {
                        Text("NetRide Premium · \(formatFare(fare))")
                            .font(.system(size: 13))
                            .foregroundColor(AppTheme.secondaryDarkText)
                    }
                }
                Spacer()
            }
            if let failure = rideProvider.requestFailure {
                Text(failure)
                    .font(.system(size: 13))
                    .foregroundColor(AppTheme.errorColor)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            AppButton(title: "Cancel Ride", style: .outlined) {
                cancelRide()
            }
            .padding(.bottom, 8)
        }
        .padding(.horizontal, 20)
        .padding(.bottom, 12)
    }

    private var confirmTitle: String {
        if specialsProvider.canAttachToRide { return "Confirm with SPECIAL" }
        if applyCredits { return "Confirm with ride credits" }
        return "Confirm NetRide Premium"
    }

    // MARK: - Logic

    private func setup() {
        locationManager.requestWhenInUseAuthorization()
        locationManager.startUpdatingLocation()
        Task {
            await loadProfile()
            await loadCredits()
            await specialsProvider.refresh()
        }
        // Periodic geohash subscription.
        Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { _ in
            if let userPosition {
                rideProvider.subscribeToNearbyDrivers(Location(lat: userPosition.latitude, lng: userPosition.longitude))
            }
        }
    }

    private func loadProfile() async {
        do {
            _ = try await UserService.getProfile()
        } catch {
            if let api = error as? APIError, case .server(let status, _) = api, status == 404 {
                await AuthService.logout()
                AppRouter.shared.replaceWith(.login)
            }
        }
    }

    private func loadCredits() async {
        creditsBalance = (try? await RewardsService.getCredits())?.balanceCents ?? 0
        favorites = (try? await UserService.getFavorites()) ?? []
    }

    private func locate() {
        if let loc = locationManager.location {
            userPosition = loc.coordinate
        }
    }

    private func handleSearchResult(_ result: SearchResult, isPickup: Bool) {
        let location = Location(lat: result.lat, lng: result.lon, address: result.displayName)
        if isPickup {
            pickup = location
            userPosition = CLLocationCoordinate2D(latitude: result.lat, longitude: result.lon)
        } else {
            destination = location
            rideProvider.reportActivity(type: "REQUEST_FLOW", lat: result.lat, lng: result.lon)
        }
        Task {
            try? await SearchHistoryService.instance.save(result)
        }
        if pickup != nil && destination != nil {
            updateRoute()
        }
    }

    private func updateRoute() {
        guard let pickup, let destination else { return }
        loadingEstimates = true
        Task {
            do {
                let plan = try await RoutingService.plan(origin: pickup, dest: destination)
                routePoints = plan.polyline
                estimateFare = plan.totalFare
                estimateDurationSeconds = plan.etaSecondsEffective
                panelOpen = true
            } catch {
                errorMessage = "We couldn't find a route. Please try a different destination."
            }
            loadingEstimates = false
        }
    }

    private func confirmRide() {
        guard let pickup, let destination else { return }
        requesting = true
        let redemptionId = specialsProvider.canAttachToRide ? specialsProvider.current?.id : nil
        let promo = promoPreview?.valid == true && redemptionId == nil ? promoPreview?.code : nil
        let credits = applyCredits ? min(creditsBalance, max(0, Int((estimateFare ?? 0) * 100))) : nil
        rideProvider.requestRide(
            pickup: pickup,
            destination: destination,
            favoritePriority: favoriteDriverEnabled,
            promoCode: promo,
            applyCredits: applyCredits,
            creditUseCents: credits,
            specialRedemptionId: redemptionId
        )
        requesting = false
    }

    private func cancelRide() {
        Task {
            _ = await rideProvider.cancelRide(reasonCode: nil, reasonText: nil)
        }
    }

    private func showDriverCancelledApology() {
        // Mirrors the driver-cancelled apology dialog.
        guard let notice = rideProvider.driverCancelledNotice else { return }
        let reason = (notice["reasonText"] as? String) ?? "Your driver had to cancel this ride. We're matching you with a new driver."
        let alert = UIAlertController(title: "Driver cancelled", message: reason, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default))
        UIApplication.shared.keyWindow?.rootViewController?.present(alert, animated: true)
    }

    /// Consumes a ride intent (special ride) — prefills destination and attaches redemption.
    private func consumeRideIntent(_ intent: RideIntent) {
        specialsProvider.rideIntent = nil
        if let lat = intent.destinationLat, let lng = intent.destinationLng {
            destination = Location(
                lat: lat, lng: lng,
                address: intent.sponsorName ?? "Special destination"
            )
            rideProvider.reportActivity(type: "REQUEST_FLOW", lat: lat, lng: lng)
            if let userPosition {
                pickup = Location(lat: userPosition.latitude, lng: userPosition.longitude, address: "Current location")
            }
            updateRoute()
        }
    }

    private func formatFare(_ fare: Double) -> String {
        String(format: "$%.2f", fare)
    }

    private func formatDuration(_ seconds: Double) -> String {
        let mins = Int(seconds / 60)
        if mins < 60 { return "\(mins) min" }
        return "\(mins / 60)h \(mins % 60)m"
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
        let path = UIBezierPath(roundedRect: rect, byRoundingCorners: corners, cornerRadii: CGSize(width: radius, height: radius))
        return Path(path.cgPath)
    }
}