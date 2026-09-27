import SwiftUI

struct SplashView: View {
    @State private var scale: CGFloat = 0.6
    @State private var opacity: Double = 0

    var body: some View {
        ZStack {
            AppTheme.primaryBackground.ignoresSafeArea()
            VStack(spacing: 16) {
                Image(systemName: "car.fill")
                    .resizable()
                    .scaledToFit()
                    .frame(width: 120, height: 120)
                    .foregroundColor(AppTheme.primaryBrandGreen)
                Text("NetRide")
                    .font(.system(size: 34, weight: .semibold))
                    .foregroundColor(AppTheme.secondaryDarkText)
            }
            .scaleEffect(scale)
            .opacity(opacity)
        }
        .onAppear {
            withAnimation(.easeOut(duration: 1.5)) {
                scale = 1.0
                opacity = 1.0
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                route()
            }
        }
    }

    private func route() {
        // Splash already resolves initialTargetRoute at bootstrap; just navigate.
        AppRouter.shared.path = [AppRouter.shared.initialTargetRoute]
    }
}