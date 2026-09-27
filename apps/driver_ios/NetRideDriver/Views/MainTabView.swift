import SwiftUI

/// 3-tab shell (mirrors MainWrapper in the driver app): Status / Activity / Account.
struct MainTabView: View {
    @State private var selectedTab = 0
    @EnvironmentObject var driverProvider: DriverProvider

    var body: some View {
        TabView(selection: $selectedTab) {
            AvailabilityView()
                .tabItem { Label("Status", systemImage: "car.fill") }
                .tag(0)
            DriverActivityView()
                .tabItem { Label("Activity", systemImage: "receipt.fill") }
                .tag(1)
            DriverProfileView()
                .tabItem { Label("Account", systemImage: "person.fill") }
                .tag(2)
        }
        .accentColor(AppTheme.primaryBrandGreen)
        .onAppear { checkAuth() }
    }

    private func checkAuth() {
        if SessionStore.shared.jwtToken == nil {
            AppRouter.shared.replaceWith(.login)
        }
    }
}