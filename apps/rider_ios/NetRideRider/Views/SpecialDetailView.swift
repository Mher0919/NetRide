import SwiftUI
import MapKit

/// Special detail screen (mirrors SpecialDetailScreen).
struct SpecialDetailView: View {
    var sponsorId: String
    @EnvironmentObject var specialsProvider: SpecialsProvider
    @State private var sponsor: Sponsor?
    @State private var isLoading = true
    @State private var booking = false
    @State private var errorMessage: String?

    var body: some View {
        ZStack {
            AppTheme.primaryBackground.ignoresSafeArea()
            Group {
                if isLoading {
                    ProgressView()
                } else if let sponsor {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 16) {
                            // Hero
                            ZStack(alignment: .bottomLeading) {
                                Rectangle()
                                    .fill(LinearGradient(colors: [AppTheme.primaryBrandGreen, AppTheme.secondaryDarkText],
                                                         startPoint: .topLeading, endPoint: .bottomTrailing))
                                    .frame(height: 180)
                                VStack(alignment: .leading, spacing: 6) {
                                    Text(sponsor.businessName)
                                        .font(.system(size: 28, weight: .bold))
                                        .foregroundColor(.white)
                                    Text(sponsor.discount.displayLabel)
                                        .font(.system(size: 14, weight: .semibold))
                                        .padding(.horizontal, 10).padding(.vertical, 4)
                                        .background(AppTheme.warningColor)
                                        .cornerRadius(6)
                                        .foregroundColor(.white)
                                }
                                .padding()
                            }
                            .cornerRadius(16)

                            if let desc = sponsor.businessDescription {
                                Text(desc)
                                    .font(.system(size: 15))
                                    .foregroundColor(AppTheme.secondaryDarkText)
                            }
                            if let address = sponsor.address {
                                HStack(spacing: 8) {
                                    Image(systemName: "mappin.circle.fill")
                                        .foregroundColor(AppTheme.primaryBrandGreen)
                                    Text(address)
                                        .font(.system(size: 14))
                                        .foregroundColor(AppTheme.secondaryDarkText)
                                }
                            }

                            AppButton(title: "Book a ride to this place", icon: "car.fill", isEnabled: !booking) {
                                bookRide(sponsor)
                            }

                            if let errorMessage {
                                Text(errorMessage).font(.system(size: 13)).foregroundColor(AppTheme.errorColor)
                            }
                        }
                        .padding()
                    }
                }
            }
        }
        .onAppear { Task { await load() } }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            sponsor = try await SpecialsService.detail(id: sponsorId)
        } catch {
            errorMessage = ErrorHandler.message(for: error)
        }
    }

    private func bookRide(_ sponsor: Sponsor) {
        booking = true
        Task {
            do {
                let redemption = try await specialsProvider.pickSponsor(id: sponsor.id)
                // Set ride intent so the map consumes it.
                specialsProvider.rideIntent = RideIntent(
                    sponsorId: sponsor.id,
                    sponsorName: sponsor.businessName,
                    discountLabel: sponsor.discount.displayLabel,
                    destinationLat: sponsor.latitude,
                    destinationLng: sponsor.longitude,
                    redemptionId: redemption.id
                )
                // Pop to root so the map picks up the intent.
                AppRouter.shared.replaceWith(.main)
            } catch {
                errorMessage = ErrorHandler.message(for: error)
            }
            booking = false
        }
    }
}