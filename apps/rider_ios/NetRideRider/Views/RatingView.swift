import SwiftUI

/// Post-ride rating screen (mirrors RatingScreen).
struct RatingView: View {
    var trip: Trip
    var onDone: () -> Void

    @State private var rating = 5
    @State private var tipAmount = 0.0
    @State private var favorite = false
    @State private var comment = ""
    @State private var submitting = false
    @State private var errorMessage: String?

    var body: some View {
        VStack(spacing: 20) {
            Text("How was your trip?")
                .font(.system(size: 26, weight: .semibold))
                .foregroundColor(AppTheme.secondaryDarkText)

            HStack(spacing: 10) {
                ForEach(1...5, id: \.self) { star in
                    Image(systemName: star <= rating ? "star.fill" : "star")
                        .font(.system(size: 34))
                        .foregroundColor(star <= rating ? AppTheme.warningColor : AppTheme.softBorderColor)
                        .onTapGesture { rating = star }
                }
            }

            Text("Tip your driver")
                .font(.system(size: 16, weight: .semibold))
                .foregroundColor(AppTheme.secondaryDarkText)
            HStack(spacing: 12) {
                ForEach([0.0, 1.0, 3.0, 5.0], id: \.self) { amount in
                    Button {
                        tipAmount = amount
                    } label: {
                        Text(amount == 0 ? "No Tip" : "$\(Int(amount))")
                            .font(.system(size: 14, weight: .medium))
                            .foregroundColor(tipAmount == amount ? .white : AppTheme.secondaryDarkText)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 8)
                            .background(tipAmount == amount ? AppTheme.primaryBrandGreen : AppTheme.lightCardBackground)
                            .cornerRadius(10)
                    }
                }
            }

            Toggle(isOn: $favorite) {
                Text("Save this driver to favorites")
                    .font(.system(size: 14))
            }
            .tint(AppTheme.primaryBrandGreen)

            TextField("Add a comment (optional)", text: $comment, axis: .vertical)
                .lineLimit(3...5)
                .padding(12)
                .background(AppTheme.lightCardBackground)
                .cornerRadius(12)

            if let errorMessage {
                Text(errorMessage).font(.system(size: 13)).foregroundColor(AppTheme.errorColor)
            }

            AppButton(title: "Submit Rating", isEnabled: !submitting) {
                submit()
            }
            Spacer()
        }
        .padding(24)
    }

    private func submit() {
        submitting = true
        errorMessage = nil
        Task {
            do {
                if tipAmount > 0 {
                    try await UserService.submitTip(rideId: trip.id, amount: tipAmount)
                }
                try await UserService.rateRide(
                    rideId: trip.id,
                    rating: rating,
                    reviewText: comment.isEmpty ? nil : comment,
                    favorite: favorite
                )
                onDone()
            } catch {
                // "already rated" treated as success
                if let api = error as? APIError, case .server(let status, _) = api, status == 200 {
                    onDone()
                } else {
                    errorMessage = ErrorHandler.message(for: error)
                    onDone()
                }
            }
            submitting = false
        }
    }
}