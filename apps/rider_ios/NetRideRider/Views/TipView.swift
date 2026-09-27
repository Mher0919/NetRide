import SwiftUI

/// Tip bottom sheet (mirrors TipFab).
struct TipView: View {
    var onTip: (Double) -> Void
    @State private var custom = ""
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 16) {
            Text("Show your driver some love")
                .font(.system(size: 20, weight: .semibold))
                .foregroundColor(AppTheme.secondaryDarkText)
            HStack(spacing: 12) {
                ForEach([1.0, 3.0, 5.0], id: \.self) { amount in
                    Button {
                        onTip(amount)
                        dismiss()
                    } label: {
                        Text("$\(Int(amount))")
                            .font(.system(size: 18, weight: .semibold))
                            .foregroundColor(AppTheme.primaryBrandGreen)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 14)
                            .background(AppTheme.lightCardBackground)
                            .overlay(RoundedRectangle(cornerRadius: 12).stroke(AppTheme.primaryBrandGreen, lineWidth: 1.2))
                            .cornerRadius(12)
                    }
                }
            }
            HStack(spacing: 8) {
                TextField("Custom amount", text: $custom)
                    .keyboardType(.decimalPad)
                    .padding(12)
                    .background(AppTheme.lightCardBackground)
                    .cornerRadius(10)
                Button("Send") {
                    if let value = Double(custom), value > 0 {
                        onTip(value)
                        dismiss()
                    }
                }
                .font(.system(size: 15, weight: .semibold))
                .foregroundColor(.white)
                .padding(.horizontal, 20)
                .padding(.vertical, 12)
                .background(AppTheme.primaryBrandGreen)
                .cornerRadius(10)
            }
        }
        .padding(24)
        .presentationDetents([.height(220)])
    }
}