import SwiftUI

/// 3-tab shell (mirrors MainWrapper): Explore / Activity / Account.
struct MainTabView: View {
    @State private var selectedTab = 0
    @EnvironmentObject var rideProvider: RideProvider
    @EnvironmentObject var specialsProvider: SpecialsProvider

    var body: some View {
        ZStack(alignment: .top) {
            TabView(selection: $selectedTab) {
                MapScreenView()
                    .tabItem { Label("Explore", systemImage: "map.fill") }
                    .tag(0)
                ActivityView()
                    .tabItem { Label("Activity", systemImage: "clock.arrow.circlepath") }
                    .tag(1)
                ProfileView()
                    .tabItem { Label("Account", systemImage: "person.fill") }
                    .tag(2)
            }
            .accentColor(AppTheme.primaryBrandGreen)
            .onAppear { checkAuth() }

            if !rideProvider.isSocketConnected {
                ConnectionBanner()
                    .transition(.move(edge: .top))
            }
        }
        .onChange(of: selectedTab) { tab in
            if tab == 0 { Task { await specialsProvider.refresh() } }
        }
    }

    private func checkAuth() {
        if SessionStore.shared.jwtToken == nil {
            AppRouter.shared.replaceWith(.login)
        }
    }
}

struct ConnectionBanner: View {
    var body: some View {
        HStack {
            Image(systemName: "wifi.exclamationmark")
            Text("Reconnecting to ride service… ride requests may not send.")
                .font(.system(size: 12, weight: .medium))
            Spacer()
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background(AppTheme.connectionBannerRed)
        .foregroundColor(.white)
        .clipShape(Capsule())
        .padding(.top, 4)
    }
}